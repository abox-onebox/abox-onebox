import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Not, Repository } from 'typeorm';

import { OrderStatus } from '@abox/shared-types';

import { KvService } from '../../common/cache/kv.service';
import { ErrorCode } from '../../common/constants/error-code';
import { UserStatus } from '../../common/constants/user-status';
import { BizException } from '../../common/exceptions/biz.exception';
import { currentTimeline, formatTimeOfDay } from '../../common/utils/order-timeline';
import { addDays, todayBj, tomorrowBj } from '../../common/utils/time';
import { Order } from '../../database/entities/order.entity';
import { User } from '../../database/entities/user.entity';
import { MESSAGE_TEMPLATE_SPEC_MAP, NOTIFY_PAGES } from '../admin/template/message-template.specs';
import { MessageService } from './message.service';

/**
 * 通知编排服务（F5 · 真源《系统地图》F5「缺的是'按人按场景编排 + 到达率回看'」）
 *
 * ## 它补的是什么
 *
 * `MessageService.notify()` 解决「**一条**通知按场景规则发不发得出去」；
 * 本服务解决「**一群人**按场景批量触达 + 结果可回看」——即真源说的「按人按场景编排」。
 * 两者是**叠加**关系，不是替代：本服务**逐条调用 `notify()`**，投递规则（场景 / 启用闸门 /
 * 渠道 / 收件人解析 / 落日志）**仍只在 `message.service.ts` 一处**，这里不写第二遍。
 *
 * ## ⚠️ 三条设计红线
 *
 * 1. **受众只能是「预定义选择器」，不接受任意 userId 列表。**
 *    收一个 `userId[]` 就等价于开了一个「给谁都能发」的群发后门 —— 那东西一旦存在，
 *    就不会有人再走业务链路，而是直接拼列表发。故入参是 `audience: AudienceKey`
 *    （受限枚举），每个选择器还**绑定唯一场景**（`selector.scene === scene` 强校验），
 *    防止「拿退款场景的模板给截单受众群发」这类串用。
 * 2. **`dryRun` 缺省为 `true`（fail-safe）。** 编排是**会被误触**的动作（一个 POST），
 *    而它一次能影响几十上百人。默认只算不发，要真发必须显式传 `dryRun: false` ——
 *    这与「启用闸门 fail-closed」同一取向：**让人多按一次，好过错发一次**。
 * 3. **不吞掉「跳过原因」**。`notify()` 的 `delivered=false` 带 `reason`（未启用 / 缺模板 ID /
 *    找不到 openid…）。按原因分组计数后**原样回带**，而不是只回一个「成功 N 条」——
 *    否则「一条都没发出去」和「发了但失败」在出参里长得一样。
 *
 * ## ⚠️ 一期为什么必然「一条也发不出去」
 *
 * 一期没有微信账号 ⇒ `ab_message_template.wechat_template_id` 全为空 ⇒ 启用闸门（fail-closed）
 * 拦住所有订阅消息场景 ⇒ `notify()` 在第 2 步就返回 `delivered=false`。
 * **这不是缺陷，是当前真实状态**：出参照样给出真实受众规模（`audienceSize`），
 * 让运营看得见「今天若已开通，会有多少人收到」。**不许把它粉饰成「已发送」。**
 *
 * ## ⚠️ 一期 `wxData` 的 key 用**我们自己的变量名** —— 与 `refund.service.ts` 同一口径
 *
 * 真实微信模板要求 `thing1` / `time2` 这类 keyword，而 keyword 由**微信公众平台侧创建模板时**
 * 决定，一期拿不到。凭空造 keyword 属**编造契约**，故照 `refund.service.ts` 的既有做法：
 * 先用业务变量名，映射待模板创建后在**一处**补齐（届时改本文件的 `buildWxData` 即可，
 * 不要在别处再拼一份）。
 *
 * ## 与未来「自动跑批」的关系（真源依赖项）
 *
 * 真源 F5 的「依赖」写的是「订阅消息模板审核（微信侧流程）」—— 即**自动推送**要等模板审核。
 * 故一期触达入口是本服务经端点手动触发；接入跑批时**直接调本服务的 `orchestrate()`**，
 * 业务逻辑一行不改（与「跑批与手动补跑共用同一执行口」同一纪律，见 `ScheduleService.run()`）。
 */
@Injectable()
export class MessageOrchestratorService {
  private readonly logger = new Logger('MessageOrchestrate');

  constructor(
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly message: MessageService,
    /** 「同一场景同一目标日本日已投过」的去重键存储（无 Redis 时自动降级进程内 Map） */
    private readonly kv: KvService,
  ) {}

  /**
   * 编排一次批量触达
   *
   * 判定顺序：场景存在 → 受众选择器存在 → 选择器属于该场景 → 解析受众 → （非 dryRun）逐条投递 → 汇总。
   */
  async orchestrate(input: OrchestrateInput): Promise<OrchestrateResult> {
    const spec = MESSAGE_TEMPLATE_SPEC_MAP[input.scene];
    if (!spec) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `未知通知场景「${input.scene}」—— 场景键须来自服务端声明（不接受自造场景）`,
      );
    }

    const selector = findSelector(input.audience);
    if (!selector) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `未知受众选择器「${input.audience}」—— 只接受预定义选择器（${Object.keys(AUDIENCE_SELECTORS).join(' / ')}）`,
      );
    }
    if (selector.scene !== spec.scene) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `受众选择器「${selector.label}」只服务于场景「${selector.scene}」，不能用于「${spec.scene}」` +
          '—— 防止拿一个场景的模板给另一个场景的受众群发',
      );
    }

    // 目标出餐日：缺省「明日」—— 一期唯一可下单日（`isOrderable` 的上界是算出来的）
    const mealDate = input.mealDate ?? tomorrowBj();
    const userIds = await this.resolveAudience(selector, mealDate);

    const limit = input.limit ?? DEFAULT_LIMIT;
    const truncated = userIds.length > limit;
    const targets = userIds.slice(0, limit);

    // ⚠️ 缺省 dryRun：安全默认（见类头注释②）
    const dryRun = input.dryRun !== false;

    const cutoffTime = formatTimeOfDay(currentTimeline().cutoff);

    let delivered = 0;
    let ok = 0;
    let failed = 0;
    const skipped = new Map<string, number>();

    if (!dryRun) {
      /**
       * ⭐ **去重闸门：同一场景 + 同一目标出餐日，一天只投一次**
       *
       * 为什么必须加（不只是「幂等键」那道题）：`Idempotency-Key` 只有在**调用方带了这个头**
       * 时才生效，而本端点的典型用法是后台页面上一个人手点按钮 —— 手抖连点、网络重试、
       * 两个运营各自点一次，落在服务端就是**两条互不相干的请求**，幂等键一个都救不了。
       * 后果是同一批人**当天收到两次一模一样的话**（订阅消息尤其招投诉），而这条路径
       * 上**没有任何一处会提示「已经发过了」**。
       *
       * ⚠️ 用 `setNx` 而不是「先查再 set」：两个并发请求同时查到「没投过」就会双双放行，
       *    那正是要防的形状 —— 与 `IdempotentInterceptor` 用同一个原语（`kv.setNx`）。
       * ⚠️ 投递过程中抛错 → **删键**（与拦截器 `error` 分支同一选择）：失败投递不该把
       *    「今天还能再投一次」这条路堵死；宁可承担「部分投递后重试」的风险，
       *    也不要出现「想重试却被一个从没成功过的键锁住一整天」。
       */
      const dedupeKey = `orchestrate:sent:${spec.scene}:${mealDate}:${todayBj()}`;
      // 24h：跨过自然日即可 —— 键里已含北京日，次日自动换成新键，不会把明天的动作一起拦掉
      const claimed = await this.kv.setNx(dedupeKey, new Date().toISOString(), 24 * 60 * 60);
      if (!claimed) {
        throw new BizException(
          ErrorCode.DUPLICATE_SUBMIT,
          `场景「${spec.label}」对目标出餐日 ${mealDate} 在今天已投递过一次，` +
            '本次未重复发送（同一批人当天收到两条一样的话是最招投诉的一类事故）',
        );
      }

      try {
        for (const userId of targets) {
          const r = await this.message.notify({
            scene: spec.scene,
            userId,
            page: NOTIFY_PAGES.orderCreate,
            variables: { mealDate, cutoffTime },
            wxData: buildWxData({ mealDate, cutoffTime }),
          });
          if (r.delivered) {
            delivered += 1;
            if (r.ok) ok += 1;
            else failed += 1;
          } else {
            const key = r.reason ?? '未投递（未给出原因）';
            skipped.set(key, (skipped.get(key) ?? 0) + 1);
          }
        }
      } catch (e) {
        void this.kv.del(dedupeKey).catch(() => undefined);
        throw e;
      }

      this.logger.log(
        `编排「${spec.label}」mealDate=${mealDate} 受众=${userIds.length} ` +
          `投递=${delivered} 成功=${ok} 失败=${failed} 跳过=${targets.length - delivered}`,
      );
    }

    return {
      scene: spec.scene,
      label: spec.label,
      audience: selector.key,
      audienceLabel: selector.label,
      mealDate,
      audienceSize: userIds.length,
      attempted: dryRun ? 0 : targets.length,
      delivered,
      ok,
      failed,
      skipped: [...skipped].map(([reason, count]) => ({ reason, count })),
      reachRate: delivered ? Number((ok / delivered).toFixed(4)) : null,
      truncated,
      limit,
      dryRun,
      note: this.buildNote({ dryRun, truncated, userIds: userIds.length, limit }),
    };
  }

  /**
   * 受众解析：近 N 天下过单、且目标出餐日尚未下单的用户
   *
   * ## 为什么「差集」在内存里做，不写成一条 SQL 子查询
   *
   * 同 D44 发票「分月必须在服务端内存完成」的纪律：SQL 里的 `NOT IN (子查询)` 与
   * 大 `IN (...)` 列表在**驱动之间行为/上限不一致**（SQLite 绑定变量上限 999），
   * 本地 sqlite 全绿、换 MySQL 才炸。两次简单查询 + 内存 `Set` 差集**跨四驱动完全一致**，
   * 且用户量级（试运营期）下开销可忽略。
   *
   * ## ⚠️ 「下过单」的判据
   *
   * 排除 `pending_pay`（未付款）与 `cancelled`（已取消）—— 这两态表示**没有真正买过**，
   * 拿它们当「有购买习惯的人」会得到一份虚高的受众名单。
   * 其余状态（含 `refunded` 等）**保留**：退款过的人仍是「曾经下过单的人」，
   * 是否再触达属运营判断，不是系统该替他过滤的。
   *
   * ## ⭐ 「人还在不在」比「买没买过」更靠前（F-10 同族）
   *
   * 只按订单行为筛出来的名单里会带着**已注销 / 黑名单**的用户（`ab_user.status`）：
   * 他们的 `ab_order` 行按合规口径是**要保留**的（`UserService.cancelAccount` 明写
   * 「订单、退款、佣金是钱的凭证」），于是订单事实完好 ⇒ 这类用户**必然落在受众里**，还会被算进 `audienceSize`
   * —— 而 `audienceSize` 是运营拿去判断「今天会有多少人收到」的那个数，把这个人算进去，
   * 它就是一份**虚高且不可交付**的名单：给他推送既不合规（他已要求注销），
   * 也解释不清为什么到达率永远差那么几个人。
   *
   * ⚠️ 这里取 **`status === NORMAL`（只给正常用户发）**，比写钱闸门
   *    （`UserPayeeService.canReceiveMoney`：只排除已注销）**更严**，是刻意的：
   *    · **钱**是用户的财产，黑名单可以申诉回来，拦掉等于平台扣押他的钱 ⇒ 只拦注销；
   *    · **消息**是平台主动打扰，黑名单是平台自己判的「你暂时别来」，给他推送与处罚互斥。
   *    ⭐ 两处口径不同不是疏漏，故在此明写一次 —— 否则下一个人会把它们「统一」成一处，
   *    统一的方向无论朝哪边走，都会让另一边错。
   */
  private async resolveAudience(selector: AudienceSelector, targetDate: string): Promise<number[]> {
    const NOT_REALLY_ORDERED = [OrderStatus.PENDING_PAY, OrderStatus.CANCELLED];

    // ① 近 N 天（不含目标日）有过有效订单的用户
    const history = await this.orderRepo.find({
      where: {
        mealDate: Between(addDays(targetDate, -selector.days), addDays(targetDate, -1)),
        status: Not(In(NOT_REALLY_ORDERED)),
      },
      select: { userId: true },
    });

    // ② 目标日已下单的用户（这些人不需要提醒）
    const ordered = await this.orderRepo.find({
      where: {
        mealDate: targetDate,
        status: Not(In(NOT_REALLY_ORDERED)),
      },
      select: { userId: true },
    });

    // ③ 不可触达用户：**单独一次简单查询**（`status != NORMAL` ⇒ 天然是个小集合），
    //    再在内存里做差集 —— 见本方法头注释（禁止 `NOT IN (子查询)` / 大 `IN` 列表）
    const unreachable = await this.userRepo.find({
      where: { status: Not(UserStatus.NORMAL) },
      select: { id: true },
    });

    const orderedSet = new Set(ordered.map((o) => o.userId));
    const unreachableSet = new Set(unreachable.map((u) => u.id));
    const universe = new Set(history.map((o) => o.userId));
    return [...universe]
      .filter((uid) => !orderedSet.has(uid) && !unreachableSet.has(uid))
      .sort((a, b) => a - b);
  }

  /** 编排出参的口径说明（让「一条没发出去」与「发失败了」在页面上分得开） */
  private buildNote(i: {
    dryRun: boolean;
    truncated: boolean;
    userIds: number;
    limit: number;
  }): string {
    const parts: string[] = [];
    if (i.dryRun) {
      parts.push('当前为**预演**（dryRun）：只解析受众、不投递 —— 要真发请显式传 `dryRun: false`');
    }
    if (i.truncated) {
      parts.push(
        `受众 ${i.userIds} 人超出本次上限 ${i.limit} 人，**只处理前 ${i.limit} 人**` +
          '（防误触全量；分批重跑即可覆盖余下）',
      );
    }
    parts.push(
      '⚠️ 到达率的**分母是「已尝试投递」的条数**，不含因「未启用」被跳过的 —— ' +
        '`ab_message` 按纪律只记「发过什么」，不记「因为没启用所以没发」（两者不是一回事）',
    );
    return parts.join('；');
  }
}

// =====================================================================
// 受众选择器（预定义 · 唯一真相）
// =====================================================================

export type AudienceKey = keyof typeof AUDIENCE_SELECTORS;

export interface AudienceSelector {
  key: string;
  /** 中文说明（页面直接展示，端上不自造文案） */
  label: string;
  /** 回溯天数（「近 N 天下过单」的 N） */
  days: number;
  /**
   * ⚠️ 本选择器**只服务**这个场景 —— 见类头注释①（防串用）。
   *    它是「选择器」存在的意义之一：受众口径与场景是绑定的，不是自由组合的。
   */
  scene: string;
}

export const AUDIENCE_SELECTORS = {
  /** 截单提醒：近 14 天下过单、但明日还没下单的人（真源 F5「忘了下单」） */
  cutoff_remind_pending: {
    key: 'cutoff_remind_pending',
    label: '近 14 天下过单、且目标出餐日尚未下单的用户',
    days: 14,
    scene: 'cutoff_remind',
  },
} as const;

/**
 * 按运行时字符串查选择器（键非法返回 `undefined`，由调用方报 `10001`）
 *
 * ⚠️ 存在的理由：入参来自 HTTP（**运行时字符串**），而 `AUDIENCE_SELECTORS` 是
 *    `as const` 的字面量类型 —— 不能直接用字符串索引。在此做**一处**显式拓宽，
 *    而不是把常量整体降级成 `Record<string, AudienceSelector>`
 *    （降级会连带丢掉键的拼写检查，`AUDIENCE_SELECTORS.cutoff_remind_pendng` 就查不出来了）。
 */
export function findSelector(key: string): AudienceSelector | undefined {
  return (AUDIENCE_SELECTORS as Record<string, AudienceSelector>)[key];
}

/** 单次编排的受众上限（防误触全量；超出按 `truncated` 如实回带） */
const DEFAULT_LIMIT = 500;

/**
 * 组装微信订阅消息 `data`
 *
 * ⚠️ 一期 key 用**业务变量名**（`mealDate` / `cutoffTime`），不是微信的 `thing1` / `time2` ——
 *    真实 keyword 由微信公众平台创建模板时决定，一期拿不到，凭空造即编造契约。
 *    映射待模板创建后**只改这一处**（同 `refund.service.ts` 的既有口径）。
 */
function buildWxData(vars: Record<string, string>): Record<string, { value: string }> {
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, { value: v }]));
}

// =====================================================================
// 出参
// =====================================================================

export interface OrchestrateInput {
  /** 场景键（须在 `MESSAGE_TEMPLATE_SPECS` 内） */
  scene: string;
  /** 受众选择器键（须在 `AUDIENCE_SELECTORS` 内） */
  audience: string;
  /** 目标出餐日（`YYYY-MM-DD`）；缺省「明日」 */
  mealDate?: string;
  /**
   * 预演：只解析受众、不投递。
   *
   * ⚠️ **缺省 `true`**（安全默认）—— 要真发必须显式传 `false`。
   *    端点层不覆写该默认值（见类头注释②）。
   */
  dryRun?: boolean;
  /** 本次受众上限（缺省 500） */
  limit?: number;
}

export interface OrchestrateResult {
  scene: string;
  label: string;
  audience: string;
  audienceLabel: string;
  mealDate: string;
  /** 命中的受众总数（**dryRun 也为真值** —— 这正是它一期最有用的部分） */
  audienceSize: number;
  /** 实际调用投递的条数（`dryRun` 时为 0） */
  attempted: number;
  /** `notify()` 返回 `delivered=true` 的条数 */
  delivered: number;
  /** 投递成功的条数 */
  ok: number;
  /** 投递失败的条数（真调了通道但回报失败） */
  failed: number;
  /** 被跳过的条数**按原因分组**（未启用 / 缺模板 ID / 找不到 openid…） */
  skipped: Array<{ reason: string; count: number }>;
  /** 到达率 = `ok / delivered`；`delivered=0` 时为 `null`（**不是 0** —— 0 会被读成「发出去全失败」） */
  reachRate: number | null;
  /** 受众是否超出上限被截断 */
  truncated: boolean;
  limit: number;
  dryRun: boolean;
  note: string;
}

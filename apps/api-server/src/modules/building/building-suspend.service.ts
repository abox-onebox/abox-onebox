import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Not, Repository } from 'typeorm';
import {
  BuildingGroupStatus,
  BuildingStatus,
  OrderStatus,
  ORDER_STATUS_VIEW,
  ORDER_TERMINAL_STATUS,
} from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { BizConfigService } from '../../common/services/biz-config.service';
import {
  decideSuspend,
  groupOf,
  hintKeyOf,
  isUnfinished,
  suspendBlockCode,
  SuspendCounts,
  SuspendHintKey,
  SuspendScope,
} from '../../common/utils/suspend-gate';
import { todayBj } from '../../common/utils/time';
import { NOTIFY_PAGES } from '../admin/template/message-template.specs';
import { Order } from '../../database/entities/order.entity';
import { MessageService } from '../message/message.service';
import { UpdateBuildingDto, UpdateBuildingGroupDto } from './dto/building-admin.dto';

/**
 * N2 停用被拦时的 hint —— 与 `GROUP_SUSPENDED_HINT` 同一写法：**错什么 + 怎么修**
 *
 * ⚠️ 为什么必须区分「卡退款审批」与「待履约」：8 态里 `refund_applying` / `refunding`
 *    和 `paid` 一样会被闸门拦下，但运营该做的动作完全不同。不区分的话他看到
 *    「有未完结订单」却不知道该去点退款审批还是去等配送，最常见的处理是**反复重试停用**
 *    —— 把一次配置疏漏变成一串无效操作日志。
 */
const SUSPEND_HINT: Record<SuspendHintKey, string> = {
  refund_stuck:
    '有订单卡在退款审批 —— 停用不会推进退款，也不会取消它。请先去退款审批放行或驳回，再停用。',
  fulfill_pending:
    '有订单待履约 —— 停用不等于退款，这些单会照常配送。确认无需配送后再停用，或先逐单退款。',
  irrevocable:
    '已有订单进入履约阶段（已截单 / 出餐 / 在途 / 已送达），供应商已按份数备货，无法通过停用撤回 —— 只能逐单走 force_refund 审批。',
  threshold:
    '未完结订单数超过单人可强制停用的上限，force 在此无效 —— 须走高危操作审批（两级 approve→execute）。',
};

/** 未完结订单样例条数（只用于出参 `samples`，不参与判定） */
const SUSPEND_SAMPLE_SIZE = 5;

/**
 * 单次停用**最多通知多少人**（防误触全量；与编排侧 `DEFAULT_LIMIT=500` 同量级）
 *
 * ⚠️ 为什么要有上限：停用是**一次点击**，而它的通知面是「这栋楼所有未完结订单」。
 *    真出现几百笔存量单时，那不是通知，是群发事故 —— 且失败行会一起写进 `ab_message`，
 *    把这张表（语义是「发过什么」）冲淡。超上限只处理最早的一批并**如实 WARN**。
 */
const SUSPEND_NOTIFY_LIMIT = 500;

/**
 * 楼宇 / 楼群停用闸门 + 强制停用后的存量订单通知（从 `BuildingAdminService` 拆出，
 * 见 T5 拆分方案 · 第一步）
 *
 * 本服务只持有与停用判定/通知相关的依赖：未完结订单表、停用阈值配置、消息投递。
 * 停用判定的**纯函数**部分（`decideSuspend` / `groupOf` / `isUnfinished` / `suspendBlockCode`
 * / `hintKeyOf`）在 `common/utils/suspend-gate.ts`，本服务只做 IO 编排与 HTTP 契约翻译。
 */
@Injectable()
export class BuildingSuspendService {
  private readonly logger = new Logger('BuildingSuspend');

  constructor(
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    /** 闸门阈值 `building.suspend_force_max_count`（`@Global()` 的 CommonModule 已导出） */
    private readonly bizConfig: BizConfigService,
    /**
     * 强制停用放行后通知存量订单用户（spec §6.5）
     *
     * ⚠️ 用的是 **投递侧** `MessageService.notify()`，不是编排侧
     *    `MessageOrchestratorService.orchestrate()` —— 理由见 `notifySuspendAffected()`。
     *    投递规则（场景 / 启用闸门 / 渠道 / 收件人解析 / 落 `ab_message`）仍只在
     *    `message.service.ts` 一处，本服务不写第二份。
     */
    private readonly message: MessageService,
  ) {}

  /**
   * 未完结订单谓词 —— **全仓唯一实现**，禁止在别处再写一份 `Not(In([...]))`
   *
   * ⚠️ 必须**反算**（终态之外皆未完结）：硬编码未完结清单是 fail-open —— 将来状态机
   *    新增非终态时它默认放行且无任何信号；反算是 fail-closed，新增状态自动受拦。
   *
   * ⚠️ `mealDate >= todayBj()`：历史订单（已过出餐日）不算「未完结」—— 它们的钱、
   *    货、佣金都已走完自己的通道，停用不影响它们，不该拿来挡运营。
   */
  private unfinishedWhere() {
    return { status: Not(In(ORDER_TERMINAL_STATUS)), mealDate: MoreThanOrEqual(todayBj()) };
  }

  /**
   * 统计某个作用域下的未完结订单（8 态）
   *
   * ⚠️ 楼群**按 `building_group_id` 查、不查成员楼名单**：60003 要求先清空成员楼才能停用，
   *    等你真能停用时名单已空，查出来是假绿；而历史订单的 `building_group_id` 是**快照**，
   *    楼搬走后历史单仍指向旧群 —— 只有按它查才抓得到「人已走、债还在」的单。
   *
   * ⚠️ `groupB` 由 `total - groupA` 得出，不单独查：两组的并集恒等于未完结全集
   *    （未知状态按保守侧归 A，见 `groupOf`），分开查反而会造出「两边加起来不等于总数」
   *    的静默不一致。
   */
  private async countSuspendable(scope: SuspendScope, id: number): Promise<SuspendCounts> {
    const col = scope === 'building' ? 'o.building_id' : 'o.building_group_id';

    /**
     * ① 按状态聚合计数（**一条 SQL，最多十几行**）
     *
     * ⚠️ 为什么不在 SQL 里写 `status NOT IN (...)`：那样就等于把「哪些状态算未完结」
     *    又写了一遍 —— 判据从此有 SQL 和 TS 两份表述，改一边漏一边正是本批在治的病。
     *    这里**故意把全状态都取回来**（`GROUP BY` 后行数恒定），由 `isUnfinished()` /
     *    `groupOf()` 在 TS 侧判定 —— 判据因此**只有一份**。
     */
    const rows = await this.orderRepo
      .createQueryBuilder('o')
      .select('o.status', 'status')
      .addSelect('COUNT(*)', 'n')
      .where(`${col} = :id`, { id })
      .andWhere('o.meal_date >= :today', { today: todayBj() })
      .groupBy('o.status')
      .getRawMany<{ status: string; n: string | number }>();

    let total = 0;
    let groupB = 0;
    let refundStuck = 0;
    let fulfillPending = 0;
    for (const r of rows) {
      const n = Number(r.n);
      if (!isUnfinished(r.status)) continue;
      total += n;
      if (groupOf(r.status) === 'B') {
        groupB += n;
        // B 组内部再分两小类：运营的下一步动作完全不同（见 SUSPEND_HINT）
        if (r.status === OrderStatus.REFUND_APPLYING || r.status === OrderStatus.REFUNDING) {
          refundStuck += n;
        } else {
          fulfillPending += n;
        }
      }
    }

    /** ② 样例与 A 组单号：都只取头几条，不参与判定；A/B 同样交给 `groupOf()` 判 */
    const where = {
      ...this.unfinishedWhere(),
      ...(scope === 'building' ? { buildingId: id } : { buildingGroupId: id }),
    };
    const [samples, aRows] = await Promise.all([
      this.orderRepo.find({
        where,
        order: { mealDate: 'ASC' },
        take: SUSPEND_SAMPLE_SIZE,
        select: { orderNo: true, mealDate: true, status: true },
      }),
      this.orderRepo.find({
        where,
        order: { mealDate: 'ASC' },
        take: 10,
        select: { orderNo: true, status: true },
      }),
    ]);

    return {
      total,
      groupA: total - groupB,
      groupB,
      refundStuck,
      fulfillPending,
      aOrderNos: aRows.filter((r) => groupOf(r.status) === 'A').map((r) => r.orderNo),
      earliestMealDate: samples.length ? samples[0].mealDate : null,
      samples: samples.map((r) => ({
        orderNo: r.orderNo,
        mealDate: r.mealDate,
        statusLabel: ORDER_STATUS_VIEW[r.status as OrderStatus]?.admin ?? r.status,
      })),
    };
  }

  /**
   * 闸门执行（楼宇 / 楼群共用，唯一出口）
   *
   * ⚠️ 抛码的**决策**来自 `decideSuspend()`，本方法只负责把它翻译成 HTTP 契约
   *    （错误码 + payload）。payload 里 `hint` 的分支选择也来自纯函数 `hintKeyOf()`。
   *
   * ⚠️ **通知不在这里发**：`MessageService` 的硬约束②是「投递点必须在业务事务之外」，
   *    而本方法跑在 `patch.status` 赋值与 `save()` **之前** —— 此时发通知，一旦后续
   *    保存失败，就是「用户收到『照常配送』而楼其实没被停用」。故这里只**回带**
   *    `forced`，由调用方在 `save()` 之后调 `notifySuspendAffected()`。
   */
  private async runSuspendGate(
    scope: SuspendScope,
    id: number,
    targetSuspended: boolean,
    forceSuspend: boolean,
  ): Promise<{ unfinishedCount: number; forced: boolean }> {
    const counts = await this.countSuspendable(scope, id);
    const threshold = await this.bizConfig.suspendForceMaxCount();
    const d = decideSuspend({ scope, targetSuspended, counts, threshold, forceSuspend });

    if (d.kind === 'allow') return { unfinishedCount: counts.total, forced: false };
    if (d.kind === 'allow_forced') {
      /**
       * 放行，但两件事不能省：
       *   · 审计 —— 控制器上既有的 `@OperationLog` 会记**请求体**（`forceSuspend` /
       *     `suspendReason` 都在里面）与**响应体**（响应里的 `notifyFailedCount` 会
       *     一并落到 `response_data`），本处**不另写一份日志**（写就是第二份审计）。
       *   · 通知 —— B 组用户必须被告知，见 `notifySuspendAffected()`。
       */
      return { unfinishedCount: counts.total, forced: true };
    }

    throw new BizException(suspendBlockCode(scope, d.reason) as ErrorCode, undefined, undefined, {
      unfinishedCount: counts.total,
      groupA: { count: counts.groupA, orderNos: counts.aOrderNos },
      groupB: { count: counts.groupB },
      earliestMealDate: counts.earliestMealDate,
      samples: counts.samples,
      threshold,
      hint: SUSPEND_HINT[hintKeyOf(counts, d.reason)],
      opCode: scope === 'building' ? 'suspend_building' : 'suspend_building_group',
    });
  }

  /** 楼宇停用闸门 —— 在 `patch.status` 赋值**之前**调用（拦下时楼的状态尚未被改） */
  async assertBuildingSuspendable(
    id: number,
    dto: UpdateBuildingDto,
  ): Promise<{ forced: boolean }> {
    return this.runSuspendGate(
      'building',
      id,
      dto.status === BuildingStatus.SUSPENDED,
      dto.forceSuspend === true,
    );
  }

  /** 楼群停用闸门 —— 在 60003（成员非空）闸门**之后**调用：先判便宜的，再判贵的 */
  async assertGroupSuspendable(
    gid: number,
    dto: UpdateBuildingGroupDto,
  ): Promise<{ forced: boolean }> {
    return this.runSuspendGate(
      'building_group',
      gid,
      dto.status === BuildingGroupStatus.SUSPENDED,
      dto.forceSuspend === true,
    );
  }

  /**
   * 强制停用放行后，通知存量订单用户（spec §6.5 · 场景 `building_suspend_fulfill`
   * / `building_suspend_refund`，声明在 `admin/template/message-template.specs.ts`）
   *
   * 返回**没通知到的人数**（`0` = 全部通知到位）。
   *
   * ## ⚠️ 为什么调 `MessageService.notify()` 而不是编排侧 `orchestrate()`
   *
   * 不是另起一套 —— `orchestrate()` 内部就是**逐条调 `notify()`**（见其类头），
   * 投递规则（场景 / 启用闸门 / 渠道 / 收件人 openid 解析 / 落 `ab_message`）**仍只有一份**。
   * 是 `orchestrate()` 的**受众模型装不下**这件事，三条都是硬冲突：
   *   1. `resolveAudience()` 的口径是「近 N 天下过单 **且目标日尚未下单**」，而我们要
   *      通知的恰恰是「**已经下单、单还没完结**」的人 —— 两者互为补集，按它解析
   *      出来的受众**恒为空**，且出参 `audienceSize=0` 看起来完全正常（**静默零投递**）；
   *   2. `orchestrate()` 一次只带**一个** `mealDate`，而存量订单**每人每单的出餐日不同**，
   *      统一填一个日期，就是给用户发一条日期写错的话；
   *   3. 它的日级去重键 `orchestrate:sent:{scene}:{mealDate}:{today}` 会让同一天
   *      **第二次停用直接抛 `DUPLICATE_SUBMIT`** —— 两次停用是两栋楼、两批人，却被当重复。
   *
   * ## ⚠️ 两批两套模板，绝不合成一套（D-N2-3b）
   *
   * `paid` 的人最终拿到**餐**，`refunding` 的人最终拿到**退款**。合成一句「照常配送」，
   * 会让一个正在退款的用户据此**不做午饭安排** —— 不发是失职，发错是误导。
   *
   * ## ⚠️ 不阻断 / 不重试
   *
   * 整块包在 try/catch 里，任何失败都不改变「楼已停用」这个结果；**不做自动重试**
   * （重复打扰），留运营按 `ab_message` 的失败行手动补发。
   */
  async notifySuspendAffected(scope: SuspendScope, id: number): Promise<number> {
    let attempted = 0;
    let notified = 0;
    const skipped = new Map<string, number>();

    try {
      const rows = await this.orderRepo.find({
        where: {
          ...this.unfinishedWhere(),
          ...(scope === 'building' ? { buildingId: id } : { buildingGroupId: id }),
        },
        select: { id: true, orderNo: true, userId: true, mealDate: true, status: true },
        order: { mealDate: 'ASC' },
        take: SUSPEND_NOTIFY_LIMIT,
      });
      if (rows.length >= SUSPEND_NOTIFY_LIMIT) {
        this.logger.warn(
          `停用通知受众达到上限 ${SUSPEND_NOTIFY_LIMIT}（scope=${scope} id=${id}）：` +
            '只处理最早的一批，其余**不会自动补发** —— 请拆分处理或人工核对',
        );
      }

      /**
       * 只通知 **B 组**：A 组（已截单及之后）已在履约链上，「照常配送」是它唯一
       * 可能的结局，再发一条属于打扰（原型「常规状态不推」同一原则）。
       * ⚠️ 分组仍由 `groupOf()` 判 —— 不在这里手抄一份状态清单。
       */
      const targets = rows.filter((r) => r.userId && groupOf(r.status) === 'B');
      attempted = targets.length;

      const results = await Promise.all(
        targets.map(async (o) => {
          const mealDate = String(o.mealDate);
          try {
            const r = await this.message.notify({
              scene:
                o.status === OrderStatus.REFUND_APPLYING || o.status === OrderStatus.REFUNDING
                  ? 'building_suspend_refund'
                  : 'building_suspend_fulfill',
              userId: Number(o.userId),
              page: NOTIFY_PAGES.orderDetail,
              /**
               * ⚠️ `orderNo` **必须**进 `variables`：它落进 `ab_message.payload`，
               *    是 spec §6.5「让运营事后看得到……是谁」那一条里「是谁」的唯一凭据。
               *    只记 `notifyFailedCount` 一个数字，事后无从知道漏的是哪几笔。
               *    ⚠️ 它**不进** `wxData`（用户看不到，也不是模板变量）—— 两者不是一回事：
               *    `wxData` 是给用户看的内容，`variables` 是给排查看的落库字段。
               */
              variables: { mealDate, orderNo: String(o.orderNo) },
              wxData: { mealDate: { value: mealDate } },
            });
            return {
              ok: r.delivered && r.ok === true,
              reason: r.delivered
                ? (r.errMsg ?? '通道未回报')
                : (r.reason ?? '未投递（未给出原因）'),
            };
          } catch (e) {
            return { ok: false, reason: e instanceof Error ? e.message : String(e) };
          }
        }),
      );

      for (const r of results) {
        if (r.ok) notified += 1;
        else skipped.set(r.reason, (skipped.get(r.reason) ?? 0) + 1);
      }
    } catch (e) {
      // ⚠️ 连查询都失败时**受众规模未知** —— 这种失败不能回 `0`（那会被读成
      //    「都通知到了」）。回 `1` 表示「至少一次失败、且规模未知」，并单独留痕。
      this.logger.warn(
        `停用通知未能执行（scope=${scope} id=${id}）：${e instanceof Error ? e.message : String(e)}` +
          ' —— 停用**不受影响**，但存量订单用户本轮没有收到任何告知，请人工补发',
      );
      return attempted - notified + 1;
    }

    const failed = attempted - notified;
    if (failed > 0) {
      this.logger.warn(
        `停用通知未完成（scope=${scope} id=${id}）：目标 ${attempted} 人、已通知 ${notified} 人、` +
          `未通知 ${failed} 人（${[...skipped].map(([r, n]) => `${r}×${n}`).join('、')}）` +
          ' —— 不自动重试，请按 `ab_message` 的失败行手动补发',
      );
    }
    return failed;
  }
}

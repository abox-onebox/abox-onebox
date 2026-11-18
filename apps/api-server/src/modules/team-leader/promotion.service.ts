import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { LEADER_LEVEL_META, LeaderLevel, LeaderStatus } from '@abox/shared-types';

import { BizConfigService } from '../../common/services/biz-config.service';
import {
  addDays,
  bjMinuteText,
  daysBetween,
  monthRangeOf,
  now,
  toBjIso,
  todayBj,
} from '../../common/utils/time';
import { Commission } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { NOTIFY_PAGES } from '../admin/template/message-template.specs';
import { MessageService } from '../message/message.service';
import { LeaderInviteService } from './invite.service';
import { LeaderLevelService } from './level.service';

/** 单次审计结果（供 e2e / 日志观测） */
export interface PromotionAuditResult {
  leaderId: number;
  /** 审计前的等级 */
  before: string;
  /** 审计后的等级（未升级则与 before 相同） */
  after: string;
  /** 是否发生了升级 */
  promoted: boolean;
  /** 本次实算的当月完成份数（已落表） */
  monthOrders: number;
  /** 本次实算的介绍转正数（已落表） */
  invitedFormalCount: number;
  /** 审计后的当前费率（随 `after` 联动；未升级时 = 原费率），供调用方直接回显 */
  rate: number;
  /** 是否因本次审计把「被邀请人已转正」标记为真并回写了邀请人 */
  formalFlipped: boolean;
  /** 链式晋级：邀请人（如有）的审计结果 */
  inviterAudit?: PromotionAuditResult;
}

/** 链式晋级最大递归深度（防数据环：A 邀请 B、B 又邀请 A） */
const MAX_CHAIN_DEPTH = 4;

/**
 * 见习期长度（天）—— 自「最近一次出单」或「建档」起算，超期即停职
 *
 * ⚠️ 失效判定（`expireTrainees`）与到期预警（`warnExpiringTrainees`）**必须**共用它：
 *    两处各写一个 30，改一处漏一处就会出现「预警说还剩 5 天、其实今天已经失效」
 *    这种最难解释的不一致。
 */
export const TRAINEE_EXPIRE_DAYS = 30;

/**
 * 到期预警提前天数 —— 恰好剩这么多天时提醒**一次**
 *
 * 取 7 天（一个完整周盒周期）：够他安排一次促单，又不会早到被遗忘。
 */
export const TRAINEE_WARN_DAYS = 7;

/**
 * 团长晋级审计（C2 · M2-2.9「推荐裂变与晋级审计」）
 *
 * 【为什么需要它】
 *   等级与费率是**结果**，不是输入：`ab_team_leader.level / commission_rate` 必须由
 *   「当月完成份数 + 介绍转正数」**推导**并落表。缺了本服务，`resolveLevel` 只是
 *   一个没人调用的纯函数 —— P16 的进度条会永远停在种子值。
 *
 * 【口径（唯一来源：@abox/shared-types 的 resolveLevel）】
 *   · **月单** = 当自然月 `ab_commission` 的份数合计（按 `meal_date` 归月）
 *     —— 佣金行是按「实发份数」落的（剔除退款），故月单天然等于 C2 语义的
 *        「本月已完成份数」，无需再 JOIN 订单表。
 *     ⚠️ 反向冲销行（M3 `reversal.service`）必须以**负数量**落库，否则本口径会虚高，
 *        故此处显式做 `type='reversal' → -quantity` 折算，不依赖写入方记得取负。
 *   · **介绍转正数** = `ab_leader_invite` 中「本人邀请 且 已达正式及以上」的条数；
 *     与 `ab_team_leader.invited_formal_count`（后台可人工修正）**取大**，
 *     与 L16 的呈现口径一致（否则「能看到晋级却升不了级」）。
 *   · **只升不降**：`resolveLevel` 不满足条件时返回见习，若直接落表会把首席降成见习。
 *     本服务只在 `target` 严格高于当前等级时升级；降级只由 `leader-expire.task`
 *     （见习 30 天未促单）与后台人工操作触发。
 *
 * 【链式晋级】被邀请人升到「正式」及以上时，邀请人的「介绍转正数」+1，
 *   邀请人可能因此**立刻满足**更高一级的双条件 —— 故回写后递归审计邀请人
 *   （深度上限 `MAX_CHAIN_DEPTH`，防数据环）。
 *
 * 【幂等】全部按当前值重算后**条件更新**，重复执行结果一致；不产生重复流水。
 */
@Injectable()
export class LeaderPromotionService {
  private readonly logger = new Logger('LeaderPromotion');

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>,
    private readonly inviteService: LeaderInviteService,
    private readonly levelService: LeaderLevelService,
    private readonly bizConfig: BizConfigService,
    private readonly message: MessageService,
  ) {}

  /**
   * 当月已完成份数（C2「月单」）
   *
   * ## ⭐ 口径一：`pending` + `settled` 都要算（2026-09-17 · M4-2 两段式定稿）
   *
   * ⚠️ 原先只算 `status='settled'`。两段式（计佣写 `pending` → T+1 02:00 入账）上线后，
   *   若继续只算 `settled`，**一个纯资金动作会把一条业务判定拖慢一天**：团长 T 日
   *   确认的 30 单已让 `month_orders` 达标，却要等 T+1 02:00 入账才被认定为「金牌」。
   *   而「月单」问的是**本月促成了多少单**（事实），不是「多少钱已入账」（钱）。
   *   仍**排除** `cancelled`（佣金被冲销 = 该单退款，事实已不成立）。
   *
   * ## ⭐ 口径二：只数 `type='normal'` 且未被冲销的行（同批修真 bug）
   *
   * 原实现是 `SUM(CASE WHEN type='reversal' THEN -quantity ELSE quantity END)`，
   * 配合 `status='settled'` 过滤 —— **两者互相抵消不掉，反而重复计**：
   *   · 冲销时 `reverseCommission` 会把**原行**置 `cancelled`（→ 被 status 条件排除，−q）
   *   · 同时写一条 `type='reversal'`、`quantity` **为负**的冲销行（`-q`）
   *   · 而 CASE 里 `-c.quantity` 把负号**又翻正**（`+q`）
   * 净效果：退款单被排除后又加了回来 —— **月单不降反平**，团长可以靠退款单把
   * `month_orders` 刷到达标线而晋级（C2 是真金白银的费率提升）。
   *
   * 修法：本方法只回答「**本月有几份有效订单**」，故只取正常行、且已被冲销的行
   * 自然被 `status` 排除；**冲销行整体不参与计数**（钱的反向已由「原行被排除」体现，
   * 再加一条负数量就是重复扣）。写成 `type='normal'` + `status IN (pending, settled)`
   * 是**单一真相**的表述 —— 不要再引入按 `type` 分叉的 CASE。
   *
   * ⚠️ 判据：凡以 `ab_commission.status` 为条件的统计，先问「**它统计的是事实还是钱**」；
   *    事实类（单数、份数、活跃度）不看资金状态、也不能把冲销行当独立事件累加，
   *    钱类（余额、待入账）才看状态。
   *
   * @param at 归月基准（缺省今日）；e2e 可用它构造确定性断言
   */
  async monthOrdersOf(leaderId: number, at: string = todayBj()): Promise<number> {
    const { from, to } = monthRangeOf(at);

    const raw = await this.dataSource
      .getRepository(Commission)
      .createQueryBuilder('c')
      .select('COALESCE(SUM(c.quantity), 0)', 'qty')
      .where('c.teamLeaderId = :id', { id: leaderId })
      // ⭐ 只数正常行；已被冲销的原行为 cancelled、冲销行为 reversal，两者都排除
      .andWhere("c.type = 'normal'")
      .andWhere('c.status IN (:...st)', { st: ['pending', 'settled'] })
      .andWhere('c.mealDate BETWEEN :from AND :to', { from, to })
      .getRawOne<{ qty: number | string }>();

    return Math.max(0, Number(raw?.qty ?? 0));
  }

  /**
   * 审计一个团长：实算指标 → 落表 → 必要时升级 → 必要时回写邀请人并**链式**审计
   *
   * @param leaderId  `ab_team_leader.id`（不是 user_id）
   * @param depth     内部使用，限制链式递归
   * @param opts.notify
   *   升级时**是否推送晋级通知**（缺省 `true`）。
   *
   *   ## 为什么默认发、却必须留一个关闭口
   *
   *   晋级 = 佣金率上涨，是本系统里**唯一纯好消息的自动状态翻转**，团长必须知道。
   *   但有两个场景不能发：
   *   ① **L22 团长自己点「重新核算晋级进度」**（`team-leader.controller.ts`）——
   *      升级结果当场显示在他屏幕上，再推一条微信是重复打扰；
   *   ② 后台/脚本的**批量重算**（`auditAll` 用于修数据）—— 一次扫几百人，
   *      会给全体团长群发一遍「恭喜晋级」。此时调用方显式传 `false`。
   *
   *   ⚠️ 判据写成 `opts.notify !== false`（而不是 `=== true`）：漏传要发，
   *      这是刻意的默认值方向 —— **忘了传的代价是「多一条好消息」，
   *      而不是「团长永远不知道自己的费率变了」**。
   */
  async audit(
    leaderId: number,
    depth = 0,
    opts: { notify?: boolean } = {},
  ): Promise<PromotionAuditResult | null> {
    const leader = await this.leaderRepo.findOne({ where: { id: leaderId } });
    if (!leader) return null;

    // 已停职者不再参与晋级（保留历史等级，复职时由 apply 重置为见习）
    const monthOrders = await this.monthOrdersOf(leaderId);
    const counted = await this.inviteService.countFormal(leaderId);
    const invitedFormalCount = Math.max(counted, Number(leader.invitedFormalCount));

    const target = this.levelService.resolve(monthOrders, invitedFormalCount);
    const promoted = this.levelService.isHigher(target, leader.level);
    const after = promoted ? target : leader.level;

    // 指标无条件落表（即便未升级）—— 「月单」「介绍转正数」是审计的**产物**，
    // 不落表则 P16 进度条只能用陈旧种子值（这正是 2.9 要补的「数据落表」）。
    const patch: Partial<TeamLeader> = {
      monthOrders,
      invitedFormalCount,
    };
    let rate = Number(leader.commissionRate);
    if (promoted) {
      rate = await this.bizConfig.commissionRate(after);
      patch.level = after;
      patch.levelUpdatedAt = new Date();
      patch.commissionRate = rate.toFixed(4);
    }

    await this.leaderRepo.save({ ...leader, ...patch });

    const result: PromotionAuditResult = {
      leaderId,
      before: leader.level,
      after,
      promoted,
      monthOrders,
      invitedFormalCount,
      rate,
      formalFlipped: false,
    };

    if (promoted) {
      this.logger.log(
        `晋级：团长#${leaderId} ${leader.level} → ${after}` +
          `（月单 ${monthOrders} / 介绍转正 ${invitedFormalCount}，费率 ${patch.commissionRate}）`,
      );
      if (opts.notify !== false) {
        await this.notifyPromoted(Number(leader.userId), leader.level, after, rate);
      }
    }

    // ---- 推荐关系回写：被邀请人达「正式及以上」→ 标记 is_formal 并给邀请人 +1 ----
    const flipped = await this.inviteService.markFormal(leader.userId, after as LeaderLevel);
    if (!flipped) return result;
    result.formalFlipped = true;

    const invite = await this.inviteService.findByInvitee(leader.userId);
    const inviterLeaderId = invite?.inviterLeaderId;
    if (!inviterLeaderId) return result; // 自荐申请无邀请人

    // 邀请人计数 +1（只增；重复审计不会重复加，因为 markFormal 只翻转一次）
    const inviter = await this.leaderRepo.findOne({ where: { id: Number(inviterLeaderId) } });
    if (inviter) {
      await this.leaderRepo.save({
        ...inviter,
        invitedFormalCount: Number(inviter.invitedFormalCount) + 1,
      });
    }

    if (depth + 1 < MAX_CHAIN_DEPTH) {
      // ⚠️ `opts` 必须**透传**：链式晋升里升的是**邀请人**，不是本人 ——
      //    漏传就等于「邀请人被升级了却收不到通知」，而这正是裂变链条上最该被强化的那一环。
      const inviterAudit = await this.audit(Number(inviterLeaderId), depth + 1, opts);
      if (inviterAudit) result.inviterAudit = inviterAudit;
    } else {
      this.logger.warn(
        `晋级链式审计已达深度上限（${MAX_CHAIN_DEPTH}），跳过邀请人 ${inviterLeaderId}`,
      );
    }

    return result;
  }

  /**
   * 批量审计（供定时任务使用）：只处理在职团长
   *
   * @returns 汇总计数
   */
  async auditAll(manager?: EntityManager): Promise<{ scanned: number; promoted: number }> {
    const repo = manager ? manager.getRepository(TeamLeader) : this.leaderRepo;
    const leaders = await repo.find({
      where: { status: LeaderStatus.ACTIVE },
      select: { id: true },
    });

    let promoted = 0;
    for (const l of leaders) {
      // ⚠️ 批量重算是修数据，不是逐人庆祝：一次扫几百人若按默认发通知，
      //    会群发一遍「恭喜晋级」——那些晋级可能已是几天前的事实，纯属骚扰。
      //    真正的业务触发点（确认分发 / 每日自动确认）走 audit() 的默认发。
      const r = await this.audit(Number(l.id), 0, { notify: false });
      if (r?.promoted) promoted += 1;
    }
    return { scanned: leaders.length, promoted };
  }

  /**
   * 见习团长 30 天未促单 → 取消资格（C2 · 停职）
   *
   * 判据：`level = trainee` 且 `status = 在职` 且北京日期差 `≥ 30 天`
   *（即预警文案承诺的失效日当天，由 03:00 跑批停职）。
   * ⚠️ `last_order_at` 为空（从未促单）视为**自建档时间起算** —— 否则「从未出过单」
   *    的见习团长会永久免于失效，与 C2 语义相反。
   *
   * @returns 被停职的团长 id 列表（幂等：重复执行第二次返回空）
   */
  async expireTrainees(days = TRAINEE_EXPIRE_DAYS, at: Date = now()): Promise<number[]> {
    // ⚠️ 与 warnExpiringTrainees 同源：**北京日期差**，不比毫秒。
    //    旧实现是 `anchor < now - 30*24h`：同一天 23:50 出的单，在次日 03:00 会被
    //    多留一天（日期差 30 但毫秒差只有 27h），而预警按日期算「恰好剩 7 天」
    //    已在 7 天前发出 —— 用户被告知 11-18 失效，实际 11-19 才停职。
    const today = todayBj(at);

    const trainees = await this.leaderRepo.find({
      where: { status: LeaderStatus.ACTIVE, level: LeaderLevel.TRAINEE },
    });

    const expiredIds: number[] = [];
    for (const t of trainees) {
      const anchor = t.lastOrderAt ? new Date(t.lastOrderAt) : new Date(t.createdAt);
      const anchorIso = toBjIso(anchor);
      if (!anchorIso) continue;
      const anchorDate = anchorIso.slice(0, 10);
      if (daysBetween(anchorDate, today) < days) continue;

      await this.leaderRepo.save({ ...t, status: LeaderStatus.SUSPENDED });
      expiredIds.push(Number(t.id));
      // ⚠️ 通知**失败不得中断跑批**：一个人发不出去，不该让后面几十个人全都
      //    留在一个「已经在停职中却不知道」的状态里。故单独 try 住、只记日志。
      try {
        await this.notifySuspended(Number(t.userId), `见习期内 ${days} 天未促成订单`, at);
      } catch (e) {
        this.logger.warn(
          `停职通知发送失败（团长#${t.id}，停职本身已生效）：${(e as Error).message}`,
        );
      }
    }

    if (expiredIds.length) {
      this.logger.warn(`见习失效：${expiredIds.length} 名团长已停职（${days} 天未促单）`);
    }
    return expiredIds;
  }

  /**
   * 见习到期预警：找出「恰好还剩 `withinDays` 天到期」的见习团长，逐个提醒
   *
   * ## 为什么判据是「恰好等于」而不是「小于等于」
   *
   * 小于等于会让最后 7 天**每天**发一条 —— 那是骚扰，而且第二天就被无视。
   * 恰好等于 7 天，天然做到「这辈子只发一次」，不需要额外记「发过没发过」的状态。
   *
   * ⚠️ 代价：若某天任务没跑（服务停机 / 锁未释放），这个人就**收不到**预警，
   *    只能等 7 天后的停职通知兜底。这个取舍是刻意的 ——
   *    「偶尔漏一条提醒」比「连续 7 天每天提醒一次」代价小得多。
   *
   * ⚠️ 起算点必须与 `expireTrainees()` **完全同源**（`lastOrderAt ?? createdAt`）：
   *    否则会出现「预警说还有 7 天、失效判据说已经过期」这种谁也解释不清的分裂。
   *
   * @returns 真正发送成功的条数（未启用 / 额度耗尽都不计入）
   */
  async warnExpiringTrainees(withinDays = TRAINEE_WARN_DAYS, at: Date = now()): Promise<number> {
    const today = todayBj(at);
    const trainees = await this.leaderRepo.find({
      where: { status: LeaderStatus.ACTIVE, level: LeaderLevel.TRAINEE },
    });

    let sent = 0;
    for (const t of trainees) {
      const anchor = t.lastOrderAt ? new Date(t.lastOrderAt) : new Date(t.createdAt);
      const anchorIso = toBjIso(anchor);
      if (!anchorIso) continue;
      // `toBjIso` 已换算成北京时间，取前 10 位即「北京日期」
      const anchorDate = anchorIso.slice(0, 10);

      const deadline = addDays(anchorDate, TRAINEE_EXPIRE_DAYS);
      if (daysBetween(today, deadline) !== withinDays) continue;

      /**
       * 文案要说「多久没出单」，**不能说「还差几单」** ——
       * 失效判据是「30 天没有新订单」，与「月度份数没到 30 单」是两件不同的事：
       * 一个首席团长一个月做 5 单照样合规，一个刚上任的见习做 40 单也可能因为
       * 集中在某一天而逼近「30 天无单」。说错这一句，通知就变成了假信息。
       */
      const silentDays = daysBetween(anchorDate, today);
      const title = t.lastOrderAt ? `已 ${silentDays} 天没有新订单` : '上任后一直没有订单';

      try {
        const r = await this.message.notify({
          scene: 'trainee_expiring',
          userId: Number(t.userId),
          // 落工作台：他要看的是「今天有没有团可推」和分享入口，不是佣金明细
          page: NOTIFY_PAGES.leaderWorkbench,
          wxData: {
            noticeTitle: { value: title.slice(0, 20) },
            // 日期口径下 deadline 就是失效日；跑批在当日 03:00 执行，
            // `time` 关键词用 00:00 标定「哪一天」，不要误读成 0 点整停职
            deadlineAt: { value: `${deadline} 00:00` },
          },
          variables: { noticeTitle: title, deadlineAt: deadline },
          dedupeKey: `trainee-warn:${t.id}:${deadline}`,
        });
        if (r.ok) sent += 1;
      } catch (e) {
        this.logger.warn(`到期预警发送失败（团长#${t.id}）：${(e as Error).message}`);
      }
    }

    if (sent) {
      this.logger.log(`见习到期预警：已提醒 ${sent} 名团长（距失效 ${withinDays} 天）`);
    }
    return sent;
  }

  // ==========================================================================
  // 通知投递（2026-11-18 · 团长激活三件套）
  //
  // ## 为什么发通知的代码要收敛到这两个私有方法
  //
  // 晋级有两个触发源（确认分发 / 每日自动确认），停职也有两个（见习期满 / 后台手动）。
  // 每个调用点各自拼一遍 `wxData`，迟早出现「同一件事在两个入口写成两句话」——
  // 与 `cutoffAtText` 被提取进 `time.ts` 是同一个理由（单一实现，不许有第二份）。
  //
  // ## ⚠️ 三条共同纪律
  //
  // 1. **绝不影响主流程**：`MessageService.notify()` 本身承诺不抛异常，但模板表查询
  //    仍可能抛 DB 错。调用方各自 try 住，失败只记 WARN —— 通知是增强，不是业务。
  // 2. **必须带 `dedupeKey`**：同一件事可能经由多个入口触发（见各方法内注）。
  // 3. **`thing` 关键词限 20 字符**：超长微信直接 `47003`，故统一 `slice(0, 20)` 截断。
  // ==========================================================================

  /**
   * 晋级通知（涨钱的事，团长必须知道）
   *
   * @param at 生效时刻；缺省取当前时刻（`bjMinuteText` 按 UTC+8 格式化）
   */
  private async notifyPromoted(
    userId: number,
    before: string,
    after: string,
    rate: number,
    at: Date = now(),
  ): Promise<void> {
    const label = LEADER_LEVEL_META[after as LeaderLevel]?.label ?? after;
    const rateText = pctText(rate);
    // 「金牌团长 · 佣金10%」= 11 字，远未触及 20 字上限，但截断仍要留（等级名可配置）
    const title = `${label}团长 · 佣金${rateText}`.slice(0, 20);
    const effectiveAt = bjMinuteText(at);

    const r = await this.message.notify({
      scene: 'leader_promoted',
      userId,
      page: NOTIFY_PAGES.leaderCommission,
      wxData: {
        noticeTitle: { value: title },
        effectiveAt: { value: effectiveAt },
      },
      variables: { levelLabel: label, rateText, effectiveAt },
      // 同一人同一等级只发一次：链式审计 + 多入口触发之外的第二道保险
      dedupeKey: `promote:${userId}:${after}`,
    });

    if (r.delivered && !r.ok) {
      this.logger.warn(`晋级通知未送达（用户#${userId}，${before}→${after}）：${r.errMsg}`);
    }
  }

  /**
   * 停职通知（必须带上「怎么恢复」这条出路）
   *
   * ⚠️ 停职后 `LeaderGuard` 挡住所有团长端接口、端上 `isLeader` 变 false ⇒
   *    **底部导航的团长入口直接消失**。只说「你被停职了」等于宣布出局，
   *    故落地页指向申请页（`apply` 对停职者有复职分支，等级重置为见习）。
   */
  private async notifySuspended(userId: number, reason: string, at: Date): Promise<void> {
    const suspendedAt = bjMinuteText(at);
    const title = reason.slice(0, 20);

    const r = await this.message.notify({
      scene: 'leader_suspended',
      userId,
      page: NOTIFY_PAGES.leaderApply,
      wxData: {
        noticeTitle: { value: title },
        suspendedAt: { value: suspendedAt },
      },
      variables: { reasonText: reason, suspendedAt },
      dedupeKey: `suspend:${userId}`,
    });

    if (r.delivered && !r.ok) {
      this.logger.warn(`停职通知未送达（用户#${userId}）：${r.errMsg}`);
    }
  }

  /**
   * 供**其他模块**在「运营手动停职」时复用同一条文案与落地页
   *
   * `leader-admin.service.ts` 的 `audit.SUSPEND` 与见习期满自动停职是两回事，
   * 但团长看到的东西必须**一模一样** —— 所以它不能自己拼一份 `wxData`。
   */
  async notifySuspendedFor(userId: number, reason: string): Promise<void> {
    await this.notifySuspended(userId, reason, now());
  }
}

/**
 * 费率 → `8%` / `8.5%` / `12%`
 *
 * ⚠️ 不能用 `replace(/\.?0+$/, '')` 收尾零：`'10.00'` 会被吃成 `'1'`（经典坑），
 *    必须分两步 —— 先删尾零，再删可能残留的小数点。
 */
function pctText(rate: number): string {
  const s = (rate * 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${s}%`;
}

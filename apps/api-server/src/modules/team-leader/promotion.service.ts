import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { LeaderLevel, LeaderStatus } from '@abox/shared-types';

import { BizConfigService } from '../../common/services/biz-config.service';
import { monthRangeOf, todayBj } from '../../common/utils/time';
import { Commission } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
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
  ) {}

  /**
   * 当月已完成份数（C2「月单」）
   *
   * @param at 归月基准（缺省今日）；e2e 可用它构造确定性断言
   */
  async monthOrdersOf(leaderId: number, at: string = todayBj()): Promise<number> {
    const { from, to } = monthRangeOf(at);

    const raw = await this.dataSource
      .getRepository(Commission)
      .createQueryBuilder('c')
      .select(
        "COALESCE(SUM(CASE WHEN c.type = 'reversal' THEN -c.quantity ELSE c.quantity END), 0)",
        'qty',
      )
      .where('c.teamLeaderId = :id', { id: leaderId })
      .andWhere('c.status = :st', { st: 'settled' })
      .andWhere('c.mealDate BETWEEN :from AND :to', { from, to })
      .getRawOne<{ qty: number | string }>();

    return Math.max(0, Number(raw?.qty ?? 0));
  }

  /**
   * 审计一个团长：实算指标 → 落表 → 必要时升级 → 必要时回写邀请人并**链式**审计
   *
   * @param leaderId  `ab_team_leader.id`（不是 user_id）
   * @param depth     内部使用，限制链式递归
   */
  async audit(leaderId: number, depth = 0): Promise<PromotionAuditResult | null> {
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
      const inviterAudit = await this.audit(Number(inviterLeaderId), depth + 1);
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
      const r = await this.audit(Number(l.id));
      if (r?.promoted) promoted += 1;
    }
    return { scanned: leaders.length, promoted };
  }

  /**
   * 见习团长 30 天未促单 → 取消资格（C2 · 停职）
   *
   * 判据：`level = trainee` 且 `status = 在职` 且 `last_order_at` 早于 30 天前。
   * ⚠️ `last_order_at` 为空（从未促单）视为**自建档时间起算** —— 否则「从未出过单」
   *    的见习团长会永久免于失效，与 C2 语义相反。
   *
   * @returns 被停职的团长 id 列表（幂等：重复执行第二次返回空）
   */
  async expireTrainees(days = 30, now = new Date()): Promise<number[]> {
    const deadline = new Date(now.getTime() - days * 24 * 3600 * 1000);

    const trainees = await this.leaderRepo.find({
      where: { status: LeaderStatus.ACTIVE, level: LeaderLevel.TRAINEE },
    });

    const expiredIds: number[] = [];
    for (const t of trainees) {
      const anchor = t.lastOrderAt ? new Date(t.lastOrderAt) : new Date(t.createdAt);
      if (anchor.getTime() >= deadline.getTime()) continue;

      await this.leaderRepo.save({ ...t, status: LeaderStatus.SUSPENDED });
      expiredIds.push(Number(t.id));
    }

    if (expiredIds.length) {
      this.logger.warn(`见习失效：${expiredIds.length} 名团长已停职（${days} 天未促单）`);
    }
    return expiredIds;
  }
}

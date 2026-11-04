import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { CouponService } from '../coupon/coupon.service';
import { AiInsightService } from './ai-insight.service';
import { WecomTokenService } from './wecom-token.service';
import { WecomBindingService } from './wecom-binding.service';
import { Order } from '../../database/entities/order.entity';
import { now, todayBj, toBjIso } from '../../common/utils/time';
import type { CouponValidityType } from '@abox/shared-types';

/** 计为「真实购买」的订单状态（排除未付/截单/取消/退款） */
const VALID_ORDER_STATUSES = ['paid', 'cooked', 'delivering', 'delivered', 'completed'];
/** 流失判定：最近一单距今超过该天数视为流失 */
const CHURN_DAYS = 14;
/** 复购判定：累计有效订单数 ≥ 该值视为复购客 */
const REPUCHASE_MIN_ORDERS = 2;

export type RecallSegment = 'repurchase' | 'churn';

export interface RecallCouponSpec {
  name: string;
  /** 面额（分） */
  faceValueFen: number;
  /** 门槛（分）；0 = 无门槛 */
  thresholdFen: number;
  validityType: CouponValidityType;
  /** validityType=days 时有效 */
  validDays: number;
}

export interface SegmentPlan {
  segment: RecallSegment;
  userIds: number[];
  count: number;
  coupon: RecallCouponSpec;
}

export interface RecallPreview {
  generatedAt: string;
  rangeNote: string;
  segments: SegmentPlan[];
}

export interface RecallConfirmResult {
  pushed: boolean;
  reason?: string;
  sentAt: string | null;
  segments: Array<{
    segment: RecallSegment;
    targetCount: number;
    couponDefId: number | null;
    grantedCount: number;
    skippedCount: number;
    batchNo: string;
  }>;
}

/** 每个人群档位的默认券方案（内部「测算示例」，运营确认前可在前端改） */
export function defaultCouponSpec(segment: RecallSegment): RecallCouponSpec {
  if (segment === 'repurchase') {
    return {
      name: '老客回馈券（测算示例）',
      faceValueFen: 500,
      thresholdFen: 0,
      validityType: 'days',
      validDays: 7,
    };
  }
  return {
    name: '召回专享券（测算示例）',
    faceValueFen: 800,
    thresholdFen: 0,
    validityType: 'days',
    validDays: 7,
  };
}

export interface ClassifyRow {
  userId: number;
  cnt: number;
  lastAt: Date;
}

/**
 * 纯函数：把「用户 → 订单聚合行」分类为复购客 / 流失客（零 IO，便于单测钉死）。
 *
 * - 复购：累计有效订单 ≥ REPUCHASE_MIN_ORDERS
 * - 流失：至少 1 单，且最近一单 < at - CHURN_DAYS
 * 两者可重叠（一个买过多次但已沉寂的人，既算复购也算流失召回对象）。
 */
export function classifyUsers(
  rows: ClassifyRow[],
  at: Date,
  opts: { churnDays?: number; repurchaseMin?: number } = {},
): { repurchase: number[]; churn: number[] } {
  const churnDays = opts.churnDays ?? CHURN_DAYS;
  const repurchaseMin = opts.repurchaseMin ?? REPUCHASE_MIN_ORDERS;
  const cutoff = new Date(at.getTime() - churnDays * 86_400_000);
  const repurchase: number[] = [];
  const churn: number[] = [];
  for (const r of rows) {
    if (r.cnt >= repurchaseMin) repurchase.push(r.userId);
    if (r.cnt >= 1 && r.lastAt.getTime() < cutoff.getTime()) churn.push(r.userId);
  }
  return { repurchase, churn };
}

@Injectable()
export class RecallCampaignService {
  private readonly logger = new Logger(RecallCampaignService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly couponSvc: CouponService,
    private readonly aiInsight: AiInsightService,
    private readonly tokenSvc: WecomTokenService,
    private readonly bindingSvc: WecomBindingService,
  ) {}

  /** 拉取并聚合「用户 → 有效订单数 / 最近下单时刻」 */
  private async loadOrderAggregates(): Promise<ClassifyRow[]> {
    const raw = await this.dataSource
      .getRepository(Order)
      .createQueryBuilder('o')
      .select('o.userId', 'userId')
      .addSelect('COUNT(*)', 'cnt')
      .addSelect('MAX(o.createdAt)', 'lastAt')
      .where('o.status IN (:...sts)', { sts: VALID_ORDER_STATUSES })
      .groupBy('o.userId')
      .getRawMany<{ userId: string; cnt: string; lastAt: Date }>();
    return raw.map((r) => ({
      userId: Number(r.userId),
      cnt: Number(r.cnt),
      lastAt: r.lastAt instanceof Date ? r.lastAt : new Date(r.lastAt),
    }));
  }

  /** 预览：圈人 + 给出每个档位的默认券方案（不写库、不发券） */
  async preview(): Promise<RecallPreview> {
    const at = now();
    const rows = await this.loadOrderAggregates();
    const { repurchase, churn } = classifyUsers(rows, at);
    const segments: SegmentPlan[] = [
      {
        segment: 'repurchase',
        userIds: repurchase,
        count: repurchase.length,
        coupon: defaultCouponSpec('repurchase'),
      },
      { segment: 'churn', userIds: churn, count: churn.length, coupon: defaultCouponSpec('churn') },
    ];
    return {
      generatedAt: toBjIso(at) ?? '',
      rangeNote: `基于「有效订单状态 ${VALID_ORDER_STATUSES.join('/')}」聚合；流失口径 = 最近一单 > ${CHURN_DAYS} 天前`,
      segments,
    };
  }

  private async resolveOwnerUserId(): Promise<string | null> {
    const envId = (process.env.WECOM_OWNER_USERID || '').trim();
    if (envId) return envId;
    try {
      const owners = (await this.bindingSvc.list()).filter((b) => b.tier === 'owner');
      return owners[0]?.userId ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 确认发放（手动触发，不建 cron）。
   *
   * 流程：重算人群 → 每个档位建券种（createDef）→ 批量发券（grantBatch，幂等键按 档位+日期）→
   * 记台账 → 推摘要给负责人企微。
   * `dryRun=true` 时 grantBatch 只试算不写库（券种仍会建，便于核对人数）。
   */
  async confirm(dto: {
    segments: RecallSegment[];
    dryRun?: boolean;
    actorName?: string | null;
  }): Promise<RecallConfirmResult> {
    const at = now();
    const rows = await this.loadOrderAggregates();
    const { repurchase, churn } = classifyUsers(rows, at);
    const userIdsBySeg: Record<RecallSegment, number[]> = { repurchase, churn };

    const segments: RecallConfirmResult['segments'] = [];
    const summaryLines: string[] = [];

    for (const seg of dto.segments) {
      const userIds = userIdsBySeg[seg] ?? [];
      const spec = defaultCouponSpec(seg);
      const def = await this.couponSvc.createDef({
        name: `${spec.name} ${todayBj(at)}`,
        faceValueFen: spec.faceValueFen,
        thresholdFen: spec.thresholdFen,
        validityType: spec.validityType,
        validDays: spec.validDays,
        remark: `AI 唤醒活动 · ${seg} · ${todayBj(at)}`,
      });
      const idempotencyKey = `recall-${seg}-${todayBj(at)}`;
      const r = await this.couponSvc.grantBatch({
        scope: 'userIds',
        userIds,
        couponDefId: def.id,
        name: spec.name,
        faceValueFen: spec.faceValueFen,
        thresholdFen: spec.thresholdFen,
        validityType: spec.validityType,
        validDays: spec.validDays,
        obtainedFrom: 'activity',
        remark: `AI 唤醒活动 · ${seg}`,
        idempotencyKey,
        dryRun: dto.dryRun === true,
      });
      segments.push({
        segment: seg,
        targetCount: userIds.length,
        couponDefId: def.id,
        grantedCount: r.grantedCount,
        skippedCount: r.skippedCount,
        batchNo: r.batchNo,
      });
      summaryLines.push(
        `· ${seg === 'repurchase' ? '复购客' : '流失客'}：命中 ${userIds.length} 人，发券 ${r.grantedCount} 张（跳过 ${r.skippedCount}）`,
      );
    }

    let reason: string | undefined;
    let sentAt: string | null = toBjIso(new Date());
    if (dto.dryRun !== true) {
      try {
        const userId = await this.resolveOwnerUserId();
        if (!userId) {
          reason = '未找到负责人绑定（无 WECOM_OWNER_USERID，后台绑定表里也没有 owner 级绑定）';
        } else {
          const digest =
            `【ABox AI 唤醒活动】${todayBj(at)}\n` +
            summaryLines.join('\n') +
            '\n（AI 圈人 + 批量发券，仅供复盘）';
          const pr = await this.tokenSvc.sendText(userId, digest);
          sentAt = toBjIso(new Date());
          if (!pr.ok)
            reason = `企业微信下发失败${pr.errcode ? ' errcode=' + pr.errcode : ''}${pr.errmsg ? ' ' + pr.errmsg : ''}`;
        }
      } catch (e) {
        reason = e instanceof Error ? e.message : String(e);
      }
    }

    // 记忆：把本次活动回写台账（source=admin）
    await this.aiInsight.record({
      kind: 'recall-campaign',
      title: `AI 唤醒活动 ${todayBj(at)} · ${dto.segments.join('/')} · 发券 ${segments.reduce((s, x) => s + x.grantedCount, 0)} 张${dto.dryRun ? '（试算）' : ''}`,
      content: [`【ABox AI 唤醒活动】${todayBj(at)}`, ...summaryLines].join('\n'),
      source: 'admin',
      actorName: dto.actorName ?? null,
      meta: {
        mode: 'admin_recall',
        payload: { segments: dto.segments, dryRun: !!dto.dryRun, results: segments },
      },
    });

    return { pushed: dto.dryRun !== true ? !reason : false, reason, sentAt, segments };
  }
}

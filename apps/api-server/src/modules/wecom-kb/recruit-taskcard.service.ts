import { Injectable } from '@nestjs/common';

import { BizException } from '../../common/exceptions/biz.exception';
import { ErrorCode } from '../../common/constants/error-code';
import { now, toBjIso, addDays, bjDateTime } from '../../common/utils/time';
import { bjTodayStr } from './stats-intent';
import { StatsService } from '../stats/stats.service';
import { NameResolverService } from './name-resolver.service';
import { AiInsightService } from './ai-insight.service';
import {
  generateRecruitTaskCards,
  revalidateTaskCard,
  APPLY_PATH,
  type RecruitGap,
  type RecruitTaskCard,
  type RecruitTaskCardGenInput,
  type RecruitTaskCardGenResult,
} from '../../common/utils/recruit-taskcard';

type TaskCardDecisionInput = {
  buildingId: number;
  decision: 'approve' | 'skip';
  /** generate 返回的原卡话术；服务端再过合规闸，最终物料沿用这段 */
  pitchText?: string;
  estimatedEarningText?: string;
  reason?: string;
};

type TaskCardMaterial = RecruitTaskCard & { operatorNote: string };

type GenerateResult = RecruitTaskCardGenResult & {
  degraded?: boolean;
  /** 降级时回显的原始缺口数据（清单 §3：绝不 500，也不让运营对着空屏） */
  gaps?: RecruitGap[];
  coveredBuildingIds?: number[];
};

/**
 * 招募任务卡 · 后台闭环（AI 编排节点 G · 安全版）
 *
 * ## 闭环
 * 生成缺口任务卡（只读，不写库）→ 运营逐卡确认 → 出物料（话术 + 裸申请路径）+ 记台账。
 *
 * ## 安全版硬边界（祝总 2026-11-17 拍板）
 * - 不自动发消息（不调 send_message）、不建团长（不调 appoint_leader）、不碰钱。
 * - ref 恒 null：缺口楼无真实推荐人，AI 编造 USR/LDR 码会绑错推荐关系。
 * - 唯一写点 = `ab_ai_insight` 台账；不改 ab_leader / ab_order / ab_user。
 *
 * ## 取数口径（与企微节点 G 的 genRecruitProposal 完全一致）
 * 近 30 天有单楼（StatsService.buildingRank，同一方法）− 在职团长覆盖楼（NameResolver.listLeaders）
 * = 招募缺口。StatsService 已 export（StatsModule），无企微 binding 依赖。
 */
@Injectable()
export class RecruitTaskcardService {
  constructor(
    private readonly stats: StatsService,
    private readonly resolver: NameResolverService,
    private readonly aiInsight: AiInsightService,
  ) {}

  /** 生成（只读，零副作用）：实时算缺口 → spawn 草稿器 → 返回任务卡 */
  async generate(): Promise<GenerateResult> {
    const data = await this.buildGapInput();
    if (data.gaps.length === 0) {
      return {
        ok: true,
        mode: 'rules',
        cards: [],
        rejected: [],
        notes: ['当前没有招募缺口：近 30 天有订单的楼均已有在职团长，或还没有开团数据。'],
        generatedAt: toBjIso(now()) ?? undefined,
        degraded: false,
      };
    }
    const result = await generateRecruitTaskCards(data);
    // 脚本缺失/超时 → 降级：回显原始缺口数据（清单 §3），绝不 500
    if (!result.ok) {
      return {
        ok: false,
        mode: result.mode,
        cards: [],
        rejected: [],
        notes: [result.message || '招募任务卡生成失败，已转人工'],
        generatedAt: data.generatedAt,
        degraded: true,
        gaps: data.gaps,
        coveredBuildingIds: data.coveredBuildingIds,
      };
    }
    return { ...result, degraded: false };
  }

  /**
   * 逐卡确认（人已逐张勾选）：实时复核 → 出物料 + 记台账；blocked 卡不出物料。
   *
   * ⭐ 挑刺 v1.1 两处修正：
   * 1. 物料沿用请求带回的 **generate 原卡话术**（服务端再跑合规闸），不再是服务端常量话术；
   * 2. 真做幂等：查当日台账，同楼同日已批准 → 返回已有物料，不重复写。
   *    顺序是「先实时复核、后幂等」：楼若已被覆盖，即使今天批准过也不再吐旧物料。
   */
  async confirm(input: {
    decisions: TaskCardDecisionInput[];
    actorId: number | null;
    actorName: string | null;
  }): Promise<{
    results: Array<{
      buildingId: number;
      ok: boolean;
      decision: string;
      reason?: string;
      material?: TaskCardMaterial;
      idempotent?: boolean;
    }>;
    approvedCount: number;
    skippedCount: number;
  }> {
    const decisions = Array.isArray(input?.decisions) ? input.decisions : [];
    if (decisions.length === 0) {
      throw new BizException(ErrorCode.PARAM_INVALID, '没有可确认的任务卡');
    }

    const date = bjTodayStr(now());
    // 实时重拉缺口（复核用），只拉一次供本批所有卡共享
    const fresh = await this.buildGapInput();
    // 幂等源：当日已批准的楼 → 台账 payload 里存的物料
    const already = await this.loadApprovedToday(date);
    const results: Array<{
      buildingId: number;
      ok: boolean;
      decision: string;
      reason?: string;
      material?: TaskCardMaterial;
      idempotent?: boolean;
    }> = [];
    let approvedCount = 0;
    let skippedCount = 0;

    for (const d of decisions) {
      const buildingId = Number(d?.buildingId);
      if (!Number.isFinite(buildingId) || buildingId <= 0) {
        results.push({
          buildingId: Number.NaN,
          ok: false,
          decision: 'skip',
          reason: 'buildingId 非法',
        });
        continue;
      }
      if (d?.decision !== 'approve') {
        // §0/§4：skip 也要留痕（挑刺前 skip 是静默的，与清单冲突）
        await this.recordLedger({
          buildingId,
          buildingName: this.nameOf(buildingId, fresh.gaps),
          action: 'skip',
          actorId: input.actorId,
          actorName: input.actorName,
          date,
        });
        skippedCount++;
        results.push({ buildingId, ok: true, decision: 'skip' });
        continue;
      }

      // 用实时缺口 + 请求带回的原卡话术构造待复核卡（楼名/数字仍以实时缺口为准，不接受请求改写）
      const probe = this.cardForValidate(buildingId, fresh.gaps, d);
      const check = revalidateTaskCard(probe, {
        gaps: fresh.gaps,
        coveredBuildingIds: fresh.coveredBuildingIds,
      });
      if (!check.ok) {
        results.push({
          buildingId,
          ok: false,
          decision: 'approve',
          reason: `${check.blocked.code}: ${check.blocked.detail}`,
        });
        continue;
      }

      // 幂等：先复核再查台账，楼已被覆盖的卡不会因「今天批过」而吐旧物料
      const prior = already.get(buildingId);
      if (prior) {
        results.push({
          buildingId,
          ok: true,
          decision: 'approve',
          material: prior,
          idempotent: true,
          reason: '本日已批准，返回已有物料（未重复记台账）',
        });
        approvedCount++;
        continue;
      }

      const material: TaskCardMaterial = {
        ...check.row,
        operatorNote:
          '请确认目标用户已归属该楼后再投放；系统未代发任何消息。' +
          '申请路径为小程序内部路由，需自行生成小程序码/入口投放。',
      };
      // confirm 的台账是本期唯一写点（不是旁路），故 await 确保落库；record 自身吞异常不连带主流程
      await this.recordLedger({
        buildingId,
        buildingName: check.row.buildingName,
        action: 'approve',
        actorId: input.actorId,
        actorName: input.actorName,
        date,
        material,
      });
      approvedCount++;
      results.push({ buildingId, ok: true, decision: 'approve', material });
    }

    return { results, approvedCount, skippedCount };
  }

  /** 当日已批准的 { buildingId → 物料 }。台账读失败不阻断确认（写点同样吞异常） */
  private async loadApprovedToday(date: string): Promise<Map<number, TaskCardMaterial>> {
    const map = new Map<number, TaskCardMaterial>();
    let rows: Awaited<ReturnType<AiInsightService['listRecruitLedgerSince']>> = [];
    try {
      rows = await this.aiInsight.listRecruitLedgerSince(bjDateTime(date, 0, 0));
    } catch {
      return map;
    }
    for (const row of rows) {
      try {
        const meta = row.metaJson
          ? (JSON.parse(row.metaJson) as {
              input?: { date?: string; buildingId?: number; action?: string };
              payload?: TaskCardMaterial;
            })
          : null;
        const inp = meta?.input;
        const bid = Number(inp?.buildingId);
        if (
          inp?.action !== 'approve' ||
          inp.date !== date ||
          !Number.isFinite(bid) ||
          bid <= 0 ||
          !meta?.payload?.pitchText
        ) {
          continue;
        }
        map.set(bid, meta.payload);
      } catch {
        /* 脏 meta 跳过，不让它阻断本批确认 */
      }
    }
    return map;
  }

  /** 实时算缺口：近30天有单楼 − 在职团长覆盖楼（口径同企微节点 G） */
  private async buildGapInput(): Promise<RecruitTaskCardGenInput> {
    const nowD = now();
    const at = toBjIso(nowD) ?? new Date().toISOString();
    // T-1 为锚点（今天数据还在长），与 wecom-chat 的 endShift:-1 一致
    const anchor = addDays(bjTodayStr(nowD), -1);

    type Bld = { id: number; name: string; gmvFen: number; orderCount: number };
    let buildings: Bld[] = [];
    try {
      const view = await this.stats.buildingRank({ range: '30d', date: anchor });
      buildings = (view?.buildings || []).map((b) => ({
        id: Number(b.id),
        name: String(b.name || `#${b.id}`),
        gmvFen: Number(b.gmvFen ?? 0),
        orderCount: Number(b.orderCount ?? 0),
      }));
    } catch {
      buildings = [];
    }

    const covered = new Set<number>();
    try {
      const leaders = await this.resolver.listLeaders();
      for (const l of leaders || []) {
        const bid = Number((l as { buildingId?: unknown }).buildingId);
        if (Number.isFinite(bid)) covered.add(bid);
      }
    } catch {
      /* 覆盖数据源失败：仍可给出缺口候选，confirm 时会再复核一次 */
    }

    // 差集 = 有单楼且无在职团长；按 GMV 降序、最多 20 栋（与节点 G 一致）
    const gaps: RecruitGap[] = buildings
      .filter((b) => Number.isFinite(b.id) && b.id > 0 && !covered.has(b.id))
      .sort((a, b) => b.gmvFen - a.gmvFen)
      .slice(0, 20)
      .map((b) => ({
        buildingId: b.id,
        buildingName: b.name,
        orderCount30d: b.orderCount,
        gmv30d: (b.gmvFen / 100).toFixed(2),
        activeLeader: 0,
      }));

    return { generatedAt: at, gaps, coveredBuildingIds: [...covered] };
  }

  private nameOf(buildingId: number, gaps: RecruitGap[]): string {
    return String(
      gaps.find((g) => Number(g?.buildingId) === buildingId)?.buildingName || `#${buildingId}`,
    );
  }

  /**
   * 复核用卡：楼名/数字取实时缺口；话术取 generate 原卡（缺省时用安全版常量兜底）。
   * 这些常量只用于「运营没把话术带回来」的兼容场景，服务端绝不自行编造对外话术。
   */
  private cardForValidate(
    buildingId: number,
    gaps: RecruitGap[],
    d: TaskCardDecisionInput,
  ): RecruitTaskCard {
    const gap = gaps.find((g) => Number(g?.buildingId) === buildingId);
    const buildingName = String(gap?.buildingName || `#${buildingId}`);
    return {
      buildingId,
      buildingName,
      priority: 1,
      gap: {
        orderCount30d: gap?.orderCount30d == null ? '暂缺' : String(gap.orderCount30d),
        gmv30d: gap?.gmv30d == null ? '暂缺' : String(gap.gmv30d),
        activeLeader: Number(gap?.activeLeader ?? 0),
      },
      targetSegment: '该楼近 30 天有过订单的用户',
      pitchText:
        d?.pitchText?.trim() ||
        `【${buildingName}】正在招募楼内团长，负责把每天套餐送到工位。有意者可了解详情。`,
      estimatedEarningText: d?.estimatedEarningText?.trim() || '测算示例：以实际订单与佣金率为准。',
      applyPath: APPLY_PATH,
      ref: null,
      reason: d?.reason ?? '',
    };
  }

  /** 台账（旁路，record 永不抛异常）：kind=recruit-taskcard，approve 的 payload 存物料供幂等复用 */
  private async recordLedger(input: {
    buildingId: number;
    buildingName: string;
    action: 'approve' | 'skip';
    actorId: number | null;
    actorName: string | null;
    date: string;
    material?: TaskCardMaterial;
  }): Promise<void> {
    await this.aiInsight.record({
      kind: 'recruit-taskcard',
      title: `招募任务卡${input.action === 'approve' ? '批准' : '跳过'}：${input.buildingName}`,
      content:
        input.action === 'approve'
          ? `运营批准了楼「${input.buildingName}」(#${input.buildingId}) 的招募任务卡，` +
            '系统已产出物料（话术+裸申请路径），未对外发消息、未建团长。'
          : `运营跳过了楼「${input.buildingName}」(#${input.buildingId}) 的招募任务卡。`,
      source: 'admin',
      actorId: input.actorId,
      actorName: input.actorName,
      meta: {
        mode: 'admin_confirm',
        input: { date: input.date, buildingId: input.buildingId, action: input.action },
        payload: input.material ?? null,
      },
    });
  }
}

import { Injectable } from '@nestjs/common';

import { BizException } from '../../common/exceptions/biz.exception';
import { ErrorCode } from '../../common/constants/error-code';
import { now, toBjIso } from '../../common/utils/time';
import { bjTodayStr } from './stats-intent';
import { bjDateTime } from '../../common/utils/time';
import { NameResolverService } from './name-resolver.service';
import { AiInsightService } from './ai-insight.service';
import { summarizeLeaderHealth } from './leader-health';
import {
  generateLeaderTaskCards,
  revalidateLeaderCard,
  type LeaderOption,
  type LeaderStrategyCard,
  type LeaderTaskCardGenInput,
  type LeaderTaskCardGenResult,
} from '../../common/utils/leader-taskcard';

type CardDecision = {
  /** 处置卡唯一标识（用 kind，四类各一） */
  kind: string;
  decision: 'approve' | 'skip';
  /** generate 返回的原卡；服务端复核后沿用其理由，事实字段以实时名册为准 */
  card?: LeaderStrategyCard;
};

type ExecutionItem = LeaderStrategyCard & { operatorNote: string };

type ConfirmResult = {
  results: Array<{
    kind: string;
    ok: boolean;
    decision: string;
    reason?: string;
    execution?: ExecutionItem;
    idempotent?: boolean;
  }>;
  approvedCount: number;
  skippedCount: number;
};

type GenerateResult = LeaderTaskCardGenResult & {
  degraded?: boolean;
  leaders?: LeaderOption[];
};

/**
 * 团长处置卡 · 后台闭环（AI 编排节点 N · 安全版）
 *
 * ## 闭环
 * 结构化处置卡（只读生成）→ 运营逐卡确认 → 出「可执行处置清单」+ 记台账。
 *
 * ## 🚨 履约红线（祝总 2026-11-17 拍板）
 * - **绝不调 leaderAdmin.audit / 任何写接口**：不 suspend、不 restore、不 sign_agreement、
 *   不 note，绝不改团长状态、绝不清用户归属团长。
 * - 系统只吐「团长#id + 建议 D22 动作 + 事实依据 + 去哪页人工点」清单，人拿清单去后台 D22
 *   自己核对事实后确认；D22 的 suspend 会清用户归属，所以页面与清单都标红此风险。
 * - 唯一写点 = `ab_ai_insight` 台账；不改 ab_team_leader / ab_user / 任何业务表。
 * - 事实字段（band/沉默天数/卡点/单量）取自只读健康度纯函数，AI/请求篡改无效。
 *
 * ## 取数口径（与企微节点 N 的 genLeaderHealth 同源，只读）
 * NameResolver.listLeaders（已带 status=1）→ summarizeLeaderHealth 纯函数分档。
 */
@Injectable()
export class LeaderTaskcardService {
  constructor(
    private readonly resolver: NameResolverService,
    private readonly aiInsight: AiInsightService,
  ) {}

  /** 生成（只读，零副作用）：实时取数 → spawn 草稿器 → 返回处置卡 */
  async generate(): Promise<GenerateResult> {
    const data = await this.buildGenInput();
    if (data.leaders.length === 0) {
      return {
        ok: true,
        mode: 'rules',
        cards: [],
        rejected: [],
        notes: ['当前没有在职团长（名册为空或全停用），无法出处置卡。'],
        generatedAt: data.generatedAt,
        degraded: false,
        leaders: [],
      };
    }
    const result = await generateLeaderTaskCards(data);
    if (!result.ok) {
      return {
        ok: false,
        mode: result.mode,
        cards: [],
        rejected: [],
        notes: [result.message || '团长处置卡生成失败，已转人工'],
        generatedAt: data.generatedAt,
        degraded: true,
        leaders: data.leaders,
      };
    }
    return { ...result, degraded: false };
  }

  /**
   * 逐卡确认（人已勾选）：实时复核 → 出执行清单 + 记台账，不真停用。
   * 先复核（团长离册/动作非法/红线话术即拦），后查当日台账做幂等。
   */
  async confirm(input: {
    decisions: CardDecision[];
    actorId: number | null;
    actorName: string | null;
  }): Promise<ConfirmResult> {
    const decisions = Array.isArray(input?.decisions) ? input.decisions : [];
    if (decisions.length === 0)
      throw new BizException(ErrorCode.PARAM_INVALID, '没有可确认的处置卡');

    const date = bjTodayStr(now());
    const fresh = await this.buildActiveCtx();
    const already = await this.loadConfirmedToday(date);

    const results: ConfirmResult['results'] = [];
    let approvedCount = 0;
    let skippedCount = 0;

    for (const d of decisions) {
      const kind = String(d?.kind || '');
      if (!kind) {
        results.push({ kind, ok: false, decision: 'skip', reason: 'kind 非法' });
        continue;
      }
      if (d?.decision !== 'approve') {
        await this.recordLedger({
          kind,
          action: 'skip',
          actorId: input.actorId,
          actorName: input.actorName,
          date,
        });
        skippedCount++;
        results.push({ kind, ok: true, decision: 'skip' });
        continue;
      }

      // 请求方必须把 generate 原卡带回；否则无法复核（防止凭空 approve 一个不存在的卡）
      const card = d.card;
      if (!card) {
        results.push({ kind, ok: false, decision: 'approve', reason: '缺少原卡数据，无法复核' });
        continue;
      }
      if (String(card.kind) !== kind) {
        results.push({ kind, ok: false, decision: 'approve', reason: 'kind 与原卡不一致' });
        continue;
      }
      const check = revalidateLeaderCard(card, fresh);
      if (!check.ok || !check.row) {
        results.push({
          kind,
          ok: false,
          decision: 'approve',
          reason: `${check.blocked?.code}: ${check.blocked?.detail}`,
        });
        continue;
      }

      const prior = already.get(kind);
      if (prior) {
        results.push({
          kind,
          ok: true,
          decision: 'approve',
          execution: prior,
          idempotent: true,
          reason: '本日已确认，返回已有清单（未重复记台账）',
        });
        approvedCount++;
        continue;
      }

      const execution: ExecutionItem = {
        ...check.row,
        operatorNote:
          '系统未停用任何团长、未改任何状态、未清用户归属。请拿本清单去后台「团长管理 D22 资质补录/例外处理」' +
          '人工核对事实后自行点确认；suspend 会清该团长名下用户归属，务必二次确认。',
      };
      // 唯一写点 = 台账，await 落库避免自证时序坑（record 自身吞异常，不连带主流程）
      await this.recordLedger({
        kind,
        action: 'approve',
        actorId: input.actorId,
        actorName: input.actorName,
        date,
        execution,
      });
      approvedCount++;
      results.push({ kind, ok: true, decision: 'approve', execution });
    }

    return { results, approvedCount, skippedCount };
  }

  /** 当日已确认的 { kind → 执行清单 }。台账读失败不阻断（写点同样吞异常） */
  private async loadConfirmedToday(date: string): Promise<Map<string, ExecutionItem>> {
    const map = new Map<string, ExecutionItem>();
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
              input?: { date?: string; kind?: string; action?: string; node?: string };
              payload?: ExecutionItem;
            })
          : null;
        const inp = meta?.input;
        // 只认本节点自己的台账（复用 listRecruitLedgerSince 返回的全部 kind，需按 node 过滤）
        if (
          inp?.node !== 'leader-taskcard' ||
          inp?.action !== 'approve' ||
          inp.date !== date ||
          !inp.kind ||
          !meta?.payload?.leaderId
        ) {
          continue;
        }
        map.set(inp.kind, meta.payload);
      } catch {
        /* 脏 meta 跳过 */
      }
    }
    return map;
  }

  /** 实时在职白名单（confirm 复核用） */
  private async buildActiveCtx(): Promise<{ leaders: LeaderOption[] }> {
    return { leaders: await this.loadLeaders() };
  }

  /** 生成入参：在职团长白名单 + 健康度汇总摘要 */
  private async buildGenInput(): Promise<LeaderTaskCardGenInput> {
    const nowD = now();
    const at = toBjIso(nowD) ?? new Date().toISOString();
    const leaders = await this.loadLeaders();
    const totals = await this.loadTotals(leaders);
    return { generatedAt: at, leaders, totals };
  }

  /**
   * 在职团长白名单：listLeaders（已带 status=1）再双保险过滤，纯函数分档，
   * 映射成脚本要的 LeaderOption（只带事实，不含姓名/手机号）。
   */
  private async loadLeaders(): Promise<LeaderOption[]> {
    try {
      const rows = await this.resolver.listLeaders();
      const active = (rows || []).filter((r) => Number(r.status) === 1);
      if (active.length === 0) return [];
      const { items } = summarizeLeaderHealth(active, now().getTime());
      return items.map((it) => ({
        leaderId: it.leaderId,
        buildingName: String(it.buildingName || it.groupName || `#${it.leaderId}`),
        band: it.band,
        silentDays: it.silentDays,
        monthOrders: it.monthOrders,
        level: it.level,
        blockers: it.blockers,
      }));
    } catch {
      return [];
    }
  }

  /** 汇总摘要（只读，给 AI 断场景用） */
  private async loadTotals(leaders: LeaderOption[]): Promise<LeaderTaskCardGenInput['totals']> {
    if (leaders.length === 0) return {};
    try {
      const rows = await this.resolver.listLeaders();
      const active = (rows || []).filter((r) => Number(r.status) === 1);
      const { totals } = summarizeLeaderHealth(active, now().getTime());
      return {
        total: totals.total,
        payoutUnbound: totals.payoutUnbound,
        agreementStale: totals.agreementStale,
        blockedAndSilent: totals.blockedAndSilent,
        byBand: totals.byBand,
      };
    } catch {
      return { total: leaders.length };
    }
  }

  /**
   * 台账（旁路，record 永不抛异常）：kind=leader-taskcard，approve 的 payload 存清单供幂等复用。
   */
  private async recordLedger(input: {
    kind: string;
    action: 'approve' | 'skip';
    actorId: number | null;
    actorName: string | null;
    date: string;
    execution?: ExecutionItem;
  }): Promise<void> {
    await this.aiInsight.record({
      kind: 'leader-taskcard',
      title: `团长处置卡${input.action === 'approve' ? '确认' : '跳过'}：${input.kind}`,
      content:
        input.action === 'approve'
          ? `运营确认了处置建议「${input.kind}」，系统已产出可执行处置清单，` +
            '未停用任何团长、未改状态、未清用户归属；真处置由人去 D22 人工确认。'
          : `运营跳过了处置建议「${input.kind}」。`,
      source: 'admin',
      actorId: input.actorId,
      actorName: input.actorName,
      meta: {
        mode: 'admin_confirm',
        // node 字段用于区分复用 listRecruitLedgerSince 拉回的其他 kind 台账
        input: {
          node: 'leader-taskcard',
          date: input.date,
          kind: input.kind,
          action: input.action,
        },
        payload: input.execution ?? null,
      },
    });
  }
}

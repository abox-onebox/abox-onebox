import { Injectable } from '@nestjs/common';

import { BizException } from '../../common/exceptions/biz.exception';
import { ErrorCode } from '../../common/constants/error-code';
import { now, toBjIso, addDays, bjDateTime } from '../../common/utils/time';
import { bjTodayStr } from './stats-intent';
import { StatsService } from '../stats/stats.service';
import { NameResolverService } from './name-resolver.service';
import { AiInsightService } from './ai-insight.service';
import {
  generateCouponTaskCards,
  revalidateCouponCard,
  type CouponBuildingOption,
  type CouponDefOption,
  type CouponStrategyCard,
  type CouponTaskCardGenInput,
  type CouponTaskCardGenResult,
} from '../../common/utils/coupon-taskcard';

type CardDecision = {
  /** 策略卡唯一标识（用 kind，四类各一） */
  kind: string;
  decision: 'approve' | 'skip';
  /** generate 返回的原卡；服务端复核后沿用其预算文案/理由，金额仍以实时券种为准 */
  card?: CouponStrategyCard;
};

type ExecutionItem = CouponStrategyCard & { operatorNote: string };

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

type GenerateResult = CouponTaskCardGenResult & {
  degraded?: boolean;
  couponDefs?: CouponDefOption[];
  buildings?: CouponBuildingOption[];
};

/**
 * 发券策略卡 · 后台闭环（AI 编排节点 H · 安全版）
 *
 * ## 闭环
 * 结构化策略卡（只读生成）→ 运营逐卡确认 → 出「可执行发券清单」+ 记台账。
 *
 * ## 安全版硬边界（祝总 2026-11-17 拍板）
 * - **绝不真发券、绝不建券种**：不调 grantBatch / createDef / grant（哪怕 dryRun 也会建券种）。
 * - 系统只吐「scope + 券种 #id + 面额门槛 + 试算人群」清单，人拿清单去后台「批量发券」页
 *   自己确认执行；真发券入口仍只有券管理页那一处，不新增第三个发券入口。
 * - 唯一写点 = `ab_ai_insight` 台账；不改 ab_coupon / ab_user_coupon / ab_order / ab_user。
 * - 金额一律以实时券种白名单为准（AI/请求篡改无效），人群规模取只读 stats 并标测算。
 *
 * ## 取数口径（与企微节点 H 的 genCouponStrategy 同源，只读）
 * StatsService.retention / buildingRank + NameResolver.listCouponDefs（仅 active）。
 */
@Injectable()
export class CouponTaskcardService {
  constructor(
    private readonly stats: StatsService,
    private readonly resolver: NameResolverService,
    private readonly aiInsight: AiInsightService,
  ) {}

  /** 生成（只读，零副作用）：实时取数 → spawn 草稿器 → 返回策略卡 */
  async generate(): Promise<GenerateResult> {
    const data = await this.buildGenInput();
    if (data.couponDefs.length === 0) {
      return {
        ok: true,
        mode: 'rules',
        cards: [],
        rejected: [],
        notes: ['当前没有可用券种（后台券种库为空或全停用），无法出策略卡。'],
        generatedAt: data.generatedAt,
        degraded: false,
        couponDefs: [],
        buildings: data.buildings,
      };
    }
    const result = await generateCouponTaskCards(data);
    if (!result.ok) {
      return {
        ok: false,
        mode: result.mode,
        cards: [],
        rejected: [],
        notes: [result.message || '发券策略卡生成失败，已转人工'],
        generatedAt: data.generatedAt,
        degraded: true,
        couponDefs: data.couponDefs,
        buildings: data.buildings,
      };
    }
    return { ...result, degraded: false };
  }

  /**
   * 逐卡确认（人已勾选）：实时复核 → 出执行清单 + 记台账，不真发券。
   * 先复核（券种停用/楼失效即拦），后查当日台账做幂等。
   */
  async confirm(input: {
    decisions: CardDecision[];
    actorId: number | null;
    actorName: string | null;
  }): Promise<ConfirmResult> {
    const decisions = Array.isArray(input?.decisions) ? input.decisions : [];
    if (decisions.length === 0)
      throw new BizException(ErrorCode.PARAM_INVALID, '没有可确认的策略卡');

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
      const check = revalidateCouponCard(card, fresh);
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
          '系统未发券、未建券种。请拿本清单去「财务-代金券」页用批量发券执行：' +
          'scope 与券种 #id 见下方，面额/门槛以券种定义为准；发前先 dryRun 试算确认人群。',
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
          inp?.node !== 'coupon-taskcard' ||
          inp?.action !== 'approve' ||
          inp.date !== date ||
          !inp.kind ||
          !meta?.payload?.couponDefId
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

  /** 实时券种 + 楼栋白名单（confirm 复核用） */
  private async buildActiveCtx(): Promise<{
    couponDefs: CouponDefOption[];
    buildings: CouponBuildingOption[];
  }> {
    const couponDefs = await this.loadActiveCouponDefs();
    const buildings = await this.loadBuildings();
    return { couponDefs, buildings };
  }

  /** 生成入参：券种 active 白名单 + 楼栋白名单 + 数据摘要 */
  private async buildGenInput(): Promise<CouponTaskCardGenInput> {
    const nowD = now();
    const at = toBjIso(nowD) ?? new Date().toISOString();
    const anchor = addDays(bjTodayStr(nowD), -1);

    const couponDefs = await this.loadActiveCouponDefs();
    const buildings = await this.loadBuildings();

    // 人群规模：活跃 / 新客 / 复购（retention summary）；沉睡 = 活跃 − 复购（活跃但未复购）
    let newCustomerCount: number | string = '暂缺';
    let sleepCount: number | string = '暂缺';
    let repeatCount: number | string = '暂缺';
    try {
      const view = await this.stats.retention({ range: '30d', date: anchor });
      const s = view?.summary;
      if (s) {
        const active = Number(s.activeUserCount ?? 0);
        const repeat = Number(s.repeatUserCount ?? 0);
        newCustomerCount = Number(s.newUserCount ?? 0);
        repeatCount = repeat;
        sleepCount = Math.max(0, active - repeat);
      }
    } catch {
      /* 人群数据缺失：脚本会写「暂缺」，不编造 */
    }

    return {
      generatedAt: at,
      couponDefs,
      buildings,
      segments: { newCustomerCount, sleepCount, repeatCount },
    };
  }

  /** 券种白名单：只给 active（selftest 暴露过：停用券 id 在表内会被脚本放行） */
  private async loadActiveCouponDefs(): Promise<CouponDefOption[]> {
    try {
      const list = await this.resolver.listCouponDefs();
      return (list || [])
        .filter((d) => {
          const status = String((d as { status?: unknown }).status ?? 'active').toLowerCase();
          return status === 'active' || status === '1' || status === 'enabled';
        })
        .map((d) => ({
          id: Number(d.id),
          name: String(d.name || '未命名'),
          faceValueFen: Number(d.faceValueFen ?? 0),
          thresholdFen: Number(d.thresholdFen ?? 0),
          validityType: String(d.validityType ?? 'days'),
          validDays: Number.isFinite(Number(d.validDays)) ? Number(d.validDays) : 7,
          status: 'active',
        }))
        .filter((d) => Number.isFinite(d.id) && d.id > 0);
    } catch {
      return [];
    }
  }

  /** 楼栋白名单：近 30 天有单楼，按 GMV 降序取前 8 */
  private async loadBuildings(): Promise<CouponBuildingOption[]> {
    try {
      const view = await this.stats.buildingRank({
        range: '30d',
        date: addDays(bjTodayStr(now()), -1),
      });
      return (view?.buildings || [])
        .map((b) => ({
          id: Number(b.id),
          name: String(b.name || `#${b.id}`),
          orderCount30d: Number(b.orderCount ?? 0),
          gmv30d: ((Number(b.gmvFen ?? 0) || 0) / 100).toFixed(2),
        }))
        .filter((b) => Number.isFinite(b.id) && b.id > 0)
        .sort((a, b) => Number(b.gmv30d) - Number(a.gmv30d))
        .slice(0, 8);
    } catch {
      return [];
    }
  }

  /** 台账（旁路，record 永不抛异常）：kind=coupon-taskcard，approve 的 payload 存清单供幂等复用 */
  private async recordLedger(input: {
    kind: string;
    action: 'approve' | 'skip';
    actorId: number | null;
    actorName: string | null;
    date: string;
    execution?: ExecutionItem;
  }): Promise<void> {
    await this.aiInsight.record({
      kind: 'coupon-taskcard',
      title: `发券策略卡${input.action === 'approve' ? '确认' : '跳过'}：${input.kind}`,
      content:
        input.action === 'approve'
          ? `运营确认了策略「${input.kind}」，系统已产出可执行发券清单，` +
            '未发券、未建券种；真发券由人去券管理页执行。'
          : `运营跳过了发券策略「${input.kind}」。`,
      source: 'admin',
      actorId: input.actorId,
      actorName: input.actorName,
      meta: {
        mode: 'admin_confirm',
        // node 字段用于区分复用 listRecruitLedgerSince 拉回的其他 kind 台账
        input: {
          node: 'coupon-taskcard',
          date: input.date,
          kind: input.kind,
          action: input.action,
        },
        payload: input.execution ?? null,
      },
    });
  }
}

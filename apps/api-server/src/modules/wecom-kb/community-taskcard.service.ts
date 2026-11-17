import { Injectable } from '@nestjs/common';

import { BizException } from '../../common/exceptions/biz.exception';
import { ErrorCode } from '../../common/constants/error-code';
import { now, toBjIso } from '../../common/utils/time';
import { bjTodayStr } from './stats-intent';
import { bjDateTime } from '../../common/utils/time';
import { NameResolverService } from './name-resolver.service';
import { AiInsightService } from './ai-insight.service';
import { summarizeLeaderHealth } from './leader-health';
import { pickCommunityTargets } from './community-plan';
import {
  generateCommunityTaskCards,
  revalidateScheduleCard,
  revalidatePitch,
  type CommunityTargetOption,
  type CommunityTemplateOption,
  type CommunityCouponOption,
  type CommunityScheduleCard,
  type CommunityPitchCard,
  type CommunityTaskCardGenInput,
  type CommunityTaskCardGenResult,
} from '../../common/utils/community-taskcard';

type ScheduleDecision = {
  /** 排期卡唯一标识（day，周一~周日） */
  day: string;
  decision: 'approve' | 'skip';
  /** generate 返回的原卡；服务端复核后沿用其话术，价格/面额以实时白名单为准 */
  card?: CommunityScheduleCard;
};

type ScheduleExecution = CommunityScheduleCard & { operatorNote: string };

type ConfirmResult = {
  results: Array<{
    day: string;
    ok: boolean;
    decision: string;
    reason?: string;
    execution?: ScheduleExecution;
    idempotent?: boolean;
  }>;
  /** 合规分档话术清单（随确认输出，逐条已过合规闸） */
  pitches: CommunityPitchCard[];
  approvedCount: number;
  skippedCount: number;
};

type GenerateResult = CommunityTaskCardGenResult & {
  degraded?: boolean;
  targets?: CommunityTargetOption[];
};

/**
 * 社群排期卡 · 后台闭环（AI 编排节点 P · 安全版）
 *
 * ## 闭环
 * 结构化排期卡（只读生成）→ 运营逐日确认 → 出「排期表 + 合规话术清单」+ 记台账。
 *
 * ## 🚨 发消息红线（祝总 2026-11-17 拍板）
 * - **绝不调 wecomToken.sendText / 任何发消息接口**：不发群、不发券、不加好友。
 * - 系统只吐「周几 + 靶楼档位 + 套餐/券（测算示例）+ 合规话术 + 去哪手动发」清单，
 *   人拿清单去群里手动发、去券管理页人工发券。
 * - 唯一写点 = `ab_ai_insight` 台账；不改任何业务表。
 * - 🎯 话术合规闸（核心增量）：平台名（含快团团）/链接口令/既成事实话术，生成与确认双拦。
 *
 * ## 取数口径（与企微节点 P 的 genCommunityPlan 同源，只读）
 * NameResolver.listLeaders → summarizeLeaderHealth → pickCommunityTargets（靶楼分层）；
 * listTemplatesFull（status=1 套餐白名单）+ listCouponDefs（券种白名单）。
 */
@Injectable()
export class CommunityTaskcardService {
  constructor(
    private readonly resolver: NameResolverService,
    private readonly aiInsight: AiInsightService,
  ) {}

  /** 生成（只读，零副作用）：实时取数 → spawn 草稿器 → 返回排期卡 */
  async generate(): Promise<GenerateResult> {
    const data = await this.buildGenInput();
    const noTargets = data.targets.length === 0;
    const result = await generateCommunityTaskCards(data);
    if (!result.ok) {
      return {
        ok: false,
        mode: result.mode,
        schedule: [],
        pitches: [],
        rejected: [],
        notes: [result.message || '社群排期卡生成失败，已转人工'],
        generatedAt: data.generatedAt,
        degraded: true,
        targets: data.targets,
      };
    }
    // 套餐/券全缺时 AI 出不了可用卡：降级为空，注明原因（不伪造套餐名）
    if (!noTargets && data.templates.length === 0 && data.coupons.length === 0) {
      return {
        ...result,
        schedule: [],
        pitches: [],
        degraded: true,
        notes: ['当前没有启用中的套餐与券种，无法出可执行排期；请先在套餐/券管理页配置。'],
      };
    }
    return { ...result, degraded: false, targets: data.targets };
  }

  /**
   * 逐日确认（人已勾选）：实时复核 → 出排期表 + 合规话术清单 + 记台账，不发任何消息。
   * 先复核（套餐/券停用、话术违规即拦），后查当日台账做幂等。
   */
  async confirm(input: {
    decisions: ScheduleDecision[];
    actorId: number | null;
    actorName: string | null;
  }): Promise<ConfirmResult> {
    const decisions = Array.isArray(input?.decisions) ? input.decisions : [];
    if (decisions.length === 0)
      throw new BizException(ErrorCode.PARAM_INVALID, '没有可确认的排期卡');

    const date = bjTodayStr(now());
    const fresh = await this.buildCtx();
    const already = await this.loadConfirmedToday(date);
    const pitches = await this.buildCompliantPitches(fresh);

    const results: ConfirmResult['results'] = [];
    let approvedCount = 0;
    let skippedCount = 0;

    for (const d of decisions) {
      const day = String(d?.day || '');
      if (!day) {
        results.push({ day, ok: false, decision: 'skip', reason: 'day 非法' });
        continue;
      }
      if (d?.decision !== 'approve') {
        await this.recordLedger({
          day,
          action: 'skip',
          actorId: input.actorId,
          actorName: input.actorName,
          date,
        });
        skippedCount++;
        results.push({ day, ok: true, decision: 'skip' });
        continue;
      }

      // 请求方必须把 generate 原卡带回；否则无法复核（防止凭空 approve 一个不存在的卡）
      const card = d.card;
      if (!card) {
        results.push({ day, ok: false, decision: 'approve', reason: '缺少原卡数据，无法复核' });
        continue;
      }
      if (String(card.day) !== day) {
        results.push({ day, ok: false, decision: 'approve', reason: 'day 与原卡不一致' });
        continue;
      }
      const check = revalidateScheduleCard(card, fresh);
      if (!check.ok || !check.row) {
        results.push({
          day,
          ok: false,
          decision: 'approve',
          reason: `${check.blocked?.code}: ${check.blocked?.detail}`,
        });
        continue;
      }

      const prior = already.get(day);
      if (prior) {
        results.push({
          day,
          ok: true,
          decision: 'approve',
          execution: prior,
          idempotent: true,
          reason: '本日已确认，返回已有清单（未重复记台账）',
        });
        approvedCount++;
        continue;
      }

      const execution: ScheduleExecution = {
        ...check.row,
        operatorNote:
          '系统未发任何群消息、未发券、未加好友。请拿本清单去群里人工复制发送；' +
          '套餐/券金额均为测算示例，请以套餐/券管理页实时配置为准；发券请去券管理页人工操作。',
      };
      // 唯一写点 = 台账，await 落库避免自证时序坑（record 自身吞异常，不连带主流程）
      await this.recordLedger({
        day,
        action: 'approve',
        actorId: input.actorId,
        actorName: input.actorName,
        date,
        execution,
      });
      approvedCount++;
      results.push({ day, ok: true, decision: 'approve', execution });
    }

    return { results, pitches, approvedCount, skippedCount };
  }

  /**
   * 分档话术清单：从实时数据重算 4 条合规话术（确定性模板，非 AI）。
   * 不复用 generate 的 AI 话术 —— 那些是草稿，确认时以这套过闸模板为准，避免 AI 篡改。
   */
  private async buildCompliantPitches(ctx: {
    targets: CommunityTargetOption[];
  }): Promise<CommunityPitchCard[]> {
    const byTier = new Map<string, CommunityTargetOption[]>();
    for (const t of ctx.targets) {
      const arr = byTier.get(t.tier) || [];
      arr.push(t);
      byTier.set(t.tier, arr);
    }
    const templates: Array<{ tier: 'amplify' | 'steady' | 'wake' | 'silent'; text: string }> = [
      { tier: 'amplify', text: '本期套餐到店，量足管够，需要的邻居留言，我们统一送工位。' },
      { tier: 'steady', text: '本期套餐照常供应，想换口味的邻居看一眼菜单，留言即可。' },
      { tier: 'wake', text: '好久没见你订餐啦，这周套餐不错，有空回来试试，留言就行。' },
      { tier: 'silent', text: '邻居好久不见，本期有新套餐，想订随时留言，我们送到工位。' },
    ];
    const out: CommunityPitchCard[] = [];
    for (const t of templates) {
      const row = revalidatePitch({ ...t, executeHint: '' });
      if (row.ok && row.row) out.push(row.row);
    }
    return out;
  }

  /** 当日已确认的 { day → 执行清单 }。台账读失败不阻断（写点同样吞异常） */
  private async loadConfirmedToday(date: string): Promise<Map<string, ScheduleExecution>> {
    const map = new Map<string, ScheduleExecution>();
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
              input?: { date?: string; day?: string; action?: string; node?: string };
              payload?: ScheduleExecution;
            })
          : null;
        const inp = meta?.input;
        if (
          inp?.node !== 'community-taskcard' ||
          inp?.action !== 'approve' ||
          inp.date !== date ||
          !inp.day ||
          !meta?.payload?.day
        ) {
          continue;
        }
        map.set(inp.day, meta.payload);
      } catch {
        /* 脏 meta 跳过 */
      }
    }
    return map;
  }

  /** 实时白名单上下文（confirm 复核用） */
  private async buildCtx(): Promise<{
    targets: CommunityTargetOption[];
    templates: CommunityTemplateOption[];
    coupons: CommunityCouponOption[];
  }> {
    const [targets, templates, coupons] = await Promise.all([
      this.loadTargets(),
      this.loadTemplates(),
      this.loadCoupons(),
    ]);
    return { targets, templates, coupons };
  }

  /** 生成入参：靶楼白名单 + 套餐/券白名单 + 分档汇总 */
  private async buildGenInput(): Promise<CommunityTaskCardGenInput> {
    const nowD = now();
    const at = toBjIso(nowD) ?? new Date().toISOString();
    const ctx = await this.buildCtx();
    const totals = await this.loadTotals(ctx.targets);
    return {
      generatedAt: at,
      targets: ctx.targets,
      templates: ctx.templates,
      coupons: ctx.coupons,
      totals,
    };
  }

  /** 靶楼白名单：listLeaders → 健康度 → pickCommunityTargets，只带事实无姓名/手机号 */
  private async loadTargets(): Promise<CommunityTargetOption[]> {
    try {
      const rows = await this.resolver.listLeaders();
      const active = (rows || []).filter((r) => Number(r.status) === 1);
      if (active.length === 0) return [];
      const { items } = summarizeLeaderHealth(active, now().getTime());
      const t = pickCommunityTargets(items);
      // focus（放量前三）+ mustWake（最该救的沉默前三）+ wake（待唤醒）
      const picked = [...t.focus, ...t.mustWake, ...t.wake.slice(0, 3)];
      const seen = new Set<number>();
      const out: CommunityTargetOption[] = [];
      for (const x of picked) {
        if (seen.has(x.leaderId)) continue;
        seen.add(x.leaderId);
        out.push({
          leaderId: x.leaderId,
          buildingName: String(x.buildingName || x.groupName || `#${x.leaderId}`),
          tier: x.tier,
          monthOrders: x.monthOrders,
          totalOrders: x.totalOrders,
          silentDays: x.silentDays,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** 套餐白名单（status=1 启用中） */
  private async loadTemplates(): Promise<CommunityTemplateOption[]> {
    try {
      const rows = await this.resolver.listTemplatesFull();
      return (rows || [])
        .filter((t) => Number(t.status) === 1)
        .slice(0, 20)
        .map((t) => ({
          id: Number(t.id),
          name: String(t.name || '未命名'),
          priceFen: Number(t.priceFen || 0),
        }))
        .filter((t) => Number.isFinite(t.id));
    } catch {
      return [];
    }
  }

  /** 券种白名单（只取 active；停用券不出卡） */
  private async loadCoupons(): Promise<CommunityCouponOption[]> {
    try {
      const rows = await this.resolver.listCouponDefs();
      return (rows || [])
        .filter((c) => {
          const st = String(c.status ?? '').toLowerCase();
          return st === 'active' || st === '1' || st === 'enabled';
        })
        .slice(0, 20)
        .map((c) => ({
          id: Number(c.id),
          name: String(c.name || '券'),
          faceValueFen: Number(c.faceValueFen || 0),
          thresholdFen: Number(c.thresholdFen || 0),
        }))
        .filter((c) => Number.isFinite(c.id));
    } catch {
      return [];
    }
  }

  /** 分档汇总（只读，给 AI 断场景用） */
  private async loadTotals(
    targets: CommunityTargetOption[],
  ): Promise<CommunityTaskCardGenInput['totals']> {
    const totals: CommunityTaskCardGenInput['totals'] = {};
    for (const t of targets) {
      const k = t.tier as keyof typeof totals;
      if (k in totals && typeof totals[k] === 'number') (totals[k] as number) += 1;
    }
    return totals;
  }

  /**
   * 台账（旁路，record 永不抛异常）：kind=community-taskcard，approve 的 payload 存清单供幂等复用。
   */
  private async recordLedger(input: {
    day: string;
    action: 'approve' | 'skip';
    actorId: number | null;
    actorName: string | null;
    date: string;
    execution?: ScheduleExecution;
  }): Promise<void> {
    await this.aiInsight.record({
      kind: 'community-taskcard',
      title: `社群排期卡${input.action === 'approve' ? '确认' : '跳过'}：${input.day}`,
      content:
        input.action === 'approve'
          ? `运营确认了社群排期「${input.day}」，系统已产出排期执行清单与合规话术，` +
            '未发任何群消息、未发券、未加好友；真人拿清单去群里手动执行。'
          : `运营跳过了社群排期「${input.day}」。`,
      source: 'admin',
      actorId: input.actorId,
      actorName: input.actorName,
      meta: {
        mode: 'admin_confirm',
        input: {
          node: 'community-taskcard',
          date: input.date,
          day: input.day,
          action: input.action,
        },
        payload: input.execution ?? null,
      },
    });
  }
}

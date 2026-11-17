import { http } from './request';

/**
 * AI 报告中心
 *
 * 与「AI 台账」配套：台账只读 `ab_ai_insight`，本页负责批量生成报告并留档。
 * 生成走 dryRun 语义 —— 只生成 + 留档，绝不推送企微、不写任何业务表。
 * 读报告复用 ai-insight 的 listInsights/getInsight（同一张台账）。
 */

/** 单节点生成结果（与后端 DailyNodeResult 同形） */
export interface DailyNodeResult {
  key: string;
  title: string;
  text: string;
  ok: boolean;
  skipped?: boolean;
}

/** 批量生成报告（只留档不外发） */
export function generateReports(kinds?: string[]): Promise<{
  nodes: DailyNodeResult[];
  pushed: false;
  generated: number;
}> {
  return http.post('/admin/ai-report/generate', { kinds });
}

/** 数据体检结果（今天有没有数据可算、哪些节点会被跳过） */
export interface PreflightResult {
  grade: string;
  headline: string;
  blockers: string[];
  notes: string[];
  skipNodes: string[];
}

/** 只读数据体检：解释报告为何降级，不写库不推送 */
export function getPreflight(): Promise<{
  at: string;
  result: PreflightResult;
  text: string;
}> {
  return http.get('/admin/ai-report/preflight');
}

/** 本周汇总（只读预览，后端强制 dryRun，绝不外发） */
export interface WeeklyDigest {
  rangeFrom: string;
  rangeTo: string;
  total: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  digest: string;
  pushed: false;
}

export function getWeeklyDigest(): Promise<WeeklyDigest> {
  return http.get('/admin/ai-report/weekly-digest');
}

/** ③效果回填结果：扫已执行建议，按生成后窗口回填业务快照到 meta.effect */
export interface BackfillResult {
  scanned: number;
  filled: number;
  degraded: number;
}

export function backfillEffects(windowDays = 7): Promise<BackfillResult> {
  return http.post('/admin/ai-report/backfill-effects', { windowDays });
}

/** ④效果复盘：采纳率 / 执行率 / 效果覆盖，按节点聚合 */
export interface EffectReview {
  total: number;
  byStatus: Record<string, number>;
  adoptedRate: number;
  executedRate: number;
  effectCovered: number;
  byKind: Array<{
    kind: string;
    total: number;
    adopted: number;
    executed: number;
    effectCovered: number;
  }>;
  at: string;
}

export function getEffectReview(): Promise<EffectReview> {
  return http.get('/admin/ai-report/effect-review');
}

/** ⑤事件预警骨架（只读，不推送不执行） */
export interface AlertSignal {
  key: string;
  label: string;
  value: number;
  level: 'info' | 'warn' | 'danger';
}
export interface AlertsResult {
  windowDays: number;
  grade: 'insufficient' | 'ok' | 'attention';
  signals: AlertSignal[];
  note: string;
  at: string;
}

export function getAlerts(windowDays = 7): Promise<AlertsResult> {
  return http.get('/admin/ai-report/alerts', { windowDays });
}

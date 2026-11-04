import { http } from './request';

/**
 * AI 台账（`ab_ai_insight`）
 *
 * 15 个 AI 节点的产出一律留档：企微触发的、后台触发的、每日 09:00 自动编排的。
 * 本文件只做「读 + 标记」，不做「执行」—— `payload` 字段已预留，下一批才接一键执行。
 */

/**
 * 节点标识（与后端 `kind` 同一套；后端用脚本名，不是编排的节点 key）
 *
 * 末尾的 `(string & Record<never, never>)` 是为了**保留字面量补全**的同时允许任意新 kind：
 * 后端新增节点后前端不必同步改类型，页面会退回显示原始英文（`KIND_LABEL` 里没有就用原值）。
 * ⚠️ 不用社区常见的 `(string & {})` —— `@typescript-eslint/ban-types` 会判它违规。
 */
export type InsightKind =
  | 'daily-report'
  | 'meal-proposal'
  | 'recruit-proposal'
  | 'coupon-strategy'
  | 'demand-forecast'
  | 'growth-experiment'
  | 'risk-recon'
  | 'churn-recall'
  | 'leader-health'
  | 'health-score'
  | 'community-plan'
  | 'refund-cluster'
  | 'launch-draft'
  | 'campaign'
  | 'launch-pack'
  | (string & Record<never, never>);

export interface InsightListItem {
  id: number;
  kind: InsightKind;
  title: string;
  source: 'chat' | 'admin' | 'cron' | string;
  status: 'open' | 'adopted' | 'dismissed' | string;
  actorName: string | null;
  createdAt: string | null;
  excerpt: string;
}

export interface InsightDetail extends Omit<InsightListItem, 'excerpt'> {
  content: string;
  decidedBy: string | null;
  decidedAt: string | null;
  /** 后端透传的 JSON：`{ mode, elapsedMs, input }`；解析失败时是 `{ parseError, raw }` */
  meta: Record<string, unknown> | null;
}

export interface InsightListQuery {
  kind?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

/** 列表（分页） */
export function listInsights(
  q: InsightListQuery,
): Promise<{ list: InsightListItem[]; total: number; page: number; pageSize: number }> {
  return http.get('/admin/ai-insight', q);
}

/** 节点清单（只列库里真实出现过的 kind，供筛选下拉） */
export function listInsightKinds(): Promise<{ list: Array<{ kind: string; count: number }> }> {
  return http.get('/admin/ai-insight/kinds');
}

/** 详情（含全文与 meta） */
export function getInsight(id: number): Promise<InsightDetail> {
  return http.get(`/admin/ai-insight/${id}`);
}

/**
 * 标记状态。
 *
 * 允许退回 `open`：现实中「先标了采纳、事后发现没做」很常见，
 * 让他改回来比逼他重新生成一份更省事。
 */
export function decideInsight(
  id: number,
  status: 'open' | 'adopted' | 'dismissed',
): Promise<{ id: number; status: string }> {
  return http.post(`/admin/ai-insight/${id}/decide`, { status });
}

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

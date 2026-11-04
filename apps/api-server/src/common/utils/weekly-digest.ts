/**
 * 本周 AI 播报聚合（纯函数、零 IO —— 便于单测钉死）。
 *
 * 从 `ab_ai_insight` 拉出的本周留档，聚合成一段可推送企微的纯文本摘要。
 * 抽成独立 util（不引 Nest 服务 / 不引 typeorm），避免单测被迫加载整个 DI 图。
 */

/** 周播报聚合单行（只取聚合所需字段） */
export interface WeeklyDigestRow {
  kind: string;
  status: string;
  title: string;
}

export interface WeeklyDigest {
  digest: string;
  total: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
}

const STATUS_ZH: Record<string, string> = {
  adopted: '已采纳',
  dismissed: '已忽略',
  open: '待看',
};

/**
 * 把本周 insights 聚合成纯文本播报。
 *
 * 返回 `digest`（纯文本，换行用 \n，适配企微 text 消息）、总量、按类型 / 按状态计数。
 * 计数一律用 `?? 0` 兜底空值；类型排序按数量降序，状态固定 open/adopted/dismissed 三态顺序。
 */
export function buildWeeklyDigest(
  rows: WeeklyDigestRow[],
  rangeFrom: string,
  rangeTo: string,
): WeeklyDigest {
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const r of rows) {
    if (r.kind != null) byKind[String(r.kind)] = (byKind[String(r.kind)] ?? 0) + 1;
    if (r.status != null) byStatus[String(r.status)] = (byStatus[String(r.status)] ?? 0) + 1;
  }
  const total = rows.length;
  const lines: string[] = [];
  lines.push('【ABox AI 本周播报】');
  lines.push(`${rangeFrom} ~ ${rangeTo}`);
  lines.push(`本周共沉淀 ${total} 条 AI 产出（来源：企微 / 后台 / 每日编排）`);
  if (total > 0) {
    lines.push('');
    lines.push('— 按类型 —');
    for (const k of Object.keys(byKind).sort((a, b) => byKind[b] - byKind[a])) {
      lines.push(`· ${k}：${byKind[k]}`);
    }
    lines.push('');
    lines.push('— 按状态 —');
    for (const s of ['open', 'adopted', 'dismissed']) {
      if (byStatus[s]) lines.push(`· ${STATUS_ZH[s] ?? s}：${byStatus[s]}`);
    }
    const recent = rows.slice(0, 8);
    lines.push('');
    lines.push('— 近期重点 —');
    for (const r of recent) lines.push(`· ${r.title}`);
  }
  lines.push('');
  lines.push('（AI 留档，仅供复盘参考；执行需人工确认）');
  return { digest: lines.join('\n'), total, byKind, byStatus };
}

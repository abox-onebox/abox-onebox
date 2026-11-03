/**
 * 退款根因聚类（纯函数，零 IO，可单测）
 * ------------------------------------------------------------------
 * 节点 Q「退款根因聚类」的唯一判据真源。
 * 为什么抽纯函数：聚类全是算术（占比 / 均值 / 分桶 / 重复用户），
 * 交给 LLM 做等于让它编数；这里算准，脚本只负责把结论说成人话。
 *
 * ⚠️ 四条口径约束：
 *   ① **原因优先取 `reasonTypeText`**（后台已按 `REFUND_REASON_LABEL` 归一），
 *      缺失才回落到自由文本 `reason`；两者都没有则记「未标注原因」，
 *      **不猜、不归类**——猜错的根因会让人去整改一个不存在的问题。
 *   ② **未标注占比过高必须自己报警**（`unlabeled.warning`）：
 *      样本里三成以上没标原因时，任何「根因画像」都不可信，脚本须原样转述这条警告。
 *   ③ **重复退款用户只数不点名**：只用 `userId` 做计数，输出的 `maxPerUser`
 *      是「单人最多退了几笔」，绝不带昵称/手机号/订单号，避免个人身份进 LLM。
 *   ④ **窗口按「出餐日优先、退款时间兜底」过滤**：退款可能跨日出餐，
 *      只按 `mealDate` 过滤会漏掉前一天出餐、次日才退的样本。
 */

/** 退款列表行（`admin/finance/refunds` 的 list 项，只取本模块要用的字段） */
export interface RefundClusterRow {
  /** 退款金额（分） */
  amountFen?: number | null;
  /** 后台归一后的原因文案（如「菜品质量问题」） */
  reasonTypeText?: string | null;
  /** 用户填的自由文本原因 */
  reason?: string | null;
  /** 申请来源文案（用户自助 / 客服代申请 …） */
  applySourceText?: string | null;
  /** 状态文案（待审批 / 已通过 / 已退款 / 已驳回） */
  statusText?: string | null;
  /** 出餐日 YYYY-MM-DD */
  mealDate?: string | null;
  /** 实际退款时间（BJ ISO） */
  refundedAt?: string | null;
  /** 用户 id（**只用于计数，绝不外传**） */
  userId?: number | null;
  orderNo?: string | null;
}

/** 退款单没有标任何原因时的归类名（不要用空串，容易被当成"缺字段"） */
export const UNLABELED_REASON = '未标注原因';

/** 未标注占比超过这个值就报警（三成以上没标 = 根因画像不可信） */
export const UNLABELED_WARN_SHARE = 0.3;

/** 金额分桶（分）：小额多为「口味不合/临时不去」，大额多为「整单出错」 */
export const AMOUNT_BUCKETS = [
  { key: '≤10 元', minFen: 0, maxFen: 1000 },
  { key: '10~30 元', minFen: 1001, maxFen: 3000 },
  { key: '>30 元', minFen: 3001, maxFen: Number.POSITIVE_INFINITY },
] as const;

export interface RefundCluster {
  /** 聚类名（原因文案 / 未标注原因） */
  key: string;
  count: number;
  amountFen: number;
  /** 占窗口内样本的比例（0~1，保留 4 位由调用方格式化） */
  share: number;
  avgAmountFen: number;
  /** 脱敏后的原因摘录（最多 2 条，已截断/去号码） */
  samples: string[];
}

export interface RefundClusterResult {
  /** 窗口内样本数 */
  total: number;
  totalAmountFen: number;
  /** 按笔数降序；同笔数按金额降序 */
  clusters: RefundCluster[];
  unlabeled: { count: number; share: number; warning: boolean };
  amountBuckets: { key: string; count: number }[];
  /** 来源分布（用户自助 / 客服代申请 …），按笔数降序 */
  sourceMix: { key: string; count: number }[];
  /** 重复退款（>1 笔）的用户数 + 单人最多笔数（不含身份） */
  repeat: { distinctUsers: number; repeatedUsers: number; maxPerUser: number };
  /** 实际参与统计的窗口天数（调用方传入，原样带回便于文案对齐） */
  windowDays: number;
}

/**
 * 原因文本脱敏：截断 + 抹掉像手机号/长数字串的片段。
 * 用户可能在原因里写「我电话 13800001111」——这类内容绝不能进 LLM。
 */
export function sanitizeReason(text: string | null | undefined, maxLen = 40): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const masked = s.replace(/\d{7,}/g, '***');
  return masked.length > maxLen ? `${masked.slice(0, maxLen)}…` : masked;
}

/** 取一行的聚类键：先归一原因，再自由文本，最后兜底 */
export function reasonKeyOf(row: RefundClusterRow): string {
  const label = sanitizeReason(row.reasonTypeText, 20);
  if (label) return label;
  const free = sanitizeReason(row.reason, 20);
  if (free) return free;
  return UNLABELED_REASON;
}

/** 行是否落在窗口内：出餐日优先，缺失则用退款时间兜底 */
export function inWindow(row: RefundClusterRow, cutoffYmd: string): boolean {
  const day = (row.mealDate ?? '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day >= cutoffYmd;
  const at = (row.refundedAt ?? '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return at >= cutoffYmd;
  // 两个日期都没有：不剔除（宁可多算一笔，也别悄悄丢样本），由调用方在文案里说明
  return true;
}

function amountOf(row: RefundClusterRow): number {
  const v = Number(row.amountFen ?? 0);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/**
 * 聚类主函数。
 * @param rows 退款列表行（**调用方负责脱敏**：本函数不读昵称/手机号）
 * @param opts.cutoffYmd 窗口起始日（含），如 30 天窗口传 now-29d
 * @param opts.windowDays 原样回带的天数
 * @param opts.topN 最多返回多少类（默认 8；其余并入「其他」）
 */
export function clusterRefunds(
  rows: RefundClusterRow[],
  opts: { cutoffYmd: string; windowDays: number; topN?: number },
): RefundClusterResult {
  const topN = opts.topN && opts.topN > 0 ? opts.topN : 8;
  const picked = (rows ?? []).filter((r) => inWindow(r, opts.cutoffYmd));

  const total = picked.length;
  const totalAmountFen = picked.reduce((s, r) => s + amountOf(r), 0);

  // 聚类累加
  const map = new Map<string, { count: number; amountFen: number; samples: string[] }>();
  for (const r of picked) {
    const key = reasonKeyOf(r);
    const cur = map.get(key) ?? { count: 0, amountFen: 0, samples: [] };
    cur.count += 1;
    cur.amountFen += amountOf(r);
    if (cur.samples.length < 2) {
      const raw = sanitizeReason(r.reason, 40);
      // 自由文本与聚类名重复时不重复展示（否则样例行全是同一句话）
      if (raw && raw !== key) cur.samples.push(raw);
    }
    map.set(key, cur);
  }

  const all: RefundCluster[] = [...map.entries()]
    .map(([key, v]) => ({
      key,
      count: v.count,
      amountFen: v.amountFen,
      share: total ? v.count / total : 0,
      avgAmountFen: v.count ? Math.round(v.amountFen / v.count) : 0,
      samples: v.samples,
    }))
    .sort((a, b) => b.count - a.count || b.amountFen - a.amountFen);

  // 超出 topN 的并入「其他」（不丢数量，否则占比加起来不到 100%）
  let clusters = all;
  if (all.length > topN) {
    const head = all.slice(0, topN);
    const tail = all.slice(topN);
    const rest = tail.reduce(
      (acc, c) => ({
        count: acc.count + c.count,
        amountFen: acc.amountFen + c.amountFen,
      }),
      { count: 0, amountFen: 0 },
    );
    clusters = [
      ...head,
      {
        key: '其他（长尾）',
        count: rest.count,
        amountFen: rest.amountFen,
        share: total ? rest.count / total : 0,
        avgAmountFen: rest.count ? Math.round(rest.amountFen / rest.count) : 0,
        samples: [],
      },
    ];
  }

  const unlabeledCount = map.get(UNLABELED_REASON)?.count ?? 0;
  const unlabeledShare = total ? unlabeledCount / total : 0;

  const amountBuckets = AMOUNT_BUCKETS.map((b) => ({
    key: b.key,
    count: picked.filter((r) => {
      const a = amountOf(r);
      return a >= b.minFen && a <= b.maxFen;
    }).length,
  }));

  const sourceMap = new Map<string, number>();
  for (const r of picked) {
    const k = sanitizeReason(r.applySourceText, 12) || '未标注来源';
    sourceMap.set(k, (sourceMap.get(k) ?? 0) + 1);
  }
  const sourceMix = [...sourceMap.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);

  // 重复退款：只用 userId 计数，不含任何身份信息
  const perUser = new Map<number, number>();
  for (const r of picked) {
    const uid = Number(r.userId ?? 0);
    if (!uid) continue;
    perUser.set(uid, (perUser.get(uid) ?? 0) + 1);
  }
  const counts = [...perUser.values()];
  const repeat = {
    distinctUsers: perUser.size,
    repeatedUsers: counts.filter((c) => c > 1).length,
    maxPerUser: counts.length ? Math.max(...counts) : 0,
  };

  return {
    total,
    totalAmountFen,
    clusters,
    unlabeled: {
      count: unlabeledCount,
      share: unlabeledShare,
      warning: unlabeledShare > UNLABELED_WARN_SHARE,
    },
    amountBuckets,
    sourceMix,
    repeat,
    windowDays: opts.windowDays,
  };
}

/** 一句话概括（给摘要/降级稿用，不含任何身份信息） */
export function describeRefundCluster(r: RefundClusterResult): string {
  if (r.total <= 0) return `近 ${r.windowDays} 天没有退款样本。`;
  const top = r.clusters[0];
  const parts = [
    `近 ${r.windowDays} 天退款 ${r.total} 笔 · 合计 ${((r.totalAmountFen || 0) / 100).toFixed(2)} 元`,
    `最多的一类：${top.key} ${top.count} 笔（${(top.share * 100).toFixed(1)}%）`,
  ];
  if (r.unlabeled.warning) {
    parts.push(`⚠️ 未标注原因占 ${(r.unlabeled.share * 100).toFixed(0)}%，聚类结论可信度低`);
  }
  if (r.repeat.repeatedUsers > 0) {
    parts.push(`重复退款用户 ${r.repeat.repeatedUsers} 人（单人最多 ${r.repeat.maxPerUser} 笔）`);
  }
  return parts.join(' · ');
}

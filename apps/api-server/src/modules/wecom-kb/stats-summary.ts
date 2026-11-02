/**
 * 统计数据「说人话」（纯函数 · 无 IO · 可直接单测）
 *
 * ⚠️ **本文件存在的理由**：
 *   通用兜底 `summarizeResult()` 只认 `id / orderNo / status / totalCount / count / ok / tier`
 *   七个键。而 `/admin/stats/dashboard` 的数字全在 `metrics` 里嵌套着（18 项），
 *   七个键一个都对不上 ⇒ 老板问「昨天经营怎么样」，收到的是一段被截到 600 字的原始 JSON。
 *   这里为每个统计视角各写一份定向格式化，替代那段 JSON。
 *
 * ⚠⚠️ **取不到的数一律不说，绝不补 0**
 *   这是本文件最重要的纪律。`metrics` 里任何一项在结构变化后都可能缺失，
 *   若缺了就按 0 打印，老板会看到一个**凭空出现的 0**（「退款率 0%」看起来是最健康的，
 *   实际含义是「这个数没取到」）。故每个字段过 `numField`，`null` 直接跳过。
 *
 * ⚠️ 单位铁律（照 `stats.service.ts` 的 `StatsDashboardView` 注释）：
 *   · 金额一律是**整数分** ⇒ 显示前 ÷ 100
 *   · 比率一律是 **0–1 的小数**（`ratio()` 保留 4 位）⇒ 显示前 × 100
 *   · `grossProfitRate` 可能是 **null**（该字段没有 `?? 0` 兜底，GMV 为 0 时 `ratio` 返回 null）
 */

/* ------------------------------------------------------------------ *
 * 阈值（业务口径 —— 集中一处，要改只改这里）
 * ------------------------------------------------------------------ */

/**
 * 退款率警戒线：超过就要主动说出来。
 * 5% 的理由：¥25.80 一份的生意，毛利率大约两成多，退款率只要过 5%，
 * 基本把单均利润吃掉三成以上 —— 到这个量级就已经不是「个别事故」而是「流程有问题」。
 */
export const ALERT_REFUND_RATE = 0.05;

/**
 * GMV 环比跌幅警戒线：20%。
 * 低于这个数的波动属正常（天气、楼里出差、单周假期），到这个数就要有人去看。
 */
export const ALERT_GMV_DROP = 0.2;

/**
 * 单栋楼环比跌幅警戒线：30%（比整体更敏感，因为单栋基数小、更容易真掉）。
 */
export const ALERT_BUILDING_DROP = 0.3;

/**
 * 单栋楼预警的**基线下限**（分 · ¥500）。
 * ⚠️ 没有这一条，新开的小楼会天天报警：「昨天 ¥600 今天 ¥200」跌了 67%，
 *    但绝对额只少了 ¥400，不值得占用老板的注意力。**报警必须同时看比例与绝对额。**
 */
export const ALERT_MIN_GMV_FEN = 50_000;

/* ------------------------------------------------------------------ *
 * 格式化原语
 * ------------------------------------------------------------------ */

/** 分 → `¥1,234.56`（千分位 · 两位小数） */
export function fmtYuan(fen: number): string {
  const yuan = fen / 100;
  const [i, f] = Math.abs(yuan).toFixed(2).split('.');
  return `${yuan < 0 ? '-' : ''}¥${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`;
}

/** 带正负号的金额（用于「涨了多少」这一栏） */
export function fmtYuanSigned(fen: number): string {
  return `${fen > 0 ? '+' : ''}${fmtYuan(fen)}`;
}

/** 整数千分位 */
export function fmtInt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 0–1 比率 → `5.1%`；`null` → `—`（**不打印 0%**，0% 与「取不到」是两件事） */
export function fmtPct(ratio: number | null, digits = 1): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** 毫秒 → 人话（`42.3 秒` / `8 分 12 秒`） */
export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const totalSec = Math.round(ms / 1000);
  return `${Math.floor(totalSec / 60)} 分 ${totalSec % 60} 秒`;
}

/** 变化率描述：`涨 12.3%` / `跌 8.1%` / `持平`；上期为 0 时给 `新增` */
export function fmtChange(cur: number, prev: number): string {
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return '—';
  if (prev === 0) return cur === 0 ? '持平' : '上期为 0，无法算变化';
  const c = (cur - prev) / Math.abs(prev);
  if (Math.abs(c) < 0.005) return '持平';
  return `${c > 0 ? '涨' : '跌'} ${(Math.abs(c) * 100).toFixed(1)}%`;
}

/** 百分点差（用于比较两个**比率**，如退款率 2.6% → 3.4% 是 +0.8 个百分点） */
export function fmtPp(cur: number | null, prev: number | null): string {
  if (cur == null || prev == null) return '—';
  const d = (cur - prev) * 100;
  if (Math.abs(d) < 0.05) return '持平';
  return `${d > 0 ? '+' : ''}${d.toFixed(1)} 个百分点`;
}

/* ------------------------------------------------------------------ *
 * 取值守卫（一切从 unknown 出发，取不到返回 null）
 * ------------------------------------------------------------------ */

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function numField(o: Record<string, unknown> | null, k: string): number | null {
  if (!o) return null;
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strField(o: Record<string, unknown> | null, k: string): string | null {
  if (!o) return null;
  const v = o[k];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function arrField(o: Record<string, unknown> | null, k: string): unknown[] {
  if (!o) return [];
  const v = o[k];
  return Array.isArray(v) ? v : [];
}

/** 区间说明：`10-26 ~ 11-01`（去掉年份，企微里更短；跨年时保留年份） */
function rangeLabel(data: Record<string, unknown>): string {
  const r = asObj(data.range);
  const s = strField(r, 'startDate');
  const e = strField(r, 'endDate');
  if (!s || !e) return '';
  const sameYear = s.slice(0, 4) === e.slice(0, 4);
  const show = (d: string): string => (sameYear ? d.slice(5) : d);
  return `${show(s)} ~ ${show(e)}`;
}

/* ------------------------------------------------------------------ *
 * D47 · 核心指标看板
 * ------------------------------------------------------------------ */

/**
 * 把 dashboard 出参说成人话。返回 `null` = 结构不认识（调用方据此**退回「我看不懂」**，
 * 而不是硬编一段数字）。
 */
export function summarizeDashboard(data: unknown): string | null {
  const d = asObj(data);
  const m = asObj(d?.metrics);
  if (!d || !m) return null;

  const gmv = numField(m, 'gmvFen');
  const cnt = numField(m, 'orderCount');
  // 两个核心数都取不到 ⇒ 结构变了，交给调用方兜底
  if (gmv == null && cnt == null) return null;

  const label = rangeLabel(d);
  const head = label ? `经营数据 · ${label}（按出餐日）` : '经营数据';

  const lines: string[] = [head];

  // 第 1 行：规模
  const l1: string[] = [];
  if (gmv != null) l1.push(`GMV ${fmtYuan(gmv)}`);
  if (cnt != null) l1.push(`${fmtInt(cnt)} 单`);
  const qty = numField(m, 'quantity');
  if (qty != null) l1.push(`${fmtInt(qty)} 份`);
  const avgOrder = numField(m, 'avgOrderAmountFen');
  if (avgOrder != null) l1.push(`客单价 ${fmtYuan(avgOrder)}`);
  if (l1.length) lines.push(l1.join(' · '));

  // 第 2 行：风险
  const l2: string[] = [];
  const refundCnt = numField(m, 'refundCount');
  const refundRate = numField(m, 'refundRate');
  if (refundCnt != null) {
    l2.push(
      refundRate != null
        ? `退款 ${fmtInt(refundCnt)} 单（${fmtPct(refundRate)}）`
        : `退款 ${fmtInt(refundCnt)} 单`,
    );
  }
  const pending = numField(m, 'pendingPayCount');
  if (pending != null && pending > 0) l2.push(`未支付 ${fmtInt(pending)} 单`);
  if (l2.length) lines.push(l2.join(' · '));

  // 第 3 行：活跃与复购
  const l3: string[] = [];
  const actUser = numField(m, 'activeUserCount');
  const actLeader = numField(m, 'activeLeaderCount');
  const actBld = numField(m, 'activeBuildingCount');
  if (actUser != null) l3.push(`用户 ${fmtInt(actUser)}`);
  if (actLeader != null) l3.push(`团长 ${fmtInt(actLeader)}`);
  if (actBld != null) l3.push(`楼栋 ${fmtInt(actBld)}`);
  const repeatRate = numField(m, 'repeatRate');
  const repeatUser = numField(m, 'repeatUserCount');
  if (repeatRate != null) {
    l3.push(
      repeatUser != null
        ? `复购 ${fmtInt(repeatUser)} 人（${fmtPct(repeatRate)}）`
        : `复购率 ${fmtPct(repeatRate)}`,
    );
  }
  if (l3.length) lines.push(l3.join(' · '));

  // 第 4 行：毛利（⚠️ 必须与 warnings 同屏，见下）
  const profit = numField(m, 'grossProfitFen');
  const profitRate = numField(m, 'grossProfitRate'); // ⚠️ 可能为 null
  const commission = numField(m, 'commissionFen');
  const l4: string[] = [];
  if (profit != null) {
    l4.push(
      profitRate != null
        ? `毛利 ${fmtYuan(profit)}（${fmtPct(profitRate)}）`
        : `毛利 ${fmtYuan(profit)}`,
    );
  }
  if (commission != null) l4.push(`佣金 ${fmtYuan(commission)}`);
  if (l4.length) lines.push(l4.join(' · '));

  // ⚠️⚠️ 毛利可靠性提示：**必须转述，不许吞掉**
  //   履约成本三项未登记、或采购应付单还没生成（T+1 02:00 才跑）时，毛利会少扣钱而**虚高**。
  //   老板拿一个「看起来很赚」的数去做决策，比不给他这个数更糟。
  const warnings = arrField(d, 'warnings');
  const warnLines = warnings.filter((w): w is string => typeof w === 'string' && w.trim() !== '');
  if (warnLines.length) {
    lines.push('');
    for (const w of warnLines) lines.push(`注意：${w}`);
  }

  return lines.join('\n');
}

/**
 * 环比：本期 vs 上期（同档位、不重叠）。
 *
 * 只比四项老板最关心的：GMV / 单量 / 退款率 / 毛利。
 * 返回空数组 = 上期结构不认识（**宁可不给，也不给错**）。
 */
export function compareDashboard(cur: unknown, prev: unknown): string[] {
  const cm = asObj(asObj(cur)?.metrics);
  const pm = asObj(asObj(prev)?.metrics);
  if (!cm || !pm) return [];

  const lines: string[] = [''];
  const focus: string[] = [];

  const cGmv = numField(cm, 'gmvFen');
  const pGmv = numField(pm, 'gmvFen');
  if (cGmv != null && pGmv != null) {
    focus.push(`GMV ${fmtChange(cGmv, pGmv)}（${fmtYuanSigned(cGmv - pGmv)}）`);
  }

  const cCnt = numField(cm, 'orderCount');
  const pCnt = numField(pm, 'orderCount');
  if (cCnt != null && pCnt != null && cCnt !== pCnt) {
    focus.push(`单量 ${cCnt > pCnt ? '+' : ''}${fmtInt(cCnt - pCnt)} 单`);
  }

  const cRefund = numField(cm, 'refundRate');
  const pRefund = numField(pm, 'refundRate');
  if (cRefund != null && pRefund != null) {
    focus.push(`退款率 ${fmtPp(cRefund, pRefund)}`);
  }

  const cProfit = numField(cm, 'grossProfitFen');
  const pProfit = numField(pm, 'grossProfitFen');
  if (cProfit != null && pProfit != null) {
    focus.push(`毛利 ${fmtChange(cProfit, pProfit)}`);
  }

  if (focus.length === 0) return [];
  lines.push('对比上一档：' + focus.join(' · '));

  // ── 阈值预警（只报超线的，不报「一切正常」—— 正常不该占注意力）──
  const alerts: string[] = [];

  if (cRefund != null && cRefund > ALERT_REFUND_RATE) {
    alerts.push(`退款率 ${fmtPct(cRefund)}，超过 ${fmtPct(ALERT_REFUND_RATE, 0)} 警戒线`);
  }
  if (cGmv != null && pGmv != null && pGmv > 0) {
    const drop = (cGmv - pGmv) / pGmv;
    if (drop < -ALERT_GMV_DROP) {
      alerts.push(
        `GMV 环比跌 ${(Math.abs(drop) * 100).toFixed(1)}%，超过 ${(ALERT_GMV_DROP * 100).toFixed(0)}% 警戒线`,
      );
    }
  }
  if (cProfit != null && cProfit < 0) {
    alerts.push(`毛利为负（${fmtYuan(cProfit)}），当前亏损`);
  }

  if (alerts.length) {
    lines.push('');
    for (const a of alerts) lines.push(`【要注意】${a}`);
  }

  return lines;
}

/* ------------------------------------------------------------------ *
 * D48 · 楼群 / 楼栋榜单
 * ------------------------------------------------------------------ */

/** 从榜单出参里取行（楼栋优先，取不到回落到楼群） */
function rankRows(data: unknown): { rows: Record<string, unknown>[]; scope: string } {
  const d = asObj(data);
  const bld = arrField(d, 'buildings')
    .map(asObj)
    .filter((x): x is Record<string, unknown> => x != null);
  if (bld.length) return { rows: bld, scope: '楼栋' };
  const grp = arrField(d, 'groups')
    .map(asObj)
    .filter((x): x is Record<string, unknown> => x != null);
  return { rows: grp, scope: '楼群' };
}

/** 按 id 建索引，供环比匹配 */
function indexById(rows: Record<string, unknown>[]): Map<number, Record<string, unknown>> {
  const m = new Map<number, Record<string, unknown>>();
  for (const r of rows) {
    const id = numField(r, 'id');
    if (id != null) m.set(id, r);
  }
  return m;
}

/**
 * 楼栋排行 + 跌幅点名。
 *
 * 环比只点名**一栋**（跌得最狠、且绝对额够看的那栋）。理由：老板问这个，
 * 99% 是想知道「哪里出了问题」，罗列十栋各自涨跌反而看不出重点。
 */
export function summarizeBuildingRank(cur: unknown, prev: unknown, topN = 5): string | null {
  const { rows, scope } = rankRows(cur);
  if (rows.length === 0) return null;

  const label = rangeLabel(asObj(cur) ?? {});
  const head = label ? `${scope}排行 · ${label}（按 GMV）` : `${scope}排行（按 GMV）`;
  const lines: string[] = [head];

  const top = rows.slice(0, topN);
  top.forEach((r, i) => {
    const name = strField(r, 'name') ?? `#${numField(r, 'id') ?? '?'}`;
    const gmv = numField(r, 'gmvFen');
    const cnt = numField(r, 'orderCount');
    const share = numField(r, 'gmvShare');
    const bits: string[] = [];
    if (gmv != null) bits.push(fmtYuan(gmv));
    if (cnt != null) bits.push(`${fmtInt(cnt)} 单`);
    if (share != null) bits.push(fmtPct(share));
    lines.push(`${i + 1}. ${name}  ${bits.join(' · ')}`);
  });

  const total = numField(asObj(cur), 'totalGmvFen');
  if (total != null) lines.push(`合计 ${fmtYuan(total)}`);

  // ── 环比：找跌得最狠且值得看的一栋 ──
  const prevRows = rankRows(prev).rows;
  if (prevRows.length) {
    const prevIdx = indexById(prevRows);
    let worst: { name: string; drop: number; cGmv: number; pGmv: number } | null = null;
    for (const r of rows) {
      const id = numField(r, 'id');
      const cGmv = numField(r, 'gmvFen');
      if (id == null || cGmv == null) continue;
      const pGmv = numField(prevIdx.get(id) ?? null, 'gmvFen');
      if (pGmv == null || pGmv < ALERT_MIN_GMV_FEN) continue; // 基数太小不看，避免噪声
      const drop = (cGmv - pGmv) / pGmv;
      if (drop > -ALERT_BUILDING_DROP) continue;
      if (!worst || drop < worst.drop) {
        worst = { name: strField(r, 'name') ?? `#${id}`, drop, cGmv, pGmv };
      }
    }
    if (worst) {
      lines.push('');
      lines.push(
        `【要注意】${worst.name} 跌 ${(Math.abs(worst.drop) * 100).toFixed(1)}%` +
          `（${fmtYuan(worst.pGmv)} → ${fmtYuan(worst.cGmv)}），超过 ${(ALERT_BUILDING_DROP * 100).toFixed(0)}% 警戒线`,
      );
    }
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * D49 · 商品热度
 * ------------------------------------------------------------------ */

export function summarizeDishHeat(data: unknown, topN = 5): string | null {
  const d = asObj(data);
  const items = arrField(d, 'items')
    .map(asObj)
    .filter((x): x is Record<string, unknown> => x != null);
  if (!d || items.length === 0) return null;

  const label = rangeLabel(d);
  const lines: string[] = [
    label ? `菜品热度 · ${label}（TOP ${Math.min(topN, items.length)}）` : '菜品热度',
  ];

  items.slice(0, topN).forEach((r, i) => {
    const name = strField(r, 'itemName') ?? `#${numField(r, 'itemId') ?? '?'}`;
    const qty = numField(r, 'quantity');
    const share = numField(r, 'share');
    const bits: string[] = [];
    if (qty != null) bits.push(`${fmtInt(qty)} 份`);
    if (share != null) bits.push(fmtPct(share));
    lines.push(`${i + 1}. ${name}  ${bits.join(' · ')}`);
  });

  const totalQty = numField(d, 'totalQuantity');
  const itemCount = numField(d, 'itemCount');
  const tail: string[] = [];
  if (totalQty != null) tail.push(`区间共 ${fmtInt(totalQty)} 份`);
  if (itemCount != null) tail.push(`涉及 ${fmtInt(itemCount)} 个商品`);
  if (tail.length) lines.push(tail.join(' · '));

  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * D50 · 留存
 * ------------------------------------------------------------------ */

export function summarizeRetention(data: unknown, topCohorts = 3): string | null {
  const d = asObj(data);
  const s = asObj(d?.summary);
  if (!d || !s) return null;

  const label = rangeLabel(d);
  const lines: string[] = [label ? `留存 · ${label}` : '留存'];

  const bits: string[] = [];
  const act = numField(s, 'activeUserCount');
  if (act != null) bits.push(`活跃 ${fmtInt(act)} 人`);
  const nw = numField(s, 'newUserCount');
  if (nw != null) bits.push(`新客 ${fmtInt(nw)}`);
  const back = numField(s, 'returningUserCount');
  if (back != null) bits.push(`回流 ${fmtInt(back)}`);
  const rep = numField(s, 'repeatUserCount');
  const repRate = numField(s, 'repeatRate');
  if (rep != null && repRate != null) bits.push(`复购 ${fmtInt(rep)} 人（${fmtPct(repRate)}）`);
  else if (repRate != null) bits.push(`复购率 ${fmtPct(repRate)}`);
  if (bits.length) lines.push(bits.join(' · '));

  const cohorts = arrField(d, 'cohorts')
    .map(asObj)
    .filter((x): x is Record<string, unknown> => x != null);
  const valid = cohorts.filter((c) => numField(c, 'newUserCount') != null);
  if (valid.length) {
    lines.push('按首单所在周分群：');
    for (const c of valid.slice(-topCohorts)) {
      const start = strField(c, 'cohortStart');
      const cnt = numField(c, 'newUserCount') ?? 0;
      const observable = c.observable === true;
      const rate = numField(c, 'retentionRate1');
      // ⚠️ 观察窗口没走完就不给留存率。此时算出来的低留存只是「数据还没长出来」，
      //    报了它，老板会以为留存崩了。
      const tail = observable
        ? rate != null
          ? `次周留 ${fmtPct(rate)}`
          : '次周留存无法计算'
        : '观察窗口未走完，暂不给留存率';
      lines.push(`· ${start ? start.slice(5) : '?'} 那周：新客 ${fmtInt(cnt)}，${tail}`);
    }
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * D77 · 页面停留
 * ------------------------------------------------------------------ */

export function summarizePageDuration(data: unknown, topN = 3): string | null {
  const d = asObj(data);
  const s = asObj(d?.summary);
  if (!d || !s) return null;

  const label = rangeLabel(d);
  const lines: string[] = [label ? `页面停留 · ${label}（按访问日）` : '页面停留（按访问日）'];

  const visits = numField(s, 'visits');
  const avg = numField(s, 'avgMs');
  const pageCount = numField(s, 'pageCount');
  const bits: string[] = [];
  if (visits != null) bits.push(`${fmtInt(visits)} 次访问`);
  if (pageCount != null) bits.push(`${fmtInt(pageCount)} 个页面`);
  if (avg != null) bits.push(`平均停留 ${fmtMs(avg)}`);
  if (bits.length) lines.push(bits.join(' · '));

  const pages = arrField(d, 'pages')
    .map(asObj)
    .filter((x): x is Record<string, unknown> => x != null);
  const shown = pages.slice(0, topN);
  if (shown.length) {
    lines.push('停留最久：');
    for (const p of shown) {
      const page = strField(p, 'page') ?? '（未命名页面）';
      const a = numField(p, 'avgMs');
      const v = numField(p, 'visits');
      const bits2: string[] = [];
      if (a != null) bits2.push(`平均 ${fmtMs(a)}`);
      if (v != null) bits2.push(`${fmtInt(v)} 次`);
      lines.push(`· ${page}  ${bits2.join(' · ')}`);
    }
  }

  // ⚠️ 匿名口径必须说出来：老板看到「1234 次访问」很容易读成「1234 个人」。
  lines.push('');
  lines.push('（匿名埋点，只有访问次数与停留时长，没有独立访客数）');

  return lines.join('\n');
}

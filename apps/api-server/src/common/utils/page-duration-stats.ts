import { toBjIso } from './time';

/**
 * utils/page-duration-stats —— 页面停留聚合判据（D77 · 2026-10-30）
 *
 * ⭐ 为什么抽成**纯函数**：`StatsService` 的服务层判据**没有单测拦**（全仓无
 *    `stats.service` 单测），改坏了只有人肉看数才发现。聚合口径又是「运营照着做
 *    决策」的东西 —— 错了不报错，只是结论错。故把两个最容易错的判据（路径归一、
 *    无效日期剔除）与聚合算法抽出来，让单测能钉住。
 *
 * ⭐ 为什么**不在 SQL 里**做归一与逐日分组：`TRIM(LEADING '/' FROM x)` 与
 *    `DAY(created_at)` 都是**驱动相关**语法（SQLite 无此二函数），用了就破坏
 *    「四驱动零改动切换」—— 本地全绿、换驱动才炸（同 D44 分月口径）。
 *    ⇒ 一律取出后在**服务端内存**完成，与 D44 同一条纪律。
 */

/** 进入聚合前的单条停留事件（已清洗：路径归一过、时刻有效） */
export interface PageDurationRowInput {
  /** 归一化后的页面路径 */
  page: string;
  /** 停留毫秒 */
  durationMs: number;
  /** 事件时刻（毫秒；用于分日） */
  atMs: number;
}

/** 单页聚合行 */
export interface PageDurationAggRow {
  page: string;
  /** 访问次数（**PV 口径** —— 匿名数据没有用户维度，算不出 UV/独立访客） */
  visits: number;
  totalMs: number;
  avgMs: number;
  medianMs: number;
  maxMs: number;
  /** 访问次数占比（0–1，保留 4 位小数） */
  share: number;
}

/** 分日趋势行 */
export interface PageDurationDailyRow {
  /** 自然日（北京时区 YYYY-MM-DD） */
  date: string;
  visits: number;
  avgMs: number;
}

export interface PageDurationAggregate {
  pages: PageDurationAggRow[];
  /** 分日趋势（按日期升序；区间内无数据的日子**不补零行** —— 补零会把「没数据」画成「停留 0」） */
  daily: PageDurationDailyRow[];
  summary: {
    visits: number;
    pageCount: number;
    totalMs: number;
    avgMs: number;
  };
}

/**
 * 页面路径归一
 *
 * 实测库里同一页有两种写法：`pages/index/index`（小程序）与 `/pages/index/index`（H5 历史版本），
 * 直接按原值分组会把**同一个页面算成两个**，且两边都不报错 —— 运营只会觉得「首页数据怎么这么少」。
 */
export function normalizePagePath(page: unknown): string {
  if (typeof page !== 'string') return '';
  return page.trim().replace(/^\/+/, '');
}

/**
 * 时刻清洗：无效日期行返回 `null`（调用方须剔除并计入 `droppedRows`）
 *
 * ⚠️ 为什么需要它：生产库里存在 `2026-10-27 13:57:49` 这类**不存在的日期**
 *    （MySQL 在宽松模式下允许写入，读出来 `new Date(...)` 得 Invalid Date）。
 *    不清掉，它会落进「某一天」的分日桶（或让整个聚合抛错），而这类行本身就
 *    **不是真实访问** —— 计入统计等于往结论里掺假数据。
 *
 * ⚠️ `null` 的语义是「这条不能用」，**不是「这条是 0 毫秒」**：后者会拉低平均值，
 *    把错误伪装成一个正常的低数值。
 *
 * ⛔ **已知边界（别把它当万能）**：MySQL 在宽松模式下存下的 `2026-10-27` 这类
 *    无效日期，经驱动转成 `Date` 时**已被 JS 宽松解析成一个合法的邻近日期**
 *    （实测 `new Date('2026-10-27 13:57:49')` → 2026-10-27，**有效**），
 *    ⇒ 本函数**识别不出**它（它此刻确实是个正常 Date）。
 *    这类脏数据只能靠**一次性数据清洗**解决（见 `stats.service.pageDuration()` 头注），
 *    不要指望在聚合层用日期合法性判据兜住。
 */
export function saneTimeMs(v: unknown): number | null {
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === 'string' || typeof v === 'number') {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** 停留毫秒清洗：负数 / 非有限 / 超 24h 的一律视为无效（与端上封顶口径一致） */
export function saneDurationMs(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n), 24 * 60 * 60 * 1000);
}

/** 中位数（偶数取中间两个的均值，四舍五入取整；空数组返回 0） */
export function medianOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * 聚合（纯函数 · 单次遍历分桶 + 排序输出）
 *
 * ⚠️ 排序口径：按 `visits` 降序，同次数按 `totalMs` 降序，再按 `page` 升序 ——
 *    三级都给了，**不留「同分随机序」**（否则运营刷新两次看到榜单顺序变了，
 *    会以为数据实时在变）。
 */
export function aggregatePageDuration(rows: PageDurationRowInput[]): PageDurationAggregate {
  const byPage = new Map<string, number[]>();
  const byDate = new Map<string, number[]>();

  for (const raw of rows) {
    // ⚠️ 归一**放在聚合内部**而不是交给调用方：调用方忘了归一，表现是「同一个页面
    //    在榜单里出现两次」，**不报错、也不容易被发现**。放在这里则无人可绕过。
    const page = normalizePagePath(raw.page);
    const r = { page, durationMs: raw.durationMs, atMs: raw.atMs };
    if (!r.page) continue;
    const p = byPage.get(r.page);
    if (p) p.push(r.durationMs);
    else byPage.set(r.page, [r.durationMs]);

    // 分日一律走 `toBjIso`（北京时区单一真相），不自己拼 `getFullYear()`
    // —— 后者取的是**宿主时区**，服务器时区一变，分日边界就整体偏移一天。
    const day = (toBjIso(new Date(r.atMs)) ?? '').slice(0, 10);
    if (day) {
      const d = byDate.get(day);
      if (d) d.push(r.durationMs);
      else byDate.set(day, [r.durationMs]);
    }
  }

  const totalVisits = rows.filter((r) => Boolean(r.page)).length;
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

  const pages: PageDurationAggRow[] = [...byPage.entries()]
    .map(([page, xs]) => {
      const totalMs = sum(xs);
      return {
        page,
        visits: xs.length,
        totalMs,
        avgMs: xs.length ? Math.round(totalMs / xs.length) : 0,
        medianMs: medianOf(xs),
        maxMs: xs.length ? Math.max(...xs) : 0,
        share: totalVisits ? round4(xs.length / totalVisits) : 0,
      };
    })
    .sort((a, b) => b.visits - a.visits || b.totalMs - a.totalMs || a.page.localeCompare(b.page));

  const daily: PageDurationDailyRow[] = [...byDate.entries()]
    .map(([date, xs]) => ({
      date,
      visits: xs.length,
      avgMs: xs.length ? Math.round(sum(xs) / xs.length) : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const totalMs = sum([...byPage.values()].map((xs) => sum(xs)));

  return {
    pages,
    daily,
    summary: {
      visits: totalVisits,
      pageCount: pages.length,
      totalMs,
      avgMs: totalVisits ? Math.round(totalMs / totalVisits) : 0,
    },
  };
}

/**
 * 时间工具（统一 UTC+8）
 * 关键锚点：截单 T-1 24:00、自动确认 T 日 14:00、跑批 T+1 02:00
 */
export const TZ_OFFSET_MINUTES = 8 * 60;

/** 返回北京时间（UTC+8）的 Date（其 UTC 字段即为北京时间字段） */
export function toBeijing(date: Date = new Date()): Date {
  return new Date(date.getTime() + TZ_OFFSET_MINUTES * 60 * 1000);
}

/** 业务日：以 T-1 24:00 为界，返回该订单归属的「T 日」yyyy-MM-dd */
export function bizDate(date: Date = new Date()): string {
  const bj = toBeijing(date);
  const s = bj.toISOString().slice(0, 10);
  return s;
}

/** 距离今日 24:00（截单）剩余毫秒 */
export function msToCutoff(date: Date = new Date()): number {
  const bj = toBeijing(date);
  const next = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() + 1));
  return next.getTime() - bj.getTime();
}

/**
 * 业务日加减：`yyyy-MM-dd` 位移 N 天（N 可负）
 *
 * ⚠️ 必须走 **纯 UTC** 运算。用本地时区构造 `new Date('2026-09-16')` 再加减，
 *    在 UTC+8 之外的机器上会整体偏一天 —— 而统计区间的首尾日一旦偏一天，
 *    看板上的每一个数都会错，且错得不明显（e2e 里只表现为「差一条」）。
 *
 * @param date 业务日字符串 `yyyy-MM-dd`，或 Date（走 {@link bizDate} 归一）
 */
export function shiftBizDate(date: Date | string, days: number): string {
  const base = typeof date === 'string' ? date : bizDate(date);
  const [y, m, d] = base.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * 该业务日所在自然周的**周一**（留存 cohort 分组用）
 *
 * 口径：周一到周日为一周（`getUTCDay()` 的周日 = 0，故先 +6 再 %7 归一）。
 */
export function weekStartBizDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return shiftBizDate(date, -dow);
}

/** 倒计时文本 `HH:mm:ss`（原型 P1/P3/P11 倒计时口径） */
export function countdownText(date: Date = new Date()): string {
  const diff = Math.max(0, msToCutoff(date));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(diff / 3600000))}:${pad(Math.floor((diff % 3600000) / 60000))}:${pad(
    Math.floor((diff % 60000) / 1000),
  )}`;
}

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

/** 倒计时文本 `HH:mm:ss`（原型 P1/P3/P11 倒计时口径） */
export function countdownText(date: Date = new Date()): string {
  const diff = Math.max(0, msToCutoff(date));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(diff / 3600000))}:${pad(Math.floor((diff % 3600000) / 60000))}:${pad(
    Math.floor((diff % 60000) / 1000),
  )}`;
}

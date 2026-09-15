/**
 * 金额工具（元 ↔ 分换算与浮点收敛）
 *
 * ⚠️ 口径（《接口规范》§1.6）：
 *   · **DB 与业务计算一律用「元」**（`DECIMAL(10,2)` / `decimal` + moneyTransformer）
 *   · **接口出参一律用「分」**（整数字段后缀 `Fen`），避免端上浮点显示误差
 *   · 元 → 分一律走 `toFen()`（四舍五入到分），禁止 `value * 100` 直接裸算
 */

/** 保留 2 位小数（四舍五入），消除累加浮点误差 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 元 → 分（整数） */
export function toFen(yuan: number): number {
  return Math.round(yuan * 100);
}

/** 分 → 元（保留 2 位） */
export function toYuan(fen: number): number {
  return round2(fen / 100);
}

/** 金额转「两位小数字符串」（落库用，DECIMAL 列统一入参形态） */
export function money(n: number): string {
  return round2(n).toFixed(2);
}

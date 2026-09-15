/**
 * 金额工具
 * 约定：金额一律用 **整数分** 在内部计算，避免浮点误差；
 * 对外展示统一 `¥25.80`（两位小数，人民币）。
 */
export function yuanToFen(yuan: number): number {
  return Math.round(yuan * 100);
}

export function fenToYuan(fen: number): number {
  return fen / 100;
}

/** 格式化为 `¥25.80` */
export function formatYuan(yuan: number | string): string {
  const n = typeof yuan === 'string' ? Number(yuan) : yuan;
  if (!Number.isFinite(n)) return '¥0.00';
  return `¥${n.toFixed(2)}`;
}

/** 保留两位小数的数值字符串（不带符号），用于表单 / 接口 */
export function toAmountString(yuan: number): string {
  return yuan.toFixed(2);
}

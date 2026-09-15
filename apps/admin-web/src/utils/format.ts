/** utils/format —— 后台通用格式化（金额 / 时间 / 文本脱敏） */

/** 分 → 元字符串（保留 2 位） */
export function fenToYuan(fen: number | null | undefined): string {
  if (fen === null || fen === undefined || !Number.isFinite(Number(fen))) return '—';
  return (Number(fen) / 100).toFixed(2);
}

/** 分 → 带 ¥ 前缀（金额列直接用） */
export function fenToCny(fen: number | null | undefined): string {
  const y = fenToYuan(fen);
  return y === '—' ? y : `¥${y}`;
}

/** 元 → 分（四舍五入，规避 25.8 * 100 = 2579.999… 的浮点误差） */
export function yuanToFen(yuan: number | string | null | undefined): number {
  const n = Number(yuan);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * 时间格式化
 *
 * ⚠️ 服务端出参有两种时间形态：`toBjIso()` 产出的**带 +08:00 偏移字符串**，
 *    以及 TypeORM 直接序列化的**实体 Date**（形如 `2026-09-15T12:00:00.000Z`）。
 *    本函数统一交给浏览器时区渲染；`null` 显示 `—`（不显示 Invalid Date）。
 */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 仅日期部分 */
export function formatDate(value: string | Date | null | undefined): string {
  const s = formatDateTime(value);
  return s === '—' ? s : s.slice(0, 10);
}

/** 空值占位 */
export function displayOr(value: unknown, placeholder = '—'): string {
  if (value === null || value === undefined || value === '') return placeholder;
  return String(value);
}

/** 手机号脱敏（§1.6 口径：非必要不展示全号） */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  const s = String(phone);
  return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-4)}` : s;
}

/** 收款账号脱敏（银行卡 / 支付宝） */
export function maskAccount(account: string | null | undefined): string {
  if (!account) return '—';
  const s = String(account);
  if (s.includes('*')) return s; // 服务端已脱敏
  return s.length <= 4 ? s : `${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
}

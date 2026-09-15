import { createHash } from 'crypto';

/**
 * 手机号脱敏（《接口规范》§1.6）
 *   出参一律脱敏：`13800000007` → `138****0007`
 *   ⚠️ 完整手机号仅 `/leader/orders` 导出接口返回，且必须写操作日志。
 */
export function maskPhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return '***';
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

/**
 * 手机号哈希（存 ab_user.phone_hash，用于「同号去重」而不落明文）
 * 加盐取独立盐值，避免明文可枚举。
 */
export function phoneHash(phone: string, salt = 'abox_phone'): string {
  return createHash('sha256')
    .update(`${salt}:${phone.replace(/\D/g, '')}`)
    .digest('hex');
}

/**
 * 收款账号脱敏（银行卡 / 支付宝）
 *   `6222021234567890123` → `6222****0123`
 *   短于 8 位时只留前 2 位 + 掩码。
 *
 * ⚠️ 落库口径：`ab_team_leader.payout_account` 与 `ab_withdraw.receive_account`
 *    一律**存脱敏值**（业务只需展示与人工核对末四位，无需完整账号）。
 */
export function maskAccount(account?: string | null): string | null {
  if (!account) return null;
  const s = account.replace(/\s/g, '');
  if (s.length <= 8) return `${s.slice(0, 2)}****`;
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/** 简易 UUID v4（幂等键兜底 / mock 场景，无需引入 uuid 依赖） */
export function uuidV4(): string {
  const hex = createHash('sha1')
    .update(`${Date.now()}_${Math.random()}_${process.hrtime.bigint().toString()}`)
    .digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

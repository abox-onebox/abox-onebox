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

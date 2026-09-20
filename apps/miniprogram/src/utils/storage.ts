/**
 * utils/storage —— 本地存储封装
 *
 * ⚠️ 键名**唯一来源在此**，且与原型同源（`abox_*`）：stores 一律从此处取键，
 *    不得各自硬编码 —— 否则改名时会出现「写入键 A、读取键 B」的静默失效。
 */
export const STORAGE_KEYS = {
  /** JWT（登录态） */
  token: 'abox_token',
  /** 用户资料 */
  user: 'abox_user',
  /** 是否具备团长身份（控制团长 tab 是否出现） */
  isLeader: 'abox_is_leader',
  /** 团长档案 */
  leader: 'abox_leader',
  /**
   * ⭐ **本地联调身份切换**（仅 demo 模式读取，见 `utils/dev-identity.ts`）
   *   —— 记「当前用的是哪个 `dev:<标识>`」，用于判断这次启动是否**换人了**
   *   （换人必须清掉上一个人的登录态，否则 token 还是旧用户的）。
   *   生产（`MODE=production`）下**永不写入、永不读取**。
   */
  devIdentity: 'abox_dev_identity',
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/** 读存储（缺失 / 异常一律回落 fallback，绝不抛错阻断页面） */
export function readStorage<T>(key: StorageKey, fallback: T): T {
  try {
    const value = uni.getStorageSync(key) as T | '' | null | undefined;
    if (value === '' || value === null || value === undefined) return fallback;
    return value;
  } catch (err) {
    console.warn(`[storage] 读取 ${key} 失败，使用默认值`, err);
    return fallback;
  }
}

/** 写存储（失败仅告警：存储不可用不应阻断业务） */
export function writeStorage(key: StorageKey, value: unknown): void {
  try {
    uni.setStorageSync(key, value);
  } catch (err) {
    console.warn(`[storage] 写入 ${key} 失败`, err);
  }
}

/** 删存储 */
export function removeStorage(key: StorageKey): void {
  try {
    uni.removeStorageSync(key);
  } catch (err) {
    console.warn(`[storage] 删除 ${key} 失败`, err);
  }
}

/** 取 JWT（空串 = 未登录） */
export function getToken(): string {
  return readStorage(STORAGE_KEYS.token, '');
}

/** 清空全部登录态（登出 / token 失效） */
export function clearAuthStorage(): void {
  removeStorage(STORAGE_KEYS.token);
  removeStorage(STORAGE_KEYS.user);
  removeStorage(STORAGE_KEYS.isLeader);
  removeStorage(STORAGE_KEYS.leader);
}

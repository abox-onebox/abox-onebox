import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * 后台账号口令哈希 —— **零依赖**（node:crypto 的 scrypt）
 *
 * 为什么不引 bcrypt/argon2：二者都是原生扩展，需编译工具链；本机沙箱
 * （Windows + pnpm 受限）装原生包风险高，而 scrypt 是 RFC 7914 标准 KDF，
 * 内存硬化参数足以覆盖「后台账号 < 10 个」的场景。
 *
 * 存储格式（自描述，便于日后无痛升级算法）：
 *   `scrypt:<saltHex>:<hashHex>`
 *   `dev_plain:<明文>`   ← 仅种子数据使用，**上线前必须清空**（见 docs 账号资源清单）
 *
 * ⚠️ 未知前缀一律返回 false（fail-closed），避免格式漂移导致「谁都登不进」被
 *    误判成「密码正确」。
 */
const SCRYPT_PREFIX = 'scrypt:';
const DEV_PLAIN_PREFIX = 'dev_plain:';

/** scrypt 参数：N=16384 / r=8 / p=1（Node 默认），keyLen=32 */
const KEY_LEN = 32;
const SALT_BYTES = 16;

/** 生成可入库的口令哈希 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const hash = scryptSync(plain, salt, KEY_LEN).toString('hex');
  return `${SCRYPT_PREFIX}${salt}:${hash}`;
}

/** 定长安全比较（长度不同直接 false，避免 timingSafeEqual 抛错） */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 校验口令 */
export function verifyPassword(plain: string, stored: string): boolean {
  if (!stored) return false;

  if (stored.startsWith(DEV_PLAIN_PREFIX)) {
    const expect = Buffer.from(stored.slice(DEV_PLAIN_PREFIX.length), 'utf8');
    return safeEqual(Buffer.from(plain, 'utf8'), expect);
  }

  if (stored.startsWith(SCRYPT_PREFIX)) {
    const rest = stored.slice(SCRYPT_PREFIX.length);
    const [salt, hash] = rest.split(':');
    if (!salt || !hash) return false;
    const actual = scryptSync(plain, salt, KEY_LEN);
    return safeEqual(actual, Buffer.from(hash, 'hex'));
  }

  return false;
}

/** 该哈希是否为「开发期明文占位」（供登录成功后提示 / 上线前扫描） */
export function isDevPlainHash(stored: string): boolean {
  return stored.startsWith(DEV_PLAIN_PREFIX);
}

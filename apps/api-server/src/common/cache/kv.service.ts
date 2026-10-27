import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

interface MemoryEntry {
  value: string;
  /** 到期时间戳（毫秒），0 = 永不过期 */
  expireAt: number;
}

/**
 * 单条命令的最长等待（毫秒）—— **fail-closed 的安全阀**
 *
 * ⚠️ 为什么必须有它：下面把 `enableOfflineQueue` 打开了（让「连接还没建立/正在重连」
 *    的命令排队而不是立刻抛），这同时意味着 Redis **真的**不可用时命令会**一直排队**。
 *    没有这个超时，fail-closed 就会从「拒绝」退化成「挂住」—— 那比拒绝更糟：
 *    请求不返回、连接池被占满、值班的人连错误日志都看不到。
 *    ⇒ 有了它，`incr` / `setNx` 的 fail-closed 语义**一点没动**：
 *      抖动 / 首次握手（毫秒级）⇒ 排队后成功；真不可用 ⇒ 超时后照旧抛错。
 */
const KV_COMMAND_TIMEOUT_MS = 1000;

/**
 * 轻量 KV（缓存 / 幂等键 / 任务锁）
 *
 * 双驱动（`QUEUE_DRIVER`，与队列共用开关，语义即「有无 Redis」）：
 *   memory —— 本地零依赖：进程内 Map，重启即丢（仅开发期，够用）
 *   redis  —— 生产 / 云端：ioredis
 *
 * ⚠️ **降级策略（2026-10-26 修订，仅适用于缓存类操作）**：
 *    `redis` 驱动下若连接失败（本地忘开 Redis、网络不通），
 *    自动降级为内存实现并打 WARN —— 保证「本地零依赖」承诺不被一个缓存拖垮。
 *    生产环境应通过监控告警暴露该 WARN。
 *
 * ⛔ **例外：`setNx` 与 `incr` 永不降级（fail-closed）**。
 *    原因：`setNx` 是幂等占位与分布式锁的**正确性原语**，不是缓存。
 *    一旦降级到进程内 Map，多实例各自持有互不相通的内存 ⇒
 *    同一个幂等键会在每个实例上都抢到一次 ⇒ 同一请求被真正执行两次，
 *    且不抛错、业务无感，只在日志留一行 WARN（实测已复现）。
 *    故此处与项目队列口径统一：**Redis 连不上就抛错，不静默降级**。
 *    ——宁可让下单失败报错，也不能让同一笔钱的事静默做两遍。
 */
@Injectable()
export class KvService implements OnModuleDestroy {
  private readonly logger = new Logger('KvService');
  private readonly memory = new Map<string, MemoryEntry>();
  private redis: Redis | null = null;
  private degraded = false;
  /** 配置声明的驱动是否为 redis（与运行期是否降级无关） */
  private readonly driverIsRedis: boolean;

  constructor(private readonly config: ConfigService) {
    const driver = this.config.get<string>('redis.driver') ?? 'memory';
    this.driverIsRedis = driver === 'redis';
    if (!this.driverIsRedis) {
      this.logger.log('KV 驱动：memory（进程内，重启即丢）');
      return;
    }

    try {
      /**
       * ⚠️ **连接层抗抖（2026-10-27 修 · 生产实测：部署后第一次登录直接 429）**
       *
       * 旧配置 `enableOfflineQueue: false` 的后果：ioredis 在 **socket 握手完成之前**
       * 收到命令会**立刻抛**
       *   `Stream isn't writeable and enableOfflineQueue options is false`
       * 而这与「Redis 整个不可达」的报错**一字不差**（本仓
       *   `scripts/test-kv-idempotency-degradation.mjs:73-77` 早就记载过这个陷阱，
       *   但那是给测试脚手架用的，生产代码一直没修）。
       * 再叠加 `lazyConnect: true`（第一次命令才去连接）⇒
       *   **进程启动后的第一批请求必然命中这个窗口**，且因为是 `failClosed`，
       *   表现为「登录 429 / 登录失败计数拒绝 / 幂等键拒绝 ⇒ 下单失败」。
       * 这不是「Redis 抖了一下」的可用性取舍，而是**把「还没连上」误判成「不可用」**。
       *
       * ⇒ 修法是**改判定粒度，不是放宽 fail-closed**：
       *     · `enableOfflineQueue: true` —— 握手/重连窗口内的命令**排队**，
       *       连上后自动执行（抖动对用户完全无感）；
       *     · `commandTimeout` —— 安全阀：真不可用时到点就抛，**fail-closed 照旧生效**；
       *     · `retryStrategy` —— 退避重连，避免网络恢复瞬间把连接打爆。
       */
      this.redis = new Redis({
        host: this.config.get<string>('redis.host'),
        port: this.config.get<number>('redis.port'),
        password: this.config.get<string>('redis.password'),
        db: this.config.get<number>('redis.db') ?? 0,
        lazyConnect: true,
        enableOfflineQueue: true,
        maxRetriesPerRequest: 2,
        commandTimeout: KV_COMMAND_TIMEOUT_MS,
        connectTimeout: 10_000,
        retryStrategy: (times: number) => Math.min(times * 200, 2000),
      });
      this.redis.on('error', (e: Error) => {
        if (!this.degraded) {
          this.degraded = true;
          this.logger.warn(`Redis 不可用，KV 降级为内存实现：${e.message}`);
        }
      });
      this.logger.log('KV 驱动：redis');
    } catch (e) {
      this.degraded = true;
      this.logger.warn(`Redis 初始化失败，KV 降级为内存实现：${(e as Error).message}`);
    }
  }

  private useMemory(): boolean {
    return this.redis === null || this.degraded;
  }

  private sweepIfNeeded(): void {
    // 惰性清理：仅在写入时抽样清理，避免定时器常驻
    if (this.memory.size < 500) return;
    const now = Date.now();
    for (const [k, v] of this.memory) {
      if (v.expireAt !== 0 && v.expireAt <= now) this.memory.delete(k);
    }
  }

  async get(key: string): Promise<string | null> {
    if (this.useMemory()) {
      const hit = this.memory.get(key);
      if (!hit) return null;
      if (hit.expireAt !== 0 && hit.expireAt <= Date.now()) {
        this.memory.delete(key);
        return null;
      }
      return hit.value;
    }
    try {
      return await this.redis!.get(key);
    } catch {
      this.degraded = true;
      return this.get(key);
    }
  }

  async set(key: string, value: string, ttlSec?: number): Promise<void> {
    if (this.useMemory()) {
      this.sweepIfNeeded();
      this.memory.set(key, {
        value,
        expireAt: ttlSec && ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0,
      });
      return;
    }
    try {
      if (ttlSec && ttlSec > 0) await this.redis!.set(key, value, 'EX', ttlSec);
      else await this.redis!.set(key, value);
    } catch {
      this.degraded = true;
      await this.set(key, value, ttlSec);
    }
  }

  /**
   * 仅当键不存在时写入（幂等占位 / 分布式锁的核心原语）
   *
   * ⛔ **fail-closed**：`redis` 驱动下**不降级**到进程内内存，Redis 出错直接向上抛。
   *    （降级会让多实例各抢到一次同一幂等键，见类注释。缓存类的 get/set/del 仍可降级。）
   *
   * @returns true = 本次抢到；false = 已被占用
   * @throws Redis 不可用 —— 调用方须按「无法保证幂等」处理，不可继续走资金路径
   */
  async setNx(key: string, value: string, ttlSec?: number): Promise<boolean> {
    // ① redis 驱动：永不走内存，异常直接抛（fail-closed）
    if (this.driverIsRedis) {
      if (!this.redis) {
        throw new Error(
          `KV setNx 不可用：redis 驱动已声明但客户端未初始化，且禁止降级到内存（key=${key}）`,
        );
      }
      // 用显式分支而非 args 数组：ioredis 的 set 重载对动态数组不友好（TS2352）
      const r =
        ttlSec && ttlSec > 0
          ? await this.redis.set(key, value, 'EX', ttlSec, 'NX')
          : await this.redis.set(key, value, 'NX');
      return r === 'OK';
    }

    // ② memory 驱动（仅开发期）：进程内语义，单实例下等价
    const hit = this.memory.get(key);
    if (hit && (hit.expireAt === 0 || hit.expireAt > Date.now())) return false;
    await this.set(key, value, ttlSec);
    return true;
  }

  async del(key: string): Promise<void> {
    if (this.useMemory()) {
      this.memory.delete(key);
      return;
    }
    try {
      await this.redis!.del(key);
    } catch {
      this.degraded = true;
      this.memory.delete(key);
    }
  }

  /**
   * 自增计数（登录失败次数 / 限流等）
   *
   * ⚠️ **TTL 只在首次自增时落，后续自增沿用首次的到期时刻**（滑动窗口的固定窗口版）。
   *    若每次自增都刷新 TTL，攻击者只要保持每 14 分钟失败一次就能把账号**永久锁死**。
   *
   * ⛔ **fail-closed（2026-10-26 修订 · N3）**：与 `setNx` 同口径，
   *    `redis` 驱动下**不降级**到进程内内存，Redis 出错直接向上抛。
   *
   *    原因：`incr` 的两个调用方都是**安全原语**，不是缓存 ——
   *      · `rate-limit.middleware` 接口限流
   *      · `auth.service` 登录失败次数锁定（防暴力破解）
   *    一旦降级，多实例各自持有一份互不相通的计数 ⇒ 限流阈值被放大到 N 倍、
   *    **暴力破解保护形同虚设**，且不抛错、业务无感，只在日志留一行 WARN。
   *    这是**安全问题**，不是可用性问题 —— 宁可拒绝请求，也不能让保护静默失效。
   *
   * @returns 自增后的值（从 1 开始）
   * @throws Redis 不可用 —— 调用方须按「无法计数」处理：
   *         限流应**拒绝**请求，登录失败计数应**拒绝**本次登录（都不可放行）
   */
  async incr(key: string, ttlSec?: number): Promise<number> {
    // ① redis 驱动：永不走内存，异常直接抛（fail-closed）
    if (this.driverIsRedis) {
      if (!this.redis) {
        throw new Error(
          `KV incr 不可用：redis 驱动已声明但客户端未初始化，且禁止降级到内存（key=${key}）`,
        );
      }
      const n = await this.redis.incr(key);
      if (n === 1 && ttlSec && ttlSec > 0) await this.redis.expire(key, ttlSec);
      return n;
    }

    // ② memory 驱动（仅开发期）：进程内语义，单实例下等价
    const hit = this.memory.get(key);
    const alive = !!hit && (hit.expireAt === 0 || hit.expireAt > Date.now());
    const next = (alive ? Number(hit!.value) : 0) + 1;
    const expireAt = alive ? hit!.expireAt : ttlSec && ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0;
    this.memory.set(key, { value: String(next), expireAt });
    return next;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch {
        /* 已断开则忽略 */
      }
    }
    this.memory.clear();
  }
}

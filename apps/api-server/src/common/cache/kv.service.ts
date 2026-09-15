import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

interface MemoryEntry {
  value: string;
  /** 到期时间戳（毫秒），0 = 永不过期 */
  expireAt: number;
}

/**
 * 轻量 KV（缓存 / 幂等键 / 任务锁）
 *
 * 双驱动（`QUEUE_DRIVER`，与队列共用开关，语义即「有无 Redis」）：
 *   memory —— 本地零依赖：进程内 Map，重启即丢（仅开发期，够用）
 *   redis  —— 生产 / 云端：ioredis
 *
 * ⚠️ **降级策略**：`redis` 驱动下若连接失败（本地忘开 Redis、网络不通），
 *    自动降级为内存实现并打 WARN —— 保证「本地零依赖」承诺不被一个缓存拖垮。
 *    生产环境应通过监控告警暴露该 WARN。
 */
@Injectable()
export class KvService implements OnModuleDestroy {
  private readonly logger = new Logger('KvService');
  private readonly memory = new Map<string, MemoryEntry>();
  private redis: Redis | null = null;
  private degraded = false;

  constructor(private readonly config: ConfigService) {
    const driver = this.config.get<string>('redis.driver') ?? 'memory';
    if (driver !== 'redis') {
      this.logger.log('KV 驱动：memory（进程内，重启即丢）');
      return;
    }

    try {
      this.redis = new Redis({
        host: this.config.get<string>('redis.host'),
        port: this.config.get<number>('redis.port'),
        password: this.config.get<string>('redis.password'),
        db: this.config.get<number>('redis.db') ?? 0,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
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
   * @returns true = 本次抢到；false = 已被占用
   */
  async setNx(key: string, value: string, ttlSec?: number): Promise<boolean> {
    if (this.useMemory()) {
      const hit = this.memory.get(key);
      if (hit && (hit.expireAt === 0 || hit.expireAt > Date.now())) return false;
      await this.set(key, value, ttlSec);
      return true;
    }
    try {
      // 用显式分支而非 args 数组：ioredis 的 set 重载对动态数组不友好（TS2352）
      const r =
        ttlSec && ttlSec > 0
          ? await this.redis!.set(key, value, 'EX', ttlSec, 'NX')
          : await this.redis!.set(key, value, 'NX');
      return r === 'OK';
    } catch {
      this.degraded = true;
      return this.setNx(key, value, ttlSec);
    }
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
   * @returns 自增后的值（从 1 开始）
   */
  async incr(key: string, ttlSec?: number): Promise<number> {
    if (this.useMemory()) {
      const hit = this.memory.get(key);
      const alive = !!hit && (hit.expireAt === 0 || hit.expireAt > Date.now());
      const next = (alive ? Number(hit!.value) : 0) + 1;
      const expireAt = alive
        ? hit!.expireAt
        : ttlSec && ttlSec > 0
          ? Date.now() + ttlSec * 1000
          : 0;
      this.memory.set(key, { value: String(next), expireAt });
      return next;
    }
    try {
      const n = await this.redis!.incr(key);
      if (n === 1 && ttlSec && ttlSec > 0) await this.redis!.expire(key, ttlSec);
      return n;
    } catch {
      this.degraded = true;
      return this.incr(key, ttlSec);
    }
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

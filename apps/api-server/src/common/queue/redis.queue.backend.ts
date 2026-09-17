import { Logger } from '@nestjs/common';
import { Queue as BullQueue, Worker as BullWorker } from 'bullmq';
import Redis from 'ioredis';

import {
  backoffMs,
  QueueJobHandler,
  QueueName,
  QUEUE_LABEL,
  QUEUE_NAMES,
  QueueStatsItem,
  type QueueBackend,
  type QueueBackendOptions,
} from './queue.types';

export interface RedisQueueConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  /** Worker 并发（每个队列各自一个 Worker） */
  concurrency: number;
}

/** Redis 键前缀（与其它用同一 Redis 的应用隔离） */
const BULL_PREFIX = 'abox';

/**
 * Redis + BullMQ 驱动（`QUEUE_DRIVER=redis`，生产驱动）
 *
 * ## ⚠️ 本文件是**未经本地运行验证**的分支 —— 如实标注
 *
 * 开发机没有 Docker（无 Redis），故本实现**只经过 typecheck 与代码评审**，
 * 没有在本机跑过一次真实入队/消费。上云后**必须**做一次冒烟：
 * 设 `QUEUE_DRIVER=redis` 起服务 → 触发一笔退款 → 确认 Redis 中出现
 * `abox:refund-apply` 键、任务被执行、失败任务按退避重试。
 * 在此之前，不要因为「代码看起来对」就认为生产队列已就绪
 * （本项目的一贯纪律：**没验过的路径不许当成已实装**）。
 *
 * ## 启动自检：连不上就拒绝启动（fail-closed）
 *
 * `create()` 里先用一条**短连接**探测（`retryStrategy: () => null` + 3s 超时），
 * 连不上直接抛错 → Nest 启动失败。**刻意不退化为进程内队列**，理由见
 * `queue.types.ts` 顶部：静默降级的后果是「任务写在某个实例的内存里」，
 * 既不报错也无处可查。
 *
 * ## 连接用法
 *
 * `Queue`（只发任务）共用一个连接；**每个 `Worker` 各用一个独立连接** ——
 * BullMQ 的 Worker 用阻塞式命令取任务（`BRPOPLPUSH`），与普通命令共用连接会
 * 让该连接被占住。
 */
export class RedisQueueBackend implements QueueBackend {
  readonly driver = 'redis' as const;
  readonly durable = true;

  private readonly logger = new Logger('Queue:redis');
  private readonly queues = new Map<QueueName, BullQueue>();
  private readonly workers = new Map<QueueName, BullWorker>();
  private producer: Redis | null = null;
  private closed = false;

  private constructor(
    private readonly cfg: RedisQueueConfig,
    private readonly opts: QueueBackendOptions,
  ) {}

  /** 工厂：探测连通性 → 建后端。连不上即抛（调用方决定让启动失败） */
  static async create(
    cfg: RedisQueueConfig,
    opts: QueueBackendOptions,
  ): Promise<RedisQueueBackend> {
    await RedisQueueBackend.probe(cfg);
    const backend = new RedisQueueBackend(cfg, opts);
    backend.producer = new Redis({
      host: cfg.host,
      port: cfg.port,
      password: cfg.password,
      db: cfg.db,
      // ⚠️ BullMQ 明确要求 null：它自己管理「阻塞取任务」的等待语义，
      //    设成数字会让阻塞命令在超时后被误判为失败
      maxRetriesPerRequest: null,
    });
    backend.producer.on('error', (e: Error) =>
      backend.logger.error(`队列 Redis 连接异常：${e.message}`),
    );
    backend.logger.log(`队列驱动：redis（${cfg.host}:${cfg.port}/${cfg.db}，前缀 ${BULL_PREFIX}）`);
    return backend;
  }

  /** 启动自检：短连接 ping 一次，失败抛带可操作指引的错误 */
  private static async probe(cfg: RedisQueueConfig): Promise<void> {
    const probe = new Redis({
      host: cfg.host,
      port: cfg.port,
      password: cfg.password,
      db: cfg.db,
      lazyConnect: true,
      connectTimeout: 3000,
      // 只连一次：探测失败要**立刻**得到结论，而不是按退避重连几十秒
      retryStrategy: () => null,
      maxRetriesPerRequest: 1,
    });
    try {
      await probe.connect();
      await probe.ping();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `队列驱动为 redis，但连接 Redis 失败（${cfg.host}:${cfg.port}）：${msg}\n` +
          '  · 本机无 Redis（无 Docker）→ 请显式设 QUEUE_DRIVER=memory（进程内队列，重启即丢）；\n' +
          '  · 生产环境 → 检查 REDIS_HOST / REDIS_PORT / REDIS_PASSWORD 与网络连通性。\n' +
          '  ⚠️ 队列**不做静默降级**：静默退化成进程内队列会让「任务只存在于某个实例' +
          '内存里」这种故障既不报错、也无处可查。',
      );
    } finally {
      probe.disconnect();
    }
  }

  async enqueue(queue: QueueName, name: string, payload: unknown): Promise<string> {
    if (this.closed) throw new Error('队列已关闭，拒绝入队');
    const bull = this.queues.get(queue) ?? this.makeQueue(queue);
    const job = await bull.add(name, payload, {
      attempts: this.opts.attempts,
      // 与 memory 驱动同一组退避数字（backoffMs），只差由 BullMQ 计时
      backoff: { type: 'exponential', delay: this.opts.backoffBaseMs },
      removeOnComplete: 200,
      removeOnFail: false,
    });
    return String(job.id);
  }

  register(queue: QueueName, handler: QueueJobHandler): void {
    if (this.workers.has(queue)) return;

    // Worker 用**独立连接**（阻塞式取任务会占住连接，见类头注释）
    const worker = new BullWorker(
      queue,
      async (job) => {
        await handler(job.data, {
          jobId: String(job.id),
          attempt: job.attemptsMade + 1,
          maxAttempts: job.opts.attempts ?? this.opts.attempts,
        });
      },
      {
        connection: {
          host: this.cfg.host,
          port: this.cfg.port,
          password: this.cfg.password,
          db: this.cfg.db,
          maxRetriesPerRequest: null,
        },
        prefix: BULL_PREFIX,
        concurrency: this.cfg.concurrency,
      },
    );

    worker.on('failed', (job, err) => {
      const made = job?.attemptsMade ?? 1;
      const max = job?.opts?.attempts ?? this.opts.attempts;
      if (made >= max) {
        this.opts.onDeadLetter({
          queue,
          jobName: job?.name ?? '-',
          payload: job?.data,
          attempts: made,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      } else {
        this.logger.warn(
          `任务 ${job?.id}（${QUEUE_LABEL[queue]}）第 ${made} 次失败，` +
            `退避 ${backoffMs(this.opts.backoffBaseMs, made)}ms 后重试：${err.message}`,
        );
      }
    });

    this.workers.set(queue, worker);
  }

  async stats(): Promise<QueueStatsItem[]> {
    const out: QueueStatsItem[] = [];
    for (const queue of QUEUE_NAMES) {
      const bull = this.queues.get(queue) ?? this.makeQueue(queue);
      const c = await bull.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
      out.push({
        queue,
        label: QUEUE_LABEL[queue],
        waiting: c.waiting ?? 0,
        active: c.active ?? 0,
        delayed: c.delayed ?? 0,
        failed: c.failed ?? 0,
        completed: c.completed ?? 0,
      });
    }
    return out;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const w of this.workers.values()) {
      try {
        await w.close();
      } catch {
        /* 关闭尽力而为 */
      }
    }
    for (const q of this.queues.values()) {
      try {
        await q.close();
      } catch {
        /* 同上 */
      }
    }
    try {
      this.producer?.disconnect();
    } catch {
      /* 同上 */
    }
    this.workers.clear();
    this.queues.clear();
  }

  private makeQueue(queue: QueueName): BullQueue {
    const bull = new BullQueue(queue, { connection: this.producer!, prefix: BULL_PREFIX });
    this.queues.set(queue, bull);
    return bull;
  }
}

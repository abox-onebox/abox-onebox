import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

import {
  backoffMs,
  QueueJobHandler,
  QueueName,
  QUEUE_LABEL,
  QueueStatsItem,
  type QueueBackend,
  type QueueBackendOptions,
} from './queue.types';

/** 一条待执行任务（进程内表示） */
interface MemoryJob {
  id: string;
  queue: QueueName;
  name: string;
  payload: unknown;
  /** 第几次尝试（1 = 第一次） */
  attempt: number;
  /** 何时可执行（毫秒时间戳，退避重试靠它） */
  availableAt: number;
}

/**
 * 进程内队列驱动（`QUEUE_DRIVER=memory`）
 *
 * 用途：**本地开发与 e2e** —— 无 Redis 也能把「入队 → 消费 → 重试 → 死信」
 * 整条链路跑通（否则这套代码在本地一行都执行不到）。
 *
 * ## 三个刻意的实现选择
 *
 * 1. **串行泵**（一次只执行一条任务）。并发需要锁与顺序保证，而 MVP 体量
 *    （≈500 单/天）根本不需要；串行还能让 e2e 的断言**确定性可复现** ——
 *    并发执行会让「第几次尝试」变得不可预测。
 * 2. **没有任务 = 没有定时器**。泵只在队列非空时挂一个 `setTimeout`，
 *    且 `unref()` —— 否则每个 e2e 进程结束前都会因为「还有一个待执行的定时器」
 *    多挂几秒（本项目已经因为进程不退出排查过多次）。
 * 3. **attempt 语义与 BullMQ 对齐**：`attempts=3` 表示**总共执行 3 次**
 *    （首次 + 2 次重试），不是「重试 3 次」。
 *
 * ⚠️ **不做持久化**（进程重启即丢）与**不跨实例分发** —— 这是驱动本身的定义，
 *    不是缺陷；`QueueService.stats()` 会把它如实标成 `durable=false`。
 */
export class MemoryQueueBackend implements QueueBackend {
  readonly driver = 'memory' as const;
  readonly durable = false;

  private readonly logger = new Logger('Queue:memory');
  private readonly jobs = new Map<QueueName, MemoryJob[]>();
  private readonly handlers = new Map<QueueName, QueueJobHandler>();
  private readonly completed = new Map<QueueName, number>();
  private readonly deadLettered = new Map<QueueName, number>();

  private timer: NodeJS.Timeout | null = null;
  private pumping = false;
  /** 当前正在执行的任务数（串行泵下 ∈ {0,1}） */
  private activeCount = 0;
  private closed = false;

  constructor(private readonly opts: QueueBackendOptions) {
    for (const q of this.allQueueNames()) this.jobs.set(q, []);
  }

  /**
   * 初始化时把三个队列各建一个空桶
   *
   * ⚠️ 用「已知队列清单」而不是「handler 注册时再建」：`stats()` 会在任何 handler
   *    注册之前被调用（健康检查早于消费者就绪），若按 handler 惰性建桶，
   *    早期调用会得到**空数组**而不是「三个队列 + 全 0」，看起来像队列不存在。
   */
  private allQueueNames(): QueueName[] {
    return Object.keys(QUEUE_LABEL) as QueueName[];
  }

  async enqueue(queue: QueueName, name: string, payload: unknown): Promise<string> {
    if (this.closed) throw new Error('队列已关闭，拒绝入队');
    const job: MemoryJob = {
      id: randomUUID(),
      queue,
      name,
      payload,
      attempt: 1,
      availableAt: Date.now(),
    };
    this.bucket(queue).push(job);
    this.schedule();
    return job.id;
  }

  register(queue: QueueName, handler: QueueJobHandler): void {
    this.handlers.set(queue, handler);
    this.schedule();
  }

  async stats(): Promise<QueueStatsItem[]> {
    return this.allQueueNames().map((queue) => {
      const all = this.bucket(queue);
      const now = Date.now();
      const delayed = all.filter((j) => j.availableAt > now).length;
      return {
        queue,
        label: QUEUE_LABEL[queue],
        waiting: all.length - delayed,
        active: this.activeCount,
        delayed,
        // 「失败」在 memory 驱动下的真实含义是「重试耗尽、已进死信」——
        // 中间态的重试留在 waiting/delayed 里，因为任务还在排队
        failed: this.deadLettered.get(queue) ?? 0,
        completed: this.completed.get(queue) ?? 0,
      };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const q of this.jobs.keys()) this.jobs.set(q, []);
  }

  // -------------------------------------------------------------------------
  // 泵
  // -------------------------------------------------------------------------

  private bucket(queue: QueueName): MemoryJob[] {
    let b = this.jobs.get(queue);
    if (!b) {
      b = [];
      this.jobs.set(queue, b);
    }
    return b;
  }

  /** 挂一个定时器，到点执行「最早到期」的那条任务 */
  private schedule(): void {
    if (this.closed || this.timer || this.pumping) return;
    const next = this.nextAvailableAt();
    if (next === null) return;

    const delay = Math.max(0, next - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, delay);
    // ⚠️ unref：待执行任务不应阻止进程退出（e2e 结束时不额外挂几秒）
    this.timer.unref?.();
  }

  private nextAvailableAt(): number | null {
    let min: number | null = null;
    for (const q of this.jobs.keys()) {
      for (const j of this.bucket(q)) {
        if (min === null || j.availableAt < min) min = j.availableAt;
      }
    }
    return min;
  }

  /** 取出**最早到期**的一条可执行任务（全局按 availableAt 排序，保证近似 FIFO） */
  private takeReady(): MemoryJob | null {
    const now = Date.now();
    let picked: MemoryJob | null = null;
    let pickedQueue: QueueName | null = null;

    for (const q of this.jobs.keys()) {
      const bucket = this.bucket(q);
      for (let i = 0; i < bucket.length; i++) {
        const j = bucket[i];
        if (j.availableAt > now) continue;
        if (!picked || j.availableAt < picked.availableAt) {
          picked = j;
          pickedQueue = q;
        }
      }
    }
    if (!picked || !pickedQueue) return null;

    const bucket = this.bucket(pickedQueue);
    bucket.splice(bucket.indexOf(picked), 1);
    return picked;
  }

  private async pump(): Promise<void> {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const job = this.takeReady();
        if (!job) break;
        await this.execute(job);
      }
    } finally {
      this.pumping = false;
      this.schedule();
    }
  }

  private async execute(job: MemoryJob): Promise<void> {
    const handler = this.handlers.get(job.queue);
    if (!handler) {
      // 消费者尚未注册（模块装配顺序问题）→ **不消耗尝试次数**，稍后重来。
      // 静默丢弃会让「任务入队了但没人消费」变成不可见故障，故至少要留痕。
      this.logger.warn(`队列「${QUEUE_LABEL[job.queue]}」尚无消费者，任务 ${job.id} 延后执行`);
      job.availableAt = Date.now() + 500;
      this.bucket(job.queue).push(job);
      return;
    }

    this.activeCount++;
    try {
      await handler(job.payload, {
        jobId: job.id,
        attempt: job.attempt,
        maxAttempts: this.opts.attempts,
      });
      this.completed.set(job.queue, (this.completed.get(job.queue) ?? 0) + 1);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (job.attempt >= this.opts.attempts) {
        this.deadLettered.set(job.queue, (this.deadLettered.get(job.queue) ?? 0) + 1);
        this.opts.onDeadLetter({
          queue: job.queue,
          jobName: job.name,
          payload: job.payload,
          attempts: job.attempt,
          error: err,
        });
      } else {
        const wait = backoffMs(this.opts.backoffBaseMs, job.attempt);
        this.logger.warn(
          `任务 ${job.id}（${QUEUE_LABEL[job.queue]}）第 ${job.attempt} 次失败，` +
            `${wait}ms 后重试：${err.message}`,
        );
        job.attempt += 1;
        job.availableAt = Date.now() + wait;
        this.bucket(job.queue).push(job);
      }
    } finally {
      this.activeCount--;
    }
  }
}

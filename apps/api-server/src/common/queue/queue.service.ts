import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OperationLog } from '../../database/entities/system.entity';
import { MemoryQueueBackend } from './memory.queue.backend';
import { RedisQueueBackend } from './redis.queue.backend';
import {
  DeadLetterInfo,
  QueueDriver,
  QueueJobHandler,
  QueueName,
  QueueStats,
  QueueStatsItem,
  QUEUE_DRIVER_NOTE,
  QUEUE_JOBS,
  QUEUE_LABEL,
  type QueueBackend,
} from './queue.types';

/** 死信操作日志的模块名 / 动作名（与对账告警同一张表，便于统一检索） */
const DEAD_LETTER_MODULE = 'queue';
const DEAD_LETTER_ACTION = '任务重试耗尽';

/**
 * 队列服务（M4-3）—— 业务侧**唯一**的入队入口
 *
 * ## 用法
 *
 * 生产端（支付 / 退款 / 结算）：
 * ```ts
 * await this.queue.enqueue('refund-apply', { refundId, orderNo, amountFen });
 * ```
 * 消费端（`src/queues/*.consumer.ts`）在 `onModuleInit` 里：
 * ```ts
 * this.queue.register('refund-apply', (payload, ctx) => this.handle(payload, ctx));
 * ```
 *
 * ## 为什么入队一定要 `await`
 *
 * `enqueue` 是**业务事务完成之后**的动作，但它本身是「这件事还没做完」的登记。
 * 若 fire-and-forget，Redis 抖动时任务可能没进去而调用方以为进去了 ——
 * 于是「退款单据已生成、重试任务不存在」这种组合就出现了，且没有任何痕迹。
 * 故 `enqueue` 会 await 到底；失败时**抛错给调用方**，由调用方决定
 * （重试类场景的原调用方本身就在 catch 里，多一层失败也只是记日志）。
 *
 * ## 死信（重试耗尽）为什么写 `ab_operation_log`
 *
 * 重试耗尽意味着「这件事**已经没有人再管了**」—— 必须有地方被人看见。
 * 落操作日志（`module='queue'`）而不是只打日志：日志会随轮转消失，
 * 而操作日志是运营/运维会主动去查的表（M3-15 的对账告警用的是同一张表）。
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Queue');
  private backend: QueueBackend | null = null;

  /**
   * 消费者注册表
   *
   * ⚠️ 不能只写进 backend：Nest 的 `onModuleInit` 顺序是**按模块拓扑**排的，
   *    `CommonModule`（本服务）可能先于 `QueuesModule`（消费者）初始化。
   *    故注册统一先进本表，backend 就绪时补注册；backend 已就绪则直接注册。
   *    两条路径都覆盖，避免「消费者注册丢失 → 任务永远无人消费」这种静默故障。
   */
  private readonly handlers = new Map<QueueName, QueueJobHandler>();

  /** 运行时参数（`stats()` 在 backend 就绪前也要能回答） */
  private driver: QueueDriver = 'memory';
  private attempts = 3;
  private backoffBaseMs = 1000;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(OperationLog)
    private readonly opLogRepo: Repository<OperationLog>,
  ) {}

  async onModuleInit(): Promise<void> {
    this.driver = this.config.get<QueueDriver>('app.drivers.queue') ?? 'memory';
    this.attempts = this.config.get<number>('app.queue.attempts') ?? 3;
    this.backoffBaseMs = this.config.get<number>('app.queue.backoffBaseMs') ?? 1000;
    const concurrency = this.config.get<number>('app.queue.concurrency') ?? 2;

    const opts = {
      attempts: this.attempts,
      backoffBaseMs: this.backoffBaseMs,
      onDeadLetter: (info: DeadLetterInfo) => void this.recordDeadLetter(info),
    };

    if (this.driver === 'redis') {
      // ⚠️ 连不上就抛 → Nest 启动失败。**刻意不做静默降级**（理由见 queue.types.ts）
      this.backend = await RedisQueueBackend.create(
        {
          host: this.config.get<string>('redis.host') ?? '127.0.0.1',
          port: this.config.get<number>('redis.port') ?? 6379,
          password: this.config.get<string>('redis.password') || undefined,
          db: this.config.get<number>('redis.db') ?? 0,
          concurrency,
        },
        opts,
      );
    } else {
      this.backend = new MemoryQueueBackend(opts);
      this.logger.log(
        `队列驱动：memory（进程内，重启即丢；attempts=${this.attempts}，退避基数=${this.backoffBaseMs}ms）`,
      );
    }

    // 补注册：本服务先于消费者模块初始化时走这里
    for (const [queue, handler] of this.handlers) this.backend.register(queue, handler);
  }

  async onModuleDestroy(): Promise<void> {
    await this.backend?.close();
    this.backend = null;
  }

  /** 生产端：把一个后续任务交给队列（任务名由 `QUEUE_JOBS` 决定，调用方不自造） */
  async enqueue(queue: QueueName, payload: unknown): Promise<string> {
    if (!this.backend) {
      throw new Error(`队列尚未初始化，无法入队（${QUEUE_LABEL[queue]}）`);
    }
    return this.backend.enqueue(queue, QUEUE_JOBS[queue], payload);
  }

  /** 消费端：注册处理器（同一队列重复注册以最后一次为准） */
  register(queue: QueueName, handler: QueueJobHandler): void {
    this.handlers.set(queue, handler);
    this.backend?.register(queue, handler);
  }

  /** 是否已有该队列的消费者（供 e2e / 运维自查「任务有没有人接」） */
  hasConsumer(queue: QueueName): boolean {
    return this.handlers.has(queue);
  }

  /**
   * 队列状态（管理端只读）
   *
   * ⭐ `durable=false` 是**重点**：它回答「现在这个队列会不会丢任务」。
   *    backend 未就绪（启动早期）时也要能回答，故用配置里的 driver 兜底。
   */
  async stats(): Promise<QueueStats> {
    const base = {
      driver: this.backend?.driver ?? this.driver,
      durable: this.backend?.durable ?? false,
      attempts: this.attempts,
      backoffBaseMs: this.backoffBaseMs,
    };

    if (!this.backend) {
      return {
        ...base,
        note: '队列尚未初始化（服务启动中）；以下计数为空。',
        queues: [],
      };
    }

    const queues: QueueStatsItem[] = await this.backend.stats();
    return { ...base, note: QUEUE_DRIVER_NOTE[this.backend.driver], queues };
  }

  /**
   * 死信落库（重试耗尽）
   *
   * ⚠️ 与 `MessageService.writeLog` 同一纪律：**记录失败绝不上抛** ——
   *    这里已经在处理「失败」了，再抛出去只会把失败叠成崩溃。
   */
  private async recordDeadLetter(info: DeadLetterInfo): Promise<void> {
    this.logger.error(
      `⛔ 任务重试耗尽（${QUEUE_LABEL[info.queue]} / ${info.jobName}）× ${info.attempts} 次：${info.error.message}`,
    );
    try {
      await this.opLogRepo.insert({
        adminUserId: null,
        module: DEAD_LETTER_MODULE,
        action: DEAD_LETTER_ACTION,
        targetId: info.queue,
        requestData: {
          jobName: info.jobName,
          attempts: info.attempts,
          payload: info.payload,
        },
        snapshot: {
          source: 'system',
          driver: this.backend?.driver ?? '-',
          error: info.error.message.slice(0, 512),
          // ⚠️ 死信是「这件事没人再管了」——必须留下**可人工处理**的信息，
          //    否则运维只看到「任务失败」，不知道该去核哪个业务对象
          hint:
            '该任务已停止重试。请按 payload 核对该业务对象的最终状态，' +
            '确认是否需要手工重跑（支付/退款类任务幂等，可安全重放）。',
        },
      });
    } catch (e) {
      this.logger.error(`写死信操作日志失败（不影响主流程）：${(e as Error).message}`);
    }
  }
}

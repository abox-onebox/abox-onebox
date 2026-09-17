/**
 * 队列基座 —— 类型与常量（M4-3）
 *
 * ## 为什么造这一层
 *
 * M4-3 之前，项目里所有「外部通道调用」与「通知投递」都**同步**发生在业务
 * 请求路径上：微信退款慢 → 退款接口慢；微信退款抛错 → 只能在接口里吞掉或失败。
 * 队列把这批工作从「必须当场成功」变成「**尽力立刻、失败可重试**」。
 *
 * ## 触发时机（本批真实接入的两类）
 *
 * 1. **外部通道失败重试**：微信退款 / 支付入账失败 → 入队退避重试，
 *    不再「等次日对账兜底」（对账只能发现错，不能修正）。
 * 2. **通知投递**：退款结果 / 团长申请确认 / 佣金入账 → 交由 `MessageService`
 *    投递，失败重试，且**永远不阻塞业务响应**。
 *
 * ## ⭐ 驱动策略：显式声明，**不静默降级**（与 `KvService` 刻意不同）
 *
 * `KvService` 在 Redis 连不上时自动降级为进程内 Map 并打 WARN —— 那是对的，
 * **因为 KV 存的是缓存、幂等键、任务锁**：丢一把锁最多让两个任务同时跑一次
 * （而任务本身在业务层以 `meal_date` 幂等），丢一条缓存只是重算一次。
 *
 * 队列**不能**沿用这个策略：
 *   · 进程内队列**重启即丢** —— 一条「微信退款失败待重试」的任务就这么没了；
 *   · 多实例部署时**每个实例各有一个内存队列**，任务被投到哪个实例是随机的，
 *     消费者不在同实例时任务**永不执行、也无处可查**。
 * 以上两种都不会报错 —— 正是本项目反复栽的「静默失效」形态。
 *
 * 故本层的策略是 **fail-closed**：
 *   · `QUEUE_DRIVER=memory` —— 显式声明走进程内（本地 / e2e），并在状态出参里
 *     **如实标注 `durable=false`**；
 *   · `QUEUE_DRIVER=redis` —— 启动时必须连上，**连不上就拒绝启动**（抛错），
 *     绝不悄悄退化成进程内。
 */

/** 队列驱动（复用 `QUEUE_DRIVER` 开关，与 `KvService` 同一开关但**策略不同**） */
export type QueueDriver = 'redis' | 'memory';

/** 三个队列（《项目目录结构 v2.0》§四 `queues/`） */
export const QUEUE_NAMES = ['order-paid', 'refund-apply', 'settle-orders'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/** 队列中文名（出参与日志共用，避免各处再写一份映射） */
export const QUEUE_LABEL: Record<QueueName, string> = {
  'order-paid': '支付后续',
  'refund-apply': '退款后续',
  'settle-orders': '结算后续',
};

/**
 * 重试策略（**两驱动共用同一组数字**，语义对齐；真值来自 `app.queue.*` 配置）
 *
 * 退避 = `backoffBaseMs * 2^(attempt-1)`（默认 1s / 2s / 4s…）。
 * 单调递增而非固定间隔：外部通道抖动多为「短暂过载」，越往后越该让路。
 *
 * ⚠️ `QUEUE_BACKOFF_BASE_MS` 可被环境变量覆盖 —— **e2e 用它把退避压到毫秒级**，
 *    否则「验证重试」要真等好几秒。生产保持默认 1000ms。
 */
export function backoffMs(baseMs: number, attempt: number): number {
  return baseMs * 2 ** Math.max(0, attempt - 1);
}

/** 任务上下文（处理器拿得到「这是第几次尝试」，便于日志与自愈判断） */
export interface QueueJobContext {
  jobId: string;
  /** 第几次尝试，从 1 开始 */
  attempt: number;
  maxAttempts: number;
}

/**
 * 任务处理器
 *
 * ⚠️ 契约：**抛错 = 需要重试**。处理器内部若要「失败但不重试」，必须自己吞掉
 *    并记录 —— 不要用抛错表达「业务上不需要重试」，那会被重试三次。
 */
export type QueueJobHandler<P = unknown> = (payload: P, ctx: QueueJobContext) => Promise<void>;

/** 单队列统计 */
export interface QueueStatsItem {
  queue: QueueName;
  label: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}

/**
 * 队列状态出参
 *
 * ⭐ `durable` 与 `note` 是本接口存在的主要理由：**让「当前队列会不会丢任务」
 *    这件事有地方可查**，而不是等人从「为什么退款没重试」倒推。
 */
export interface QueueStats {
  driver: QueueDriver;
  /** 进程重启后任务是否还在（`memory` 恒 false） */
  durable: boolean;
  note: string;
  attempts: number;
  backoffBaseMs: number;
  queues: QueueStatsItem[];
}

/** 驱动说明文案（状态出参与日志共用一份，不各写各的） */
export const QUEUE_DRIVER_NOTE: Record<QueueDriver, string> = {
  memory:
    '⚠️ 进程内队列（`QUEUE_DRIVER=memory`）：**进程重启即丢**，且多实例部署时任务不会跨实例分发 —— 仅限本地开发与测试。',
  redis: 'Redis + BullMQ：任务持久在 Redis，进程重启后仍可继续消费（生产驱动）。',
};

/**
 * 任务名（每个队列的**动作名**）
 *
 * 一期每个队列只有一个动作（保留 job name 这一层是为了将来同队列多动作时
 * 不必改数据结构）。名字写进 Redis 的 job.name，是**运维可见的事实** ——
 * 改名等于改线上可观测口径，不要随手改。
 */
export const QUEUE_JOBS = {
  'order-paid': 'confirm-paid',
  'refund-apply': 'execute-refund',
  'settle-orders': 'notify-settled',
} as const;

/** 死信信息（重试耗尽后交给上层记录 —— 队列层不直接依赖业务仓储） */
export interface DeadLetterInfo {
  queue: QueueName;
  jobName: string;
  payload: unknown;
  /** 实际执行次数（= 配置的 attempts） */
  attempts: number;
  error: Error;
}

export interface QueueBackendOptions {
  attempts: number;
  backoffBaseMs: number;
  /** 重试耗尽回调（由 `QueueService` 落操作日志，见该类注释） */
  onDeadLetter(info: DeadLetterInfo): void;
}

/**
 * 队列驱动契约（memory / redis 两驱动必须语义一致）
 *
 * ⚠️ 一致性要求：`attempts=3` 在两驱动下都必须表示**总共执行 3 次**。
 *    这是「换驱动不改行为」的底线 —— 若 redis 驱动把 3 解释成「重试 3 次」
 *    （共 4 次），同一份业务代码在本地与生产的行为就不同了。
 */
export interface QueueBackend {
  readonly driver: QueueDriver;
  /** 进程重启后任务是否还在（memory 恒 false） */
  readonly durable: boolean;
  enqueue(queue: QueueName, name: string, payload: unknown): Promise<string>;
  register(queue: QueueName, handler: QueueJobHandler): void;
  stats(): Promise<QueueStatsItem[]>;
  close(): Promise<void>;
}

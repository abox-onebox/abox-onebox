import { http } from './request';

/**
 * api/queue —— 运营后台队列状态（`GET /admin/queue`）
 *
 * ## 为什么这套类型在前端再写一份
 *
 * `QueueStats` 定义在 `api-server/src/common/queue/queue.types.ts`（**服务端内部**类型，
 * 不在 `@abox/shared-types` 里）。跨端共享它的代价是把它挪进共享包并连带改动
 * `QueueService` / 两个驱动 —— 为一个只读状态页动运行态契约不值当。
 * 故此处镜像一份**纯展示**字段，不参与任何业务判断。
 *
 * ⚠️ 队列名 / 中文名（`label`）**由服务端下发**，端上不维护第二份映射。
 */

export interface QueueStatsItem {
  queue: string;
  /** 队列中文名（服务端下发） */
  label: string;
  /** 等待中 */
  waiting: number;
  /** 正在执行 */
  active: number;
  /** 退避重试中（还没失败，只是稍后再试） */
  delayed: number;
  /** ⭐ 重试耗尽、已进死信 —— 这个数 > 0 就要人接手 */
  failed: number;
  completed: number;
}

export interface QueueStats {
  driver: string;
  /** 进程重启后任务是否还在（`memory` 恒 false） */
  durable: boolean;
  /** 驱动说明文案（服务端下发） */
  note: string;
  attempts: number;
  backoffBaseMs: number;
  queues: QueueStatsItem[];
}

export function fetchQueueStatus(): Promise<QueueStats> {
  return http.get<QueueStats>('/admin/queue');
}

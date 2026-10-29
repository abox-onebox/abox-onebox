/**
 * T1/T2 · 定时任务执行记录的**落库判据**（2026-10-29）
 *
 * ## 背景：为什么需要一条判据，而不是「跑一次写一条」
 * 项目不变量是「**派生值不落库**」（`schedule.service.ts` 头注），且 `run()` 已有的
 * `TaskRunOutcome` 只进日志。T2 要的是「**失败告警**」——告警是**事件**不是派生值，
 * 所以落 `ab_operation_log` 不违背该不变量（对账不平告警本就落这张表，有先例）。
 *
 * ⚠️ 但**不能每次跑批都写**：`pay-reconcile` 是**每 30 分钟**的高频任务，
 *    一年 17520 次运行 —— 成功也写，等于用噪音把真正的告警埋掉
 *    （本项目已有教训：`warnMissingOnce` 那条「每次都告警 = 没有告警」）。
 *
 * ## 判据（本文件唯一职责）
 * **只有失败才落库**；被锁跳过、执行成功都只进内存（供后台看「最近一次」）。
 *
 * ⚠️ 三个易错分支，逐条钉死：
 *  · `skipped='locked'` + `ran=false` —— **不是失败**（并发跑批占用，正常现象），写了会刷屏；
 *  · `error` 为空串 —— 按**未失败**处理（空串不是失败证据，fail-closed 反过来会漏报）；
 *  · 成功但 `result` 为 undefined —— 仍算成功（业务出参本就可能为空，不是失败）。
 */

/** 跑批结果的最小视图（与 `TaskRunOutcome` 的同名字段一致，刻意不引入依赖） */
export interface RunOutcomeLike {
  /** 是否抢到锁并执行 */
  ran: boolean;
  skipped?: 'locked';
  /** 业务异常信息（`run()` 吞异常后填在这里） */
  error?: string;
}

/** 落库动作名（也是「是否已告警过」的判据，勿随手改） */
export const RUN_FAILED_MODULE = 'system';
export const RUN_FAILED_ACTION = '定时任务失败';

/**
 * 这次跑批要不要落一条持久告警
 *
 * @returns true = 写 `ab_operation_log`；false = 只进内存
 */
export function shouldAlertRunFailure(outcome: RunOutcomeLike): boolean {
  // ① 被锁跳过：正常并发现象，不是失败
  if (!outcome.ran) return false;
  // ② 只有**非空**的 error 才构成失败的证据（空串视为未失败）
  return Boolean(outcome.error && outcome.error.trim().length > 0);
}

/**
 * 幂等键（同任务 + 同目标日期只告警一次）
 *
 * ⚠️ 与 `reconciliation` 的告警同一范式：重放（失败后锁已释放）**不重复堆行**，
 *    否则一次反复失败的跑批会在操作日志里堆出几十条，真正的新故障反而没人看。
 */
export function runFailureTargetId(task: string, date: string): string {
  return `${task}:${date}`;
}

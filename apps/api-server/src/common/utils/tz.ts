/**
 * 全项目统一时区常量（单一真相）
 *
 * 为什么单独一个文件：它同时被**业务时间轴**（`order-timeline.ts`，决定时刻的语义）
 * 与**调度声明表**（`tasks/schedule.service.ts`，决定 cron 的时区）使用。
 * 若各自写一份字面量，就又是一处「两处各写一遍」的漂移源（同缺陷 #49 的成因）。
 *
 * ⚠️ 服务端所有时间计算都假定 `Asia/Shanghai`（见 `common/utils/time.ts` 的
 *    `TZ_OFFSET_MINUTES = 8 * 60`）—— 该偏移量是**写死的 UTC+8**，不读系统时区，
 *    也不做夏令时处理（中国自 1991 年起无夏令时，故安全）。
 */
export const TZ = 'Asia/Shanghai';

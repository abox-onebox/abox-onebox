import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { DeliveryGenerateResult, DeliveryService } from '../modules/delivery/delivery.service';
import { ScheduleService, TASK_SCHEDULES } from './schedule.service';

const NAME = 'delivery-generate' as const;
const SPEC = TASK_SCHEDULES[NAME];

/**
 * T 日 00:30 · 生成配送单（4.3）
 *
 * 口径：《订单状态机与全链路流转 v1.0》§3 「T 日 00:30 delivery-generate.task
 *      生成次日配送单 ab_delivery_record」
 *
 * ## 为什么在 00:30 而不是 00:00
 * 它必须排在 `cutoff`（00:00）之后：配送单的份数取自「截单后定格」的订单。
 * 二者相隔 30 分钟，是给截单留的处理窗口（截单要遍历当日全部订单 + 解冻余额）。
 *
 * ## 目标日期是「今日」
 * D 日 00:30 生成的是 **D 日**（今天）的配送单 —— 那批货当天 11:30 就要送到。
 *
 * ## 粒度是「楼群」不是「订单」
 * `ab_delivery_record` 唯一键 `(meal_date, building_group_id)` —— 一天一个楼群一张单。
 * 与「一车货送一个楼群、团长在楼下收」的实际履约一致。
 *
 * 手动补跑（e2e / 运维）：直接调 `DeliveryService.generateByDate(date)`，不经本任务。
 */
@Injectable()
export class DeliveryGenerateTask {
  private readonly logger = new Logger(DeliveryGenerateTask.name);

  constructor(
    private readonly sched: ScheduleService,
    private readonly delivery: DeliveryService,
  ) {}

  @Cron(SPEC.cron, { timeZone: SPEC.timeZone })
  async handle(): Promise<void> {
    const outcome = await this.sched.run(NAME, (date) => this.runOnce(date));

    if (outcome.error || !outcome.result) return; // `run()` 已记录失败原因
    const r = outcome.result;
    const { date } = outcome;

    this.logger.log(
      `配送单生成 date=${date} 新建 ${r.created} 单 / ${r.totalQuantity} 份 ` +
        `预计送达 ${r.expectedAt}（幂等跳过 ${r.skipped} / 无单楼群 ${r.emptyGroups}）`,
    );
    if (r.warning) this.logger.warn(r.warning);
  }

  /**
   * 业务执行口（**不含锁**）—— 跑批与手动补跑共用
   *
   * 手动补跑：`POST /admin/schedule/delivery-generate/run`（不带锁）。
   */
  async runOnce(date: string): Promise<DeliveryGenerateResult> {
    return this.delivery.generateByDate(date);
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { AutoConfirmByDateResult, OrderService } from '../modules/order/order.service';
import { ScheduleService, TASK_SCHEDULES } from './schedule.service';

const NAME = 'auto-confirm' as const;
const SPEC = TASK_SCHEDULES[NAME];

/**
 * T 日 14:00 · 自动确认收货兜底 + 计佣（4.4）
 *
 * 口径：《订单状态机与全链路流转 v1.0》§3「T 日 14:00 auto-confirm.task ⚠️锚点2
 *      自动确认收货」+ §二 T11（`delivered → completed`）+ §时点表
 *      「佣金**计算** T 日 14:00 / 佣金**入账** T+1 02:00」。
 *
 * ## 目标日期是「**今日**」，不是「明日」
 * ⚠️ 本任务与 `meal-publish` 的 cron **完全相同**（`0 0 14 * * *`），但两者动的是
 *    **不同的一天**：
 *      · `meal-publish`  开的是 **D+1** 的团（D+1 的开团时刻正是 D 日 14:00）
 *      · `auto-confirm`  确认的是 **D** 日的单（D 日 14:00 收 D 日已送达的货）
 *    这也是整张调度表里**最容易配错**的一处，故日期不在这里算，一律由
 *    `ScheduleService.requireDateForTask()` 从 `TASK_SCHEDULES` 推导。
 *
 * ## ⭐ 本任务只做「计佣」，不做「入账」（两段式 · 2026-09-17 定稿）
 * ```
 * T 日 14:00  本任务 ──► ab_commission(status=pending)      ← 计佣
 * T+1 02:00   commission-settle.task ──► 进团长余额          ← 入账
 * ```
 * 端上「本次计佣 ¥X」与「已到账」是两件事，文案已同步（见 `leader-order.ts`）。
 *
 * ## 只做委托
 * 确认 + 计佣 + 晋级审计全在 `OrderService.autoConfirmByDate()` —— 与手动补跑共用
 * 同一执行口，跑批不会长出第二套口径。
 *
 * 手动补跑（e2e / 运维）：`POST /admin/schedule/auto-confirm/run`（`date` 可选）。
 */
@Injectable()
export class AutoConfirmTask {
  private readonly logger = new Logger(AutoConfirmTask.name);

  constructor(
    private readonly sched: ScheduleService,
    private readonly orders: OrderService,
  ) {}

  @Cron(SPEC.cron, { timeZone: SPEC.timeZone })
  async handle(): Promise<void> {
    const outcome = await this.sched.run(NAME, (date) => this.runOnce(date));

    if (outcome.error || !outcome.result) return; // `run()` 已记录失败原因
    const r = outcome.result;
    const { date } = outcome;

    if (r.confirmedCount === 0 && r.notDelivered.count === 0 && r.orphanConfirmed === 0) {
      // 该日出餐计划未排期、或团长已全部自行确认 —— 属正常，不必告警
      this.logger.log(`自动确认 date=${date} 无待确认订单（团长已自行确认或当日无排期）`);
      return;
    }

    this.logger.log(
      `自动确认完成 date=${date} 确认 ${r.confirmedCount} 单（${r.confirmedQuantity} 份）` +
        `计佣 ¥${(r.commissionFen / 100).toFixed(2)}（pending · 次日 02:00 入账）` +
        (r.orphanConfirmed ? ` · 无归属收口 ${r.orphanConfirmed} 单` : '') +
        (r.promotions.length ? ` · 触发晋级 ${r.promotions.length} 人` : ''),
    );

    // ⚠️ 履约异常必须**显式喊出来**：这些单没被确认、佣金也计不了，
    //    若只混在成功日志里，运营只会看到「确认了 N 单」，异常永远浮不上来。
    if (r.notDelivered.count) {
      this.logger.warn(
        `⚠️ date=${date} 有 ${r.notDelivered.count} 单到 14:00 仍未送达` +
          `（${Object.entries(r.notDelivered.byStatus)
            .map(([s, n]) => `${s}=${n}`)
            .join(' / ')}）—— 状态未改动，请人工核查出餐与配送`,
      );
    }
  }

  /**
   * 业务执行口（**不含锁**）—— 跑批与手动补跑共用
   *
   * · 跑批：`handle()` 经 `sched.run()` 调用（带锁，同一目标日期只跑一次）
   * · 手动补跑：`POST /admin/schedule/auto-confirm/run`（**不带锁** ——
   *   补跑的意义正是「跑批没跑成/要重跑」，被锁挡住就失去用途）
   */
  async runOnce(date: string): Promise<AutoConfirmByDateResult> {
    return this.orders.autoConfirmByDate(date);
  }
}

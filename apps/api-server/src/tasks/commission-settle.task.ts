import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { CommissionService, CommissionSettleView } from '../modules/finance/commission.service';
import { ScheduleService, TASK_SCHEDULES } from './schedule.service';

const NAME = 'commission-settle' as const;
const SPEC = TASK_SCHEDULES[NAME];

/**
 * T+1 02:00 · 佣金入账（4.5）
 *
 * 口径：《订单状态机与全链路流转 v1.0》§3「T+1 02:00 commission-settle.task
 *      佣金入账：计入团长佣金余额（提现走灵活用工代发 · C11）」。
 *
 * ## ⭐ 两段式的第二段（2026-09-17 · M4-2 定稿）
 * ```
 * T 日 14:00  auto-confirm（或团长 L9 一键分发）──► ab_commission(status=pending)
 * T+1 02:00   本任务 ──────────────────────────► status=settled + 进团长余额
 * ```
 * 故 `pending` 是**每天都存在的正常中间态**，`scanned=0` 只在「当天没有新确认的订单」
 * 时出现。本任务与 D35 手动补跑端点的**同一执行口**是 `CommissionService.settlePending()`
 * —— 不存在第二套入账逻辑。
 *
 * ## 目标日期是「**昨日**」
 * 入账对象是**已发生出餐日（D 日）**的订单佣金：D 日 14:00 确认 → D+1 02:00 入账。
 * 日期一律由 `ScheduleService.requireDateForTask()` 从 `TASK_SCHEDULES` 推导。
 *
 * ⚠️ 本任务**不做「补计佣」**：它只把**已经存在的** `pending` 行入账，不会去扫描
 *    「该计佣却没有佣金行的订单」—— 订单表没有「下单/确认时刻的团长等级」快照，
 *    事后补算只能读团长**当前**等级，中间晋级过的会被**多算**且无法自证
 *    （《缺陷与陷阱》#51）。**做一个会算错的补算，比不做更危险。**
 *
 * 手动补跑（e2e / 运维）：`POST /admin/schedule/commission-settle/run`（`date` 可选）。
 */
@Injectable()
export class CommissionSettleTask {
  private readonly logger = new Logger(CommissionSettleTask.name);

  constructor(
    private readonly sched: ScheduleService,
    private readonly commissions: CommissionService,
  ) {}

  @Cron(SPEC.cron, { timeZone: SPEC.timeZone })
  async handle(): Promise<void> {
    const outcome = await this.sched.run(NAME, (date) => this.runOnce(date));

    if (outcome.error || !outcome.result) return; // `run()` 已记录失败原因
    const r = outcome.result;
    const { date } = outcome;

    if (r.scanned === 0) {
      // ⚠️ 这是**正常**的（当天没有新确认的订单），不是「钱没结」。
      //    若此处改记 warn，运营每天凌晨都会被一条假告警吵醒。
      this.logger.log(`佣金入账 date=${date} 无待入账佣金（当天无新确认订单）`);
      return;
    }

    this.logger.log(
      `佣金入账完成 date=${date} 入账 ${r.settled} 条 / ${r.leaders.length} 个团长` +
        ` ¥${(r.amountFen / 100).toFixed(2)}（${r.quantity} 份）` +
        (r.skipped ? ` · 跳过 ${r.skipped} 条` : ''),
    );

    // 跳过项**必须显式喊出来**（团长档案不存在多半是脏数据）；不静默丢弃。
    if (r.skippedReasons.length) {
      this.logger.warn(`佣金入账 date=${date} 有跳过项：${r.skippedReasons.join('；')}`);
    }
  }

  /**
   * 业务执行口（**不含锁**）—— 跑批与手动补跑共用
   *
   * · 跑批：`handle()` 经 `sched.run()` 调用（带锁，同一目标日期只跑一次）
   * · 手动补跑：`POST /admin/schedule/commission-settle/run`（**不带锁**）
   */
  async runOnce(date: string): Promise<CommissionSettleView> {
    return this.commissions.settlePending({ date });
  }
}

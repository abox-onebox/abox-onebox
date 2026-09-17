import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { money } from '../common/utils/money';
import { SupplierShareService } from '../modules/finance/supplier-share.service';
import { ScheduleService, TASK_SCHEDULES } from './schedule.service';

const NAME = 'supplier-share' as const;
const SPEC = TASK_SCHEDULES[NAME];

/**
 * T+1 02:00 · 生成**昨日**应付结算单（只生成不拨款 · C10 不变）
 *
 * 口径（《ABox一盒自营结算口径定义v1.0.md》§四 · 《订单状态机》§3.1 定时任务清单）：
 *   · 计费基数 = **实收量**（S2 出餐确认申报的实送份数；未申报 = 计划量）
 *   · 单价 = 逐菜协商采购价（取**出餐计划生成时冻结的快照**）
 *   · 对象 = **只有供应商**（半成品采购款）；场所/打包/配送是自身成本，不出付款单
 *
 * ⚠️ 幂等：以 `(供应商, 菜品, 出餐日)` 为键，重复触发不会多出单 ——
 *    与「运营手动补跑」共用 `SupplierShareService.generate()` 同一执行口，
 *    因此**跑批与手动补跑不会有第二套口径**。
 *
 * ⚠️ fail-closed 项（该日出餐确认未完成 / 资质异常）**不会**被自动出单，
 *    而是进「未出单异常清单」等运营处理 —— 日志里给 warn，页面入口见 P34。
 *
 * 手动触发（e2e / 运维补数）走 `SupplierShareService.generate()`，不经本任务。
 */
@Injectable()
export class SupplierShareTask {
  private readonly logger = new Logger(SupplierShareTask.name);

  constructor(
    private readonly sched: ScheduleService,
    private readonly shares: SupplierShareService,
  ) {}

  @Cron(SPEC.cron, { timeZone: SPEC.timeZone })
  async handle(): Promise<void> {
    // 目标日期 = 「昨日」（应付的对象是**已发生**的交付），由声明表推导后透传
    const outcome = await this.sched.run(NAME, (date) => this.runOnce(date));

    if (outcome.error || !outcome.result) return; // `run()` 已记录失败原因
    const r = outcome.result;

    this.logger.log(
      `应付出单完成 date=${r.date} 新增 ${r.summary.createdCount} 单 ` +
        `¥${money(r.summary.createdAmountFen / 100)} ` +
        `跳过 ${r.summary.skippedCount}（已出过） 异常 ${r.summary.exceptionCount}`,
    );
    if (r.summary.exceptionCount) {
      this.logger.warn(
        `未出单异常 ${r.summary.exceptionCount} 项（多为出餐确认未完成/资质异常）` +
          '—— 请在后台「应付结算」页查看异常清单并处理',
      );
    }
  }

  /**
   * 业务执行口（**不含锁**）—— 跑批与手动补跑共用
   *
   * 手动补跑：`POST /admin/schedule/supplier-share/run`（不带锁）。
   */
  async runOnce(date: string) {
    return this.shares.runDaily(date);
  }
}

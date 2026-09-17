import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { CutoffByDateResult, OrderService } from '../modules/order/order.service';
import { ProducePlanFreezeResult, SupplierService } from '../modules/supplier/supplier.service';
import { ScheduleService, TASK_SCHEDULES } from './schedule.service';

const NAME = 'cutoff' as const;
const SPEC = TASK_SCHEDULES[NAME];

/** 截单出参（跨订单 / 供应商两域的组合结果） */
export interface CutoffOutcome {
  cut: CutoffByDateResult;
  plan: ProducePlanFreezeResult;
}

/**
 * T-1 24:00 · 截单（4.2 · ⚠️ **关键锚点 1**）
 *
 * 口径：《订单状态机与全链路流转 v1.0》§3 T-1 24:00
 *   ① `pending_pay → cancelled`（批量，解冻余额）
 *   ② `paid → cut_off`（锁定，**不可逆**）
 *   ③ 汇总各菜品份数 → 推送 N 家供应商备料量
 *
 * ## 为什么这个任务是**两个域的组合**，而它自己不写业务
 * 三段里前两段属订单域（`OrderService.cutoffByDate`）、第三段属供应商域
 * （`SupplierService.freezeProducePlan`）。**截单本身是一个跨域业务流程**，
 * 所以由任务来组合 —— 而不是让订单服务反向依赖供应商服务。
 * 每个域仍只由自己的服务实现，任务不含任何判定逻辑。
 *
 * ## 目标日期是「今日」
 * D 日 00:00 截的是 D 日的单 —— D 日的截单时刻正是 D 日 00:00（`cutoffAtOf`）。
 * 也就是说本任务**不需要任何日期偏移**（偏移只在「开明日团」和「T+1 结算」出现）。
 *
 * ## 顺序不可颠倒
 * 必须先截单（订单状态定格、`sold_count` 回写）**再**刷新生产计划 ——
 * 反过来的话，计划量会按**未定格**的销量算出来，而它一旦生成就冻结了。
 *
 * ## 幂等
 * 业务层以 `meal_date` 为键天然幂等（重跑时已无 `pending_pay` / `paid` 订单，
 * 计划刷新按当前订单重算覆盖）。故重复触发**不产生重复数据**（验收标准 3）。
 *
 * 手动补跑（e2e / 运维）：按同样顺序调
 * `OrderService.cutoffByDate(date)` → `SupplierService.freezeProducePlan(date)`，不经本任务。
 */
@Injectable()
export class CutoffTask {
  private readonly logger = new Logger(CutoffTask.name);

  constructor(
    private readonly sched: ScheduleService,
    private readonly orders: OrderService,
    private readonly suppliers: SupplierService,
  ) {}

  @Cron(SPEC.cron, { timeZone: SPEC.timeZone })
  async handle(): Promise<void> {
    const outcome = await this.sched.run(NAME, (date) => this.runOnce(date));

    if (outcome.error || !outcome.result) return; // `run()` 已记录失败原因
    const { cut, plan } = outcome.result;
    const { date } = outcome;

    this.logger.log(
      `截单完成 date=${date} ` +
        `未支付取消 ${cut.autoCancelled.count} 单（解冻 ¥${(cut.autoCancelled.releasedBalanceFen / 100).toFixed(2)}）` +
        ` / 锁定 ${cut.locked.count} 单 ${cut.locked.totalQuantity} 份` +
        ` / 备料量 ${plan.totalQuantity} 份（涉及 ${plan.supplierCount} 家供应商）`,
    );

    if (!cut.autoCancelled.count && !cut.locked.count) {
      this.logger.warn(`截单 date=${date} 无订单可处理 —— 该日可能未开团，或跑批重复触发`);
    }
    if (plan.skippedStarted) {
      this.logger.warn(
        `截单 date=${date} 有 ${plan.skippedStarted} 道菜的生产计划已开工，` +
          '备料量未按截单结果覆盖 —— 请人工核对是否漏产',
      );
    }
  }

  /**
   * 业务执行口（**不含锁**）—— 跑批与手动补跑共用
   *
   * ⚠️ 顺序不可颠倒：**先截单（订单状态定格、`sold_count` 回写）再刷新生产计划**。
   *    反过来的话，计划量会按未定格的销量算出来，而它一旦生成就冻结了。
   *
   * 手动补跑：`POST /admin/schedule/cutoff/run`（不带锁）。
   */
  async runOnce(date: string): Promise<CutoffOutcome> {
    // ① + ② 订单侧：取消未支付 / 锁定已支付 / 定格备料量基数
    const cut = await this.orders.cutoffByDate(date);
    // ③ 供应商侧：按定格后的量覆盖刷新生产计划（谁被冻结，就按谁结算）
    const plan = await this.suppliers.freezeProducePlan(date);
    return { cut, plan };
  }
}

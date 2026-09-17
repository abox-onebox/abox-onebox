import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OperationLog } from '../database/entities/system.entity';
import { DeliveryModule } from '../modules/delivery/delivery.module';
import { FinanceModule } from '../modules/finance/finance.module';
import { MealModule } from '../modules/meal/meal.module';
import { OrderModule } from '../modules/order/order.module';
import { SupplierModule } from '../modules/supplier/supplier.module';
import { TeamLeaderModule } from '../modules/team-leader/team-leader.module';
import { ScheduleService } from './schedule.service';
import { ScheduleAdminService } from './schedule-admin.service';
import { ScheduleAdminController } from './schedule-admin.controller';
import { MealPublishTask } from './meal-publish.task';
import { CutoffTask } from './cutoff.task';
import { DeliveryGenerateTask } from './delivery-generate.task';
import { AutoConfirmTask } from './auto-confirm.task';
import { CommissionSettleTask } from './commission-settle.task';
import { SupplierShareTask } from './supplier-share.task';
import { ReconciliationTask } from './reconciliation.task';
import { LeaderExpireTask } from './leader-expire.task';

/**
 * 定时任务模块（时间点与目标日期以 `schedule.service.ts` 的 `TASK_SCHEDULES` 为准）
 *
 * ## 两条纪律
 * 1. **任务不重抄业务口径**，一律委托对应模块的服务 —— 跑批与「运维手动补跑」
 *    共用同一执行口，避免「跑批一种算法、点按钮另一种」。
 * 2. **目标日期不在任务里算** —— 一律走 `ScheduleService.requireDateForTask()`，
 *    它从 `TASK_SCHEDULES` 推导。这是对 M4 头号陷阱「同刻不同日」的防御
 *    （`meal-publish` 与 `auto-confirm` 同刻触发，却分属明日 / 今日）。
 *
 * ## 委托关系（M4-2 后 8 个任务全部实装）
 * | 任务 | 委托目标 |
 * | --- | --- |
 * | `meal-publish` | `MealModule.MealAdminService.publishByDate()` |
 * | `cutoff` | `OrderModule.OrderService.cutoffByDate()` + `SupplierModule.SupplierService.freezeProducePlan()` |
 * | `delivery-generate` | `DeliveryModule.DeliveryService.generateByDate()` |
 * | `auto-confirm` | `OrderModule.OrderService.autoConfirmByDate()`（内含批量确认 + 计佣 + 晋级审计） |
 * | `commission-settle` | `FinanceModule.CommissionService.settlePending()` |
 * | `supplier-share` | `FinanceModule.SupplierShareService.runDaily()` |
 * | `reconciliation` | `FinanceModule.ReconciliationService.reconcile()`（不入账，只读 + 不平告警） |
 * | `leader-expire` | `TeamLeaderModule.LeaderPromotionService.expireTrainees()` |
 *
 * ⚠️ 依赖方向全部**单向**（`TasksModule → 各业务模块`），业务模块不反向依赖本模块，
 *    因此不存在循环。
 *
 * ⚠️ `forFeature([OperationLog])` 只给 `reconciliation` 用：跑批发现对账不平时要落一条
 *    **持久告警**（用户 2026-09-17 裁定「落操作日志」，零 DDL）。放任务层而非
 *    `ReconciliationService` 里，是为了保住该服务「**纯读视图**」的契约
 *    （D43 两接口都不写库，见 finance.module.ts 头注）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([OperationLog]),
    TeamLeaderModule,
    FinanceModule,
    MealModule,
    OrderModule,
    SupplierModule,
    DeliveryModule,
  ],
  controllers: [ScheduleAdminController],
  providers: [
    ScheduleService,
    ScheduleAdminService,
    MealPublishTask,
    CutoffTask,
    DeliveryGenerateTask,
    AutoConfirmTask,
    CommissionSettleTask,
    SupplierShareTask,
    ReconciliationTask,
    LeaderExpireTask,
  ],
})
export class TasksModule {}

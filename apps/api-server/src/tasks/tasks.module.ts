import { Module } from '@nestjs/common';
import { ScheduleService } from './schedule.service';
import { MealPublishTask } from './meal-publish.task';
import { CutoffTask } from './cutoff.task';
import { DeliveryGenerateTask } from './delivery-generate.task';
import { AutoConfirmTask } from './auto-confirm.task';
import { CommissionSettleTask } from './commission-settle.task';
import { SupplierShareTask } from './supplier-share.task';
import { ReconciliationTask } from './reconciliation.task';
import { LeaderExpireTask } from './leader-expire.task';

/** 定时任务模块（8 个任务，时间点以《订单状态机 v1.0》§3.1 为准） */
@Module({
  providers: [
    ScheduleService,
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

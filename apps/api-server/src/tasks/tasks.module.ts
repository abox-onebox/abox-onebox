import { Module } from '@nestjs/common';
import { FinanceModule } from '../modules/finance/finance.module';
import { TeamLeaderModule } from '../modules/team-leader/team-leader.module';
import { ScheduleService } from './schedule.service';
import { MealPublishTask } from './meal-publish.task';
import { CutoffTask } from './cutoff.task';
import { DeliveryGenerateTask } from './delivery-generate.task';
import { AutoConfirmTask } from './auto-confirm.task';
import { CommissionSettleTask } from './commission-settle.task';
import { SupplierShareTask } from './supplier-share.task';
import { ReconciliationTask } from './reconciliation.task';
import { LeaderExpireTask } from './leader-expire.task';

/**
 * 定时任务模块（时间点以《订单状态机 v1.0》§3.1 为准）
 *
 * ⚠️ 任务**不重抄业务口径**，一律委托对应模块的服务：
 *    · `LeaderExpireTask`（C2 见习 30 天失效）→ `TeamLeaderModule.LeaderPromotionService`
 *    · `SupplierShareTask`（S9 T+1 应付出单，M3-9 实装）→ `FinanceModule.SupplierShareService`
 *    —— 手动补跑与跑批共用同一执行口，避免「跑批一种算法、点按钮另一种」。
 */
@Module({
  imports: [TeamLeaderModule, FinanceModule],
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

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { AppConfigModule } from './config/config.module';
import { CommonModule } from './common/common.module';
import { ProvidersModule } from './providers/providers.module';

import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { BuildingModule } from './modules/building/building.module';
import { SupplierModule } from './modules/supplier/supplier.module';
import { DistributionCenterModule } from './modules/distribution-center/distribution-center.module';
import { MealModule } from './modules/meal/meal.module';
import { TraceabilityModule } from './modules/traceability/traceability.module';
import { OrderModule } from './modules/order/order.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { TeamLeaderModule } from './modules/team-leader/team-leader.module';
import { PaymentModule } from './modules/payment/payment.module';
import { FinanceModule } from './modules/finance/finance.module';
import { MessageModule } from './modules/message/message.module';
import { StatsModule } from './modules/stats/stats.module';
import { AdminModule } from './modules/admin/admin.module';
import { TasksModule } from './tasks/tasks.module';
import { QueuesModule } from './queues/queues.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    // 基础设施（配置 / 公共能力 / 外部依赖抽象）
    AppConfigModule,
    ScheduleModule.forRoot(),
    CommonModule,
    ProvidersModule,
    DatabaseModule,

    // 业务模块（12 域 + 后台/统计）
    AuthModule,
    UserModule,
    BuildingModule,
    SupplierModule,
    DistributionCenterModule,
    MealModule,
    TraceabilityModule,
    OrderModule,
    DeliveryModule,
    TeamLeaderModule,
    PaymentModule,
    FinanceModule,
    MessageModule,
    StatsModule,
    AdminModule,

    // 定时任务（8 个）与队列消费者（3 个）
    TasksModule,
    QueuesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

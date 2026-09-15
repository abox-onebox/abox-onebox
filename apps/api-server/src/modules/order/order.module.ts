import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Building } from '../../database/entities/building.entity';
import { Balance, BalanceLog } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { MealAssignment, SetMealItem } from '../../database/entities/meal.entity';
import { DeliveryRecord, Order, PaymentLog, Refund } from '../../database/entities/order.entity';
import { Dish, Supplier } from '../../database/entities/supplier.entity';
import { OperationLog } from '../../database/entities/system.entity';
import { User } from '../../database/entities/user.entity';
import { FinanceModule } from '../finance/finance.module';
import { TeamLeaderModule } from '../team-leader/team-leader.module';
import { LeaderOrderController } from './leader-order.controller';
import { LeaderOrderService } from './leader-order.service';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';

/**
 * 订单模块 · 见《接口规范 v1.0》§3.3/§3.4、§4.2/§4.3 与《目录结构 v2.0》
 *
 * M1 已实现：U6 创建、U9 列表、U10 详情、U11 自助取消、支付成功入账（markPaid）
 * M2 已实现：L4 所辖订单列表（脱敏）· L5 导出（留痕）· L6 异常订单 ·
 *           L7 团长代退申请（经 `RefundService`）· L8 今日取餐 · L9 一键分发（计佣）
 * M3 待实现：后台订单管控（D8–D12）
 *
 * ⚠️ 依赖方向：`OrderModule → FinanceModule`（取 `RefundService` 承接 L7 与计佣）、
 *    `OrderModule → TeamLeaderModule`（取 `LeaderPromotionService`：一键分发计佣后
 *    触发 C2 晋级审计）。两者均为单向，无循环。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      PaymentLog,
      Refund,
      Balance,
      BalanceLog,
      User,
      Building,
      TeamLeader,
      MealAssignment,
      SetMealItem,
      Dish,
      Supplier,
      DeliveryRecord,
      OperationLog,
    ]),
    FinanceModule,
    TeamLeaderModule,
  ],
  controllers: [OrderController, LeaderOrderController],
  providers: [OrderService, LeaderOrderService],
  exports: [OrderService, LeaderOrderService],
})
export class OrderModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Building, BuildingGroup } from '../../database/entities/building.entity';
import { Balance, BalanceLog, Commission } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { MealAssignment, SetMeal, SetMealItem } from '../../database/entities/meal.entity';
import { DeliveryRecord, Order, PaymentLog, Refund } from '../../database/entities/order.entity';
import { Dish, Supplier } from '../../database/entities/supplier.entity';
import { OperationLog } from '../../database/entities/system.entity';
import { User } from '../../database/entities/user.entity';
import { FinanceModule } from '../finance/finance.module';
import { RatingModule } from '../rating/rating.module';
import { TeamLeaderModule } from '../team-leader/team-leader.module';
import { LeaderOrderController } from './leader-order.controller';
import { LeaderOrderService } from './leader-order.service';
import { OrderAdminController } from './order-admin.controller';
import { OrderAdminService } from './order-admin.service';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';

/**
 * 订单模块 · 见《接口规范 v1.0》§3.3/§3.4、§4.2/§4.3、§6.2 与《目录结构 v2.0》
 *
 * M1 已实现：U6 创建、U9 列表、U10 详情、U11 自助取消、支付成功入账（markPaid）
 * M2 已实现：L4 所辖订单列表（脱敏）· L5 导出（留痕）· L6 异常订单 ·
 *           L7 团长代退申请（经 `RefundService`）· L8 今日取餐 · L9 一键分发（计佣）
 * M3-3 已实现：D8 全平台订单流 · D9 详情+操作日志 · D10 手动改单 ·
 *           D11 强制退款（经 `RefundService` → `ReversalService`）· D12 导出（留痕）
 *
 * ⚠️ 依赖方向：`OrderModule → FinanceModule`（取 `RefundService` 承接 L7/D11、
 *    取 `ReversalService` 走反向结算）、`OrderModule → TeamLeaderModule`
 *    （取 `LeaderPromotionService`：一键分发计佣后触发 C2 晋级审计）。均单向，无循环。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      PaymentLog,
      Refund,
      Balance,
      BalanceLog,
      Commission,
      User,
      Building,
      BuildingGroup,
      TeamLeader,
      SetMeal,
      MealAssignment,
      SetMealItem,
      Dish,
      Supplier,
      DeliveryRecord,
      OperationLog,
    ]),
    FinanceModule,
    TeamLeaderModule,
    // P1-U2：detail() 借 RatingService 组装 U10 详情的 rating 块（canRate/rated/回显）
    RatingModule,
  ],
  controllers: [OrderController, LeaderOrderController, OrderAdminController],
  providers: [OrderService, LeaderOrderService, OrderAdminService],
  exports: [OrderService, LeaderOrderService, OrderAdminService],
})
export class OrderModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Building } from '../../database/entities/building.entity';
import { Balance, BalanceLog } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { MealAssignment, SetMealItem } from '../../database/entities/meal.entity';
import { Order, PaymentLog, Refund } from '../../database/entities/order.entity';
import { Dish, Supplier } from '../../database/entities/supplier.entity';
import { User } from '../../database/entities/user.entity';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';

/**
 * 订单模块 · 见《接口规范 v1.0》§3.3/§3.4 与《目录结构 v2.0》
 *
 * M1 已实现：U6 创建、U9 列表、U10 详情、U11 自助取消、支付成功入账（markPaid）
 * M2/M3 待实现：取餐确认与一键分发（按实发份数计佣）、后台订单管控（D8–D12）
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
    ]),
  ],
  controllers: [OrderController],
  providers: [OrderService],
  exports: [OrderService],
})
export class OrderModule {}

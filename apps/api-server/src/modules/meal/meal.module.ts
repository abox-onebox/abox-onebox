import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Building } from '../../database/entities/building.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { MealAssignment, SetMeal, SetMealItem } from '../../database/entities/meal.entity';
import { Order } from '../../database/entities/order.entity';
import { Dish, Supplier } from '../../database/entities/supplier.entity';
import { User } from '../../database/entities/user.entity';
import { HomeController, InviteController } from './meal.controller';
import { MealService } from './meal.service';

/**
 * 套餐编排模块 · 见《接口规范 v1.0》§3.1 与《目录结构 v2.0》
 *
 * M1 已实现：U1 明日套餐、U2 历史归档、U3 邀请落地
 * M3 待实现：后台套餐矩阵 D1–D7（日期 × 楼群）
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      MealAssignment,
      SetMeal,
      SetMealItem,
      Dish,
      Supplier,
      Building,
      TeamLeader,
      Order,
      User,
    ]),
  ],
  controllers: [HomeController, InviteController],
  providers: [MealService],
  exports: [MealService],
})
export class MealModule {}

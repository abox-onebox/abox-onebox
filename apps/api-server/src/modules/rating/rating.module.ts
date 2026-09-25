import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DishRating, Order } from '../../database/entities/order.entity';
import { SetMealItem } from '../../database/entities/meal.entity';
import { Dish, Supplier } from '../../database/entities/supplier.entity';
import { RatingAdminController } from './rating-admin.controller';
import { RatingController } from './rating.controller';
import { RatingService } from './rating.service';

/**
 * 口味评价模块（P1-U2 · 2026-09-25）
 *
 * - U20 提交（`POST /orders/:orderNo/rating` · 用户侧 · 逐菜三键 · 一次定稿）
 * - D69 红黑榜（`GET /admin/stats/dish-rating` · 后台 · 菜品热度页第二 Tab）
 * - 载体：新表 `ab_dish_rating`（第 28 张 · 只增 · 迁移 1700000000003）
 *
 * ⚠️ 依赖方向：`OrderModule → RatingModule`（OrderService.detail() 借 RatingService
 *    组装 U10 详情的 `rating` 块）。本模块**不反向依赖** OrderModule —— 落库前
 *    直接用 Order/SetMealItem 仓库做归属与菜品校验，不借 OrderService（其私有
 *    `loadOwnOrder` 的「不区分不存在与非本人」语义在这里**逐字复刻**并注明出处）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([DishRating, Order, SetMealItem, Dish, Supplier])],
  controllers: [RatingController, RatingAdminController],
  providers: [RatingService],
  exports: [RatingService],
})
export class RatingModule {}

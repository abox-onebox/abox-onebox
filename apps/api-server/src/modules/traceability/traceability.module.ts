import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Building } from '../../database/entities/building.entity';
import { DistributionCenter } from '../../database/entities/finance.entity';
import { MealAssignment, SetMeal, SetMealItem } from '../../database/entities/meal.entity';
import { Dish, Supplier } from '../../database/entities/supplier.entity';
import { TraceabilityController } from './traceability.controller';
import { TraceabilityService } from './traceability.service';

/**
 * 今日这盒 · 出品方溯源（U5 · C8 · M5-14）模块
 *
 * 见《接口规范 v1.0》§3.2 与《项目目录结构 v2.0》。
 *
 * ⚠️ 与 `MealModule` **刻意不合并**：两者共用 `ab_set_meal_item` 等实体，看似可以并进
 *    套餐模块，但那样会让「下单页契约」与「溯源页契约」住在同一个 service 里 ——
 *    而两者的红线并不相同（U1 只禁价格字段，U5 还要禁供应商状态与联系方式）。
 *    合成一个模块后，谁都能顺手把 U5 的字段接到 U1 上，且**没有任何门禁会拦**。
 *    代价是本模块重复声明 7 个仓储（DI 层面零成本），换来的是两条契约各有各的边界。
 *
 * 注：`readTakeoutLinks()` 来自 `common/utils`，非 provider —— 它是**纯函数**，
 * 由 `SupplierModule` 与 `TraceabilityModule` 共同引用，天然只有一份实现。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      MealAssignment,
      SetMeal,
      SetMealItem,
      Dish,
      Supplier,
      DistributionCenter,
      Building,
    ]),
  ],
  controllers: [TraceabilityController],
  providers: [TraceabilityService],
  exports: [TraceabilityService],
})
export class TraceabilityModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Building, BuildingGroup } from '../../database/entities/building.entity';
import { Commission, SupplierShare } from '../../database/entities/finance.entity';
import { SetMealItem } from '../../database/entities/meal.entity';
import { Order } from '../../database/entities/order.entity';
import { Dish, Supplier } from '../../database/entities/supplier.entity';

import { StatsAdminController } from './stats-admin.controller';
import { StatsService } from './stats.service';

/**
 * 数据统计模块（D47–D50 · 原型 P35 · 模块 M36）
 *
 * 落点纪律（见 `modules/admin/admin.module.ts` 顶部长注释）：
 *   后台端点**就近放在业务域模块内**、路径以 `admin/` 开头，
 *   不集中到 `AdminModule`。故 D47–D50 归本模块，控制器名为
 *   `stats-admin.controller.ts`（`AdminModule` 中预留的落点注释即此名）。
 *
 * ⚠️ `AdminGuard` / `OperationLogInterceptor` / `ResponseInterceptor` **都不在此装配**：
 *   由 `CommonModule`（`@Global`）以 `APP_GUARD` / `APP_INTERCEPTOR` 全局注册。
 *   此处只声明实体、控制器与服务，重复注册反而会让拦截器跑两遍。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      // 订单事实表（GMV / 单量 / 份数 / 活跃维度 / 趋势的唯一数据源）
      Order,
      // 成本侧：佣金净额
      Commission,
      // 成本侧：采购应付净额（**只取 payee_type='supplier'**）
      SupplierShare,
      // 榜单名称（楼群/楼栋可能已软删 → 找不到名时回退 `#id`）
      Building,
      BuildingGroup,
      // 菜品热度：套餐 → 菜品 展开
      SetMealItem,
      Dish,
      Supplier,
    ]),
  ],
  controllers: [StatsAdminController],
  providers: [StatsService],
  exports: [StatsService],
})
export class StatsModule {}

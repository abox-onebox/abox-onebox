import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Building, BuildingGroup } from '../../database/entities/building.entity';
import { DistributionCenter, SupplierShare } from '../../database/entities/finance.entity';
import { MealAssignment, SetMealItem } from '../../database/entities/meal.entity';
import { AdminUser, OperationLog } from '../../database/entities/system.entity';
import {
  Dish,
  Supplier,
  SupplierDishCenterDaily,
  SupplierDishDaily,
} from '../../database/entities/supplier.entity';
import { FinanceModule } from '../finance/finance.module';
import { SupplierAdminController } from './supplier-admin.controller';
import { SupplierAdminService } from './supplier-admin.service';
import { DishAdminController } from './dish/dish-admin.controller';
import { DishAdminService } from './dish/dish-admin.service';
import { SupplierController } from './supplier.controller';
import { SupplierService } from './supplier.service';

/**
 * 供应商 + 菜品 模块 · 见《接口规范 v1.0》§6.4 与《目录结构 v2.0》
 *
 * ## 三个控制器，三套主体，别搞混
 *   · `SupplierController`（`@Controller('supplier')`）—— **供应商端** S 系列，
 *     供应商 Web 看自己的出餐计划 / 确认出餐 / 打包任务（role=supplier，**M3-8 实装 S1–S3**）
 *   · `SupplierAdminController`（`@Controller('admin/suppliers')`）—— **运营后台** D23–D28
 *   · `DishAdminController`（`@Controller('admin/dishes')`）—— **运营后台** 菜品库扩展
 *
 * ## 为什么实体直接 forFeature 而不依赖别的模块
 * 与 M3-5 `TeamLeaderModule` 同一处理：`DistributionCenter` / `SupplierShare` 属财务域，
 * 但 D23 要统计「名下几个集散中心」「本月应付多少」——若为此依赖 `FinanceModule`，
 * 会多出一条跨模块服务依赖链；实体级依赖不构成模块循环，代价可控。
 */
@Module({
  imports: [
    // M3-9：供应商端结算自查（S9）复用财务侧的 `SupplierShareService`。
    // 单向依赖，无循环（`FinanceModule` 不反向依赖本模块）—— 好处是应付行的
    // 结构与状态文案**只有一份实现**，不会出现「运营看到的」与「供应商看到的」不一致。
    FinanceModule,
    TypeOrmModule.forFeature([
      Supplier,
      Dish,
      SupplierDishDaily,
      SupplierDishCenterDaily,
      DistributionCenter,
      SupplierShare,
      BuildingGroup,
      Building,
      MealAssignment,
      SetMealItem,
      AdminUser,
      OperationLog,
    ]),
  ],
  controllers: [SupplierController, SupplierAdminController, DishAdminController],
  providers: [SupplierService, SupplierAdminService, DishAdminService],
  exports: [SupplierService, SupplierAdminService, DishAdminService],
})
export class SupplierModule {}

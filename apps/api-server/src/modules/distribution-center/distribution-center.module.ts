import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BuildingGroup } from '../../database/entities/building.entity';
import { DistributionCenter, SupplierShare } from '../../database/entities/finance.entity';
import { MealAssignment } from '../../database/entities/meal.entity';
import { DistributionCenterAdminController } from './distribution-center-admin.controller';
import { DistributionCenterAdminService } from './distribution-center-admin.service';
import { DistributionCenterController } from './distribution-center.controller';
import { DistributionCenterService } from './distribution-center.service';

/**
 * 集散中心（= **ABox 自有加工 / 出餐场所**）配置
 * （C4 · 表驱动，默认 4 个可增删）· 见《接口规范 v1.0》§6.4 D29–D32
 *
 * ## 两个控制器，两套主体
 *   · `DistributionCenterController`（`@Controller('distribution-center')`）——
 *     供应商端视图（空占位，S 系列）
 *   · `DistributionCenterAdminController`（`@Controller('admin/distribution-centers')`）——
 *     **运营后台** D29–D32
 *
 * ## ⚠️ M4-0：加工场所打包任务**不在本模块**
 *   原供应商端 S3 `GET /supplier/packing-tasks` 已随自营口径迁到运营后台
 *   `GET /admin/packing-tasks`（`SupplierModule` 的 `PackingAdminController`）。
 *   留在这里的是「场所配置」，那边的派生还需要供应商 / 菜品 / 生产计划域的数据 ——
 *   实现只有 `SupplierService.packingTasks()` 一份，此处不重复实现、也不反向依赖它。
 *
 * ## 为什么注入 `MealAssignment` 这个「别的域」的实体
 * D32 的两道删除前置之一是「仍被套餐分配引用」（`ab_meal_assignment.distribution_center_id`）。
 * 若为此依赖 `MealModule` 的**服务**，会形成 `Meal → Supplier`、
 * `DistributionCenter → Meal` 的隐性耦合；而只是数一行 count，用实体足够。
 * ⚠️ 注意这里是**引用计数**而非业务编排：真正的分配逻辑仍归 MealModule，别在此扩展。
 *
 * ## ⚠️ M4-0 起不再注入 `Supplier`
 * 自营口径下场所**不归属供应商**（`supplier_id` 已停用），D29 的「按供应商筛选 /
 * 关键词命中供应商名」随之删除 —— 于是这个模块与供应商表的实体依赖也一并消失。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([DistributionCenter, BuildingGroup, SupplierShare, MealAssignment]),
  ],
  controllers: [DistributionCenterController, DistributionCenterAdminController],
  providers: [DistributionCenterService, DistributionCenterAdminService],
  exports: [DistributionCenterService, DistributionCenterAdminService],
})
export class DistributionCenterModule {}

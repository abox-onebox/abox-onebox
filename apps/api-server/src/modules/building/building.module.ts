import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Building, BuildingGroup } from '../../database/entities/building.entity';
import { DistributionCenter } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { MealAssignment, SetMeal } from '../../database/entities/meal.entity';
import { BuildingAdminController, BuildingGroupAdminController } from './building-admin.controller';
import { BuildingAdminService } from './building-admin.service';
import { BuildingController } from './building.controller';
import { BuildingService } from './building.service';

/**
 * 办公楼 / 楼群 模块 · 见《接口规范 v1.0》§6.3 与《目录结构 v2.0》
 *
 * ## 三类控制器，别搞混
 *   · `BuildingController`（`@Controller('building')`）—— **用户端**只读，
 *     用户端「切换办公楼」等场景（U 系列，M1 已落 C 端基座，本批次不动）
 *   · `BuildingAdminController`（`@Controller('admin/buildings')`）—— **运营后台** D13–D15
 *   · `BuildingGroupAdminController`（`@Controller('admin/building-groups')`）—— **运营后台** D16–D18
 *
 * ## 为什么实体直接 forFeature 而不依赖别的模块
 * 与 M3-5 `TeamLeaderModule` / M3-6 `SupplierModule` 同一处理：
 * `DistributionCenter` / `TeamLeader` / `MealAssignment` / `SetMeal` 分属财务、
 * 团长、套餐域，但 D13–D18 要算「这栋楼有没有团长」「这栋楼送不送得出去」
 * 「这栋楼群今天吃什么」——若为此依赖 `FinanceModule` / `TeamLeaderModule` / `MealModule`，
 * 会多出三条跨模块服务依赖链（且 `MealModule` 又依赖 `BuildingModule` 的实体，
 * 服务级依赖会成环）。实体级依赖不构成模块循环，代价可控。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Building,
      BuildingGroup,
      TeamLeader,
      DistributionCenter,
      MealAssignment,
      SetMeal,
    ]),
  ],
  controllers: [BuildingController, BuildingAdminController, BuildingGroupAdminController],
  providers: [BuildingService, BuildingAdminService],
  exports: [BuildingService, BuildingAdminService],
})
export class BuildingModule {}

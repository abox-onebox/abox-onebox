import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BuildingGroup } from '../../database/entities/building.entity';
import { DistributionCenter, SupplierShare } from '../../database/entities/finance.entity';
import { MealAssignment } from '../../database/entities/meal.entity';
import { Supplier } from '../../database/entities/supplier.entity';
import { DistributionCenterAdminController } from './distribution-center-admin.controller';
import { DistributionCenterAdminService } from './distribution-center-admin.service';
import { DistributionCenterController } from './distribution-center.controller';
import { DistributionCenterService } from './distribution-center.service';

/**
 * 集散中心配置（C4 · 表驱动，默认 4 个可增删）· 见《接口规范 v1.0》§6.4 D29–D32
 *
 * ## 两个控制器，两套主体
 *   · `DistributionCenterController`（`@Controller('distribution-center')`）——
 *     **供应商端**视图（集散中心自己的打包/配送任务，S 系列，M3-11 实装）
 *   · `DistributionCenterAdminController`（`@Controller('admin/distribution-centers')`）——
 *     **运营后台** D29–D32
 *
 * ## 为什么注入 `MealAssignment` 这个「别的域」的实体
 * D32 的两道删除前置之一是「仍被套餐分配引用」（`ab_meal_assignment.distribution_center_id`）。
 * 若为此依赖 `MealModule` 的**服务**，会形成 `Meal → Supplier`、
 * `DistributionCenter → Meal` 的隐性耦合；而只是数一行 count，用实体足够。
 * ⚠️ 注意这里是**引用计数**而非业务编排：真正的分配逻辑仍归 MealModule，别在此扩展。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DistributionCenter,
      Supplier,
      BuildingGroup,
      SupplierShare,
      MealAssignment,
    ]),
  ],
  controllers: [DistributionCenterController, DistributionCenterAdminController],
  providers: [DistributionCenterService, DistributionCenterAdminService],
  exports: [DistributionCenterService, DistributionCenterAdminService],
})
export class DistributionCenterModule {}

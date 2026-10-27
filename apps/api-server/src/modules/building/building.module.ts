import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Building, BuildingGroup } from '../../database/entities/building.entity';
import { DistributionCenter } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { MealAssignment, SetMeal } from '../../database/entities/meal.entity';
import { Order } from '../../database/entities/order.entity';
import { MessageModule } from '../message/message.module';
import { BuildingAdminController, BuildingGroupAdminController } from './building-admin.controller';
import { BuildingAdminService } from './building-admin.service';
import { BuildingSuspendService } from './building-suspend.service';
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
      /**
       * N2（P3-5）：停用闸门要数「这栋楼 / 这个楼群还有多少未完结订单」。
       * ⚠️ 同本模块既有做法 —— **只登记实体，不 import `OrderModule`**：实体级 forFeature
       *    不构成模块循环，而服务级 import 会（`OrderModule` 反过来依赖本域的楼/楼群）。
       */
      Order,
    ]),
    /**
     * N2（P3-5）：强制停用放行后要通知存量订单用户（spec §6.5）。
     *
     * ⚠️ 这里**必须**走模块依赖而不是再注入 `Order` 自己拼投递 —— 投递规则（启用闸门 /
     *    渠道 / `userId → openid` / 落 `ab_message`）**只在 `MessageService` 一处**，
     *    自己拼就是第二份投递判据。
     * ⚠️ `MessageModule` 只依赖实体（不依赖 `BuildingModule`），**不会成环**。
     */
    MessageModule,
  ],
  controllers: [BuildingController, BuildingAdminController, BuildingGroupAdminController],
  /**
   * ⚠️ `BuildingSuspendService` **必须**登记为 provider —— 它是 `BuildingAdminService`
   *    的构造依赖（N2 停用闸门 + 强制停用后的存量通知）。不登记 ⇒ 启动时
   *    `Nest can't resolve dependencies`，且是**启动期**才炸、编译期看不出来。
   *    ⚠️ 不必 export：停用能力只对楼栋/楼群编辑路径服务，没有第二个消费方
   *    （多 export 一个就是多开一条入口）。
   */
  providers: [BuildingService, BuildingAdminService, BuildingSuspendService],
  exports: [BuildingService, BuildingAdminService],
})
export class BuildingModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Building, BuildingGroup } from '../../database/entities/building.entity';
import { DistributionCenter } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { MealAssignment, SetMeal, SetMealItem } from '../../database/entities/meal.entity';
import { Order } from '../../database/entities/order.entity';
import { Item, Supplier } from '../../database/entities/supplier.entity';
import { User } from '../../database/entities/user.entity';
import { AiInsight } from '../../database/entities';
import { WecomKbModule } from '../wecom-kb/wecom-kb.module';
import { MessageModule } from '../message/message.module';
import { HomeController, InviteController } from './meal.controller';
import { MealAdminController } from './meal-admin.controller';
import { MealAdminService } from './meal-admin.service';
import { MealService } from './meal.service';

/**
 * 套餐编排模块 · 见《接口规范 v1.0》§3.1 与 §6.1
 *
 * - 用户端（M1 已实现）：U1 明日套餐、U2 历史归档、U3 邀请落地
 * - 后台端（M3-2 已实现）：D1 矩阵 / D2 创建 / D3 编辑 / D4 上下架 / D5 批量复制
 *   / D6 模板库 / D7 存为模板
 *
 * ⚠️ 后台控制器放在**本模块内**（而非集中到 admin 模块）：它只需注入同模块的
 *    service，零跨模块 DI；集中到 admin 模块会形成「admin 反向依赖全部业务模块」。
 *    详见 `modules/admin/admin.module.ts` 头部的职责边界说明。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      MealAssignment,
      SetMeal,
      SetMealItem,
      Item,
      Supplier,
      Building,
      BuildingGroup,
      DistributionCenter,
      TeamLeader,
      Order,
      User,
      AiInsight,
    ]),
    WecomKbModule,
    /**
     * 开团通知（场景 `group_open`）需要 `MessageService`（已 export）。
     *
     * ⚠️ 单向依赖：`MessageModule` 只 import `TypeOrmModule`，不会反向依赖本模块 ——
     *    若将来有人在 `MessageModule` 里 import `MealModule`，这里就会形成循环依赖
     *    （Nest 启动时表现为 `MessageService` 注入为 undefined，而不是报循环）。
     */
    MessageModule,
  ],
  controllers: [HomeController, InviteController, MealAdminController],
  providers: [MealService, MealAdminService],
  exports: [MealService, MealAdminService],
})
export class MealModule {}

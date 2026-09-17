import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BuildingGroup } from '../../database/entities/building.entity';
import { MealAssignment } from '../../database/entities/meal.entity';
import { DeliveryRecord, Order } from '../../database/entities/order.entity';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';

/**
 * 配送单 模块 · 见《接口规范 v1.0》与《目录结构 v2.0》
 *
 * M4-1 实装：`DeliveryService.generateByDate()` —— T 日 00:30 按楼群生成配送单
 * （跑批由 `tasks/delivery-generate.task.ts` 委托）。
 *
 * M5-1 实装：D61 `GET /admin/deliveries`（列表 + 份数差异）+ D62 `PUT /admin/deliveries/{id}`
 * （人工修正份数 / 司机 / 车牌，`version` 乐观锁 + 写操作日志）——
 * 收口挂账 **#61**「跑批幂等不覆盖保护了人工录入，也把份数永久固化」的口子。
 */
@Module({
  imports: [TypeOrmModule.forFeature([DeliveryRecord, Order, BuildingGroup, MealAssignment])],
  controllers: [DeliveryController],
  providers: [DeliveryService],
  exports: [DeliveryService],
})
export class DeliveryModule {}

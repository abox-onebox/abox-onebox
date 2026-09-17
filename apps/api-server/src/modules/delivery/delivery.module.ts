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
 * ⚠️ 本模块**只导出服务**，供 `TasksModule` 调用；`DeliveryController` 仍为空壳 ——
 *    配送单的后台查看入口在 D 系列里尚未定义（运营目前通过 P34 订单详情间接看），
 *    属后续批次。此处不预建半成品端点。
 */
@Module({
  imports: [TypeOrmModule.forFeature([DeliveryRecord, Order, BuildingGroup, MealAssignment])],
  controllers: [DeliveryController],
  providers: [DeliveryService],
  exports: [DeliveryService],
})
export class DeliveryModule {}

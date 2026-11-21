import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ExportTask } from '../../database/entities/export-task.entity';
import { AdminModule } from '../admin/admin.module';
import { OrderModule } from '../order/order.module';
import { ExportTaskController } from './export-task.controller';
import { ExportTaskService } from './export-task.service';

/**
 * 后台导出作业模块（2026-11-21）
 *
 * ## 依赖方向
 * 本模块**向下**依赖订单域与系统管理域的既有 service（复用筛选与取数口径），
 * 它们都不知道导出作业的存在 —— 不会出现「订单模块反过来认识下载中心」的环。
 * 队列实例与 StorageProvider 由全局 `CommonModule` / `ProvidersModule` 提供，此处不重复装配。
 *
 * ## 消费者为什么在本模块内注册
 * `ExportTaskService.onModuleInit()` 直接 `queue.register('export-task', ...)`。
 * 若塞进 `QueuesModule`，那个模块就要 import 本模块 + 订单 + 系统管理，
 * 装配面反而更大，而且「导出作业」的生命周期被拆到两个文件里。
 */
@Module({
  imports: [TypeOrmModule.forFeature([ExportTask]), OrderModule, AdminModule],
  controllers: [ExportTaskController],
  providers: [ExportTaskService],
  exports: [ExportTaskService],
})
export class ExportModule {}

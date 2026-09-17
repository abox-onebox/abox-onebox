import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TeamLeader } from '../database/entities/leader.entity';
import { OperationLog } from '../database/entities/system.entity';
import { KvService } from './cache/kv.service';
import { QueueService } from './queue/queue.service';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { AdminGuard } from './guards/admin.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LeaderGuard } from './guards/leader.guard';
import { OperationLogInterceptor } from './interceptors/operation-log.interceptor';
import { ResponseInterceptor } from './interceptors/response.interceptor';
import { BizConfigService } from './services/biz-config.service';

/**
 * 全局公共能力：统一响应 / 全局异常 / 全局鉴权 / 业务参数 / KV / 操作日志 / 队列（M4-3）
 * 通过 APP_* 令牌注册，无需在每个模块重复声明。
 *
 * ⚠️ 拦截器执行顺序（注册序 = 外层 → 内层）：
 *    ResponseInterceptor（外层，负责统一包装）
 *    → OperationLogInterceptor（记**业务数据本身**，不是包装后的响应体）
 *    → IdempotentInterceptor（方法级，内层，缓存的也是业务数据本身）
 *
 * 后台能力：`AdminGuard` 在此注册并导出 —— `/admin/*`、`/supplier/*` 直接
 *    `@UseGuards(AdminGuard)` 即可，无需各模块重复 import 后台账号表。
 * 团长能力：`LeaderGuard` 同理。
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([TeamLeader, OperationLog])],
  providers: [
    KvService,
    QueueService,
    BizConfigService,
    LeaderGuard,
    AdminGuard,
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: OperationLogInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [KvService, QueueService, BizConfigService, LeaderGuard, AdminGuard],
})
export class CommonModule {}

import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TeamLeader } from '../database/entities/leader.entity';
import { KvService } from './cache/kv.service';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LeaderGuard } from './guards/leader.guard';
import { ResponseInterceptor } from './interceptors/response.interceptor';
import { BizConfigService } from './services/biz-config.service';

/**
 * 全局公共能力：统一响应 / 全局异常 / 全局鉴权 / 业务参数 / KV
 * 通过 APP_* 令牌注册，无需在每个模块重复声明。
 *
 * ⚠️ 拦截器执行顺序（注册序 = 外层 → 内层）：
 *    ResponseInterceptor（外层，负责统一包装）
 *    → IdempotentInterceptor（方法级，内层，缓存的是**业务数据本身**）
 *
 * 团长能力：`LeaderGuard` 在此注册并导出（@Global 后全局可用）——
 *    `/leader/*` 直接 `@UseGuards(LeaderGuard)`，无需各模块重复 import。
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([TeamLeader])],
  providers: [
    KvService,
    BizConfigService,
    LeaderGuard,
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [KvService, BizConfigService, LeaderGuard],
})
export class CommonModule {}

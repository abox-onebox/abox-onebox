import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Balance, BalanceLog, Commission } from '../database/entities/finance.entity';
import { TeamLeader } from '../database/entities/leader.entity';
import { OperationLog } from '../database/entities/system.entity';
import { Withdraw } from '../database/entities/withdraw.entity';
import { KvService } from './cache/kv.service';
import { QueueService } from './queue/queue.service';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { AdminGuard } from './guards/admin.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LeaderGuard } from './guards/leader.guard';
import { OperationLogInterceptor } from './interceptors/operation-log.interceptor';
import { ResponseInterceptor } from './interceptors/response.interceptor';
import { BizConfigService } from './services/biz-config.service';
import { LeaderLookupService } from './services/leader-lookup.service';
import { LeaderMoneyService } from './services/leader-money.service';

/**
 * 全局公共能力：统一响应 / 全局异常 / 全局鉴权 / 业务参数 / KV / 操作日志 / 队列（M4-3）
 * / 团长资金真源（M4-4）
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
 *
 * ⭐ **M5-11 `LeaderLookupService`**（邀请码 → 团长 的**唯一实现**）在此注册并 `exports` ——
 *    收口缺陷 #92 时盘出「邀请码 → 团长」原本有**三份各自独立的实现**（U3 落地页 /
 *    下单归属 / 登录绑定），前两份连正则都抄了同一份字面量。改一处必然分叉，
 *    故收敛为一份：调用方只保留「无效时怎么办」的策略差异（降级 / 抛 30007）。
 *
 * ⭐ **M4-4 `LeaderMoneyService`**（团长「余额 / 冻结 / 待入账佣金 / 累计已提现」
 *    的**唯一真源**读取口）在此注册并 `exports` —— 登录 / 资料 / 工作台 / 后台团长详情
 *    四处共用同一份口径。⚠️ 它能被全局注入，靠的是**本模块 `exports` 了这个服务**，
 *    不是靠 `@Global()` 传递仓储：`@Global()` 只让本模块 `exports` 的东西全局可见，
 *    故本服务自己的 `forFeature` 也已在此补齐（#66 的教训反向使用）。
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TeamLeader,
      OperationLog,
      Balance,
      /** M5-10：U14 用户余额明细（`LeaderMoneyService.logsOf`）也要读流水，故一并注册 */
      BalanceLog,
      Commission,
      Withdraw,
    ]),
  ],
  providers: [
    KvService,
    QueueService,
    BizConfigService,
    LeaderMoneyService,
    LeaderLookupService,
    LeaderGuard,
    AdminGuard,
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: OperationLogInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [
    KvService,
    QueueService,
    BizConfigService,
    LeaderMoneyService,
    LeaderLookupService,
    LeaderGuard,
    AdminGuard,
  ],
})
export class CommonModule {}

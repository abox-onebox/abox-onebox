import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Balance, BalanceLog, Commission } from '../database/entities/finance.entity';
import { TeamLeader } from '../database/entities/leader.entity';
import { MealAssignment } from '../database/entities/meal.entity';
import { OperationLog, OpBlocklist, SalesPause } from '../database/entities/system.entity';
import { User } from '../database/entities/user.entity';
import { Withdraw } from '../database/entities/withdraw.entity';
import { Building, BuildingGroup } from '../database/entities/building.entity';
import { KvService } from './cache/kv.service';
import { QueueService } from './queue/queue.service';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { AdminGuard } from './guards/admin.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LeaderGuard } from './guards/leader.guard';
import { OperationLogInterceptor } from './interceptors/operation-log.interceptor';
import { OpBlocklistInterceptor } from './interceptors/op-blocklist.interceptor';
import { OpBlocklistService } from './services/op-blocklist.service';
import { ResponseInterceptor } from './interceptors/response.interceptor';
import { BizConfigService } from './services/biz-config.service';
import { LeaderLookupService } from './services/leader-lookup.service';
import { OrderAvailabilityService } from './services/order-availability.service';
import { LeaderMoneyService } from './services/leader-money.service';
import { UserPayeeService } from './services/user-payee.service';

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
 *
 * ⭐ **F-10 `UserPayeeService`**（「这个人还能不能收钱」的**唯一判定**）同样全局导出：
 *    写钱路径分散在 order（计佣）/ finance（入账、退款退余额）两个模块，
 *    而verdict 必须在三处**逐字一致**（否则「其中一处开始拦了」就会变成新的拔河），
 *    故按 `LeaderLookupService` / `LeaderMoneyService` 同款做法入驻 `common/`。
 *
 * ⭐ **N1/W1 `OrderAvailabilityService`**（「这栋楼这个出餐日能不能下单」的
 *    **唯一装载口**）同样全局导出：判据本身在 `utils/orderability.ts` 的纯函数里，
 *    本服务只负责把「楼 / 楼群 / 分配 / 停售 / 截单窗口」取齐后交给它。
 *    ⚠️ 它**不是** `LeaderLookupService` 那类「判据收口」，而是「**装载**收口」——
 *    四个入口若各自查一遍这三张表，判据虽然只有一份，装载仍会分叉。
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
      /** F-10：写钱路径要判「收款人身份状态」，故本模块也需持有 `ab_user` 仓储 */
      User,
      /** P1-c：KB 助手禁止清单仓储（全局拦截器 + 审批流闸共用） */
      OpBlocklist,
      /**
       * N1/W1（P3-3）：可订性判定编排要读「楼 / 楼群 / 分配」三张表。
       * ⚠️ 按本仓既有做法**只登记实体、不 import 业务模块** —— 实体级 forFeature
       *    不构成模块循环（服务级 import 才会），`CommonModule` 是 `@Global()`，
       *    故 `meal` / `order` / `team-leader` / `building` 四模块无需任何改写即可注入。
       *
       * ⭐⭐ **W1 全局停售（P3-6）**：`OrderAvailabilityService` 还要读 `ab_sales_pause`
       *    （第 5 个构造参数 `@InjectRepository(SalesPause)`）。此处漏登记 ⇒ 编译与单测
       *    **都过得去**（tsc 只看类型，单测用 `getRepositoryToken` 手工 provider），
       *    唯独**真实启动**时 Nest 抛 `can't resolve dependencies ... SalesPauseRepository`
       *    ⇒ 2026-10-27 首次部署即 502。教训：`@InjectRepository(X)` 与 `forFeature`
       *    的配对**只能靠启动验证或静态对账**，不能靠 tsc。
       */
      Building,
      BuildingGroup,
      MealAssignment,
      /** W1：全局停售表（同上，漏了就启动即崩） */
      SalesPause,
    ]),
  ],
  providers: [
    KvService,
    QueueService,
    BizConfigService,
    OrderAvailabilityService,
    LeaderMoneyService,
    LeaderLookupService,
    UserPayeeService,
    OpBlocklistService,
    LeaderGuard,
    AdminGuard,
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: OperationLogInterceptor },
    { provide: APP_INTERCEPTOR, useClass: OpBlocklistInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [
    KvService,
    QueueService,
    BizConfigService,
    OrderAvailabilityService,
    LeaderMoneyService,
    LeaderLookupService,
    UserPayeeService,
    OpBlocklistService,
    LeaderGuard,
    AdminGuard,
  ],
})
export class CommonModule {}

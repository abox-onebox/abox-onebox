import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { AppConfigModule } from './config/config.module';
import { CommonModule } from './common/common.module';
import { KvService } from './common/cache/kv.service';
import { createRateLimitMiddleware } from './common/middleware/rate-limit.middleware';
import { ProvidersModule } from './providers/providers.module';

import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { BuildingModule } from './modules/building/building.module';
import { SupplierModule } from './modules/supplier/supplier.module';
import { DistributionCenterModule } from './modules/distribution-center/distribution-center.module';
import { MealModule } from './modules/meal/meal.module';
import { TraceabilityModule } from './modules/traceability/traceability.module';
import { OrderModule } from './modules/order/order.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { TeamLeaderModule } from './modules/team-leader/team-leader.module';
import { PaymentModule } from './modules/payment/payment.module';
import { FinanceModule } from './modules/finance/finance.module';
import { MessageModule } from './modules/message/message.module';
import { StatsModule } from './modules/stats/stats.module';
import { RatingModule } from './modules/rating/rating.module';
import { AdminModule } from './modules/admin/admin.module';
// M5-16：登录落点 `/dashboard` 的待办聚合（D66）—— 跨域只读聚合，故单起一模块
// （不是系统管理域、也不属于任何单一业务域；理由见 `dashboard.module.ts` 头注释）
import { DashboardModule } from './modules/admin/dashboard/dashboard.module';
import { TasksModule } from './tasks/tasks.module';
import { QueuesModule } from './queues/queues.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    // 基础设施（配置 / 数据库 / 公共能力 / 外部依赖抽象）
    // ⚠️ DatabaseModule 必须在 CommonModule 之前 —— BizConfigService 依赖 DataSource
    AppConfigModule,
    ScheduleModule.forRoot(),
    DatabaseModule,
    CommonModule,
    ProvidersModule,

    // 业务模块（12 域 + 后台/统计）
    AuthModule,
    UserModule,
    BuildingModule,
    SupplierModule,
    DistributionCenterModule,
    MealModule,
    TraceabilityModule,
    OrderModule,
    DeliveryModule,
    TeamLeaderModule,
    PaymentModule,
    FinanceModule,
    MessageModule,
    StatsModule,
    // 口味评价（P1-U2 · U20 提交 + D69 红黑榜 · 第 28 张表 ab_dish_rating）
    RatingModule,
    AdminModule,
    // 工作台聚合（D66 · M5-16）：放最后 —— 它是纯读、无副作用，
    // 且注册顺序不参与任何 DI 解析（模块间无相互依赖）。
    DashboardModule,

    // 定时任务（8 个）与队列消费者（3 个）
    TasksModule,
    QueuesModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  constructor(private readonly kv: KvService) {}

  /**
   * 限流中间件注册（**M5-6 实装** · 收口《全面检查与测试报告 v1.0》§二 P2-7）
   *
   * ## 为什么是 `configure()`，而不是在 `main.ts` 里 `app.use()`
   * 这里踩过一个**静默**的坑，写下来免得下次再踩：
   * `NestApplication.init()` 内部的顺序是 ——
   *   ① `registerParserMiddleware()`（挂 body-parser）
   *   ② `registerModules()`（**跑本方法** `configure()`）
   *   ③ `registerRouter()`（挂所有控制器路由）
   * 而 `app.use(x)` 是把 `x` **追加到 Express 栈尾**。于是：
   *   · 在 `await app.init()` **之前** `app.use` → 排在 body-parser **前** →
   *     `req.body` 恒为 `undefined` → 账号维度静默失效（IP 维度照常，外部看不出异常）；
   *   · 在 `await app.init()` **之后** `app.use` → 排在**路由之后** →
   *     请求已被控制器处理完毕，中间件**一次都不会执行**（比前一种更隐蔽：连日志都没有）。
   * `configure()` 在 ② 被调用，天然夹在 body-parser 与路由之间 —— 两个约束同时满足，
   * 这是 Nest 里唯一既「拿得到请求体」又「挡得住请求」的注册点。
   * ⚠️ 对应的验证方式不是看代码，而是跑 `tests/` 下的限流探针断言 429 —— 位置错了不会报错。
   *
   * ## 取 `KvService` 的方式
   * 构造器注入（`CommonModule` 是 `@Global()` 且 `exports` 了它，且 `AppModule` 本就
   * 直接 `imports` 它）。**不要**写成 `configure()` 里 `app.get(KvService)` ——
   * 那需要在 `configure` 里拿到 ApplicationRef，多绕一层且无收益。
   *
   * ## `forRoutes('*')` 的实际形状
   * 经 `RouteInfoPathExtractor` 展开为两段注册：`/api/v1$` + `/api/v1/*`
   * （全局前缀是 `setGlobalPrefix` 设的，中间件**会**带上它）。规则匹配与
   * 「跳过 health/docs/static」都在中间件内部做（见 `rate-limit.middleware.ts`
   * 的 `matchRule` / `SKIP_PATH`），故这里不做 `exclude()` —— 一处判断，不分散两处。
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createRateLimitMiddleware(this.kv)).forRoutes('*');
  }
}

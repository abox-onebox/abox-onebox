import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BuildingGroup } from '../../../database/entities/building.entity';
import { MealAssignment } from '../../../database/entities/meal.entity';
import { DeliveryRecord, Refund } from '../../../database/entities/order.entity';
import { Withdraw } from '../../../database/entities/withdraw.entity';

import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * 后台工作台模块（D66 · M5-16 · 登录落点 `/dashboard`）
 *
 * ## 为什么单起一个模块，而不是塞进 `AdminModule`
 *
 * `AdminModule` 的职责边界写得很死（顶部长注释）：**只管后台自有的系统管理域**
 * （账号 / 角色 / 操作日志 / 系统配置）。其余后台端点一律「就近放在业务域模块内」，
 * 为的是依赖天然收敛、不产生跨模块 DI。
 *
 * 而 D66 两者都不是：它是**跨域的只读聚合** —— 一次要读退款 / 提现 / 套餐分配 /
 * 配送四个域的实体。把它塞进 `AdminModule` 会让「系统管理域」这个边界失效；
 * 塞进任何一个业务域模块（比如 meal）又会让那个域反向认识其余三个域。
 *
 * 故按 `StatsModule`（D47–D50，同样是跨域只读聚合）的既有先例单起一模块：
 * **依赖面在一处写全**，日后有人问「为什么后台会碰配送单」，
 * 答案就在这 6 行 `forFeature` 里，不用翻遍全仓。
 *
 * ⚠️ 这里注入的是**仓库**而不是各业务域的 service —— 聚合只做 `COUNT`，
 *    读 service 会把「什么算待办」的口径复制第二份（本端点的立项理由就是消灭这个）。
 *
 * ⚠️ `AdminGuard` / `OperationLogInterceptor` / `ResponseInterceptor` 都**不在此装配**：
 *    由 `CommonModule`（`@Global`）以 `APP_GUARD` / `APP_INTERCEPTOR` 全局注册，
 *    重复注册会让拦截器跑两遍。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      // ① 退款待审
      Refund,
      // ② 提现待审
      Withdraw,
      // ③ 明日漏排楼群（分配事实 + 楼群台账）
      MealAssignment,
      BuildingGroup,
      // ④ 今日配送履约
      DeliveryRecord,
    ]),
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}

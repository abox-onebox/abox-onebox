import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TeamLeader } from '../../database/entities/leader.entity';
import { Order } from '../../database/entities/order.entity';
import { User } from '../../database/entities/user.entity';
import { UserController } from './user.controller';
import { UserService } from './user.service';

/**
 * 用户 / 个人中心模块 · 见《接口规范 v1.0》§3.5 与《目录结构 v2.0》
 *
 * M2 已实装：**U17 客服入口配置**（`GET /me/support`，一期走客服微信号人工处理）。
 * M5-10 补：**U13 余额**（`GET /me/balance`）· **U14 余额明细**（`GET /me/balance/logs`）。
 * M5-20 补：**U19 账号注销**（`POST /me/cancel` · 提审硬条件，见 `UserService.cancelAccount`）。
 *   ⚠️ 本批起本模块**有自有 provider**（`UserService`）与 `forFeature([User, TeamLeader, Order])`
 *   —— 注销要同时判「是否在职团长」与「有无在途订单」，这两张表不能借别人的仓储。
 * 仍待补：U15 订阅授权上报（一期明确未实装）。**U16 协议正文已由 M5-18 实装**（端上原生页
 *   `pages/agreement/agreement` + `constants/agreements.ts`，不经后端）。
 * ⚠️ **U12 不另设端点** —— 由 A2 `GET /auth/me` 承担（同一实现 `AuthService.profile`）。
 *
 * ⚠️ `BizConfigService` / `LeaderMoneyService` 均来自 `CommonModule`（`@Global()` 且 `exports`）。
 *    U13/U14 复用 `LeaderMoneyService` 而**不是**自己 `forFeature` 余额表
 *    —— 余额真源只有一处（M4-4 的 #69 教训）；U19 的「余额闸门」同样走它。
 * ⚠️ 历史遗留：此前 `UserController` 声明了 `@Controller('user')` 却**未在本模块注册**，
 *    等价于死代码；后改为契约中的 `/me` 前缀并正式挂载。
 */
@Module({
  imports: [TypeOrmModule.forFeature([User, TeamLeader, Order])],
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}

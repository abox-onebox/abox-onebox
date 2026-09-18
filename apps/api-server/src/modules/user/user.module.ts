import { Module } from '@nestjs/common';

import { UserController } from './user.controller';

/**
 * 用户 / 个人中心模块 · 见《接口规范 v1.0》§3.5 与《目录结构 v2.0》
 *
 * M2 已实装：**U17 客服入口配置**（`GET /me/support`，一期走客服微信号人工处理）。
 * M5-10 补：**U13 余额**（`GET /me/balance`）· **U14 余额明细**（`GET /me/balance/logs`）。
 * 仍待补：U15 订阅授权上报（一期明确未实装）· U16 协议正文。
 * ⚠️ **U12 不另设端点** —— 由 A2 `GET /auth/me` 承担（同一实现 `AuthService.profile`）。
 *
 * ⚠️ 本模块**无自有 provider**：`BizConfigService` / `LeaderMoneyService` 均来自
 *    `CommonModule`（`@Global()` 且 `exports`）。U13/U14 复用 `LeaderMoneyService`
 *    而**不是**自己 `forFeature` 余额表 —— 余额真源只有一处（M4-4 的 #69 教训）。
 * ⚠️ 历史遗留：此前 `UserController` 声明了 `@Controller('user')` 却**未在本模块注册**，
 *    等价于死代码；后改为契约中的 `/me` 前缀并正式挂载。
 */
@Module({
  controllers: [UserController],
})
export class UserModule {}

import { Module } from '@nestjs/common';

import { UserController } from './user.controller';

/**
 * 用户 / 个人中心模块 · 见《接口规范 v1.0》§3.5 与《目录结构 v2.0》
 *
 * M2 已实装：**U17 客服入口配置**（`GET /me/support`，一期走客服微信号人工处理）。
 * M4 待补：U12 用户信息 · U13 余额 · U14 余额明细 · U15 订阅授权上报 · U16 协议正文。
 *
 * ⚠️ 本模块**无自有 provider**：`BizConfigService` 来自 `CommonModule`（@Global）。
 * ⚠️ 历史遗留：此前 `UserController` 声明了 `@Controller('user')` 却**未在本模块注册**，
 *    等价于死代码；本次改为契约中的 `/me` 前缀并正式挂载。
 */
@Module({
  controllers: [UserController],
})
export class UserModule {}

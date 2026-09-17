import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { MessageSubscribeService } from './message-subscribe.service';

/**
 * 用户端订阅授权清单（M4-3 · 《接口规范》§3.5 个人中心）
 *
 * 路由：`GET /api/v1/me/subscribe/templates`
 *
 * ## 契约关系（**说清楚，免得被当成野生端点**）
 *
 * 《接口规范》§3.5 原有 **U15 `POST /me/subscribe`「上报订阅消息授权结果」**，
 * 与之配套的**读侧**（端上问「我该请求哪些模板」）在契约里没有 —— 因为写契约时
 * 微信订阅消息尚无任何投递点，「要授权什么」无从谈起。M4-3 把投递点接上后，
 * 这一半成为必需，故在此新增并**回写 §九 扩展登记**（本批次文档同步项）。
 *
 * | 端点 | 方向 | 状态 |
 * |------|------|------|
 * | `GET /me/subscribe/templates` | 服务端 → 端上：该请求哪些模板 | **M4-3 实装（本控制器）** |
 * | `POST /me/subscribe`（U15） | 端上 → 服务端：上报授权结果 | ⚠️ **未实装**（需新表 + 一期无法验证，见 `MessageSubscribeService` 头注） |
 *
 * ## 身份与权限
 *
 * 只读、只回**公开的微信模板 ID**（不含任何他人数据），故沿用全局 `JwtAuthGuard`
 * 的用户身份即可，**不需要**额外收窄 —— 它属于「用户自己的客户端应该问什么」，
 * 不是「看到别人的数据」。也未挂 `LeaderGuard`：退款结果通知对**所有下单用户**都要授权。
 */
@ApiTags('个人中心')
@ApiBearerAuth()
@Controller('me/subscribe')
export class MessageSubscribeController {
  constructor(private readonly subscribe: MessageSubscribeService) {}

  @Get('templates')
  @ApiOperation({
    summary: '可请求订阅授权的场景清单（端上据此调 requestSubscribeMessage）',
  })
  templates() {
    return this.subscribe.list();
  }
}

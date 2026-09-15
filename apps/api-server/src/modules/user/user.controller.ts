import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { BizConfigService } from '../../common/services/biz-config.service';

/**
 * 个人中心（`/me/*`）· 《接口规范》§3.5
 *
 * 本期（M2）只实装 **U17 客服入口配置** —— 其余（U12 用户信息 / U13 余额 /
 * U14 余额明细 / U15 订阅上报 / U16 协议正文）属 M4，届时在本控制器内继续补齐。
 *
 * 【2026-09-15 口径】一期**不做在线客服**：所有「联系运营 / 联系客服」入口
 *   （含退出团长、余额争议、提现异常）统一跳「客服微信号」页面，由用户手动添加
 *   客服微信、**人工解决**。故本接口只回微信号与提示文案，配置由运营在后台维护
 *   （`ab_config.service.*`）—— 端上**不内置任何硬编码联系方式**。
 *
 * ⚠️ 原本的 `@Controller('user')` 前缀在《接口规范》中无任何对应端点，
 *    故改为契约中的 `/me`（§3.5），避免长期留着一个不存在的路由空间。
 */
@ApiTags('个人中心')
@ApiBearerAuth()
@Controller('me')
export class UserController {
  constructor(private readonly bizConfig: BizConfigService) {}

  @Get('support')
  @ApiOperation({
    summary: 'U17 客服入口配置（一期：客服微信号 + 服务时间，人工处理）',
  })
  support() {
    return this.bizConfig.supportContact();
  }
}

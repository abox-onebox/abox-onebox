import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../../common/decorators/auth.decorator';
import { AiCsAskDto } from './dto/ai-cs.dto';
import { AiCsService } from './ai-cs.service';

/**
 * C 端智能客服（D · #44）· 消费者侧，免登录
 *
 * ## 为何 `@Public()`
 * 客服问答与资质公示是**信任证据**，本就面向未登录的访客（含微信审核与首次来客）。
 * 与 `traceability` 同源：免登录下服务端拿不到身份，故两端点都不依赖 `req.user`。
 *
 * ## 不涉及 LLM
 * 生产 `PROVIDER_MODE=mock`，本控制器只做「关键词命中 → 罐头答案 + 挂载 124 号令公示块」，
 * 答案与公示结构均由 `common/utils/ai-cs.ts` 纯函数产出，可单测、可门禁、可部署。
 *
 * ## 出参红线
 * 答案文案**不含任何第三方平台**名称 / 链接 / 跳转口令（微信小程序运营规范 5.10 互推 = 下架）。
 * 资质公示只展示本公司备案信息，不下发供应商联系方式 / 合作状态。
 */
@ApiTags('C 端智能客服')
@Controller('ai-cs')
export class AiCsController {
  constructor(private readonly svc: AiCsService) {}

  @Public()
  @Post('ask')
  @ApiOperation({
    summary: '消费者提问（免登录 · 规则命中问答）',
    description:
      '消费者自然语言提问 → 关键词命中意图 → 返回罐头答案；命中资质 / 标签类话题时，' +
      '`compliance` 字段附带 124 号令公示块（备案信息 + 预包装标签必含字段），否则为 null。\n\n' +
      '⚠️ 本端点不接 LLM，生产 `PROVIDER_MODE=mock`；答案为规则库命中，未命中走兜底引导。',
  })
  ask(@Body() dto: AiCsAskDto) {
    return this.svc.ask(dto.question);
  }

  @Public()
  @Get('compliance/124')
  @ApiOperation({
    summary: '124 号令资质与标签公示（免登录 · 公开只读）',
    description:
      '返回公司级备案信息（经营主体 / 备案编号 / 统一社会信用代码 / 经营范围 / 备案日期）' +
      '与预包装食品标签必含字段 schema。前端在主页显著位置（第二十条）与商品页复用此结构渲染。\n\n' +
      '备案编号等来自后台「系统配置 · 124 号令合规公示」一组键，运营可编辑；缺省走代码兜底值。',
  })
  compliance124() {
    return this.svc.getComplianceBlock();
  }
}

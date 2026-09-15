import { Body, Controller, Get, Headers, Param, Post, Req, UseInterceptors } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { HEADER } from '@abox/shared-types';

import { CurrentUser, JwtPayload, Public } from '../../common/decorators/auth.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { IdempotentInterceptor } from '../../common/interceptors/idempotent.interceptor';
import { MockPaidDto, PayOrderNoParamDto } from './dto/payment.dto';
import { PaymentService } from './payment.service';

/**
 * 支付接口（U7 / U8）
 *
 * ⚠️ 路径归属：按《接口规范》§3.3，U7/U8 挂在 `/orders/{orderNo}/pay*` 之下。
 *    为保持 URL 契约不变，本控制器仍以 `orders` 为前缀，只承载这两个纯支付动作；
 *    订单域的增删查改由 `modules/order` 的 OrderController 负责。
 */
@ApiTags('支付')
@Controller('orders')
export class OrdersPayController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post(':orderNo/pay')
  @UseInterceptors(IdempotentInterceptor)
  @Idempotent({ scope: 'pay' })
  @ApiHeader({
    name: HEADER.IDEMPOTENCY_KEY,
    required: true,
    description: '幂等键；KV 键名 `idem:pay:<key>`（§1.4）',
  })
  @ApiOperation({ summary: 'U7 创建微信支付单（JSAPI，幂等）' })
  createPrepay(@CurrentUser() user: JwtPayload, @Param() p: PayOrderNoParamDto) {
    return this.paymentService.createPrepay(user.sub, p.orderNo);
  }

  @Get(':orderNo/pay-result')
  @ApiOperation({ summary: 'U8 支付结果（前端轮询 / 回跳）' })
  payResult(@CurrentUser() user: JwtPayload, @Param() p: PayOrderNoParamDto) {
    return this.paymentService.payResult(user.sub, p.orderNo);
  }
}

/**
 * 微信支付回调与调试探针（§七 W1）
 * `/pay/notify` **免 JWT**，real 模式下由 `wx-signature.guard` 校验收款签名。
 */
@ApiTags('支付')
@Controller('pay')
export class PayNotifyController {
  constructor(private readonly paymentService: PaymentService) {}

  @Public()
  @Post('notify')
  @ApiOperation({ summary: 'W1 微信支付结果通知（免 JWT；一律回 SUCCESS）' })
  notify(@Headers() headers: Record<string, unknown>, @Req() req: RawBodyRequest<Request>) {
    // real 模式必须用**原始报文**验签，故 main.ts 已开启 rawBody
    const raw = req.rawBody?.toString('utf8') ?? JSON.stringify(req.body ?? {});
    return this.paymentService.handlePayNotify(headers, raw);
  }

  @Public()
  @Post('mock/paid')
  @ApiOperation({
    summary: '调试：手动触发支付成功（仅 PROVIDER_MODE=mock；金额省略则取订单实付）',
  })
  mockPaid(@Body() dto: MockPaidDto) {
    return this.paymentService.simulatePaid(dto.orderNo, dto.amountFen);
  }
}

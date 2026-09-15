import { Module } from '@nestjs/common';

import { OrderModule } from '../order/order.module';
import { PayNotifyController, OrdersPayController } from './payment.controller';
import { PaymentService } from './payment.service';
import { WxpayConfigService } from './wxpay-config';
import { WxpayService } from './wxpay.service';

/**
 * 微信支付集成模块 · 见《接口规范 v1.0》§3.3 与《目录结构 v2.0》
 *
 * 依赖方向：PaymentModule → OrderModule（单向，OrderModule **不**反向依赖支付）。
 * 因此「取消已支付订单的原路退款」放在 OrderService 内直连 `WX_PAY_PROVIDER`，
 * 避免 Payment ↔ Order 循环引用。
 *
 * ⚠️ 一期口径（C11）：本通道**只负责用户实付收款与退款**；
 *    供应商 / 集散中心走人工对公转账，团长佣金走灵活用工平台 —— 均不经本模块。
 */
@Module({
  imports: [OrderModule],
  controllers: [OrdersPayController, PayNotifyController],
  providers: [PaymentService, WxpayService, WxpayConfigService],
  exports: [PaymentService],
})
export class PaymentModule {}

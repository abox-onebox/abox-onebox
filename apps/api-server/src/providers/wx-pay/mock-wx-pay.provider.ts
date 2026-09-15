import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';

import {
  PayNotifyResult,
  PrepayInput,
  PrepayResult,
  RefundInput,
  RefundResult,
  WxPayProvider,
} from './wx-pay.provider';

/**
 * 微信支付 · 本地假实现
 *
 * 无需商户号 / 证书即可跑通「下单 → 支付 → 回调 → 订单转 paid」全链路：
 *   1. createPrepay 返回假 prepay_id 与假 payParams（小程序端会调起失败，属预期）；
 *   2. MOCK_PAY_AUTO_SUCCESS=true 时，延迟 N 毫秒后自动发出「支付成功」事件；
 *   3. 也可调 POST /api/v1/pay/mock/paid 手动触发，便于分步调试。
 */
@Injectable()
export class MockWxPayProvider extends WxPayProvider {
  private readonly logger = new Logger('WxPay:mock');
  private readonly emitter = new EventEmitter();
  private readonly autoSuccess: boolean;
  private readonly delayMs: number;

  constructor(private readonly config: ConfigService) {
    super();
    this.autoSuccess = this.config.get<boolean>('app.mock.payAutoSuccess') ?? true;
    this.delayMs = this.config.get<number>('app.mock.payCallbackDelayMs') ?? 800;
  }

  get isMock(): boolean {
    return true;
  }

  async createPrepay(input: PrepayInput): Promise<PrepayResult> {
    const prepayId = `mock_prepay_${input.orderNo}`;
    this.logger.log(
      `[mock] 统一下单 orderNo=${input.orderNo} 金额=${input.amountFen}分 openid=${input.openid} → ${prepayId}`,
    );

    if (this.autoSuccess) {
      setTimeout(() => {
        void this.simulatePaid(input.orderNo, input.amountFen).catch((e) =>
          this.logger.error(`[mock] 自动支付回调失败：${(e as Error).message}`),
        );
      }, this.delayMs);
    }

    return {
      prepayId,
      payParams: {
        timeStamp: String(Math.floor(Date.now() / 1000)),
        nonceStr: randomBytes(16).toString('hex'),
        package: `prepay_id=${prepayId}`,
        signType: 'RSA',
        paySign: 'mock_pay_sign',
      },
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const refundId = `mock_refund_${input.refundNo}`;
    this.logger.log(
      `[mock] 退款 orderNo=${input.orderNo} 退款额=${input.refundFen}分 原单额=${input.totalFen}分 → ${refundId}`,
    );
    return { refundId, status: 'SUCCESS', raw: { mock: true } };
  }

  async parseNotify(_headers: Record<string, unknown>, rawBody: string): Promise<PayNotifyResult> {
    // mock 模式下按自定义明文结构解析，便于调试端点直接投递
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      this.logger.warn('[mock] 回调体非 JSON，按空处理');
    }
    return {
      orderNo: String(body.orderNo ?? ''),
      transactionId: String(body.transactionId ?? `mock_txn_${Date.now()}`),
      amountFen: Number(body.amountFen ?? 0),
      success: body.success !== false,
      raw: body,
    };
  }

  onPaid(handler: (result: PayNotifyResult) => void): void {
    this.emitter.on('paid', handler);
  }

  async simulatePaid(orderNo: string, amountFen: number): Promise<void> {
    const result: PayNotifyResult = {
      orderNo,
      transactionId: `mock_txn_${Date.now()}`,
      amountFen,
      success: true,
      raw: { mock: true, simulatedAt: new Date().toISOString() },
    };
    this.logger.log(`[mock] 触发支付成功事件 orderNo=${orderNo} 金额=${amountFen}分`);
    this.emitter.emit('paid', result);
  }
}

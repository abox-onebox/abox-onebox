import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import type { PayCreateResult, PayNotifyAck } from '@abox/shared-types';

import { OrderService } from '../order/order.service';
import { WxpayConfigService } from './wxpay-config';
import { WxpayService } from './wxpay.service';

/**
 * 支付编排服务（《接口规范 v1.0》§3.3 U7/U8、§七 W1）
 *
 * 编排关系：`PaymentService` → `WxpayService`（通道） + `OrderService`（状态机与金额）
 *
 * ⚠️ mock 自动回调链路：`MockWxPayProvider.createPrepay()` 会在延迟后
 *    发出 `paid` 事件；若无人订阅，事件会被丢弃 → 订单永远停在 `pending_pay`。
 *    故此处 `onModuleInit` **必须**订阅并把事件送入 `markPaid`。
 */
@Injectable()
export class PaymentService implements OnModuleInit {
  private readonly logger = new Logger('PaymentService');

  constructor(
    private readonly orderService: OrderService,
    private readonly wxpay: WxpayService,
    private readonly wxpayConfig: WxpayConfigService,
  ) {}

  onModuleInit(): void {
    this.wxpay.onPaid((r) => {
      void this.orderService
        .markPaid(r.orderNo, r.transactionId, r.amountFen, r.raw)
        .then((res) => {
          this.logger.log(
            `[自动回调] orderNo=${r.orderNo} 入账=${res.changed ? '成功' : '跳过'}${
              res.reason ? `（${res.reason}）` : ''
            }`,
          );
        })
        .catch((e: Error) => this.logger.error(`[自动回调] 入账异常：${e.message}`));
    });
    this.logger.log(
      `支付通道就绪：${this.wxpay.isMock ? 'mock（本地假支付，自动回调已订阅）' : 'real'}`,
    );
  }

  /** U7 · 创建微信支付单（JSAPI） */
  async createPrepay(userId: number, orderNo: string): Promise<PayCreateResult> {
    const prep = await this.orderService.preparePrepay(userId, orderNo);

    const { payParams } = await this.wxpay.createPrepay({
      orderNo: prep.orderNo,
      amountFen: prep.payAmountFen,
      description: this.wxpayConfig.buildDescription(prep.mealDate, prep.quantity),
      openid: prep.openid,
    });

    this.logger.log(
      `创建支付单 orderNo=${orderNo} 金额=${prep.payAmountFen}分 通道=${this.wxpay.isMock ? 'mock' : 'real'}`,
    );

    return { ...payParams, orderNo: prep.orderNo, payAmountFen: prep.payAmountFen };
  }

  /** U8 · 支付结果（前端轮询 / 回跳） */
  payResult(userId: number, orderNo: string) {
    return this.orderService.payResult(userId, orderNo);
  }

  /**
   * W1 · 微信支付结果通知
   * 契约（§七）：无论内部结果如何，**回调一律回 `{"code":"SUCCESS"}`**，
   * 否则微信会持续重推，形成风暴。
   */
  async handlePayNotify(headers: Record<string, unknown>, rawBody: string): Promise<PayNotifyAck> {
    let parsed;
    try {
      parsed = await this.wxpay.parseNotify(headers, rawBody);
    } catch (e) {
      this.logger.error(`支付回调验签/解析失败：${(e as Error).message}`);
      return { code: 'FAIL', message: '验签失败' };
    }

    if (!parsed.orderNo) {
      this.logger.error('支付回调查无 out_trade_no，已忽略');
      return { code: 'SUCCESS', message: '成功' };
    }

    if (!parsed.success) {
      // 非成功通知（关单 / 未支付）不入账，仅记录
      this.logger.warn(`支付回调非成功态，忽略：orderNo=${parsed.orderNo}`);
      return { code: 'SUCCESS', message: '成功' };
    }

    try {
      await this.orderService.markPaid(
        parsed.orderNo,
        parsed.transactionId,
        parsed.amountFen,
        parsed.raw,
      );
    } catch (e) {
      this.logger.error(`支付回调入账失败 orderNo=${parsed.orderNo}：${(e as Error).message}`);
      // 仍回 SUCCESS：入账失败交由对账任务兜底，回 FAIL 会被微信重推形成风暴
    }
    return { code: 'SUCCESS', message: '成功' };
  }

  /**
   * 调试端点：手动触发一笔支付成功（仅 mock 通道）
   * 用途：分步调试「下单 → 支付 → 回调 → 订单转 paid」，无需依赖自动回调延迟。
   */
  async simulatePaid(orderNo: string, amountFen?: number): Promise<{ triggered: boolean }> {
    const fen = amountFen ?? (await this.orderService.payAmountFenOf(orderNo));
    const triggered = await this.wxpay.simulatePaid(orderNo, fen);
    return { triggered };
  }
}

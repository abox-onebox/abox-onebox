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
 * ⚠️ **本地 / e2e 专用**：退款**失败注入**标记（M4-3）
 *
 * `refund()` 的 `reason` 含此串时，直接返回 `status='FAIL'`。
 *
 * ## 为什么需要它
 *
 * M4-3 的头号改动是「**外部通道调用移出 DB 事务**，失败改为入队退避重试」——
 * 而这条链路**无法用正常路径触发**：mock 退款永远成功，真实微信退款也不会失败。
 * 没有注入点，这套机制就只能靠「我认为它是对的」来交付，而本项目要求
 * **机械证据**（见《缺陷与陷阱》#34/#42/#65：证据必须与产物对齐）。
 *
 * ## 三条约束（防止它泄漏到真实环境）
 *
 * 1. **只存在于 mock 实现** —— `RealWxPayProvider` 没有这条分支，生产路径无从触发；
 * 2. **必须显式传标记** —— 依赖调用方在 `reason` 里写死这个串，
 *    正常人（用户/运营）填的退款原因不可能包含 `__mock_refund_fail__`；
 * 3. **命中时会 WARN** —— 日志里一眼能看出「这笔失败是注入的」，不会与真故障混淆。
 *
 * ⚠️ 与 `simulatePaid()`（既有「调试专用」钩子）同一性质，同一纪律。
 */
export const MOCK_REFUND_FAIL_MARKER = '__mock_refund_fail__';

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
    // ⚠️ 失败注入（仅本地/e2e，见 `MOCK_REFUND_FAIL_MARKER` 注释）
    if (input.reason?.includes(MOCK_REFUND_FAIL_MARKER)) {
      this.logger.warn(
        `[mock] 命中退款失败注入标记 refundNo=${input.refundNo} —— 返回 FAIL（**这笔失败是注入的，不是真故障**）`,
      );
      return {
        refundId: `mock_refund_failed_${input.refundNo}`,
        status: 'FAIL',
        raw: { mock: true, injected: true },
      };
    }

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

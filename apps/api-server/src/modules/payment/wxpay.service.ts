import { Inject, Injectable, Logger } from '@nestjs/common';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  PayNotifyResult,
  PrepayResult,
  WX_PAY_PROVIDER,
  WxPayProvider,
} from '../../providers/wx-pay/wx-pay.provider';

/**
 * 微信支付通道封装（业务侧唯一入口）
 *
 * 职责边界：**只做通道调用与错误翻译**，不碰订单状态与金额口径。
 *   · 与订单状态的联动一律走 `OrderService`（由 `PaymentService` 编排）；
 *   · 金额单位在 Provider 层恒为「分」，本层不做二次换算。
 */
@Injectable()
export class WxpayService {
  private readonly logger = new Logger('WxpayService');

  constructor(@Inject(WX_PAY_PROVIDER) private readonly provider: WxPayProvider) {}

  get isMock(): boolean {
    return this.provider.isMock;
  }

  /** 统一下单（JSAPI） */
  async createPrepay(input: {
    orderNo: string;
    amountFen: number;
    description: string;
    openid: string;
  }): Promise<PrepayResult> {
    if (input.amountFen <= 0) {
      throw new BizException(ErrorCode.PAY_CREATE_FAILED, '支付金额必须大于 0 分');
    }
    try {
      return await this.provider.createPrepay(input);
    } catch (e) {
      if (e instanceof BizException) throw e;
      this.logger.error(`统一下单失败 orderNo=${input.orderNo}：${(e as Error).message}`);
      throw new BizException(ErrorCode.PAY_CREATE_FAILED);
    }
  }

  /** 解析并验签支付结果通知 */
  parseNotify(headers: Record<string, unknown>, rawBody: string): Promise<PayNotifyResult> {
    return this.provider.parseNotify(headers, rawBody);
  }

  /** 订阅支付成功事件（mock 自动回调依赖此通道） */
  onPaid(handler: (r: PayNotifyResult) => void): void {
    this.provider.onPaid?.(handler);
  }

  /** 调试：手动触发一笔支付成功（仅 mock 实现提供） */
  async simulatePaid(orderNo: string, amountFen: number): Promise<boolean> {
    if (!this.provider.simulatePaid) return false;
    await this.provider.simulatePaid(orderNo, amountFen);
    return true;
  }
}

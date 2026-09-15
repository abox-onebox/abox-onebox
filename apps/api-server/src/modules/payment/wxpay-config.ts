import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * 微信支付配置视图
 *
 * 只做「配置读取 + 描述文案拼装」，**不承载任何签名逻辑** ——
 * 签名/验签一律由 `WxPayProvider` 的实现负责（mock ↔ real 可替换）。
 */
@Injectable()
export class WxpayConfigService {
  constructor(private readonly config: ConfigService) {}

  get mchId(): string {
    return this.config.get<string>('wechat.pay.mchId') ?? '';
  }

  get notifyUrl(): string {
    return this.config.get<string>('wechat.pay.notifyUrl') ?? '';
  }

  get refundNotifyUrl(): string {
    return this.config.get<string>('wechat.pay.refundNotifyUrl') ?? '';
  }

  /** 商户参数是否齐备（real 模式下缺一不可） */
  get isConfigured(): boolean {
    return Boolean(
      this.mchId &&
      this.config.get<string>('wechat.pay.apiV3Key') &&
      this.config.get<string>('wechat.pay.serialNo'),
    );
  }

  /**
   * 统一下单商品描述（微信要求 ≤ 127 字符）
   * 例：`ABox一盒 团餐 2026-09-16 ×1`
   */
  buildDescription(mealDate: string, quantity: number): string {
    const s = `ABox一盒 团餐 ${mealDate} ×${quantity}`;
    return s.length > 120 ? s.slice(0, 120) : s;
  }
}

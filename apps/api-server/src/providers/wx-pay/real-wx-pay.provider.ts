import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  PayNotifyResult,
  PrepayInput,
  PrepayResult,
  RefundInput,
  RefundResult,
  WxPayProvider,
} from './wx-pay.provider';

/**
 * 微信支付 V3 · 真实实现（PROVIDER_MODE=real）
 *
 * ⚠️ 当前状态：**待启用**
 *   微信支付商户号仍在申请/核对中（见《账号资源与密钥清单》），故本实现暂不落地，
 *   以免写入无法验证的签名逻辑。商户号 + APIv3 密钥 + 商户私钥 + 平台证书就位后，
 *   按以下清单补全（约 0.5 人天）：
 *
 *   1. 统一下单  POST /v3/pay/transactions/jsapi
 *      body: { appid, mchid, description, out_trade_no, notify_url, amount:{total,currency:'CNY'}, payer:{openid} }
 *      → 取 prepay_id，再按 V3 规则用商户私钥 RSA-SHA256 生成 paySign
 *   2. 支付回调  解析 resource（AES-256-GCM 解密，密钥 = APIv3 密钥）
 *      校验 Wechatpay-Signature / Wechatpay-Timestamp / Wechatpay-Nonce 防重放
 *   3. 退款      POST /v3/refund/domestic/refunds
 *   4. 证书轮换  平台证书定期下载与缓存（建议 12h）
 *
 * 推荐直接引入 `wechatpay-node-v3`（已在 package.json），避免手写签名踩坑。
 */
@Injectable()
export class RealWxPayProvider extends WxPayProvider {
  private readonly logger = new Logger('WxPay:real');

  constructor(private readonly config: ConfigService) {
    super();
    const mchId = this.config.get<string>('wechat.pay.mchId') ?? '';
    const apiV3Key = this.config.get<string>('wechat.pay.apiV3Key') ?? '';
    const serialNo = this.config.get<string>('wechat.pay.serialNo') ?? '';
    if (!mchId || !apiV3Key || !serialNo) {
      this.logger.warn('微信支付商户参数不完整（MCH_ID / API_V3_KEY / SERIAL_NO），真实支付不可用');
    }
  }

  get isMock(): boolean {
    return false;
  }

  private notReady(): never {
    throw new BizException(
      ErrorCode.PAY_FAILED,
      '真实微信支付通道待启用：商户号与证书就位后补全（详见 real-wx-pay.provider.ts 注释）',
    );
  }

  async createPrepay(_input: PrepayInput): Promise<PrepayResult> {
    this.notReady();
  }

  async refund(_input: RefundInput): Promise<RefundResult> {
    this.notReady();
  }

  async parseNotify(_headers: Record<string, unknown>, _rawBody: string): Promise<PayNotifyResult> {
    this.notReady();
  }
}

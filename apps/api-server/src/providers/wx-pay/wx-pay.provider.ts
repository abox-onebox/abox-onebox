/**
 * 微信支付 V3 能力抽象（用户实付收款 · JSAPI）
 *
 * 金额单位约定：**Provider 层一律用「分」**（与微信接口一致），
 * 业务层用「元」（DECIMAL(10,2)）；转换只在 service 边界做一次。
 *
 * ⚠️ 一期结算口径（C11）：
 *   - 本通道**只负责用户实付收款**与退款；
 *   - 供应商 / 集散中心走人工对公转账日结，**不再使用微信分账**；
 *   - 团长佣金走灵活用工平台代发代扣，见 flex-payout.provider.ts。
 */
export const WX_PAY_PROVIDER = Symbol('WX_PAY_PROVIDER');

export interface WxPayJsapiParams {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
}

export interface PrepayInput {
  /** 商户订单号（用 ab_order.order_no） */
  orderNo: string;
  /** 金额（分） */
  amountFen: number;
  /** 商品描述 */
  description: string;
  /** 支付者 openid */
  openid: string;
}

export interface PrepayResult {
  prepayId: string;
  payParams: WxPayJsapiParams;
}

export interface PayNotifyResult {
  orderNo: string;
  transactionId: string;
  amountFen: number;
  success: boolean;
  raw: unknown;
}

export interface RefundInput {
  orderNo: string;
  refundNo: string;
  /** 退款金额（分） */
  refundFen: number;
  /** 原订单总额（分） */
  totalFen: number;
  reason?: string;
}

export interface RefundResult {
  refundId: string;
  status: string;
  raw?: unknown;
}

export abstract class WxPayProvider {
  abstract get isMock(): boolean;

  /** 统一下单，返回小程序可调起的支付参数 */
  abstract createPrepay(input: PrepayInput): Promise<PrepayResult>;

  /** 申请退款 */
  abstract refund(input: RefundInput): Promise<RefundResult>;

  /** 解析并验签支付结果通知 */
  abstract parseNotify(headers: Record<string, unknown>, rawBody: string): Promise<PayNotifyResult>;

  /** 订阅「支付成功」（mock 自动回调时由 service 消费） */
  onPaid?(handler: (result: PayNotifyResult) => void): void;

  /** 调试专用：手动触发一笔支付成功（仅 mock 实现提供） */
  simulatePaid?(orderNo: string, amountFen: number): Promise<void>;
}

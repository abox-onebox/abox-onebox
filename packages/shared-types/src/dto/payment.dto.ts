/**
 * 支付契约（U7 / U8 / W1 · 《接口规范 v1.0》§3.3、§七）
 *
 * ⚠️ 金额在 **Provider 层一律用「分」**，业务层（DB）用元(DECIMAL)。
 *    转换只在 service 边界做一次，禁止在多处重复换算。
 */

/** U7 返回 —— 小程序 `wx.requestPayment` 直接可用 */
export interface PayCreateResult {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
  /** 便于端上轮询 U8 */
  orderNo: string;
  payAmountFen: number;
}

/** U8 支付结果 */
export interface PayResultView {
  orderNo: string;
  /** 订单主状态（pending_pay / paid / cancelled …） */
  status: string;
  statusText: string;
  paid: boolean;
  payAmountFen: number;
  paidAt: string | null;
  /** 支付失败原因（仅失败时有值） */
  failReason: string | null;
}

/** W1 支付结果通知（微信 → 服务端；mock 模式下为等价明文结构） */
export interface PayNotifyPayload {
  out_trade_no: string;
  transaction_id: string;
  amount_fen: number;
  trade_state: 'SUCCESS' | 'CLOSED' | 'NOTPAY' | 'REFUND';
}

/** 回调统一回执（§七） */
export interface PayNotifyAck {
  code: 'SUCCESS' | 'FAIL';
  message: string;
}

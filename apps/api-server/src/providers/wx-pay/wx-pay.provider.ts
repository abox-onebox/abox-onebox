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

/**
 * 微信侧订单交易状态（`trade_state` 原样的子集）
 *
 * `UNKNOWN` 是**本地兜底**：拿不到 reply 或 reply 里没有 `trade_state` 时用。
 * ⚠️ 它与 `NOTPAY` 语义**不同**：`NOTPAY` 是微信明确回答「这笔没付」，
 * `UNKNOWN` 是「我没有拿到回答」—— 后者**不能**当作「没付」处理
 * （否则「微信说已支付、本地没收到」会被引成「没付」而关单）。
 */
export type WxTradeState =
  'SUCCESS' | 'REFUND' | 'NOTPAY' | 'CLOSED' | 'REVOKED' | 'PAYERROR' | 'ACCEPT' | 'UNKNOWN';

export interface QueryOrderInput {
  /** 商户订单号（ab_order.order_no） */
  orderNo: string;
}

/**
 * 查单结果（P3 · 支付单边账补齐的唯一输入）
 *
 * ## 三态必须分开，合成一个 `boolean` 就会出错
 * | 形态 | found | 可当「已支付」 | 该做什么 |
 * |---|---|---|---|
 * | 微信明确说没这笔单 | `false` | ❌ | 记一笔，交人工核对（订单号可能根本没送到微信） |
 * | 微信说已支付 | `true` + `paid=true` | ✅ | 本地补入账 |
 * | 根本没拿到回答 | —— | ❌ | **不动单**，等下次任务重试 |
 *
 * 第三态由**抛异常**表达（`PAY_QUERY_FAILED`），刻意不塞进返回值 ——
 * 否则调用方极易写成 `if (!r.paid) 关单`，把「查不到」当成「没付」，
 * 那是**把钱收了还把单关了**，比不动单危险得多。
 */
export interface QueryOrderResult {
  /** 微信侧能否查到这笔单（false = 明确不存在，不是「查询失败」） */
  found: boolean;
  tradeState: WxTradeState;
  /** 判定为「已支付且应入账」—— 仅 `SUCCESS`（`REFUND` 表示付过又退了，不可入账） */
  paid: boolean;
  transactionId?: string;
  /** 订单总金额（分）；与本地 `pay_amount` 比对用 */
  amountFen?: number;
  raw?: unknown;
}

export abstract class WxPayProvider {
  abstract get isMock(): boolean;

  /** 统一下单，返回小程序可调起的支付参数 */
  abstract createPrepay(input: PrepayInput): Promise<PrepayResult>;

  /** 申请退款 */
  abstract refund(input: RefundInput): Promise<RefundResult>;

  /**
   * 查单（P3 · 回调丢失时的补齐手段）
   *
   * ⛔ **契约**：查询**失败**必须**抛异常**（`PAY_QUERY_FAILED`），
   *    不得返回 `found:false` —— 「没查到这笔单」与「没拿到回答」是两回事，
   *    混在一起会让调用方把「通道挂了」当成「用户没付」，进而关掉一张真已付款的单。
   *
   * @throws BizException(PAY_QUERY_FAILED) 通道不可用 / 网络或验签失败
   */
  abstract queryOrder(input: QueryOrderInput): Promise<QueryOrderResult>;

  /** 解析并验签支付结果通知 */
  abstract parseNotify(headers: Record<string, unknown>, rawBody: string): Promise<PayNotifyResult>;

  /** 订阅「支付成功」（mock 自动回调时由 service 消费） */
  onPaid?(handler: (result: PayNotifyResult) => void): void;

  /** 调试专用：手动触发一笔支付成功（仅 mock 实现提供） */
  simulatePaid?(orderNo: string, amountFen: number): Promise<void>;
}

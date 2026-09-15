/**
 * 订单主状态机（11 态 = 正常 7 + 异常 4）
 * 权威来源：《ABox一盒订单状态机与全链路流转v1.0.md》§1.1
 */
export enum OrderStatus {
  /** 待支付（30 分钟内有效） */
  PENDING_PAY = 'pending_pay',
  /** 已支付，等待截单 */
  PAID = 'paid',
  /** 已截单（T-1 24:00 锁定） */
  CUT_OFF = 'cut_off',
  /** 已出餐（供应商确认，须 <= 09:30） */
  COOKED = 'cooked',
  /** 配送中（货拉拉发出） */
  DELIVERING = 'delivering',
  /** 待取餐（11:30 送达办公楼） */
  DELIVERED = 'delivered',
  /** 已完成（团长确认 / T 日 14:00 自动确认 + 佣金入账） */
  COMPLETED = 'completed',
  /** 已取消（截单前自助取消 / 超时未支付 / 截单兜底） */
  CANCELLED = 'cancelled',
  /** 退款申请中（团长代退已提交，待平台审批） */
  REFUND_APPLYING = 'refund_applying',
  /** 退款中（审批通过，微信退款处理中） */
  REFUNDING = 'refunding',
  /** 已退款（到账 + 反向结算完成） */
  REFUNDED = 'refunded',
}

/** 用户端 5 态展示 */
export type UserOrderStatusView = '待支付' | '待出餐' | '配送中' | '待取餐' | '已完成'
  | '已取消' | '退款申请中' | '退款中' | '已退款';

/** 团长端 6 态展示 */
export type LeaderOrderStatusView = '待支付' | '待出餐' | '已出餐' | '配送中' | '待取餐' | '已完成'
  | '已取消' | '退款申请中' | '退款中' | '已退款';

/** 后台 8 态展示 */
export type AdminOrderStatusView = '待支付' | '已支付' | '已截单' | '已出餐' | '配送中' | '待取餐' | '已完成'
  | '已取消' | '退款申请中' | '退款中' | '已退款';

/** 主状态 → 三视角展示文案 */
export const ORDER_STATUS_VIEW: Record<
  OrderStatus,
  { user: string; leader: string; admin: string }
> = {
  [OrderStatus.PENDING_PAY]: { user: '待支付', leader: '待支付', admin: '待支付' },
  [OrderStatus.PAID]: { user: '待出餐', leader: '待出餐', admin: '已支付' },
  [OrderStatus.CUT_OFF]: { user: '待出餐', leader: '待出餐', admin: '已截单' },
  [OrderStatus.COOKED]: { user: '待出餐', leader: '已出餐', admin: '已出餐' },
  [OrderStatus.DELIVERING]: { user: '配送中', leader: '配送中', admin: '配送中' },
  [OrderStatus.DELIVERED]: { user: '待取餐', leader: '待取餐', admin: '待取餐' },
  [OrderStatus.COMPLETED]: { user: '已完成', leader: '已完成', admin: '已完成' },
  [OrderStatus.CANCELLED]: { user: '已取消', leader: '已取消', admin: '已取消' },
  [OrderStatus.REFUND_APPLYING]: { user: '退款申请中', leader: '退款申请中', admin: '退款申请中' },
  [OrderStatus.REFUNDING]: { user: '退款中', leader: '退款中', admin: '退款中' },
  [OrderStatus.REFUNDED]: { user: '已退款', leader: '已退款', admin: '已退款' },
};

/** 终态 */
export const ORDER_TERMINAL_STATUS: OrderStatus[] = [
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
];

/** ab_refund.status（与订单退款态一一对应） */
export enum RefundStatus {
  APPLYING = 'applying',
  APPROVED = 'approved',
  REFUNDING = 'refunding',
  REFUNDED = 'refunded',
  REJECTED = 'rejected',
}

/** ab_supplier_share.status（应付状态机 · C10 人工对公） */
export enum SupplierShareStatus {
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
  REVERSED = 'reversed',
}

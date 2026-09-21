/**
 * 订单查询契约（U9 / U10 / U11 · 《接口规范 v1.0》§3.4）
 * 金额一律**整数分**（§1.6）；时间一律 ISO 8601 带 `+08:00`。
 */

/** 订单列表项（U9） */
export interface OrderListItem {
  orderNo: string;
  status: string;
  /** 三视角文案（由 `ORDER_STATUS_VIEW` 映射，端上不再自行拼文案） */
  statusText: string;
  mealDate: string;
  quantity: number;
  /** 单价快照（分） */
  unitPriceFen: number;
  totalAmountFen: number;
  /** 主菜名（列表展示用，取套餐 slot=1 菜品） */
  mainDishName: string | null;
  createdAt: string;
}

/** 状态机时间线节点（U10） */
export interface OrderTimelineNode {
  /** 与 `OrderStatus` 同值（不含 pending_pay） */
  node: string;
  at: string | null;
  done: boolean;
  text: string;
}

/** 取餐信息（U10） */
export interface OrderPickupInfo {
  point: string;
  leaderName: string | null;
  /** 已脱敏（§1.6） */
  leaderPhone: string | null;
  /**
   * 送达时刻 `HH:mm`（服务端按**生效时间轴**派生下发，端上只展示、不自造）
   *
   * ⚠️ PR-02 收口（2026-09-21）：端上取餐卡与「配送途中」提示曾各写死 `11:30`。
   * 真源是服务端 `currentTimeline().arrival`（后台 `set_meal.delivery_arrival_time` 可改），
   * 端上拿不到 ⇒ 必须由本字段下发，不得再写死。
   */
  expectAt: string;
}

/** 订单详情（U10） */
export interface OrderDetailResult {
  orderNo: string;
  status: string;
  statusText: string;
  mealDate: string;
  quantity: number;
  unitPriceFen: number;
  totalAmountFen: number;
  balanceUsedFen: number;
  payAmountFen: number;
  remark: string | null;
  dishes: Array<{ name: string; slot: number; supplierName: string | null }>;
  timeline: OrderTimelineNode[];
  pickup: OrderPickupInfo;
  createdAt: string;
  paidAt: string | null;
  /** 截单后发起代退的引导信息（U11 错误载荷 / 详情页提示复用） */
  leaderContact: { name: string | null; phone: string | null } | null;
}

/** U11 取消结果 */
export interface CancelOrderResult {
  orderNo: string;
  status: string;
  statusText: string;
  /** 是否已发起原路退款（`paid` 单为 true） */
  refundInitiated: boolean;
  /** 退回余额（分，0 表示无余额退回） */
  refundedBalanceFen: number;
}

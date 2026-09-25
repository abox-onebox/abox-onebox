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

/**
 * 订单的口味评价状态（U10 详情新增 · P1-U2）
 *
 * `canRate` / `rated` 互补但**不是互斥全集**（还有「未送达不可评」这一段）：
 *   · `rated=true`  ⇒ `canRate=false`，`items` 非空（已评内容，回显用）
 *   · `rated=false && canRate=true` ⇒ 可评（端上出评价卡）
 *   · `rated=false && canRate=false` ⇒ 尚未送达（或该单无菜品明细）—— 端上不出卡
 */
export interface OrderRatingView {
  /** 当前状态可评价（已送达/已完成 且 未评过 且 有菜品明细） */
  canRate: boolean;
  /** 已提交过评价（一次提交即定稿，不可改 —— 2026-09-25 裁决） */
  rated: boolean;
  /** 首次提交时刻（ISO 8601 +08:00）；未评为 null */
  ratedAt: string | null;
  /** 已评内容（按提交顺序；未评为空数组 —— 「没评」与「评了零个菜」不同态） */
  items: Array<{ dishId: number; rating: number; reason: string | null }>;
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
  /**
   * ⚠️ `dishId`（P1-U2 新增）：评价提交按 `dishId` 定位菜品 ——
   * `ab_dish.name` 无唯一约束（A3），按名字定位会把评价记到别家同名菜头上。
   */
  dishes: Array<{ dishId: number; name: string; slot: number; supplierName: string | null }>;
  /** 口味评价状态（P1-U2 新增；端上据此决定出不出评价卡） */
  rating: OrderRatingView;
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

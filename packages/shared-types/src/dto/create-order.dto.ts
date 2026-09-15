/**
 * 下单接口契约（U6 · 《接口规范 v1.0》§3.3）
 *
 * ⚠️ 2026-09-15 裁定：**以《接口规范》§3.3 为准**。
 *    此前本文件曾定义 `mealAssignmentId / leaderId / idempotentKey`，与文档不一致：
 *      · `mealAssignmentId` 是**内部主键**，不应暴露给端上（可被构造绕过楼群/日期校验）；
 *      · 幂等键按 §1.4 走**请求头** `Idempotency-Key`，不放 body。
 *    服务端按 `mealDate + 用户所属楼群` 自行反查 `ab_meal_assignment`。
 */
export interface CreateOrderDto {
  /** 出餐日（T 日），`YYYY-MM-DD`；缺省 = 服务端「明日」 */
  mealDate?: string;
  /** 份数；上限 `ab_config.order.max_quantity`（默认 20） */
  quantity: number;
  /** 备注（过敏忌口等），≤ 256 字 */
  remark?: string;
  /** 余额抵扣（**整数分**，§1.6）；0 或省略表示不使用余额 */
  useBalanceFen?: number;
  /** 跟随的团长邀请码；缺省按用户默认归属团长 */
  leaderCode?: string;
}

/** U6 返回 —— 订单已创建（`pending_pay`），支付参数由 U7 单独获取 */
export interface CreateOrderResult {
  orderNo: string;
  mealDate: string;
  quantity: number;
  status: string;
  /** 单价快照（分），锁定 ¥25.80 → 2580 */
  unitPriceFen: number;
  /** 订单总额（分）= 单价 × 份数 */
  totalAmountFen: number;
  /** 余额抵扣（分） */
  balanceUsedFen: number;
  /** 应付微信金额（分）= 总额 − 余额抵扣 */
  payAmountFen: number;
  /** 支付超时时刻（ISO 8601 +08:00）—— 30 分钟未支付自动取消（T3） */
  expireAt: string;
}

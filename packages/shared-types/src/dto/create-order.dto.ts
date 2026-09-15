/** 下单入参（U7 / M02-01） */
export interface CreateOrderDto {
  /** 套餐分配 id（日期 × 楼群 二维矩阵的一格） */
  mealAssignmentId: number;
  /** 份数；上限 `ab_config.MAX_QUANTITY_PER_ORDER` */
  quantity: number;
  /** 跟随的团长 id（来自邀请链接 / 办公楼默认团长） */
  leaderId?: number;
  /** 幂等键：同一用户 + 同一套餐 + 同一幂等键只创建一单 */
  idempotentKey: string;
}

export interface CreateOrderResult {
  orderNo: string;
  /** 微信支付参数（JSAPI） */
  payParams: Record<string, string>;
  /** 30 分钟未支付自动取消的截止时间戳（毫秒） */
  expireAt: number;
}

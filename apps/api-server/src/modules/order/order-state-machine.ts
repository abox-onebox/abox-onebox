import { OrderStatus } from '@abox/shared-types';

/**
 * 订单状态机映射
 * 权威来源：《ABox一盒订单状态机与全链路流转v1.0.md》§二 状态迁移表
 * 主流程 T1–T11 单向不可逆；退款分支 T12–T16 见文档。
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING_PAY]: [OrderStatus.PAID, OrderStatus.CANCELLED],
  [OrderStatus.PAID]: [OrderStatus.CUT_OFF, OrderStatus.CANCELLED],
  [OrderStatus.CUT_OFF]: [OrderStatus.COOKED, OrderStatus.REFUND_APPLYING],
  [OrderStatus.COOKED]: [OrderStatus.DELIVERING, OrderStatus.REFUND_APPLYING],
  [OrderStatus.DELIVERING]: [OrderStatus.DELIVERED, OrderStatus.REFUND_APPLYING],
  [OrderStatus.DELIVERED]: [OrderStatus.COMPLETED, OrderStatus.REFUND_APPLYING],
  [OrderStatus.COMPLETED]: [OrderStatus.REFUND_APPLYING],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.REFUND_APPLYING]: [OrderStatus.REFUNDING, OrderStatus.REFUNDED],
  [OrderStatus.REFUNDING]: [OrderStatus.REFUNDED],
  [OrderStatus.REFUNDED]: [],
};

/** 截单后（cut_off 及以后）用户不可自助取消（C6） */
export const USER_SELF_CANCEL_ALLOWED: OrderStatus[] = [OrderStatus.PENDING_PAY, OrderStatus.PAID];

export function canTransit(from: OrderStatus, to: OrderStatus): boolean {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

export function canUserSelfCancel(status: OrderStatus): boolean {
  return USER_SELF_CANCEL_ALLOWED.includes(status);
}

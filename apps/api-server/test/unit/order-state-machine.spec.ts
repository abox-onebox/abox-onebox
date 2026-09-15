import { OrderStatus } from '@abox/shared-types';
import { canTransit, canUserSelfCancel } from '../../src/modules/order/order-state-machine';

describe('订单状态机（对照《订单状态机 v1.0》§二）', () => {
  it('主流程 T1–T11 单向迁移成立', () => {
    expect(canTransit(OrderStatus.PENDING_PAY, OrderStatus.PAID)).toBe(true);
    expect(canTransit(OrderStatus.PAID, OrderStatus.CUT_OFF)).toBe(true);
    expect(canTransit(OrderStatus.CUT_OFF, OrderStatus.COOKED)).toBe(true);
    expect(canTransit(OrderStatus.COOKED, OrderStatus.DELIVERING)).toBe(true);
    expect(canTransit(OrderStatus.DELIVERING, OrderStatus.DELIVERED)).toBe(true);
    expect(canTransit(OrderStatus.DELIVERED, OrderStatus.COMPLETED)).toBe(true);
  });

  it('截单后用户不可自助取消（C6）', () => {
    expect(canUserSelfCancel(OrderStatus.PENDING_PAY)).toBe(true);
    expect(canUserSelfCancel(OrderStatus.PAID)).toBe(true);
    expect(canUserSelfCancel(OrderStatus.CUT_OFF)).toBe(false);
    expect(canUserSelfCancel(OrderStatus.DELIVERED)).toBe(false);
  });

  it('终态封闭：已取消 / 已退款无后继', () => {
    expect(canTransit(OrderStatus.CANCELLED, OrderStatus.PAID)).toBe(false);
    expect(canTransit(OrderStatus.REFUNDED, OrderStatus.COMPLETED)).toBe(false);
  });

  it('退款分支：申请 → 退款中 → 已退款', () => {
    expect(canTransit(OrderStatus.REFUND_APPLYING, OrderStatus.REFUNDING)).toBe(true);
    expect(canTransit(OrderStatus.REFUNDING, OrderStatus.REFUNDED)).toBe(true);
  });
});

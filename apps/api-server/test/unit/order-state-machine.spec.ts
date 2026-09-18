import { OrderStatus } from '@abox/shared-types';
import {
  canTransit,
  canUserSelfCancel,
  ORDER_INITIAL_STATUS,
  ORDER_RESERVED_STATUSES,
  ORDER_TRANSITIONS,
} from '../../src/modules/order/order-state-machine';

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

  /**
   * 退款分支（**M5-8 改口径** · 见《缺陷与陷阱》#79 / #84）
   *
   * ⚠️ 「订单」与「退款单」的退款进度是**两条**：
   *    · 订单：`refund_applying` → **一步到** `refunded`（审批通过即落，`settleRefundDb` 的第一条语句）
   *    · 退款单：`applying → refunding → refunded`（走 `ab_refund.status`，通道进度）
   * 旧断言 `refund_applying → refunding` 为 true，是**照抄声明表**写的 —— 而那条边
   * 从 M4-3 起就**从未被实现过**（躺了三个批次，无人报错）。本用例改为**双向锁定**：
   * 正向证明一步到 `refunded`，反向**明确断言那条边不成立**（防它被谁「顺手加回来」）。
   */
  it('退款分支：申请 → 已退款（一步到底，订单不经过「退款中」）', () => {
    expect(canTransit(OrderStatus.REFUND_APPLYING, OrderStatus.REFUNDED)).toBe(true);
    expect(canTransit(OrderStatus.REFUND_APPLYING, OrderStatus.REFUNDING)).toBe(false);
  });

  it('保留态 `refunding`：仍在 11 态契约里，但订单**进不去**（无入边 · 只在保留清单里）', () => {
    // 无入边 ⇒ 任何状态都无法迁移到它
    for (const from of Object.keys(ORDER_TRANSITIONS) as OrderStatus[]) {
      expect(ORDER_TRANSITIONS[from]).not.toContain(OrderStatus.REFUNDING);
    }
    // 但它必须被**显式登记**为保留态，而不是悄悄从枚举里消失
    // （门禁 `state:audit` 规则 ④ 认的就是这个清单）
    expect(ORDER_RESERVED_STATUSES).toContain(OrderStatus.REFUNDING);
  });

  it('初始态 `pending_pay` 是表中唯一允许「无入边」的状态', () => {
    expect(ORDER_INITIAL_STATUS).toBe(OrderStatus.PENDING_PAY);
    const incoming = new Set(
      (Object.keys(ORDER_TRANSITIONS) as OrderStatus[]).flatMap((from) =>
        ORDER_TRANSITIONS[from].map((to) => String(to)),
      ),
    );
    expect(incoming.has(String(ORDER_INITIAL_STATUS))).toBe(false);
  });
});

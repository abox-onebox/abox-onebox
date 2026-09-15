import { OrderStatus } from '@abox/shared-types';

import {
  buildTimeline,
  canTransit,
  explainSelfCancelBlock,
  userStatusText,
} from '../../src/modules/order/order-state-machine';

/**
 * 状态机与时间线（对照《订单状态机 v1.0》§二/§三、C6 三段式）
 */
describe('订单时间线（U10）', () => {
  const cutoffAt = new Date('2026-09-15T16:00:00.000Z'); // T 日 00:00 (+08)
  const createdAt = new Date('2026-09-15T04:00:00.000Z');

  it('刚下单（pending_pay）：6 个节点全部未完成', () => {
    const nodes = buildTimeline({
      status: OrderStatus.PENDING_PAY,
      createdAt,
      cutoffAt,
    });
    expect(nodes).toHaveLength(6);
    expect(nodes.every((n) => !n.done)).toBe(true);
    expect(nodes[0].node).toBe(OrderStatus.PAID);
  });

  it('已支付：paid 完成，cut_off 起未完成（且仅 paid 有来源时间）', () => {
    const paidAt = new Date('2026-09-15T04:05:00.000Z');
    const nodes = buildTimeline({ status: OrderStatus.PAID, createdAt, paidAt, cutoffAt });

    const paid = nodes.find((n) => n.node === OrderStatus.PAID)!;
    expect(paid.done).toBe(true);
    expect(paid.at).toEqual(paidAt);

    const cutoff = nodes.find((n) => n.node === OrderStatus.CUT_OFF)!;
    expect(cutoff.done).toBe(false);
    expect(cutoff.at).toBeNull();
  });

  it('已截单：cut_off 完成且时间取系统锚点（非人工操作时间）', () => {
    const nodes = buildTimeline({
      status: OrderStatus.CUT_OFF,
      createdAt,
      paidAt: createdAt,
      cutoffAt,
    });
    const cutoff = nodes.find((n) => n.node === OrderStatus.CUT_OFF)!;
    expect(cutoff.done).toBe(true);
    expect(cutoff.at).toEqual(cutoffAt);
  });

  it('已送达待取餐：前 5 节点完成，completed 未完成', () => {
    const nodes = buildTimeline({
      status: OrderStatus.DELIVERED,
      createdAt,
      paidAt: createdAt,
      cutoffAt,
    });
    expect(nodes.find((n) => n.node === OrderStatus.DELIVERED)!.done).toBe(true);
    expect(nodes.find((n) => n.node === OrderStatus.COMPLETED)!.done).toBe(false);
  });

  it('已完成：全 6 节点完成，completed 取 completed_at', () => {
    const completedAt = new Date('2026-09-16T06:10:00.000Z');
    const nodes = buildTimeline({
      status: OrderStatus.COMPLETED,
      createdAt,
      paidAt: createdAt,
      cutoffAt,
      completedAt,
    });
    expect(nodes.every((n) => n.done)).toBe(true);
    expect(nodes.find((n) => n.node === OrderStatus.COMPLETED)!.at).toEqual(completedAt);
  });

  it('异常态（已取消）：主流程节点不置完成，改为追加取消节点', () => {
    const cancelledAt = new Date('2026-09-15T05:00:00.000Z');
    const nodes = buildTimeline({
      status: OrderStatus.CANCELLED,
      createdAt,
      paidAt: createdAt,
      cutoffAt,
      cancelledAt,
    });
    expect(nodes).toHaveLength(7);
    expect(nodes.filter((n) => n.done)).toHaveLength(1);
    const last = nodes[nodes.length - 1];
    expect(last.node).toBe(OrderStatus.CANCELLED);
    expect(last.text).toBe('已取消');
    expect(last.at).toEqual(cancelledAt);
  });

  it('退款申请中：追加「退款申请中」节点并置完成', () => {
    const nodes = buildTimeline({
      status: OrderStatus.REFUND_APPLYING,
      createdAt,
      cutoffAt,
      cancelledAt: createdAt,
    });
    const last = nodes[nodes.length - 1];
    expect(last.node).toBe(OrderStatus.REFUND_APPLYING);
    expect(last.text).toBe('退款申请中');
    expect(last.done).toBe(true);
  });
});

describe('自助取消闸门（C6）', () => {
  it('截单前 + pending_pay/paid → 放行', () => {
    expect(explainSelfCancelBlock(OrderStatus.PENDING_PAY, false)).toBe('ok');
    expect(explainSelfCancelBlock(OrderStatus.PAID, false)).toBe('ok');
  });

  it('截单后 → cutoff（对应 40004，引导联系团长代退）', () => {
    expect(explainSelfCancelBlock(OrderStatus.PAID, true)).toBe('cutoff');
    expect(explainSelfCancelBlock(OrderStatus.CUT_OFF, true)).toBe('cutoff');
    expect(explainSelfCancelBlock(OrderStatus.DELIVERED, true)).toBe('cutoff');
  });

  it('未截单但状态已不可自助取消 → status（对应 30003）', () => {
    expect(explainSelfCancelBlock(OrderStatus.CUT_OFF, false)).toBe('status');
    expect(explainSelfCancelBlock(OrderStatus.REFUNDING, false)).toBe('status');
  });

  it('截单后是硬闸：即便状态为 pending_pay 也拒绝', () => {
    expect(explainSelfCancelBlock(OrderStatus.PENDING_PAY, true)).toBe('cutoff');
  });
});

describe('三视角文案与迁移表完整性', () => {
  it('三视角文案同源（用户/团长/后台可不同）', () => {
    expect(userStatusText(OrderStatus.PAID)).toBe('待出餐');
    expect(userStatusText(OrderStatus.CUT_OFF)).toBe('待出餐');
    expect(userStatusText(OrderStatus.REFUND_APPLYING)).toBe('退款申请中');
  });

  it('未知状态回落原值（不抛错，避免时间线渲染炸掉）', () => {
    expect(userStatusText('unknown_status')).toBe('unknown_status');
  });

  it('终态封闭：已取消/已退款无后继；主流程单向', () => {
    expect(canTransit(OrderStatus.CANCELLED, OrderStatus.PAID)).toBe(false);
    expect(canTransit(OrderStatus.REFUNDED, OrderStatus.COMPLETED)).toBe(false);
    expect(canTransit(OrderStatus.COMPLETED, OrderStatus.PAID)).toBe(false);
    expect(canTransit(OrderStatus.PAID, OrderStatus.CUT_OFF)).toBe(true);
  });
});

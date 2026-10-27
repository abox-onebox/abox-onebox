import { ORDER_TERMINAL_STATUS, OrderStatus } from '@abox/shared-types';

import { blindBoxView } from '../../src/common/utils/blind-box';

/**
 * X 盲盒视图判据（2026-10-27）
 *
 * ⚠️ 两条**沉默逻辑防线**（漏了不报错、不崩溃、悄悄泄底或挂幽灵占位）：
 *   ① 只有 delivered/completed 下发内容（**隐藏 ≠ 拦住**）；
 *   ② cancelled/refunded 一律不占位（否则「待揭晓」挂在永远不到达的单上，
 *      或退款后从「已揭晓」倒退回「待揭晓」）。
 * ⚠️ 断言一律用**枚举名**：枚举值一调整，字面量用例仍绿而判据已翻。
 */
describe('blindBoxView', () => {
  const NAME = '红烧肉盲盒';

  it('送达 / 完成 ⇒ 揭晓：占位 + 给内容', () => {
    expect(blindBoxView(OrderStatus.DELIVERED, NAME)).toEqual({ pending: true, name: NAME });
    expect(blindBoxView(OrderStatus.COMPLETED, NAME)).toEqual({ pending: true, name: NAME });
  });

  it('送达前一律只占位、不给内容（真遮蔽，抓包也拿不到）', () => {
    for (const s of [
      OrderStatus.PENDING_PAY,
      OrderStatus.PAID,
      OrderStatus.CUT_OFF,
      OrderStatus.COOKED,
      OrderStatus.DELIVERING,
    ]) {
      expect(blindBoxView(s, NAME)).toEqual({ pending: true, name: null });
    }
  });

  it('⭐ 取消单不再挂着「待揭晓」（这单永远等不到送达）', () => {
    expect(blindBoxView(OrderStatus.CANCELLED, NAME)).toEqual({ pending: false, name: null });
  });

  it('⭐ 已退款单不再从「已揭晓」倒退回「待揭晓」', () => {
    expect(blindBoxView(OrderStatus.REFUNDED, NAME)).toEqual({ pending: false, name: null });
  });

  it('退款申请中 / 退款中仍属未揭晓占位（未到终态，订单还有下文）', () => {
    expect(blindBoxView(OrderStatus.REFUND_APPLYING, NAME)).toEqual({ pending: true, name: null });
    expect(blindBoxView(OrderStatus.REFUNDING, NAME)).toEqual({ pending: true, name: null });
  });

  it('没抽到盲盒 ⇒ 整行不出现（历史订单 / 未开启）', () => {
    expect(blindBoxView(OrderStatus.PAID, null)).toEqual({ pending: false, name: null });
    expect(blindBoxView(OrderStatus.DELIVERED, null)).toEqual({ pending: false, name: null });
  });

  it('⭐ 列未加载（undefined）不得被当成「有惊喜」—— 这就是必须用 Boolean() 的原因', () => {
    expect(blindBoxView(OrderStatus.PAID, undefined)).toEqual({ pending: false, name: null });
    expect(blindBoxView(OrderStatus.CANCELLED, undefined)).toEqual({ pending: false, name: null });
  });

  it('⭐ 作废态由终态真源派生：终态新增（除 completed）时本判据自动跟着变', () => {
    for (const s of ORDER_TERMINAL_STATUS) {
      const v = blindBoxView(s, NAME);
      if (s === OrderStatus.COMPLETED) {
        expect(v).toEqual({ pending: true, name: NAME }); // 正常揭晓
      } else {
        expect(v.pending).toBe(false); // cancelled / refunded：作废
      }
    }
  });
});

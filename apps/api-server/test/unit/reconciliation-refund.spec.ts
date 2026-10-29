import {
  partitionRefundedDayLogs,
  refundedAndDroppedOrderIds,
  refundedDroppedTip,
} from '../../src/common/utils/reconciliation-refund';

/** 流水：只带归位判据需要的 orderId / 金额 */
function log(orderId: number | string, fen: number = 2580) {
  return { orderId, payAmount: fen / 100 };
}

describe('对账 · 当日付当日退的流水归位', () => {
  // ------------------------------------------------------------ 集合判据
  describe('refundedAndDroppedOrderIds', () => {
    it('已退款且订单不在当日已付款清单 ⇒ 归入剔除集合', () => {
      const out = refundedAndDroppedOrderIds([1, 2], [2, 97]);
      expect([...out]).toEqual([97]);
    });

    it('已退款但订单**仍在**当日已付款清单 ⇒ 不剔除（部分退款不能动）', () => {
      const out = refundedAndDroppedOrderIds([1, 2, 97], [97]);
      expect(out.size).toBe(0);
    });

    it('没退款的订单永不进剔除集合', () => {
      const out = refundedAndDroppedOrderIds([1], []);
      expect(out.size).toBe(0);
    });

    it('bigint 转出来的字符串 id 与数字 id 视为同一个', () => {
      const out = refundedAndDroppedOrderIds(['1', '2'], ['97']);
      expect([...out]).toEqual([97]);
    });
  });

  // ------------------------------------------------------------ 拆分
  describe('partitionRefundedDayLogs', () => {
    it('当日付当日整单退 ⇒ 流水被剔除，不参与判不平', () => {
      // 订单 97 已退款且不在 orders ⇒ 其流水剔除
      const r = partitionRefundedDayLogs([log(1), log(97), log(2)], [1, 2], [97]);
      expect(r.kept.map((l) => Number(l.orderId))).toEqual([1, 2]);
      expect(r.excludedRefunded.map((l) => Number(l.orderId))).toEqual([97]);
      expect(r.excludedOrderIds).toEqual([97]);
    });

    it('部分退款（订单仍在 orders）⇒ 流水**保留**（剔了会凭空多出 order_paid_no_log）', () => {
      const r = partitionRefundedDayLogs([log(5)], [5], [5]);
      expect(r.kept.length).toBe(1);
      expect(r.excludedRefunded.length).toBe(0);
    });

    it('未退款却不在 orders ⇒ **保留**（这才是真的「订单没推进」，不能误剔）', () => {
      const r = partitionRefundedDayLogs([log(88)], [1], []);
      expect(r.kept.map((l) => Number(l.orderId))).toEqual([88]);
      expect(r.excludedRefunded.length).toBe(0);
    });

    it('同一天多笔付退 ⇒ 全部剔除，excludedOrderIds 去重升序', () => {
      const r = partitionRefundedDayLogs([log(97), log(1), log(94)], [1], [97, 94, 97]);
      expect(r.kept.map((l) => Number(l.orderId))).toEqual([1]);
      expect(r.excludedOrderIds).toEqual([94, 97]);
    });

    it('orderId 取不到有效数字 ⇒ 一律保留（NaN 不能静默丢流水）', () => {
      const r = partitionRefundedDayLogs([log('abc'), log('')], [1], ['abc']);
      expect(r.kept.length).toBe(2);
      expect(r.excludedRefunded.length).toBe(0);
    });

    it('空流水 / 空集合不炸', () => {
      const r = partitionRefundedDayLogs([], [], []);
      expect(r.kept).toEqual([]);
      expect(r.excludedOrderIds).toEqual([]);
    });
  });

  // ------------------------------------------------------------ 复现 10-28 真实场景
  describe('复现 2026-10-28 误报', () => {
    it('剔除后两侧都是 7740 ⇒ diffFen=0、无差异 ⇒ 判平', () => {
      // 当日流水 3 笔：订单 1(2580) / 2(5160) / 97(5160) = 12900
      const dayLogs = [log(1, 2580), log(2, 5160), log(97, 5160)];
      // 订单侧只有 1、2 两单（97 已退被排除）= 7740
      const orderIds = [1, 2];
      // 当日已退款：订单 97（5160）与 94（2580）
      const refunded = [97, 94];

      const { kept } = partitionRefundedDayLogs(dayLogs, orderIds, refunded);
      const logFen = kept.reduce((s, l) => s + Math.round(l.payAmount * 100), 0);
      const orderFen = 2580 + 5160;

      expect(logFen).toBe(7740);
      expect(orderFen - logFen).toBe(0);
      // 未修复前：logFen=12900 ⇒ diffFen=-5160 ⇒ balanced=false（天天误报）
    });

    it('订单 94 当日有退款但它不是当日支付的 ⇒ 不影响（它本就不在流水里）', () => {
      const r = partitionRefundedDayLogs([log(1)], [1], [94]);
      expect(r.kept.length).toBe(1);
      expect(r.excludedRefunded.length).toBe(0);
    });
  });

  // ------------------------------------------------------------ 文案
  describe('refundedDroppedTip', () => {
    it('有剔除才给文案，且写明「不属当日实收」', () => {
      const tip = refundedDroppedTip(1);
      expect(tip).toContain('1 笔');
      expect(tip).toContain('已退回');
    });

    it('没剔除给空串（端上据此决定显不显示）', () => {
      expect(refundedDroppedTip(0)).toBe('');
      expect(refundedDroppedTip(-1)).toBe('');
    });
  });
});

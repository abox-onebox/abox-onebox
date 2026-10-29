/**
 * 对账 · 「当日付、当日退」的流水归位（纯判据，可单测）
 *
 * ## 为什么需要它
 * 对账按**支付日**取两侧：
 *   · 订单侧 `orders`  —— 过滤 `status NOT IN (排除态)` ⇒ **已退/已取消的订单不在里面**；
 *   · 流水侧 `daySuccessLogs` —— 只按 `paid_at` + 成功取，**不排除已退订单**。
 *
 * 于是「当日收款成功、随后整单退款」这一**完全正常**的业务流水，
 * 会因为「流水在、订单不在」被判成 `log_success_no_order`（钱收到了但订单没推进）——
 * 而它的钱其实已经退回去了（`ab_refund` 里有当日已退款记录）。
 *
 * 后果不是多一行显示而已：它同时把 `logFen` 抬高一笔 ⇒ `diffFen ≠ 0` ⇒
 * **`balanced=false`**，即**只要当天有「付了又退」的单就天天误报不平**。
 * 告警天天响 = 真出事时没人看。
 *
 * ## 判据（关键：只在「订单也不在当日已付款清单」时才剔除）
 * 必须**同时**满足两条才算「已归位的退款流水」：
 *   ① 该订单当日有**已退款**记录；
 *   ② 该订单**不在**当日已付款订单清单里（⇒ 订单已终态，两侧都不该出现）。
 *
 * ⚠️ 少了 ② 会造出新缺陷：部分退款时订单仍在 `orders` 里（未终态），
 *    若把它的流水剔掉，反而凭空多出一条 `order_paid_no_log`（订单已付款、流水缺失）。
 *
 * ## 只影响金额口径，不影响凭证检查
 * 剔除只用于 `logFen` / `logCount` / 「流水→订单」差异检测；
 * **重复交易号检测仍看全量流水**（凭证重复是重复入账的前兆，与退款无关）。
 */

/** 参与归位判断所需的最小流水形状 */
export interface ReconLogLike {
  /** 可能是 number 也可能是 bigint 转换后的 string */
  orderId: number | string;
}

export interface PartitionedDayLogs<T extends ReconLogLike> {
  /** 参与对账（金额合计 + 「流水→订单」差异检测）的流水 */
  kept: T[];
  /** 被剔除的「当日付当日退」流水（仅供留痕/排查，不参与判不平） */
  excludedRefunded: T[];
  /** 被剔除的订单 id（去重、升序）—— 留痕里能一眼看出剔了哪几单 */
  excludedOrderIds: number[];
}

const num = (v: number | string): number => Number(v);

/**
 * 求「当日已退款 **且** 订单不在当日已付款清单」的订单 id 集合
 *
 * @param dayOrderIds        当日已付款订单 id（`orders` 的 id 集合）
 * @param dayRefundedOrderIds 当日有已退款记录的订单 id
 */
export function refundedAndDroppedOrderIds(
  dayOrderIds: Iterable<number | string>,
  dayRefundedOrderIds: Iterable<number | string>,
): Set<number> {
  const inOrders = new Set<number>();
  for (const id of dayOrderIds) inOrders.add(num(id));

  const out = new Set<number>();
  for (const id of dayRefundedOrderIds) {
    const n = num(id);
    if (!inOrders.has(n)) out.add(n);
  }
  return out;
}

/**
 * 按上述集合把当日成功流水拆成「参与对账」与「已退款剔除」两堆
 *
 * ⚠️ `orderId` 取不到有效数字时**一律保留**（`NaN` 不该静默把流水丢掉 ——
 *    丢掉流水会让 `logFen` 变小，属于「改数据让账平」，比误报危险得多）。
 */
export function partitionRefundedDayLogs<T extends ReconLogLike>(
  dayLogs: readonly T[],
  dayOrderIds: Iterable<number | string>,
  dayRefundedOrderIds: Iterable<number | string>,
): PartitionedDayLogs<T> {
  const dropped = refundedAndDroppedOrderIds(dayOrderIds, dayRefundedOrderIds);

  const kept: T[] = [];
  const excludedRefunded: T[] = [];
  for (const l of dayLogs) {
    const n = num(l.orderId);
    if (Number.isFinite(n) && dropped.has(n)) excludedRefunded.push(l);
    else kept.push(l);
  }

  return {
    kept,
    excludedRefunded,
    excludedOrderIds: [...dropped].sort((a, b) => a - b),
  };
}

/**
 * 「当日付当日退」的说明文案（写进留痕/排查提示）
 *
 * 为什么要显式说：剔除后 `logFen` 不再等于当天支付流水的原额合计，
 * 运营拿它去和流水总数对会发现对不上 —— 不说就变成下一个「看起来像 bug」。
 */
export function refundedDroppedTip(excludedCount: number): string {
  if (excludedCount <= 0) return '';
  return `当日收款后已整单退款的流水 ${excludedCount} 笔已从对账视野剔除（钱已退回，不属于当日实收）`;
}

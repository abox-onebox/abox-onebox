/**
 * 停用闸门决策（N2 · 纯函数 · 见 `docs/specs/PHASE3-N1N2W1-落码规格.md` §6.0）
 *
 * 「停用一栋楼 / 一个楼群之前要不要拦」里，有三条是**沉默逻辑防线** —— 漏了不报错、
 * 不崩溃、悄悄少拦，e2e 还全绿。只有把它们抽成不依赖 repository 的纯函数，才能被
 * jest 逐条钉死；埋在 service 里就没有任何东西能验它们。
 *
 * ⚠️ 零 IO / 零 DI / **不读时钟**，且**连 `nowMs` 参数都没有** —— 时间只出现在 IO 层的
 *    计数查询里（`mealDate >= todayBj()`），决策本身完全无时间维度。这比「收 `nowMs`
 *    以便注入」更强：**没有时间参数的决策函数，结构上不可能随时间漂移**。
 *
 * ⚠️ 不抛异常（抛什么是调用方的契约责任）、不读配置（`threshold` 由调用方传入）、
 *    不做字数校验（`suspendReason` 的 ≥10 字归 DTO `@MinLength`，这儿再判就是第二份校验）。
 */
import { ORDER_TERMINAL_STATUS, OrderStatus } from '@abox/shared-types';

/** A 组 · 履约中（不可撤回）—— 供应商已按份数备货，运营无权通过停用撤回 */
export const ORDER_FULFILLING_STATUS: readonly OrderStatus[] = [
  OrderStatus.CUT_OFF,
  OrderStatus.COOKED,
  OrderStatus.DELIVERING,
  OrderStatus.DELIVERED,
];

/** B 组 · 可放行 —— 未截单，或退款已在自己的通道里走（停用不推进也不阻断它） */
export const ORDER_RELEASABLE_STATUS: readonly OrderStatus[] = [
  OrderStatus.PENDING_PAY,
  OrderStatus.PAID,
  OrderStatus.REFUND_APPLYING,
  OrderStatus.REFUNDING,
];

/**
 * 未完结谓词 —— **全仓唯一实现**，禁止在别处再写一份 `Not(In([...]))`
 *
 * ⚠️ 必须**反算**（`ORDER_TERMINAL_STATUS` 之外皆未完结），禁止硬编码未完结清单：
 *    硬编码白名单是 fail-open —— 将来状态机新增非终态时它默认放行且无任何信号；
 *    反算是 fail-closed，新增状态自动受拦，无需改这里。
 */
export function isUnfinished(status: string): boolean {
  return !ORDER_TERMINAL_STATUS.includes(status as OrderStatus);
}

/**
 * A/B 组别 —— **每次调用现算**，不得缓存、不得落库、不得从订单快照字段读
 *
 * ⚠️ `cut_off` 是时间派生态：同一笔订单会在午夜从 B 组变成 A 组 —— 运营 23:55 能用
 *    「force + reason」逃生舱，00:05 就没了，期间没有任何配置变化。组别一旦被当成
 *    静态属性写死，23:59 与 00:01 会给出同一结论，其中一个必然错。
 *
 * ⚠️ 未知状态取**保守侧归 A**（不可撤回）：B 组的含义是「运营有权撤回」，不认识的状态
 *    不能凭空授予这个权限。故用 B 组白名单判定，落榜者一律 A —— 与 `isUnfinished`
 *    的反算同一精神（不认识 ⇒ 不放行）。
 */
export function groupOf(status: string): 'A' | 'B' | 'terminal' {
  if (ORDER_TERMINAL_STATUS.includes(status as OrderStatus)) return 'terminal';
  if (ORDER_RELEASABLE_STATUS.includes(status as OrderStatus)) return 'B';
  /**
   * 剩下的都是 A 组 —— 含「状态机将来新增、还没归类的非终态」（保守侧，见本方法头）。
   *
   * ⚠️ `ORDER_FULFILLING_STATUS` 因此**不参与本函数的判定**，它是 **A 组的显式清单
   *    （oracle）**：`test/unit/suspend-gate.spec.ts` 断言「本函数的结论 ≡ 两张显式
   *    清单」，从而把「将来新增的第 12 个状态没被归类」变成**红灯**而不是静默落进 A。
   *    若在这里直接查它，未知状态就会落到 `else` 分支 —— 那要么再写一个恒等于 A 的
   *    三元（形同虚设），要么把未知状态判成 B（fail-open）。
   */
  return 'A';
}

export type SuspendScope = 'building' | 'building_group';

export interface SuspendCounts {
  total: number; // 8 态未完结总数
  groupA: number; // A 组：已进入履约
  groupB: number; // B 组：可放行
  refundStuck: number; // refund_applying / refunding
  fulfillPending: number; // pending_pay / paid
  aOrderNos: string[];
  earliestMealDate: string | null;
  /** 出参样例（只给用户看，不参与任何判定） */
  samples: Array<{ orderNo: string; mealDate: string; statusLabel: string }>;
}

export type SuspendBlockReason =
  | 'irrevocable' // A 组 > 0 —— 硬约束，force 无效，不可配置
  | 'threshold_exceeded' // N > 阈值 —— force 也无效，走审批
  | 'unfinished_orders'; // 1 ≤ N ≤ 阈值 且未 force

export type SuspendDecision =
  | { kind: 'allow' } // N = 0
  | { kind: 'allow_forced' } // 1 ≤ N ≤ 阈值 + force ⇒ 放行，但必须审计 + 通知
  | { kind: 'block'; reason: SuspendBlockReason };

export interface SuspendGateInput {
  scope: SuspendScope;
  targetSuspended: boolean; // 目标状态是否为「停用」
  counts: SuspendCounts;
  threshold: number; // building.suspend_force_max_count
  forceSuspend: boolean;
}

/**
 * 闸门决策 —— **求值顺序即决策，不要调换**
 *
 * 1. 目标不是「停用」⇒ allow（启用方向本闸门不介入）
 * 2. A 组 > 0 ⇒ 60013（硬约束，force 无效）
 * 3. N = 0 ⇒ allow；N > 阈值 ⇒ 60012（force 也无效，走审批）
 * 4. 1 ≤ N ≤ 阈值：force ⇒ allow_forced；否则 unfinished_orders
 */
export function decideSuspend(i: SuspendGateInput): SuspendDecision {
  if (!i.targetSuspended) return { kind: 'allow' };
  if (i.counts.groupA > 0) return { kind: 'block', reason: 'irrevocable' };
  if (i.counts.total === 0) return { kind: 'allow' };
  if (i.counts.total > i.threshold) return { kind: 'block', reason: 'threshold_exceeded' };
  return i.forceSuspend ? { kind: 'allow_forced' } : { kind: 'block', reason: 'unfinished_orders' };
}

/** (scope, reason) → 错误码：60006 / 60007 按作用域分，60012 / 60013 与作用域无关 */
export type SuspendBlockCode = 60006 | 60007 | 60012 | 60013;

export function suspendBlockCode(scope: SuspendScope, r: SuspendBlockReason): SuspendBlockCode {
  if (r === 'irrevocable') return 60013;
  if (r === 'threshold_exceeded') return 60012;
  return scope === 'building' ? 60006 : 60007;
}

/**
 * hint 分支 —— 「卡在退款审批」与「待履约」必须分开
 *
 * ⚠️ `refund_applying` / `refunding` 和 `paid` 一样会被闸门拦下，但运营该做的动作
 *    完全不同（去点退款审批 vs 等配送）。不区分的后果是运营反复重试停用，把一次
 *    配置疏漏变成一串无效操作日志。
 */
export type SuspendHintKey = 'refund_stuck' | 'fulfill_pending' | 'irrevocable' | 'threshold';

export function hintKeyOf(c: SuspendCounts, r: SuspendBlockReason): SuspendHintKey {
  if (r === 'irrevocable') return 'irrevocable';
  if (r === 'threshold_exceeded') return 'threshold';
  return c.refundStuck > 0 ? 'refund_stuck' : 'fulfill_pending';
}

/**
 * X 盲盒「视图判据」（**唯一真源** · 2026-10-27）
 *
 * 为什么单独抽出来：原先这段逻辑是 `order.service.ts` 里的一行三元表达式，
 * 而全仓**没有 order.service 的单元测试**（`test/unit/` 只有纯函数级用例）⇒
 * 判据写在服务里就是「改了没人拦」，重构时极易悄悄退化。
 * 本仓已在 `suspend-gate.ts` / `orderability.ts` 上验证过「纯函数 + jest 钉死」
 * 这条路有效，盲盒照做一份。
 *
 * ⚠️ 边界：只回答「**这一刻该给用户看什么**」—— 不取数（服务层职责）、
 *    不读时钟、零 IO、零 DI。输入就是「状态 + 库里落的值」两个量。
 *
 * ⭐⭐ **两条判据都要对**（2026-10-27 复核新增第二条）：
 *   1. **送达才揭晓**：只有 `delivered` / `completed` 下发内容。
 *      「隐藏 ≠ 拦住」—— 早前是无条件下发、靠端上不显示，抓一次包就泄底。
 *   2. **终态不再占位**：`cancelled` / `refunded` 一律 `pending=false`。
 *      否则 ① 下单后取消 ⇒ 挂着「待揭晓」而这单**永远等不到送达**；
 *      ② 已送达再退款 ⇒ 内容从「已揭晓」**倒退回**「待揭晓」。
 */
import { ORDER_TERMINAL_STATUS, OrderStatus } from '@abox/shared-types';

/** 已揭晓：只有这两个状态下发内容（含首尾：送达即算） */
const REVEALED_STATUS: ReadonlySet<string> = new Set<string>([
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
]);

/**
 * 盲盒作废态 = **终态里除 `completed` 之外的那些**。
 *
 * ⭐ 必须从 `ORDER_TERMINAL_STATUS` **派生**，不能自造一份字面量数组 ——
 *    终态真源就在 shared-types（`order-status.ts`），再抄一份就是本项目一直在治的
 *    「判据两份：终态定义一改，这边还停在旧集合，且不会报错」。
 * ⚠️ 为什么排除 `completed`：它是「送达且已完成」，属**正常揭晓**路径，
 *    与「订单没下文了」是两回事（前者要看内容，后者连占位都不该留）。
 */
const VOID_STATUS: ReadonlySet<string> = new Set<string>(
  ORDER_TERMINAL_STATUS.filter((s) => s !== OrderStatus.COMPLETED).map((s) => String(s)),
);

export interface BlindBoxView {
  /** 只回答「有没有惊喜」，不含内容，可安全下发 */
  pending: boolean;
  /** 已揭晓才有值；其余一律 null */
  name: string | null;
}

/**
 * @param status        `ab_order.status`
 * @param blindBoxName  库里落的值（下单时随机抽的）；列未加载时为 `undefined`
 *
 * ⚠️ **判「有没有值」一律用 `Boolean()`**：实体列类型是
 *    `string | null | undefined`，而 `undefined !== null` 为 **true** ——
 *    `!== null` 会把「没查这个字段」误判成「有惊喜」。
 */
export function blindBoxView(
  status: string | null | undefined,
  blindBoxName: string | null | undefined,
): BlindBoxView {
  // 作废态优先：订单终止 ⇒ 盲盒作废（既不揭晓、也不挂占位行）
  if (status && VOID_STATUS.has(status)) return { pending: false, name: null };
  // 没抽到盲盒（历史订单 / 未开启）：整行不出现
  if (!blindBoxName) return { pending: false, name: null };
  const revealed = REVEALED_STATUS.has(status ?? '');
  return { pending: true, name: revealed ? (blindBoxName ?? null) : null };
}

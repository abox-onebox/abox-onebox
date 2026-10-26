import { OrderStatus, ORDER_TERMINAL_STATUS } from '@abox/shared-types';

import { isUnfinished } from '../../src/common/utils/suspend-gate';

/**
 * N2 · 未完结订单的 8 态全覆盖（AC **B2-2 / B2-3**）
 * 裁决来源：`docs/qa/AC-N1N2W1-楼宇停用与一键停售.md` §0.2 裁决 0-A
 *
 * ── 为什么这一条要单独钉死 ──────────────────────────────────────────────────
 * 「未完结」有两种写法：
 *
 *   ① **黑名单反算**：`NOT IN (completed, cancelled, refunded)` —— 3 项，从终态反推
 *   ② **6 态白名单**：`IN (pending_pay, paid, cut_off, cooked, delivering, delivered)`
 *
 * ② 的失效方式是**沉默**的：它不报错、不崩溃、不停用，只是**悄悄少拦两单**
 * （`refund_applying` 退款申请中 / `refunding` 退款中）。运营看着「该楼无未完结订单」
 * 点了停用，而那两笔钱还在退款流程里 —— e2e 会全绿，因为没有任何断言问过这两个状态。
 *
 * ⇒ 本文件的核心断言是**反白名单**：明确要求 `refund_applying` / `refunding`
 *    **必须**计入未完结。它俩一旦被排除，本文件立刻红。
 *
 * ── 为什么断言「枚举覆盖」而不只是「8 这个数字」 ────────────────────────────
 * 只断言 `unfinished.length === 8`，将来新增第 12 个状态时：
 *    · 若新状态既没进终态也没进未完结集 ⇒ 它会被**当成未完结**（黑名单反算的天然行为）
 *      —— 严格说这是「宁可多拦」的保守方向，但**它是不是想要的没人问过**；
 *    · 若有人顺手把它加进终态 ⇒ 8 变 7，**没有断言会发现这是错的**。
 * ⇒ 故本文件断言**不变量**：`未完结 ∪ 终态 ≡ 全枚举` 且 `未完结 ∩ 终态 = ∅`。
 *   任何一个新状态没被显式归类，或者被归错类，这里都会红。
 *
 * ── ✅ 已收口（P3-5 落地后更新，别再按旧注释理解）────────────────────────
 * 生产谓词已抽成纯函数 `common/utils/suspend-gate.ts` 的 `isUnfinished()`，
 * 本文件**已改为 import 生产实现**，本地那一份替身**已删除**。
 *
 * ⇒ 为什么这一步必须做而不是「能跑就行」：留着本地那份，这里测的就是**第二份判据**
 *    —— 与本批 N1 要治的病（同一件事多处理述、各自漂移）是**同一个病**，只是换了个
 *    文件重演。届时 `suspend-gate.ts` 里的谓词被改坏，本文件照样全绿。
 *
 * ⚠️ 本文件仍断言 `ORDER_TERMINAL_STATUS`（终态恰好 3 项）—— 那不是第二份判据，
 *    是**被判定据所依赖的输入**：谓词是「终态之外皆未完结」，输入错了谓词必然错，
 *    两边都断言才覆盖得住（只断言谓词的话，把常量改成 4 项它依然「自洽」）。
 */
const ALL_STATUSES = Object.values(OrderStatus);

const UNFINISHED = ALL_STATUSES.filter(isUnfinished);

describe('B2-2 · 未完结 = 8 态，且必须是黑名单反算', () => {
  /** ⚠️ 断言 3 项而不是 8 项，是**刻意**的：写白名单的人会把 `ORDER_TERMINAL_STATUS`
   *  改成 8 项的未完结清单，那时「未完结 = 8」这条仍然绿。断言**终态只有 3 项**
   *  才是在守「反算」这个**写法**，而不只是守数字。 */
  it('★ 终态集合恰好 3 项 ⇒ 证明是黑名单反算，不是 6 态白名单', () => {
    expect(ORDER_TERMINAL_STATUS).toHaveLength(3);
    expect([...ORDER_TERMINAL_STATUS].sort()).toEqual(
      [OrderStatus.CANCELLED, OrderStatus.COMPLETED, OrderStatus.REFUNDED].sort(),
    );
  });

  it('未完结恰好 8 项', () => {
    expect(UNFINISHED).toHaveLength(8);
  });

  /** ⚠️ 这两条是本文件的**全部价值所在**：6 态白名单漏掉的正是这两个退款中间态。
   *  它们不报错、不崩溃，只是悄悄少拦 —— 除了这两行，没有任何东西会问起它们。 */
  it('★ refund_applying（退款申请中）必须计入未完结', () => {
    expect(isUnfinished(OrderStatus.REFUND_APPLYING)).toBe(true);
    expect(UNFINISHED).toContain(OrderStatus.REFUND_APPLYING);
  });

  it('★ refunding（退款中）必须计入未完结', () => {
    expect(isUnfinished(OrderStatus.REFUNDING)).toBe(true);
    expect(UNFINISHED).toContain(OrderStatus.REFUNDING);
  });

  /** 不变量：任何一个成员状态都必须被**显式**归类到一侧，且只能一侧。
   *  ⇒ 将来新增状态而忘了归类，或归错类，这里会红 —— 而不会悄悄落进某一侧。 */
  it('★ 不变量：未完结 ∪ 终态 ≡ 全枚举，且两者无交集', () => {
    expect(ALL_STATUSES).toHaveLength(11);
    for (const s of ALL_STATUSES) {
      const inUnfinished = UNFINISHED.includes(s);
      const inTerminal = ORDER_TERMINAL_STATUS.includes(s);
      expect(inUnfinished || inTerminal).toBe(true); // 必须被归类
      expect(inUnfinished && inTerminal).toBe(false); // 不得两侧都有
    }
    expect(UNFINISHED.length + ORDER_TERMINAL_STATUS.length).toBe(ALL_STATUSES.length);
  });

  /** 逐一列出 8 态 —— 不是为了凑数，是为了**漏掉的那一个会自己说话**：
   *  用 `toHaveLength(8)` 只能知道「少了一个」，用这份清单能直接看到少了**哪一个**。 */
  it('8 个未完结态逐一断言', () => {
    expect([...UNFINISHED].sort()).toEqual(
      [
        OrderStatus.PENDING_PAY,
        OrderStatus.PAID,
        OrderStatus.CUT_OFF,
        OrderStatus.COOKED,
        OrderStatus.DELIVERING,
        OrderStatus.DELIVERED,
        OrderStatus.REFUND_APPLYING,
        OrderStatus.REFUNDING,
      ].sort(),
    );
  });
});

describe('B2-3 · 三个终态 ⇒ 未完结数为 0 ⇒ 允许停用', () => {
  it.each([
    ['completed', OrderStatus.COMPLETED],
    ['cancelled', OrderStatus.CANCELLED],
    ['refunded', OrderStatus.REFUNDED],
  ])('%s 不计入未完结', (_label, status) => {
    expect(isUnfinished(status)).toBe(false);
  });

  it('三个终态各一笔 ⇒ 未完结计数为 0 ⇒ 停用放行', () => {
    const orders = [OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.REFUNDED];
    expect(orders.filter(isUnfinished)).toHaveLength(0);
  });

  /** ⚠️ 这条守的是 B2-2 与 B2-3 的**边界不是同一条线**：
   *  `refunded`（已退款，钱已到账 + 反向结算完成）是终态 ⇒ 放行；
   *  `refunding`（退款中，钱还在通道里）是未完结 ⇒ 拦。
   *  两者只差一个字母，且都属于「这笔订单的退款流程」—— 混淆它们的后果是
   *  在钱还没退回去的时候把楼停了。 */
  it('★ refunded 放行 与 refunding 拦截 是两条不同的线', () => {
    expect(isUnfinished(OrderStatus.REFUNDED)).toBe(false);
    expect(isUnfinished(OrderStatus.REFUNDING)).toBe(true);
  });
});

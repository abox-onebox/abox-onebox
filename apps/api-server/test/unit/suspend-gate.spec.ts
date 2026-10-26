import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ORDER_TERMINAL_STATUS, OrderStatus } from '@abox/shared-types';

import {
  ORDER_FULFILLING_STATUS,
  ORDER_RELEASABLE_STATUS,
  SuspendBlockReason,
  SuspendCounts,
  SuspendGateInput,
  decideSuspend,
  groupOf,
  hintKeyOf,
  isUnfinished,
  suspendBlockCode,
} from '../../src/common/utils/suspend-gate';

/**
 * 停用闸门决策（N2 · spec §6.0）⚠️ 三条**沉默逻辑防线**：漏了不报错、不崩溃、悄悄少拦，
 * e2e 还全绿 —— ① 8 态反算含 `refund_applying` / `refunding`；② A/B 组别每次现算；
 * ③ hint 要区分退款审批与待履约。⚠️ 断言一律用枚举名：枚举值一调整，字面量用例仍绿而判据已翻。
 */
const counts = (c: Partial<SuspendCounts>): SuspendCounts => ({
  total: 0,
  groupA: 0,
  groupB: 0,
  refundStuck: 0,
  fulfillPending: 0,
  aOrderNos: [],
  earliestMealDate: null,
  samples: [],
  ...c,
});

const gate = (i: Partial<SuspendGateInput>): SuspendGateInput => ({
  scope: 'building',
  targetSuspended: true,
  counts: counts({}),
  threshold: 20,
  forceSuspend: false,
  ...i,
});

/** 期望「拦下」的简写，省得每条断言都展开成三行 */
const blocked = (reason: SuspendBlockReason) => ({ kind: 'block' as const, reason });

describe('isUnfinished（8 态反算）', () => {
  /** ⚠️ 本批头号防线：用 6 态白名单的实现会**少拦这两单**且无任何信号，e2e 全绿。 */
  it('★ refund_applying / refunding 必须是未完结（防硬编码白名单 fail-open）', () => {
    expect(isUnfinished(OrderStatus.REFUND_APPLYING)).toBe(true);
    expect(isUnfinished(OrderStatus.REFUNDING)).toBe(true);
  });
});

describe('groupOf + A/B 翻转', () => {
  /** ⚠️ **不要用 ABOX_SHIFT_TO_HOUR 做跨零点**：它跨不了零点，且这条验的是「状态变了 ⇒ 组别
   *    变了」，与墙钟无因果关系。同一笔单跨过截单就该换组，与几点钟无关。 */
  it('★ 同一笔订单：paid ⇒ B 组（可 force），cut_off ⇒ A 组（force 无效）', () => {
    expect(groupOf(OrderStatus.PAID)).toBe('B');
    expect(groupOf(OrderStatus.CUT_OFF)).toBe('A');

    const b = counts({ total: 1, groupB: 1, fulfillPending: 1 });
    expect(decideSuspend(gate({ counts: b }))).toEqual(blocked('unfinished_orders'));
    // B 组换组前：force 能放行
    expect(decideSuspend(gate({ counts: b, forceSuspend: true }))).toEqual({
      kind: 'allow_forced',
    });

    // 同一笔单推进到 cut_off：结论必须翻成硬约束，且 force 也救不回来
    const a = counts({ total: 1, groupA: 1, aOrderNos: ['A1'] });
    expect(decideSuspend(gate({ counts: a }))).toEqual(blocked('irrevocable'));
    expect(decideSuspend(gate({ counts: a, forceSuspend: true }))).toEqual(blocked('irrevocable'));
    // 未知状态按保守侧归 A 组（不凭空授予「可撤回」权限）；终态归 terminal
    expect(groupOf('some_future_status')).toBe('A');
    expect(groupOf(OrderStatus.COMPLETED)).toBe('terminal');
  });

  /** `ORDER_FULFILLING_STATUS` 是 **A 组的显式清单（oracle）**，不参与 `groupOf()` 判定
   *  （未知态须保守归 A）—— 这里断言「推导结论 ≡ 显式清单」。 */
  it('★ 三表并集 = 全枚举，且 groupOf / isUnfinished 与之一致（忘归类 ⇒ 红灯）', () => {
    const all = Object.values(OrderStatus);
    const sum =
      ORDER_TERMINAL_STATUS.length +
      ORDER_RELEASABLE_STATUS.length +
      ORDER_FULFILLING_STATUS.length;
    expect(sum).toBe(all.length);
    for (const s of all) {
      const want = ORDER_TERMINAL_STATUS.includes(s)
        ? 'terminal'
        : ORDER_RELEASABLE_STATUS.includes(s)
          ? 'B'
          : 'A';
      expect(groupOf(s)).toBe(want);
      // ⭐ 顺带覆盖 `isUnfinished` 的**全枚举**（不只 9 个已知态）：终态之外皆未完结
      expect(isUnfinished(s)).toBe(want !== 'terminal');
    }
  });
});

describe('decideSuspend 分级边界', () => {
  it('★ N = threshold：未 force ⇒ unfinished_orders；force ⇒ allow_forced', () => {
    const at = counts({ total: 20, groupB: 20 });
    expect(decideSuspend(gate({ counts: at }))).toEqual(blocked('unfinished_orders'));
    expect(decideSuspend(gate({ counts: at, forceSuspend: true }))).toEqual({
      kind: 'allow_forced',
    });
  });

  it('★ N = threshold + 1 ⇒ threshold_exceeded，force 也无效（走审批）', () => {
    const over = counts({ total: 21, groupB: 21 });
    expect(decideSuspend(gate({ counts: over }))).toEqual(blocked('threshold_exceeded'));
    expect(decideSuspend(gate({ counts: over, forceSuspend: true }))).toEqual(
      blocked('threshold_exceeded'),
    );
  });

  it('N = 0 ⇒ allow；目标不是停用 ⇒ allow（启用方向闸门不介入）', () => {
    expect(decideSuspend(gate({}))).toEqual({ kind: 'allow' });
    const enable = gate({ targetSuspended: false, counts: counts({ total: 99 }) });
    expect(decideSuspend(enable)).toEqual({ kind: 'allow' });
  });
});

describe('hintKeyOf + suspendBlockCode（出参形状）', () => {
  it('★ 卡退款审批 vs 待履约必须分开；A 组 / 超阈值各有专属 hint', () => {
    expect(hintKeyOf(counts({ refundStuck: 2 }), 'unfinished_orders')).toBe('refund_stuck');
    expect(hintKeyOf(counts({ fulfillPending: 2 }), 'unfinished_orders')).toBe('fulfill_pending');
    expect(hintKeyOf(counts({ groupA: 1 }), 'irrevocable')).toBe('irrevocable');
    expect(hintKeyOf(counts({ total: 99 }), 'threshold_exceeded')).toBe('threshold');
  });

  it('60006 / 60007 按作用域分；60012 / 60013 与作用域无关', () => {
    expect(suspendBlockCode('building', 'unfinished_orders')).toBe(60006);
    expect(suspendBlockCode('building_group', 'unfinished_orders')).toBe(60007);
    expect(suspendBlockCode('building', 'threshold_exceeded')).toBe(60012);
    expect(suspendBlockCode('building_group', 'threshold_exceeded')).toBe(60012);
    expect(suspendBlockCode('building', 'irrevocable')).toBe(60013);
  });
});

describe('纯函数约束', () => {
  const src = readFileSync(join(__dirname, '../../src/common/utils/suspend-gate.ts'), 'utf8');
  it('★ 不读时钟、不取数：无参 new Date() / Date.now() / Repository 命中数为 0', () => {
    expect(src.match(/new\s+Date\(\s*\)/g) ?? []).toHaveLength(0);
    expect(src.match(/Date\.now\s*\(/g) ?? []).toHaveLength(0);
    expect(src).not.toMatch(/Repository/);
  });
});

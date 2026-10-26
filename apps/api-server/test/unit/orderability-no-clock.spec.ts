import {
  evaluateStructure,
  evaluateAvailability,
  reasonText,
  type AvailabilityInput,
} from '../../src/common/utils/orderability';

/**
 * N1-2 · `orderability.ts` **不读环境时钟**（AC §C.1.3 / G11）
 *
 * ── 为什么这条必须写成 jest，不能写成静态判据 ────────────────────────────────
 * 静态那条（`check-n1n2-w1-suspend-rules.mjs` 的 `N1-2`）**已降级为提示项**，
 * 因为它的**判据形态与约束形态不匹配**（G11）：
 *
 *   约束 = 运行时不读环境时钟（**行为**）
 *   静态 = 文件里不出现 `Date.now()` 字样（**结构**）
 *
 * ⇒ 架构师给了反例：在文件顶部插一行 `const x = Date.now();`，
 *   **不动任何 import、不碰任何签名**，静态判据照样全绿 —— 而约束已被违反。
 * ⇒ **判据的绿和约束的绿可以是相反的。** 行为约束只能由跑得起来的检查守。
 *
 * ── 这条 spec 怎么守 ────────────────────────────────────────────────────────
 * 用**探针替换全局 `Date`**，在调用谓词期间记录：
 *   ① `Date.now()` 的调用次数
 *   ② **无参** `new Date()` 的构造次数
 *
 * ⚠️ **只记无参 `new Date()`**：`reasonText()` 里的 `new Date(ctx.publishAtMs)`
 *    是**毫秒 → Date 的纯换算**（入参由调用方注入），那是本文件「不读时钟」原则的
 *    **正面 exemplar**，把它判成违规就是逼人删掉正确写法。
 *    ⇒ 判据盯的是「**从哪拿时间**」，不是「有没有用到 Date 这个类型」。
 *
 * ── 变异自证（本文件必须能被证明会失败）────────────────────────────────────
 * 在 `orderability.ts` 顶部临时插一行 `const __probe = Date.now();` 后跑本文件：
 *   预期 ⇒ 「Date.now 零调用」那几条**变红**。
 * 已实测，见 AC §C.6.3 的变异留痕表第 6 行。
 */

// ── 探针 ────────────────────────────────────────────────────────────────────
type Tally = { nowCalls: number; noArgDates: number };
const tally: Tally = { nowCalls: 0, noArgDates: 0 };

const RealDate = globalThis.Date;

/** 装探针；返回 tally 快照的读取器 */
function installProbe(): void {
  class ProbeDate extends RealDate {
    // ⚠️ 形参必须写成 `any[]`：`ConstructorParameters<typeof Date>` 只取**第一个**重载
    //    （定长元组）⇒ TS 把 `args.length` 收窄成字面量 `1` ⇒ `=== 0` 被判为不可能比较。
    //    而我们要区分的恰恰是**实参个数**（0 个 = 读时钟，有参 = 纯换算），
    //    重载签名在这里不是我们要的信息。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 必须 any[]：ConstructorParameters<typeof Date> 只取首个重载，会把 args.length 收窄成字面量 1，破坏「无参=读时钟 / 有参=纯换算」判定
    constructor(...args: any[]) {
      // ⚠️ 不能直接 `super(...args)`：`Date` 的构造重载都不是 rest 参数，
      //    TS 因此拒绝展开 `any[]`（TS2556）。按实参个数分派到具体重载即可 ——
      //    分派本身也让「无参 / 有参」这两种形态在代码里显式可见。
      if (args.length === 0) super();
      else if (args.length === 1) super(args[0]);
      else super(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
      if (args.length === 0) tally.noArgDates += 1;
    }
    static now(): number {
      tally.nowCalls += 1;
      return RealDate.now();
    }
  }
  globalThis.Date = ProbeDate as unknown as DateConstructor;
}

function reset(): void {
  tally.nowCalls = 0;
  tally.noArgDates = 0;
}

afterEach(() => {
  globalThis.Date = RealDate;
  reset();
});

/** 跑一段代码并给出期间的时钟读取计数 */
function during<T>(fn: () => T): { value: T } & Tally {
  installProbe();
  reset();
  let value: T;
  try {
    value = fn();
  } finally {
    globalThis.Date = RealDate;
  }
  return { value: value!, nowCalls: tally.nowCalls, noArgDates: tally.noArgDates };
}

// ── 入参 ────────────────────────────────────────────────────────────────────
const SCOPE = { buildingStatus: 1, buildingGroupId: 7, buildingGroupStatus: 1 };

const INPUT: AvailabilityInput = {
  ...SCOPE,
  assignmentStatus: 'active',
  salesPaused: false,
  cutoffWindowMinutes: 30,
  publishAtMs: Date.UTC(2026, 9, 26, 10, 0),
  cutoffAtMs: Date.UTC(2026, 9, 27, 0, 0),
  nowMs: Date.UTC(2026, 9, 26, 12, 0),
};

// ── 用例 ────────────────────────────────────────────────────────────────────
describe('N1-2 · orderability 不读环境时钟（行为判据 · 静态守不住）', () => {
  /** ⚠️ **这条是下面所有「零调用」断言的前提**：如果探针本身记不到东西，
   *  那「零调用」就可能是「探针坏了」，而不是「真的没读」。
   *  ⇒ **判据必须能证明自己会失败** —— 先证明探针抓得住，再信它的零。 */
  it('★ 探针自证：装了探针后 Date.now() / 无参 new Date() 确实被记录', () => {
    installProbe();
    reset();
    try {
      RealDate.now(); // 走原实现 ⇒ 不应被计
      expect(tally.nowCalls).toBe(0);

      Date.now(); // 走探针 ⇒ 应被计
      // eslint-disable-next-line no-new
      new Date(); // 无参 ⇒ 应被计
      // eslint-disable-next-line no-new
      new Date(1_700_000_000_000); // 有参 ⇒ **不应**被计
    } finally {
      globalThis.Date = RealDate;
    }
    expect(tally.nowCalls).toBe(1);
    expect(tally.noArgDates).toBe(1);
  });

  /** ⚠️ **这条补的是本文件最大的一个洞 —— 变异自证抓出来的**：
   *  首版只统计 `during(...)` 窗口内的调用。而架构师给的反例是
   *  「在文件顶部插一行 `const x = Date.now();`」—— 那发生在**模块加载时**，
   *  不在任何 `during()` 窗口里 ⇒ **首版 6 条断言全绿，而约束已被违反**。
   *
   *  ⇒ 这跟静态判据掉进的是**同一个坑的不同一层**：
   *    静态那条看的是「字面」，这条如果只看调用窗口，漏的是「**时机**」。
   *    「不读时钟」这个约束是**全时段**的，判据就不能只覆盖「调用时」。
   *
   *  ⇒ 用 `jest.isolateModules` + 先装探针再 `require`：让模块在探针下**重新加载一次**，
   *    加载期的时钟读取就会被记录。 */
  it('★ 模块加载期间也不读时钟（防顶层 `const x = Date.now();` 这类形态）', () => {
    installProbe();
    reset();
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../../src/common/utils/orderability');
      });
    } finally {
      globalThis.Date = RealDate;
    }
    expect(tally.nowCalls).toBe(0);
    expect(tally.noArgDates).toBe(0);
  });

  it('★ evaluateStructure 期间：Date.now 零调用 且 无参 new Date 零次', () => {
    const r = during(() => evaluateStructure(SCOPE));
    expect(r.value.ok).toBe(true); // 顺带确认这次调用真的进了谓词体
    expect(r.nowCalls).toBe(0);
    expect(r.noArgDates).toBe(0);
  });

  it('★ evaluateAvailability 期间：Date.now 零调用 且 无参 new Date 零次', () => {
    const r = during(() => evaluateAvailability(INPUT));
    expect(r.value.canOrder).toBe(true);
    expect(r.nowCalls).toBe(0);
    expect(r.noArgDates).toBe(0);
  });

  it('★ evaluateAvailability 四个拦截分支期间也都零读时钟（含 not_open_yet / cutoff）', () => {
    const cases: Array<[string, AvailabilityInput]> = [
      ['sales_paused', { ...INPUT, salesPaused: true }],
      ['meal_not_published', { ...INPUT, assignmentStatus: null }],
      ['not_open_yet', { ...INPUT, nowMs: Date.UTC(2026, 9, 26, 9, 0) }],
      ['cutoff', { ...INPUT, nowMs: Date.UTC(2026, 9, 26, 23, 45) }],
    ];
    for (const [label, input] of cases) {
      const r = during(() => evaluateAvailability(input));
      expect(r.value.canOrder).toBe(false); // 确认真的落到了拦截分支
      expect({ label, nowCalls: r.nowCalls, noArgDates: r.noArgDates }).toEqual({
        label,
        nowCalls: 0,
        noArgDates: 0,
      });
    }
  });

  it('★ reasonText 期间：Date.now 零调用；**有参** new Date(ms) 不算读时钟', () => {
    const r = during(() =>
      reasonText('not_open_yet', {
        publishAtMs: INPUT.publishAtMs,
        cutoffAtMs: INPUT.cutoffAtMs,
        cutoffWindowMinutes: 30,
      }),
    );
    expect(r.value).toBe('今日 18:00 开团，敬请期待');
    expect(r.nowCalls).toBe(0);
    expect(r.noArgDates).toBe(0); // ← 关键：`new Date(ctx.publishAtMs)` 是纯换算，不在此列
  });

  /** ⚠️ 这条是**兜底的第二道**：探针只覆盖了 `Date.now` 与 `new Date`。
   *  若哪天有人改用 `performance.now()` / `process.hrtime()` 之类绕过它，
   *  可复现性断言会先红 —— 读了时钟的谓词在「同一入参」下仍可能给出不同结果。
   *  ⇒ 它抓不到所有形态，但能抓到「结果真的随时间变了」那一类。 */
  it('★ 纯函数可复现：同一入参连续调用结果完全一致（不随墙钟漂移）', () => {
    const a = evaluateAvailability(INPUT);
    const b = evaluateAvailability(INPUT);
    expect(a).toEqual(b);
    expect(evaluateStructure(SCOPE)).toEqual(evaluateStructure(SCOPE));

    // 跨「真实的墙钟推进」仍一致：若谓词内部读了时钟，这个循环有概率给出不同结果
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(JSON.stringify(evaluateAvailability({ ...INPUT, nowMs: INPUT.nowMs + 0 })));
    }
    expect(seen.size).toBe(1);
  });
});

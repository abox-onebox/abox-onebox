/**
 * `toBizDateStr` 单测 —— 这个函数是 2026-11-02 那次 500 的修复点，必须锁住
 *
 * 事故链（线上实测）：
 *   mysql2 对 `DATE` 列返回 **JS `Date` 对象**，而实体字段标的是 `string`。
 *   于是 `String(row.firstDate)` 得到 `'Wed Oct 28 2026 …'`：
 *     · 与 `/^\d{4}-\d{2}-\d{2}$/` 不匹配；
 *     · 丢进 `split('-')` 得 `NaN` → `Date.UTC(NaN,…)` → `Invalid time value` → **500**；
 *     · 与 `'2026-10-26'` 做字符串比较恒不等价 ⇒ **全员被判「回流」、新客恒 0**。
 *
 * ⚠️ 时区：本机/CI 在东八区（`getTimezoneOffset() = -480`）时，
 *    `new Date(2026, 9, 28).toISOString().slice(0,10)` 是 **2026-10-27**（退一天）。
 *    所以第 1 条用例在东八区能直接抓住「用 toISOString 实现」这个错误；
 *    若在 UTC 环境跑，这条抓不到（UTC 下两者一致）—— 故不把它当唯一防线，
 *    另外几类入参形态各自都有用例。
 */

import { addDays, daysBetween, toBizDateStr } from '../../src/common/utils/time';

describe('toBizDateStr · 任意日期值归一为业务日', () => {
  it('Date 对象取**本地**分量（东八区下用 toISOString 会退成前一天）', () => {
    const d = new Date(2026, 9, 28); // 本地 2026-10-28 00:00
    expect(toBizDateStr(d)).toBe('2026-10-28');
    // 对照：东八区下 toISOString 的日期段是 2026-10-27，与期望差一天。
    // 这条差值本身就是「为什么不能用 toISOString」的证据；UTC 环境下两者相同，
    // 故这里只在东八区构成有效防线。
    const viaIso = d.toISOString().slice(0, 10);
    expect(viaIso === '2026-10-28').toBe(d.getTimezoneOffset() === 0);
  });

  it('YYYY-MM-DD 字符串原样返回', () => {
    expect(toBizDateStr('2026-10-28')).toBe('2026-10-28');
  });

  it('带时间的 ISO 串取日期段（不做时区换算）', () => {
    expect(toBizDateStr('2026-10-28T00:00:00.000Z')).toBe('2026-10-28');
    expect(toBizDateStr('2026-10-28 13:45:00')).toBe('2026-10-28');
  });

  it('取不到就返回空串（**不是** 0，也不是今天）', () => {
    expect(toBizDateStr(null)).toBe('');
    expect(toBizDateStr(undefined)).toBe('');
    expect(toBizDateStr('')).toBe('');
    expect(toBizDateStr('abc')).toBe('');
    expect(toBizDateStr(new Date('nope'))).toBe(''); // Invalid Date
    // 正控：同样入参换成合法值就有值 —— 证明上面几条 not 不是恒真
    expect(toBizDateStr('2026-01-02')).toBe('2026-01-02');
  });

  it('数字等其他类型不被误当日（避免 `1730000000000` 这种被当日期）', () => {
    expect(toBizDateStr(1730000000000)).toBe('');
    expect(toBizDateStr(0)).toBe('');
  });
});

/**
 * `daysBetween` 单测 —— 见习到期判定与预警共用的日历天数差
 *
 * ## 为什么它非测不可
 *
 * 这个差值直接决定两件事同不同步：
 *   · `expireTrainees()`：「anchor 距今 > 30 天 → 停职」
 *   · `warnExpiringTrainees()`：「距失效恰好 7 天 → 提醒」
 * 一旦它按毫秒相除（而不是日历日），同一个「还剩 7 天」的团长会在
 * 不同小时被判成 6 天或 7 天 —— 表现为「昨天该提醒的今天没提醒」。
 *
 * 输入是字符串（`addDays` / `todayBj` 的产物），故本函数只对**日期**负责，
 * 时刻差异在调用方就已按北京日期归零（见 `warnExpiringTrainees` 里的
 * `toBjIso(...).slice(0, 10)`）。
 */
describe('daysBetween · 日历天数差', () => {
  it('同一天为 0（不是 1，也不是 -1）', () => {
    expect(daysBetween('2026-11-18', '2026-11-18')).toBe(0);
  });

  it('相邻两天为 1 / -1（方向敏感）', () => {
    expect(daysBetween('2026-11-18', '2026-11-19')).toBe(1);
    expect(daysBetween('2026-11-19', '2026-11-18')).toBe(-1);
  });

  it('跨月、跨年都对', () => {
    expect(daysBetween('2026-11-28', '2026-12-02')).toBe(4);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });

  it('闰年 2 月：2028 有 29 号、2027 没有（差一天）', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2027-02-28', '2027-03-01')).toBe(1);
  });

  it('与 addDays 互为逆运算（30 天见习期在两个月里都算得对）', () => {
    for (const base of ['2026-11-18', '2026-02-01', '2028-02-28']) {
      expect(daysBetween(base, addDays(base, 30))).toBe(30);
      expect(daysBetween(addDays(base, 30), base)).toBe(-30);
    }
  });

  it('30 天窗口内「恰好剩 7 天」的判据稳定（不会因为中间跨闰月而漂）', () => {
    // 2028-02-01 + 30 = 2028-03-02；从此往前 7 天 = 2028-02-24
    const deadline = addDays('2028-02-01', 30);
    expect(deadline).toBe('2028-03-02');
    expect(daysBetween('2028-02-24', deadline)).toBe(7);
    // 前一天的判据必须是 8，不能与 7 混淆（差一天会让预警提前/推迟一次）
    expect(daysBetween('2028-02-23', deadline)).toBe(8);
  });
});

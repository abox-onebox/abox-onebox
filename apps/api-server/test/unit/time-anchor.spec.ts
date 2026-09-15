import {
  addDays,
  cutoffAtOf,
  isAfterCutoff,
  isOrderable,
  isDateStr,
  publishAtOf,
  secondsToCutoff,
  toBjIso,
  todayBj,
  tomorrowBj,
} from '../../src/common/utils/time';

/**
 * 时间锚点（对照《订单状态机 v1.0》§1.2）
 *   开团 T-1 14:00 · 截单 T-1 24:00（= T 日 00:00）· 送达 T 日 11:30 · 自动确认 T 日 14:00
 *
 * 全部断言基于「绝对时刻」，与运行机器时区无关（实现使用显式 +08:00 偏移）。
 */
describe('时间锚点（UTC+8）', () => {
  const MEAL_DATE = '2026-09-16'; // T 日

  it('截单时刻 = T 日 00:00（即 T-1 24:00）', () => {
    expect(cutoffAtOf(MEAL_DATE).toISOString()).toBe('2026-09-15T16:00:00.000Z');
  });

  it('开团时刻 = T-1 14:00', () => {
    expect(publishAtOf(MEAL_DATE).toISOString()).toBe('2026-09-15T06:00:00.000Z');
  });

  it('canOrder 窗口 = [T-1 14:00, T 日 00:00 − 10min)', () => {
    const at = (iso: string) => new Date(iso);

    // 开团前 1 分钟 → 不可下单
    expect(isOrderable(MEAL_DATE, 10, at('2026-09-15T05:59:00Z'))).toBe(false);
    // 刚开团 → 可下单
    expect(isOrderable(MEAL_DATE, 10, at('2026-09-15T06:00:00Z'))).toBe(true);
    // 截单前 10 分钟整 → 已关闭（半开区间）
    expect(isOrderable(MEAL_DATE, 10, at('2026-09-15T15:50:00Z'))).toBe(false);
    // 截单前 11 分钟 → 仍可下单
    expect(isOrderable(MEAL_DATE, 10, at('2026-09-15T15:49:00Z'))).toBe(true);
    // 截单时刻 → 不可下单
    expect(isOrderable(MEAL_DATE, 10, at('2026-09-15T16:00:00Z'))).toBe(false);
  });

  it('isAfterCutoff 与 canOrder 互为硬闸前后关系', () => {
    expect(isAfterCutoff(MEAL_DATE, new Date('2026-09-15T15:59:59Z'))).toBe(false);
    expect(isAfterCutoff(MEAL_DATE, new Date('2026-09-15T16:00:00Z'))).toBe(true);
  });

  it('secondsToCutoff 已过截单返回 0（不出现负数倒计时）', () => {
    const before = secondsToCutoff(MEAL_DATE, new Date('2026-09-15T15:59:00Z'));
    expect(before).toBe(60);
    expect(secondsToCutoff(MEAL_DATE, new Date('2026-09-15T16:30:00Z'))).toBe(0);
  });

  it('toBjIso 输出带 +08:00 的 ISO 8601', () => {
    expect(toBjIso(new Date('2026-09-15T03:30:00.000Z'))).toBe('2026-09-15T11:30:00+08:00');
    expect(toBjIso(null)).toBeNull();
  });

  it('日期加减跨月安全；todayBj/tomorrowBj 相差一天', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29'); // 闰年
    const now = new Date('2026-09-15T16:00:00Z'); // 北京时间 09-16 00:00
    expect(todayBj(now)).toBe('2026-09-16');
    expect(tomorrowBj(now)).toBe('2026-09-17');
  });

  it('isDateStr 只接受 YYYY-MM-DD', () => {
    expect(isDateStr('2026-09-16')).toBe(true);
    expect(isDateStr('2026-9-16')).toBe(false);
    expect(isDateStr('20260916')).toBe(false);
    expect(isDateStr(undefined)).toBe(false);
  });
});

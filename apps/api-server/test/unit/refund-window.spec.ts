import { isRefundWindowExpired } from '../../src/common/utils/refund-window';

/**
 * H9 · 完成后可退时限（2026-10-29）
 *
 * 要拦的**静默**错误：
 * ① 时限配了却没生效（恒不拦）⇒ H9 等于没修；
 * ② 时限把**非 completed** 的单也拦了 ⇒ 无谓堵死退款（那时佣金还没入账，本无欠款风险）；
 * ③ 时限配成 0 / 缺键时**误拦** ⇒ 上线即把退款口子悄悄关掉（最危险的一种）。
 */

const now = new Date('2026-10-29T12:00:00+08:00');
const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

describe('isRefundWindowExpired · 完成后可退时限', () => {
  it('时限 0（缺省不限）→ 不拦，哪怕完成了一万小时', () => {
    const v = isRefundWindowExpired({
      status: 'completed',
      completedAt: ago(10_000),
      windowHours: 0,
      now,
    });
    expect(v.expired).toBe(false);
  });

  it('时限为负 / NaN → 一律不拦（配错时退回「不限」，绝不误关退款口）', () => {
    for (const bad of [-1, Number.NaN]) {
      const v = isRefundWindowExpired({
        status: 'completed',
        completedAt: ago(999),
        windowHours: bad,
        now,
      });
      expect(v.expired).toBe(false);
    }
  });

  it('⛔ 非 completed 状态 → 不拦（佣金尚未结算入账，无欠款风险）', () => {
    for (const st of ['paid', 'cut_off', 'cooked', 'delivering', 'delivered']) {
      const v = isRefundWindowExpired({
        status: st,
        completedAt: ago(999),
        windowHours: 24,
        now,
      });
      expect(v.expired).toBe(false);
    }
  });

  it('completed 且在时限内 → 不拦', () => {
    const v = isRefundWindowExpired({
      status: 'completed',
      completedAt: ago(10),
      windowHours: 24,
      now,
    });
    expect(v.expired).toBe(false);
  });

  it('completed 且刚到边界（恰好等于时限）→ 不拦（含端点）', () => {
    const v = isRefundWindowExpired({
      status: 'completed',
      completedAt: ago(24),
      windowHours: 24,
      now,
    });
    expect(v.expired).toBe(false);
  });

  it('completed 且超出时限 → 拦（这就是 H9 要补的洞）', () => {
    const v = isRefundWindowExpired({
      status: 'completed',
      completedAt: ago(25),
      windowHours: 24,
      now,
    });
    expect(v.expired).toBe(true);
    expect(v.note).toContain('超出可退时限');
  });

  it('completed 但缺 completedAt → 不拦（数据残缺不该堵死用户退款）', () => {
    const v = isRefundWindowExpired({
      status: 'completed',
      completedAt: null,
      windowHours: 24,
      now,
    });
    expect(v.expired).toBe(false);
    expect(v.note).toContain('fail-open');
  });

  // ==================== 自证 ====================

  it('自证：同一组入参只改「是否超期」，结论必须相反（判据不是恒 false）', () => {
    const base = { status: 'completed', windowHours: 24, now };
    expect(isRefundWindowExpired({ ...base, completedAt: ago(1) }).expired).toBe(false);
    expect(isRefundWindowExpired({ ...base, completedAt: ago(100) }).expired).toBe(true);
  });

  it('自证：缺省（0）下**任何**订单都不被拦（判据不是恒 true）', () => {
    const statuses = ['paid', 'delivered', 'completed', 'refunded'];
    for (const st of statuses) {
      expect(
        isRefundWindowExpired({ status: st, completedAt: ago(9_999), windowHours: 0, now }).expired,
      ).toBe(false);
    }
  });
});

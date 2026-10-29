import { runFailureTargetId, shouldAlertRunFailure } from '../../src/common/utils/schedule-run-log';

/**
 * T1/T2 · 跑批失败告警的落库判据（2026-10-29）
 *
 * 要拦的**静默**错误：
 * ① 成功也落库 ⇒ 高频任务 pay-reconcile（每 30 分钟）一年 17520 条噪音，
 *    真正的失败告警被埋掉（「每次都告警 = 没有告警」）；
 * ② 被锁跳过也落库 ⇒ 同上一类，且「并发占用」根本不是故障；
 * ③ 失败**不**落库 ⇒ T2 等于没做。
 */

describe('shouldAlertRunFailure · 跑批失败才落库', () => {
  it('失败（error 非空）→ 落库', () => {
    expect(shouldAlertRunFailure({ ran: true, error: '连接超时' })).toBe(true);
  });

  it('⛔ 成功（无 error）→ 不落库（否则高频任务刷爆操作日志）', () => {
    expect(shouldAlertRunFailure({ ran: true })).toBe(false);
  });

  it('⛔ 被锁跳过 → 不落库（并发占用是正常现象，不是故障）', () => {
    expect(shouldAlertRunFailure({ ran: false, skipped: 'locked' })).toBe(false);
  });

  it('error 为空串 → 不落库（空串不是失败证据）', () => {
    expect(shouldAlertRunFailure({ ran: true, error: '' })).toBe(false);
  });

  it('error 全是空白 → 不落库', () => {
    expect(shouldAlertRunFailure({ ran: true, error: '   \n  ' })).toBe(false);
  });

  it('成功但 result 为空（本函数的入参视图里没有 result）→ 仍按成功处理', () => {
    expect(shouldAlertRunFailure({ ran: true, error: undefined })).toBe(false);
  });

  it('幂等键 = 任务 + 日期（同任务同日只告警一次）', () => {
    expect(runFailureTargetId('cutoff', '2026-10-29')).toBe('cutoff:2026-10-29');
    expect(runFailureTargetId('cutoff', '2026-10-30')).not.toBe(
      runFailureTargetId('cutoff', '2026-10-29'),
    );
  });

  // ==================== 自证 ====================

  it('自证：判据既不恒 true 也不恒 false（失败 true / 成功 false 都被覆盖）', () => {
    const verdicts = [
      shouldAlertRunFailure({ ran: true, error: 'boom' }),
      shouldAlertRunFailure({ ran: true }),
      shouldAlertRunFailure({ ran: false, skipped: 'locked' }),
    ];
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });
});

import {
  buildReconRunLog,
  RECON_RUN_ACTION,
  RECON_RUN_MODULE,
  reconFreshness,
  reconFreshnessTip,
  reconRunSummary,
  type ReconRunFact,
} from '../../src/common/utils/reconciliation-run-log';

/**
 * S5 · 对账执行留痕的判据
 *
 * 本文件要钉死的三件事：
 *   ① **平与不平都要留痕**（只留不平 = 分不清「核过了」还是「没跑」）；
 *   ② 留痕里**必须**写明「不含微信侧」（少了它，这条留痕就是误导）；
 *   ③ 「有没有按时核」的判据：never / stale / fresh 三态都不能含糊。
 */

function fact(patch: Partial<ReconRunFact> = {}): ReconRunFact {
  return {
    date: '2026-10-28',
    balanced: true,
    orderFen: 258_000,
    logFen: 258_000,
    refundFen: 0,
    netFen: 258_000,
    diffFen: 0,
    diffCount: 0,
    channelSource: 'local_only',
    billAvailable: false,
    durationMs: 1234,
    trigger: 'cron',
    ...patch,
  };
}

describe('buildReconRunLog — 留痕内容', () => {
  it('⭐ 平了也要生成留痕（否则「无告警」永远说不清是核过还是没跑）', () => {
    const plan = buildReconRunLog(fact({ balanced: true }), 0);
    expect(plan.module).toBe(RECON_RUN_MODULE);
    expect(plan.action).toBe(RECON_RUN_ACTION);
    expect(plan.snapshot.balanced).toBe(true);
    expect(plan.snapshot.summary).toContain('已平');
  });

  it('⭐ 不平的留痕也要写，且带差异统计', () => {
    const plan = buildReconRunLog(fact({ balanced: false, diffCount: 3, diffFen: 7740 }), 0);
    expect(plan.snapshot.balanced).toBe(false);
    expect(plan.snapshot.diffCount).toBe(3);
    expect(plan.snapshot.diffFen).toBe(7740);
    expect(plan.snapshot.summary).toContain('不平');
  });

  it('⭐ 无论平与不平，caveat 都在（少了它这条留痕就是误导）', () => {
    expect(String(buildReconRunLog(fact({ balanced: true }), 0).snapshot.caveat)).toContain(
      '不等于已与微信侧对平',
    );
    expect(String(buildReconRunLog(fact({ balanced: false }), 0).snapshot.caveat)).toContain(
      '不等于已与微信侧对平',
    );
  });

  it('⭐ runs 累加：补跑覆盖写，看得出这一天核过几次', () => {
    expect(buildReconRunLog(fact(), 0).snapshot.runs).toBe(1);
    expect(buildReconRunLog(fact(), 2).snapshot.runs).toBe(3);
    // 历史值脏了（NaN）也不能把计数带坏
    expect(buildReconRunLog(fact(), Number.NaN).snapshot.runs).toBe(1);
  });

  it('trigger 进留痕（排查「这天为什么两条」时的第一个问题）', () => {
    expect(buildReconRunLog(fact({ trigger: 'manual' }), 0).requestData.trigger).toBe('manual');
    expect(buildReconRunLog(fact({ trigger: 'cron' }), 0).snapshot.trigger).toBe('cron');
  });

  it('targetId 就是被核日期（同一天一条，便于覆盖而非堆行）', () => {
    expect(buildReconRunLog(fact({ date: '2026-10-27' }), 0).targetId).toBe('2026-10-27');
  });

  it('只放差异**统计**不放明细（明细可能上百行）', () => {
    const plan = buildReconRunLog(
      fact({ diffTypeStats: [{ type: 'no_log', label: '无流水', count: 2 }] }),
      0,
    );
    expect(plan.snapshot.diffTypeStats).toEqual([{ type: 'no_log', label: '无流水', count: 2 }]);
    expect(JSON.stringify(plan.snapshot)).not.toContain('orderNo');
  });
});

describe('reconRunSummary — 一句话结论', () => {
  it('平：带三头金额 + 不含微信侧', () => {
    const s = reconRunSummary(fact({ balanced: true }));
    expect(s).toContain('已平');
    expect(s).toContain('local_only');
  });

  it('不平：带差异笔数与金额', () => {
    const s = reconRunSummary(fact({ balanced: false, diffCount: 5, diffFen: 12_900 }));
    expect(s).toContain('5 笔');
    expect(s).toContain('129.00');
  });

  it('⭐ 再长也截得断（JSON 列不该被无限撑大）', () => {
    const s = reconRunSummary(fact({ netFen: 10 ** 15 }));
    expect(s.length).toBeLessThanOrEqual(300);
  });
});

describe('reconFreshness — 有没有按时核', () => {
  it('⭐ 一条都没有 → never（这是最该被看见的一种）', () => {
    expect(reconFreshness(null, '2026-10-28')).toBe('never');
    expect(reconFreshness(undefined, '2026-10-28')).toBe('never');
    expect(reconFreshness('', '2026-10-28')).toBe('never');
  });

  it('正好核到应核日期 → fresh', () => {
    expect(reconFreshness('2026-10-28', '2026-10-28')).toBe('fresh');
  });

  it('核了更晚的日期 → fresh（应核日期自然已被覆盖）', () => {
    expect(reconFreshness('2026-10-29', '2026-10-28')).toBe('fresh');
  });

  it('⭐ 早于应核日期 → stale（中间至少漏跑一天）', () => {
    expect(reconFreshness('2026-10-27', '2026-10-28')).toBe('stale');
    expect(reconFreshness('2026-09-30', '2026-10-28')).toBe('stale');
  });

  it('跨月/跨年靠字符串序就能比（不引日期库，也不会错时区）', () => {
    expect(reconFreshness('2026-11-01', '2026-10-31')).toBe('fresh');
    expect(reconFreshness('2026-12-31', '2027-01-01')).toBe('stale');
  });
});

describe('reconFreshnessTip — 人话', () => {
  it('never 明说「无告警 ≠ 已核过」', () => {
    const t = reconFreshnessTip('never', { expectedDate: '2026-10-28' });
    expect(t).toContain('从未记录自动对账');
    expect(t).toContain('无告警');
  });

  it('stale 指出漏了哪一天', () => {
    const t = reconFreshnessTip('stale', {
      lastRunDate: '2026-10-26',
      expectedDate: '2026-10-28',
    });
    expect(t).toContain('2026-10-26');
    expect(t).toContain('2026-10-28');
    expect(t).toContain('漏跑');
  });

  it('fresh 说清已覆盖到哪天', () => {
    const t = reconFreshnessTip('fresh', {
      lastRunDate: '2026-10-28',
      expectedDate: '2026-10-28',
    });
    expect(t).toContain('已覆盖应核日期');
  });
});

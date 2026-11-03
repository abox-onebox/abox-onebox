/**
 * 节点 Q 判据单测：退款聚类
 * ------------------------------------------------------------------
 * 这层的输出会直接影响「要不要去改某个环节」，所以算术必须钉死：
 * 占比分母、topN 合并后总数守恒、未标注报警线、金额分桶边界、重复用户计数。
 */

import {
  clusterRefunds,
  describeRefundCluster,
  inWindow,
  reasonKeyOf,
  sanitizeReason,
  UNLABELED_REASON,
  UNLABELED_WARN_SHARE,
  type RefundClusterRow,
} from '../../src/modules/wecom-kb/refund-cluster';

const CUTOFF = '2026-10-05';

function row(over: Partial<RefundClusterRow> = {}): RefundClusterRow {
  return {
    amountFen: 2580,
    mealDate: '2026-11-02',
    reasonTypeText: '菜品质量问题',
    userId: 1,
    ...over,
  };
}

describe('reasonKeyOf', () => {
  it('优先用后台归一后的原因文案', () => {
    expect(reasonKeyOf(row({ reasonTypeText: '出餐延误', reason: '我随便写的' }))).toBe('出餐延误');
  });

  it('归一缺失时回落到自由文本', () => {
    expect(reasonKeyOf(row({ reasonTypeText: null, reason: '菜凉了' }))).toBe('菜凉了');
  });

  it('两者都空 ⇒ 未标注原因（不猜不归类）', () => {
    expect(reasonKeyOf(row({ reasonTypeText: null, reason: null }))).toBe(UNLABELED_REASON);
    expect(reasonKeyOf(row({ reasonTypeText: '  ', reason: '   ' }))).toBe(UNLABELED_REASON);
  });
});

describe('sanitizeReason', () => {
  it('长数字（手机号）必须掩码，不能进 LLM', () => {
    const s = sanitizeReason('我电话 13800001111 打不通');
    expect(s).not.toContain('13800001111');
    expect(s).toContain('***');
  });

  it('超长文本截断并加省略号', () => {
    const s = sanitizeReason('一'.repeat(100), 10);
    expect(s.length).toBe(11);
    expect(s.endsWith('…')).toBe(true);
  });

  it('空白归一成空串', () => {
    expect(sanitizeReason('   ')).toBe('');
    expect(sanitizeReason(null)).toBe('');
  });
});

describe('inWindow', () => {
  it('有出餐日就按出餐日判（即使退款时间在窗口外）', () => {
    expect(inWindow(row({ mealDate: '2026-10-04' }), CUTOFF)).toBe(false);
    expect(inWindow(row({ mealDate: '2026-10-05' }), CUTOFF)).toBe(true);
  });

  it('没有出餐日时用退款时间兜底（跨日退款别丢样本）', () => {
    expect(inWindow(row({ mealDate: null, refundedAt: '2026-10-04T10:00:00+08:00' }), CUTOFF)).toBe(
      false,
    );
    expect(inWindow(row({ mealDate: null, refundedAt: '2026-10-09T10:00:00+08:00' }), CUTOFF)).toBe(
      true,
    );
  });

  it('两个日期都没有 ⇒ 不剔除（宁可多算一笔，也不悄悄丢样本）', () => {
    expect(inWindow(row({ mealDate: null, refundedAt: null }), CUTOFF)).toBe(true);
  });
});

describe('clusterRefunds', () => {
  const rows: RefundClusterRow[] = [
    row({ reasonTypeText: '菜品质量问题', amountFen: 2580 }),
    row({ reasonTypeText: '菜品质量问题', amountFen: 2580 }),
    row({ reasonTypeText: '菜品质量问题', amountFen: 2580 }),
    row({ reasonTypeText: '出餐延误', amountFen: 2580 }),
    row({ reasonTypeText: null, reason: null, amountFen: 900 }),
  ];

  it('笔数 / 占比 / 金额 / 笔均都算准', () => {
    const r = clusterRefunds(rows, { cutoffYmd: CUTOFF, windowDays: 30 });
    expect(r.total).toBe(5);
    expect(r.totalAmountFen).toBe(2580 * 4 + 900);
    const q = r.clusters[0];
    expect(q.key).toBe('菜品质量问题');
    expect(q.count).toBe(3);
    expect(q.share).toBeCloseTo(0.6, 6);
    expect(q.avgAmountFen).toBe(2580);
  });

  it('聚类按笔数降序，同笔数按金额降序', () => {
    const r = clusterRefunds(
      [
        row({ reasonTypeText: 'A', amountFen: 1000 }),
        row({ reasonTypeText: 'B', amountFen: 3000 }),
        row({ reasonTypeText: 'B', amountFen: 3000 }),
        row({ reasonTypeText: 'A', amountFen: 1000 }),
      ],
      { cutoffYmd: CUTOFF, windowDays: 30 },
    );
    expect(r.clusters.map((c) => c.key)).toEqual(['B', 'A']);
  });

  it('未标注占比超过阈值必须报警（三成以上根因画像不可信）', () => {
    const bad = clusterRefunds(
      [
        row({ reasonTypeText: null, reason: null }),
        row({ reasonTypeText: null, reason: null }),
        row({ reasonTypeText: '菜品质量问题' }),
      ],
      { cutoffYmd: CUTOFF, windowDays: 30 },
    );
    expect(bad.unlabeled.count).toBe(2);
    expect(bad.unlabeled.share).toBeCloseTo(2 / 3, 6);
    expect(bad.unlabeled.warning).toBe(true);
    expect(bad.unlabeled.share).toBeGreaterThan(UNLABELED_WARN_SHARE);

    const ok = clusterRefunds(
      [
        row({ reasonTypeText: null, reason: null }),
        row({ reasonTypeText: 'A' }),
        row({ reasonTypeText: 'B' }),
        row({ reasonTypeText: 'C' }),
      ],
      { cutoffYmd: CUTOFF, windowDays: 30 },
    );
    expect(ok.unlabeled.warning).toBe(false);
  });

  it('topN 之外的并入「其他（长尾）」，且总数守恒（占比不能加起来不到 100%）', () => {
    const many = Array.from({ length: 6 }, (_, i) => row({ reasonTypeText: `原因${i}` }));
    const r = clusterRefunds(many, { cutoffYmd: CUTOFF, windowDays: 30, topN: 4 });
    expect(r.clusters.length).toBe(5);
    expect(r.clusters[4].key).toBe('其他（长尾）');
    expect(r.clusters[4].count).toBe(2);
    expect(r.clusters.reduce((s, c) => s + c.count, 0)).toBe(6);
    const shareSum = r.clusters.reduce((s, c) => s + c.share, 0);
    expect(shareSum).toBeCloseTo(1, 6);
  });

  it('金额分桶边界：1000 / 1001 / 3000 / 3001', () => {
    const r = clusterRefunds(
      [
        row({ amountFen: 1000 }),
        row({ amountFen: 1001 }),
        row({ amountFen: 3000 }),
        row({ amountFen: 3001 }),
      ],
      { cutoffYmd: CUTOFF, windowDays: 30 },
    );
    // 1000 → ≤10 元；1001 与 3000 → 10~30 元；3001 → >30 元
    expect(r.amountBuckets.map((b) => b.count)).toEqual([1, 2, 1]);
  });

  it('重复退款只数不点名：只统计 userId 与最大笔数', () => {
    const r = clusterRefunds(
      [
        row({ userId: 7 }),
        row({ userId: 7 }),
        row({ userId: 7 }),
        row({ userId: 9 }),
        row({ userId: null }),
      ],
      { cutoffYmd: CUTOFF, windowDays: 30 },
    );
    expect(r.repeat.distinctUsers).toBe(2);
    expect(r.repeat.repeatedUsers).toBe(1);
    expect(r.repeat.maxPerUser).toBe(3);
  });

  it('窗口外的样本不进任何统计', () => {
    const r = clusterRefunds([row({ mealDate: '2026-09-01' }), row({ mealDate: '2026-11-02' })], {
      cutoffYmd: CUTOFF,
      windowDays: 30,
    });
    expect(r.total).toBe(1);
    expect(r.totalAmountFen).toBe(2580);
  });

  it('空样本不炸，且话术如实说「没有样本」', () => {
    const r = clusterRefunds([], { cutoffYmd: CUTOFF, windowDays: 30 });
    expect(r.total).toBe(0);
    expect(r.clusters).toEqual([]);
    expect(r.unlabeled.warning).toBe(false);
    expect(describeRefundCluster(r)).toContain('没有退款样本');
  });

  it('摘要话术带上未标注警告与重复退款', () => {
    const r = clusterRefunds(
      [
        row({ reasonTypeText: null, reason: null, userId: 3 }),
        row({ reasonTypeText: null, reason: null, userId: 3 }),
        row({ reasonTypeText: 'A', userId: 4 }),
      ],
      { cutoffYmd: CUTOFF, windowDays: 30 },
    );
    const txt = describeRefundCluster(r);
    expect(txt).toContain('未标注原因占');
    expect(txt).toContain('重复退款用户 1 人');
  });
});

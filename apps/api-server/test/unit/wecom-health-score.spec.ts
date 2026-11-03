import {
  computeHealthScore,
  gradeOf,
  gradeLabel,
  weakestDimension,
  type HealthScoreInput,
} from '../../src/modules/wecom-kb/health-score';

/**
 * 经营健康度总分
 *
 * 最要紧的一条负控：**数据缺失不许把分打低**。
 * 缺一整维时该维不进分母（测得 3 维就按 60 分满分折算），
 * 否则「今天对账接口没数据」就会天天把公司打成红色，三天后没人再信这个数。
 */

const BEST: HealthScoreInput = {
  gmvDeltaRate: 0.2,
  orderDeltaRate: 0.2,
  repeatRate: 0.5,
  week1Retention: 0.6,
  reconBalanced: true,
  refundPendingCount: 0,
  withdrawPendingCount: 0,
  refundRate: 0.01,
  shareExceptionCount: 0,
  leaderCoverageRate: 1,
  activeLeaderRate: 0.9,
};

const WORST: HealthScoreInput = {
  gmvDeltaRate: -0.3,
  orderDeltaRate: -0.3,
  repeatRate: 0.02,
  week1Retention: 0.05,
  reconBalanced: false,
  refundPendingCount: 30,
  withdrawPendingCount: 30,
  refundRate: 0.3,
  shareExceptionCount: 20,
  leaderCoverageRate: 0.05,
  activeLeaderRate: 0.05,
};

describe('gradeOf 等级线', () => {
  it('80 及以上绿、60~79 黄、59 及以下红', () => {
    expect(gradeOf(100)).toBe('green');
    expect(gradeOf(80)).toBe('green');
    expect(gradeOf(79)).toBe('yellow');
    expect(gradeOf(60)).toBe('yellow');
    expect(gradeOf(59)).toBe('red');
    expect(gradeOf(0)).toBe('red');
  });

  it('等级文案是「颜色 + 结论」，不含情绪词', () => {
    expect(gradeLabel('green')).toContain('健康');
    expect(gradeLabel('yellow')).toContain('需关注');
    expect(gradeLabel('red')).toContain('高风险');
    expect(gradeLabel(null)).toBe('未评级');
  });
});

describe('computeHealthScore 基本盘', () => {
  it('五维全优 = 100 分绿色', () => {
    const r = computeHealthScore(BEST);
    expect(r.score).toBe(100);
    expect(r.grade).toBe('green');
    expect(r.measuredWeight).toBe(100);
    expect(r.missing).toEqual([]);
    expect(r.dimensions).toHaveLength(5);
  });

  it('五维全差 = 低分红色', () => {
    const r = computeHealthScore(WORST);
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeLessThan(30);
    expect(r.grade).toBe('red');
  });

  it('每维满分恒为 20，且得分不超过满分', () => {
    const r = computeHealthScore(BEST);
    for (const d of r.dimensions) {
      expect(d.max).toBe(20);
      expect(d.score).toBeLessThanOrEqual(20);
      expect(d.score).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('★缺数据不许把分打低', () => {
  it('资金维全缺：不进分母，其余全优仍是满分', () => {
    const r = computeHealthScore({
      ...BEST,
      reconBalanced: null,
      refundPendingCount: null,
      withdrawPendingCount: null,
    });
    const cash = r.dimensions.find((d) => d.key === 'cash')!;
    expect(cash.measured).toBe(false);
    expect(cash.score).toBe(0); // 计入分母才该扣分；这里只证明「标记为未测」
    expect(r.missing).toEqual(['资金']);
    expect(r.measuredWeight).toBe(80);
    expect(r.score).toBe(100); // ← 关键：不是 80
  });

  it('两维缺失：measuredWeight=60，总分仍按已测折算', () => {
    const r = computeHealthScore({
      ...BEST,
      reconBalanced: null,
      refundPendingCount: null,
      withdrawPendingCount: null,
      leaderCoverageRate: null,
      activeLeaderRate: null,
    });
    expect(r.missing).toEqual(['资金', '组织']);
    expect(r.measuredWeight).toBe(60);
    expect(r.score).toBe(100);
  });

  it('全维缺失 = 不给分（null），绝不返回 0 分假装很差', () => {
    const r = computeHealthScore({});
    expect(r.score).toBeNull();
    expect(r.grade).toBeNull();
    expect(r.measuredWeight).toBe(0);
    expect(r.missing).toHaveLength(5);
  });

  it('维度内部分子项缺失：按已测子项归一化', () => {
    // 增长维只有 GMV（12 分满分），GMV 满分 → 该维仍应拿满 20
    const r = computeHealthScore({ gmvDeltaRate: 0.2, orderDeltaRate: null });
    const growth = r.dimensions.find((d) => d.key === 'growth')!;
    expect(growth.measured).toBe(true);
    expect(growth.score).toBe(20);
  });

  it('子项缺失不会被当成 0 分（负控：把缺失当 0 分时该维会掉到 12）', () => {
    const full = computeHealthScore({ gmvDeltaRate: 0.2, orderDeltaRate: 0.2 });
    const partial = computeHealthScore({ gmvDeltaRate: 0.2, orderDeltaRate: null });
    expect(full.dimensions[0].score).toBe(20);
    expect(partial.dimensions[0].score).toBe(20);
    // 反向证明：若缺失当 0 分，(12+0)/20*20 = 12 ≠ 20
    expect(partial.dimensions[0].score).not.toBe(12);
  });
});

describe('分维阈值', () => {
  it('GMV 环比跨档：+15% / +5% / 持平 / -15%', () => {
    const at = (v: number) =>
      computeHealthScore({ gmvDeltaRate: v }).dimensions[0].subs.find(
        (s) => s.label === 'GMV 环比',
      )!.score;
    expect(at(0.15)).toBe(12);
    expect(at(0.149)).toBe(9);
    expect(at(0.05)).toBe(9);
    expect(at(-0.04)).toBe(6);
    expect(at(-0.15)).toBe(3);
    expect(at(-0.5)).toBe(0);
  });

  it('对账不平：三项齐时只扣一半，只测这一项时该维归零', () => {
    const ok = computeHealthScore({ reconBalanced: true }).dimensions[2].score;
    const bad = computeHealthScore({ reconBalanced: false }).dimensions[2].score;
    expect(ok).toBe(20);
    // 该维只有这一个子项 ⇒ 归一化后确实归零（不是 bug，是「只测到一项」的必然结果）
    expect(bad).toBe(0);
    const mixed = computeHealthScore({
      reconBalanced: false,
      refundPendingCount: 0,
      withdrawPendingCount: 0,
    }).dimensions[2].score;
    expect(mixed).toBeGreaterThan(0);
    expect(mixed).toBeLessThan(20);
  });

  it('积压笔数分档：0 最优、>10 笔归零', () => {
    const at = (n: number) =>
      computeHealthScore({ refundPendingCount: n }).dimensions[2].subs.find(
        (s) => s.label === '退款积压',
      )!.score;
    expect(at(0)).toBe(5);
    expect(at(3)).toBe(3);
    expect(at(10)).toBe(1);
    expect(at(11)).toBe(0);
  });

  it('退款率分档：≤2% 满分、>10% 只剩 1 分', () => {
    const at = (v: number) =>
      computeHealthScore({ refundRate: v }).dimensions[3].subs.find((s) => s.label === '退款率')!
        .score;
    expect(at(0.02)).toBe(10);
    expect(at(0.05)).toBe(7);
    expect(at(0.1)).toBe(4);
    expect(at(0.11)).toBe(1);
  });
});

describe('weakestDimension', () => {
  it('挑出最短板（未测维度不参与）', () => {
    const r = computeHealthScore({ ...BEST, repeatRate: 0.02, week1Retention: 0.05 });
    const w = weakestDimension(r.dimensions);
    expect(w?.key).toBe('retention');
  });

  it('全未测时返回 null', () => {
    expect(weakestDimension(computeHealthScore({}).dimensions)).toBeNull();
  });
});

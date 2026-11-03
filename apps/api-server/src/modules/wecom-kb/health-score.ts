/**
 * 经营健康度总分（Health Score）· 纯函数判据真源
 * ------------------------------------------------------------------
 * 节点 O 的唯一打分入口。五个维度各 20 分，合计 100：
 *   增长 growth / 留存 retention / 资金 cash / 履约 fulfillment / 组织 organization
 *
 * ⚠️⚠️ 最要紧的一条设计：**数据缺失不等于表现差**。
 *   某维度的子项取不到时，先在该维内部按「已测子项」归一化；
 *   整维全缺（`measured=false`）则该维**不进分母**，总分按已测维度的满分折算。
 *   否则每天 09:00 都会因为「对账接口今天没数据」把一家正常公司打成红色，
 *   三天之后没人再信这个分数 —— 那比不做更糟。
 *   代价是总分可能来自「5 维里的 3 维」，所以结果里必须带 `measuredWeight`，
 *   service 一定要把「已测 3/5 维」印给用户看。
 *
 * ⚠️ 等级线：≥80 绿（健康）/ ≥60 黄（需关注）/ <60 红（高风险）。
 *   定在 80 而不是 90：周盒是新业务，用 90 分线等于天天红色、等于没有信号。
 */

export type HealthGrade = 'green' | 'yellow' | 'red';

export type HealthDimensionKey = 'growth' | 'retention' | 'cash' | 'fulfillment' | 'organization';

export interface HealthScoreInput {
  /** 本期 vs 上期 GMV 变化率（小数，0.083 = +8.3%）；null/undefined = 未知 */
  gmvDeltaRate?: number | null;
  /** 本期 vs 上期订单量变化率 */
  orderDeltaRate?: number | null;
  /** 复购率 0~1 */
  repeatRate?: number | null;
  /** 可观测 cohort 的次周留存率 0~1 */
  week1Retention?: number | null;
  /** 本地三头对账是否已平 */
  reconBalanced?: boolean | null;
  /** 退款待审批笔数 */
  refundPendingCount?: number | null;
  /** 提现待审批笔数 */
  withdrawPendingCount?: number | null;
  /** 退款率 0~1 */
  refundRate?: number | null;
  /** 应付未出单异常项数 */
  shareExceptionCount?: number | null;
  /** 团长覆盖：有在职团长的楼栋 / 在营楼栋 0~1 */
  leaderCoverageRate?: number | null;
  /** 活跃团长 / 在职团长 0~1 */
  activeLeaderRate?: number | null;
}

export interface HealthSubScore {
  label: string;
  /** 该子项在维度内的满分 */
  max: number;
  /** 实际得分（已按维度内缺失归一化后的口径） */
  score: number;
  /** 是否取到数据 */
  measured: boolean;
}

export interface HealthDimension {
  key: HealthDimensionKey;
  label: string;
  /** 维度满分（恒 20） */
  max: number;
  /** 实得（measured=false 时恒 0，且不计入分母） */
  score: number;
  measured: boolean;
  subs: HealthSubScore[];
}

export interface HealthScoreResult {
  /** 折算到 100 的总分；全维缺失时为 null（宁可不给分，也不给假分） */
  score: number | null;
  grade: HealthGrade | null;
  dimensions: HealthDimension[];
  /** 已测维度的满分合计（100 = 五维齐全，60 = 只测到三维） */
  measuredWeight: number;
  /** 缺失维度的中文说明（service 必须原样转述） */
  missing: string[];
}

const DIM_MAX = 20;

export function gradeOf(score: number): HealthGrade {
  if (score >= 80) return 'green';
  if (score >= 60) return 'yellow';
  return 'red';
}

export function gradeLabel(grade: HealthGrade | null): string {
  if (grade === 'green') return '绿色 · 健康';
  if (grade === 'yellow') return '黄色 · 需关注';
  if (grade === 'red') return '红色 · 高风险';
  return '未评级';
}

/** 分档取值：命中第一个满足 `min` 阈值（阈值从高到低）的档位 */
function tier(value: number, table: Array<[number, number]>): number {
  for (const [min, score] of table) {
    if (value >= min) return score;
  }
  return 0;
}

/** 分档取值（越小越好）：命中第一个满足 `max` 上限的档位 */
function tierMax(value: number, table: Array<[number, number]>): number {
  for (const [max, score] of table) {
    if (value <= max) return score;
  }
  return table[table.length - 1][1];
}

function sub(label: string, max: number, measured: boolean, score: number): HealthSubScore {
  return { label, max, measured, score: measured ? Math.max(0, Math.min(max, score)) : 0 };
}

/**
 * 维度归一化：把「已测子项的得分率」放大到维度满分。
 * 一个子项都没测到 → measured=false，score=0（且调用方不计入分母）。
 */
function finalize(key: HealthDimensionKey, label: string, subs: HealthSubScore[]): HealthDimension {
  const measuredSubs = subs.filter((s) => s.measured);
  if (!measuredSubs.length) {
    return { key, label, max: DIM_MAX, score: 0, measured: false, subs };
  }
  const got = measuredSubs.reduce((a, s) => a + s.score, 0);
  const full = measuredSubs.reduce((a, s) => a + s.max, 0);
  const score = full > 0 ? Math.round((got / full) * DIM_MAX) : 0;
  return { key, label, max: DIM_MAX, score, measured: true, subs };
}

const isNum = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const isBool = (v: boolean | null | undefined): v is boolean => typeof v === 'boolean';

export function computeHealthScore(input: HealthScoreInput): HealthScoreResult {
  /* ---------------- 增长：GMV 12 + 订单量 8 ---------------- */
  const growth = finalize('growth', '增长', [
    sub(
      'GMV 环比',
      12,
      isNum(input.gmvDeltaRate),
      isNum(input.gmvDeltaRate)
        ? tier(input.gmvDeltaRate, [
            [0.15, 12],
            [0.05, 9],
            [-0.05, 6],
            [-0.15, 3],
          ])
        : 0,
    ),
    sub(
      '订单量环比',
      8,
      isNum(input.orderDeltaRate),
      isNum(input.orderDeltaRate)
        ? tier(input.orderDeltaRate, [
            [0.15, 8],
            [0.05, 6],
            [-0.05, 4],
            [-0.15, 2],
          ])
        : 0,
    ),
  ]);

  /* ---------------- 留存：复购率 12 + 次周留存 8 ---------------- */
  const retention = finalize('retention', '留存', [
    sub(
      '复购率',
      12,
      isNum(input.repeatRate),
      isNum(input.repeatRate)
        ? tier(input.repeatRate, [
            [0.4, 12],
            [0.25, 9],
            [0.15, 6],
            [0.08, 3],
          ])
        : 0,
    ),
    sub(
      '次周留存',
      8,
      isNum(input.week1Retention),
      isNum(input.week1Retention)
        ? tier(input.week1Retention, [
            [0.5, 8],
            [0.35, 6],
            [0.2, 4],
            [0, 2],
          ])
        : 0,
    ),
  ]);

  /* ---------------- 资金：对账 10 + 退款积压 5 + 提现积压 5 ---------------- */
  const cash = finalize('cash', '资金', [
    sub('对账平衡', 10, isBool(input.reconBalanced), input.reconBalanced === true ? 10 : 0),
    sub(
      '退款积压',
      5,
      isNum(input.refundPendingCount),
      isNum(input.refundPendingCount)
        ? tierMax(input.refundPendingCount, [
            [0, 5],
            [3, 3],
            [10, 1],
            [Number.POSITIVE_INFINITY, 0],
          ])
        : 0,
    ),
    sub(
      '提现积压',
      5,
      isNum(input.withdrawPendingCount),
      isNum(input.withdrawPendingCount)
        ? tierMax(input.withdrawPendingCount, [
            [0, 5],
            [3, 3],
            [10, 1],
            [Number.POSITIVE_INFINITY, 0],
          ])
        : 0,
    ),
  ]);

  /* ---------------- 履约：退款率 10 + 应付未出单 10 ---------------- */
  const fulfillment = finalize('fulfillment', '履约', [
    sub(
      '退款率',
      10,
      isNum(input.refundRate),
      isNum(input.refundRate)
        ? tierMax(input.refundRate, [
            [0.02, 10],
            [0.05, 7],
            [0.1, 4],
            [Number.POSITIVE_INFINITY, 1],
          ])
        : 0,
    ),
    sub(
      '应付未出单异常',
      10,
      isNum(input.shareExceptionCount),
      isNum(input.shareExceptionCount)
        ? tierMax(input.shareExceptionCount, [
            [0, 10],
            [2, 7],
            [5, 4],
            [Number.POSITIVE_INFINITY, 1],
          ])
        : 0,
    ),
  ]);

  /* ---------------- 组织：团长覆盖 10 + 团长活跃 10 ---------------- */
  const organization = finalize('organization', '组织', [
    sub(
      '团长覆盖',
      10,
      isNum(input.leaderCoverageRate),
      isNum(input.leaderCoverageRate)
        ? tier(input.leaderCoverageRate, [
            [0.9, 10],
            [0.7, 8],
            [0.5, 5],
            [0.3, 3],
            [0, 1],
          ])
        : 0,
    ),
    sub(
      '团长活跃',
      10,
      isNum(input.activeLeaderRate),
      isNum(input.activeLeaderRate)
        ? tier(input.activeLeaderRate, [
            [0.8, 10],
            [0.6, 7],
            [0.4, 4],
            [0.2, 2],
            [0, 1],
          ])
        : 0,
    ),
  ]);

  const dimensions = [growth, retention, cash, fulfillment, organization];
  const measured = dimensions.filter((d) => d.measured);
  const measuredWeight = measured.length * DIM_MAX;
  const missing = dimensions.filter((d) => !d.measured).map((d) => d.label);

  if (!measuredWeight) {
    return { score: null, grade: null, dimensions, measuredWeight: 0, missing };
  }

  const raw = measured.reduce((a, d) => a + d.score, 0);
  const total = Math.round((raw / measuredWeight) * 100);
  return {
    score: total,
    grade: gradeOf(total),
    dimensions,
    measuredWeight,
    missing,
  };
}

/** 维度得分率评价（给 LLM 与文案用的中性词，不带情绪） */
export function dimensionVerdict(d: HealthDimension): string {
  if (!d.measured) return '数据暂缺';
  const rate = d.score / d.max;
  if (rate >= 0.8) return '良好';
  if (rate >= 0.6) return '中性';
  if (rate >= 0.4) return '偏弱';
  return '偏差';
}

/** 找出最短的板（用于「先补哪一维」的建议，未测维度不参与） */
export function weakestDimension(dims: HealthDimension[]): HealthDimension | null {
  const measured = dims.filter((d) => d.measured);
  if (!measured.length) return null;
  return measured.reduce((a, b) => (b.score < a.score ? b : a));
}

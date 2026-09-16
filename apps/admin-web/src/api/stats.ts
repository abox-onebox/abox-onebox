import { http } from './request';

/**
 * api/stats —— D47–D50 后台数据看板（原型 P35 · 模块 M36）
 *
 * 口径出处：《接口规范 v1.0》§6.6。本文件**只声明形状**，不复制口径 ——
 * 状态集合、区间天数、毛利等式全部由服务端下发 / 计算（见
 * `apps/api-server/src/modules/stats/stats.constants.ts`）。
 */

/** 统计区间（按出餐日 mealDate 计算） */
export type StatsRangeValue = 'today' | '7d' | '30d';

/** 区间回显（服务端算，端上不再自己拼日期） */
export interface StatsRangeView {
  range: StatsRangeValue;
  label: string;
  startDate: string;
  endDate: string;
  days: number;
}

/** 区间下拉项（服务端未下发时兜底；正常直接用服务端 `rangeOptions`） */
export const STATS_RANGE_OPTIONS: Array<{ value: StatsRangeValue; label: string }> = [
  { value: 'today', label: '今日' },
  { value: '7d', label: '近 7 日' },
  { value: '30d', label: '近 30 日' },
];

/** 履约成本三项的登记状态（与 P36 系统配置页**同源**） */
export interface StatsCostRegistration {
  allRegistered: boolean;
  registered: Record<'siteFee' | 'packingLaborFee' | 'deliveryFee', boolean>;
  missingKeys: string[];
  /** 未登记项的中文名，可直接展示 */
  missingLabels: string[];
  total: number;
}

/** 履约成本三项当前值（元/份） */
export interface StatsCostItems {
  supplierTotal: number;
  siteFee: number;
  packingLaborFee: number;
  deliveryFee: number;
}

/** D47 指标组 */
export interface StatsDashboardMetrics {
  orderCount: number;
  quantity: number;
  gmvFen: number;
  avgOrderAmountFen: number;
  avgUnitPriceFen: number;
  totalOrderCount: number;
  pendingPayCount: number;
  refundCount: number;
  refundRate: number;
  activeUserCount: number;
  activeLeaderCount: number;
  activeBuildingCount: number;
  repeatUserCount: number;
  repeatRate: number;
  commissionFen: number;
  purchaseFen: number;
  fulfillmentFen: number;
  grossProfitFen: number;
  grossProfitRate: number | null;
}

/** D47 出参 */
export interface StatsDashboardResult {
  range: StatsRangeView;
  metrics: StatsDashboardMetrics;
  costRegistration: StatsCostRegistration;
  costItems: StatsCostItems;
  /** false = 本期采购应付单尚未生成 → 毛利未扣采购款，严重高估 */
  purchaseGenerated: boolean;
  trend: Array<{ date: string; orderCount: number; quantity: number; gmvFen: number }>;
  /** 可直接展示的毛利可靠性提示；无风险时为空数组 */
  warnings: string[];
}

/** D48 榜单行 */
export interface StatsRankRow {
  id: number;
  name: string;
  orderCount: number;
  quantity: number;
  gmvFen: number;
  gmvShare: number;
}

export interface StatsBuildingRankResult {
  range: StatsRangeView;
  groups: StatsRankRow[];
  buildings: Array<StatsRankRow & { buildingGroupId: number | null; buildingGroupName: string }>;
  totalGmvFen: number;
}

/** D49 菜品热度行 */
export interface StatsDishHeatRow {
  dishId: number;
  dishName: string;
  supplierId: number;
  supplierName: string;
  quantity: number;
  orderCount: number;
  share: number;
}

export interface StatsDishHeatResult {
  range: StatsRangeView;
  topN: number;
  items: StatsDishHeatRow[];
  /** 区间内全部菜品份数（占比分母） */
  totalQuantity: number;
  dishCount: number;
}

/** D50 留存出参 */
export interface StatsRetentionResult {
  range: StatsRangeView;
  summary: {
    activeUserCount: number;
    newUserCount: number;
    returningUserCount: number;
    repeatUserCount: number;
    repeatRate: number;
  };
  cohorts: Array<{
    cohortStart: string;
    cohortEnd: string;
    newUserCount: number;
    retainedWeek1: number | null;
    retentionRate1: number | null;
    /** false = 观察窗口未走完，留存率无意义（不下发数字） */
    observable: boolean;
  }>;
  note: string;
}

export interface StatsQuery {
  range?: StatsRangeValue;
}

export const TOP_N_OPTIONS = [5, 10, 20, 50];

export const fetchStatsDashboard = (params: StatsQuery = {}) =>
  http.get<StatsDashboardResult>('/admin/stats/dashboard', params);

export const fetchBuildingRank = (params: StatsQuery = {}) =>
  http.get<StatsBuildingRankResult>('/admin/stats/building-rank', params);

export const fetchDishHeat = (params: StatsQuery & { topN?: number } = {}) =>
  http.get<StatsDishHeatResult>('/admin/stats/dish-heat', params);

export const fetchRetention = (params: StatsQuery = {}) =>
  http.get<StatsRetentionResult>('/admin/stats/retention', params);

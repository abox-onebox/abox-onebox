import { HEADER } from '@abox/shared-types';

import { http } from './request';
import type { StatsCostItems, StatsCostRegistration, StatsRangeView } from './stats';
import type { PageResult } from './system';

/**
 * api/finance —— 后台财务（《接口规范 v1.0》§6.5 · 原型 P34）
 *
 * 覆盖：
 *   · **C6 三段式第二段** —— 退款审批（D40 流水 / D41 通过 / D42 驳回）
 *   · **M3-13** —— D33 资金总览 / D34 佣金结算明细 / D35 佣金入账（补跑）
 *   · **M3-14** —— D38 余额账户管理 / D39 余额调整（资金动作 · 必带幂等键）
 *
 * 尚未落点：D43（微信对账）、D44（发票管理）。
 *
 * ⚠️ 金额一律**整数分**（`Fen` 结尾）；端上只做展示换算，绝不参与口径计算
 *    —— 「可退多少」由服务端重算并下发，端上算错时会退错钱。
 */

/** 退款单状态（与 `@abox/shared-types` 的 `RefundStatus` 同源） */
export type RefundStatusValue =
  'applying' | 'approved' | 'refunding' | 'refunded' | 'rejected' | 'failed';

/** 审批页 Tab（语义糖，服务端展开成状态集合） */
export type RefundTabValue = 'pending' | 'approved' | 'rejected' | 'refunded' | 'all';

export interface RefundRow {
  id: number;
  refundNo: string;
  orderNo: string;
  orderId: number;
  mealDate: string | null;
  quantity: number | null;

  amountFen: number;
  /** 拆两路：微信原路退 */
  wxAmountFen: number;
  /** 拆两路：余额抵扣退回 */
  balanceAmountFen: number;

  status: RefundStatusValue;
  statusText: string;
  applySource: string;
  applySourceText: string;
  reasonType: string | null;
  reasonTypeText: string | null;
  reason: string | null;

  user: { id: number; nickname: string | null; phoneMasked: string | null };
  leader: { id: number; realName: string | null; level: string } | null;

  /** C6 第二段依据：申请前的订单状态（驳回会回到这里） */
  orderStatusBefore: string | null;
  orderStatusBeforeText: string | null;
  orderStatus: string | null;
  orderStatusText: string | null;

  auditorId: number | null;
  auditAt: string | null;
  auditRemark: string | null;
  wxRefundNo: string | null;
  refundedAt: string | null;
  reversed: boolean;
  createdAt: string;

  /** 按钮可用性口径唯一在服务端 */
  canApprove: boolean;
  canReject: boolean;
  blockReason: string | null;
}

export interface RefundsSummary {
  pendingCount: number;
  pendingAmountFen: number;
  approvedCount: number;
  refundedCount: number;
  refundedAmountFen: number;
  rejectedCount: number;
}

export interface RefundsQuery {
  status?: string;
  tab?: RefundTabValue;
  keyword?: string;
  mealDate?: string;
  page?: number;
  pageSize?: number;
}

export interface RefundsPage extends PageResult<RefundRow> {
  tab: RefundTabValue;
  summary: RefundsSummary;
  /** 服务端下发的枚举映射（端上不维护第二份，避免漂移） */
  statusOptions: Array<{ value: string; label: string }>;
  sourceOptions: Array<{ value: string; label: string }>;
}

export interface ApproveRefundPayload {
  remark?: string;
}

export interface ApproveRefundResult {
  refundNo: string;
  orderNo: string;
  status: RefundStatusValue;
  refundedFen: number;
  wxRefundedFen: number;
  balanceRefundedFen: number;
  reversal: {
    balanceRefundedFen: number;
    commissionReversedFen: number;
    commissionReversedQuantity: number;
    supplierShareAdjusted: number;
    supplierShareMode: string;
    notes: string[];
  };
  orderStatusBefore: string | null;
  auditorId: number;
  auditAt: string;
  tips: string;
  order: { orderNo: string; status: string; statusText: string } | null;
  /** 「钱去哪了」的可读留痕（页面上直接展示，不必让运营去猜） */
  executionChain: string[];
}

export interface RejectRefundResult {
  refundNo: string;
  orderNo: string;
  refundStatus: RefundStatusValue;
  orderStatus: string;
  orderStatusText: string;
  fundsMoved: false;
  tips: string;
}

// ---------------------------------------------------------------- D40–D42

/** D40 退款流水 / 待审批列表 */
export function fetchAdminRefunds(params: RefundsQuery): Promise<RefundsPage> {
  return http.get<RefundsPage>('/admin/finance/refunds', params);
}

/** 单条（审批前二次确认；金额必须来自服务端） */
export function fetchRefundDetail(id: number): Promise<RefundRow> {
  return http.get<RefundRow>(`/admin/finance/refunds/detail/${id}`);
}

/** D41 审批通过 → 实际退款（微信原路退 + 余额退回 + 反向结算） */
export function approveRefund(
  id: number,
  payload: ApproveRefundPayload,
): Promise<ApproveRefundResult> {
  return http.post<ApproveRefundResult>(`/admin/finance/refunds/${id}/approve`, payload);
}

/** D42 审批驳回 → 订单回到申请前状态（资金零变动） */
export function rejectRefund(id: number, reason: string): Promise<RejectRefundResult> {
  return http.post<RejectRefundResult>(`/admin/finance/refunds/${id}/reject`, { reason });
}

/* ========================================================================= *
 * D33–D35 资金总览 / 佣金结算（M3-13 · 原型 P34）
 * ========================================================================= */

/** 某日出餐日的应付单状态（四态是**给人看的**，不是库里的三态） */
export type PayableStatusValue = 'none' | 'pending' | 'paid' | 'partial';

/** 逐日出餐日摘要（原型「每日结算跑批」表） */
export interface FinanceDailyRow {
  date: string;
  orderCount: number;
  quantity: number;
  gmvFen: number;
  commissionFen: number;
  purchaseFen: number;
  payableStatus: PayableStatusValue;
  payableStatusText: string;
}

export interface FinanceOverviewQuery {
  /** 统计区间：today / 7d / 30d（与看板 D47 **同一个 `range` 语义**） */
  range?: string;
  /** 区间终点锚点（出餐日），缺省今日 —— 回看已过完的区间用 */
  date?: string;
}

export interface FinanceOverview {
  range: StatsRangeView;
  /** 收入侧（与看板 D47 同一份口径） */
  income: {
    orderCount: number;
    quantity: number;
    gmvFen: number;
    avgOrderAmountFen: number;
    totalOrderCount: number;
    refundCount: number;
    refundRate: number;
  };
  expense: {
    purchaseFen: number;
    commissionFen: number;
    fulfillmentFen: number;
    /** 区间内已退回用户的金额（微信原路退 + 余额回退合计） */
    refundedAmountFen: number;
  };
  payable: {
    totalFen: number;
    unpaidFen: number;
    paidFen: number;
    pendingCount: number;
    paidCount: number;
    generated: boolean;
  };
  /** 平台负债 —— ⚠️ **时点量，不随区间变化** */
  liability: {
    asOf: string;
    balanceFen: number;
    frozenFen: number;
    pendingCommissionFen: number;
    pendingCommissionCount: number;
  };
  profit: { grossProfitFen: number; grossProfitRate: number | null };
  costRegistration: StatsCostRegistration;
  costItems: StatsCostItems;
  warnings: string[];
  daily: FinanceDailyRow[];
  note: string;
}

/** D33 资金总览 */
export const fetchFinanceOverview = (params: FinanceOverviewQuery = {}) =>
  http.get<FinanceOverview>('/admin/finance/overview', params);

export interface FinanceCommissionRow {
  id: number;
  orderNo: string;
  mealDate: string;
  leaderId: number;
  leaderName: string;
  phoneMasked: string;
  leaderLevel: string;
  leaderLevelText: string;
  /** 结算时的费率快照（C2）—— 不是团长当前费率 */
  rate: number;
  baseAmountFen: number;
  quantity: number;
  /** `reversal`（退款冲销）时为**负值** */
  amountFen: number;
  type: string;
  typeText: string;
  status: string;
  statusText: string;
  settledAt: string | null;
  createdAt: string;
}

export interface FinanceCommissionSummary {
  count: number;
  quantity: number;
  earnedFen: number;
  /** 冲销（负值） */
  reversedFen: number;
  netFen: number;
  settledFen: number;
  pendingFen: number;
  cancelledFen: number;
  byLevel: Array<{
    level: string;
    levelText: string;
    count: number;
    quantity: number;
    amountFen: number;
  }>;
}

export interface FinanceCommissionQuery {
  /** 出餐日，缺省今日（明细页是「一天一张表」的习惯，不是区间） */
  date?: string;
  leaderId?: number;
  status?: string;
  type?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export interface FinanceCommissionPage extends PageResult<FinanceCommissionRow> {
  date: string;
  /** 按**同一过滤条件的全量**统计（翻页不跳 KPI） */
  summary: FinanceCommissionSummary;
}

/** D34 佣金结算明细（跨团长） */
export const fetchFinanceCommissions = (params: FinanceCommissionQuery = {}) =>
  http.get<FinanceCommissionPage>('/admin/finance/commissions', params);

export interface SettleCommissionsPayload {
  /** 限定出餐日；缺省 = 全部待入账 */
  date?: string;
}

export interface SettleCommissionsLeader {
  leaderId: number;
  leaderName: string;
  level: string;
  settled: number;
  amountFen: number;
  quantity: number;
}

export interface SettleCommissionsResult {
  date: string | null;
  scanned: number;
  settled: number;
  skipped: number;
  amountFen: number;
  quantity: number;
  leaders: SettleCommissionsLeader[];
  /** 跳过原因（不静默丢弃 —— 运营必须能看见「为什么没结」） */
  skippedReasons: string[];
  /** ⚠️ 口径说明：一期 `scanned` 常态为 0 的原因（**必须展示**，否则会被当成故障） */
  note: string;
}

/**
 * D35 佣金入账（幂等 · 手动触发 / 补跑）
 *
 * **整批单事务**：要么全入账、要么全不入账；并发重复入账按行跳过，不会重复加钱。
 * ⚠️ 一期佣金在「取餐确认」时即时入账，故 `scanned` 常态为 0 —— 这不是故障，
 *    端上必须把返回的 `note` 展示出来。
 */
export const settleCommissions = (payload: SettleCommissionsPayload = {}) =>
  http.post<SettleCommissionsResult>('/admin/finance/commissions/settle', payload);

// ------------------------------------------------------------------ D38 余额账户

/** D38 单条账户行 */
export interface BalanceAccountRow {
  userId: number;
  nickname: string | null;
  avatarUrl: string | null;
  /** 手机号**列表一律脱敏**（同 M3-6 纪律） */
  phoneMasked: string | null;
  isLeader: boolean;
  leaderId: number | null;
  leaderLevel: string | null;
  leaderLevelText: string | null;
  /** 团长状态（1 在职 / 2 停职）；非团长为 null */
  leaderStatus: number | null;
  leaderStatusText: string | null;
  balanceFen: number;
  frozenFen: number;
  /** 可用 + 冻结 */
  netFen: number;
  totalInFen: number;
  totalOutFen: number;
  /** `false` = 从未发生资金往来（余额全 0）—— 此时仍可给他充值（D39 会自动建户） */
  hasAccount: boolean;
  updatedAt: string | null;
}

/** 平台负债（**全量 · 时点量** · 与 D33 资金总览的 `liability` 同源同值） */
export interface BalanceLiability {
  asOf: string;
  balanceFen: number;
  frozenFen: number;
  netFen: number;
  accountCount: number;
  leaderAccountCount: number;
}

/** D38 余额流水（仅精确查单用户时下发最近 20 条） */
export interface BalanceLogRow {
  id: number;
  type: string;
  typeText: string;
  direction: number;
  amountFen: number;
  balanceAfterFen: number;
  relatedId: string | null;
  remark: string | null;
  createdAt: string;
}

export interface BalanceListQuery {
  /** 按用户精确查（返回 `view='single'` + 最近 20 条流水；无账户也会返回一行） */
  userId?: number;
  accountType?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export interface BalanceAccountList extends PageResult<BalanceAccountRow> {
  /** ⭐ 全量负债：**不随筛选变化**（`total` 才是本次筛选命中数） */
  liability: BalanceLiability;
  view: 'list' | 'single';
  accountTypeOptions: Array<{ value: string; label: string }>;
  /**
   * 端上可用动作（**判定权威在服务端 `@Roles`**，此处只让端上不必猜）
   *
   * `canAdjust` 与 `FinanceAdminController` 的 `@Roles(...BALANCE_ADJUST_ROLES)`
   * **共用同一角色常量**，不可能出现「按钮亮着、点了 `10003`」。
   */
  actions: { canAdjust: boolean };
  logs: BalanceLogRow[];
}

/** D38 余额账户管理 */
export const fetchFinanceBalances = (params: BalanceListQuery = {}) =>
  http.get<BalanceAccountList>('/admin/finance/balances', params);

// ------------------------------------------------------------------ D39 余额调整

/** D39 调整动作 */
export type BalanceAdjustAction = 'recharge' | 'deduct' | 'freeze' | 'unfreeze';

export interface AdjustBalancePayload {
  userId: number;
  action: BalanceAdjustAction;
  /** **整数分**（端上从元输入框换算：`Math.round(yuan * 100)`） */
  amountFen: number;
  /** **必填** · 2–128 字 · 写入余额流水 `remark` */
  reason: string;
}

export interface AdjustBalanceResult {
  /** 调整单号（`AJ…`） */
  adjustNo: string;
  action: string;
  actionText: string;
  userId: number;
  nickname: string | null;
  isLeader: boolean;
  amountFen: number;
  balanceBeforeFen: number;
  frozenBeforeFen: number;
  balanceFen: number;
  frozenFen: number;
  netFen: number;
  totalInFen: number;
  totalOutFen: number;
  reason: string;
  operatorId: number;
  operatorName: string;
  logId: number;
}

/**
 * D39 余额调整（幂等 · 资金动作）
 *
 * ⚠️ `idempotencyKey` **必填**：调账没有业务单号可供判重，重复提交就是重复加钱。
 *    键的语义是「**这一笔调整**」：弹窗打开时生成一次，**提交失败重试沿用同一个**
 *    （服务端会返回首次结果而不是再扣一次）；成功后即作废（下次调整是新的一笔）。
 */
export const adjustFinanceBalance = (payload: AdjustBalancePayload, idempotencyKey: string) =>
  http.post<AdjustBalanceResult>('/admin/finance/balances/adjust', payload, {
    headers: { [HEADER.IDEMPOTENCY_KEY]: idempotencyKey },
  });

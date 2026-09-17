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
 *   · **M3-15** —— D43 微信支付对账（差异清单）/ D44 发票管理（进项票台账）
 *   · **M4-4** —— D45 提现审批列表 / D46 批准 · D46a 驳回 · D46b 到账回执 ·
 *     D46c 打款失败（L12 打开的资金链在后台收口）
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
  /** ⚠️ 口径说明：两段式后 `pending` 是常态、`scanned=0` 的确切含义（**必须展示**，否则会被当成故障） */
  note: string;
}

/**
 * D35 佣金入账（幂等 · 手动触发 / 补跑）
 *
 * **整批单事务**：要么全入账、要么全不入账；并发重复入账按行跳过，不会重复加钱。
 * ⚠️ **佣金两段式**：计佣（确认收货时写 `pending`）与入账（T+1 02:00 进余额）分两个
 *    时点，故 `pending` 是**每天的常态**；`scanned=0` 只在当天没有新确认订单时出现 ——
 *    这**不是故障**，端上必须把返回的 `note` 展示出来。
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

/* ========================================================================= *
 * M3-15 · D43 微信支付对账 / D44 发票管理
 * ========================================================================= */

// ------------------------------------------------------------------ D43 对账

/** 差异类型（**刻意与「哪一侧缺数据」直白对应**，便于 3 秒内判断该找谁） */
export type ReconDiffType =
  | 'order_paid_no_log'
  | 'log_success_no_order'
  | 'amount_mismatch'
  | 'duplicate_transaction'
  | 'no_transaction_id';

export interface ReconDiffRow {
  type: ReconDiffType;
  typeText: string;
  orderId: number | null;
  orderNo: string | null;
  /** 订单侧金额（分）；不适用为 `null` */
  orderFen: number | null;
  /** 流水侧金额（分）；不适用为 `null` */
  logFen: number | null;
  /** 差额（分，`orderFen − logFen`）；不适用为 `null` */
  diffFen: number | null;
  transactionId: string | null;
  paidAt: string | null;
  statusText: string;
  /** ⭐ 服务端下发的**下一步动作**（人话，含「不要做什么」）—— 端上不自造 */
  nextAction: string;
}

export interface ReconSummary {
  orderFen: number;
  logFen: number;
  /** `orderFen − logFen`：**正常必须为 0** */
  diffFen: number;
  refundFen: number;
  /** `orderFen − refundFen` 净入账 */
  netFen: number;
  orderCount: number;
  logCount: number;
  refundCount: number;
  matchedCount: number;
  diffCount: number;
  /** ⭐ 同时要求**金额相等**与**无结构差异** —— 金额一样但凭证重复也是「未平」 */
  balanced: boolean;
}

/**
 * ⭐⭐ 渠道信息（**必须原样展示**）
 *
 * 一期 `source='local_only'` + `billAvailable=false`：本页只对了**本地三头**
 * （订单 ↔ 支付流水 ↔ 退款），**不等于已与微信侧对平**。若把它渲染成
 * 「已与微信对账通过」，运营就会停止怀疑 —— 而真正的差异（微信收了钱、
 * 系统不知道）恰恰只能靠账单比对发现。故 `note` 必须可见。
 */
export interface ReconChannel {
  source: 'local_only' | 'bill';
  billAvailable: boolean;
  label: string;
  note: string;
}

export interface ReconciliationView extends PageResult<ReconDiffRow> {
  date: string;
  /** 恒 `'paidAt'` —— 提醒「这里的 date 不是出餐日」 */
  anchor: 'paidAt';
  anchorLabel: string;
  channel: ReconChannel;
  summary: ReconSummary;
  diffTypeStats: Array<{ type: ReconDiffType; label: string; count: number }>;
  note: string;
}

export interface ReconciliationQuery {
  /** **支付日**（北京时间 YYYY-MM-DD，锚在 `paid_at`）；缺省今日 */
  date?: string;
  page?: number;
  pageSize?: number;
}

/** D43 微信支付对账（按**支付日**） */
export const fetchReconciliation = (params: ReconciliationQuery = {}) =>
  http.get<ReconciliationView>('/admin/finance/reconciliation', params);

// ------------------------------------------------------------------ D44 发票

/** 开票状态（**派生值**） */
export type InvoiceStatusValue = 'none' | 'partial' | 'full';

/** 发票台账行（**供应商 × 月份**） */
export interface InvoiceRow {
  payeeId: number;
  supplierName: string;
  /** 开票抬头（D28 独立成列）；未登记为 `null` */
  invoiceTitle: string | null;
  /** 抬头未登记 → 端上引导去 D28 补（没有抬头票开不出来） */
  titleMissing: boolean;
  /** 应付单生成月 `YYYY-MM` */
  month: string;
  rowCount: number;
  paidRowCount: number;
  unpaidRowCount: number;
  /** 已付款应付额（**开票分母**） */
  paidAmountFen: number;
  invoicedFen: number;
  /** 其中未开票金额（**该催的**） */
  uninvoicedFen: number;
  /** 尚未付款的应付额（不进状态判定） */
  unpaidAmountFen: number;
  /** 当月纠错冲销额（负数）—— 需另行换票 */
  reversalFen: number;
  invoiceNos: string[];
  status: InvoiceStatusValue;
  statusText: string;
  firstPaidAt: string | null;
  lastPaidAt: string | null;
  overdueDays: number | null;
  overdue: boolean;
}

export interface InvoiceSummary {
  monthCount: number;
  supplierCount: number;
  paidAmountFen: number;
  invoicedFen: number;
  uninvoicedFen: number;
  unpaidAmountFen: number;
  reversalFen: number;
  noneCount: number;
  partialCount: number;
  fullCount: number;
  overdueCount: number;
  overdueDays: number;
  statusOptions: Array<{ value: string; label: string }>;
}

export interface InvoiceListView extends PageResult<InvoiceRow> {
  /** **筛选后全量**（不受分页影响） */
  summary: InvoiceSummary;
  note: string;
}

export interface InvoiceListQuery {
  /** 按**应付单生成月**筛选（YYYY-MM） */
  month?: string;
  supplierId?: number;
  status?: InvoiceStatusValue;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

/** D44 发票管理（进项票台账 · 派生视图） */
export const fetchInvoices = (params: InvoiceListQuery = {}) =>
  http.get<InvoiceListView>('/admin/finance/invoices', params);

/* ========================================================================= *
 * M4-4 · D45 提现审批列表 / D46–D46c 四动作（原型 P34 · 模块 M35-08）
 * ========================================================================= */

/**
 * 提现状态（与 `@abox/shared-types` 的 `WithdrawStatus` 同源）
 *
 * ⚠️ `paying`（打款中）**一期不会出现**：它是二期 `FLEX_API` 自动通道的中间态。
 *    一期是人工通道，四个动作里没有任何一个会把状态置成 `paying`；
 *    但 `approved` / `paying` 两者都接受「到账登记」与「打款失败」
 *    —— 二期接上 API 后前端无需改动。
 */
export type WithdrawStatusValue =
  'pending' | 'approved' | 'paying' | 'success' | 'rejected' | 'failed';

/** Tab（语义糖，服务端展开成状态集合 —— 端上不自己拼） */
export type WithdrawTabValue = 'review' | 'payout' | 'done' | 'all';

export interface WithdrawRow {
  id: number;
  withdrawNo: string;

  /** 申请金额（分）—— **一切解冻都以它为准** */
  amountFen: number;
  /** 平台代扣个税（分） */
  taxWithheldFen: number;
  /** 实付（分） */
  actualFen: number;
  /**
   * ⭐ 到账前 `taxWithheldAmount` / `actualAmount` 在库里仍是 `apply()` 写入的
   *    初值（申请金额 / 0），**不代表结论**。故服务端只在**已到账**时把这两项
   *    标记为已知；未到账时端上必须显示「待登记」而不是「¥0.00 个税」。
   */
  actualKnown: boolean;
  taxKnown: boolean;

  status: WithdrawStatusValue;
  statusText: string;
  /** `FLEX_MANUAL` 一期人工通道 / `FLEX_API` 二期自动通道 */
  payoutChannel: string;
  /** 通道中文名（服务端下发，端上不自造） */
  payoutChannelText: string;
  payoutBatchNo: string | null;

  receiveType: string;
  /** 收款方式中文名（服务端下发） */
  receiveTypeText: string;
  /** ⚠️ **已是脱敏存储**（申请时 `maskAccount`），原样展示即可，不要再脱一次 */
  receiveAccount: string;
  receiveName: string;

  user: { id: number; nickname: string | null; phoneMasked: string | null };
  leader: {
    id: number;
    realName: string | null;
    level: string;
    levelText: string;
    /** 该团长**此刻**的资产快照 —— 驳回前用它印证「确实冻结着这笔钱」 */
    balanceFen: number;
    frozenFen: number;
    /** 还有多少佣金待入账（两段式下天天产生）—— 回答「驳回后他是不是马上又能提」 */
    pendingCommissionFen: number;
  } | null;

  auditorId: number | null;
  auditAt: string | null;
  auditRemark: string | null;
  failReason: string | null;
  paidAt: string | null;
  createdAt: string;

  /** 按钮可用性口径唯一在服务端（同 D9 / D40） */
  canApprove: boolean;
  canReject: boolean;
  canMarkPaid: boolean;
  canMarkFailed: boolean;
  blockReason: string | null;
}

/**
 * 汇总
 *
 * ⚠️ 两类量**刻意分开**（同 D38）：
 *   · **在途量（时点量）** —— `pending*` / `approved*` / `paying*` /
 *     `frozenByWithdrawFen` 取**全量**，**不随筛选变化**。
 *     「平台此刻因提现占用了用户多少钱」不该因为搜索框里敲了个姓名就变小。
 *   · **历史量** —— `paid*` / `released*` 取**同一过滤条件的全量**（不受分页影响）。
 */
export interface WithdrawSummary {
  /** 快照时刻（时点量必须能被复现） */
  asOf: string;
  pendingCount: number;
  pendingAmountFen: number;
  approvedCount: number;
  approvedAmountFen: number;
  /** 一期恒 0（见 `WithdrawStatusValue` 的说明） */
  payingCount: number;
  payingAmountFen: number;
  /** ⭐ 提现占用的冻结额（待审批 + 已批准 + 打款中）= 可与 `ab_balance.frozen` 的增量互相验算 */
  frozenByWithdrawFen: number;
  paidCount: number;
  paidAmountFen: number;
  /** 已驳回 + 打款失败（两者都已原路解冻） */
  releasedCount: number;
  releasedAmountFen: number;
  /** 本页命中数（= 分页的 `total`，与上面两类都不同） */
  scopedTotal: number;
}

export interface WithdrawListQuery {
  status?: WithdrawStatusValue;
  tab?: WithdrawTabValue;
  payoutBatchNo?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export interface WithdrawListView extends PageResult<WithdrawRow> {
  tab: WithdrawTabValue;
  summary: WithdrawSummary;
  /** 服务端下发的枚举映射（端上不维护第二份，避免漂移） */
  statusOptions: Array<{ value: string; label: string }>;
  tabOptions: Array<{ value: string; label: string }>;
  /**
   * 端上可用动作（**判定权威在服务端 `@Roles`**）
   *
   * `canAudit` 与 D46 系列四个端点的 `@Roles(...FUND_ACTION_ROLES)`
   * **共用同一角色常量** —— 不可能出现「按钮亮着、点了 `10003`」。
   */
  actions: { canAudit: boolean };
}

/** 审批（驳回 / 到账 / 失败）四个动作的共用出参：动作后的余额快照 */
export interface WithdrawMoneySnapshot {
  balanceBeforeFen: number;
  frozenBeforeFen: number;
  balanceFen: number;
  frozenFen: number;
  totalInFen: number;
  totalOutFen: number;
}

export interface ApproveWithdrawPayload {
  /** 缺省由服务端生成 `PB{yyyyMMdd}`（按**审批日**聚合） */
  payoutBatchNo?: string;
  remark?: string;
}

export interface ApproveWithdrawResult {
  id: number;
  withdrawNo: string;
  status: WithdrawStatusValue;
  statusText: string;
  amountFen: number;
  payoutBatchNo: string;
  auditorId: number;
  auditorName: string;
  /** 恒 `false`：批准**不动钱**（余额已在申请时就冻结） */
  moneyMoved: false;
  /** 下一步该做什么（服务端下发人话，端上不自造） */
  nextStep: string;
}

export interface RejectWithdrawResult extends WithdrawMoneySnapshot {
  id: number;
  withdrawNo: string;
  status: WithdrawStatusValue;
  statusText: string;
  amountFen: number;
  reason: string;
  auditorId: number;
  auditorName: string;
  moneyMoved: true;
  tips: string;
}

export interface MarkWithdrawPaidPayload {
  /** 平台代扣个税（分）—— 与 `actualFen` **可单传可同传**，同传时必须自洽 */
  taxWithheldFen?: number;
  /** 实付（分） */
  actualFen?: number;
  paidAt?: string;
  payoutBatchNo?: string;
  remark?: string;
}

export interface MarkWithdrawPaidResult extends WithdrawMoneySnapshot {
  id: number;
  withdrawNo: string;
  status: WithdrawStatusValue;
  statusText: string;
  amountFen: number;
  taxWithheldFen: number;
  actualFen: number;
  /**
   * ⭐ 代扣额的来源：
   *   · `explicit` 运营两栏都填了并已校验自洽
   *   · `derived` 只填一栏，另一栏由「申请 − 已填」推出
   *   · `assumed_zero` **两栏都没填** → 系统替你假设了「无代扣」
   * 端上必须把 `assumed_zero` 显示出来 —— 否则「个税为 0」会被当成结论。
   */
  taxSource: 'explicit' | 'derived' | 'assumed_zero';
  paidAt: string;
  payoutBatchNo: string | null;
  auditorId: number;
  auditorName: string;
  tips: string;
}

export interface FailWithdrawPayload {
  /** 必填 · 2–256 字 */
  failReason: string;
  payoutBatchNo?: string;
  remark?: string;
}

export interface FailWithdrawResult extends WithdrawMoneySnapshot {
  id: number;
  withdrawNo: string;
  status: WithdrawStatusValue;
  statusText: string;
  amountFen: number;
  failReason: string;
  moneyMoved: true;
  tips: string;
}

/** D45 提现审批列表 */
export function fetchAdminWithdrawals(params: WithdrawListQuery): Promise<WithdrawListView> {
  return http.get<WithdrawListView>('/admin/finance/withdrawals', params);
}

/**
 * D46 审批通过（登记批次号）
 *
 * ⚠️ **不动钱**：申请一瞬间余额已被冻结，批准只是「同意把这笔冻结额出款」
 *    —— 故本动作既不写余额流水、也不改 `total_out`。
 */
export function approveWithdrawal(
  id: number,
  payload: ApproveWithdrawPayload = {},
): Promise<ApproveWithdrawResult> {
  return http.post<ApproveWithdrawResult>(`/admin/finance/withdrawals/${id}/approve`, payload);
}

/**
 * D46a 审批驳回 → **原路解冻**（`balance +X / frozen −X`，`total_in`/`total_out` 都不动）
 *
 * `reason` 必填且 ≥2 字：团长端会看到这句话。
 */
export function rejectWithdrawal(id: number, reason: string): Promise<RejectWithdrawResult> {
  return http.post<RejectWithdrawResult>(`/admin/finance/withdrawals/${id}/reject`, { reason });
}

/**
 * D46b 到账回执登记（一期人工通道的**唯一收口**）
 *
 * ⚠️ `total_out` 按**申请金额**累加（不是实付）—— 代扣个税是平台代缴给税务的，
 *    不是平台留存；若按实付记，账面会永久留下一个等于税额的缺口。
 * ⚠️ **不写余额流水**：到账那刻**可用余额不变**，没有一条属于它的 `ab_balance_log`。
 */
export function markWithdrawalPaid(
  id: number,
  payload: MarkWithdrawPaidPayload = {},
): Promise<MarkWithdrawPaidResult> {
  return http.post<MarkWithdrawPaidResult>(`/admin/finance/withdrawals/${id}/paid`, payload);
}

/** D46c 打款失败 → **原路解冻**（同驳回口径；团长可重新申请） */
export function markWithdrawalFailed(
  id: number,
  payload: FailWithdrawPayload,
): Promise<FailWithdrawResult> {
  return http.post<FailWithdrawResult>(`/admin/finance/withdrawals/${id}/fail`, payload);
}

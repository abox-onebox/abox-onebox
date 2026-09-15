import { http } from './request';
import type { PageResult } from './system';

/**
 * api/order —— 后台订单中心（《接口规范 v1.0》§6.2 D8–D12 · 原型 P30/P31）
 *
 * 与 `api/leader.ts` 的分工：那是团长侧「我所辖订单」（脱敏 + 导出留痕）；
 * 本文件是**全平台**视图。两者共用 `ab_order`，越权与脱敏规则一致 ——
 * 后台列表同样只给 `phoneMasked`，只有 D12 导出给完整号且服务端强制留痕。
 */

/** 订单状态（11 态，与 `@abox/shared-types` 同源；此处在端上只作类型约束） */
export type AdminOrderStatus =
  | 'pending_pay'
  | 'paid'
  | 'cut_off'
  | 'cooked'
  | 'delivering'
  | 'delivered'
  | 'completed'
  | 'cancelled'
  | 'refund_applying'
  | 'refunding'
  | 'refunded';

export interface AdminOrderRow {
  orderNo: string;
  mealDate: string;
  status: AdminOrderStatus;
  /** 后台视角状态文案（服务端给，端上不自造） */
  statusText: string;
  quantity: number;
  unitPriceFen: number;
  totalAmountFen: number;
  balanceUsedFen: number;
  payAmountFen: number;
  userName: string | null;
  /** ⚠️ 列表只给脱敏号；完整号仅在 D12 导出 */
  phoneMasked: string;
  userId?: number;
  buildingId: number;
  buildingName: string | null;
  groupId: number;
  groupName: string | null;
  leaderId: number | null;
  leaderName: string | null;
  setMealId: number;
  setMealName: string | null;
  mainDishName: string | null;
  remark: string | null;
  createdAt: string;
  paidAt: string | null;
  completedAt: string | null;
  refund: {
    refundNo: string;
    status: string;
    statusText: string;
    amountFen: number;
    applySource: string;
    applySourceText: string;
  } | null;
}

export interface AdminOrdersSummary {
  totalCount: number;
  validCount: number;
  validQuantity: number;
  validAmountFen: number;
  abnormalCount: number;
  pendingPayCount: number;
  refundingCount: number;
}

export interface AdminOrdersQuery {
  mealDate?: string;
  startDate?: string;
  endDate?: string;
  buildingId?: number;
  groupId?: number;
  leaderId?: number;
  status?: string;
  keyword?: string;
  tab?: 'all' | 'abnormal';
  page?: number;
  pageSize?: number;
}

export interface AdminOrdersPage extends PageResult<AdminOrderRow> {
  summary: AdminOrdersSummary;
  tab: 'all' | 'abnormal';
}

export interface AdminOrderDish {
  slot: number;
  slotLabel: string;
  dishId: number;
  name: string;
  supplierId: number;
  supplierName: string | null;
  shareAmountFen: number | null;
}

export interface AdminOrderTimelineNode {
  node: string;
  at: string | null;
  done: boolean;
  text: string;
}

export interface AdminOrderRefundDetail {
  refundNo: string;
  status: string;
  statusText: string;
  amountFen: number;
  applySource: string;
  applySourceText: string;
  reasonType: string | null;
  reasonTypeText: string | null;
  reason: string | null;
  teamLeaderId: number | null;
  auditorId: number | null;
  auditAt: string | null;
  auditRemark: string | null;
  wxRefundNo: string | null;
  refundedAt: string | null;
  reversed: boolean;
  createdAt: string;
}

export interface AdminOrderCommissionRow {
  id: number;
  type: string;
  status: string;
  leaderId: number;
  leaderLevel: string;
  rate: number;
  baseAmountFen: number;
  quantity: number;
  amountFen: number;
  mealDate: string;
  settledAt: string | null;
}

export interface AdminOperationLogRow {
  id: number;
  adminUserId: number | null;
  operator: string | null;
  action: string;
  requestIp: string | null;
  requestData: unknown;
  responseData: unknown;
  createdAt: string | null;
}

export interface AdminOrderDetail {
  order: AdminOrderRow;
  dishes: AdminOrderDish[];
  timeline: AdminOrderTimelineNode[];
  refund: AdminOrderRefundDetail | null;
  payment: {
    transactionId: string | null;
    payMethod: string;
    amountFen: number;
    status: string;
    paidAt: string | null;
  } | null;
  commission: AdminOrderCommissionRow[];
  leader: {
    id: number;
    name: string | null;
    phoneMasked: string;
    level: string;
    commissionRate: number;
    status: number;
  } | null;
  /** 端上据此置灰按钮并显示原因 —— 口径唯一在服务端 */
  actions: {
    canAdjust: boolean;
    adjustBlockReason: string | null;
    canForceRefund: boolean;
    refundBlockReason: string | null;
    refundableFen: number;
  };
  operationLogs: AdminOperationLogRow[];
}

export interface ManualAdjustPayload {
  orderNo: string;
  action: 'change_quantity' | 'change_building';
  quantity?: number;
  buildingId?: number;
  reason: string;
}

export interface ManualAdjustResult {
  orderNo: string;
  action: string;
  reason: string;
  changed: boolean;
  before: Record<string, number | string>;
  after: Record<string, number | string>;
  frozenDeltaFen: number;
  tips: string;
}

export interface ForceRefundPayload {
  reason: string;
  reasonType?: string;
  amountFen?: number;
}

export interface ForceRefundResult {
  refundNo: string;
  orderNo: string;
  status: string;
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
  tips: string;
}

export interface OrderExportResult {
  fileName: string;
  count: number;
  truncated: boolean;
  headers: string[];
  list: string[][];
}

// ---------------------------------------------------------------- D8–D12

/** 筛选项（D8/D12 前置数据源） */
export interface OrderFilterOptions {
  groups: Array<{ id: number; name: string; status: number }>;
  buildings: Array<{ id: number; name: string; groupId: number | null }>;
  leaders: Array<{
    id: number;
    name: string;
    buildingId: number | null;
    level: string;
    status: number;
  }>;
  statuses: Array<{ value: string; label: string }>;
}

export function fetchOrderFilterOptions(): Promise<OrderFilterOptions> {
  return http.get<OrderFilterOptions>('/admin/orders/filter-options');
}

/** D8 全平台订单流（tab=abnormal 为异常：待支付 + 退款待处理，已取消不算异常） */
export function fetchAdminOrders(params: AdminOrdersQuery): Promise<AdminOrdersPage> {
  return http.get<AdminOrdersPage>('/admin/orders', params);
}

/** D9 订单详情（含菜品、支付、退款、佣金、时间线、操作日志、可操作性判据） */
export function fetchAdminOrderDetail(orderNo: string): Promise<AdminOrderDetail> {
  return http.get<AdminOrderDetail>(`/admin/orders/${orderNo}`);
}

/** D10 手动改单（目标值语义：重试不会翻倍） */
export function manualAdjustOrder(payload: ManualAdjustPayload): Promise<ManualAdjustResult> {
  return http.post<ManualAdjustResult>('/admin/orders/manual-adjust', payload);
}

/** D11 后台强制退款（微信原路退 + 余额退回 + 反向结算） */
export function forceRefundOrder(
  orderNo: string,
  payload: ForceRefundPayload,
): Promise<ForceRefundResult> {
  return http.post<ForceRefundResult>(`/admin/orders/${orderNo}/force-refund`, payload);
}

/** D12 订单导出（完整手机号 · 服务端强制留痕）；端上据 headers 拼 CSV */
export function exportAdminOrders(params: AdminOrdersQuery): Promise<OrderExportResult> {
  return http.get<OrderExportResult>('/admin/orders/export', params);
}

/** 状态筛选项（服务端 `ORDER_STATUS_VIEW.admin` 的镜像；端上仅用于下拉选项） */
export const ADMIN_ORDER_STATUS_OPTIONS: Array<{ value: AdminOrderStatus; label: string }> = [
  { value: 'pending_pay', label: '待支付' },
  { value: 'paid', label: '已支付' },
  { value: 'cut_off', label: '已截单' },
  { value: 'cooked', label: '已出餐' },
  { value: 'delivering', label: '配送中' },
  { value: 'delivered', label: '待取餐' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
  { value: 'refund_applying', label: '退款申请中' },
  { value: 'refunding', label: '退款中' },
  { value: 'refunded', label: '已退款' },
];

/** 退款原因类型（与 shared-types 同源，端上仅作下拉） */
export const REFUND_REASON_OPTIONS = [
  { value: 'quality', label: '品质问题' },
  { value: 'missing', label: '缺漏少送' },
  { value: 'late', label: '配送延误' },
  { value: 'wrong', label: '错单错送' },
  { value: 'other', label: '其他' },
];

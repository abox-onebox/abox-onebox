import { http } from './request';
import type { PageResult } from './system';

/**
 * api/finance —— 后台财务（《接口规范 v1.0》§6.5 · 原型 P34）
 *
 * 本文件当前覆盖 **C6 三段式的第二段**：退款审批（D40 流水 / D41 通过 / D42 驳回）。
 * D33–D39、D43–D46（资金总览、应付结算、余额调整、对账、提现审批）属后续批次。
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

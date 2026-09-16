import { http } from './request';
import type { PageResult } from './system';

/**
 * api/supplier-share —— **运营后台**应付结算（S9 · P34 · M3-9）
 *
 * ⚠️ 与 `api/supplier-portal.ts` 的 S4（`/supplier/settlement` · 供应商端自查）
 *    **不是一回事**：本文件走 `/admin/supplier-shares/*`，操作者只能是
 *    `super_admin` / `admin` / `finance`；`operator` 只**读**（不能出单、不能登记付款），
 *    `viewer` 根本进不来。服务端按角色收窄，端上不做权限判断。
 *
 * 口径（《ABox一盒自营结算口径定义v1.0.md》）：
 *   · 计费基数 = **实收量**（供应商出餐确认申报的实送份数），**不是订单销量**
 *   · 单价 = 逐菜协商采购价（**出餐计划生成时冻结的快照**）
 *   · 应付对象只剩供应商；场地/打包/配送是自身成本，**不出付款单**
 *   · ⭐ 用户退款**不冲减**应付（半成品在出餐日已交付）
 *
 * ⚠️ 金额一律**整数分**（`Fen` 结尾）；端上只做展示换算，不参与口径计算。
 */

export type ShareStatusValue = 'pending' | 'success' | 'failed' | 'reversed';

export interface SupplierShareRow {
  id: number;
  shareNo: string;
  /** 应付生成日（T+1 跑批执行日） */
  shareDate: string;
  /** 出餐日（这一笔对应哪天的交付） */
  mealDate: string;
  payeeType: string;
  supplierId: number;
  supplierName: string;
  dishId: number | null;
  dishName: string | null;
  /** 实收量（= 计费基数） */
  quantity: number;
  unitPriceFen: number;
  amountFen: number;
  type: string;
  /** 恒 manual（人工对公转账 · C10 不接支付通道） */
  channel: string;
  status: ShareStatusValue;
  statusLabel: string;
  paymentVoucherNo: string | null;
  invoiceNo: string | null;
  paidAt: string | null;
  settledAt: string | null;
  createdAt: string;
  /** 按钮可用性口径唯一在服务端 */
  canRegisterPayment: boolean;
  blockReason: string | null;
}

export interface SharesSummary {
  rowCount: number;
  amountFen: number;
  pendingCount: number;
  pendingAmountFen: number;
  paidCount: number;
  paidAmountFen: number;
  reversedCount: number;
  reversedAmountFen: number;
  supplierCount: number;
}

export interface SharesQuery {
  date?: string;
  supplierId?: number;
  status?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export interface SharesPage extends PageResult<SupplierShareRow> {
  date: string | null;
  /** 按**同一过滤条件的全量**统计（翻页不跳 KPI） */
  summary: SharesSummary;
  statusOptions: Array<{ value: string; label: string }>;
}

export interface GenerateSharesPayload {
  /** 出餐日（必填 —— 出单对象是「某个出餐日的交付量」） */
  date: string;
  supplierId?: number;
}

export interface ShareCreatedItem {
  id: number | null;
  shareNo: string;
  supplierId: number;
  supplierName: string;
  dishId: number;
  dishName: string;
  planQuantity: number;
  quantity: number;
  unitPriceFen: number;
  amountFen: number;
}

export interface ShareSkippedItem {
  supplierId: number;
  supplierName: string;
  dishId: number;
  dishName: string;
  reason: string;
  shareNo: string;
}

export interface ShareExceptionItem {
  supplierId: number;
  supplierName: string;
  dishId: number;
  dishName: string;
  planQuantity: number;
  /** 该菜当日生产计划状态：pending / cooking / done */
  dailyStatus: string;
  /** not_started / incomplete / actual_missing / license_invalid / zero_quantity */
  reason: string;
  /** 人话说明（服务端下发，端上不维护第二份） */
  reasonText: string;
}

export interface GenerateSharesResult {
  date: string;
  created: ShareCreatedItem[];
  skipped: ShareSkippedItem[];
  exceptions: ShareExceptionItem[];
  summary: {
    createdCount: number;
    createdAmountFen: number;
    skippedCount: number;
    exceptionCount: number;
    candidateCount: number;
  };
  notes: Record<string, string>;
}

export interface ShareExceptionsResult {
  date: string;
  list: ShareExceptionItem[];
  summary: {
    count: number;
    supplierCount: number;
    dishCount: number;
    byReason: Record<string, number>;
  };
  notes: Record<string, string>;
}

export interface RegisterPaymentPayload {
  /** 银行回单号（必填 —— 付款完成的唯一凭证） */
  paymentVoucherNo: string;
  /** 供应商发票号（自营口径下是税前扣除凭证，建议登记） */
  invoiceNo?: string;
}

/** 应付单列表（按出餐日 / 供应商 / 状态 / 关键词） */
export const fetchSupplierShares = (params: SharesQuery = {}) =>
  http.get<SharesPage>('/admin/supplier-shares', params);

/** 未出单异常清单（`date` 必填：这份清单回答的是「某一天为什么没出单」） */
export const fetchShareExceptions = (date: string, supplierId?: number) =>
  http.get<ShareExceptionsResult>(
    '/admin/supplier-shares/exceptions',
    supplierId ? { date, supplierId } : { date },
  );

/**
 * 生成应付单（幂等 · 可重跑）
 *
 * 跑批（T+1 02:00）与运营手动补跑**共用同一执行口**，因此不会出现
 * 「跑批一种算法、点按钮另一种」。同一（供应商 · 菜品 · 出餐日）已有单则跳过。
 */
export const generateSupplierShares = (payload: GenerateSharesPayload) =>
  http.post<GenerateSharesResult>('/admin/supplier-shares/generate', payload);

/** 付款登记（人工对公转账后回填凭证 · C10：系统只记账，不走通道） */
export const registerSharePayment = (id: number, payload: RegisterPaymentPayload) =>
  http.post<SupplierShareRow & { tips: string }>(`/admin/supplier-shares/${id}/payment`, payload);

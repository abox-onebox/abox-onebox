import { http } from './request';
import type { PageResult } from './system';

/**
 * api/supplier —— 后台供应商管理（《接口规范 v1.0》§6.4 D23–D32 · 原型 P33）
 *
 * ⚠️ 与 `supplier` 端的 S 系列接口**不是一回事**：本文件走 `/admin/suppliers/*`
 *    与 `/admin/dishes`、`/admin/distribution-centers`，主体是 `ab_admin_user`；
 *    供应商 Web 走 `/supplier/*`，主体是 `ab_admin_user` 里 `role=supplier` 的账号。
 *    两者在 `JwtAuthGuard` 就按 `typ` 分流了。
 *
 * ⚠️ 金额一律**整数分**（`Fen` 结尾）。表单里用户填「元」，提交前用 `yuanToFen()`
 *    转换一次 —— 别在组件里散落 `* 100`。
 *
 * ⚠️ 枚举文案（审核状态 / 档位 / 平台）**由服务端下发或取自
 *    `@abox/shared-types`**，不在此维护第二份中文映射。
 */

// ============================================================================
// D23 供应商名录
// ============================================================================

export interface SupplierRow {
  id: number;
  name: string;
  /**
   * ⚠️ M4-0 起服务端**不再下发** `type` / `typeLabel`（供应商类型已停用，
   * 自营下只有「半成品供货方」一种角色）、也不再下发 `dcCount`
   * （加工场所属 ABox 自有，不挂在供应商名下）。
   */
  contactName: string;
  /** 列表只给脱敏号；详情才给真实号码 */
  contactPhoneMasked: string | null;
  category: string | null;

  auditStatus: string;
  auditStatusLabel: string;
  auditRemark: string | null;
  auditedAt: string | null;
  auditedBy: number | null;
  auditedByName: string | null;

  licenseExpireAt: string | null;
  /** normal / expiring / expired / unknown —— 派生值 */
  licenseState: string;
  licenseStateLabel: string;
  /** 距到期天数（已过期为负；未登记为 null）*/
  licenseDaysLeft: number | null;

  status: number;
  statusLabel: string;

  dishCount: number;
  /** 本月采购应付（含纠错冲销负行）*/
  monthShareFen: number;
  /** 已配置外卖链接的平台 key 列表 */
  takeoutPlatforms: string[];
  /** 合作中 ∧ 资质通过 ∧ 证照未过期 */
  canServe: boolean;
  capacityPerDay: number | null;
}

export interface SuppliersSummary {
  totalCount: number;
  activeCount: number;
  suspendedCount: number;
  // ⚠️ M4-0 删除 4 项：`dishCount` / `distributeCount` / `bothCount`（依赖已停用的
  //    `type`）与 `dcTotalCount`（依赖已停用的「场所归属供应商」）。
  //    恒为 0 或恒等于 totalCount 的 KPI 不是指标，是噪音。
  auditPendingCount: number;
  auditApprovedCount: number;
  auditRejectedCount: number;
  expiringCount: number;
  expiredCount: number;
  canServeCount: number;
}

export interface SuppliersQuery {
  // ⚠️ M4-0：`type` 筛选已移除（供应商类型停用）
  status?: number;
  auditStatus?: string;
  licenseState?: string;
  category?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export interface Option {
  value: string | number;
  label: string;
}

export interface SuppliersPage extends PageResult<SupplierRow> {
  summary: SuppliersSummary;
  auditStatusOptions: Option[];
  statusOptions: Option[];
  categoryOptions: Option[];
  payeeTypeOptions: Option[];
  actions: { canManage: boolean };
  notes?: Record<string, string>;
}

export const fetchAdminSuppliers = (params: SuppliersQuery) =>
  http.get<SuppliersPage>('/admin/suppliers', params);

export interface SupplierDetail {
  supplier: SupplierRow;
  contactPhone: string | null;
  contactPhoneMasked: string | null;
  bank: {
    payeeType: string;
    payeeTypeLabel: string;
    bankName: string | null;
    /** ⚠️ 只有脱敏号 —— 服务端不回账号原文 */
    bankAccountMasked: string | null;
    invoiceTitle: string | null;
  };
  dishes: DishRow[];
  // ⚠️ M4-0 删除 `distributionCenters`：加工场所属 ABox 自有，不挂在供应商名下。
  recentShares: Array<{
    id: number;
    shareNo: string;
    shareDate: string;
    mealDate: string;
    dishId: number | null;
    quantity: number;
    unitPriceFen: number;
    amountFen: number;
    type: string;
    status: string;
  }>;
  operationLogs: Array<{
    id: number;
    module: string;
    action: string;
    adminUserId: number | null;
    createdAt: string | null;
  }>;
  takeout: TakeoutOut;
}

export const fetchSupplierDetail = (id: number) =>
  http.get<SupplierDetail>(`/admin/suppliers/${id}`);

// ============================================================================
// D24 / D25 / D26 / D28（D27 已下线）
// ============================================================================

export interface SupplierWritePayload {
  name?: string;
  // ⚠️ M4-0 无 `type`：传上来会被 `forbidNonWhitelisted` 直接拒（10001）
  contactName?: string;
  contactPhone?: string;
  category?: string;
  businessLicense?: string;
  foodLicense?: string;
  licenseExpireAt?: string;
  address?: string;
  capacityPerDay?: number;
  payeeType?: string;
  /** D25 独有：本接口是供应商启停的唯一入口 */
  status?: number;
}

export const createSupplier = (data: SupplierWritePayload) =>
  http.post<{ id: number; name: string; auditStatus: string; status: number }>(
    '/admin/suppliers',
    data,
  );

export interface UpdateSupplierResult {
  id: number;
  status: number;
  licenseExpireAt: string | null;
  licenseState: string;
  /** 因证照落成过期而**联动下架**的菜品数（>0 时前端必须明确提示）*/
  unpublishedDishCount: number;
  canServe: boolean;
}

export const updateSupplier = (id: number, data: SupplierWritePayload) =>
  http.put<UpdateSupplierResult>(`/admin/suppliers/${id}`, data);

export interface AuditResult {
  id: number;
  auditStatus: string;
  auditStatusLabel: string;
  licenseExpireAt: string | null;
  licenseState: string;
  /** 审核**不影响**合作状态，服务端显式回带 */
  status: number;
  canServe: boolean;
}

export const auditSupplier = (
  id: number,
  data: { result: 'approved' | 'rejected'; licenseExpireAt?: string; remark?: string },
) => http.post<AuditResult>(`/admin/suppliers/${id}/audit`, data);

// ⚠️ M4-0：`setSupplierType`（D27）已删除 —— 端点整体下线，
//    留着这个函数会让页面很容易把「设置类型」按钮又接回来。

export interface SettleAccountResult {
  id: number;
  payeeType: string;
  payeeTypeLabel: string;
  bankName: string | null;
  bankAccountMasked: string | null;
  invoiceTitle: string | null;
}

export const setSettleAccount = (
  id: number,
  data: { payeeType: string; bankName?: string; bankAccount?: string; invoiceTitle?: string },
) => http.put<SettleAccountResult>(`/admin/suppliers/${id}/settle-account`, data);

// ============================================================================
// 扩展 · 外卖平台店铺链接
// ============================================================================

export interface TakeoutLinkItem {
  platform: string;
  platformLabel: string;
  url: string | null;
  shopId: string | null;
  configured: boolean;
}

export interface TakeoutOut {
  /** ⚠️ 三个平台**一律返回**（未配置的 configured=false），前端据此显示灰色「未入驻」*/
  links: TakeoutLinkItem[];
  recommended: string | null;
  configuredCount: number;
}

export const setTakeoutLinks = (
  id: number,
  data: {
    meituan?: { url?: string | null; shopId?: string | null };
    taobao?: { url?: string | null; shopId?: string | null };
    jd?: { url?: string | null; shopId?: string | null };
    recommended?: string;
  },
) => http.put<TakeoutOut>(`/admin/suppliers/${id}/takeout-links`, data);

// ============================================================================
// 扩展 · 菜品库
// ============================================================================

export interface DishRow {
  id: number;
  supplierId: number;
  supplierName: string | null;
  name: string;
  category: string | null;
  categoryLabel: string;
  /** 供价（分）· C9 逐菜协商价 */
  costPriceFen: number;
  /** 元串，仅供输入框回填 */
  costPriceYuan: string;
  status: number;
  statusLabel: string;
  saleCount: number;
  rating: number;
  description: string | null;
  imageUrl: string | null;
}

export interface DishesQuery {
  supplierId?: number;
  category?: string;
  status?: number;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export interface DishesPage extends PageResult<DishRow> {
  summary: {
    totalCount: number;
    onSaleCount: number;
    offSaleCount: number;
    avgPriceFen: number;
    totalSaleCount: number;
  };
  categoryOptions: Option[];
  supplierOptions: Option[];
  actions: { canManage: boolean };
  notes?: Record<string, string>;
}

export const fetchAdminDishes = (params: DishesQuery) =>
  http.get<DishesPage>('/admin/dishes', params);

export const createDish = (data: {
  supplierId: number;
  name: string;
  category: string;
  costPriceFen: number;
  description?: string;
  imageUrl?: string;
  status?: number;
}) => http.post<{ id: number; name: string; costPriceFen: number }>('/admin/dishes', data);

export const updateDish = (
  id: number,
  data: {
    name?: string;
    category?: string;
    costPriceFen?: number;
    description?: string;
    imageUrl?: string;
    status?: number;
  },
) => http.put<Record<string, unknown>>(`/admin/dishes/${id}`, data);

export const batchDishStatus = (data: { ids: number[]; status: number; reason?: string }) =>
  http.post<{
    requested: number;
    changed: number;
    skipped: number;
    status: number;
    reason: string | null;
  }>('/admin/dishes/batch-status', data);

// ============================================================================
// D29–D32 集散中心配置
// ============================================================================

export interface DistributionCenterRow {
  id: number;
  name: string;
  /**
   * ⚠️ M4-0：`supplierId` / `supplierName` / `supplierType` 已从出参移除 ——
   * 加工场所属 **ABox 自有**，不归属合作供应商。
   */
  address: string;
  contactName: string | null;
  contactPhone: string | null;
  /** 场地摊销（分）· 默认 0 = **未登记**（不是免费） */
  riceFeeFen: number;
  riceFeeYuan: string;
  /** 打包人工（分）· 默认 0 = **未登记**（不是免费） */
  packFeeFen: number;
  packFeeYuan: string;
  serviceGroups: number[];
  serviceGroupNames: string[];
  serviceGroupCount: number;
  status: number;
  statusLabel: string;
  /** 历史应付笔数（决定能否删除）*/
  shareCount: number;
  /** 历史应付金额（分）—— 与笔数是两件事 */
  shareAmountFen: number;
  assignCount: number;
  /** 两道前置都为空才为 true；前端据此禁用「删除」按钮 */
  canDelete: boolean;
}

export interface DcsQuery {
  status?: number;
  // ⚠️ M4-0：`supplierId` 筛选已移除（场所不归属供应商）
  groupId?: number;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export interface DcsPage extends PageResult<DistributionCenterRow> {
  summary: {
    totalCount: number;
    activeCount: number;
    suspendedCount: number;
    totalRiceFeeFen: number;
    totalPackFeeFen: number;
    servedGroupCount: number;
  };
  statusOptions: Option[];
  groupOptions: Option[];
  actions: { canManage: boolean };
  notes?: Record<string, string>;
}

export const fetchDistributionCenters = (params: DcsQuery) =>
  http.get<DcsPage>('/admin/distribution-centers', params);

export interface DcWritePayload {
  name?: string;
  // ⚠️ M4-0：无 `supplierId` —— 场所属 ABox 自有（传上来会被直接拒 10001）
  address?: string;
  contactName?: string;
  contactPhone?: string;
  riceFeeFen?: number;
  packFeeFen?: number;
  /** ⚠️ 整体替换语义：传 [] 即清空 */
  serviceGroups?: number[];
  status?: number;
}

export const createDistributionCenter = (data: DcWritePayload) =>
  http.post<{ id: number; name: string; status: number }>('/admin/distribution-centers', data);

export const updateDistributionCenter = (id: number, data: DcWritePayload) =>
  http.put<Record<string, unknown>>(`/admin/distribution-centers/${id}`, data);

export const deleteDistributionCenter = (id: number) =>
  http.delete<{ id: number; deleted: boolean; status: number }>(
    `/admin/distribution-centers/${id}`,
  );

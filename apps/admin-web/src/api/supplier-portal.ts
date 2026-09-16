import { http } from './request';

/**
 * api/supplier-portal —— **供应商端**出餐链路（《接口规范 v1.0》§6.5 S1–S2 / S9 · 原型 P21/P22/P25）
 *
 * ⚠️ 与 `api/supplier.ts`（**运营后台** `/admin/suppliers/*` · P33）**不是一回事**：
 *    本文件走 `/supplier/*`，主体是 `role=supplier` 的后台账号；
 *    服务端在 `JwtAuthGuard` 就按 `typ` 分流，数据范围由 token 里的 `supplierId` 决定。
 *
 * ⚠️ **S3 打包任务已迁运营后台**（M4-0）：见 `api/packing.ts`（`/admin/packing-tasks`）。
 *
 * ⚠️ 请求体里**不发 `supplierId`** —— 主体由登录态决定。多带这个字段会被
 *    `forbidNonWhitelisted` 直接拒（10001），这是刻意的：收下它就等于允许
 *    「A 供应商改 B 的计划」。
 *
 * ⚠️ 金额出参一律**整数分**（`Fen` 结尾）。
 */

// ============================================================================
// S1 出餐工作台（P21）
// ============================================================================

export interface PortalCenter {
  distributionCenterId: number;
  centerName: string;
  centerAddress: string | null;
  /** 应送份数（分中心） */
  planQuantity: number;
  /** 实送份数（确认时登记；未确认为 null） */
  actualQuantity: number | null;
  /** pending / confirmed */
  status: string;
  confirmedAt: string | null;
}

export interface PortalDish {
  dishId: number;
  dishName: string;
  category: string | null;
  imageUrl: string | null;
  unitPriceFen: number;
  planQuantity: number;
  confirmedQuantity: number;
  pendingQuantity: number;
  /** 父行状态（由明细派生）：pending 未开工 / cooking 部分送达 / done 全部送达 */
  status: string;
  completedAt: string | null;
  centers: PortalCenter[];
}

export interface PortalSupplier {
  id: number;
  name: string;
  // ⚠️ M4-0：`type` / `typeLabel` 已从出参移除（自营下供应商只有「半成品供货方」一种角色）
  status: number;
  statusLabel: string;
  auditStatus: string;
  auditStatusLabel: string;
  licenseState: string;
  /** 出餐前置判据（合作中 ∧ 资质已通过 ∧ 证照未过期）—— 为 false 时确认必被 50001 拦 */
  canServe: boolean;
}

export interface WorkbenchData {
  date: string;
  supplier: PortalSupplier;
  deadline: {
    text: string;
    at: string | null;
    overdue: boolean;
    canConfirm: boolean;
  };
  dishes: PortalDish[];
  summary: {
    dishCount: number;
    centerCount: number;
    planQuantity: number;
    confirmedQuantity: number;
    pendingQuantity: number;
    allConfirmed: boolean;
    /** 当日没有派到任何生产计划（断团 / 截单后未生成）→ 端上走空态 */
    empty: boolean;
  };
  notes: Record<string, string>;
}

export const fetchWorkbench = (date?: string) =>
  http.get<WorkbenchData>('/supplier/workbench', date ? { date } : undefined);

// ============================================================================
// S2 出餐确认（P22）
// ============================================================================

export interface CookConfirmItem {
  dishId: number;
  distributionCenterId: number;
  /** 不传 = 足额送达；传了以申报值为准（短送留痕） */
  actualQuantity?: number;
  remark?: string;
}

export interface CookConfirmResult {
  date: string;
  confirmed: Array<{
    dishId: number;
    dishName: string | null;
    distributionCenterId: number;
    centerName: string | null;
    planQuantity: number;
    actualQuantity: number | null;
    confirmedAt: string | null;
  }>;
  /** 已确认过的项（幂等：重复提交不会报错，只回这里） */
  skipped: Array<{
    dishId: number;
    dishName: string | null;
    distributionCenterId: number;
    reason: string;
    confirmedAt: string | null;
  }>;
  dishes: Array<{
    dishId: number;
    dishName: string | null;
    status: string;
    planQuantity: number;
    confirmedQuantity: number;
    centerCount: number;
    confirmedCenterCount: number;
  }>;
  summary: { submitted: number; confirmed: number; skipped: number; allDone: boolean };
}

/**
 * 出餐确认
 *
 * ⚠️ 截止时间是 **deadline 而非 earliest**：提前确认允许，迟于出餐日 09:30 一律 50009。
 *    因此端上不能只在「当天」才显示确认按钮 —— 备好就该能报。
 */
export const cookConfirm = (body: { date: string; items: CookConfirmItem[] }) =>
  http.post<CookConfirmResult>('/supplier/meal/cook-confirm', body);

// ============================================================================
// S3 集散中心打包任务 —— ⚠️ 已迁运营后台（M4-0 · 2026-09-16）
// ============================================================================
//
// 原 `GET /supplier/packing-tasks` **整条路由已删除**（→ 10004），前端入口
// `/supplier/packing` 也从 `SUPPLIER_NAV` / `SUPPLIER_MENU_KEYS` 下线。
// 新的落点是运营后台 `GET /admin/packing-tasks` —— 见 `api/packing.ts`
// 与 `views/supplier/packing-center.vue`。
//
// 为什么不能留给供应商：打包闸门必须看到**所有**供应商的到位情况，
// 一次查询天然包含他方的到货明细（违反 I1：不泄露他方经营数据）。
// 且自营下加工场所属 ABox 自有（`ab_distribution_center.supplier_id` 已停用），
// 原可见性判据「本主体名下有没有启用中集散中心」本身也已失效。

// ============================================================================
// S9 我的应付结算明细（P25 · M3-9）
// ============================================================================

export interface SettlementRow {
  id: number;
  shareNo: string;
  /** 应付生成日（T+1 凌晨跑批） */
  shareDate: string;
  /** 出餐日 */
  mealDate: string;
  dishId: number | null;
  dishName: string | null;
  /** 实收量（= 计费基数：你申报的实送份数，未申报视为足额） */
  quantity: number;
  /** 我的协商单价 */
  unitPriceFen: number;
  amountFen: number;
  /** pending 待付款 / success 已付款 */
  status: string;
  statusLabel: string;
  /** 银行回单号（付款完成的唯一凭证） */
  paymentVoucherNo: string | null;
  invoiceNo: string | null;
  paidAt: string | null;
}

export interface SettlementData {
  date: string;
  supplier: { id: number; name: string };
  list: SettlementRow[];
  summary: {
    rowCount: number;
    quantity: number;
    amountFen: number;
    pendingCount: number;
    pendingAmountFen: number;
    paidCount: number;
    paidAmountFen: number;
    /** 跨日期的待付合计 —— 供应商最关心的一个数：「平台还欠我多少」 */
    pendingTotalAmountFen: number;
    pendingTotalRowCount: number;
    /** 该日尚未出单（跑批在 T+1 凌晨，或当日出餐确认未完成）→ 走空态 */
    empty: boolean;
  };
  notes: Record<string, string>;
}

/**
 * 我的应付结算明细（只读自己的）
 *
 * ⚠️ 出参**不含**终端售价 / 佣金 / 毛利 —— B2B 采购关系下供应商只该知道
 *    「我的协商价 × 我的交付量」。这不是端上隐藏，而是服务端结构上就没有这些字段。
 * ⚠️ 应付单在**次日凌晨**按前一日实收量生成，所以查「今天」常常是空的，属正常。
 */
export const fetchSettlement = (date?: string) =>
  http.get<SettlementData>('/supplier/settlement', date ? { date } : undefined);

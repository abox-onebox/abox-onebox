import { http } from './request';

/**
 * api/coupon —— 后台代金券（独立券系统 · 2026-10-23）
 *
 * 端点（与 `CouponAdminController` 一一对应）：
 *   · `GET  /admin/coupon/defs`    券种定义列表
 *   · `POST /admin/coupon/defs`    新建券种
 *   · `PUT  /admin/coupon/defs/:id` 改券种（**仅状态 / 备注 / 限量**）
 *   · `POST /admin/coupon/grant`   手动发券（客服补偿 / 推荐补发）
 *   · `GET  /admin/coupon/grants`  发放记录（核券记录）
 *
 * ⚠️ 金额一律**整数分**（`Fen` 结尾），端上只做展示换算。
 *
 * ⚠️ 为什么「面额 / 有效期」改不了（PUT 只收三个字段）：
 *    券种一旦发出，那批券的核销口径就**定死**在用户手上了。改面额会让
 *    「已发出的券」跟着变价，改有效期会让「用户看到的到期日」凭空移动 ——
 *    两种都会造成已承诺权益的事后变更。要改就**停用旧券种 + 新建**。
 */

/** 有效期类型：days=领取后 N 天 / period=固定起止日 */
export type CouponValidityType = 'days' | 'period';

/** 券来源 */
export type CouponObtainedFrom = 'referral' | 'compensation' | 'manual';

export interface CouponDefRow {
  id: number;
  name: string;
  /** 面额（分） */
  faceValueFen: number;
  /** 门槛（分）；0 = 无门槛 */
  thresholdFen: number;
  validityType: CouponValidityType;
  /** days 型的天数 */
  validDays: number | null;
  /** period 型起止（YYYY-MM-DD） */
  validFrom: string | null;
  validTo: string | null;
  /** 发行上限；null = 不限 */
  totalLimit: number | null;
  issuedCount: number;
  status: string;
  remark: string | null;
  createdAt: string;
}

export interface UserCouponRow {
  id: number;
  code: string;
  name: string;
  faceValueFen: number;
  thresholdFen: number;
  validFrom: string;
  validTo: string;
  status: string;
  obtainedFrom: CouponObtainedFrom;
  usedAt: string | null;
  orderNo: string | null;
  /** 批量发放批次号；单人发券为 null */
  grantBatchNo: string | null;
  /** 回收时刻；未回收为 null */
  revokedAt: string | null;
  createdAt: string;
}

export interface CreateCouponDefPayload {
  name: string;
  faceValueFen: number;
  thresholdFen: number;
  validityType: CouponValidityType;
  validDays?: number | null;
  validFrom?: string | null;
  validTo?: string | null;
  totalLimit?: number | null;
  remark?: string | null;
  status?: string;
}

export interface UpdateCouponDefPayload {
  status?: string;
  remark?: string | null;
  totalLimit?: number | null;
}

export interface GrantCouponPayload {
  userId?: number;
  /** 与 userId 二选一（后台查无此人会报 20002） */
  userPhone?: string;
  /** 关联券种；不传 = 纯手动补偿券 */
  couponDefId?: number | null;
  name?: string;
  faceValueFen: number;
  thresholdFen?: number;
  validityType: CouponValidityType;
  validDays?: number | null;
  validFrom?: string | null;
  validTo?: string | null;
  obtainedFrom?: CouponObtainedFrom;
  remark?: string | null;
}

export interface GrantQuery {
  obtainedFrom?: string;
  userId?: number;
}

export const COUPON_STATUS_OPTIONS = [
  { value: 'active', label: '启用中' },
  { value: 'inactive', label: '已停用' },
] as const;

export const OBTAINED_FROM_OPTIONS = [
  { value: '', label: '全部来源' },
  { value: 'referral', label: '推荐返券' },
  { value: 'compensation', label: '客服补偿' },
  { value: 'manual', label: '手动发放' },
] as const;

export function fetchCouponDefs(): Promise<CouponDefRow[]> {
  return http.get<CouponDefRow[]>('/admin/coupon/defs');
}

export function createCouponDef(payload: CreateCouponDefPayload): Promise<CouponDefRow> {
  return http.post<CouponDefRow>('/admin/coupon/defs', payload);
}

export function updateCouponDef(
  id: number,
  payload: UpdateCouponDefPayload,
): Promise<CouponDefRow> {
  return http.put<CouponDefRow>(`/admin/coupon/defs/${id}`, payload);
}

export function grantCoupon(payload: GrantCouponPayload): Promise<UserCouponRow> {
  return http.post<UserCouponRow>('/admin/coupon/grant', payload);
}

export function fetchCouponGrants(params: GrantQuery = {}): Promise<UserCouponRow[]> {
  return http.get<UserCouponRow[]>('/admin/coupon/grants', params);
}

// ------------------------------------------------------------------ 批量发放 / 回收

/** 批量发放的人群选择方式 */
export type CouponGrantScope = 'all' | 'building' | 'phones' | 'userIds';

export interface GrantCouponBatchPayload {
  scope: CouponGrantScope;
  buildingId?: number | null;
  phones?: string[];
  userIds?: number[];
  couponDefId?: number | null;
  name?: string;
  faceValueFen: number;
  thresholdFen?: number;
  validityType: CouponValidityType;
  validDays?: number | null;
  validFrom?: string | null;
  validTo?: string | null;
  obtainedFrom?: CouponObtainedFrom;
  /** 发放原因（必填，≥2 字） */
  remark: string;
  /** `true` = 只试算不写库 */
  dryRun?: boolean;
  /** 幂等键；同键 = 同批，已发过的用户自动跳过 */
  idempotencyKey?: string | null;
  excludeBlacklist?: boolean;
}

export interface CouponGrantBatchResult {
  dryRun: boolean;
  batchNo: string;
  /** 本次实际（或预计）发放张数 */
  grantedCount: number;
  /** 同一批次已发过而跳过的张数 */
  skippedCount: number;
  totalFaceValueFen: number;
  /** 黑名单 / 已注销被排除的人数 */
  excludedCount: number;
  /** 手机号清单里查无此人的号码 */
  unmatchedPhones: string[];
  /** 命中用户样例（脱敏手机号） */
  samplePhones: string[];
  codes: string[];
}

export const GRANT_SCOPE_OPTIONS = [
  { value: 'all', label: '全平台用户' },
  { value: 'building', label: '按楼宇' },
  { value: 'phones', label: '手机号清单' },
  { value: 'userIds', label: '用户 ID 清单' },
] as const;

/**
 * 批量发放（试算与实发同一端点，靠 `dryRun` 区分）
 *
 * ⚠️ 端上**不许**自己估算命中人数：试算与实发在服务端是同一条路径
 *    （见 `CouponService.grantBatch` 头注），自己估就会出现「试算 73、实发 80」。
 */
export function grantCouponBatch(
  payload: GrantCouponBatchPayload,
): Promise<CouponGrantBatchResult> {
  return http.post<CouponGrantBatchResult>('/admin/coupon/grant-batch', payload);
}

/** 回收一张券（仅未使用可撤；原因进操作日志） */
export function revokeCoupon(id: number, reason: string): Promise<UserCouponRow> {
  return http.post<UserCouponRow>(`/admin/coupon/grants/${id}/revoke`, { reason });
}

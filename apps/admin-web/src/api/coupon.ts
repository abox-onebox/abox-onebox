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

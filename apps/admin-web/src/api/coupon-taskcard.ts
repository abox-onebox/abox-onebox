import { http } from './request';

/** 发券策略卡（AI 编排节点 H · 安全版）前端接口：只出清单、不真发券 */

export type CouponStrategyKind = 'newCustomer' | 'sleepWake' | 'buildingTarget' | 'repurchase';
export type CouponScope = 'all' | 'building';

export interface CouponStrategyCard {
  kind: CouponStrategyKind;
  scope: CouponScope;
  buildingId: number | null;
  buildingName: string;
  couponDefId: number;
  couponName: string;
  faceValueFen: number;
  thresholdFen: number;
  validityType: string;
  validDays: number;
  targetCount: string;
  budgetText: string;
  reason: string;
  executeHint: string;
}

export interface CouponCardRejected {
  kind: string | null;
  why: string;
}

export interface CouponTaskCardGenResult {
  ok: boolean;
  mode: string;
  cards: CouponStrategyCard[];
  rejected: CouponCardRejected[];
  notes: string[];
  message?: string;
  generatedAt?: string;
  degraded?: boolean;
}

export interface CouponExecution extends CouponStrategyCard {
  operatorNote: string;
}

export interface CouponCardResult {
  kind: string;
  ok: boolean;
  decision: string;
  reason?: string;
  execution?: CouponExecution;
  idempotent?: boolean;
}

export interface CouponConfirmResult {
  results: CouponCardResult[];
  approvedCount: number;
  skippedCount: number;
}

/** 生成（只读，不写库、不发券） */
export function generateCouponTaskCards(): Promise<CouponTaskCardGenResult> {
  return http.post('/admin/coupon-taskcard/generate');
}

/** 逐卡确认（只出执行清单 + 记台账，不真发券） */
export function confirmCouponTaskCards(
  decisions: Array<{ kind: string; decision: 'approve' | 'skip'; card?: CouponStrategyCard }>,
): Promise<CouponConfirmResult> {
  return http.post('/admin/coupon-taskcard/confirm', { decisions });
}

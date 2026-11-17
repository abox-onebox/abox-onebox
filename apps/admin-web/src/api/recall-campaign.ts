import { http } from './request';

/** 复购 / 流失主动唤醒闭环（#C）前端接口 */

export type RecallSegment = 'repurchase' | 'churn';

export interface RecallCouponSpec {
  name: string;
  /** 面额（分） */
  faceValueFen: number;
  /** 门槛（分） */
  thresholdFen: number;
  validityType: string;
  validDays: number;
}

export interface SegmentPlan {
  segment: RecallSegment;
  userIds: number[];
  count: number;
  coupon: RecallCouponSpec;
}

export interface RecallPreview {
  generatedAt: string;
  rangeNote: string;
  segments: SegmentPlan[];
}

export interface RecallSegmentResult {
  segment: RecallSegment;
  targetCount: number;
  couponDefId: number | null;
  grantedCount: number;
  skippedCount: number;
  batchNo: string;
}

export interface RecallConfirmResult {
  pushed: boolean;
  reason?: string;
  sentAt: string | null;
  segments: RecallSegmentResult[];
}

/** 预览：圈人 + 默认券方案（不写库） */
export function recallPreview(): Promise<RecallPreview> {
  return http.post('/admin/recall-campaign/preview');
}

/**
 * 确认发放：建券种 + 批量发券（幂等）+ 记台账 + 推负责人企微。
 * ⚠️ 安全默认：dryRun 默认 true（只试算人数、不写库）。要真发必须显式传 false，
 * 且经页面上 ElMessageBox 二次确认 —— 防止漏传参数变成真发券。
 */
export function recallConfirm(
  segments: RecallSegment[],
  dryRun = true,
): Promise<RecallConfirmResult> {
  return http.post('/admin/recall-campaign/confirm', { segments, dryRun });
}

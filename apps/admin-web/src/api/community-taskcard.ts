import { http } from './request';

/** 社群排期卡（AI 编排节点 P · 安全版）前端接口：只出清单、不发消息、不发券 */

export type CommunityTier = 'amplify' | 'steady' | 'wake' | 'silent';

export interface CommunityTargetOption {
  leaderId: number;
  buildingName: string;
  tier: string;
  monthOrders: number;
  totalOrders: number;
  silentDays: number | null;
}
export interface CommunityTemplateOption {
  id: number;
  name: string;
  priceFen: number;
}
export interface CommunityCouponOption {
  id: number;
  name: string;
  faceValueFen: number;
  thresholdFen: number;
}

export interface CommunityScheduleCard {
  day: string;
  targetTier: CommunityTier;
  templateId: number | null;
  templateName: string | null;
  couponId: number | null;
  couponName: string | null;
  offer: string;
  pitch: string;
  note: string;
  executeHint: string;
}
export interface CommunityPitchCard {
  tier: CommunityTier;
  text: string;
  executeHint: string;
}
export interface CommunityRejected {
  type: string | null;
  why: string;
}

export interface CommunityTaskCardGenResult {
  ok: boolean;
  mode: string;
  schedule: CommunityScheduleCard[];
  pitches: CommunityPitchCard[];
  rejected: CommunityRejected[];
  notes: string[];
  message?: string;
  generatedAt?: string;
  degraded?: boolean;
  targets?: CommunityTargetOption[];
}

export interface CommunityExecution extends CommunityScheduleCard {
  operatorNote: string;
}

export interface CommunityScheduleResult {
  day: string;
  ok: boolean;
  decision: string;
  reason?: string;
  execution?: CommunityExecution;
  idempotent?: boolean;
}

export interface CommunityConfirmResult {
  results: CommunityScheduleResult[];
  pitches: CommunityPitchCard[];
  approvedCount: number;
  skippedCount: number;
}

/** 生成（只读，不发消息不发券） */
export function generateCommunityTaskCards(): Promise<CommunityTaskCardGenResult> {
  return http.post('/admin/community-taskcard/generate');
}

/** 逐日确认（只出排期表+合规话术清单+台账，不发消息不发券） */
export function confirmCommunityTaskCards(
  decisions: Array<{ day: string; decision: 'approve' | 'skip'; card?: CommunityScheduleCard }>,
): Promise<CommunityConfirmResult> {
  return http.post('/admin/community-taskcard/confirm', { decisions });
}

import { http } from './request';

/** 团长处置卡（AI 编排节点 N · 安全版）前端接口：只出清单、不真停用、不清归属 */

export type LeaderCardKind =
  'agreementFollowup' | 'silentWakeup' | 'payoutFollowup' | 'suspendReview';
export type LeaderAuditSuggestion = 'suspend' | 'restore' | 'sign_agreement' | 'note';

export interface LeaderStrategyCard {
  kind: LeaderCardKind;
  leaderId: number;
  buildingName: string;
  level: string;
  band: string;
  silentDays: number | null;
  monthOrders: number;
  facts: string;
  action: LeaderAuditSuggestion;
  reason: string;
  blockerList: string[];
  executeHint: string;
}

export interface LeaderCardRejected {
  kind: string | null;
  why: string;
}

export interface LeaderTaskCardGenResult {
  ok: boolean;
  mode: string;
  cards: LeaderStrategyCard[];
  rejected: LeaderCardRejected[];
  notes: string[];
  message?: string;
  generatedAt?: string;
  degraded?: boolean;
}

export interface LeaderExecution extends LeaderStrategyCard {
  operatorNote: string;
}

export interface LeaderCardResult {
  kind: string;
  ok: boolean;
  decision: string;
  reason?: string;
  execution?: LeaderExecution;
  idempotent?: boolean;
}

export interface LeaderConfirmResult {
  results: LeaderCardResult[];
  approvedCount: number;
  skippedCount: number;
}

/** 生成（只读，不写库、不停用） */
export function generateLeaderTaskCards(): Promise<LeaderTaskCardGenResult> {
  return http.post('/admin/leader-taskcard/generate');
}

/** 逐卡确认（只出执行清单 + 记台账，不真停用、不清归属） */
export function confirmLeaderTaskCards(
  decisions: Array<{ kind: string; decision: 'approve' | 'skip'; card?: LeaderStrategyCard }>,
): Promise<LeaderConfirmResult> {
  return http.post('/admin/leader-taskcard/confirm', { decisions });
}

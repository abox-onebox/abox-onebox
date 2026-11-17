/**
 * 后台 API · 招募任务卡（AI 编排节点 G · 安全版）
 * 生成一个缺口任务卡列表（只读）→ 逐卡确认出物料（不发消息、不建团长）。
 */
import { http } from './request';

export interface RecruitTaskCard {
  buildingId: number;
  buildingName: string;
  priority: number;
  gap: { orderCount30d: string; gmv30d: string; activeLeader: number };
  targetSegment: string;
  pitchText: string;
  estimatedEarningText: string;
  /** 裸申请路径（无 ref = 自荐） */
  applyPath: string;
  /** 安全版恒 null */
  ref: string | null;
  reason: string;
}

export interface RecruitTaskCardGenResult {
  ok: boolean;
  mode: string;
  cards: RecruitTaskCard[];
  rejected: Array<{ buildingId: number | string | null; why: string }>;
  notes: string[];
  generatedAt?: string;
  message?: string;
  degraded?: boolean;
  /** 降级时回显的原始缺口（服务端 §3 承诺，不让运营对着空屏） */
  gaps?: Array<{
    buildingId: number;
    buildingName?: string | null;
    orderCount30d?: number | string | null;
    gmv30d?: number | string | null;
    activeLeader?: number | null;
  }>;
  coveredBuildingIds?: number[];
}

export interface ConfirmDecision {
  buildingId: number;
  decision: 'approve' | 'skip';
  /** ⭐ 原样带回 generate 的 AI 话术：confirm 物料必须沿用这段，否则卡片与物料不一致 */
  pitchText?: string;
  estimatedEarningText?: string;
  reason?: string;
}

export interface ConfirmCardResult {
  buildingId: number;
  ok: boolean;
  decision: string;
  reason?: string;
  material?: RecruitTaskCard & { operatorNote: string };
}

export interface ConfirmCardsResult {
  results: ConfirmCardResult[];
  approvedCount: number;
  skippedCount: number;
}

/** 生成招募任务卡（只读，零副作用） */
export function generateRecruitTaskCards(): Promise<RecruitTaskCardGenResult> {
  return http.post<RecruitTaskCardGenResult>('/admin/recruit-taskcard/generate', {});
}

/** 逐卡确认（人工闸，仅负责人）：实时复核 → 出物料 + 记台账 */
export function confirmRecruitTaskCards(decisions: ConfirmDecision[]): Promise<ConfirmCardsResult> {
  return http.post<ConfirmCardsResult>('/admin/recruit-taskcard/confirm', { decisions });
}

/**
 * api/leader —— 团长端（M2 · L14–L18）
 * 契约：《接口规范 v1.0》§4.5「团长管理」
 *
 * ⚠️ 除 `applyLeader` 外，全部端点都需**在职团长**身份：
 *    服务端 `LeaderGuard` 会在 JWT 之后再查一次 `ab_team_leader`，
 *    故端上不能用本地缓存的 `isLeader` 当授权凭据（token 7 天内团长可能被停职）。
 */
import type { LeaderLevel } from '@abox/shared-types';

import { http } from './request';

/** 团长档案（L14 / L17 出参） */
export interface LeaderProfile {
  id: number;
  userId: number;
  realName: string;
  phone: string;
  /** 楼层，如 `12F`（2026-09-15 裁定恢复该维度） */
  floor: string | null;
  buildingId: number;
  buildingName: string | null;
  level: LeaderLevel;
  /** 等级中文（见习 / 正式 / 金牌 / 首席），来源 = 服务端 LEADER_LEVEL_META */
  levelLabel: string;
  /** DECIMAL(5,4) 字符串，如 "0.1200" */
  commissionRate: string;
  /** 1 在职 / 2 停职（tinyint，裁定① 以实体为准） */
  status: number;
  monthOrders: number;
  invitedFormalCount: number;
  balance: string;
  totalOrders: number;
  totalCommission: string;
  agreedAt: string | null;
  agreeVersion: string | null;
}

/** 单级佣金规则（L16） */
export interface LevelRuleItem {
  key: LeaderLevel;
  name: string;
  rate: number;
  condition: string;
}

export interface LevelRulesResult {
  levels: LevelRuleItem[];
  mine: {
    level: LeaderLevel;
    monthOrders: number;
    invitedFormalCount: number;
    nextLevel: LeaderLevel | null;
    progress: number;
  };
  expireRule: string;
}

/** L17 申请入参 */
export interface ApplyLeaderPayload {
  buildingId: number;
  phone: string;
  /** 「公司 · 姓名」，与表 `real_name` 对应（必填） */
  realName: string;
  floor?: string;
  /** 已勾选同意的协议版本号；缺失 = 未勾选 → 服务端 10001 */
  agreementVersion: string;
}

export interface ApplyLeaderResult {
  isLeader: boolean;
  leader: LeaderProfile;
}

/** L17 · 申请成为团长（C3：勾选协议后**提交即生效**，无人工审核） */
export function applyLeader(payload: ApplyLeaderPayload): Promise<ApplyLeaderResult> {
  return http.post<ApplyLeaderResult>('/leader/apply', { ...payload } as Record<string, unknown>);
}

/** L14 · 团长资料 */
export function fetchLeaderProfile(): Promise<LeaderProfile> {
  return http.get<LeaderProfile>('/leader/profile');
}

/** L15 · 修改团长资料（手机号 / 楼层；办公楼变更需后台审核，本期不开放） */
export function updateLeaderProfile(payload: {
  phone?: string;
  floor?: string;
}): Promise<LeaderProfile> {
  return http.put<LeaderProfile>('/leader/profile', { ...payload } as Record<string, unknown>);
}

/** L16 · 4 级佣金规则 + C2 双条件升级门槛 + 我的晋级进度 */
export function fetchLevelRules(): Promise<LevelRulesResult> {
  return http.get<LevelRulesResult>('/leader/level-rules');
}

/** L18 · 勾选同意《团长合作协议》（补签 / 版本升级重签） */
export function signAgreement(
  agreementVersion: string,
): Promise<{ agreedAt: string | null; agreeVersion: string | null }> {
  return http.post<{ agreedAt: string | null; agreeVersion: string | null }>('/leader/agreement', {
    agreementVersion,
  });
}

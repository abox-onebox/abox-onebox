/**
 * api/auth —— 认证（A1 登录 / A2 我的资料）
 * 契约：《接口规范 v1.0》§2.1
 */
import type { LeaderLevel } from '@abox/shared-types';

import { http } from './request';

export interface LoginPayload {
  /** `uni.login` 拿到的 code；mock 模式传 `dev:<userId>` */
  code: string;
  nickname?: string;
  avatarUrl?: string;
}

export interface LoginUser {
  id: number;
  nickname: string | null;
  avatarUrl: string | null;
  /** ⚠️ C3 / L9：不取手机号，恒为 null */
  phone: string | null;
  buildingId: number | null;
  teamLeaderId: number | null;
}

export interface LoginLeaderBrief {
  id: number;
  level: LeaderLevel;
  /** DECIMAL(5,4) 字符串，如 "0.1200" */
  commissionRate: string;
  /** 佣金余额（元，字符串） */
  balance: string;
}

export interface LoginResult {
  token: string;
  isNewUser: boolean;
  /** L10 · 团长为叠加身份，端上据此决定是否展示团长 tab */
  isLeader: boolean;
  user: LoginUser;
  leader: LoginLeaderBrief | null;
}

export interface MeResult extends LoginUser {
  isLeader: boolean;
  leader:
    | (LoginLeaderBrief & {
        totalOrders?: number;
        totalCommission?: string;
      })
    | null;
}

/** A1 · 微信登录（免鉴权） */
export function login(payload: LoginPayload): Promise<LoginResult> {
  return http.post<LoginResult>('/auth/login', { ...payload } as Record<string, unknown>, {
    auth: false,
  });
}

/** A2 · 当前登录用户资料（含团长身份） */
export function fetchMe(): Promise<MeResult> {
  return http.get<MeResult>('/auth/me');
}

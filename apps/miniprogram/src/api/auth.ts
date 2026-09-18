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
  /**
   * ⚠️ **已废弃 · 元 · 字符串** —— M4-4 起取 `ab_balance` 真值（此前是
   * `ab_team_leader.balance` 这一从未被写过的列，显示的是种子死数字）。
   * 新代码用 `balanceFen`。
   */
  balance: string;
  /** ⭐ 可用余额（**整数分**）· 真源 = `ab_balance` */
  balanceFen: number;
  /** 冻结额（**整数分**） */
  frozenFen: number;
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
  /**
   * ⭐ M5-10 派生只读字段（未绑定 → null）
   *
   * P8 个人中心要显示「跟随团长：李明 · 国贸三期 A 座」；此前出参只有
   * `buildingId` / `teamLeaderId` 两个**数字**，端上无法渲染，只能糊一句
   * 「已绑定办公楼（见首页取餐点）」。故 A2 补这两个名字字段
   * （**不新开 U12 `/me`**，那份数据本来就在 A2 里）。
   */
  buildingName: string | null;
  leaderName: string | null;
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

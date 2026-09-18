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
  /**
   * ⭐ 团长邀请码（`LDR0001`）—— 带了就**在同一趟登录里完成绑定**（《接口规范》§1.5）。
   *
   * 字段名与 A1 一览表一致（服务端 DTO 同名字段此前是**死字段**，2026-09-18 才实装）
   * —— 它和 U3 路径参数、`CreateOrderDto.leaderCode` 是**同一个值**，
   * 历史命名分叉保留不改，但登录入参统一用 `inviteCode`。
   *
   * ⚠️ 码无效 / 团长已停职 → **整个登录 30007**（刻意不静默忽略：
   *    「用户以为加入了、服务端什么也没发生」正是缺陷 #92）。调用方须兜底回落普通登录。
   */
  inviteCode?: string;
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

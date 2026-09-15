/**
 * api/meal —— 首页 / 套餐（U1 明日套餐、U2 历史归档、U3 团长邀请落地）
 * 契约：《接口规范 v1.0》§3.1
 */
import type {
  HomeDailyResult,
  HomeHistoryItem,
  LeaderInviteLanding,
  PageResult,
} from '@abox/shared-types';

import { http, query } from './request';

/**
 * U1 · 明日套餐
 * @param mealDate 指定出餐日（`YYYY-MM-DD`）；缺省 = 服务端「明日」
 */
export function fetchDaily(mealDate?: string): Promise<HomeDailyResult> {
  return http.get<HomeDailyResult>(`/home/daily${query({ mealDate })}`);
}

/** U2 · 历史套餐归档（出餐日 ≤ 今日，倒序） */
export function fetchHistory(page = 1, pageSize = 20): Promise<PageResult<HomeHistoryItem>> {
  return http.get<PageResult<HomeHistoryItem>>(`/home/history${query({ page, pageSize })}`);
}

/** U3 · 团长邀请落地（免登录，只读） */
export function fetchInviteLanding(leaderCode: string): Promise<LeaderInviteLanding> {
  return http.get<LeaderInviteLanding>(`/leader/invite/${encodeURIComponent(leaderCode)}`, {
    auth: false,
  });
}

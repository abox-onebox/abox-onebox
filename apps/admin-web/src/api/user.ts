import { http } from './request';
import type { PageResult } from './system';

/**
 * api/user —— 后台 **C 端用户**管理（`GET/PUT /admin/users`）
 *
 * ⚠️ 与 `api/system.ts` 的区别（两者名字都带「用户」，别混）：
 *    · 本文件 → **小程序 C 端用户**（吃盒饭的人，`ab_user`）
 *    · `api/system.ts` → **后台运营账号**（客服 / 财务，`ab_admin_user`）
 *    两套账号体系无任何外键关系，混用会让「拉黑一个恶意下单的用户」
 *    与「停用一个运营账号」互相污染。
 *
 * ⚠️ 本文件此前是**空壳**（只有 `export {}`）—— 因为后端本来就没有
 *    `/admin/users` 任何端点。随着 `UserAdminController` 落地，此处同步复活。
 */

// ============================================================================
// 名录 / 筛选器 / 详情 / 修改
// ============================================================================

export interface UserRow {
  id: number;
  /** 已注销用户已被服务端匿名化为「已注销用户」，如实展示 */
  nickname: string | null;
  avatarUrl: string | null;
  /** 脱敏手机号（如 `138****1234`）；未填则 `null` */
  phoneMasked: string | null;
  /** openid 后 6 位（仅用于区分同名用户，不是可登录凭据） */
  openidTail: string | null;
  status: number;
  /** 状态中文（服务端下发，端上不自造映射） */
  statusLabel: string;
  buildingId: number | null;
  buildingName: string | null;
  /** 所属楼群（`null` = 该楼未归群 ⇒ 该用户下不了单，且只能运营修） */
  groupName: string | null;
  leaderId: number | null;
  leaderName: string | null;
  orderCount: number;
  lastOrderAt: string | null;
  createdAt: string;
}

export interface UserSummary {
  totalCount: number;
  normalCount: number;
  blacklistCount: number;
  canceledCount: number;
  /** ⭐ 未绑楼 = 下不了单（端上报 20016），运营要盯的就是这个数 */
  unboundCount: number;
}

export interface UserListResult extends PageResult<UserRow> {
  summary: UserSummary;
}

export interface UserFilterOptions {
  buildings: Array<{ id: number; name: string; status: number; statusLabel: string }>;
  statuses: Array<{ key: number; label: string }>;
  bindStates: Array<{ key: string; label: string }>;
}

export interface UserQuery {
  keyword?: string;
  buildingId?: number;
  status?: number;
  bindState?: string;
  page?: number;
  pageSize?: number;
}

export interface UserBalance {
  balanceFen: number;
  frozenFen: number;
  totalInFen: number;
  totalOutFen: number;
  hasBalanceAccount: boolean;
}

export interface UserRecentOrder {
  orderNo: string;
  mealDate: string;
  quantity: number;
  totalFen: number;
  status: string;
  /** 后台视角状态文案（服务端下发） */
  statusText: string;
  createdAt: string;
}

export interface UserDetailResult {
  user: UserRow;
  balance: UserBalance;
  recentOrders: UserRecentOrder[];
  /** ⭐ 服务端直说「下不了单的原因与修法」，端上整段展示，不要改写 */
  note: string;
}

export interface UpdateUserPayload {
  /** 传 `null` = 解绑办公楼（该用户此后下不了单，需重新选楼） */
  buildingId?: number | null;
  /** 1 正常 / 2 黑名单；不接受 3（已注销只能用户自助，恢复走人工） */
  status?: number;
}

export interface UpdateUserResult {
  id: number;
  /** 实际发生变更的字段名；空数组 = 目标值与当前值一致 */
  changed: string[];
  note: string;
}

export function fetchUsers(params: UserQuery): Promise<UserListResult> {
  return http.get<UserListResult>('/admin/users', params);
}

export function fetchUserFilterOptions(): Promise<UserFilterOptions> {
  return http.get<UserFilterOptions>('/admin/users/filter-options');
}

export function fetchUserDetail(id: number): Promise<UserDetailResult> {
  return http.get<UserDetailResult>(`/admin/users/${id}`);
}

export function updateUser(id: number, payload: UpdateUserPayload): Promise<UpdateUserResult> {
  return http.put<UpdateUserResult>(`/admin/users/${id}`, payload);
}

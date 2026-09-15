import { http } from './request';
import type { AdminAccount } from './auth';

/**
 * api/system —— 后台系统管理（《接口规范 v1.0》§6.7 D51–D56）
 *
 * 与 `api/user.ts` 的区别：本文件管的是**后台账号**（`ab_admin_user`，运营/供应商），
 * `api/user.ts` 管的是**小程序用户**（`ab_user`）。两套账号体系无任何外键关系。
 */

export interface AdminAccountRow extends AdminAccount {
  supplierName: string | null;
  phone: string | null;
  status: number;
  statusText: string;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface PageResult<T> {
  list: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export interface AdminAccountQuery {
  keyword?: string;
  role?: string;
  status?: number;
  page?: number;
  pageSize?: number;
}

export interface CreateAdminUserPayload {
  username: string;
  password: string;
  role: string;
  realName?: string;
  supplierId?: number;
  phone?: string;
}

export interface UpdateAdminUserPayload {
  realName?: string;
  role?: string;
  supplierId?: number;
  phone?: string;
  status?: number;
}

export interface AdminRoleRow {
  role: string;
  label: string;
  menus: string[];
  /** -1 = 全量通配 */
  menuCount: number;
  isSystem: boolean;
}

export interface OperationLogRow {
  id: number;
  operatorId: number | null;
  operatorName: string | null;
  operatorRole: string | null;
  operatorRoleLabel: string | null;
  module: string;
  action: string;
  targetId: string | null;
  requestIp: string | null;
  requestData: unknown;
  responseData: unknown;
  failed: boolean;
  createdAt: string | null;
}

export interface OperationLogQuery {
  operatorId?: number;
  module?: string;
  date?: string;
  page?: number;
  pageSize?: number;
}

/** D56 出参：分页 + 操作人下拉（供筛选器直接用） */
export type OperationLogPage = PageResult<OperationLogRow> & {
  operators: Array<{ id: number; name: string; role: string; roleLabel: string }>;
};

/** D51 账号列表 */
export function fetchAdminAccounts(
  params: AdminAccountQuery,
): Promise<PageResult<AdminAccountRow>> {
  return http.get<PageResult<AdminAccountRow>>('/admin/system/accounts', params);
}

/** D52 新增账号 */
export function createAdminAccount(payload: CreateAdminUserPayload): Promise<AdminAccountRow> {
  return http.post<AdminAccountRow>('/admin/system/accounts', payload);
}

/** D53 编辑 / 停用账号 */
export function updateAdminAccount(
  id: number,
  payload: UpdateAdminUserPayload,
): Promise<AdminAccountRow> {
  return http.put<AdminAccountRow>(`/admin/system/accounts/${id}`, payload);
}

/** D54 角色与权限矩阵（只读） */
export function fetchAdminRoles(): Promise<{ list: AdminRoleRow[]; note: string }> {
  return http.get<{ list: AdminRoleRow[]; note: string }>('/admin/system/roles');
}

/** D56 操作日志 */
export function fetchOperationLogs(params: OperationLogQuery): Promise<OperationLogPage> {
  return http.get<OperationLogPage>('/admin/system/logs', params);
}

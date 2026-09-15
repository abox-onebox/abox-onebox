import { http } from './request';

/**
 * api/auth —— 鉴权（《接口规范 v1.0》§二 A2–A5）
 *
 * ⚠️ **两套账号体系共用 `/auth/*` 前缀**，但本文件只发后台请求：
 *    小程序端的 A1 由 miniprogram 工程负责，二者 token 不可混用
 *    （服务端 `JwtAuthGuard` 按路径隔离，见 api-server/common/guards/jwt-auth.guard.ts）。
 */

/** 后台角色（与 api-server/common/constants/admin-role.ts 的 key 逐项一致） */
export type AdminRole = 'super_admin' | 'admin' | 'operator' | 'finance' | 'viewer' | 'supplier';

export const ADMIN_ROLES: Array<{ value: AdminRole; label: string }> = [
  { value: 'super_admin', label: '超级管理员' },
  { value: 'admin', label: '管理员' },
  { value: 'operator', label: '运营专员' },
  { value: 'finance', label: '财务' },
  { value: 'viewer', label: '只读观察者' },
  { value: 'supplier', label: '供应商' },
];

export interface AdminAccount {
  id: number;
  username: string;
  name: string;
  role: AdminRole | string;
  roleLabel?: string;
  /** 供应商账号绑定的 ab_supplier.id（S* 与 P21–P26 的数据范围锚点） */
  supplierId?: number | null;
  /** 菜单 key = 路由 path；`['*']` 表示全量 */
  menus: string[];
}

export interface AdminLoginResult {
  token: string;
  refreshToken: string;
  /** access token 有效期（秒） */
  expiresIn: number;
  account: AdminAccount;
}

export interface AdminLoginPayload {
  username: string;
  password: string;
  captcha?: string;
}

/** A2 后台登录 */
export function adminLogin(payload: AdminLoginPayload): Promise<AdminLoginResult> {
  return http.post<AdminLoginResult>('/auth/admin-login', payload);
}

/** A3 刷新令牌 */
export function refreshAdminToken(refreshToken: string): Promise<AdminLoginResult> {
  return http.post<AdminLoginResult>('/auth/refresh', { refreshToken });
}

/** A4 登出（服务端无状态，仅前端清态） */
export function adminLogout(): Promise<null> {
  return http.post<null>('/auth/logout');
}

/** A5 当前登录者（含 menus —— 刷新页面后重建侧边栏的唯一来源） */
export function fetchAdminProfile(): Promise<AdminAccount> {
  return http.get<AdminAccount>('/auth/profile');
}

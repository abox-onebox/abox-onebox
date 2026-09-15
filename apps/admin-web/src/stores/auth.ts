import { defineStore } from 'pinia';

import { adminLogin, adminLogout, fetchAdminProfile } from '@/api/auth';
import type { AdminAccount, AdminRole } from '@/api/auth';
import { clearTokens, getRefreshToken, getToken, setTokens } from '@/utils/auth';

/**
 * stores/auth —— 后台账号态（运营后台 + 供应商后台同一工程，按 role 过滤菜单）
 *
 * 契约：A2 `POST /auth/admin-login` → `{ token, refreshToken, expiresIn, account }`
 *       A5 `GET /auth/profile`     → `account`（含 `menus[]`）
 *       A4 `POST /auth/logout`     → `null`（服务端无状态，仅前端清态）
 *
 * ⚠️ **菜单的唯一来源是服务端**（`account.menus`）。前端**不**按 role 硬编码菜单 ——
 *    否则「角色 → 可见菜单」会同时存在于前后端两处，改一处必然漂移。
 *    前端侧只做「按 menus 过滤 NAV」这一件事（见 stores/permission.ts）。
 *
 * ⚠️ **localStorage 里的 token 不等于已登录**：`token` 可能已过期、账号可能刚被停用。
 *    因此进应用时 `restore()` 必须向 A5 求证一次，失败即清态踢回登录页。
 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: getToken(),
    account: null as AdminAccount | null,
    /** 是否已完成一次 A5 会话求证（避免每次路由跳转都打接口） */
    restored: false,
  }),

  getters: {
    isLoggedIn: (state): boolean => state.token !== '',
    /** 当前角色；未登录为空串 */
    role: (state): AdminRole | '' => (state.account?.role as AdminRole) ?? '',
    /** 供应商账号只能看到供应商侧菜单 */
    isSupplier: (state): boolean => state.account?.role === 'supplier',
    displayName: (state): string => state.account?.name ?? '',
    roleLabel: (state): string => state.account?.roleLabel ?? '',
    menus: (state): string[] => state.account?.menus ?? [],
    /** 该菜单是否可见（`*` = 全量通配，super_admin 专用） */
    canSee: (state) => {
      return (path: string): boolean => {
        const menus = state.account?.menus ?? [];
        return menus.includes('*') || menus.includes(path);
      };
    },
  },

  actions: {
    /** A2 登录 */
    async login(username: string, password: string): Promise<void> {
      const result = await adminLogin({ username, password });
      setTokens(result.token, result.refreshToken);
      this.token = result.token;
      this.account = result.account;
      this.restored = true;
    },

    /**
     * 会话求证（A5）
     *
     * 三种结果都要处理干净：
     *   · 本地无 token → 直接返回 false，**不发请求**（避免首屏一次必然 401）
     *   · 接口失败（过期 / 停用 / 被吊销） → 清态返回 false，由守卫踢回登录页
     *   · 成功 → 用服务端返回的 account 覆盖本地（角色被改过时前端菜单立即跟上）
     */
    async restore(): Promise<boolean> {
      if (!this.token) return false;
      if (this.restored && this.account) return true;

      try {
        this.account = await fetchAdminProfile();
        this.restored = true;
        return true;
      } catch {
        this.reset();
        return false;
      }
    },

    /** A4 登出（尽力而为：服务端失败也要清本地，不能把用户卡在登录态） */
    async logout(): Promise<void> {
      try {
        await adminLogout();
      } catch {
        /* 无状态接口，失败不影响本地清态 */
      }
      this.reset();
    },

    /** 纯本地清态 */
    reset(): void {
      clearTokens();
      this.token = '';
      this.account = null;
      this.restored = false;
    },

    /** 供后续「刷新令牌」使用（一期未自动续期，预留） */
    refreshTokenValue(): string {
      return getRefreshToken();
    },
  },
});

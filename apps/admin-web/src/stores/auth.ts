import { defineStore } from 'pinia';

export type AdminRole = 'admin' | 'supplier';

export interface AdminAccount {
  id: number;
  name: string;
  role: AdminRole;
  /** RBAC 菜单（由后端按角色下发，前端据此过滤侧边栏） */
  menus: string[];
}

/**
 * stores/auth —— 后台账号态（运营后台 + 供应商后台同一工程，按 role 过滤菜单）
 *
 * 契约：POST /auth/admin-login（《接口规范 v1.0》A2）
 *   入参 { username, password, captcha? }
 *   出参 { token, refreshToken, expiresIn, account: { id, name, role, menus[] } }
 *   失败 5 次锁定 15 分钟（错误码 20005）
 *
 * ⚠️ **骨架阶段说明**：账号体系独立于小程序（表 `ab_admin_user`），
 *    请求层（`api/request.ts` / `api/auth.ts`）尚未实现，属 M1 任务。
 *    因此 `login()` **故意抛错**，而不是静默"成功"——避免登录页看起来能用。
 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    role: 'admin' as AdminRole,
    token: '' as string,
    account: null as AdminAccount | null,
  }),

  getters: {
    isLoggedIn: (state): boolean => state.token !== '',
    /** 供应商账号只能看到供应商侧菜单 */
    isSupplier: (state): boolean => state.role === 'supplier',
  },

  actions: {
    async login(_username: string, _password: string): Promise<void> {
      throw new Error(
        '[未实现] 后台登录：请对接 POST /auth/admin-login（《接口规范 v1.0》A2），' +
          '成功后就本 store 的 token / account / role，并持久化 token',
      );
    },

    /** 本地登出（清态即可；服务端无会话，JWT 过期即失效） */
    logout(): void {
      this.token = '';
      this.account = null;
      this.role = 'admin';
    },
  },
});

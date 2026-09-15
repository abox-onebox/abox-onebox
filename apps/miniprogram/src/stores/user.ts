import { defineStore } from 'pinia';

/** 本地存储键（与 utils/storage 约定一致，勿随意改名） */
const TOKEN_KEY = 'abox_token';
const USER_KEY = 'abox_user';

export interface UserInfo {
  id: number;
  nickname: string;
  avatarUrl?: string;
  buildingId?: number;
}

/**
 * stores/user —— 登录态
 *
 * 口径：C3 · 仅微信授权登录，**不取手机号与地址**（L9）；
 *      昵称头像走微信开放能力，电话与地址一律不落库。
 *
 * 契约：POST /auth/login（《接口规范 v1.0》A1）
 *   入参 { code } → 出参 { token, isLeader, user }
 */
export const useUserStore = defineStore('user', {
  state: () => ({
    token: '' as string,
    info: null as UserInfo | null,
  }),

  getters: {
    isLoggedIn: (state): boolean => state.token !== '',
  },

  actions: {
    /**
     * 从本地存储恢复登录态。
     * 由 App.vue 的 onLaunch 调用，避免每次冷启动都重新走一次微信授权。
     */
    restore(): void {
      try {
        const token = uni.getStorageSync(TOKEN_KEY);
        if (typeof token === 'string' && token) {
          this.token = token;
        }
        const info = uni.getStorageSync(USER_KEY);
        if (info && typeof info === 'object') {
          this.info = info as UserInfo;
        }
      } catch (err) {
        // 本地存储不可用时保持未登录态，不阻断小程序启动
        console.warn('[user] 恢复登录态失败，按未登录处理', err);
      }
    },

    /** 登录成功后落状态并持久化（由登录流程在拿到 token 后调用） */
    setLogin(token: string, info: UserInfo): void {
      this.token = token;
      this.info = info;
      uni.setStorageSync(TOKEN_KEY, token);
      uni.setStorageSync(USER_KEY, info);
    },

    /** 退出登录 / token 失效时清理 */
    clear(): void {
      this.token = '';
      this.info = null;
      uni.removeStorageSync(TOKEN_KEY);
      uni.removeStorageSync(USER_KEY);
    },
  },
});

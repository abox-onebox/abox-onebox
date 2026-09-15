import { defineStore } from 'pinia';

import { STORAGE_KEYS, readStorage, writeStorage, removeStorage } from '@/utils/storage';

export interface UserInfo {
  id: number;
  nickname: string | null;
  avatarUrl: string | null;
  /** ⚠️ C3 / L9：仅微信授权登录，**不取手机号与地址**；此字段一律为 null */
  phone: string | null;
  /** 所属办公楼（经团长邀请链接绑定；未绑定则无法下单） */
  buildingId: number | null;
  /** 默认归属团长 */
  teamLeaderId: number | null;
}

/**
 * stores/user —— 登录态
 *
 * 口径：C3 · 仅微信授权登录，**不取手机号与地址**（L9）；
 *      昵称头像走微信开放能力，电话与地址一律不落库。
 *
 * 契约：POST /auth/login（《接口规范 v1.0》A1）→ 出参 { token, isNewUser, isLeader, user }
 */
export const useUserStore = defineStore('user', {
  state: () => ({
    token: '' as string,
    info: null as UserInfo | null,
    /** 是否新注册用户（首次登录时可做一次性引导） */
    isNewUser: false as boolean,
  }),

  getters: {
    isLoggedIn: (state): boolean => state.token !== '',
    /** 是否已绑定办公楼（未绑定 → 首页会提示「通过团长邀请链接进入」） */
    hasBuilding: (state): boolean => !!state.info?.buildingId,
  },

  actions: {
    /**
     * 从本地存储恢复登录态。
     * 由 App.vue 的 onLaunch 调用，避免每次冷启动都重新走一次微信授权。
     */
    restore(): void {
      try {
        const token = readStorage<string>(STORAGE_KEYS.token, '');
        if (token) this.token = token;

        const info = readStorage<UserInfo | null>(STORAGE_KEYS.user, null);
        if (info && typeof info === 'object') this.info = info;
      } catch (err) {
        // 本地存储不可用时保持未登录态，不阻断小程序启动
        console.warn('[user] 恢复登录态失败，按未登录处理', err);
      }
    },

    /** 登录成功后落状态并持久化（由 utils/auth.ts 在拿到 token 后调用） */
    setLogin(token: string, info: UserInfo, isNewUser = false): void {
      this.token = token;
      this.info = info;
      this.isNewUser = isNewUser;
      writeStorage(STORAGE_KEYS.token, token);
      writeStorage(STORAGE_KEYS.user, info);
    },

    /** 局部更新资料（如绑定办公楼后） */
    patchInfo(patch: Partial<UserInfo>): void {
      if (!this.info) return;
      this.info = { ...this.info, ...patch };
      writeStorage(STORAGE_KEYS.user, this.info);
    },

    /** 退出登录 / token 失效时清理 */
    clear(): void {
      this.token = '';
      this.info = null;
      this.isNewUser = false;
      removeStorage(STORAGE_KEYS.token);
      removeStorage(STORAGE_KEYS.user);
    },
  },
});

import { defineStore } from 'pinia';
import { LeaderLevel } from '@abox/shared-types';

/** 本地存储键（与原型同源，勿随意改名） */
const IS_LEADER_KEY = 'abox_is_leader';
const LEADER_KEY = 'abox_leader';

export interface LeaderInfo {
  id: number;
  realName: string;
  level: LeaderLevel;
  /** 佣金费率，DECIMAL(5,4) 的字符串形式，如 "0.1200"（首席 12%） */
  commissionRate: string;
  /** 佣金余额（元，两位小数字符串，如 "575.86"） */
  balance: string;
}

/**
 * stores/leader —— 团长身份
 *
 * 口径：L10 · 团长是**叠加身份**，与普通用户共用同一小程序身份（不是独立端）。
 *      登录后用 `abox_is_leader` 持久化，据此动态决定是否展示团长入口：
 *        false → tabBar 4 项（首页 / 供应商 / 订单 / 我的）
 *        true  → tabBar 5 项（首页 / 供应商 / 📦团长 / 订单 / 我的）
 *
 * 契约：GET /leader/profile（《接口规范 v1.0》L 域）
 */
export const useLeaderStore = defineStore('leader', {
  state: () => ({
    /** 是否具备团长身份（控制 📦 团长 tab 是否出现） */
    isLeader: false as boolean,
    info: null as LeaderInfo | null,
  }),

  getters: {
    /** 佣金等级对应费率（以团长档案为准，兜底取等级默认值） */
    rate: (state): number => Number(state.info?.commissionRate ?? 0),
  },

  actions: {
    /** 从本地存储恢复团长身份（App.vue onLaunch 调用） */
    restore(): void {
      try {
        this.isLeader = uni.getStorageSync(IS_LEADER_KEY) === true;
        const info = uni.getStorageSync(LEADER_KEY);
        if (info && typeof info === 'object') {
          this.info = info as LeaderInfo;
        }
      } catch (err) {
        // 存储不可用 → 按普通用户处理（不展示团长入口）
        console.warn('[leader] 恢复团长身份失败，按普通用户处理', err);
      }
    },

    /** 申请团长即刻生效（C2：见习无需审核）或拉取到档案后写入 */
    setLeader(info: LeaderInfo): void {
      this.isLeader = true;
      this.info = info;
      uni.setStorageSync(IS_LEADER_KEY, true);
      uni.setStorageSync(LEADER_KEY, info);
    },

    /** 30 天未促单被取消资格、或主动退出时清理 */
    clear(): void {
      this.isLeader = false;
      this.info = null;
      uni.removeStorageSync(IS_LEADER_KEY);
      uni.removeStorageSync(LEADER_KEY);
    },
  },
});

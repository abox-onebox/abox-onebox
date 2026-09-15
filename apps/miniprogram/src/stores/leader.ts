import { defineStore } from 'pinia';
import { LEADER_LEVEL_META, LeaderLevel } from '@abox/shared-types';

import { STORAGE_KEYS, readStorage, writeStorage, removeStorage } from '@/utils/storage';

export interface LeaderInfo {
  id: number;
  /** 真实姓名（A1 登录出参不含；M2 拉团长档案后补齐，故为可选） */
  realName?: string | null;
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
 *        false → 底部 4 项（首页 / 溯源 / 订单 / 我的）
 *        true  → 底部 5 项（首页 / 溯源 / 团长 / 订单 / 我的）
 *
 * 契约：POST /auth/login 返回 `isLeader` + `leader`；后续增量走 GET /leader/profile（M2）
 */
export const useLeaderStore = defineStore('leader', {
  state: () => ({
    /** 是否具备团长身份（控制「团长」tab 是否出现） */
    isLeader: false as boolean,
    info: null as LeaderInfo | null,
  }),

  getters: {
    /** 佣金等级对应费率（以团长档案为准，兜底 0） */
    rate: (state): number => Number(state.info?.commissionRate ?? 0),
    /** 等级文案（用于角标）；文案唯一来源 = shared-types 的 LEADER_LEVEL_META */
    levelLabel: (state): string =>
      LEADER_LEVEL_META[state.info?.level ?? LeaderLevel.TRAINEE].label,
  },

  actions: {
    /** 从本地存储恢复团长身份（App.vue onLaunch 调用） */
    restore(): void {
      try {
        this.isLeader = readStorage<boolean>(STORAGE_KEYS.isLeader, false) === true;

        const info = readStorage<LeaderInfo | null>(STORAGE_KEYS.leader, null);
        if (info && typeof info === 'object') this.info = info;
      } catch (err) {
        // 存储不可用 → 按普通用户处理（不展示团长入口）
        console.warn('[leader] 恢复团长身份失败，按普通用户处理', err);
      }
    },

    /** 申请团长即刻生效（C2：见习无需审核）或拉取到档案后写入 */
    setLeader(info: LeaderInfo): void {
      this.isLeader = true;
      this.info = info;
      writeStorage(STORAGE_KEYS.isLeader, true);
      writeStorage(STORAGE_KEYS.leader, info);
    },

    /** 30 天未促单被取消资格、或主动退出时清理 */
    clear(): void {
      this.isLeader = false;
      this.info = null;
      removeStorage(STORAGE_KEYS.isLeader);
      removeStorage(STORAGE_KEYS.leader);
    },
  },
});

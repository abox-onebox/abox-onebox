import { Injectable } from '@nestjs/common';

import { LEADER_LEVEL_META, LeaderLevel, resolveLevel } from '@abox/shared-types';

/** L16 出参的单级规则 */
export interface LevelRuleItem {
  key: LeaderLevel;
  name: string;
  rate: number;
  condition: string;
}

/** 等级阶梯（低 → 高），用于推导「下一级」 */
const LADDER: readonly LeaderLevel[] = [
  LeaderLevel.TRAINEE,
  LeaderLevel.FORMAL,
  LeaderLevel.GOLD,
  LeaderLevel.CHIEF,
];

/**
 * 团长等级服务（C2）
 *
 * ⚠️ 口径唯一来源 = `@abox/shared-types` 的 `LEADER_LEVEL_META` 与 `resolveLevel`。
 *    服务端**不重复定义**费率与门槛 —— 端上也要展示同一套规则，双份定义必然漂移。
 *    费率最终以 `ab_config.commission.rate.*` 为准（运营可调），本服务只做**规则呈现与判定**。
 */
@Injectable()
export class LeaderLevelService {
  /** L16 · 4 级佣金规则 + C2 双条件门槛 */
  rules(): LevelRuleItem[] {
    return LADDER.map((key) => {
      const meta = LEADER_LEVEL_META[key];
      return {
        key,
        name: `${meta.label}团长`,
        rate: meta.rate,
        condition:
          key === LeaderLevel.TRAINEE
            ? '提交申请即生效'
            : `月单 > ${meta.monthlyOrders} 且 介绍 ${meta.referrals} 名转正团长`,
      };
    });
  }

  /**
   * 依据业绩判定「应处等级」（C2 双条件须**同时满足**）
   * @param monthOrders 当月完成份数
   * @param invitedFormalCount 经本人邀请且已转正的团长数
   */
  resolve(monthOrders: number, invitedFormalCount: number): LeaderLevel {
    return resolveLevel(monthOrders, invitedFormalCount);
  }

  /**
   * 晋级进度（供 P16 等级进度条）
   *
   * 进度取**双条件中较慢的一方**（木桶原理）—— 与 C2「AND」语义一致：
   * 任一条未达标都不能升级，故只报最短板。
   */
  progress(
    monthOrders: number,
    invitedFormalCount: number,
  ): { level: LeaderLevel; nextLevel: LeaderLevel | null; progress: number } {
    const level = this.resolve(monthOrders, invitedFormalCount);
    const idx = LADDER.indexOf(level);
    const nextLevel = idx >= 0 && idx < LADDER.length - 1 ? LADDER[idx + 1] : null;

    if (!nextLevel) {
      return { level, nextLevel: null, progress: 1 };
    }

    const meta = LEADER_LEVEL_META[nextLevel];
    const byOrders = meta.monthlyOrders > 0 ? monthOrders / meta.monthlyOrders : 1;
    const byReferrals = meta.referrals > 0 ? invitedFormalCount / meta.referrals : 1;
    const progress = Number(Math.min(1, Math.min(byOrders, byReferrals)).toFixed(2));

    return { level, nextLevel, progress };
  }

  /** 见习失效规则文案（C2：30 天未促单自动取消） */
  expireRule(): string {
    return '见习团长 30 天未促成订单自动取消资格';
  }
}

import { Injectable, Logger } from '@nestjs/common';

import { LEADER_LEVEL_META, LeaderLevel, resolveLevel } from '@abox/shared-types';

/** L16 出参的单级规则 */
export interface LevelRuleItem {
  key: LeaderLevel;
  name: string;
  rate: number;
  condition: string;
}

/**
 * 等级阶梯（低 → 高），用于推导「下一级」与比较「谁更高」
 *
 * 导出给 `LeaderPromotionService`（晋级审计）复用 —— 「等级高低」这件事只允许
 * 有一处定义（本文件），否则审计与展示会对「同一等级」给出不同排序。
 */
export const LEADER_LEVEL_LADDER: readonly LeaderLevel[] = [
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
  private readonly logger = new Logger(LeaderLevelService.name);

  /** L16 · 4 级佣金规则 + C2 双条件门槛 */
  rules(): LevelRuleItem[] {
    return LEADER_LEVEL_LADDER.map((key) => {
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
   * 晋级进度（供 P16 等级进度条 / P20 资料页）
   *
   * 进度取**双条件中较慢的一方**（木桶原理）—— 与 C2「AND」语义一致：
   * 任一条未达标都不能升级，故只报最短板。
   *
   * ⭐ 2026-09-18 修缺陷 #94：**「下一级 / 进度」相对「生效等级」，不相对「业绩测算等级」**
   *
   * 同名不同义的坑（这是本方法签名带上 `effectiveLevel` 的唯一原因）：
   *   · `ab_team_leader.level`（L11/L14 出参 `level`）= **实际生效等级**，平台审核写入；
   *   · `resolveLevel(monthOrders, referrals)`（返回值里的 `derivedLevel`）
   *     = **按本月业绩反推的「应处等级」**，它是**晋级审计的输入**，根本不看当前等级。
   *   于是一个「首席但本月只做了 7 单」的团长会**同时**命中 `chief` 与 `trainee` ——
   *   两个值都对，只是语义不同。旧实现把它命名为 `level` 且进度按它推导，端上一照抄
   *   就成了「同屏两个等级」（P16 大卡「首席 · 12%」+ 体系表「← 当前：见习」）。
   *
   * ⚠️ **端上不得自己复刻这段推导** —— 「谁比谁高」的单一真相是 `LEADER_LEVEL_LADDER`，
   *    门槛的单一真相是 `LEADER_LEVEL_META`（与 `resolveLevel()` 同源）。端上照抄一份
   *    必然漂移；服务端一次算清、下发结果即可。
   *
   * @param effectiveLevel      实际生效等级（`ab_team_leader.level`）
   * @param monthOrders         当月完成份数
   * @param invitedFormalCount  经本人邀请且已转正的团长数
   */
  progress(
    effectiveLevel: LeaderLevel,
    monthOrders: number,
    invitedFormalCount: number,
  ): { derivedLevel: LeaderLevel; nextLevel: LeaderLevel | null; progress: number } {
    const derivedLevel = this.resolve(monthOrders, invitedFormalCount);

    /**
     * ⚠️ 生效等级若不在阶梯表内（历史脏值，例如已废弃的 `regular`），按**最低级**兜底，
     *    **不能**返回 `nextLevel: null` —— null 的语义是「已达最高等级」，
     *    那会让一个数据异常看起来像「已封顶」（同族：#67 静默取到 undefined 不报错）。
     *    宁可显示一条偏低的进度条，也不假装到顶。
     */
    const rawIdx = LEADER_LEVEL_LADDER.indexOf(effectiveLevel);
    if (rawIdx < 0) {
      this.logger.warn(
        `生效等级 "${effectiveLevel}" 不在阶梯表内（历史脏值？），晋级进度按 ${LEADER_LEVEL_LADDER[0]} 兜底`,
      );
    }
    const idx = rawIdx < 0 ? 0 : rawIdx;

    const nextLevel = idx < LEADER_LEVEL_LADDER.length - 1 ? LEADER_LEVEL_LADDER[idx + 1] : null;
    if (!nextLevel) {
      return { derivedLevel, nextLevel: null, progress: 1 };
    }

    const meta = LEADER_LEVEL_META[nextLevel];
    const byOrders = meta.monthlyOrders > 0 ? monthOrders / meta.monthlyOrders : 1;
    const byReferrals = meta.referrals > 0 ? invitedFormalCount / meta.referrals : 1;
    const progress = Number(Math.min(1, Math.min(byOrders, byReferrals)).toFixed(2));

    return { derivedLevel, nextLevel, progress };
  }

  /**
   * 等级序号（0 = 见习）
   *
   * ⚠️ 未知等级（脏数据 / 未来新增级别）返回 **-1**，调用方必须显式处理 ——
   *   晋级审计据此判定「不认识的等级一律不自动升降」，避免把脏数据误升成首席。
   */
  rank(level: string): number {
    return LEADER_LEVEL_LADDER.indexOf(level as LeaderLevel);
  }

  /** `target` 是否严格高于 `current`（两侧等级都必须是已知等级，否则恒 false） */
  isHigher(target: LeaderLevel, current: string): boolean {
    const t = this.rank(target);
    const c = this.rank(current);
    return t >= 0 && c >= 0 && t > c;
  }

  /** 见习失效规则文案（C2：30 天未促单自动取消） */
  expireRule(): string {
    return '见习团长 30 天未促成订单自动取消资格';
  }
}

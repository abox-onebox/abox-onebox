/**
 * 团长 4 级阶梯（C2）
 * 权威来源：交接包 v1.3 §4.1（C2）
 *
 * ⚠️ 枚举**值**必须与 DB / 接口规范逐字一致（2026-09-15 裁定）：
 *    `ab_team_leader.level` 存 `trainee / formal / gold / chief`，
 *    《接口规范》§4.6 L16 出参亦为 `"key":"formal"`，原型 CSS 为 `.level-formal`。
 *    曾误写为 `regular` → `LEADER_LEVEL_META[leader.level]` 查表 miss（`label` 取到
 *    undefined 而崩溃），已统一为 `formal`。**禁止**再改回 `regular`。
 */
export enum LeaderLevel {
  TRAINEE = 'trainee',
  FORMAL = 'formal',
  GOLD = 'gold',
  CHIEF = 'chief',
}

export const LEADER_LEVEL_META: Record<
  LeaderLevel,
  { label: string; rate: number; monthlyOrders: number; referrals: number }
> = {
  [LeaderLevel.TRAINEE]: { label: '见习', rate: 0.08, monthlyOrders: 0, referrals: 0 },
  [LeaderLevel.FORMAL]: { label: '正式', rate: 0.09, monthlyOrders: 30, referrals: 1 },
  [LeaderLevel.GOLD]: { label: '金牌', rate: 0.1, monthlyOrders: 60, referrals: 2 },
  [LeaderLevel.CHIEF]: { label: '首席', rate: 0.12, monthlyOrders: 100, referrals: 3 },
};

/**
 * 升级判定（C2：月单 **且** 介绍 N 名转正团长，双条件须同时满足）
 * 见习为申请即生效，例外处理。
 */
export function resolveLevel(monthlyOrders: number, referrals: number): LeaderLevel {
  if (monthlyOrders > 100 && referrals >= 3) return LeaderLevel.CHIEF;
  if (monthlyOrders > 60 && referrals >= 2) return LeaderLevel.GOLD;
  if (monthlyOrders > 30 && referrals >= 1) return LeaderLevel.FORMAL;
  return LeaderLevel.TRAINEE;
}

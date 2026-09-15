/**
 * 团长 4 级阶梯（C2）
 * 权威来源：交接包 v1.3 §4.1（C2）
 */
export enum LeaderLevel {
  TRAINEE = 'trainee',
  REGULAR = 'regular',
  GOLD = 'gold',
  CHIEF = 'chief',
}

export const LEADER_LEVEL_META: Record<
  LeaderLevel,
  { label: string; rate: number; monthlyOrders: number; referrals: number }
> = {
  [LeaderLevel.TRAINEE]: { label: '见习', rate: 0.08, monthlyOrders: 0, referrals: 0 },
  [LeaderLevel.REGULAR]: { label: '正式', rate: 0.09, monthlyOrders: 30, referrals: 1 },
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
  if (monthlyOrders > 30 && referrals >= 1) return LeaderLevel.REGULAR;
  return LeaderLevel.TRAINEE;
}

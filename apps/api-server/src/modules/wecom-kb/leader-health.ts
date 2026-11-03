/**
 * 团长健康度分群与风险判据（纯函数，零 IO，可单测）
 * ------------------------------------------------------------------
 * 节点 N「团长健康度与流失风险」的唯一判据真源。
 * 为什么抽纯函数：全仓没有 team-leader service 的单测，把阈值写进 service 方法里
 * 就等于没人拦——档位边界一旦写错，企微每天都会推一份错的「谁在掉队」。
 *
 * ⚠️ 三条口径约束（写错就会误伤真团长）：
 *   ① **新团长不能算流失**：上任不满 `NEW_LEADER_DAYS` 天的一律判 `new`，
 *      否则「昨天刚任命的楼」第二天就以「0 单沉睡」进预警清单，人会开始不信这份报告。
 *   ② **沉默天数用团长维度 `lastOrderAt`**（他名下最近一次产生订单的时间），
 *      不是他自己下单的时间——团长不是买家。
 *   ③ **升级门槛取 `LEADER_LEVEL_META`**（与 `resolveLevel` 同一张表），
 *      不在这里另写一份数字，避免「表说 30 单、报告说 25 单」这种口径分裂。
 *
 * ⚠️ 本模块**不读佣金金额**：`ab_team_leader.total_commission` 只是统计快照，
 *   `balance` 列从不更新（恒 0），拿它算「团长手上还有多少钱」会得到假亏损。
 *   健康度只看行为（单量/活跃/卡点），钱的事归财务节点 K。
 */

import { LEADER_LEVEL_META, LeaderLevel } from '@abox/shared-types';

/** 入职/上任「太新」，不参与流失判定（天） */
export const NEW_LEADER_DAYS = 7;
/** 健康：最近一次出单在 7 天内（周盒一周一期，7 天 = 一个完整周期） */
export const HEALTHY_DAYS = 7;
/** 待唤醒：8~14 天（已错过一个周期） */
export const WATCH_DAYS = 14;

/** 后台 `admin/leaders?view=roster` 行里本模块用到的字段（其余一律不取） */
export interface LeaderHealthRow {
  id: number;
  buildingId?: number | null;
  buildingName?: string | null;
  groupName?: string | null;
  level?: string | null;
  /** 1 在职 / 2 停职 */
  status?: number | null;
  /** 本月完成份数（`ab_team_leader.month_orders`，推导值的落库缓存） */
  monthOrders?: number | null;
  /** 累计完成份数 */
  totalOrders?: number | null;
  /** 已转正的被推荐人数量（升级第二条件） */
  invitedFormalCount?: number | null;
  /** 他名下最近一次产生订单的时间（BJ ISO 字符串或 null） */
  lastOrderAt?: string | null;
  /** 收款三要素是否齐全（缺一项就提不了现） */
  payoutBound?: boolean | null;
  /** 已签协议版本（如 `v1.1`） */
  agreeVersion?: string | null;
  /** 任命时间 */
  createdAt?: string | null;
}

/** 活跃度分档：new 新上任 / healthy 健康 / watch 待唤醒 / dormant 沉睡 / never 有任职但从未出单 */
export type LeaderBand = 'new' | 'healthy' | 'watch' | 'dormant' | 'never';

/** 卡点：与活跃度**正交**，可以同时存在（沉睡 + 没绑收款 = 更急） */
export type LeaderBlocker = 'payout_unbound' | 'agreement_stale';

export interface LeaderHealthItem {
  leaderId: number;
  buildingName: string | null;
  groupName: string | null;
  level: string;
  band: LeaderBand;
  /** 距最近出单的天数；null = 没有出单记录 */
  silentDays: number | null;
  /** 上任天数 */
  tenureDays: number | null;
  monthOrders: number;
  totalOrders: number;
  invitedFormalCount: number;
  blockers: LeaderBlocker[];
  /** 距下一等级还差多少（已是最高级则为 null） */
  gapToNextLevel: { level: string; orders: number; referrals: number } | null;
}

/** 等级阶梯顺序（低 → 高），与 `LEADER_LEVEL_META` 同源 */
const LEVEL_LADDER: LeaderLevel[] = [
  LeaderLevel.TRAINEE,
  LeaderLevel.FORMAL,
  LeaderLevel.GOLD,
  LeaderLevel.CHIEF,
];

/** 解析日期串（兼容 `2026-11-02T11:30:00+08:00` 与 `2026-11-02 11:30:00`），失败返回 null */
export function parseTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const norm = s.includes('T') ? s : s.replace(' ', 'T');
  const t = new Date(norm).getTime();
  return Number.isFinite(t) ? t : null;
}

function daysSince(s: string | null | undefined, nowMs: number): number | null {
  const t = parseTime(s);
  if (t == null) return null;
  return Math.floor((nowMs - t) / 86400000);
}

/** 下一等级要凑的条件（`monthOrders` 与 `invitedFormalCount` 双条件） */
export function nextLevelGap(
  level: string | null | undefined,
  monthOrders: number,
  invitedFormalCount: number,
): LeaderHealthItem['gapToNextLevel'] {
  const idx = LEVEL_LADDER.indexOf((level ?? '') as LeaderLevel);
  if (idx < 0) return null; // 等级认不出，不猜
  const next = LEVEL_LADDER[idx + 1];
  if (!next) return null; // 已是首席
  const meta = LEADER_LEVEL_META[next];
  return {
    level: next,
    orders: Math.max(0, meta.monthlyOrders - monthOrders),
    referrals: Math.max(0, meta.referrals - invitedFormalCount),
  };
}

/**
 * 单个团长的健康度判定。
 *
 * 分档优先看「上任多久」再看他「多久没出单」：新团长一律 new，
 * 这样「刚任命 + 0 单」不会被误判成沉睡（最容易假警报的一种）。
 */
export function judgeLeader(row: LeaderHealthRow, nowMs: number): LeaderHealthItem {
  const monthOrders = Number(row.monthOrders ?? 0);
  const totalOrders = Number(row.totalOrders ?? 0);
  const invitedFormalCount = Number(row.invitedFormalCount ?? 0);
  const silentDays = daysSince(row.lastOrderAt, nowMs);
  const tenureDays = daysSince(row.createdAt, nowMs);

  let band: LeaderBand;
  if (tenureDays != null && tenureDays < NEW_LEADER_DAYS) {
    band = 'new';
  } else if (silentDays == null) {
    // 有任职（且不是新上任）却没有任何出单记录
    band = 'never';
  } else if (silentDays <= HEALTHY_DAYS) {
    band = 'healthy';
  } else if (silentDays <= WATCH_DAYS) {
    band = 'watch';
  } else {
    band = 'dormant';
  }

  const blockers: LeaderBlocker[] = [];
  // ⚠️ 只在明确为 false 时判卡点：字段缺失（undefined）不等于「没绑」
  if (row.payoutBound === false) blockers.push('payout_unbound');
  if (row.agreeVersion == null || String(row.agreeVersion).trim() === '')
    blockers.push('agreement_stale');

  return {
    leaderId: Number(row.id),
    buildingName: row.buildingName ?? null,
    groupName: row.groupName ?? null,
    level: row.level ?? 'unknown',
    band,
    silentDays,
    tenureDays,
    monthOrders,
    totalOrders,
    invitedFormalCount,
    blockers,
    gapToNextLevel: nextLevelGap(row.level, monthOrders, invitedFormalCount),
  };
}

export interface LeaderHealthTotals {
  /** 参与判定的在职团长数 */
  total: number;
  byBand: Record<LeaderBand, number>;
  /** 卡点人数（与活跃度正交，可重叠） */
  payoutUnbound: number;
  agreementStale: number;
  /** 同时有卡点的沉睡/从未出单团长（最该先打的电话） */
  blockedAndSilent: number;
  /** 本月单量分档 */
  orderBuckets: Record<'0' | '1-20' | '21-60' | '61-100' | '100+', number>;
  /** 距离下一等级只差 10 单/1 人的团长（最容易推一把） */
  nearPromotion: number;
}

/** 汇总（输入须已按 `status===1` 过滤；这里不代替调用方做在职过滤，避免两处口径） */
export function summarizeLeaderHealth(
  rows: LeaderHealthRow[],
  nowMs: number,
): { items: LeaderHealthItem[]; totals: LeaderHealthTotals } {
  const items = rows.map((r) => judgeLeader(r, nowMs));
  const byBand: Record<LeaderBand, number> = {
    new: 0,
    healthy: 0,
    watch: 0,
    dormant: 0,
    never: 0,
  };
  const orderBuckets: LeaderHealthTotals['orderBuckets'] = {
    '0': 0,
    '1-20': 0,
    '21-60': 0,
    '61-100': 0,
    '100+': 0,
  };
  let payoutUnbound = 0;
  let agreementStale = 0;
  let blockedAndSilent = 0;
  let nearPromotion = 0;

  for (const it of items) {
    byBand[it.band] += 1;
    if (it.monthOrders <= 0) orderBuckets['0'] += 1;
    else if (it.monthOrders <= 20) orderBuckets['1-20'] += 1;
    else if (it.monthOrders <= 60) orderBuckets['21-60'] += 1;
    else if (it.monthOrders <= 100) orderBuckets['61-100'] += 1;
    else orderBuckets['100+'] += 1;

    if (it.blockers.includes('payout_unbound')) payoutUnbound += 1;
    if (it.blockers.includes('agreement_stale')) agreementStale += 1;
    if (it.blockers.length > 0 && (it.band === 'dormant' || it.band === 'never'))
      blockedAndSilent += 1;

    const gap = it.gapToNextLevel;
    if (gap && gap.orders <= 10 && gap.referrals <= 1) nearPromotion += 1;
  }

  return {
    items,
    totals: {
      total: items.length,
      byBand,
      payoutUnbound,
      agreementStale,
      blockedAndSilent,
      orderBuckets,
      nearPromotion,
    },
  };
}

/** 把一条团长记录说成一行（不含姓名/手机号，避免个人身份进 LLM） */
export function describeLeader(it: LeaderHealthItem): string {
  const who = `${it.buildingName ?? '未知楼栋'}（团长#${it.leaderId}）`;
  const silent = it.silentDays == null ? '无出单记录' : `距最近出单 ${it.silentDays} 天`;
  const blockerText = it.blockers.length
    ? ` · 卡点：${it.blockers.map((b) => (b === 'payout_unbound' ? '未绑收款' : '协议待补签')).join('、')}`
    : '';
  const gapText = it.gapToNextLevel
    ? ` · 距${it.gapToNextLevel.level} 差 ${it.gapToNextLevel.orders} 单 / ${it.gapToNextLevel.referrals} 人`
    : '';
  return `${who} ${silent} · 本月 ${it.monthOrders} 单 · 累计 ${it.totalOrders} 单${blockerText}${gapText}`;
}

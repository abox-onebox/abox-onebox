/**
 * 社群运营靶楼分层（纯函数，零 IO，可单测）
 * ------------------------------------------------------------------
 * 节点 P「社群/私域运营助手」的唯一判据真源。
 * 它不生成文案（文案归 LLM），只回答一个问题：**这一周的社群力气该往哪几栋楼使**。
 * 为什么抽纯函数：分档边界一旦写错，AI 会把「刚上任的新团长」当成沉默靶子，
 * 在群里 @ 一个昨天才接手的人要单量——这种错一旦发出去，团长会直接不信这套工具。
 *
 * ⚠️ 三条口径约束：
 *   ① **复用 N 的 `LeaderHealthItem.band`**，不在这里重算沉默天数阈值——
 *      「7 天健康 / 8~14 待唤醒 / >14 沉睡」只允许有一个真源（`leader-health.ts`）。
 *   ② **新上任（band='new'）一律归 `steady`，永远不进 `silent`**：
 *      新团长本月 0 单是正常的，把他当沉默靶子等于开局就打击人。
 *   ③ **「值不值得救」看历史累计单量**（`totalOrders`），不看本月：
 *      本月掉到 0 但历史有 80 单的楼，比从没起量的楼更值得花社群资源。
 */

import type { LeaderHealthItem } from './leader-health';

/** 本月达到这个单量，才算「有量可放大」（社群该做的是加码，不是唤醒） */
export const AMPLIFY_MIN_ORDERS = 30;

/** 社群靶楼分层：amplify 放量 / steady 维持 / wake 唤醒 / silent 沉默待判 */
export type CommunityTier = 'amplify' | 'steady' | 'wake' | 'silent';

export interface CommunityTarget {
  leaderId: number;
  buildingName: string | null;
  groupName: string | null;
  tier: CommunityTier;
  monthOrders: number;
  totalOrders: number;
  /** 距最近出单天数；null = 从未出单 */
  silentDays: number | null;
}

export interface CommunityTargets {
  amplify: CommunityTarget[];
  steady: CommunityTarget[];
  wake: CommunityTarget[];
  silent: CommunityTarget[];
  /** band='new' 的人数（已并入 steady，单独计数供文案说明） */
  newCount: number;
  totals: Record<CommunityTier, number>;
  /** 社群主战场：amplify 里本月单量最高的 3 栋 */
  focus: CommunityTarget[];
  /** 最值得先救的沉默楼：历史有量（totalOrders>0）且按累计单量取前 3 */
  mustWake: CommunityTarget[];
}

function tierOf(item: LeaderHealthItem): CommunityTier {
  // ① 新上任：绝不进 silent（口径约束②）
  if (item.band === 'new') return 'steady';
  if (item.band === 'healthy') {
    return item.monthOrders >= AMPLIFY_MIN_ORDERS ? 'amplify' : 'steady';
  }
  if (item.band === 'watch') return 'wake';
  return 'silent'; // dormant / never
}

function toTarget(item: LeaderHealthItem, tier: CommunityTier): CommunityTarget {
  return {
    leaderId: item.leaderId,
    buildingName: item.buildingName,
    groupName: item.groupName,
    tier,
    monthOrders: item.monthOrders,
    totalOrders: item.totalOrders,
    silentDays: item.silentDays,
  };
}

/**
 * 分层主函数。
 * @param items 已判定过 band 的团长项（来自 `summarizeLeaderHealth`，调用方须已按在职过滤）
 */
export function pickCommunityTargets(items: LeaderHealthItem[]): CommunityTargets {
  const buckets: Record<CommunityTier, CommunityTarget[]> = {
    amplify: [],
    steady: [],
    wake: [],
    silent: [],
  };
  let newCount = 0;

  for (const it of items ?? []) {
    const tier = tierOf(it);
    if (it.band === 'new') newCount += 1;
    buckets[tier].push(toTarget(it, tier));
  }

  // 放量档：本月单量降序（社群主推的就是这几栋）
  buckets.amplify.sort((a, b) => b.monthOrders - a.monthOrders);
  // 唤醒档：沉默越久越急
  buckets.wake.sort((a, b) => (b.silentDays ?? 0) - (a.silentDays ?? 0));
  // 沉默档：「历史有量」优先，其次沉默更久（没起过量的排后面）
  buckets.silent.sort(
    (a, b) => b.totalOrders - a.totalOrders || (b.silentDays ?? 0) - (a.silentDays ?? 0),
  );
  buckets.steady.sort((a, b) => b.monthOrders - a.monthOrders);

  const focus = buckets.amplify.slice(0, 3);
  const mustWake = buckets.silent.filter((t) => t.totalOrders > 0).slice(0, 3);

  return {
    ...buckets,
    newCount,
    totals: {
      amplify: buckets.amplify.length,
      steady: buckets.steady.length,
      wake: buckets.wake.length,
      silent: buckets.silent.length,
    },
    focus,
    mustWake,
  };
}

/** 一行摘要（不含姓名/手机号） */
export function describeTargets(t: CommunityTargets): string {
  const line = (label: string, arr: CommunityTarget[]): string =>
    `${label} ${arr.length} 栋` +
    (arr.length
      ? '（' +
        arr
          .slice(0, 3)
          .map((x) => `${x.buildingName ?? `团#${x.leaderId}`} ${x.monthOrders} 单`)
          .join('、') +
        (arr.length > 3 ? ' 等' : '') +
        '）'
      : '');
  return [
    line('放量', t.amplify),
    line('维持', t.steady),
    line('唤醒', t.wake),
    line('沉默', t.silent),
  ].join(' · ');
}

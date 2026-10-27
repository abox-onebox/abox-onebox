import { DistributionGap, GroupCoverageState } from '@abox/shared-types';

import { evaluateStructure } from '../../common/utils/orderability';
import { DistributionCenter } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';

/**
 * 办公楼 / 楼群的**派生值** —— 从 `building-admin.service.ts` 拆出（T5 第二步）
 *
 * ## 为什么先抽这一层
 *
 * 主文件里混着四个关切（楼栋读写 / 楼群 CRUD / 成员替换 / 停用闸门），而它们**全部**
 * 共用这六个派生函数 —— 共享 helper 就是切不开那四个关切的唯一原因。把它们先变成
 * **无状态、输入全部显式传参**的纯函数，后面的按关切拆分才不用再处理共享。
 *
 * ## ⚠️ 本模块**必须保持零 IO**
 *
 * 不注入 Repository、不读配置、不读时钟。任何一条进来，它就从「可单测的派生层」
 * 退化成「另一个 service」，本批在治的「同一件事多份表述」会重新获得土壤。
 * `loadContext()` / `groupStatusOf()` 因为要查库，**刻意留在**主服务里。
 *
 * ## ⚠️ `DC_ACTIVE` 为什么在这里
 * 主服务还有 6 处直接用它（列表/概览的启用停用标签等）。真源只能有一份 ⇒
 * 由本模块导出、主服务 import，**不各写一份常量**。
 */

/** 集散中心状态（`ab_distribution_center.status`）· 与 M3-6 同一口径 */
export const DC_ACTIVE = 1;

/** 楼群 id → 服务它的集散中心（按启用优先、id 升序） */
export function dcByGroup(dcList: DistributionCenter[]): Map<number, DistributionCenter[]> {
  const map = new Map<number, DistributionCenter[]>();
  for (const dc of dcList) {
    for (const gid of (dc.serviceGroups ?? []) as number[]) {
      const key = Number(gid);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(dc);
    }
  }
  for (const list of map.values()) {
    list.sort(
      (a, b) => Number(b.status === DC_ACTIVE) - Number(a.status === DC_ACTIVE) || a.id - b.id,
    );
  }
  return map;
}

/**
 * 覆盖缺口判定（**派生** · 见 `DistributionGap`）
 *
 * ⚠️ 三种成因分三种码，端上给三种修法 —— 合成一个「未覆盖」运营只能猜。
 */
export function gapOf(
  buildingGroupId: number | null | undefined,
  dcMap: Map<number, DistributionCenter[]>,
): DistributionGap {
  if (!buildingGroupId) return DistributionGap.NO_GROUP;
  const dcs = dcMap.get(Number(buildingGroupId)) ?? [];
  if (dcs.length === 0) return DistributionGap.NO_CENTER;
  if (!dcs.some((d) => d.status === DC_ACTIVE)) return DistributionGap.ALL_CENTER_DISABLED;
  return DistributionGap.NONE;
}

/** 主 / 备集散中心（派生 · 裁决 1） */
export function centerPair(dcs: DistributionCenter[]) {
  const active = dcs.filter((d) => d.status === DC_ACTIVE);
  return { main: active[0] ?? null, backup: active[1] ?? null };
}

/** 楼群覆盖状态（**派生**）：空楼群 / 已覆盖 / 未覆盖 */
export function coverageOf(memberCount: number, dcs: DistributionCenter[]): GroupCoverageState {
  if (memberCount === 0) return GroupCoverageState.EMPTY;
  return dcs.some((d) => d.status === DC_ACTIVE)
    ? GroupCoverageState.COVERED
    : GroupCoverageState.UNCOVERED;
}

/** 路线号：按主集散中心 id 升序 → R1…Rn（派生 · 裁决 1） */
export function routeNoMap(dcList: DistributionCenter[]): Map<number, string> {
  const ordered = dcList
    .filter((d) => d.status === DC_ACTIVE)
    .map((d) => Number(d.id))
    .sort((a, b) => a - b);
  const map = new Map<number, string>();
  ordered.forEach((id, i) => map.set(id, `R${i + 1}`));
  return map;
}

/**
 * 管家端「配置上能不能开团」—— **判据只有 `evaluateStructure()` 一份**
 *
 * ⚠️ 为什么管家端只调结构层、不调 `evaluateAvailability()`：管家端是运营 KPI，
 *    **没有时间维度**。叠了时间层，运营夜里看列表会因为「过了截单」看到 false，
 *    把**周期性状态**误报成**配置缺口** —— 两种问题的处置动作完全不同。
 *
 * ⚠️ `buildingGroupStatus` 由调用方传入而不是在这里查：列表 / 概览页已经把楼群整表
 *    取在内存里（`loadContext()`），本方法若内部再查一次就是 N+1。
 */
export function canAssignOf(
  buildingStatus: number,
  buildingGroupId: number | null,
  buildingGroupStatus: number | null,
): boolean {
  return evaluateStructure({ buildingStatus, buildingGroupId, buildingGroupStatus }).ok;
}

/** 有多少个团长同时管着**多于一栋**楼（概览页 KPI，纯派生） */
export function countMultiBuilding(leaders: TeamLeader[]): number {
  const byLeader = new Map<number, number>();
  for (const l of leaders) {
    const uid = Number(l.userId);
    byLeader.set(uid, (byLeader.get(uid) ?? 0) + 1);
  }
  return [...byLeader.values()].filter((n) => n > 1).length;
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import {
  BUILDING_GROUP_STATUS_LABEL,
  BUILDING_STATUS_LABEL,
  BuildingGroupStatus,
  BuildingStatus,
  DISTRIBUTION_GAP_LABEL,
  DistributionGap,
  GROUP_COVERAGE_LABEL,
  GroupCoverageState,
  LEADER_LEVEL_META,
  LeaderLevel,
} from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { normalizePage, paginate } from '../../common/utils/response';
import { Building, BuildingGroup } from '../../database/entities/building.entity';
import { DistributionCenter } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { MealAssignment, SetMeal } from '../../database/entities/meal.entity';
import {
  DC_ACTIVE,
  canAssignOf,
  centerPair,
  countMultiBuilding,
  coverageOf,
  dcByGroup,
  gapOf,
  routeNoMap,
} from './building-derive';
import { AdminBuildingsQueryDto } from './dto/building-admin.dto';

type Row = Record<string, unknown>;

/**
 * 后台 · 办公楼 / 楼群**读侧**服务（T5 第三步 · 从 `building-admin.service.ts` 迁出）
 *
 * 只装**读**：列表 D13 / 详情 / P37 总览 / 配送映射，以及两者共用的主数据上下文
 * （`loadContext`）与单楼群状态回显（`groupStatusOf`）。写侧（新增 / 编辑 / 楼群 CRUD /
 * 成员替换 / 停用闸门）仍在 `BuildingAdminService`。
 *
 * ## 为什么按「读 / 写」切，而不是按「楼栋 / 楼群」切
 * 楼群 CRUD 与楼栋 CRUD 看着是两条线，但它们**共用同一套主数据装载与同一套派生**
 * （`loadContext` + `building-derive`）。按实体切 ⇒ 谁都想要 `loadContext`，
 * 共享依赖切不开，最后还是一份大文件夹一层转发。读写切的好处是**依赖方向单一**：
 * 读侧不认识写侧，写侧只在回显时用读侧。
 *
 * ⚠️ **本文件目前不在 N1-16 的扫描范围内**（该判据按路径只盯 `building-admin.service.ts`）：
 *    这里**不得内联**「楼状态 ∧ 已归群」类判据 —— 一律走 `building-derive.canAssignOf()`。
 *    判据盲区已登记在 spec §5.4.6，裁定前不要扩大它的面。
 */
@Injectable()
export class BuildingQueryService {
  constructor(
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    @InjectRepository(BuildingGroup) private readonly groupRepo: Repository<BuildingGroup>,
    @InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>,
    @InjectRepository(DistributionCenter) private readonly dcRepo: Repository<DistributionCenter>,
    @InjectRepository(MealAssignment) private readonly assignRepo: Repository<MealAssignment>,
    @InjectRepository(SetMeal) private readonly setMealRepo: Repository<SetMeal>,
  ) {}

  // ==========================================================================
  // 内部：一次性装载主数据上下文
  // ==========================================================================

  /**
   * 装载整套主数据（楼栋 / 楼群 / 在职团长 / 集散中心）
   *
   * ⚠️ 「在职团长」只取 `status=1`：停职团长的档案还挂在楼上（M3-5 D20 转交后
   *    原团长是**停职非删除**），照单全收会让一栋楼显示出两个团长。
   */
  async loadContext() {
    const [buildings, groups, leaders, dcList] = await Promise.all([
      this.buildingRepo.find({ where: { deletedAt: IsNull() }, order: { id: 'ASC' } }),
      this.groupRepo.find({ where: { deletedAt: IsNull() }, order: { id: 'ASC' } }),
      this.leaderRepo.find({ where: { status: 1 } }),
      this.dcRepo.find({ where: { deletedAt: IsNull() }, order: { id: 'ASC' } }),
    ]);
    return { buildings, groups, leaders, dcList };
  }

  /** 单栋楼所属楼群的 `status`（新增 / 编辑后回显用；列表页不要走这里，见上面注释） */
  async groupStatusOf(gid: number | null): Promise<number | null> {
    if (gid === null) return null;
    const g = await this.groupRepo.findOne({ where: { id: gid, deletedAt: IsNull() } });
    return g?.status ?? null;
  }

  // ==========================================================================
  // D13 · 办公楼列表
  // ==========================================================================

  async listBuildings(q: AdminBuildingsQueryDto, viewerRole: string): Promise<Row> {
    const { page, pageSize, skip } = normalizePage(q);
    const { buildings, groups, leaders, dcList } = await this.loadContext();
    const dcMap = dcByGroup(dcList);
    const routeMap = routeNoMap(dcList);

    const groupMap = new Map(groups.map((g) => [Number(g.id), g]));
    const leaderMap = new Map(leaders.map((l) => [Number(l.buildingId), l]));

    const rows = buildings.map((b) => {
      const gid = b.buildingGroupId ? Number(b.buildingGroupId) : null;
      const gap = gapOf(gid, dcMap);
      const { main, backup } = centerPair(gid ? (dcMap.get(gid) ?? []) : []);
      const leader = leaderMap.get(Number(b.id));
      const level = (leader?.level ?? LeaderLevel.TRAINEE) as LeaderLevel;
      return {
        id: Number(b.id),
        name: b.name,
        address: b.address,
        city: b.city,
        district: b.district ?? null,
        longitude: b.longitude ?? null,
        latitude: b.latitude ?? null,
        floorCount: b.floorCount ?? null,
        population: b.population ?? null,

        status: b.status,
        statusLabel: BUILDING_STATUS_LABEL[b.status] ?? `未知(${b.status})`,

        buildingGroupId: gid,
        groupName: gid ? (groupMap.get(gid)?.name ?? null) : null,

        leaderId: leader ? Number(leader.id) : null,
        leaderName: leader ? leader.realName : null,
        leaderLevel: leader ? level : null,
        leaderLevelLabel: leader ? (LEADER_LEVEL_META[level]?.label ?? level) : null,

        mainDcId: main ? Number(main.id) : null,
        mainDcName: main ? main.name : null,
        backupDcId: backup ? Number(backup.id) : null,
        backupDcName: backup ? backup.name : null,
        routeNo: main ? (routeMap.get(Number(main.id)) ?? null) : null,

        gap,
        gapLabel: DISTRIBUTION_GAP_LABEL[gap],
        /**
         * 配置上能不能开团（**无时间维度** · 管家端语义，与用户端 `canOrder` 不是一回事）
         *
         * ⚠️ 这里的 `canOrder` 是**解释性引用**（说明两个语义为何不同名），
         *    **不要全局替换**为 `canAssign` —— 用户端 / 团长端的字段名仍是 `canOrder`，
         *    一替换这句就变成「与用户端 `canAssign` 不是一回事」，自相矛盾且不再解释任何东西。
         *
         * ⚠️ 判据改为 `evaluateStructure()`：原写法 `status===ACTIVE && gid!==null`
         *    漏了「所属楼群已停用」—— 楼群停用后成员楼**静默**失去开团能力，
         *    而这里仍显示「可开团」。
         */
        canAssign: canAssignOf(b.status, gid, gid ? (groupMap.get(gid)?.status ?? null) : null),
      };
    });

    let filtered = rows;
    if (q.groupId) filtered = filtered.filter((r) => r.buildingGroupId === Number(q.groupId));
    if (q.status !== undefined) filtered = filtered.filter((r) => r.status === Number(q.status));
    if (q.gap) filtered = filtered.filter((r) => r.gap === q.gap);
    if (q.leaderState === 'assigned') filtered = filtered.filter((r) => r.leaderId !== null);
    if (q.leaderState === 'unassigned') filtered = filtered.filter((r) => r.leaderId === null);
    if (q.keyword) {
      const kw = q.keyword.trim().toLowerCase();
      filtered = filtered.filter(
        (r) =>
          String(r.name).toLowerCase().includes(kw) || String(r.address).toLowerCase().includes(kw),
      );
    }

    const total = filtered.length;
    const ordered = [...filtered].sort(
      (a, b) =>
        Number((b.status as number) === BuildingStatus.ACTIVE) -
          Number((a.status as number) === BuildingStatus.ACTIVE) || Number(a.id) - Number(b.id),
    );
    const pageRows = ordered.slice(skip, skip + pageSize);

    const summary = {
      totalCount: rows.length,
      activeCount: rows.filter((r) => r.status === BuildingStatus.ACTIVE).length,
      preparingCount: rows.filter((r) => r.status === BuildingStatus.PREPARING).length,
      suspendedCount: rows.filter((r) => r.status === BuildingStatus.SUSPENDED).length,
      groupCount: groups.length,
      /** 覆盖人数合计（估算值求和 · 未登记的按 0 计，并在 unregisteredCount 里说明） */
      populationTotal: rows.reduce((s, r) => s + Number(r.population ?? 0), 0),
      populationUnregisteredCount: rows.filter((r) => r.population === null).length,
      leaderAssignedCount: rows.filter((r) => r.leaderId !== null).length,
      leaderVacantCount: rows.filter((r) => r.leaderId === null).length,
      canAssignCount: rows.filter((r) => r.canAssign).length,
      uncoveredCount: rows.filter((r) => r.gap !== DistributionGap.NONE).length,
    };

    return {
      ...paginate(pageRows, total, page, pageSize),
      summary,
      statusOptions: (Object.values(BuildingStatus) as BuildingStatus[]).map((v) => ({
        value: v,
        label: BUILDING_STATUS_LABEL[v],
      })),
      groupOptions: groups.map((g) => ({ value: Number(g.id), label: g.name })),
      gapOptions: (Object.values(DistributionGap) as DistributionGap[]).map((v) => ({
        value: v,
        label: DISTRIBUTION_GAP_LABEL[v],
      })),
      leaderStateOptions: [
        { value: 'assigned', label: '已有团长' },
        { value: 'unassigned', label: '待分配团长' },
      ],
      actions: { canManage: viewerRole !== 'viewer' },
      notes: {
        population:
          '覆盖人数为**运营估算**（非实时统计）；真实就餐人数见 P35 数据看板，两者口径不同勿混用。',
        gap: '「未覆盖」是**下单能成立、履约断链**的状态：用户点得动，却没有集散中心接单配送。',
        map: '主/备集散中心与路线号由「集散中心 → 服务楼群」配置**实时派生**（M3-6 D31），楼栋上不存副本。',
        independent:
          '一楼群一日一套餐（`uk_meal_assignment_date_group`）。需要分楼独立套餐时，请把楼拆成各自的楼群。',
      },
    };
  }

  /** 办公楼详情（D13 附属） */
  async buildingDetail(id: number): Promise<Row> {
    const { buildings, groups, leaders, dcList } = await this.loadContext();
    const b = buildings.find((x) => Number(x.id) === Number(id));
    if (!b) throw new BizException(ErrorCode.BUILDING_NOT_FOUND, `办公楼不存在：#${id}`);

    const dcMap = dcByGroup(dcList);
    const routeMap = routeNoMap(dcList);
    const gid = b.buildingGroupId ? Number(b.buildingGroupId) : null;
    const gap = gapOf(gid, dcMap);
    const dcs = gid ? (dcMap.get(gid) ?? []) : [];
    const { main, backup } = centerPair(dcs);
    const leader = leaders.find((l) => Number(l.buildingId) === Number(b.id));

    const assignments = gid
      ? await this.assignRepo.find({
          where: { buildingGroupId: gid },
          order: { mealDate: 'DESC' },
          take: 5,
        })
      : [];
    const mealIds = [...new Set(assignments.map((a) => Number(a.setMealId)))];
    const meals = mealIds.length ? await this.setMealRepo.find({ where: { id: In(mealIds) } }) : [];
    const mealMap = new Map(meals.map((m) => [Number(m.id), m.name]));

    return {
      building: {
        id: Number(b.id),
        name: b.name,
        address: b.address,
        city: b.city,
        district: b.district ?? null,
        longitude: b.longitude ?? null,
        latitude: b.latitude ?? null,
        floorCount: b.floorCount ?? null,
        population: b.population ?? null,
        status: b.status,
        statusLabel: BUILDING_STATUS_LABEL[b.status] ?? null,
        canAssign: canAssignOf(
          b.status,
          gid,
          gid ? (groups.find((g) => Number(g.id) === gid)?.status ?? null) : null,
        ),
      },
      group: gid
        ? {
            id: gid,
            name: groups.find((g) => Number(g.id) === gid)?.name ?? null,
          }
        : null,
      leader: leader
        ? {
            id: Number(leader.id),
            realName: leader.realName,
            level: leader.level,
            levelLabel: LEADER_LEVEL_META[leader.level as LeaderLevel]?.label ?? leader.level,
          }
        : null,
      distribution: {
        gap,
        gapLabel: DISTRIBUTION_GAP_LABEL[gap],
        mainDcId: main ? Number(main.id) : null,
        mainDcName: main ? main.name : null,
        backupDcId: backup ? Number(backup.id) : null,
        backupDcName: backup ? backup.name : null,
        routeNo: main ? (routeMap.get(Number(main.id)) ?? null) : null,
        /** 该楼群的全部候选集散中心（含停用，供运营改挂时挑）*/
        candidates: dcs.map((d) => ({
          id: Number(d.id),
          name: d.name,
          status: d.status,
          statusLabel: d.status === DC_ACTIVE ? '启用' : '已停用',
        })),
      },
      recentAssignments: assignments.map((a) => ({
        id: Number(a.id),
        mealDate: a.mealDate,
        setMealId: Number(a.setMealId),
        setMealName: mealMap.get(Number(a.setMealId)) ?? null,
        status: a.status,
      })),
      notes: {
        leader:
          '团长只能经 D20 任命 / D21 变更（本条接口为只读）—— 楼栋编辑不提供团长字段，避免绕过撞车闸门。',
      },
    };
  }

  // ==========================================================================
  // P37 总览视图（派生聚合）
  // ==========================================================================

  async overview(viewerRole: string): Promise<Row> {
    const { buildings, groups, leaders, dcList } = await this.loadContext();
    const dcMap = dcByGroup(dcList);
    const leaderMap = new Map(leaders.map((l) => [Number(l.buildingId), l]));
    const groupStatusMap = new Map(groups.map((g) => [Number(g.id), g.status]));

    const groupDistribution = groups.map((g) => {
      const gid = Number(g.id);
      const members = buildings.filter((b) => Number(b.buildingGroupId) === gid);
      const dcs = dcMap.get(gid) ?? [];
      const { main } = centerPair(dcs);
      const state = coverageOf(members.length, dcs);
      return {
        groupId: gid,
        name: g.name,
        description: g.description ?? null,
        status: g.status,
        statusLabel: BUILDING_GROUP_STATUS_LABEL[g.status] ?? null,
        memberCount: members.length,
        populationTotal: members.reduce((s, b) => s + Number(b.population ?? 0), 0),
        buildingNames: members.map((b) => b.name),
        coverageState: state,
        coverageLabel: GROUP_COVERAGE_LABEL[state],
        mainDcId: main ? Number(main.id) : null,
        mainDcName: main ? main.name : null,
      };
    });

    const centerCoverage = dcList.map((dc) => {
      const gids = ((dc.serviceGroups ?? []) as number[]).map(Number);
      const covered = buildings.filter((b) => gids.includes(Number(b.buildingGroupId)));
      return {
        dcId: Number(dc.id),
        name: dc.name,
        address: dc.address,
        status: dc.status,
        statusLabel: dc.status === DC_ACTIVE ? '启用' : '已停用',
        coveredGroupCount: gids.length,
        coveredBuildingCount: covered.length,
        coveredPopulation: covered.reduce((s, b) => s + Number(b.population ?? 0), 0),
      };
    });

    const gapRows = buildings
      .map((b) => ({
        id: Number(b.id),
        name: b.name,
        status: b.status,
        statusLabel: BUILDING_STATUS_LABEL[b.status] ?? null,
        gap: gapOf(b.buildingGroupId ? Number(b.buildingGroupId) : null, dcMap),
      }))
      .map((r) => ({ ...r, gapLabel: DISTRIBUTION_GAP_LABEL[r.gap] }));

    const vacant = buildings
      .filter((b) => !leaderMap.has(Number(b.id)))
      .map((b) => ({ id: Number(b.id), name: b.name, status: b.status }));

    return {
      buildings: {
        totalCount: buildings.length,
        activeCount: buildings.filter((b) => b.status === BuildingStatus.ACTIVE).length,
        preparingCount: buildings.filter((b) => b.status === BuildingStatus.PREPARING).length,
        suspendedCount: buildings.filter((b) => b.status === BuildingStatus.SUSPENDED).length,
        populationTotal: buildings.reduce((s, b) => s + Number(b.population ?? 0), 0),
        /**
         * ⚠️ 这行**原本根本没读列表页那个字段**，而是自己内联了第二份同样的判据
         *    （`status===ACTIVE && buildingGroupId`）—— 改名时若只改字段名而漏掉它，
         *    「楼宇概览」就会留一份没人管的旧判据，与列表页是两个独立数字、
         *    将来对不上也没人查得出。改为与列表页同源，都走 `evaluateStructure()`。
         */
        canAssignCount: buildings.filter((b) => {
          const gid = b.buildingGroupId ? Number(b.buildingGroupId) : null;
          return canAssignOf(b.status, gid, gid ? (groupStatusMap.get(gid) ?? null) : null);
        }).length,
      },
      leaderStats: {
        assignedCount: leaders.length,
        vacantBuildingCount: vacant.length,
        /** 一名团长服务的楼栋数（>1 表示兼管多栋，与原型「赵静一人管两栋」同口径）*/
        multiBuildingCount: countMultiBuilding(leaders),
      },
      groupStats: {
        totalCount: groups.length,
        activeCount: groups.filter((g) => g.status === BuildingGroupStatus.ACTIVE).length,
        suspendedCount: groups.filter((g) => g.status === BuildingGroupStatus.SUSPENDED).length,
        emptyCount: groupDistribution.filter((g) => g.coverageState === GroupCoverageState.EMPTY)
          .length,
        uncoveredCount: groupDistribution.filter(
          (g) => g.coverageState === GroupCoverageState.UNCOVERED,
        ).length,
      },
      centerStats: {
        totalCount: dcList.length,
        activeCount: dcList.filter((d) => d.status === DC_ACTIVE).length,
        disabledCount: dcList.filter((d) => d.status !== DC_ACTIVE).length,
        coveredBuildingCount: buildings.filter(
          (b) =>
            gapOf(b.buildingGroupId ? Number(b.buildingGroupId) : null, dcMap) ===
            DistributionGap.NONE,
        ).length,
      },
      groupDistribution,
      centerCoverage,
      uncoveredBuildings: gapRows.filter((r) => r.gap !== DistributionGap.NONE),
      vacantBuildings: vacant,
      actions: { canManage: viewerRole !== 'viewer' },
      notes: {
        monthlyOrders:
          '本视图只做**主数据健康度**（楼栋 / 楼群 / 团长 / 集散覆盖），不含经营指标 —— 「本月服务订单」等看 P35 数据看板，避免同一指标两处口径。',
        coverage:
          '集散覆盖率 = 已归群 且 所属楼群有启用集散中心的楼栋占比。未覆盖的楼**下单能成立、履约断链**，需尽快处理。',
      },
    };
  }

  // ==========================================================================
  // 配送映射（P37 视图 5 · 全派生）
  // ==========================================================================

  async deliveryMap(): Promise<Row> {
    const { buildings, groups, dcList } = await this.loadContext();
    const dcMap = dcByGroup(dcList);
    const routeMap = routeNoMap(dcList);
    const groupMap = new Map(groups.map((g) => [Number(g.id), g]));

    const routes = new Map<number, Row>();
    const unassigned: Row[] = [];

    for (const b of buildings) {
      const gid = b.buildingGroupId ? Number(b.buildingGroupId) : null;
      const gap = gapOf(gid, dcMap);
      const { main, backup } = centerPair(gid ? (dcMap.get(gid) ?? []) : []);
      if (!main) {
        unassigned.push({
          buildingId: Number(b.id),
          buildingName: b.name,
          groupId: gid,
          groupName: gid ? (groupMap.get(gid)?.name ?? null) : null,
          gap,
          gapLabel: DISTRIBUTION_GAP_LABEL[gap],
          population: b.population ?? null,
        });
        continue;
      }
      const key = Number(main.id);
      if (!routes.has(key)) {
        routes.set(key, {
          routeNo: routeMap.get(key) ?? null,
          dcId: key,
          dcName: main.name,
          dcAddress: main.address,
          dcStatus: main.status,
          dcStatusLabel: '启用',
          stops: [] as Row[],
        });
      }
      (routes.get(key)!.stops as Row[]).push({
        buildingId: Number(b.id),
        buildingName: b.name,
        address: b.address,
        groupId: gid,
        groupName: gid ? (groupMap.get(gid)?.name ?? null) : null,
        backupDcId: backup ? Number(backup.id) : null,
        backupDcName: backup ? backup.name : null,
        population: b.population ?? null,
        status: b.status,
        statusLabel: BUILDING_STATUS_LABEL[b.status] ?? null,
      });
    }

    // 路线内顺序 = 同主集散中心下按楼栋 id 升序（裁决 1）
    const list = [...routes.values()]
      .sort((a, b) => Number(a.dcId) - Number(b.dcId))
      .map((r) => {
        const stops: Row[] = (r.stops as Row[])
          .sort((a, b) => Number(a.buildingId) - Number(b.buildingId))
          .map((s, i) => ({ seq: i + 1, ...s }) as Row);
        return {
          ...r,
          stops,
          stopCount: stops.length,
          populationTotal: stops.reduce((sum, x) => sum + Number(x.population ?? 0), 0),
        };
      });

    const coveredCount = list.reduce((s, r) => s + Number(r.stopCount), 0);

    return {
      routes: list,
      unassigned,
      summary: {
        routeCount: list.length,
        coveredBuildingCount: coveredCount,
        uncoveredBuildingCount: unassigned.length,
        maxStopCount: list.reduce((m, r) => Math.max(m, Number(r.stopCount)), 0),
        totalBuildingCount: buildings.length,
      },
      notes: {
        derived:
          '路线号与站点顺序由「集散中心 → 服务楼群」配置实时派生（主集散中心 id 升序 = R1…Rn；同路线内按楼栋 id 升序）。',
        noDistance:
          '**不返回距离与单段时长**：需地图与真实路况数据，一期不具备。原型上的 km / 分钟为演示值，不是可交付口径。',
        backup:
          '备用集散中心 = 服务同一楼群的其他启用集散中心中 id 最小的一个；没有则为空（该楼群只有一个集散中心，无冗余）。',
      },
    };
  }
}

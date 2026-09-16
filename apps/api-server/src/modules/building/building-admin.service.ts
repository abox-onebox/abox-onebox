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
import { todayBj, tomorrowBj } from '../../common/utils/time';
import { Building, BuildingGroup } from '../../database/entities/building.entity';
import { DistributionCenter } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { MealAssignment, SetMeal } from '../../database/entities/meal.entity';
import {
  AdminBuildingGroupsQueryDto,
  AdminBuildingsQueryDto,
  CreateBuildingDto,
  CreateBuildingGroupDto,
  UpdateBuildingDto,
  UpdateBuildingGroupDto,
} from './dto/building-admin.dto';

type Row = Record<string, unknown>;

/** 集散中心状态（`ab_distribution_center.status`）· 与 M3-6 同一口径 */
const DC_ACTIVE = 1;

/**
 * 后台 · 办公楼 / 楼群服务（M3-7 · 《接口规范》§6.3 D13–D18 · 原型 P37 · 模块 M33-01/02）
 *
 * ## 四条裁决（三条与原型/规范字面不同，务必先读）
 *
 * ### 裁决 1 · 集散中心映射**派生，不落库**
 * 原型 P37 视图 5 展示了「办公楼 → 主集散中心 / 备用集散中心 / 路线内顺序」。
 * 但「集散中心服务哪些楼群」的真源已经在 M3-6 落地：`ab_distribution_center.service_groups`。
 * 若在 `ab_building` 上再存一份「主集散中心」，就是**两套真源** ——
 * 运营改了集散中心的服务范围，楼栋上的字段不会跟着变，界面上两处互相打脸。
 *
 * 故本服务一律**实时派生**：
 *   主集散中心 = 服务该楼所属楼群、且启用中的集散中心里 id 最小的那个
 *   备用集散中心 = 其余服务该楼群的启用集散中心里 id 最小的那个
 *   路线号 Rn = 按主集散中心 id 升序编号；路线内顺序 = 同主集散中心下按楼栋 id 升序
 *   距离 / 单段时长 = **不返回**（需地图与真实路况数据，一期没有；编不出就不编）
 *
 * ### 裁决 2 · `leaderId` 不在本模块
 * 《接口规范》§6.3 原文 D15 写「编辑（含 `leaderId` 关联）」，但 M3-5 已经把
 * 「谁是这栋楼的团长」收口到 D20（任命）/ D21（变更），并且带了**撞车闸门 20012**。
 * 若 D15 也能改 `leaderId`，就同时开了第二条路径，且是一条**绕过闸门**的路径
 * （只改楼上的引用、不动 `ab_team_leader.building_id`，两处立刻不一致）。
 * 故 `UpdateBuildingDto` 刻意不声明 `leaderId`：传了会被 `forbidNonWhitelisted` 拒（10001），
 * 而不是被静默忽略 —— **拒掉比忽略好**，运营至少知道「这里不让你改」。
 *
 * ### 裁决 3 · 停用楼栋 / 停用楼群都**不拦**，但楼群停用要求成员楼已清空
 * 差别在**可观测性**：
 *   · 停用一栋楼 → 影响面就是这栋楼，P37 列表上状态立刻变，运营看得见 → 放行 + 出参警告
 *   · 停用一个楼群 → 成员楼会**静默**失去开团能力（楼自身的状态还是「营业中」，
 *     用户端却显示「该办公楼今日未开团」），P37 上看不出任何异常 → **拦**（60003）
 * 这不是「宽松 vs 严格」，是「错了以后看得见 vs 看不见」。
 *
 * ### 裁决 4 · 所有列表的筛选与分页在**内存**完成
 * 与 M3-6 D29 同一理由：`gap`（覆盖缺口）、`leaderState` 都是派生值，
 * 下推 SQL 要么走 JSON 列（跨库语义不同，见 M3-6 教训），要么写三段子查询。
 * 主数据量级是「十几栋楼 / 几个楼群」，全量取出后在内存筛分页既正确又简单；
 * 真涨到几千栋时应改为物化列 + 定时刷新，而不是继续加子查询。
 */
@Injectable()
export class BuildingAdminService {
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
  private async loadContext() {
    const [buildings, groups, leaders, dcList] = await Promise.all([
      this.buildingRepo.find({ where: { deletedAt: IsNull() }, order: { id: 'ASC' } }),
      this.groupRepo.find({ where: { deletedAt: IsNull() }, order: { id: 'ASC' } }),
      this.leaderRepo.find({ where: { status: 1 } }),
      this.dcRepo.find({ where: { deletedAt: IsNull() }, order: { id: 'ASC' } }),
    ]);
    return { buildings, groups, leaders, dcList };
  }

  /** 楼群 id → 服务它的集散中心（按启用优先、id 升序） */
  private dcByGroup(dcList: DistributionCenter[]): Map<number, DistributionCenter[]> {
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
  private gapOf(
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
  private centerPair(dcs: DistributionCenter[]) {
    const active = dcs.filter((d) => d.status === DC_ACTIVE);
    return { main: active[0] ?? null, backup: active[1] ?? null };
  }

  /** 楼群覆盖状态（**派生**）：空楼群 / 已覆盖 / 未覆盖 */
  private coverageOf(memberCount: number, dcs: DistributionCenter[]): GroupCoverageState {
    if (memberCount === 0) return GroupCoverageState.EMPTY;
    return dcs.some((d) => d.status === DC_ACTIVE)
      ? GroupCoverageState.COVERED
      : GroupCoverageState.UNCOVERED;
  }

  /** 路线号：按主集散中心 id 升序 → R1…Rn（派生 · 裁决 1） */
  private routeNoMap(dcList: DistributionCenter[]): Map<number, string> {
    const ordered = dcList
      .filter((d) => d.status === DC_ACTIVE)
      .map((d) => Number(d.id))
      .sort((a, b) => a - b);
    const map = new Map<number, string>();
    ordered.forEach((id, i) => map.set(id, `R${i + 1}`));
    return map;
  }

  // ==========================================================================
  // D13 · 办公楼列表
  // ==========================================================================

  async listBuildings(q: AdminBuildingsQueryDto, viewerRole: string): Promise<Row> {
    const { page, pageSize, skip } = normalizePage(q);
    const { buildings, groups, leaders, dcList } = await this.loadContext();
    const dcMap = this.dcByGroup(dcList);
    const routeMap = this.routeNoMap(dcList);

    const groupMap = new Map(groups.map((g) => [Number(g.id), g]));
    const leaderMap = new Map(leaders.map((l) => [Number(l.buildingId), l]));

    const rows = buildings.map((b) => {
      const gid = b.buildingGroupId ? Number(b.buildingGroupId) : null;
      const gap = this.gapOf(gid, dcMap);
      const { main, backup } = this.centerPair(gid ? (dcMap.get(gid) ?? []) : []);
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
        /** 现在能不能真的开团 = 营业中 ∧ 已归群（未归群无法分配套餐） */
        canOrder: b.status === BuildingStatus.ACTIVE && gid !== null,
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
      canOrderCount: rows.filter((r) => r.canOrder).length,
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

    const dcMap = this.dcByGroup(dcList);
    const routeMap = this.routeNoMap(dcList);
    const gid = b.buildingGroupId ? Number(b.buildingGroupId) : null;
    const gap = this.gapOf(gid, dcMap);
    const dcs = gid ? (dcMap.get(gid) ?? []) : [];
    const { main, backup } = this.centerPair(dcs);
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
        canOrder: b.status === BuildingStatus.ACTIVE && gid !== null,
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
    const dcMap = this.dcByGroup(dcList);
    const leaderMap = new Map(leaders.map((l) => [Number(l.buildingId), l]));

    const groupDistribution = groups.map((g) => {
      const gid = Number(g.id);
      const members = buildings.filter((b) => Number(b.buildingGroupId) === gid);
      const dcs = dcMap.get(gid) ?? [];
      const { main } = this.centerPair(dcs);
      const state = this.coverageOf(members.length, dcs);
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
        gap: this.gapOf(b.buildingGroupId ? Number(b.buildingGroupId) : null, dcMap),
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
        canOrderCount: buildings.filter(
          (b) => b.status === BuildingStatus.ACTIVE && b.buildingGroupId,
        ).length,
      },
      leaderStats: {
        assignedCount: leaders.length,
        vacantBuildingCount: vacant.length,
        /** 一名团长服务的楼栋数（>1 表示兼管多栋，与原型「赵静一人管两栋」同口径）*/
        multiBuildingCount: this.countMultiBuilding(leaders),
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
            this.gapOf(b.buildingGroupId ? Number(b.buildingGroupId) : null, dcMap) ===
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

  private countMultiBuilding(leaders: TeamLeader[]): number {
    const byLeader = new Map<number, number>();
    for (const l of leaders) {
      const uid = Number(l.userId);
      byLeader.set(uid, (byLeader.get(uid) ?? 0) + 1);
    }
    return [...byLeader.values()].filter((n) => n > 1).length;
  }

  // ==========================================================================
  // 配送映射（P37 视图 5 · 全派生）
  // ==========================================================================

  async deliveryMap(): Promise<Row> {
    const { buildings, groups, dcList } = await this.loadContext();
    const dcMap = this.dcByGroup(dcList);
    const routeMap = this.routeNoMap(dcList);
    const groupMap = new Map(groups.map((g) => [Number(g.id), g]));

    const routes = new Map<number, Row>();
    const unassigned: Row[] = [];

    for (const b of buildings) {
      const gid = b.buildingGroupId ? Number(b.buildingGroupId) : null;
      const gap = this.gapOf(gid, dcMap);
      const { main, backup } = this.centerPair(gid ? (dcMap.get(gid) ?? []) : []);
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

  // ==========================================================================
  // D14 · 新增办公楼
  // ==========================================================================

  async createBuilding(dto: CreateBuildingDto): Promise<Row> {
    const name = dto.name.trim();
    await this.assertBuildingNameFree(name, null);

    if (dto.buildingGroupId) await this.assertGroupExists(dto.buildingGroupId);

    const saved = await this.buildingRepo.save(
      this.buildingRepo.create({
        name,
        address: dto.address.trim(),
        city: dto.city?.trim() || '北京',
        district: dto.district?.trim() || null,
        longitude: dto.longitude ?? null,
        latitude: dto.latitude ?? null,
        floorCount: dto.floorCount ?? null,
        population: dto.population ?? null,
        buildingGroupId: dto.buildingGroupId ?? null,
        status: dto.status ?? BuildingStatus.ACTIVE,
      }),
    );

    const gid = saved.buildingGroupId ? Number(saved.buildingGroupId) : null;
    const dcMap = this.dcByGroup(await this.dcRepo.find({ where: { deletedAt: IsNull() } }));
    const gap = this.gapOf(gid, dcMap);

    return {
      id: Number(saved.id),
      name: saved.name,
      address: saved.address,
      status: saved.status,
      statusLabel: BUILDING_STATUS_LABEL[saved.status] ?? null,
      buildingGroupId: gid,
      population: saved.population ?? null,
      gap,
      gapLabel: DISTRIBUTION_GAP_LABEL[gap],
      canOrder: saved.status === BuildingStatus.ACTIVE && gid !== null,
      warnings: this.buildingWarnings(saved, gap, gid),
    };
  }

  // ==========================================================================
  // D15 · 编辑办公楼
  // ==========================================================================

  async updateBuilding(id: number, dto: UpdateBuildingDto): Promise<Row> {
    const b = await this.buildingRepo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!b) throw new BizException(ErrorCode.BUILDING_NOT_FOUND, `办公楼不存在：#${id}`);

    const patch: Partial<Building> = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name !== b.name) {
        await this.assertBuildingNameFree(name, Number(b.id));
        patch.name = name;
      }
    }
    if (dto.address !== undefined && dto.address.trim() !== b.address) {
      patch.address = dto.address.trim();
    }
    if (dto.city !== undefined && dto.city.trim() !== b.city) patch.city = dto.city.trim();
    if (dto.district !== undefined && (dto.district.trim() || null) !== (b.district ?? null)) {
      patch.district = dto.district.trim() || null;
    }
    if (dto.longitude !== undefined && dto.longitude !== (b.longitude ?? null)) {
      patch.longitude = dto.longitude;
    }
    if (dto.latitude !== undefined && dto.latitude !== (b.latitude ?? null)) {
      patch.latitude = dto.latitude;
    }
    if (dto.floorCount !== undefined && dto.floorCount !== (b.floorCount ?? null)) {
      patch.floorCount = dto.floorCount;
    }
    if (dto.population !== undefined && dto.population !== (b.population ?? null)) {
      patch.population = dto.population;
    }
    // 楼群：`undefined` = 未传（不动） / `null` = 移出楼群（合法意图）—— 故用 `!== undefined` 而非 `??`
    //
    // ⚠️ 真缺陷（2026-09-16，e2e §19 D15 抓出）：此处**不能**写 `'buildingGroupId' in dto`。
    //    本项目 `target: ES2022` ⇒ `useDefineForClassFields` 默认 true ⇒ DTO 的类字段声明
    //    会在实例上**逐个 defineProperty（值为 undefined）**，于是 `'x' in dto` **恒为 true**，
    //    「未传」与「传了 null」根本区分不开 —— 只改名字的请求会被误判成「要移出楼群」。
    //    本仓一律以「值与 `undefined` 比较」判断字段是否被传（同 D18 `buildingIds`）。
    if (dto.buildingGroupId !== undefined) {
      const next = dto.buildingGroupId ?? null;
      const cur = b.buildingGroupId ? Number(b.buildingGroupId) : null;
      if (next !== cur) {
        if (next !== null) await this.assertGroupExists(next);
        patch.buildingGroupId = next;
      }
    }
    if (dto.status !== undefined && dto.status !== b.status) patch.status = dto.status;

    if (Object.keys(patch).length === 0) {
      throw new BizException(ErrorCode.PARAM_INVALID, '没有需要变更的字段');
    }

    Object.assign(b, patch);
    b.version = (b.version ?? 0) + 1;
    const saved = await this.buildingRepo.save(b);

    const gid = saved.buildingGroupId ? Number(saved.buildingGroupId) : null;
    const dcMap = this.dcByGroup(await this.dcRepo.find({ where: { deletedAt: IsNull() } }));
    const gap = this.gapOf(gid, dcMap);

    return {
      id: Number(saved.id),
      name: saved.name,
      status: saved.status,
      statusLabel: BUILDING_STATUS_LABEL[saved.status] ?? null,
      buildingGroupId: gid,
      population: saved.population ?? null,
      gap,
      gapLabel: DISTRIBUTION_GAP_LABEL[gap],
      canOrder: saved.status === BuildingStatus.ACTIVE && gid !== null,
      changed: Object.keys(patch),
      warnings: this.buildingWarnings(saved, gap, gid),
    };
  }

  /**
   * 编辑/新增后的**软警告**（不阻断，只在出参提示）
   *
   * ⚠️ 与 60003（楼群非空不可停用）的差别：这里是「楼级」动作，影响面立刻可见；
   *    楼群停用是「静默影响一批楼」，所以那个必须拦。见文件头裁决 3。
   */
  private buildingWarnings(b: Building, gap: DistributionGap, gid: number | null): string[] {
    const w: string[] = [];
    if (b.status !== BuildingStatus.ACTIVE && gid !== null) {
      w.push('该楼已非营业中：不会出现在套餐矩阵的可选楼栋里，已分配的历史套餐不受影响。');
    }
    if (b.status === BuildingStatus.ACTIVE && gid === null) {
      w.push(
        '该楼未归入楼群：无法分配套餐（用户端会显示「今日未开团」）。请到「楼群划分」把它挂进一个楼群。',
      );
    }
    if (gap === DistributionGap.NO_CENTER) {
      w.push(
        '所属楼群没有任何集散中心服务：用户能下单、但没有主体接单配送。请到「集散中心配置」把该楼群加进某个集散中心的「服务楼群」。',
      );
    }
    if (gap === DistributionGap.ALL_CENTER_DISABLED) {
      w.push('服务该楼群的集散中心已全部停用：请恢复其中一个，或改挂其他集散中心。');
    }
    return w;
  }

  // ==========================================================================
  // D16 · 楼群列表
  // ==========================================================================

  async listGroups(q: AdminBuildingGroupsQueryDto, viewerRole: string): Promise<Row> {
    const { page, pageSize, skip } = normalizePage(q);
    const { buildings, groups, leaders, dcList } = await this.loadContext();
    const dcMap = this.dcByGroup(dcList);
    const leaderMap = new Map(leaders.map((l) => [Number(l.buildingId), l]));

    // 当日 / 次日套餐名（供「楼群划分」视图展示「今天这栋楼群吃什么」）
    const today = todayBj();
    const tomorrow = tomorrowBj();
    const assigns = await this.assignRepo.find({
      where: { mealDate: In([today, tomorrow]) },
    });
    const mealIds = [...new Set(assigns.map((a) => Number(a.setMealId)))];
    const meals = mealIds.length ? await this.setMealRepo.find({ where: { id: In(mealIds) } }) : [];
    const mealMap = new Map(meals.map((m) => [Number(m.id), m.name]));

    const rows = groups.map((g) => {
      const gid = Number(g.id);
      const members = buildings.filter((b) => Number(b.buildingGroupId) === gid);
      const dcs = dcMap.get(gid) ?? [];
      const { main, backup } = this.centerPair(dcs);
      const state = this.coverageOf(members.length, dcs);
      const pick = (date: string) => {
        const a = assigns.find((x) => Number(x.buildingGroupId) === gid && x.mealDate === date);
        if (!a) return null;
        return {
          mealDate: a.mealDate,
          setMealId: Number(a.setMealId),
          setMealName: mealMap.get(Number(a.setMealId)) ?? null,
          status: a.status,
        };
      };

      return {
        id: gid,
        name: g.name,
        description: g.description ?? null,
        city: g.city,
        district: g.district ?? null,
        status: g.status,
        statusLabel: BUILDING_GROUP_STATUS_LABEL[g.status] ?? null,

        memberCount: members.length,
        populationTotal: members.reduce((s, b) => s + Number(b.population ?? 0), 0),
        members: members.map((b) => ({
          id: Number(b.id),
          name: b.name,
          status: b.status,
          statusLabel: BUILDING_STATUS_LABEL[b.status] ?? null,
          population: b.population ?? null,
          leaderId: leaderMap.has(Number(b.id)) ? Number(leaderMap.get(Number(b.id))!.id) : null,
          leaderName: leaderMap.get(Number(b.id))?.realName ?? null,
        })),

        centerCount: dcs.filter((d) => d.status === DC_ACTIVE).length,
        mainDcId: main ? Number(main.id) : null,
        mainDcName: main ? main.name : null,
        backupDcId: backup ? Number(backup.id) : null,
        backupDcName: backup ? backup.name : null,

        coverageState: state,
        coverageLabel: GROUP_COVERAGE_LABEL[state],

        todayAssignment: pick(today),
        tomorrowAssignment: pick(tomorrow),
        /** 当日无分配 = 这栋楼群今天不会出现在用户端（不是错误，只是没排） */
      };
    });

    let filtered = rows;
    if (q.status !== undefined) filtered = filtered.filter((r) => r.status === Number(q.status));
    if (q.keyword) {
      const kw = q.keyword.trim().toLowerCase();
      filtered = filtered.filter(
        (r) =>
          String(r.name).toLowerCase().includes(kw) ||
          String(r.description ?? '')
            .toLowerCase()
            .includes(kw) ||
          (r.members as Row[]).some((m) => String(m.name).toLowerCase().includes(kw)),
      );
    }

    const total = filtered.length;
    const ordered = [...filtered].sort((a, b) => Number(a.id) - Number(b.id));
    const pageRows = ordered.slice(skip, skip + pageSize);

    return {
      ...paginate(pageRows, total, page, pageSize),
      summary: {
        totalCount: rows.length,
        activeCount: rows.filter((r) => r.status === BuildingGroupStatus.ACTIVE).length,
        suspendedCount: rows.filter((r) => r.status === BuildingGroupStatus.SUSPENDED).length,
        emptyCount: rows.filter((r) => r.coverageState === GroupCoverageState.EMPTY).length,
        uncoveredCount: rows.filter((r) => r.coverageState === GroupCoverageState.UNCOVERED).length,
        memberBuildingTotal: rows.reduce((s, r) => s + Number(r.memberCount), 0),
        populationTotal: rows.reduce((s, r) => s + Number(r.populationTotal), 0),
      },
      statusOptions: (Object.values(BuildingGroupStatus) as BuildingGroupStatus[]).map((v) => ({
        value: v,
        label: BUILDING_GROUP_STATUS_LABEL[v],
      })),
      buildingOptions: buildings.map((b) => ({
        value: Number(b.id),
        label: b.name,
        groupId: b.buildingGroupId ? Number(b.buildingGroupId) : null,
      })),
      actions: { canManage: viewerRole !== 'viewer' },
      notes: {
        unified:
          '一楼群一日一套餐（`uk_meal_assignment_date_group`）。原型展示的「独立分配」（银泰 1 栋红烧肉 / 2 栋东坡肉）在本结构下需**把楼拆成各自的楼群** —— 这不是限制，楼群本就是「分发单位」的定义。',
        replace:
          '保存成员楼为**整体替换**语义：不在列表里的楼会被移出本群（其 `building_group_id` 置空，成为「未归群」）。',
        coverage: '未覆盖 = 该楼群有成员楼但没有启用中的集散中心服务 → 用户能下单、履约断链。',
      },
    };
  }

  /** 楼群详情（D16 附属） */
  async groupDetail(id: number): Promise<Row> {
    const { buildings, groups, dcList } = await this.loadContext();
    const g = groups.find((x) => Number(x.id) === Number(id));
    if (!g) throw new BizException(ErrorCode.BUILDING_GROUP_NOT_FOUND, `楼群不存在：#${id}`);
    const gid = Number(g.id);
    const members = buildings.filter((b) => Number(b.buildingGroupId) === gid);
    const dcs = this.dcByGroup(dcList).get(gid) ?? [];
    const state = this.coverageOf(members.length, dcs);
    return {
      id: gid,
      name: g.name,
      description: g.description ?? null,
      city: g.city,
      district: g.district ?? null,
      status: g.status,
      statusLabel: BUILDING_GROUP_STATUS_LABEL[g.status] ?? null,
      memberCount: members.length,
      members: members.map((b) => ({ id: Number(b.id), name: b.name, status: b.status })),
      centers: dcs.map((d) => ({
        id: Number(d.id),
        name: d.name,
        status: d.status,
        statusLabel: d.status === DC_ACTIVE ? '启用' : '已停用',
      })),
      coverageState: state,
      coverageLabel: GROUP_COVERAGE_LABEL[state],
    };
  }

  // ==========================================================================
  // D17 · 新建楼群
  // ==========================================================================

  async createGroup(dto: CreateBuildingGroupDto): Promise<Row> {
    const name = dto.name.trim();
    await this.assertGroupNameFree(name, null);

    const ids = dto.buildingIds ?? [];
    if (ids.length) await this.assertBuildingsExist(ids);

    const saved = await this.groupRepo.save(
      this.groupRepo.create({
        name,
        description: dto.description?.trim() || null,
        city: dto.city?.trim() || '北京',
        district: dto.district?.trim() || null,
        status: BuildingGroupStatus.ACTIVE,
      }),
    );
    const gid = Number(saved.id);
    const moved = ids.length ? await this.assignMembers(gid, ids) : 0;

    return {
      id: gid,
      name: saved.name,
      status: saved.status,
      statusLabel: BUILDING_GROUP_STATUS_LABEL[saved.status] ?? null,
      memberCount: moved,
      coverageState: this.coverageOf(
        moved,
        (await this.dcRepo.find({ where: { deletedAt: IsNull() } })).filter((d) =>
          ((d.serviceGroups ?? []) as number[]).map(Number).includes(gid),
        ),
      ),
    };
  }

  // ==========================================================================
  // D18 · 编辑楼群
  // ==========================================================================

  async updateGroup(id: number, dto: UpdateBuildingGroupDto): Promise<Row> {
    const g = await this.groupRepo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!g) throw new BizException(ErrorCode.BUILDING_GROUP_NOT_FOUND, `楼群不存在：#${id}`);
    const gid = Number(g.id);

    const patch: Partial<BuildingGroup> = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name !== g.name) {
        await this.assertGroupNameFree(name, gid);
        patch.name = name;
      }
    }
    if (
      dto.description !== undefined &&
      (dto.description.trim() || null) !== (g.description ?? null)
    ) {
      patch.description = dto.description.trim() || null;
    }
    if (dto.city !== undefined && dto.city.trim() !== g.city) patch.city = dto.city.trim();
    if (dto.district !== undefined && (dto.district.trim() || null) !== (g.district ?? null)) {
      patch.district = dto.district.trim() || null;
    }
    if (dto.status !== undefined && dto.status !== g.status) patch.status = dto.status;

    const hasMembersPatch = dto.buildingIds !== undefined;
    if (Object.keys(patch).length === 0 && !hasMembersPatch) {
      throw new BizException(ErrorCode.PARAM_INVALID, '没有需要变更的字段');
    }

    // ⚠️ 顺序关键：**先搬楼再判停用闸门** —— 一次请求里「清空成员 + 停用」应当放行。
    //    若倒过来判，运营就必须分两次调用，中间那个状态（有成员却要停用）毫无意义。
    let changedMembers = 0;
    if (hasMembersPatch) {
      const ids = dto.buildingIds ?? [];
      if (ids.length) await this.assertBuildingsExist(ids);
      changedMembers = await this.assignMembers(gid, ids);
    }

    if (patch.status === BuildingGroupStatus.SUSPENDED) {
      const remaining = await this.buildingRepo.count({
        where: { buildingGroupId: gid, deletedAt: IsNull() },
      });
      if (remaining > 0) {
        throw new BizException(
          ErrorCode.BUILDING_GROUP_NOT_EMPTY,
          `楼群下仍有 ${remaining} 栋办公楼，不能停用`,
          undefined,
          { remaining, hint: '请先把成员楼移到其他楼群（或移出楼群）再停用' },
        );
      }
    }

    Object.assign(g, patch);
    g.version = (g.version ?? 0) + 1;
    const saved = await this.groupRepo.save(g);

    const buildings = await this.buildingRepo.find({
      where: { buildingGroupId: gid, deletedAt: IsNull() },
    });
    const dcs = (await this.dcRepo.find({ where: { deletedAt: IsNull() } })).filter((d) =>
      ((d.serviceGroups ?? []) as number[]).map(Number).includes(gid),
    );
    const state = this.coverageOf(buildings.length, dcs);

    return {
      id: gid,
      name: saved.name,
      status: saved.status,
      statusLabel: BUILDING_GROUP_STATUS_LABEL[saved.status] ?? null,
      memberCount: buildings.length,
      changedMembers,
      changed: Object.keys(patch),
      coverageState: state,
      coverageLabel: GROUP_COVERAGE_LABEL[state],
      warnings:
        state === GroupCoverageState.UNCOVERED
          ? [
              '该楼群没有启用中的集散中心服务：成员楼下单能成立、履约断链，请到「集散中心配置」挂载。',
            ]
          : [],
    };
  }

  // ==========================================================================
  // 内部：成员楼整体替换 + 唯一性/存在性校验
  // ==========================================================================

  /**
   * 成员楼**整体替换**（D17/D18 共用 · 与 M3-6 D31 `serviceGroups` 同一纪律）
   *
   * 语义：
   *   · 传入列表**外的**本群现有成员 → 移出（`building_group_id` 置 null）
   *   · 传入列表内的楼 → 归入本群（**无论原先属于哪个楼群** —— 一楼一群，搬过来即覆盖）
   *   · 不动「属于其他楼群、且不在本列表里」的楼
   */
  private async assignMembers(gid: number, ids: number[]): Promise<number> {
    const target = [...new Set(ids.map(Number))];
    const current = await this.buildingRepo.find({
      where: { buildingGroupId: gid, deletedAt: IsNull() },
    });
    const toRemove = current.filter((b) => !target.includes(Number(b.id)));
    if (toRemove.length) {
      await this.buildingRepo.save(
        toRemove.map((b) => Object.assign(b, { buildingGroupId: null })),
      );
    }

    const toAdd = target.length
      ? await this.buildingRepo.find({ where: { id: In(target), deletedAt: IsNull() } })
      : [];
    const needMove = toAdd.filter((b) => Number(b.buildingGroupId ?? 0) !== gid);
    if (needMove.length) {
      await this.buildingRepo.save(needMove.map((b) => Object.assign(b, { buildingGroupId: gid })));
    }

    return target.length;
  }

  private async assertBuildingsExist(ids: number[]): Promise<void> {
    const found = await this.buildingRepo.find({
      where: { id: In(ids.map(Number)), deletedAt: IsNull() },
    });
    const foundIds = new Set(found.map((b) => Number(b.id)));
    const missing = ids.map(Number).filter((i) => !foundIds.has(i));
    if (missing.length) {
      throw new BizException(
        ErrorCode.BUILDING_NOT_FOUND,
        `办公楼不存在：#${missing.join(', #')}`,
        undefined,
        {
          missing,
        },
      );
    }
  }

  /** 楼名唯一（排除自身与已软删） —— 同名楼会让「按楼筛选」变成歧义操作 */
  private async assertBuildingNameFree(name: string, selfId: number | null): Promise<void> {
    const dup = await this.buildingRepo.findOne({
      where: { name, deletedAt: IsNull() },
    });
    if (dup && Number(dup.id) !== selfId) {
      throw new BizException(ErrorCode.BUILDING_NAME_TAKEN, `办公楼名已存在：${name}`, undefined, {
        duplicatedId: Number(dup.id),
      });
    }
  }

  private async assertGroupNameFree(name: string, selfId: number | null): Promise<void> {
    const dup = await this.groupRepo.findOne({ where: { name, deletedAt: IsNull() } });
    if (dup && Number(dup.id) !== selfId) {
      throw new BizException(
        ErrorCode.BUILDING_GROUP_NAME_TAKEN,
        `楼群名已存在：${name}`,
        undefined,
        {
          duplicatedId: Number(dup.id),
        },
      );
    }
  }

  private async assertGroupExists(gid: number): Promise<void> {
    const g = await this.groupRepo.findOne({ where: { id: gid, deletedAt: IsNull() } });
    if (!g) throw new BizException(ErrorCode.BUILDING_GROUP_NOT_FOUND, `楼群不存在：#${gid}`);
  }
}

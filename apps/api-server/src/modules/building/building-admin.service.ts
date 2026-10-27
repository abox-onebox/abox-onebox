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
// ⚠️ `evaluateStructure` 随 `canAssignOf()` 一并迁入 `./building-derive`（T5 第二步）——
//    主服务不再直接持有结构层判据，管家端「能不能开团」的唯一入口是那个纯函数。
import { normalizePage, paginate } from '../../common/utils/response';
import { todayBj, tomorrowBj } from '../../common/utils/time';
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
import { BuildingSuspendService } from './building-suspend.service';
import {
  AdminBuildingGroupsQueryDto,
  AdminBuildingsQueryDto,
  CreateBuildingDto,
  CreateBuildingGroupDto,
  UpdateBuildingDto,
  UpdateBuildingGroupDto,
} from './dto/building-admin.dto';

type Row = Record<string, unknown>;

/**
 * 往已停用楼群搬楼 / 挂楼时的提示（两句：错什么 + 怎么修 · 沿用 ADR §7 的 `hint` 写法）
 *
 * ⚠️ 抽成常量的原因：这条 `hint` 由 `assertGroupOpen()` **一处**持有、`createBuilding` /
 *    `updateBuilding` / `assignMembers` **三条**写路径共用；若各写一份，就是三份会
 *    各自漂移的文案 —— 正是本批 N1 在治的病。
 */
const GROUP_SUSPENDED_HINT =
  '目标楼群已停用：成员楼会静默失去开团能力（楼自身仍显示「营业中」，用户端却显示「今日未开团」）。请先恢复该楼群，或改挂一个启用中的楼群。';

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
    /**
     * N2（P3-5）：停用闸门 + 强制停用放行后的存量订单通知
     *
     * ⚠️ 两者**必须同属一个服务**：通知的触发条件（`forced`）由闸门算出，
     *    拆成两个服务就得把内部判定结果跨服务传回来，反而更绕。
     *    纯判据在 `common/utils/suspend-gate.ts`、投递规则在 `message.service.ts`，
     *    该服务只做 IO 编排 —— 三处都不写第二份判据。
     */
    private readonly suspendService: BuildingSuspendService,
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

  /** 单栋楼所属楼群的 `status`（新增 / 编辑后回显用；列表页不要走这里，见上面注释） */
  private async groupStatusOf(gid: number | null): Promise<number | null> {
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

  // ==========================================================================
  // D14 · 新增办公楼
  // ==========================================================================

  async createBuilding(dto: CreateBuildingDto): Promise<Row> {
    const name = dto.name.trim();
    await this.assertBuildingNameFree(name, null);

    /**
     * ⚠️ N4：新建时挂楼群**同样**要过 60008 —— 这是 spec 与 AC 都**没点到**的第三条写路径
     *    （它们只列了 `assignMembers` 与 `updateBuilding`）。只查「在不在」不够 ——
     *    楼群存在但已停用时照样放行 ⇒ 楼建进去之后因 `group_suspended`
     *    不可下单，而后台给运营的回执是「创建成功」。与另两条路径共用同一判据。
     */
    if (dto.buildingGroupId) await this.assertGroupOpen(dto.buildingGroupId);

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
    const dcMap = dcByGroup(await this.dcRepo.find({ where: { deletedAt: IsNull() } }));
    const gap = gapOf(gid, dcMap);

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
      canAssign: canAssignOf(saved.status, gid, await this.groupStatusOf(gid)),
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
        if (next !== null) {
          /**
           * ⚠️ 同 `assignMembers()`：**挂楼**也要查目标楼群状态（N4 · 60008）。
           *    只查「在不在」不够 —— 楼群存在但已停用时照样放行，成员楼同样会
           *    静默失去开团能力。这是 60003 的第二条旁路。
           */
          await this.assertGroupOpen(next);
        }
        patch.buildingGroupId = next;
      }
    }
    /**
     * N2 闸门 —— 必须放在 `patch.status` 赋值**之前**：拦下时这栋楼的状态还没被改，
     *    运营改完参数就能直接重试，不需要先把它恢复成营业中。
     */
    const gate = await this.suspendService.assertBuildingSuspendable(id, dto);
    if (dto.status !== undefined && dto.status !== b.status) patch.status = dto.status;

    if (Object.keys(patch).length === 0) {
      throw new BizException(ErrorCode.PARAM_INVALID, '没有需要变更的字段');
    }

    Object.assign(b, patch);
    b.version = (b.version ?? 0) + 1;
    const saved = await this.buildingRepo.save(b);

    /**
     * N2 通知 —— 必须在 `save()` **之后**（`MessageService` 硬约束②：投递点在事务之外）。
     *    只有「强制停用放行」这一条路径才会产生它，普通编辑不会多出这个字段。
     */
    const notifyFailedCount = gate.forced
      ? await this.suspendService.notifySuspendAffected('building', Number(saved.id))
      : undefined;

    const gid = saved.buildingGroupId ? Number(saved.buildingGroupId) : null;
    const dcMap = dcByGroup(await this.dcRepo.find({ where: { deletedAt: IsNull() } }));
    const gap = gapOf(gid, dcMap);

    return {
      id: Number(saved.id),
      name: saved.name,
      status: saved.status,
      statusLabel: BUILDING_STATUS_LABEL[saved.status] ?? null,
      buildingGroupId: gid,
      population: saved.population ?? null,
      gap,
      gapLabel: DISTRIBUTION_GAP_LABEL[gap],
      canAssign: canAssignOf(saved.status, gid, await this.groupStatusOf(gid)),
      changed: Object.keys(patch),
      /**
       * ⚠️ `notifyFailedCount` **只在强制停用放行时出现**（其余路径不返回该键）。
       *    它同时会随响应体落进 `ab_operation_log.response_data`（`OperationLogInterceptor`
       *    回写的就是响应体）—— 这正是 spec §6.5「失败必须留痕」要的那一条。
       */
      ...(notifyFailedCount === undefined ? {} : { notifyFailedCount }),
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
    const dcMap = dcByGroup(dcList);
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
      const { main, backup } = centerPair(dcs);
      const state = coverageOf(members.length, dcs);
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
    const dcs = dcByGroup(dcList).get(gid) ?? [];
    const state = coverageOf(members.length, dcs);
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
      coverageState: coverageOf(
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

    /** N2 闸门回带：是否走了「强制停用放行」（只有这条路径才需要通知存量用户） */
    let gate: { forced: boolean } | null = null;

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
      /**
       * N2 闸门 —— 放在 60003 **之后**：先判「成员非空」（一次 `count`），
       *    再数未完结订单（多次查询）。顺序与既有「先搬楼再判闸门」同一精神。
       */
      gate = await this.suspendService.assertGroupSuspendable(gid, dto);
    }

    Object.assign(g, patch);
    g.version = (g.version ?? 0) + 1;
    const saved = await this.groupRepo.save(g);

    /** N2 通知 —— 同上：只在强制停用放行后、且 `save()` 之后 */
    const notifyFailedCount = gate?.forced
      ? await this.suspendService.notifySuspendAffected('building_group', gid)
      : undefined;

    const buildings = await this.buildingRepo.find({
      where: { buildingGroupId: gid, deletedAt: IsNull() },
    });
    const dcs = (await this.dcRepo.find({ where: { deletedAt: IsNull() } })).filter((d) =>
      ((d.serviceGroups ?? []) as number[]).map(Number).includes(gid),
    );
    const state = coverageOf(buildings.length, dcs);

    return {
      id: gid,
      name: saved.name,
      status: saved.status,
      statusLabel: BUILDING_GROUP_STATUS_LABEL[saved.status] ?? null,
      memberCount: buildings.length,
      changedMembers,
      changed: Object.keys(patch),
      /** 同楼宇侧：只在强制停用放行时出现，并随响应体落进 `ab_operation_log` */
      ...(notifyFailedCount === undefined ? {} : { notifyFailedCount }),
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
    /**
     * ⚠️ 入口查目标楼群状态（N4 · 60008）—— 60003 的**旁路堵漏**
     *
     * `BUILDING_GROUP_NOT_EMPTY`(60003) 只保证「停用楼群的那一刻成员为 0」，
     *    却管不到「停用之后再把楼搬进来」。本方法此前完全不查目标楼群状态，
     *    运营往一个已停用的楼群里搬楼，成员楼会**静默**失去开团能力 —— 这正是
     *    裁决 3 里「错了以后看不见」的那类，必须拦。
     */
    await this.assertGroupOpen(gid);

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

  /**
   * N4 判据（**全仓唯一**）—— 目标楼群此刻收不收楼（60008 旁路堵漏）
   *
   * ⚠️ **三条写路径**都会把 `building_group_id` 指向某个楼群：`createBuilding` /
   *    `updateBuilding` 的归群分支 / `assignMembers`（批量搬楼）。判据只能在**这一处**，
   *    否则就是同一件事三份表述、将来各自漂移 —— 正是本批 N1 在治的病。
   *    ⚠️ `throw` **不在这里、也不在各调用点**：60008 的抛点收口后全仓只剩
   *    `assertGroupOpen()` **一处**（见其头注），三条路径共用、payload 形状一致。
   *    本方法只回**判据**不抛码，是因为 `missing` / `suspended` 对应两个不同的码
   *    （`BUILDING_GROUP_NOT_FOUND` / 60008），压成一个 boolean 就把区分弄丢了。
   *
   * ⚠️ **直接读 `status`**，不做「楼群停用了但楼还想挂进去」这类一致性判定 ——
   *    楼群停用是它**自己**的属性，与被挂那栋楼当前什么状态**无关**。
   *
   * ⚠️ `missing` 与 `suspended` **必须分开返回**，不能合成一个 boolean：
   *    行取不到该抛 `BUILDING_GROUP_NOT_FOUND`，而不是被当成「没收楼」放行。
   *    写成 `g?.status === SUSPENDED` 时，`g` 为 undefined ⇒ 恒 false ⇒ **静默放行** ——
   *    这正是 D-N1-8 那一类「拿语义判定去承担存在性」的 fail-open，本批刚治过。
   */
  private async groupGate(gid: number): Promise<'missing' | 'suspended' | 'ok'> {
    const g = await this.groupRepo.findOne({ where: { id: gid, deletedAt: IsNull() } });
    if (!g) return 'missing';
    return g.status === BuildingGroupStatus.SUSPENDED ? 'suspended' : 'ok';
  }

  /**
   * 往某个楼群挂楼 / 搬楼之前的统一准入（三条写路径共用）
   *
   * ⚠️ 抛码留在**这里**而不是散在各调用点：60008 的 payload 形状
   *    （`{ targetGroupId, hint }`，见 spec §8）三条路径完全一致，没有理由抄三遍。
   */
  private async assertGroupOpen(gid: number): Promise<void> {
    const gate = await this.groupGate(gid);
    if (gate === 'missing') {
      throw new BizException(ErrorCode.BUILDING_GROUP_NOT_FOUND, `楼群不存在：#${gid}`);
    }
    if (gate === 'suspended') {
      throw new BizException(ErrorCode.BUILDING_GROUP_SUSPENDED_REJECT, undefined, undefined, {
        targetGroupId: gid,
        hint: GROUP_SUSPENDED_HINT,
      });
    }
  }
}

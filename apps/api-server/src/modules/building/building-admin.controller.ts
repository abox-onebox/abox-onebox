import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  BUILDING_GROUP_STATUS_LABEL,
  BUILDING_STATUS_LABEL,
  BuildingGroupStatus,
  BuildingStatus,
  DISTRIBUTION_GAP_LABEL,
  DistributionGap,
} from '@abox/shared-types';

import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import {
  AdminBuildingGroupsQueryDto,
  AdminBuildingsQueryDto,
  BuildingGroupIdParamDto,
  BuildingIdParamDto,
  CreateBuildingDto,
  CreateBuildingGroupDto,
  UpdateBuildingDto,
  UpdateBuildingGroupDto,
} from './dto/building-admin.dto';
import { BuildingAdminService } from './building-admin.service';

/**
 * 后台 · 办公楼管理（《接口规范 v1.0》§6.3 D13–D15 · 原型 P37 · 模块 M33-01）
 *
 * 路径 `admin/buildings/*` —— 前缀 `admin/` 是 `JwtAuthGuard` 的**主体隔离**依据。
 *
 * ⚠️ **路由顺序**：`GET filter-options` / `overview` / `delivery-map` 三个静态段
 *    必须声明在 `GET :id` **之前**，否则会被当成楼栋 id（同 D8 `export` / D19 的坑）。
 *
 * ⚠️ **两级白名单**（与 M3-4/M3-5/M3-6 同一设计）：
 *    类级放 `operator` —— 运营要能看楼栋、查覆盖缺口、跟进团长空缺；
 *    D14/D15 **方法级收窄到 `super_admin`/`admin`** —— 改楼栋档案会影响
 *    套餐矩阵可选范围与配送归属，是「决定哪些楼能开团」的事。
 *    `finance` / `viewer` 类级就不放：菜单矩阵里两者都没有 `/building/*`。
 */
@ApiTags('后台·办公楼管理')
@ApiBearerAuth()
@Controller('admin/buildings')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class BuildingAdminController {
  constructor(private readonly buildingAdmin: BuildingAdminService) {}

  // ------------------------------------------------------------ D13 列表

  @Get()
  @ApiOperation({
    summary: 'D13 办公楼列表',
    description:
      '按楼群 / 状态 / 覆盖缺口 / 团长归属 / 关键词筛选。' +
      '`summary` 为**全量**统计（翻页不跳 KPI）；' +
      '`gap` 是派生值，区分三种「送不出去」：no_group 未归群 / no_center 楼群无集散 / ' +
      'all_center_disabled 集散已停用 —— 三种成因对应三种修法。' +
      '`canOrder` = 营业中 ∧ 已归群（未归群无法分配套餐）。' +
      '主/备集散中心与路线号由「集散中心 → 服务楼群」配置**实时派生**，楼栋上不存副本。',
  })
  list(@Query() q: AdminBuildingsQueryDto, @CurrentAdmin('role') role: string) {
    return this.buildingAdmin.listBuildings(q, role);
  }

  @Get('filter-options')
  @ApiOperation({
    summary: 'D13 附属 · 筛选器下拉（状态 / 楼群 / 覆盖缺口 / 团长归属）',
    description:
      '枚举文案来自 `@abox/shared-types`，不在控制器里再抄一份中文（M3-4 起的统一纪律）。' +
      '楼群下拉来自真实数据。列表接口亦内联同名 options，独立接口供搜索表单组件单独拉取。',
  })
  async filterOptions() {
    const { groupOptions } = await this.buildingAdmin.listBuildings(
      { page: 1, pageSize: 1 },
      'viewer',
    );
    return {
      statusOptions: (Object.values(BuildingStatus) as BuildingStatus[]).map((v) => ({
        value: v,
        label: BUILDING_STATUS_LABEL[v],
      })),
      gapOptions: (Object.values(DistributionGap) as DistributionGap[]).map((v) => ({
        value: v,
        label: DISTRIBUTION_GAP_LABEL[v],
      })),
      leaderStateOptions: [
        { value: 'assigned', label: '已有团长' },
        { value: 'unassigned', label: '待分配团长' },
      ],
      groupOptions,
    };
  }

  @Get('overview')
  @ApiOperation({
    summary: 'P37 总览视图 · 主数据健康度（楼栋 / 楼群 / 团长 / 集散覆盖）',
    description:
      '⚠️ 只做**主数据健康度**，不含经营指标 —— 「本月服务订单」等看 P35 数据看板（D47），' +
      '避免同一指标两处口径。含楼群分布、集散中心覆盖、未覆盖楼栋清单、待分配团长清单。',
  })
  overview(@CurrentAdmin('role') role: string) {
    return this.buildingAdmin.overview(role);
  }

  @Get('delivery-map')
  @ApiOperation({
    summary: 'P37 集散中心映射视图 · 办公楼 → 主/备集散中心（派生）',
    description:
      '路线号 Rn 按主集散中心 id 升序编号，路线内站点按楼栋 id 升序 —— 全部**实时派生**，' +
      '不落库（真源是 `ab_distribution_center.service_groups`）。' +
      '⚠️ **不返回距离与单段时长**：需地图与真实路况数据，一期不具备；原型上的 km/分钟为演示值。',
  })
  deliveryMap() {
    return this.buildingAdmin.deliveryMap();
  }

  @Get(':id')
  @ApiOperation({
    summary: 'D13 附属 · 办公楼详情（档案 + 楼群 + 团长 + 集散映射 + 近期套餐）',
    description:
      '团长为**只读**：改团长走 D20/D21（楼栋编辑不提供 leaderId，避免绕过 20012 撞车闸门）。',
  })
  detail(@Param() p: BuildingIdParamDto) {
    return this.buildingAdmin.buildingDetail(p.id);
  }

  // ------------------------------------------------------------ D14 / D15

  @Post()
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'building', action: '新增办公楼' })
  @ApiOperation({
    summary: 'D14 新增办公楼',
    description:
      '楼名重复 → 60005（同名楼会让「按楼筛选」变成歧义操作）；楼群不存在 → 60002。' +
      '不传 `buildingGroupId` 即「未归群」：楼能建档，但无法分配套餐（`canOrder=false`）。' +
      '出参 `warnings` 逐条说明「还差什么才能开团」。',
  })
  create(@Body() dto: CreateBuildingDto) {
    return this.buildingAdmin.createBuilding(dto);
  }

  @Put(':id')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'building', action: '编辑办公楼', targetParam: 'id' })
  @ApiOperation({
    summary: 'D15 编辑办公楼（含归群 / 状态）',
    description:
      '部分更新，只改传了的字段；`buildingGroupId: null` = **移出楼群**。' +
      '空变更 → 10001（不写库、不写日志）。' +
      '⚠️ **刻意不收 `leaderId`**（《接口规范》原文写「含 leaderId 关联」，本批次按 M3-5 单入口纪律修订）：' +
      '改团长只有 D20/D21 一个入口，且带撞车闸门 —— 传 `leaderId` 会被 `forbidNonWhitelisted` 拒（10001）。',
  })
  update(@Param() p: BuildingIdParamDto, @Body() dto: UpdateBuildingDto) {
    return this.buildingAdmin.updateBuilding(p.id, dto);
  }
}

/**
 * 后台 · 楼群管理（《接口规范 v1.0》§6.3 D16–D18 · 原型 P37 · 模块 M33-02）
 *
 * ⚠️ 与 `BuildingAdminController` 分成两个控制器：路径前缀不同（`admin/building-groups`），
 *    Nest 的 `@Controller` 无法共用一个前缀。两者共用同一 service，避免逻辑分叉。
 */
@ApiTags('后台·楼群管理')
@ApiBearerAuth()
@Controller('admin/building-groups')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class BuildingGroupAdminController {
  constructor(private readonly buildingAdmin: BuildingAdminService) {}

  @Get()
  @ApiOperation({
    summary: 'D16 楼群列表',
    description:
      '含成员办公楼、主/备集散中心、覆盖状态、当日与次日套餐分配。' +
      '⚠️ 一楼群一日一套餐（`uk_meal_assignment_date_group`）；' +
      '原型上的「独立分配」需**把楼拆成各自的楼群** —— 楼群本就是「分发单位」的定义。',
  })
  list(@Query() q: AdminBuildingGroupsQueryDto, @CurrentAdmin('role') role: string) {
    return this.buildingAdmin.listGroups(q, role);
  }

  @Get('filter-options')
  @ApiOperation({
    summary: 'D16 附属 · 筛选器下拉（楼群状态）',
    description: '楼群状态只有两态（1 启用 / 2 停用）—— 楼群是纯组织维度，没有「待开通」中间态。',
  })
  filterOptions() {
    return {
      statusOptions: (Object.values(BuildingGroupStatus) as BuildingGroupStatus[]).map((v) => ({
        value: v,
        label: BUILDING_GROUP_STATUS_LABEL[v],
      })),
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'D16 附属 · 楼群详情（成员楼 + 服务集散中心）' })
  detail(@Param() p: BuildingGroupIdParamDto) {
    return this.buildingAdmin.groupDetail(p.id);
  }

  @Post()
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'building', action: '新建楼群' })
  @ApiOperation({
    summary: 'D17 新建楼群',
    description:
      '楼群名重复 → 60004；`buildingIds` 含不存在楼栋 → 60001。' +
      '`buildingIds` 为**整体设置**：这些楼会归入本楼群（原先属于别的楼群的会被搬过来）。',
  })
  create(@Body() dto: CreateBuildingGroupDto) {
    return this.buildingAdmin.createGroup(dto);
  }

  @Put(':id')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'building', action: '编辑楼群', targetParam: 'id' })
  @ApiOperation({
    summary: 'D18 编辑楼群（含成员办公楼增删）',
    description:
      '`buildingIds` 为**整体替换**语义（与 D31 `serviceGroups` 同一纪律）：传 `[]` 即清空成员楼，' +
      '不在列表里的楼会被移出本群。' +
      '⚠️ 停用楼群要求**成员楼已清空**，否则 60003 —— 因为停用会让成员楼**静默**失去开团能力，' +
      '而楼自身状态仍显示「营业中」，运营在 P37 上看不出异常。' +
      '⚠️ 顺序：**先搬楼再判闸门**，故「清空成员 + 停用」可在一次请求内完成。',
  })
  update(@Param() p: BuildingGroupIdParamDto, @Body() dto: UpdateBuildingGroupDto) {
    return this.buildingAdmin.updateGroup(p.id, dto);
  }
}

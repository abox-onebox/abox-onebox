import { http } from './request';
import type { PageResult } from './system';

/**
 * api/building —— 后台办公楼 / 楼群管理（《接口规范 v1.0》§6.3 D13–D18 · 原型 P37）
 *
 * ⚠️ **主/备集散中心与路线号是服务端派生值**（真源是 `ab_distribution_center.service_groups`），
 *    端上不要自己按楼群去匹配集散中心 —— 那样会造出第二套推导逻辑，
 *    两处一旦不一致（比如运营改了集散中心的服务范围），页面显示就会与后端判断打架。
 *
 * ⚠️ **不返回距离与单段时长**：需地图与真实路况数据，一期不具备。
 *    原型上的「0.8 km / 30 分钟」是演示值，**不要**照抄到正式页面。
 *
 * ⚠️ 枚举文案（营业中 / 待开通 / 已暂停 / 覆盖缺口）**由服务端下发**，
 *    或取自 `@abox/shared-types`，不在此维护第二份中文映射。
 */

// ============================================================================
// D13 办公楼列表
// ============================================================================

export interface BuildingRow {
  id: number;
  name: string;
  address: string;
  city: string;
  district: string | null;
  longitude: string | null;
  latitude: string | null;
  floorCount: number | null;
  /** 覆盖人数（运营估算，非实时统计）*/
  population: number | null;

  status: number;
  statusLabel: string;

  buildingGroupId: number | null;
  groupName: string | null;

  leaderId: number | null;
  leaderName: string | null;
  leaderLevel: string | null;
  leaderLevelLabel: string | null;

  mainDcId: number | null;
  mainDcName: string | null;
  backupDcId: number | null;
  backupDcName: string | null;
  routeNo: string | null;

  /** none / no_group / no_center / all_center_disabled */
  gap: string;
  gapLabel: string;
  /** 营业中 ∧ 已归群 */
  canOrder: boolean;
}

export interface BuildingsSummary {
  totalCount: number;
  activeCount: number;
  preparingCount: number;
  suspendedCount: number;
  groupCount: number;
  populationTotal: number;
  populationUnregisteredCount: number;
  leaderAssignedCount: number;
  leaderVacantCount: number;
  canOrderCount: number;
  uncoveredCount: number;
}

export interface Option {
  value: string | number;
  label: string;
  type?: string;
  groupId?: number | null;
}

export interface BuildingsQuery {
  groupId?: number;
  status?: number;
  gap?: string;
  leaderState?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export interface BuildingsPage extends PageResult<BuildingRow> {
  summary: BuildingsSummary;
  statusOptions: Option[];
  groupOptions: Option[];
  gapOptions: Option[];
  leaderStateOptions: Option[];
  actions: { canManage: boolean };
  notes?: Record<string, string>;
}

export const fetchBuildings = (params: BuildingsQuery) =>
  http.get<BuildingsPage>('/admin/buildings', params);

export interface BuildingDetail {
  building: {
    id: number;
    name: string;
    address: string;
    city: string;
    district: string | null;
    longitude: string | null;
    latitude: string | null;
    floorCount: number | null;
    population: number | null;
    status: number;
    statusLabel: string | null;
    canOrder: boolean;
  };
  group: { id: number; name: string | null } | null;
  leader: { id: number; realName: string; level: string; levelLabel: string } | null;
  distribution: {
    gap: string;
    gapLabel: string;
    mainDcId: number | null;
    mainDcName: string | null;
    backupDcId: number | null;
    backupDcName: string | null;
    routeNo: string | null;
    /** 该楼群的全部候选集散中心（含停用，供运营改挂时挑）*/
    candidates: Array<{ id: number; name: string; status: number; statusLabel: string }>;
  };
  recentAssignments: Array<{
    id: number;
    mealDate: string;
    setMealId: number;
    setMealName: string | null;
    status: string;
  }>;
  notes?: Record<string, string>;
}

export const fetchBuildingDetail = (id: number) =>
  http.get<BuildingDetail>(`/admin/buildings/${id}`);

// ============================================================================
// P37 总览（主数据健康度）
// ============================================================================

export interface GroupDistributionItem {
  groupId: number;
  name: string;
  description: string | null;
  status: number;
  statusLabel: string | null;
  memberCount: number;
  populationTotal: number;
  buildingNames: string[];
  /** covered / uncovered / empty */
  coverageState: string;
  coverageLabel: string;
  mainDcId: number | null;
  mainDcName: string | null;
}

export interface CenterCoverageItem {
  dcId: number;
  name: string;
  address: string;
  status: number;
  statusLabel: string;
  coveredGroupCount: number;
  coveredBuildingCount: number;
  coveredPopulation: number;
}

export interface BuildingOverview {
  buildings: {
    totalCount: number;
    activeCount: number;
    preparingCount: number;
    suspendedCount: number;
    populationTotal: number;
    canOrderCount: number;
  };
  leaderStats: {
    assignedCount: number;
    vacantBuildingCount: number;
    multiBuildingCount: number;
  };
  groupStats: {
    totalCount: number;
    activeCount: number;
    suspendedCount: number;
    emptyCount: number;
    uncoveredCount: number;
  };
  centerStats: {
    totalCount: number;
    activeCount: number;
    disabledCount: number;
    coveredBuildingCount: number;
  };
  groupDistribution: GroupDistributionItem[];
  centerCoverage: CenterCoverageItem[];
  uncoveredBuildings: Array<{
    id: number;
    name: string;
    status: number;
    statusLabel: string | null;
    gap: string;
    gapLabel: string;
  }>;
  vacantBuildings: Array<{ id: number; name: string; status: number }>;
  actions: { canManage: boolean };
  notes?: Record<string, string>;
}

export const fetchBuildingOverview = () => http.get<BuildingOverview>('/admin/buildings/overview');

// ============================================================================
// P37 集散中心映射（全派生）
// ============================================================================

export interface DeliveryStop {
  seq: number;
  buildingId: number;
  buildingName: string;
  address: string;
  groupId: number | null;
  groupName: string | null;
  backupDcId: number | null;
  backupDcName: string | null;
  population: number | null;
  status: number;
  statusLabel: string | null;
}

export interface DeliveryRoute {
  routeNo: string | null;
  dcId: number;
  dcName: string;
  dcAddress: string;
  dcStatus: number;
  dcStatusLabel: string;
  stops: DeliveryStop[];
  stopCount: number;
  populationTotal: number;
}

export interface DeliveryMap {
  routes: DeliveryRoute[];
  unassigned: Array<{
    buildingId: number;
    buildingName: string;
    groupId: number | null;
    groupName: string | null;
    gap: string;
    gapLabel: string;
    population: number | null;
  }>;
  summary: {
    routeCount: number;
    coveredBuildingCount: number;
    uncoveredBuildingCount: number;
    maxStopCount: number;
    totalBuildingCount: number;
  };
  notes?: Record<string, string>;
}

export const fetchDeliveryMap = () => http.get<DeliveryMap>('/admin/buildings/delivery-map');

// ============================================================================
// D14 / D15 写操作
// ============================================================================

export interface BuildingWritePayload {
  name?: string;
  address?: string;
  city?: string;
  district?: string;
  longitude?: string;
  latitude?: string;
  floorCount?: number;
  population?: number;
  /** 传 null = 移出楼群（不参与任何套餐分配）*/
  buildingGroupId?: number | null;
  status?: number;
}

export interface BuildingWriteResult {
  id: number;
  name: string;
  status: number;
  statusLabel: string | null;
  buildingGroupId: number | null;
  population: number | null;
  gap: string;
  gapLabel: string;
  canOrder: boolean;
  changed?: string[];
  /** 「还差什么才能开团」的逐条说明（不阻断保存）*/
  warnings: string[];
}

export const createBuilding = (data: BuildingWritePayload) =>
  http.post<BuildingWriteResult>('/admin/buildings', data);

export const updateBuilding = (id: number, data: BuildingWritePayload) =>
  http.put<BuildingWriteResult>(`/admin/buildings/${id}`, data);

// ============================================================================
// D16 · 楼群列表
// ============================================================================

export interface GroupMember {
  id: number;
  name: string;
  status: number;
  statusLabel: string | null;
  population: number | null;
  leaderId: number | null;
  leaderName: string | null;
}

export interface GroupAssignment {
  mealDate: string;
  setMealId: number;
  setMealName: string | null;
  status: string;
}

export interface GroupRow {
  id: number;
  name: string;
  description: string | null;
  city: string;
  district: string | null;
  status: number;
  statusLabel: string | null;

  memberCount: number;
  populationTotal: number;
  members: GroupMember[];

  centerCount: number;
  mainDcId: number | null;
  mainDcName: string | null;
  backupDcId: number | null;
  backupDcName: string | null;

  /** covered / uncovered / empty */
  coverageState: string;
  coverageLabel: string;

  todayAssignment: GroupAssignment | null;
  tomorrowAssignment: GroupAssignment | null;
}

export interface GroupsQuery {
  status?: number;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export interface GroupsPage extends PageResult<GroupRow> {
  summary: {
    totalCount: number;
    activeCount: number;
    suspendedCount: number;
    emptyCount: number;
    uncoveredCount: number;
    memberBuildingTotal: number;
    populationTotal: number;
  };
  statusOptions: Option[];
  buildingOptions: Option[];
  actions: { canManage: boolean };
  notes?: Record<string, string>;
}

export const fetchGroups = (params: GroupsQuery) =>
  http.get<GroupsPage>('/admin/building-groups', params);

export interface GroupDetail {
  id: number;
  name: string;
  description: string | null;
  city: string;
  district: string | null;
  status: number;
  statusLabel: string | null;
  memberCount: number;
  members: Array<{ id: number; name: string; status: number }>;
  centers: Array<{ id: number; name: string; status: number; statusLabel: string }>;
  coverageState: string;
  coverageLabel: string;
}

export const fetchGroupDetail = (id: number) =>
  http.get<GroupDetail>(`/admin/building-groups/${id}`);

// ============================================================================
// D17 / D18 写操作
// ============================================================================

export interface GroupWritePayload {
  name?: string;
  description?: string;
  city?: string;
  district?: string;
  /** ⚠️ 整体替换语义：传 [] 即清空成员楼，不在列表里的楼会被移出本群 */
  buildingIds?: number[];
  /** 停用要求成员楼已清空，否则 60003 */
  status?: number;
}

export interface GroupWriteResult {
  id: number;
  name: string;
  status: number;
  statusLabel: string | null;
  memberCount: number;
  changedMembers?: number;
  changed?: string[];
  coverageState: string;
  coverageLabel: string;
  warnings: string[];
}

export const createGroup = (data: GroupWritePayload) =>
  http.post<GroupWriteResult>('/admin/building-groups', data);

export const updateGroup = (id: number, data: GroupWritePayload) =>
  http.put<GroupWriteResult>(`/admin/building-groups/${id}`, data);

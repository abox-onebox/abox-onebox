import { http } from './request';
import type { PageResult } from './system';

/**
 * api/meal —— 后台套餐编排（《接口规范 v1.0》§6.1 D1–D7 · 原型 P27–P29）
 *
 * 与 `api/home.ts`（小程序 U1/U2）的分工：那两个接口是**用户端只读**（C8 约束：
 * 严禁吐供价与供应商状态）；本文件是**运营后台读写**，必须给出成本与供应商维度。
 * 两者共用 `ab_meal_assignment` 一张表 —— 后台改完，用户端下一个请求就能看到。
 */

/** 分配状态：pending 已排期未上架 / active 已上架 / cancelled 已取消 */
export type AssignmentStatus = 'pending' | 'active' | 'cancelled';

/** D1 矩阵 · 楼群（含「已分配 / 未分配」两组楼栋 id） */
export interface MatrixGroup {
  id: number;
  name: string;
  buildingIds: number[];
  /** 楼群内「合作中」办公楼 —— UI 为选中态复选框 */
  assignedBuildings: number[];
  /** 楼群内停用 / 待分配办公楼 —— UI 为**禁用**复选框 */
  emptyBuildings: number[];
}

/** D1 矩阵 · 单元格（日期 × 楼群；无分配时 assignmentId=null，空格子本身即信息） */
export interface MatrixCell {
  mealDate: string;
  groupId: number;
  assignmentId: number | null;
  setMealId: number | null;
  setMealName: string | null;
  setMealPriceFen: number | null;
  status: AssignmentStatus | null;
  statusHint: string | null;
  dishCount: number;
  distributionCenterId: number | null;
  distributionCenterName: string | null;
  assignedBuildings: number[];
  emptyBuildings: number[];
  soldCount: number;
  /** 已过硬截单时刻（T 日 00:00）—— 已截单则不可再上架 */
  cutoffPassed: boolean;
  canPublish: boolean;
}

export interface MealMatrix {
  startDate: string;
  endDate: string;
  dates: string[];
  groups: MatrixGroup[];
  /** 行优先展开的**完整**网格（dates.length × groups.length 项） */
  cells: MatrixCell[];
  stats: {
    dateCount: number;
    groupCount: number;
    cellCount: number;
    assignedCells: number;
    publishedCells: number;
    emptyCells: number;
    totalSold: number;
  };
  note: string;
}

export interface MealAssignment {
  id: number;
  mealDate: string;
  buildingGroupId: number;
  setMealId: number;
  setMealName: string | null;
  distributionCenterId: number | null;
  status: AssignmentStatus;
  statusHint: string;
  publishAt: string | null;
  cutoffAt: string | null;
  cutoffPassed: boolean;
  soldCount: number;
}

export interface CreateAssignmentPayload {
  mealDate: string;
  buildingGroupId: number;
  setMealId: number;
  distributionCenterId?: number;
}

export interface UpdateAssignmentPayload {
  setMealId?: number;
  distributionCenterId?: number;
}

export interface CopyAssignmentsPayload {
  fromDate: string;
  targetDates: string[];
  buildingGroupIds?: number[];
}

export interface CopyAssignmentsResult {
  fromDate: string;
  targetDates: string[];
  created: Array<{ mealDate: string; buildingGroupId: number; assignmentId: number }>;
  createdCount: number;
  /** 被**跳过**而非覆盖的项（已存在分配 / 已截单）· 复制动作最需要透明的一列 */
  skipped: Array<{ mealDate: string; buildingGroupId: number; reason: string }>;
  skippedCount: number;
  note: string;
}

/** D6/D7 套餐模板里的菜品项 */
export interface SetMealItemRow {
  dishId: number;
  slot: number;
  slotLabel: string;
  name: string | null;
  supplierId: number | null;
}

export interface SetMealTemplateRow {
  id: number;
  name: string | null;
  priceFen: number;
  costPriceFen: number;
  oneLiner: string | null;
  status: number;
  statusText: string;
  dishCount: number;
  items: SetMealItemRow[];
  /** 被多少个「未取消的分配」引用 —— 模板库里最有用的一列 */
  usedCount: number;
}

export interface SetMealTemplateQuery {
  keyword?: string;
  status?: number;
  page?: number;
  pageSize?: number;
}

export interface CreateTemplatePayload {
  name: string;
  price?: number;
  oneLiner?: string;
  description?: string;
  coverUrl?: string;
  /** 与 sourceSetMealId 二选一 */
  items?: Array<{ dishId: number; slot: number }>;
  sourceSetMealId?: number;
}

/** 菜品选择器（D7 编排页候选菜品） */
export interface DishOption {
  id: number;
  name: string;
  category: string | null;
  imageUrl: string | null;
  supplierId: number;
  supplierName: string | null;
  supplierStatus: number | null;
  costPriceFen: number;
  status: number;
}

export interface DishOptions {
  /** 档位选项由服务端给出 —— 端上不维护第二份「1=主荤…」映射 */
  slots: Array<{ value: number; label: string }>;
  list: DishOption[];
  total: number;
}

// ---------------------------------------------------------------- D1–D5 编排

/** D1 日期 × 楼群二维矩阵 */
export function fetchMealMatrix(params: {
  startDate?: string;
  endDate?: string;
}): Promise<MealMatrix> {
  return http.get<MealMatrix>('/admin/meal/matrix', params);
}

/** D2 创建套餐分配（建出来是 pending，需 D4 上架才对用户端开放） */
export function createMealAssignment(payload: CreateAssignmentPayload): Promise<MealAssignment> {
  return http.post<MealAssignment>('/admin/meal/assignments', payload);
}

/** D3 编辑分配（只改套餐与集散中心；改日期 / 楼群请删旧建新） */
export function updateMealAssignment(
  id: number,
  payload: UpdateAssignmentPayload,
): Promise<MealAssignment> {
  return http.put<MealAssignment>(`/admin/meal/assignments/${id}`, payload);
}

/** D4 上架 / 下架（重复同向操作**幂等**） */
export function publishMealAssignment(
  id: number,
  action: 'publish' | 'unpublish',
): Promise<MealAssignment> {
  return http.post<MealAssignment>(`/admin/meal/assignments/${id}/publish`, { action });
}

/** D5 批量复制（不覆盖已存在项；复制出的分配一律 pending） */
export function copyMealAssignments(
  payload: CopyAssignmentsPayload,
): Promise<CopyAssignmentsResult> {
  return http.post<CopyAssignmentsResult>('/admin/meal/assignments/copy', payload);
}

// ---------------------------------------------------------------- D6–D7 模板

/** D6 套餐模板库 */
export function fetchMealTemplates(
  params: SetMealTemplateQuery,
): Promise<PageResult<SetMealTemplateRow>> {
  return http.get<PageResult<SetMealTemplateRow>>('/admin/meal/templates', params);
}

/** D7 存为模板（入参不含 supplierId / costPrice —— 由菜品反查与求和） */
export function createMealTemplate(payload: CreateTemplatePayload): Promise<SetMealTemplateRow> {
  return http.post<SetMealTemplateRow>('/admin/meal/templates', payload);
}

/** 菜品选择器 */
export function fetchDishOptions(params: { keyword?: string }): Promise<DishOptions> {
  return http.get<DishOptions>('/admin/meal/dishes', params);
}

/** 集散中心选择器（可选字段 —— 不选是合法状态，C9：集散复用供应商场地、场地费默认 ¥0） */
export interface DistributionCenterOption {
  id: number;
  name: string;
  supplierId: number;
  supplierName: string | null;
  address: string | null;
  status: number;
}

export function fetchDistributionCenterOptions(): Promise<{
  list: DistributionCenterOption[];
  total: number;
}> {
  return http.get<{ list: DistributionCenterOption[]; total: number }>(
    '/admin/meal/distribution-centers',
  );
}

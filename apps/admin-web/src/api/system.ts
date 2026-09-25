import { http } from './request';
import type { AdminAccount } from './auth';

/**
 * api/system —— 后台系统管理（《接口规范 v1.0》§6.7 D51–D56）
 *
 * 与 `api/user.ts` 的区别：本文件管的是**后台账号**（`ab_admin_user`，运营/供应商），
 * `api/user.ts` 管的是**小程序用户**（`ab_user`）。两套账号体系无任何外键关系。
 */

export interface AdminAccountRow extends AdminAccount {
  supplierName: string | null;
  phone: string | null;
  status: number;
  statusText: string;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface PageResult<T> {
  list: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export interface AdminAccountQuery {
  keyword?: string;
  role?: string;
  status?: number;
  page?: number;
  pageSize?: number;
}

export interface CreateAdminUserPayload {
  username: string;
  password: string;
  role: string;
  realName?: string;
  supplierId?: number;
  phone?: string;
}

export interface UpdateAdminUserPayload {
  realName?: string;
  role?: string;
  supplierId?: number;
  phone?: string;
  status?: number;
}

export interface AdminRoleRow {
  role: string;
  label: string;
  menus: string[];
  /** -1 = 全量通配 */
  menuCount: number;
  isSystem: boolean;
}

export interface OperationLogRow {
  id: number;
  operatorId: number | null;
  operatorName: string | null;
  operatorRole: string | null;
  operatorRoleLabel: string | null;
  module: string;
  action: string;
  targetId: string | null;
  requestIp: string | null;
  requestData: unknown;
  responseData: unknown;
  failed: boolean;
  createdAt: string | null;
}

export interface OperationLogQuery {
  operatorId?: number;
  module?: string;
  date?: string;
  page?: number;
  pageSize?: number;
}

/** D56 出参：分页 + 操作人下拉（供筛选器直接用） */
export type OperationLogPage = PageResult<OperationLogRow> & {
  operators: Array<{ id: number; name: string; role: string; roleLabel: string }>;
};

/** D51 账号列表 */
export function fetchAdminAccounts(
  params: AdminAccountQuery,
): Promise<PageResult<AdminAccountRow>> {
  return http.get<PageResult<AdminAccountRow>>('/admin/system/accounts', params);
}

/** D52 新增账号 */
export function createAdminAccount(payload: CreateAdminUserPayload): Promise<AdminAccountRow> {
  return http.post<AdminAccountRow>('/admin/system/accounts', payload);
}

/** D53 编辑 / 停用账号 */
export function updateAdminAccount(
  id: number,
  payload: UpdateAdminUserPayload,
): Promise<AdminAccountRow> {
  return http.put<AdminAccountRow>(`/admin/system/accounts/${id}`, payload);
}

/** D54 角色与权限矩阵（只读） */
export function fetchAdminRoles(): Promise<{ list: AdminRoleRow[]; note: string }> {
  return http.get<{ list: AdminRoleRow[]; note: string }>('/admin/system/roles');
}

/** D56 操作日志 */
export function fetchOperationLogs(params: OperationLogQuery): Promise<OperationLogPage> {
  return http.get<OperationLogPage>('/admin/system/logs', params);
}

/* ------------------------------------------------------------------ *
 * D57 / D58 系统配置（M3-10）
 *
 * ⚠️ 本页**不维护第二份配置文案**：标签 / 说明 / 取值范围 / 「是否可改」
 *    全部由 D57 下发（服务端 `config.specs.ts` 是唯一真相）。
 *    前端只负责按 `valueType` 选控件、按 `editable` 置灰。
 * ------------------------------------------------------------------ */

/** 值的语义类型 —— 决定用哪种控件 */
export type ConfigValueType = 'money' | 'percent' | 'int' | 'text' | 'time' | 'enum' | 'policy';

/** 接线状态：`live` 改了生效 / `unwired` 改了不生效 / `policy` 策略标识 */
export type ConfigWiring = 'live' | 'unwired' | 'policy';

export interface ConfigItemView {
  key: string;
  label: string;
  /** 展示值（`percent` 已是百分数，如 `8` 表示 8%） */
  value: string;
  valueType: ConfigValueType;
  impact: string;
  wiring: ConfigWiring;
  editable: boolean;
  description: string;
  /** 谁在消费这个值 —— 回答「改了谁会变」 */
  consumedBy: string;
  unit?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  options?: Array<{ value: string; label: string }>;
  /** 仅成本项：是否已登记（`false` = 值为 0，只表示「没填」） */
  registered?: boolean;
  /** `wiring='unwired'` 时：为什么改了不生效 */
  unwiredReason?: string;
  /** `db` 库内已登记 / `fallback` 库中无此行、当前走代码兜底值 */
  valueSource: 'db' | 'fallback';
  untouched: boolean;
  updatedAt: string | null;
}

export interface ConfigGroupView {
  group: string;
  label: string;
  description: string;
  items: ConfigItemView[];
}

/** 履约成本登记状态（与 D47 数据看板共用同一判据） */
export interface SettlementCostMeta {
  allRegistered: boolean;
  registered: Record<string, boolean>;
  missingKeys: string[];
  missingLabels: string[];
  total: number;
  /** 未登记时的统一提示（已登记为 `null`） */
  warning: string | null;
}

export interface ConfigListView {
  groups: ConfigGroupView[];
  meta: {
    settlementCost: SettlementCostMeta;
    cacheTtlSeconds: number;
    wiringSummary: { total: number; live: number; unwired: number; policy: number };
    note: string;
  };
}

/** D58 单项变更（前 → 后） */
export interface ConfigChange {
  key: string;
  label: string;
  before: string;
  after: string;
}

export interface ConfigUpdateResult {
  changed: ConfigChange[];
  unchanged: Array<{ key: string; label: string; value: string }>;
  effectiveAt: string | null;
  note: string;
}

/** D57 系统配置清单 */
export function fetchSystemConfigs(): Promise<ConfigListView> {
  return http.get<ConfigListView>('/admin/system/configs');
}

/**
 * D58 批量更新配置（整批原子）
 *
 * ⚠️ 服务端要求 `value` 为字符串；`percent` 类型传**百分数**（`8` = 8%）。
 */
export function updateSystemConfigs(
  items: Array<{ key: string; value: string }>,
): Promise<ConfigUpdateResult> {
  return http.put<ConfigUpdateResult>('/admin/system/configs', { items });
}

/* ------------------------------------------------------------------ *
 * D59 / D60 通知模板（M3-12）
 *
 * ⚠️ 同样**不维护第二份场景文案**：场景名 / 渠道 / 触发时机 / 变量白名单 /
 *    接线状态 / 启用还缺什么，全部由 D59 下发（服务端 `message-template.specs.ts`
 *    是唯一真相）。前端只按 `fieldWiring` 决定「能不能改」，按 `blockers` 提示缺项。
 * ------------------------------------------------------------------ */

/** 字段级接线状态：`live` 改了生效 / `record_only` 仅供人工使用（非程序行为） */
export type MessageFieldWiring = 'live' | 'record_only';

/** 场景级接线状态：`live` 有代码投递点 / `pending` 一期无投递点 */
export type MessageSceneWiring = 'live' | 'pending';

export interface MessageTemplateChannelView {
  key: string;
  label: string;
  requirementField: string;
  requirementFieldLabel: string;
  /** 该渠道的必要条件是否已配置（未满足则不允许启用） */
  requirementMet: boolean;
}

export interface MessageTemplateItemView {
  id: number | null;
  persisted: boolean;
  scene: string;
  label: string;
  audience: string;
  channels: MessageTemplateChannelView[];
  trigger: string;
  mandatory: boolean;
  variables: string[];
  enabled: boolean;
  wechatTemplateId: string | null;
  groupContent: string | null;
  fieldWiring: {
    enabled: MessageFieldWiring;
    wechatTemplateId: MessageFieldWiring;
    groupContent: MessageFieldWiring;
  };
  wiring: MessageSceneWiring;
  pendingReason?: string;
  consumedBy: string;
  note?: string;
  canEnable: boolean;
  blockers: string[];
  updatedBy: number | null;
  updatedAt: string | null;
}

export interface MessageTemplateListView {
  list: MessageTemplateItemView[];
  summary: { total: number; enabled: number; live: number; pending: number };
  note: string;
}

export interface MessageTemplateUpdateResult {
  item: MessageTemplateItemView;
  changed: Array<{ field: string; label: string; before: string; after: string }>;
  note: string;
}

/** D59 通知模板清单 */
export function fetchMessageTemplates(): Promise<MessageTemplateListView> {
  return http.get<MessageTemplateListView>('/admin/system/templates');
}

/**
 * D60 编辑单条通知模板
 *
 * ⚠️ 只传**要改的字段**：缺省 = 不改，显式传 `null` = 清空（两者语义不同）。
 * ⚠️ `scene` / 渠道等只读字段**不能**放进请求体 —— 服务端开了
 *    `forbidNonWhitelisted`，传了会直接 `10001`。
 */
export function updateMessageTemplate(
  id: number,
  patch: { enabled?: number; wechatTemplateId?: string | null; groupContent?: string | null },
): Promise<MessageTemplateUpdateResult> {
  return http.put<MessageTemplateUpdateResult>(`/admin/system/templates/${id}`, patch);
}

// ---------------------------------------------------------------------------
// F5 消息触达（D67 到达率 + D68 编排）
// ---------------------------------------------------------------------------

/**
 * 到达率：单场景汇总行
 *
 * ⚠️ `reachRate` 为 `null` 表示「区间内**没有任何尝试投递**」，与「0%」（发了全失败）
 *    **语义不同** —— 页面上必须分开渲染，否则一期会把「没发过」显示成「全失败」。
 */
export interface MessageReachSceneRow {
  scene: string;
  label: string;
  /** `live` = 有代码投递点；`pending` = 一期无投递点；`unknown` = 已下线场景的历史记录 */
  wiring: string;
  /** 场景当前是否启用 —— **它解释「为什么这条 attempted 是 0」** */
  enabled: boolean;
  attempted: number;
  success: number;
  failed: number;
  reachRate: number | null;
}

export interface MessageReachView {
  range: { from: string; to: string; days: number };
  /** 按场景汇总（**含 0 投递的场景**，顺序与「模板配置」页一致） */
  scenes: MessageReachSceneRow[];
  /** 按北京日汇总（只含有记录的日子） */
  daily: Array<{
    date: string;
    attempted: number;
    success: number;
    failed: number;
    reachRate: number | null;
  }>;
  summary: {
    attempted: number;
    success: number;
    failed: number;
    reachRate: number | null;
    scenesWithTraffic: number;
  };
  note: string;
}

/** D67 到达率（按场景 / 按北京日 · F5） */
export function fetchMessageReach(params?: {
  from?: string;
  to?: string;
}): Promise<MessageReachView> {
  return http.get<MessageReachView>('/admin/messages/reach', params);
}

/** D68 编排出参（F5） */
export interface OrchestrateResult {
  scene: string;
  label: string;
  audience: string;
  audienceLabel: string;
  mealDate: string;
  /** 命中的受众总数（**`dryRun` 也为真值** —— 一期最有用的就是它） */
  audienceSize: number;
  attempted: number;
  delivered: number;
  ok: number;
  failed: number;
  /** 被跳过的条数**按原因分组**（未启用 / 缺模板 ID / 找不到 openid…） */
  skipped: Array<{ reason: string; count: number }>;
  reachRate: number | null;
  truncated: boolean;
  limit: number;
  dryRun: boolean;
  note: string;
}

/**
 * D68 编排一次批量触达（F5）
 *
 * ⚠️ `dryRun` **缺省 true**（服务端安全默认）：只解析受众、不投递。
 *    要真发必须显式传 `false` —— 本函数**不代填默认值**，把「必须显式声明」
 *    这一层留在调用点（页面在二次确认之后才传 `false`）。
 */
export function orchestrateMessage(payload: {
  scene: string;
  audience: string;
  mealDate?: string;
  dryRun?: boolean;
  limit?: number;
}): Promise<OrchestrateResult> {
  return http.post<OrchestrateResult>('/admin/messages/orchestrate', payload);
}

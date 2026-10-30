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
  /** B3 · 知识助手自报操作人（X-KB-Operator） */
  kbOperator?: string | null;
  /** B3 · 自然语言指令（X-KB-NL） */
  kbNlIntent?: string | null;
  /** B3 · 操作块 JSON（X-KB-OpBlock） */
  kbOpBlock?: string | null;
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

// ---------------------------------------------------------------------------
// 阶段 3 · 高危审批申请单（M37 新增）
// ---------------------------------------------------------------------------

/**
 * ⚠️ `recalled` 是后端终态之一（`ab_operation_request.status`，见迁移 1700000000010），
 *    2026-10-30 补「撤回」入口时才发现前端枚举**漏了这一态** ——
 *    漏的后果不是报错，而是撤回成功后列表/详情把状态渲染成裸英文 `recalled`。
 *    改状态机务必后端 enum 与此处**同时**改（两端各一份，无自动同步）。
 */
export type OperationRequestStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'recalled';

export interface OperationRequestRow {
  id: number;
  opCode: string;
  opLabel: string;
  risk: string;
  params: Record<string, unknown>;
  status: OperationRequestStatus;
  /** 知识助手自报操作人（X-KB-Operator） */
  submitterKb: string | null;
  /** 后台手动建单 / 代为提交人 admin_user_id */
  submitterAdminId: number | null;
  /** 自然语言原文（X-KB-NL） */
  submitterNl: string | null;
  /** 操作块 JSON（X-KB-OpBlock 原文） */
  submitterOpBlock: unknown;
  approverId: number | null;
  approvedAt: string | null;
  rejectReason: string | null;
  /** 执行回执（含 request_id 关联） */
  snapshot: unknown;
  executedAt: string | null;
  /** ⭐ 撤回三件套（2026-10-30 补「撤回」入口时同步补上：状态有终态 `recalled`，
   *    但字段此前没登记 ⇒ 撤了谁看都只知道「已撤回」，查不到谁撤的、为什么） */
  recalledAt: string | null;
  recalledBy: number | null;
  recallReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OperationRequestQuery {
  status?: OperationRequestStatus;
  opCode?: string;
}

/** 申请单列表（operator 仅看自己提交） */
export function fetchOperationRequests(
  params?: OperationRequestQuery,
): Promise<OperationRequestRow[]> {
  return http.get<OperationRequestRow[]>('/admin/operation-requests', params);
}

/** 提交高危操作申请（operator 可提交，admin 可代建） */
export function createOperationRequest(payload: {
  opCode: string;
  params: Record<string, unknown>;
  submitterKb?: string;
  submitterNl?: string;
  submitterOpBlock?: unknown;
}): Promise<OperationRequestRow> {
  return http.post<OperationRequestRow>('/admin/operation-requests', payload);
}

/** 申请单详情 */
export function fetchOperationRequestDetail(id: number): Promise<OperationRequestRow> {
  return http.get<OperationRequestRow>(`/admin/operation-requests/${id}`);
}

/** 审批通过（两步：仅置 approved，不执行） */
export function approveOperationRequest(id: number): Promise<OperationRequestRow> {
  return http.post<OperationRequestRow>(`/admin/operation-requests/${id}/approve`);
}

/** 驳回申请 */
export function rejectOperationRequest(id: number, reason: string): Promise<OperationRequestRow> {
  return http.post<OperationRequestRow>(`/admin/operation-requests/${id}/reject`, { reason });
}

/** 执行已审批的申请（调原目标接口，复用 @OperationLog 审计） */
export function executeOperationRequest(id: number): Promise<OperationRequestRow> {
  return http.post<OperationRequestRow>(`/admin/operation-requests/${id}/execute`);
}

/**
 * 撤回未审批的申请（仅 `pending` 可撤；`operator` 仅能撤自己提交的）
 *
 * ⚠️ 这是**提交人自己的**动作，不是审批动作 —— 端上不要把按钮塞进
 *    「仅 super_admin / admin 可见」的审批区里，否则 operator 永远看不到它
 *    （与顶栏「修改口令」同类：入口必须跟着**谁有权用**走，不是跟着页面分区走）。
 * @param reason 撤回理由（**选填**，服务端 RecallOperationRequestDto 不校验必填）
 */
export function recallOperationRequest(id: number, reason?: string): Promise<OperationRequestRow> {
  return http.post<OperationRequestRow>(`/admin/operation-requests/${id}/recall`, { reason });
}

// ============================================================================
// W1 一键停售（《接口规范》§7.4 · P3-6）
//
// ⚠️ **两条不得**（《PHASE3 落码规格》§13.1）：
//    1. **不得读 `ab_config` / 不得调 `BizConfigService`**：那套读路径有 60 秒进程内 TTL
//       且 `ensureLoaded()` 的 catch 静默 fail-open，停售要的是「立刻」，用它读会出现
//       「后台显示已停售、用户端仍可下单最多 60 秒」且零报错。停售状态只走本组端点。
//    2. 不得依赖 `OrderAvailabilityService.salesPaused()` —— 那是后端 private 方法且
//       当前是 `return false` 占位，它不是后台 UI 的读路径。
//
// ⚠️ **与 N2 楼宇停用正交，不要复用闸门**（§13.3）：停售是「临时、全局、不动历史订单」，
//    楼宇停用是「长期下线一栋楼、要过未完结订单闸门」。本组接口不带任何停用闸门码
//    （60006 / 60007 / 60012 / 60013 —— 那四个是**停用**码，不是停售码）。
// ============================================================================

/** 停售区间（`ab_sales_pause` 一行）—— 字段形态与实体 `SalesPause` 一致 */
export interface SalesPauseRow {
  id: number;
  /** 停售起始出餐日（含）· `YYYY-MM-DD` */
  mealDateFrom: string;
  /** 停售截止出餐日（含）· `YYYY-MM-DD`；允许等于 `mealDateFrom`（「停售明日」即此形态）*/
  mealDateTo: string;
  /** 停售原因 —— 会原样随用户端文案下发，故后端强制必填且 ≥ 4 字 */
  reason: string;
  createdBy: number | null;
  /** 恢复时刻；`null` = 该区间**仍生效** */
  resumedAt: string | null;
  resumedBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SalesPausePayload {
  mealDateFrom: string;
  mealDateTo: string;
  reason: string;
}

/**
 * 停售列表（**含历史**）· GET —— operator 可读
 *
 * ❗ 出参是**裸数组**（`SalesPauseRow[]`），与 `fetchOperationRequests` 同形，
 *    后端刻意**不套** `{ list }`。`http.get<T>` 只解包业务信封、不解包自定义信封，
 *    所以套错了**编译期看不出来** —— 改这个签名前先回源 `SalesPauseController.list()`。
 *
 * ⚠️ 已恢复的行（`resumedAt` 非空）**不会被过滤掉**，只是按 `id DESC` 排在后面 ——
 *    历史区间是审计事实，服务端刻意不吞。要区分「生效中 / 已恢复」必须端上自己按
 *    `resumedAt === null` 过滤，**不能假设第一条就是生效的那条**。
 */
export function fetchSalesPauses(): Promise<SalesPauseRow[]> {
  return http.get<SalesPauseRow[]>('/admin/sales-pause');
}

/** 创建停售区间 · POST —— 仅 super_admin / admin（真正的闸门是后端 `@Roles`）*/
export function createSalesPause(payload: SalesPausePayload): Promise<SalesPauseRow> {
  return http.post<SalesPauseRow>('/admin/sales-pause', payload);
}

/** 恢复（写 resumedAt / resumedBy）· POST —— 仅 super_admin / admin */
export function resumeSalesPause(id: number): Promise<SalesPauseRow> {
  return http.post<SalesPauseRow>(`/admin/sales-pause/${id}/resume`);
}

// ============================================================================
// 知识助手禁止清单（P1-c · 补 admin:coverage 缺口 #41）
// ============================================================================

/**
 * 清单行
 *
 * ⚠️ 与「运营申请」页的 `opLabel` 不同源：本表**不存**中文名（`ab_op_blocklist` 只有
 *    opCode），中文一律在端上按 `ops` 清单现查（`labelOf`），
 *    查不到就原样显示 opCode —— 宁可显示一串代码，也不编一个中文名。
 */
export interface OpBlockRow {
  id: number;
  opCode: string;
  note: string | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

/** 可禁止的 op 清单（真源 `wecom-kb/op-meta.ts`，端上不维护第二份） */
export interface OpCatalogItem {
  opCode: string;
  label: string;
}

export function fetchOpCatalog(): Promise<{ list: OpCatalogItem[] }> {
  return http.get<{ list: OpCatalogItem[] }>('/admin/op-blocklist/ops');
}

export function fetchOpBlocklist(): Promise<{ list: OpBlockRow[] }> {
  return http.get<{ list: OpBlockRow[] }>('/admin/op-blocklist');
}

/** 列入禁止（已存在则幂等返回原行，不报错）· 仅 super_admin / admin */
export function addOpBlock(payload: { opCode: string; note?: string }): Promise<OpBlockRow> {
  return http.post<OpBlockRow>('/admin/op-blocklist', payload);
}

/**
 * 解除禁止 · 仅 super_admin / admin
 *
 * ⚠️ 服务端是**物理删除**，解完连「这条禁令存在过」都查不出来 ——
 *    故后端另写一条 `@OperationLog` 审计（对称留痕），端上不额外做二次确认外的提示。
 */
export function removeOpBlock(opCode: string): Promise<{ ok: boolean }> {
  return http.delete<{ ok: boolean }>(`/admin/op-blocklist/${encodeURIComponent(opCode)}`);
}

// ============================================================================
// 企微令牌绑定（`/wecom/kb/bindings` · 仅 super_admin / admin）
//
// ⚠️ **令牌的两个「空」含义不同，端上必须能区分**：
//      · 字段**不传**（undefined）→ 不改（服务端 `?? existing`）
//      · 字段传 **空串 ''**  → **清空**该令牌（空串不是 nullish，会真写进去）
//    ⇒ 一个空输入框若被无脑当 `''` 提交，就会在用户「我什么都没填」的直觉下
//      把线上令牌悄悄清空。故本页约定：**留空 = 不修改**，清空走显式动作。
// ⚠️ `GET` 出参是**裸数组**（不是 `{ list }`）—— 与 `/admin/op-blocklist` 不同，
//    别照抄（已按控制器 `list(): Promise<Array<...>>` 回源确认）。
// ============================================================================

export interface WecomBindingRow {
  userId: string;
  operatorName: string;
  /** ⚠️ 只回标记、不回令牌明文（避免令牌在管理面泄露） */
  hasOperatorToken: boolean;
  hasApproverToken: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertWecomBindingPayload {
  userId: string;
  operatorName: string;
  /** 省略 = 不修改；空串 = 清空 */
  operatorToken?: string;
  /** 同上 */
  approverToken?: string;
}

export function fetchWecomBindings(): Promise<WecomBindingRow[]> {
  return http.get<WecomBindingRow[]>('/wecom/kb/bindings');
}

export function upsertWecomBinding(payload: UpsertWecomBindingPayload): Promise<WecomBindingRow> {
  return http.post<WecomBindingRow>('/wecom/kb/bindings', payload);
}

/** 解绑（物理删除整行，含两个令牌）· userId 是企微 userid，可能含特殊字符 ⇒ 必编码 */
export function removeWecomBinding(userId: string): Promise<{ ok: boolean }> {
  return http.delete<{ ok: boolean }>(`/wecom/kb/bindings/${encodeURIComponent(userId)}`);
}

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

/**
 * 身份等级 —— 决定机器人用**哪个执行账号**去打后台端点
 *
 * · `owner` → 执行账号 `kb-owner`（后台 role=`admin`）⇒ 131 个端点全可达
 * · `staff` → 执行账号 `kb-bot`（后台 role=`operator`）⇒ 只能到 69 个
 *
 * ⚠️ 这是**第二道闸门**之外的**第一道**：后端 `@Roles` 是代码里写死的，
 *    改不动；能改的是「以谁的身份去撞那道闸」。故放权 / 收回 = 改这一列，
 *    **不需要**重发令牌、不需要改后端。
 * ⚠️ 默认值是 `staff`（迁移 `1700000000022` 的刻意选择）：新绑一个人
 *    先只给最小权限，要提权得显式点「设为负责人」。
 */
export type WecomTier = 'owner' | 'staff';

export interface WecomBindingRow {
  userId: string;
  operatorName: string;
  /** 服务端恒回落 `staff`（`b.tier || 'staff'`），故不会是 undefined */
  tier: WecomTier;
  /**
   * 单独放权的端点编码清单（只对 `tier=staff` 生效）。
   *
   * 语义是**加号**：空数组 = 没放权，他只有 operator 角色本来的能力；
   * 有编码 = 这些端点**额外**允许他做。所以收回放权（置空）是安全动作，
   * 不会把他原本能做的事一起收走。
   *
   * 服务端恒回 `b.grantedOps || []`，故这里不会是 undefined。
   */
  grantedOps: string[];
  /** ⚠️ 只回标记、不回令牌明文（避免令牌在管理面泄露） */
  hasOperatorToken: boolean;
  hasApproverToken: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertWecomBindingPayload {
  userId: string;
  operatorName: string;
  /**
   * 身份等级（省略 = 新建走 `staff` / 编辑时不改）
   *
   * ⚠️ 服务端 `upsert` 对 `tier` 的处理与令牌**不同**：令牌留空=不改，
   *    而 `tier` 省略时新建落 `staff`、编辑保持原值。要改等级请走
   *    `setWecomBindingTier`（独立端点，语义单一，不会顺手动到令牌）。
   */
  tier?: WecomTier;
  /**
   * 单独放权清单（省略 = 不改动已有清单）
   *
   * ⚠️ 与 `tier` 同款「省略即不改」语义，但**新建时省略会落空数组**（= 没放权）。
   *    要精确控制请走 `setWecomBindingGrant`（独立端点，不会顺手动到令牌与等级）。
   */
  grantedOps?: string[];
  /** 省略 = 不修改；空串 = 清空 */
  operatorToken?: string;
  /** 同上 */
  approverToken?: string;
}

/**
 * ⚠️⭐ 这一组走**正常前缀**（`/api/v1/admin/wecom-kb/...`），不要再写 `{ baseURL: '' }`。
 *
 *   曾经为了「和回调凑一组」写成 `/wecom/kb/bindings` + 空 baseURL。那是错的，
 *   而且错得隐蔽 —— 免前缀会连带丢掉三样东西：
 *     ① **body 解析**：`main.ts` 关了默认 bodyParser，自定义中间件只挂 `/api/v1/*`
 *        ⇒ `req.body` 恒 undefined ⇒ 所有写入回 10001「参数校验失败」；
 *     ② **后台主体判定**：`JwtAuthGuard` 只认 `/admin`、`/supplier` 开头
 *        ⇒ 后台 token 被判成「用户端」，一律回 10002；
 *     ③ 统一限流规则。
 *   2026-11-01 线上实测：整页不可用（列表 500、写入 10001、点按钮提示请用后台接口）。
 *
 *   ⇒ 只有**企微回调**需要免前缀（那是企微侧配的地址，不能带 `/api/v1`）；
 *     管理端点已整体归位到 `/admin/wecom-kb`。
 */
export function fetchWecomBindings(): Promise<WecomBindingRow[]> {
  return http.get<WecomBindingRow[]>('/admin/wecom-kb/bindings');
}

export function upsertWecomBinding(payload: UpsertWecomBindingPayload): Promise<WecomBindingRow> {
  return http.post<WecomBindingRow>('/admin/wecom-kb/bindings', payload);
}

/** 解绑（物理删除整行，含两个令牌）· userId 是企微 userid，可能含特殊字符 ⇒ 必编码 */
export function removeWecomBinding(userId: string): Promise<{ ok: boolean }> {
  return http.delete<{ ok: boolean }>(`/admin/wecom-kb/bindings/${encodeURIComponent(userId)}`);
}

/**
 * 只改身份等级（放权 / 收回）· `PATCH /admin/wecom-kb/bindings/:userId/tier`
 *
 * ⚠️ 为什么单开一个端点而不复用 `upsert`：`upsert` 是「整行覆盖式保存」，
 *    而放权/收回只是**一个布尔量级的意图**。若走 `upsert`，调用点必须把
 *    `operatorName` 一起传（否则被清空）、且一旦漏传 `tier` 还会静默保持原值
 *    —— 页面上的「设为负责人」按钮就变成「顺手重存整行」，是没必要的事故面。
 *
 * ⚠️ 绑定不存在时**不报错**，回 `{ found: false }`：服务端刻意不静默成功
 *    （`setTier` 返回 null 就回 found=false），页面据此提示「这条绑定已被删除，请刷新」。
 *    判 `code` 看不出这个区别，必须判 `found`。
 */
export function setWecomBindingTier(
  userId: string,
  tier: WecomTier,
): Promise<{ found: boolean; tier?: string }> {
  return http.patch<{ found: boolean; tier?: string }>(
    `/admin/wecom-kb/bindings/${encodeURIComponent(userId)}/tier`,
    { tier },
  );
}

/**
 * 机器人试跑 · `POST /admin/wecom-kb/simulate`
 *
 * 企微回调地址要域名、备案没过 ⇒ 机器人在真实环境里一次都没被跑通过。
 * 这个端点让后台**当场说一句话**看它怎么回，走的还是同一套判据与执行通道，
 * 不是另写的模拟器 —— 试跑的结果对线上有效。
 *
 * ⚠️ **这里会真的写库**：它不是沙箱。写操作仍要「回 1」才执行，但点了就是真执行。
 * 审计里记的是**当前登录管理员的姓名**（`X-KB-Operator`），不是「机器人」。
 *
 * ⭐⭐ **身份可选**（`tier` + `grantedOps`）：不指定时按负责人跑。
 *    指定 `staff` 才是「同事看到的结论」—— 只以负责人跑，证明不了放权到底有没有生效。
 *    注意 `execAs` 可能与所选 `tier` **不同**：同事一旦有特批项，执行身份会升到
 *    `owner`（否则后台 `@Roles` 直接 403），那时限制由清单逐条判，`execAs` 会回 `owner`。
 */
export interface SimulateWecomResult {
  reply: string;
  execAs: 'owner' | 'staff' | 'none';
  /** 回显所选档位（与实际执行身份可能不同，见上） */
  tier?: WecomTier;
  /** 生效的放权条数 */
  granted?: number;
  /** 目录里已失效、被剔除的编码（不提示会让人以为「放权了却没生效」） */
  unknown?: string[];
}

export interface SimulateWecomOptions {
  /** true = 清掉「这个管理员 + 这个身份档」的试跑会话 */
  reset?: boolean;
  tier?: WecomTier;
  grantedOps?: string[];
}

export function simulateWecomChat(
  text: string,
  opts: SimulateWecomOptions = {},
): Promise<SimulateWecomResult> {
  return http.post<SimulateWecomResult>('/admin/wecom-kb/simulate', { text, ...opts });
}

/**
 * 单独放权的可选项（后台功能目录，只读）· `GET /admin/wecom-kb/ops`
 *
 * 数据由服务端从源码自动生成的目录给出，前端**不要硬编码**这 131 项：
 * 端点改名/新增后硬编码会静默过期，表现成「勾了不生效」或「新功能勾不到」。
 *
 * `staffBase=true` 表示「不放权时同事本来就能做」—— 页面必须把这类与
 * 「本次额外给的」分开显示，否则会把「本来就有的 40 项」误读成「我放权了 40 项」。
 */
export interface WecomOpItem {
  code: string;
  label: string;
  method: string;
  path: string;
  module: string;
  risk: 'low' | 'mid' | 'high';
  staffBase: boolean;
}

export function fetchWecomOps(): Promise<{ total: number; items: WecomOpItem[] }> {
  return http.get<{ total: number; items: WecomOpItem[] }>('/admin/wecom-kb/ops');
}

/**
 * 只改「单独放权的功能清单」· `PATCH /admin/wecom-kb/bindings/:userId/grant`
 *
 * ⚠️ 与 `tier` 的区别，页面上必须说清（否则用户会以为放权 = 提权）：
 *    · `tier=owner` → 把这个人**整体**升成负责人能力（131 项全开），是重手法；
 *    · `grantedOps` → 只把**点到的那几件**给他（外加他原本 operator 就会的那些），是轻手法。
 *    日常该用后者：给财务同事开「退款审批」一项，不必连「改团长佣金」一起给。
 *
 * ⚠️ 传 `[]` = 收回全部放权（安全：他退回 operator 本来的能力，不会残废）。
 * ⚠️ 目录里已失效的编码由服务端剔除并回传 `unknown`，页面要如实提示，
 *    不能静默当成功 —— 否则管理员会以为「放权成功了但其实一条没生效」。
 */
export function setWecomBindingGrant(
  userId: string,
  ops: string[],
): Promise<{ found: boolean; count?: number; unknown?: string[] }> {
  return http.patch<{ found: boolean; count?: number; unknown?: string[] }>(
    `/admin/wecom-kb/bindings/${encodeURIComponent(userId)}/grant`,
    { ops },
  );
}

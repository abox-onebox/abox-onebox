import { http } from './request';
import type { PageResult } from './system';

/**
 * api/leader —— 后台团长管理（《接口规范 v1.0》§6.3 D19–D22 · 原型 P32）
 *
 * ⚠️ 与 `api/leader.ts`（小程序端）**不是一回事**：本文件是**后台**视角，
 *    走 `/admin/leaders/*`，主体是 `ab_admin_user`；小程序团长端走 `/leader/*`，
 *    主体是叠加了团长身份的 `ab_user`。两者在 `JwtAuthGuard` 就分流了。
 *
 * ⚠️ 金额一律**整数分**（`Fen` 结尾）；费率由服务端下发 `commissionRateText`，
 *    端上不做「等级 → 费率」的二次推导（口径唯一在服务端，避免两处漂移）。
 */

/** D19 名录视图 */
export type LeaderViewValue = 'roster' | 'applications';

/** D22 例外处理动作 */
export type LeaderAuditActionValue = 'suspend' | 'restore' | 'sign_agreement' | 'note';

export interface LeaderRow {
  id: number;
  userId: number;
  realName: string;
  phoneMasked: string | null;
  nickname: string | null;
  /** ⚠️ 不是微信号：模型未采集微信号，这里是微信身份标识后 6 位 */
  openidTail: string | null;
  floor: string | null;

  buildingId: number;
  buildingName: string | null;
  groupId: number | null;
  groupName: string | null;

  level: string;
  levelLabel: string;
  commissionRate: string;
  commissionRateText: string;

  status: number;
  statusLabel: string;

  monthOrders: number;
  invitedFormalCount: number;
  totalOrders: number;

  balanceFen: number;
  frozenFen: number;
  totalCommissionFen: number;
  pendingAmountFen: number;

  agreedAt: string | null;
  agreeVersion: string | null;
  payoutBound: boolean;
  lastOrderAt: string | null;
  createdAt: string;

  /** 按钮可用性口径唯一在服务端 */
  actions: { canManage: boolean; canAudit: boolean };
}

/** 申请流水行（`view=applications`） */
export interface LeaderApplicationRow {
  id: number;
  userId: number;
  realName: string;
  nickname: string | null;
  openidTail: string | null;
  phoneMasked: string | null;
  floor: string | null;
  buildingId: number;
  buildingName: string | null;
  inviter: { leaderId: number; realName: string; level: string; levelLabel: string } | null;
  inviterText: string;
  channel: string;
  level: string;
  levelLabel: string;
  status: number;
  statusLabel: string;
  agreeVersion: string | null;
  appliedAt: string | null;
}

export interface LeadersSummary {
  totalCount: number;
  activeCount: number;
  suspendedCount: number;
  traineeCount: number;
  formalCount: number;
  goldCount: number;
  chiefCount: number;
  monthNewCount: number;
  monthCommissionFen: number;
  /** C3 口径：申请即生效，恒为 0（口径表达，非未实现） */
  pendingAuditCount: number;
  days?: number;
  byBuilding?: Array<{ key: string; count: number }>;
}

export interface LeaderLevelOption {
  key: string;
  label: string;
  rate: number;
  rateText: string;
  monthlyOrders: number;
  referrals: number;
}

export interface LeadersQuery {
  view?: LeaderViewValue;
  groupId?: number;
  buildingId?: number;
  level?: string;
  status?: number;
  keyword?: string;
  days?: number;
  page?: number;
  pageSize?: number;
}

export interface LeadersPage<T> extends PageResult<T> {
  view: LeaderViewValue;
  summary: LeadersSummary;
  levelOptions: LeaderLevelOption[];
  statusOptions: Array<{ key: number; label: string }>;
  actions: { canManage: boolean; canAudit: boolean };
  /** 出参偏差说明（如「本期没有微信号」）—— 页面要如实展示，不要静默丢弃 */
  notes?: Record<string, string>;
}

export interface LeaderFilterOptions {
  groups: Array<{ id: number; name: string; status: number }>;
  buildings: Array<{ id: number; name: string; groupId: number | null; status: number }>;
  levels: LeaderLevelOption[];
  statuses: Array<{ key: number; label: string }>;
}

export interface LeaderDetail {
  profile: {
    id: number;
    userId: number;
    realName: string;
    phoneMasked: string | null;
    floor: string | null;
    buildingId: number;
    buildingName: string | null;
    groupId: number | null;
    groupName: string | null;
    level: string;
    levelLabel: string;
    commissionRate: string;
    commissionRateText: string;
    status: number;
    statusLabel: string;
    monthOrders: number;
    invitedFormalCount: number;
    totalOrders: number;
    balanceFen: number;
    frozenFen: number;
    totalCommissionFen: number;
    withdrawnAmountFen: number;
    pendingAmountFen: number;
    agreedAt: string | null;
    agreeVersion: string | null;
    payoutType: string | null;
    payoutAccount: string | null;
    payoutName: string | null;
    payoutBound: boolean;
    lastOrderAt: string | null;
    createdAt: string | null;
  };
  account: { nickname: string | null; openidTail: string | null; userStatus: number | null };
  inviter: { leaderId: number; realName: string; level: string; levelLabel: string } | null;
  inviteChannel: string | null;
  bindAt: string | null;
  invitees: Array<{
    inviteId: number;
    inviteeUserId: number;
    nickname: string | null;
    leaderId: number | null;
    realName: string | null;
    level: string | null;
    levelLabel: string;
    isFormal: boolean;
    formalAt: string | null;
    bindAt: string | null;
  }>;
  commissions: Array<{
    id: number;
    orderNo: string;
    mealDate: string;
    leaderLevel: string;
    levelLabel: string;
    rate: string;
    rateText: string;
    baseAmountFen: number;
    quantity: number;
    amountFen: number;
    type: string;
    status: string;
    payoutChannel: string;
    taxWithheldFen: number;
    createdAt: string | null;
  }>;
  operationLogs: Array<{
    id: number;
    module: string;
    action: string;
    targetId: string | null;
    operator: string | null;
    at: string | null;
    requestData: unknown;
  }>;
}

export interface AppointLeaderPayload {
  userId: number;
  buildingId: number;
  realName: string;
  phone: string;
  floor?: string;
  level?: string;
  /** 转交确认：目标楼现任在职团长 id（不传且楼已被占 → 20012） */
  transferFromLeaderId?: number;
  reason: string;
}

export interface AppointLeaderResult {
  leader: LeaderRow;
  transferredFrom: { leaderId: number; realName: string; phoneMasked: string | null } | null;
  reason: string;
  note: string;
}

export interface UpdateLeaderPayload {
  level?: string;
  buildingId?: number;
  floor?: string;
  reason: string;
}

export interface UpdateLeaderResult {
  leader: LeaderRow;
  before: { level: string; commissionRate: string; buildingId: number; floor: string | null };
  changes: string[];
  reason: string;
}

export interface AuditLeaderPayload {
  action: LeaderAuditActionValue;
  agreementVersion?: string;
  reason: string;
}

export interface AuditLeaderResult {
  leader: LeaderRow;
  action: LeaderAuditActionValue;
  actionLabel: string;
  before: { status: number; agreeVersion: string | null };
  after: { status: number | null; agreeVersion: string | null };
  reason: string;
  note: string | null;
}

// ------------------------------------------------------------------ D19

/** D19 团长名录（view=roster） */
export function fetchAdminLeaders(params: LeadersQuery): Promise<LeadersPage<LeaderRow>> {
  return http.get<LeadersPage<LeaderRow>>('/admin/leaders', { ...params, view: 'roster' });
}

/** D19 申请流水（view=applications；C3 申请即生效，本页仅为观察流水） */
export function fetchLeaderApplications(
  params: LeadersQuery,
): Promise<LeadersPage<LeaderApplicationRow>> {
  return http.get<LeadersPage<LeaderApplicationRow>>('/admin/leaders', {
    ...params,
    view: 'applications',
  });
}

/** D19 附属 · 筛选器下拉 */
export function fetchLeaderFilterOptions(): Promise<LeaderFilterOptions> {
  return http.get<LeaderFilterOptions>('/admin/leaders/filter-options');
}

/** D19 附属 · 团长详情（档案 + 裂变链 + 佣金 + 操作日志） */
export function fetchLeaderDetail(id: number): Promise<LeaderDetail> {
  return http.get<LeaderDetail>(`/admin/leaders/${id}`);
}

// ------------------------------------------------------------------ D20 / D21 / D22

/** D20 任命 / 转交团长 */
export function appointLeader(payload: AppointLeaderPayload): Promise<AppointLeaderResult> {
  return http.post<AppointLeaderResult>('/admin/leaders', payload);
}

/** D21 变更团长（等级 / 所属办公楼 / 楼层；不含 status） */
export function updateLeader(
  id: number,
  payload: UpdateLeaderPayload,
): Promise<UpdateLeaderResult> {
  return http.put<UpdateLeaderResult>(`/admin/leaders/${id}`, payload);
}

/** D22 资质补录 / 例外处理 */
export function auditLeader(id: number, payload: AuditLeaderPayload): Promise<AuditLeaderResult> {
  return http.post<AuditLeaderResult>(`/admin/leaders/${id}/audit`, payload);
}

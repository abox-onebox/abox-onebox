/**
 * api/leader —— 团长端「身份 / 资料 / 工作台 / 分享」（M2 · L1–L3、L14–L18）
 * 契约：《接口规范 v1.0》§4.5「团长管理」/ §4.1「工作台」/ §4.6「分享」
 *
 * 兄弟模块：
 *   · `api/leader-order.ts`   —— L4–L9（订单聚合 / 代退 / 取餐确认一键分发）
 *   · `api/leader-finance.ts` —— L10–L13（佣金 / 余额 / 提现）
 *
 * ⚠️ 除 `applyLeader` 外，全部端点都需**在职团长**身份：
 *    服务端 `LeaderGuard` 会在 JWT 之后再查一次 `ab_team_leader`，
 *    故端上不能用本地缓存的 `isLeader` 当授权凭据（token 7 天内团长可能被停职）。
 */
import type { LeaderLevel } from '@abox/shared-types';

import { http } from './request';

// ---------------------------------------------------------------------------
// L1 · 今日战报工作台
// ---------------------------------------------------------------------------

/** 工作台 · 今日战报 */
export interface WorkbenchToday {
  /** `YYYY-MM-DD` */
  mealDate: string;
  /** 有效订单数（已排除 cancelled） */
  orderCount: number;
  /** 份数（已排除 cancelled） */
  quantity: number;
  /** 退款中的单数（refund_applying + refunding + refunded） */
  refundCount: number;
  /** 成交额（整数分） */
  amountFen: number;
  /** 已确认分发份数（= 计佣基数） */
  completedQuantity: number;
  /** 佣金（整数分）= completedQuantity × 配置单价 × rate */
  commissionFen: number;
  level: LeaderLevel;
  /** 见习 / 正式 / 金牌 / 首席 */
  levelLabel: string;
  /** 小数，如 0.08 */
  rate: number;
}

/** 工作台 · 明日进度 */
export interface WorkbenchTomorrow {
  /** `YYYY-MM-DD` */
  mealDate: string;
  /** 份数 */
  orderedCount: number;
  /** 单数 */
  orderedOrders: number;
  /** 截单时刻，`+08:00` 带偏移 ISO（如 `2026-09-16T00:00:00+08:00`）；无截单配置 → null */
  cutoffAt: string | null;
  canOrder: boolean;
  /** 单价（整数分） */
  unitPriceFen: number;
}

/** 工作台 · 取餐点与配送 */
export interface WorkbenchPickup {
  /** `${办公楼名} ${楼层}` 拼接串；都可空 → null */
  point: string | null;
  buildingName: string | null;
  floor: string | null;
  status: 'pending' | 'called' | 'en_route' | 'arrived';
  /** 待叫车 / 已叫车 / 配送中 / 已送达 */
  statusText: string;
  /** 恒为字面量 `'11:30'` */
  expectAt: string;
  /** `+08:00` 带偏移 ISO */
  expectAtIso: string | null;
  /** ⚠️ 注意：本字段是 **UTC ISO**（`....Z`），与上面的 `expectAtIso` 格式不同 */
  actualAt: string | null;
  driverName: string | null;
  driverPhone: string | null;
  plateNo: string | null;
}

export interface LeaderWorkbenchData {
  today: WorkbenchToday;
  tomorrow: WorkbenchTomorrow;
  pickup: WorkbenchPickup;
}

/** L1 · 团长工作台（今日战报 + 明日进度 + 取餐点） */
export function fetchWorkbench(): Promise<LeaderWorkbenchData> {
  return http.get<LeaderWorkbenchData>('/leader/workbench');
}

// ---------------------------------------------------------------------------
// L2 / L3 · 分享中心与小程序码
// ---------------------------------------------------------------------------

export interface LeaderShareMaterialData {
  /** `LDR` + 4 位零填充 id，如 `LDR0001` */
  inviteCode: string;
  /** 小程序码 scene 参数，如 `l=12` */
  scene: string;
  /** 分享落地页路径（恒为 `pages/index/index`） */
  path: string;
  /** 分享参数串，如 `leaderCode=LDR0001` */
  shareQuery: string;
  title: string;
  desc: string;
  /** 海报素材（M5 素材库，当前恒 null） */
  posterUrl: string | null;
  /** 当前恒 null —— **不得伪造图片 URL** */
  qrcodeUrl: string | null;
  /** 当前恒 true（微信能力未接入时如实标记） */
  mock: boolean;
  tips: string;
}

/** L2 · 分享物料（邀请码 / 落地路径 / 文案） */
export function fetchShareMaterial(): Promise<LeaderShareMaterialData> {
  return http.get<LeaderShareMaterialData>('/leader/share');
}

export interface LeaderQrcodeData {
  inviteCode: string;
  scene: string;
  path: string;
  /** clamp 后的实际宽度（`[280, 1280]`） */
  width: number;
  /** 当前恒 null */
  qrcodeUrl: string | null;
  /** 当前恒 true */
  mock: boolean;
  tips: string;
}

/** L3 · 生成小程序码（服务端 clamp 宽度；未接微信能力时返回 mock 标记） */
export function generateLeaderQrcode(width?: number): Promise<LeaderQrcodeData> {
  return http.post<LeaderQrcodeData>(
    `/leader/share/qrcode${width ? `?width=${encodeURIComponent(String(width))}` : ''}`,
  );
}

// ---------------------------------------------------------------------------
// L14–L18 · 团长档案 / 规则 / 协议 / 申请
// ---------------------------------------------------------------------------

/** 收款方式（与 L12 提现前置条件对应） */
export type PayoutType = 'bank' | 'alipay';

/** 团长档案（L14 / L17 出参） */
export interface LeaderProfile {
  id: number;
  userId: number;
  realName: string;
  phone: string;
  /** 楼层，如 `12F`（2026-09-15 裁定恢复该维度） */
  floor: string | null;
  buildingId: number;
  buildingName: string | null;
  level: LeaderLevel;
  /** 等级中文（见习 / 正式 / 金牌 / 首席），来源 = 服务端 LEADER_LEVEL_META */
  levelLabel: string;
  /** DECIMAL(5,4) 字符串，如 "0.1200" —— ⚠️ 字符串，不是 number */
  commissionRate: string;
  /** 1 在职 / 2 停职（tinyint，裁定① 以实体为准） */
  status: number;
  monthOrders: number;
  invitedFormalCount: number;
  /**
   * ⚠️ **元 · 字符串**（如 `"0.00"`），且是 `ab_team_leader` 上的**统计快照**，
   *    不保证与真实可用余额同步 —— 展示「可用余额」请走 L11 `balanceFen`。
   */
  balance: string;
  totalOrders: number;
  /** ⚠️ **元 · 字符串** */
  totalCommission: string;
  agreedAt: string | null;
  agreeVersion: string | null;
  /** 收款方式（L12 提现前置条件；三者齐全才算已绑定） */
  payoutType: PayoutType | null;
  /** ⚠️ 已脱敏（如 `6217****0123`） */
  payoutAccount: string | null;
  payoutName: string | null;
  /** 三者齐全 → true（端上据此决定是否引导去绑卡） */
  payoutBound: boolean;
}

/** 单级佣金规则（L16） */
export interface LevelRuleItem {
  key: LeaderLevel;
  name: string;
  rate: number;
  condition: string;
}

export interface LevelRulesResult {
  levels: LevelRuleItem[];
  mine: {
    level: LeaderLevel;
    monthOrders: number;
    invitedFormalCount: number;
    nextLevel: LeaderLevel | null;
    progress: number;
  };
  expireRule: string;
}

/** L17 申请入参 */
export interface ApplyLeaderPayload {
  buildingId: number;
  phone: string;
  /** 「公司 · 姓名」，与表 `real_name` 对应（必填） */
  realName: string;
  floor?: string;
  /** 已勾选同意的协议版本号；缺失 = 未勾选 → 服务端 10001 */
  agreementVersion: string;
}

export interface ApplyLeaderResult {
  isLeader: boolean;
  leader: LeaderProfile;
}

/** L17 · 申请成为团长（C3：勾选协议后**提交即生效**，无人工审核） */
export function applyLeader(payload: ApplyLeaderPayload): Promise<ApplyLeaderResult> {
  return http.post<ApplyLeaderResult>('/leader/apply', { ...payload } as Record<string, unknown>);
}

/** L14 · 团长资料 */
export function fetchLeaderProfile(): Promise<LeaderProfile> {
  return http.get<LeaderProfile>('/leader/profile');
}

/**
 * L15 · 修改团长资料（手机号 / 楼层 / 收款方式）
 *
 * ⚠️ DTO 刻意**不含 `buildingId`**，且全局 `forbidNonWhitelisted: true` ——
 *    传了会被直接拒绝（`10001`）；办公楼变更需走后台审核。
 * ⚠️ `payoutAccount` 服务端**落库前脱敏**，出参回显的是脱敏值。
 */
export function updateLeaderProfile(payload: {
  phone?: string;
  floor?: string;
  payoutType?: PayoutType;
  payoutAccount?: string;
  payoutName?: string;
}): Promise<LeaderProfile> {
  return http.put<LeaderProfile>('/leader/profile', { ...payload } as Record<string, unknown>);
}

/** L16 · 4 级佣金规则 + C2 双条件升级门槛 + 我的晋级进度 */
export function fetchLevelRules(): Promise<LevelRulesResult> {
  return http.get<LevelRulesResult>('/leader/level-rules');
}

/** L18 · 勾选同意《团长合作协议》（补签 / 版本升级重签） */
export function signAgreement(
  agreementVersion: string,
): Promise<{ agreedAt: string | null; agreeVersion: string | null }> {
  return http.post<{ agreedAt: string | null; agreeVersion: string | null }>('/leader/agreement', {
    agreementVersion,
  });
}

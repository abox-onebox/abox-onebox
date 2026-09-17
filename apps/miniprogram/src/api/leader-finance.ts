/**
 * api/leader-finance —— 团长端「财务域」（M2 · L10–L13）
 * 契约：《接口规范 v1.0》§4.4「佣金与提现」
 *
 * ⚠️ 金额口径（§1.6）：本文件**出参一律为整数分**（字段名以 `Fen` 结尾）；
 *    唯一例外是 **L12 入参 `amount` 用「元」**（与实体 `DECIMAL(12,2)` 一致）
 *    —— 端上提交前用 `yuanToFen` 之外的**元**数值直接传，切勿把分当元传。
 *
 * ⚠️ C11 出款口径：一期 `payoutChannel = 'FLEX_MANUAL'`，佣金走**灵活用工平台**
 *    代发并代扣个税；**不接**微信「商家转账到零钱」。
 */
import type { LeaderLevel } from '@abox/shared-types';

import { http, query } from './request';

/**
 * 注意：L11 出参的 `payoutChannel` 实际值为**大写** `'FLEX_MANUAL'`（配置默认值），
 * 与 `@abox/shared-types` 里 `PayoutChannel` 枚举的**小写** `'flex_manual'` 不同源。
 * 端上只做展示，不参与判断，故此处用 `string` 以免类型谎报。
 */

// ---------------------------------------------------------------------------
// L10 · 佣金明细
// ---------------------------------------------------------------------------

export interface LeaderCommissionItem {
  id: number;
  orderNo: string;
  /** `YYYY-MM-DD` */
  mealDate: string;
  /** 结算时的等级快照 */
  leaderLevel: LeaderLevel;
  /** 小数快照，如 0.09 */
  rate: number;
  /** 计佣基数（整数分） */
  baseAmountFen: number;
  /** 计入份数（实发） */
  quantity: number;
  /** 佣金（整数分）；`type='reversal'` 时为**负数** */
  amountFen: number;
  type: 'normal' | 'reversal';
  /** 结算态 */
  status: 'pending' | 'settled' | 'cancelled';
  /** 代扣个税（整数分，当前恒 0，由灵活用工平台回传） */
  taxWithheldFen: number;
  /** UTC ISO；未结算 → null */
  settledAt: string | null;
  /** UTC ISO */
  createdAt: string;
}

export interface LeaderCommissionSummary {
  range: 'day' | 'month';
  /** `YYYY-MM-DD`（含首） */
  startDate: string;
  /** `YYYY-MM-DD`（含尾） */
  endDate: string;
  /** 正常入账合计（整数分，正） */
  earnedFen: number;
  /** 冲销合计（整数分，⚠️ **负数**） */
  reversedFen: number;
  /** 净额 = earned + reversed（整数分） */
  netFen: number;
  /** 计入份数（仅 normal） */
  quantity: number;
  level: LeaderLevel;
  levelLabel: string;
  rate: number;
}

export interface LeaderCommissionsData {
  /** 全量统计，**不受分页影响** */
  summary: LeaderCommissionSummary;
  list: LeaderCommissionItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export interface LeaderCommissionQuery {
  range?: 'day' | 'month';
  /** `YYYY-MM-DD`；缺省 = 今日。`month` 时取该月整月 */
  date?: string;
  page?: number;
  pageSize?: number;
}

/** L10 · 佣金明细（含按日/按月汇总） */
export function fetchCommissions(
  params: LeaderCommissionQuery = {},
): Promise<LeaderCommissionsData> {
  return http.get<LeaderCommissionsData>(
    `/leader/commissions${query({
      range: params.range,
      date: params.date,
      page: params.page,
      pageSize: params.pageSize,
    })}`,
  );
}

// ---------------------------------------------------------------------------
// L11 · 团长余额
// ---------------------------------------------------------------------------

export interface LeaderBalanceData {
  /** 可用余额（整数分）—— 真源 `ab_balance`（`ab_team_leader.balance` 已于 M4-4 停用为历史字段） */
  balanceFen: number;
  /** 冻结金额（整数分）：提现申请即冻结，终态才释放 */
  frozenFen: number;
  /** 待结算佣金（整数分） */
  pendingCommissionFen: number;
  /** 累计收入（整数分） */
  totalInFen: number;
  /** 累计支出（整数分） */
  totalOutFen: number;
  /** 累计已提现（整数分，团长维度快照） */
  withdrawnFen: number;
  /** 在途提现单数（仅统计 `pending`） */
  inFlightCount: number;
  /** 最低提现额（整数分，默认 1000 = ¥10.00） */
  minWithdrawFen: number;
  /** `balanceFen >= minWithdrawFen` */
  canWithdraw: boolean;
  level: LeaderLevel;
  levelLabel: string;
  rate: number;
  /** 出款通道（一期 `'FLEX_MANUAL'`） */
  payoutChannel: string;
}

/** L11 · 余额（提现 / 消费前的可用额） */
export function fetchLeaderBalance(): Promise<LeaderBalanceData> {
  return http.get<LeaderBalanceData>('/leader/balance');
}

// ---------------------------------------------------------------------------
// L12 · 提现申请
// ---------------------------------------------------------------------------

export interface WithdrawApplyPayload {
  /** ⚠️ 单位**元**（不是分）；最低见 `ab_config.commission.min_withdraw`（默认 ¥10.00） */
  amount: number;
  /** 缺省取团长已绑定的收款方式 */
  receiveType?: 'bank' | 'alipay';
  receiveAccount?: string;
  receiveName?: string;
}

export interface LeaderWithdrawApplyData {
  id: number;
  /** `WD` + yyyyMMdd + 8 位 */
  withdrawNo: string;
  /** 申请金额（整数分） */
  amountFen: number;
  /** 恒为 `pending` */
  status: 'pending';
  /** 恒为「待审批」 */
  statusText: string;
  /** `'FLEX_MANUAL'` */
  payoutChannel: string;
  receiveType: 'bank' | 'alipay';
  /** **已脱敏**，如 `6222****0123` */
  receiveAccount: string;
  tips: string;
}

/**
 * L12 · 提现申请
 *
 * ⚠️ **必须传 `Idempotency-Key`**（服务端强制）：提现属资金操作，缺失 → `10001`。
 *    重复提交 → `10006` + 首次结果（端上按成功处理，且**不会重复冻结**）。
 *
 * 关键错误码：`40003` 低于最低额（`data.minFen` 附最低额）/ `40007` 未绑定收款方式
 *            / `50004` 可提现余额不足。
 */
export function applyWithdraw(
  payload: WithdrawApplyPayload,
  idempotentKey: string,
): Promise<LeaderWithdrawApplyData> {
  return http.post<LeaderWithdrawApplyData>(
    '/leader/withdraw',
    { ...payload } as Record<string, unknown>,
    { idempotentKey },
  );
}

// ---------------------------------------------------------------------------
// L13 · 提现记录
// ---------------------------------------------------------------------------

export interface LeaderWithdrawalItem {
  id: number;
  withdrawNo: string;
  /** 申请金额（整数分） */
  amountFen: number;
  /** 代扣个税（整数分，当前恒 0） */
  taxWithheldFen: number;
  /** 实际到账（整数分） */
  actualFen: number;
  status: 'pending' | 'approved' | 'paying' | 'success' | 'rejected' | 'failed';
  /** 待审批 / 已批准 / 打款中 / 已到账 / 已驳回 / 打款失败 */
  statusText: string;
  payoutChannel: string;
  /** 灵活用工平台批次号（人工期为空） */
  payoutBatchNo: string | null;
  receiveType: 'bank' | 'alipay';
  /** 已脱敏 */
  receiveAccount: string;
  failReason: string | null;
  auditRemark: string | null;
  /** UTC ISO */
  paidAt: string | null;
  /** UTC ISO */
  createdAt: string;
}

export interface LeaderWithdrawalsData {
  list: LeaderWithdrawalItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export interface LeaderWithdrawalsQuery {
  /** 按状态过滤（6 态之一） */
  status?: string;
  page?: number;
  pageSize?: number;
}

/** L13 · 提现记录（分页） */
export function fetchWithdrawals(
  params: LeaderWithdrawalsQuery = {},
): Promise<LeaderWithdrawalsData> {
  return http.get<LeaderWithdrawalsData>(
    `/leader/withdrawals${query({
      status: params.status,
      page: params.page,
      pageSize: params.pageSize,
    })}`,
  );
}

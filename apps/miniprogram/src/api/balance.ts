/**
 * api/balance —— 余额流水（M2 · L19，对应 P17）
 *
 * ⚠️ 与 `api/leader-finance.ts` 的分工：
 *   · L11 `/leader/balance`      → **余额快照**（可用 / 冻结，用于展示与提现判断）
 *   · L19 `/leader/balance-logs` → **发生额流水**（每笔收入 / 支出 + 操作后余额）
 *   两者同源于 `ab_balance` / `ab_balance_log`，可相互验算。
 *
 * ⚠️ 方向口径与佣金明细**不同**：
 *   本接口 `amountFen` **恒为正数**，收支方向看 `direction`（1 收入 / -1 支出）；
 *   而 L10 佣金明细的冲销笔（`type='reversal'`）金额本身为**负数**。
 */
import { http, query } from './request';

export interface BalanceLogItem {
  id: number;
  /** `commission` / `order_pay` / `withdraw` / `withdraw_refund` / `refund` */
  type: string;
  /** 中文文案（服务端给，端上不自造） */
  typeText: string;
  /** 1 收入 / -1 支出 */
  direction: number;
  /** ⚠️ 恒为正数；方向看 `direction` */
  amountFen: number;
  /** 该笔操作后的余额（整数分） */
  balanceAfterFen: number;
  /** 关联单号（订单号 / 提现单号） */
  relatedId: string | null;
  remark: string | null;
  /** 代扣个税（整数分，C11 灵活用工回传） */
  taxWithheldFen: number;
  payoutChannel: string | null;
  /** UTC ISO */
  createdAt: string;
}

export interface BalanceLogSummary {
  /** 累计收入（整数分） */
  inFen: number;
  /** 累计支出（整数分） */
  outFen: number;
  /** 净额 = in − out（整数分） */
  netFen: number;
  /** 流水总条数（全量，不受分页影响） */
  count: number;
}

export interface BalanceLogsData {
  /** 全量统计，不受分页影响 */
  summary: BalanceLogSummary;
  list: BalanceLogItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export interface BalanceLogQuery {
  type?: string;
  page?: number;
  pageSize?: number;
}

/** L19 · 余额流水（分页 + 全量收支汇总） */
export function fetchBalanceLogs(params: BalanceLogQuery = {}): Promise<BalanceLogsData> {
  return http.get<BalanceLogsData>(
    `/leader/balance-logs${query({
      type: params.type,
      page: params.page,
      pageSize: params.pageSize,
    })}`,
  );
}

/** 流水类型筛选项（与后端 `BALANCE_LOG_TYPE_LABEL` 的键一致） */
export const BALANCE_LOG_TABS: Array<{ label: string; value: string }> = [
  { label: '全部', value: '' },
  { label: '佣金入账', value: 'commission' },
  { label: '提现', value: 'withdraw' },
  { label: '退单回退', value: 'refund' },
];

/**
 * api/user —— 个人中心（《接口规范》§3.5）
 *
 * M4-3 实装 **订阅授权清单**（U18）；M5-10 补 **U13 余额 / U14 余额明细**。
 * U12 用户信息**不在本文件** —— 由 A2 `GET /auth/me`（`api/auth.ts` 的 `fetchMe`）
 * 承担同一份数据，端上不要为它再包一层。
 * U15 订阅上报一期未实装；U16 协议正文待补。
 */
import { http, query } from './request';

// ---------------------------------------------------------------------------
// U13 余额 / U14 余额明细（M5-10）
// ---------------------------------------------------------------------------

/**
 * U13 · 账户余额快照（**整数分**）
 *
 * ⚠️ **普通用户也有这个账户**，不需要团长身份 —— 订单退款会退回余额、
 *    下单时可直接抵扣。与 `api/leader-finance.ts` 的 L11（团长余额）
 *    读的是**同一张 `ab_balance`**（同一个人同一时刻只有一个余额），
 *    差别只在 L11 走 `LeaderGuard`、本接口不走。
 *
 * ⚠️ 余额**不支持充值**（避免形成预付资金负债），来源是订单退款
 *    **与团长佣金入账**两路 —— 用户与团长共用同一 `ab_balance`，
 *    故**不要**把这里当成「只有退款」的独立钱包（原型 v4.10.0 那句如此写，已过时）。
 */
export interface UserBalanceData {
  /** 可用余额（整数分） */
  balanceFen: number;
  /** 冻结额（整数分） */
  frozenFen: number;
  /** 累计收入（整数分） */
  totalInFen: number;
  /** 累计支出（整数分） */
  totalOutFen: number;
  /**
   * `false` = 尚无余额账户（余额全 0 是**正常状态**，不是异常）
   *
   * ⚠️ 字段名与 A2 `/auth/me` 的 `leader.hasBalanceAccount` **逐字一致**，
   *    端上判断「0 元」还是「没开过户」用同一套逻辑。
   */
  hasBalanceAccount: boolean;
  /** 口径说明（**服务端下发**，端上不复制文案） */
  note: string;
}

/**
 * U14 · 余额流水（分页 + **全量**收支汇总）
 *
 * ⚠️ `amountFen` **恒为正数**，方向看 `direction`（1 收入 / -1 支出）——
 *    与 L10 佣金明细的冲销笔（`amountFen` 本身为负）**口径不同**，
 *    不得混用同一套正负号逻辑。
 */
export interface MyBalanceLogItem {
  id: number;
  type: string;
  /** 中文文案（服务端给，端上不自造） */
  typeText: string;
  /** 1 收入 / -1 支出 */
  direction: number;
  amountFen: number;
  /** 该笔操作后的余额（整数分） */
  balanceAfterFen: number;
  relatedId: string | null;
  remark: string | null;
  taxWithheldFen: number;
  payoutChannel: string | null;
  /** UTC ISO */
  createdAt: string;
}

export interface MyBalanceLogsData {
  /** 全量统计，不受分页影响 */
  summary: { inFen: number; outFen: number; netFen: number; count: number };
  list: MyBalanceLogItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

/** U13 · 账户余额 */
export function fetchMyBalance(): Promise<UserBalanceData> {
  return http.get<UserBalanceData>('/me/balance');
}

/** U14 · 余额明细（不传 `type` = 全部流水） */
export function fetchMyBalanceLogs(
  params: { type?: string; page?: number; pageSize?: number } = {},
): Promise<MyBalanceLogsData> {
  return http.get<MyBalanceLogsData>(
    `/me/balance/logs${query({
      type: params.type,
      page: params.page,
      pageSize: params.pageSize,
    })}`,
  );
}

// ---------------------------------------------------------------------------
// U18 订阅授权（M4-3）
// ---------------------------------------------------------------------------

/** 一条「可请求订阅授权」的场景（服务端已按四条件筛过，端上不要再判） */
export interface SubscribeTemplateItem {
  /** 场景键（仅用于日志/埋点，**不要**拿它做业务分支） */
  scene: string;
  /** 场景中文名（端上不维护第二份文案） */
  label: string;
  /** 微信订阅消息模板 ID —— 直接作为 `requestSubscribeMessage` 的 `tmplIds` */
  templateId: string;
}

export interface SubscribeTemplateList {
  list: SubscribeTemplateItem[];
  /**
   * 口径说明（服务端下发，端上不复制）
   *
   * ⚠️ 列表为空**通常是正常的**：一期尚无微信模板 ID，没有可授权的对象。
   *    端上此时应**什么都不做**，而不是拿假 ID 去调微信。
   */
  note: string;
}

/**
 * 读取「当前可以让用户授权」的订阅消息场景
 *
 * ⚠️ 模板 ID 由运营在后台配置，**端上不得硬编码** —— 硬编码等于第二份真相：
 *    运营换了模板，端上还在请求旧 ID，两边都不报错。
 */
export function fetchSubscribeTemplates(): Promise<SubscribeTemplateList> {
  return http.get<SubscribeTemplateList>('/me/subscribe/templates');
}

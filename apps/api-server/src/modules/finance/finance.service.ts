import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { yuanToFen } from '@abox/shared-utils';
import type { SettlementCostItems, SettlementCostRegistration } from '@abox/shared-utils';

import { toBjIso } from '../../common/utils/time';
import { Balance, Commission, SupplierShare } from '../../database/entities/finance.entity';
import { Refund } from '../../database/entities/order.entity';
import { COMMISSION_VOID_STATUSES, PURCHASE_VOID_STATUSES } from '../stats/stats.constants';
import type { StatsRange } from '../stats/stats.constants';
import { StatsService } from '../stats/stats.service';
import type { StatsRangeView } from '../stats/stats.service';
import { FinanceOverviewQueryDto } from './dto/finance.dto';

/**
 * 服务端金额归一：DB 的 DECIMAL 在 MySQL 返字符串、SQLite 返浮点 ——
 * 一律经 `yuanToFen` 归到整数分（跨驱动逐分一致），非有限值按 0 处理。
 */
function fen(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? yuanToFen(n) : 0;
}

/** 应付单状态（剔失效行后只剩这两态 + 已失效被过滤） */
const SHARE_PENDING = 'pending';
const SHARE_PAID = 'success';

/** 退款终态：钱已退回用户 */
const REFUND_DONE = 'refunded';

/** 某日出餐日对应的应付单状态（**给运营看的四态**，不是库里的三态） */
export type PayableStatus = 'none' | 'pending' | 'paid' | 'partial';

/** 逐日出餐日摘要（原型 P34「每日结算跑批」表 · 与 `stats.trend` 同长度） */
export interface FinanceDailyRow {
  date: string;
  orderCount: number;
  quantity: number;
  gmvFen: number;
  commissionFen: number;
  purchaseFen: number;
  payableStatus: PayableStatus;
  payableStatusText: string;
}

/** D33 资金总览出参 */
export interface FinanceOverviewView {
  range: StatsRangeView;
  /** 收入侧（**与 D47 看板同一份口径**） */
  income: {
    orderCount: number;
    quantity: number;
    gmvFen: number;
    avgOrderAmountFen: number;
    totalOrderCount: number;
    refundCount: number;
    refundRate: number;
  };
  /** 支出侧 */
  expense: {
    purchaseFen: number;
    commissionFen: number;
    fulfillmentFen: number;
    /** 区间内**已退回用户**的金额（微信原路退 + 余额回退合计） */
    refundedAmountFen: number;
  };
  /** 应付未付（采购款 · 按出餐日区间） */
  payable: {
    totalFen: number;
    unpaidFen: number;
    paidFen: number;
    pendingCount: number;
    paidCount: number;
    /** 本期是否已出过应付单（false = 毛利未扣采购成本） */
    generated: boolean;
  };
  /** 平台负债（**时点量，不随 range 变化**） */
  liability: {
    /** 快照时刻（北京时间 ISO） */
    asOf: string;
    balanceFen: number;
    frozenFen: number;
    pendingCommissionFen: number;
    pendingCommissionCount: number;
  };
  /** 结果值（同 D47：GMV − 采购 − 履约 − 佣金） */
  profit: { grossProfitFen: number; grossProfitRate: number | null };
  costRegistration: SettlementCostRegistration;
  costItems: SettlementCostItems;
  warnings: string[];
  daily: FinanceDailyRow[];
  note: string;
}

/** 应付单状态中文（服务端唯一来源，端上不自造） */
export const PAYABLE_STATUS_LABEL: Record<PayableStatus, string> = {
  none: '未出单',
  pending: '待付款',
  paid: '已付款',
  partial: '部分已付',
};

/**
 * D33 的口径说明（必须下发 —— 页面上要能读到「这些数是怎么来的」）
 */
export const FINANCE_OVERVIEW_NOTE =
  '收入 / 成本 / 毛利三项与「数据看板 D47」是**同一份口径**（同一个服务函数），' +
  'GMV 不含未支付 / 已取消 / 已退款（**在途退款计入**）。' +
  '经营毛利是**结果值**：履约成本三项未登记、或本期采购应付单尚未生成时会系统性偏高（见 warnings）。' +
  '余额与待入账佣金是**时点量**（不随区间变化），代表平台此刻的即时负债。';

/**
 * 财务服务 · **D33 资金总览**（《接口规范》§6.5 · 原型 P34 · 模块 M35-01）
 *
 * ⭐ **本服务的核心纪律：不自己算一套口径。**
 *    GMV / 采购款 / 佣金 / 履约成本 / 毛利 / 逐日趋势**全部取自 `StatsService.dashboard()`**
 *    —— 它与 D47 看板是同一个函数，因此「财务页的 GMV」与「看板的 GMV」不可能漂移。
 *    如果这里再写一遍 `SUM(...)`，两页数字迟早对不上，而运营会拿着截图来问「哪个对」。
 *
 * 本服务**只补资金视角独有**的四样（看板不关心的）：
 *    ① 应付单**付了没有**（pending / paid 拆分）—— 看板只管「欠了多少」
 *    ② 已退回用户的金额 —— 看板给的是退款**率**（订单维度），不是钱
 *    ③ 用户余额与冻结（**平台负债** · 时点量）
 *    ④ 待入账佣金（`ab_commission.status='pending'` · 时点量）
 *
 * ⚠️ 逐日 `commissionFen` / `purchaseFen` 是本服务按出餐日聚合的（看板的 trend 只有
 *    GMV/单量/份数）。为防「分项之和 ≠ 总额」，出参的区间总额一律取看板值，
 *    并由 e2e 断言 `Σ daily.commissionFen === income/expense 的区间值` ——
 *    两处口径一旦漂移立刻变红，而不是等人去发现。
 */
@Injectable()
export class FinanceService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly stats: StatsService,
  ) {}

  async overview(q: FinanceOverviewQueryDto): Promise<FinanceOverviewView> {
    // ① 区间口径唯一来源：看板服务（函数级同源，非「抄一份常量」）
    const dash = await this.stats.dashboard({
      range: q.range as StatsRange | undefined,
      date: q.date,
    });
    const range = dash.range;

    // ② 资金视角补充（四组并行）
    const [shares, refundedAmountFen, liability, pendingComm] = await Promise.all([
      this.loadShares(range),
      this.loadRefundedAmountFen(range),
      this.loadLiability(),
      this.loadPendingCommission(),
    ]);

    // ③ 逐日聚合（GMV/单量/份数取看板 trend，成本侧自己按出餐日分桶）
    const byDate = new Map<string, { commission: number; purchase: number; status: Set<string> }>();
    const bucket = (date: string) => {
      const cur = byDate.get(date) ?? { commission: 0, purchase: 0, status: new Set<string>() };
      byDate.set(date, cur);
      return cur;
    };
    for (const s of shares.rows) {
      const b = bucket(String(s.mealDate));
      b.purchase += fen(s.amount);
      b.status.add(String(s.status));
    }
    for (const c of await this.loadCommissionRows(range)) {
      bucket(String(c.mealDate)).commission += fen(c.amount);
    }

    const daily: FinanceDailyRow[] = dash.trend.map((t) => {
      const b = byDate.get(t.date);
      const status = payableStatusOf(b?.status);
      return {
        date: t.date,
        orderCount: t.orderCount,
        quantity: t.quantity,
        gmvFen: t.gmvFen,
        commissionFen: b?.commission ?? 0,
        purchaseFen: b?.purchase ?? 0,
        payableStatus: status,
        payableStatusText: PAYABLE_STATUS_LABEL[status],
      };
    });

    return {
      range,
      income: {
        orderCount: dash.metrics.orderCount,
        quantity: dash.metrics.quantity,
        gmvFen: dash.metrics.gmvFen,
        avgOrderAmountFen: dash.metrics.avgOrderAmountFen,
        totalOrderCount: dash.metrics.totalOrderCount,
        refundCount: dash.metrics.refundCount,
        refundRate: dash.metrics.refundRate,
      },
      expense: {
        purchaseFen: dash.metrics.purchaseFen,
        commissionFen: dash.metrics.commissionFen,
        fulfillmentFen: dash.metrics.fulfillmentFen,
        refundedAmountFen,
      },
      payable: {
        totalFen: shares.totalFen,
        unpaidFen: shares.unpaidFen,
        paidFen: shares.paidFen,
        pendingCount: shares.pendingCount,
        paidCount: shares.paidCount,
        generated: shares.generated,
      },
      liability: {
        asOf: liability.asOf,
        balanceFen: liability.balanceFen,
        frozenFen: liability.frozenFen,
        pendingCommissionFen: pendingComm.amountFen,
        pendingCommissionCount: pendingComm.count,
      },
      profit: {
        grossProfitFen: dash.metrics.grossProfitFen,
        grossProfitRate: dash.metrics.grossProfitRate,
      },
      costRegistration: dash.costRegistration,
      costItems: dash.costItems,
      warnings: dash.warnings,
      daily,
      note: FINANCE_OVERVIEW_NOTE,
    };
  }

  /* ------------------------------------------------------------------ *
   * 内部加载
   * ------------------------------------------------------------------ */

  /**
   * 区间内**采购应付**（只取供应商主体、剔失效行）。
   *
   * ⚠️ 出参同时给「区间总额」与「行」：总额用于 D33 的 payable 汇总（口径 = 看板的
   *    采购款），行用于逐日分桶。二者由同一批行算出，天然一致。
   */
  private async loadShares(range: StatsRangeView): Promise<{
    totalFen: number;
    unpaidFen: number;
    paidFen: number;
    pendingCount: number;
    paidCount: number;
    generated: boolean;
    rows: Array<{ mealDate: unknown; amount: unknown; status: unknown }>;
  }> {
    const rows = await this.dataSource
      .getRepository(SupplierShare)
      .createQueryBuilder('s')
      .select(['s.mealDate', 's.amount', 's.status'])
      .where('s.mealDate BETWEEN :start AND :end', { start: range.startDate, end: range.endDate })
      .andWhere('s.payeeType = :payee', { payee: 'supplier' })
      .getMany();

    const valid = rows.filter((r) => !PURCHASE_VOID_STATUSES.includes(r.status));
    let totalFen = 0;
    let unpaidFen = 0;
    let paidFen = 0;
    let pendingCount = 0;
    let paidCount = 0;
    for (const r of valid) {
      const amt = fen(r.amount);
      totalFen += amt;
      if (r.status === SHARE_PAID) {
        paidFen += amt;
        paidCount += 1;
      } else if (r.status === SHARE_PENDING) {
        unpaidFen += amt;
        pendingCount += 1;
      }
    }

    return {
      totalFen,
      unpaidFen,
      paidFen,
      pendingCount,
      paidCount,
      // ⭐ 用「是否有有效行」而不是「金额是否为 0」判定已出单：
      //    实收量为 0 的日子也会出单（金额 0），按金额判会说「没出单」。
      generated: valid.length > 0,
      rows: valid.map((r) => ({ mealDate: r.mealDate, amount: r.amount, status: r.status })),
    };
  }

  /** 区间内佣金行（剔 `cancelled`）—— 逐日分桶用；区间总额以看板为准 */
  private async loadCommissionRows(range: StatsRangeView): Promise<Commission[]> {
    const rows = await this.dataSource
      .getRepository(Commission)
      .createQueryBuilder('c')
      .select(['c.mealDate', 'c.amount', 'c.status'])
      .where('c.mealDate BETWEEN :start AND :end', { start: range.startDate, end: range.endDate })
      .getMany();
    return rows.filter((r) => !COMMISSION_VOID_STATUSES.includes(r.status));
  }

  /**
   * 区间内**已退回用户**的金额。
   *
   * `ab_refund` 没有 `meal_date`（它只有 `order_id`），故按出餐日筛选必须回到订单表。
   * ⚠️ 用 **SQL 子查询**而不是 `IN (:...ids)`：30 天区间可能上千单，而 SQLite 的
   *    绑定变量上限是 999 —— 拼大 IN 列表会在换 SQLite 驱动时直接报错（MySQL 却没事，
   *    于是本地全绿、换驱动才炸）。
   */
  private async loadRefundedAmountFen(range: StatsRangeView): Promise<number> {
    const rows = await this.dataSource
      .getRepository(Refund)
      .createQueryBuilder('r')
      .select(['r.amount', 'r.status'])
      .where(
        'r.order_id IN (SELECT o.id FROM ab_order o WHERE o.meal_date BETWEEN :start AND :end)',
        { start: range.startDate, end: range.endDate },
      )
      .getMany();
    return rows.filter((r) => r.status === REFUND_DONE).reduce((s, r) => s + fen(r.amount), 0);
  }

  /**
   * 平台负债（**时点量**）：用户可用余额 + 冻结金额。
   *
   * 这两笔钱已经在用户账上、随时可提现或抵扣，因此是平台的**即时负债**，
   * 与「区间」无关 —— 出参带 `asOf` 时刻，页面必须按「截至某时刻」展示，
   * 否则会被误读成「本期新增负债」。
   *
   * ⚠️ **口径唯一真相**（M3-14）：D33 资金总览与 **D38 余额账户管理共用本函数**。
   *    两页各自 `SUM(ab_balance)` 必然漂移（改了一处忘另一处，且没有任何报错），
   *    故本函数为 `public` 供 `BalanceAdminService` 直接调用；e2e 用
   *    「D38 `summary.liability.balanceFen` === D33 `liability.balanceFen`」钉死这条。
   */
  async loadLiability(): Promise<{
    asOf: string;
    balanceFen: number;
    frozenFen: number;
    /** 账户数（`ab_balance` 有行 = 已发生过资金往来）—— 取到的行数即计数，不额外查库 */
    accountCount: number;
  }> {
    const rows = await this.dataSource
      .getRepository(Balance)
      .createQueryBuilder('b')
      .select(['b.balance', 'b.frozen'])
      .getMany();
    let balanceFen = 0;
    let frozenFen = 0;
    for (const r of rows) {
      balanceFen += fen(r.balance);
      frozenFen += fen(r.frozen);
    }
    return { asOf: toBjIso(new Date()) ?? '', balanceFen, frozenFen, accountCount: rows.length };
  }

  /** 待入账佣金（全量 · 时点量）：`ab_commission.status='pending'` */
  private async loadPendingCommission(): Promise<{ amountFen: number; count: number }> {
    const rows = await this.dataSource
      .getRepository(Commission)
      .createQueryBuilder('c')
      .select(['c.amount'])
      .where('c.status = :st', { st: 'pending' })
      .getMany();
    return {
      amountFen: rows.reduce((s, r) => s + fen(r.amount), 0),
      count: rows.length,
    };
  }
}

/** 由「该日出餐日出现的应付单状态集合」推导四态 */
function payableStatusOf(statuses: Set<string> | undefined): PayableStatus {
  if (!statuses || statuses.size === 0) return 'none';
  const hasPending = statuses.has(SHARE_PENDING);
  const hasPaid = statuses.has(SHARE_PAID);
  if (hasPending && hasPaid) return 'partial';
  return hasPaid ? 'paid' : 'pending';
}

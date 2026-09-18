import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Repository } from 'typeorm';

import { BALANCE_LOG_TYPE_LABEL } from '../constants/balance-log';
import { Balance, BalanceLog, Commission } from '../../database/entities/finance.entity';
import { Withdraw } from '../../database/entities/withdraw.entity';
import { normalizePage, paginate } from '../utils/response';
import { toFen } from '../utils/money';

/**
 * 团长「钱」的**唯一真源**读取口（M4-4 · 修复《缺陷与陷阱》#69）
 *
 * ## 为什么需要这个服务（它修的是一个用户直接看得见的错）
 *
 * `ab_team_leader` 上挂着三列看起来像「钱」的字段：`balance`（注释「可用余额」）、
 * `pending_amount`（待入账）、`withdrawn_amount`（已提现）。它们**只在种子里被赋过值，
 * 全仓没有任何写点** —— 而 `ab_team_leader.balance` 恰好被登录 / 资料 / 退出三个
 * 出参当作「可用余额」下发。后果是：
 *
 * · 团长「我的」页显示的余额是**种子里写死的数字**（示例数据里是 ¥575.86），
 *   而「余额明细」页走 L11（`ab_balance`）显示的是**真值** ——
 *   **同一个人在同一时刻看到两个不同的余额**，且两者都不报错；
 * · 他去提现时被 `50004 可提现余额不足` 挡下（因为真值可能是 0），
 *   而页面上明明写着有几百块 —— 这是**必然会产生的客服工单**；
 * · `ABox一盒MVP` 的两个前端文件里早已写明「`ab_team_leader.balance` 仅为快照，
 *   勿用；展示可用余额请走 L11 `balanceFen`」（`api/leader-finance.ts:109`、
 *   `api/leader.ts:168`）——**明知有坑，服务端出参自己还在踩**。
 *
 * ## 口径（三项全部改为**派生**，不再读写那三列）
 *
 * | 出参 | 真源 | 说明 |
 * |------|------|------|
 * | `balanceFen` | `ab_balance.balance` | 可用余额。与 L11 / D38 同一个源 |
 * | `frozenFen` | `ab_balance.frozen` | 冻结额（提现占用 + D39 手工冻结） |
 * | `pendingCommissionFen` | `ab_commission` `status='pending' ∧ type='normal'` 合计 | 待入账佣金（两段式的正常中间态） |
 * | `withdrawnFen` | `ab_withdraw` `status='success'` 的 **`actual_amount`** 合计 | 累计**到手**金额，不是申请额 |
 *
 * ⭐ `withdrawnFen` 取 `actual_amount` 而非 `amount`：平台代扣的个税**没到团长手里**，
 *    把申请额当作「已提现」会让团长看到一笔自己没收到的钱（同 D46b 的口径）。
 * ⭐ `pendingCommissionFen` 必须再排除 `type='reversal'`（负额行）——
 *    否则退款冲销会把「待入账」算小甚至算成负数。
 *
 * ## 为什么不把这些列「写起来」而是「不再读」
 *
 * 让 `creditCommissions` / `closeWithdraw` 等每个写点都顺手更新一遍这三列，就是
 * **第二份真相**：漏掉任一个写点（下单抵扣、退款回退、D39 调账、提现冻结…）都会
 * 让快照与真源悄悄分叉，而分叉的表现是「某个页面显示旧数字」——不报错、无告警。
 * 项目在 M4-0 已有同一模式的先例（`ab_distribution_center.supplier_id` /
 * `ab_supplier.type`）：**列保留（历史字段）· 新逻辑不读不写**。
 *
 * ⚠️ 本服务注册在 `CommonModule`（`@Global()`）并 `exports`，故任何模块可直接注入，
 *    无需各自 `forFeature` 一次仓储（#66 的教训反向使用：**谁声明谁注册**，
 *    全局可见性靠「本模块 exports 本服务」而不是靠 `@Global()` 传递仓储）。
 */
@Injectable()
export class LeaderMoneyService {
  constructor(
    @InjectRepository(Balance) private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(BalanceLog) private readonly balanceLogRepo: Repository<BalanceLog>,
    @InjectRepository(Commission) private readonly commissionRepo: Repository<Commission>,
    @InjectRepository(Withdraw) private readonly withdrawRepo: Repository<Withdraw>,
  ) {}

  /**
   * 单个用户账户的快照（余额 / 冻结）
   *
   * 无账户时返回全 0 且 `hasAccount=false` —— **不报错**：
   * 「这个团长还没发生过任何资金往来」是正常状态，不是异常
   * （与 D38 的「无账户空视图」同一处理）。
   */
  async accountOf(userId: number): Promise<LeaderAccountSnapshot> {
    const account = await this.balanceRepo.findOne({ where: { userId: Number(userId) } });
    return {
      balanceFen: toFen(Number(account?.balance ?? 0)),
      frozenFen: toFen(Number(account?.frozen ?? 0)),
      totalInFen: toFen(Number(account?.totalIn ?? 0)),
      totalOutFen: toFen(Number(account?.totalOut ?? 0)),
      hasAccount: !!account,
    };
  }

  /**
   * 批量取团长四项真值（key = `ab_team_leader.id`）
   *
   * 一次三条聚合查询（余额 / 待入账佣金 / 累计已提现），供列表页避免 N+1。
   * ⚠️ 调用方传进来的 `leaderIds` 规模应与**当前页**同阶（≤100）：
   *    `In` 列表在 SQLite 下有 999 个绑定变量上限（M3-9 踩过），
   *    全量名单请走子查询而不是本方法。
   */
  async snapshotOf(
    leaders: Array<{ id: number; userId: number }>,
  ): Promise<Map<number, LeaderMoneySnapshot>> {
    const out = new Map<number, LeaderMoneySnapshot>();
    if (!leaders.length) return out;

    const leaderIds = leaders.map((l) => Number(l.id));
    const userIds = leaders.map((l) => Number(l.userId));

    const [accounts, pendings, withdrawals] = await Promise.all([
      this.balanceRepo.find({ where: { userId: In(userIds) } }),
      this.commissionRepo.find({
        where: { teamLeaderId: In(leaderIds), status: 'pending', type: 'normal' },
      }),
      this.withdrawRepo.find({
        where: { leaderId: In(leaderIds), status: 'success' },
      }),
    ]);

    const accountByUser = new Map(accounts.map((a) => [Number(a.userId), a]));
    const pendingByLeader = new Map<number, number>();
    for (const c of pendings) {
      const lid = Number(c.teamLeaderId);
      pendingByLeader.set(lid, (pendingByLeader.get(lid) ?? 0) + toFen(Number(c.amount)));
    }
    const withdrawnByLeader = new Map<number, number>();
    for (const w of withdrawals) {
      const lid = Number(w.leaderId);
      withdrawnByLeader.set(lid, (withdrawnByLeader.get(lid) ?? 0) + toFen(Number(w.actualAmount)));
    }

    for (const l of leaders) {
      const account = accountByUser.get(Number(l.userId));
      out.set(Number(l.id), {
        balanceFen: toFen(Number(account?.balance ?? 0)),
        frozenFen: toFen(Number(account?.frozen ?? 0)),
        totalInFen: toFen(Number(account?.totalIn ?? 0)),
        totalOutFen: toFen(Number(account?.totalOut ?? 0)),
        hasAccount: !!account,
        /** ⭐ 累计已提现 —— 到账口径（实付合计），不是申请额 */
        withdrawnFen: withdrawnByLeader.get(Number(l.id)) ?? 0,
        /** ⭐ 待入账佣金（两段式下的正常中间态，非异常） */
        pendingCommissionFen: pendingByLeader.get(Number(l.id)) ?? 0,
      });
    }
    return out;
  }

  /**
   * 余额流水（`ab_balance_log`）分页 + **全量**收支汇总
   *
   * ## ⭐ 为什么按 `userId` 而不是「团长」
   *
   * 本服务原先叫「团长钱的真源」，但 `ab_balance` / `ab_balance_log` 的主键维度
   * 从来就是 **`user_id`**：用户与团长**共用同一小程序身份**，佣金入账与下单抵扣
   * 走的是**同一条余额链路**（团长佣金既能提现、也能直接抵餐费）。
   * 故这里收 `userId`，两个读侧各自映射：
   *   · `CommissionService.listBalanceLogs(leader)` → 传 `leader.userId`（L19 · P17）
   *   · `UserController.balanceLogs(user)`         → 传 `user.sub`（U14 · P9）
   *
   * ## ⭐ 单一实现，不抄第二份
   *
   * 提取到本服务（`common/`）之前，用户侧要展示流水只能：
   *   ① 跨模块 import `CommissionService`（`modules/user` → `modules/finance` 的
   *      业务模块耦合，且要连带把 FinanceModule 拖进 UserModule）；
   *   ② 或在用户侧再写一份「查表 + 映射 + 汇总」。
   * ②的后果不是多 20 行代码，而是**两份汇总口径会分叉**：`summary` 按**全量**统计
   * （不受分页影响，与 L10 同一约定），哪天有人只改了其中一份，用户看到的
   * 「累计收入」与团长看到的就对不上，而两边都不报错。
   *
   * ⚠️ `amount` 恒为正数，方向看 `direction`（1 收入 / -1 支出）——
   *    与 L10 佣金明细的冲销笔（`type='reversal'`，金额**本身为负**）**口径不同**，
   *    端上不得混用同一套正负号逻辑。
   */
  async logsOf(userId: number, q: BalanceLogQuery = {}) {
    const where: FindOptionsWhere<BalanceLog> = { userId: Number(userId) };
    if (q.type) where.type = q.type;

    const { page, pageSize, skip } = normalizePage(q);
    const [rows, total] = await this.balanceLogRepo.findAndCount({
      where,
      order: { id: 'DESC' },
      skip,
      take: pageSize,
    });

    // 汇总按**全量**统计（不受分页影响），与 L10 同一约定
    const all = await this.balanceLogRepo.find({ where });
    let inFen = 0;
    let outFen = 0;
    for (const r of all) {
      const amt = toFen(Number(r.amount));
      if (Number(r.direction) > 0) inFen += amt;
      else outFen += amt;
    }

    return {
      summary: { inFen, outFen, netFen: inFen - outFen, count: Number(total) },
      ...paginate(
        rows.map((r) => ({
          id: Number(r.id),
          type: r.type,
          /** 中文文案由服务端给（与订单状态文案同一纪律：端上不自造） */
          typeText: BALANCE_LOG_TYPE_LABEL[r.type] ?? r.type,
          direction: Number(r.direction),
          /** ⚠️ 恒为正数；方向看 `direction` */
          amountFen: toFen(Number(r.amount)),
          /** 该笔操作后的余额（整数分） */
          balanceAfterFen: toFen(Number(r.balanceAfter)),
          relatedId: r.relatedId ?? null,
          remark: r.remark ?? null,
          taxWithheldFen: toFen(Number(r.taxWithheldAmount || 0)),
          payoutChannel: r.payoutChannel ?? null,
          createdAt: r.createdAt,
        })),
        total,
        page,
        pageSize,
      ),
    };
  }
}

/** 余额流水查询入参（`page` / `pageSize` 由 `normalizePage` 收口） */
export interface BalanceLogQuery {
  type?: string;
  page?: number;
  pageSize?: number;
}

/** 单账户快照（`ab_balance` 派生） */
export interface LeaderAccountSnapshot {
  balanceFen: number;
  frozenFen: number;
  totalInFen: number;
  totalOutFen: number;
  /** `false` = `ab_balance` 无该用户行（从未发生资金往来，余额全 0） */
  hasAccount: boolean;
}

/** 团长四项真值（`ab_balance` + `ab_commission` + `ab_withdraw` 派生） */
export interface LeaderMoneySnapshot extends LeaderAccountSnapshot {
  /** 累计已提现（`status='success'` 的 `actual_amount` 合计 = 到手金额） */
  withdrawnFen: number;
  /** 待入账佣金（`status='pending' ∧ type='normal'`） */
  pendingCommissionFen: number;
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, EntityManager, FindOptionsWhere, Repository } from 'typeorm';

import { LEADER_LEVEL_META, LeaderLevel, WithdrawStatus } from '@abox/shared-types';

import { BizConfigService } from '../../common/services/biz-config.service';
import { monthRangeOf, todayBj } from '../../common/utils/time';
import { round2 } from '../../common/utils/money';
import { normalizePage, paginate } from '../../common/utils/response';
import { Balance, BalanceLog, Commission } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { Order } from '../../database/entities/order.entity';
import { Withdraw } from '../../database/entities/withdraw.entity';
import {
  AdminCommissionsQueryDto,
  AdminSettleCommissionsDto,
  BalanceLogQueryDto,
  LeaderCommissionQueryDto,
} from './dto/finance.dto';

/**
 * 佣金与余额服务（M2 · 2.6）
 *
 * 落点：`modules/finance`（《开发里程碑计划 v1.0》2.6 · 接口 L10 / L11）
 *
 * **余额真源口径（2026-09-15 定）**：
 *   · 可用 / 冻结余额的唯一真源 = `ab_balance`（`user_id` 维度）；
 *     用户与团长共用同一小程序身份，佣金入账与下单抵扣是同一条余额链路 ——
 *     团长佣金既可提现，也可直接抵餐费。
 *   · `ab_team_leader.total_commission / withdrawn_amount / pending_amount`
 *     是**团长维度统计快照**，不参与提现扣减，避免双真源漂移。
 *
 * 计佣基数口径（M2 风险项）：**按实发份数**（`completed` 订单份数，剔除已退款），
 *   非下单份数 —— 见《订单状态机》§4 与 `auto-confirm.task`。
 */
/**
 * 入账段的最小单元：一笔佣金「该进多少钱、进谁的账」。
 *
 * `rate` / `level` 是**佣金行的快照**（可选）—— 补结算必须用它而不是团长当前值，
 * 否则流水文案会与实际金额对不上（见 `creditCommissions` 内注释）。
 */
export interface CommissionCredit {
  orderNo: string;
  /** 金额（元 · 正数） */
  amount: number;
  quantity: number;
  rate?: number;
  level?: string;
  /** 自定义流水文案；缺省由 `creditCommissions` 按等级/费率生成 */
  remark?: string;
  /** 提现/发放渠道（取佣金行自己的 `payout_channel`；缺省 `FLEX_MANUAL` 灵活用工） */
  channel?: string;
}

/** D35 出参：按团长拆分的入账明细（运营最关心「谁到账了多少」） */
export interface CommissionSettleLeaderView {
  leaderId: number;
  leaderName: string;
  level: string;
  settled: number;
  amountFen: number;
  quantity: number;
}

/** D35 出参 */
export interface CommissionSettleView {
  /** 限定的出餐日（null = 全部待入账） */
  date: string | null;
  /** 扫描到的 `pending` 佣金条数 */
  scanned: number;
  /** 实际入账条数 */
  settled: number;
  /** 跳过条数（并发已入账 / 团长档案不存在） */
  skipped: number;
  amountFen: number;
  quantity: number;
  leaders: CommissionSettleLeaderView[];
  /** 跳过的**原因**（不静默丢弃：运营必须能看见「为什么没结」） */
  skippedReasons: string[];
  /** ⚠️ 口径说明（一期 `pending` 常态为 0 的原因 —— 必须下发给端上） */
  note: string;
}

/**
 * D35 的口径说明（**必须下发**）
 *
 * ⭐ **2026-09-17 · M4-2 定稿：佣金改为两段式** —— 本文案随之重写。
 *
 * 旧版写的是「一期佣金即时入账，故 `pending` 常态为 0 条」；两段式上线后
 * **`pending` 是每天都会出现的正常中间态**，若继续沿用旧文案，运营看到
 * 「待入账 N 条」会以为出了故障，反而去查一批正常数据。
 *
 * ⚠️ 两段式的**业务理由**（不是技术偏好）：自营口径下用户退款**不冲减**供应商
 *   采购款（钱照付，《自营结算口径定义》§5.1）。若佣金在确认当时就入账并被提走，
 *   一单退款就变成平台**双亏** —— 货钱付了、佣金也追不回。隔夜入账（T 日 14:00
 *   确认 → T+1 02:00 入账，约 12 小时）为退款留出一段冷静期。
 */
export const COMMISSION_SETTLE_NOTE =
  '佣金入账 = 把 `ab_commission.status=pending` 的行置为 settled 并计入团长余额。' +
  '⭐ **佣金两段式**：计佣（确认收货时写 pending）与入账（T+1 02:00 跑批进余额）' +
  '分两个时点，故「待入账 N 条」是**每天的常态**，不是故障、也不是「钱没结」。' +
  '本端点既是 `commission-settle.task`（T+1 02:00）的**同一执行口**，' +
  '也用于漏跑批后的手动补跑（传 `date` 限定出餐日；不传 = 全量待入账）。';

@Injectable()
export class CommissionService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Commission) private readonly commissionRepo: Repository<Commission>,
    @InjectRepository(Balance) private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(BalanceLog) private readonly balanceLogRepo: Repository<BalanceLog>,
    @InjectRepository(Withdraw) private readonly withdrawRepo: Repository<Withdraw>,
    private readonly bizConfig: BizConfigService,
  ) {}

  /**
   * L19 · 余额流水（P17 余额流水的服务端支撑）
   *
   * `ab_balance_log` 是「佣金入账 / 下单抵扣 / 提现冻结 / 退款回退」的**发生额账本**，
   * 与 `ab_balance`（余额快照）同源：每笔写入都在同一事务内留下 `balanceAfter` 落痕，
   * 故本接口与 L11 的 `balanceFen` 可相互验算。
   *
   * 口径：`direction = 1` 收入 / `-1` 支出；**`amountFen` 恒为正数**，方向看 `direction`
   *      （与 L10 佣金明细的「冲销存负数」不同，注意区分）。
   */
  async listBalanceLogs(leader: TeamLeader, q: BalanceLogQueryDto) {
    const userId = Number(leader.userId);
    const where: FindOptionsWhere<BalanceLog> = { userId };
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
      const amt = Math.round(Number(r.amount) * 100);
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
          amountFen: Math.round(Number(r.amount) * 100),
          balanceAfterFen: Math.round(Number(r.balanceAfter) * 100),
          relatedId: r.relatedId ?? null,
          remark: r.remark ?? null,
          taxWithheldFen: Math.round(Number(r.taxWithheldAmount || 0) * 100),
          payoutChannel: r.payoutChannel ?? null,
          createdAt: r.createdAt,
        })),
        total,
        page,
        pageSize,
      ),
    };
  }

  /**
   * L10 · 佣金明细
   *
   * `range=day` 取 `date` 当天；`range=month` 取 `date` 所在自然月；缺省今日 + day。
   * 汇总（`summary`）按**全量**统计，不受分页影响。
   */
  async listCommissions(leader: TeamLeader, q: LeaderCommissionQueryDto) {
    const range: 'day' | 'month' = q.range === 'month' ? 'month' : 'day';
    const base = q.date?.trim() || todayBj();
    const { from, to } = monthOrDayRange(base, range);

    const where = { teamLeaderId: Number(leader.id), mealDate: Between(from, to) };
    const { page, pageSize, skip } = normalizePage(q);

    const [rows, total] = await this.commissionRepo.findAndCount({
      where,
      order: { mealDate: 'DESC', id: 'DESC' },
      skip,
      take: pageSize,
    });
    const all = await this.commissionRepo.find({ where });

    let earned = 0;
    let reversed = 0;
    let quantity = 0;
    for (const c of all) {
      const amt = Number(c.amount);
      if (c.type === 'reversal') {
        reversed += amt; // 库中已存负值
      } else {
        earned += amt;
        quantity += Number(c.quantity || 0);
      }
    }

    return {
      summary: {
        range,
        startDate: from,
        endDate: to,
        earnedFen: Math.round(earned * 100),
        reversedFen: Math.round(reversed * 100),
        netFen: Math.round((earned + reversed) * 100),
        /** 计入份数（实发，不含冲销） */
        quantity,
        level: leader.level,
        levelLabel: levelLabel(leader.level),
        rate: Number(leader.commissionRate),
      },
      ...paginate(
        rows.map((c) => ({
          id: Number(c.id),
          orderNo: c.orderNo,
          mealDate: c.mealDate,
          leaderLevel: c.leaderLevel,
          rate: Number(c.rate),
          baseAmountFen: Math.round(Number(c.baseAmount) * 100),
          quantity: Number(c.quantity),
          amountFen: Math.round(Number(c.amount) * 100),
          type: c.type,
          status: c.status,
          /** 代扣个税（C11，团长到手 = 佣金 − 税） */
          taxWithheldFen: Math.round(Number(c.taxWithheldAmount || 0) * 100),
          settledAt: c.settledAt ?? null,
          createdAt: c.createdAt,
        })),
        total,
        page,
        pageSize,
      ),
    };
  }

  /**
   * D34 · 佣金结算明细（**跨团长** · 后台 P34 · M35-02）
   *
   * 与 L10（团长自查明细）的区别：
   *   · L10 是**团长维度**（只看自己、按 range=day/month 汇总）
   *   · D34 是**平台维度**（全部团长、按单个出餐日一张表），并附**按等级拆分**，
   *     因为财务核对时问的是「今天首席/金牌各发了多少佣金」
   *
   * `summary` 一律取**同一过滤条件的全量**（不受分页影响），与 D8 / D40 / D36 同一约定 ——
   * 分页里的合计数是「本页合计」，运营会拿它对账。
   *
   * ⚠️ 手机号一律**脱敏**（团长档案里存的本身就是脱敏号，此处不额外开后门）。
   */
  async listCommissionsForAdmin(q: AdminCommissionsQueryDto) {
    const date = q.date?.trim() || todayBj();
    const kw = q.keyword?.trim();

    const base = this.commissionRepo.createQueryBuilder('c').where('c.mealDate = :date', { date });
    if (q.leaderId) base.andWhere('c.teamLeaderId = :lid', { lid: q.leaderId });
    if (q.status) base.andWhere('c.status = :st', { st: q.status });
    if (q.type) base.andWhere('c.type = :tp', { tp: q.type });
    if (kw) {
      // 关键词命中「订单号」或「团长姓名」——团长姓名要回到 ab_team_leader 查，
      // 故用**子查询**而非拼 id 列表（`ab_commission` 不存团长姓名，这是刻意的：
      // 姓名会改、佣金行不该跟着改）。
      base.andWhere(
        '(c.orderNo LIKE :kw OR c.teamLeaderId IN ' +
          '(SELECT t.id FROM ab_team_leader t WHERE t.real_name LIKE :kw))',
        { kw: `%${kw}%` },
      );
    }

    const { page, pageSize, skip } = normalizePage(q);
    const [rows, total] = await base
      .clone()
      .orderBy('c.id', 'DESC')
      .skip(skip)
      .take(pageSize)
      .getManyAndCount();

    // 汇总 = 全量（不受分页影响）
    const all = await base.clone().getMany();

    let earnedFen = 0;
    let reversedFen = 0;
    let settledFen = 0;
    let pendingFen = 0;
    let cancelledFen = 0;
    let quantity = 0;
    const levelMap = new Map<string, { count: number; amountFen: number; quantity: number }>();
    for (const c of all) {
      const amt = amountFenOf(c.amount);
      if (c.type === 'reversal') {
        reversedFen += amt; // 库中存负值
      } else {
        earnedFen += amt;
        quantity += Number(c.quantity || 0);
      }
      if (c.status === 'settled') settledFen += amt;
      else if (c.status === 'pending') pendingFen += amt;
      else cancelledFen += amt;

      const lv = levelMap.get(c.leaderLevel) ?? { count: 0, amountFen: 0, quantity: 0 };
      lv.count += 1;
      lv.amountFen += amt;
      if (c.type !== 'reversal') lv.quantity += Number(c.quantity || 0);
      levelMap.set(c.leaderLevel, lv);
    }

    // 团长信息批量补齐（一页 ≤ 100 条 → IN 参数安全）
    const leaderIds = [...new Set(rows.map((r) => Number(r.teamLeaderId)))];
    const leaders = leaderIds.length
      ? await this.dataSource
          .getRepository(TeamLeader)
          .createQueryBuilder('t')
          .select(['t.id', 't.realName', 't.phone', 't.level'])
          .where('t.id IN (:...ids)', { ids: leaderIds })
          .getMany()
      : [];
    const leaderMap = new Map(leaders.map((l) => [Number(l.id), l]));

    return {
      date,
      summary: {
        count: all.length,
        quantity,
        earnedFen,
        reversedFen,
        /** 净额 = 正项 + 冲销（冲销为负） */
        netFen: earnedFen + reversedFen,
        settledFen,
        pendingFen,
        cancelledFen,
        byLevel: [...levelMap.entries()]
          .map(([level, v]) => ({
            level,
            levelText: levelLabel(level),
            count: v.count,
            quantity: v.quantity,
            amountFen: v.amountFen,
          }))
          .sort((a, b) => b.amountFen - a.amountFen),
      },
      ...paginate(
        rows.map((c) => {
          const leader = leaderMap.get(Number(c.teamLeaderId));
          return {
            id: Number(c.id),
            orderNo: c.orderNo,
            mealDate: c.mealDate,
            leaderId: Number(c.teamLeaderId),
            /** 团长姓名（档案缺失时回落空串 —— 不编造） */
            leaderName: leader?.realName ?? '',
            /** 与团长档案同源；档案里存的本身就是脱敏号 */
            phoneMasked: leader?.phone ?? '',
            leaderLevel: c.leaderLevel,
            leaderLevelText: levelLabel(c.leaderLevel),
            /** 结算时的费率快照（C2）—— 不是团长当前费率 */
            rate: Number(c.rate),
            baseAmountFen: amountFenOf(c.baseAmount),
            quantity: Number(c.quantity),
            amountFen: amountFenOf(c.amount),
            type: c.type,
            typeText: COMMISSION_TYPE_LABEL[c.type] ?? c.type,
            status: c.status,
            statusText: COMMISSION_STATUS_LABEL[c.status] ?? c.status,
            settledAt: c.settledAt ?? null,
            createdAt: c.createdAt,
          };
        }),
        total,
        page,
        pageSize,
      ),
    };
  }

  /**
   * L11 · 团长余额（提现 / 消费前的可用额）
   *
   * 出参同时给出佣金视角，便于工作台与提现页共用同一份口径。
   */
  async getBalance(leader: TeamLeader) {
    const account = await this.balanceRepo.findOne({ where: { userId: Number(leader.userId) } });
    const minWithdrawYuan = await this.bizConfig.minWithdraw();

    const balance = Number(account?.balance ?? 0);
    const frozen = Number(account?.frozen ?? 0);
    const minFen = Math.round(minWithdrawYuan * 100);

    // 待结算佣金（已产生未打款）
    const pendingRows = await this.commissionRepo.find({
      where: { teamLeaderId: Number(leader.id), status: 'pending' },
    });
    const pendingCommission = pendingRows.reduce((s, c) => s + Number(c.amount), 0);

    // 提现中的申请单（待审批 / 已批准 / 打款中）
    const inFlight = await this.withdrawRepo.count({
      where: {
        leaderId: Number(leader.id),
        status: WithdrawStatus.PENDING,
      },
    });

    return {
      balanceFen: Math.round(balance * 100),
      frozenFen: Math.round(frozen * 100),
      pendingCommissionFen: Math.round(pendingCommission * 100),
      totalInFen: Math.round(Number(account?.totalIn ?? 0) * 100),
      totalOutFen: Math.round(Number(account?.totalOut ?? 0) * 100),
      /** 累计已提现（团长维度快照） */
      withdrawnFen: Math.round(Number(leader.withdrawnAmount) * 100),
      inFlightCount: inFlight,
      minWithdrawFen: minFen,
      canWithdraw: Math.round(balance * 100) >= minFen,
      level: leader.level,
      levelLabel: levelLabel(leader.level),
      rate: Number(leader.commissionRate),
      payoutChannel: await this.bizConfig.payoutChannel(),
    };
  }

  /**
   * 计佣（写 `ab_commission` 的 `pending` 行）——**不入账**
   *
   * ## ⭐ 这是「两段式」的第一段（2026-09-17 · M4-2 定稿）
   *
   * ```mermaid
   * T 日 14:00  确认收货（团长主动 L9 / 系统兜底 4.4）──► ab_commission(status=pending)
   * T+1 02:00  commission-settle.task ────────────────► status=settled + 进团长余额
   * ```
   *
   * ⚠️ **为什么不再即时入账**（改动的**业务**理由，不是技术偏好）：入账后就是可提现的钱。
   *   自营口径下用户退款**不冲减**供应商采购款（钱照付，《自营结算口径定义》§5.1）——
   *   若佣金在确认当时就被提走，一单退款即成为平台**双亏**。隔夜入账留出约 12 小时冷静期。
   *
   * ⚠️ **出参 `amountFen` 的语义已变**：从「本次到账金额」变为「**本次计佣金额**」。
   *   端上文案必须相应改成「将于次日 02:00 入账」—— 否则团长确认后看不到余额变，
   *   会以为钱丢了。（L9 / 4.4 两侧的出参与文案均已同步。）
   *
   * ## 两条路径共用本方法
   * 口径必须一致，否则同一单经不同路径计佣会得出不同金额：
   *   · L9 团长主动取餐确认（`leader-order.service.ts`）
   *   · 4.4 `auto-confirm.task` T 日 14:00 系统自动兜底确认
   *
   * ## 口径
   *   · 基数 = **实发份数** × 单价（取订单 `total_amount` = 售价 × 份数）
   *   · 费率 = 计佣时**等级快照**（`ab_commission.leader_level` + `rate`，C2）
   *   · 幂等 = `uk_commission_order_type`(orderId, type) 唯一索引 + 先查后写，
   *     重复确认 / 定时任务补跑不会重复计佣
   *
   * ## ⭐ 「事实」与「钱」分开记（两段式的连带后果，务必理解）
   *   · `total_orders` / `last_order_at`（**事实**）→ 在**计佣**时累加（本节）；
   *   · `total_commission`（**钱**）→ 在**入账**时累加（`creditCommissions`）。
   *   若两段式后把「事实」也留到入账才记，`total_orders` 会晚一天且**补跑会重复加**
   *   （`touchOrderStats` 的补账语义就是「只改账不改事实」）。故事实归事实、钱归钱。
   */
  async accrueForOrders(
    leader: TeamLeader,
    orders: Order[],
    channel = 'FLEX_MANUAL',
    manager?: EntityManager,
  ): Promise<{ count: number; quantity: number; amountFen: number; orderNos: string[] }> {
    /** ⚠️ 入账代码**只有一处**（`creditCommissions`）—— 本方法不再调用它，勿在此另写。 */
    const run = async (m: EntityManager) => {
      const rate = Number(leader.commissionRate);
      let count = 0;
      let quantity = 0;
      let amountSum = 0;
      const orderNos: string[] = [];

      for (const order of orders) {
        const exist = await m.findOne(Commission, {
          where: { orderId: Number(order.id), type: 'normal' },
        });
        if (exist) continue; // 幂等：该单已计佣

        const base = Number(order.totalAmount);
        const qty = Number(order.quantity || 0);
        const amount = round2(base * rate);

        await m.save(
          m.create(Commission, {
            orderId: Number(order.id),
            orderNo: order.orderNo,
            teamLeaderId: Number(leader.id),
            leaderLevel: leader.level,
            rate: leader.commissionRate, // 快照
            baseAmount: base.toFixed(2),
            quantity: qty,
            amount: amount.toFixed(2),
            type: 'normal',
            status: 'pending', // ⭐ 两段式：计佣不入账，等 T+1 02:00 跑批
            settledAt: null,
            mealDate: order.mealDate,
            payoutChannel: channel,
            taxWithheldAmount: '0.00',
          }),
        );

        count += 1;
        quantity += qty;
        amountSum += amount;
        orderNos.push(order.orderNo);
      }

      // 「事实」累加：订单已确认收货 —— 与钱无关，故不等入账。
      // ⚠️ 只有在真写出新佣金行时才动（`count > 0`），否则重复确认会把单数刷上去。
      if (count > 0) {
        await m
          .createQueryBuilder()
          .update(TeamLeader)
          .set({
            totalOrders: Number(leader.totalOrders) + quantity,
            lastOrderAt: new Date(),
          })
          .where('id = :id', { id: leader.id })
          .execute();
      }

      return {
        count,
        quantity,
        /** ⚠️ = **本次计佣金额**（非到账金额），见方法头注释 */
        amountFen: Math.round(amountSum * 100),
        orderNos,
      };
    };

    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  /* ------------------------------------------------------------------ *
   * 入账段（**唯一**把佣金写进余额的地方，仅 `settlePending` 调用）
   * ------------------------------------------------------------------ */

  /**
   * 把一批佣金计入团长余额。
   *
   * 写出三样东西，缺一不可：
   *   ① `ab_balance_log`（**每笔一条**，含 `balance_after` 逐步落痕 —— 这是账本，
   *      与 L19 余额流水、L11 余额可相互验算）
   *   ② `ab_balance.balance / total_in`（余额快照）
   *   ③ `ab_team_leader.total_commission`（团长维度统计快照，**不参与提现扣减**）
   *
   * ⚠️ **本方法只改「钱」，从不改「事实」** —— 不碰 `total_orders` / `last_order_at`。
   *   两段式（M4-2）之后，事实（订单已确认收货）在**计佣**时就已由
   *   `accrueForOrders` 记过；入账只是把钱搬进余额，属于**补账语义**。若在此再动
   *   `total_orders`，漏跑批后的补入账会把单数重复加上去、`last_order_at` 也会被
   *   刷成「补跑那天」，把团长活跃度与 C2 晋级审计（按 `month_orders`）一起污染。
   *   —— 原本这里有个 `touchOrderStats` 开关区分两种来源；两段式后计佣不再走本方法，
   *   该开关只剩 `false` 一个取值，成了「永不生效的选项」（《缺陷与陷阱》#52 同族），
   *   故**直接删除**，让「只改账不改事实」成为本方法的不变量。
   *
   * ⚠️ **本方法是把佣金写进余额的唯一实现** —— `accrueForOrders`（计佣）刻意不调用它。
   *   任何时候要「入账」，都走 `settlePending`，不要在别处另写一遍余额加法，
   *   否则同一笔佣金经不同路径会得出不同的 `balanceAfter`（本项目头号顽疾「两个真相」）。
   */
  private async creditCommissions(
    m: EntityManager,
    leader: TeamLeader,
    credits: CommissionCredit[],
  ): Promise<{ amountFen: number; quantity: number; orderNos: string[] }> {
    if (!credits.length) return { amountFen: 0, quantity: 0, orderNos: [] };

    const account = await m.findOne(Balance, { where: { userId: Number(leader.userId) } });

    let balance = Number(account?.balance ?? 0);
    let totalIn = Number(account?.totalIn ?? 0);
    let amountSum = 0;
    let quantitySum = 0;
    const orderNos: string[] = [];

    for (const c of credits) {
      balance = round2(balance + c.amount);
      totalIn = round2(totalIn + c.amount);
      amountSum = round2(amountSum + c.amount);
      quantitySum += c.quantity;
      orderNos.push(c.orderNo);

      // ⚠️ 流水文案里的等级/费率取**佣金行的快照**（`c.rate`/`c.level`），不是团长当前值 ——
      //    补结算时团长可能已晋级，用当前值会让账本写着「首席 12%」而钱是按 8% 算的。
      const rate = c.rate ?? Number(leader.commissionRate);
      const level = c.level ?? leader.level;
      await m.save(
        m.create(BalanceLog, {
          userId: Number(leader.userId),
          type: 'commission',
          direction: 1,
          amount: c.amount.toFixed(2),
          balanceAfter: balance.toFixed(2),
          relatedId: c.orderNo,
          remark: c.remark ?? `佣金入账 ${levelLabel(level)} ${(rate * 100).toFixed(0)}%`,
          // 渠道取**佣金行自己的** `payout_channel`（每行一条流水，故不必强行统一）——
          // 两段式后补入账可能一次跨多行，各行渠道未必相同，取行值最诚实。
          payoutChannel: c.channel ?? 'FLEX_MANUAL',
          taxWithheldAmount: '0.00',
        }),
      );
    }

    if (account) {
      await m
        .createQueryBuilder()
        .update(Balance)
        .set({
          balance: balance.toFixed(2),
          totalIn: totalIn.toFixed(2),
          version: () => 'version + 1',
        })
        .where('id = :id', { id: account.id })
        .execute();
    } else {
      await m.save(
        m.create(Balance, {
          userId: Number(leader.userId),
          balance: balance.toFixed(2),
          totalIn: totalIn.toFixed(2),
        }),
      );
    }

    // 团长维度统计快照：**只累加 `total_commission`（钱）**，见方法头注释。
    const totalCommission = round2(Number(leader.totalCommission) + amountSum).toFixed(2);
    await m
      .createQueryBuilder()
      .update(TeamLeader)
      .set({ totalCommission })
      .where('id = :id', { id: leader.id })
      .execute();

    return { amountFen: Math.round(amountSum * 100), quantity: quantitySum, orderNos };
  }

  /* ------------------------------------------------------------------ *
   * D35 · 佣金入账（手动触发 / 补跑）
   * ------------------------------------------------------------------ */

  /**
   * D35 · 把 `ab_commission.status='pending'` 的佣金入账（进余额）。
   *
   * ⭐ **这是 4.5 `commission-settle.task`（T+1 02:00 佣金入账）的同一执行口** ——
   *   跑批与运营手动补跑共用本方法，不存在第二套入账逻辑。
   *
   * ⚠️ **两段式（M4-2 定稿）之后，`pending` 是每天都会出现的正常中间态** ——
   *   T 日确认收货计佣写 `pending`，T+1 02:00 由本方法入账。故 `scanned=0` 只在
   *   「当天没有新确认的订单」时才出现，属正常；`scanned>0` 更是正常。
   *   **不要**再把 `scanned=0` 解释成「钱没结」（旧版注释如此，已随两段式改写）。
   *
   * ⚠️ 本方法**不做「补计佣」**：它只把**已经存在的** pending 行入账，不会去扫描
   *   「该计佣却没有佣金行的订单」。原因是订单表没有「下单/确认时刻的团长等级」快照，
   *   事后补算只能读团长**当前**等级 —— 中间晋级过的团长会被**多算**，且事后无法
   *   证明算错了（《缺陷与陷阱》#51）。**做一个会算错的补算，比不做更危险。**
   *
   * 幂等与并发：
   *   · 逐行 `UPDATE ... WHERE id=? AND status='pending'`，以 `affected` 判定归属 ——
   *     并发下另一处已入账的行 `affected=0`，进 `skipped` 而不是重复加钱；
   *   · **整批单事务**：任一步失败全部回滚（要么全入账、要么全不入账），
   *     不留「一半团长到账、一半没到」的中间态。
   *
   * `settledAt` 取**系统当前时间**（跑批/补跑时刻）而非业务时点 —— 对账要诚实的时间戳，
   * 且 `ab_commission.meal_date` 已记录业务归属日，两者语义不冲突。
   */
  async settlePending(dto: AdminSettleCommissionsDto): Promise<CommissionSettleView> {
    const date = dto.date?.trim() || null;
    const where: FindOptionsWhere<Commission> = { status: 'pending' };
    if (date) where.mealDate = date;

    const rows = await this.commissionRepo.find({ where, order: { id: 'ASC' } });
    if (!rows.length) {
      return {
        date,
        scanned: 0,
        settled: 0,
        skipped: 0,
        amountFen: 0,
        quantity: 0,
        leaders: [],
        skippedReasons: [],
        note: COMMISSION_SETTLE_NOTE,
      };
    }

    const byLeader = new Map<number, Commission[]>();
    for (const r of rows) {
      const id = Number(r.teamLeaderId);
      const list = byLeader.get(id) ?? [];
      list.push(r);
      byLeader.set(id, list);
    }

    const leaders: CommissionSettleLeaderView[] = [];
    const skippedReasons: string[] = [];
    let settled = 0;
    let skipped = 0;
    let amountFen = 0;
    let quantity = 0;

    await this.dataSource.transaction(async (m) => {
      for (const [leaderId, list] of byLeader) {
        const leader = await m.findOne(TeamLeader, { where: { id: leaderId } });
        if (!leader) {
          // 团长档案已不存在 → 该批佣金**无归属**。不猜、不建号、不静默丢弃：
          // 记进 `skippedReasons` 让运营看见（多半是脏数据，需要人工核）。
          skipped += list.length;
          skippedReasons.push(`团长 #${leaderId} 档案不存在，${list.length} 条佣金跳过`);
          continue;
        }

        const credits: CommissionCredit[] = [];
        const now = new Date();
        for (const r of list) {
          const upd = await m
            .createQueryBuilder()
            .update(Commission)
            .set({ status: 'settled', settledAt: now })
            .where('id = :id', { id: Number(r.id) })
            .andWhere('status = :st', { st: 'pending' })
            .execute();
          if ((upd.affected ?? 0) === 0) {
            skipped += 1; // 并发下已被别处入账
            continue;
          }
          credits.push({
            orderNo: r.orderNo,
            amount: Number(r.amount),
            quantity: Number(r.quantity),
            // 快照取自佣金行本身（补账时团长等级可能已变）
            rate: Number(r.rate),
            level: r.leaderLevel,
            channel: r.payoutChannel ?? undefined,
            remark: `佣金入账（补结算）${levelLabel(r.leaderLevel)} ${(Number(r.rate) * 100).toFixed(0)}%`,
          });
        }

        if (!credits.length) continue;

        const credited = await this.creditCommissions(m, leader, credits);
        settled += credits.length;
        amountFen += credited.amountFen;
        quantity += credited.quantity;
        leaders.push({
          leaderId,
          leaderName: leader.realName ?? '',
          level: leader.level,
          settled: credits.length,
          amountFen: credited.amountFen,
          quantity: credited.quantity,
        });
      }
    });

    return {
      date,
      scanned: rows.length,
      settled,
      skipped,
      amountFen,
      quantity,
      leaders,
      skippedReasons,
      note: COMMISSION_SETTLE_NOTE,
    };
  }
}

/** 等级中文名（`LEADER_LEVEL_META` 查表 miss 时回落 key 本身） */
/** `ab_commission.status` → 中文文案（服务端唯一来源，端上不自造） */
export const COMMISSION_STATUS_LABEL: Record<string, string> = {
  pending: '待入账',
  settled: '已入账',
  cancelled: '已冲销',
};

/** `ab_commission.type` → 中文文案（`reversal` 是退款冲销，金额为负） */
export const COMMISSION_TYPE_LABEL: Record<string, string> = {
  normal: '正常计佣',
  reversal: '退款冲销',
};

/** 金额归一（DB 的 DECIMAL 跨驱动类型不一致 → 一律整数分） */
function amountFenOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** `ab_balance_log.type` → 中文文案（服务端唯一来源，端上不自造） */
export const BALANCE_LOG_TYPE_LABEL: Record<string, string> = {
  commission: '佣金入账',
  order_pay: '下单抵扣',
  withdraw: '提现',
  withdraw_refund: '提现退回',
  refund: '退款回退',
  /**
   * M3-14 新增：管理端手工调整（充 / 扣 / 冻 / 解）
   *
   * ⚠️ 漏了这条，团长在 P17 余额明细里会看到裸英文 `adjust` ——
   *    `listBalanceLogs` 的文案回退是 `LABEL[type] ?? type`，**不报错、只是变丑**，
   *    属于最容易漏且最难被发现的一类。值的定义见 `balance-admin.service.ts`。
   */
  adjust: '管理端调整',
};

export function levelLabel(level: string): string {
  return LEADER_LEVEL_META[level as LeaderLevel]?.label ?? level;
}

/**
 * 统计区间（含首含尾）
 * ⚠️ `ab_commission.meal_date` 为 DATE 字符串，`Between` 即 `>= from AND <= to`。
 * 月份边界委托 `common/utils/time.monthRangeOf` —— 晋级审计（C2 月单）与
 * 佣金明细必须用同一套月区间，故不在本文件重复实现。
 */
export function monthOrDayRange(
  base: string,
  range: 'day' | 'month',
): { from: string; to: string } {
  if (range === 'day') return { from: base, to: base };
  return monthRangeOf(base);
}

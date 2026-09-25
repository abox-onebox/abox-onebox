import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, EntityManager, FindOptionsWhere, In, Repository } from 'typeorm';

import { LEADER_LEVEL_META, LeaderLevel, WITHDRAW_FROZEN_STATUS } from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BALANCE_LOG_TYPE_LABEL } from '../../common/constants/balance-log';
import { BizException } from '../../common/exceptions/biz.exception';
import { BizConfigService } from '../../common/services/biz-config.service';
import { LeaderMoneyService } from '../../common/services/leader-money.service';
import { UserPayeeService } from '../../common/services/user-payee.service';
import { QueueService } from '../../common/queue/queue.service';
import { monthRangeOf, todayBj } from '../../common/utils/time';
import { money, round2 } from '../../common/utils/money';
import { normalizePage, paginate } from '../../common/utils/response';
import { Balance, BalanceLog, Commission } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { Order } from '../../database/entities/order.entity';
import { Withdraw } from '../../database/entities/withdraw.entity';
import { SettleOrdersPayload } from '../../queues/queue-payloads';
import { MessageService } from '../message/message.service';
import { NOTIFY_PAGES } from '../admin/template/message-template.specs';
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
 * **余额真源口径（2026-09-15 定 · 2026-09-17 M4-4 收紧）**：
 *   · 可用 / 冻结余额的唯一真源 = `ab_balance`（`user_id` 维度）；
 *     用户与团长共用同一小程序身份，佣金入账与下单抵扣是同一条余额链路 ——
 *     团长佣金既可提现，也可直接抵餐费。
 *   · `ab_team_leader.total_commission` 是**事实累计**（入账时由
 *     `creditCommissions()` 累加，是活的），与余额不是一回事。
 *   · ⚠️ `ab_team_leader.withdrawn_amount` / `pending_amount` / `balance` 三列
 *     **从种子之后就没有任何写点**（M4-4 盘出并停用 · 《缺陷与陷阱》#69）——
 *     它们曾被当作「团长维度统计快照」下发，实际展示的是种子里写死的数字。
 *     ⭐ 现已全部改为**派生**，读取口收敛到 `LeaderMoneyService`
 *     （`ab_balance` / `ab_commission` / `ab_withdraw` 三表），列保留但不再读写。
 *     本注释此前写「是团长维度统计快照」，属**文案承诺了一件代码没做的事**。
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
  /**
   * 已入队「佣金入账通知」的团长数（M4-3）
   *
   * ⭐ 为什么要在出参里给这个数：入队失败**不会**让入账失败（这是队列的本分），
   *    于是它就成了一个「不出现在任何地方就没人知道」的静默失败。
   *    给出来之后：`notifyQueued < leaders.length` 直接说明「有人入账了但通知没发出去」，
   *    e2e 也能断言，运维照 `ab_operation_log`（`module=queue`）查详情。
   */
  notifyQueued: number;
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
  private readonly logger = new Logger(CommissionService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Commission) private readonly commissionRepo: Repository<Commission>,
    @InjectRepository(Balance) private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(BalanceLog) private readonly balanceLogRepo: Repository<BalanceLog>,
    @InjectRepository(Withdraw) private readonly withdrawRepo: Repository<Withdraw>,
    // M4-3：入账通知要用 `leader → userId` 找收件人（团长表已在 FinanceModule forFeature）
    @InjectRepository(TeamLeader) private readonly teamLeaderRepo: Repository<TeamLeader>,
    private readonly bizConfig: BizConfigService,
    // M4-3：入账后「通知团长」的任务入队口（消费者 `queues/settle-orders.consumer.ts`）
    private readonly queue: QueueService,
    private readonly message: MessageService,
    // M4-4：余额 / 冻结 / 待入账佣金 / 累计已提现的**唯一真源**读取口（#69）
    private readonly leaderMoney: LeaderMoneyService,
    /** F-10：写余额前判「收款人身份状态」（全仓唯一实现 `canReceiveMoney`） */
    private readonly payee: UserPayeeService,
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
    /**
     * ⭐ M5-10：实现体已提取到 `LeaderMoneyService.logsOf(userId, q)` ——
     * 用户侧 U14（P9 账户余额明细）与团长侧 L19（P17）读的是**同一条余额链路**，
     * 两份实现必然在「全量汇总不受分页影响」这类约定上悄悄分叉。
     * 本方法只剩「把 leader 映射成 userId」这一个职责。
     */
    return this.leaderMoney.logsOf(Number(leader.userId), q);
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
    const minWithdrawYuan = await this.bizConfig.minWithdraw();

    /**
     * ⭐ M4-4：五项金额全部走 `LeaderMoneyService`（**唯一真源**）。
     *
     * 改动前本方法有三处各自的毛病，且都不报错：
     *   ① `withdrawnFen` 取 `ab_team_leader.withdrawn_amount` —— 该列**从未被写过**，
     *      提现页「累计已提现」永远是种子值 / 0（#69）；
     *   ② `pendingCommission` 只按 `status='pending'` 过滤、**没排除 `type='reversal'`**
     *      （负额冲销行）→ 一旦出现「已入账后冲销」的行，待入账佣金会被算小
     *      （与 M4-2 修掉的 `monthOrdersOf` 双计是同一族缺陷：漏一个过滤条件，
     *      数字就悄悄错，且没有任何断言会红）；
     *   ③ `inFlightCount` 只数 `status='pending'`，而**紧接着的注释写着**
     *      「待审批 / 已批准 / 打款中」——**文案承诺三个状态、代码只数一个**
     *      （同 M4-1 的 `isRealDate` 文案与代码不一致）。后果：运营一批准，
     *      这数字立刻掉到 0，团长以为「没有处理中的提现」，而那笔钱仍在冻结中。
     */
    const snapshot = await this.leaderMoney.snapshotOf([
      { id: Number(leader.id), userId: Number(leader.userId) },
    ]);
    const snap = snapshot.get(Number(leader.id))!;
    const minFen = Math.round(minWithdrawYuan * 100);

    // 占用（冻结）中的提现单 —— 用 `WITHDRAW_FROZEN_STATUS`（shared-types 单一真相），
    // 不手写状态列表，否则「批准后不算占用」这类漂移会再次发生。
    const inFlight = await this.withdrawRepo.count({
      where: { leaderId: Number(leader.id), status: In([...WITHDRAW_FROZEN_STATUS]) },
    });

    return {
      balanceFen: snap.balanceFen,
      frozenFen: snap.frozenFen,
      pendingCommissionFen: snap.pendingCommissionFen,
      totalInFen: snap.totalInFen,
      totalOutFen: snap.totalOutFen,
      /** 累计已提现（**到账口径**：`ab_withdraw(status='success').actual_amount` 合计） */
      withdrawnFen: snap.withdrawnFen,
      inFlightCount: inFlight,
      minWithdrawFen: minFen,
      canWithdraw: snap.balanceFen >= minFen,
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
   *
   * ⚠️ **F-10 收款人闸门**：写余额前先判 `leader.userId` 还收不收得了钱
   *   （`UserPayeeService.canReceiveMoney`）。已注销用户的佣金一旦进余额就**永远提不出来**
   *   —— 提现是唯一的出钱口且必须过 `LeaderGuard`，注销身份过不去 ⇒ 钱永久悬空且**零提示**。
   *   ⭐ **正常业务流不会走到这里的失败分支**：唯一调用方 `settlePending` 在**构建
   *   credits 之前**就用同一函数前置跳过并记入 `skippedReasons`（佣金行留在 `pending`
   *   ⇒ 补跑可再拾起），故本处的 `throw` 只是一道**兜底的后墙**：
   *   「**明明有人绕过了前置闸门却还想写钱**」本身就是必须停下的态。
   *   ⚠️ 也因此它**绝不能被当成常规跳过手段** —— 抛错会让 `settlePending` 的
   *   「整批单事务」回滚，当天**所有团长**的佣金一起退回 `pending`（可重入，重跑即可补齐，
   *   与同方法内乐观锁冲突的处理同哲学）。
   */
  private async creditCommissions(
    m: EntityManager,
    leader: TeamLeader,
    credits: CommissionCredit[],
  ): Promise<{ amountFen: number; quantity: number; orderNos: string[] }> {
    if (!credits.length) return { amountFen: 0, quantity: 0, orderNos: [] };

    const leaderUser = Number(leader.userId);
    if (!(await this.payee.canReceiveMoney(leaderUser, m))) {
      throw new BizException(
        ErrorCode.ACCOUNT_CANCELED,
        `团长 #${leader.id}（用户 #${leaderUser}）已注销，${credits.length} 条佣金不能入账` +
          '（钱一旦进余额就永远提不出来）—— 本批结算已回滚，请核对前置闸门后重跑（结算可重入）',
      );
    }

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
      // ⭐ 乐观锁 · 缺陷 #81 收口 —— **全仓唯一把钱写进余额的入账口**，
      // 也是三处里最该加的一处：它与 T+1 02:00 的佣金入账同源，
      // 而「当天正好有一笔退款退回余额」会撞同一个账户。
      // 旧写法只写 `WHERE id = :id` → 后提交者覆盖先提交者（丢更新），
      // 且两条流水的 `balanceAfter` 各自自洽 → 事后对账**两条都像对的**。
      // ⚠️ `affected = 0` 时**故意抛错让整批回滚**（而不是内部重试）：
      //    本方法的调用方是「**一个事务包住所有团长**」（`settlePending`），
      //    而在同一事务内重读会读到**同一快照**（MySQL REPEATABLE READ）
      //    → 重试必然又失败；要真重试得 `SELECT ... FOR UPDATE`，代价远高于收益。
      //    而结算跑批**本身可重入**（`settlePending` 只捞 `pending` 行），
      //    下一次补跑即可。更重要的是：**持续撞乐观锁本身就是
      //    「有异常写点在抢同一个账户」的信号**，静默重试会把它埋掉。
      const upd = await m
        .createQueryBuilder()
        .update(Balance)
        .set({
          balance: balance.toFixed(2),
          totalIn: totalIn.toFixed(2),
          version: () => 'version + 1',
        })
        .where('id = :id AND version = :v', { id: account.id, v: account.version })
        .execute();
      if (!upd.affected) {
        throw new BizException(
          ErrorCode.BALANCE_CONCURRENT_MODIFIED,
          `团长 #${leader.id} 余额在入账瞬间被其它操作改动，本批结算已回滚（结算可重入，直接重跑即可补齐）`,
        );
      }
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
   *
   * ⚠️ **F-10**：团长所属用户已注销时，该团长的佣金**整批留在 `pending` 跳过**
   * （见循环内的注释）—— 故 `skipped > 0` 不再只意味着「并发已入账」，
   * 也可能是「这笔钱现在没有可交付的收款人」，原因一律进 `skippedReasons`。
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
        notifyQueued: 0,
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
    /** 通知种子：事务内收集（要用到 `list` 里的 mealDate），**事务提交后才入队** */
    const notices: SettleOrdersPayload[] = [];
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

        /**
         * ⭐ **F-10 前置闸门（写钱最后一道的前一道）**：这个团长还收不收得了钱
         *
         * ⚠️ 必须在**构建 credits 之前**判定 —— 一旦进了下面的循环，佣金行就被
         *    置成 `settled`；此时再判「不可收款」，钱要么沉默地丢（记 settled 不入账），
         *    要么抛错把 `settlePending` 的**整批单事务**回滚、连累当天的**所有团长**。
         *    这里提前 `continue` ⇒ 佣金行**留在 `pending`** ⇒ 下一次跑批/补跑自动再拾起
         *    （本方法天然可重入），同时把原因推进 `skippedReasons` 交运营人工处理
         *    ——「留待人工队列」的具体形态就是这条 pending 队列本身，不需要新表。
         */
        const leaderUser = Number(leader.userId);
        if (!(await this.payee.canReceiveMoney(leaderUser, m))) {
          skipped += list.length;
          skippedReasons.push(
            `团长 #${leaderId}（用户 #${leaderUser}）已注销，` +
              `${list.length} 条佣金留在 pending 未入账（入账即成为永远提不出来的钱，请人工核实）`,
          );
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

        // 通知种子（**只收集，不入队** —— 事务还没提交，此时入队可能发出「假入账」通知）
        notices.push({
          mealDate: this.commonMealDate(list, date),
          leaderId,
          settledCount: credits.length,
          amountFen: credited.amountFen,
        });
      }
    });

    // ⭐ 入队必须在**事务提交之后**：事务若回滚，钱没入账却已发通知 = 退款链路同款「说不清」。
    const notifyQueued = await this.enqueueSettleNotices(notices);

    return {
      date,
      scanned: rows.length,
      settled,
      skipped,
      amountFen,
      quantity,
      leaders,
      notifyQueued,
      skippedReasons,
      note: COMMISSION_SETTLE_NOTE,
    };
  }

  /**
   * 派发「佣金入账通知」任务（**入队失败绝不影响入账结果**）
   *
   * 逐个团长入队：某一条失败只影响那一个人（`enqueue` 单个抛错不中断整批），
   * 且失败必须**喊出来** —— 入账已发生、通知没发，是运营需要知道的状态。
   *
   * @returns 成功入队的条数（`< notices.length` 说明有团长收不到通知）
   */
  private async enqueueSettleNotices(notices: SettleOrdersPayload[]): Promise<number> {
    let queued = 0;
    for (const n of notices) {
      try {
        await this.queue.enqueue('settle-orders', n);
        queued += 1;
      } catch (e) {
        this.logger.error(
          `⚠️ 佣金入账通知入队失败（团长 #${n.leaderId}，${n.mealDate}）：` +
            `${e instanceof Error ? e.message : String(e)} —— 该团长收不到入账通知（**入账本身已完成**）`,
        );
      }
    }
    return queued;
  }

  /**
   * 团长本次入账的归属出餐日（用于通知文案）
   *
   * 正常路径下 D35 的 `date` 必填且与佣金行一致（跑批由 `ScheduleService` 推导「昨日」），
   * 只有**手动补跑不带日期**时才会出现「一个团长跨多个出餐日」。
   * 那种情况下取**最近的一天**并沿用批次 `date`：通知文案只需要一个日期，
   * 精确到日的明细在小程序佣金页里（那里按 `meal_date` 完整展示）。
   */
  private commonMealDate(list: Commission[], batchDate: string | null): string {
    const dates = [...new Set(list.map((r) => String(r.mealDate)))].sort();
    if (dates.length === 1) return dates[0];
    return batchDate ?? dates[dates.length - 1] ?? '';
  }

  /**
   * 投递一条「佣金入账通知」（**由队列消费者调用**，M4-3）
   *
   * ## 为什么通知逻辑在这里，而不在消费者里
   *
   * `leader → userId → openid` 的换算是**本模块的数据**（消费者不该为了发一条通知
   * 去 `forFeature` 团长表）；且这条文案的变量必须与
   * `MESSAGE_TEMPLATE_SPECS.commission_settled` 的白名单一致 —— 两者放同一个仓库层级
   * 才好一起改。消费者只做「拿到载荷 → 调本方法」（与 `order-paid` 调 `markPaid`
   * 完全同构）。
   *
   * ## 三种结局（**抛错 = 需要重试**，见 `queue.types.ts` 处理器契约）
   *
   * | 情况 | 处理 |
   * |------|------|
   * | 团长档案不存在 | WARN 后**正常结束**（脏数据，重试三次也不会有档案） |
   * | 场景未启用 / 缺模板 ID | `notify()` 返回 `delivered=false`，**正常结束**（如实状态，不是失败） |
   * | 查库异常 | 抛出 → 队列退避重试 |
   *
   * ⚠️ 通知**失败不重试到天荒地老**：重试三次仍投不出去 → 进死信 + 写
   *    `ab_operation_log`（`module=queue`），由运维看，而不是无限重推骚扰用户。
   */
  async notifySettled(payload: SettleOrdersPayload): Promise<void> {
    const leader = await this.teamLeaderRepo.findOne({ where: { id: Number(payload.leaderId) } });
    if (!leader) {
      this.logger.warn(
        `入账通知跳过：团长 #${payload.leaderId} 档案不存在（${payload.mealDate}，` +
          `${payload.settledCount} 笔）—— 入账已完成，仅通知无处可发`,
      );
      return;
    }

    const amount = money(payload.amountFen / 100) ?? '0.00';
    try {
      const r = await this.message.notify({
        scene: 'commission_settled',
        userId: Number(leader.userId),
        page: NOTIFY_PAGES.leaderCommission,
        variables: {
          mealDate: payload.mealDate,
          amount,
          settledCount: String(payload.settledCount),
        },
        wxData: {
          mealDate: { value: payload.mealDate },
          amount: { value: amount },
          settledCount: { value: String(payload.settledCount) },
        },
      });
      if (!r.delivered) {
        this.logger.log(`入账通知未投递（团长 #${payload.leaderId}）：${r.reason ?? '-'}`);
      }
    } catch (e) {
      // `MessageService.notify()` 已承诺不抛异常，此处兜底只为「通知永远不会
      // 变成队列任务失败」——否则一次通知故障会白跑三次重试再进死信。
      this.logger.warn(
        `入账通知异常（团长 #${payload.leaderId}）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
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

/** `ab_balance_log.type` → 中文文案（**服务端唯一来源**，端上不自造） */
export { BALANCE_LOG_TYPE_LABEL };

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

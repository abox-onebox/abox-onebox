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
import { BalanceLogQueryDto, LeaderCommissionQueryDto } from './dto/finance.dto';

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
   * 计佣并即时入账（M2 验收标准 3）
   *
   * 口径：
   *   · 基数 = **实发份数** × 单价（取订单 `total_amount` = 售价 × 份数）
   *   · 费率 = 结算时**等级快照**（`ab_commission.leader_level` + `rate`，C2）
   *   · 幂等 = `uk_commission_order_type`(orderId, type) 唯一索引 + 先查后写，
   *     重复确认 / 定时任务补跑不会重复计佣
   *   · 入账 = `ab_commission(status='settled')` + `ab_balance.balance` + 一条
   *     `ab_balance_log(type='commission', direction=1)`，保证「佣金明细 ↔ 余额流水」一致
   *
   * ⚠️ M2 阶段由「取餐确认（L9）」即时触发入账；M4 的 `commission-settle.task`
   *    改为扫描 `pending` 佣金补结算，两者幂等、互不冲突。
   */
  async accrueForOrders(
    leader: TeamLeader,
    orders: Order[],
    channel = 'FLEX_MANUAL',
    manager?: EntityManager,
  ): Promise<{ count: number; quantity: number; amountFen: number; orderNos: string[] }> {
    const run = async (m: EntityManager) => {
      const rate = Number(leader.commissionRate);
      const account = await m.findOne(Balance, { where: { userId: Number(leader.userId) } });

      let balance = Number(account?.balance ?? 0);
      let totalIn = Number(account?.totalIn ?? 0);
      let amountSum = 0;
      let quantitySum = 0;
      const orderNos: string[] = [];

      for (const order of orders) {
        const exist = await m.findOne(Commission, {
          where: { orderId: Number(order.id), type: 'normal' },
        });
        if (exist) continue; // 幂等：该单已计佣

        const base = Number(order.totalAmount);
        const quantity = Number(order.quantity || 0);
        const amount = round2(base * rate);

        await m.save(
          m.create(Commission, {
            orderId: Number(order.id),
            orderNo: order.orderNo,
            teamLeaderId: Number(leader.id),
            leaderLevel: leader.level,
            rate: leader.commissionRate, // 快照
            baseAmount: base.toFixed(2),
            quantity,
            amount: amount.toFixed(2),
            type: 'normal',
            status: 'settled',
            settledAt: new Date(),
            mealDate: order.mealDate,
            payoutChannel: channel,
            taxWithheldAmount: '0.00',
          }),
        );

        balance = round2(balance + amount);
        totalIn = round2(totalIn + amount);
        amountSum = round2(amountSum + amount);
        quantitySum += quantity;
        orderNos.push(order.orderNo);

        await m.save(
          m.create(BalanceLog, {
            userId: Number(leader.userId),
            type: 'commission',
            direction: 1,
            amount: amount.toFixed(2),
            balanceAfter: balance.toFixed(2),
            relatedId: order.orderNo,
            remark: `佣金入账 ${levelLabel(leader.level)} ${(rate * 100).toFixed(0)}%`,
            payoutChannel: channel,
            taxWithheldAmount: '0.00',
          }),
        );
      }

      if (orderNos.length) {
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

        // 团长维度统计快照（不参与提现扣减，仅供展示）
        await m
          .createQueryBuilder()
          .update(TeamLeader)
          .set({
            totalCommission: round2(Number(leader.totalCommission) + amountSum).toFixed(2),
            totalOrders: Number(leader.totalOrders) + quantitySum,
            lastOrderAt: new Date(),
          })
          .where('id = :id', { id: leader.id })
          .execute();
      }

      return {
        count: orderNos.length,
        quantity: quantitySum,
        amountFen: Math.round(amountSum * 100),
        orderNos,
      };
    };

    return manager ? run(manager) : this.dataSource.transaction(run);
  }
}

/** 等级中文名（`LEADER_LEVEL_META` 查表 miss 时回落 key 本身） */
/** `ab_balance_log.type` → 中文文案（服务端唯一来源，端上不自造） */
export const BALANCE_LOG_TYPE_LABEL: Record<string, string> = {
  commission: '佣金入账',
  order_pay: '下单抵扣',
  withdraw: '提现',
  withdraw_refund: '提现退回',
  refund: '退款回退',
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

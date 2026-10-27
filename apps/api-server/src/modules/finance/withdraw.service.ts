import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { WITHDRAW_STATUS_VIEW, WithdrawStatus } from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { BizConfigService } from '../../common/services/biz-config.service';
import { maskAccount } from '../../common/utils/crypto';
import { round2 } from '../../common/utils/money';
import { genWithdrawNo } from '../../common/utils/order-no';
import { normalizePage, paginate } from '../../common/utils/response';
import { bjDateTime, todayBj } from '../../common/utils/time';
import { Balance, BalanceLog } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { Withdraw } from '../../database/entities/withdraw.entity';
import { WithdrawApplyReqDto, WithdrawalsQueryDto } from './dto/finance.dto';

/**
 * D3 提现规则定稿（2026-10-26）：计入「当日笔数 / 当日累计额」的提现状态。
 *
 * ⚠️ 刻意**不含** `REJECTED` / `FAILED` —— 这两种状态钱已原路解冻，
 *    再占用当日额度等于罚站长（被驳回不是团长的错）。
 *
 * ⚠️ 与 `summaryOf()` 的「冻结中」判据是**两套口径**，别互相抄：
 *    那里问的是「钱还冻着吗」（排除终态），这里问的是「今天提过吗」（排除作废态）。
 */
const DAILY_COUNTED_STATUS: string[] = [
  WithdrawStatus.PENDING,
  WithdrawStatus.APPROVED,
  WithdrawStatus.PAYING,
  WithdrawStatus.SUCCESS,
];

/**
 * 提现服务（M2 · 2.6 · 接口 L12 / L13）
 *
 * 落点：`modules/finance`（《开发里程碑计划 v1.0》2.6）
 *
 * **C11 出款口径**：
 *   一期 `payout_channel = FLEX_MANUAL` —— 佣金个税与出款走**灵活用工平台**
 *   （代扣代缴，团长拿到手税后金额），系统**不接微信「商家转账到零钱」**。
 *   本服务只负责「申请 → 冻结余额 → 建单（待审批）」；
 *   后台审批与打款批次由 M3（D45/D46）与 `payout.service` 承接。
 *
 * **资金语义**：申请即把金额从 `ab_balance.balance` 移入 `frozen`（可用 → 冻结），
 *   驳回 / 打款失败时原路解冻（`withdraw_refund`）；到账后写 `withdrawn_amount` 快照。
 *
 * **D3 定稿（2026-10-26）**：起提不限 / T+1 / 免手续费 / 单日 ¥2000 / 当日 1 笔。
 *   其中 T+1 在本服务只能落成「**承诺文案 + 可观测**」—— 一期没有自动打款能力
 *   （`markPaid` 是人工回填），要「审批后立即到账」必须先接 `FLEX_API`（二期）。
 */
@Injectable()
export class WithdrawService {
  private readonly logger = new Logger('WithdrawService');

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Withdraw) private readonly withdrawRepo: Repository<Withdraw>,
    @InjectRepository(Balance) private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>,
    private readonly bizConfig: BizConfigService,
  ) {}

  /**
   * L12 · 提现申请
   *
   * 校验顺序（错误码即端上分支依据）：
   *   1. 金额 ≥ 最低提现额（`commission.min_withdraw`，缺省 ¥10 · 书面依据见
   *      `docs/ABox一盒接口规范v1.0.md:627/631`；配 0 = 不限起提）            → 40003
   *   2. 收款方式已绑定（本次入参 或 团长资料已存）                         → 40007
   *   3. 当日笔数未超 `commission.withdraw_daily_count`（默认 1）           → 40025
   *   4. 当日累计额未超 `commission.withdraw_daily_limit`（默认 ¥2000）     → 40024
   *   5. 可用余额充足                                                      → 50004
   *
   * ⚠️ **第 3、4 步必须在事务内读**（第 5 步的余额写也在同一事务里）：
   *    事务外读、事务内写 ⇒ 两个并发请求「都读到旧值、都通过」，日限额形同虚设。
   *    即便如此仍可能有并发漏网，最终由 `ab_balance` 乐观锁（`version + 1`）兜住 ——
   *    **不需要另加悲观锁**。
   */
  async apply(leader: TeamLeader, dto: WithdrawApplyReqDto) {
    const minYuan = await this.bizConfig.minWithdraw();
    const dailyLimitYuan = await this.bizConfig.withdrawDailyLimit();
    const dailyCount = await this.bizConfig.withdrawDailyCount();
    const amount = round2(dto.amount);
    const minFen = Math.round(minYuan * 100);

    // 1) 最低额
    if (Math.round(amount * 100) < minFen) {
      throw new BizException(
        ErrorCode.WITHDRAW_BELOW_MIN,
        `最低提现金额为 ¥${minYuan.toFixed(2)}`,
        undefined,
        { minFen },
      );
    }

    // 2) 收款方式：本次入参优先，缺省取已绑定
    const receiveType = dto.receiveType ?? leader.payoutType ?? null;
    const receiveAccount = (dto.receiveAccount ?? leader.payoutAccount ?? '').trim();
    const receiveName = (dto.receiveName ?? leader.payoutName ?? '').trim();
    if (!receiveType || !receiveAccount || !receiveName) {
      throw new BizException(ErrorCode.PAYOUT_NOT_BOUND, '请先在团长资料中绑定收款方式');
    }

    const channel = await this.bizConfig.payoutChannel();
    const withdrawNo = genWithdrawNo();

    // 当日区间：北京自然日 [00:00, 次日 00:00)。hour 传 24 = 次日 0 点，正好作含尾上界。
    const dayFrom = bjDateTime(todayBj(), 0);
    const dayTo = bjDateTime(todayBj(), 24);

    const created = await this.dataSource.transaction(async (m) => {
      // 3 + 4) 当日笔数与累计额 —— **同一区间一次查询**（走 idx_withdraw_leader_time）
      const agg = await m
        .createQueryBuilder(Withdraw, 'w')
        .select('COALESCE(SUM(w.amount), 0)', 'sumYuan')
        .addSelect('COUNT(1)', 'cnt')
        .where('w.leaderId = :leaderId', { leaderId: Number(leader.id) })
        .andWhere('w.createdAt >= :from AND w.createdAt < :to', { from: dayFrom, to: dayTo })
        .andWhere('w.status IN (:...counted)', { counted: DAILY_COUNTED_STATUS })
        .getRawOne<{ sumYuan: string; cnt: string }>();

      const usedCount = Number(agg?.cnt ?? 0);
      const usedFen = Math.round(Number(agg?.sumYuan ?? 0) * 100);
      const amountFen = Math.round(amount * 100);

      // 3) 当日笔数（0 = 不限）。**先判笔数** —— daily_count=1 时它必然先于金额命中。
      if (dailyCount > 0 && usedCount >= dailyCount) {
        throw new BizException(
          ErrorCode.WITHDRAW_DAILY_DUPLICATED,
          '今日已有一笔提现在处理中，请等这笔完成后再申请',
          undefined,
          { usedCount, dailyCount },
        );
      }

      // 4) 当日累计额（0 = 不限），**含本次申请额**
      if (dailyLimitYuan > 0) {
        const limitFen = Math.round(dailyLimitYuan * 100);
        if (usedFen + amountFen > limitFen) {
          const remainYuan = Math.max(0, limitFen - usedFen) / 100;
          throw new BizException(
            ErrorCode.WITHDRAW_DAILY_LIMIT_EXCEEDED,
            `今日剩余可提 ¥${remainYuan.toFixed(2)}（单日上限 ¥${dailyLimitYuan.toFixed(2)}）`,
            undefined,
            { usedFen, limitFen },
          );
        }
      }

      const account = await m.findOne(Balance, { where: { userId: Number(leader.userId) } });
      const balance = Number(account?.balance ?? 0);
      const frozen = Number(account?.frozen ?? 0);

      // 5) 余额校验
      if (Math.round(balance * 100) < amountFen) {
        throw new BizException(
          ErrorCode.WITHDRAW_BALANCE_NOT_ENOUGH,
          `可提现余额 ¥${balance.toFixed(2)} 不足`,
        );
      }

      const nextBalance = round2(balance - amount);
      const nextFrozen = round2(frozen + amount);

      // 乐观锁：`ab_balance.version` 防并发双提
      const upd = await m
        .createQueryBuilder()
        .update(Balance)
        .set({
          balance: nextBalance.toFixed(2),
          frozen: nextFrozen.toFixed(2),
          // 申请阶段不计入累计支出（到账后才算支出），此处不动 total_out
          version: () => 'version + 1',
        })
        .where('id = :id AND version = :v', { id: account?.id, v: account?.version })
        .execute();
      if (!upd.affected) {
        throw new BizException(ErrorCode.WITHDRAW_BALANCE_NOT_ENOUGH, '余额已变动，请刷新后重试');
      }

      // 冻结流水（direction=-1 支出方向，remarks 标注为冻结）
      await m.save(
        m.create(BalanceLog, {
          userId: Number(leader.userId),
          type: 'withdraw',
          direction: -1,
          amount: amount.toFixed(2),
          balanceAfter: nextBalance.toFixed(2),
          relatedId: withdrawNo,
          remark: `提现申请（冻结至审批完成）· ${WITHDRAW_STATUS_VIEW[WithdrawStatus.PENDING]}`,
          payoutChannel: channel,
          taxWithheldAmount: '0.00',
        }),
      );

      // 首次提现顺带绑定收款方式（后续可在团长资料页修改）
      if (!leader.payoutAccount || !leader.payoutName || !leader.payoutType) {
        await m.update(
          TeamLeader,
          { id: leader.id },
          { payoutType: receiveType, payoutAccount: receiveAccount, payoutName: receiveName },
        );
        this.logger.log(`团长#${leader.id} 首次绑定收款方式（${receiveType}）`);
      }

      return m.save(
        m.create(Withdraw, {
          withdrawNo,
          leaderId: Number(leader.id),
          userId: Number(leader.userId),
          amount: amount.toFixed(2),
          taxWithheldAmount: '0.00',
          actualAmount: amount.toFixed(2), // 个税在打款时按实登记（一期人工）
          payoutChannel: channel,
          receiveType,
          receiveAccount: maskAccount(receiveAccount) ?? receiveAccount,
          receiveName,
          status: WithdrawStatus.PENDING,
        }),
      );
    });

    this.logger.log(
      `提现申请：团长#${leader.id} 单号 ${withdrawNo} 金额 ¥${amount.toFixed(2)} → 待审批`,
    );

    return {
      id: Number(created.id),
      withdrawNo: created.withdrawNo,
      amountFen: Math.round(Number(created.amount) * 100),
      status: created.status,
      statusText: WITHDRAW_STATUS_VIEW[created.status as WithdrawStatus] ?? created.status,
      payoutChannel: created.payoutChannel,
      receiveType: created.receiveType,
      receiveAccount: created.receiveAccount,
      // D3 定稿 T+1：一期只能承诺（无自动打款），故写「1 个工作日内」而非「立即」
      tips:
        '申请已提交，运营审批后 1 个工作日内到账（节假日顺延）· ' +
        '平台不收手续费，个税由灵活用工平台依法代扣代缴，到账为税后金额',
    };
  }

  /** L13 · 提现记录（分页，可带状态过滤） */
  async listWithdrawals(leader: TeamLeader, q: WithdrawalsQueryDto) {
    const { page, pageSize, skip } = normalizePage(q);
    const where: Record<string, unknown> = { leaderId: Number(leader.id) };
    if (q.status?.trim()) where.status = q.status.trim();

    const [rows, total] = await this.withdrawRepo.findAndCount({
      where,
      order: { createdAt: 'DESC', id: 'DESC' },
      skip,
      take: pageSize,
    });

    return paginate(
      rows.map((w) => ({
        id: Number(w.id),
        withdrawNo: w.withdrawNo,
        amountFen: Math.round(Number(w.amount) * 100),
        taxWithheldFen: Math.round(Number(w.taxWithheldAmount) * 100),
        actualFen: Math.round(Number(w.actualAmount) * 100),
        status: w.status,
        statusText: WITHDRAW_STATUS_VIEW[w.status as WithdrawStatus] ?? w.status,
        payoutChannel: w.payoutChannel,
        payoutBatchNo: w.payoutBatchNo ?? null,
        receiveType: w.receiveType,
        receiveAccount: w.receiveAccount,
        failReason: w.failReason ?? null,
        auditRemark: w.auditRemark ?? null,
        paidAt: w.paidAt ?? null,
        createdAt: w.createdAt,
      })),
      total,
      page,
      pageSize,
    );
  }

  /** 团长维度的提现汇总（供工作台/资料页） */
  async summaryOf(leaderId: number) {
    const rows = await this.withdrawRepo.find({ where: { leaderId: Number(leaderId) } });
    let successFen = 0;
    let frozenFen = 0;
    for (const w of rows) {
      const fen = Math.round(Number(w.amount) * 100);
      if (w.status === WithdrawStatus.SUCCESS) successFen += fen;
      else if (w.status !== WithdrawStatus.REJECTED && w.status !== WithdrawStatus.FAILED) {
        frozenFen += fen;
      }
    }
    return { count: rows.length, successFen, frozenFen };
  }
}

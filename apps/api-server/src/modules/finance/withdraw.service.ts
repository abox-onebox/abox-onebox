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
import { Balance, BalanceLog } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { Withdraw } from '../../database/entities/withdraw.entity';
import { WithdrawApplyReqDto, WithdrawalsQueryDto } from './dto/finance.dto';

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
   *   1. 金额 ≥ 最低提现额（`ab_config.commission.min_withdraw`，默认 ¥10.00）→ 40003
   *   2. 收款方式已绑定（本次入参 或 团长资料已存）                          → 40007
   *   3. 可用余额充足                                                       → 50004
   */
  async apply(leader: TeamLeader, dto: WithdrawApplyReqDto) {
    const minYuan = await this.bizConfig.minWithdraw();
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

    const created = await this.dataSource.transaction(async (m) => {
      const account = await m.findOne(Balance, { where: { userId: Number(leader.userId) } });
      const balance = Number(account?.balance ?? 0);
      const frozen = Number(account?.frozen ?? 0);

      // 3) 余额校验
      if (Math.round(balance * 100) < Math.round(amount * 100)) {
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
      tips: '申请已提交，运营审批后由灵活用工平台代发（个税代扣代缴，到账为税后金额）',
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

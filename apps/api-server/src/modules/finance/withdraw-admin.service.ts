import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository, SelectQueryBuilder } from 'typeorm';

import {
  PAYOUT_CHANNEL_META,
  PayoutChannel,
  RECEIVE_TYPE_VIEW,
  ReceiveType,
  WITHDRAW_STATUS_VIEW,
  WithdrawStatus,
} from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { maskPhone } from '../../common/utils/crypto';
import { money, toFen, toYuan } from '../../common/utils/money';
import { payoutBatchNoOf } from '../../common/utils/order-no';
import { normalizePage, paginate } from '../../common/utils/response';
import { toBjIso } from '../../common/utils/time';
import { Balance, BalanceLog, Commission } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { User } from '../../database/entities/user.entity';
import { Withdraw } from '../../database/entities/withdraw.entity';
import {
  AdminApproveWithdrawDto,
  AdminFailWithdrawDto,
  AdminPaidWithdrawDto,
  AdminRejectWithdrawDto,
  AdminWithdrawalsQueryDto,
} from './dto/finance.dto';
import { FUND_ACTION_ROLES } from './finance.constants';
import { levelLabel } from './commission.service';

/**
 * 后台 · 提现审批（《接口规范 v1.0》§6.5 · **D45 列表 / D46 批准 / D46a 驳回 /
 * D46b 到账回执 / D46c 打款失败** · 原型 P34 · 模块 M35-08）
 *
 * ## 这一页为什么是本批次才补的（它不是「锦上添花的后台页」）
 *
 * L12（团长提现申请）从 M2 起就实装了：申请一瞬间 `ab_balance.balance -= X`、
 * `frozen += X`。而在本批次之前，**后台没有任何端点能把这张单子往前推** ——
 * 提现单永远停在 `pending`，被冻结的钱既不会出去、也不会回来。三个可观测的后果：
 *
 * 1. **团长的钱被永久锁死**：`frozen` 只增不减，且没有任何界面或接口能让它下降；
 * 2. **`collectQuitBlockers` 把团长永久困住**：该守卫以 `WITHDRAW_FROZEN_STATUS`
 *    （`pending`/`approved`/`paying`）判定「有未完成的提现」→ 只要提过一次现，
 *    C3「退出团长」就**再也不可能成功**，而错误文案还写着「等待提现到账」
 *    （等一个永远不会发生的到账）；
 * 3. **`ab_leader.withdrawn_amount` 永远是种子值**：没有任何写点。
 *
 * ⭐ 所以本服务的定位是「**把 L12 打开的那条资金链收口**」，不是新增一个报表页。
 *
 * ## 状态机与四动作（每个动作都有 e2e 断言）
 *
 * ```
 *                ┌─ D46  approve ─→ approved ─┐
 *   pending ─────┤                            ├─→ D46b paid → success   （钱出平台）
 *                └─ D46a reject  ─→ rejected  │
 *                                            └─→ D46c fail → failed    （钱退回用户）
 * ```
 *
 * ⚠️ **`paying` 一期不提供入口**：它是二期 `FLEX_API`（自动通道）的中间态
 *    —— 运营把清单提交给平台后、回执回来之前。一期是人工通道（`FLEX_MANUAL`），
 *    「已提交平台、等回执」这件事在系统里没有可观测的锚点，造一个 `paying`
 *    只会让运营多点一次按钮、却什么都不改变。但**收口两个动作都接受 `paying` 入参**，
 *    二期接上 API 后无需改动收口逻辑（`WITHDRAW_FROZEN_STATUS` 已把它算作占用中）。
 *
 * ## 三条资金不变量（本文件的全部风险都在这三条上）
 *
 * 1. ⭐⭐ **解冻金额必须与申请冻结额精确相等**，且**解冻前校验冻结额充足**：
 *    `frozen < 申请额` 时 fail-closed `40015`（**不复用 `40002`** —— 前者是
 *    「冻结账对不上」的账实不符信号，要查数据结构；后者是「钱不够花」）。
 *    驳回 / 到账 / 失败三个动作都走**同一个** `releaseFrozen()`，不各写一份。
 * 2. ⭐⭐ **`total_out` 的增量是「申请金额」而非「实付金额」**：
 *    申请时已经从可用余额扣掉 X，到账只是把这笔被冻结的钱正式记为支出。
 *    若按实付（X − 代扣）记，`total_in − total_out` 与 `balance + frozen`
 *    之间会**永久**留下一个等于代扣税额的缺口 —— 账面上看是「平台多留了钱」，
 *    而实际上那笔税是**平台代扣代缴给税务**的，不是平台留存的。
 *    （e2e 用「到账前后 `(total_in − total_out)` 的差值 === 申请金额」钉死。）
 * 3. ⭐⭐ **驳回 / 失败**完全复原申请前状态**：`balance +X / frozen −X`，
 *    `total_in` / `total_out` **都不动**（钱没进出平台，只是从「冻结」挪回「可用」，
 *    与 D39 冻结/解冻同口径）。
 *
 * ## 为什么到账**不写** `ab_balance_log`
 *
 * `ab_balance_log` 的语义是「**可用余额的每一次变化**」（`direction` 只描述可用余额，
 * `balanceAfter` 逐条落痕、末条 === 当前余额 —— L11 ↔ L19 靠这个互验）。
 * 到账那一刻**可用余额不变**（钱早在申请时就被扣走了），故没有一条属于它的行。
 * ⭐ 这不是「账本与快照不同源」：`frozen` 与 `total_out` 的变化**从来**不由流水解释
 * —— D39 的 `freeze` 行就是先例（`direction=-1` 但 `total_out` 刻意不动）。
 * 到账这一事件由 `ab_withdraw` 自身完整记录（`paid_at` / `tax_withheld_amount` /
 * `actual_amount` / `payout_batch_no`），且与提现单一一对应、可逐笔查。
 * e2e 会把「到账后流水条数不变」写成断言 —— 让「为什么没有」变成**声明**，
 * 而不是让后来人以为漏写了。
 */
@Injectable()
export class WithdrawAdminService {
  private readonly logger = new Logger(WithdrawAdminService.name);

  constructor(
    @InjectRepository(Withdraw) private readonly withdrawRepo: Repository<Withdraw>,
    @InjectRepository(Balance) private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(Commission) private readonly commissionRepo: Repository<Commission>,
    @InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Tab → 状态集合（分组口径写在服务端，端上不自己拼）
   *
   * `review` / `payout` / `done` 三分对应「运营每天真正要做的三件事」：
   * 审批 → 打款 → 复盘。**没有 `all` 之外的第四种切法**，
   * 故不提供「按金额排序」之类的展示型开关。
   */
  private static readonly TAB_STATUS: Record<string, string[]> = {
    review: [WithdrawStatus.PENDING],
    payout: [WithdrawStatus.APPROVED, WithdrawStatus.PAYING],
    done: [WithdrawStatus.SUCCESS, WithdrawStatus.REJECTED, WithdrawStatus.FAILED],
    all: [],
  };

  /**
   * 占用（冻结）中可用余额的状态集合
   *
   * ⚠️ 从 `WITHDRAW_FROZEN_STATUS` 的语义**重述**而非直接 import：
   *    那边是 shared-types 给团长端 / 守卫用的数组，这里需要的是**同一批取值**。
   *    实际上两处必须一致，故 e2e 断言「`frozenByWithdrawFen` === 三状态金额之和」
   *    把这条一致性钉在行为上（而不是靠注释对齐）。
   */
  private static readonly OCCUPYING: string[] = [
    WithdrawStatus.PENDING,
    WithdrawStatus.APPROVED,
    WithdrawStatus.PAYING,
  ];

  // ==========================================================================
  // D45 · 提现审批列表
  // ==========================================================================

  async list(q: AdminWithdrawalsQueryDto, viewerRole: string) {
    const { page, pageSize, skip } = normalizePage(q);
    const tab = q.tab ?? (q.status ? 'all' : 'review');
    const statuses = q.status ? [q.status] : WithdrawAdminService.TAB_STATUS[tab];

    const build = () => {
      const qb = this.withdrawRepo.createQueryBuilder('w');
      if (statuses?.length) qb.andWhere('w.status IN (:...statuses)', { statuses });
      if (q.payoutBatchNo) qb.andWhere('w.payout_batch_no = :pb', { pb: q.payoutBatchNo });
      if (q.keyword) {
        const kw = `%${q.keyword.trim()}%`;
        /**
         * 关键词跨三处匹配（单号 / 收款人 / 昵称）—— 用**子查询**而非 JOIN：
         * JOIN 会让分页的 `getManyAndCount()` 行数被放大（一个用户多行时 count 失真），
         * 而且 SQLite 的绑定变量上限 999 也要求避免拼大 `IN` 列表（M3-9 已踩过）。
         */
        qb.andWhere(
          '(w.withdraw_no LIKE :kw OR w.receive_name LIKE :kw OR w.leader_id IN ' +
            '(SELECT l1.id FROM ab_team_leader l1 WHERE l1.real_name LIKE :kw) OR ' +
            'w.user_id IN (SELECT u1.id FROM ab_user u1 WHERE u1.nickname LIKE :kw))',
          { kw },
        );
      }
      return qb;
    };

    const [rows, total] = await build()
      .clone()
      // 待审批的最久一笔排最前 —— 运营这一页的动作是「清空队列」，不是「看最新的」
      .orderBy('w.status', 'ASC')
      .addOrderBy('w.id', 'ASC')
      .skip(skip)
      .take(pageSize)
      .getManyAndCount();

    const summary = await this.summaryOf(build);

    return {
      ...paginate(await this.decorate(rows), total, page, pageSize),
      tab,
      summary,
      statusOptions: Object.entries(WITHDRAW_STATUS_VIEW).map(([value, label]) => ({
        value,
        label,
      })),
      tabOptions: [
        { value: 'review', label: '待审批' },
        { value: 'payout', label: '待打款' },
        { value: 'done', label: '已终态' },
        { value: 'all', label: '全部' },
      ],
      actions: {
        /**
         * ⭐ **单一真相**：与 D46 系列四个端点的 `@Roles(...FUND_ACTION_ROLES)` 共用
         * `finance.constants.ts` 的同一常量 —— 结构上不可能出现
         * 「按钮亮着、点了 `10003`」或「按钮灰着、其实有权限」。
         */
        canAudit: (FUND_ACTION_ROLES as readonly string[]).includes(viewerRole),
      },
    };
  }

  /**
   * 汇总
   *
   * ⚠️ 两类量**刻意分开**（同 D38 的纪律）：
   *   · **在途量（时点量）** —— `pending` / `approved` / `frozenByWithdrawFen`
   *     取**全量**，**不随筛选变化**。「平台此刻因提现占用了用户多少钱」不该
   *     因为运营在搜索框里敲了个姓名就变小；三者在同一事务边界内快照，
   *     故 `frozenByWithdrawFen` 恰好是「提现占用的冻结额」，可与
   *     `ab_balance.frozen` 对比（后者还含 D39 的手工冻结，故只比较**增量**）。
   *   · **历史量** —— `paid` / `released` 取**同一过滤条件的全量**
   *     （不受分页影响，翻页时数字不跳，与 D34/D40 同一约定）。
   */
  private async summaryOf(build: () => SelectQueryBuilder<Withdraw>) {
    const scoped = await build().clone().orderBy('w.id', 'ASC').getMany();
    const all = await this.withdrawRepo.createQueryBuilder('w').getMany();

    const sumFen = (list: Withdraw[]) => list.reduce((s, w) => s + toFen(Number(w.amount)), 0);
    const pick = (list: Withdraw[], st: WithdrawStatus) => list.filter((w) => w.status === st);

    const inFlight = all.filter((w) =>
      WithdrawAdminService.OCCUPYING.includes(w.status as WithdrawStatus),
    );

    return {
      /** 快照时刻（运单侧出参带 `asOf` 是既有纪律：时点量必须能被复现） */
      asOf: new Date().toISOString(),
      /** ⭐ 全量 · 时点量（不随筛选变化） */
      pendingCount: pick(all, WithdrawStatus.PENDING).length,
      pendingAmountFen: sumFen(pick(all, WithdrawStatus.PENDING)),
      approvedCount: pick(all, WithdrawStatus.APPROVED).length,
      approvedAmountFen: sumFen(pick(all, WithdrawStatus.APPROVED)),
      payingCount: pick(all, WithdrawStatus.PAYING).length,
      payingAmountFen: sumFen(pick(all, WithdrawStatus.PAYING)),
      /** ⭐⭐ 提现占用的冻结额（= 待审批 + 已批准 + 打款中），可与 `ab_balance.frozen` 的增量互相验算 */
      frozenByWithdrawFen: sumFen(inFlight),
      /** 筛选后的历史量（不受分页影响） */
      paidCount: pick(scoped, WithdrawStatus.SUCCESS).length,
      paidAmountFen: sumFen(pick(scoped, WithdrawStatus.SUCCESS)),
      releasedCount: [
        ...pick(scoped, WithdrawStatus.REJECTED),
        ...pick(scoped, WithdrawStatus.FAILED),
      ].length,
      releasedAmountFen: sumFen([
        ...pick(scoped, WithdrawStatus.REJECTED),
        ...pick(scoped, WithdrawStatus.FAILED),
      ]),
      /** 本页命中数（与上面两类都不同：它是分页的 `total`） */
      scopedTotal: scoped.length,
    };
  }

  // ==========================================================================
  // D46 · 审批通过
  // ==========================================================================

  async approve(
    id: number,
    dto: AdminApproveWithdrawDto,
    operatorId: number,
    operatorName: string,
  ) {
    const row = await this.mustGet(id);
    this.assertStatus(row, [WithdrawStatus.PENDING], '批准');

    const batchNo = dto.payoutBatchNo?.trim() || payoutBatchNoOf();
    const before = toFen(Number(row.amount));

    await this.dataSource.transaction(async (m) => {
      const upd = await m
        .createQueryBuilder()
        .update(Withdraw)
        .set({
          status: WithdrawStatus.APPROVED,
          auditorId: operatorId,
          auditAt: new Date(),
          auditRemark: dto.remark ?? null,
          payoutBatchNo: batchNo,
        })
        // 乐观锁：`ab_withdraw.version` 防并发对同一单重复审批
        .where('id = :id AND status = :st', { id: row.id, st: WithdrawStatus.PENDING })
        .execute();
      if (!upd.affected) {
        throw new BizException(
          ErrorCode.WITHDRAW_STATUS_ILLEGAL,
          '该提现单刚被其他操作改动，请刷新后重试',
        );
      }
    });

    this.logger.log(
      `D46 批准提现单#${row.id}（${row.withdrawNo}·¥${money(before / 100)}）` +
        `→ 批次 ${batchNo}（审批人 ${operatorName}）`,
    );

    return {
      id: Number(row.id),
      withdrawNo: row.withdrawNo,
      status: WithdrawStatus.APPROVED,
      statusText: WITHDRAW_STATUS_VIEW[WithdrawStatus.APPROVED],
      amountFen: before,
      payoutBatchNo: batchNo,
      auditorId: operatorId,
      auditorName: operatorName,
      /** 静默校验用：批准**不动钱**（余额已在上一步冻结） */
      moneyMoved: false,
      nextStep: `提交灵活用工平台后回 D45 登记到账（批次 ${batchNo}）`,
    };
  }

  // ==========================================================================
  // D46a · 审批驳回（原路解冻）
  // ==========================================================================

  async reject(id: number, dto: AdminRejectWithdrawDto, operatorId: number, operatorName: string) {
    const row = await this.mustGet(id);
    this.assertStatus(row, [WithdrawStatus.PENDING], '驳回');

    const before = toFen(Number(row.amount));
    const after = await this.dataSource.transaction(async (m) => {
      const settled = await this.releaseFrozen(m, row, {
        type: 'withdraw_refund',
        remark: `提现驳回退回（${dto.reason}）`,
      });
      await m.update(
        Withdraw,
        { id: row.id },
        {
          status: WithdrawStatus.REJECTED,
          auditorId: operatorId,
          auditAt: new Date(),
          auditRemark: dto.reason,
        },
      );
      return settled;
    });

    this.logger.log(
      `D46a 驳回提现单#${row.id}（${row.withdrawNo}）→ 解冻 ¥${money(before / 100)}` +
        `（审批人 ${operatorName}：${dto.reason}）`,
    );

    return {
      id: Number(row.id),
      withdrawNo: row.withdrawNo,
      status: WithdrawStatus.REJECTED,
      statusText: WITHDRAW_STATUS_VIEW[WithdrawStatus.REJECTED],
      amountFen: before,
      reason: dto.reason,
      auditorId: operatorId,
      auditorName: operatorName,
      ...after,
      /** 给运营 / 客服看的一句话：用户的可用余额此刻回到多少 */
      moneyMoved: true,
      tips: `已退回团长可用余额 ¥${money(before / 100)}，他可在「提现记录」看到「已驳回」`,
    };
  }

  // ==========================================================================
  // D46b · 到账回执登记（一期人工通道的唯一收口）
  // ==========================================================================

  async markPaid(id: number, dto: AdminPaidWithdrawDto, operatorId: number, operatorName: string) {
    const row = await this.mustGet(id);
    this.assertStatus(row, [WithdrawStatus.APPROVED, WithdrawStatus.PAYING], '登记到账');

    const amountFen = toFen(Number(row.amount));

    /**
     * ⭐ 代扣个税与实付必须**自洽**。
     *
     * 规则：`申请金额 − 代扣 = 实付`。四个组合的处理见 DTO 注释；
     * 两者都传却不自洽 → `10001`（**不允许两处各记一套**：
     * 那必然产生「账上代扣 50、实付按另算」的双真相，事后无从判断哪个是真的）。
     */
    let taxFen: number;
    let actualFen: number;
    let taxSource: 'explicit' | 'derived' | 'assumed_zero';
    if (dto.taxWithheldFen === undefined && dto.actualFen === undefined) {
      taxFen = 0;
      actualFen = amountFen;
      taxSource = 'assumed_zero';
    } else if (dto.actualFen === undefined) {
      taxFen = dto.taxWithheldFen!;
      actualFen = amountFen - taxFen;
      taxSource = 'derived';
    } else if (dto.taxWithheldFen === undefined) {
      actualFen = dto.actualFen;
      taxFen = amountFen - actualFen;
      taxSource = 'derived';
    } else {
      taxFen = dto.taxWithheldFen;
      actualFen = dto.actualFen;
      taxSource = 'explicit';
      if (amountFen - taxFen !== actualFen) {
        throw new BizException(
          ErrorCode.PARAM_INVALID,
          `代扣与实付不自洽：申请 ¥${money(toYuan(amountFen))} − 代扣 ` +
            `¥${money(toYuan(taxFen))} ≠ 实付 ¥${money(toYuan(actualFen))}`,
          undefined,
          { field: 'actualFen', amountFen, taxWithheldFen: taxFen, actualFen },
        );
      }
    }
    if (taxFen < 0 || actualFen < 0) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        '代扣与实付都不得为负（申请金额小于所填代扣时请先核对回执）',
        undefined,
        { field: 'taxWithheldFen', amountFen, taxWithheldFen: taxFen, actualFen },
      );
    }

    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) {
      throw new BizException(ErrorCode.PARAM_INVALID, 'paidAt 不是合法时间', undefined, {
        field: 'paidAt',
      });
    }

    const after = await this.dataSource.transaction(async (m) => {
      /**
       * 到账：`frozen −X` + `total_out +X`（**X = 申请金额，不是实付**，见文件头不变量 ②）。
       * ⚠️ 不写 `ab_balance_log`（见文件头「为什么到账不写余额流水」）。
       */
      const settled = await this.releaseFrozen(m, row, {
        direction: 'out',
        remark: `提现到账（实付 ¥${money(toYuan(actualFen))}）`,
      });
      await m.update(
        Withdraw,
        { id: row.id },
        {
          status: WithdrawStatus.SUCCESS,
          taxWithheldAmount: money(toYuan(taxFen)),
          actualAmount: money(toYuan(actualFen)),
          paidAt,
          payoutBatchNo: dto.payoutBatchNo?.trim() || row.payoutBatchNo || payoutBatchNoOf(),
          auditorId: row.auditorId ?? operatorId,
          failReason: null,
        },
      );
      return settled;
    });

    this.logger.log(
      `D46b 提现到账#${row.id}（${row.withdrawNo}）申请 ¥${money(toYuan(amountFen))} ` +
        `− 代扣 ¥${money(toYuan(taxFen))} = 实付 ¥${money(toYuan(actualFen))}（登记人 ${operatorName}）`,
    );

    return {
      id: Number(row.id),
      withdrawNo: row.withdrawNo,
      status: WithdrawStatus.SUCCESS,
      statusText: WITHDRAW_STATUS_VIEW[WithdrawStatus.SUCCESS],
      amountFen,
      taxWithheldFen: taxFen,
      actualFen,
      /** ⭐ `assumed_zero` = 系统替你假设了「无代扣」—— 让人看得见这个假设 */
      taxSource,
      paidAt: toBjIso(paidAt),
      payoutBatchNo: dto.payoutBatchNo?.trim() || row.payoutBatchNo || null,
      auditorId: row.auditorId ?? operatorId,
      auditorName: operatorName,
      ...after,
      tips: `团长实收 ¥${money(toYuan(actualFen))}（平台代扣个税 ¥${money(toYuan(taxFen))} 代缴）`,
    };
  }

  // ==========================================================================
  // D46c · 打款失败（原路解冻）
  // ==========================================================================

  async markFailed(id: number, dto: AdminFailWithdrawDto, operatorId: number) {
    const row = await this.mustGet(id);
    this.assertStatus(row, [WithdrawStatus.APPROVED, WithdrawStatus.PAYING], '登记打款失败');

    const amountFen = toFen(Number(row.amount));
    const after = await this.dataSource.transaction(async (m) => {
      const settled = await this.releaseFrozen(m, row, {
        type: 'withdraw_refund',
        remark: `打款失败退回（${dto.failReason}）`,
      });
      await m.update(
        Withdraw,
        { id: row.id },
        {
          status: WithdrawStatus.FAILED,
          failReason: dto.failReason,
          auditorId: row.auditorId ?? operatorId,
          auditRemark: dto.remark ?? row.auditRemark ?? null,
          payoutBatchNo: dto.payoutBatchNo?.trim() || row.payoutBatchNo || payoutBatchNoOf(),
        },
      );
      return settled;
    });

    this.logger.warn(
      `D46c 提现打款失败#${row.id}（${row.withdrawNo}）→ 解冻 ¥${money(amountFen / 100)}：${dto.failReason}`,
    );

    return {
      id: Number(row.id),
      withdrawNo: row.withdrawNo,
      status: WithdrawStatus.FAILED,
      statusText: WITHDRAW_STATUS_VIEW[WithdrawStatus.FAILED],
      amountFen,
      failReason: dto.failReason,
      ...after,
      moneyMoved: true,
      tips: '已退回团长可用余额，他可在「提现记录」看到「打款失败」并重新申请',
    };
  }

  // ==========================================================================
  // 内部：解冻 / 校验 / 装饰
  // ==========================================================================

  /**
   * ⭐⭐ **唯一**的冻结释放口（驳回 / 到账 / 失败三路共用）
   *
   * 三路的差别只在 `direction`：
   *   · `'in'`（驳回 / 失败）—— 把钱**挪回可用余额**：`balance +X / frozen −X`，
   *     `total_in` / `total_out` **都不动**（钱没进出平台）。
   *   · `'out'`（到账）—— 钱**正式出平台**：`frozen −X / total_out +X`，
   *     可用余额不变；且**按申请金额 X 计入 `total_out`**（见文件头不变量 ②）。
   *
   * ⚠️ 三路各写一份的后果不是「重复代码」，而是**其中一路漏掉某个字段**：
   *    例如「到账忘了减 frozen」→ 该用户的冻结额永久虚高，
   *    而同一天其余提现看起来都正常 —— 只有他自己的「可提现余额」越用越少。
   *
   * ⚠️ **解冻前必须先校验 `frozen >= X`**（fail-closed `40015`）：
   *    若冻结额不足，说明存在**绕过冻结口径**的写点（有人直接从别处扣了 `frozen`），
   *    这是**账实不符信号** —— 继续往下走会让 `frozen` 变成负数、
   *    并在下一个用户那里表现为「冻结额凭空多了」。此时应停下查数据，而不是硬扣。
   */
  private async releaseFrozen(
    m: EntityManager,
    row: Withdraw,
    opt: { type?: string; direction?: 'in' | 'out'; remark: string },
  ): Promise<{
    balanceBeforeFen: number;
    frozenBeforeFen: number;
    balanceFen: number;
    frozenFen: number;
    totalInFen: number;
    totalOutFen: number;
  }> {
    const amountFen = toFen(Number(row.amount));
    const userId = Number(row.userId);

    const account = await m.findOne(Balance, { where: { userId } });
    if (!account) {
      throw new BizException(
        ErrorCode.BALANCE_FROZEN_NOT_ENOUGH,
        `用户 #${userId} 没有余额账户，无法释放提现冻结额（账实不符，请查数据）`,
        undefined,
        { userId, withdrawNo: row.withdrawNo, amountFen, hasAccount: false },
      );
    }

    const balanceFen = toFen(Number(account.balance));
    const frozenFen = toFen(Number(account.frozen));
    if (frozenFen < amountFen) {
      throw new BizException(
        ErrorCode.BALANCE_FROZEN_NOT_ENOUGH,
        `冻结余额 ¥${money(toYuan(frozenFen))} 不足以释放提现冻结 ¥${money(toYuan(amountFen))}` +
          `（账实不符，请查数据）`,
        undefined,
        { userId, withdrawNo: row.withdrawNo, amountFen, frozenFen, hasAccount: true },
      );
    }

    const isOut = opt.direction === 'out';
    const nextBalanceFen = isOut ? balanceFen : balanceFen + amountFen;
    const nextFrozenFen = frozenFen - amountFen;
    const nextTotalInFen = toFen(Number(account.totalIn));
    const nextTotalOutFen = isOut
      ? toFen(Number(account.totalOut)) + amountFen
      : toFen(Number(account.totalOut));

    /**
     * 乐观锁：`ab_balance.version`。与 L12 提现 / D39 调账同一处理 ——
     * 抢锁失败即 `10001`「请刷新后重试」，**不重试、不静默覆盖**。
     */
    const upd = await m
      .createQueryBuilder()
      .update(Balance)
      .set({
        balance: money(toYuan(nextBalanceFen)),
        frozen: money(toYuan(nextFrozenFen)),
        totalIn: money(toYuan(nextTotalInFen)),
        totalOut: money(toYuan(nextTotalOutFen)),
        version: () => 'version + 1',
      })
      .where('id = :id AND version = :v', { id: account.id, v: account.version })
      .execute();
    if (!upd.affected) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        '该账户余额刚被其他操作改动，请刷新后重试',
        undefined,
        { field: 'id', userId },
      );
    }

    /**
     * 只有 `'in'`（把钱挪回可用余额）才写流水 —— 因为只有它改变了**可用余额**。
     * `'out'`（到账）见文件头「为什么到账不写余额流水」。
     */
    if (!isOut) {
      await m.save(
        m.create(BalanceLog, {
          userId,
          type: opt.type ?? 'withdraw_refund',
          direction: 1,
          amount: money(toYuan(amountFen)),
          balanceAfter: money(toYuan(nextBalanceFen)),
          relatedId: row.withdrawNo,
          remark: opt.remark.slice(0, 256),
          payoutChannel: row.payoutChannel,
          taxWithheldAmount: '0.00',
        }),
      );
    }

    return {
      balanceBeforeFen: balanceFen,
      frozenBeforeFen: frozenFen,
      balanceFen: nextBalanceFen,
      frozenFen: nextFrozenFen,
      totalInFen: nextTotalInFen,
      totalOutFen: nextTotalOutFen,
    };
  }

  /** 取单（不存在 → `40016`） */
  private async mustGet(id: number): Promise<Withdraw> {
    const row = await this.withdrawRepo.findOne({ where: { id: Number(id) } });
    if (!row) {
      throw new BizException(ErrorCode.WITHDRAW_NOT_FOUND, `提现单 #${id} 不存在`, undefined, {
        id,
      });
    }
    return row;
  }

  /**
   * 状态机守卫（fail-closed `40017`）
   *
   * ⚠️ 这里**不是**「顺手加个校验」：四个动作两两之间都可能被误操作
   *    （对已到账的单再点「批准」、对已驳回的单点「到账」），
   *    而每个误操作的后果都是**再动一次钱**。故一律显式返回
   *    「当前状态「已到账」不支持批准」这种**能直接照着排查**的话，
   *    而不是笼统的「操作失败」。
   */
  private assertStatus(row: Withdraw, allowed: WithdrawStatus[], action: string): void {
    const cur = row.status as WithdrawStatus;
    if (!allowed.includes(cur)) {
      throw new BizException(
        ErrorCode.WITHDRAW_STATUS_ILLEGAL,
        `当前状态「${WITHDRAW_STATUS_VIEW[cur] ?? cur}」不支持${action}（提现单 ${row.withdrawNo}）`,
        undefined,
        {
          id: Number(row.id),
          withdrawNo: row.withdrawNo,
          status: cur,
          allowed,
          action,
        },
      );
    }
  }

  /** 行装饰：一次补齐团长 / 用户 / 余额快照（避免前端 N+1） */
  private async decorate(rows: Withdraw[]): Promise<Record<string, unknown>[]> {
    if (!rows.length) return [];

    const leaderIds = [...new Set(rows.map((r) => Number(r.leaderId)))];
    const userIds = [...new Set(rows.map((r) => Number(r.userId)))];

    const [leaders, users, accounts, pendingRows] = await Promise.all([
      this.leaderRepo.find({ where: { id: In(leaderIds.concat([0])) } }),
      this.userRepo.find({ where: { id: In(userIds.concat([0])) } }),
      this.balanceRepo.find({ where: { userId: In(userIds.concat([0])) } }),
      /**
       * 「该团长还有多少佣金待入账」—— D45 页要回答「驳回后他是不是马上又能提」
       * （两段式下 `pending` 天天产生，见 M4-2）。用 `In` 列表安全：
       * 一页 ≤ 100 行 → 去重后的团长数 ≤ 100，远低于 SQLite 的 999 上限。
       */
      this.commissionRepo.find({
        /**
         * ⚠️ 只数 `type='normal'`：`reversal`（退款冲销）是**负额**行，
         *    若一起累加会把「待入账」算小甚至算成负数。两段式下
         *    `pending` 只可能是 `normal`（冲销发生在已入账之后），
         *    但显式写出来，将来若允许「未入账即冲销」也不会静默错账。
         */
        where: { teamLeaderId: In(leaderIds.concat([0])), status: 'pending', type: 'normal' },
      }),
    ]);

    const leaderMap = new Map(leaders.map((l) => [Number(l.id), l]));
    const userMap = new Map(users.map((u) => [Number(u.id), u]));
    const accountMap = new Map(accounts.map((a) => [Number(a.userId), a]));
    const pendingByLeader = new Map<number, number>();
    for (const c of pendingRows) {
      const lid = Number(c.teamLeaderId);
      pendingByLeader.set(lid, (pendingByLeader.get(lid) ?? 0) + toFen(Number(c.amount)));
    }

    return rows.map((w) => {
      const st = w.status as WithdrawStatus;
      const leader = leaderMap.get(Number(w.leaderId));
      const user = userMap.get(Number(w.userId));
      const account = accountMap.get(Number(w.userId));
      const amountFen = toFen(Number(w.amount));
      const taxFen = toFen(Number(w.taxWithheldAmount));
      const actualFen = toFen(Number(w.actualAmount));

      /**
       * ⭐ 每行动作可用性**唯一在服务端**（同 D9/D40 的做法）：
       *    端上照 `can*` 渲染按钮，不自己判状态 —— 否则「前端判断」与
       *    「后端守卫」两套口径必然漂移，且漂移的表现是按钮能点、点了报错。
       */
      const isPending = st === WithdrawStatus.PENDING;
      const isPayable = st === WithdrawStatus.APPROVED || st === WithdrawStatus.PAYING;

      return {
        id: Number(w.id),
        withdrawNo: w.withdrawNo,

        amountFen,
        taxWithheldFen: taxFen,
        actualFen,
        /**
         * 一期（人工通道）里 `actual` 在到账登记前始终等于申请金额
         * （`apply()` 就是这么写的），若页面上把「实付」直接当结论展示，
         * 运营会以为个税为 0。故**只在已到账时**把实付视为已知，否则标 `null`。
         */
        actualKnown: st === WithdrawStatus.SUCCESS,
        taxKnown: st === WithdrawStatus.SUCCESS,

        status: st,
        statusText: WITHDRAW_STATUS_VIEW[st] ?? st,
        payoutChannel: w.payoutChannel,
        /**
         * 通道文案由服务端给（与订单状态文案同一纪律：**端上不自造**）。
         * ⚠️ 取不到时**回落原值**而不是给个「未知」——历史流水里可能存着
         *    `WECHAT_TRANSFER` 之外的脏值，直接露出原串才便于排查。
         */
        payoutChannelText:
          PAYOUT_CHANNEL_META[w.payoutChannel as PayoutChannel]?.label ?? w.payoutChannel,
        payoutBatchNo: w.payoutBatchNo ?? null,

        receiveType: w.receiveType,
        receiveTypeText: RECEIVE_TYPE_VIEW[w.receiveType as ReceiveType] ?? w.receiveType,
        /** 收款账号**已是脱敏存储**（`maskAccount` 在申请时处理），此处原样下发 */
        receiveAccount: w.receiveAccount,
        receiveName: w.receiveName,

        user: {
          id: Number(w.userId),
          nickname: user?.nickname ?? null,
          /** 后台列表**同样脱敏** —— 全号属于受审计的导出通道（同 D40） */
          phoneMasked: maskPhone(user?.phone ?? null),
        },
        leader: leader
          ? {
              id: Number(leader.id),
              realName: leader.realName ?? null,
              level: leader.level,
              levelText: levelLabel(leader.level),
              /** 该团长此刻的资产快照 —— 驳回前用它印证「确实冻结着这笔钱」 */
              balanceFen: toFen(Number(account?.balance ?? 0)),
              frozenFen: toFen(Number(account?.frozen ?? 0)),
              pendingCommissionFen: pendingByLeader.get(Number(leader.id)) ?? 0,
            }
          : null,

        auditorId: w.auditorId ?? null,
        auditAt: w.auditAt ? toBjIso(w.auditAt) : null,
        auditRemark: w.auditRemark ?? null,
        failReason: w.failReason ?? null,
        paidAt: w.paidAt ? toBjIso(w.paidAt) : null,
        createdAt: toBjIso(w.createdAt),

        canApprove: isPending,
        canReject: isPending,
        canMarkPaid: isPayable,
        canMarkFailed: isPayable,
        blockReason:
          isPending || isPayable
            ? null
            : `当前状态「${WITHDRAW_STATUS_VIEW[st] ?? st}」已终态，无需处理`,
      };
    });
  }
}

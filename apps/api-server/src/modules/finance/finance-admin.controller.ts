import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HEADER } from '@abox/shared-types';

import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { IdempotentInterceptor } from '../../common/interceptors/idempotent.interceptor';
import {
  BalanceAdminService,
  BALANCE_ADJUST_ROLES,
  FINANCE_VIEW_ROLES,
} from './balance-admin.service';
import { CommissionService } from './commission.service';
import {
  AdminAdjustBalanceDto,
  AdminApproveWithdrawDto,
  AdminBalancesQueryDto,
  AdminCommissionsQueryDto,
  AdminFailWithdrawDto,
  AdminInvoicesQueryDto,
  AdminPaidWithdrawDto,
  AdminReconciliationQueryDto,
  AdminRejectWithdrawDto,
  AdminSettleCommissionsDto,
  AdminWithdrawalsQueryDto,
  FinanceOverviewQueryDto,
  WithdrawIdParamDto,
} from './dto/finance.dto';
import { FUND_ACTION_ROLES } from './finance.constants';
import { FinanceService } from './finance.service';
import { InvoiceService } from './invoice.service';
import { ReconciliationService } from './reconciliation.service';
import { WithdrawAdminService } from './withdraw-admin.service';

/**
 * 后台 · 财务结算（《接口规范 v1.0》§6.5 · 原型 P34 · 模块 M35）
 *
 * 本控制器承载 **D33 资金总览 / D34 佣金结算明细 / D35 佣金入账 / D38 余额账户 /
 * D39 余额调整 / D43 微信对账 / D44 发票管理 / D45 提现审批列表 /
 * D46 批准 · D46a 驳回 · D46b 到账回执 · D46c 打款失败**；
 * 同域其余端点在相邻控制器：
 *   · D36/D37 应付结算 → `supplier-share-admin.controller.ts`（`admin/supplier-shares`）
 *   · D40–D42 退款审批 → `refund-admin.controller.ts`（`admin/finance/refunds`）
 *
 * ⚠️ **两级白名单**（与 D40/D41 同一处理）：
 *   类级（`FINANCE_READ_ROLES`）含 `operator` —— 运营要能看资金总览、佣金明细、
 *   余额账户、对账差异与**提现队列**（跟进「为什么佣金没结」「这个用户余额为什么是负的」
 *   「今天哪几笔对不上」「这笔提现怎么还没到账」）；
 *   **方法级（`FUND_ACTION_ROLES`）收窄到 `super_admin`/`admin`/`finance`** 的有五处：
 *   D35（把佣金记进团长余额）· **D39（直接改用户余额）** · **D46 系列四个动作
 *   （批准 / 驳回 / 到账 / 打款失败）** —— 都是资金动作，运营不该拍板
 *   （同 D41「决定钱退不退」）。
 *   ⭐ 这两个集合在 `finance.constants.ts` **各只有一份定义** —— 此前 D35 / D39 / D41/D42
 *   四处各写着字面量，那种副本的后果不是编译失败而是**静默漂移**
 *   （「按钮亮着、点了 `10003`」或更糟的「按钮灰着、其实有权限」）。
 *   ⭐ D43/D44/D45 **均为纯读**（GET），故不额外收窄 —— 它们不改一分钱。
 *
 * ⚠️ 白名单与菜单同源：`admin-role.ts` 里 `/finance/*` 只出现在 `admin` / `operator` /
 *   `finance` 的菜单中，`viewer` 没有财务页 —— 故此处**不含 `viewer`**
 *   （与 D47–D50 看板刻意含 `viewer` 的理由正好相反：那边 viewer 的菜单**只有**看板页，
 *   漏了就整个角色不可用）。
 *
 * ⚠️ **路由顺序**：本控制器全是静态段（`overview` / `commissions(+/settle)` /
 *   `balances(+/adjust)` / `reconciliation` / `invoices` /
 *   `withdrawals` 与其 `:id/{approve|reject|paid|fail}`）——
 *   `withdrawals` 是**静态首段**，`{id}` 只在段中，故不存在参数路由吃掉静态路径的问题。
 *   若将来加 `withdrawals/:id` 详情，仍必须声明在 `withdrawals/export` 之类的静态段之前。
 */
@ApiTags('后台·财务结算')
@ApiBearerAuth()
@Controller('admin/finance')
@UseGuards(AdminGuard)
@Roles(...FINANCE_VIEW_ROLES)
export class FinanceAdminController {
  constructor(
    private readonly finance: FinanceService,
    private readonly commission: CommissionService,
    private readonly balance: BalanceAdminService,
    private readonly reconciliation: ReconciliationService,
    private readonly invoice: InvoiceService,
    private readonly withdraw: WithdrawAdminService,
  ) {}

  // ------------------------------------------------------------ D33 资金总览

  @Get('overview')
  @ApiOperation({
    summary: 'D33 资金总览（P34 · M35-01）',
    description:
      '收入 / 成本 / 毛利与「数据看板 D47」**同一份口径**（同一个服务函数），' +
      'GMV 不含未支付/已取消/已退款（**在途退款计入**）。\n\n' +
      '另补资金视角四项：① 应付单**付了没有**（pending/paid 拆分）② 已退回用户的金额 ' +
      '③ 用户余额与冻结（`liability` · **时点量，不随区间变化**）④ 待入账佣金。\n\n' +
      '`daily[]` 是逐出餐日摘要（原型「每日结算跑批」表）。⚠️ 经营毛利是**结果值**：' +
      '履约成本未登记或本期应付单未生成时会系统性偏高，原因见 `warnings`。',
  })
  overview(@Query() q: FinanceOverviewQueryDto) {
    return this.finance.overview(q);
  }

  // ------------------------------------------------------------ D34 佣金明细

  @Get('commissions')
  @ApiOperation({
    summary: 'D34 佣金结算明细（P34 · M35-02）',
    description:
      '**跨团长**的佣金流水（区别于 L10 团长自查）：按出餐日一张表，`date` 缺省今日。' +
      '`status` / `type` / `keyword` 为 M3-13 登记的扩展入参。\n\n' +
      '行内 `rate` / `leaderLevel` 是**结算时的快照**（C2），不是团长当前等级 —— ' +
      '拿它去对照「现在的佣金比例」必然对不上，这是设计如此。\n\n' +
      '`summary.byLevel[]` 按等级拆分，`summary` 取**同一过滤条件的全量**（不受分页影响）。',
  })
  listCommissions(@Query() q: AdminCommissionsQueryDto) {
    return this.commission.listCommissionsForAdmin(q);
  }

  // ------------------------------------------------------------ D35 佣金入账（资金动作 · 收窄）

  @Post('commissions/settle')
  @UseInterceptors(IdempotentInterceptor)
  @Idempotent({ scope: 'commission-settle', required: false })
  @Roles(...FUND_ACTION_ROLES)
  @OperationLog({ module: 'finance', action: '佣金入账补跑' })
  @ApiOperation({
    summary: 'D35 佣金入账（幂等 · 手动触发 / 补跑）',
    description:
      '把 `ab_commission.status=pending` 的佣金置为 `settled` 并计入团长余额 —— ' +
      '这是 M4 `commission-settle.task`（T+1 02:00）的**同一执行口**，' +
      '跑批上线前用于手动补跑、异常/历史数据补账。\n\n' +
      '`date` 可限定出餐日，缺省 = 全部待入账。**整批单事务**：任一步失败全部回滚，' +
      '不留「一半团长到账」的中间态；并发的重复入账以逐行 `affected` 判定后进 `skipped`，' +
      '不会重复加钱。\n\n' +
      '⚠️ **佣金两段式（2026-09-17 定稿）**：计佣（确认收货时写 `pending`）与入账' +
      '（T+1 02:00 跑批进余额）分两个时点，故 **`pending` 是每天都存在的正常中间态**，' +
      '`scanned=0` 只在「当天没有新确认的订单」时出现 —— 出参 `note` 会把这句话原样' +
      '带给操作人，避免「点了按钮 0 条」被当成故障。两段式为退款留出约 12 小时冷静期' +
      '（自营口径下退款不冲减供应商采购款，佣金若已提走即平台双亏）。',
  })
  settleCommissions(@Body() dto: AdminSettleCommissionsDto) {
    return this.commission.settlePending(dto);
  }

  // ------------------------------------------------------------ D38 余额账户

  @Get('balances')
  @ApiOperation({
    summary: 'D38 余额账户管理（P34 · M35-04）',
    description:
      '跨用户的余额账户列表（`ab_balance` 快照 + `ab_user` / `ab_team_leader` 装饰）。\n\n' +
      '⭐ `summary.liability` 是**全量负债（时点量）**，与 D33 资金总览的 `liability` ' +
      '**同一个服务函数** —— 它**不随本页筛选变化**（`total` 才是本次筛选命中数）：' +
      '「平台还欠用户多少钱」不该因为运营搜了个昵称就变小。\n\n' +
      '按 `userId` 精确查时：① 该用户**没有账户也会返回一行**（`hasAccount=false`，余额全 0）' +
      '——否则「搜不到人 → 以为查无此用户 → 不敢充值」；② 附带该用户**最近 20 条流水**，' +
      '让「他这 ¥150 是哪来的」当场可查。\n\n' +
      '手机号**列表一律脱敏**（同 M3-6 纪律）。\n\n' +
      '`actions.canAdjust` 按当前登录角色下发（`super_admin`/`admin`/`finance` 为 `true`）' +
      '—— 端上据此决定「调账」按钮是否可点；**判定权威仍在服务端 `@Roles`**，' +
      '两者共用同一角色常量。',
  })
  listBalances(@Query() q: AdminBalancesQueryDto, @CurrentAdmin('role') role: string) {
    return this.balance.list(q, role);
  }

  // ------------------------------------------------------------ D39 余额调整（资金动作 · 收窄）

  @Post('balances/adjust')
  @Roles(...BALANCE_ADJUST_ROLES)
  @UseInterceptors(IdempotentInterceptor)
  @Idempotent({ scope: 'balance-adjust' })
  @OperationLog({ module: 'finance', action: '余额调整' })
  @ApiHeader({
    name: HEADER.IDEMPOTENCY_KEY,
    required: true,
    description:
      '幂等键（**必填**）：调账没有业务单号可供判重，重复提交就是重复加钱 —— ' +
      '缺失 → `10001`；重复提交 → `10006` + 首次结果',
  })
  @ApiOperation({
    summary: 'D39 余额调整（充值 / 扣减 / 冻结 / 解冻 · P34 · M35-04）',
    description:
      '四动作：`recharge` 充值 / `deduct` 扣减 / `freeze` 冻结 / `unfreeze` 解冻。\n\n' +
      '`amountFen` 是**整数分**（管理端出参一律分，入参用分才对称），`reason` **必填**' +
      '（写入余额流水 `remark` —— 这是日后唯一能回答「运营为什么给这个人加钱」的信息）。\n\n' +
      '**三条硬约束**：① 余额**不得为负**（扣减/冻结超出可用额 → `40002`；解冻超出冻结额 → ' +
      '`40015`，两者刻意分开：前者是「钱不够花」，后者是「冻结账对不上」的账实不符信号）；' +
      '② 冻结与解冻**不动** `total_in`/`total_out`（钱没进出平台，只是从「可用」挪到「冻结」，' +
      '与 L12 提现「申请阶段不计入累计支出」同口径）；③ 乐观锁 `version` 防并发调账丢更新。\n\n' +
      '⭐ **只有「充值」能在用户无账户时自动建户** —— 其余三个动作都以「已有余额」为前提，' +
      '无账户时明确报错而不是先建一个 0 余额账户再报「余额不足」。\n\n' +
      '⚠️ `unfreeze` 是对规范「充/扣/冻」三动作的**必要补充**：不能解冻的冻结就是死钱。',
  })
  adjustBalance(
    @Body() dto: AdminAdjustBalanceDto,
    @CurrentAdmin('sub') operatorId: number,
    @CurrentAdmin('username') operatorName: string,
  ) {
    return this.balance.adjust(dto, operatorId, operatorName);
  }

  // ------------------------------------------------------------ D43 微信对账

  @Get('reconciliation')
  @ApiOperation({
    summary: 'D43 微信支付对账（P34 · M35-06）',
    description:
      '按**支付日**核对三头：订单侧（`ab_order`）↔ 支付流水侧（`ab_payment_log`）↔ ' +
      '退款侧（`ab_refund`）。出参主体是**差异清单**（不是一个流水列表 —— 那去 D33 / D40 看），' +
      '每条差异自带中文类型 + **下一步动作**：「对账不平」四个字对运营毫无用处。\n\n' +
      '⭐ **`date` 是「支付日」（`paid_at` 的北京日），不是出餐日** —— 对账对象是微信账单，' +
      '微信按支付日切日。这是财务域里唯一一个 `date` 不指出餐日的端点，故出参回显 ' +
      "`anchor='paidAt'` + `anchorLabel='支付日'`；拿它去对 D33/D34/D36 的出餐日数字" +
      '必然对不上（两个时间轴，不是 bug）。\n\n' +
      '⚠️⚠️ **一期拿不到微信账单**（无商户号 + 无 API 证书），故出参**强制**带 ' +
      "`channel.source='local_only'` + `billAvailable=false` + 人话 `note`：本页当前只对了" +
      '**本地三头**，**不等于已与微信侧对平**。若报成「已对平」，真正的差异' +
      '（微信收了钱、系统不知道）将永远不可见。\n\n' +
      '`summary.balanced` 同时要求**金额相等**与**无结构差异**（重复交易号 / 缺交易号' +
      '可能不影响合计，却是重复入账的前兆）。差异可筛五类：订单已付无流水 / 流水成功无订单 / ' +
      '金额不一致 / 重复交易号 / 缺微信交易号。\n\n' +
      '⚠️ 本接口**刻意不提供「一键平账」**：对账的作用是暴露差异，不是把差异抹掉。',
  })
  reconciliationOf(@Query() q: AdminReconciliationQueryDto) {
    return this.reconciliation.reconcile(q);
  }

  // ------------------------------------------------------------ D44 发票管理

  @Get('invoices')
  @ApiOperation({
    summary: 'D44 发票管理（**进项票** · P34 · M35-07）',
    description:
      '供应商开给 ABox 的**增值税发票**（自营口径下是税前扣除凭证）台账。\n\n' +
      '⭐ **零 DDL · 派生视图**：不建 `ab_invoice`，全部事实都已在 `ab_supplier_share` 里' +
      '（`invoice_no` + `paid_at` + `payee_id`）。建表只会立刻产生第二份真相 ' +
      '（「应付表说付了、发票表说没票」时以谁为准）。\n\n' +
      '⭐ **粒度 = 「供应商 × 月份」**（不是单条应付行）：发票按月开，按行展示会看到' +
      '「同一发票号重复 30 次」，**完全看不出**「这家这个月只开了一半」。' +
      '三态 `none` / `partial` / `full` 中，**`partial` 是本页存在的理由**。\n\n' +
      '⚠️ 两个口径：① 月份 = **应付单生成月**（`share_date`），权责发生制台账，' +
      '跨月付款仍归原月；② 开票分母**只含已付款行**（未付款就要票，供应商不会给），' +
      '未付款额单列 `unpaidAmountFen`，不参与状态判定。\n\n' +
      '扩展入参 `month` / `supplierId` / `status` / `keyword`（非法枚举 → `10001`，' +
      '**不静默回落成「全部」**）。`summary` 取**筛选后全量**（不受分页影响）。\n\n' +
      '`titleMissing=true` 表示未登记开票抬头（D28）—— 抬头缺失票开不出来，端上引导去补。',
  })
  listInvoices(@Query() q: AdminInvoicesQueryDto) {
    return this.invoice.list(q);
  }

  // ------------------------------------------------------------ D45 提现审批列表

  @Get('withdrawals')
  @ApiOperation({
    summary: 'D45 提现审批列表（P34 · M35-08）',
    description:
      '跨团长的提现单队列（L12 申请出来的单子在这里被处理）。`tab` 三分对应运营每天' +
      '真正要做的三件事：`review` 待审批 / `payout` 待打款 / `done` 已终态；' +
      '也可用 `status` 精确过滤（`status` 优先于 `tab`）。\n\n' +
      '⭐ **在途量是时点量**：`pending*` / `approved*` / `frozenByWithdrawFen` **取全量、' +
      '不随筛选变化** ——「平台此刻因提现占用了用户多少钱」不该因为运营搜了个姓名就变小；' +
      '`frozenByWithdrawFen` 可与 `ab_balance.frozen` 的**增量**互相验算（后者还含 D39 手工冻结）。' +
      '`paid*` / `released*` 则取**同一过滤条件的全量**（不受分页影响）。\n\n' +
      '每行带团长资产快照（`leader.balanceFen` / `frozenFen` / `pendingCommissionFen`）' +
      '—— 驳回前用它印证「确实冻结着这笔钱」；收款账号**已是脱敏存储**，手机号同样脱敏。\n\n' +
      '`actions.canAudit` 按当前登录角色下发（`super_admin`/`admin`/`finance` 为 `true`），' +
      '**判定权威仍在服务端 `@Roles`**，两者共用 `FUND_ACTION_ROLES`。',
  })
  listWithdrawals(@Query() q: AdminWithdrawalsQueryDto, @CurrentAdmin('role') role: string) {
    return this.withdraw.list(q, role);
  }

  // ------------------------------------------------------------ D46 批准（资金动作 · 收窄）

  @Post('withdrawals/:id/approve')
  @UseInterceptors(IdempotentInterceptor)
  @Idempotent({ scope: 'withdraw-approve', required: false })
  @Roles(...FUND_ACTION_ROLES)
  @OperationLog({ module: 'finance', action: '提现审批通过', targetParam: 'id' })
  @ApiOperation({
    summary: 'D46 提现审批通过（台账口径）',
    description:
      '`pending → approved`：写审批人 / 时间 / 备注，并登记**出款批次号**。\n\n' +
      '⭐ **批准不动钱**（余额早在 L12 申请时就已从可用挪入冻结），本步只改状态 —— ' +
      '出参 `moneyMoved=false` 明写这一点，避免运营以为「点完钱就发出去了」。\n\n' +
      '⭐ `payoutBatchNo` 缺省 = **审批日批次**（`PB{yyyyMMdd}`）：一期人工通道下' +
      '「今天批的钱是一批」，运营把该批次筛出来导出清单、提交灵活用工平台一次即可。' +
      '需要一天内分批提交时显式传入（批次号**不是**资金主键，提现单号才是，故不加锁）。\n\n' +
      '仅 `pending` 可批准，否则 `40017`；并发重复批准以 `WHERE status=pending` 的 ' +
      '`affected` 判定后拒绝，不会重复写审批人。',
  })
  approveWithdrawal(
    @Param() p: WithdrawIdParamDto,
    @Body() dto: AdminApproveWithdrawDto,
    @CurrentAdmin('sub') operatorId: number,
    @CurrentAdmin('username') operatorName: string,
  ) {
    return this.withdraw.approve(p.id, dto, operatorId, operatorName);
  }

  // ------------------------------------------------------------ D46a 驳回（资金动作 · 收窄）

  @Post('withdrawals/:id/reject')
  @UseInterceptors(IdempotentInterceptor)
  @Idempotent({ scope: 'withdraw-reject', required: false })
  @Roles(...FUND_ACTION_ROLES)
  @OperationLog({ module: 'finance', action: '提现审批驳回', targetParam: 'id' })
  @ApiOperation({
    summary: 'D46a 提现审批驳回 → **原路解冻**',
    description:
      '`pending → rejected`：`balance +X` / `frozen −X`，' +
      '**`total_in`/`total_out` 都不动**（钱没进出平台，只是从「冻结」挪回「可用」）。\n\n' +
      '⭐ 解冻**前**先校验冻结额充足，`frozen < 申请额` 时 fail-closed `40015` ' +
      '—— 那是「冻结账对不上」的账实不符信号（有人绕过了冻结口径），' +
      '硬扣会让 `frozen` 变负并在下一个用户身上表现为「冻结额凭空多了」。\n\n' +
      '`reason` 必填 ≥2 字并写入 `audit_remark`：这是唯一能回答「为什么把我这笔打回来」的地方。\n\n' +
      '⚠️ 缺本端点时，L12 申请出去的钱**永远回不来**（`frozen` 只增不减），' +
      '且 C3 退团守卫会以「有未完成的提现」把团长**永久困住**。',
  })
  rejectWithdrawal(
    @Param() p: WithdrawIdParamDto,
    @Body() dto: AdminRejectWithdrawDto,
    @CurrentAdmin('sub') operatorId: number,
    @CurrentAdmin('username') operatorName: string,
  ) {
    return this.withdraw.reject(p.id, dto, operatorId, operatorName);
  }

  // ------------------------------------------------------------ D46b 到账回执（资金动作 · 收窄）

  @Post('withdrawals/:id/paid')
  @UseInterceptors(IdempotentInterceptor)
  @Idempotent({ scope: 'withdraw-paid', required: false })
  @Roles(...FUND_ACTION_ROLES)
  @OperationLog({ module: 'finance', action: '提现到账登记', targetParam: 'id' })
  @ApiOperation({
    summary: 'D46b 到账回执登记（一期人工通道的**唯一收口**）',
    description:
      '`approved|paying → success`：登记 `tax_withheld_amount` / `actual_amount` / `paid_at`。\n\n' +
      '⭐⭐ **`total_out` 按「申请金额」而非「实付」累加**：申请时已从可用余额扣掉 X，' +
      '到账只是把这笔冻结的钱正式记为支出。若按实付记，`total_in − total_out` 与 ' +
      '`balance + frozen` 之间会**永久**留下一个等于代扣税额的缺口 —— 账面上像「平台多留了钱」，' +
      '而实际那笔税是**平台代扣代缴给税务**的，不是平台留存。\n\n' +
      '代扣与实付**必须自洽**（`申请额 − 代扣 = 实付`），两者都传却不自洽 → `10001`；' +
      "都缺省则视为无代扣，并在出参标 `taxSource='assumed_zero'`（让「系统替你假设了 0」可见）。\n\n" +
      '⭐ 本步**不写** `ab_balance_log`：该表的语义是「**可用余额**的每一次变化」，' +
      '而到账时可用余额不变（钱在申请时就已扣走）。`frozen` / `total_out` 的变化' +
      '**从来**不由流水解释（D39 的 `freeze` 行即先例），到账事件由 `ab_withdraw` 自身完整承载。',
  })
  markWithdrawalPaid(
    @Param() p: WithdrawIdParamDto,
    @Body() dto: AdminPaidWithdrawDto,
    @CurrentAdmin('sub') operatorId: number,
    @CurrentAdmin('username') operatorName: string,
  ) {
    return this.withdraw.markPaid(p.id, dto, operatorId, operatorName);
  }

  // ------------------------------------------------------------ D46c 打款失败（资金动作 · 收窄）

  @Post('withdrawals/:id/fail')
  @UseInterceptors(IdempotentInterceptor)
  @Idempotent({ scope: 'withdraw-fail', required: false })
  @Roles(...FUND_ACTION_ROLES)
  @OperationLog({ module: 'finance', action: '提现打款失败', targetParam: 'id' })
  @ApiOperation({
    summary: 'D46c 打款失败登记 → **原路解冻**',
    description:
      '`approved|paying → failed`：与 D46a 一样原路解冻（`balance +X / frozen −X`），' +
      '但状态语义**相反** —— 驳回是「平台认为不该发」，失败是「平台尝试发了但没成功」' +
      '（账号不存在 / 户名不符 / 平台额度不足）。分开是为了让运营看到成因分布：' +
      '某批次里 `failed` 集中 → 收款信息质检有问题；`rejected` 集中 → 审批口径有问题。\n\n' +
      '`failReason` 必填 ≥2 字（写入 `fail_reason`）。',
  })
  markWithdrawalFailed(
    @Param() p: WithdrawIdParamDto,
    @Body() dto: AdminFailWithdrawDto,
    @CurrentAdmin('sub') operatorId: number,
  ) {
    return this.withdraw.markFailed(p.id, dto, operatorId);
  }
}

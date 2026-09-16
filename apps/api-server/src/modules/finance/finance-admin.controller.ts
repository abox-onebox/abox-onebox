import { Body, Controller, Get, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
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
  AdminBalancesQueryDto,
  AdminCommissionsQueryDto,
  AdminSettleCommissionsDto,
  FinanceOverviewQueryDto,
} from './dto/finance.dto';
import { FinanceService } from './finance.service';

/**
 * 后台 · 财务结算（《接口规范 v1.0》§6.5 · 原型 P34 · 模块 M35）
 *
 * 本控制器承载 **D33 资金总览 / D34 佣金结算明细 / D35 佣金入账 / D38 余额账户 / D39 余额调整**；
 * 同域其余端点在相邻控制器：
 *   · D36/D37 应付结算 → `supplier-share-admin.controller.ts`（`admin/supplier-shares`）
 *   · D40–D42 退款审批 → `refund-admin.controller.ts`（`admin/finance/refunds`）
 *
 * ⚠️ **两级白名单**（与 D40/D41 同一处理）：
 *   类级（`FINANCE_VIEW_ROLES`）含 `operator` —— 运营要能看资金总览、佣金明细与余额账户
 *   （跟进「为什么佣金没结」「这个用户余额为什么是负的」）；
 *   **方法级（`BALANCE_ADJUST_ROLES`）收窄到 `super_admin`/`admin`/`finance`** 的有两处：
 *   D35（把佣金记进团长余额）与 **D39（直接改用户余额）** —— 都是资金动作，运营不该拍板
 *   （同 D41「决定钱退不退」）。
 *
 * ⚠️ 白名单与菜单同源：`admin-role.ts` 里 `/finance/overview`、`/finance/commission`、
 *   `/finance/balance` 只出现在 `admin` / `operator` / `finance` 的菜单中，`viewer` 没有
 *   财务页 —— 故此处**不含 `viewer`**（与 D47–D50 看板刻意含 `viewer` 的理由正好相反：
 *   那边 viewer 的菜单**只有**看板页，漏了就整个角色不可用）。
 *
 * ⚠️ **路由顺序**：本控制器全是静态段（`overview` / `commissions(+/settle)` /
 *   `balances(+/adjust)`），不存在 `:id` 吃路径的问题。若将来加详情页
 *   （如 `balances/:userId`），静态段仍必须声明在参数路由之前。
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
  @Roles('super_admin', 'admin', 'finance')
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
      '⚠️ **一期 `scanned` 常态为 0**：佣金在「取餐确认」时即时入账（`settled`），' +
      '`pending` 是 M4 两步结算上线后的中间态 —— 出参 `note` 会把这句话原样带给操作人，' +
      '避免「点了按钮 0 条」被当成故障。',
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
}

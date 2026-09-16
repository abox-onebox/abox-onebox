import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { CommissionService } from './commission.service';
import {
  AdminCommissionsQueryDto,
  AdminSettleCommissionsDto,
  FinanceOverviewQueryDto,
} from './dto/finance.dto';
import { FinanceService } from './finance.service';

/**
 * 后台 · 财务结算（《接口规范 v1.0》§6.5 · 原型 P34 · 模块 M35）
 *
 * 本控制器承载 **D33 资金总览 / D34 佣金结算明细 / D35 佣金入账**；
 * 同域其余端点在相邻控制器：
 *   · D36/D37 应付结算 → `supplier-share-admin.controller.ts`（`admin/supplier-shares`）
 *   · D40–D42 退款审批 → `refund-admin.controller.ts`（`admin/finance/refunds`）
 *
 * ⚠️ **两级白名单**（与 D40/D41 同一处理）：
 *   类级含 `operator` —— 运营要能看资金总览与佣金明细（跟进「为什么佣金没结」）；
 *   D35 **方法级收窄到 `super_admin`/`admin`/`finance`** —— 它会把佣金记进团长余额，
 *   是资金动作，运营不该拍板（同 D41「决定钱退不退」）。
 *
 * ⚠️ 白名单与菜单同源：`admin-role.ts` 里 `/finance/overview`、`/finance/commission`
 *   只出现在 `admin` / `operator` / `finance` 的菜单中，`viewer` 没有财务页 ——
 *   故此处**不含 `viewer`**（与 D47–D50 看板刻意含 `viewer` 的理由正好相反：
 *   那边 viewer 的菜单**只有**看板页，漏了就整个角色不可用）。
 *
 * ⚠️ **路由顺序**：本控制器无参数化路由（三个都是静态段），不存在 `:id` 吃路径的问题。
 *   若将来加详情页，静态段仍必须声明在 `:id` 之前。
 */
@ApiTags('后台·财务结算')
@ApiBearerAuth()
@Controller('admin/finance')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'finance', 'operator')
export class FinanceAdminController {
  constructor(
    private readonly finance: FinanceService,
    private readonly commission: CommissionService,
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
}

import { Body, Controller, Get, Ip, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import {
  AdminOrdersQueryDto,
  ForceRefundDto,
  ManualAdjustDto,
  OrderNoParamDto,
} from './dto/order-admin.dto';
import { OrderAdminService } from './order-admin.service';

/**
 * 后台 · 订单中心（《接口规范 v1.0》§6.2 D8–D12 · 原型 P30/P31）
 *
 * 路径统一挂在 `admin/orders/*` —— 与用户端 `/orders/*` **只差一个前缀**，
 * 但这个前缀正是 `JwtAuthGuard` 的隔离依据（`ADMIN_SCOPE`）：写成 `/orders/admin/*`
 * 的话，鉴权会退回用户端规则，整个后台订单接口会被 C 端 token 打开。
 *
 * ⚠️ **路由顺序**：`GET export` 必须声明在 `GET :orderNo` **之前**，
 *    否则 `/admin/orders/export` 会被当成 `orderNo='export'` 吃掉（Nest 按声明顺序匹配）。
 *
 * ⚠️ `@Roles('super_admin','admin','operator','finance')`：财务要看订单（对账要用），
 *    但 `viewer` 不在白名单 —— 只读观察者只有看板。
 */
@ApiTags('后台·订单中心')
@ApiBearerAuth()
@Controller('admin/orders')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator', 'finance')
export class OrderAdminController {
  constructor(private readonly orderAdmin: OrderAdminService) {}

  // ------------------------------------------------------------ D8 订单流

  @Get()
  @ApiOperation({
    summary: 'D8 全平台订单流（含异常 Tab）',
    description:
      'tab=all 全部 / tab=abnormal 异常（待支付超时 + 退款待审批 + 退款中；**已取消不算异常**）。' +
      'summary 按同一过滤条件的全量统计，不受分页影响。手机号脱敏。',
  })
  list(@Query() q: AdminOrdersQueryDto) {
    return this.orderAdmin.list(q);
  }

  // ------------------------------------------------------------ 筛选项（只读）

  @Get('filter-options')
  @ApiOperation({
    summary: '订单筛选下拉（楼群 / 办公楼 / 团长 / 状态 · 只读）',
    description:
      '订单列表的三个核心筛选维度。管理这些对象属 3.5（团长名录）与 3.7（办公楼管理），' +
      '本接口只提供「能选」的最小数据源，避免订单中心反向依赖尚未落地的模块。',
  })
  filterOptions() {
    return this.orderAdmin.filterOptions();
  }

  // ------------------------------------------------------------ D12 导出

  @Get('export')
  @ApiOperation({
    summary: 'D12 订单导出（含完整手机号 · 强制留痕）',
    description:
      '过滤条件与 D8 完全一致 —— 导出的必须是「你筛出来的那批」。' +
      '单次上限 5000 行，超出截断并在 truncated 标记。响应为「表头 + 二维数组」，端上拼 CSV。',
  })
  exportOrders(
    @Query() q: AdminOrdersQueryDto,
    @CurrentAdmin('sub') operatorId: number,
    @Ip() ip: string,
  ) {
    return this.orderAdmin.exportOrders(q, operatorId, ip);
  }

  // ------------------------------------------------------------ D10 手动改单

  @Post('manual-adjust')
  @OperationLog({ module: 'order', action: '手动改单' })
  @ApiOperation({
    summary: 'D10 手动改单（改份数 / 改取餐楼）',
    description:
      '改份数**仅限未支付**订单（已支付的改份数=补收或退款，属支付通道动作，一期走「强制退款 + 重新下单」）；' +
      '改取餐楼限未支付/已支付，且目标楼须与原楼**同楼群**（30015）。两者均要求未过截单（30014）。' +
      '入参给的是**目标值**而非增量 —— 重试不会翻倍。',
  })
  manualAdjust(@Body() dto: ManualAdjustDto, @CurrentAdmin('sub') operatorId: number) {
    return this.orderAdmin.manualAdjust(dto, operatorId);
  }

  // ------------------------------------------------------------ D9 详情

  @Get(':orderNo')
  @ApiOperation({
    summary: 'D9 订单详情 + 操作日志 + 佣金明细',
    description:
      '含订单快照、菜品明细、支付流水、退款单、时间线、该单的后台操作日志，' +
      '以及 actions{canAdjust,canForceRefund,可退金额} —— 按钮可用性口径唯一在服务端。',
  })
  detail(@Param() p: OrderNoParamDto) {
    return this.orderAdmin.detail(p.orderNo);
  }

  // ------------------------------------------------------------ D11 强制退款

  @Post(':orderNo/force-refund')
  @OperationLog({ module: 'order', action: '后台强制退款', targetParam: 'orderNo' })
  @ApiOperation({
    summary: 'D11 后台强制退款（C6 第三段 · 客诉兜底）',
    description:
      '跳过「申请 → 审批」直接退款：微信实付部分原路退，余额抵扣部分退回余额，' +
      '同步执行反向结算（佣金反冲 + 应付冲减 + 毛利留存）。' +
      '订单若已有团长代退申请 → 40008，请走退款审批（D41）。一期只支持全额退款。',
  })
  forceRefund(
    @Param() p: OrderNoParamDto,
    @Body() dto: ForceRefundDto,
    @CurrentAdmin('sub') operatorId: number,
  ) {
    return this.orderAdmin.forceRefund(p.orderNo, dto, operatorId);
  }
}

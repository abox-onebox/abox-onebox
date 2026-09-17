import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import {
  AdminRefundsQueryDto,
  ApproveRefundDto,
  RejectRefundDto,
  RefundIdParamDto,
} from './dto/refund-admin.dto';
import { FINANCE_READ_ROLES, FUND_ACTION_ROLES } from './finance.constants';
import { RefundAdminService } from './refund-admin.service';

/**
 * 后台 · 退款审批（《接口规范 v1.0》§6.5 D40–D42 · 原型 P34）
 *
 * 路径 `admin/finance/refunds/*` —— 前缀 `admin/` 是 `JwtAuthGuard` 的隔离依据，
 * 与用户端 `/leader/*`、`/orders/*` 天然分开。
 *
 * ⚠️ **路由顺序**：`GET detail/:id` 这类固定段路径要声明在 `GET :id` 之前，
 *    否则 `/admin/finance/refunds/detail/1` 会被 `:id` 吃掉（与 D8 的 export 同一个坑）。
 *
 * ⚠️ **两级白名单**：类级放 `operator`（运营要能**看**退款流水、跟进用户），
 *    但 D41/D42 **方法级收窄到 `FUND_ACTION_ROLES`** —— 决定「钱退不退」
 *    是资金动作，不该由运营专员拍板。这样运营的 `/finance/refund` 菜单也不再是
 *    「看得见点不开」。`viewer` 两级都进不来。
 *
 * ⚠️ M4-4：两个集合已上移到 `finance.constants.ts`（域级概念），与 D35 / D39 /
 *    D46 系列共用同一份定义 —— 此前五个端点各写一份字面量，漂移不报错。
 */
@ApiTags('后台·退款审批')
@ApiBearerAuth()
@Controller('admin/finance/refunds')
@UseGuards(AdminGuard)
@Roles(...FINANCE_READ_ROLES)
export class RefundAdminController {
  constructor(private readonly refundAdmin: RefundAdminService) {}

  // ------------------------------------------------------------ D40 流水

  @Get()
  @ApiOperation({
    summary: 'D40 退款流水 / 待审批列表',
    description:
      'tab=pending 待审批 / approved 已通过 / rejected 已驳回 / refunded 已退款 / all 全部；' +
      '亦可按 status 精确过滤。summary 按同一过滤条件的全量统计，不受分页影响。' +
      '每行带「微信实付 / 余额抵扣」拆分（通过弹窗照此展示），手机号脱敏。',
  })
  list(@Query() q: AdminRefundsQueryDto) {
    return this.refundAdmin.list(q);
  }

  // ------------------------------------------------------------ 单条（审批前二次确认）

  @Get('detail/:id')
  @ApiOperation({
    summary: '退款单详情（审批前二次确认用）',
    description: '与 D40 行结构一致 —— 通过弹窗里的金额必须来自服务端，不接受端上计算。',
  })
  detail(@Param() p: RefundIdParamDto) {
    return this.refundAdmin.detail(p.id);
  }

  // ------------------------------------------------------------ D41 通过

  @Post(':id/approve')
  @Roles(...FUND_ACTION_ROLES)
  @OperationLog({ module: 'finance', action: '退款审批通过', targetParam: 'id' })
  @ApiOperation({
    summary: 'D41 审批通过 → 实际退款（C6 第二段 → 第三段）',
    description:
      '微信实付走通道原路退 + 余额抵扣退回余额 + 反向结算（佣金冲销 / 应付冲减 / 毛利留存）。' +
      '审批与实退同事务：通道退款失败（40010）则审批一并回滚，不留「已批准但没退」的悬空单。' +
      '仅 `applying` 可审批（否则 40013）；可退额由服务端重算，不一致 → 40011。',
  })
  approve(
    @Param() p: RefundIdParamDto,
    @Body() dto: ApproveRefundDto,
    @CurrentAdmin('sub') operatorId: number,
  ) {
    return this.refundAdmin.approve(p.id, operatorId, dto.remark);
  }

  // ------------------------------------------------------------ D42 驳回

  @Post(':id/reject')
  @Roles(...FUND_ACTION_ROLES)
  @OperationLog({ module: 'finance', action: '退款审批驳回', targetParam: 'id' })
  @ApiOperation({
    summary: 'D42 审批驳回 → 订单回到申请前状态（C6 第二段）',
    description:
      '资金零变动：不碰余额、不写佣金、不动应付，只把订单状态回退到申请前的节点' +
      '（取 `ab_refund.order_status_before`）。缺该记录 → 40014（fail-closed，' +
      '改走 D11 强制退款），绝不靠猜状态。reason 必填 ≥2 字。',
  })
  reject(
    @Param() p: RefundIdParamDto,
    @Body() dto: RejectRefundDto,
    @CurrentAdmin('sub') operatorId: number,
  ) {
    return this.refundAdmin.reject(p.id, operatorId, dto.reason);
  }
}

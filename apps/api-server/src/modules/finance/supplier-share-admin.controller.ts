import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import {
  GenerateSharesDto,
  RegisterPaymentDto,
  ShareExceptionsQueryDto,
  ShareIdParamDto,
  SupplierShareListQueryDto,
} from './dto/supplier-share.dto';
import { SupplierShareService } from './supplier-share.service';

/**
 * 后台 · 应付结算（S9 · 原型 P34 · **自营口径 2026-09-16**）
 *
 * 路径 `admin/supplier-shares/*` —— 前缀 `admin/` 是主体隔离依据
 * （`JwtAuthGuard` 按 `typ` 拒掉小程序 token）。
 *
 * ⚠️ **两级白名单**（与 D41/D42 同一处理）：
 *   类级放 `operator`（运营要能**看**应付单、跟进「为什么没出单」），
 *   但「生成应付」与「付款登记」**方法级收窄到 `super_admin`/`admin`/`finance`**
 *   —— 这两件事一个决定「欠供应商多少」、一个决定「钱付了没有」，是资金动作。
 *   `viewer`（只读观察者）与 `supplier` 两级都进不来。
 *
 * ⚠️ **路由顺序**：`GET exceptions` 这类**静态段必须声明在参数路由之前**
 *   （`admin.guard` / D8 的 export、D19 的 filter-options 都踩过这个坑）。
 *   本控制器当前无 `GET :id`，仍按纪律把 `exceptions` 写在前面，避免后续加详情页时踩雷。
 *
 * ⚠️ 出参**不含**终端售价 / 佣金 / 毛利 —— 后台侧虽然可见全貌，但应付单的字段设计
 *   要与供应商端（P25）同构，否则「给供应商看的数」与「运营核对的数」会漂移。
 */
@ApiTags('后台·应付结算')
@ApiBearerAuth()
@Controller('admin/supplier-shares')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'finance', 'operator')
export class SupplierShareAdminController {
  constructor(private readonly shares: SupplierShareService) {}

  // ------------------------------------------------------------ 列表

  @Get()
  @ApiOperation({
    summary: 'S9 应付单列表（P34）',
    description:
      '按 `date`（出餐日）/ `supplierId` / `status` 过滤，`keyword` 命中应付单号·银行回单号·发票号。' +
      '`summary` 取**同一过滤条件的全量**，不受分页影响。\n\n' +
      '计费基数是**实收量**（供应商出餐确认申报的实送份数），**不是订单销量** —— ' +
      '自营口径下采购是「交多少付多少」，与用户是否退款无关。',
  })
  list(@Query() q: SupplierShareListQueryDto) {
    return this.shares.list(q);
  }

  // ------------------------------------------------------------ 异常清单（静态段在前）

  @Get('exceptions')
  @ApiOperation({
    summary: 'S9 未出单异常清单',
    description:
      '「某一天为什么没出单」的可执行答案。`date` **必填**。\n\n' +
      '典型原因：**出餐确认未完成**（父行实收量只覆盖已确认的中心 → 按它出单会少付、' +
      '按计划量补齐会多付，故系统不猜）、供应商**资质异常**、实收量为 0。\n\n' +
      '补齐后重跑「生成应付」即可补出；已出单的行不会出现在本清单里。',
  })
  exceptions(@Query() q: ShareExceptionsQueryDto) {
    return this.shares.exceptions(q);
  }

  // ------------------------------------------------------------ 生成应付（资金动作 · 收窄）

  @Post('generate')
  @Roles('super_admin', 'admin', 'finance')
  @OperationLog({ module: 'finance', action: '生成应付单' })
  @ApiOperation({
    summary: 'S9 生成应付单（幂等 · 可重跑）',
    description:
      '跑批（T+1 02:00）与运营手动补跑共用同一执行口。`date` 必填（出单对象是「某个出餐日的交付量」）。\n\n' +
      '**幂等键** = (供应商 · 菜品 · 出餐日)：已有应付行则进 `skipped`，不会重复出单，可安全重跑。\n\n' +
      '出参同时给出 `created`（出了什么）/ `skipped`（已存在）/ `exceptions`（**为什么没出**）—— ' +
      '第三项才是运营点完按钮最需要的。',
  })
  generate(@Body() dto: GenerateSharesDto, @CurrentAdmin('sub') operatorId: number) {
    return this.shares.generate(dto, operatorId);
  }

  // ------------------------------------------------------------ 付款登记（资金动作 · 收窄）

  @Post(':id/payment')
  @Roles('super_admin', 'admin', 'finance')
  @OperationLog({ module: 'finance', action: '应付付款登记', targetParam: 'id' })
  @ApiOperation({
    summary: 'S9 付款登记（人工对公转账后回填凭证 · C10）',
    description:
      '**系统只记账，不发起任何通道付款** —— 实际转账由财务走对公账户完成。\n\n' +
      '`paymentVoucherNo`（银行回单号）**必填** → 缺则 50013；它是「这笔钱确实付了」的唯一凭证。\n' +
      '`invoiceNo` 可选（自营口径下是税前扣除凭证，建议登记）。\n\n' +
      '⚠️ 仅 `pending` 可登记 → 否则 **50012**（重复登记就是重复出款）。' +
      '付款时刻取系统当前时间（刻意不收 `paidAt` 入参）—— 对账要的是诚实的时间戳。',
  })
  registerPayment(
    @Param() p: ShareIdParamDto,
    @Body() dto: RegisterPaymentDto,
    @CurrentAdmin('sub') operatorId: number,
  ) {
    return this.shares.registerPayment(p.id, dto, operatorId);
  }
}

import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { SupplierShareService } from '../finance/supplier-share.service';
import {
  CookConfirmDto,
  MAX_CONFIRM_ITEMS,
  PackingTasksQueryDto,
  SupplierSettlementQueryDto,
  SupplierWorkbenchQueryDto,
} from './dto/supplier.dto';
import { SupplierService } from './supplier.service';

/**
 * 供应商端 · 出餐链路 + 结算自查（《接口规范 v1.0》§6.5 S1–S3 / S9 供应商侧 · 原型 P21–P25）
 *
 * ## 主体与隔离（与后台 D 系列是**两套账号体系**）
 *   · 本控制器 `@Controller('supplier')` → 供应商 Web（`role=supplier`）
 *   · 运营后台走 `admin/suppliers/*`（见 `supplier-admin.controller.ts`）
 *   两者靠 `AdminGuard` 的 `typ` + `@Roles` 在**鉴权层**分开，不靠路径自觉。
 *
 * ## 数据范围收窄靠服务层，不靠路径
 *   `admin.guard.ts` 的既有纪律：供应商隔离 = `@Roles('supplier')`
 *   **+ 服务层用 token 里的 `supplierId` 收窄**。请求体里刻意**不接受** `supplierId`，
 *   否则就成了「A 供应商改 B 供应商的计划」。
 *
 * ## 只读不写日志
 *   S1 / S3 / S9 是 `GET`，**不标** `@OperationLog`（否则列表页会把日志表刷爆）；
 *   S2 是写操作（置送达确认、留责任人），必须留痕。
 *
 * ## 结算自查（S9 · M3-9）
 *   `GET settlement` 由 `SupplierShareService.supplierView()` 提供 —— **刻意复用财务侧
 *   同一个服务**，而不是在供应商模块里再读一遍表：应付行的结构与状态文案只有一份实现，
 *   就不会出现「运营看到的数」与「供应商看到的数」不一致。代价是 supplier 模块
 *   → finance 模块的单向依赖（无循环：FinanceModule 不反向依赖）。
 */
@ApiTags('供应商端·出餐与结算')
@ApiBearerAuth()
@Controller('supplier')
@UseGuards(AdminGuard)
@Roles('supplier')
export class SupplierController {
  constructor(
    private readonly supplier: SupplierService,
    private readonly shares: SupplierShareService,
  ) {}

  @Get('workbench')
  @ApiOperation({
    summary: 'S1 出餐工作台（P21）',
    description:
      '当日（或 `date` 指定日）出餐计划 + 按集散中心拆分的配送清单。' +
      '`date` 缺省取「本供应商最近一个有生产计划的出餐日」——不写死明天，' +
      '因为周末或停团时最近有计划的日子可能不是明日。' +
      '`deadline` 给出确认截止（出餐日当天 09:30）与是否已过点；' +
      '`supplier.canServe` 是出餐前置判据（合作中 ∧ 资质已通过 ∧ 证照未过期），' +
      '页面上要显式提示，别让供应商点了按钮才发现被拦。' +
      '`summary.empty=true` 表示当日没有派到任何生产计划（断团 / 截单后未生成），端上走空态。',
  })
  workbench(
    @Query() q: SupplierWorkbenchQueryDto,
    @CurrentAdmin('supplierId') supplierId: number | null,
  ) {
    return this.supplier.workbench(supplierId, q);
  }

  @Post('meal/cook-confirm')
  @OperationLog({ module: 'supplier', action: '出餐确认' })
  @ApiOperation({
    summary: 'S2 出餐确认（P22 · 须在出餐日 09:30 前）',
    description:
      '按 **(菜, 集散中心)** 逐项确认送达 —— 与原型 P22 的交互粒度一致' +
      '（一道菜要分别送到 N 个集散中心，每个中心各自确认）。\n\n' +
      '**09:30 是 deadline 而非 earliest**：提前确认允许（备好即可报），' +
      '只有迟于出餐日当天 09:30 才拒（50009，fail-closed，不接受补确认）。\n\n' +
      `**幂等**：已确认项原样进 \`skipped\`，不报错、不改时间戳（网络重试是常态）。\n\n` +
      '`actualQuantity` 不传 = 足额送达；传了则以申报值为准（**短送留痕是对账与结算的依据**）。\n\n' +
      '前置校验顺序：资质（50001）→ 时间（50009）→ 生产计划存在（50010）→ 配送范围（50011）。\n\n' +
      `一次最多提交 ${MAX_CONFIRM_ITEMS} 项。`,
  })
  cookConfirm(
    @Body() dto: CookConfirmDto,
    @CurrentAdmin('supplierId') supplierId: number | null,
    @CurrentAdmin('sub') adminId: number | null,
  ) {
    return this.supplier.cookConfirm(supplierId, adminId, dto);
  }

  @Get('packing-tasks')
  @ApiOperation({
    summary: 'S3 集散中心打包任务（P21/P22 下游）',
    description:
      '**仅对名下挂了启用中集散中心的主体可见**（原型的集散型 / 混合型）。' +
      '无集散中心时返回 `visible=false` + `reason`（HTTP 200）——' +
      '「你没有这项任务」是正常状态，不是错误，不该让端上走报错分支。\n\n' +
      '`ready` = 该中心当日**所有**菜品均已确认送达，才允许开包；' +
      '未到齐时 `blockers` 列出欠的供应商与菜品（原型「出餐确认后推送给集散中心」的落地）。\n\n' +
      '`routes` 是路线派生（R 编号 / 站点链 / 各楼群份数），' +
      '**不返回距离与单段时长** —— 无地图数据，原型上的 km/分钟是演示值。',
  })
  packingTasks(
    @Query() q: PackingTasksQueryDto,
    @CurrentAdmin('supplierId') supplierId: number | null,
  ) {
    return this.supplier.packingTasks(supplierId, q);
  }

  @Get('settlement')
  @ApiOperation({
    summary: 'S9 我的应付结算明细（P25 · M3-9）',
    description:
      '**只读自己的**：范围由 token 内的 `supplierId` 收窄，**不支持传入 `supplierId`**。\n\n' +
      '计费基数 = **实收量**（你在出餐确认里申报的实送份数；未申报视为足额）—— ' +
      '平台采购是「交多少付多少」，与终端卖没卖出去无关。\n\n' +
      '`summary.pendingTotalAmountFen` 是**跨日期的待付合计**（「平台还欠我多少」）。\n\n' +
      '⚠️ 本接口**不含**终端售价 ¥25.80、佣金、毛利、成本合计 —— ' +
      'B2B 采购关系下供应商只该知道「我的协商价 × 我的交付量」。',
  })
  settlement(
    @Query() q: SupplierSettlementQueryDto,
    @CurrentAdmin('supplierId') supplierId: number | null,
  ) {
    return this.shares.supplierView(supplierId, q.date);
  }
}

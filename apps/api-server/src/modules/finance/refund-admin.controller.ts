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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { IdempotentInterceptor } from '../../common/interceptors/idempotent.interceptor';
import {
  AdminRefundsQueryDto,
  ApproveRefundDto,
  BatchApproveRefundDto,
  BatchRejectRefundDto,
  BatchApproveByScopeDto,
  BatchRejectByScopeDto,
  BatchRefundPreviewDto,
  RejectRefundDto,
  RefundIdParamDto,
} from './dto/refund-admin.dto';
import { FINANCE_READ_ROLES, FUND_ACTION_ROLES } from './finance.constants';
import { RefundAdminService } from './refund-admin.service';
import { RefundBatchService } from './refund-batch.service';

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
  constructor(
    private readonly refundAdmin: RefundAdminService,
    private readonly refundBatch: RefundBatchService,
  ) {}

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

  // ------------------------------------------------------------ E5 批量（声明在 `:id/*` 之前）

  @Post('batch-approve')
  @UseInterceptors(IdempotentInterceptor)
  // ⭐ 与 D41 同口径：`required: false`。
  //    批量的**重试安全不靠幂等键** —— 靠两点：① 下游每笔的原子占位
  //    （`WHERE id=? AND status='applying'`，重复提交撞 40013）；② 结果按
  //    成功 / 跳过 / 失败三类归并，重试时已成功的归入 `skipped` 而不是报错。
  //    ⇒ 同一个批次带同一个键重复提交，会拿到**首次结果**（含失败清单），
  //    这正是运营想要的；但**换一批勾选必须换新键**，否则会拿到上一批的结果。
  @Idempotent({ scope: 'refund-batch-approve', required: false })
  @Roles(...FUND_ACTION_ROLES)
  @OperationLog({ module: 'finance', action: '批量退款审批通过' })
  @ApiOperation({
    summary: 'E5 批量审批通过（D41 的批量形态）',
    description:
      '逐笔走**既有的单笔审批执行口**（账务口径零分叉），串行提交、每笔独立成败。' +
      '出参按 succeeded / skipped（已不是待审批，多半上一轮已处理）/ failed 三类分别返回，' +
      '**绝不把部分成功报成全部成功或全部失败** —— 这两谎报会让运营重复退或漏退。' +
      'ids 中有任一不存在 → 整批拒绝（40012），资金零变动。单次上限见 40028。',
  })
  batchApprove(@Body() dto: BatchApproveRefundDto, @CurrentAdmin('sub') operatorId: number) {
    return this.refundBatch.batchApprove(dto.ids, operatorId, dto.remark);
  }

  @Post('batch-reject')
  @UseInterceptors(IdempotentInterceptor)
  @Idempotent({ scope: 'refund-batch-reject', required: false })
  @Roles(...FUND_ACTION_ROLES)
  @OperationLog({ module: 'finance', action: '批量退款审批驳回' })
  @ApiOperation({
    summary: 'E5 批量驳回（D42 的批量形态）',
    description:
      'reason 必填 ≥2 字，逐笔写入 `ab_refund.audit_remark`（批量不降低留痕标准）。' +
      '资金零变动：驳回只回退订单状态，不碰余额与佣金。三类结果与批量通过同口径。',
  })
  batchReject(@Body() dto: BatchRejectRefundDto, @CurrentAdmin('sub') operatorId: number) {
    return this.refundBatch.batchReject(dto.ids, operatorId, dto.reason);
  }

  // ------------------------------------------------------------ E5 台账口径 · 按配送日 / 楼宇

  @Post('scope-preview')
  @Roles(...FUND_ACTION_ROLES)
  @ApiOperation({
    summary: 'E5 按配送日 / 楼宇批量 —— 预览（**只算不执行**）',
    description:
      '条件批量必须先看这一步：把「命中几笔 · 多少钱 · 都是哪些」摆出来。' +
      '返回的 `count` / `amountFen` 要在执行时**原样带回**（服务端重算比对，' +
      '不一致 → 40029）—— 等于给这批数据上一把乐观锁，杜绝「看到的」与「退的」不是同一批。',
  })
  scopePreview(@Body() dto: BatchRefundPreviewDto) {
    return this.refundBatch.previewScope({
      mealDate: dto.mealDate,
      buildingId: dto.buildingId ?? null,
    });
  }

  @Post('scope-approve')
  @UseInterceptors(IdempotentInterceptor)
  @Idempotent({ scope: 'refund-scope-approve', required: false })
  @Roles(...FUND_ACTION_ROLES)
  @OperationLog({ module: 'finance', action: '按配送日批量退款' })
  @ApiOperation({
    summary: 'E5 按配送日 / 楼宇批量 —— 审批通过',
    description:
      '**断点续退**：一次最多处理 `limit` 笔（缺省与上限均 50），出参 `remaining` = 还剩几笔。' +
      '再点一次即可继续 —— 已处理的不再处于 `applying`，下次命中集里根本没有它们，' +
      '故不需要游标或断点表，也不会重复退。' +
      '必带 `expectedCount` / `expectedAmountFen`（预览给的数字），对不上 → 40029。',
  })
  scopeApprove(@Body() dto: BatchApproveByScopeDto, @CurrentAdmin('sub') operatorId: number) {
    return this.refundBatch.approveByScope(
      { mealDate: dto.mealDate, buildingId: dto.buildingId ?? null },
      { count: dto.expectedCount, amountFen: dto.expectedAmountFen },
      operatorId,
      dto.remark,
      dto.limit,
    );
  }

  @Post('scope-reject')
  @UseInterceptors(IdempotentInterceptor)
  @Idempotent({ scope: 'refund-scope-reject', required: false })
  @Roles(...FUND_ACTION_ROLES)
  @OperationLog({ module: 'finance', action: '按配送日批量驳回' })
  @ApiOperation({
    summary: 'E5 按配送日 / 楼宇批量 —— 驳回',
    description: 'reason 必填 ≥2 字；断点续退与乐观锁比对口径同 `scope-approve`。',
  })
  scopeReject(@Body() dto: BatchRejectByScopeDto, @CurrentAdmin('sub') operatorId: number) {
    return this.refundBatch.rejectByScope(
      { mealDate: dto.mealDate, buildingId: dto.buildingId ?? null },
      { count: dto.expectedCount, amountFen: dto.expectedAmountFen },
      operatorId,
      dto.reason,
      dto.limit,
    );
  }

  // ------------------------------------------------------------ D41 通过

  @Post(':id/approve')
  @UseInterceptors(IdempotentInterceptor)
  // ⭐ `required: false`（2026-09-18 · 缺陷 #80 收口）：本端点**已有**数据库级闸门
  //    （`approveByAdmin` 对退款单行做原子占位 `WHERE id=? AND status='applying'`），
  //    幂等键在这里是**第二层**（挡网络重试 / 双击的重复提交，让端上拿到首次结果而不是
  //    一条「状态已变」的错）。故**不强制**要求请求头 —— 否则 curl / e2e / 其它后台
  //    集成方一律撞 10001，等于给闸门加了一道与人无关的门槛。
  @Idempotent({ scope: 'refund-approve', required: false })
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
  @UseInterceptors(IdempotentInterceptor)
  @Idempotent({ scope: 'refund-reject', required: false })
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

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { REFUND_STATUS_LABEL } from '@abox/shared-types';

import { REFUND_BATCH_MAX_IDS } from '../../../common/utils/refund-batch';

/** 与 `REFUND_STATUS_LABEL` 同源（端上不维护第二份映射） */
const REFUND_STATUSES: string[] = Object.keys(REFUND_STATUS_LABEL);
const STATUS_HINT = Object.entries(REFUND_STATUS_LABEL)
  .map(([k, v]) => `${k}(${v})`)
  .join(' / ');

/** 审批页 Tab（语义糖，服务端展开成 status 集合 —— 端上不该自己拼状态集合） */
export const REFUND_TABS = ['pending', 'approved', 'rejected', 'refunded', 'all'] as const;

/**
 * D40 · 退款流水查询（《接口规范》§6.5 · 审批页 P34）
 *
 * `tab` 是给页面用的语义糖：`pending` = 待审批（`applying`）；
 * `approved` = 已批准/退款中（`approved` + `refunding`，一期同事务内会立刻转
 * `refunded`，故这一栏常态为空）；`refunded` / `rejected` 为终态。
 * 需要精确到某个状态时用 `status`。
 */
export class AdminRefundsQueryDto {
  @ApiPropertyOptional({ description: `精确状态过滤：${STATUS_HINT}` })
  @IsOptional()
  @IsIn(REFUND_STATUSES, { message: `status 需为：${STATUS_HINT}` })
  status?: string;

  @ApiPropertyOptional({
    description:
      '页面 Tab：pending 待审批 / approved 已通过 / rejected 已驳回 / refunded 已退款 / all 全部',
    enum: REFUND_TABS,
  })
  @IsOptional()
  @IsIn(REFUND_TABS as unknown as string[], {
    message: 'tab 需为 pending/approved/rejected/refunded/all',
  })
  tab?: (typeof REFUND_TABS)[number];

  @ApiPropertyOptional({
    description: '关键词：退款单号 / 订单号 / 用户昵称',
    example: 'RF20260915',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;

  @ApiPropertyOptional({
    description: '出餐日 YYYY-MM-DD（运营的天然时间轴）',
    example: '2026-09-16',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'mealDate 需为 YYYY-MM-DD' })
  mealDate?: string;

  @ApiPropertyOptional({ description: '页码，默认 1' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数，默认 20，上限 100' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

/** 路径参数：退款单 id */
export class RefundIdParamDto {
  @ApiProperty({ description: '退款单 id（ab_refund.id，不是 refundNo）', example: 12 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  id!: number;
}

/**
 * D41 · 审批通过
 *
 * 无需入参校验金额：可退额以**服务端重算**为准（`total_amount − discount_amount`），
 * 与退款单不一致时直接 `40011` 拒绝 —— 审批是资金动作，不接受端上算出来的数字。
 * `remark` 只是留痕（写 `ab_refund.audit_remark`）。
 */
export class ApproveRefundDto {
  @ApiPropertyOptional({ description: '审批备注（留痕用）', example: '已电话核实，同意退款' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;
}

/**
 * D42 · 审批驳回
 *
 * `reason` **必填**且至少 2 字：驳回是有后果的动作（订单状态回退），
 * 且团长/用户后续一定会问「为什么不同意」，没有理由的驳回等于没有审计。
 */
/**
 * E5 · 批量审批通过（D41 的批量形态）
 *
 * ## 只收**显式 id 列表**，不收「按条件批量」
 * 刻意不提供 `mealDate` / `buildingId` / `status` 之类的条件入参：
 * 「把这个出餐日所有待审批的全退了」是最危险的形状 —— 运营看不到自己到底选了谁，
 * 一旦条件写宽，钱就在无人核对的情况下批量出门（与 `ADR-N1N2W1` §D-N2-3 同一取舍）。
 * 显式 id 至少保证：运营在列表里**逐个勾过**，且返回能逐条对上号。
 *
 * ## 为什么 `ids` 上限由服务端收口
 * 上限写在 `REFUND_BATCH_MAX_IDS`（`common/utils/refund-batch.ts`）—— 与 `pageSize`
 * 一样是**服务端口径**，端上不自己定。校验器里这里只做「非空 + 每个是正整数」，
 * 规模超限由服务层报 `40028`（错误信息里带上限与实到数，运营直接知道该拆几批）。
 */
export class BatchApproveRefundDto {
  @ApiProperty({
    description: `退款单 id 列表（ab_refund.id，非退款单号）；去重后最多 ${REFUND_BATCH_MAX_IDS} 笔`,
    type: [Number],
    example: [11, 12, 13],
  })
  @IsArray({ message: 'ids 需为退款单 id 数组' })
  @ArrayMinSize(1, { message: '请至少勾选一笔退款单' })
  @Type(() => Number)
  @IsInt({ each: true, message: 'ids 中的每一项都需为整数' })
  @Min(1, { each: true, message: 'ids 中的每一项都需为正整数' })
  ids!: number[];

  @ApiPropertyOptional({
    description: '审批备注（同 D41，逐笔写入 ab_refund.audit_remark）',
    example: '楼宇临时封控，整批同意退款',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;
}

/**
 * E5 · 批量驳回（D42 的批量形态）
 *
 * `reason` 与单笔一样**必填 ≥2 字**：驳回会把订单状态回退，团长和用户一定会问为什么，
 * 批量只是把同一条理由写给 N 笔 —— 不因为「是批量」就降低留痕标准。
 */
export class BatchRejectRefundDto {
  @ApiProperty({
    description: `退款单 id 列表；去重后最多 ${REFUND_BATCH_MAX_IDS} 笔`,
    type: [Number],
    example: [11, 12, 13],
  })
  @IsArray({ message: 'ids 需为退款单 id 数组' })
  @ArrayMinSize(1, { message: '请至少勾选一笔退款单' })
  @Type(() => Number)
  @IsInt({ each: true, message: 'ids 中的每一项都需为整数' })
  @Min(1, { each: true, message: 'ids 中的每一项都需为正整数' })
  ids!: number[];

  @ApiProperty({
    description: '驳回理由（必填，≥2 字，逐笔写入 ab_refund.audit_remark）',
    example: '联系不上用户，暂不退款',
  })
  @IsString({ message: '请填写驳回理由' })
  @MinLength(2, { message: '驳回理由至少 2 个字' })
  @MaxLength(200)
  reason!: string;
}

/**
 * E5（台账原始口径）· **按配送日 / 楼宇**批量
 *
 * ## 三步式：预览 →（人看）→ 执行
 * 条件批量天然比勾选批量危险 —— 运营看不见自己选了谁。故**强制两步**：
 *   ① `preview` 把「命中几笔 · 多少钱 · 都是哪些」摆出来；
 *   ② 运营确认；
 *   ③ `execute` 必须把预览里的 `count` / `amountFen` **原样带回**，
 *      服务端重算比对，不一致 → 40029（等于给这批数据上了把乐观锁）。
 *
 * ## 断点续退
 * 一次只处理 `limit` 笔（缺省与上限均 50），出参带 `remaining`。
 * 剩下的再点一次即可 —— **不需要游标或断点表**：已处理的单不再处于 `applying`，
 * 下次命中集里自然没有它们（这也是「再点一次」不会重复退的原因）。
 */

/** 条件批量的公共入参 */
export class RefundBatchScopeDto {
  @ApiProperty({
    description: '配送日（出餐日 YYYY-MM-DD）—— 批量的**主条件**，必填',
    example: '2026-10-30',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'mealDate 需为 YYYY-MM-DD' })
  mealDate!: string;

  @ApiPropertyOptional({
    description: '楼宇 id（ab_building.id）；**不传 = 该配送日全部楼宇**',
    example: 3,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  buildingId?: number;
}

/** 预览（只算不执行，零资金动作） */
export class BatchRefundPreviewDto extends RefundBatchScopeDto {}

/** 按条件批量通过 */
export class BatchApproveByScopeDto extends RefundBatchScopeDto {
  @ApiProperty({ description: '预览返回的**可退笔数**（用于比对，防止期间集合变化）' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedCount!: number;

  @ApiProperty({ description: '预览返回的**合计金额（分）**' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedAmountFen!: number;

  @ApiPropertyOptional({
    description: `本次最多处理多少笔（断点续退的批大小，缺省与上限均 ${REFUND_BATCH_MAX_IDS}）`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ description: '审批备注（逐笔留痕）' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;
}

/** 按条件批量驳回 */
export class BatchRejectByScopeDto extends RefundBatchScopeDto {
  @ApiProperty({ description: '预览返回的可退笔数' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedCount!: number;

  @ApiProperty({ description: '预览返回的合计金额（分）' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedAmountFen!: number;

  @ApiPropertyOptional({ description: '本次最多处理多少笔' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiProperty({ description: '驳回理由（必填，≥2 字，逐笔留痕）' })
  @IsString({ message: '请填写驳回理由' })
  @MinLength(2, { message: '驳回理由至少 2 个字' })
  @MaxLength(200)
  reason!: string;
}

export class RejectRefundDto {
  @ApiProperty({
    description: '驳回理由（必填，≥2 字，写入 ab_refund.audit_remark）',
    example: '同一订单已重复申请，本次不予退款',
  })
  @IsString({ message: '请填写驳回理由' })
  @MinLength(2, { message: '驳回理由至少 2 个字' })
  @MaxLength(200)
  reason!: string;
}

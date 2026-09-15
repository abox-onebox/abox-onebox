import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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

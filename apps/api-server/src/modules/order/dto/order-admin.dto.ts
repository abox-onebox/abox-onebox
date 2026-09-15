import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { REFUND_REASON_LABEL, RefundReasonType } from '@abox/shared-types';

/** 退款原因取值（与 shared-types 单一来源） */
const REASON_TYPES: string[] = Object.values(RefundReasonType);
const REASON_HINT = Object.values(RefundReasonType)
  .map((v) => REFUND_REASON_LABEL[v])
  .join(' / ');

/** 订单列表 / 导出共用的过滤条件（D8 / D12） */
export class AdminOrdersQueryDto {
  @ApiPropertyOptional({ description: '出餐日（精确）YYYY-MM-DD', example: '2026-09-16' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'mealDate 需为 YYYY-MM-DD' })
  mealDate?: string;

  @ApiPropertyOptional({
    description: '出餐日起（区间，含）；mealDate 缺省时生效',
    example: '2026-09-01',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'startDate 需为 YYYY-MM-DD' })
  startDate?: string;

  @ApiPropertyOptional({ description: '出餐日止（区间，含）', example: '2026-09-30' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'endDate 需为 YYYY-MM-DD' })
  endDate?: string;

  @ApiPropertyOptional({ description: '办公楼 id' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  buildingId?: number;

  @ApiPropertyOptional({ description: '楼群 id' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId?: number;

  @ApiPropertyOptional({ description: '团长 id' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  leaderId?: number;

  @ApiPropertyOptional({
    description:
      '订单状态：pending_pay/paid/cut_off/cooked/delivering/delivered/completed' +
      '/cancelled/refund_applying/refunding/refunded',
  })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  status?: string;

  @ApiPropertyOptional({ description: '关键词：订单号 或 用户昵称' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;

  @ApiPropertyOptional({
    description:
      '视图：all 全部 / abnormal 异常（待支付超时 + 退款待处理）。' +
      '异常口径由服务端定义，端上不自造。',
    enum: ['all', 'abnormal'],
    default: 'all',
  })
  @IsOptional()
  @IsIn(['all', 'abnormal'], { message: 'tab 需为 all 或 abnormal' })
  tab?: 'all' | 'abnormal';

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

/**
 * D10 手动改单
 *
 * ⚠️ **改单给的是「目标值」而不是「增量」**。
 *    增量在重试下会翻倍：运营点了「+1」、请求超时、再点一次，就成了 +2，
 *    而订单看起来「改成功了」。目标值天然幂等 —— 重放多少次都是那个份数。
 */
export class ManualAdjustDto {
  @ApiProperty({ description: '订单号', example: 'AB20260916000001' })
  @IsString()
  @IsNotEmpty({ message: '请提供订单号' })
  @MaxLength(32)
  orderNo!: string;

  @ApiProperty({
    description:
      'change_quantity 改份数（目标值）/ change_building 改办公楼（目标值）。' +
      '「加/减」通过 quantity 目标值表达，不提供增量语义。',
    enum: ['change_quantity', 'change_building'],
  })
  @IsIn(['change_quantity', 'change_building'], {
    message: 'action 需为 change_quantity 或 change_building',
  })
  action!: 'change_quantity' | 'change_building';

  @ApiPropertyOptional({ description: '目标份数（action=change_quantity 时必填）', example: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  quantity?: number;

  @ApiPropertyOptional({ description: '目标办公楼 id（action=change_building 时必填）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  buildingId?: number;

  @ApiProperty({
    description: '改单原因（**必填**，写入操作日志的前后值快照）',
    example: '用户电话要求加 1 份',
  })
  @IsString()
  @MinLength(2, { message: '请填写改单原因（至少 2 个字）' })
  @MaxLength(200)
  reason!: string;
}

/**
 * D11 后台强制退款
 *
 * `amountFen` 是**防误操作参数**：前端把可退金额摆在二次确认弹窗里，运营照着填。
 * 与可退金额不符即 `40011` —— 这一填就排除了「看错订单」。一期只支持全额退款。
 */
export class ForceRefundDto {
  @ApiProperty({ description: '退款原因（**必填**）', example: '餐品异物，现场客诉' })
  @IsString()
  @MinLength(2, { message: '请填写退款原因（至少 2 个字）' })
  @MaxLength(200)
  reason!: string;

  @ApiPropertyOptional({
    description: '退款原因类型',
    enum: REASON_TYPES,
    example: RefundReasonType.QUALITY,
  })
  @IsOptional()
  @IsIn(REASON_TYPES, { message: `reasonType 需为：${REASON_HINT}` })
  reasonType?: string;

  @ApiPropertyOptional({
    description: '可退金额（分）· 防误操作校验：与可退金额不符 → 40011',
    example: 5160,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amountFen?: number;
}

/** D9 路径参数 */
export class OrderNoParamDto {
  @ApiProperty({ description: '订单号' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  orderNo!: string;
}

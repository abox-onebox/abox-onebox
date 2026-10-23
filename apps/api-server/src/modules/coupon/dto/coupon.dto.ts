import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import type {
  CouponObtainedFrom,
  CouponValidityType,
  GrantCouponBodyDto,
  UpsertCouponDefBodyDto,
} from '@abox/shared-types';

const VALIDITY_TYPES: CouponValidityType[] = ['days', 'period'];
const OBTAINED_FROM: CouponObtainedFrom[] = [
  'referral',
  'compensation',
  'manual',
  'system',
  'activity',
];

/** 后台创建 / 更新券种定义 */
export class UpsertCouponDefReqDto implements UpsertCouponDefBodyDto {
  @ApiProperty({ description: '券名称', example: '新人补偿券' })
  @IsString()
  @MaxLength(64)
  name!: string;

  @ApiProperty({ description: '面额（整数分）', example: 500 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  faceValueFen!: number;

  @ApiProperty({ description: '使用门槛（整数分）；0 = 无门槛', example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  thresholdFen!: number;

  @ApiProperty({ description: '有效期类型：days=领取后N天 / period=固定起止日', example: 'days' })
  @IsIn(VALIDITY_TYPES)
  validityType!: CouponValidityType;

  @ApiPropertyOptional({ description: 'validity_type=days 时有效：领取后 N 天', example: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  validDays?: number | null;

  @ApiPropertyOptional({ description: 'validity_type=period 时生效日 YYYY-MM-DD' })
  @IsOptional()
  @IsString()
  validFrom?: string | null;

  @ApiPropertyOptional({ description: 'validity_type=period 时失效日 YYYY-MM-DD' })
  @IsOptional()
  @IsString()
  validTo?: string | null;

  @ApiPropertyOptional({ description: '发行总量上限；省略 / null = 不限' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  totalLimit?: number | null;

  @ApiPropertyOptional({ description: '备注' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  remark?: string | null;
}

/** 后台更新券种定义（仅开放状态 / 备注 / 限量；面额、有效期不可改，避免影响已发放券） */
export class UpdateCouponDefReqDto {
  @ApiPropertyOptional({ description: '状态：active / inactive' })
  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: string;

  @ApiPropertyOptional({ description: '备注' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  remark?: string | null;

  @ApiPropertyOptional({ description: '发行总量上限；null = 不限' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  totalLimit?: number | null;
}

/** 后台手动发放（客服补偿） */
export class GrantCouponReqDto implements GrantCouponBodyDto {
  @ApiPropertyOptional({ description: '接收用户 id（与 userPhone 二选一）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId?: number;

  @ApiPropertyOptional({ description: '接收用户手机号（反查用户）' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  userPhone?: string;

  @ApiPropertyOptional({ description: '关联券种定义 id（用于回写 issuedCount / 限量校验）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  couponDefId?: number | null;

  @ApiPropertyOptional({ description: '券名称（省略时取券种定义名）' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @ApiProperty({ description: '面额（整数分，必填）', example: 500 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  faceValueFen!: number;

  @ApiPropertyOptional({ description: '使用门槛（整数分）；0 = 无门槛', example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  thresholdFen?: number;

  @ApiProperty({ description: '有效期类型：days / period', example: 'days' })
  @IsIn(VALIDITY_TYPES)
  validityType!: CouponValidityType;

  @ApiPropertyOptional({ description: 'validity_type=days 时有效' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  validDays?: number | null;

  @ApiPropertyOptional({ description: 'validity_type=period 时生效日 YYYY-MM-DD' })
  @IsOptional()
  @IsString()
  validFrom?: string | null;

  @ApiPropertyOptional({ description: 'validity_type=period 时失效日 YYYY-MM-DD' })
  @IsOptional()
  @IsString()
  validTo?: string | null;

  @ApiPropertyOptional({ description: '来源：referral/compensation/manual/system/activity' })
  @IsOptional()
  @IsIn(OBTAINED_FROM)
  obtainedFrom?: CouponObtainedFrom;

  @ApiPropertyOptional({ description: '发放备注（补偿原因等）' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  remark?: string | null;
}

/** 订单可用券查询（totalFen 由端上按单价×份数算出） */
export class AvailableCouponsQueryDto {
  @ApiPropertyOptional({ description: '订单总额（整数分），用于判定门槛是否满足' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  totalFen?: number;
}

/** 后台：发放记录查询 */
export class GrantQueryDto {
  @ApiPropertyOptional({ description: '按来源过滤' })
  @IsOptional()
  @IsIn(OBTAINED_FROM)
  obtainedFrom?: CouponObtainedFrom;

  @ApiPropertyOptional({ description: '按接收用户 id 过滤' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId?: number;
}

// 仅用于避免某些 lint 误报未使用导入；数组上限校验留给业务层
void ArrayMaxSize;
void IsNumber;

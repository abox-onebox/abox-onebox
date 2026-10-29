import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  MinLength,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import type {
  CouponGrantScope,
  CouponObtainedFrom,
  CouponValidityType,
  GrantCouponBatchBodyDto,
  GrantCouponBodyDto,
  RevokeCouponBodyDto,
  UpsertCouponDefBodyDto,
} from '@abox/shared-types';

const VALIDITY_TYPES: CouponValidityType[] = ['days', 'period'];
const GRANT_SCOPES: CouponGrantScope[] = ['all', 'building', 'phones', 'userIds'];
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

/**
 * 后台批量发放（2026-10-29）
 *
 * ⚠️ `dryRun: true` 与实发走**同一条路径**（见 service 头注）：端上先试算、
 *    把命中人数摆给运营看、再让他按确认 —— 而不是端上自己估一个数。
 *
 * ⚠️ `phones` / `userIds` 上限 500：不是技术上限，是**误操作上限** ——
 *    一次动作影响上千人时，「试算」这一步的意义会被稀释。
 */
export class GrantCouponBatchReqDto implements GrantCouponBatchBodyDto {
  @ApiProperty({
    description: '人群：all=全平台 / building=某栋楼 / phones=手机号清单 / userIds=用户 id 清单',
    enum: GRANT_SCOPES,
  })
  @IsIn(GRANT_SCOPES)
  scope!: CouponGrantScope;

  @ApiPropertyOptional({ description: 'scope=building 时必填' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  buildingId?: number | null;

  @ApiPropertyOptional({ description: 'scope=phones 时必填（最多 500 个）' })
  @IsOptional()
  @IsArray({ message: 'phones 需为手机号数组' })
  @ArrayMaxSize(500, { message: '单次最多 500 个手机号' })
  @IsString({ each: true, message: 'phones 中每一项都需为字符串' })
  phones?: string[];

  @ApiPropertyOptional({ description: 'scope=userIds 时必填（最多 500 个）' })
  @IsOptional()
  @IsArray({ message: 'userIds 需为用户 id 数组' })
  @ArrayMaxSize(500, { message: '单次最多 500 个用户 id' })
  @IsInt({ each: true, message: 'userIds 中每一项都需为整数' })
  @Min(1, { each: true, message: 'userIds 中每一项都需为正整数' })
  userIds?: number[];

  @ApiPropertyOptional({ description: '关联券种定义 id（回写 issuedCount / 限量校验）' })
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

  @ApiProperty({
    description: '发放原因（必填：进券备注与操作日志）',
    example: '10-29 出餐延误补偿',
  })
  @IsString()
  // ⚠️ 同单人发券：这是日后唯一能回答「为什么给这些人发钱」的信息，不允许一个字
  @MinLength(2, { message: '发放原因至少 2 个字（日后要靠它回答为什么发这笔券）' })
  @MaxLength(256)
  remark!: string;

  @ApiPropertyOptional({ description: 'true = 只试算不写库（返回预计命中人数等）' })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({ description: '幂等键；同键 = 同批，已发过的用户自动跳过' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotencyKey?: string | null;

  @ApiPropertyOptional({ description: '是否排除黑名单用户（默认 true）' })
  @IsOptional()
  @IsBoolean()
  excludeBlacklist?: boolean;
}

/** 后台回收代金券 */
export class RevokeCouponReqDto implements RevokeCouponBodyDto {
  @ApiProperty({
    description: '回收原因（必填；进操作日志，不占业务表列）',
    example: '误发，金额填错',
  })
  @IsString()
  @MaxLength(256)
  reason!: string;
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

// 数组上限校验已在 `GrantCouponBatchReqDto` 用 `ArrayMaxSize` 落实（此前这里只写
// `void ArrayMaxSize` 是为了压 lint 未使用告警 —— 现在真的用上了，不再需要压）。
void IsNumber;

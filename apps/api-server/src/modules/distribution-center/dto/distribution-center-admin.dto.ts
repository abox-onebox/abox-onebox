import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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

/**
 * 后台 · 集散中心配置 DTO（《接口规范 v1.0》§6.4 D29–D32 · C4 表驱动）
 *
 * ⚠️ **C4 纪律**：集散中心**不是硬编码 4 个**，而是 `ab_distribution_center` 表驱动、
 *    默认种子 4 个、可增删。因此这里没有任何「最多 4 个」的校验 ——
 *    写死数量就是违背 C4 的裁决本身。
 *
 * ⚠️ **C9 修订**：`rice_fee`（场地费）与 `pack_fee`（打包费）**默认均为 ¥0** ——
 *    集散复用合作供应商场地、打包由平台兼职承担。科目保留是为了按实际登记与审计，
 *    界面上要明确标注「默认 ¥0」而不是让运营以为漏填了。
 *
 * ⚠️ 金额入参用**分**（后缀 `Fen`），与供应商模块一致；落库转 DECIMAL(8,2) 元列。
 */

const PHONE_RE = /^1[3-9]\d{9}$/;

export class AdminDistributionCentersQueryDto {
  @ApiPropertyOptional({ description: '启用状态：1 启用 / 0 停用' })
  @IsOptional()
  @Type(() => Number)
  @IsIn([0, 1], { message: '状态需为 1（启用）或 0（停用）' })
  status?: number;

  @ApiPropertyOptional({ description: '按关联供应商过滤' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  supplierId?: number;

  @ApiPropertyOptional({ description: '按服务楼群过滤（JSON 数组包含判断）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId?: number;

  @ApiPropertyOptional({ description: '关键词：集散中心名 / 地址 / 关联供应商名（片段）' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  keyword?: string;

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

export class DistributionCenterIdParamDto {
  @ApiProperty({ description: '集散中心 id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  id!: number;
}

/** D30 新增集散中心（`address` 必填：实体为 NOT NULL，且它决定配送路线） */
export class CreateDistributionCenterDto {
  @ApiProperty({
    description: '集散中心名，如「集散中心 1（国贸片）」',
    example: '集散中心 5（望京片）',
  })
  @IsString()
  @MinLength(2, { message: '集散中心名至少 2 个字' })
  @MaxLength(64)
  name!: string;

  @ApiProperty({ description: '关联供应商 id（必须是集散型或混合型，否则 50008）' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  supplierId!: number;

  @ApiProperty({ description: '场地地址（复用合作供应商场地）' })
  @IsString()
  @MinLength(2, { message: '地址至少 2 个字' })
  @MaxLength(256)
  address!: string;

  @ApiPropertyOptional({ description: '联系人' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  contactName?: string;

  @ApiPropertyOptional({ description: '联系电话' })
  @IsOptional()
  @Matches(PHONE_RE, { message: '联系电话格式不正确' })
  contactPhone?: string;

  @ApiPropertyOptional({ description: '场地费（**分**）· C9 默认 0（复用供应商场地）', example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000000)
  riceFeeFen?: number;

  @ApiPropertyOptional({ description: '打包费（**分**）· C9 默认 0（平台兼职承担）', example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000000)
  packFeeFen?: number;

  @ApiPropertyOptional({ description: '服务的楼群 id 列表', type: [Number] })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  serviceGroups?: number[];

  @ApiPropertyOptional({ description: '启用状态：1 启用（默认）/ 0 停用' })
  @IsOptional()
  @Type(() => Number)
  @IsIn([0, 1], { message: '状态需为 1（启用）或 0（停用）' })
  status?: number;
}

/** D31 编辑（全部选填；含「关联供应商」与「结算参数」） */
export class UpdateDistributionCenterDto {
  @ApiPropertyOptional({ description: '集散中心名' })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: '集散中心名至少 2 个字' })
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({ description: '关联供应商 id（改挂主体时会校验新主体类型）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  supplierId?: number;

  @ApiPropertyOptional({ description: '场地地址' })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: '地址至少 2 个字' })
  @MaxLength(256)
  address?: string;

  @ApiPropertyOptional({ description: '联系人' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  contactName?: string;

  @ApiPropertyOptional({ description: '联系电话' })
  @IsOptional()
  @Matches(PHONE_RE, { message: '联系电话格式不正确' })
  contactPhone?: string;

  @ApiPropertyOptional({ description: '场地费（分）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000000)
  riceFeeFen?: number;

  @ApiPropertyOptional({ description: '打包费（分）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000000)
  packFeeFen?: number;

  @ApiPropertyOptional({
    description: '服务的楼群 id 列表（回传即**整体替换**，不是增量）',
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  serviceGroups?: number[];

  @ApiPropertyOptional({ description: '启用状态' })
  @IsOptional()
  @Type(() => Number)
  @IsIn([0, 1], { message: '状态需为 1（启用）或 0（停用）' })
  status?: number;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  ValidateIf,
} from 'class-validator';

import { BuildingGroupStatus, BuildingStatus, DistributionGap } from '@abox/shared-types';

/**
 * 后台 · 办公楼 / 楼群 DTO（《接口规范 v1.0》§6.3 D13–D18 · 原型 P37）
 *
 * ⚠️ 校验分层（与 M3-4/M3-5/M3-6 后台同一纪律）：
 *   类级装饰器 → 只管「类型 / 格式 / 枚举合法性」（失败即 10001）
 *   服务层     → 管「业务语义」（楼群不存在 60002、楼群非空不可停用 60003、
 *                重名 60004/60005）
 *
 * ⚠️ 全局 `ValidationPipe` 开了 `forbidNonWhitelisted` —— DTO 未声明的字段会被
 *   **直接拒绝（10001）而非静默忽略**。本文件的 `UpdateBuildingDto` **刻意不声明
 *   `leaderId`**：改「谁是这栋楼的团长」只有一个入口（D20 任命 / D21 变更），
 *   传了就在这里被拒 —— 见 `building-admin.service.ts` 文件头裁决 2。
 *
 * ⚠️ **经纬度按字符串收**：`ab_building.longitude/latitude` 是 DECIMAL(10,6)，
 *   精度靠字符串保真（`coordTransformer` 同一考虑）。用 number 收会先被
 *   JS 双精度截断一次，再落库 —— 座标漂移到米级，配送路线就算错了。
 */

const COORD_RE = /^-?\d{1,3}(\.\d{1,6})?$/;

/** 一次最多搬动的楼数（防误传全量 id 把整个楼群清空） */
const MAX_GROUP_MEMBERS = 200;

// ============================================================================
// D13 · 办公楼列表
// ============================================================================

export class AdminBuildingsQueryDto {
  @ApiPropertyOptional({ description: '楼群过滤' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '楼群 id 需为整数' })
  groupId?: number;

  @ApiPropertyOptional({
    description: '状态过滤：1 营业中 / 2 待开通 / 3 已暂停',
    enum: BuildingStatus,
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(Object.values(BuildingStatus), {
    message: '状态需为 1（营业中）/ 2（待开通）/ 3（已暂停）',
  })
  status?: number;

  @ApiPropertyOptional({
    description:
      '配送覆盖缺口过滤：none 已覆盖 / no_group 未归入楼群 / no_center 楼群无集散中心 / all_center_disabled 集散中心已停用',
    enum: DistributionGap,
  })
  @IsOptional()
  @IsIn(Object.values(DistributionGap), { message: '覆盖缺口类型不合法' })
  gap?: string;

  @ApiPropertyOptional({ description: '团长归属过滤：assigned 已有在职团长 / unassigned 待分配' })
  @IsOptional()
  @IsIn(['assigned', 'unassigned'], { message: '团长归属过滤需为 assigned 或 unassigned' })
  leaderState?: string;

  @ApiPropertyOptional({ description: '关键词（楼名 / 地址）' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;

  @ApiPropertyOptional({ description: '页码，从 1 起', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数（上限 100，见 §1.3）', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class BuildingIdParamDto {
  @ApiProperty({ description: '办公楼 id' })
  @Type(() => Number)
  @IsInt({ message: '办公楼 id 需为整数' })
  @Min(1)
  id!: number;
}

// ============================================================================
// D14 / D15 · 新增 / 编辑办公楼
// ============================================================================

export class CreateBuildingDto {
  @ApiProperty({ description: '办公楼名称（同名视为重复 → 60005）' })
  @IsString()
  @MinLength(2, { message: '办公楼名称至少 2 字' })
  @MaxLength(64)
  name!: string;

  @ApiProperty({ description: '地址（123 号令：证照地址须与线下门店一致，故楼址不能留空）' })
  @IsString()
  @MinLength(2, { message: '地址至少 2 字' })
  @MaxLength(256)
  address!: string;

  @ApiPropertyOptional({ description: '城市', default: '北京' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  city?: string;

  @ApiPropertyOptional({ description: '行政区' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  district?: string;

  @ApiPropertyOptional({ description: '经度（字符串，最多 6 位小数）' })
  @IsOptional()
  @IsString()
  @Matches(COORD_RE, { message: '经度格式不合法' })
  longitude?: string;

  @ApiPropertyOptional({ description: '纬度（字符串，最多 6 位小数）' })
  @IsOptional()
  @IsString()
  @Matches(COORD_RE, { message: '纬度格式不合法' })
  latitude?: string;

  @ApiPropertyOptional({ description: '楼层数' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(300)
  floorCount?: number;

  @ApiPropertyOptional({ description: '覆盖人数（运营估算，非实时统计）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000000)
  population?: number;

  @ApiPropertyOptional({
    description: '所属楼群 id；不传 = 未归群（未归群的楼无法分配套餐，D13 出参 gap=no_group）',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '楼群 id 需为整数' })
  @Min(1)
  buildingGroupId?: number;

  @ApiPropertyOptional({
    description: '状态：1 营业中（默认）/ 2 待开通 / 3 已暂停',
    enum: BuildingStatus,
    default: BuildingStatus.ACTIVE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(Object.values(BuildingStatus), { message: '状态需为 1 / 2 / 3' })
  status?: number;

  // ⚠️ 刻意不声明 leaderId —— 见文件头说明（改团长只有 D20/D21 一个入口）
}

export class UpdateBuildingDto {
  @ApiPropertyOptional({ description: '办公楼名称' })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: '办公楼名称至少 2 字' })
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({ description: '地址' })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: '地址至少 2 字' })
  @MaxLength(256)
  address?: string;

  @ApiPropertyOptional({ description: '城市' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  city?: string;

  @ApiPropertyOptional({ description: '行政区' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  district?: string;

  @ApiPropertyOptional({ description: '经度（字符串）' })
  @IsOptional()
  @IsString()
  @Matches(COORD_RE, { message: '经度格式不合法' })
  longitude?: string;

  @ApiPropertyOptional({ description: '纬度（字符串）' })
  @IsOptional()
  @IsString()
  @Matches(COORD_RE, { message: '纬度格式不合法' })
  latitude?: string;

  @ApiPropertyOptional({ description: '楼层数' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(300)
  floorCount?: number;

  @ApiPropertyOptional({ description: '覆盖人数（运营估算）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000000)
  population?: number;

  /**
   * 所属楼群 —— **传 `null` 表示移出楼群**（`@ValidateIf` 让 null 跳过 `@IsInt`）
   *
   * ⚠️ 为什么必须支持 null：运营要能表达「这栋楼暂停合作、退回未归群」。
   *    若只支持「传新楼群 id」，就永远无法把楼从楼群里摘出去，
   *    只能新建一个空壳楼群来当垃圾桶。
   */
  @ApiPropertyOptional({
    description: '所属楼群 id；传 null 表示移出楼群（不参与任何套餐分配）',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o: UpdateBuildingDto) => o.buildingGroupId !== null)
  @Type(() => Number)
  @IsInt({ message: '楼群 id 需为整数' })
  @Min(1)
  buildingGroupId?: number | null;

  @ApiPropertyOptional({
    description: '状态：1 营业中 / 2 待开通 / 3 已暂停',
    enum: BuildingStatus,
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(Object.values(BuildingStatus), { message: '状态需为 1 / 2 / 3' })
  status?: number;

  // ⚠️ 刻意不声明 leaderId —— 传了会被 forbidNonWhitelisted 拒（10001）
}

// ============================================================================
// D16 · 楼群列表
// ============================================================================

export class AdminBuildingGroupsQueryDto {
  @ApiPropertyOptional({
    description: '状态过滤：1 启用 / 2 停用',
    enum: BuildingGroupStatus,
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(Object.values(BuildingGroupStatus), { message: '楼群状态需为 1（启用）或 2（停用）' })
  status?: number;

  @ApiPropertyOptional({ description: '关键词（楼群名 / 描述 / 成员楼名）' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;

  @ApiPropertyOptional({ description: '页码，从 1 起', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

export class BuildingGroupIdParamDto {
  @ApiProperty({ description: '楼群 id' })
  @Type(() => Number)
  @IsInt({ message: '楼群 id 需为整数' })
  @Min(1)
  id!: number;
}

// ============================================================================
// D17 / D18 · 新建 / 编辑楼群
// ============================================================================

export class CreateBuildingGroupDto {
  @ApiProperty({ description: '楼群名（同名视为重复 → 60004）' })
  @IsString()
  @MinLength(2, { message: '楼群名至少 2 字' })
  @MaxLength(64)
  name!: string;

  @ApiPropertyOptional({ description: '说明' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;

  @ApiPropertyOptional({ description: '城市', default: '北京' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  city?: string;

  @ApiPropertyOptional({ description: '行政区' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  district?: string;

  @ApiPropertyOptional({
    description:
      '初始成员办公楼 id 列表（**整体设置**：这些楼会归入本楼群，原先属于别的楼群的会被搬过来）',
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_GROUP_MEMBERS, { message: `单次最多搬动 ${MAX_GROUP_MEMBERS} 栋楼` })
  @Type(() => Number)
  @IsInt({ each: true, message: '办公楼 id 需为整数' })
  buildingIds?: number[];
}

export class UpdateBuildingGroupDto {
  @ApiPropertyOptional({ description: '楼群名' })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: '楼群名至少 2 字' })
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({ description: '说明' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;

  @ApiPropertyOptional({ description: '城市' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  city?: string;

  @ApiPropertyOptional({ description: '行政区' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  district?: string;

  /**
   * 成员办公楼 —— **整体替换语义**（与 M3-6 D31 `serviceGroups` 同一纪律）
   *
   * ⚠️ 传 `[]` 即**清空成员楼**（不是「保持原值」）；传入列表**之外**的楼会被搬出本群。
   *    若实现成「空值 = 保持原值」，运营会以为解绑了、实际还挂着。
   */
  @ApiPropertyOptional({
    description: '成员办公楼 id 列表（整体替换；传 [] 即清空成员楼）',
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_GROUP_MEMBERS, { message: `单次最多搬动 ${MAX_GROUP_MEMBERS} 栋楼` })
  @Type(() => Number)
  @IsInt({ each: true, message: '办公楼 id 需为整数' })
  buildingIds?: number[];

  @ApiPropertyOptional({
    description: '状态：1 启用 / 2 停用（停用要求**成员楼已清空**，否则 60003）',
    enum: BuildingGroupStatus,
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(Object.values(BuildingGroupStatus), { message: '楼群状态需为 1（启用）或 2（停用）' })
  status?: number;
}

// ============================================================================
// 说明：坐标正则只允许「最多 6 位小数」，与 `ab_building` 的 DECIMAL(10,6) 对齐 ——
// 端上传 7 位小数会被拒（10001），而不是落库时被静默四舍五入。
// ============================================================================

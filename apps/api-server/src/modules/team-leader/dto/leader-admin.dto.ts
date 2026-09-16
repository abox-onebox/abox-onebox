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

import { LeaderAuditAction, LeaderLevel, LeaderStatus } from '@abox/shared-types';

/**
 * 后台 · 团长管理 DTO（《接口规范 v1.0》§6.3 D19–D22）
 *
 * ⚠️ 校验分层（与订单/退款后台同一纪律）：
 *   类级装饰器 → 只管「类型 / 格式」（失败即 10001）
 *   服务层     → 管「业务语义」（办公楼已有团长 20012 / 已是团长 20007 / 目标楼停用 …）
 *
 * ⚠️ 全局 `ValidationPipe` 开了 `forbidNonWhitelisted` —— DTO 未声明的字段会被
 *   **直接拒绝（10001）而非静默忽略**。因此 D21 刻意**不含 `status`**：
 *   停用/复职只有 D22 一个入口（见 `LeaderAuditAction` 的注释）。
 */

/** 名录视图：roster 团长名册 / applications 申请流水（P32 上方卡片） */
export const LEADER_VIEWS = ['roster', 'applications'] as const;
export type LeaderView = (typeof LEADER_VIEWS)[number];

/** D19 · 团长名录 / 申请流水查询 */
export class AdminLeadersQueryDto {
  @ApiPropertyOptional({
    description: 'roster 名录（默认）/ applications 申请流水',
    enum: LEADER_VIEWS,
  })
  @IsOptional()
  @IsIn(LEADER_VIEWS as unknown as string[], { message: 'view 需为 roster 或 applications' })
  view?: LeaderView;

  @ApiPropertyOptional({ description: '楼群 id（经 ab_building.building_group_id 归属）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId?: number;

  @ApiPropertyOptional({ description: '服务办公楼 id' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  buildingId?: number;

  @ApiPropertyOptional({ description: '等级过滤', enum: LeaderLevel })
  @IsOptional()
  @IsIn(Object.values(LeaderLevel), { message: '等级不合法' })
  level?: string;

  @ApiPropertyOptional({ description: '在职状态过滤：1 在职 / 2 停职', enum: LeaderStatus })
  @IsOptional()
  @Type(() => Number)
  @IsIn(Object.values(LeaderStatus), { message: '状态需为 1（在职）或 2（停职）' })
  status?: number;

  @ApiPropertyOptional({ description: '关键词：姓名 / 手机号（精确或片段）' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  keyword?: string;

  @ApiPropertyOptional({
    description: '履历单条查询：等于团长 id（D19 详情的备用入口，保持单表语义）',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  id?: number;

  @ApiPropertyOptional({
    description: '申请流水回溯天数（view=applications 时生效，默认 7，上限 90）',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;

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

/** 路径参数 `:id`（团长 id） */
export class LeaderIdParamDto {
  @ApiProperty({ description: '团长 id（ab_team_leader.id）', example: 1 })
  @Type(() => Number)
  @IsInt({ message: 'id 需为整数' })
  @Min(1, { message: 'id 不合法' })
  id!: number;
}

/**
 * D20 · 任命 / 转交团长
 *
 * 【转交语义】目标办公楼**已有在职团长**时：
 *   · 未传 `transferFromLeaderId` → **20012**（附 `data.occupiedBy`，端上弹确认框）
 *   · 传了且与现任一致 → 执行转交（现任置停职），留痕写明「转交给 X」
 * 之所以不默认顶替：一个误点就把别人经营中的楼换人，且对方的历史佣金归属还在他名下。
 */
export class AppointLeaderDto {
  @ApiProperty({
    description: '被任命的**已有用户** id（ab_user.id，必须先注册过小程序）',
    example: 6,
  })
  @Type(() => Number)
  @IsInt({ message: 'userId 需为整数' })
  @Min(1)
  userId!: number;

  @ApiProperty({ description: '拟服务的办公楼 id', example: 1 })
  @Type(() => Number)
  @IsInt({ message: 'buildingId 需为整数' })
  @Min(1)
  buildingId!: number;

  @ApiProperty({ description: '姓名（或「公司 · 姓名」）', example: '国贸三期 · 李明' })
  @IsString()
  @IsNotEmpty({ message: '姓名不能为空' })
  @MaxLength(32)
  realName!: string;

  @ApiProperty({
    description: '手机号（用作到楼提醒；与团长表一一对应，冲突 20004）',
    example: '13800000009',
  })
  @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不合法' })
  phone!: string;

  @ApiPropertyOptional({ description: '楼层，如 12F' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  floor?: string;

  @ApiPropertyOptional({
    description:
      '起始等级（默认 trainee 见习）—— 后台手工任命时一般保持见习，' +
      '让晋升审计（C2 双条件）自然抬升，避免一上任就给高费率',
    enum: LeaderLevel,
  })
  @IsOptional()
  @IsIn(Object.values(LeaderLevel), { message: '等级不合法' })
  level?: string;

  @ApiPropertyOptional({
    description: '转交确认：目标楼现任**在职**团长的 id。传错/传旧值一律 20012',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  transferFromLeaderId?: number;

  @ApiProperty({
    description: '任命/转交原因（≥2 字，写入操作日志）',
    example: '原团长调岗，转交张磊',
  })
  @IsString()
  @MinLength(2, { message: '原因至少 2 个字' })
  @MaxLength(200)
  reason!: string;
}

/**
 * D21 · 变更团长（**常规变更**：等级 / 所属办公楼 / 楼层）
 *
 * ⚠️ 刻意不含 `status` —— 停用/复职属「例外处理」，只走 D22。
 * ⚠️ 改 `level` 会**同步写 `commission_rate`**：等级只是标签，费率才是钱。
 *    历史上出现过「派生等级算出来了、费率没落库」的缺陷，此处反向同样成立 ——
 *    只改 level 不改 rate，会让佣金按旧费率结算，且界面上看不出矛盾。
 */
export class UpdateLeaderDto {
  @ApiPropertyOptional({ description: '目标等级（同时联动 commission_rate）', enum: LeaderLevel })
  @IsOptional()
  @IsIn(Object.values(LeaderLevel), { message: '等级不合法' })
  level?: string;

  @ApiPropertyOptional({ description: '目标服务办公楼 id（变更会同步 ab_user.building_id）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  buildingId?: number;

  @ApiPropertyOptional({ description: '楼层（传空字符串表示清空）' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  floor?: string;

  @ApiProperty({
    description: '变更原因（≥2 字，写入操作日志）',
    example: '金牌考核达标，手工调整为正式',
  })
  @IsString()
  @MinLength(2, { message: '原因至少 2 个字' })
  @MaxLength(200)
  reason!: string;
}

/**
 * D22 · 资质补录 / 例外处理
 *
 * ⚠️ **C3 口径提示**：团长**申请即生效、无前置审核**。本接口不是「审核入口」，
 *   只是事后留痕与纠偏。界面文案必须与 P32「提交申请即生效（无审核）」一致，
 *    否则会让运营以为存在待审核队列（原型 KPI 卡里「待审核申请」恒为 0 就是这个意思）。
 */
export class AuditLeaderDto {
  @ApiProperty({
    description: 'suspend 例外停用 / restore 恢复在职 / sign_agreement 协议补签 / note 资质备注',
    enum: LeaderAuditAction,
  })
  @IsIn(Object.values(LeaderAuditAction), { message: 'action 不合法' })
  action!: string;

  @ApiPropertyOptional({
    description: '协议版本号（action=sign_agreement 时必填，落 agreed_at / agree_version）',
    example: 'v1.0',
  })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  agreementVersion?: string;

  @ApiProperty({
    description: '原因 / 备注（≥2 字）。停用必须写清违规事实，便于日后申辩复核',
    example: '连续 3 次无故爽约，暂停团长资格',
  })
  @IsString()
  @MinLength(2, { message: '原因至少 2 个字' })
  @MaxLength(200)
  reason!: string;
}

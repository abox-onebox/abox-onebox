import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { ReceiveType } from '@abox/shared-types';

/**
 * 团长端 DTO（《接口规范》§4.5）
 *
 * ⚠️ 校验分层与订单模块一致：
 *   类级装饰器 → 只管「类型 / 格式」（失败即 10001）
 *   服务层     → 管「业务语义」（已是团长 20007 / 手机号占用 20004 / 办公楼未开通 …）
 *
 * ⚠️ 全局 `ValidationPipe` 开了 `forbidNonWhitelisted` —— DTO 未声明的字段会被**直接拒绝
 *    （10001）而非静默忽略**。因此「办公楼变更需后台审核」（L15）在本期**不开放**：
 *    `UpdateLeaderProfileReqDto` 刻意不含 `buildingId`，端上传了即被拒，避免绕过审核。
 */

/** L17 · 申请成为团长（C3：提交申请即生效，无人工审核） */
export class ApplyLeaderReqDto {
  @ApiProperty({ description: '拟服务的办公楼 id', example: 1 })
  @Type(() => Number)
  @IsInt({ message: 'buildingId 需为整数' })
  @Min(1, { message: 'buildingId 不合法' })
  buildingId!: number;

  @ApiProperty({
    description: '手机号（用于到楼下提醒取餐；与团长表一一对应，冲突返回 20004）',
    example: '13800000001',
  })
  @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不合法' })
  phone!: string;

  @ApiProperty({
    description: '姓名（或「公司 · 姓名」，与原型申请表单一致）',
    example: '北京某某公司 · 张某某',
  })
  @IsString()
  @MaxLength(32, { message: '姓名过长' })
  realName!: string;

  @ApiPropertyOptional({
    description: '所在楼层，如 12F（2026-09-15 裁定恢复该维度）',
    example: '12F',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  floor?: string;

  @ApiProperty({
    description: '已勾选同意的《团长合作协议》版本号 —— 缺失即视为未勾选，直接 10001',
    example: 'v1.0',
  })
  @IsString()
  @IsNotEmpty({ message: '请先勾选《团长合作协议》' })
  @MaxLength(16, { message: '协议版本号不合法' })
  agreementVersion!: string;
}

/** L18 · 勾选同意《团长合作协议》（补签 / 版本升级重签） */
export class LeaderAgreementReqDto {
  @ApiProperty({ description: '协议版本号', example: 'v1.0' })
  @IsString()
  @MaxLength(16)
  agreementVersion!: string;
}

/**
 * L15 · 修改团长资料（手机号 / 楼层 / 收款方式；办公楼变更需后台审核，本期不开放）
 *
 * ⚠️ 收款方式三字段是 **L12 提现的前置条件** —— 未绑定即提现返回 `40007`。
 *    落库时账号**脱敏存储**（`ab_team_leader.payout_account`）。
 */
export class UpdateLeaderProfileReqDto {
  @ApiPropertyOptional({
    description: '手机号（变更时查重，冲突返回 20004）',
    example: '13800000002',
  })
  @IsOptional()
  @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不合法' })
  phone?: string;

  @ApiPropertyOptional({ description: '楼层，如 12F', example: '12F' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  floor?: string;

  @ApiPropertyOptional({
    description: '收款方式：bank 银行卡 / alipay 支付宝（提现前置条件）',
    enum: ReceiveType,
  })
  @IsOptional()
  @IsIn(Object.values(ReceiveType), { message: '收款方式需为 bank 或 alipay' })
  payoutType?: string;

  @ApiPropertyOptional({ description: '收款账号（落库脱敏）', example: '6222021234567890123' })
  @IsOptional()
  @IsString()
  @MinLength(4, { message: '收款账号过短' })
  @MaxLength(64)
  payoutAccount?: string;

  @ApiPropertyOptional({ description: '收款人姓名', example: '李明' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  payoutName?: string;
}

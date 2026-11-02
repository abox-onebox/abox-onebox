import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** 预绑定 DTO（super_admin / admin 调用）。令牌留空字符串 = 清空该令牌。 */
export class UpsertWecomBindingDto {
  /**
   * ⚠️ 描述必填：这是**企微 userid**，不是平台用户 id —— 填错表现为「绑定成功但机器人不理你」。
   * 机器人问参数时只有 `@ApiProperty` 的描述会念给用户听，没有它就只剩干巴巴的 `userId`。
   */
  @ApiProperty({
    description:
      '企微 userid（**不是**平台用户 `ab_user.id`）：企微通讯录里该成员的唯一标识，' +
      '在企微「通讯录 → 成员资料」里取',
    example: 'ZhangSan',
  })
  @IsString()
  @MaxLength(64)
  userId!: string;

  @ApiProperty({ description: '这位同事的姓名（进审计日志与后台列表）', example: '张三' })
  @IsString()
  @MaxLength(64)
  operatorName!: string;

  /** 身份等级：owner=负责人（admin 角色，全端点）/ staff=同事（operator 角色，默认） */
  @ApiPropertyOptional({
    description: '身份等级：owner=负责人（全端点）/ staff=同事（默认，最小权限）',
    enum: ['owner', 'staff'],
  })
  @IsOptional()
  @IsIn(['owner', 'staff'])
  tier?: 'owner' | 'staff';

  /** 单独放权清单（端点编码）；省略 = 不改动已有清单 */
  @ApiPropertyOptional({
    description: '单独放权的端点编码清单；**省略 = 不改动**已有清单（与 `ops: []` 区分开）',
    example: ['get_admin_stats_dashboard'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  grantedOps?: string[];

  @ApiPropertyOptional({
    description: '该同事的执行令牌；**留空字符串 = 清空**（不传则不动）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  operatorToken?: string;

  @ApiPropertyOptional({ description: '审批令牌；留空字符串 = 清空（不传则不动）' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  approverToken?: string;
}

/** 只改身份等级（放权 / 收回） */
export class SetWecomTierDto {
  @IsIn(['owner', 'staff'])
  tier!: 'owner' | 'staff';
}

/**
 * 只改「单独放权的功能清单」。
 *
 * 传空数组 = 收回全部放权（安全动作：同事退回 operator 本来的能力，不会被他做不了任何事）。
 * 上限 200 是**远大于**当前目录条数（131）的保守闸门：它只防「一次塞几万条」的滥用，
 * 不承担「哪些编码合法」的判定 —— 那件事由 `normalizeGrant` 逐条对目录校验。
 */
export class SetWecomGrantDto {
  /**
   * ⚠️ 描述必填：用户（和机器人）得知道这里填的是**端点编码**、从哪抄。
   * 发「操作目录」可拿到全部编码；目录里已失效的编码会被丢弃并回传 `unknown`。
   */
  @ApiProperty({
    description:
      '要放权的**端点编码**列表（如 `get_admin_stats_dashboard`）；' +
      '让机器人发「操作目录」可拿到全部编码；传空数组 = 收回全部放权',
    example: ['get_admin_stats_dashboard', 'get_admin_orders'],
    type: [String],
  })
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ops!: string[];
}

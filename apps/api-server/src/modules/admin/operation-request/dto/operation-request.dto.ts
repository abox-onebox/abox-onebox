import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 阶段 3 可进审批流的 admin 高危 op（服务端权威，与 OPS_CATALOG.risk='admin' 一致；
 * 前端只填 op 代码，端点/方法由 `OperationRequestService.OP_ENDPOINTS` 内部映射，
 * 绝不让前端拼 `/admin` 路径 —— 防止「写错一个字母就静默变用户端可访问」的红线）。
 */
export const APPROVABLE_ADMIN_OPS = [
  'create_dish',
  'batch_dish_status',
  'edit_dish',
  'change_leader',
  'appoint_leader',
  'leader_audit',
] as const;

export type ApprovableAdminOp = (typeof APPROVABLE_ADMIN_OPS)[number];

/** 提交高危操作申请 */
export class CreateOperationRequestDto {
  @ApiProperty({
    description: 'op 代码（须为 admin 高危类）',
    enum: APPROVABLE_ADMIN_OPS,
  })
  @IsIn(APPROVABLE_ADMIN_OPS, { message: 'opCode 不在可审批范围' })
  opCode!: string;

  @ApiProperty({ description: '校验后的真实参数（执行时即作为目标接口 body）' })
  @IsObject()
  @IsNotEmpty()
  params!: Record<string, unknown>;

  @ApiPropertyOptional({ description: '知识助手自报操作人（X-KB-Operator）' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  submitterKb?: string;

  @ApiPropertyOptional({ description: '自然语言原文（X-KB-NL）' })
  @IsOptional()
  @IsString()
  submitterNl?: string;

  @ApiPropertyOptional({ description: '操作块 JSON（X-KB-OpBlock 原文）' })
  @IsOptional()
  // @IsOptional 同时是「白名单豁免」标记：否则 whitelist:true 会把它剥离
  submitterOpBlock?: unknown;
}

/** 驳回申请 */
export class RejectOperationRequestDto {
  @ApiProperty({ description: '驳回理由' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  reason!: string;
}

/** 列表查询 */
export class OperationRequestQueryDto {
  @ApiPropertyOptional({ description: '状态过滤：pending/approved/rejected/executed' })
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected', 'executed'])
  status?: string;

  @ApiPropertyOptional({ description: 'op 代码过滤' })
  @IsOptional()
  @IsString()
  opCode?: string;
}

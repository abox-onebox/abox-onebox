import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { AdminGuard } from '../../common/guards/admin.guard';
import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import type { JwtPayload } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { RecruitTaskcardService } from './recruit-taskcard.service';

/** 单张任务卡的确认决策 */
export class TaskCardDecisionDto {
  @ApiProperty({
    description: '楼 id（服务端 confirm 时重拉实时缺口白名单校验，不认本次 generate 的缓存）',
    example: 12,
  })
  @Type(() => Number)
  @IsInt({ message: 'buildingId 需为整数' })
  @Min(1, { message: 'buildingId 不合法' })
  buildingId!: number;

  @ApiProperty({ description: 'approve=批准出物料 / skip=跳过', enum: ['approve', 'skip'] })
  @IsIn(['approve', 'skip'], { message: 'decision 只能是 approve 或 skip' })
  decision!: 'approve' | 'skip';

  /**
   * ⭐ 必须把 generate 返回的原卡话术带回来（否则 confirm 只能用常量话术，
   * 运营在卡片上看到的 AI 文案与批准后复制的物料会不是同一段）。
   * 服务端不信任这些文本：revalidateTaskCard 会再跑一遍禁用词 + 测算示例闸。
   */
  @ApiPropertyOptional({ description: 'generate 返回的 AI 招募话术（服务端会再过合规闸）' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  pitchText?: string;

  @ApiPropertyOptional({ description: 'generate 返回的收益文案（必须含「测算示例」）' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  estimatedEarningText?: string;

  @ApiPropertyOptional({ description: 'generate 返回的优先理由（仅展示，不参与闸）' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** 逐卡确认入参：一批可含多卡，服务端逐卡独立处理（可部分成功） */
export class ConfirmTaskCardsDto {
  @ApiProperty({ description: '逐卡决策数组', type: [TaskCardDecisionDto] })
  @IsArray()
  @ArrayNotEmpty({ message: '没有可确认的任务卡' })
  @ValidateNested({ each: true })
  @Type(() => TaskCardDecisionDto)
  decisions!: TaskCardDecisionDto[];

  @ApiPropertyOptional({
    description: '操作人姓名兜底（服务端优先用 JWT 里的 username；仅在 JWT 无 username 时采用）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  actorName?: string;
}

/**
 * 后台 · 团长招募任务卡（AI 编排节点 G · 安全版）
 *
 * ## 闭环
 * 生成缺口任务卡（只读零副作用）→ 运营**逐卡**勾选 → 批准出物料（话术 + 裸申请路径）+ 记台账。
 *
 * ## 安全版硬边界（祝总 2026-11-17 拍板）
 * 本控制器**只有生成与出物料两个动作**：不自动发消息（不调 send_message）、
 * 不建团长（不调 appoint_leader）、不碰钱。系统对外一句话都不发。
 * 团长的产生由真人用户在小程序 `/leader/apply` 自行申请（C3 提交即生效，无审核）。
 *
 * ## 权限口径（挑刺 v1.1 修订）
 * - generate 是**只读**节点，operator 可看缺口卡（类级 @Roles 含 operator）。
 * - confirm 是**人工闸**，方法级 @Roles 收紧到 super_admin/admin。
 *
 * ## 逐卡确认
 * confirm 一次可提交多卡决策，但服务端逐卡独立复核：已被覆盖的楼会被拦下不出物料，
 * 不影响同批其它卡；同楼同日重复批准幂等（查 ab_ai_insight 台账，不重复写）。
 */
@Controller('admin/recruit-taskcard')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class RecruitTaskcardAdminController {
  constructor(private readonly svc: RecruitTaskcardService) {}

  /** 生成（只读，零副作用）：实时缺口 → AI 任务卡草稿 */
  @Post('generate')
  @ApiOperation({
    summary: 'G 生成招募任务卡（只读，不写库、不发消息；operator 可看）',
    description:
      '近30天有单楼 − 在职团长覆盖楼 = 招募缺口，交 AI 写成逐卡可确认的招募任务卡。' +
      '脚本缺失/超时降级回显原始缺口（degraded=true），绝不 500。',
  })
  generate() {
    return this.svc.generate();
  }

  /** 逐卡确认（人工闸，仅负责人）：实时复核 → 出物料 + 记台账 */
  @Post('confirm')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'recruit', action: 'G 招募任务卡逐卡确认' })
  @ApiOperation({
    summary: 'G 逐卡确认招募任务卡（人工闸，仅负责人）',
    description:
      '对每张卡做实时复核（楼可能已被覆盖/不在缺口楼），通过后产出「话术 + 裸申请路径」物料并记台账。' +
      '物料沿用 generate 返回的 AI 话术（服务端再过合规闸），不换成常量话术。' +
      '绝不发消息、绝不建团长、绝不替用户申请。同楼同日幂等。',
  })
  confirm(@Body() dto: ConfirmTaskCardsDto, @CurrentAdmin() admin: JwtPayload | undefined) {
    return this.svc.confirm({
      decisions: dto.decisions,
      // typ=admin 时 sub = ab_admin_user.id（AdminGuard 已保证主体类型）
      actorId: admin?.sub ?? null,
      actorName: admin?.username ?? dto.actorName ?? null,
    });
  }
}

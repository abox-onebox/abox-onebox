import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { AdminGuard } from '../../common/guards/admin.guard';
import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import type { JwtPayload } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { LeaderTaskcardService } from './leader-taskcard.service';
import type { LeaderStrategyCard } from '../../common/utils/leader-taskcard';

/** 单张处置卡的确认决策 */
export class LeaderCardDecisionDto {
  @ApiProperty({
    description: '处置卡类型（四类之一）',
    enum: ['agreementFollowup', 'silentWakeup', 'payoutFollowup', 'suspendReview'],
  })
  @IsString()
  @IsIn(['agreementFollowup', 'silentWakeup', 'payoutFollowup', 'suspendReview'])
  kind!: string;

  @ApiProperty({ description: 'approve=确认出执行清单 / skip=跳过', enum: ['approve', 'skip'] })
  @IsIn(['approve', 'skip'])
  decision!: 'approve' | 'skip';

  @ApiPropertyOptional({
    description:
      'generate 返回的原卡（approve 时必填；服务端实时复核后沿用其理由，事实以实时名册为准）',
  })
  @IsOptional()
  @IsObject()
  card?: Record<string, unknown>;
}

export class ConfirmLeaderCardsDto {
  @ApiProperty({ type: [LeaderCardDecisionDto], description: '逐卡决策列表' })
  @IsArray()
  @ArrayNotEmpty()
  decisions!: LeaderCardDecisionDto[];

  @ApiPropertyOptional({ description: '操作人（后台账号名；优先取 JWT）' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  actorName?: string;
}

/**
 * 后台 · 团长处置卡（AI 编排节点 N · 安全版）
 *
 * ## 闭环
 * 结构化处置卡（只读生成）→ 运营逐卡确认 → 出「可执行处置清单」+ 记台账 →
 * 人拿清单去后台 D22 自己核对事实后确认执行。
 *
 * ## 🚨 履约红线（祝总 2026-11-17 拍板）
 * 本控制器**没有任何真处置动作**：不调 leaderAdmin.audit、不 suspend、不 restore、
 * 不签协议、不改任何团长状态、不清用户归属。系统只吐清单 + 记台账；D22 是唯一
 * 真处置入口。suspend 会清用户归属，清单与页面均标红此风险。
 *
 * ## 权限口径（与 G / H / M 一致）
 * - generate 只读，operator 可看处置卡（类级 @Roles 含 operator）。
 * - confirm 是人工闸，方法级 @Roles 收紧到 super_admin/admin。
 */
@Controller('admin/leader-taskcard')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class LeaderTaskcardAdminController {
  constructor(private readonly svc: LeaderTaskcardService) {}

  /** 生成（只读，零副作用）：实时取数 → AI 处置卡草稿 */
  @Post('generate')
  @ApiOperation({
    summary: 'N 生成团长处置卡（只读，不写库、不停用；operator 可看）',
    description:
      '基于在职团长健康度分档，AI 出四类处置卡（事实以实时名册为准）。' +
      '脚本缺失/超时降级（degraded=true），绝不 500，绝不改团长状态。',
  })
  generate() {
    return this.svc.generate();
  }

  /** 逐卡确认（人工闸，仅负责人）：实时复核 → 出执行清单 + 记台账，不真停用 */
  @Post('confirm')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'leader', action: 'N 团长处置卡逐卡确认（只出清单不真停用）' })
  @ApiOperation({
    summary: 'N 逐卡确认团长处置卡（人工闸，仅负责人；不停用不清归属）',
    description:
      '实时复核团长是否仍在在职名册、动作是否合法、理由有无既成事实话术，通过后产出' +
      '「团长#id + 建议 D22 动作 + 事实依据 + 去哪页人工点」清单并记台账。' +
      '系统绝不调 audit、绝不停用、绝不清用户归属；真处置由人拿清单去 D22 核对后确认。同卡同日幂等。',
  })
  confirm(@Body() dto: ConfirmLeaderCardsDto, @CurrentAdmin() admin: JwtPayload | undefined) {
    return this.svc.confirm({
      decisions: dto.decisions.map((d) => ({
        kind: d.kind,
        decision: d.decision,
        // DTO 宽松接收；service 的 revalidateLeaderCard 会逐字段复核，非法卡被挡
        card: d.card as LeaderStrategyCard | undefined,
      })),
      actorId: admin?.sub ?? null,
      actorName: admin?.username ?? dto.actorName ?? null,
    });
  }
}

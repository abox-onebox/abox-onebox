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
import { CommunityTaskcardService } from './community-taskcard.service';
import type { CommunityScheduleCard } from '../../common/utils/community-taskcard';

/** 单日排期的确认决策 */
export class CommunityScheduleDecisionDto {
  @ApiProperty({
    description: '排期日（周一~周日）',
    enum: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
  })
  @IsString()
  @IsIn(['周一', '周二', '周三', '周四', '周五', '周六', '周日'])
  day!: string;

  @ApiProperty({ description: 'approve=确认出清单 / skip=跳过', enum: ['approve', 'skip'] })
  @IsIn(['approve', 'skip'])
  decision!: 'approve' | 'skip';

  @ApiPropertyOptional({
    description:
      'generate 返回的原卡（approve 时必填；服务端实时复核后沿用其话术，价格/面额以实时白名单为准）',
  })
  @IsOptional()
  @IsObject()
  card?: Record<string, unknown>;
}

export class ConfirmCommunityCardsDto {
  @ApiProperty({ type: [CommunityScheduleDecisionDto], description: '逐日决策列表' })
  @IsArray()
  @ArrayNotEmpty()
  decisions!: CommunityScheduleDecisionDto[];

  @ApiPropertyOptional({ description: '操作人（后台账号名；优先取 JWT）' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  actorName?: string;
}

/**
 * 后台 · 社群排期卡（AI 编排节点 P · 安全版）
 *
 * ## 闭环
 * 结构化排期卡（只读生成）→ 运营逐日确认 → 出「排期表 + 合规话术清单」+ 记台账 →
 * 人拿清单去群里手动发、去券管理页人工发券。
 *
 * ## 🚨 发消息红线（祝总 2026-11-17 拍板）
 * 本控制器**没有任何发消息/发券动作**：不调 wecomToken.sendText、不发群、不发券、不加好友。
 * 系统只吐清单 + 记台账；真人手动执行是唯一出口。
 * 话术合规闸（平台名含快团团 / 链接口令 / 既成事实）在生成与确认时双拦。
 *
 * ## 权限口径（与 G / H / M / N 一致）
 * - generate 只读，operator 可看排期卡（类级 @Roles 含 operator）。
 * - confirm 是人工闸，方法级 @Roles 收紧到 super_admin/admin。
 */
@Controller('admin/community-taskcard')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class CommunityTaskcardAdminController {
  constructor(private readonly svc: CommunityTaskcardService) {}

  /** 生成（只读，零副作用）：实时取数 → AI 排期卡草稿 */
  @Post('generate')
  @ApiOperation({
    summary: 'P 生成社群排期卡（只读，不发消息；operator 可看）',
    description:
      '基于靶楼分层 + 当期套餐/券白名单，AI 出一周排期与分档话术；话术逐条过合规闸' +
      '（平台名/链接/口令/既成事实必拦）。脚本缺失/超时降级（degraded=true），绝不 500，绝不发任何消息。',
  })
  generate() {
    return this.svc.generate();
  }

  /** 逐日确认（人工闸，仅负责人）：实时复核 → 出清单 + 记台账，不发消息 */
  @Post('confirm')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'wecom', action: 'P 社群排期卡逐日确认（只出清单不发消息）' })
  @ApiOperation({
    summary: 'P 逐日确认社群排期卡（人工闸，仅负责人；不发消息不发券）',
    description:
      '实时复核套餐/券是否仍在白名单、话术是否合规，通过后产出' +
      '「周几 + 靶楼档位 + 套餐/券（测算示例）+ 合规话术 + 去哪手动发」清单并记台账。' +
      '系统绝不调发消息接口、绝不发券、绝不加好友；人拿清单去群里手动执行。同日幂等。',
  })
  confirm(@Body() dto: ConfirmCommunityCardsDto, @CurrentAdmin() admin: JwtPayload | undefined) {
    return this.svc.confirm({
      decisions: dto.decisions.map((d) => ({
        day: d.day,
        decision: d.decision,
        // DTO 宽松接收；service 的 revalidateScheduleCard 会逐字段复核，非法卡被挡
        card: d.card as CommunityScheduleCard | undefined,
      })),
      actorId: admin?.sub ?? null,
      actorName: admin?.username ?? dto.actorName ?? null,
    });
  }
}

import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsArray, IsOptional, IsString } from 'class-validator';

import { AdminGuard } from '../../common/guards/admin.guard';
import { Roles } from '../../common/decorators/auth.decorator';
import { WecomChatService, type DailyNodeResult } from './wecom-chat.service';

/** 生成范围：节点 key（daily/meal/...）或台账 kind（daily-report/meal-proposal/...）均可 */
export class GenerateReportsDto {
  /** 只生成指定节点；不传 = 全部 12 个节点 */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  kinds?: string[];
}

/**
 * 后台 · AI 报告中心（批量生成）
 * ==================================================================
 * 与「AI 台账」页配套：台账读 `ab_ai_insight`，本控制器负责**生成**报告并留档。
 *
 * ## 硬边界（对齐 dryRun 语义）
 * - 只调 `generateReportsDryRun()` → `runDailyNodes()` 逐节点留档，**绝不推送企微**；
 * - 唯一写点 = `ab_ai_insight` 台账；不建表、不发券、不改订单、不推群；
 * - 生成是「留档给人看」，不是「执行」—— 真动作仍去各业务页人工做。
 *
 * ## 权限
 * 生成会写台账（12 条/次），收紧到 super_admin/admin；operator 只能在台账页看。
 */
@Controller('admin/ai-report')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin')
export class AiReportAdminController {
  constructor(private readonly chat: WecomChatService) {}

  /** 批量生成报告（只留档不外发）。返回逐节点结果与 pushed=false 证据 */
  @Post('generate')
  async generate(@Body() dto: GenerateReportsDto): Promise<{
    nodes: DailyNodeResult[];
    pushed: false;
    generated: number;
  }> {
    const r = await this.chat.generateReportsDryRun(dto.kinds);
    return { ...r, generated: r.nodes.length };
  }
}

import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsArray, IsOptional, IsString } from 'class-validator';

import { AdminGuard } from '../../common/guards/admin.guard';
import { Roles } from '../../common/decorators/auth.decorator';
import { WecomChatService, type DailyNodeResult } from './wecom-chat.service';
import { AiInsightService } from './ai-insight.service';

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
 * 读取（报告/体检）对 operator 开放，与台账页一致；生成会写台账（12 条/次），
 * `@Post generate` 单独收紧到 super_admin/admin。
 */
@Controller('admin/ai-report')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class AiReportAdminController {
  constructor(
    private readonly chat: WecomChatService,
    private readonly insights: AiInsightService,
  ) {}

  /**
   * 本周汇总（纯只读预览）：复用 broadcastWeekly 的汇总逻辑，**强制 dryRun=true**。
   * ⚠️ 绝不让前端传 dryRun —— 否则一个误点就会真推企微。这里写死 true，
   *    走 broadcastWeekly 的早返回分支，不推送、不写台账。
   */
  @Get('weekly-digest')
  async weeklyDigest(): Promise<{
    rangeFrom: string;
    rangeTo: string;
    total: number;
    byKind: Record<string, number>;
    byStatus: Record<string, number>;
    digest: string;
    pushed: false;
  }> {
    const r = await this.insights.broadcastWeekly({ dryRun: true });
    return {
      rangeFrom: r.rangeFrom,
      rangeTo: r.rangeTo,
      total: r.total,
      byKind: r.byKind,
      byStatus: r.byStatus,
      digest: r.digest,
      pushed: false,
    };
  }

  /** 数据体检（纯只读）：今天有没有数据可算、哪些节点会被跳过 */
  @Get('preflight')
  async preflight(): Promise<{
    at: string;
    result: {
      grade: string;
      headline: string;
      blockers: string[];
      notes: string[];
      skipNodes: string[];
    };
    text: string;
  }> {
    return this.chat.getPreflightReadonly();
  }

  /** 批量生成报告（只留档不外发）。返回逐节点结果与 pushed=false 证据 */
  @Post('generate')
  @Roles('super_admin', 'admin')
  async generate(@Body() dto: GenerateReportsDto): Promise<{
    nodes: DailyNodeResult[];
    pushed: false;
    generated: number;
  }> {
    const r = await this.chat.generateReportsDryRun(dto.kinds);
    return { ...r, generated: r.nodes.length };
  }
}

import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

import { AdminGuard } from '../../common/guards/admin.guard';
import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import type { JwtPayload } from '../../common/decorators/auth.decorator';
import {
  RecallCampaignService,
  type RecallConfirmResult,
  type RecallPreview,
  type RecallSegment,
} from './recall-campaign.service';

/**
 * 后台 · 复购 / 流失主动唤醒闭环（#C）
 *
 * ## 闭环
 * 预览（圈人 + 默认券方案）→ 人工确认 → 批量发券（幂等）→ 记台账 → 推负责人企微。
 *
 * ## 为什么手动触发（不建 cron）
 * 祝总铁律「禁自动定时」。本控制器两个端点都是**手动触发**：
 * 运营在后台点「生成唤醒方案」看圈人结果，再点「确认发放」才真正发券。
 *
 * ## 人工闸
 * 发券是**真写库、真触达用户**，故确认端点即使有 operator 角色也不自动跑——
 * 必须人来点「确认发放」。预览端点零副作用。
 */
export class RecallConfirmDto {
  /** 要发放的档位：repurchase=复购客 / churn=流失客 */
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(['repurchase', 'churn'], { each: true })
  segments!: RecallSegment[];

  /** 仅试算发券人数、不写库（券种仍会建）。默认 false = 真实发放 */
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  dryRun?: boolean;
}

@Controller('admin/recall-campaign')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class RecallCampaignAdminController {
  constructor(private readonly svc: RecallCampaignService) {}

  /** 预览：圈人 + 默认券方案（零副作用，不写库不发券） */
  @Post('preview')
  async preview(): Promise<RecallPreview> {
    return this.svc.preview();
  }

  /**
   * 确认发放：按所选档位建券种 + 批量发券（幂等）+ 记台账 + 推负责人企微。
   * 真写库、真触达，须人工点击。
   */
  @Post('confirm')
  async confirm(
    @Body() dto: RecallConfirmDto,
    @CurrentAdmin() admin: JwtPayload | undefined,
  ): Promise<RecallConfirmResult> {
    return this.svc.confirm({
      segments: dto.segments,
      dryRun: dto.dryRun ?? false,
      actorName: admin?.username ?? null,
    });
  }
}

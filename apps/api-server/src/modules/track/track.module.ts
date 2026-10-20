import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PageTrack } from '../../database/entities/system.entity';
import { PageTrackCleanupTask } from './page-track-cleanup.task';
import { TrackController } from './track.controller';
import { TrackService } from './track.service';

/**
 * 页面停留埋点模块（U15 · 2026-10-20）
 *
 * - 上报：`POST /track/page-duration`（**匿名免登录** · 批量 ≤ 20 条/次）
 * - 载体：新表 `ab_page_track`（第 30 张 · 只增 · 迁移 1700000000014）
 * - 清理：`PageTrackCleanupTask` 每日 03:30 删超 180 天的行
 *   （隐私政策第四节承诺的执行体；刻意不进 `TASK_SCHEDULES`，理由见其文件头）
 * - 口径：**匿名聚合** —— 无任何身份字段，DTO 在 whitelist +
 *   forbidNonWhitelisted 的全局 ValidationPipe 下连「多余字段」都进不来
 *   （详见 `dto/track.dto.ts` 头注与实体 `PageTrack` 头注）。
 *
 * ⚠️ 本模块**不导出** Service：埋点是「只写不读」的单向管道，后台聚合直接用 SQL
 *    （表上有 `idx_page_track_page_created (page, created_at)`），不提供查询端点 ——
 *    查询端点一旦存在就要论角色与脱敏，而匿名数据没有可脱敏的身份维度，
 *    更没有「谁能看」的既有裁决。要做得先立项。
 */
@Module({
  imports: [TypeOrmModule.forFeature([PageTrack])],
  controllers: [TrackController],
  providers: [TrackService, PageTrackCleanupTask],
})
export class TrackModule {}

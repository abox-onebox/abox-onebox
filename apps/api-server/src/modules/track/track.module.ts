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
 * ⚠️ **读侧已于 2026-10-30 立项并落地**（D77 · `GET /admin/stats/page-duration`）：
 *    本模块仍然**只写不读**（`TrackService` 不导出），聚合端点建在 **`StatsModule`**
 *    下 —— 理由：它是看板第五页，要复用看板的角色白名单（含 `viewer`，
 *    见 `stats-admin.controller.ts` 头注）与区间口径，放这里等于把看板权限再抄一份。
 *    ⛔ 原头注曾写「查询端点一旦存在就要论角色与脱敏…要做得先立项」——
 *      裁决已由项目负责人给出（匿名 ⇒ 无身份维度可脱敏，故按看板只读角色开放），
 *      本段按新事实改写，**不留「文档说不做、代码已做」的自相矛盾**。
 */
@Module({
  imports: [TypeOrmModule.forFeature([PageTrack])],
  controllers: [TrackController],
  providers: [TrackService, PageTrackCleanupTask],
})
export class TrackModule {}

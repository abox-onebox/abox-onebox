import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Building } from '../../database/entities/building.entity';
import { LeaderInvite, TeamLeader } from '../../database/entities/leader.entity';
import { User } from '../../database/entities/user.entity';
import { LeaderInviteService } from './invite.service';
import { LeaderLevelService } from './level.service';
import { TeamLeaderController } from './team-leader.controller';
import { TeamLeaderService } from './team-leader.service';

/**
 * 团长端（叠加身份）模块 · 见《接口规范 v1.0》§4 与《目录结构 v2.0》
 *
 * `LeaderGuard` 不在此注册 —— 它由 `CommonModule`（@Global）提供，全局可直接
 * `@UseGuards(LeaderGuard)`，避免各业务模块重复 import 团长表。
 *
 * `share.service.ts`（P19 分享中心 / 小程序码）属 M2-2.7，本期未实现，仍为骨架。
 */
@Module({
  imports: [TypeOrmModule.forFeature([TeamLeader, LeaderInvite, Building, User])],
  controllers: [TeamLeaderController],
  providers: [TeamLeaderService, LeaderInviteService, LeaderLevelService],
  exports: [TeamLeaderService, LeaderInviteService, LeaderLevelService],
})
export class TeamLeaderModule {}

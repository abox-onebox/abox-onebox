import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Building } from '../../database/entities/building.entity';
import { Balance, Commission } from '../../database/entities/finance.entity';
import { LeaderInvite, TeamLeader } from '../../database/entities/leader.entity';
import { DeliveryRecord, Order } from '../../database/entities/order.entity';
import { User } from '../../database/entities/user.entity';
import { Withdraw } from '../../database/entities/withdraw.entity';
import { LeaderInviteService } from './invite.service';
import { LeaderLevelService } from './level.service';
import { LeaderPromotionService } from './promotion.service';
import { ShareService } from './share.service';
import { TeamLeaderController } from './team-leader.controller';
import { TeamLeaderService } from './team-leader.service';
import { LeaderWorkbenchService } from './workbench.service';

/**
 * 团长端（叠加身份）模块 · 见《接口规范 v1.0》§4 与《目录结构 v2.0》
 *
 * `LeaderGuard` 不在此注册 —— 它由 `CommonModule`（@Global）提供，全局可直接
 * `@UseGuards(LeaderGuard)`，避免各业务模块重复 import 团长表。
 *
 * M2 已实装：L1 工作台 · L2/L3 分享与小程序码（`share.service`）·
 *            L14–L18 资料 / 等级规则 / 申请 / 协议留痕 ·
 *            **L20 退出团长 · L21 我的推荐 · L22 晋级核算 · 2.9 晋级审计链路**。
 *
 * ⚠️ 为 L20 的「资金闸门」与 L22 的「月单实算」直接注入了 finance 域的
 *    `Balance` / `Withdraw` / `Commission` **实体**（`forFeature`），而非依赖
 *    `FinanceModule` —— 实体级依赖不构成模块循环，且避免 `OrderModule → FinanceModule`
 *    之外再多出一条跨模块服务依赖链。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TeamLeader,
      LeaderInvite,
      Building,
      User,
      Order,
      DeliveryRecord,
      Balance,
      Withdraw,
      Commission,
    ]),
  ],
  controllers: [TeamLeaderController],
  providers: [
    TeamLeaderService,
    LeaderInviteService,
    LeaderLevelService,
    LeaderPromotionService,
    LeaderWorkbenchService,
    ShareService,
  ],
  exports: [
    TeamLeaderService,
    LeaderInviteService,
    LeaderLevelService,
    LeaderPromotionService,
    LeaderWorkbenchService,
    ShareService,
  ],
})
export class TeamLeaderModule {}

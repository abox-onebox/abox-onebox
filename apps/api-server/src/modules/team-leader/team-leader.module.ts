import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Building, BuildingGroup } from '../../database/entities/building.entity';
import { Balance, Commission } from '../../database/entities/finance.entity';
import { LeaderInvite, TeamLeader } from '../../database/entities/leader.entity';
import { DeliveryRecord, Order } from '../../database/entities/order.entity';
import { OperationLog } from '../../database/entities/system.entity';
import { User } from '../../database/entities/user.entity';
import { Withdraw } from '../../database/entities/withdraw.entity';
import { MessageModule } from '../message/message.module';
import { LeaderAdminController } from './leader-admin.controller';
import { LeaderAdminService } from './leader-admin.service';
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
 * M3-5 已实装：**D19–D22 后台团长管理**（`leader-admin.*` · 原型 P32）——
 *            名录 / 申请流水 / 筛选器 / 详情 / 任命与转交 / 常规变更 / 资质补录。
 *
 * ⚠️ 为 L20 的「资金闸门」与 L22 的「月单实算」直接注入了 finance 域的
 *    `Balance` / `Withdraw` / `Commission` **实体**（`forFeature`），而非依赖
 *    `FinanceModule` —— 实体级依赖不构成模块循环，且避免 `OrderModule → FinanceModule`
 *    之外再多出一条跨模块服务依赖链。
 * ⚠️ M3-5 沿用同一手法：`BuildingGroup`（名录按楼群筛选）、`OperationLog`
 *    （团长详情页要看「他是怎么被任命的」）均以**实体**方式注入。
 *    这也是为什么后台团长管理放在本模块而不是新建 `leader-admin` 模块 ——
 *    它读写的是同一批实体、同一套 C2 口径，拆开只会让「等级/费率」两处各写一遍。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TeamLeader,
      LeaderInvite,
      Building,
      BuildingGroup,
      User,
      Order,
      DeliveryRecord,
      Balance,
      Withdraw,
      Commission,
      OperationLog,
    ]),
    // M4-3：L17 申请成为团长后的「提交确认」通知（场景 `leader_apply`）
    MessageModule,
  ],
  controllers: [TeamLeaderController, LeaderAdminController],
  providers: [
    TeamLeaderService,
    LeaderInviteService,
    LeaderLevelService,
    LeaderPromotionService,
    LeaderWorkbenchService,
    ShareService,
    LeaderAdminService,
  ],
  exports: [
    TeamLeaderService,
    LeaderInviteService,
    LeaderLevelService,
    LeaderPromotionService,
    LeaderWorkbenchService,
    ShareService,
    LeaderAdminService,
  ],
})
export class TeamLeaderModule {}

import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HEADER } from '@abox/shared-types';

import { CurrentUser, JwtPayload } from '../../common/decorators/auth.decorator';
import { CurrentLeader } from '../../common/decorators/leader.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { LeaderGuard } from '../../common/guards/leader.guard';
import { IdempotentInterceptor } from '../../common/interceptors/idempotent.interceptor';
import { TeamLeader } from '../../database/entities/leader.entity';
import { ShareService } from './share.service';
import {
  ApplyLeaderReqDto,
  InviteListQueryDto,
  LeaderAgreementReqDto,
  QuitLeaderReqDto,
  UpdateLeaderProfileReqDto,
} from './dto/team-leader.dto';
import { LeaderInviteService } from './invite.service';
import { LeaderPromotionService } from './promotion.service';
import { TeamLeaderService } from './team-leader.service';
import { LeaderWorkbenchService } from './workbench.service';

/**
 * 团长端控制器（M2 · 《接口规范》§4.1 工作台 + §4.5 团长管理）
 *
 * 路由前缀 = `/api/v1/leader`（全局前缀在 `main.ts` 设置）。
 *
 * ⚠️ **身份纪律**（§1.5）：除 `apply` 外全部挂 `LeaderGuard` —— 它会在 JWT 之后再查一次
 *    `ab_team_leader` 确认在职，**不信任 token 里的 `isLeader`**（token 7 天有效期内团长
 *    可能已被停职）。
 * ⚠️ `POST /leader/apply` 反面**不能**挂守卫：调用它的正是「还不是团长」的用户。
 * ⚠️ 与 `leader-order` / `leader-finance` 共享 `/leader` 前缀，路径段互不冲突。
 */
@ApiTags('团长端')
@ApiBearerAuth()
@Controller('leader')
export class TeamLeaderController {
  constructor(
    private readonly teamLeaderService: TeamLeaderService,
    private readonly workbenchService: LeaderWorkbenchService,
    private readonly shareService: ShareService,
    private readonly inviteService: LeaderInviteService,
    private readonly promotionService: LeaderPromotionService,
  ) {}

  // ---------------------------------------------------------------- 工作台 M11

  @Get('workbench')
  @UseGuards(LeaderGuard)
  @ApiOperation({ summary: 'L1 今日战报 + 明日进度 + 取餐点配送状态' })
  workbench(@CurrentLeader() leader: TeamLeader) {
    return this.workbenchService.getWorkbench(leader);
  }

  @Get('share')
  @UseGuards(LeaderGuard)
  @ApiOperation({ summary: 'L2 分享物料（邀请码 / 小程序路径 / 海报底图）' })
  share(@CurrentLeader() leader: TeamLeader) {
    return this.shareService.getShareMaterial(leader);
  }

  @Post('share/qrcode')
  @UseGuards(LeaderGuard)
  @ApiOperation({ summary: 'L3 生成带团长 ID 的小程序码' })
  shareQrcode(@CurrentLeader() leader: TeamLeader, @Query('width') width?: string) {
    const n = Number(width);
    return this.shareService.generateQrcode(leader, Number.isFinite(n) && n > 0 ? n : 430);
  }

  // -------------------------------------------------------------- 团长管理 M15

  @Post('apply')
  @ApiOperation({ summary: 'L17 申请成为团长（C3：勾选协议后提交即生效，无审核）' })
  apply(@CurrentUser() user: JwtPayload, @Body() dto: ApplyLeaderReqDto) {
    return this.teamLeaderService.apply(user.sub, dto);
  }

  @Get('profile')
  @UseGuards(LeaderGuard)
  @ApiOperation({ summary: 'L14 团长资料' })
  profile(@CurrentLeader() leader: TeamLeader) {
    return this.teamLeaderService.getProfile(leader.userId);
  }

  @Put('profile')
  @UseGuards(LeaderGuard)
  @ApiOperation({ summary: 'L15 修改团长资料（手机号 / 楼层 / 收款方式）' })
  updateProfile(@CurrentLeader() leader: TeamLeader, @Body() dto: UpdateLeaderProfileReqDto) {
    return this.teamLeaderService.updateProfile(leader.userId, dto);
  }

  @Get('level-rules')
  @UseGuards(LeaderGuard)
  @ApiOperation({ summary: 'L16 4 级佣金规则 + C2 双条件升级门槛' })
  levelRules(@CurrentLeader() leader: TeamLeader) {
    return this.teamLeaderService.getLevelRules(leader.userId);
  }

  @Post('agreement')
  @UseGuards(LeaderGuard)
  @ApiOperation({ summary: 'L18 勾选同意《团长合作协议》（记录签署时间与版本号）' })
  agreement(@CurrentLeader() leader: TeamLeader, @Body() dto: LeaderAgreementReqDto) {
    return this.teamLeaderService.signAgreement(leader.userId, dto);
  }

  // ------------------------------------------------- 推荐裂变与晋级（M2-2.9）

  @Get('invites')
  @UseGuards(LeaderGuard)
  @ApiOperation({ summary: 'L21 我的推荐列表（邀请明细 + 转正汇总）' })
  invites(@CurrentLeader() leader: TeamLeader, @Query() q: InviteListQueryDto) {
    return this.inviteService.listMyInvites(Number(leader.id), q);
  }

  @Post('level/audit')
  @UseGuards(LeaderGuard)
  @ApiOperation({
    summary: 'L22 重新核算我的晋级进度（月单 + 介绍转正 → 落表并升级）',
  })
  auditLevel(@CurrentLeader() leader: TeamLeader) {
    return this.promotionService.audit(Number(leader.id));
  }

  // ------------------------------------------------------ 退出（M2-2.8）

  @Post('quit')
  @UseGuards(LeaderGuard)
  @UseInterceptors(IdempotentInterceptor)
  @Idempotent({ scope: 'leader-quit' })
  @ApiHeader({
    name: HEADER.IDEMPOTENCY_KEY,
    required: true,
    description: '幂等键（UUID）：退出属状态变更，重复提交返回 code:10006 + 首次结果',
  })
  @ApiOperation({
    summary: 'L20 退出团长身份（停职保留档案；余额/在途提现/待结算佣金未清则 20008）',
  })
  quit(@CurrentLeader() leader: TeamLeader, @Body() dto: QuitLeaderReqDto) {
    return this.teamLeaderService.quit(leader.userId, dto);
  }
}

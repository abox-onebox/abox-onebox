import { Body, Controller, Get, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HEADER } from '@abox/shared-types';

import { CurrentLeader } from '../../common/decorators/leader.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { LeaderGuard } from '../../common/guards/leader.guard';
import { IdempotentInterceptor } from '../../common/interceptors/idempotent.interceptor';
import { TeamLeader } from '../../database/entities/leader.entity';
import { CommissionService } from './commission.service';
import {
  BalanceLogQueryDto,
  LeaderCommissionQueryDto,
  WithdrawApplyReqDto,
  WithdrawalsQueryDto,
} from './dto/finance.dto';
import { WithdrawService } from './withdraw.service';

/**
 * 团长端 · 佣金与提现控制器（《接口规范》§4.4 · L10–L13）
 *
 * 路由前缀与 `team-leader` / `leader-order` 同为 `/api/v1/leader` ——
 * NestJS 允许多个控制器共享前缀，只要**路径段不冲突**：
 *   team-leader → workbench / share* / profile / level-rules / agreement / apply
 *   leader-order → orders* / pickup*
 *   leader-finance → commissions / balance / withdraw / withdrawals
 *
 * ⚠️ 全部挂 `LeaderGuard`（§1.5 身份二次校验）。
 */
@ApiTags('团长端 · 佣金与提现')
@ApiBearerAuth()
@Controller('leader')
export class LeaderFinanceController {
  constructor(
    private readonly commissionService: CommissionService,
    private readonly withdrawService: WithdrawService,
  ) {}

  @Get('commissions')
  @UseGuards(LeaderGuard)
  @ApiOperation({ summary: 'L10 佣金明细（range=day|month）' })
  commissions(@CurrentLeader() leader: TeamLeader, @Query() q: LeaderCommissionQueryDto) {
    return this.commissionService.listCommissions(leader, q);
  }

  @Get('balance')
  @UseGuards(LeaderGuard)
  @ApiOperation({ summary: 'L11 团长余额（提现/消费前的可用额）' })
  balance(@CurrentLeader() leader: TeamLeader) {
    return this.commissionService.getBalance(leader);
  }

  @Get('balance-logs')
  @UseGuards(LeaderGuard)
  @ApiOperation({ summary: 'L19 余额流水（佣金入账 / 下单抵扣 / 提现 / 退款回退）' })
  balanceLogs(@CurrentLeader() leader: TeamLeader, @Query() q: BalanceLogQueryDto) {
    return this.commissionService.listBalanceLogs(leader, q);
  }

  @Post('withdraw')
  @UseGuards(LeaderGuard)
  @UseInterceptors(IdempotentInterceptor)
  @Idempotent({ scope: 'withdraw' })
  @ApiHeader({
    name: HEADER.IDEMPOTENCY_KEY,
    required: true,
    description: '幂等键（**必填**）：提现属资金操作，缺失 → 10001；重复提交 → 10006 + 首次结果',
  })
  @ApiOperation({ summary: 'L12 提现申请（≥ ¥10.00，走灵活用工代发）' })
  withdraw(@CurrentLeader() leader: TeamLeader, @Body() dto: WithdrawApplyReqDto) {
    return this.withdrawService.apply(leader, dto);
  }

  @Get('withdrawals')
  @UseGuards(LeaderGuard)
  @ApiOperation({ summary: 'L13 提现记录（分页）' })
  withdrawals(@CurrentLeader() leader: TeamLeader, @Query() q: WithdrawalsQueryDto) {
    return this.withdrawService.listWithdrawals(leader, q);
  }
}

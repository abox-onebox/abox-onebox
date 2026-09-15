import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { HEADER } from '@abox/shared-types';

import { CurrentLeader } from '../../common/decorators/leader.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { LeaderGuard } from '../../common/guards/leader.guard';
import { IdempotentInterceptor } from '../../common/interceptors/idempotent.interceptor';
import { TeamLeader } from '../../database/entities/leader.entity';
import {
  LeaderAbnormalQueryDto,
  LeaderExportQueryDto,
  LeaderOrdersQueryDto,
  PickupConfirmReqDto,
} from './dto/leader-order.dto';
import { LeaderOrderService } from './leader-order.service';

/**
 * 团长端 · 订单聚合与取餐控制器（《接口规范》§4.2 / §4.3 · L4–L6、L8–L9）
 *
 * 与 `team-leader` / `leader-finance` 共享 `/api/v1/leader` 前缀，路径段不冲突。
 * 全部挂 `LeaderGuard`（§1.5 身份二次校验：JWT 之后再查 `ab_team_leader` 在职）。
 *
 * ⚠️ 路由顺序：`orders/export`、`orders/abnormal` 必须声明在 `orders` **之前**
 *    （Nest 按声明顺序匹配静态段，虽然当前无 `orders/:x` 通配，仍保持显式）。
 */
@ApiTags('团长端 · 订单与取餐')
@ApiBearerAuth()
@Controller('leader')
export class LeaderOrderController {
  constructor(private readonly leaderOrderService: LeaderOrderService) {}

  @Get('orders/export')
  @UseGuards(LeaderGuard)
  @ApiOperation({ summary: 'L5 导出订单明细（完整手机号 + 写操作日志）' })
  exportOrders(
    @CurrentLeader() leader: TeamLeader,
    @Query() q: LeaderExportQueryDto,
    @Req() req: Request,
  ) {
    return this.leaderOrderService.exportOrders(leader, q, req.ip);
  }

  @Get('orders/abnormal')
  @UseGuards(LeaderGuard)
  @ApiOperation({ summary: 'L6 异常订单（待支付催促）' })
  abnormal(@CurrentLeader() leader: TeamLeader, @Query() q: LeaderAbnormalQueryDto) {
    return this.leaderOrderService.listAbnormal(leader, q);
  }

  @Get('orders')
  @UseGuards(LeaderGuard)
  @ApiOperation({ summary: 'L4 所辖订单列表（手机号脱敏）' })
  orders(@CurrentLeader() leader: TeamLeader, @Query() q: LeaderOrdersQueryDto) {
    return this.leaderOrderService.listOrders(leader, q);
  }

  @Get('pickup/today')
  @UseGuards(LeaderGuard)
  @ApiOperation({ summary: 'L8 本楼今日取餐（总份数 / 配送状态 / 成员列表）' })
  pickupToday(@CurrentLeader() leader: TeamLeader, @Query('mealDate') mealDate?: string) {
    return this.leaderOrderService.pickupToday(leader, mealDate);
  }

  @Post('pickup/confirm')
  @UseGuards(LeaderGuard)
  @UseInterceptors(IdempotentInterceptor)
  @Idempotent({ scope: 'pickup-confirm' })
  @ApiHeader({
    name: HEADER.IDEMPOTENCY_KEY,
    required: false,
    description: '幂等键（建议传；重复提交返回 code:10006 + 首次结果）',
  })
  @ApiOperation({
    summary: 'L9 确认收货并一键分发（按实发份数计佣；缺省全量，可传 orderNos 局部）',
  })
  confirm(@CurrentLeader() leader: TeamLeader, @Body() dto: PickupConfirmReqDto) {
    return this.leaderOrderService.confirmPickup(leader, dto);
  }
}

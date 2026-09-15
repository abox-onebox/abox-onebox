import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HEADER } from '@abox/shared-types';

import { CurrentUser, JwtPayload } from '../../common/decorators/auth.decorator';
import { CurrentLeader } from '../../common/decorators/leader.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { LeaderGuard } from '../../common/guards/leader.guard';
import { IdempotentInterceptor } from '../../common/interceptors/idempotent.interceptor';
import { TeamLeader } from '../../database/entities/leader.entity';
import { RefundApplyReqDto } from '../finance/dto/finance.dto';
import { RefundService } from '../finance/refund.service';
import { CreateOrderReqDto, OrderNoParamDto, OrdersQueryDto } from './dto/order.dto';
import { OrderService } from './order.service';

@ApiTags('订单')
@Controller('orders')
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly refundService: RefundService,
  ) {}

  @Post()
  @UseInterceptors(IdempotentInterceptor)
  @Idempotent({ scope: 'order' })
  @ApiHeader({
    name: HEADER.IDEMPOTENCY_KEY,
    required: true,
    description: '幂等键（UUID，同一意图复用；重复请求返回 code:10006 + 首次结果）',
  })
  @ApiOperation({ summary: 'U6 创建订单（幂等）' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateOrderReqDto) {
    return this.orderService.create(user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'U9 我的订单列表（按出餐日倒序）' })
  list(@CurrentUser() user: JwtPayload, @Query() q: OrdersQueryDto) {
    return this.orderService.list(user.sub, q);
  }

  @Get(':orderNo')
  @ApiOperation({ summary: 'U10 订单详情 + 状态机时间线' })
  detail(@CurrentUser() user: JwtPayload, @Param() p: OrderNoParamDto) {
    return this.orderService.detail(user.sub, p.orderNo);
  }

  @Post(':orderNo/cancel')
  @ApiOperation({
    summary: 'U11 自助取消（仅截单前 + pending_pay/paid；截单后返回 40004 + 团长联系方式）',
  })
  cancel(@CurrentUser() user: JwtPayload, @Param() p: OrderNoParamDto) {
    return this.orderService.cancel(user.sub, p.orderNo);
  }

  /**
   * L7 · 团长代退申请（C6 第一段）
   *
   * ⚠️ 路径落在 `/orders/` 域（与用户自助取消同资源），但**鉴权走团长身份**：
   *    `LeaderGuard` 会在 JWT 之后再查 `ab_team_leader` 确认在职（§1.5），
   *    并在 service 内校验「订单属于本团长所辖楼栋」防跨楼越权。
   * ⚠️ 本接口**只登记申请**（`ab_refund.status='applying'`），**资金零变动**。
   */
  @Post(':orderNo/refund-apply')
  @UseGuards(LeaderGuard)
  @ApiOperation({ summary: 'L7 团长代退申请（C6 第一段：只登记，不退款不回退）' })
  refundApply(
    @CurrentLeader() leader: TeamLeader,
    @Param() p: OrderNoParamDto,
    @Body() dto: RefundApplyReqDto,
  ) {
    return this.refundService.applyByLeader(leader, p.orderNo, dto);
  }
}

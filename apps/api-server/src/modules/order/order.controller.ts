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

  /**
   * U11 自助取消（T4）
   *
   * ⚠️ **幂等键刻意 `required: false`**（外部测试报告 PR-01 · 2026-09-21 收口）：
   *    · 带键 → 同一键的**并发 / 重放**在 KV 层被拦下（`idem:order-cancel:<key>`），
   *      第二次得 `10006` + 首次结果，端上按成功处理；
   *    · 不带键（既有端上版本）→ 放行，由 **service 层事务内的原子占位**兜底。
   *    ⇒ **两层覆盖的是不同情况，缺一层就有缝**：KV 只认「同一个键」，
   *      拦不住「两个不同键」或「一端带键一端不带」的并发；真正让钱不会被退两次的
   *      是 service 层那条 `WHERE id = ? AND status = ?` + `affected` 判定。
   *    之所以**不**把 `required` 提为 `true`：那是破坏性契约变更（既有端上调用方与
   *      e2e 都得先改），而收益已由 service 层覆盖。
   */
  @Post(':orderNo/cancel')
  @UseInterceptors(IdempotentInterceptor)
  @Idempotent({ scope: 'order-cancel', required: false })
  @ApiHeader({
    name: HEADER.IDEMPOTENCY_KEY,
    required: false,
    description: '幂等键（可选；同键重放返回 code:10006 + 首次结果）',
  })
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

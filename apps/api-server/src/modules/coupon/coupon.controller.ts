import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

import { CurrentUser, JwtPayload } from '../../common/decorators/auth.decorator';
import { CouponService } from './coupon.service';
import { AvailableCouponsQueryDto } from './dto/coupon.dto';

/**
 * 用户端代金券（《接口规范》§3 · 我的券 / 订单可用券）
 *
 * 鉴权由全局 `JwtAuthGuard` 兜底（与订单域一致）；本控制器不重复挂守卫。
 */
@ApiTags('代金券')
@Controller('coupon')
export class CouponController {
  constructor(private readonly couponService: CouponService) {}

  @Get('my')
  @ApiOperation({ summary: '我的优惠券（全部，含可用性判据 / 不可用原因）' })
  my(@CurrentUser() user: JwtPayload) {
    return this.couponService.listMy(user.sub);
  }

  @Get('my-available')
  @ApiOperation({
    summary: '订单可用券（未使用 + 在有效期 + 门槛满足；含实际抵扣额）',
    description: 'totalFen 由端上按「单价 × 份数」算出传入，用于判定门槛。',
  })
  available(@CurrentUser() user: JwtPayload, @Query() q: AvailableCouponsQueryDto) {
    const totalFen = q.totalFen ?? 0;
    return this.couponService.listAvailableForOrder(user.sub, totalFen);
  }
}

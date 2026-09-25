import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, JwtPayload } from '../../common/decorators/auth.decorator';
import { OrderNoParamDto } from '../order/dto/order.dto';
import { RatingSubmitReqDto } from './dto/rating.dto';
import { RatingService } from './rating.service';

/**
 * U20 · 提交口味评价（P1-U2 · 用户侧）
 *
 * ⚠️ 路径落在 `/orders/` 域（评价是订单的后置动作），与取消/代退同资源前缀。
 * ⚠️ 鉴权走**全局** `JwtAuthGuard`（`APP_GUARD`，与 order.controller 用户端点同一形态），
 *    不另挂 @UseGuards。
 * ⚠️ **刻意不加幂等键**：幂等键拦「同一键重放」，而评价的防重放由
 *    「该单已有评价行即拒绝（30021）」这条**业务闸门**承担 ——
 *    幂等层命中会返回首次**成功结果**，那等于把「不可改」裁决变成「重放当成功」，
 *    语义正好相反。
 * ⚠️ 用户侧写操作**不写 ab_operation_log**（那是后台操作者审计表，用户动作的
 *    留痕就是 `ab_dish_rating` 行本身）。
 */
@ApiTags('订单')
@ApiBearerAuth()
@Controller('orders')
export class RatingController {
  constructor(private readonly ratingService: RatingService) {}

  @Post(':orderNo/rating')
  @ApiOperation({
    summary: 'U20 提交口味评价（逐菜三键 · 一次定稿不可改）',
    description:
      '每道菜「好吃/一般/不好」三键 + 可选原因；允许跳过（未提交的菜不落行）。' +
      '仅 delivered/completed 可评（否则 30020）；已评过即拒绝（30021，回带 ratedAt）。',
  })
  submit(
    @CurrentUser() user: JwtPayload,
    @Param() p: OrderNoParamDto,
    @Body() dto: RatingSubmitReqDto,
  ) {
    return this.ratingService.submit(user.sub, p.orderNo, dto);
  }
}

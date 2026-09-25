import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from '../../common/decorators/auth.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { DishRatingQueryDto } from './dto/rating.dto';
import { RatingService } from './rating.service';

/**
 * D69 · 口味红黑榜（P1-U2 · 后台 · 原型 P35 菜品热度页第二个 Tab）
 *
 * ⚠️ **角色白名单与 StatsAdminController 逐字一致**（含 viewer）：
 *    口味评价 Tab 挂在「菜品热度」页上，而 viewer 的菜单**只有这 4 个看板页** ——
 *    漏了 viewer 就是「菜单能点、点了 10003」（与 D47–D50 同一条纪律）。
 * ⚠️ 纯读 GET → **不加 @OperationLog()**（GET 标了会把看板刷成日志垃圾）。
 */
@ApiTags('后台·数据看板')
@ApiBearerAuth()
@Controller('admin/stats')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'finance', 'operator', 'viewer')
export class RatingAdminController {
  constructor(private readonly ratingService: RatingService) {}

  @Get('dish-rating')
  @ApiOperation({
    summary: 'D69 口味红黑榜（P35 · P1-U2 · 菜品热度页第二 Tab）',
    description:
      '按菜品聚合口味评价：好吃/一般/不好计数、差评率、本月被投诉次数（红线 ≥ 3 标红）、' +
      '最近差评原因；`worstThree` 直接回答 P1 验收判据「本周最差的三道菜」。' +
      '区间与 D47–D50 同源（today/7d/30d · 出餐日 · date 为终点锚）。',
  })
  dishRating(@Query() q: DishRatingQueryDto) {
    return this.ratingService.dishRating(q);
  }
}

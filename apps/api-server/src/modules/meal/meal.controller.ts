import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, JwtPayload, Public } from '../../common/decorators/auth.decorator';
import { HomeDailyQueryDto, HomeHistoryQueryDto, InviteCodeParamDto } from './dto/meal.dto';
import { MealService } from './meal.service';

/**
 * 首页（M01）
 *
 * ⚠️ 鉴权说明：U1/U2 出参含「我的楼群套餐 / 我的已有订单 / 我的团长」，
 * 属**用户私有只读**数据，故**要求登录**（《接口规范》§3.1 属公共域，但 §1.1
 * 的「可匿名只读」实际适用于 U5 溯源；另见 M1 验收标准 1：微信授权后直接进首页）。
 */
@ApiTags('首页')
@Controller('home')
export class HomeController {
  constructor(private readonly mealService: MealService) {}

  @Get('daily')
  @ApiOperation({ summary: 'U1 明日套餐（含 canOrder 权威判定与倒计时）' })
  daily(@CurrentUser() user: JwtPayload, @Query() q: HomeDailyQueryDto) {
    return this.mealService.daily(user.sub, q.mealDate);
  }

  @Get('history')
  @ApiOperation({ summary: 'U2 历史套餐归档（M01-02）' })
  history(@CurrentUser() user: JwtPayload, @Query() q: HomeHistoryQueryDto) {
    return this.mealService.history(user.sub, q.page, q.pageSize);
  }
}

/**
 * 团长邀请落地（M01-03 · U3）
 * 免登录只读：仅返回团长昵称 / 楼名 / 一句 slogan，**不泄露手机号与佣金**。
 * 注：`/leader/*` 的团长业务接口（工作台、订单、佣金）由 M2 的 TeamLeaderModule 承接，
 *     本控制器只负责公开的邀请落地展示。
 */
@ApiTags('首页')
@Controller('leader/invite')
export class InviteController {
  constructor(private readonly mealService: MealService) {}

  @Public()
  @Get(':leaderCode')
  @ApiOperation({ summary: 'U3 团长邀请落地（免登录）' })
  landing(@Param() p: InviteCodeParamDto) {
    return this.mealService.inviteLanding(p.leaderCode);
  }
}

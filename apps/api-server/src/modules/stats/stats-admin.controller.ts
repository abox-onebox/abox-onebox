import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from '../../common/decorators/auth.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';

import { DishHeatQueryDto, StatsQueryDto } from './dto/stats.dto';
import { StatsService } from './stats.service';

/**
 * D47–D50 后台数据看板（原型 P35 · 模块 M36）
 *
 * ⚠️ **为什么白名单里有 `viewer`**（而其余后台控制器都没有）：
 *   `admin-role.ts` 里 `viewer`（只读观察者）的菜单**只有这 4 个看板页**。
 *   若此处不含 `viewer`，该角色登录后在自己**唯一拥有的页面**上会拿 10003，
 *   等于这个角色根本不可用 —— 菜单授权与接口授权必须同源，
 *   否则「菜单能点、点了报无权限」是最容易被当成 bug 的一类不一致。
 *
 * ⚠️ 四个端点**都是 GET**，故一律不加 `@OperationLog()`：
 *   操作日志只标写操作（`GET` 标了会把看板刷成日志垃圾）。
 */
@ApiTags('后台·数据看板')
@ApiBearerAuth()
@Controller('admin/stats')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'finance', 'operator', 'viewer')
export class StatsAdminController {
  constructor(private readonly stats: StatsService) {}

  @Get('dashboard')
  @ApiOperation({
    summary: 'D47 核心指标看板（P35 · M36-01）',
    description:
      'GMV / 订单量 / 份数 / 客单价 / 退款率 / 复购率 / 活跃用户·团长·楼栋 / 佣金·采购·履约成本 / ' +
      '经营毛利（结果值） + 逐日趋势。**经营毛利为「上限值」时会通过 `warnings` 明示原因**：' +
      '① 履约成本三项未登记 ② 采购应付单尚未生成。',
  })
  dashboard(@Query() q: StatsQueryDto) {
    return this.stats.dashboard(q);
  }

  @Get('building-rank')
  @ApiOperation({
    summary: 'D48 楼群 / 楼栋榜单（P35 · M36-02）',
    description:
      '按出餐日区间聚合有效订单，分别给出楼群与楼栋维度的订单数 / 份数 / GMV / 占比，' +
      '按 GMV 降序。楼群、楼栋被软删后仍会出现在榜单（回退名 `楼群#id`），' +
      '以免「分项之和 ≠ 总额」。',
  })
  buildingRank(@Query() q: StatsQueryDto) {
    return this.stats.buildingRank(q);
  }

  @Get('dish-heat')
  @ApiOperation({
    summary: 'D49 菜品热度（P35 · M36-03）',
    description:
      '按「套餐 → 菜品」展开后统计每个菜品被发出的份数（一份套餐里的每个菜各计一次订单份数），' +
      '降序取 TOP N。`share` 的分母是区间内**全部**菜品份数，不是 TOP N 之和。',
  })
  dishHeat(@Query() q: DishHeatQueryDto) {
    return this.stats.dishHeat(q);
  }

  @Get('retention')
  @ApiOperation({
    summary: 'D50 留存分析（P35 · M36-04）',
    description:
      '活跃/新客/回流/复购汇总 + 按「首单所在自然周」分群的次周留存。' +
      '观察窗口未走完的 cohort **不下发留存率**（`observable=false`），' +
      '因为此时算出的低留存只是「数据还没长出来」。',
  })
  retention(@Query() q: StatsQueryDto) {
    return this.stats.retention(q);
  }
}

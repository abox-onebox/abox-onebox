import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

import {
  DISH_HEAT_DEFAULT_TOP_N,
  DISH_HEAT_MAX_TOP_N,
  STATS_DEFAULT_RANGE,
  STATS_RANGES,
  StatsRange,
} from '../stats.constants';

/**
 * D47–D50 通用查询（《接口规范》§6.6 · 数据统计 M36）
 *
 * ⚠️ `range` **必须**是枚举而不是「任意起止日期」：
 *   一旦放开自由日期区间，运营会拿「8/1–8/13」与「8/2–8/14」两个区间去对比，
 *   而两个区间的自然周/月不重合 → 结论全是噪声。只给 today/7d/30d 三档，
 *   保证任何两个人看同一档得到同一个区间。
 */
export class StatsQueryDto {
  @ApiPropertyOptional({
    description: '统计区间（按**出餐日** mealDate 计算）：today 今日 / 7d 近 7 日 / 30d 近 30 日',
    enum: STATS_RANGES,
    default: STATS_DEFAULT_RANGE,
    example: '7d',
  })
  @IsOptional()
  @IsIn(STATS_RANGES as unknown as string[], { message: 'range 需为 today / 7d / 30d' })
  range?: StatsRange;

  /**
   * 区间**终点锚点**（出餐日）；缺省 = 今日。
   *
   * ⚠️ 这是「锚点」不是「自由起止」—— 起止仍由 `range` 的档位推导（终点往前推 N−1 天）。
   *    之所以要它：期末对账/复核要看**已经过完的那几天**（今天的数据还在长），
   *    没有锚点就只能看「以今天为终点的区间」，对不上历史账。
   *    仍**不允许**「起点终点各填一个」—— 那就退回了「两个区间无法对比」的老问题。
   */
  @ApiPropertyOptional({
    description: '区间终点锚点（出餐日 YYYY-MM-DD），缺省今日 —— 用于回看已过完的历史区间',
    example: '2026-09-10',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date 需为 YYYY-MM-DD' })
  date?: string;
}

/** D49 · 菜品热度查询（在通用区间之上多一个 TOP N） */
export class DishHeatQueryDto extends StatsQueryDto {
  @ApiPropertyOptional({
    description: `返回前 N 个菜品，默认 ${DISH_HEAT_DEFAULT_TOP_N}，上限 ${DISH_HEAT_MAX_TOP_N}`,
    default: DISH_HEAT_DEFAULT_TOP_N,
    example: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'topN 需为整数' })
  @Min(1, { message: 'topN 至少为 1' })
  @Max(DISH_HEAT_MAX_TOP_N, { message: `topN 上限为 ${DISH_HEAT_MAX_TOP_N}` })
  topN?: number;
}

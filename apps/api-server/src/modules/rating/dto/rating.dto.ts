import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { StatsQueryDto } from '../../stats/dto/stats.dto';
import { RATING_LEVELS, RATING_WORST_COUNT } from '../rating.constants';

/** 单菜评价入参 */
export class DishRatingItemDto {
  @ApiProperty({
    description: '菜品 id（须属于该订单的套餐；name 无唯一约束，按 id 定位）',
    example: 3,
  })
  @Type(() => Number)
  @IsInt({ message: 'dishId 需为整数' })
  dishId!: number;

  @ApiProperty({ description: '1 好吃 / 2 一般 / 3 不好', enum: RATING_LEVELS, example: 3 })
  @Type(() => Number)
  @IsIn(RATING_LEVELS as unknown as number[], { message: 'rating 需为 1 / 2 / 3' })
  rating!: number;

  @ApiPropertyOptional({ description: '可选原因（自由文本，上限 128 字）', example: '茄子太咸' })
  @IsOptional()
  @IsString()
  @MaxLength(128, { message: '原因上限 128 字' })
  reason?: string;
}

/**
 * U20 提交口味评价
 *
 * ⚠️ `items` **允许部分提交**（逐菜三键 · 裁决 ①）：跳过的菜不落行 ——
 * 「不想评那道」不该逼用户给「一般」。
 * ⚠️ **一次提交即定稿**（裁决 ④）：重复提交返回 30021，不合并、不覆盖。
 */
export class RatingSubmitReqDto {
  @ApiProperty({
    description: '逐菜评价（至少 1 项；未提交的菜视为跳过）',
    type: [DishRatingItemDto],
  })
  @IsArray()
  @ArrayMinSize(1, { message: '至少评价一道菜' })
  @ArrayMaxSize(20, { message: '单次最多 20 项（一饭四菜上限 + 冗余）' })
  @ValidateNested({ each: true })
  @Type(() => DishRatingItemDto)
  items!: DishRatingItemDto[];
}

/**
 * D69 查询 —— **直接继承 `StatsQueryDto`**（区间语义与 D47–D50 同源：
 * `range` 只开 today/7d/30d 三档、`date` 是终点锚不是自由起止）。
 * 区间校验**只声明一次**（stats.dto），这里零新增字段 —— 换任何一档，
 * 五个看板端点得到同一个区间。
 */
export class DishRatingQueryDto extends StatsQueryDto {}

/** 「最差三道菜」展示形态（worstThree 出参） */
export const WORST_COUNT_FOR_DOC = RATING_WORST_COUNT;

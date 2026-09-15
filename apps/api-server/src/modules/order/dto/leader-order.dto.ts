import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { OrderStatus } from '@abox/shared-types';

/**
 * L4 团长订单列表查询（《接口规范》§4.2 · M12-01）
 * ⚠️ 出参手机号**一律脱敏**；完整手机号仅 L5 导出接口返回且须写操作日志。
 */
export class LeaderOrdersQueryDto {
  @ApiPropertyOptional({ description: '出餐日 YYYY-MM-DD；缺省 = 今日', example: '2026-09-15' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'mealDate 需为 YYYY-MM-DD' })
  mealDate?: string;

  @ApiPropertyOptional({
    description: `按状态过滤，如 ${OrderStatus.PAID}；缺省 = 全部`,
  })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  status?: string;

  @ApiPropertyOptional({ description: '订单号模糊搜索', example: 'AB20260915' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  keyword?: string;

  @ApiPropertyOptional({ description: '页码，默认 1' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数，默认 20，上限 100' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

/** L5 导出查询（仅 mealDate） */
export class LeaderExportQueryDto {
  @ApiPropertyOptional({ description: '出餐日 YYYY-MM-DD；缺省 = 今日', example: '2026-09-15' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'mealDate 需为 YYYY-MM-DD' })
  mealDate?: string;
}

/** L6 异常订单查询（暂只支持按出餐日） */
export class LeaderAbnormalQueryDto {
  @ApiPropertyOptional({ description: '出餐日 YYYY-MM-DD；缺省 = 今日', example: '2026-09-15' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'mealDate 需为 YYYY-MM-DD' })
  mealDate?: string;
}

/**
 * L9 取餐确认（M13-03 · 幂等）
 *
 * `orderNos` 缺省 = 「全部确认」；传数组则**局部确认**（仅这些订单转 `completed`）。
 * 单次上限 500 单，超出请分批（避免一次事务过大）。
 */
export class PickupConfirmReqDto {
  @ApiPropertyOptional({
    description: '局部确认的订单号列表；缺省 = 全部确认',
    example: ['AB2026091500071234'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500, { message: '单次最多确认 500 单，请分批提交' })
  @IsString({ each: true })
  orderNos?: string[];
}

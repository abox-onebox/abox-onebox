import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Min } from 'class-validator';

/**
 * U5 查询参数（《接口规范 v1.0》§3.2）
 *
 * ## 为什么 `buildingId` 是查询参数而不是从 token 推
 * 本端点标了 `@Public()`（验收要求「溯源可匿名只读」）—— 而 `JwtAuthGuard` 在
 * `@Public()` 时**直接放行、不注入 `req.user`**，所以服务端**拿不到**调用者身份，
 * 也就无从推楼群。楼群必须由端上显式传入（端上从登录出参的 `user.buildingId` 取）。
 *
 * ⚠️ 缺省**不做**「回落到任一楼群」这种猜测：不同楼群当日套餐不同，
 * 猜错就会把 A 楼的出品方显示给 B 楼的人 —— 溯源页答错的代价比不答更高。
 */
export class TraceabilityTodayQueryDto {
  @ApiPropertyOptional({
    description: '办公楼 id（`ab_building.id`）· 用于定位其所属楼群当日分配；省略时服务端报 10001',
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  buildingId?: number;

  @ApiPropertyOptional({
    description: '出餐日 YYYY-MM-DD；缺省 = 明日（T+1）',
    example: '2026-09-16',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'mealDate 需为 YYYY-MM-DD' })
  mealDate?: string;
}

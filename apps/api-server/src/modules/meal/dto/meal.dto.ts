import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/** U1/U2 查询参数 */
export class HomeDailyQueryDto {
  @ApiPropertyOptional({
    description: '出餐日 YYYY-MM-DD；缺省=明日（T+1）',
    example: '2026-09-16',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'mealDate 需为 YYYY-MM-DD' })
  mealDate?: string;
}

export class HomeHistoryQueryDto {
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

/** U3 路径参数 */
export class InviteCodeParamDto {
  @ApiPropertyOptional({ description: '团长邀请码，如 LDR0007' })
  @IsString()
  leaderCode!: string;
}

/** 档位文案（ab_set_meal_item.slot：1 主荤 / 2 半荤 / 3 素菜 / 4 汤 / 5 主食） */
export const SLOT_LABEL: Record<number, string> = {
  1: '主荤',
  2: '半荤',
  3: '素菜',
  4: '汤',
  5: '主食',
};

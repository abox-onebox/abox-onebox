import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import type { CreateOrderDto } from '@abox/shared-types';
import { OrderStatus } from '@abox/shared-types';

/**
 * U6 下单入参（《接口规范》§3.3 · 2026-09-15 裁定以文档为准）
 *
 * ⚠️ 校验分层：
 *   类级装饰器 → 只管「类型/格式」（失败即 10001）
 *   服务层     → 管「业务语义」（份数上限 30002 / 余额合法性 30006 / 截单 30001 …）
 *   原因：上限值来自 `ab_config`，不能在装饰器里写死；余额非法须返回业务码而非 10001。
 */
export class CreateOrderReqDto implements CreateOrderDto {
  @ApiPropertyOptional({ description: '出餐日 YYYY-MM-DD；缺省 = 明日', example: '2026-09-16' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'mealDate 需为 YYYY-MM-DD' })
  mealDate?: string;

  @ApiProperty({ description: '份数（业务上限见 ab_config.order.max_quantity）', example: 1 })
  @Type(() => Number)
  @IsInt({ message: '份数需为整数' })
  @Min(1, { message: '份数至少 1 份' })
  quantity!: number;

  @ApiPropertyOptional({ description: '备注（过敏忌口等）', example: '不要香菜' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  remark?: string;

  @ApiPropertyOptional({ description: '余额抵扣（整数分），0 或省略表示不用余额', example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '余额抵扣需为数字（整数分）' })
  useBalanceFen?: number;

  @ApiPropertyOptional({ description: '团长邀请码；缺省按用户默认归属团长', example: 'LDR0001' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  leaderCode?: string;
}

/** U9 订单列表查询 */
export class OrdersQueryDto {
  @ApiPropertyOptional({ description: `按状态过滤，如 ${OrderStatus.PAID}` })
  @IsOptional()
  @IsString()
  status?: string;

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

/** 路径参数：业务订单号 */
export class OrderNoParamDto {
  @ApiProperty({ description: '业务订单号', example: 'AB2026091500071234' })
  @IsString()
  @Matches(/^AB\d{16}$/, { message: 'orderNo 格式不合法' })
  orderNo!: string;
}

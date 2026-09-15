import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

/** 支付/查询路径参数（与订单域共用格式） */
export class PayOrderNoParamDto {
  @ApiProperty({ example: 'AB2026091500071234' })
  @IsString()
  @Matches(/^AB\d{16}$/, { message: 'orderNo 格式不合法' })
  orderNo!: string;
}

/** 调试端点入参：手动触发支付成功（仅 PROVIDER_MODE=mock） */
export class MockPaidDto {
  @ApiProperty({ description: '业务订单号' })
  @IsString()
  @Matches(/^AB\d{16}$/, { message: 'orderNo 格式不合法' })
  orderNo!: string;

  @ApiPropertyOptional({ description: '金额（分）；省略则取订单实付金额' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amountFen?: number;
}

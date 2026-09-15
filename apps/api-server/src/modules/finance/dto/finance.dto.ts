import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { REFUND_REASON_LABEL, RefundReasonType, ReceiveType } from '@abox/shared-types';

/** 代退原因取值（与 shared-types 单一来源） */
const REASON_TYPES: string[] = Object.values(RefundReasonType);
const REASON_HINT = Object.values(RefundReasonType)
  .map((v) => REFUND_REASON_LABEL[v])
  .join(' / ');

/**
 * L7 团长代退申请（《接口规范》§4.2 · C6 第一段）
 *
 * ⚠️ 本接口**只登记申请**（`ab_refund.status='applying'`），**不退款、不回退分账**；
 *    实际退款由后台审批通过后执行（§6.5 D46）。
 * ⚠️ `remark` 与 `reason` 会**合并写入 `ab_refund.reason`**（实体无独立 remark 列，
 *    且该列长 256），拼接为「主因 | 补充」；端上传空则只存主因。
 */
export class RefundApplyReqDto {
  @ApiProperty({
    description: '退款原因类型',
    enum: REASON_TYPES,
    example: RefundReasonType.QUALITY,
  })
  @IsIn(REASON_TYPES, { message: `reasonType 需为：${REASON_HINT}` })
  reasonType!: string;

  @ApiPropertyOptional({ description: '原因说明（主因描述）', example: '红烧肉有异味' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  @ApiPropertyOptional({ description: '补充备注（与 reason 合并存储）', example: '用户已拍照留证' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;
}

/** 佣金明细查询（L10） */
export class LeaderCommissionQueryDto {
  @ApiPropertyOptional({ description: '统计范围：day 按日 / month 按月', example: 'day' })
  @IsOptional()
  @IsIn(['day', 'month'], { message: 'range 需为 day 或 month' })
  range?: 'day' | 'month';

  @ApiPropertyOptional({ description: '基准日期 YYYY-MM-DD；缺省 = 今日', example: '2026-09-15' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date 需为 YYYY-MM-DD' })
  date?: string;

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

/**
 * 余额流水查询（L19 · P17 余额流水）
 *
 * `ab_balance_log` 与 `ab_balance` 同源：本接口出参与 L11 的 `balanceFen` 可相互验算。
 */
export class BalanceLogQueryDto {
  @ApiPropertyOptional({
    description: '流水类型：commission/order_pay/withdraw/withdraw_refund/refund',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  type?: string;

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

/** 提现记录查询（L13） */
export class WithdrawalsQueryDto {
  @ApiPropertyOptional({
    description: '按状态过滤：pending/approved/paying/success/rejected/failed',
  })
  @IsOptional()
  @IsString()
  @MaxLength(16)
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

/**
 * L12 提现申请（《接口规范》§4.4 · C11）
 *
 * 金额单位为**元**（与实体 DECIMAL(12,2) 一致）；低于 `commission.min_withdraw`
 * （默认 ¥10.00）→ `40003`；未绑定收款方式 → `40007`；可用余额不足 → `50004`。
 */
export class WithdrawApplyReqDto {
  @ApiProperty({
    description: '提现金额（元），最低见 ab_config.commission.min_withdraw',
    example: 25.8,
  })
  @Type(() => Number)
  @IsNotEmpty({ message: '请填写提现金额' })
  @Min(0.01, { message: '提现金额需大于 0' })
  amount!: number;

  @ApiPropertyOptional({
    description: '收款方式：bank 银行卡 / alipay 支付宝',
    enum: ReceiveType,
    default: ReceiveType.BANK,
  })
  @IsOptional()
  @IsIn(Object.values(ReceiveType), { message: 'receiveType 需为 bank 或 alipay' })
  receiveType?: string;

  @ApiPropertyOptional({
    description: '收款账号；缺省取团长已绑定的收款方式',
    example: '6222****1234',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  receiveAccount?: string;

  @ApiPropertyOptional({ description: '收款人姓名；缺省取团长真实姓名', example: '李明' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  receiveName?: string;
}

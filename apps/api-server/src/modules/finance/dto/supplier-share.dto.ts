import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * 应付结算（S9 · **后台侧**）请求 DTO —— M3-9
 *
 * 口径唯一权威源：《ABox一盒自营结算口径定义v1.0.md》§四（计费基数与出单规则）/ §九（接口口径）
 *   · 计费基数 = **实收量**（`ab_supplier_dish_daily.actual_quantity`；未申报则 = 计划量）
 *   · 单价 = 逐菜协商采购价（**出餐计划生成时冻结的快照**，见 service 头注）
 *   · 应付对象**只剩供应商**（`payee_type=distribution_center` 已冻结，新单不再产生）
 *
 * ⚠️ 金额出参一律**整数分**（`Fen` 结尾）；入参不含金额 —— 应付额由服务端按
 *    「实收量 × 冻结单价」算，端上算出来的数字一律不采信（与 D41 同一纪律）。
 */

/** 应付单状态文案（与 `ab_supplier_share.status` 同源 · 服务端下发，端上不维护第二份） */
export const SHARE_STATUS_LABEL: Record<string, string> = {
  pending: '待付款',
  success: '已付款',
  failed: '异常',
  reversed: '已冲减',
};

const SHARE_STATUSES = Object.keys(SHARE_STATUS_LABEL);
const STATUS_HINT = SHARE_STATUSES.map((k) => `${k}(${SHARE_STATUS_LABEL[k]})`).join(' / ');

/** 页面 Tab（语义糖）——应付结算是「按日付款」场景，核心只有待付 / 已付两栏 */
export const SHARE_TABS = ['pending', 'success', 'all'] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** S9 · 应付单列表查询 */
export class SupplierShareListQueryDto {
  @ApiPropertyOptional({
    description: '出餐日 YYYY-MM-DD（应付结算的天然时间轴：按日出单、按日付款）',
    example: '2026-09-16',
  })
  @IsOptional()
  @Matches(DATE_RE, { message: 'date 需为 YYYY-MM-DD' })
  date?: string;

  @ApiPropertyOptional({ description: '供应商 id（缺省 = 全部）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  supplierId?: number;

  @ApiPropertyOptional({
    description: `状态过滤：${STATUS_HINT} / all 全部（默认）`,
    enum: [...SHARE_STATUSES, 'all'],
  })
  @IsOptional()
  @IsIn([...SHARE_STATUSES, 'all'], { message: `status 需为：${STATUS_HINT} / all` })
  status?: string;

  @ApiPropertyOptional({
    description: '关键词：应付单号 / 银行回单号 / 发票号',
    example: 'SH20260916',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
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

/** 路径参数：应付单 id */
export class ShareIdParamDto {
  @ApiProperty({ description: '应付单 id（ab_supplier_share.id，不是 shareNo）', example: 12 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  id!: number;
}

/**
 * S9 · 生成应付单（跑批可重跑，此接口供运营手动补跑）
 *
 * `date` 必填：出单的对象是「**某个出餐日**的交付量」，没有日期就没有出单范围
 * —— 刻意不提供「不带日期出一堆单」的用法。
 */
export class GenerateSharesDto {
  @ApiProperty({ description: '出餐日 YYYY-MM-DD（应付对应的生产日）', example: '2026-09-16' })
  @Matches(DATE_RE, { message: 'date 需为 YYYY-MM-DD' })
  date!: string;

  @ApiPropertyOptional({ description: '只出该供应商的单（缺省 = 全部供应商）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  supplierId?: number;
}

/**
 * S9 · 付款登记（人工对公转账后回填凭证 · C10 不变）
 *
 * ⚠️ `paymentVoucherNo` **必填**：银行回单号是「这笔钱确实付了」的唯一凭证，
 *    没有它，系统里的 `success` 只是一句口头承诺。缺 → 50013。
 * ⚠️ 刻意**不收** `paidAt`：付款时刻取系统当前时间。让操作员自填时间会引入
 *    「事后补录一个好看的时间」，而对账要的正是**诚实的时间戳**。
 */
export class RegisterPaymentDto {
  @ApiProperty({
    description: '银行回单号（付款完成的唯一凭证，必填）',
    example: '20260916-000123',
  })
  @IsString()
  @MinLength(4, { message: '请填写完整的银行回单号' })
  @MaxLength(64)
  paymentVoucherNo!: string;

  @ApiPropertyOptional({
    description: '供应商发票号（自营口径下是税前扣除凭证，建议一并登记）',
    example: '01123456',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  invoiceNo?: string;
}

/**
 * S9 · 未出单异常清单查询
 *
 * `date` 必填：这份清单回答的是「**某一天为什么没出单**」。
 * 不给日期就等于问「历史上所有没出单的原因」，那不是一份可执行的清单。
 */
export class ShareExceptionsQueryDto {
  @ApiProperty({
    description: '出餐日 YYYY-MM-DD（必填）',
    example: '2026-09-16',
  })
  @Matches(DATE_RE, { message: 'date 需为 YYYY-MM-DD' })
  date!: string;

  @ApiPropertyOptional({ description: '只看某个供应商（缺省 = 全部）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  supplierId?: number;
}

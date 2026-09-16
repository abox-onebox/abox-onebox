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
  MinLength,
} from 'class-validator';

import { REFUND_REASON_LABEL, RefundReasonType, ReceiveType } from '@abox/shared-types';

import { STATS_DEFAULT_RANGE, STATS_RANGES } from '../../stats/stats.constants';

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

/* ========================================================================= *
 * M3-13 后台财务（D33 资金总览 · D34 佣金结算明细 · D35 佣金入账）
 * ========================================================================= */

/** 佣金行状态取值（与 `ab_commission.status` 注释同源） */
export const COMMISSION_STATUS_KEYS = ['pending', 'settled', 'cancelled'] as const;
/** 佣金行类型取值：`normal` 正项 / `reversal` 退款冲销（负值） */
export const COMMISSION_TYPE_KEYS = ['normal', 'reversal'] as const;

const COMMISSION_STATUS_HINT = 'pending(待入账) / settled(已入账) / cancelled(已冲销)';

/**
 * D33 · 资金总览查询
 *
 * ⚠️ `range` 复用统计看板的 **`STATS_RANGES`**（today/7d/30d）—— 绝不另立一套
 *    「日/周/月」区间语义：同一句话在两页指两个不同区间，是最难查的一类对不上账。
 *    `date` 是区间**终点锚点**（缺省今日），供期末复核对已过完的区间。
 */
export class FinanceOverviewQueryDto {
  @ApiPropertyOptional({
    description: '统计区间（按**出餐日** mealDate 计算）：today 今日 / 7d 近 7 日 / 30d 近 30 日',
    enum: STATS_RANGES,
    default: STATS_DEFAULT_RANGE,
    example: '7d',
  })
  @IsOptional()
  @IsIn(STATS_RANGES as unknown as string[], { message: 'range 需为 today / 7d / 30d' })
  range?: string;

  @ApiPropertyOptional({
    description: '区间终点锚点（出餐日 YYYY-MM-DD），缺省今日 —— 用于回看已过完的历史区间',
    example: '2026-09-10',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date 需为 YYYY-MM-DD' })
  date?: string;
}

/**
 * D34 · 佣金结算明细查询（**跨团长** · 与 L10 团长自查明细区分）
 *
 * 接口规范原写 `date=&leaderId=&page=`；`status` / `type` / `keyword` 为 M3-13
 * 登记的**扩展入参**（财务核对「哪些还没入账 / 哪些被冲销了」是高频动作，
 * 没有过滤就只能翻页）。
 *
 * ⚠️ `date` 缺省 = **今日**（与 D33 的 `range` 不同：明细页是「一天一张表」的
 *    工作习惯）。要看多天请逐日切换 —— 不让它变成第二个区间参数。
 */
export class AdminCommissionsQueryDto {
  @ApiPropertyOptional({
    description: '出餐日 YYYY-MM-DD（缺省今日）',
    example: '2026-09-16',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date 需为 YYYY-MM-DD' })
  date?: string;

  @ApiPropertyOptional({ description: '按团长过滤（ab_team_leader.id）', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  leaderId?: number;

  @ApiPropertyOptional({ description: `按状态过滤：${COMMISSION_STATUS_HINT}` })
  @IsOptional()
  @IsIn(COMMISSION_STATUS_KEYS as unknown as string[], {
    message: `status 需为：${COMMISSION_STATUS_HINT}`,
  })
  status?: string;

  @ApiPropertyOptional({ description: '按类型过滤：normal 正项 / reversal 冲销' })
  @IsOptional()
  @IsIn(COMMISSION_TYPE_KEYS as unknown as string[], { message: 'type 需为 normal 或 reversal' })
  type?: string;

  @ApiPropertyOptional({ description: '关键词：订单号 / 团长姓名', example: 'O2026091' })
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

/**
 * D35 · 佣金入账（手动触发 / 补跑）
 *
 * 入参只有「限定哪个出餐日」，**刻意不收金额也不收团长**：
 * 入账金额一律以 `ab_commission` 的行为准（那是计佣时冻结的快照），
 * 一旦允许传金额，就等于开了一个「手工往团长余额里加钱」的后门。
 * `date` 缺省 = 全部待入账。
 */
export class AdminSettleCommissionsDto {
  @ApiPropertyOptional({
    description: '限定出餐日 YYYY-MM-DD；缺省 = 全部待入账（`status=pending`）',
    example: '2026-09-16',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date 需为 YYYY-MM-DD' })
  date?: string;
}

// ---------------------------------------------------------------- D38 / D39 余额账户

/** D39 调整动作取值（`recharge` 充值 / `deduct` 扣减 / `freeze` 冻结 / `unfreeze` 解冻） */
export const BALANCE_ADJUST_ACTIONS = ['recharge', 'deduct', 'freeze', 'unfreeze'] as const;
/** D38 账户类型过滤取值 */
export const BALANCE_ACCOUNT_TYPES = ['all', 'leader', 'user'] as const;

const BALANCE_ADJUST_HINT = 'recharge(充值) / deduct(扣减) / freeze(冻结) / unfreeze(解冻)';
const BALANCE_ACCOUNT_TYPE_HINT = 'all(全部) / leader(仅团长) / user(仅普通用户)';

/**
 * D38 · 余额账户管理查询（**跨用户**）
 *
 * ⚠️ `accountType` 用**字符串枚举**而不是 `onlyLeader=true/false`：
 *    query 里的布尔串经 `@Type(() => Boolean)` 会把 `'false'` 转成 `true`
 *    （非空字符串一律为真），是「传了 false 却筛出全部」的经典陷阱。
 *
 * ⚠️ 按 `userId` 精确查询时，**即使该用户还没有账户**（`ab_balance` 无行）也返回
 *    一行 `hasAccount=false` 的全 0 视图 —— 否则运营「搜不到人 → 以为查无此用户 →
 *    不敢充值」，而 D39 恰恰支持给无账户用户首充建户。
 */
export class AdminBalancesQueryDto {
  @ApiPropertyOptional({ description: '按用户精确查询（`ab_user.id`）', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId?: number;

  @ApiPropertyOptional({
    description: `账户类型过滤：${BALANCE_ACCOUNT_TYPE_HINT}`,
    enum: BALANCE_ACCOUNT_TYPES,
    default: 'all',
  })
  @IsOptional()
  @IsIn(BALANCE_ACCOUNT_TYPES as unknown as string[], {
    message: `accountType 需为：${BALANCE_ACCOUNT_TYPE_HINT}`,
  })
  accountType?: string;

  @ApiPropertyOptional({
    description: '关键词：昵称 / 手机号（模糊匹配）',
    example: '1380000',
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

/**
 * D39 · 余额调整（充值 / 扣减 / 冻结 / 解冻）
 *
 * ⚠️ `amountFen` 是**整数分**（不是元）：管理端出参一律分，入参用分才对称；
 *    且 `IsInt` 天然挡掉 `0.1 + 0.2` 这类浮点残差。端上是元输入框，提交前自行换算。
 *
 * ⚠️ `reason` **必填**（《接口规范》D39 原文要求）：这笔钱为什么动，是日后唯一能
 *    回答「运营为什么给这个人加钱」的信息 —— 写进 `ab_balance_log.remark`。
 *
 * ⚠️ 本接口**必须**带幂等键（`Idempotency-Key`）：它没有业务单号可供判重，
 *    重复提交就是重复加钱（同 L12 提现）。
 */
export class AdminAdjustBalanceDto {
  @ApiProperty({
    description: '目标用户（`ab_user.id`）—— 用户与团长**共用同一小程序身份**，故此处不区分',
    example: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId!: number;

  @ApiProperty({
    description: `调整动作：${BALANCE_ADJUST_HINT}`,
    enum: BALANCE_ADJUST_ACTIONS,
    example: 'recharge',
  })
  @IsIn(BALANCE_ADJUST_ACTIONS as unknown as string[], {
    message: `action 需为：${BALANCE_ADJUST_HINT}`,
  })
  action!: string;

  @ApiProperty({
    description: '调整金额（**整数分 · 必须 > 0**；单笔上限 ¥1,000,000.00 防手滑）',
    example: 1000,
  })
  @Type(() => Number)
  @IsInt({ message: 'amountFen 需为整数分' })
  @Min(1, { message: 'amountFen 必须大于 0' })
  @Max(100_000_000, { message: '单笔调整金额不得超过 ¥1,000,000.00' })
  amountFen!: number;

  @ApiProperty({
    description: '调整原因（**必填** · 2–128 字 · 写入余额流水 remark）',
    example: '客服补偿：9-15 配送超时',
  })
  @IsString()
  @MinLength(2, { message: 'reason 至少 2 个字（这笔钱为什么动必须写清楚）' })
  @MaxLength(128, { message: 'reason 最长 128 字' })
  reason!: string;
}

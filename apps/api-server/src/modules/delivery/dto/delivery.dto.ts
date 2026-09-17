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

import { DELIVERY_STATUS_ORDER } from '@abox/shared-types';

/** `YYYY-MM-DD`（出餐日） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 单张配送单份数上限
 *
 * 为什么要有上限：份数是**照单装车**的数字，误输一位（5 → 99999）会让整条
 * 配送链按错误的量装货。给 9999 的余量（单楼群单日出餐量的数量级是 10²）足够，
 * 同时把「明显是手误」的输入挡在写库之前。
 */
export const MAX_DELIVERY_QUANTITY = 9999;

/** 修正原因的最小长度（至少 2 个字符 —— 「改」这种等于没写） */
const REASON_MIN = 2;
const REASON_MAX = 64;

/**
 * D61 · 配送单列表查询
 *
 * `date` 缺省时取**最近一个有配送单的出餐日**（不是「今天」）——
 * 配送单是 T 日 00:30 生成的，运营白天打开页面想看的是**今天这批**，
 * 而「今天」在 00:30 之前还没有单。用「最近有单的日期」才不会打开就是空页。
 */
export class DeliveryListQueryDto {
  @ApiPropertyOptional({ description: '出餐日 `YYYY-MM-DD`；缺省取最近一个有配送单的出餐日' })
  @IsOptional()
  @Matches(DATE_RE, { message: 'date 必须是 YYYY-MM-DD' })
  date?: string;

  @ApiPropertyOptional({ description: '楼群 id（只看某个楼群时传）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'buildingGroupId 必须是整数' })
  @Min(1, { message: 'buildingGroupId 必须为正整数' })
  buildingGroupId?: number;

  @ApiPropertyOptional({
    description: '配送状态筛选：`pending` / `called` / `en_route` / `arrived`',
  })
  @IsOptional()
  @IsIn([...DELIVERY_STATUS_ORDER], { message: 'status 不在允许范围内' })
  status?: string;
}

/**
 * D62 · 配送单人工修正
 *
 * ## 为什么需要这个接口（挂账 #61）
 * `DeliveryService.generateByDate()` 对已存在的 `(meal_date, building_group_id)` 行
 * **跳过不覆盖** —— 理由正当（司机 / 车牌是人工录入的，跑批抹掉就找不回来），
 * 但代价是 `total_quantity` **也被一起冻住**：截单跑晚、或补跑改过份数之后，
 * 表里的份数与实际要送的份数会**长期不一致，而且没有任何页面能改**
 * （`DeliveryController` 此前是空壳）—— 这个口子只存在 DBA 手里。
 *
 * ## 只允许改这五样
 * 份数 / 司机 / 司机电话 / 车牌 / 备注。
 *
 * ⚠️ **不含 `status`**：配送状态是履约流转（`called` → `en_route` → `arrived`），
 *    有它自己的时点与责任，属独立批次；把状态也塞进「人工修正」会让
 *    「改数字」与「推进履约」混成同一个动作，审计上分不清。
 *
 * ## `version` 与 `reason` 都是必填
 * · `version` —— 乐观锁。两个运营先后改同一张单（A 改份数 / B 改司机），
 *   B 的**旧快照**会把 A 的份数一起覆盖回去，双方都不报错，直到装错货。
 *   提交时带上从列表拿到的 `version`，服务端 CAS 校验，不匹配即 `30016`。
 * · `reason` —— 审计要求。份数被改这件事**必须能回答「为什么」**，
 *   否则三个月后看到「5 → 3」无从判断是谁的锅。它不写进 `remark`
 *   （那是给配送员看的备注，混入审计原因会污染），而是随请求体进
 *   `ab_operation_log.request_data`，在 D56 操作日志页可查。
 */
export class DeliveryPatchDto {
  @ApiProperty({ description: '乐观锁版本号（取列表出参的 `version`，原样回传）' })
  @IsInt({ message: 'version 必须是整数' })
  @Min(0, { message: 'version 不能为负' })
  version!: number;

  @ApiProperty({ description: `修正原因（${REASON_MIN}–${REASON_MAX} 字，写入操作日志）` })
  @IsString({ message: 'reason 必须是字符串' })
  @MinLength(REASON_MIN, { message: `修正原因至少 ${REASON_MIN} 个字` })
  @MaxLength(REASON_MAX, { message: `修正原因最多 ${REASON_MAX} 个字` })
  reason!: string;

  @ApiPropertyOptional({
    description: '配送份数（0 表示该楼群当日一份都不送；不允许负数）',
    minimum: 0,
    maximum: MAX_DELIVERY_QUANTITY,
  })
  @IsOptional()
  @IsInt({ message: 'totalQuantity 必须是整数' })
  @Min(0, { message: 'totalQuantity 不能为负' })
  @Max(MAX_DELIVERY_QUANTITY, { message: `totalQuantity 不能超过 ${MAX_DELIVERY_QUANTITY}` })
  totalQuantity?: number;

  @ApiPropertyOptional({ description: '司机姓名（传空字符串 = 清空）' })
  @IsOptional()
  @IsString({ message: 'driverName 必须是字符串' })
  @MaxLength(64, { message: 'driverName 最多 64 字' })
  driverName?: string;

  @ApiPropertyOptional({ description: '司机电话（传空字符串 = 清空）' })
  @IsOptional()
  @IsString({ message: 'driverPhone 必须是字符串' })
  @MaxLength(20, { message: 'driverPhone 最多 20 字' })
  driverPhone?: string;

  @ApiPropertyOptional({ description: '车牌（传空字符串 = 清空）' })
  @IsOptional()
  @IsString({ message: 'plateNo 必须是字符串' })
  @MaxLength(16, { message: 'plateNo 最多 16 字' })
  plateNo?: string;

  @ApiPropertyOptional({ description: '配送备注（给配送员看 · 传空字符串 = 清空）' })
  @IsOptional()
  @IsString({ message: 'remark 必须是字符串' })
  @MaxLength(256, { message: 'remark 最多 256 字' })
  remark?: string;
}

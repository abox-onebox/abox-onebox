import { ApiProperty } from '@nestjs/swagger';
import { Matches, MaxLength, MinLength } from 'class-validator';

/** `YYYY-MM-DD`（出餐日）—— 只校验形状，不校验是否真实存在的日期（DB 侧 DATE 兜底） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 停售原因的长度下限
 *
 * ⚠️ 为什么是 4 而不是 1：这段文案会**原样下发到用户端**（「今日暂停接单」页）。
 *    「停」「停售」这类输入等于没写 —— 用户看到的是一个不知所云的页面，
 *    而运营以为自己留了说明。4 个字刚好够说清「设备检修」这类真实原因。
 */
const REASON_MIN = 4;
/** 与 `ab_sales_pause.reason` 的 `VARCHAR(255)` 对齐 */
const REASON_MAX = 255;

/**
 * W1 · 创建全局停售区间
 *
 * ⚠️ **只有三个字段，没有「开关」字段**：停售状态 = 「存在一条覆盖该出餐日且
 *    `resumed_at IS NULL` 的记录」。再加一个 `enabled` 就是第二份真相 ——
 *    运营停了售却忘了开开关（或反之），页面上「成功」而实际没生效，与本批
 *    要消灭的失败形态**完全同形**。
 *
 * ⚠️ `from == to` 是**合法**的（「停售明日」就是这个形态）。`from > to` 才是错，
 *    由 service 抛 `PARAM_INVALID`（DTO 层不做跨字段校验 —— 形状校验归 DTO，
 *    语义校验归 service，各守各的，避免第二份判据）。
 *
 * ⚠️ 全局 `ValidationPipe` 开了 `forbidNonWhitelisted`：未声明的字段会被**直接拒成
 *    10001**，不是静默忽略。故本 DTO 的字段集合 = 接口契约，一个都不能少。
 */
export class CreateSalesPauseDto {
  @ApiProperty({
    description: '停售起始出餐日 `YYYY-MM-DD`（含）',
    example: '2026-10-27',
  })
  @Matches(DATE_RE, { message: 'mealDateFrom 必须是 YYYY-MM-DD' })
  mealDateFrom!: string;

  @ApiProperty({
    description: '停售截止出餐日 `YYYY-MM-DD`（含）；允许等于 mealDateFrom（只停一天）',
    example: '2026-10-27',
  })
  @Matches(DATE_RE, { message: 'mealDateTo 必须是 YYYY-MM-DD' })
  mealDateTo!: string;

  @ApiProperty({
    description:
      '停售原因（**必填**，至少 4 个字符）。这段文案会随用户端「不可下单」提示原样下发，' +
      '请写一句用户看得懂的人话，如「后厨设备检修，明日恢复」。',
    example: '后厨设备检修，明日恢复',
  })
  @MinLength(REASON_MIN, { message: `停售原因至少 ${REASON_MIN} 个字符（会下发到用户端）` })
  @MaxLength(REASON_MAX, { message: `停售原因过长（上限 ${REASON_MAX} 字符）` })
  reason!: string;
}

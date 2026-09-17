import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

/**
 * 手动补跑定时任务的入参（`POST /admin/schedule/{task}/run`）
 *
 * ⚠️ `date` **可选**：
 *   · 不传 → 按 `TASK_SCHEDULES[task].dateKind` 推导（与跑批完全同一天，
 *     这是补跑的正常用法 —— 「昨晚没跑成，现在补上」）
 *   · 传 → 显式指定目标日期（「补一个特定日期的数据」）
 *
 * ⚠️ 只做**格式**校验，不做「是否已过该日期」之类的业务判断 ——
 *    补跑本来就常用于补过去的日期，在这里拦会把正当用途挡掉。
 *    真正的业务闸门在各服务内（如开团的 `isAfterCutoff`）。
 */
export class RunTaskDto {
  @ApiPropertyOptional({
    description: '目标日期（yyyy-MM-dd）。不传则按任务的日期语义推导（今日/明日/昨日）',
    example: '2026-09-17',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date 须为 yyyy-MM-dd 格式' })
  date?: string;
}

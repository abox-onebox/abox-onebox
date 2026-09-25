import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

import { MESSAGE_TEMPLATE_SPECS } from '../../admin/template/message-template.specs';
import { AUDIENCE_SELECTORS } from '../message-orchestrator.service';

/** 合法场景键 —— 由**服务端声明**派生，不在 DTO 里手抄一份 */
const SCENE_KEYS = MESSAGE_TEMPLATE_SPECS.map((s) => s.scene);
/** 合法受众选择器键 —— 同上 */
const AUDIENCE_KEYS = Object.keys(AUDIENCE_SELECTORS);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * F5 编排请求（`POST /admin/messages/orchestrate`）
 *
 * ## ⚠️ 为什么 `audience` 是**枚举**而不是 `userId[]`
 *
 * 收一个 `userId[]` 就等于给后台开了一个「给谁都能发」的群发后门 —— 有了它，
 * 不会再有人走业务链路。故只接受**预定义受众选择器**，且选择器与场景**强绑定**
 * （见 `MessageOrchestratorService` 类头注释①）。
 *
 * ## ⚠️ `dryRun` 在这里**不给默认值**
 *
 * 「缺省预演（`dryRun=true`）」这一 fail-safe 语义定义在**服务层**
 * （`MessageOrchestratorService.orchestrate()` 的 `input.dryRun !== false`）。
 * 若在 DTO 上用 `@Transform`/默认赋值把它补成 `false`，就会**静默推翻**那个安全默认 ——
 * 于是「一个不带参数的 POST 就群发」。故 DTO **只做透传与类型校验**，不设默认。
 *
 * ## 只读字段一律拒绝
 *
 * 全局 `ValidationPipe` 开了 `forbidNonWhitelisted`：传入未声明字段 → `10001` + `data.fields`，
 * **不静默忽略**（静默忽略最坏：调用方以为发成功了）。
 */
export class OrchestrateDto {
  @ApiProperty({
    description: '场景键（须在服务端场景声明清单内）',
    enum: SCENE_KEYS,
    example: 'cutoff_remind',
  })
  @IsString({ message: 'scene 必须为字符串' })
  @IsIn(SCENE_KEYS, { message: `scene 须为服务端声明的场景之一：${SCENE_KEYS.join(' / ')}` })
  scene!: string;

  @ApiProperty({
    description: '受众选择器键（预定义 · 与场景绑定）',
    enum: AUDIENCE_KEYS,
    example: 'cutoff_remind_pending',
  })
  @IsString({ message: 'audience 必须为字符串' })
  @IsIn(AUDIENCE_KEYS, {
    message: `audience 须为预定义选择器之一：${AUDIENCE_KEYS.join(' / ')}（不接受任意用户列表）`,
  })
  audience!: string;

  @ApiPropertyOptional({
    description: '目标出餐日（YYYY-MM-DD）；缺省 = 明日（一期唯一可下单日）',
    example: '2026-09-26',
  })
  @IsOptional()
  @Matches(DATE_RE, { message: 'mealDate 须为 YYYY-MM-DD 格式' })
  mealDate?: string;

  @ApiPropertyOptional({
    description:
      '预演：只解析受众、不投递。⚠️ **缺省 true（安全默认）** —— 要真发必须显式传 false。',
    example: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'dryRun 必须为布尔值' })
  dryRun?: boolean;

  @ApiPropertyOptional({
    description: '本次受众上限（默认 500，上限 2000）；超出会截断并回带 `truncated: true`',
    example: 500,
  })
  @IsOptional()
  @IsInt({ message: 'limit 必须为整数' })
  @Min(1, { message: 'limit 最小为 1' })
  @Max(2000, { message: 'limit 最大为 2000' })
  limit?: number;
}

/**
 * F5 到达率查询（`GET /admin/messages/reach`）
 *
 * ⚠️ 日期格式在 DTO 层校验，**语义**（是否真实存在该日 / 区间是否过大）由服务层校验 ——
 *    分工明确：DTO 挡明显拼错的形状，服务层挡「格式对但无意义」的值（`2026-02-31`、区间 900 天）。
 *    两层都**不静默回落**：传了非法值就报 `10001`，不偷偷换成默认区间。
 */
export class ReachQueryDto {
  @ApiPropertyOptional({
    description: '起始北京日（YYYY-MM-DD）；缺省 = `to` 往前 6 天（近 7 天）',
    example: '2026-09-19',
  })
  @IsOptional()
  @Matches(DATE_RE, { message: 'from 须为 YYYY-MM-DD 格式' })
  from?: string;

  @ApiPropertyOptional({
    description: '截止北京日（YYYY-MM-DD）；缺省 = 今日',
    example: '2026-09-25',
  })
  @IsOptional()
  @Matches(DATE_RE, { message: 'to 须为 YYYY-MM-DD 格式' })
  to?: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * D60 编辑通知模板（单条）
 *
 * ## ⚠️ 为什么只有三个字段，且**没有** `scene` / `channels`
 *
 * `scene`、渠道组合、触发时机、变量白名单是**代码事实**（见 `message-template.specs.ts`），
 * 不是可编辑配置。把它们写进 DTO 就等于允许运营改场景键 —— 而代码是按 `scene`
 * 分派投递的，改了就再也收不到。
 *
 * **传入只读字段会怎样？** 全局 `ValidationPipe` 已开 `forbidNonWhitelisted: true`，
 * 未声明的字段会被**直接拒绝**（`10001` + `data.fields`），而不是静默忽略 ——
 * 静默忽略最坏：调用方以为改成功了。这条与 D58 的「未知键拒绝」同源。
 *
 * ## ⚠️「未传」与「传 null」是两种语义（*不是* 同一种）
 *
 * - 字段**缺省** → 不改这一项（保持库中原值）
 * - 字段**显式传 `null`** → 清空这一项
 *
 * 判定必须用 `!== undefined`，**不能用** `'field' in dto`：DTO 实例的类字段声明
 * 会以 `undefined` 初始化，`in` 恒为 `true`（`target: ES2022` ⇒
 * `useDefineForClassFields` 默认开启）。这个坑本项目已踩过（见《缺陷与陷阱》#46）。
 * `@IsOptional()` 恰好与之一致：`null` 与 `undefined` 均跳过后续校验。
 */
export class UpdateMessageTemplateDto {
  @ApiPropertyOptional({
    description: '总开关：1 启用 / 0 关闭（启用受「渠道必要条件」闸门约束，缺项将被拒绝）',
    enum: [0, 1],
    example: 1,
  })
  @IsOptional()
  @IsIn([0, 1], { message: 'enabled 只能是 0 或 1' })
  enabled?: number;

  @ApiPropertyOptional({
    description:
      '微信订阅消息模板 ID（在微信公众平台创建）。传 null 或空串表示**清空**；' +
      '清空后该场景若含订阅消息渠道，启用闸门将不允许其为启用态。',
    example: 'AbCdEf1234567890',
  })
  @IsOptional()
  @IsString({ message: 'wechatTemplateId 必须为字符串' })
  @MaxLength(64, { message: 'wechatTemplateId 过长（上限 64 字符）' })
  wechatTemplateId?: string | null;

  @ApiPropertyOptional({
    description:
      '微信群人工通知文案。可含 `{{变量}}`，变量名须在该场景白名单内（未在白名单内会被拒绝）。' +
      '⚠️ 该字段**不改变微信订阅消息的内容**（那由微信侧模板决定）。',
    example: '【ABox 取餐提醒】{{mealDate}} 的午餐已送达 {{buildingName}} 楼下。',
  })
  @IsOptional()
  @IsString({ message: 'groupContent 必须为字符串' })
  @MaxLength(500, { message: 'groupContent 过长（上限 500 字符）' })
  groupContent?: string | null;
}

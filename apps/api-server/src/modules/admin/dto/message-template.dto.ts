import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

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

/**
 * D60+ · 把「代码声明里有、库里没有」的场景落库（2026-11-18 新增）
 *
 * ## 为什么需要它
 *
 * `PUT /admin/templates/:id` 只能改**已存在的行**（`findOne` 找不到就 404），
 * 而行的唯一创建途径是种子脚本 —— 生产环境**不跑 seed**（会污染真实数据）。
 * 结果：新增场景（如 N2 的 `building_suspend_fulfill` / `building_suspend_refund`）
 * 在后台永远显示「尚未落库」，运营**填不了模板 ID**，那两条通知也就永远发不出去。
 *
 * ⇒ 补一个幂等的落库入口：按 `scene` 判定，已存在则等同一次编辑，
 *   不存在则按声明的 `seed` 落一行，随后复用 `update()` 的全部校验。
 *
 * ⚠️ 场景键仍**只允许来自声明**（`MESSAGE_TEMPLATE_SPEC_MAP`），
 *   不接受任意字符串 —— 否则又变成「可以凭空造场景」。
 */
export class CreateMessageTemplateDto extends UpdateMessageTemplateDto {
  @ApiPropertyOptional({
    description: '场景键（须在服务端场景声明内；已存在则幂等，等同一次编辑）',
    example: 'building_suspend_fulfill',
  })
  @IsString({ message: 'scene 必须为字符串' })
  @MaxLength(64, { message: 'scene 过长（上限 64 字符）' })
  scene!: string;
}

/**
 * D60++ · 校验「填进来的模板 ID」与场景声明是否对得上（2026-11-18 新增）
 *
 * ## 为什么模板 ID 要**显式传**，而不是从库里读
 *
 * 让运营在**保存之前**就能校验：填完 ID 先点一下「校验」，通过了再保存/启用。
 * 若从库里读，就必须先保存才能校验，等于把「发现填错」推迟到「已经存进去之后」。
 *
 * `wechatTemplateId` 必填而非可选，也是同一个理由 —— 允许缺省会让"校验"与
 * "库里那行"产生歧义（到底校验的是页面上的，还是库里的？）。
 */
export class VerifyTemplateDto {
  @ApiProperty({
    description: '场景键（须在服务端场景声明内）',
    example: 'cutoff_remind',
  })
  @IsString({ message: 'scene 必须为字符串' })
  @IsNotEmpty({ message: 'scene 不能为空' })
  @MaxLength(64, { message: 'scene 过长（上限 64 字符）' })
  scene!: string;

  @ApiProperty({
    description: '要校验的微信模板 ID（运营在公众平台「我的模板」里复制的那串）',
    example: '9Aw5ZV1j9xdWTFEkqCpZ7mIBbSC34khK55OtzUPl0rU',
  })
  @IsString({ message: 'wechatTemplateId 必须为字符串' })
  @IsNotEmpty({ message: '请先填微信模板 ID 再校验' })
  @MaxLength(64, { message: 'wechatTemplateId 过长（上限 64 字符）' })
  wechatTemplateId!: string;
}

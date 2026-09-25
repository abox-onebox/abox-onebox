import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * U19 · 账号注销入参（M5-20）
 *
 * ## ⚠️ 为什么必须**手打确认词**，而不是一个 `confirm: true`
 *
 * 注销是**不可逆**动作（`ab_user.status` 置 3 后同一微信号登录会被 20014 拦下，
 * 恢复只能走客服人工）。一个布尔量在三种情况下都会被误发：
 *   ① 端上按钮没做二次确认，用户点错；
 *   ② 脚本 / 联调工具复制上一发请求时漏改字段；
 *   ③ 未来某个页面「顺手」带上了 `confirm: true`。
 * 要求 `confirmText === '注销账号'`（逐字）把「我确实要注销」变成一个**必须显式
 * 打出来的词** —— 这是 GitHub 删库同款闸门，成本极低、拦得住上面三种。
 *
 * ⚠️ 确认词由**服务端**校验（`ACCOUNT_CANCEL_CONFIRM_TEXT`），端上那份只是
 *    提示文案。若两端不一致 ⇒ 注销请求报 `10001`，**是可见的失败**，不是静默放行。
 */
export const ACCOUNT_CANCEL_CONFIRM_TEXT = '注销账号';

export class UserCancelDto {
  @ApiProperty({
    description: `确认词，必须逐字等于「${ACCOUNT_CANCEL_CONFIRM_TEXT}」`,
    example: ACCOUNT_CANCEL_CONFIRM_TEXT,
  })
  @IsString()
  @MaxLength(32)
  confirmText!: string;

  @ApiPropertyOptional({ description: '注销原因（选填，仅留痕，不影响处理）' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

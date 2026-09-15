import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** 微信登录入参 */
export class LoginDto {
  @ApiProperty({
    description:
      'wx.login() 返回的 code。PROVIDER_MODE=mock 时可用 `dev:<标识>` 直接指定固定身份，如 dev:1001',
    example: 'dev:1001',
  })
  @IsString()
  @IsNotEmpty({ message: 'code 不能为空' })
  code!: string;

  @ApiPropertyOptional({ description: '昵称（首次登录写入，后续不覆盖）' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  nickname?: string;

  @ApiPropertyOptional({ description: '头像 URL（首次登录写入）' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  avatarUrl?: string;

  @ApiPropertyOptional({ description: '邀请码（团长 id 派生），用于绑定推荐关系（C2）' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  inviteCode?: string;
}

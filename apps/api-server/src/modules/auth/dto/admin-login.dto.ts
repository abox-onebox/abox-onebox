import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** A2 后台登录入参（运营 + 供应商同一接口，按账号角色返回不同菜单） */
export class AdminLoginDto {
  @ApiProperty({ description: '后台账号登录名', example: 'admin' })
  @IsString()
  @IsNotEmpty({ message: '账号不能为空' })
  @MaxLength(64)
  username!: string;

  @ApiProperty({ description: '密码', example: 'admin123' })
  @IsString()
  @IsNotEmpty({ message: '密码不能为空' })
  @MinLength(6, { message: '密码至少 6 位' })
  @MaxLength(128)
  password!: string;

  @ApiPropertyOptional({
    description: '图形验证码（一期未接入，前端不传，字段预留以免二期改契约）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  captcha?: string;
}

/** A3 刷新令牌入参 */
export class RefreshTokenDto {
  @ApiProperty({ description: 'A2/A1 返回的 refreshToken' })
  @IsString()
  @IsNotEmpty({ message: 'refreshToken 不能为空' })
  refreshToken!: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/** A6 修改口令（首次登录强制改密 / 定期改密） */
export class ChangePasswordDto {
  @ApiProperty({ description: '原口令' })
  @IsString()
  @IsNotEmpty({ message: '原口令不能为空' })
  @MaxLength(128)
  oldPassword!: string;

  @ApiProperty({ description: '新口令（≥10 位，含字母与数字）' })
  @IsString()
  @IsNotEmpty({ message: '新口令不能为空' })
  @MinLength(10, { message: '新口令至少 10 位' })
  @MaxLength(128)
  newPassword!: string;
}

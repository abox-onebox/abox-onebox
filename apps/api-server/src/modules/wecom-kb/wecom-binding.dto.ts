import { IsOptional, IsString, MaxLength } from 'class-validator';

/** 预绑定 DTO（super_admin / admin 调用）。令牌留空字符串 = 清空该令牌。 */
export class UpsertWecomBindingDto {
  @IsString()
  @MaxLength(64)
  userId!: string;

  @IsString()
  @MaxLength(64)
  operatorName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  operatorToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  approverToken?: string;
}

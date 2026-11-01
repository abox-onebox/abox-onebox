import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** 预绑定 DTO（super_admin / admin 调用）。令牌留空字符串 = 清空该令牌。 */
export class UpsertWecomBindingDto {
  @IsString()
  @MaxLength(64)
  userId!: string;

  @IsString()
  @MaxLength(64)
  operatorName!: string;

  /** 身份等级：owner=负责人（admin 角色，全端点）/ staff=同事（operator 角色，默认） */
  @IsOptional()
  @IsIn(['owner', 'staff'])
  tier?: 'owner' | 'staff';

  @IsOptional()
  @IsString()
  @MaxLength(512)
  operatorToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  approverToken?: string;
}

/** 只改身份等级（放权 / 收回） */
export class SetWecomTierDto {
  @IsIn(['owner', 'staff'])
  tier!: 'owner' | 'staff';
}

import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

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

  /** 单独放权清单（端点编码）；省略 = 不改动已有清单 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  grantedOps?: string[];

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

/**
 * 只改「单独放权的功能清单」。
 *
 * 传空数组 = 收回全部放权（安全动作：同事退回 operator 本来的能力，不会被他做不了任何事）。
 * 上限 200 是**远大于**当前目录条数（131）的保守闸门：它只防「一次塞几万条」的滥用，
 * 不承担「哪些编码合法」的判定 —— 那件事由 `normalizeGrant` 逐条对目录校验。
 */
export class SetWecomGrantDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ops!: string[];
}

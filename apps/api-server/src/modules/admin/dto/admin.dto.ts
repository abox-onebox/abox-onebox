import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { ADMIN_ROLES } from '../../../common/constants/admin-role';

const ROLE_HINT = ADMIN_ROLES.join(' / ');

/** D51 运营账号列表查询 */
export class AdminAccountQueryDto {
  @ApiPropertyOptional({ description: '模糊匹配账号 / 姓名 / 手机号' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;

  @ApiPropertyOptional({ description: `角色过滤：${ROLE_HINT}` })
  @IsOptional()
  @IsIn(ADMIN_ROLES, { message: `role 需为：${ROLE_HINT}` })
  role?: string;

  @ApiPropertyOptional({ description: '状态过滤：1 启用 / 2 停用' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([1, 2])
  status?: number;

  @ApiPropertyOptional({ description: '页码，默认 1' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数，默认 20，上限 100' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

/**
 * D52 新增后台账号
 *
 * ⚠️ `role='supplier'` 时 `supplierId` **必填**（服务端强制）—— 否则该账号登录后
 *    能进供应商端却查不到任何数据，表现为「空白页」而非明确报错。
 */
export class CreateAdminUserDto {
  @ApiProperty({ description: '登录名（唯一）', example: 'operator01' })
  @IsString()
  @IsNotEmpty({ message: '登录名不能为空' })
  @Matches(/^[a-zA-Z0-9_.-]{3,64}$/, {
    message: '登录名需为 3–64 位字母、数字或 _ . -',
  })
  username!: string;

  @ApiProperty({ description: '初始密码（≥8 位，含字母与数字）', example: 'Abox@2026' })
  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  @MaxLength(128)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, { message: '密码需同时包含字母与数字' })
  password!: string;

  @ApiProperty({ description: `角色：${ROLE_HINT}`, example: 'operator' })
  @IsIn(ADMIN_ROLES, { message: `role 需为：${ROLE_HINT}` })
  role!: string;

  @ApiPropertyOptional({ description: '姓名', example: '张三' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  realName?: string;

  @ApiPropertyOptional({ description: '绑定的供应商 ID（role=supplier 时必填）', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  supplierId?: number;

  @ApiPropertyOptional({ description: '手机号', example: '13800000000' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}

/** D53 编辑 / 停用后台账号（**不含密码**；改密走独立审计路径，一期由超级管理员重建） */
export class UpdateAdminUserDto {
  @ApiPropertyOptional({ description: '姓名' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  realName?: string;

  @ApiPropertyOptional({ description: `角色：${ROLE_HINT}` })
  @IsOptional()
  @IsIn(ADMIN_ROLES, { message: `role 需为：${ROLE_HINT}` })
  role?: string;

  @ApiPropertyOptional({ description: '绑定的供应商 ID' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  supplierId?: number;

  @ApiPropertyOptional({ description: '手机号' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ description: '状态：1 启用 / 2 停用' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([1, 2], { message: 'status 需为 1（启用）或 2（停用）' })
  status?: number;
}

/** D56 操作日志查询 */
export class OperationLogQueryDto {
  @ApiPropertyOptional({ description: '操作人 ab_admin_user.id' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  operatorId?: number;

  @ApiPropertyOptional({ description: '模块名，如 order / supplier / finance' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  module?: string;

  @ApiPropertyOptional({ description: '日期 YYYY-MM-DD（按北京时间当天过滤）' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date 需为 YYYY-MM-DD' })
  date?: string;

  @ApiPropertyOptional({ description: '页码，默认 1' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数，默认 20，上限 100' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

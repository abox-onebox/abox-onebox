import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min, ValidateIf } from 'class-validator';

import { UserStatus } from '../../../common/constants/user-status';

/**
 * 后台 · C 端用户管理 DTO
 *
 * ⚠️ 校验分层（与 `building-admin.dto.ts` / `leader-admin.dto.ts` 同一纪律）：
 *   类级装饰器 → 只管「类型 / 格式 / 枚举合法性」（失败即 10001）
 *   服务层     → 管「业务语义」（用户不存在 20002、楼不存在 60001）
 *
 * ⚠️ `UpdateUserDto` **刻意不声明 `teamLeaderId`**：换楼即按新楼重算归属
 *   （`UserAdminService.update` 会清 `team_leader_id`）。开放该字段等于让运营
 *   手工指定「佣金归谁」，与 `PUT /me/building` 的规则互相打架。
 */
export class AdminUsersQueryDto {
  @ApiPropertyOptional({ description: '关键词（昵称 / 手机号 / openid 后 6 位）' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;

  @ApiPropertyOptional({ description: '办公楼 id 过滤' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '办公楼 id 需为整数' })
  @Min(1)
  buildingId?: number;

  @ApiPropertyOptional({ description: '账号状态：1 正常 / 2 黑名单 / 3 已注销' })
  @IsOptional()
  @Type(() => Number)
  @IsIn(Object.values(UserStatus), { message: '状态需为 1（正常）/ 2（黑名单）/ 3（已注销）' })
  status?: number;

  @ApiPropertyOptional({
    description: '绑楼状态：bound 已绑 / unbound 未绑（未绑的人下不了单，是运营要盯的）',
  })
  @IsOptional()
  @IsIn(['bound', 'unbound'], { message: '绑楼过滤需为 bound 或 unbound' })
  bindState?: string;

  @ApiPropertyOptional({ description: '页码，从 1 起', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数（上限 100，见 §1.3）', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

export class UserIdParamDto {
  @ApiProperty({ description: 'C 端用户 id（ab_user.id）' })
  @Type(() => Number)
  @IsInt({ message: '用户 id 需为整数' })
  @Min(1)
  id!: number;
}

export class UpdateUserDto {
  /**
   * 所属办公楼 —— **传 `null` 表示解绑**（`@ValidateIf` 让 null 跳过 `@IsInt`）
   *
   * ⚠️ 为什么必须支持 null：用户绑错楼时运营要能「先解绑、让他自己重选」，
   *    否则只能把他硬塞到另一栋楼 —— 而那栋楼可能也不是他的。
   */
  @ApiPropertyOptional({
    description: '办公楼 id；传 null 表示解绑（解绑后该用户下不了单，需重新选楼）',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o: UpdateUserDto) => o.buildingId !== null)
  @Type(() => Number)
  @IsInt({ message: '办公楼 id 需为整数' })
  @Min(1)
  buildingId?: number | null;

  /**
   * 账号状态：1 正常 / 2 黑名单
   *
   * ⚠️ **刻意不接受 3（已注销）**：注销是**用户自主发起**的动作，
   *    且注销前有三道资金闸门（`UserService.cancelAccount`）。运营若能把人
   *    「改成已注销」，就等于绕开闸门把有钱、有在途订单的账号一键注销。
   *    恢复已注销账号同样不在本接口 —— 走客服人工。
   */
  @ApiPropertyOptional({ description: '账号状态：1 正常 / 2 黑名单（不接受 3 已注销）' })
  @IsOptional()
  @Type(() => Number)
  @IsIn([UserStatus.NORMAL, UserStatus.BLACKLIST], {
    message: '状态只能改为 1（正常）或 2（黑名单）；已注销账号需人工恢复',
  })
  status?: number;

  // ⚠️ 刻意不声明 teamLeaderId —— 见文件头说明（归属随楼重算）
}

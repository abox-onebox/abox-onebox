import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AdminUsersQueryDto, UpdateUserDto, UserIdParamDto } from './dto/user-admin.dto';
import { UserAdminService } from './user-admin.service';

/**
 * 后台 · C 端用户管理（`admin/users/*`）
 *
 * ## ⚠️ 与 `/admin/system/accounts` 的区别（名字都带「用户」，别混）
 *
 * | 端点 | 管的是谁 | 表 |
 * |------|----------|-----|
 * | `admin/users/*`（本文件） | **C 端微信用户**（吃盒饭的人） | `ab_user` |
 * | `admin/system/accounts` | **后台运营账号**（客服、财务） | `ab_admin_user` |
 *
 * 两者混在一起会让「拉黑一个恶意下单的用户」和「停用一个运营账号」互相污染 ——
 * 后者涉及后台权限，前者只是业务数据。
 *
 * ## 为什么本文件此前根本不存在
 *
 * 全仓 83 个 `/admin/*` 端点里**没有一个 C 端用户的**：运营查不到人、
 * 代绑不了楼、也拉不黑（`ab_user.status = 2` 有语义、登录侧有拦截 `20006`，
 * 但**没有任何入口能把它置上** —— 有锁没钥匙）。详见 `UserAdminService` 头注。
 *
 * ## 两级白名单
 * 类级 `super_admin` / `admin` / `operator` —— 客服代绑楼栋是运营的日常；
 * `finance` / `viewer` / `supplier` 一律 10003（财务与只读角色不进用户域，
 * 手机号尾号与 openid 尾号属个人信息，不该给无关角色）。
 *
 * ⚠️ 路由顺序：`GET filter-options` 必须在 `GET :id` **之前**
 *    （同 `/admin/leaders/filter-options` 的坑）。
 */
@ApiTags('后台·用户管理')
@ApiBearerAuth()
@Controller('admin/users')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class UserAdminController {
  constructor(private readonly userAdmin: UserAdminService) {}

  @Get()
  @ApiOperation({
    summary: 'C 端用户名录（分页 · 关键词 / 办公楼 / 状态 / 绑楼状态过滤）',
    description:
      '手机号一律脱敏、openid 只回后 6 位。\n\n' +
      '⭐ `summary.unboundCount` = **未绑楼**的人数 —— 这些人下不了单（端上报 20016），' +
      '而他们自己只知道「首页一片空白」。这个数从 0 变正就是在报警。',
  })
  list(@Query() q: AdminUsersQueryDto) {
    return this.userAdmin.list(q);
  }

  @Get('filter-options')
  @ApiOperation({ summary: '筛选器下拉（办公楼 / 账号状态 / 绑楼状态）' })
  filterOptions() {
    return this.userAdmin.filterOptions();
  }

  @Get(':id')
  @ApiOperation({
    summary: '用户详情（档案 + 余额 + 最近 10 单）',
    description:
      '⭐ `note` 字段会**直接说清下不了单的原因与修法** —— ' +
      '「未绑楼」（用户可自助 / 后台可代绑）与「楼未归群」（只能运营配楼群）' +
      '在端上表现一模一样，但在后台必须分开讲，否则运营会拿错药方。',
  })
  detail(@Param() p: UserIdParamDto) {
    return this.userAdmin.detail(p.id);
  }

  @Put(':id')
  @Roles('super_admin', 'admin', 'operator')
  @OperationLog({ module: 'user', action: '修改 C 端用户', targetParam: 'id' })
  @ApiOperation({
    summary: '修改 C 端用户（代绑 / 解绑办公楼 · 拉黑 / 恢复正常）',
    description:
      '改楼会**清空 `team_leader_id`**，跟随团长由服务端按新楼重算 —— ' +
      '与 `PUT /me/building` 同一规则。\n\n' +
      '⚠️ **刻意不接受 `status = 3`（已注销）**：注销是用户自主发起且有三道资金闸门，' +
      '运营改状态等于绕开闸门把有钱、有在途订单的账号一键注销。\n\n' +
      '目标值与当前值一致时返回 `changed: []`（不是错误）。',
  })
  update(@Param() p: UserIdParamDto, @Body() dto: UpdateUserDto) {
    return this.userAdmin.update(p.id, dto);
  }
}

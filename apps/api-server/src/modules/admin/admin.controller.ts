import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AdminUserService } from './admin-user/admin-user.service';
import { AdminRoleService } from './role/role.service';
import { OperationLogService } from './operation-log/operation-log.service';
import {
  AdminAccountQueryDto,
  CreateAdminUserDto,
  OperationLogQueryDto,
  UpdateAdminUserDto,
} from './dto/admin.dto';

/**
 * 后台 · 系统管理（D51–D56）· 见《接口规范 v1.0》§6.7
 *
 * ⚠️ **`@Roles('super_admin','admin')` 打在类上**：系统管理（账号/角色/日志）
 *    只对这两个角色开放。`operator` 的菜单矩阵本就不含 `/system/*`，
 *    这里是**服务端兜底** —— 前端菜单过滤是体验，不是安全边界（M3 验收标准 1）。
 */
@ApiTags('后台·系统管理')
@ApiBearerAuth()
@Controller('admin/system')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin')
export class AdminController {
  constructor(
    private readonly adminUserService: AdminUserService,
    private readonly adminRoleService: AdminRoleService,
    private readonly operationLogService: OperationLogService,
  ) {}

  // ------------------------------------------------------------ D51–D53 账号

  @Get('accounts')
  @ApiOperation({ summary: 'D51 运营账号列表（分页 + 角色/状态/关键词过滤）' })
  listAccounts(@Query() q: AdminAccountQueryDto) {
    return this.adminUserService.list(q);
  }

  @Post('accounts')
  @OperationLog({ module: 'system', action: '新增后台账号' })
  @ApiOperation({ summary: 'D52 新增后台账号（口令用 scrypt 哈希入库，永不回显）' })
  createAccount(@Body() dto: CreateAdminUserDto) {
    return this.adminUserService.create(dto);
  }

  @Put('accounts/:id')
  @OperationLog({ module: 'system', action: '编辑后台账号' })
  @ApiOperation({
    summary: 'D53 编辑 / 停用账号',
    description:
      '三条防自锁规则（20010）：不能停用自己、不能降级自己、不能动最后一个启用的超管。' +
      '角色或状态变更时会吊销该账号的旧令牌（AdminGuard 即时生效）。',
  })
  updateAccount(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAdminUserDto,
    @CurrentAdmin('sub') operatorId: number,
  ) {
    return this.adminUserService.update(id, dto, operatorId);
  }

  // ------------------------------------------------------------ D54–D55 角色

  @Get('roles')
  @ApiOperation({ summary: 'D54 角色与权限矩阵（只读；菜单 key = 前端路由 path）' })
  listRoles() {
    return this.adminRoleService.matrix();
  }

  @Put('roles/:role')
  @OperationLog({ module: 'system', action: '调整角色权限' })
  @ApiOperation({
    summary: 'D55 权限调整 —— 一期不支持（10001）',
    description: '一期角色菜单由服务端代码定义，需改权限请走 D53 调整账号角色。',
  })
  updateRole(@Param('role') role: string) {
    return this.adminRoleService.updateRole(role);
  }

  // ------------------------------------------------------------ D56 操作日志

  @Get('logs')
  @ApiOperation({ summary: 'D56 操作日志（按操作人 / 模块 / 北京时间日期过滤）' })
  listLogs(@Query() q: OperationLogQueryDto) {
    return this.operationLogService.list(q);
  }
}

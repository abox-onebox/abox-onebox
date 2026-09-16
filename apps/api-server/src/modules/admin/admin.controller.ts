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
import { ConfigService } from './config/config.service';
import { MessageTemplateService } from './template/message-template.service';
import { AdminRoleService } from './role/role.service';
import { OperationLogService } from './operation-log/operation-log.service';
import {
  AdminAccountQueryDto,
  CreateAdminUserDto,
  OperationLogQueryDto,
  UpdateAdminUserDto,
} from './dto/admin.dto';
import { UpdateConfigsDto } from './dto/config.dto';
import { UpdateMessageTemplateDto } from './dto/message-template.dto';

/**
 * 后台 · 系统管理（D51–D60）· 见《接口规范 v1.0》§6.7
 *
 * ⚠️ **`@Roles('super_admin','admin')` 打在类上**：系统管理（账号/角色/日志/配置/通知模板）
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
    private readonly configService: ConfigService,
    private readonly messageTemplateService: MessageTemplateService,
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

  // ------------------------------------------------------------ D57–D58 系统配置

  @Get('configs')
  @ApiOperation({
    summary: 'D57 参数配置清单（按分组返回，含「是否已接线」如实标注）',
    description:
      '值已归一为展示口径（佣金费率为百分数，如 8 表示 8%）。' +
      '每条附 editable / wiring / consumedBy —— `wiring=unwired` 的项**改了不生效**，' +
      '页面据此置为只读并说明原因。',
  })
  listConfigs() {
    return this.configService.list();
  }

  @Put('configs')
  @OperationLog({ module: 'system', action: '更新系统配置' })
  @ApiOperation({
    summary: 'D58 批量更新配置（整批原子 + 白名单 + 即时生效）',
    description:
      '① 不在可管理清单内的键直接拒绝（不静默忽略）；② 任一项校验失败则**整批不写入**；' +
      '③ 写入后**同步刷新**配置缓存（不等 60s TTL），避免「页面已改、业务按旧值跑」。' +
      '出参回带 `changed[]`（前 → 后）供前端二次确认后展示。',
  })
  updateConfigs(@Body() dto: UpdateConfigsDto, @CurrentAdmin('sub') operatorId: number) {
    return this.configService.update(dto, operatorId);
  }

  // ------------------------------------------------------------ D59–D60 通知模板

  @Get('templates')
  @ApiOperation({
    summary: 'D59 通知模板清单（含接线状态与启用闸门）',
    description:
      '以服务端代码里的**场景声明**为准返回（库只补可编辑值）。每条附：' +
      '`channels[]`（每个渠道的必要条件是否已满足）、`blockers[]`（启用还缺什么）、' +
      '`wiring`（`live` = 真有代码投递；`pending` = 一期无投递点，改了不生效）。',
  })
  listTemplates() {
    return this.messageTemplateService.list();
  }

  @Put('templates/:id')
  @OperationLog({ module: 'system', action: '编辑通知模板' })
  @ApiOperation({
    summary: 'D60 编辑通知模板（只可改 启用状态 / 微信模板ID / 微信群文案）',
    description:
      '场景键、渠道、触发时机、变量白名单是**代码事实**，不在可编辑范围 —— ' +
      '传入这些字段会被 `forbidNonWhitelisted` 直接拒绝（`10001`，不静默忽略）。' +
      '两道闸门：① 文案变量须在该场景白名单内；② **启用时**每个渠道的必要条件' +
      '（订阅消息需模板 ID、微信群需文案）必须齐备，否则拒绝启用（fail-closed）—— ' +
      '避免页面显示「已启用」而实际投不出去。',
  })
  updateTemplate(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateMessageTemplateDto,
    @CurrentAdmin('sub') operatorId: number,
  ) {
    return this.messageTemplateService.update(id, dto, operatorId);
  }
}

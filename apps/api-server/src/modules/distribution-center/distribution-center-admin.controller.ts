import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import {
  AdminDistributionCentersQueryDto,
  CreateDistributionCenterDto,
  DistributionCenterIdParamDto,
  UpdateDistributionCenterDto,
} from './dto/distribution-center-admin.dto';
import { DistributionCenterAdminService } from './distribution-center-admin.service';

/**
 * 后台 · 集散中心配置（《接口规范 v1.0》§6.4 D29–D32 · 原型 P33 下部 · M34-05）
 *
 * ⚠️ 与既有 `distribution-center.controller.ts`（`@Controller('distribution-center')`）
 *    不是同一个东西：那个是**供应商端**（S 系列，集散中心自己的打包任务视图），
 *    本控制器是**运营后台**（D29–D32，平台配置集散中心），
 *    路径 `admin/` 前缀就是主体隔离依据（越权 10003）。
 *
 * ⚠️ **C4**：集散中心是**表驱动**的，默认种子 4 个但可增删 —— 别在任何地方假设只有 4 个。
 *
 * ⚠️ **两级白名单**：类级放 `operator`（要看配置、要对账），
 *    写操作（D30–D32）收窄到 `super_admin`/`admin` ——
 *    集散中心决定「哪些楼群的餐从哪个场地发」，改它等于改履约路线。
 */
@ApiTags('后台·集散中心配置')
@ApiBearerAuth()
@Controller('admin/distribution-centers')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class DistributionCenterAdminController {
  constructor(private readonly dcAdmin: DistributionCenterAdminService) {}

  @Get()
  @ApiOperation({
    summary: 'D29 集散中心配置列表（C4 · 表驱动）',
    description:
      '按状态 / 关联供应商 / 服务楼群 / 关键词筛选。出参含：场地费与打包费（元分双份，' +
      '**C9 后默认为 ¥0**）、服务楼群 id 与名称、历史应付笔数与金额、被套餐分配引用数，' +
      '以及 `canDelete`（两道前置都为空才为 true）。' +
      '服务楼群筛选在服务端内存完成（JSON 列跨库字符串连接语义不同），对外行为与 SQL 筛选一致。',
  })
  list(@Query() q: AdminDistributionCentersQueryDto, @CurrentAdmin('role') role: string) {
    return this.dcAdmin.list(q, role);
  }

  @Post()
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'supplier', action: '新增集散中心' })
  @ApiOperation({
    summary: 'D30 新增集散中心',
    description:
      '关联供应商必须是**集散型或混合型**，否则 50008（纯出餐商家名下挂集散中心是自相矛盾的主数据）。' +
      '场地费 / 打包费不填即为 0（C9：复用供应商场地、平台兼职打包）。',
  })
  create(@Body() dto: CreateDistributionCenterDto) {
    return this.dcAdmin.create(dto);
  }

  @Put(':id')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'supplier', action: '编辑集散中心', targetParam: 'id' })
  @ApiOperation({
    summary: 'D31 编辑集散中心（含关联供应商 · 结算参数 · 服务楼群）',
    description:
      '⚠️ `serviceGroups` 是**整体替换**语义（传 `[]` 即清空，不是增量追加）。' +
      '`status=0` 是**停用**：保留记录、退出新分配、随时可恢复 —— 有历史结算时这就是唯一出路。',
  })
  update(@Param() p: DistributionCenterIdParamDto, @Body() dto: UpdateDistributionCenterDto) {
    return this.dcAdmin.update(p.id, dto);
  }

  @Delete(':id')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'supplier', action: '删除集散中心', targetParam: 'id' })
  @ApiOperation({
    summary: 'D32 删除集散中心（软删）',
    description:
      '⚠️ 与 D31 的 `status=0` 是两件事：本接口写 `deleted_at`，记录从此不再出现，' +
      '仅用于「建错了」。两道前置：有历史应付流水（50002）/ 仍被套餐分配引用（50002）时一律拒绝，' +
      '并在错误信息里给出「改用停用」的出路。',
  })
  remove(@Param() p: DistributionCenterIdParamDto) {
    return this.dcAdmin.remove(p.id);
  }
}

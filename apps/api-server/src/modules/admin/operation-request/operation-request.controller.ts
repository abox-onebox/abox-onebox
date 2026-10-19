import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin, Roles } from '../../../common/decorators/auth.decorator';
import type { JwtPayload } from '../../../common/decorators/auth.decorator';
import { OperationLog } from '../../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import {
  CreateOperationRequestDto,
  OperationRequestQueryDto,
  RejectOperationRequestDto,
  RecallOperationRequestDto,
} from './dto/operation-request.dto';
import { OperationRequestService } from './operation-request.service';

/**
 * 阶段 3 · 高危审批申请单接口（全在 /admin 作用域）
 *
 * 类级 `@Roles('super_admin','admin','operator')`：operator 可提交 / 看自己；
 * approve / execute / reject 方法级收窄到 `super_admin,admin`（operator 不能审批 —— 最小权限）。
 */
@ApiTags('后台·高危审批')
@ApiBearerAuth()
@Controller('admin/operation-requests')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class OperationRequestController {
  constructor(private readonly svc: OperationRequestService) {}

  @Post()
  @ApiOperation({ summary: '提交高危操作申请（operator 可提交，admin 可代建）' })
  create(@Body() dto: CreateOperationRequestDto, @CurrentAdmin() actor: JwtPayload) {
    return this.svc.create(dto, actor);
  }

  @Get()
  @ApiOperation({ summary: '申请单列表（operator 仅看自己提交）' })
  list(@Query() q: OperationRequestQueryDto, @CurrentAdmin() actor: JwtPayload) {
    return this.svc.list(q, actor);
  }

  @Get(':id')
  @ApiOperation({ summary: '申请单详情' })
  detail(@Param('id', ParseIntPipe) id: number, @CurrentAdmin() actor: JwtPayload) {
    return this.svc.detail(id, actor);
  }

  @Post(':id/approve')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'system', action: '审批通过高危操作申请' })
  @ApiOperation({ summary: '审批通过（两步：仅置 approved，不执行）' })
  approve(@Param('id', ParseIntPipe) id: number, @CurrentAdmin() actor: JwtPayload) {
    return this.svc.approve(id, actor);
  }

  @Post(':id/reject')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'system', action: '驳回高危操作申请' })
  @ApiOperation({ summary: '驳回申请' })
  reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectOperationRequestDto,
    @CurrentAdmin() actor: JwtPayload,
  ) {
    return this.svc.reject(id, dto.reason, actor);
  }

  @Post(':id/recall')
  @OperationLog({ module: 'system', action: '撤回高危操作申请' })
  @ApiOperation({ summary: '撤回未审批的申请（仅 pending；operator 仅能撤自己提交的）' })
  recall(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RecallOperationRequestDto,
    @CurrentAdmin() actor: JwtPayload,
  ) {
    return this.svc.recall(id, dto.reason, actor);
  }

  @Post(':id/execute')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'system', action: '执行已审批的高危操作' })
  @ApiOperation({ summary: '执行已审批的申请（调原目标接口，复用 @OperationLog 审计）' })
  execute(@Param('id', ParseIntPipe) id: number, @CurrentAdmin() actor: JwtPayload) {
    return this.svc.execute(id, actor);
  }
}

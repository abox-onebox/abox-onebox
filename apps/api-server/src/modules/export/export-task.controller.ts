import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';

import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import type { JwtPayload } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { ExportTaskService } from './export-task.service';

class CreateExportTaskDto {
  @IsString()
  @IsIn(['orders', 'operation-logs'], { message: '不支持的导出类型' })
  kind!: string;

  /** 筛选条件，原样交给对应域的既有查询口径（不在本模块复刻状态机） */
  @IsOptional()
  @IsObject()
  filter?: Record<string, unknown>;
}

/**
 * 后台导出任务接口（2026-11-21）
 *
 * 与旧的同步导出端点并存：旧的 `GET /admin/orders/export` 仍可用（5000 行上限），
 * 本组给「大批量 + 要留档」的场景 —— 提交即时返回，产物去下载中心取。
 *
 * ⚠️ 下载端点返回的是**产物 URL**而不是文件流：文件在 StorageProvider 里，
 * 再由 API 读一遍只会多一份含手机号的中间副本（与旧同步导出「服务端不留文件」的纪律一致）。
 */
@ApiTags('后台·导出任务')
@ApiBearerAuth()
@Controller('admin/export-tasks')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator', 'finance')
export class ExportTaskController {
  constructor(private readonly svc: ExportTaskService) {}

  @Post()
  @OperationLog({ module: 'system', action: '发起导出任务' })
  @ApiOperation({ summary: '提交异步导出任务（即时返回 taskId，生成交给队列）' })
  request(@Body() dto: CreateExportTaskDto, @CurrentAdmin() actor: JwtPayload) {
    return this.svc.request(dto.kind, dto.filter ?? {}, actor);
  }

  @Get()
  @ApiOperation({ summary: '导出任务列表（operator 仅看自己提交）' })
  list(@CurrentAdmin() actor: JwtPayload) {
    return this.svc.list(actor);
  }

  @Get(':id')
  @ApiOperation({ summary: '导出任务详情' })
  detail(@Param('id', ParseIntPipe) id: number, @CurrentAdmin() actor: JwtPayload) {
    return this.svc.detail(id, actor);
  }

  @Get(':id/download')
  @ApiOperation({ summary: '取产物下载 URL（仅 done 态）' })
  download(@Param('id', ParseIntPipe) id: number, @CurrentAdmin() actor: JwtPayload) {
    return this.svc.downloadUrl(id, actor);
  }

  @Post(':id/retry')
  @OperationLog({ module: 'system', action: '重试导出任务' })
  @ApiOperation({ summary: '重试失败任务（复用原筛选条件）' })
  retry(@Param('id', ParseIntPipe) id: number, @CurrentAdmin() actor: JwtPayload) {
    return this.svc.retry(id, actor);
  }
}

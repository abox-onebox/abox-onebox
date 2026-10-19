import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentAdmin, Roles } from '../../../common/decorators/auth.decorator';
import type { JwtPayload } from '../../../common/decorators/auth.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { OpBlocklistService } from '../../../common/services/op-blocklist.service';

/**
 * 知识助手禁止清单管理（P1-c - 2026-10-19）
 * admin / super_admin 可查看、追加、解除禁止的 op；operator 不可操作（避免自己解禁自己）。
 * 助手侧无论直执行还是提交审批，命中本清单都会被服务端拦截（见 OpBlocklistInterceptor 与 OperationRequestService）。
 */
@ApiTags('border-知识助手禁止清单')
@ApiBearerAuth()
@Controller('admin/op-blocklist')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin')
export class OpBlocklistController {
  constructor(private readonly svc: OpBlocklistService) {}

  @Get()
  @ApiOperation({ summary: '查看禁止清单（含 op / 原因 / 列入人 / 时间）' })
  list() {
    return this.svc.list().then((rows) => ({ list: rows }));
  }

  @Post()
  @ApiOperation({ summary: '把某 op 列入禁止（助手将无法执行或提交审批）' })
  async add(@Body() dto: { opCode?: string; note?: string }, @CurrentAdmin() actor: JwtPayload) {
    if (!dto || !dto.opCode) throw new BadRequestException('opCode 必填');
    return this.svc.add(dto.opCode, dto.note ?? null, actor ? actor.sub : null);
  }

  @Delete(':opCode')
  @ApiOperation({ summary: '解除某 op 的禁止' })
  async remove(@Param('opCode') opCode: string) {
    await this.svc.remove(opCode);
    return { ok: true };
  }
}

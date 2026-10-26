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
import { OperationLog } from '../../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { OpBlocklistService } from '../../../common/services/op-blocklist.service';

/**
 * 知识助手禁止清单管理（P1-c - 2026-10-19）
 * admin / super_admin 可查看、追加、解除禁止的 op；operator 不可操作（避免自己解禁自己）。
 * 助手侧无论直执行还是提交审批，命中本清单都会被服务端拦截（见 OpBlocklistInterceptor 与 OperationRequestService）。
 *
 * ⚠️ **对称留痕（2026-10-26 补）**：`add` 由行内 `createdBy` 记录列入人；
 *    `remove` 是**物理删除**，删完连「这条禁令存在过」都查不出来，
 *    故必须由 `@OperationLog` 补一条审计（`ab_operation_log`），否则
 *    「谁解除了哪条禁令」事后查无此人、查无此事 —— 与列入动作严重不对称。
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
  @ApiOperation({ summary: '解除某 op 的禁止（记录操作人与目标 op，可审计）' })
  @OperationLog({ module: 'system', action: '解除AI禁止清单', targetParam: 'opCode' })
  async remove(@Param('opCode') opCode: string, @CurrentAdmin() actor: JwtPayload) {
    // 认不出操作人就拒绝解除：本动作是物理删除，没有操作人等于审计断链
    if (!actor?.sub) throw new BadRequestException('无法识别操作人，拒绝解除禁止');
    await this.svc.remove(opCode);
    return { ok: true };
  }
}

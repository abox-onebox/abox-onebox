import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../../common/guards/admin.guard';
import { Roles } from '../../common/decorators/auth.decorator';
import { WecomBindingService } from './wecom-binding.service';
import { SetWecomTierDto, UpsertWecomBindingDto } from './wecom-binding.dto';
import { WecomBinding } from './wecom-binding.entity';

/**
 * 企业微信令牌绑定管理（super_admin / admin 预绑定 userid ↔ 令牌 / 身份等级）
 *
 * 仅管理员可写；同事在聊天里发的指令不在此端点，走 /wecom/kb/callback。
 * 列表/详情**不回显令牌明文**，只回 hasOperatorToken / hasApproverToken 标记，
 * 避免令牌在管理面泄露（令牌本身仍明文存库，属「管理员预绑定」路线固有形态）。
 *
 * `tier` 决定机器人用哪个执行账号：owner=admin 角色（131 个端点），staff=operator
 * 角色（69 个）。放权/收回就是改这一列，不需要重发令牌。
 */
@Controller('wecom/kb/bindings')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin')
export class WecomBindingAdminController {
  constructor(private readonly svc: WecomBindingService) {}

  @Post()
  async upsert(@Body() dto: UpsertWecomBindingDto): Promise<WecomBinding> {
    return this.svc.upsert(dto);
  }

  /** 只改身份等级（放权 / 收回）；绑定不存在返回 found=false，不静默成功 */
  @Patch(':userId/tier')
  async setTier(
    @Param('userId') userId: string,
    @Body() dto: SetWecomTierDto,
  ): Promise<{ found: boolean; tier?: string }> {
    const r = await this.svc.setTier(userId, dto.tier);
    return r ? { found: true, tier: r.tier } : { found: false };
  }

  @Get()
  async list(): Promise<Array<Record<string, unknown>>> {
    const all = await this.svc.list();
    return all.map((b) => ({
      userId: b.userId,
      operatorName: b.operatorName,
      tier: b.tier || 'staff',
      hasOperatorToken: !!b.operatorToken,
      hasApproverToken: !!b.approverToken,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    }));
  }

  @Delete(':userId')
  async remove(@Param('userId') userId: string): Promise<{ ok: boolean }> {
    await this.svc.remove(userId);
    return { ok: true };
  }
}

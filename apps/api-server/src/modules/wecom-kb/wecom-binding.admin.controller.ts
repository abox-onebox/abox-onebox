import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../../common/guards/admin.guard';
import { Roles } from '../../common/decorators/auth.decorator';
import { WecomBindingService } from './wecom-binding.service';
import { SetWecomGrantDto, SetWecomTierDto, UpsertWecomBindingDto } from './wecom-binding.dto';
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

  /**
   * 只改「单独放权的功能清单」（按功能项给某个同事放权 / 收回）。
   *
   * 不动令牌、不动 tier：放权是「多做几件事」，不是「把身份改成负责人」。
   * 传 `ops: []` 即收回全部放权（同事退回 operator 本来的能力，不会残废）。
   * 目录里已失效的编码会被丢弃并回传 `unknown`，让页面能如实提示，而不是静默吞掉。
   */
  @Patch(':userId/grant')
  async setGrant(
    @Param('userId') userId: string,
    @Body() dto: SetWecomGrantDto,
  ): Promise<{ found: boolean; count?: number; unknown?: string[] }> {
    const r = await this.svc.setGrant(userId, dto.ops);
    if (!r) return { found: false };
    return { found: true, count: (r.binding.grantedOps || []).length, unknown: r.unknown };
  }

  @Get()
  async list(): Promise<Array<Record<string, unknown>>> {
    const all = await this.svc.list();
    return all.map((b) => ({
      userId: b.userId,
      operatorName: b.operatorName,
      tier: b.tier || 'staff',
      /**
       * 放权清单原样给前端（不是只给个数）：页面要能勾选回填，
       * 只回个数会让「编辑已有放权」变成「每次都要重勾一遍」。
       */
      grantedOps: b.grantedOps || [],
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

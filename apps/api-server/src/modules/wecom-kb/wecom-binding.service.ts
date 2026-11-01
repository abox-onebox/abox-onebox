import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WecomBinding } from './wecom-binding.entity';
import { normalizeGrant } from './op-policy';

export interface UpsertInput {
  userId: string;
  operatorName: string;
  operatorToken?: string;
  approverToken?: string;
  /** 身份等级；不传默认 staff（最小权限） */
  tier?: 'owner' | 'staff';
  /** 单独放权清单；不传 = 不动（与令牌同款「省略即不改」语义） */
  grantedOps?: string[];
}

@Injectable()
export class WecomBindingService {
  constructor(@InjectRepository(WecomBinding) private readonly repo: Repository<WecomBinding>) {}

  /** 预绑定 / 更新（管理员调用）。operatorToken/approverToken 传 '' 即清空。 */
  async upsert(input: UpsertInput): Promise<WecomBinding> {
    const existing = await this.repo.findOne({ where: { userId: input.userId } });
    if (existing) {
      existing.operatorName = input.operatorName;
      existing.operatorToken = input.operatorToken ?? existing.operatorToken ?? null;
      existing.approverToken = input.approverToken ?? existing.approverToken ?? null;
      if (input.tier) existing.tier = input.tier;
      if (input.grantedOps) existing.grantedOps = normalizeGrant(input.grantedOps).valid;
      return this.repo.save(existing);
    }
    const ent = this.repo.create({
      userId: input.userId,
      operatorName: input.operatorName,
      operatorToken: input.operatorToken ?? null,
      approverToken: input.approverToken ?? null,
      tier: input.tier ?? 'staff',
      // ⚠️ 新行必须显式写这一列：漏写会得到 undefined，simple-json 序列化后
      //    表现为「列没写」，下次读出来就是 null —— 与「没放权」同义，语义上不错，
      //    但会让「新增时勾了放权」静默丢失（同 D25 结算账户三列的老坑）。
      grantedOps: normalizeGrant(input.grantedOps).valid,
    });
    return this.repo.save(ent);
  }

  /** 只改身份等级（放权 / 收回），不动令牌 */
  async setTier(userId: string, tier: 'owner' | 'staff'): Promise<WecomBinding | null> {
    const existing = await this.repo.findOne({ where: { userId } });
    if (!existing) return null;
    existing.tier = tier;
    return this.repo.save(existing);
  }

  /**
   * 只改「单独放权的功能清单」，不动令牌、不动 tier。
   *
   * 传空数组 = 收回全部放权（安全动作：同事退回 operator 本来的能力，不会被他做不了任何事）。
   * 目录里已不存在的编码会被剔掉并回传，让页面能提示「有 N 项已失效」。
   */
  async setGrant(
    userId: string,
    codes: unknown,
  ): Promise<{ binding: WecomBinding; unknown: string[] } | null> {
    const existing = await this.repo.findOne({ where: { userId } });
    if (!existing) return null;
    const { valid, unknown } = normalizeGrant(codes);
    existing.grantedOps = valid;
    const binding = await this.repo.save(existing);
    return { binding, unknown };
  }

  async get(userId: string): Promise<WecomBinding | null> {
    return this.repo.findOne({ where: { userId } });
  }

  async remove(userId: string): Promise<void> {
    await this.repo.delete({ userId });
  }

  async list(): Promise<WecomBinding[]> {
    return this.repo.find();
  }
}

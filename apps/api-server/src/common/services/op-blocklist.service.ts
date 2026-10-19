import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OpBlocklist } from '../../database/entities/system.entity';

/**
 * 知识助手禁止清单服务（P1-c - 2026-10-19）
 *
 * 服务端权威闸：管理员把某些 op 列入禁止后，助手无论直执行还是提交审批都被拦截。
 * isBlocked(opCode)：拦截器与审批流闸共用，判断某 op 当前是否被禁。
 * list / add / remove：后台管理端（admin 角色）维护清单。
 *
 * 与前端 localStorage 自解禁无关：前端清单只是离线兜底，服务端这份才是最终裁决。
 */
@Injectable()
export class OpBlocklistService {
  constructor(@InjectRepository(OpBlocklist) private readonly repo: Repository<OpBlocklist>) {}

  async isBlocked(opCode: string): Promise<boolean> {
    if (!opCode) return false;
    const one = await this.repo.findOne({ where: { opCode } });
    return !!one;
  }

  async list(): Promise<OpBlocklist[]> {
    return this.repo.find({ order: { createdAt: 'DESC' } });
  }

  async add(
    opCode: string,
    note: string | null | undefined,
    createdBy: number | null,
  ): Promise<OpBlocklist> {
    const existing = await this.repo.findOne({ where: { opCode } });
    if (existing) return existing;
    const e = this.repo.create({
      opCode,
      note: note ?? null,
      createdBy: createdBy ?? null,
    });
    return this.repo.save(e);
  }

  async remove(opCode: string): Promise<void> {
    await this.repo.delete({ opCode });
  }
}

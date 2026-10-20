import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WecomBinding } from './wecom-binding.entity';

export interface UpsertInput {
  userId: string;
  operatorName: string;
  operatorToken?: string;
  approverToken?: string;
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
      return this.repo.save(existing);
    }
    const ent = this.repo.create({
      userId: input.userId,
      operatorName: input.operatorName,
      operatorToken: input.operatorToken ?? null,
      approverToken: input.approverToken ?? null,
    });
    return this.repo.save(ent);
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

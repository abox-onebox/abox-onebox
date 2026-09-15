import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { LeaderLevel, LeaderStatus } from '@abox/shared-types';

import { LeaderInvite } from '../../database/entities/leader.entity';

/**
 * 团长推荐关系服务（C2 晋级审计 · M2-2.9）
 *
 * 口径（《ER v2.1》§4.2 实体注释 + 表结构评审意见 P0-4）：
 *   · 一个用户**只绑定一个邀请人**（`uk_invite_invitee` 唯一键兜底）；
 *   · `inviter_leader_id` **可空**以支持 C3 自荐申请（`channel='self'`）；
 *   · `is_formal` 是冗余位（被邀请人是否已达正式及以上），避免高频 JOIN
 *     `ab_team_leader` 判等级。
 *
 * 何时落表：
 *   ① 用户经邀请链接/小程序码/海报进入 → U3 落地页绑定时建记录（`channel` = link/qrcode/poster）
 *   ② 用户直接申请团长（自荐）→ 本服务的 `bindOnApply` 建 `channel='self'` 记录
 *   ⚠️ 二者互斥：若已存在绑定记录，`bindOnApply` **只回填** `invitee_leader_id`，不覆盖邀请人。
 */
@Injectable()
export class LeaderInviteService {
  constructor(
    @InjectRepository(LeaderInvite) private readonly inviteRepo: Repository<LeaderInvite>,
  ) {}

  /**
   * 申请团长时落/补推荐关系
   *
   * @returns 最终生效的推荐记录（`inviterLeaderId` 供调用方写入 `ab_user.team_leader_id`）
   */
  async bindOnApply(
    userId: number,
    leaderId: number,
    level: LeaderLevel,
    manager?: EntityManager,
  ): Promise<LeaderInvite> {
    const repo = manager ? manager.getRepository(LeaderInvite) : this.inviteRepo;
    const existed = await repo.findOne({ where: { inviteeUserId: userId } });

    if (existed) {
      // 已由邀请链接绑定 → 只补「被邀请人转任团长后的 id / 等级快照」，邀请人不动
      existed.inviteeLeaderId = leaderId;
      existed.inviteeLevel = level;
      return repo.save(existed);
    }

    return repo.save({
      inviterLeaderId: null,
      inviteeUserId: userId,
      inviteeLeaderId: leaderId,
      channel: 'self',
      bindAt: new Date(),
      inviteeLevel: level,
      isFormal: 0,
    });
  }

  /**
   * 统计「经本人邀请且**已转正**（正式及以上）」的团长数 —— C2 晋级第二条件
   *
   * ⚠️ 只认 `is_formal = 1`：`inviteeLeaderId` 非空仅代表对方成为团长（可能是见习），
   *    不足以计入「介绍 N 名**转正**团长」。
   */
  async countFormal(inviterLeaderId: number): Promise<number> {
    return this.inviteRepo.count({ where: { inviterLeaderId, isFormal: 1 } });
  }

  /**
   * 标记被邀请人已转正（等级晋升到正式及以上时调用，M2-2.9 / 晋级任务）
   * @returns 是否发生了状态翻转（true 表示从「未转正」变为「已转正」，需回写邀请人计数）
   */
  async markFormal(inviteeUserId: number, level: LeaderLevel): Promise<boolean> {
    const invite = await this.inviteRepo.findOne({ where: { inviteeUserId } });
    if (!invite || invite.isFormal === 1) return false;
    if (level === LeaderLevel.TRAINEE) return false;

    invite.isFormal = 1;
    invite.inviteeLevel = level;
    invite.formalAt = new Date();
    await this.inviteRepo.save(invite);
    return true;
  }

  /** 查询某用户的邀请绑定关系（申请流程用于取邀请人） */
  async findByInvitee(userId: number): Promise<LeaderInvite | null> {
    return this.inviteRepo.findOne({ where: { inviteeUserId: userId } });
  }
}

/** 复用：判断团长是否在职（供本模块内多处判定，避免字面量散落） */
export const isLeaderActive = (status: number): boolean => status === LeaderStatus.ACTIVE;

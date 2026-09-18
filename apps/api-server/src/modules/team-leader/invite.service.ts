import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';

import { LeaderLevel, LeaderStatus } from '@abox/shared-types';

import { normalizePage, paginate } from '../../common/utils/response';
import { LeaderInvite } from '../../database/entities/leader.entity';
import { User } from '../../database/entities/user.entity';

type PageInput = { page?: unknown; pageSize?: unknown };

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
 *   ① 用户经邀请链接/小程序码/海报进入 → U3 落地页「授权加入」时建记录
 *      （`channel` = link/qrcode/poster）—— **`bindOnInvite`**（2026-09-18 补 · 缺陷 #92）
 *   ② 用户直接申请团长（自荐）→ 本服务的 `bindOnApply` 建 `channel='self'` 记录
 *   ⚠️ 二者互斥：若已存在绑定记录，另一条路径**只回填** `invitee_leader_id`，不覆盖邀请人。
 */
@Injectable()
export class LeaderInviteService {
  constructor(
    @InjectRepository(LeaderInvite) private readonly inviteRepo: Repository<LeaderInvite>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {}

  /**
   * ① 用户经**邀请链接 / 小程序码 / 海报**进入 → 「授权加入」绑定时落推荐关系
   * （U3 落地页 · `channel` = `link` / `qrcode` / `poster`）
   *
   * ⭐ 2026-09-18 补 · 收口**缺陷 #92**：本文件头注的「何时落表 ①」长期**只有描述没有实现**
   *    （`ab_leader_invite` 全仓只有 `bindOnApply` 一条写点），而 `ab_user.building_id` /
   *    `team_leader_id` **全仓没有生产写点** —— 于是扫码进来的人**服务端侧根本没被绑定**，
   *    落地页只能「本地记一笔」。本方法 + `AuthService.login` 的 `leaderCode` 分支共同补上。
   *
   * ## 语义（三条，都必须守住）
   * 1. **已有记录 → 不改写邀请人**：`inviter_leader_id` 是**历史事实** ——
   *    它决定「谁的介绍转正数 +1」（C2 晋级第二条件）。用户后来扫了别人的码
   *    （`ab_user.team_leader_id` 改跟随）**不能**把这条历史改掉，否则等于
   *    篡改前一个邀请人的晋级依据。故本方法对已存在的行**幂等返回**。
   * 2. **自荐记录（`channel='self'`）不被覆盖**：那是「无邀请人」的既成事实，
   *    扫一个码不能把它变成「有人邀请」（同 `bindOnApply` 的反向保护）。
   * 3. **被邀请人此刻还不是团长** → `invitee_leader_id` 留空、`is_formal = 0`；
   *    将来他申请成为团长时由 `bindOnApply` 回填 `invitee_leader_id`，
   *    转正（正式及以上）时由 `markFormal` 把 `is_formal` 翻成 1。
   *    ⇒ L21「我的推荐」因此会同时列出**已转正团长**与**尚未申请的普通用户**，
   *      这正是 `listMyInvites` 出参里 `isLeader` / `traineeCount` 两个字段的用途。
   */
  async bindOnInvite(
    userId: number,
    inviterLeaderId: number,
    channel: string,
    inviteCode?: string,
    manager?: EntityManager,
  ): Promise<LeaderInvite> {
    const repo = manager ? manager.getRepository(LeaderInvite) : this.inviteRepo;
    const existed = await repo.findOne({ where: { inviteeUserId: userId } });
    if (existed) return existed;

    return repo.save({
      inviterLeaderId,
      inviteeUserId: userId,
      inviteeLeaderId: null,
      inviteCode: inviteCode ?? null,
      channel,
      bindAt: new Date(),
      inviteeLevel: null,
      isFormal: 0,
    });
  }

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

  /**
   * L21 · 我的推荐列表（M2-2.9「推荐裂变」的可见面）
   *
   * 只回**昵称**，不回手机号（§1.6：手机号属敏感字段，仅 L5 导出且须留痕）。
   * `summary` 按**全量**统计（不受分页影响），与 L10 / L19 同一约定。
   *
   * ⚠️ 只统计「我是邀请人」的记录（`inviter_leader_id = 我`）——
   *    自荐记录（`inviter_leader_id` 为 NULL）不属于任何人的裂变成果。
   */
  async listMyInvites(inviterLeaderId: number, input: PageInput = {}) {
    const { page, pageSize, skip } = normalizePage(input);

    const [rows, total] = await this.inviteRepo.findAndCount({
      where: { inviterLeaderId },
      order: { id: 'DESC' },
      skip,
      take: pageSize,
    });

    const userIds = [...new Set(rows.map((r) => Number(r.inviteeUserId)))];
    const users = userIds.length ? await this.userRepo.find({ where: { id: In(userIds) } }) : [];
    const nameOf = new Map(users.map((u) => [Number(u.id), u.nickname]));

    const formalCount = await this.countFormal(inviterLeaderId);

    return {
      summary: {
        /** 累计邀请人数（含未转正） */
        totalCount: Number(total),
        /** 其中已转正（正式及以上）—— C2 第二条件的计数值 */
        formalCount,
        /** 尚在见习 */
        traineeCount: Math.max(0, Number(total) - formalCount),
      },
      ...paginate(
        rows.map((r) => ({
          id: Number(r.id),
          /** 被邀请人昵称（无手机号） */
          nickname: nameOf.get(Number(r.inviteeUserId)) ?? '微信用户',
          channel: r.channel,
          /** 绑定时间 */
          bindAt: r.bindAt,
          /** 是否已转正（正式及以上） */
          isFormal: Number(r.isFormal) === 1,
          /** 转正时间（未转正为 null） */
          formalAt: r.formalAt ?? null,
          /** 被邀请人当前等级（未成为团长时为 null） */
          inviteeLevel: r.inviteeLevel ?? null,
          /** 是否已成为团长 */
          isLeader: Boolean(r.inviteeLeaderId),
        })),
        total,
        page,
        pageSize,
      ),
    };
  }
}

/** 复用：判断团长是否在职（供本模块内多处判定，避免字面量散落） */
export const isLeaderActive = (status: number): boolean => status === LeaderStatus.ACTIVE;

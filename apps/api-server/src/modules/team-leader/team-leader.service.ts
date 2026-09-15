import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { LEADER_LEVEL_META, LeaderLevel, LeaderStatus } from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { maskAccount } from '../../common/utils/crypto';
import { Building } from '../../database/entities/building.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { User } from '../../database/entities/user.entity';
import {
  ApplyLeaderReqDto,
  LeaderAgreementReqDto,
  UpdateLeaderProfileReqDto,
} from './dto/team-leader.dto';
import { LeaderInviteService } from './invite.service';
import { LeaderLevelService } from './level.service';

/** 办公楼在营状态（`ab_building.status`：1 合作中 / 2 停用） */
const BUILDING_OPEN = 1;

/**
 * 团长服务（M2 · 2.1 身份判定 + 2.2 申请即生效）
 *
 * 【C3 关键口径】**提交申请即生效，无人工审核** ——
 *   勾选协议 + 建 `ab_team_leader`（见习 8%）+ 落推荐关系，三步一次完成，接口直接返回
 *   `isLeader: true`，端上据此把底部导航重渲染为 5 项（L10 叠加身份）。
 *
 * 【身份模型·L10】团长是**叠加在 user 上的第二身份**，不单独签发 token：
 *   本模块写操作改的是 `ab_team_leader`，同时把 `ab_user.building_id` 同步为所服务办公楼
 *   （用户从此归属该楼），`team_leader_id` 指向**邀请人**（自荐则保持 null）。
 *
 * 【在职判据】`status = 1`（tinyint）—— 2026-09-15 裁定以实体为准，
 *   见 `@abox/shared-types` 的 `LeaderStatus`。
 */
@Injectable()
export class TeamLeaderService {
  constructor(
    @InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>,
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    private readonly inviteService: LeaderInviteService,
    private readonly levelService: LeaderLevelService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * L17 · 申请成为团长（C3：提交即生效）
   *
   * 校验顺序（先便宜后昂贵，且先查冲突再写库）：
   *   ① 办公楼存在且在营  ② 已是在职团长 → 20007  ③ 手机号被他人占用 → 20004
   * 写库（单事务）：`ab_team_leader`（新建或停职者复职）+ `ab_user` 归属 + `ab_leader_invite`
   */
  async apply(userId: number, dto: ApplyLeaderReqDto) {
    const building = await this.requireOpenBuilding(dto.buildingId);

    const existed = await this.leaderRepo.findOne({ where: { userId } });
    if (existed && existed.status === LeaderStatus.ACTIVE) {
      throw new BizException(ErrorCode.LEADER_EXISTS);
    }

    const phoneOwner = await this.leaderRepo.findOne({ where: { phone: dto.phone } });
    if (phoneOwner && phoneOwner.userId !== userId) {
      throw new BizException(ErrorCode.PHONE_TAKEN);
    }

    const invite = await this.inviteService.findByInvitee(userId);
    const inviterLeaderId = invite?.inviterLeaderId ?? null;
    const now = new Date();
    const traineeRate = LEADER_LEVEL_META[LeaderLevel.TRAINEE].rate.toFixed(4);

    const leader = await this.dataSource.transaction(async (manager) => {
      const leaderRepo = manager.getRepository(TeamLeader);

      // 停职者重新申请 → 复职并**重置为见习**（C2 阶梯从头走，避免停职期间白拿高费率）
      const payload = {
        buildingId: dto.buildingId,
        phone: dto.phone,
        realName: dto.realName,
        floor: dto.floor ?? null,
        level: LeaderLevel.TRAINEE,
        commissionRate: traineeRate,
        status: LeaderStatus.ACTIVE,
        agreedAt: now,
        agreeVersion: dto.agreementVersion,
      };

      const saved = existed
        ? await leaderRepo.save({ ...existed, ...payload })
        : await leaderRepo.save({ userId, ...payload });

      // 身份归属：办公楼（用户从此归属该楼）+ 邀请人（自荐为 null）
      await manager.getRepository(User).update(userId, {
        buildingId: dto.buildingId,
        teamLeaderId: inviterLeaderId,
      });

      // 推荐关系与身份**同事务**落库 —— 半成功会让 C2 晋级审计永久缺一条
      await this.inviteService.bindOnApply(userId, saved.id, LeaderLevel.TRAINEE, manager);

      return saved;
    });

    return { isLeader: true, leader: await this.toProfile(leader, building.name) };
  }

  /** L18 · 勾选同意《团长合作协议》（补签 / 版本升级重签；申请时已含一次） */
  async signAgreement(userId: number, dto: LeaderAgreementReqDto) {
    const leader = await this.requireActiveLeader(userId);
    leader.agreedAt = new Date();
    leader.agreeVersion = dto.agreementVersion;
    const saved = await this.leaderRepo.save(leader);
    return { agreedAt: saved.agreedAt ?? null, agreeVersion: saved.agreeVersion ?? null };
  }

  /** L14 · 团长资料 */
  async getProfile(userId: number) {
    const leader = await this.requireActiveLeader(userId);
    return this.toProfile(leader);
  }

  /** L15 · 修改团长资料（手机号 / 楼层；办公楼变更需后台审核 → 本 DTO 不含 buildingId） */
  async updateProfile(userId: number, dto: UpdateLeaderProfileReqDto) {
    const leader = await this.requireActiveLeader(userId);

    if (dto.phone && dto.phone !== leader.phone) {
      const owner = await this.leaderRepo.findOne({ where: { phone: dto.phone } });
      if (owner && owner.userId !== userId) {
        throw new BizException(ErrorCode.PHONE_TAKEN);
      }
      leader.phone = dto.phone;
    }
    if (dto.floor !== undefined) {
      leader.floor = dto.floor || null;
    }

    // 收款方式（L12 提现前置条件；账号一律脱敏存储）
    if (dto.payoutType !== undefined) leader.payoutType = dto.payoutType || null;
    if (dto.payoutAccount !== undefined) {
      leader.payoutAccount = dto.payoutAccount ? maskAccount(dto.payoutAccount) : null;
    }
    if (dto.payoutName !== undefined) leader.payoutName = dto.payoutName || null;

    const saved = await this.leaderRepo.save(leader);
    return this.toProfile(saved);
  }

  /** L16 · 4 级佣金规则 + C2 双条件门槛 + 我的晋级进度 */
  async getLevelRules(userId: number) {
    const leader = await this.requireActiveLeader(userId);

    // 「介绍转正数」双源取大：表内累计（后台可修正）与邀请关系实时统计
    const counted = await this.inviteService.countFormal(leader.id);
    const invitedFormalCount = Math.max(counted, leader.invitedFormalCount);
    const { level, nextLevel, progress } = this.levelService.progress(
      leader.monthOrders,
      invitedFormalCount,
    );

    return {
      levels: this.levelService.rules(),
      mine: { level, monthOrders: leader.monthOrders, invitedFormalCount, nextLevel, progress },
      expireRule: this.levelService.expireRule(),
    };
  }

  // ------------------------------------------------------------------ 内部

  private async requireOpenBuilding(id: number): Promise<Building> {
    const building = await this.buildingRepo.findOne({ where: { id } });
    if (!building) throw new BizException(ErrorCode.NOT_FOUND, '办公楼不存在');
    if (building.status !== BUILDING_OPEN) {
      throw new BizException(ErrorCode.NOT_FOUND, '该办公楼暂未开通，无法申请团长');
    }
    return building;
  }

  /**
   * 取在职团长档案
   * ⚠️ 正常链路上 `LeaderGuard` 已校验过一次；此处重复一次是为了让 service 可被
   *    非 HTTP 入口（定时任务、其他模块内部调用）安全复用，不依赖守卫。
   */
  private async requireActiveLeader(userId: number): Promise<TeamLeader> {
    const leader = await this.leaderRepo.findOne({ where: { userId } });
    if (!leader) throw new BizException(ErrorCode.FORBIDDEN, '仅团长可访问该接口');
    if (leader.status !== LeaderStatus.ACTIVE) {
      throw new BizException(ErrorCode.LEADER_DISQUALIFIED);
    }
    return leader;
  }

  /**
   * 团长档案出参（**不含**用户隐私字段；只回团长自己的资料）
   *
   * `buildingName` 可由调用方传入以避免重复查库（申请流程已持有 `Building`）；
   * **未传时自行查库填充** —— L14 契约要求资料含办公楼名，返回 null 会让端上
   * 「我的 · 团长资料」少一行关键信息（e2e 曾抓到该缺陷）。
   */
  private async toProfile(leader: TeamLeader, buildingName?: string) {
    const name =
      buildingName ??
      (await this.buildingRepo.findOne({ where: { id: leader.buildingId } }))?.name ??
      null;

    return {
      id: leader.id,
      userId: leader.userId,
      realName: leader.realName,
      phone: leader.phone,
      floor: leader.floor ?? null,
      buildingId: leader.buildingId,
      buildingName: name,
      level: leader.level,
      levelLabel: LEADER_LEVEL_META[leader.level as LeaderLevel]?.label ?? leader.level,
      commissionRate: leader.commissionRate,
      status: leader.status,
      monthOrders: leader.monthOrders,
      invitedFormalCount: leader.invitedFormalCount,
      balance: leader.balance,
      totalOrders: leader.totalOrders,
      totalCommission: leader.totalCommission,
      agreedAt: leader.agreedAt ?? null,
      agreeVersion: leader.agreeVersion ?? null,
      /** 收款方式（提现前置条件 · L12 未绑定即 40007） */
      payoutType: leader.payoutType ?? null,
      payoutAccount: leader.payoutAccount ?? null,
      payoutName: leader.payoutName ?? null,
      payoutBound: Boolean(leader.payoutType && leader.payoutAccount && leader.payoutName),
    };
  }
}

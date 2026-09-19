import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, In, Repository } from 'typeorm';

import {
  LEADER_AUDIT_ACTION_LABEL,
  LEADER_LEVEL_META,
  LEADER_STATUS_LABEL,
  LeaderAuditAction,
  LeaderLevel,
  LeaderStatus,
} from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { LeaderMoneyService } from '../../common/services/leader-money.service';
import { BizConfigService } from '../../common/services/biz-config.service';
import { BizException } from '../../common/exceptions/biz.exception';
import { maskPhone } from '../../common/utils/crypto';
import { toFen } from '../../common/utils/money';
import { normalizePage, paginate, PageResult } from '../../common/utils/response';
import { addDays, bjDateTime, monthRangeOf, toBjIso, todayBj } from '../../common/utils/time';
import { Building, BuildingGroup } from '../../database/entities/building.entity';
import { Balance, Commission } from '../../database/entities/finance.entity';
import { LeaderInvite, TeamLeader } from '../../database/entities/leader.entity';
import { OperationLog } from '../../database/entities/system.entity';
import { User } from '../../database/entities/user.entity';
import {
  AdminLeadersQueryDto,
  AppointLeaderDto,
  AuditLeaderDto,
  UpdateLeaderDto,
} from './dto/leader-admin.dto';

/** `ab_building.status`：1 合作中 / 2 停用 */
const BUILDING_OPEN = 1;

/** 角色能否做「改档案 / 定费率 / 停用」这类高风险动作 */
type ManageActions = { canManage: boolean; canAudit: boolean };

/** 名录列表出参（D19） */
type LeaderListResult = PageResult<Record<string, unknown>> & {
  view: 'roster' | 'applications';
  summary: Record<string, unknown>;
  levelOptions: Array<Record<string, unknown>>;
  statusOptions: Array<Record<string, unknown>>;
  actions: ManageActions;
  notes?: Record<string, string>;
};

/**
 * 后台 · 团长管理服务（M3-5 · 《接口规范》§6.3 D19–D22 · 原型 P32）
 *
 * ## 三条贯穿本文件的纪律
 *
 * 1. **派生态必须同步落库**：`level` 只是标签，`commission_rate` 才是钱。
 *    改等级却不改费率，佣金会按旧费率结算，而界面上看不出任何矛盾
 *    （M2 已踩过反向版本：`LeaderPromotionService` 算出等级却没落库）。
 *    故本文件所有改 `level` 的路径一律走 `rateOf()` 同时写 `commissionRate`。
 *
 * 2. **停用/复职只有一个入口（D22）**：D21 刻意不收 `status`，避免运营在两个入口
 *    之间猜「哪个才是真的」。D22 的停用还会清 `ab_user.team_leader_id`
 *    （撤销「我归属于某位团长」），与 L20 退出团长同一处理。
 *
 * 3. **`view=applications` 不伪造「微信号」**：数据模型从未采集过微信号
 *    （L17 申请表单只有 姓名/手机号/楼层/办公楼/协议），原型 P32 表格里的
 *    「微信号」列**在实现层没有对应字段**。此处如实返回 `openidTail`
 *    （微信身份标识后 6 位，仅用于区分同名申请人）+ `nickname`，并在出参
 *    `notes.wechatId` 里写明偏差 —— 宁可让运营看到「本期没有微信号」，
 *    也不返回一个看起来像微信号的假值。
 */
@Injectable()
export class LeaderAdminService {
  private readonly logger = new Logger('LeaderAdminService');

  constructor(
    @InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>,
    @InjectRepository(LeaderInvite) private readonly inviteRepo: Repository<LeaderInvite>,
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    @InjectRepository(BuildingGroup) private readonly groupRepo: Repository<BuildingGroup>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Balance) private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(Commission) private readonly commissionRepo: Repository<Commission>,
    @InjectRepository(OperationLog) private readonly opLogRepo: Repository<OperationLog>,
    private readonly dataSource: DataSource,
    /** M4-4：已提现 / 待入账佣金 / 余额的唯一真源读取口（#69） */
    private readonly leaderMoney: LeaderMoneyService,
    /** M5-13：**等级 → 费率** 的唯一真源口（`ab_config.commission.rate.*` · 常量兜底） */
    private readonly bizConfig: BizConfigService,
  ) {}

  // ==========================================================================
  // D19 · 团长名录 / 申请流水 / 筛选器 / 详情
  // ==========================================================================

  /**
   * D19 名录（`view=roster`）或申请流水（`view=applications`）
   *
   * `summary` 按**同一过滤条件的全量**统计，不受分页影响 ——
   * 与 D8 订单中心 / L10 佣金明细同一约定，端上翻页时 KPI 卡不跟着跳。
   */
  async list(q: AdminLeadersQueryDto, viewerRole: string): Promise<LeaderListResult> {
    const view = q.view ?? 'roster';
    // 「改档案 / 定费率 / 停用」是高风险动作：类级白名单含 operator（要看要补录），
    // 但这些动作收窄到 super_admin / admin。端上按 actions 决定按钮可见性，
    // **判定权威在服务端 + @Roles**（同 D9 `actions` 的设计）。
    const canManage = viewerRole === 'super_admin' || viewerRole === 'admin';
    const actions: ManageActions = { canManage, canAudit: canManage };

    if (view === 'applications') return this.applicationList(q, actions);

    const { page, pageSize, skip } = normalizePage(q);

    const base = this.buildRosterQuery(q);
    const [rows, total] = await base
      .clone()
      .orderBy('l.level', 'ASC')
      .addOrderBy('l.monthOrders', 'DESC')
      .addOrderBy('l.id', 'ASC')
      .skip(skip)
      .take(pageSize)
      .getManyAndCount();

    // 汇总 = 同一过滤条件的**全量**（另取一次，不受 skip/take 影响）
    const all = await base.clone().orderBy('l.id', 'ASC').getMany();
    const monthCommissionFen = await this.monthCommissionFen(all.map((l) => Number(l.id)));

    const summary = {
      totalCount: all.length,
      activeCount: all.filter((l) => l.status === LeaderStatus.ACTIVE).length,
      suspendedCount: all.filter((l) => l.status === LeaderStatus.SUSPENDED).length,
      traineeCount: all.filter((l) => l.level === LeaderLevel.TRAINEE).length,
      formalCount: all.filter((l) => l.level === LeaderLevel.FORMAL).length,
      goldCount: all.filter((l) => l.level === LeaderLevel.GOLD).length,
      chiefCount: all.filter((l) => l.level === LeaderLevel.CHIEF).length,
      /** 本月新增团长数（created_at 落在北京时间当月） */
      monthNewCount: all.filter((l) => this.inCurrentMonth(l.createdAt)).length,
      /**
       * 本月佣金支出（含反向冲销）
       *
       * ⚠️ 刻意**不**做 `status != 'cancelled'` 过滤：C9 的冲销是
       *    「原 normal 行翻 cancelled + 新写一条 amount 为负的 reversal 行」。
       *    若把 cancelled 剔掉只剩负行，一笔已全额冲销的佣金会显示成 -X 而非 0。
       *    两行都算才是净额。
       */
      monthCommissionFen,
      /** C3 口径：申请即生效，**不存在待审核队列** —— 恒为 0（口径表达，非占位） */
      pendingAuditCount: 0,
    };

    return {
      ...paginate(await this.decorateRoster(rows, actions), total, page, pageSize),
      view: 'roster',
      summary,
      levelOptions: await this.levelOptions(),
      statusOptions: this.statusOptions(),
      actions,
    };
  }

  /** D19 `view=applications` · 近 N 天申请流水（C3 申请即生效，本页是观察流水） */
  private async applicationList(
    q: AdminLeadersQueryDto,
    actions: ManageActions,
  ): Promise<LeaderListResult> {
    const { page, pageSize, skip } = normalizePage(q);
    const days = q.days ?? 7;
    const from = bjDateTime(addDays(todayBj(), -(days - 1)), 0, 0);

    const base = this.leaderRepo
      .createQueryBuilder('l')
      .where('l.created_at >= :from', { from })
      .andWhere('l.deleted_at IS NULL');

    if (q.buildingId) base.andWhere('l.building_id = :buildingId', { buildingId: q.buildingId });
    if (q.level) base.andWhere('l.level = :level', { level: q.level });
    if (q.status) base.andWhere('l.status = :status', { status: q.status });
    if (q.groupId) {
      base.andWhere(
        'l.building_id IN (SELECT b.id FROM ab_building b WHERE b.building_group_id = :groupId)',
        { groupId: q.groupId },
      );
    }
    if (q.keyword) {
      const kw = `%${q.keyword}%`;
      base.andWhere(
        new Brackets((w) => {
          w.where('l.real_name LIKE :kw', { kw });
          w.orWhere('l.phone LIKE :kw', { kw });
          w.orWhere('l.user_id IN (SELECT u.id FROM ab_user u WHERE u.nickname LIKE :kw)', { kw });
        }),
      );
    }

    const [rows, total] = await base
      .clone()
      .orderBy('l.createdAt', 'DESC')
      .addOrderBy('l.id', 'DESC')
      .skip(skip)
      .take(pageSize)
      .getManyAndCount();

    const all = await base.clone().orderBy('l.id', 'ASC').getMany();
    const listAll = await this.decorateApplications(all);

    return {
      ...paginate(await this.decorateApplications(rows), total, page, pageSize),
      view: 'applications',
      summary: {
        totalCount: all.length,
        pendingAuditCount: 0,
        days,
        byBuilding: this.countBy(listAll, 'buildingName'),
      },
      levelOptions: await this.levelOptions(),
      statusOptions: this.statusOptions(),
      actions,
      notes: {
        wechatId:
          '数据模型未采集微信号（L17 申请表单只收集 姓名/手机号/楼层/办公楼/协议）。' +
          '原型 P32 的「微信号」列在实现层无对应字段；本期以微信昵称 + openid 后 6 位代替。' +
          '如需真实微信号，须在 L17 申请表单增加字段并加列。',
      },
    };
  }

  /** D19 附属 · 筛选器下拉（楼群 / 办公楼 / 等级 / 状态） */
  async filterOptions() {
    const [groups, buildings] = await Promise.all([
      this.groupRepo.find({ order: { id: 'ASC' } }),
      this.buildingRepo.find({ order: { id: 'ASC' } }),
    ]);

    return {
      groups: groups
        .filter((g) => !g.deletedAt)
        .map((g) => ({ id: Number(g.id), name: g.name, status: g.status })),
      buildings: buildings
        .filter((b) => !b.deletedAt)
        .map((b) => ({
          id: Number(b.id),
          name: b.name,
          groupId: b.buildingGroupId ?? null,
          status: b.status,
        })),
      levels: await this.levelOptions(),
      statuses: this.statusOptions(),
    };
  }

  /** D19 附属 · 团长详情（档案 + 裂变链 + 佣金流水 + 操作日志） */
  async detail(id: number) {
    const leader = await this.leaderRepo.findOne({ where: { id } });
    if (!leader) throw new BizException(ErrorCode.NOT_FOUND, '团长不存在');

    const userId = Number(leader.userId);

    const [building, user, account, invite, invitees, commissionRows, logs, snapshots] =
      await Promise.all([
        this.buildingRepo.findOne({ where: { id: leader.buildingId } }),
        this.userRepo.findOne({ where: { id: userId } }),
        this.balanceRepo.findOne({ where: { userId } }),
        this.inviteRepo.findOne({ where: { inviteeUserId: userId } }),
        this.inviteRepo.find({ where: { inviterLeaderId: Number(leader.id) } }),
        this.commissionRepo.find({
          where: { teamLeaderId: Number(leader.id) },
          order: { id: 'DESC' },
          take: 20,
        }),
        /**
         * ⚠️ D20（任命）的操作日志 `targetId` 是**被任命用户 id** ——
         *    `/admin/leaders` 的路径里没有团长 id，请求体里也只有 `userId`，
         *    拦截器只能取到它。而 D21/D22 的 targetId 是团长 id。
         *    故这里两者一起查：否则详情页看不到「他是怎么被任命的」这条最关键的记录。
         */
        this.opLogRepo
          .createQueryBuilder('o')
          .where('o.module = :m', { m: 'leader' })
          .andWhere('o.target_id IN (:...ids)', { ids: [String(leader.id), String(userId)] })
          .orderBy('o.id', 'DESC')
          .take(20)
          .getMany(),
        /** M4-4：已提现 / 待入账佣金真源（见列表处说明） */
        this.leaderMoney.snapshotOf([{ id: Number(leader.id), userId }]),
      ]);
    const snap = snapshots.get(Number(leader.id));

    const group = building?.buildingGroupId
      ? await this.groupRepo.findOne({ where: { id: building.buildingGroupId } })
      : null;

    const inviter = invite?.inviterLeaderId
      ? await this.leaderRepo.findOne({ where: { id: invite.inviterLeaderId } })
      : null;

    const inviteeLeaderIds = invitees
      .map((i) => i.inviteeLeaderId)
      .filter((v): v is number => v != null);
    const inviteeUserIds = invitees.map((i) => Number(i.inviteeUserId));

    const [inviteeLeaders, inviteeUsers] = await Promise.all([
      inviteeLeaderIds.length
        ? this.leaderRepo.find({ where: { id: In(inviteeLeaderIds) } })
        : Promise.resolve([] as TeamLeader[]),
      inviteeUserIds.length
        ? this.userRepo.find({ where: { id: In(inviteeUserIds) } })
        : Promise.resolve([] as User[]),
    ]);

    const leaderById = new Map(inviteeLeaders.map((l) => [Number(l.id), l]));
    const userById = new Map(inviteeUsers.map((u) => [Number(u.id), u]));

    return {
      profile: {
        id: Number(leader.id),
        userId,
        realName: leader.realName,
        phoneMasked: maskPhone(leader.phone),
        floor: leader.floor ?? null,
        buildingId: Number(leader.buildingId),
        buildingName: building?.name ?? null,
        groupId: building?.buildingGroupId ?? null,
        groupName: group?.name ?? null,
        level: leader.level,
        levelLabel: this.levelLabel(leader.level),
        commissionRate: leader.commissionRate,
        commissionRateText: `${(Number(leader.commissionRate) * 100).toFixed(0)}%`,
        status: leader.status,
        statusLabel: this.statusLabel(leader.status),
        monthOrders: Number(leader.monthOrders ?? 0),
        invitedFormalCount: Number(leader.invitedFormalCount ?? 0),
        totalOrders: Number(leader.totalOrders ?? 0),
        balanceFen: toFen(Number(account?.balance ?? 0)),
        frozenFen: toFen(Number(account?.frozen ?? 0)),
        totalCommissionFen: toFen(Number(leader.totalCommission)),
        /** ⭐ 真源派生（到账实付合计）—— 不再读 `ab_team_leader.withdrawn_amount` */
        withdrawnAmountFen: snap?.withdrawnFen ?? 0,
        /** ⭐ 真源派生（待入账佣金合计）—— 不再读 `ab_team_leader.pending_amount` */
        pendingAmountFen: snap?.pendingCommissionFen ?? 0,
        agreedAt: toBjIso(leader.agreedAt),
        agreeVersion: leader.agreeVersion ?? null,
        payoutType: leader.payoutType ?? null,
        payoutAccount: leader.payoutAccount ?? null,
        payoutName: leader.payoutName ?? null,
        payoutBound: Boolean(leader.payoutType && leader.payoutAccount && leader.payoutName),
        lastOrderAt: toBjIso(leader.lastOrderAt),
        createdAt: toBjIso(leader.createdAt),
      },
      account: {
        nickname: user?.nickname ?? null,
        openidTail: user?.openid ? user.openid.slice(-6) : null,
        userStatus: user?.status ?? null,
      },
      /** 裂变链·上行：谁推荐了他 */
      inviter: inviter
        ? {
            leaderId: Number(inviter.id),
            realName: inviter.realName,
            level: inviter.level,
            levelLabel: this.levelLabel(inviter.level),
          }
        : null,
      inviteChannel: invite?.channel ?? null,
      bindAt: toBjIso(invite?.bindAt),
      /** 裂变链·下行：他推荐了谁 */
      invitees: invitees.map((i) => {
        const iLeaderId = i.inviteeLeaderId ?? null;
        const l2 = iLeaderId != null ? leaderById.get(Number(iLeaderId)) : undefined;
        const u2 = userById.get(Number(i.inviteeUserId));
        return {
          inviteId: Number(i.id),
          inviteeUserId: Number(i.inviteeUserId),
          nickname: u2?.nickname ?? null,
          leaderId: iLeaderId,
          realName: l2?.realName ?? null,
          level: l2?.level ?? i.inviteeLevel ?? null,
          levelLabel: this.levelLabel(l2?.level ?? i.inviteeLevel ?? null),
          isFormal: i.isFormal === 1,
          formalAt: toBjIso(i.formalAt),
          bindAt: toBjIso(i.bindAt),
        };
      }),
      /** 佣金流水（近 20 条，含反向冲销负行） */
      commissions: commissionRows.map((c) => ({
        id: Number(c.id),
        orderNo: c.orderNo,
        mealDate: c.mealDate,
        leaderLevel: c.leaderLevel,
        levelLabel: this.levelLabel(c.leaderLevel),
        rate: c.rate,
        rateText: `${(Number(c.rate) * 100).toFixed(0)}%`,
        baseAmountFen: toFen(Number(c.baseAmount)),
        quantity: Number(c.quantity),
        amountFen: toFen(Number(c.amount)),
        type: c.type,
        status: c.status,
        payoutChannel: c.payoutChannel,
        taxWithheldFen: toFen(Number(c.taxWithheldAmount)),
        createdAt: toBjIso(c.createdAt),
      })),
      operationLogs: logs.map((o) => ({
        id: Number(o.id),
        module: o.module,
        action: o.action,
        targetId: o.targetId,
        operator: (o.snapshot as { operator?: string } | null | undefined)?.operator ?? null,
        at: toBjIso(o.createdAt),
        requestData: o.requestData,
      })),
    };
  }

  // ==========================================================================
  // D20 · 任命 / 转交团长
  // ==========================================================================

  /**
   * D20 任命（或转交）团长
   *
   * 【为什么被任命者必须是**已注册用户**】团长是叠加在 user 上的身份（L10），
   *   没有 `ab_user` 就没有微信身份 —— 这样的「团长」收不到取餐提醒、登不进小程序，
   *   是纯粹的脏数据。故先查用户，不存在 / 已停用即 20011。
   *
   * 【转交闸门】目标楼已有在职团长时，必须显式传 `transferFromLeaderId` 且与现任一致，
   *   否则 20012 并回带 `data.occupiedBy`。现任被置为**停职**（不是删除），
   *   历史佣金 / 推荐关系 / 待结算佣金全部保留 —— 换人不该抹掉别人已经赚到的钱。
   */
  async appoint(dto: AppointLeaderDto) {
    const building = await this.buildingRepo.findOne({ where: { id: dto.buildingId } });
    if (!building) throw new BizException(ErrorCode.NOT_FOUND, '办公楼不存在');
    if (building.status !== BUILDING_OPEN) {
      throw new BizException(ErrorCode.NOT_FOUND, '该办公楼未开通，无法任命团长');
    }

    const user = await this.userRepo.findOne({ where: { id: dto.userId } });
    if (!user) throw new BizException(ErrorCode.LEADER_APPOINT_USER_INVALID);
    if (user.status !== 1) {
      throw new BizException(ErrorCode.LEADER_APPOINT_USER_INVALID, '该用户账号已停用');
    }

    const existing = await this.leaderRepo.findOne({ where: { userId: dto.userId } });
    if (existing && existing.status === LeaderStatus.ACTIVE) {
      throw new BizException(ErrorCode.LEADER_EXISTS);
    }

    const phoneOwner = await this.leaderRepo.findOne({ where: { phone: dto.phone } });
    if (phoneOwner && Number(phoneOwner.userId) !== dto.userId) {
      throw new BizException(ErrorCode.PHONE_TAKEN);
    }

    // ---------------------------------------------------------------- 转交闸门
    const occupant = await this.leaderRepo.findOne({
      where: { buildingId: dto.buildingId, status: LeaderStatus.ACTIVE },
    });
    const isTransfer = Boolean(occupant && Number(occupant.userId) !== dto.userId);

    if (isTransfer && occupant) {
      if (!dto.transferFromLeaderId || dto.transferFromLeaderId !== Number(occupant.id)) {
        throw new BizException(
          ErrorCode.BUILDING_LEADER_OCCUPIED,
          `「${building.name}」当前团长为 ${occupant.realName}（id=${occupant.id}），转交需显式确认`,
          undefined,
          {
            occupiedBy: {
              leaderId: Number(occupant.id),
              realName: occupant.realName,
              phoneMasked: maskPhone(occupant.phone),
              level: occupant.level,
              levelLabel: this.levelLabel(occupant.level),
            },
          },
        );
      }
    }

    const level = (dto.level as LeaderLevel | undefined) ?? LeaderLevel.TRAINEE;
    const now = new Date();

    const saved = await this.dataSource.transaction(async (manager) => {
      // 1) 转交 → 现任停职（保留全部历史档案）
      if (isTransfer && occupant) {
        await manager.getRepository(TeamLeader).update(Number(occupant.id), {
          status: LeaderStatus.SUSPENDED,
        });
        this.logger.log(
          `团长转交：楼#${dto.buildingId} 由 #${occupant.id}（${occupant.realName}）→ 用户#${dto.userId}`,
        );
      }

      // 2) 被任命者建档 / 复职
      // ⭐ M5-13：费率走配置真源（`rateOf` 已改为 async）—— 它是「费率快照」的第二个写点。
      const appointedRate = await this.rateOf(level);
      const payload = {
        buildingId: dto.buildingId,
        phone: dto.phone,
        realName: dto.realName,
        floor: dto.floor ?? null,
        level,
        commissionRate: appointedRate,
        levelUpdatedAt: now,
        status: LeaderStatus.ACTIVE,
        agreedAt: now,
        agreeVersion: 'v1.0',
      };

      const row = existing
        ? await manager.getRepository(TeamLeader).save({ ...existing, ...payload })
        : await manager.getRepository(TeamLeader).save({ userId: dto.userId, ...payload });

      // 3) 用户归属楼同步（后台任命＝平台管理员代他选择服务楼，故一并改归属）
      await manager.getRepository(User).update(dto.userId, { buildingId: dto.buildingId });

      return row;
    });

    const view = await this.decorateRoster([saved], { canManage: true, canAudit: true });

    return {
      leader: view[0],
      transferredFrom: occupant
        ? {
            leaderId: Number(occupant.id),
            realName: occupant.realName,
            phoneMasked: maskPhone(occupant.phone),
          }
        : null,
      reason: dto.reason,
      note:
        '任命已生效（团长为叠加身份，无需对方确认）。历史佣金与推荐关系保留在原团长名下；' +
        '如原团长仍有待结算佣金或在途提现，需另行走财务流程结清。',
    };
  }

  // ==========================================================================
  // D21 · 变更团长（常规变更：等级 / 所属办公楼 / 楼层）
  // ==========================================================================

  /**
   * D21 变更团长档案
   *
   * ⚠️ **改等级必须同时改费率**：`level` 是标签、`commissionRate` 是钱，
   *    两者不同步会让佣金按旧费率结算，且界面上看不出矛盾。
   * ⚠️ **不收 `status`**：停用/复职属「例外处理」，只走 D22（单一入口）。
   * ⚠️ **改所属办公楼要拦「目标楼已被占」**：否则一栋楼会同时出现两位在职团长，
   *    用户下单时的归属团长就变成不确定行为（`ab_user.team_leader_id` 只有一个）。
   */
  async update(id: number, dto: UpdateLeaderDto) {
    const leader = await this.leaderRepo.findOne({ where: { id } });
    if (!leader) throw new BizException(ErrorCode.NOT_FOUND, '团长不存在');

    const before = {
      level: leader.level,
      commissionRate: leader.commissionRate,
      buildingId: Number(leader.buildingId),
      floor: leader.floor ?? null,
    };
    const changes: string[] = [];

    // ------------------------------------------------------------------ 等级
    if (dto.level && dto.level !== leader.level) {
      const level = dto.level as LeaderLevel;
      leader.level = level;
      // ⭐ M5-13：同一入口（`rateOf` → 配置真源），不再是常量
      leader.commissionRate = await this.rateOf(level);
      leader.levelUpdatedAt = new Date();
      changes.push(
        `等级 ${this.levelLabel(before.level)} → ${this.levelLabel(level)}` +
          `（费率 ${before.commissionRate} → ${leader.commissionRate}）`,
      );
    }

    // ------------------------------------------------------------ 所属办公楼
    if (dto.buildingId && dto.buildingId !== Number(leader.buildingId)) {
      const building = await this.buildingRepo.findOne({ where: { id: dto.buildingId } });
      if (!building) throw new BizException(ErrorCode.NOT_FOUND, '目标办公楼不存在');
      if (building.status !== BUILDING_OPEN) {
        throw new BizException(ErrorCode.NOT_FOUND, '目标办公楼未开通');
      }

      const occupant = await this.leaderRepo.findOne({
        where: { buildingId: dto.buildingId, status: LeaderStatus.ACTIVE },
      });
      if (occupant && Number(occupant.id) !== id) {
        // 与 D20 同一闸门、同一错误码：换楼等于换履约主体，撞车必须显式处理
        throw new BizException(
          ErrorCode.BUILDING_LEADER_OCCUPIED,
          `目标办公楼已由 ${occupant.realName}（id=${occupant.id}）服务，请先走 D20 转交`,
          undefined,
          {
            occupiedBy: {
              leaderId: Number(occupant.id),
              realName: occupant.realName,
              phoneMasked: maskPhone(occupant.phone),
            },
          },
        );
      }

      const oldName = (await this.buildingRepo.findOne({ where: { id: leader.buildingId } }))?.name;
      leader.buildingId = dto.buildingId;
      changes.push(`办公楼 ${oldName ?? before.buildingId} → ${building.name}`);
    }

    // ------------------------------------------------------------------ 楼层
    if (dto.floor !== undefined && (dto.floor || null) !== (leader.floor ?? null)) {
      changes.push(`楼层 ${leader.floor ?? '—'} → ${dto.floor || '—'}`);
      leader.floor = dto.floor || null;
    }

    if (!changes.length) {
      // 空变更不写库也不写日志：否则审计里会出现一堆「改了但什么都没改」的记录
      throw new BizException(ErrorCode.PARAM_INVALID, '没有任何字段发生变化');
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const row = await manager.getRepository(TeamLeader).save(leader);
      // 用户归属楼同步：他今后属于新楼（短期事实跟随长期归属）
      await manager.getRepository(User).update(Number(leader.userId), {
        buildingId: row.buildingId,
      });
      return row;
    });

    const view = await this.decorateRoster([saved], { canManage: true, canAudit: true });

    return { leader: view[0], before, changes, reason: dto.reason };
  }

  // ==========================================================================
  // D22 · 资质补录 / 例外处理
  // ==========================================================================

  /**
   * D22 资质补录与例外处理（**C3 口径：这不是「审核」入口**）
   *
   * 四个动作的落点：
   *   · `suspend`        → `status=2` + 清 `ab_user.team_leader_id`（同 L20 退出）
   *   · `restore`        → `status=1`。**不重置等级** —— 它是「纠错/恢复」，
   *                        与 L17「停职者重新申请 → 重置为见习」语义不同：
   *                        后者是重新入行，前者是把误操作改回来
   *   · `sign_agreement` → 写 `agreed_at` / `agree_version`（协议升级重签 / 历史补签）
   *   · `note`           → 只留痕，不动任何字段
   */
  async audit(id: number, dto: AuditLeaderDto) {
    const leader = await this.leaderRepo.findOne({ where: { id } });
    if (!leader) throw new BizException(ErrorCode.NOT_FOUND, '团长不存在');

    const action = dto.action as LeaderAuditAction;
    const before = { status: leader.status, agreeVersion: leader.agreeVersion ?? null };
    let note: string | null = null;

    if (action === LeaderAuditAction.SUSPEND) {
      if (leader.status === LeaderStatus.SUSPENDED) {
        throw new BizException(ErrorCode.LEADER_STATUS_ILLEGAL, '该团长已处于停职状态');
      }
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(TeamLeader).update(id, { status: LeaderStatus.SUSPENDED });
        // 撤销「归属于某团长」的关系；保留 building_id（他仍是该楼用户）
        await manager.getRepository(User).update(Number(leader.userId), { teamLeaderId: null });
      });
      note = '已停职：该团长无法再接单、无法访问团长端；历史佣金 / 订单 / 推荐关系保留。';
    } else if (action === LeaderAuditAction.RESTORE) {
      if (leader.status === LeaderStatus.ACTIVE) {
        throw new BizException(ErrorCode.LEADER_STATUS_ILLEGAL, '该团长已处于在职状态');
      }
      leader.status = LeaderStatus.ACTIVE;
      await this.leaderRepo.save(leader);
      note = '已恢复在职，等级与费率保持原值（未重置为见习）。';
    } else if (action === LeaderAuditAction.SIGN_AGREEMENT) {
      if (!dto.agreementVersion) {
        throw new BizException(ErrorCode.PARAM_INVALID, '协议补签须提供协议版本号');
      }
      leader.agreedAt = new Date();
      leader.agreeVersion = dto.agreementVersion;
      await this.leaderRepo.save(leader);
      note = '协议签署已留痕（若为版本升级重签，旧版本号不再保留 —— 只记最新签署版本）。';
    }
    // NOTE：不改任何字段，仅靠 @OperationLog 落一条留痕

    const fresh = await this.leaderRepo.findOne({ where: { id } });
    const view = await this.decorateRoster([fresh ?? leader], { canManage: true, canAudit: true });

    return {
      leader: view[0],
      action,
      actionLabel: LEADER_AUDIT_ACTION_LABEL[action],
      before,
      after: { status: fresh?.status ?? null, agreeVersion: fresh?.agreeVersion ?? null },
      reason: dto.reason,
      note,
    };
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  /** 名录基础查询（groupId / buildingId / level / status / keyword / id 过滤） */
  private buildRosterQuery(q: AdminLeadersQueryDto) {
    const qb = this.leaderRepo.createQueryBuilder('l').where('l.deleted_at IS NULL');

    if (q.id) qb.andWhere('l.id = :id', { id: q.id });
    if (q.buildingId) qb.andWhere('l.building_id = :buildingId', { buildingId: q.buildingId });
    if (q.level) qb.andWhere('l.level = :level', { level: q.level });
    if (q.status) qb.andWhere('l.status = :status', { status: q.status });
    if (q.groupId) {
      /**
       * 用子查询而非 JOIN：`ab_building` 是主数据，JOIN 后 `getManyAndCount()` 的
       * distinct 语义在 sqlite / mysql 上表现不一致（可能让 total 大于实际行数）。
       */
      qb.andWhere(
        'l.building_id IN (SELECT b.id FROM ab_building b WHERE b.building_group_id = :groupId)',
        { groupId: q.groupId },
      );
    }
    if (q.keyword) {
      const kw = `%${q.keyword}%`;
      qb.andWhere(
        new Brackets((w) => {
          w.where('l.real_name LIKE :kw', { kw });
          w.orWhere('l.phone LIKE :kw', { kw });
          w.orWhere('l.user_id IN (SELECT u.id FROM ab_user u WHERE u.nickname LIKE :kw)', { kw });
        }),
      );
    }

    return qb;
  }

  /** 名录行装配（一次批量补齐办公楼 / 楼群 / 余额，避免 N+1） */
  private async decorateRoster(
    rows: TeamLeader[],
    actions: ManageActions,
  ): Promise<Array<Record<string, unknown>>> {
    if (!rows.length) return [];

    const buildingIds = [...new Set(rows.map((r) => Number(r.buildingId)))];
    const userIds = [...new Set(rows.map((r) => Number(r.userId)))];

    const [buildings, users, balances, snapshots] = await Promise.all([
      buildingIds.length
        ? this.buildingRepo.find({ where: { id: In(buildingIds) } })
        : Promise.resolve([] as Building[]),
      userIds.length
        ? this.userRepo.find({ where: { id: In(userIds) } })
        : Promise.resolve([] as User[]),
      userIds.length
        ? this.balanceRepo.find({ where: { userId: In(userIds) } })
        : Promise.resolve([] as Balance[]),
      /**
       * ⚠️ M4-4：`withdrawnAmountFen` / `pendingAmountFen` 原取
       *    `ab_team_leader.withdrawn_amount` / `pending_amount` —— 这两列
       *    **从种子之后就没有任何写点**，页面上永远是 0（或种子值）。
       *    改从真源派生：已提现 = `ab_withdraw(status='success').actual_amount` 合计；
       *    待入账 = `ab_commission(status='pending' ∧ type='normal').amount` 合计。
       */
      this.leaderMoney.snapshotOf(
        rows.map((l) => ({ id: Number(l.id), userId: Number(l.userId) })),
      ),
    ]);

    const groupIds = [
      ...new Set(buildings.map((b) => b.buildingGroupId).filter((v): v is number => v != null)),
    ];
    const groups = groupIds.length
      ? await this.groupRepo.find({ where: { id: In(groupIds) } })
      : [];

    const buildingById = new Map(buildings.map((b) => [Number(b.id), b]));
    const groupById = new Map(groups.map((g) => [Number(g.id), g]));
    const userById = new Map(users.map((u) => [Number(u.id), u]));
    const balanceByUserId = new Map(balances.map((b) => [Number(b.userId), b]));

    return rows.map((l) => {
      const building = buildingById.get(Number(l.buildingId));
      const group = building?.buildingGroupId ? groupById.get(building.buildingGroupId) : null;
      const user = userById.get(Number(l.userId));
      const account = balanceByUserId.get(Number(l.userId));
      const snap = snapshots.get(Number(l.id));

      return {
        id: Number(l.id),
        userId: Number(l.userId),
        realName: l.realName,
        phoneMasked: maskPhone(l.phone),
        nickname: user?.nickname ?? null,
        openidTail: user?.openid ? user.openid.slice(-6) : null,
        floor: l.floor ?? null,
        buildingId: Number(l.buildingId),
        buildingName: building?.name ?? null,
        groupId: building?.buildingGroupId ?? null,
        groupName: group?.name ?? null,
        level: l.level,
        levelLabel: this.levelLabel(l.level),
        commissionRate: l.commissionRate,
        commissionRateText: `${(Number(l.commissionRate) * 100).toFixed(0)}%`,
        status: l.status,
        statusLabel: this.statusLabel(l.status),
        monthOrders: Number(l.monthOrders ?? 0),
        invitedFormalCount: Number(l.invitedFormalCount ?? 0),
        totalOrders: Number(l.totalOrders ?? 0),
        balanceFen: toFen(Number(account?.balance ?? 0)),
        frozenFen: toFen(Number(account?.frozen ?? 0)),
        totalCommissionFen: toFen(Number(l.totalCommission)),
        /** ⭐ 真源派生（`ab_withdraw` 到账实付合计）—— 不再读 `ab_team_leader.withdrawn_amount` */
        withdrawnAmountFen: snap?.withdrawnFen ?? 0,
        /** ⭐ 真源派生（`ab_commission` 待入账合计）—— 不再读 `ab_team_leader.pending_amount` */
        pendingAmountFen: snap?.pendingCommissionFen ?? 0,
        agreedAt: toBjIso(l.agreedAt),
        agreeVersion: l.agreeVersion ?? null,
        payoutBound: Boolean(l.payoutType && l.payoutAccount && l.payoutName),
        lastOrderAt: toBjIso(l.lastOrderAt),
        createdAt: toBjIso(l.createdAt),
        /** 按钮可用性口径**唯一在服务端**（同 D9 `actions`） */
        actions,
      };
    });
  }

  /** 申请流水行装配（含推荐人） */
  private async decorateApplications(rows: TeamLeader[]): Promise<Array<Record<string, unknown>>> {
    if (!rows.length) return [];

    const userIds = [...new Set(rows.map((r) => Number(r.userId)))];
    const buildingIds = [...new Set(rows.map((r) => Number(r.buildingId)))];

    const [users, invites, buildings] = await Promise.all([
      this.userRepo.find({ where: { id: In(userIds) } }),
      this.inviteRepo.find({ where: { inviteeUserId: In(userIds) } }),
      buildingIds.length
        ? this.buildingRepo.find({ where: { id: In(buildingIds) } })
        : Promise.resolve([] as Building[]),
    ]);

    const inviterLeaderIds = [
      ...new Set(invites.map((i) => i.inviterLeaderId).filter((v): v is number => v != null)),
    ];
    const inviterLeaders = inviterLeaderIds.length
      ? await this.leaderRepo.find({ where: { id: In(inviterLeaderIds) } })
      : [];

    const userById = new Map(users.map((u) => [Number(u.id), u]));
    const inviteByUserId = new Map(invites.map((i) => [Number(i.inviteeUserId), i]));
    const buildingById = new Map(buildings.map((b) => [Number(b.id), b]));
    const inviterById = new Map(inviterLeaders.map((l) => [Number(l.id), l]));

    return rows.map((l) => {
      const user = userById.get(Number(l.userId));
      const invite = inviteByUserId.get(Number(l.userId));
      const inviter = invite?.inviterLeaderId ? inviterById.get(invite.inviterLeaderId) : undefined;
      const building = buildingById.get(Number(l.buildingId));

      return {
        id: Number(l.id),
        userId: Number(l.userId),
        realName: l.realName,
        nickname: user?.nickname ?? null,
        /** ⚠️ 不是微信号（模型未采集），是微信身份标识后 6 位，仅用于区分同名申请人 */
        openidTail: user?.openid ? user.openid.slice(-6) : null,
        phoneMasked: maskPhone(l.phone),
        floor: l.floor ?? null,
        buildingId: Number(l.buildingId),
        buildingName: building?.name ?? null,
        inviter: inviter
          ? {
              leaderId: Number(inviter.id),
              realName: inviter.realName,
              level: inviter.level,
              levelLabel: this.levelLabel(inviter.level),
            }
          : null,
        inviterText: inviter
          ? `${inviter.realName}（${this.levelLabel(inviter.level)}）`
          : '—（直接申请）',
        channel: invite?.channel ?? 'self',
        level: l.level,
        levelLabel: this.levelLabel(l.level),
        status: l.status,
        statusLabel: this.statusLabel(l.status),
        agreeVersion: l.agreeVersion ?? null,
        /** C3：申请即生效，故本条即终态，无 pending 中间态 */
        appliedAt: toBjIso(l.createdAt),
      };
    });
  }

  /** 本月佣金支出（含反向冲销行；口径详见 `list()` 内注释） */
  private async monthCommissionFen(leaderIds: number[]): Promise<number> {
    if (!leaderIds.length) return 0;

    const { from, to } = monthRangeOf(todayBj());
    const fromAt = bjDateTime(from, 0, 0);
    // 次月 1 日 00:00（**不含**）：左闭右开，避免月末 23:59:59.999 的归属歧义
    const toExclusive = bjDateTime(addDays(to, 1), 0, 0);

    const row = await this.commissionRepo
      .createQueryBuilder('c')
      .select('COALESCE(SUM(c.amount), 0)', 'total')
      .where('c.team_leader_id IN (:...leaderIds)', { leaderIds })
      .andWhere('c.created_at >= :fromAt', { fromAt })
      .andWhere('c.created_at < :toExclusive', { toExclusive })
      .getRawOne<{ total: string | number }>();

    return toFen(Number(row?.total ?? 0));
  }

  /** 某时刻是否落在北京时间「当月」 */
  private inCurrentMonth(at: Date): boolean {
    const { from, to } = monthRangeOf(todayBj());
    const d = todayBj(at);
    return d >= from && d <= to;
  }

  /**
   * 等级 → 费率快照（**唯一入口** · M5-13 收口）
   *
   * ⚠️ 真源是 `ab_config.commission.rate.*`（运营在后台可调），
   *    `LEADER_LEVEL_META[level].rate` 只作**出厂兜底**。
   *
   * 收口前这里是同步的常量版 —— 于是「后台手动改等级」（本文件）
   * 与「自动晋级审计」（`promotion.service`）写入的费率**来自两个地方**：
   * 运营改了配置，只有自动晋级那条路生效、后台改等级那条不变，而**两边都不报错**。
   * 同族于 #63「两个真相」与 #79「声明 ↔ 实现无对账」。
   *
   * ⚠️ 返回**字符串**（`ab_team_leader.commission_rate` 是 DECIMAL(5,4) 的快照值）。
   * ⚠️ **不追溯**：配置只影响此后写入的快照，已存在的团长费率保持不变 ——
   *    「改配置」不是「改历史账」，与「涨价不追改历史订单」同一条口径。
   */
  private async rateOf(level: LeaderLevel): Promise<string> {
    const rate = await this.bizConfig.commissionRate(level);
    return (Number.isFinite(rate) ? rate : LEADER_LEVEL_META[level].rate).toFixed(4);
  }

  private levelLabel(level?: string | null): string {
    if (!level) return '—';
    return LEADER_LEVEL_META[level as LeaderLevel]?.label ?? level;
  }

  private statusLabel(status: number): string {
    return LEADER_STATUS_LABEL[status as LeaderStatus] ?? String(status);
  }

  /**
   * 等级下拉（D19 名录 / 申请流水 / D19 筛选器共用）
   *
   * ⚠️ `rate` **同样走配置真源**（M5-13）：这一列是运营在下拉里"看到"的费率，
   *    若它读常量，就会出现「改了配置 → 写进去的费率变了、下拉里显示的没变」——
   *    与写入侧同源才叫真的收口（另一半见 `rateOf`）。
   */
  private async levelOptions(): Promise<Array<Record<string, unknown>>> {
    return Promise.all(
      Object.values(LeaderLevel).map(async (k) => {
        const rate = await this.bizConfig.commissionRate(k);
        return {
          key: k,
          label: LEADER_LEVEL_META[k].label,
          rate,
          rateText: `${(rate * 100).toFixed(0)}%`,
          /** C2 双条件（月单 + 介绍转正数）—— 前端只读展示，**不可编辑** */
          monthlyOrders: LEADER_LEVEL_META[k].monthlyOrders,
          referrals: LEADER_LEVEL_META[k].referrals,
        };
      }),
    );
  }

  private statusOptions(): Array<Record<string, unknown>> {
    return [LeaderStatus.ACTIVE, LeaderStatus.SUSPENDED].map((v) => ({
      key: v,
      label: LEADER_STATUS_LABEL[v],
    }));
  }

  private countBy(
    rows: Array<Record<string, unknown>>,
    field: string,
  ): Array<{ key: string; count: number }> {
    const map = new Map<string, number>();
    for (const r of rows) {
      const k = String(r[field] ?? '—');
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
  }
}

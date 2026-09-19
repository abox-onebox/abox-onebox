import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import {
  LEADER_LEVEL_META,
  LeaderLevel,
  LeaderStatus,
  WITHDRAW_FROZEN_STATUS,
} from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { BizConfigService } from '../../common/services/biz-config.service';
import { LeaderMoneyService } from '../../common/services/leader-money.service';
import { maskAccount } from '../../common/utils/crypto';
import { money, toYuan } from '../../common/utils/money';
import { toBjIso } from '../../common/utils/time';
import { Building } from '../../database/entities/building.entity';
import { Balance, Commission } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { User } from '../../database/entities/user.entity';
import { Withdraw } from '../../database/entities/withdraw.entity';
import { NOTIFY_PAGES } from '../admin/template/message-template.specs';
import { MessageService } from '../message/message.service';
import {
  ApplyLeaderReqDto,
  LeaderAgreementReqDto,
  QuitLeaderReqDto,
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
  private readonly logger = new Logger('TeamLeaderService');

  constructor(
    @InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>,
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    @InjectRepository(Balance) private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(Withdraw) private readonly withdrawRepo: Repository<Withdraw>,
    @InjectRepository(Commission) private readonly commissionRepo: Repository<Commission>,
    private readonly inviteService: LeaderInviteService,
    private readonly levelService: LeaderLevelService,
    private readonly dataSource: DataSource,
    // M4-3：申请成为团长后的「提交确认」通知（场景 `leader_apply`）
    private readonly message: MessageService,
    // M4-4：团长「余额 / 冻结 / 待入账佣金 / 累计已提现」的唯一真源读取口（#69）
    private readonly leaderMoney: LeaderMoneyService,
    /**
     * M5-13：**等级 → 费率** 的唯一真源口（`ab_config.commission.rate.*` · 常量兜底）。
     * ⚠️ 建档/复职的费率必须与晋级审计、后台任命走**同一个口** ——
     * 任何一处回退到 `LEADER_LEVEL_META[level].rate`，都会让「运营改了费率、
     * 只有一部分路径生效」，而两边都不会报错。
     */
    private readonly bizConfig: BizConfigService,
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
    // ⭐ M5-13：见习费率同样走配置真源（原本是 `LEADER_LEVEL_META[TRAINEE].rate` 常量）——
    // 「建档」是费率快照的第一个写点，它读常量就意味着「运营改配置对新建档无效」。
    const traineeRate = (await this.bizConfig.commissionRate(LeaderLevel.TRAINEE)).toFixed(4);

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

    // ⭐ M4-3：通知投递在**事务提交之后**（`leader_apply` 场景）
    //    放进事务里就是「事务回滚了、祝贺通知却已发出」—— 与退款通知同一条纪律。
    await this.notifyLeaderApplied(userId, now);

    return { isLeader: true, leader: await this.toProfile(leader, building.name) };
  }

  /**
   * 「团长申请提交确认」通知（M4-3 接线 `leader_apply`）
   *
   * ## 为什么 C3「提交即生效、无审核」也需要通知
   *
   * 「即生效」解决的是**权限**（提交完立刻能进团长端），但解决不了**认知**：
   * 刚成为团长的人不知道佣金怎么算、余额去哪看、什么时候开始计佣 —— 这些都在
   * 小程序里，而**刚上任的人不会自己去找**。通知是把他领进门的唯一动作。
   *
   * ## 三条纪律
   *
   * 1. **事务外调用**（调用点已在 `apply()` 的事务之后）；
   * 2. **失败不影响申请结果** —— `MessageService.notify()` 已承诺不抛异常，
   *    此处再兜一层 try：一次通知故障绝不能让「申请成功」变成「申请失败」；
   * 3. **未启用就静默跳过**（一期没有微信模板 ID，`leader_apply` 的启用闸门会
   *    拦住启用）—— 这是**如实状态**：代码接好了，配置还没到。
   */
  private async notifyLeaderApplied(userId: number, at: Date): Promise<void> {
    try {
      const applyAt = toBjIso(at) ?? '';
      const leaderLevel = LEADER_LEVEL_META[LeaderLevel.TRAINEE]?.label ?? LeaderLevel.TRAINEE;
      const r = await this.message.notify({
        scene: 'leader_apply',
        userId,
        page: NOTIFY_PAGES.leaderWorkbench,
        variables: { applyAt, leaderLevel },
        wxData: {
          applyAt: { value: applyAt },
          leaderLevel: { value: leaderLevel },
        },
      });
      if (!r.delivered) {
        this.logger.log(`团长申请通知未投递（user=${userId}）：${r.reason ?? '-'}`);
      }
    } catch (e) {
      this.logger.warn(
        `团长申请通知异常（user=${userId}）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
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

  /**
   * L16 · 4 级佣金规则 + C2 双条件门槛 + 我的晋级进度
   *
   * ⭐ 2026-09-18 修缺陷 #94 —— `mine` 里的等级字段**拆成两个名字**，并让进度相对生效等级：
   *   · `effectiveLevel` = **实际生效等级**（与 L11/L14 的 `level` 是**同一列** `ab_team_leader.level`）
   *   · `derivedLevel`   = **按本月业绩反推的「应处等级」**（`resolveLevel()` 的输出、
   *                        晋级审计的输入）——**它不是「我的等级」**
   *   · `nextLevel` / `progress` = 相对 **`effectiveLevel`** 的下一级与进度
   *
   * ⚠️ 为什么必须拆：旧出参只有一个 `level`（装的是 `derivedLevel`），而 L11/L14 的 `level`
   *    装的是生效等级 —— **同名不同义**。一个「首席但本月只做了 7 单」的团长会同时拿到
   *    `chief` 与 `trainee`，端上一照抄就是「同屏两个等级」。类型系统与编译器都拦不住这种错，
   *    只有把名字改到自解释才能。
   *
   * ⚠️ `effectiveLevel` 在此**复述**一次（L11/L14 也有）是刻意的：进度块的三个字段
   *    （生效等级 / 业绩测算 / 下一级+进度）必须能**自解释**，否则读侧要靠跨端点 join
   *    才能看懂「为什么进度是 100%」。它是**同一变量的引用**（同一行 `leader.level`），
   *    不是第二份定义。
   */
  async getLevelRules(userId: number) {
    const leader = await this.requireActiveLeader(userId);

    // 「介绍转正数」双源取大：表内累计（后台可修正）与邀请关系实时统计
    const counted = await this.inviteService.countFormal(leader.id);
    const invitedFormalCount = Math.max(counted, leader.invitedFormalCount);
    const { derivedLevel, nextLevel, progress } = this.levelService.progress(
      leader.level as LeaderLevel,
      leader.monthOrders,
      invitedFormalCount,
    );

    return {
      levels: await this.levelService.rules(),
      mine: {
        effectiveLevel: leader.level,
        derivedLevel,
        monthOrders: leader.monthOrders,
        invitedFormalCount,
        nextLevel,
        progress,
      },
      expireRule: this.levelService.expireRule(),
    };
  }

  /**
   * L20 · 退出团长身份（M2-2.8 · 2026-09-15 补）
   *
   * 【语义：停职而非删除】`status` 置 2，保留全部历史档案（订单 / 佣金 / 推荐关系 /
   *   协议留痕），且**支持日后重新申请复职** —— `apply` 对停职者有「复职并重置为见习」
   *   分支，故退出不是终点。同时清空 `ab_user.team_leader_id`（撤销「我归属于某位团长」
   *   这一关系），但**保留 `building_id`** —— 他仍是该写字楼的用户，明天照样能订餐。
   *
   * 【资金闸门】退出前必须走完资金链路，任一条不满足即 `20008`（附 `data.blockers`
   *   供端上逐条引导）：
   *     ① 可用余额 / 冻结余额未清零 —— 钱在账上却失去提现入口会造成事实上的资金悬空
   *     ② 存在在途提现申请（pending/approved/paying）—— 审批链仍指向一个已离职团长
   *     ③ 存在待入账佣金（`ab_commission.status='pending'`）—— 次日跑批入账时无归属
   *
   * ⭐ **本条（③）自 2026-09-17 M4-2 两段式起才真正会触发** —— 原先佣金在确认收货时
   *   即时入账（直接写 `settled`），生产链路里 `pending` 恒为 0，这条守卫是**死代码**
   *   （《缺陷与陷阱》#52）。两段式让 `pending` 成为每天都会出现的正常中间态，守卫
   *   随之「复活」，故 e2e §29 为它补了正向用例：**有 pending 佣金时必须拒绝退出**。
   *
   * 【幂等】退出后 `status=2`，重复调用会被 `LeaderGuard` / `requireActiveLeader`
   *   以 `20003` 拒绝；端上另配 `Idempotency-Key`，同键重放返回首次结果（不重复执行）。
   */
  async quit(userId: number, dto: QuitLeaderReqDto) {
    const leader = await this.requireActiveLeader(userId);

    const blockers = await this.collectQuitBlockers(leader);
    if (blockers.length) {
      throw new BizException(
        ErrorCode.LEADER_QUIT_BLOCKED,
        blockers.map((b) => b.text).join('；'),
        undefined,
        { blockers },
      );
    }

    const now = new Date();
    const result = await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(TeamLeader).update(Number(leader.id), {
        status: LeaderStatus.SUSPENDED,
      });
      // 撤销「归属某团长的用户」这一关系；`building_id` 保留（他仍是该楼用户）
      await manager.getRepository(User).update(userId, { teamLeaderId: null });
      return { quitAt: now };
    });

    this.logger.log(
      `团长退出：团长#${leader.id}（${leader.realName}）已停职` +
        `${dto.reason ? `，原因：${dto.reason}` : ''}`,
    );

    const snapshot = await this.leaderMoney.snapshotOf([
      { id: Number(leader.id), userId: Number(leader.userId) },
    ]);
    const snap = snapshot.get(Number(leader.id));

    return {
      /** 端上据此把底部导航重渲染回 4 项（C3 反向） */
      isLeader: false,
      status: LeaderStatus.SUSPENDED,
      level: leader.level,
      levelLabel: LEADER_LEVEL_META[leader.level as LeaderLevel]?.label ?? leader.level,
      quitAt: result.quitAt,
      /**
       * 历史资产仍保留，可在「我的」继续查看。
       *
       * ⚠️ `balance` 原先取 `ab_team_leader.balance` —— 那列**从种子之后就没有写点**，
       *    故退出时展示的是一个死数字。M4-4 起改取 `ab_balance` 真值（#69）。
       */
      kept: {
        totalOrders: Number(leader.totalOrders),
        totalCommission: leader.totalCommission,
        balance: snap ? money(toYuan(snap.balanceFen)) : '0.00',
        balanceFen: snap?.balanceFen ?? 0,
        frozenFen: snap?.frozenFen ?? 0,
      },
      tips: '已退出团长身份。历史佣金与订单记录仍保留；如需重新担任，可再次提交申请。',
    };
  }

  /**
   * 收集退出阻碍项（空数组 = 可以退出）
   *
   * 真源：可用/冻结余额取 `ab_balance`（用户维度，与提现同源，见 `CommissionService` 口径），
   *      在途提现取 `ab_withdraw`，待结算佣金取 `ab_commission`。
   */
  private async collectQuitBlockers(
    leader: TeamLeader,
  ): Promise<Array<{ code: string; text: string; amountFen?: number; count?: number }>> {
    const userId = Number(leader.userId);

    const [account, inFlight, pendingCommission] = await Promise.all([
      this.balanceRepo.findOne({ where: { userId } }),
      this.withdrawRepo.count({
        where: { leaderId: Number(leader.id), status: In(WITHDRAW_FROZEN_STATUS) },
      }),
      this.commissionRepo.count({ where: { teamLeaderId: Number(leader.id), status: 'pending' } }),
    ]);

    const balanceFen = Math.round(Number(account?.balance ?? 0) * 100);
    const frozenFen = Math.round(Number(account?.frozen ?? 0) * 100);

    const blockers: Array<{ code: string; text: string; amountFen?: number; count?: number }> = [];

    if (balanceFen > 0) {
      blockers.push({
        code: 'BALANCE_NOT_CLEARED',
        text: `可用余额 ¥${(balanceFen / 100).toFixed(2)} 未清零`,
        amountFen: balanceFen,
      });
    }
    if (frozenFen > 0) {
      blockers.push({
        code: 'FROZEN_NOT_CLEARED',
        text: `冻结余额 ¥${(frozenFen / 100).toFixed(2)} 未清零`,
        amountFen: frozenFen,
      });
    }
    if (inFlight > 0) {
      blockers.push({
        code: 'WITHDRAW_IN_FLIGHT',
        text: `有 ${inFlight} 笔提现正在处理中`,
        count: inFlight,
      });
    }
    if (pendingCommission > 0) {
      blockers.push({
        code: 'COMMISSION_PENDING',
        // ⚠️ 文案要给出**下一步怎么做**，不能只说「有 N 笔」（错误码是行动指引）：
        //    两段式下待入账会在次日 02:00 跑批后自动清零，故顺带告知可退出时机。
        text: `有 ${pendingCommission} 笔佣金待入账（次日 02:00 自动入账后方可退出）`,
        count: pendingCommission,
      });
    }

    return blockers;
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

    /**
     * ⚠️ 余额取 `ab_balance` 真值（M4-4 · #69），**不取** `ab_team_leader.balance`
     *    —— 后者从种子之后就没有写点，展示它会让「我的」页与 L11 余额页显示两个不同的数。
     */
    const snap = await this.leaderMoney.accountOf(Number(leader.userId));

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
      /** @deprecated 用 `balanceFen`（整数分）；值已改取 `ab_balance` */
      balance: money(toYuan(snap.balanceFen)),
      /** 可用余额（整数分）· 真源 `ab_balance` */
      balanceFen: snap.balanceFen,
      frozenFen: snap.frozenFen,
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

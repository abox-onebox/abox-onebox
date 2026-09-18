import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LeaderStatus } from '@abox/shared-types';

import { KvService } from '../../common/cache/kv.service';
import { ROLE_LABEL, menusOf } from '../../common/constants/admin-role';
import { ErrorCode } from '../../common/constants/error-code';
import { JwtPayload } from '../../common/decorators/auth.decorator';
import { BizException } from '../../common/exceptions/biz.exception';
import { money, toYuan } from '../../common/utils/money';
import { LeaderLookupService } from '../../common/services/leader-lookup.service';
import {
  LeaderAccountSnapshot,
  LeaderMoneyService,
} from '../../common/services/leader-money.service';
import { durationToSeconds } from '../../common/utils/time';
import { verifyPassword } from '../../common/utils/password';
import { Building } from '../../database/entities/building.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { AdminUser } from '../../database/entities/system.entity';
import { User } from '../../database/entities/user.entity';
import { WX_MINI_PROVIDER, WxMiniProvider } from '../../providers/wx-mini/wx-mini.provider';
import { LeaderInviteService } from '../team-leader/invite.service';
import { AdminLoginDto, RefreshTokenDto } from './dto/admin-login.dto';
import { LoginDto } from './dto/login.dto';

/**
 * 登录服务
 *
 * 关键身份模型（v4.7.8）：**用户与团长共用同一小程序身份**
 *   —— ab_user 是唯一身份；团长只是叠加在 user 上的第二身份（ab_team_leader）。
 *   因此登录只建/查用户，isLeader 作为附加状态返回，前端据此决定是否显示团长 tab。
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>,
    @InjectRepository(AdminUser) private readonly adminRepo: Repository<AdminUser>,
    /**
     * M5-10：A2 资料补 `buildingName` —— P8 个人中心要显示「跟随团长：李明 ·
     * 国贸三期 A 座」，此前只出 `buildingId`，端上只能写一句
     * 「已绑定办公楼（见首页取餐点）」糊过去。
     */
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    @Inject(WX_MINI_PROVIDER) private readonly wxMini: WxMiniProvider,
    private readonly jwt: JwtService,
    private readonly kv: KvService,
    private readonly config: ConfigService,
    /** M4-4：`leader.balance` 的真源（`ab_balance`）—— 见文件末尾 `leaderBalanceView` */
    private readonly leaderMoney: LeaderMoneyService,
    /** M5-11：邀请码解析的**唯一实现**（见 `LeaderLookupService` 头注 · 缺陷 #92） */
    private readonly leaderLookup: LeaderLookupService,
    /** M5-11：邀请关系落表（`bindOnInvite` · 「何时落表 ①」的那条路径） */
    private readonly inviteService: LeaderInviteService,
  ) {}

  /** 微信登录：code → openid → 查/建用户 → （可选）绑定邀请团长 → 签发 JWT */
  async login(dto: LoginDto) {
    const session = await this.wxMini.code2Session(dto.code);

    let user = await this.userRepo.findOne({ where: { openid: session.openid } });
    let isNewUser = false;

    if (!user) {
      user = await this.userRepo.save(
        this.userRepo.create({
          openid: session.openid,
          unionid: session.unionid ?? null,
          nickname: dto.nickname ?? '微信用户',
          avatarUrl: dto.avatarUrl ?? null,
          status: 1,
        }),
      );
      isNewUser = true;
      this.logger.log(`新用户注册 id=${user.id}（${this.wxMini.isMock ? 'mock' : 'real'} 通道）`);
    } else if (user.status === 2) {
      throw new BizException(ErrorCode.USER_DISABLED);
    }

    // ⑨ 邀请码绑定（M5-11 · 收口缺陷 #92）—— 「扫码进来的这个人归谁」的唯一写点
    if (dto.inviteCode) {
      await this.bindInvite(user, dto.inviteCode);
    }

    const leader = await this.leaderRepo.findOne({ where: { userId: user.id } });
    const isLeader = !!leader && leader.status === LeaderStatus.ACTIVE;

    const token = await this.jwt.signAsync({
      sub: user.id,
      // 显式标注主体类型（M3 起 JwtAuthGuard 靠它隔离后台 token，见 auth.decorator.ts）
      typ: 'user',
      openid: user.openid,
      isLeader,
      teamLeaderId: leader?.id ?? null,
    } satisfies JwtPayload);

    const account = leader ? await this.leaderMoney.accountOf(Number(user.id)) : null;

    return {
      token,
      isNewUser,
      isLeader,
      user: {
        id: user.id,
        nickname: user.nickname ?? null,
        avatarUrl: user.avatarUrl ?? null,
        phone: user.phone ?? null,
        buildingId: user.buildingId ?? null,
        teamLeaderId: user.teamLeaderId ?? null,
      },
      leader: leader
        ? {
            id: leader.id,
            level: leader.level,
            commissionRate: leader.commissionRate,
            ...leaderBalanceView(account),
          }
        : null,
    };
  }

  /**
   * 登录时的**邀请码绑定**（M5-11 · 收口缺陷 #92）
   *
   * ## 为什么必须在这一步做
   * 规范 §1.5 一直写着「登录链路带邀请码 → 绑定推荐团长」，但此前：
   *   · `LoginDto.inviteCode` 字段**存在却没人读**（死字段）；
   *   · `ab_leader_invite` 全仓只有 `bindOnApply`（**申请团长**路径）一条写点；
   *   · `ab_user.building_id` / `team_leader_id` 也只有「申请成为团长」与
   *     「后台任命」两条写点 —— **扫码进来的人没有任何路径被绑定**。
   * 于是 U3 落地页的「授权加入」只能如实只记本地（这就是 #92「入口有、写点无」）。
   *
   * ## 语义（逐条对应《接口规范》§1.5 的表）
   * 1. **码无效 / 团长停职 → 抛 `30007`，整个登录失败**。刻意**不静默忽略**：
   *    「用户以为加入了、服务端什么也没发生」正是 #92 要消灭的形态。
   *    端上据此提示「邀请码已失效」并回落到**不带邀请码的普通登录**，
   *    故不会把人锁在门外（见 `utils/auth.ts#bindLeaderByInvite` 的兜底）。
   * 2. **已有归属时换绑只改 `ab_user`**：楼栋**不动**（他还在原来那栋楼吃饭；
   *    把他从 A 楼搬到 B 楼是「办公楼变更」，属 L15 需后台审核的事项，不由扫码决定）。
   * 3. **邀请关系不改写**（`bindOnInvite` 内部保证）—— 邀请人是历史事实。
   */
  private async bindInvite(user: User, inviteCode: string): Promise<void> {
    const leader = await this.leaderLookup.requireActiveByCode(inviteCode);

    const patch: { teamLeaderId?: number; buildingId?: number } = {};
    if (Number(user.teamLeaderId ?? 0) !== Number(leader.id)) patch.teamLeaderId = leader.id;
    // ⚠️ 楼栋**只在还没有归属时**补 —— 换团长不换楼（见本方法头注 ②）。
    if (!user.buildingId && leader.buildingId) patch.buildingId = leader.buildingId;

    if (Object.keys(patch).length > 0) {
      await this.userRepo.update(Number(user.id), patch);
      // 内存中的实体同步更新 → 本次登录的响应体即可回显新归属（不必再查一次库）
      Object.assign(user, patch);
      this.logger.log(
        `用户#${user.id} 经邀请码 ${inviteCode} 绑定团长#${leader.id}` +
          `（楼栋 ${patch.buildingId ?? '保持不变'}）`,
      );
    }

    await this.inviteService.bindOnInvite(Number(user.id), Number(leader.id), 'link', inviteCode);
  }

  /**
   * 当前登录用户资料（A2 `GET /auth/me` / A5 `GET /auth/profile` 共用）
   *
   * ⭐ M5-10 补两个**派生只读**字段 `buildingName` / `leaderName`：
   *    P8 个人中心原型要显示「跟随团长：李明 · 国贸三期 A 座」，
   *    而此前只出 `buildingId` / `teamLeaderId` 两个数字，端上无法渲染。
   *
   *    ⚠️ 为什么不新开 `GET /me`（规范 U12）承担：U12 要的就是这份数据，
   *       本方法已是它的实现，再建端点 = 两个端点一份数据（详见
   *       `modules/user/user.controller.ts` 头注）。
   *
   *    ⚠️ 两个字段都**可空**：未绑定办公楼（新用户首次进入）→ `null`，
   *       端上显示引导文案而不是渲染 `undefined`。
   *       注意 `teamLeaderId` 有值但团长已停职时也要能显示名字 ——
   *       故按 id 直查，**不过滤 `status`**（与「跟随团长」的绑定关系无关，
   *       停职是团长侧的运营状态）。
   */
  async profile(userId: number) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BizException(ErrorCode.USER_NOT_FOUND);

    const leader = await this.leaderRepo.findOne({ where: { userId } });
    const account = leader ? await this.leaderMoney.accountOf(userId) : null;

    /**
     * 楼栋名与团长名的取数口径：
     *   · 绑定团长（`user.teamLeaderId`）优先 —— 用户「跟随」的是它；
     *   · 没有绑定团长但自己是团长 → 退回「自己的办公楼」（`leader.buildingId`），
     *     否则团长本人在 P8 上会看到「未绑定办公楼」。
     * ⚠️ 两次查询合并成一次 `In([...])`：两个 id 常常相同，去重后再查，
     *    `In` 列表长度恒 ≤ 2（SQLite 绑定变量上限 999 与本处无关，但保持习惯）。
     */
    const effectiveLeaderId = user.teamLeaderId ?? leader?.id ?? null;
    const followedLeader = effectiveLeaderId
      ? effectiveLeaderId === leader?.id
        ? leader
        : await this.leaderRepo.findOne({ where: { id: effectiveLeaderId } })
      : null;

    const buildingId = user.buildingId ?? leader?.buildingId ?? null;
    const building = buildingId
      ? await this.buildingRepo.findOne({ where: { id: Number(buildingId) } })
      : null;

    return {
      id: user.id,
      nickname: user.nickname ?? null,
      avatarUrl: user.avatarUrl ?? null,
      phone: user.phone ?? null,
      buildingId: user.buildingId ?? null,
      /** ⭐ 派生：办公楼名称（未绑定 → null），P8「跟随团长：X · {本字段}」 */
      buildingName: building?.name ?? null,
      teamLeaderId: user.teamLeaderId ?? null,
      /** ⭐ 派生：跟随团长姓名（未跟随/已解绑 → null） */
      leaderName: followedLeader?.realName ?? null,
      isLeader: !!leader && leader.status === LeaderStatus.ACTIVE,
      leader: leader
        ? {
            id: leader.id,
            level: leader.level,
            commissionRate: leader.commissionRate,
            ...leaderBalanceView(account),
            totalOrders: leader.totalOrders,
            totalCommission: leader.totalCommission,
          }
        : null,
    };
  }

  // ==========================================================================
  // 后台账号（A2 登录 / A3 刷新 / A4 登出 / A5 当前登录者）
  //
  // 与小程序用户的**根本差异**：
  //   · 独立账号表 ab_admin_user（与 ab_user 无任何外键关系）
  //   · 角色驱动（role）→ 后端下发 menus[]，前端据此渲染侧边栏
  //   · 口令登录（非微信），带失败锁定（20005）
  // ==========================================================================

  /** 登录失败计数键（按登录名，不按 IP —— 后台账号是已知的少量主体） */
  private static failKey(username: string): string {
    return `admin:login:fail:${username.toLowerCase()}`;
  }

  /** 组装对外的账号对象（**绝不出 passwordHash**） */
  private buildAccount(admin: AdminUser) {
    return {
      id: admin.id,
      username: admin.username,
      name: admin.realName ?? admin.username,
      role: admin.role,
      roleLabel: ROLE_LABEL[admin.role] ?? admin.role,
      /** 供应商账号的身份锚点：S* 与 P21–P26 的数据范围全部按它收窄 */
      supplierId: admin.supplierId ?? null,
      menus: menusOf(admin.role),
    };
  }

  /** 签发一对令牌（access 短 / refresh 长，refresh 带 rt 标记不可用于业务端点） */
  private async issueAdminTokens(admin: AdminUser) {
    const accessTtl = this.config.get<string>('app.adminJwtExpiresIn') ?? '12h';
    const refreshTtl = this.config.get<string>('app.adminRefreshExpiresIn') ?? '7d';

    const base = {
      sub: admin.id,
      typ: 'admin' as const,
      role: admin.role,
      username: admin.username,
      supplierId: admin.supplierId ?? null,
    };

    const token = await this.jwt.signAsync(base satisfies JwtPayload, {
      expiresIn: accessTtl,
    });
    const refreshToken = await this.jwt.signAsync(
      { sub: admin.id, typ: 'admin', rt: true } satisfies JwtPayload,
      { expiresIn: refreshTtl },
    );

    return { token, refreshToken, expiresIn: durationToSeconds(accessTtl) };
  }

  /**
   * A2 后台登录（运营 / 供应商同一入口）
   *
   * 校验顺序有意为之：
   *   ① **锁定闸门最先** —— 若先比对口令，攻击者能靠响应差异把接口当密码 oracle；
   *   ② 账号不存在 / 口令错 → 同一个 20005（不区分，防用户名枚举）；
   *   ③ 口令**正确**但账号停用 → 20006（此时才透露账号存在，运营需要明确反馈）。
   */
  async adminLogin(dto: AdminLoginDto) {
    const username = dto.username.trim();
    const failKey = AuthService.failKey(username);
    const maxAttempts = this.config.get<number>('app.adminLoginMaxAttempts') ?? 5;
    const lockSec = this.config.get<number>('app.adminLoginLockSeconds') ?? 900;

    const lockedFails = Number((await this.kv.get(failKey)) ?? 0);
    if (lockedFails >= maxAttempts) {
      this.logger.warn(`后台登录被拒（已锁定）username=${username}`);
      throw new BizException(ErrorCode.ADMIN_LOGIN_LOCKED, '账号或密码错误，已锁定 15 分钟');
    }

    const admin = await this.adminRepo.findOne({ where: { username } });
    const passwordOk = !!admin && verifyPassword(dto.password, admin.passwordHash);

    if (!admin || !passwordOk) {
      const n = await this.kv.incr(failKey, lockSec);
      this.logger.warn(`后台登录失败 username=${username}（第 ${n}/${maxAttempts} 次）`);
      throw new BizException(
        ErrorCode.ADMIN_LOGIN_LOCKED,
        n >= maxAttempts
          ? '账号或密码错误，已锁定 15 分钟'
          : `账号或密码错误（还可尝试 ${maxAttempts - n} 次）`,
      );
    }

    if (admin.status !== 1) {
      throw new BizException(ErrorCode.USER_DISABLED, '该后台账号已被停用，请联系超级管理员');
    }

    await this.kv.del(failKey);
    admin.lastLoginAt = new Date();
    await this.adminRepo.save(admin);

    const tokens = await this.issueAdminTokens(admin);
    this.logger.log(`后台登录成功 id=${admin.id} role=${admin.role}`);

    return { ...tokens, account: this.buildAccount(admin) };
  }

  /**
   * A3 刷新令牌
   *
   * ⚠️ 只接受 `typ='admin' && rt=true` 的令牌。用 access token 来刷新会被拒 ——
   *    否则「拿一个即将过期的令牌换一个新的」等于永不过期。
   * ⚠️ 刷新时**重新查库**：账号在令牌有效期内被停用/改角色，刷新即生效
   *    （这是让「12h 的 access」不至于成为 12 小时的权限冻结窗口的关键）。
   */
  async adminRefresh(dto: RefreshTokenDto) {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(dto.refreshToken);
    } catch {
      throw new BizException(ErrorCode.UNAUTHORIZED, '刷新令牌无效或已过期');
    }

    if (payload.typ !== 'admin' || !payload.rt) {
      throw new BizException(ErrorCode.FORBIDDEN, '该令牌不能用于刷新');
    }

    const admin = await this.adminRepo.findOne({ where: { id: payload.sub } });
    if (!admin) throw new BizException(ErrorCode.UNAUTHORIZED, '账号不存在');
    if (admin.status !== 1) {
      throw new BizException(ErrorCode.USER_DISABLED, '该后台账号已被停用');
    }

    return { ...(await this.issueAdminTokens(admin)), account: this.buildAccount(admin) };
  }

  /**
   * A5 当前登录者（含 menus —— 前端刷新页面后重建侧边栏的唯一来源）
   */
  async adminProfile(adminUserId: number) {
    const admin = await this.adminRepo.findOne({ where: { id: adminUserId } });
    if (!admin) throw new BizException(ErrorCode.UNAUTHORIZED, '账号不存在');
    if (admin.status !== 1) {
      throw new BizException(ErrorCode.USER_DISABLED, '该后台账号已被停用');
    }
    return this.buildAccount(admin);
  }

  /**
   * A4 登出
   *
   * ⚠️ **服务端无会话，本接口不吊销任何东西**：JWT 是无状态的，真正的失效
   *    依靠短 TTL（access 12h / refresh 7d）+ 前端清态。
   *    「登出即立刻失效」需要令牌黑名单或改用具名会话 —— 一期不值当，
   *    已在此显式记录，避免后人误以为调用它就安全了。
   */
  adminLogout(): null {
    return null;
  }
}

/**
 * 团长「余额」视图（M4-4 · 修复《缺陷与陷阱》#69）
 *
 * ## 为什么要有这个函数，而不是直接下发 `leader.balance`
 *
 * `ab_team_leader.balance` 这一列**只在种子里被赋过值、全仓没有任何写点**，
 * 而登录 / 资料两个出参一直把它当「可用余额」下发 —— 于是：
 *
 * · 团长「我的」页显示的是**种子里的死数字**，而「余额明细」页（L11 走 `ab_balance`）
 *   显示的是真值 → **同一个人在同一时刻看到两个不同的余额**，且**两边都不报错**；
 * · 他去提现会被 `50004 可提现余额不足` 拦下（真值可能为 0），
 *   而页面上明明写着有几百块 —— 这是必然会产生的客服工单。
 *
 * 故 `balance` 改为从 `ab_balance`（**余额唯一真源**，与 L11 / D38 同源）派生；
 * 同时补 `balanceFen` / `frozenFen`（**整数分**，端上不必再自己换算元）。
 *
 * ⚠️ `balance`（元字符串）**保留但已废弃** —— 小程序端既有页面在读它，
 *    一次性删掉会造成「字段消失」的静默故障；值本身已改成真值，
 *    新代码请用 `balanceFen`（与全项目「金额出参一律整数分」的纪律一致）。
 */
function leaderBalanceView(account: LeaderAccountSnapshot | null) {
  const zero: LeaderAccountSnapshot = {
    balanceFen: 0,
    frozenFen: 0,
    totalInFen: 0,
    totalOutFen: 0,
    hasAccount: false,
  };
  const a = account ?? zero;

  return {
    /** @deprecated 用 `balanceFen`（整数分）。此处仅为兼容既有端上页面，值取自 `ab_balance` */
    balance: money(toYuan(a.balanceFen)),
    /** 可用余额（整数分）—— 真源 `ab_balance` */
    balanceFen: a.balanceFen,
    /** 冻结额（整数分）—— 提现占用 + D39 手工冻结 */
    frozenFen: a.frozenFen,
    /** `false` = 从未发生资金往来（余额全 0），不是异常 */
    hasBalanceAccount: a.hasAccount,
  };
}

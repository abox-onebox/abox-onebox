import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, IsNull, Repository } from 'typeorm';

import {
  BUILDING_STATUS_LABEL,
  BuildingStatus,
  ORDER_STATUS_VIEW,
  OrderStatus,
} from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { UserStatus, USER_STATUS_LABEL } from '../../common/constants/user-status';
import { BizException } from '../../common/exceptions/biz.exception';
import { LeaderMoneyService } from '../../common/services/leader-money.service';
import { maskPhone } from '../../common/utils/crypto';
import { toFen } from '../../common/utils/money';
import { normalizePage, paginate } from '../../common/utils/response';
import { Building, BuildingGroup } from '../../database/entities/building.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { Order } from '../../database/entities/order.entity';
import { User } from '../../database/entities/user.entity';
import { AdminUsersQueryDto, UpdateUserDto } from './dto/user-admin.dto';

/**
 * 后台 · C 端用户管理（「用户」域此前**完全没有后台能力**）
 *
 * ## 为什么这一块此前是空的，而它是个真缺口
 *
 * 本仓库 83 个 `/admin/*` 端点里**没有任何一个是 C 端用户的**：
 * 没有 `/admin/users`、没有列表页、`admin-web/src/api/user.ts` 是一句
 * `export {}` 的骨架文件。于是运营/客服面对「用户说他下不了单」时：
 *
 *   · 查不到这个人（只能让用户报微信号，再靠昵称去猜）；
 *   · 他没绑楼时，**没有任何后台手段代绑**（唯一的写入口是邀请链接）；
 *   · 遇到恶意用户也没有拉黑入口 —— `ab_user.status = 2` 有语义、有登录拦截
 *     （`USER_DISABLED`），但**没有任何地方能把它置上**。
 *
 * 即：`status` 这个字段是「有锁没钥匙」。本服务把钥匙配上。
 *
 * ## ⚠️ 三条纪律
 *
 * 1. **手机号一律脱敏**（`maskPhone`）—— 后台不展示完整手机号，与 D19 团长名录同口径。
 * 2. **余额只走 `LeaderMoneyService`** —— `ab_balance` 只此一处读，
 *    自己 `SUM` 一次就是 #69 的形状（两个页面显示两个余额）。
 * 3. **改楼即清 `team_leader_id`** —— 与 `UserService.bindBuilding` 同一规则：
 *    楼变了，佣金归属必须重算，否则会出现「在新楼下单、佣金记给旧楼团长」且不报错。
 *
 * ## ⚠️ 与「账号管理」(`/system/admin-user`) 是两件事
 *
 * `/admin/system/accounts` 管的是**后台运营账号**（`ab_admin_user`）；
 * 本文件管的是**C 端微信用户**（`ab_user`）。两者都叫「用户」，
 * 混在一起会让「拉黑一个吃白食的用户」和「停用一个运营账号」互相污染。
 */
@Injectable()
export class UserAdminService {
  private readonly logger = new Logger('UserAdminService');

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    @InjectRepository(BuildingGroup) private readonly groupRepo: Repository<BuildingGroup>,
    @InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>,
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    /** 余额唯一真源（见文件头纪律 2） */
    private readonly leaderMoney: LeaderMoneyService,
  ) {}

  /**
   * 用户名录（分页）
   *
   * `summary` 按**同一过滤条件的全量**统计，不受分页影响 ——
   * 与 D19 团长名录 / D8 订单中心同一约定，翻页时 KPI 卡不跟着跳。
   *
   * ⚠️ `summary.unboundCount` 是本页最有运营价值的一个数：
   *    **未绑楼的用户下不了单**（`/home/daily` 报 20016），而他自己不知道为什么。
   *    这个数从 0 变正就是在说「有一批人正卡在首页空态上」。
   */
  async list(q: AdminUsersQueryDto) {
    const { page, pageSize, skip } = normalizePage(q);
    const base = this.buildQuery(q);

    const [rows, total] = await base
      .clone()
      .orderBy('u.id', 'DESC')
      .skip(skip)
      .take(pageSize)
      .getManyAndCount();

    // 汇总 = 同一过滤条件的全量（只取判断需要的三列，不搬整行）
    const all = await base
      .clone()
      .select(['u.id', 'u.status', 'u.buildingId'])
      .orderBy('u.id', 'DESC')
      .getMany();

    const view = await this.toRows(rows);

    return {
      ...paginate(view, total, page, pageSize),
      summary: {
        totalCount: all.length,
        normalCount: all.filter((u) => u.status === UserStatus.NORMAL).length,
        blacklistCount: all.filter((u) => u.status === UserStatus.BLACKLIST).length,
        canceledCount: all.filter((u) => u.status === UserStatus.CANCELED).length,
        /** ⭐ 未绑楼 = 下不了单（20016），运营要盯的就是这个数 */
        unboundCount: all.filter((u) => !u.buildingId).length,
      },
    };
  }

  /** 筛选器下拉（办公楼 / 状态 / 绑楼状态） */
  async filterOptions() {
    const buildings = await this.buildingRepo.find({
      where: { deletedAt: IsNull() },
      order: { name: 'ASC' },
    });

    return {
      buildings: buildings.map((b) => ({
        id: Number(b.id),
        name: b.name,
        status: b.status,
        statusLabel: BUILDING_STATUS_LABEL[b.status as BuildingStatus] ?? String(b.status),
      })),
      statuses: [
        { key: UserStatus.NORMAL, label: USER_STATUS_LABEL[UserStatus.NORMAL] },
        { key: UserStatus.BLACKLIST, label: USER_STATUS_LABEL[UserStatus.BLACKLIST] },
        { key: UserStatus.CANCELED, label: USER_STATUS_LABEL[UserStatus.CANCELED] },
      ],
      bindStates: [
        { key: 'bound', label: '已绑楼' },
        { key: 'unbound', label: '未绑楼（下不了单）' },
      ],
    };
  }

  /**
   * 用户详情（档案 + 余额 + 最近订单）
   *
   * ⭐ 三块信息是**同一次排查**需要的：客服接到「我下不了单」时，
   *    要先看绑没绑楼（`buildingId` / `groupName`），再看是不是被拉黑（`status`），
   *    最后看有没有钱（`balance`）。缺任何一块都要再问一轮用户。
   */
  async detail(id: number) {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new BizException(ErrorCode.USER_NOT_FOUND);

    const [row] = await this.toRows([user]);
    const account = await this.leaderMoney.accountOf(Number(user.id));

    const orders = await this.orderRepo.find({
      where: { userId: id },
      order: { createdAt: 'DESC' },
      take: 10,
    });

    return {
      user: row,
      balance: {
        balanceFen: account.balanceFen,
        frozenFen: account.frozenFen,
        totalInFen: account.totalInFen,
        totalOutFen: account.totalOutFen,
        hasBalanceAccount: account.hasAccount,
      },
      recentOrders: orders.map((o) => ({
        orderNo: o.orderNo,
        mealDate: o.mealDate,
        quantity: o.quantity,
        totalFen: toFen(Number(o.totalAmount ?? 0)),
        status: o.status,
        statusText: ORDER_STATUS_VIEW[o.status as OrderStatus]?.admin ?? String(o.status),
        createdAt: o.createdAt,
      })),
      /**
       * ⚠️ 为什么这里要讲「楼群」：`resolveUserGroup` 的失败有两种
       * （未绑楼 / 楼未归群），表现都是「下不了单」，但**修法完全不同** ——
       * 前者用户自己选一下，后者必须运营去配楼群。
       */
      note: row.buildingId
        ? row.groupName
          ? '该用户已绑楼且楼群正常。'
          : '该用户所在办公楼**未归入楼群**，他下不了单 —— 请到「楼群管理」把该楼加进楼群。'
        : '该用户**未绑定办公楼**（下不了单，端上报 20016）。可在本页代绑，或让用户到小程序「我的 → 切换团长（绑定办公楼）」自助选择。',
    };
  }

  /** 修改（代绑/解绑楼栋 · 拉黑/恢复正常） */
  async update(id: number, dto: UpdateUserDto) {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new BizException(ErrorCode.USER_NOT_FOUND);

    // 已注销是终态：注销有三道资金闸门，运营不能绕过它们把账号改成别的态
    if (user.status === UserStatus.CANCELED) {
      throw new BizException(
        ErrorCode.ACCOUNT_CANCELED,
        '该账号已由用户自助注销，不能改状态或改绑楼栋；恢复需人工处理',
      );
    }

    const patch: Partial<User> = {};
    const changed: string[] = [];

    if (dto.buildingId !== undefined) {
      const target = dto.buildingId;
      if (target !== null) {
        const building = await this.buildingRepo.findOne({
          where: { id: target, deletedAt: IsNull() },
        });
        if (!building) throw new BizException(ErrorCode.BUILDING_NOT_FOUND);
      }
      if (Number(user.buildingId ?? 0) !== Number(target ?? 0)) {
        patch.buildingId = target;
        // ⭐ 楼变 → 归属重算（与 `UserService.bindBuilding` 同一规则，勿拆开改）
        patch.teamLeaderId = null;
        changed.push('buildingId');
      }
    }

    if (dto.status !== undefined && dto.status !== user.status) {
      patch.status = dto.status;
      changed.push('status');
    }

    if (changed.length === 0) {
      return { id, changed, note: '没有需要变更的字段（目标值与当前值一致）' };
    }

    await this.userRepo.update({ id }, patch);
    this.logger.log(`后台修改 C 端用户 user=${id} · 变更字段：${changed.join(' / ')}`);

    return {
      id,
      changed,
      note:
        changed.includes('buildingId') && patch.buildingId === null
          ? '已解绑办公楼。该用户现在下不了单，需到小程序重新选择办公楼。'
          : changed.includes('buildingId')
            ? '已改绑办公楼，跟随团长已按新楼重算（佣金归属随之改变）。'
            : '账号状态已更新。',
    };
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  private buildQuery(q: AdminUsersQueryDto) {
    const qb = this.userRepo.createQueryBuilder('u');

    if (q.keyword) {
      const kw = `%${q.keyword}%`;
      // openid 只让搜**后 6 位**：全串搜等于拿一个内部标识去做模糊查询，
      // 且用户报得上来的也只有尾号（同 D19 只回 openidTail 的口径）。
      qb.andWhere(
        new Brackets((w) => {
          w.where('u.nickname LIKE :kw', { kw })
            .orWhere('u.phone LIKE :kw', { kw })
            .orWhere('u.openid LIKE :kw', { kw });
        }),
      );
    }

    if (q.buildingId) qb.andWhere('u.building_id = :buildingId', { buildingId: q.buildingId });
    if (q.status) qb.andWhere('u.status = :status', { status: q.status });
    if (q.bindState === 'bound') qb.andWhere('u.building_id IS NOT NULL');
    if (q.bindState === 'unbound') qb.andWhere('u.building_id IS NULL');

    return qb;
  }

  /**
   * 行 → 出参（楼 / 楼群 / 团长 / 订单数）
   *
   * ⚠️ 三张关联表**各查一次再内存映射**，不用 N+1：
   *    列表 20 行 → 4 次查询（users / buildings / groups / leaders / orders×1 聚合）。
   *    `ab_user` 没有 TypeORM 关系装饰器（只有 id 列），也就不可能用 `relations` 左连接。
   */
  private async toRows(rows: User[]) {
    const buildingIds = [
      ...new Set(rows.map((u) => Number(u.buildingId ?? 0)).filter((v) => v > 0)),
    ];
    const leaderIds = [
      ...new Set(rows.map((u) => Number(u.teamLeaderId ?? 0)).filter((v) => v > 0)),
    ];

    const buildings = buildingIds.length
      ? await this.buildingRepo.find({ where: { id: In(buildingIds) } })
      : [];
    const bMap = new Map(buildings.map((b) => [Number(b.id), b]));

    const groupIds = [
      ...new Set(buildings.map((b) => Number(b.buildingGroupId ?? 0)).filter((v) => v > 0)),
    ];
    const groups = groupIds.length
      ? await this.groupRepo.find({ where: { id: In(groupIds) } })
      : [];
    const gMap = new Map(groups.map((g) => [Number(g.id), g]));

    const leaders = leaderIds.length
      ? await this.leaderRepo.find({ where: { id: In(leaderIds) } })
      : [];
    const lMap = new Map(leaders.map((l) => [Number(l.id), l]));

    const orderCount = await this.orderCountOf(rows.map((u) => Number(u.id)));

    return rows.map((u) => {
      const uid = Number(u.id);
      const building = u.buildingId ? (bMap.get(Number(u.buildingId)) ?? null) : null;
      const group =
        building && building.buildingGroupId
          ? (gMap.get(Number(building.buildingGroupId)) ?? null)
          : null;
      const leader = u.teamLeaderId ? (lMap.get(Number(u.teamLeaderId)) ?? null) : null;

      return {
        id: uid,
        /** 已注销用户已被匿名化为「已注销用户」（`CANCELED_NICKNAME`），如实展示即可 */
        nickname: u.nickname ?? null,
        avatarUrl: u.avatarUrl ?? null,
        phoneMasked: maskPhone(u.phone),
        openidTail: u.openid ? u.openid.slice(-6) : null,
        status: u.status,
        statusLabel: USER_STATUS_LABEL[u.status as UserStatus] ?? String(u.status),
        buildingId: u.buildingId ?? null,
        buildingName: building?.name ?? null,
        groupName: group?.name ?? null,
        leaderId: u.teamLeaderId ?? null,
        leaderName: leader?.realName ?? null,
        orderCount: orderCount.get(uid) ?? 0,
        lastOrderAt: u.lastOrderAt ?? null,
        createdAt: u.createdAt,
      };
    });
  }

  /** 一批用户的订单数（一次聚合，不 N+1） */
  private async orderCountOf(userIds: number[]): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (userIds.length === 0) return map;

    const raw = await this.orderRepo
      .createQueryBuilder('o')
      .select('o.user_id', 'userId')
      .addSelect('COUNT(*)', 'cnt')
      .where('o.user_id IN (:...userIds)', { userIds })
      .groupBy('o.user_id')
      .getRawMany<{ userId: number | string; cnt: number | string }>();

    for (const r of raw) map.set(Number(r.userId), Number(r.cnt));
    return map;
  }
}

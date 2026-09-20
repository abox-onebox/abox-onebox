import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';

import type {
  HomeDailyResult,
  HomeHistoryItem,
  HomeLeaderInfo,
  HomeLeaderSource,
  MealDishView,
} from '@abox/shared-types';
import { OrderStatus } from '@abox/shared-types';
import { LeaderStatus } from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { BizConfigService } from '../../common/services/biz-config.service';
import { LeaderLookupService } from '../../common/services/leader-lookup.service';
import { paginate, PageResult } from '../../common/utils/response';
import {
  cutoffAtOf,
  isOrderable,
  publishAtOf,
  secondsToCutoff,
  toBjIso,
  todayBj,
  tomorrowBj,
} from '../../common/utils/time';
import { Building } from '../../database/entities/building.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { MealAssignment, SetMeal, SetMealItem } from '../../database/entities/meal.entity';
import { Order } from '../../database/entities/order.entity';
import { Dish, Supplier } from '../../database/entities/supplier.entity';
import { User } from '../../database/entities/user.entity';
import { SLOT_LABEL } from './dto/meal.dto';

/**
 * 套餐 / 首页服务
 *
 * 覆盖《接口规范 v1.0》§3.1：U1 明日套餐、U2 历史套餐归档
 *
 * ⚠️ C8 硬约束：发给用户端的菜品视图**严禁**包含供应商状态、供价、分账比例、
 *    备选商家清单与供应商联系方式。本服务只输出菜名 / 档位 / 图片 / 供应商**展示名与 id**。
 *
 * ⭐ M5-17：`dishes[].supplierId` 与 `leader.source` 为本批新增（见各自字段头注）；
 *    `resolveLeader` 的在职判据与 `OrderService.resolveLeader` 对齐（缺陷 ⑫ 收口）。
 */
@Injectable()
export class MealService {
  private readonly logger = new Logger('MealService');

  constructor(
    @InjectRepository(MealAssignment) private readonly assignmentRepo: Repository<MealAssignment>,
    @InjectRepository(SetMeal) private readonly setMealRepo: Repository<SetMeal>,
    @InjectRepository(SetMealItem) private readonly itemRepo: Repository<SetMealItem>,
    @InjectRepository(Dish) private readonly dishRepo: Repository<Dish>,
    @InjectRepository(Supplier) private readonly supplierRepo: Repository<Supplier>,
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    @InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>,
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly bizConfig: BizConfigService,
    /** M5-11：邀请码解析的**唯一实现**（见 `LeaderLookupService` 头注 · 缺陷 #92） */
    private readonly leaderLookup: LeaderLookupService,
  ) {}

  /**
   * U1 · 明日套餐
   * @param userId 当前登录用户（JWT sub）
   * @param mealDate 指定出餐日（缺省 = 明日 T+1）
   */
  async daily(userId: number, mealDate?: string): Promise<HomeDailyResult> {
    const targetDate = mealDate ?? tomorrowBj();
    const priceFen = await this.bizConfig.unitPriceFen();
    const cutoffWindow = await this.bizConfig.cutoffWindowMinutes();

    const buildingGroupId = await this.resolveUserGroup(userId);

    // 该楼群在该出餐日的分配（已取消的不算）
    const assignment = await this.assignmentRepo.findOne({
      where: { mealDate: targetDate, buildingGroupId, status: Not('cancelled') },
    });

    if (!assignment) {
      throw new BizException(ErrorCode.MEAL_NOT_PUBLISHED, `${targetDate} 该办公楼未开团`);
    }

    const [setMeal, dishes, leader, existing] = await Promise.all([
      this.setMealRepo.findOne({ where: { id: assignment.setMealId } }),
      this.dishesOfSetMeal(assignment.setMealId),
      this.resolveLeader(userId),
      this.orderRepo.findOne({
        where: { userId, mealDate: targetDate, status: Not(OrderStatus.CANCELLED) },
        order: { id: 'DESC' },
      }),
    ]);

    const canOrder = assignment.status === 'active' && isOrderable(targetDate, cutoffWindow);

    /**
     * `reason` 必须区分「还没开团」与「快截单了」—— 两者都会让 `canOrder=false`，
     * 但文案完全相反：前者是「再等等」，后者是「来不及了」。
     *
     * ⚠️ 曾经的写法只判断 `status !== 'active'`，于是**未到开团时刻**（T-1 14:00 之前）
     *    也会落进「距截单不足 N 分钟」分支，对着一个还要等好几小时的套餐说
     *    「请明日再订」。M3-2 支持运营提前编排后，这个分支从「几乎走不到」变成常见路径。
     */
    const now = Date.now();
    const publishAtMs = publishAtOf(targetDate).getTime();
    const notOpenYet = assignment.status === 'active' && now < publishAtMs;

    const reason = canOrder
      ? null
      : assignment.status !== 'active'
        ? '该办公楼今日未开团'
        : notOpenYet
          ? `今日 ${toBjIso(publishAtOf(targetDate))!.slice(11, 16)} 开团，敬请期待`
          : `距截单不足 ${cutoffWindow} 分钟，请明日再订`;

    return {
      mealDate: targetDate,
      publishAt: toBjIso(publishAtOf(targetDate))!,
      cutoffAt: toBjIso(cutoffAtOf(targetDate))!,
      canOrder,
      countdownSec: secondsToCutoff(targetDate),
      reason,
      setName: setMeal?.name ?? null,
      dishes,
      rice: '东北长粒香米饭（集散中心统一供米）',
      priceFen,
      // MVP 不设总份数上限（供应商按备料量生产），故返回 null 表示不限量；
      // 后续若启用产能上限，改读 ab_supplier.capacity_per_day 汇总。
      stockLeft: null,
      existingOrderNo: existing?.orderNo ?? null,
      leader,
    };
  }

  /**
   * U2 · 历史套餐归档（出餐日 ≤ 今日，按日期倒序）
   *
   * ⚠️ M5-17：**端上首页已不再展示本接口**（用户要求首页保持简单，砍掉「往日这盒」）。
   *    接口与端上 `api/meal.ts fetchHistory` **均保留**：它是 M1 的既有验收点，
   *    且「历史归档」这件事本身仍然成立 —— 只是当前不占首页版位。
   *    保留而非删除，是为了下一次要做「订单/历史」入口时**直接可用**，不必重写聚合。
   */
  async history(userId: number, page = 1, pageSize = 20): Promise<PageResult<HomeHistoryItem>> {
    const buildingGroupId = await this.resolveUserGroup(userId);
    const today = todayBj();

    const qb = this.assignmentRepo
      .createQueryBuilder('a')
      .where('a.building_group_id = :g', { g: buildingGroupId })
      .andWhere('a.meal_date <= :today', { today })
      .andWhere('a.status != :cancelled', { cancelled: 'cancelled' })
      .orderBy('a.meal_date', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [rows, total] = await qb.getManyAndCount();

    const list: HomeHistoryItem[] = [];
    for (const a of rows) {
      const [setMeal, dishes, ordersCount] = await Promise.all([
        this.setMealRepo.findOne({ where: { id: a.setMealId } }),
        this.dishesOfSetMeal(a.setMealId),
        this.orderRepo.count({
          where: { mealDate: a.mealDate, buildingGroupId, status: Not(OrderStatus.CANCELLED) },
        }),
      ]);
      list.push({
        mealDate: a.mealDate,
        setName: setMeal?.name ?? null,
        dishNames: dishes.map((d) => d.name),
        priceFen: Math.round(Number(setMeal?.price ?? 0) * 100),
        ordersCount,
      });
    }

    return paginate(list, total, page, pageSize);
  }

  /** U3 · 团长邀请落地（免登录） */
  async inviteLanding(leaderCode: string) {
    const leader = await this.findLeaderByCode(leaderCode);
    if (!leader || leader.status !== LeaderStatus.ACTIVE) {
      return {
        leaderCode,
        leaderName: '',
        building: null,
        floor: null,
        slogan: '邀请码已失效，可正常浏览套餐',
        valid: false,
      };
    }

    const building = await this.buildingRepo.findOne({ where: { id: leader.buildingId } });

    return {
      leaderCode,
      leaderName: leader.realName,
      building: building?.name ?? null,
      floor: null,
      slogan: `${building?.name ?? '本楼'} 团长 ${leader.realName} 邀你一起吃现做热饭`,
      valid: true,
    };
  }

  /**
   * 解析邀请码 → 团长
   *
   * ⚠️ M5-11（缺陷 #92 收口）：**实现已收敛到 `LeaderLookupService`** ——
   *    此前本方法、`OrderService.resolveLeader` 各抄了一份同样的正则，
   *    「同一件事的第二份表述」。本方法保留成薄壳只是为了不改调用方签名与
   *    「无效返回 null、由落地页降级展示」的既有语义。
   */
  async findLeaderByCode(code: string): Promise<TeamLeader | null> {
    return this.leaderLookup.byCode(code);
  }

  /** 用户所属楼群（缺失即报错，避免「未绑定办公楼」被静默当成可下单） */
  private async resolveUserGroup(userId: number): Promise<number> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BizException(ErrorCode.USER_NOT_FOUND);
    if (!user.buildingId) {
      throw new BizException(ErrorCode.NOT_FOUND, '你还未绑定办公楼，请通过团长邀请链接进入');
    }

    const building = await this.buildingRepo.findOne({ where: { id: user.buildingId } });
    if (!building?.buildingGroupId) {
      throw new BizException(ErrorCode.NOT_FOUND, '所属办公楼未配置楼群，请联系运营');
    }
    return building.buildingGroupId;
  }

  /**
   * 当前用户跟随的团长（U1 `leader` 出参）+ **归属来源**
   *
   * ## ⚠️ 本方法必须与 `OrderService.resolveLeader` 同判据（缺陷 ⑫ · M5-17 收口）
   *
   * 两处都回答「这一单佣金归谁」，但此前判据不同：
   *   · `OrderService.resolveLeader`（**真的决定钱**）：`user.team_leader_id` 指向的团长
   *     必须 `status === ACTIVE` 才用，否则回落到本楼在任团长；
   *   · 本方法（**只决定显示**）：只取 `team_leader_id` 指向的行 —— **不看在职与否**。
   *
   * 于是「总监停职 → 用户未重绑」这个组合下，首页显示停职的 A，下单却记 B 的佣金。
   * 根因是 D22「停职」只改 `ab_team_leader.status`，**不清 `ab_user.team_leader_id`**
   * （正确 —— 复职后绑定关系应当还在），所以「绑定行」与「有效归属」本来就可能不是同一个。
   *
   * 收口方式不是让两边各写一遍同样的三行，而是**让显示侧照抄交易侧的顺序**：
   * ① 绑定且在职 → 用；② 否则本楼 id 最小且在职 → 用；③ 都没有 → null。
   * 并额外下发 `source` 让端上把「你的邀请团长」与「本楼自动挂靠」说清楚。
   */
  private async resolveLeader(userId: number): Promise<HomeLeaderInfo | null> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) return null;

    let leader: TeamLeader | null = null;
    let source: HomeLeaderSource = 'building_default';

    if (user.teamLeaderId) {
      const own = await this.leaderRepo.findOne({ where: { id: user.teamLeaderId } });
      if (own && own.status === LeaderStatus.ACTIVE) {
        leader = own;
        source = 'bound';
      }
    }

    if (!leader && user.buildingId) {
      leader = await this.leaderRepo.findOne({
        where: { buildingId: user.buildingId, status: LeaderStatus.ACTIVE },
        order: { id: 'ASC' },
      });
      source = 'building_default';
    }
    if (!leader) return null;

    const building = await this.buildingRepo.findOne({ where: { id: leader.buildingId } });
    return {
      id: leader.id,
      name: leader.realName ?? null,
      building: building?.name ?? null,
      floor: null,
      source,
    };
  }

  /** 套餐菜品视图（含供应商展示名与 id，不含任何价格/分账字段 —— C8） */
  private async dishesOfSetMeal(setMealId: number): Promise<MealDishView[]> {
    const items = await this.itemRepo.find({ where: { setMealId }, order: { slot: 'ASC' } });
    if (items.length === 0) return [];

    const [dishes, suppliers] = await Promise.all([
      this.dishRepo.find({ where: { id: In(items.map((i) => i.dishId)) } }),
      this.supplierRepo.find({ where: { id: In([...new Set(items.map((i) => i.supplierId))]) } }),
    ]);

    const dishMap = new Map(dishes.map((d) => [d.id, d]));
    const supMap = new Map(suppliers.map((s) => [s.id, s]));

    return items.map((i) => {
      const dish = dishMap.get(i.dishId);
      return {
        name: dish?.name ?? `菜品 ${i.dishId}`,
        slot: i.slot,
        category: dish?.category ?? SLOT_LABEL[i.slot] ?? null,
        imageUrl: dish?.imageUrl ?? null,
        supplierName: supMap.get(i.supplierId)?.name ?? null,
        // 端上「来自：X」点击后跳溯源页并**按 id 定位**（name 无唯一约束，不按名定位）
        supplierId: i.supplierId,
      };
    });
  }
}

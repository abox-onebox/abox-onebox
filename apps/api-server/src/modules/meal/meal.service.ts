import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';

import type {
  HomeDailyResult,
  HomeHistoryItem,
  HomeLeaderInfo,
  HomeLeaderSource,
  MealItemView,
} from '@abox/shared-types';
import { OrderStatus } from '@abox/shared-types';
import { LeaderStatus } from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { BizConfigService } from '../../common/services/biz-config.service';
import { LeaderLookupService } from '../../common/services/leader-lookup.service';
import { OrderAvailabilityService } from '../../common/services/order-availability.service';
import { paginate, PageResult } from '../../common/utils/response';
import {
  cutoffAtOf,
  publishAtOf,
  secondsToCutoff,
  toBjIso,
  todayBj,
  tomorrowBj,
} from '../../common/utils/time';
import { currentTimeline, formatTimeOfDay } from '../../common/utils/order-timeline';
import { Building } from '../../database/entities/building.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { MealAssignment, SetMeal, SetMealItem } from '../../database/entities/meal.entity';
import { Order } from '../../database/entities/order.entity';
import { Item, Supplier } from '../../database/entities/supplier.entity';
import { User } from '../../database/entities/user.entity';
import { SLOT_LABEL } from './dto/meal.dto';

/**
 * 套餐 / 首页服务
 *
 * 覆盖《接口规范 v1.0》§3.1：U1 明日套餐、U2 历史套餐归档
 *
 * ⚠️ C8 硬约束：发给用户端的商品视图**严禁**包含供应商状态、供价、分账比例、
 *    备选商家清单与供应商联系方式。本服务只输出菜名 / 档位 / 图片 / 供应商**展示名与 id**。
 *
 * ⭐ M5-17：`items[].supplierId` 与 `leader.source` 为本批新增（见各自字段头注）；
 *    `resolveLeader` 的在职判据与 `OrderService.resolveLeader` 对齐（缺陷 ⑫ 收口）。
 */
@Injectable()
export class MealService {
  private readonly logger = new Logger('MealService');

  constructor(
    @InjectRepository(MealAssignment) private readonly assignmentRepo: Repository<MealAssignment>,
    @InjectRepository(SetMeal) private readonly setMealRepo: Repository<SetMeal>,
    @InjectRepository(SetMealItem) private readonly setMealItemRepo: Repository<SetMealItem>,
    @InjectRepository(Item) private readonly itemRepo: Repository<Item>,
    @InjectRepository(Supplier) private readonly supplierRepo: Repository<Supplier>,
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    @InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>,
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly bizConfig: BizConfigService,
    /** M5-11：邀请码解析的**唯一实现**（见 `LeaderLookupService` 头注 · 缺陷 #92） */
    private readonly leaderLookup: LeaderLookupService,
    /** N1（P3-4）：「此刻能否下单」的唯一判定口，与 U6 / 团长工作台同源 */
    private readonly availability: OrderAvailabilityService,
  ) {}

  /**
   * U1 · 明日套餐
   * @param userId 当前登录用户（JWT sub）
   * @param mealDate 指定出餐日（缺省 = 明日 T+1）
   */
  async daily(userId: number, mealDate?: string): Promise<HomeDailyResult> {
    const targetDate = mealDate ?? tomorrowBj();
    // ⚠️ 截单窗口不再在这里读：它已随「能否下单」下沉到 `OrderAvailabilityService`，
    //    本服务再读一份就是第二条口径来源（改一处漏一处）。
    const priceFen = await this.bizConfig.unitPriceFen();

    const { building, groupId: buildingGroupId } = await this.resolveUserGroup(userId);

    // 该楼群在该出餐日的分配（已取消的不算）
    const assignment = await this.assignmentRepo.findOne({
      where: { mealDate: targetDate, buildingGroupId, status: Not('cancelled') },
    });

    if (!assignment) {
      throw new BizException(ErrorCode.MEAL_NOT_PUBLISHED, `${targetDate} 该办公楼未开团`);
    }

    const [setMeal, rawItems, leader, existingOrders] = await Promise.all([
      this.setMealRepo.findOne({ where: { id: assignment.setMealId } }),
      this.itemsOfSetMeal(assignment.setMealId),
      this.resolveLeader(userId),
      /**
       * ⭐ 一人一日**可多单**（2026-10-03 口径变更）：故这里必须 `find` 全量未取消单，
       *    不能再用 `findOne`。已取消的不计入 —— 否则用户取消后首页仍显示「已订」，
       *    而后端其实已经放他重新下单了，两边会对不上。
       */
      this.orderRepo.find({
        where: { userId, mealDate: targetDate, status: Not(OrderStatus.CANCELLED) },
        order: { id: 'DESC' },
      }),
    ]);

    /**
     * ⚠️ 「此刻能不能下单」由编排层统一判定（N1 · P3-4 接线）
     *
     * 原写法 `assignment.status === 'active' && isOrderable(...)` **完全不参与楼宇状态** ——
     *    楼被停用（`status=3`）或所属楼群被停用时，这里照样 `canOrder = true`，
     *    用户点下单才在 U6 撞墙。两处口径不一致 = 首页说能订、下单说不能。
     *
     * 用 `forBuilding` 而不是 `forUser`：`resolveUserGroup()` 已经把 `building` 取出来了，
     *    走 `forUser` 会为了拿同一个 buildingId 再查一次 `ab_user`。
     *
     * `reason` 文案一律取编排层的 `reasonText`（`reasonText()` 是文案**唯一出口**）——
     *    本处不再自己拼：那会是第五份文案，且 `not_open_yet` / `cutoff` 漏插值就是空文案。
     */
    const availability = await this.availability.forBuilding(targetDate, Number(building.id));

    // 快消品套餐（fmcg）：主食位展示品牌饮品——
    //   把 slot 5 的商品名与其品牌（供应商展示名）分别填进 `rice` / `riceFrom`
    //   （端上按商品口径展示「来自：品牌」，不再写「随附饮品/开袋即食」，2026-10-24 整改），
    //   其余 1~4 档位进 `items` 网格。meal 饭类套餐仍走统一供米文案。
    let items = rawItems;
    let rice: string | null = '东北长粒香米饭（集散中心统一供米）';
    let riceFrom: string | null = null;
    if (setMeal?.kind === 'fmcg') {
      const beverage = rawItems.find((i) => i.slot === 5);
      rice = beverage ? beverage.name : null;
      riceFrom = beverage ? beverage.supplierName : null;
      items = rawItems.filter((i) => i.slot !== 5);
    }

    return {
      mealDate: targetDate,
      publishAt: toBjIso(publishAtOf(targetDate))!,
      cutoffAt: toBjIso(cutoffAtOf(targetDate))!,
      // ⭐ 送达时刻（PR-02 收口）：与 `cutoffAt` **同源派生** —— 端上「下单确认页」不再写死 `11:30`
      deliverAt: formatTimeOfDay(currentTimeline().arrival),
      canOrder: availability.canOrder,
      countdownSec: secondsToCutoff(targetDate),
      reason: availability.reasonText,
      setName: setMeal?.name ?? null,
      items,
      rice,
      riceFrom,
      kind: setMeal?.kind ?? 'meal',
      priceFen,
      // MVP 不设总份数上限（供应商按备料量生产），故返回 null 表示不限量；
      // 后续若启用产能上限，改读 ab_supplier.capacity_per_day 汇总。
      stockLeft: null,
      existingOrderNo: existingOrders[0]?.orderNo ?? null,
      existingOrderCount: existingOrders.length,
      existingQuantity: existingOrders.reduce((n, o) => n + (o.quantity || 0), 0),
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
    const { groupId: buildingGroupId } = await this.resolveUserGroup(userId);
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
      const [setMeal, items, ordersCount] = await Promise.all([
        this.setMealRepo.findOne({ where: { id: a.setMealId } }),
        this.itemsOfSetMeal(a.setMealId),
        this.orderRepo.count({
          where: { mealDate: a.mealDate, buildingGroupId, status: Not(OrderStatus.CANCELLED) },
        }),
      ]);
      list.push({
        mealDate: a.mealDate,
        setName: setMeal?.name ?? null,
        itemNames: items.map((d) => d.name),
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
        // 无效码也照下发：落地页是免登录页，文案「由团长统一取餐分发」仍需展示，
        // 若此处缺失会让端上被迫写死一个时刻（PR-02 要消灭的正是这个）。
        deliverAt: formatTimeOfDay(currentTimeline().arrival),
        valid: false,
      };
    }

    const building = await this.buildingRepo.findOne({ where: { id: leader.buildingId } });

    return {
      leaderCode,
      leaderName: leader.realName,
      building: building?.name ?? null,
      floor: null,
      slogan: `${building?.name ?? '本楼'} 团长 ${leader.realName} 邀你一起尝今日精选零食`,
      // ⭐ 送达时刻（PR-02 收口）：落地页免登录、无法借其它接口取到该值，故随本响应下发
      deliverAt: formatTimeOfDay(currentTimeline().arrival),
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

  /**
   * 用户所属楼群（缺失即报错，避免「未绑定办公楼」被静默当成可下单）
   *
   * ⚠️ 返回 `{ building, groupId }`：`building.status` 是「此刻能否下单」的判据之一，
   *    只带 `groupId` 出去就等于在这一步把楼宇状态丢掉（N1 的洞）。
   */
  private async resolveUserGroup(userId: number): Promise<{ building: Building; groupId: number }> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BizException(ErrorCode.USER_NOT_FOUND);
    if (!user.buildingId) {
      // ⚠️ 20016 而不是 10004：两者用户可执行的动作不同（自助选楼 / 找运营），
      //    合成一码端上就只能给一句两可的兜底文案 —— 见 ErrorCode.USER_BUILDING_UNBOUND。
      //    文案也改了：「请通过团长邀请链接进入」是**唯一绑楼途径**时的说法，
      //    现在有 `GET /building` + `PUT /me/building` 自助链路了。
      throw new BizException(
        ErrorCode.USER_BUILDING_UNBOUND,
        '你还没有选择办公楼，选好即可查看次日套餐',
      );
    }

    const building = await this.buildingRepo.findOne({ where: { id: user.buildingId } });
    if (!building?.buildingGroupId) {
      /**
       * ⚠️ 契约变更（N1 · P3-4）：`NOT_FOUND`(10004) → `BUILDING_NOT_GROUPED`(60011)
       *
       * 10004 是「资源不存在」，而这里是**配置缺失** —— 楼在、楼群没配。两者处置动作不同：
       * 前者该查数据，后者该找运营配楼群。合成一码，监控与告警就完全同形，
       * 60011 的默认文案统一由 `ERROR_MESSAGE` 提供，调用点不再内联覆写。
       */
      throw new BizException(ErrorCode.BUILDING_NOT_GROUPED);
    }
    /**
     * ⚠️ 返回 `building` 而不仅是 `groupId`：N1 的洞正是「楼宇状态不参与下单判定」——
     *    以前只把 `buildingGroupId` 带出来，`status` 在这一步被丢掉，
     *    于是楼已停用也照样 `canOrder = true`。
     */
    return { building, groupId: building.buildingGroupId };
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

  /** 套餐商品视图（含供应商展示名与 id，不含任何价格/分账字段 —— C8） */
  private async itemsOfSetMeal(setMealId: number): Promise<MealItemView[]> {
    const dishes = await this.setMealItemRepo.find({
      where: { setMealId },
      order: { slot: 'ASC' },
    });
    if (dishes.length === 0) return [];

    const [items, suppliers] = await Promise.all([
      this.itemRepo.find({ where: { id: In(dishes.map((i) => i.itemId)) } }),
      this.supplierRepo.find({ where: { id: In([...new Set(dishes.map((i) => i.supplierId))]) } }),
    ]);

    const dishMap = new Map(items.map((d) => [d.id, d]));
    const supMap = new Map(suppliers.map((s) => [s.id, s]));

    return dishes.map((i) => {
      const dish = dishMap.get(i.itemId);
      return {
        name: dish?.name ?? `商品 ${i.itemId}`,
        slot: i.slot,
        category: dish?.category ?? SLOT_LABEL[i.slot] ?? null,
        imageUrl: dish?.imageUrl ?? null,
        description: dish?.description ?? null,
        supplierName: supMap.get(i.supplierId)?.name ?? null,
        // 端上「来自：X」点击后跳溯源页并**按 id 定位**（name 无唯一约束，不按名定位）
        supplierId: i.supplierId,
      };
    });
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';

import type { HomeDailyResult, HomeHistoryItem, MealDishView } from '@abox/shared-types';
import { OrderStatus } from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { BizConfigService } from '../../common/services/biz-config.service';
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
 *    备选商家清单与供应商联系方式。本服务只输出菜名 / 档位 / 图片 / 供应商**展示名**。
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
    const reason = canOrder
      ? null
      : assignment.status !== 'active'
        ? '该办公楼今日未开团'
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

  /** U2 · 历史套餐归档（出餐日 ≤ 今日，按日期倒序） */
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
    if (!leader || leader.status !== 1) {
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
   * 兼容 `LDR0007`（4 位序号）与纯数字 id 两种写法，便于本地联调。
   */
  async findLeaderByCode(code: string): Promise<TeamLeader | null> {
    const m = /^LDR(\d{4,})$/i.exec(code.trim());
    if (m) return this.leaderRepo.findOne({ where: { id: Number(m[1]) } });

    const asId = Number(code);
    if (Number.isInteger(asId) && asId > 0) {
      return this.leaderRepo.findOne({ where: { id: asId } });
    }
    return null;
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

  /** 当前用户跟随的团长；未绑定则回落到其所在办公楼的在任团长 */
  private async resolveLeader(userId: number) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) return null;

    let leader = user.teamLeaderId
      ? await this.leaderRepo.findOne({ where: { id: user.teamLeaderId } })
      : null;

    if (!leader && user.buildingId) {
      leader = await this.leaderRepo.findOne({
        where: { buildingId: user.buildingId, status: 1 },
        order: { id: 'ASC' },
      });
    }
    if (!leader) return null;

    const building = await this.buildingRepo.findOne({ where: { id: leader.buildingId } });
    return {
      id: leader.id,
      name: leader.realName ?? null,
      building: building?.name ?? null,
      floor: null,
    };
  }

  /** 套餐菜品视图（含供应商展示名，不含任何价格/分账字段 —— C8） */
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
      };
    });
  }
}

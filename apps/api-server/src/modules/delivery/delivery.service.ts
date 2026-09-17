import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { OrderStatus } from '@abox/shared-types';

import { arrivalAtOf, toBjIso } from '../../common/utils/time';
import { BuildingGroup } from '../../database/entities/building.entity';
import { MealAssignment } from '../../database/entities/meal.entity';
import { DeliveryRecord, Order } from '../../database/entities/order.entity';

/** 配送单生成出参（`generateByDate` · 4.3） */
export interface DeliveryGenerateResult {
  date: string;
  /** 本次新建的配送单数 */
  created: number;
  /** 幂等命中：该楼群当日已有配送单 */
  skipped: number;
  /** 无订单的楼群（不生成配送单） */
  emptyGroups: number;
  /** 合计配送份数 */
  totalQuantity: number;
  /** 参与生成的楼群数 */
  groupCount: number;
  /** 预计送达时刻（T 日 11:30） */
  expectedAt: string | null;
  list: Array<{
    id?: number;
    buildingGroupId: number;
    groupName: string | null;
    totalQuantity: number;
  }>;
  /**
   * 数据可信度告警
   *
   * ⚠️ 配送单应在截单（T 00:00）之后生成，此时订单份数已定格。
   *    若本方法找不到任何 `cut_off` 订单，说明**截单可能没跑成** ——
   *    生成的份数会偏小，且不会有任何报错。此时给出告警而非静默通过。
   */
  warning: string | null;
}

/**
 * 配送服务（M4-1 · 4.3）
 *
 * 权威口径：《订单状态机与全链路流转 v1.0》§3 —— T 日 00:30 生成配送单 `ab_delivery_record`
 *
 * ## 粒度：按**楼群**，不是按订单
 * `ab_delivery_record` 的唯一键是 `(meal_date, building_group_id)`（见实体 `uk_delivery_date_group`），
 * 即**一天一个楼群一张单**。这与实际履约一致：一车货送到一个楼群，团长在楼下收。
 * 所以本服务把订单**聚合到楼群**后建单，而不是一单一单建。
 *
 * ## 份数口径
 * 与「推备料量」同源：计入 `status NOT IN ('pending_pay', 'cancelled')` 的订单。
 * 两者必须一致 —— 否则会出现「供应商做了 120 份、配送只送 100 份」，
 * 而对不上时**两边都不报错**。
 *
 * ## 幂等
 * 已存在 `(meal_date, building_group_id)` 的行即跳过，**不覆盖** ——
 * 配送单一旦生成就可能被运营填写司机 / 车牌（`driver_name` / `plate_no`），
 * 重算会把这些人工录入抹掉。份数在截单后已定格，本就无需刷新。
 */
@Injectable()
export class DeliveryService {
  private readonly logger = new Logger('Delivery');

  constructor(
    @InjectRepository(DeliveryRecord)
    private readonly deliveryRepo: Repository<DeliveryRecord>,
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(BuildingGroup) private readonly groupRepo: Repository<BuildingGroup>,
    @InjectRepository(MealAssignment)
    private readonly assignmentRepo: Repository<MealAssignment>,
  ) {}

  /**
   * 为某出餐日按楼群生成配送单（跑批入口 · 由 `tasks/delivery-generate.task.ts` 委托）
   *
   * @param date 出餐日（T 日 · 由 `ScheduleService.targetDate('today')` 得出）
   */
  async generateByDate(date: string): Promise<DeliveryGenerateResult> {
    const expectedAt = arrivalAtOf(date);

    // ---- ① 聚合：楼群 → 份数 ----
    const rows = await this.orderRepo
      .createQueryBuilder('o')
      .select('o.building_group_id', 'buildingGroupId')
      .addSelect('SUM(o.quantity)', 'quantity')
      .where('o.meal_date = :date', { date })
      .andWhere('o.status NOT IN (:...excluded)', {
        excluded: [OrderStatus.PENDING_PAY, OrderStatus.CANCELLED],
      })
      .groupBy('o.building_group_id')
      .getRawMany<{ buildingGroupId: string | number; quantity: string | number }>();

    const soldOf = new Map(
      rows.map((r) => [Number(r.buildingGroupId), Number(r.quantity ?? 0)] as const),
    );

    // 当日有分配但一份未售的楼群也要认出来 —— 它们是 emptyGroups 而非「不存在」
    const assignments = await this.assignmentRepo.find({ where: { mealDate: date } });
    const allGroupIds = [...new Set(assignments.map((a) => Number(a.buildingGroupId)))];

    const created: DeliveryGenerateResult['list'] = [];
    let skipped = 0;
    let emptyGroups = 0;
    let totalQuantity = 0;

    if (allGroupIds.length) {
      const [existed, groups] = await Promise.all([
        this.deliveryRepo.find({ where: { mealDate: date } }),
        this.groupRepo.find({ where: { id: In(allGroupIds) } }),
      ]);
      const existedKeys = new Set(existed.map((d) => d.buildingGroupId));
      const nameOf = new Map(groups.map((g) => [g.id, g.name ?? null]));

      const toCreate: Array<Partial<DeliveryRecord>> = [];
      for (const groupId of allGroupIds) {
        const qty = soldOf.get(groupId) ?? 0;
        if (qty <= 0) {
          emptyGroups += 1;
          continue;
        }
        totalQuantity += qty;
        if (existedKeys.has(groupId)) {
          skipped += 1;
          continue;
        }
        toCreate.push({
          mealDate: date,
          buildingGroupId: groupId,
          expectedAt,
          totalQuantity: qty,
          status: 'pending',
        });
        created.push({
          buildingGroupId: groupId,
          groupName: nameOf.get(groupId) ?? null,
          totalQuantity: qty,
        });
      }

      if (toCreate.length) {
        const saved = await this.deliveryRepo.save(this.deliveryRepo.create(toCreate));
        const idOf = new Map(saved.map((s) => [s.buildingGroupId, s.id]));
        for (const c of created) c.id = idOf.get(c.buildingGroupId);
      }
    }

    // ---- ② 可信度告警：截单是否真的跑过 ----
    const lockedCount = await this.orderRepo.count({
      where: { mealDate: date, status: OrderStatus.CUT_OFF },
    });
    let warning: string | null = null;
    if (created.length && lockedCount === 0) {
      warning =
        `生成配送单时未发现任何「已截单」订单（date=${date}）—— ` +
        '请确认截单任务是否已执行。份数可能偏小，建议核对后重跑 `cutoff`。';
      this.logger.warn(warning);
    }

    if (created.length) {
      this.logger.log(
        `配送单生成 date=${date} 新建 ${created.length} 单 / 合计 ${totalQuantity} 份 ` +
          `预计送达 ${toBjIso(expectedAt)}（幂等跳过 ${skipped} / 无单楼群 ${emptyGroups}）`,
      );
    }

    return {
      date,
      created: created.length,
      skipped,
      emptyGroups,
      totalQuantity,
      groupCount: allGroupIds.length,
      expectedAt: toBjIso(expectedAt),
      list: created,
      warning,
    };
  }
}

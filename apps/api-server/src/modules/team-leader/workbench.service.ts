import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';

import {
  DELIVERY_STATUS_LABEL,
  DeliveryStatus,
  LEADER_LEVEL_META,
  LeaderLevel,
  OrderStatus,
} from '@abox/shared-types';

import { BizConfigService } from '../../common/services/biz-config.service';
import { OrderAvailabilityService } from '../../common/services/order-availability.service';
import { toFen } from '../../common/utils/money';
import { currentTimeline, formatTimeOfDay } from '../../common/utils/order-timeline';
import { addDays, arrivalAtOf, cutoffAtOf, todayBj, toBjIso } from '../../common/utils/time';
import { Building } from '../../database/entities/building.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { DeliveryRecord, Order } from '../../database/entities/order.entity';

/**
 * 团长工作台服务（M2 · 2.3 · 接口 L1）
 *
 * 落点：`modules/team-leader`（《开发里程碑计划 v1.0》2.3）
 *
 * ```
 * ├ today ──── 今日战报（出餐日 = 今天，正在分发的一天）
 * │             orderCount 有效订单数 · quantity 份数 · refundCount 退款中单数
 * │             amountFen 成交额 · commissionFen **按实发份数计佣**
 * ├ tomorrow ─ 明日进度（出餐日 = 明天，今晚 24:00 截单）
 * └ pickup ─── 取餐点与配送状态（本楼群今日配送记录）
 * ```
 *
 * ⚠️ 计佣口径（M2 最高风险项）：**实发份数**（`completed` 份数，已退款单不计），
 *    与 L9 一键分发、`CommissionService.accrueForOrders` 保持同一公式，
 *    避免端上两处数字打架。
 */
@Injectable()
export class LeaderWorkbenchService {
  constructor(
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(DeliveryRecord) private readonly deliveryRepo: Repository<DeliveryRecord>,
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    private readonly bizConfig: BizConfigService,
    /** N1（P3-4）：「明日能不能下单」与用户端 U1 同一判据，避免团长端与用户端对不上 */
    private readonly availability: OrderAvailabilityService,
  ) {}

  async getWorkbench(leader: TeamLeader) {
    const today = todayBj();
    const tomorrow = addDays(today, 1);

    // ⚠️ 截单窗口不再在这里读：它已随「能否下单」一起下沉到 `OrderAvailabilityService`
    //    （本服务若再读一份，就是第二条口径来源）
    const [todayOrders, tomorrowOrders, building, unitPriceYuan] = await Promise.all([
      this.scopeOrders(leader, today),
      this.scopeOrders(leader, tomorrow),
      leader.buildingId
        ? this.buildingRepo.findOne({ where: { id: Number(leader.buildingId) } })
        : Promise.resolve(null),
      this.bizConfig.unitPriceYuan(),
    ]);

    /**
     * ⚠️ 团长端「明日能不能订单」必须与用户端 U1 **同源**：原来是 `isOrderable()` 纯时间判定，
     *    楼宇被停用时团长端仍显示可下单，而用户端点下去就是 60010 —— 两边对不上时团长
     *    只会以为是用户操作问题。`building` 已在上面取到，这里按 buildingId 复用，不重查。
     */
    const availability = building
      ? await this.availability.forBuilding(tomorrow, Number(building.id))
      : null;

    const rate = Number(leader.commissionRate);
    const unitPriceFen = toFen(unitPriceYuan);

    // ---- today ----
    const active = todayOrders.filter((o) => o.status !== OrderStatus.CANCELLED);
    const refundCount = todayOrders.filter((o) =>
      [OrderStatus.REFUND_APPLYING, OrderStatus.REFUNDING, OrderStatus.REFUNDED].includes(
        o.status as OrderStatus,
      ),
    ).length;

    const todayQuantity = active.reduce((s, o) => s + Number(o.quantity || 0), 0);
    const todayAmount = active.reduce((s, o) => s + Number(o.totalAmount), 0);

    // 实发份数 = completed（已确认分发）份数 —— 计佣基数
    const completedQuantity = todayOrders
      .filter((o) => o.status === OrderStatus.COMPLETED)
      .reduce((s, o) => s + Number(o.quantity || 0), 0);
    const commissionFen = Math.round(completedQuantity * unitPriceYuan * rate * 100);

    // ---- tomorrow ----
    const tomorrowActive = tomorrowOrders.filter(
      (o) => ![OrderStatus.CANCELLED, OrderStatus.REFUNDED].includes(o.status as OrderStatus),
    );
    const orderedQuantity = tomorrowActive.reduce((s, o) => s + Number(o.quantity || 0), 0);

    // ---- pickup ----
    const groupId = todayOrders[0]?.buildingGroupId ?? building?.buildingGroupId ?? null;
    const delivery = groupId
      ? await this.deliveryRepo.findOne({
          where: { mealDate: today, buildingGroupId: Number(groupId) },
        })
      : null;

    return {
      today: {
        mealDate: today,
        orderCount: active.length,
        quantity: todayQuantity,
        refundCount,
        amountFen: toFen(todayAmount),
        /** 已确认分发份数（计佣基数） */
        completedQuantity,
        commissionFen,
        level: leader.level,
        levelLabel: levelLabel(leader.level),
        rate,
      },
      tomorrow: {
        mealDate: tomorrow,
        orderedCount: orderedQuantity,
        orderedOrders: tomorrowActive.length,
        /** 截单时刻 T-1 24:00（= 明日 00:00） */
        cutoffAt: toBjIso(cutoffAtOf(tomorrow)),
        /**
         * ⚠️ 字段名**保持 `canOrder` 不变**：团长端问的是「此刻还能不能追加」，
         *    与管家端那个「配置上能否编排」的同名同义字段是两件事 —— 管家端那个
         *    已改名 `canAssign`（无时间维度），本端跟着改名等于改了团长端契约而语义没变。
         */
        canOrder: availability?.canOrder ?? false,
        /** 为什么不能下单（现在只有 `canOrder` 没有原因，团长看不出是楼停了还是过了截单） */
        reasonText: availability?.reasonText ?? null,
        unitPriceFen,
      },
      pickup: {
        point: building
          ? `${building.name}${leader.floor ? ` ${leader.floor}` : ''}`
          : (leader.floor ?? null),
        buildingName: building?.name ?? null,
        floor: leader.floor ?? null,
        status: delivery?.status ?? 'pending',
        statusText: delivery
          ? (DELIVERY_STATUS_LABEL[delivery.status] ?? delivery.status)
          : DELIVERY_STATUS_LABEL[DeliveryStatus.PENDING],
        /**
         * ⭐⭐ 送达时刻 —— **同一个 payload 里曾经有两个真相**（外部测试报告 PR-02 · 2026-09-21 收口）
         *
         * 改前：`expectAt: '11:30'`（手写字面量）与下一行 `expectAtIso: toBjIso(arrivalAtOf(today))`
         * （派生自真源）**并排下发**。运营在后台配置页把「送达时间」改成 `12:00` 后，同一份响应里
         * `expectAt` 还是 `'11:30'`、`expectAtIso` 已是 `12:00:00+08:00` —— **当场自相矛盾**，
         * 且团长端展示哪个由取值方决定（典型的「两个真相」）。
         *
         * 收口：`expectAt` 改为与 `expectAtIso` **同源派生**（`currentTimeline().arrival`），
         * 两者恒等 —— 改一次配置要么一起变、要么都不变。
         * ⚠️ 不要改回字面量：`set_meal.delivery_arrival_time` 在 D58 白名单里是 `wiring:'live'`
         *    （`isEditable() === true`）⇒ **后台一键可改**，不是「一期不可配」。
         */
        expectAt: formatTimeOfDay(currentTimeline().arrival),
        expectAtIso: toBjIso(arrivalAtOf(today)),
        actualAt: delivery?.actualAt ?? null,
        driverName: delivery?.driverName ?? null,
        driverPhone: delivery?.driverPhone ?? null,
        plateNo: delivery?.plateNo ?? null,
      },
    };
  }

  /** 所辖订单（mealDate + 团长范围） */
  private async scopeOrders(leader: TeamLeader, mealDate: string): Promise<Order[]> {
    const qb = this.orderRepo.createQueryBuilder('o').where('o.mealDate = :mealDate', { mealDate });
    qb.andWhere(
      new Brackets((w) => {
        w.where('o.teamLeaderId = :leaderId', { leaderId: Number(leader.id) }).orWhere(
          '(o.teamLeaderId IS NULL AND o.buildingId = :buildingId)',
          { buildingId: Number(leader.buildingId) },
        );
      }),
    );
    return qb.getMany();
  }
}

/** 等级中文名（查表 miss 时回落 key 本身） */
function levelLabel(level: string): string {
  return LEADER_LEVEL_META[level as LeaderLevel]?.label ?? level;
}

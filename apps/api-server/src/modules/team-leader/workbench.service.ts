import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';

import { LEADER_LEVEL_META, LeaderLevel, OrderStatus } from '@abox/shared-types';

import { BizConfigService } from '../../common/services/biz-config.service';
import { toFen } from '../../common/utils/money';
import {
  addDays,
  arrivalAtOf,
  cutoffAtOf,
  isOrderable,
  todayBj,
  toBjIso,
} from '../../common/utils/time';
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
  ) {}

  async getWorkbench(leader: TeamLeader) {
    const today = todayBj();
    const tomorrow = addDays(today, 1);

    const [todayOrders, tomorrowOrders, building, cutoffWindowMinutes, unitPriceYuan] =
      await Promise.all([
        this.scopeOrders(leader, today),
        this.scopeOrders(leader, tomorrow),
        leader.buildingId
          ? this.buildingRepo.findOne({ where: { id: Number(leader.buildingId) } })
          : Promise.resolve(null),
        this.bizConfig.cutoffWindowMinutes(),
        this.bizConfig.unitPriceYuan(),
      ]);

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
        canOrder: isOrderable(tomorrow, cutoffWindowMinutes),
        unitPriceFen,
      },
      pickup: {
        point: building
          ? `${building.name}${leader.floor ? ` ${leader.floor}` : ''}`
          : (leader.floor ?? null),
        buildingName: building?.name ?? null,
        floor: leader.floor ?? null,
        status: delivery?.status ?? 'pending',
        statusText: DELIVERY_STATUS_TEXT[delivery?.status ?? 'pending'] ?? '待叫车',
        expectAt: '11:30',
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

/** 配送状态文案 */
const DELIVERY_STATUS_TEXT: Record<string, string> = {
  pending: '待叫车',
  called: '已叫车',
  en_route: '配送中',
  arrived: '已送达',
};

/** 等级中文名（查表 miss 时回落 key 本身） */
function levelLabel(level: string): string {
  return LEADER_LEVEL_META[level as LeaderLevel]?.label ?? level;
}

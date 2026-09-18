import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { costRegistrationWarning } from '@abox/shared-utils';
import type { SettlementCostItems, SettlementCostRegistration } from '@abox/shared-utils';
import { shiftBizDate, weekStartBizDate } from '@abox/shared-utils';

import { BizConfigService } from '../../common/services/biz-config.service';
import { Building, BuildingGroup } from '../../database/entities/building.entity';
import { Commission, SupplierShare } from '../../database/entities/finance.entity';
import { SetMealItem } from '../../database/entities/meal.entity';
import { Order } from '../../database/entities/order.entity';
import { Dish, Supplier } from '../../database/entities/supplier.entity';

import {
  COMMISSION_VOID_STATUSES,
  DISH_HEAT_DEFAULT_TOP_N,
  DISH_HEAT_MAX_TOP_N,
  PURCHASE_VOID_STATUSES,
  RETENTION_DEFAULT_COHORT_WEEKS,
  STATS_DEFAULT_RANGE,
  STATS_RANGE_DAYS,
  STATS_RANGE_LABELS,
  STATS_REFUND_STATUSES,
  STATS_VALID_STATUSES,
  StatsRange,
} from './stats.constants';
import type { DishHeatQueryDto, StatsQueryDto } from './dto/stats.dto';

/** 统计区间（出参回显 · 保证「同档 = 同区间」，端上不再自己算日期） */
export interface StatsRangeView {
  range: StatsRange;
  label: string;
  /** 出餐日起（含）*/
  startDate: string;
  /** 出餐日止（含）*/
  endDate: string;
  /** 覆盖天数 */
  days: number;
}

/** D47 核心指标 */
export interface StatsDashboardView {
  range: StatsRangeView;
  metrics: {
    /** 计入 GMV 的订单数 */
    orderCount: number;
    /** 计入 GMV 的份数 */
    quantity: number;
    /** GMV（分）= Σ unitPriceFen × quantity */
    gmvFen: number;
    /** 客单价（分）= GMV ÷ 订单数 */
    avgOrderAmountFen: number;
    /** 单份均价（分）= GMV ÷ 份数 —— 与客单价并列下发，避免「客单价」被读成「每份价」 */
    avgUnitPriceFen: number;
    /** 区间内**全部**订单数（含未支付/已取消/已退款，退款率的分母） */
    totalOrderCount: number;
    /** 未支付订单数 */
    pendingPayCount: number;
    /** 退款订单数（一单多次申请只算一次） */
    refundCount: number;
    /** 退款率 = 退款订单数 ÷ 全部订单数（0–1，保留 4 位小数） */
    refundRate: number;
    /** 区间内有有效下单的**用户**数（去重） */
    activeUserCount: number;
    /** 活跃团长数（去重 · `team_leader_id` 非空） */
    activeLeaderCount: number;
    /** 活跃楼栋数（去重） */
    activeBuildingCount: number;
    /** 区间内下单 ≥ 2 次的用户数 */
    repeatUserCount: number;
    /** 复购率 = 复购用户数 ÷ 活跃用户数 */
    repeatRate: number;
    /** 团长佣金支出（分 · 净额，含反向冲销） */
    commissionFen: number;
    /** 半成品采购款（分 · 净额，取 `ab_supplier_share` 实际出单行） */
    purchaseFen: number;
    /** 履约成本（分）= 三项配置单价 × 份数 */
    fulfillmentFen: number;
    /** 经营毛利（分 · 结果值）= GMV − 采购款 − 履约成本 − 佣金 */
    grossProfitFen: number;
    /** 毛利率 = 经营毛利 ÷ GMV（0–1 保留 4 位小数；GMV 为 0 时 null） */
    grossProfitRate: number | null;
  };
  /** 履约成本三项的当前值与登记状态（**与 D57 配置页同源** · 见 shared-utils） */
  costRegistration: SettlementCostRegistration;
  /** 履约成本三项当前值（元/份） */
  costItems: SettlementCostItems;
  /** 采购应付单是否已生成（false = 本期毛利**未扣采购成本**，严重高估） */
  purchaseGenerated: boolean;
  /** 逐日趋势（按出餐日 · 与区间同长度，无单日补 0，便于前端直接画柱） */
  trend: Array<{ date: string; orderCount: number; quantity: number; gmvFen: number }>;
  /** ⚠️ 可直接展示的风险提示（毛利可靠性）—— 无风险时为空数组 */
  warnings: string[];
}

/** D48 楼群 / 楼栋榜单行 */
export interface StatsRankRow {
  id: number;
  name: string;
  orderCount: number;
  quantity: number;
  gmvFen: number;
  /** 占区间 GMV 的比例（0–1，保留 4 位小数） */
  gmvShare: number;
}

/** D48 楼群 / 楼栋榜单 */
export interface StatsBuildingRankView {
  range: StatsRangeView;
  groups: StatsRankRow[];
  buildings: Array<StatsRankRow & { buildingGroupId: number | null; buildingGroupName: string }>;
  totalGmvFen: number;
}

/** D49 菜品热度行 */
export interface StatsDishHeatRow {
  dishId: number;
  dishName: string;
  supplierId: number;
  supplierName: string;
  /** 该菜品被发出的份数（= 含它的订单份数之和） */
  quantity: number;
  /** 含该菜品的订单数 */
  orderCount: number;
  /** 占区间全部菜品份数的比例（0–1 保留 4 位小数） */
  share: number;
}

/** D49 菜品热度 */
export interface StatsDishHeatView {
  range: StatsRangeView;
  topN: number;
  items: StatsDishHeatRow[];
  /** 区间内**全部**菜品份数（分母 —— 按 topN 之和算占比会得出「份额合计 100%」的假象） */
  totalQuantity: number;
  /** 区间内出现过的菜品数 */
  dishCount: number;
}

/** D50 留存分析 */
export interface StatsRetentionView {
  range: StatsRangeView;
  summary: {
    activeUserCount: number;
    /** 首单落在本区间内的用户 */
    newUserCount: number;
    /** 首单早于本区间、本区间内又下单的用户 */
    returningUserCount: number;
    /** 本区间内下单 ≥ 2 次的用户 */
    repeatUserCount: number;
    /** 复购率 = 复购用户数 ÷ 活跃用户数 */
    repeatRate: number;
  };
  /** 按「首单所在自然周（周一为始）」分群，观察其后 1 周是否再次下单 */
  cohorts: Array<{
    cohortStart: string;
    cohortEnd: string;
    newUserCount: number;
    /**
     * 该群中在次周内再次下单的人数。
     * ⚠️ 与 `retentionRate1` **成对下发**：观察窗口未走完、或该群 0 人（分母为 0）时均为 null。
     *    读到 null 的正确解读是「这个数给不出来」，**不是**「留存为 0」。
     */
    retainedWeek1: number | null;
    /** 次周留存率 = `retainedWeek1` ÷ `newUserCount`；与 `retainedWeek1` 同生同灭 */
    retentionRate1: number | null;
    /** 观察窗口是否已完整走完（false = 数据还在长，此时留存率无意义）；**不含**「群为空」之意 */
    observable: boolean;
  }>;
  /** 新客判定所需的回看范围说明（前端展示，避免「新客」被误解为「本月新增」） */
  note: string;
}

/** 服务端金额归一：任何来源的金额 → 整数分（跨 mysql / sqlite 一致） */
function fen(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** 比例归一（0–1 · 保留 4 位小数） */
function ratio(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(4));
}

/**
 * D47–D50 数据看板服务（《接口规范》§6.6 · 原型 P35）
 *
 * ⭐ **实现选型说明（为什么取行回来在内存里聚合，而不是下推 SQL）**
 *
 *   1. **金额精度**：`SUM(decimal)` 在 MySQL 返回字符串、在 SQLite 返回浮点，
 *      两驱动归一方式不同；而本项目四驱动零改动切换是硬约束。取行后走
 *      `fen()` 统一归一到整数分，跨驱动结果**逐分一致**。
 *   2. **口径唯一**：「有效订单」的判定必须和 D47/D48/D49 三处完全同源 ——
 *      一旦有一处把状态集合写进 SQL、另一处写在 JS，就会漂移。
 *   3. 代价是 O(行数)。MVP 单量（日 200 单 × 30 日）下完全可接受，
 *      单量破万后再把 `isValid` 条件下推 SQL（**届时只改本文件**）。
 */
@Injectable()
export class StatsService {
  private readonly logger = new Logger('Stats');

  constructor(
    private readonly dataSource: DataSource,
    private readonly bizConfig: BizConfigService,
  ) {}

  /* ------------------------------------------------------------------ *
   * 区间解析
   * ------------------------------------------------------------------ */

  /**
   * 区间解析：`range` 定**长度**，`date`（可选）定**终点**。
   *
   * ⚠️ 端点缺省 = 今日 —— 看板看的是「正在长的今天」，这是运营最常看的一档；
   *    财务期末复核对账时才传 `date` 把终点锚到已过完的那一天。
   */
  private resolveRange(range?: string, date?: string): StatsRangeView {
    const key = (range ?? STATS_DEFAULT_RANGE) as StatsRange;
    const days = STATS_RANGE_DAYS[key] ?? STATS_RANGE_DAYS[STATS_DEFAULT_RANGE];
    const endDate = date?.trim() || shiftBizDate(new Date(), 0);
    return {
      range: key,
      label: STATS_RANGE_LABELS[key],
      startDate: shiftBizDate(endDate, -(days - 1)),
      endDate,
      days,
    };
  }

  /* ------------------------------------------------------------------ *
   * 有效订单（四个端点共用同一份判定 —— 不许多处实现）
   * ------------------------------------------------------------------ */

  private validOrderQb() {
    return this.dataSource
      .getRepository(Order)
      .createQueryBuilder('o')
      .where('o.status IN (:...statuses)', { statuses: STATS_VALID_STATUSES });
  }

  /** 区间内**全部**订单（含未支付/取消/退款 · 退款率分母用） */
  private loadAllOrdersInRange(range: StatsRangeView): Promise<Order[]> {
    return this.dataSource
      .getRepository(Order)
      .createQueryBuilder('o')
      .select([
        'o.id',
        'o.userId',
        'o.teamLeaderId',
        'o.buildingId',
        'o.buildingGroupId',
        'o.setMealId',
        'o.mealDate',
        'o.quantity',
        'o.unitPrice',
        'o.status',
      ])
      .where('o.mealDate BETWEEN :start AND :end', { start: range.startDate, end: range.endDate })
      .getMany();
  }

  /** 区间内**有效**订单（计入 GMV 的那批） */
  private async loadValidOrdersInRange(range: StatsRangeView): Promise<Order[]> {
    return this.validOrderQb()
      .select([
        'o.id',
        'o.userId',
        'o.teamLeaderId',
        'o.buildingId',
        'o.buildingGroupId',
        'o.setMealId',
        'o.mealDate',
        'o.quantity',
        'o.unitPrice',
      ])
      .andWhere('o.mealDate BETWEEN :start AND :end', {
        start: range.startDate,
        end: range.endDate,
      })
      .getMany();
  }

  /** 单条订单贡献的 GMV（分）= `unitPriceFen × quantity`（§6.6 原文口径） */
  private orderGmvFen(o: Order): number {
    return fen(o.unitPrice) * Number(o.quantity ?? 0);
  }

  /* ------------------------------------------------------------------ *
   * D47 · 核心指标看板
   * ------------------------------------------------------------------ */

  async dashboard(q: StatsQueryDto): Promise<StatsDashboardView> {
    const range = this.resolveRange(q.range, q.date);

    const [allOrders, validOrders] = await Promise.all([
      this.loadAllOrdersInRange(range),
      this.loadValidOrdersInRange(range),
    ]);

    const gmvFen = validOrders.reduce((s, o) => s + this.orderGmvFen(o), 0);
    const quantity = validOrders.reduce((s, o) => s + Number(o.quantity ?? 0), 0);
    const orderCount = validOrders.length;

    // 退款率分子：退款三态的**订单数**（不是 ab_refund 条数 —— 一单多次申请只算一次事故；
    // 而 `rejected` 驳回的申请订单已回退原态，自然不在三态内）
    const refundCount = allOrders.filter((o) => STATS_REFUND_STATUSES.includes(o.status)).length;

    // 用户维度
    const userOrderCount = new Map<number, number>();
    const leaderIds = new Set<number>();
    const buildingIds = new Set<number>();
    for (const o of validOrders) {
      const uid = Number(o.userId);
      userOrderCount.set(uid, (userOrderCount.get(uid) ?? 0) + 1);
      if (o.teamLeaderId) leaderIds.add(Number(o.teamLeaderId));
      buildingIds.add(Number(o.buildingId));
    }
    const activeUserCount = userOrderCount.size;
    const repeatUserCount = [...userOrderCount.values()].filter((c) => c >= 2).length;

    // 逐日趋势（区间内每一天都给出，无单日补 0 —— 前端不必自己补齐空洞）
    const byDate = new Map<string, { orderCount: number; quantity: number; gmvFen: number }>();
    for (const o of validOrders) {
      const key = String(o.mealDate);
      const cur = byDate.get(key) ?? { orderCount: 0, quantity: 0, gmvFen: 0 };
      cur.orderCount += 1;
      cur.quantity += Number(o.quantity ?? 0);
      cur.gmvFen += this.orderGmvFen(o);
      byDate.set(key, cur);
    }
    const trend: StatsDashboardView['trend'] = [];
    for (let i = 0; i < range.days; i += 1) {
      const date = shiftBizDate(range.startDate, i);
      trend.push({ date, ...(byDate.get(date) ?? { orderCount: 0, quantity: 0, gmvFen: 0 }) });
    }

    // 成本侧：佣金净额 / 采购净额 / 履约配置单价
    const [commissionFen, purchaseFen, costState] = await Promise.all([
      this.loadCommissionFen(range),
      this.loadPurchaseFen(range),
      this.bizConfig.settlementCostState(),
    ]);

    const perUnitFulfillmentFen =
      fen(costState.items.siteFee) +
      fen(costState.items.packingLaborFee) +
      fen(costState.items.deliveryFee);
    const fulfillmentFen = perUnitFulfillmentFen * quantity;

    const grossProfitFen = gmvFen - purchaseFen - fulfillmentFen - commissionFen;
    const purchaseGenerated = purchaseFen !== 0;

    return {
      range,
      metrics: {
        orderCount,
        quantity,
        gmvFen,
        avgOrderAmountFen: orderCount ? Math.round(gmvFen / orderCount) : 0,
        avgUnitPriceFen: quantity ? Math.round(gmvFen / quantity) : 0,
        totalOrderCount: allOrders.length,
        pendingPayCount: allOrders.filter((o) => o.status === 'pending_pay').length,
        refundCount,
        refundRate: ratio(refundCount, allOrders.length) ?? 0,
        activeUserCount,
        activeLeaderCount: leaderIds.size,
        activeBuildingCount: buildingIds.size,
        repeatUserCount,
        repeatRate: ratio(repeatUserCount, activeUserCount) ?? 0,
        commissionFen,
        purchaseFen,
        fulfillmentFen,
        grossProfitFen,
        grossProfitRate: ratio(grossProfitFen, gmvFen),
      },
      costRegistration: costState.registration,
      costItems: costState.items,
      purchaseGenerated,
      trend,
      warnings: this.buildProfitWarnings(
        costState.registration,
        quantity,
        gmvFen,
        purchaseGenerated,
      ),
    };
  }

  /**
   * ⚠️ 毛利可靠性提示（**这是 D47 最重要的出参之一**）
   *
   * 经营毛利是「收入 − 采购 − 履约 − 佣金」的结果值，因此**任何一个减项缺失都会让它虚高**：
   *  1. 履约成本三项未登记（`0.00`）→ 少扣场地/打包/配送
   *  2. 采购应付单尚未生成（T+1 02:00 跑批）→ 少扣采购款
   * 两处都会让运营拿一个「看起来很赚」的数去做决策。此处的职责就是把这两件事说出来，
   * 并**复用 shared-utils 的统一文案**（与 D57 配置页同一句话，避免两处口径打架）。
   */
  private buildProfitWarnings(
    registration: SettlementCostRegistration,
    quantity: number,
    gmvFen: number,
    purchaseGenerated: boolean,
  ): string[] {
    const warnings: string[] = [];
    if (gmvFen > 0 && !registration.allRegistered) {
      warnings.push(costRegistrationWarning(registration.missingLabels));
    }
    if (quantity > 0 && !purchaseGenerated) {
      warnings.push(
        '本期尚未生成采购应付单（应付单由 T+1 02:00 跑批生成，也可在「应付结算」页手动补跑），' +
          '因此经营毛利**未扣除采购款**，严重高估 —— 请以出单后的数据为准。',
      );
    }
    return warnings;
  }

  /** 佣金净额（分）：含反向冲销 —— 冲销负行有效，被冲销的 `normal` 行已翻 `cancelled` */
  private async loadCommissionFen(range: StatsRangeView): Promise<number> {
    const rows = await this.dataSource
      .getRepository(Commission)
      .createQueryBuilder('c')
      .select(['c.amount', 'c.status'])
      .where('c.mealDate BETWEEN :start AND :end', { start: range.startDate, end: range.endDate })
      .getMany();
    return rows
      .filter((r) => !COMMISSION_VOID_STATUSES.includes(r.status))
      .reduce((s, r) => s + fen(r.amount), 0);
  }

  /** 采购应付净额（分）：只算供应商主体，`reversed`/`cancelled` 行视为无效 */
  private async loadPurchaseFen(range: StatsRangeView): Promise<number> {
    const rows = await this.dataSource
      .getRepository(SupplierShare)
      .createQueryBuilder('s')
      .select(['s.amount', 's.status', 's.payeeType'])
      .where('s.mealDate BETWEEN :start AND :end', { start: range.startDate, end: range.endDate })
      .andWhere("s.payeeType = 'supplier'")
      .getMany();
    return rows
      .filter((r) => !PURCHASE_VOID_STATUSES.includes(r.status))
      .reduce((s, r) => s + fen(r.amount), 0);
  }

  /* ------------------------------------------------------------------ *
   * D48 · 楼群 / 楼栋榜单
   * ------------------------------------------------------------------ */

  async buildingRank(q: StatsQueryDto): Promise<StatsBuildingRankView> {
    const range = this.resolveRange(q.range, q.date);
    const validOrders = await this.loadValidOrdersInRange(range);

    const [groups, buildings] = await Promise.all([
      this.dataSource.getRepository(BuildingGroup).find(),
      this.dataSource.getRepository(Building).find(),
    ]);
    const groupName = new Map(groups.map((g) => [Number(g.id), g.name]));
    const buildingName = new Map(buildings.map((b) => [Number(b.id), b.name]));
    const buildingGroupOf = new Map(
      buildings.map((b) => [Number(b.id), b.buildingGroupId ?? null]),
    );

    const totalGmvFen = validOrders.reduce((s, o) => s + this.orderGmvFen(o), 0);

    const acc = new Map<number, { orderCount: number; quantity: number; gmvFen: number }>();
    const accBuilding = new Map<number, { orderCount: number; quantity: number; gmvFen: number }>();
    for (const o of validOrders) {
      const gk = Number(o.buildingGroupId);
      const bk = Number(o.buildingId);
      const g = acc.get(gk) ?? { orderCount: 0, quantity: 0, gmvFen: 0 };
      g.orderCount += 1;
      g.quantity += Number(o.quantity ?? 0);
      g.gmvFen += this.orderGmvFen(o);
      acc.set(gk, g);

      const b = accBuilding.get(bk) ?? { orderCount: 0, quantity: 0, gmvFen: 0 };
      b.orderCount += 1;
      b.quantity += Number(o.quantity ?? 0);
      b.gmvFen += this.orderGmvFen(o);
      accBuilding.set(bk, b);
    }

    const toRows = (
      m: Map<number, { orderCount: number; quantity: number; gmvFen: number }>,
      namer: (id: number) => string,
    ): StatsRankRow[] =>
      [...m.entries()]
        .map(([id, v]) => ({
          id,
          name: namer(id),
          orderCount: v.orderCount,
          quantity: v.quantity,
          gmvFen: v.gmvFen,
          gmvShare: ratio(v.gmvFen, totalGmvFen) ?? 0,
        }))
        .sort((a, b) => b.gmvFen - a.gmvFen || a.id - b.id);

    return {
      range,
      // 楼群/楼栋可能已被软删（历史订单仍指向它）—— 找不到名字时回退 `#id`，
      // 而不是丢掉这一行（丢掉会让「分项之和 ≠ 总额」，运营会以为统计漏了）
      groups: toRows(acc, (id) => groupName.get(id) ?? `楼群#${id}`),
      buildings: toRows(accBuilding, (id) => buildingName.get(id) ?? `楼栋#${id}`).map((r) => {
        const gid = buildingGroupOf.get(r.id) ?? null;
        return {
          ...r,
          buildingGroupId: gid,
          buildingGroupName: gid != null ? (groupName.get(gid) ?? `楼群#${gid}`) : '未分组',
        };
      }),
      totalGmvFen,
    };
  }

  /* ------------------------------------------------------------------ *
   * D49 · 菜品热度
   * ------------------------------------------------------------------ */

  async dishHeat(q: DishHeatQueryDto): Promise<StatsDishHeatView> {
    const range = this.resolveRange(q.range, q.date);
    const topN = Math.min(q.topN ?? DISH_HEAT_DEFAULT_TOP_N, DISH_HEAT_MAX_TOP_N);
    const validOrders = await this.loadValidOrdersInRange(range);

    const setMealIds = [...new Set(validOrders.map((o) => Number(o.setMealId)))];

    // 套餐 → 菜品 展开（`ab_set_meal_item`）
    const items = setMealIds.length
      ? await this.dataSource
          .getRepository(SetMealItem)
          .createQueryBuilder('i')
          .select(['i.setMealId', 'i.dishId', 'i.supplierId'])
          .where('i.setMealId IN (:...ids)', { ids: setMealIds })
          .getMany()
      : [];
    const dishesOf = new Map<number, Array<{ dishId: number; supplierId: number }>>();
    for (const it of items) {
      const k = Number(it.setMealId);
      const arr = dishesOf.get(k) ?? [];
      arr.push({ dishId: Number(it.dishId), supplierId: Number(it.supplierId) });
      dishesOf.set(k, arr);
    }

    // 一份套餐里的每个菜品都跟着「订单份数」计一次 —— 即「这一份饭里这个菜被送出了几次」
    const acc = new Map<number, { quantity: number; orderCount: number; supplierId: number }>();
    for (const o of validOrders) {
      const qty = Number(o.quantity ?? 0);
      const seen = new Set<number>();
      for (const d of dishesOf.get(Number(o.setMealId)) ?? []) {
        const cur = acc.get(d.dishId) ?? { quantity: 0, orderCount: 0, supplierId: d.supplierId };
        cur.quantity += qty;
        if (!seen.has(d.dishId)) {
          cur.orderCount += 1;
          seen.add(d.dishId);
        }
        acc.set(d.dishId, cur);
      }
    }

    const totalQuantity = [...acc.values()].reduce((s, v) => s + v.quantity, 0);
    const dishIds = [...acc.keys()];
    const dishRows = dishIds.length
      ? await this.dataSource
          .getRepository(Dish)
          .createQueryBuilder('d')
          .select(['d.id', 'd.name', 'd.supplierId'])
          .where('d.id IN (:...ids)', { ids: dishIds })
          .getMany()
      : [];
    const dishName = new Map(dishRows.map((d) => [Number(d.id), d.name]));
    const supplierIds = [...new Set(dishRows.map((d) => Number(d.supplierId)))];
    const supplierRows = supplierIds.length
      ? await this.dataSource
          .getRepository(Supplier)
          .createQueryBuilder('s')
          .select(['s.id', 's.name'])
          .where('s.id IN (:...ids)', { ids: supplierIds })
          .getMany()
      : [];
    const supplierName = new Map(supplierRows.map((s) => [Number(s.id), s.name]));

    const list: StatsDishHeatRow[] = [...acc.entries()]
      .map(([dishId, v]) => ({
        dishId,
        dishName: dishName.get(dishId) ?? `菜品#${dishId}`,
        supplierId: v.supplierId,
        supplierName: supplierName.get(v.supplierId) ?? `供应商#${v.supplierId}`,
        quantity: v.quantity,
        orderCount: v.orderCount,
        // ⚠️ 分母是**全部**菜品份数，不是 topN 之和
        share: ratio(v.quantity, totalQuantity) ?? 0,
      }))
      .sort((a, b) => b.quantity - a.quantity || a.dishId - b.dishId);

    return {
      range,
      topN,
      items: list.slice(0, topN),
      totalQuantity,
      dishCount: list.length,
    };
  }

  /* ------------------------------------------------------------------ *
   * D50 · 留存分析
   * ------------------------------------------------------------------ */

  /**
   * D50 · 留存分析
   *
   * ## 取数策略（本批修正 —— 原实现是全表扫描，见《全面检查与测试报告 v1.0》§二 P0-1）
   *
   * 「留存必须看全历史」这件事**不等于**「必须把全部订单行读进内存」。全历史只在
   * 两个地方被用到，而这两处**都能让 SQL 直接回答**：
   *
   *   ① **首单出餐日**（判新客 / 老客，以及按「首单所在周」分群）
   *      → `GROUP BY user_id` 求 `MIN(meal_date)`：**一用户一行**。
   *   ② **cohort 观察窗内是否再次下单**
   *      → 只需要 `[第 1 个分群 + 7 天, 最后一个分群的 windowEnd]` 这一段，**天然有界**
   *        （最长 ≈ N 周 + 13 天）。
   *
   * 而「区间内活跃」本来就有界（`[startDate, endDate]`），聚合成「一人一行」即可。
   *
   * ⚠️ 修正前的写法是 `select(['o.userId', 'o.mealDate']).getMany()` —— 把**每一张有效订单**
   *    都实例化成一个对象读进 Node 内存，再在 JS 里建 Map、三次遍历去重。种子数据下
   *    完全无感（几十单），但单请求的**内存与耗时都随订单总量线性增长**：首屏看板在
   *    10 万单量级即明显劣化。**「看全历史」是业务口径，不是取数方式。**
   *
   * ⚠️ 三处口径与修正前**逐字保持一致**（本批只换取数方式，不改任何口径）：
   *    · 有效订单仍走 `validOrderQb()` 单点判定；
   *    · `repeatUserCount` 数的是「区间内**不同出餐日**出现次数 ≥ 2」，不是订单数；
   *    · `retainedWeek1` / `retentionRate1` 仍**成对下发**（窗口未走完 or 分群为空 → 双 null）。
   */
  async retention(q: StatsQueryDto): Promise<StatsRetentionView> {
    const range = this.resolveRange(q.range, q.date);

    // cohort 的分群边界先算出来：下面的查询要拿它当**上界**，才能把「全历史」收敛成有界区间
    const today = shiftBizDate(range.endDate, 0);
    const lastWeekStart = weekStartBizDate(today);
    const cohortStarts: string[] = [];
    for (let i = RETENTION_DEFAULT_COHORT_WEEKS - 1; i >= 0; i -= 1) {
      cohortStarts.push(shiftBizDate(lastWeekStart, -7 * i));
    }
    /** 观察窗下界 = 最早那个分群的「次周第一天」（再早的日期对任何分群都无用） */
    const observeFrom = shiftBizDate(cohortStarts[0], 7);
    /** 观察窗上界 = 最后一个分群的 windowEnd */
    const observeTo = shiftBizDate(cohortStarts[cohortStarts.length - 1], 13);

    // ── ① 区间内活跃（**聚合到人**：一人一行，不出订单明细）────────────────
    const activityRows = await this.validOrderQb()
      .select('o.user_id', 'userId')
      .addSelect('COUNT(DISTINCT o.meal_date)', 'dayCnt')
      .andWhere('o.meal_date BETWEEN :start AND :end', {
        start: range.startDate,
        end: range.endDate,
      })
      .groupBy('o.user_id')
      .getRawMany<{ userId: number | string; dayCnt: number | string }>();

    const activeInRange = new Set<number>();
    const countInRange = new Map<number, number>();
    for (const r of activityRows) {
      const uid = Number(r.userId);
      activeInRange.add(uid);
      countInRange.set(uid, Number(r.dayCnt ?? 0));
    }

    // ── ② 首单出餐日（**聚合到人** · 一用户一行）──────────────────────────
    // ⚠️ 这一条**不能**按日期收窄：`MIN(meal_date)` 必须是**全表**范围内的最小值。
    //    若在这里加 `WHERE meal_date >= X`，那些「更早还有单」的用户会被算成
    //    「首单在 X 之后」= **假新客**（且新客数虚高、老客数虚低，两边都错）。
    //    代价是全表聚合，但**返回的是一用户一行**（订单数 ≫ 用户数），配合
    //    `idx_order_user (user_id, meal_date)` 可走松散索引扫描（loose index scan，
    //    MySQL 8 的 `GROUP BY user_id` + `MIN(meal_date)` 正命中该形状）。
    const firstRows = await this.validOrderQb()
      .select('o.user_id', 'userId')
      .addSelect('MIN(o.meal_date)', 'firstDate')
      .groupBy('o.user_id')
      .getRawMany<{ userId: number | string; firstDate: string }>();

    const firstDateByUser = new Map<number, string>();
    for (const r of firstRows) firstDateByUser.set(Number(r.userId), String(r.firstDate));

    /** 首单出餐日（有效订单口径 · 超时未支付的单不能把用户判成老客） */
    const firstDateOf = (uid: number): string => firstDateByUser.get(uid) ?? '';

    // ── ③ 分群复查用的日期明细（**有界**：只取各分群观察窗那一段）──────────
    const revisitRows = await this.validOrderQb()
      .select('o.user_id', 'userId')
      .addSelect('o.meal_date', 'mealDate')
      .andWhere('o.meal_date BETWEEN :from AND :to', { from: observeFrom, to: observeTo })
      .groupBy('o.user_id')
      .addGroupBy('o.meal_date')
      .getRawMany<{ userId: number | string; mealDate: string }>();

    const revisitDates = new Map<number, Set<string>>();
    for (const r of revisitRows) {
      const uid = Number(r.userId);
      const set = revisitDates.get(uid) ?? new Set<string>();
      set.add(String(r.mealDate));
      revisitDates.set(uid, set);
    }

    let newUserCount = 0;
    let returningUserCount = 0;
    for (const uid of activeInRange) {
      if (firstDateOf(uid) >= range.startDate) newUserCount += 1;
      else returningUserCount += 1;
    }
    const repeatUserCount = [...countInRange.values()].filter((c) => c >= 2).length;

    // cohort：按「首单所在自然周（周一为始）」分群，观察其后 7 天内是否再次下单。
    // 取最近 N 周 —— 以区间末日所在周为最后一群。
    const byFirstWeek = new Map<string, number[]>();
    for (const [uid, first] of firstDateByUser) {
      if (!first) continue;
      const wk = weekStartBizDate(first);
      const arr = byFirstWeek.get(wk) ?? [];
      arr.push(uid);
      byFirstWeek.set(wk, arr);
    }

    const cohorts = cohortStarts.map((cohortStart) => {
      const cohortEnd = shiftBizDate(cohortStart, 6);
      const users = byFirstWeek.get(cohortStart) ?? [];
      const windowEnd = shiftBizDate(cohortStart, 13);
      // `observable` = 「观察窗口（次周 = cohortStart+7 … +13）是否已走完」，只表达这一件事。
      const observable = windowEnd <= today;
      // `retainedWeek1` 与 `retentionRate1` **成对下发**，两个条件同时成立才有值，否则都是 null：
      //   (1) 观察窗口已走完 —— 未走完时算出来的低留存只是「数据还没长出来」，下发会让运营误判新客质量；
      //   (2) 分群非空 —— 0 人分群的分母是 0，`0/0` 没有意义；硬给 0 会被读成「0% 留存 = 新客质量极差」。
      // ⚠️ 不要用 `observable` 单独给 0 人分群兜底成「观察中」—— 那会把「没人来」错说成「数据还没长出来」。
      const rateAvailable = observable && users.length > 0;
      const retainedWeek1 = rateAvailable
        ? users.filter((uid) =>
            [...(revisitDates.get(uid) ?? [])].some(
              (d) => d >= shiftBizDate(cohortStart, 7) && d <= windowEnd,
            ),
          ).length
        : null;
      return {
        cohortStart,
        cohortEnd,
        newUserCount: users.length,
        retainedWeek1,
        retentionRate1: rateAvailable ? ratio(retainedWeek1 ?? 0, users.length) : null,
        observable,
      };
    });

    return {
      range,
      summary: {
        activeUserCount: activeInRange.size,
        newUserCount,
        returningUserCount,
        repeatUserCount,
        repeatRate: ratio(repeatUserCount, activeInRange.size) ?? 0,
      },
      cohorts,
      note:
        '「新客」= 首单出餐日落在本区间内的用户（首单按**有效订单**判定，' +
        '未支付/已取消/已退款不算首单）；留存按「首单所在自然周」分群，' +
        '观察窗口未走完的群、以及当周无新客的群，留存率与留存人数均为 null（页面显示「—」，**不等于 0**）。',
    };
  }
}

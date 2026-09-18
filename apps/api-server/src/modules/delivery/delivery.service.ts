import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { QueryDeepPartialEntity } from 'typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';

import {
  DELIVERY_STATUS_LABEL,
  DELIVERY_STATUS_ORDER,
  DeliveryStatus,
  ORDER_STATUS_VIEW,
  OrderStatus,
} from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { arrivalAtOf, toBjIso } from '../../common/utils/time';
import { BuildingGroup } from '../../database/entities/building.entity';
import { MealAssignment } from '../../database/entities/meal.entity';
import { DeliveryRecord, Order } from '../../database/entities/order.entity';
import { OperationLog } from '../../database/entities/system.entity';
import {
  DeliveryListQueryDto,
  DeliveryPatchDto,
  DeliveryStatusAdvanceDto,
} from './dto/delivery.dto';

/**
 * 一次配送单推进**联动的订单迁移**（「声明」的载体）
 *
 * ⭐ 它由两个具名方法 `advanceGroupOrdersToDelivering` / `...Delivered` **各自返回**，
 *    不另立一张映射表 —— 本项目反复踩过的就是「同一件事有两份表述」
 *    （#15 / #63 / #67 / #76）。写入语句与它自述的 `from → to` 挨在同一段代码里，
 *    谁改了一边忘了另一边，读代码的人当场就能看出来。
 */
interface OrderTransitionHit {
  advanced: number;
  from: OrderStatus;
  to: OrderStatus;
}

/** 订单状态分布（D61 行内 / D63 出参共用同一形状） */
type OrderStatusBreakdown = Array<{
  status: string;
  statusText: string;
  orderCount: number;
  quantity: number;
}>;

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

/** 配送单的可人工修正字段快照（D62 的 `before` / `after`） */
export interface DeliverySnapshot {
  totalQuantity: number;
  driverName: string | null;
  driverPhone: string | null;
  plateNo: string | null;
  remark: string | null;
}

/** 配送单一行（D61 出参） */
export interface DeliveryRow extends DeliverySnapshot {
  id: number;
  mealDate: string;
  buildingGroupId: number;
  buildingGroupName: string | null;
  expectedAt: string | null;
  actualAt: string | null;
  /** 按**订单**实时算出的份数（口径同备料量） */
  orderQuantity: number;
  /** `totalQuantity - orderQuantity`（正 = 配送单比订单多） */
  quantityDiff: number;
  /**
   * 份数与订单**不符**
   *
   * ⚠️ 成因有两种，**不等于「被人改过」** —— 见 `note`：
   *    ① 有人走 D62 做过人工修正；② 截单后订单侧发生了退款 / 取消
   *    （配送单份数在截单时已定格，不会跟着降）。
   *    系统无法从数字本身区分这两者，故**不假装知道**，只如实标「不符」并给出排查入口。
   */
  quantityMismatch: boolean;
  /**
   * 有人工录入痕迹（司机 / 电话 / 车牌 / 备注有值）
   *
   * ⭐ 与 `quantityMismatch` 不同，**本标记是可靠的**：跑批从不写这四列
   *    （`generateByDate` 只写 `meal_date` / `building_group_id` / `expected_at` /
   *    `total_quantity` / `status`），所以它们有值 ⇔ 有人手工填过。
   */
  hasManualInput: boolean;
  status: string;
  /** 状态中文（服务端下发 · 端上不维护第二份映射） */
  statusText: string;
  /** 乐观锁版本（D62 提交时原样回传） */
  version: number;
  /**
   * ⭐ 该楼群当日订单的**状态分布**（M5-8 新增 · 履约链可见性）
   *
   * ## 为什么配送单页必须带上它
   * 配送单状态与订单状态是**两条链**（T8/T9 才把它们接上）。只看配送单的
   * 「在途」，运营无法知道这批货对应的订单有没有跟上 —— 而「没跟上」的表现是
   * **订单永远停在 `cut_off`、佣金永不产生、且不报任何错**（#79）。
   * 把它摆在每一行上，「有几单没跟上」就从「一个看不见的洞」变成「列表里的一行」。
   *
   * 只列**实际出现过**的状态（没单的状态不占位），按主流程进度排序；
   * 份数与 `orderQuantity` 同源聚合，两项相加必然等于它。
   */
  orderStatusBreakdown: OrderStatusBreakdown;
}

/** D61 出参 */
export interface DeliveryListResult {
  /** 实际生效的出餐日（`date` 缺省时由服务端推导，端上回填选择器） */
  date: string | null;
  list: DeliveryRow[];
  summary: {
    count: number;
    totalQuantity: number;
    totalOrderQuantity: number;
    /** 份数与订单不符的张数 */
    mismatchCount: number;
    /** 已录司机 / 车牌等人工信息的张数 */
    manualInputCount: number;
    byStatus: Array<{ status: string; statusText: string; count: number }>;
  };
  /** 空态说明（无任何配送单时给 —— 「还没有单」是正常状态，不是错误） */
  reason?: string;
  /** 口径说明（随出参下发 · 端上不复制第二份文案） */
  note: string;
  /** 状态筛选下拉的权威顺序（端上不自己排） */
  statusOptions: Array<{ value: string; label: string }>;
}

/** D62 出参（`before` / `after` 随响应体被操作日志整体落库 → 审计可回放） */
export interface DeliveryPatchResult {
  id: number;
  before: DeliverySnapshot;
  after: DeliverySnapshot;
  /** 实际发生变化的字段名 */
  changed: string[];
  /** 提交了但与现值相同的字段名（**不写库**、不产生假变更记录） */
  unchanged: string[];
  /** 修正后的新版本号（端上用它刷新本地快照） */
  version: number;
  /** 修正后与订单份数的差异（正 = 比订单多 / 负 = 比订单少 / 0 = 相符） */
  quantityDiff: number;
  /** 按订单算出的份数（供端上直接展示对比） */
  orderQuantity: number;
}

/**
 * D63 出参（M5-8 · 状态机 T8 / T9）
 *
 * 把「配送单推进了」与「订单跟着动了没有」**放在同一个响应里** ——
 * 分成两个接口或让运营自己去订单页看，就会出现「推了但没联动」的静默状态：
 * 物理上的车已经开走，而系统里的订单还原地不动，且**两边都不报错**。
 */
export interface DeliveryAdvanceResult {
  id: number;
  mealDate: string;
  buildingGroupId: number;
  buildingGroupName: string | null;
  from: string;
  fromText: string;
  to: string;
  toText: string;
  /** 推进后的新版本号（端上用它刷新本地快照） */
  version: number;
  /** 实际送达时刻（推进到 `arrived` 时写入；其余情况保持原值） */
  actualAt: string | null;
  /**
   * 本次**联动的订单状态迁移**
   *
   * `called` 时为 `null`（车还没发，订单不该动 —— 这不是「没联动」，是**本就不联动**）。
   * 响应里必须把这个区别表达出来，否则端上无法区分「没联动」与「联动失败」。
   */
  orderTransition: {
    from: string;
    fromText: string;
    to: string;
    toText: string;
    /** 本次真的被推进的订单数（条件更新 `affected` 判归属） */
    advanced: number;
    /** 推进后该楼群当日订单的状态分布（份）—— 「还有几单没跟上」一眼可见 */
    remaining: Array<{ status: string; statusText: string; orderCount: number; quantity: number }>;
    /** `advanced = 0` 而订单还在原地时，给人看的原因（fail-closed 但不静默） */
    note?: string;
  } | null;
  /** 口径说明（随出参下发 · 端上不复制第二份文案） */
  note: string;
}

/**
 * D61 口径说明（随出参下发）
 *
 * ⚠️ 这段话是**产品口径**的一部分，不是注释 —— 端上原样展示，不复制第二份。
 *    刻意点明「本页不区分两种成因」，因为在数字上它们长得一模一样，
 *    假装能区分比说不知道更危险（同 #55「让系统如实说我没做那一步」）。
 */
export const DELIVERY_LIST_NOTE =
  '配送单份数在 T 日 00:30 生成时**定格**（跑批对已存在的单不覆盖，以免抹掉人工录入的司机 / 车牌）。' +
  '若某行份数与订单不符，有两种成因：① 有人在本页做过人工修正 —— 谁改的、改成多少，' +
  '去「系统管理 · 操作日志」按模块 `delivery` 查该单 id；' +
  '② 截单之后订单侧发生了退款 / 取消，而配送单份数不会跟着降。本页不区分这两者。';

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
    private readonly dataSource: DataSource,
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

    // ---- ① 聚合：楼群 → 份数（与 D61 列表**共用同一份口径**，见 aggregateOrderQuantity） ----
    const soldOf = await this.aggregateOrderQuantity(date);

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

  /**
   * 按楼群聚合「订单份数」（备料量口径）
   *
   * ⭐ **口径唯一真相**：跑批生成配送单（4.3）与 D61 列表的「订单份数」对比
   *    都走本方法。若两处各写一遍 SQL，将来改口径只改了一处，就会出现
   *    「生成的份数」与「页面上显示的应送份数」不一致，而**两边都不报错**。
   *
   * 计入：`status NOT IN ('pending_pay', 'cancelled')` —— 与「推备料量」同源。
   */
  private async aggregateOrderQuantity(date: string): Promise<Map<number, number>> {
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

    return new Map(rows.map((r) => [Number(r.buildingGroupId), Number(r.quantity ?? 0)] as const));
  }

  /** 最近一个有配送单的出餐日（D61 `date` 缺省时用） */
  private async latestDeliveryDate(): Promise<string | null> {
    const rows = await this.deliveryRepo.find({ order: { mealDate: 'DESC' }, take: 1 });
    return rows[0]?.mealDate ?? null;
  }

  /** 取可人工修正字段的快照（D61 行 / D62 `before` / 冲突出参共用） */
  private snapshotOf(r: DeliveryRecord): DeliverySnapshot {
    return {
      totalQuantity: r.totalQuantity,
      driverName: r.driverName ?? null,
      driverPhone: r.driverPhone ?? null,
      plateNo: r.plateNo ?? null,
      remark: r.remark ?? null,
    };
  }

  // =====================================================================
  // D61 / D62：后台查看与人工修正（M5-1 · 挂账 #61）
  // =====================================================================

  /**
   * 按出餐日列出配送单（D61 · 后台）
   *
   * `date` 缺省取**最近一个有配送单的出餐日** —— 配送单是 T 日 00:30 生成的，
   * 运营白天打开页面想看的是今天这批，而「今天」在 00:30 之前还没有单；
   * 用「最近有单的日期」才不会打开就是空页。
   */
  async listByDate(q: DeliveryListQueryDto): Promise<DeliveryListResult> {
    const statusOptions = DELIVERY_STATUS_ORDER.map((s) => ({
      value: s as string,
      label: DELIVERY_STATUS_LABEL[s] ?? (s as string),
    }));

    const date = q.date ?? (await this.latestDeliveryDate());
    if (!date) {
      return {
        date: null,
        list: [],
        summary: {
          count: 0,
          totalQuantity: 0,
          totalOrderQuantity: 0,
          mismatchCount: 0,
          manualInputCount: 0,
          byStatus: [],
        },
        reason:
          '还没有任何配送单。配送单在出餐日 00:30 按楼群自动生成（或经运维补跑 `delivery-generate`），生成后本页才有数据。',
        note: DELIVERY_LIST_NOTE,
        statusOptions,
      };
    }

    const records = await this.deliveryRepo.find({
      where: {
        mealDate: date,
        ...(q.buildingGroupId ? { buildingGroupId: q.buildingGroupId } : {}),
        ...(q.status ? { status: q.status } : {}),
      },
      order: { buildingGroupId: 'ASC' },
    });

    // ⚠️ 份数对比必须用**全量**订单聚合（不受 `status` / `buildingGroupId` 筛选影响）——
    //    否则筛了 status 之后「订单份数」也跟着只剩那部分，差异会被算成一个
    //    毫无意义的数（同 §28「出参一份口径、落库另一份口径」的教训）。
    const [orderQty, groups, orderBreak] = await Promise.all([
      this.aggregateOrderQuantity(date),
      records.length
        ? this.groupRepo.find({ where: { id: In(records.map((r) => r.buildingGroupId)) } })
        : Promise.resolve([] as BuildingGroup[]),
      // 订单状态分布同样取**全量**（不受筛选影响）—— 理由同上
      this.aggregateOrderBreakdown(date),
    ]);
    const nameOf = new Map(groups.map((g) => [g.id, g.name ?? null]));

    const list = records.map((r) =>
      this.toRow(
        r,
        orderQty.get(r.buildingGroupId) ?? 0,
        nameOf.get(r.buildingGroupId) ?? null,
        orderBreak.get(r.buildingGroupId) ?? [],
      ),
    );

    return {
      date,
      list,
      summary: {
        count: list.length,
        totalQuantity: list.reduce((s, r) => s + r.totalQuantity, 0),
        totalOrderQuantity: list.reduce((s, r) => s + r.orderQuantity, 0),
        mismatchCount: list.filter((r) => r.quantityMismatch).length,
        manualInputCount: list.filter((r) => r.hasManualInput).length,
        byStatus: DELIVERY_STATUS_ORDER.map((s) => ({
          status: s as string,
          statusText: DELIVERY_STATUS_LABEL[s] ?? (s as string),
          count: list.filter((r) => r.status === s).length,
        })).filter((b) => b.count > 0),
      },
      note: DELIVERY_LIST_NOTE,
      statusOptions,
    };
  }

  /** 组装一行为出参（份数差异与人工痕迹在此判定） */
  private toRow(
    r: DeliveryRecord,
    orderQuantity: number,
    groupName: string | null,
    orderStatusBreakdown: OrderStatusBreakdown = [],
  ): DeliveryRow {
    const quantityDiff = Number(r.totalQuantity) - orderQuantity;
    return {
      id: r.id,
      mealDate: r.mealDate,
      buildingGroupId: r.buildingGroupId,
      buildingGroupName: groupName,
      expectedAt: r.expectedAt ? toBjIso(r.expectedAt) : null,
      actualAt: r.actualAt ? toBjIso(r.actualAt) : null,
      totalQuantity: Number(r.totalQuantity),
      orderQuantity,
      quantityDiff,
      quantityMismatch: quantityDiff !== 0,
      hasManualInput: Boolean(r.driverName || r.driverPhone || r.plateNo || r.remark),
      driverName: r.driverName ?? null,
      driverPhone: r.driverPhone ?? null,
      plateNo: r.plateNo ?? null,
      remark: r.remark ?? null,
      status: r.status,
      statusText: DELIVERY_STATUS_LABEL[r.status] ?? r.status,
      version: r.version,
      orderStatusBreakdown,
    };
  }

  /**
   * 按楼群聚合「订单状态分布」（M5-8 · 履约链可见性）
   *
   * 与 `aggregateOrderQuantity()` 同一份 `WHERE`（排除 `pending_pay` / `cancelled`）——
   * 两份口径若不一致，就会出现「份数对得上、状态分布加起来对不上」这种
   * **自己跟自己矛盾**的出参（同 D61「两处各写一遍 SQL」的教训）。
   * 故这里的分组键多一列 `status`，过滤条件**逐字复用**同一段。
   */
  private async aggregateOrderBreakdown(date: string): Promise<Map<number, OrderStatusBreakdown>> {
    const rows = await this.orderRepo
      .createQueryBuilder('o')
      .select('o.building_group_id', 'buildingGroupId')
      .addSelect('o.status', 'status')
      .addSelect('COUNT(*)', 'orderCount')
      .addSelect('SUM(o.quantity)', 'quantity')
      .where('o.meal_date = :date', { date })
      .andWhere('o.status NOT IN (:...excluded)', {
        excluded: [OrderStatus.PENDING_PAY, OrderStatus.CANCELLED],
      })
      .groupBy('o.building_group_id')
      .addGroupBy('o.status')
      .getRawMany<{
        buildingGroupId: string | number;
        status: string;
        orderCount: string | number;
        quantity: string | number;
      }>();

    const out = new Map<number, OrderStatusBreakdown>();
    for (const r of rows) {
      const gid = Number(r.buildingGroupId);
      const list = out.get(gid) ?? [];
      list.push({
        status: r.status,
        statusText: ORDER_STATUS_VIEW[r.status as OrderStatus]?.admin ?? r.status,
        orderCount: Number(r.orderCount),
        quantity: Number(r.quantity),
      });
      out.set(gid, list);
    }
    // 按**主流程进度**排序（与 `STATUS_PROGRESS` 同一顺序），异常态附在末尾 ——
    // 让「订单走到哪一步了」在列表里是**从上到下**可读的，而不是字典序
    const rank = [
      OrderStatus.CUT_OFF,
      OrderStatus.COOKED,
      OrderStatus.DELIVERING,
      OrderStatus.DELIVERED,
      OrderStatus.COMPLETED,
      OrderStatus.REFUND_APPLYING,
      OrderStatus.REFUNDED,
    ];
    for (const list of out.values()) {
      list.sort(
        (a, b) => rank.indexOf(a.status as OrderStatus) - rank.indexOf(b.status as OrderStatus),
      );
    }
    return out;
  }

  // =====================================================================
  // D63：配送单状态推进（履约流转 · M5-8 · 状态机 T8 / T9）
  // =====================================================================

  /**
   * 推进配送单状态（D63）并把**订单**一起推到位（状态机 T8 / T9）
   *
   * ## 为什么这是 #79 的另一半
   * `delivery.service` 此前只**读** `cut_off` 订单生成配送单，**从不写 `ab_order.status`**
   * —— 于是 `cooked` / `delivering` / `delivered` 三个状态全仓零写入点，
   * 订单支付后永远停在 `cut_off`（详见 `supplier.service.advanceOrdersToCooked` 的注释）。
   * 本方法是 T8 / T9 的**唯一写入点**：货拉拉发出 → 订单 `delivering`；
   * 送到楼下 → 订单 `delivered`，下游 T10（团长确认）/ T11（14:00 兜底）**这才可达**。
   *
   * ## 四道闸门（顺序不可调换：先判「有没有」，再判「是不是你的版本」，最后判「能不能这么走」）
   * ① **存在性** → `30017`
   * ② **乐观锁** → `30016`（`version` 不匹配即拒，附 `current`）
   * ③ **单向性** → `30018`：只能向前（`pending → called → en_route → arrived`），
   *    回退 / 跳级 / 原地一律拒，附 `data.allowed`
   * ④ **CAS 写入** → 前置校验与写入之间仍有窗口，写入时再带一次 `version`，`affected=0` → `30016`
   *
   * ## 订单联动是「尽力而为 + 如实报告」，不是「要么全成要么全败」
   * 物理世界不会因为系统里订单状态不对就不发车 —— 若把「订单必须都在 `cooked`」
   * 当作推进的前置条件，运营会被**卡在门口**，然后绕过系统直接打电话（系统失去记录）。
   * 故：能推的推（条件更新 `cooked → delivering`），推不动的**如实计数**在
   * `orderTransition.remaining` 里，并给一句人能照着排查的 `note`。
   * ⚠️ 这不是「静默跳过」：数字与话都在出参里，且订单停在 `cut_off` 会在
   *    T 日 14:00 的 `auto-confirm` 里被计入 `notDelivered`（fail-closed 的告警出口）。
   *
   * ## T9 的「取餐通知」为什么不在本方法里发
   * 状态机 T9 的副作用列写着「订阅消息：取餐通知（团长）」，但**场景 `leader_delivery`
   * 一期渠道只有微信群**（`message-template.specs.ts` 里 `wiring='pending'`，
   * 理由是原型原文「初期采用微信群人工通知兜底」）。往 `wechat_group` 场景调
   * `MessageService.notify()` 会被它自己判为「无程序投递点」而跳过 ——
   * 加一个必然跳过的调用点，只会让接线状态变成假的 `live`。故此处**不装样子**，
   * 由运营按场景文案人工发群（P36 页面可复制），并已如实登记在《缺陷与陷阱》。
   */
  async advanceStatus(
    id: number,
    dto: DeliveryStatusAdvanceDto,
    operatorId?: number | null,
  ): Promise<DeliveryAdvanceResult> {
    // ---- ① 存在性 ----
    const record = await this.deliveryRepo.findOne({ where: { id } });
    if (!record) {
      throw new BizException(ErrorCode.DELIVERY_NOT_FOUND, `配送单 #${id} 不存在`);
    }

    // ---- ② 乐观锁前置校验 ----
    if (record.version !== dto.version) {
      throw new BizException(
        ErrorCode.DELIVERY_CONFLICT,
        '这张配送单已被他人修改，请刷新后重试',
        undefined,
        { current: { ...this.snapshotOf(record), status: record.status, version: record.version } },
      );
    }

    // ---- ③ 单向 **且单步** ----
    //
    // ⚠️ `allowed` 只放**紧邻的下一态**，而不是 `slice(fromIdx + 1)` 的全部后续态。
    //    放走「跳级」的代价不是「少点两次按钮」，而是**静默跳过订单联动**：
    //    `pending → arrived` 一步到底时，`to === ARRIVED` 只会跑 T9
    //    （条件更新 `delivering → delivered`），而订单此刻还在 `cooked`
    //    —— 条件不命中 ⇒ **一单都不会动，且不报任何错**，订单永远停在 `cooked`。
    //    这正是 #79 的形状（写入点缺失 ⇒ 静默卡死），不能在刚补好它的同一批里重开一次。
    //    要让系统补记物理上已经发生的过程，正确做法是**逐步补按**（每步各留一条日志、
    //    各联动一次订单），而不是让一次请求同时代表三件事。
    const fromIdx = DELIVERY_STATUS_ORDER.indexOf(record.status as DeliveryStatus);
    const allowed =
      fromIdx < 0 || fromIdx >= DELIVERY_STATUS_ORDER.length - 1
        ? []
        : [DELIVERY_STATUS_ORDER[fromIdx + 1] as string];
    if (!allowed.includes(dto.to)) {
      throw new BizException(
        ErrorCode.DELIVERY_STATUS_ILLEGAL,
        `配送单当前状态「${DELIVERY_STATUS_LABEL[record.status] ?? record.status}」不能推进到` +
          `「${DELIVERY_STATUS_LABEL[dto.to] ?? dto.to}」—— 履约流只能向前，且**一次只能一步**` +
          (allowed.length
            ? `，当前可推进到：${allowed.map((s) => DELIVERY_STATUS_LABEL[s] ?? s).join('、')}`
            : '（已是终态）'),
        undefined,
        {
          current: { status: record.status, version: record.version },
          allowed,
        },
      );
    }

    const at = new Date();
    const group = await this.groupRepo.findOne({ where: { id: record.buildingGroupId } });

    const outcome = await this.dataSource.transaction(async (m: EntityManager) => {
      // ---- ④ CAS 推进配送单 ----
      const upd = await m
        .createQueryBuilder()
        .update(DeliveryRecord)
        .set({
          status: dto.to,
          actualAt: dto.to === DeliveryStatus.ARRIVED ? at : record.actualAt,
          version: record.version + 1,
          updatedAt: at,
        })
        .where('id = :id AND version = :version', { id, version: record.version })
        .execute();
      if (!upd.affected) {
        const fresh = await m.findOne(DeliveryRecord, { where: { id } });
        throw new BizException(
          ErrorCode.DELIVERY_CONFLICT,
          '这张配送单刚刚被他人修改，请刷新后重试',
          undefined,
          {
            current: fresh
              ? { ...this.snapshotOf(fresh), status: fresh.status, version: fresh.version }
              : null,
          },
        );
      }

      const logs: QueryDeepPartialEntity<OperationLog>[] = [
        {
          adminUserId: operatorId ?? null,
          module: 'delivery',
          action: '推进配送状态',
          targetId: String(id),
          requestData: {
            mealDate: record.mealDate,
            buildingGroupId: record.buildingGroupId,
            to: dto.to,
            note: dto.note ?? null,
          },
          snapshot: {
            fromStatus: record.status,
            toStatus: dto.to,
            source: 'admin',
            reason: dto.note ?? '履约流转',
          },
        },
      ];

      // ---- ⑤ 联动订单（T8 / T9）----
      //
      // ⚠️ **两段迁移刻意各写一个具名方法**，而不是共用「传 `to` 进去」的通用循环：
      //    写法上 `set({ status: to })` 更短，但那样两处订单状态写入点在静态扫描下
      //    都是「动态值 · 判不出来」—— 而门禁 `state:audit` 正是靠**能静态判定**才
      //    对得上「声明 ↔ 写入点」。把状态写成变量，等于亲手把 #79 逃过全部门禁的
      //    那个盲区重新打开一次（同批的教训：**不要为了少写几行，把可对账性让掉**）。
      let advanced = 0;
      let transition: OrderTransitionHit | null = null;
      if (dto.to === DeliveryStatus.EN_ROUTE) {
        transition = await this.advanceGroupOrdersToDelivering(m, record, logs, operatorId);
      } else if (dto.to === DeliveryStatus.ARRIVED) {
        transition = await this.advanceGroupOrdersToDelivered(m, record, logs, operatorId);
      }
      advanced = transition?.advanced ?? 0;
      await m.getRepository(OperationLog).insert(logs);

      // 推进后的分布（事务内取，与本次写入同一快照）
      const remaining = await this.breakdownOf(m, record.mealDate, record.buildingGroupId);

      return { advanced, transition, remaining };
    });

    this.logger.log(
      `配送单推进 id=${id}（${record.mealDate} / 楼群 ${record.buildingGroupId}）` +
        `${record.status} → ${dto.to}` +
        (outcome.transition
          ? ` · 联动订单 ${outcome.advanced} 单 ` +
            `${outcome.transition.from} → ${outcome.transition.to}`
          : ' · 无订单联动（已叫车阶段不动订单）') +
        (operatorId ? `（操作人#${operatorId}）` : ''),
    );

    const fromText = DELIVERY_STATUS_LABEL[record.status] ?? record.status;
    const toText = DELIVERY_STATUS_LABEL[dto.to] ?? dto.to;
    const pair = outcome.transition;
    let transitionNote: string | undefined;
    if (pair && outcome.advanced === 0) {
      const stillFrom = outcome.remaining.find((r) => r.status === pair.from);
      transitionNote = stillFrom
        ? `该楼群当日仍有 ${stillFrom.orderCount} 单停在「${stillFrom.statusText}」而无法推进 —— ` +
          '请先确认上游是否完成（出餐确认 / 上一段发车），订单不会替物理流程做假设'
        : `该楼群当日已没有停在「${ORDER_STATUS_VIEW[pair.from]?.admin ?? pair.from}」的订单（可能已推进过）`;
    }

    return {
      id,
      mealDate: record.mealDate,
      buildingGroupId: record.buildingGroupId,
      buildingGroupName: group?.name ?? null,
      from: record.status,
      fromText,
      to: dto.to,
      toText,
      version: record.version + 1,
      actualAt: dto.to === DeliveryStatus.ARRIVED ? toBjIso(at) : toBjIso(record.actualAt),
      orderTransition: pair
        ? {
            from: pair.from,
            fromText: ORDER_STATUS_VIEW[pair.from]?.admin ?? pair.from,
            to: pair.to,
            toText: ORDER_STATUS_VIEW[pair.to]?.admin ?? pair.to,
            advanced: outcome.advanced,
            remaining: outcome.remaining,
            ...(transitionNote ? { note: transitionNote } : {}),
          }
        : null,
      note:
        (pair
          ? `本次已联动订单：${ORDER_STATUS_VIEW[pair.from]?.admin ?? pair.from} → ` +
            `${ORDER_STATUS_VIEW[pair.to]?.admin ?? pair.to}（${outcome.advanced} 单）。`
          : '「已叫车」只是运力安排，货还在加工场所 —— **订单状态刻意不动**，' +
            '订单要到「配送中」（货拉拉发出）才推进，这不是漏了联动。') +
        (dto.to === DeliveryStatus.ARRIVED
          ? '⭐ 送达通知（场景 `leader_delivery`）一期渠道为微信群，需运营按模板文案人工发群；' +
            '订阅消息渠道属二期（缺微信模板 ID）。'
          : ''),
    };
  }

  /** 事务内取「某楼群当日订单状态分布」（D63 出参用 · 与 D61 同口径） */
  private async breakdownOf(
    m: EntityManager,
    mealDate: string,
    buildingGroupId: number,
  ): Promise<OrderStatusBreakdown> {
    const rows = await m
      .createQueryBuilder(Order, 'o')
      .select('o.status', 'status')
      .addSelect('COUNT(*)', 'orderCount')
      .addSelect('SUM(o.quantity)', 'quantity')
      .where('o.meal_date = :date', { date: mealDate })
      .andWhere('o.building_group_id = :gid', { gid: buildingGroupId })
      .andWhere('o.status NOT IN (:...excluded)', {
        excluded: [OrderStatus.PENDING_PAY, OrderStatus.CANCELLED],
      })
      .groupBy('o.status')
      .getRawMany<{ status: string; orderCount: string | number; quantity: string | number }>();

    const rank = [
      OrderStatus.CUT_OFF,
      OrderStatus.COOKED,
      OrderStatus.DELIVERING,
      OrderStatus.DELIVERED,
      OrderStatus.COMPLETED,
      OrderStatus.REFUND_APPLYING,
      OrderStatus.REFUNDED,
    ];
    return rows
      .map((r) => ({
        status: r.status,
        statusText: ORDER_STATUS_VIEW[r.status as OrderStatus]?.admin ?? r.status,
        orderCount: Number(r.orderCount),
        quantity: Number(r.quantity),
      }))
      .sort(
        (a, b) => rank.indexOf(a.status as OrderStatus) - rank.indexOf(b.status as OrderStatus),
      );
  }

  /**
   * 状态机 **T8**：配送单 `en_route`（货拉拉发出）→ 该楼群订单 `cooked → delivering`
   *
   * 幂等：逐单条件更新（`WHERE id = ? AND status = 'cooked'`），`affected` 判归属。
   * 不吃 `delivered` / 更后面的状态（那些已有各自的上游），也不吃 `cut_off`
   * （出餐确认还没做 —— 那是上游缺失，会被如实计进 `remaining` 而不是被顺手跳过）。
   */
  private async advanceGroupOrdersToDelivering(
    m: EntityManager,
    record: DeliveryRecord,
    logs: QueryDeepPartialEntity<OperationLog>[],
    operatorId: number | null | undefined,
  ): Promise<OrderTransitionHit> {
    const orders = await m.find(Order, {
      where: {
        mealDate: record.mealDate,
        buildingGroupId: record.buildingGroupId,
        status: OrderStatus.COOKED,
      },
      order: { id: 'ASC' },
    });

    let advanced = 0;
    for (const o of orders) {
      const u = await m
        .createQueryBuilder()
        .update(Order)
        .set({ status: OrderStatus.DELIVERING, version: () => 'version + 1' })
        .where('id = :id', { id: o.id })
        .andWhere('status = :st', { st: OrderStatus.COOKED })
        .execute();
      if ((u.affected ?? 0) === 0) continue;

      advanced += 1;
      // 状态机 §2.1.5：每次迁移落 `ab_operation_log`（事务内，全局拦截器不生效）
      logs.push({
        adminUserId: operatorId ?? null,
        module: 'order',
        action: '发车推进',
        targetId: String(o.id),
        requestData: { orderNo: o.orderNo, mealDate: record.mealDate },
        snapshot: {
          fromStatus: OrderStatus.COOKED,
          toStatus: OrderStatus.DELIVERING,
          source: 'admin',
          reason: '运营标记货拉拉发出（状态机 T8）',
        },
      });
    }
    return { advanced, from: OrderStatus.COOKED, to: OrderStatus.DELIVERING };
  }

  /**
   * 状态机 **T9**：配送单 `arrived`（送达办公楼楼下）→ 该楼群订单 `delivering → delivered`
   *
   * `delivered` 一到，下游两条路**这才可达**：T10 团长一键分发（L9）、
   * T11 14:00 自动确认兜底 —— 而它们正是「佣金产生」的两个入口。
   *
   * ⚠️ 不动 `completedAt`：那是 T10/T11（确认收货）的落点，不是送达的落点。
   */
  private async advanceGroupOrdersToDelivered(
    m: EntityManager,
    record: DeliveryRecord,
    logs: QueryDeepPartialEntity<OperationLog>[],
    operatorId: number | null | undefined,
  ): Promise<OrderTransitionHit> {
    const orders = await m.find(Order, {
      where: {
        mealDate: record.mealDate,
        buildingGroupId: record.buildingGroupId,
        status: OrderStatus.DELIVERING,
      },
      order: { id: 'ASC' },
    });

    let advanced = 0;
    for (const o of orders) {
      const u = await m
        .createQueryBuilder()
        .update(Order)
        .set({ status: OrderStatus.DELIVERED, version: () => 'version + 1' })
        .where('id = :id', { id: o.id })
        .andWhere('status = :st', { st: OrderStatus.DELIVERING })
        .execute();
      if ((u.affected ?? 0) === 0) continue;

      advanced += 1;
      logs.push({
        adminUserId: operatorId ?? null,
        module: 'order',
        action: '送达推进',
        targetId: String(o.id),
        requestData: { orderNo: o.orderNo, mealDate: record.mealDate },
        snapshot: {
          fromStatus: OrderStatus.DELIVERING,
          toStatus: OrderStatus.DELIVERED,
          source: 'admin',
          reason: '运营标记送达办公楼（状态机 T9）',
        },
      });
    }
    return { advanced, from: OrderStatus.DELIVERING, to: OrderStatus.DELIVERED };
  }

  /**
   * 人工修正配送单（D62 · 挂账 #61）
   *
   * 只允许改 **份数 / 司机 / 电话 / 车牌 / 备注** —— **不动 `status`**
   * （配送状态是履约流转，有它自己的时点与责任，属独立批次）。
   *
   * ## 三道闸门
   * ① **存在性** → `30017`（不存在就是不存在，不静默成功）
   * ② **乐观锁** → `30016`：`version` 不匹配即拒，并把 `current` 一并下发，
   *    端上刷新后重提即可。防止「A 改份数、B 改司机，B 用旧快照把份数覆盖回去」——
   *    那种失败**双方都不报错**，直到装错货。
   * ③ **CAS 写入** → 前置校验与实际写入之间仍有窗口（两个请求同时通过 ②），
   *    故写入时再带一次 `version` 条件；`affected` 为空则同样报 `30016`。
   *
   * ## 空改动不写库
   * 提交了但与现值相同的字段进 `unchanged[]`，**不写库、不产生假变更记录**
   *（与 D58 同一纪律）。若**全部**字段都没变，直接返回，连 `version` 都不推进。
   */
  async patch(id: number, dto: DeliveryPatchDto): Promise<DeliveryPatchResult> {
    const record = await this.deliveryRepo.findOne({ where: { id } });
    if (!record) {
      throw new BizException(ErrorCode.DELIVERY_NOT_FOUND, `配送单 #${id} 不存在`);
    }

    // ---- ② 乐观锁前置校验：冲突时带 current 下发，端上刷新后重提 ----
    if (record.version !== dto.version) {
      throw new BizException(
        ErrorCode.DELIVERY_CONFLICT,
        '这张配送单已被他人修改，请刷新后重试',
        undefined,
        { current: { ...this.snapshotOf(record), version: record.version } },
      );
    }

    const orderQuantity =
      (await this.aggregateOrderQuantity(record.mealDate)).get(record.buildingGroupId) ?? 0;

    const before = this.snapshotOf(record);
    const after: DeliverySnapshot = { ...before };
    const changed: string[] = [];
    const unchanged: string[] = [];

    /** 文本归一：未提交 → `undefined`（不动该字段）；空串 → `null`（清空） */
    const text = (v: string | undefined): string | null | undefined =>
      v === undefined ? undefined : v.trim() === '' ? null : v.trim();

    if (dto.totalQuantity !== undefined) {
      if (before.totalQuantity === dto.totalQuantity) {
        unchanged.push('totalQuantity');
      } else {
        after.totalQuantity = dto.totalQuantity;
        changed.push('totalQuantity');
      }
    }

    const textFields = ['driverName', 'driverPhone', 'plateNo', 'remark'] as const;
    for (const f of textFields) {
      const v = text(dto[f]);
      if (v === undefined) continue;
      if (before[f] === v) {
        unchanged.push(f);
        continue;
      }
      after[f] = v;
      changed.push(f);
    }

    // ---- 空改动：不写库、不推进版本（避免「假变更记录」）----
    if (!changed.length) {
      return {
        id,
        before,
        after: before,
        changed: [],
        unchanged,
        version: record.version,
        quantityDiff: before.totalQuantity - orderQuantity,
        orderQuantity,
      };
    }

    // ---- ③ CAS 写入 ----
    // ⚠️ `version: record.version + 1` 也在 SET 里 —— 它保证本语句**至少改变一行**，
    //    从而 MySQL 的 `affectedRows` 不会因为「SET 值与原值相同」而返回 0
    //    被误判成冲突（MySQL 默认按「实际改变的行数」计）。
    const res = await this.deliveryRepo
      .createQueryBuilder()
      .update(DeliveryRecord)
      .set({
        totalQuantity: after.totalQuantity,
        driverName: after.driverName,
        driverPhone: after.driverPhone,
        plateNo: after.plateNo,
        remark: after.remark,
        version: record.version + 1,
        updatedAt: new Date(),
      })
      .where('id = :id AND version = :version', { id, version: record.version })
      .execute();

    if (!res.affected) {
      const fresh = await this.deliveryRepo.findOne({ where: { id } });
      throw new BizException(
        ErrorCode.DELIVERY_CONFLICT,
        '这张配送单刚刚被他人修改，请刷新后重试',
        undefined,
        { current: fresh ? { ...this.snapshotOf(fresh), version: fresh.version } : null },
      );
    }

    this.logger.log(
      `配送单人工修正 id=${id}（${record.mealDate} / 楼群 ${record.buildingGroupId}）` +
        `变更 [${changed.join(', ')}] · 版本 ${record.version} → ${record.version + 1}`,
    );

    return {
      id,
      before,
      after,
      changed,
      unchanged,
      version: record.version + 1,
      quantityDiff: after.totalQuantity - orderQuantity,
      orderQuantity,
    };
  }
}

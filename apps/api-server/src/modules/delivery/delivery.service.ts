import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { DELIVERY_STATUS_LABEL, DELIVERY_STATUS_ORDER, OrderStatus } from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { arrivalAtOf, toBjIso } from '../../common/utils/time';
import { BuildingGroup } from '../../database/entities/building.entity';
import { MealAssignment } from '../../database/entities/meal.entity';
import { DeliveryRecord, Order } from '../../database/entities/order.entity';
import { DeliveryListQueryDto, DeliveryPatchDto } from './dto/delivery.dto';

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
    const [orderQty, groups] = await Promise.all([
      this.aggregateOrderQuantity(date),
      records.length
        ? this.groupRepo.find({ where: { id: In(records.map((r) => r.buildingGroupId)) } })
        : Promise.resolve([] as BuildingGroup[]),
    ]);
    const nameOf = new Map(groups.map((g) => [g.id, g.name ?? null]));

    const list = records.map((r) =>
      this.toRow(r, orderQty.get(r.buildingGroupId) ?? 0, nameOf.get(r.buildingGroupId) ?? null),
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
  private toRow(r: DeliveryRecord, orderQuantity: number, groupName: string | null): DeliveryRow {
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
    };
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

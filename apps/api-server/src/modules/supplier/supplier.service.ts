import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { QueryDeepPartialEntity } from 'typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';

import {
  LICENSE_EXPIRING_DAYS,
  LicenseState,
  OrderStatus,
  SUPPLIER_AUDIT_STATUS_LABEL,
  SUPPLIER_STATUS_LABEL,
  SupplierAuditStatus,
  SupplierStatus,
} from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { toFen } from '../../common/utils/money';
import { addDays, bjDateTime, toBjIso, todayBj, tomorrowBj } from '../../common/utils/time';
import { Building, BuildingGroup } from '../../database/entities/building.entity';
import { DistributionCenter } from '../../database/entities/finance.entity';
import { MealAssignment, SetMealItem } from '../../database/entities/meal.entity';
import { Order } from '../../database/entities/order.entity';
import {
  Dish,
  Supplier,
  SupplierDishCenterDaily,
  SupplierDishDaily,
} from '../../database/entities/supplier.entity';
import { OperationLog } from '../../database/entities/system.entity';
import {
  CookConfirmDto,
  PackingTasksQueryDto,
  SupplierWorkbenchQueryDto,
} from './dto/supplier.dto';

/** 出餐确认截止时刻（出餐日当天 HH:mm）—— 原型 P22「截止时间：09:30」 */
const CONFIRM_DEADLINE_HOUR = 9;
const CONFIRM_DEADLINE_MINUTE = 30;
const CONFIRM_DEADLINE_TEXT = '09:30';

/** `ab_supplier_dish_center_daily.status` 值域（二态） */
const DETAIL_PENDING = 'pending';
const DETAIL_CONFIRMED = 'confirmed';

/**
 * `ab_supplier_dish_daily.status` 值域 —— **刻意沿用既有三值，不扩枚举**
 *
 * 既有值域（ER v2.1 §3.6）：`pending` / `cooking` / `done`。
 * 分中心维度的「部分确认」正好落在 `cooking`（在制 / 在途），
 * 于是「父行状态」由明细派生即可，无需新增 `partial`：
 *   · 无任何中心确认           → pending
 *   · 部分中心确认（在途）      → cooking
 *   · 全部中心确认             → done（并置 completed_at）
 */
const DAILY_PENDING = 'pending';
const DAILY_COOKING = 'cooking';
const DAILY_DONE = 'done';

/** 派生出的「应送份数」：`sup:dish` → 日总量；`sup:dish:dc` → 分中心量 */
interface DerivedPlan {
  supplierId: number;
  dishId: number;
  total: number;
  centers: Map<number, number>;
}

/** 截单刷新生产计划的出参（`freezeProducePlan`） */
export interface ProducePlanFreezeResult {
  date: string;
  /** 本次定格的计划总量（份） */
  totalQuantity: number;
  createdDaily: number;
  updatedDaily: number;
  createdDetails: number;
  updatedDetails: number;
  /** 已开工（cooking/done）而未覆盖的行数 —— 需人工核对 */
  skippedStarted: number;
  supplierCount: number;
}

/**
 * 出餐确认对订单状态机的影响（`advanceOrdersToCooked` 的出参）
 *
 * 四个数**刻意都给**：只回「推进了几单」时，运营无法区分
 * 「今天本来就没有单」与「有单但一直推不动」—— 而后者正是 #79 的形态
 * （**看起来像「今天没单」，不像故障**）。
 */
export interface OrderAdvanceResult {
  /** 本次真正推进 `cut_off → cooked` 的订单数 */
  cooked: number;
  /** 本轮「菜品全部到齐」的加工场所数 */
  readyCenterCount: number;
  /** 达标场所（id + 名） */
  readyCenters: Array<{ centerId: number; centerName: string }>;
  /** 该出餐日**仍停在 `cut_off`** 的订单数（场所未齐 / 订单没配加工场所） */
  stillCutOff: number;
}

/**
 * 供应商端服务（M3-8 · 《接口规范 v1.0》§6.5 S1–S3 · 原型 P21/P22）
 *
 * ## 三条贯穿本文件的纪律
 *
 * 1. **主体只看自己**：所有查询都以「账号绑定的 `supplierId`」收窄，
 *    请求体里**不出现** `supplierId`（见 `dto/supplier.dto.ts` 头部）。
 *    供应商隔离靠 `AdminGuard` 的 `typ` + `@Roles('supplier')` + 服务层收窄，
 *    **不靠路径**（`admin.guard.ts` 的既有纪律）。
 *
 * 2. **出餐确认是 deadline，不是 earliest**：
 *    `≤ 出餐日 09:30` 的含义是「**迟于** 09:30 不许确认」，提前备好提前确认**允许**。
 *    这样既符合原型语义（09:30 是集散中心开始打包的上游时点），
 *    又让「两侧都能被真实测到」—— 对**昨日**确认必拒（已过点），对**明日**确认必过（未到点），
 *    无需给 e2e 开后门注入时钟。过期一律 **fail-closed**（50009），
 *    不允许「补确认」把错过的时点抹平：系统里的时间戳必须诚实，对账与追责都以它为准。
 *
 * 3. **生产计划可派生但必须落库**：`ab_supplier_dish_daily` / `..._center_daily`
 *    的来源是「当日 active 的套餐分配 × 套餐菜品构成 × 已售份数」，完全可实时算出。
 *    但**仍然落库** —— 因为生产计划是给供应商的**承诺数**，一旦生成即**冻结**：
 *    若截单后再有人改单（D11/D12），不能让供应商的备料量在背后悄悄变化。
 *    故采用**惰性 ensure**：首次访问时生成，之后只读（重复调用幂等，不重算）。
 *    改单后要刷新计划属运营动作，见本文件末尾 `notes` 的待办登记。
 *
 * ⚠️ **自营路线下的语义待复核**（2026-09-16 用户裁定：单主体自营，供应商供半成品）：
 *    本文件的 `cook-confirm` 确认的是「**本供应商当日菜品生产完成 / 已交付**」，
 *    这是一个**两条路线下都成立**的中性语义；「送到哪个集散中心」的交互粒度（原型 P22）
 *    在自营下仍有效（半成品也要按点送达加工场所）。但「谁是出餐主体」在自营下变为
 *    ABox 自己（持证加工场所），需要一次口径复核 —— 见 `ref/资质与合规.md` §八。
 */
@Injectable()
export class SupplierService {
  private readonly logger = new Logger('SupplierPortal');

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Supplier) private readonly supplierRepo: Repository<Supplier>,
    @InjectRepository(Dish) private readonly dishRepo: Repository<Dish>,
    @InjectRepository(SupplierDishDaily) private readonly dailyRepo: Repository<SupplierDishDaily>,
    @InjectRepository(SupplierDishCenterDaily)
    private readonly detailRepo: Repository<SupplierDishCenterDaily>,
    @InjectRepository(DistributionCenter) private readonly dcRepo: Repository<DistributionCenter>,
    @InjectRepository(MealAssignment) private readonly maRepo: Repository<MealAssignment>,
    @InjectRepository(SetMealItem) private readonly itemRepo: Repository<SetMealItem>,
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    @InjectRepository(BuildingGroup) private readonly groupRepo: Repository<BuildingGroup>,
  ) {}

  // =====================================================================
  // S1 · 工作台
  // =====================================================================

  /**
   * S1 `GET /supplier/workbench?date=` —— 今日 / 指定日出餐计划 + 备料清单
   *
   * `date` 缺省 = 该供应商「最近一个有生产计划的出餐日」（通常是明日 T+1，
   * 因为 T-1 才是备货日）。刻意不写死 `tomorrowBj()`：周末或停团时，
   * 最近有计划的日子可能不是明天。
   */
  async workbench(adminSupplierId: number | null | undefined, q: SupplierWorkbenchQueryDto) {
    const supplier = await this.loadSupplier(adminSupplierId);
    const date = q.date ?? (await this.defaultDate(supplier.id));
    await this.ensureProducePlan(date, supplier.id);

    const [dailies, details] = await Promise.all([
      this.dailyRepo.find({
        where: { supplierId: supplier.id, produceDate: date },
        order: { id: 'ASC' },
      }),
      this.detailRepo.find({ where: { supplierId: supplier.id, produceDate: date } }),
    ]);

    const dishMap = await this.dishMapOf(dailies.map((d) => d.dishId));
    const centerMap = await this.centerMapOf(details.map((d) => d.distributionCenterId));
    const detailsOf = this.groupByDish(details);

    const dishes = dailies.map((d) => {
      const dish = dishMap.get(d.dishId);
      const rows = detailsOf.get(d.dishId) ?? [];
      const centers = rows
        .filter((r) => Number(r.planQuantity) > 0 || r.status === DETAIL_CONFIRMED)
        .map((r) => ({
          distributionCenterId: r.distributionCenterId,
          centerName:
            centerMap.get(r.distributionCenterId)?.name ?? `加工场所 ${r.distributionCenterId}`,
          centerAddress: centerMap.get(r.distributionCenterId)?.address ?? null,
          planQuantity: Number(r.planQuantity),
          actualQuantity: r.actualQuantity ?? null,
          status: r.status,
          confirmedAt: toBjIso(r.confirmedAt),
        }));

      const confirmedQuantity = centers
        .filter((c) => c.status === DETAIL_CONFIRMED)
        .reduce((sum, c) => sum + (c.actualQuantity ?? c.planQuantity), 0);
      const planQuantity =
        centers.reduce((sum, c) => sum + c.planQuantity, 0) || Number(d.planQuantity);

      return {
        dishId: d.dishId,
        dishName: dish?.name ?? `菜品 ${d.dishId}`,
        category: dish?.category ?? null,
        imageUrl: dish?.imageUrl ?? null,
        unitPriceFen: toFen(Number(d.unitPrice)),
        /** 日计划总量（父行落库值，冻结数） */
        planQuantity,
        confirmedQuantity,
        pendingQuantity: Math.max(0, planQuantity - confirmedQuantity),
        /** 父行状态：pending 未开工 / cooking 部分送达 / done 全部送达 */
        status: d.status,
        completedAt: toBjIso(d.completedAt),
        centers,
      };
    });

    const deadlineAt = this.deadlineOf(date);
    const overdue = Date.now() > deadlineAt.getTime();
    const planTotal = dishes.reduce((s, d) => s + d.planQuantity, 0);
    const confirmedTotal = dishes.reduce((s, d) => s + d.confirmedQuantity, 0);
    const canServe = this.canServe(supplier);

    return {
      date,
      supplier: {
        id: supplier.id,
        name: supplier.name,
        // ⚠️ M4-0：不再下发 `type` / `typeLabel` —— 自营下供应商只有一种角色
        //    （半成品供货方），类型三分法已停用（`ab_supplier.type` 为历史字段）。
        status: supplier.status,
        statusLabel: SUPPLIER_STATUS_LABEL[supplier.status] ?? String(supplier.status),
        auditStatus: supplier.auditStatus,
        auditStatusLabel:
          SUPPLIER_AUDIT_STATUS_LABEL[
            supplier.auditStatus as keyof typeof SUPPLIER_AUDIT_STATUS_LABEL
          ] ?? supplier.auditStatus,
        licenseState: this.licenseStateOf(supplier.licenseExpireAt),
        canServe,
      },
      deadline: {
        text: CONFIRM_DEADLINE_TEXT,
        at: toBjIso(deadlineAt),
        overdue,
        /** 未过点且未全部确认 = 还能确认 */
        canConfirm: !overdue && canServe,
      },
      dishes,
      summary: {
        dishCount: dishes.length,
        centerCount: new Set(details.map((d) => d.distributionCenterId)).size,
        planQuantity: planTotal,
        confirmedQuantity: confirmedTotal,
        pendingQuantity: Math.max(0, planTotal - confirmedTotal),
        allConfirmed: dishes.length > 0 && dishes.every((d) => d.status === DAILY_DONE),
        /** 一份都没派到（截单后未生成 / 当日停团）—— 端上给空态文案，别显示 0 份的表格 */
        empty: dishes.length === 0,
      },
      notes: {
        confirmRule: `出餐确认须在出餐日当天 ${CONFIRM_DEADLINE_TEXT} 前完成；提前确认随时可以，过点后系统不再受理。`,
        planFrozen:
          '计划份数由截单后的「楼群已售份数」汇总而来，生成后即冻结；如需调整请联系运营。',
        notForSettlement: '本页份数是生产口径，不做结算依据；应付金额以「结算明细」为准。',
      },
    };
  }

  // =====================================================================
  // S2 · 出餐确认
  // =====================================================================

  /**
   * S2 `POST /supplier/meal/cook-confirm` —— 按集散中心逐项确认（原型 P22）
   *
   * 三类前置校验，顺序不可调换（先判「有没有资格」，再判「来不来得及」，最后判「是不是你的活」）：
   *   ① `canServe` —— 合作中 ∧ 资质已通过 ∧ 证照未过期 → 50001
   *   ② 时间闸门 —— 迟于出餐日 09:30 → 50009（fail-closed）
   *   ③ 目标校验 —— 无该菜生产计划 → 50010；集散中心不在配送范围 → 50011
   *
   * **幂等**：已确认的项原样返回在 `skipped` 里，不报错、不改时间戳。
   * 重复提交是网络重试的常态，不该让供应商看到「失败」。
   */
  async cookConfirm(
    adminSupplierId: number | null | undefined,
    adminId: number | null | undefined,
    dto: CookConfirmDto,
  ) {
    const supplier = await this.loadSupplier(adminSupplierId);
    this.assertCanServe(supplier);
    this.assertNotOverdue(dto.date);
    await this.ensureProducePlan(dto.date, supplier.id);

    const dailies = await this.dailyRepo.find({
      where: { supplierId: supplier.id, produceDate: dto.date },
    });
    const dailyOf = new Map(dailies.map((d) => [d.dishId, d]));
    const details = await this.detailRepo.find({
      where: { supplierId: supplier.id, produceDate: dto.date },
    });

    const dishMap = await this.dishMapOf(dto.items.map((i) => i.dishId));
    const centerMap = await this.centerMapOf(dto.items.map((i) => i.distributionCenterId));

    const confirmed: Array<Record<string, unknown>> = [];
    const skipped: Array<Record<string, unknown>> = [];
    const touched = new Set<number>();
    const now = new Date();
    /** 履约推进结果（见 `advanceOrdersToCooked`）—— 必须由事务内赋值，事务外不可重算 */
    let orderAdvance: OrderAdvanceResult = {
      cooked: 0,
      readyCenterCount: 0,
      readyCenters: [],
      stillCutOff: 0,
    };

    await this.dataSource.transaction(async (m: EntityManager) => {
      for (const item of dto.items) {
        const daily = dailyOf.get(item.dishId);
        if (!daily) {
          throw new BizException(
            ErrorCode.PRODUCE_PLAN_NOT_FOUND,
            `当日没有「${dishMap.get(item.dishId)?.name ?? `菜品 ${item.dishId}`}」的生产计划，` +
              '无法确认（请核对出餐日与菜品，或联系运营）',
          );
        }

        const detail = details.find(
          (d) => d.dishId === item.dishId && d.distributionCenterId === item.distributionCenterId,
        );
        if (!detail) {
          throw new BizException(
            ErrorCode.COOK_CONFIRM_CENTER_MISMATCH,
            `「${dishMap.get(item.dishId)?.name ?? `菜品 ${item.dishId}`}」当日不送往` +
              `「${centerMap.get(item.distributionCenterId)?.name ?? `集散中心 ${item.distributionCenterId}`}」，` +
              '无法确认（配送范围由该集散中心服务的楼群决定）',
          );
        }

        if (detail.status === DETAIL_CONFIRMED) {
          skipped.push({
            dishId: item.dishId,
            dishName: dishMap.get(item.dishId)?.name ?? null,
            distributionCenterId: item.distributionCenterId,
            reason: 'already_confirmed',
            confirmedAt: toBjIso(detail.confirmedAt),
          });
          continue;
        }

        detail.status = DETAIL_CONFIRMED;
        // 不传 = 足额送达；传了则以申报值为准（短送留痕是对账依据）
        detail.actualQuantity =
          item.actualQuantity !== undefined ? item.actualQuantity : Number(detail.planQuantity);
        detail.confirmedAt = now;
        detail.confirmedBy = adminId ?? null;
        if (item.remark !== undefined) detail.remark = item.remark;
        await m.save(detail);

        touched.add(item.dishId);
        confirmed.push({
          dishId: item.dishId,
          dishName: dishMap.get(item.dishId)?.name ?? null,
          distributionCenterId: item.distributionCenterId,
          centerName: centerMap.get(item.distributionCenterId)?.name ?? null,
          planQuantity: Number(detail.planQuantity),
          actualQuantity: detail.actualQuantity,
          confirmedAt: toBjIso(now),
        });
      }

      // 父行状态由明细派生（pending / cooking / done），不新增枚举值
      for (const dishId of touched) {
        const daily = dailyOf.get(dishId);
        if (!daily) continue;
        const rows = await m.find(SupplierDishCenterDaily, {
          where: { supplierId: supplier.id, dishId, produceDate: dto.date },
        });
        const confirmedQty = rows
          .filter((r) => r.status === DETAIL_CONFIRMED)
          .reduce((sum, r) => sum + Number(r.actualQuantity ?? r.planQuantity), 0);
        const allConfirmed = rows.length > 0 && rows.every((r) => r.status === DETAIL_CONFIRMED);
        const anyConfirmed = rows.some((r) => r.status === DETAIL_CONFIRMED);

        daily.actualQuantity = confirmedQty;
        daily.status = allConfirmed ? DAILY_DONE : anyConfirmed ? DAILY_COOKING : DAILY_PENDING;
        daily.completedAt = allConfirmed ? now : null;
        await m.save(daily);
      }

      // ⭐⭐ M5-8：出餐确认的**下游** —— 把「菜品到齐」的加工场所下的订单推进为 `cooked`（状态机 T7）
      //
      // 放在**同一个事务**里是刻意的：若「明细已确认」提交而「订单已出餐」回滚，
      // 就留下「菜到齐了、但订单系统里没人知道」的中间态 —— 而它的表现是
      // 「订单永远停在 `cut_off`，佣金永不产生，且不报任何错」（正是 #79 的形态）。
      orderAdvance = await this.advanceOrdersToCooked(m, dto.date, adminId);
    });

    const after = await this.dailyRepo.find({
      where: { supplierId: supplier.id, produceDate: dto.date },
    });
    const dishIds = after.map((d) => d.dishId);
    const afterDetails = await this.detailRepo.find({
      where: { supplierId: supplier.id, produceDate: dto.date },
    });
    const afterDishMap = await this.dishMapOf(dishIds);

    return {
      date: dto.date,
      confirmed,
      skipped,
      /**
       * ⭐⭐ **本次出餐确认对「订单状态机」做了什么**（M5-8 · 状态机 T7）
       *
       * 这是本端点唯一的**履约副作用**，也是它此前**完全缺失**的那一半：
       * 出餐确认过去只写 `ab_supplier_dish_*`，**从不碰 `ab_order`** —— 于是订单
       * 永远停在 `cut_off`，团长「确认取餐」永远返回零值（且不回错）、**佣金永不产生**。
       */
      orderAdvance,
      dishes: after.map((d) => {
        const rows = afterDetails.filter((r) => r.dishId === d.dishId);
        const confirmedCenters = rows.filter((r) => r.status === DETAIL_CONFIRMED).length;
        return {
          dishId: d.dishId,
          dishName: afterDishMap.get(d.dishId)?.name ?? null,
          status: d.status,
          planQuantity:
            rows.reduce((s, r) => s + Number(r.planQuantity), 0) || Number(d.planQuantity),
          confirmedQuantity: Number(d.actualQuantity ?? 0),
          centerCount: rows.length,
          confirmedCenterCount: confirmedCenters,
        };
      }),
      summary: {
        submitted: dto.items.length,
        confirmed: confirmed.length,
        skipped: skipped.length,
        allDone: after.length > 0 && after.every((d) => d.status === DAILY_DONE),
      },
    };
  }

  // =====================================================================
  // 出餐确认的下游：订单履约推进（状态机 T7 · `cut_off → cooked`）
  // =====================================================================

  /**
   * 把「菜品到齐」的加工场所下的订单推进为 `cooked`（**状态机 T7**）
   *
   * ## 为什么需要它（《缺陷与陷阱》#79 · 2026-09-18 用户裁定「补实现」）
   * `cookConfirm` 此前只写 `ab_supplier_dish_daily` / `..._center_daily`，
   * **从不碰 `ab_order`**；`delivery.service` 也只读 `cut_off` 订单生成配送单、不推状态。
   * 合起来的结果是 `ab_order.status` 里的 `cooked` / `delivering` / `delivered`
   * **全仓零写入点** —— 订单支付后永远停在 `cut_off`，而下游三条链**全部不可达**：
   *   · 团长「确认取餐」（L9 准入 `delivering` / `delivered`）→ 永远返回零值（**且不报错**）
   *   · 自动确认兜底（T11 准入 `delivered`）→ 每天把全部订单报成「履约异常」
   *   · ⭐ **佣金永不产生**（`accrueForOrders` 的两个调用点都在上述不可达分支里）
   * 即「结算跑批天天扫到 0、团长余额永不增加」，而**看起来像「今天没单」**。
   *
   * ## 判据与「加工场所打包」闸门**同源**（刻意的）
   * 某加工场所当日 `plan_quantity > 0` 的明细行**全部** `confirmed` → 该场所「菜到齐」。
   * 这条判据在 `packingTasks()` 的 `ready` 里已经用了（原型 P22「出餐确认后推送给集散中心，
   * 由兼职打包并安排货拉拉配送」）—— 本方法**不另立一套**：
   * 两处各写一遍「什么叫到齐」，将来改一处就会出现「能打包了却不算已出餐」
   * 那种**两边都不报错**的分叉（同 D61 份数口径的教训）。
   *
   * ⚠️ **粒度是「加工场所」而不是「出餐日」**：一份套餐的 4 道菜来自 4 家供应商，
   *    按出餐日整批推进的话，**第一家确认就会把全部订单标成已出餐**（另外 3 道菜还没到），
   *    而用户端时间线上已经亮起「已出餐」。故按订单所属的加工场所分别判定
   *    （订单 → `assignment_id` → `ab_meal_assignment.distribution_center_id`）。
   *
   * ## 幂等
   * 逐单条件更新（`WHERE id = ? AND status = 'cut_off'`），`affected` 判归属：
   * 已被推进过的单 `affected = 0`，跳过、不重复落审计行。故重复确认、多供应商交叉确认、
   * 手动补确认都安全。
   *
   * ⚡ 与 `cutoffByDate` / `autoConfirmByDate` 同一纪律：**逐单判定归属**（不用集合更新），
   *    因为每一次状态迁移都要落一条独立的 `ab_operation_log`（状态机 §2.1.5），
   *    而集合更新不回「哪几行归我」。
   *
   * @param m   出餐确认所在的事务管理器（**必须同事务** —— 见调用点注释）
   * @param date 出餐日（T 日）
   * @param operatorId 操作账号（供应商账号 = admin 域主体）
   */
  private async advanceOrdersToCooked(
    m: EntityManager,
    date: string,
    operatorId: number | null | undefined,
  ): Promise<OrderAdvanceResult> {
    // ---- ① 本轮「菜到齐」的加工场所 -------------------------------------
    const details = await m.find(SupplierDishCenterDaily, { where: { produceDate: date } });
    const byCenter = new Map<number, SupplierDishCenterDaily[]>();
    for (const d of details) {
      const dcId = Number(d.distributionCenterId);
      const list = byCenter.get(dcId) ?? [];
      list.push(d);
      byCenter.set(dcId, list);
    }
    const readyCenterIds: number[] = [];
    for (const [dcId, rows] of byCenter) {
      // 与 packingTasks 的 `ready` 逐字同源：只算应送 > 0 的行
      const effective = rows.filter((r) => Number(r.planQuantity) > 0);
      if (effective.length && effective.every((r) => r.status === DETAIL_CONFIRMED)) {
        readyCenterIds.push(dcId);
      }
    }

    // 该出餐日仍停在 `cut_off` 的订单数（**无论场所是否到齐**）—— 用于把
    // 「今天没单」与「有单但推不动」分开，这是 #79 之所以能隐身的原因
    const stillCutOff = await m.count(Order, {
      where: { mealDate: date, status: OrderStatus.CUT_OFF },
    });

    if (!readyCenterIds.length) {
      return { cooked: 0, readyCenterCount: 0, readyCenters: [], stillCutOff };
    }

    const centers = await m.find(DistributionCenter, { where: { id: In(readyCenterIds) } });

    // ---- ② 场所 → 当日订单（订单的 `assignment_id` 指向「楼群 × 日期」的分配行）----
    const assignments = await m.find(MealAssignment, {
      where: { mealDate: date, distributionCenterId: In(readyCenterIds) },
    });
    const assignIds = assignments.map((a) => Number(a.id));
    if (!assignIds.length) {
      return {
        cooked: 0,
        readyCenterCount: readyCenterIds.length,
        readyCenters: centers.map((c) => ({ centerId: c.id, centerName: c.name })),
        stillCutOff,
      };
    }

    const orders = await m.find(Order, {
      where: {
        mealDate: date,
        status: OrderStatus.CUT_OFF,
        assignmentId: In(assignIds),
      },
      order: { id: 'ASC' },
    });

    // ---- ③ 逐单条件推进 + 落审计行 ---------------------------------------
    const logs: QueryDeepPartialEntity<OperationLog>[] = [];
    let cooked = 0;
    for (const o of orders) {
      const upd = await m
        .createQueryBuilder()
        .update(Order)
        .set({ status: OrderStatus.COOKED, version: () => 'version + 1' })
        .where('id = :id', { id: o.id })
        .andWhere('status = :st', { st: OrderStatus.CUT_OFF })
        .execute();
      if ((upd.affected ?? 0) === 0) continue;

      cooked += 1;
      // 状态机 §2.1.5：每次迁移落 `ab_operation_log`（本方法在事务内，全局拦截器不生效，
      // 故显式写入 —— 与 `cutoffByDate` / `autoConfirmByDate` 同一写法）
      logs.push({
        adminUserId: operatorId ?? null,
        module: 'order',
        action: '出餐推进',
        targetId: String(o.id),
        requestData: { orderNo: o.orderNo, mealDate: date },
        snapshot: {
          fromStatus: OrderStatus.CUT_OFF,
          toStatus: OrderStatus.COOKED,
          // 出餐确认由**供应商账号**发起（admin 域主体）→ source=admin、操作者可追溯
          source: 'admin',
          reason: '供应商出餐确认：该加工场所当日菜品已全部到齐（状态机 T7）',
        },
      });
    }
    if (logs.length) await m.getRepository(OperationLog).insert(logs);

    if (cooked) {
      this.logger.log(
        `出餐推进 date=${date} ${cooked} 单 cut_off → cooked ` +
          `（到齐场所 ${readyCenterIds.length} 个：${centers.map((c) => c.name).join('、')}）` +
          (stillCutOff - cooked > 0 ? ` · 仍有 ${stillCutOff - cooked} 单未推进` : ''),
      );
    }

    return {
      cooked,
      readyCenterCount: readyCenterIds.length,
      readyCenters: centers.map((c) => ({ centerId: c.id, centerName: c.name })),
      stillCutOff,
    };
  }

  // =====================================================================
  // 加工场所打包任务（原 S3 · M4-0 起由运营后台 `GET /admin/packing-tasks` 消费）
  // =====================================================================
  /**
   * 加工场所打包任务派生（原型 P22 下游 · 消费方 = 运营后台「加工场所打包」页）
   *
   * ⚠️⚠️ **M4-0 迁运营后台（自营口径 · 2026-09-16）**：
   *    原可见性判据是「本主体名下有没有启用中的集散中心」（原型 P21/P22 的集散型 / 混合型）。
   *    自营下加工场所**属 ABox 自有**、`ab_distribution_center.supplier_id` 已停用，
   *    该判据随之失效；更要命的是**语义上本来就是错的** —— 本方法必须**全量派生**
   *    （闸门要看到**所有**供应商的到位情况），把它开给供应商就等于让 A 家看到 B 家的
   *    到货明细（I1：不泄露他方经营数据）。故端点整体迁运营后台、供应商端 S3 **下线**
   *    （路由删除 → 10004），本方法不再收 `supplierId`，返回**全部启用中的加工场所**。
   *
   * **前置闸门 `ready`**：该场所当日**所有**应到菜品都已确认送达，才 `ready=true`。
   * 否则列出 `blockers`。这是原型那句「出餐确认后将推送给集散中心，由兼职打包并安排货拉拉配送」
   * 的落地 —— 未到齐就开包，会包出缺菜的餐。
   */
  async packingTasks(q: PackingTasksQueryDto) {
    const centers = await this.dcRepo.find({ where: { status: 1 }, order: { id: 'ASC' } });
    const usable = centers.filter((c) => !c.deletedAt);

    if (!usable.length) {
      return {
        visible: false,
        reason:
          '当前没有启用中的加工场所（D29 未配置或全部停用），没有打包任务。' +
          '（打包任务是 ABox 自有加工场所的作业视图；如已配置场所请确认其状态为「启用」）',
        date: q.date ?? null,
        centers: [],
      };
    }

    const date = q.date ?? (await this.defaultPackingDate());
    // ⚠️ 全量生成（不传 supplierId）：打包闸门要看到**所有**供应商的到位情况，
    //    漏掉任何一家都会让「已到齐」成为假象。
    await this.ensureProducePlan(date);

    const allDetails = await this.detailRepo.find({
      where: { produceDate: date, distributionCenterId: In(usable.map((c) => c.id)) },
    });

    const dailies = await this.dailyRepo.find({ where: { produceDate: date } });
    const dailyOf = new Map(dailies.map((d) => [`${d.supplierId}:${d.dishId}`, d]));
    const dishMap = await this.dishMapOf(dailies.map((d) => d.dishId));
    const supplierNames = await this.supplierNameMap();

    const { groups, assignments } = await this.loadDeliveryContext(date);
    const routeNo = this.routeNoMap(usable);

    const result = usable.map((center) => {
      const rows = allDetails.filter(
        (d) => d.distributionCenterId === center.id && Number(d.planQuantity) > 0,
      );

      const dishes = rows.map((r) => {
        const dish = dishMap.get(r.dishId);
        const key = `${r.supplierId}:${r.dishId}`;
        return {
          supplierId: r.supplierId,
          supplierName: supplierNames.get(r.supplierId) ?? `供应商 ${r.supplierId}`,
          dishId: r.dishId,
          dishName: dish?.name ?? `菜品 ${r.dishId}`,
          unitPriceFen: toFen(Number(dailyOf.get(key)?.unitPrice ?? 0)),
          planQuantity: Number(r.planQuantity),
          actualQuantity: r.actualQuantity ?? null,
          status: r.status,
          confirmedAt: toBjIso(r.confirmedAt),
        };
      });

      const blockers = dishes
        .filter((d) => d.status !== DETAIL_CONFIRMED)
        .map((d) => ({
          supplierName: d.supplierName,
          dishName: d.dishName,
          planQuantity: d.planQuantity,
          status: d.status,
        }));

      // 该中心服务的楼群 → 路线 → 站点（楼栋）
      const myGroups = groups.filter((g) => this.primaryCenterOf(g.id, usable) === center.id);
      const routes = myGroups.map((g) => {
        const stops =
          assignments.buildingOf
            .get(g.id)
            ?.slice()
            .sort((a, b) => a.id - b.id)
            .map((b) => ({ buildingId: b.id, buildingName: b.name, address: b.address })) ?? [];
        return {
          routeNo: routeNo.get(g.id) ?? null,
          buildingGroupId: g.id,
          groupName: g.name,
          quantity: assignments.soldOf.get(g.id) ?? 0,
          stops,
        };
      });

      const batchQuantity = routes.reduce((s, r) => s + r.quantity, 0);

      return {
        centerId: center.id,
        centerName: center.name,
        centerAddress: center.address,
        contactName: center.contactName ?? null,
        contactPhone: center.contactPhone ?? null,
        ready: dishes.length > 0 && blockers.length === 0,
        blockers,
        dishes,
        routes,
        summary: {
          batchQuantity,
          routeCount: routes.length,
          stopCount: routes.reduce((s, r) => s + r.stops.length, 0),
          dishCount: dishes.length,
          confirmedDishCount: dishes.filter((d) => d.status === DETAIL_CONFIRMED).length,
        },
      };
    });

    return {
      visible: true,
      date,
      centers: result,
      notes: {
        scopeRule:
          '本页是**运营后台作业视图**：一次返回**全部启用中的加工场所**（含各场所的供应商到位情况）。' +
          '该信息跨供应商，**不对供应商端开放** —— 原 `GET /supplier/packing-tasks` 已随自营口径下线（M4-0）。',
        gateRule:
          '「可开始打包」= 该加工场所当日所有菜品均已确认送达。未到齐时请先催未确认的供应商，不要开包。',
        routeRule:
          '路线号（R1…Rn）按「主加工场所 id 升序」派生；站点顺序按楼栋 id 升序。' +
          '本接口**不返回距离与单段时长** —— 无地图数据，原型上的 km/分钟是演示值，不做承诺。',
        quantityRule: '打包份数 = 该场所所服务楼群的当日已售份数之和（与用户端下单数同源）。',
      },
    };
  }

  // =====================================================================
  // 生产计划派生
  // =====================================================================

  /**
   * 惰性生成生产计划（幂等）
   *
   * 派生链：`ab_meal_assignment`(active) × `ab_set_meal_item` → 按 (供应商, 菜, 集散中心) 聚合 `sold_count`
   *
   * 三处刻意的取舍：
   *   ① **只生成 `planQuantity > 0` 的明细** —— 应送 0 份的集散中心不需要确认动作，
   *      生成出来只会让 P22 长出一串「0 份」的空卡片。
   *   ② **已有父行不重算** —— 父行是「已冻结的承诺数」。种子 / 运营已备好计划时，
   *      只需补建缺失的**明细**（历史数据只有父行的场景）。
   *   ③ `unit_price` 取 `ab_dish.cost_price`（菜品属性）而非 `ab_set_meal_item.share_amount`
   *      —— 供价是「逐菜协商」的菜品属性，同一道菜在不同套餐里不应有两个供价。
   */
  /**
   * 截单后**覆盖刷新**生产计划量（4.2 第三段 · 由 `tasks/cutoff.task.ts` 委托）
   *
   * ## 为什么需要「覆盖」，而 `ensureProducePlan` 只肯「补齐」
   * 惰性 `ensureProducePlan` 的取舍②是「已有父行不重算」—— 因为父行是**已冻结的承诺数**。
   * 但那条纪律成立的前提是「行是在**销量定格之后**生成的」。而惰性生成让这个前提
   * 可以被绕过：
   *
   * ```
   * T-1 14:00  开团 → 用户下单，sold_count 持续增长
   * T-1 15:00  供应商点开工作台（P21）→ 惰性生成计划，用的却是「此刻」的销量
   *            ↓ 此后 dailyKey 已存在，ensureProducePlan 永不重算
   * T-1 24:00  截单 —— 销量定格，但计划量停在 15:00 的快照上
   * ```
   * 结果就是**备料量系统性偏小**，供应商照着做会不够卖，而且**没有任何地方会报错**。
   * 所以截单这一刻必须把计划量**重算并覆盖**。
   *
   * ## 覆盖的边界（安全阀）
   * 只覆盖父行 `status='pending'`（尚未开工）的行。若某行已被供应商置为
   * `cooking` / `done`（手动补跑晚于出餐），说明**生产已经发生**，此时改计划量
   * 只会让「计划」与「实际已生产」对不上 —— 保持原值并记 warn。
   *
   * ## 与「生成即冻结」不矛盾
   * 冻结的**时点**是截单，不是「首次被访问」。截单前生成的是预估，截单后才是承诺。
   * 本方法正是把「预估」转成「承诺」的那一步；执行完即冻结（cutoff 只跑一次）。
   *
   * @param date 出餐日（T 日）
   */
  async freezeProducePlan(date: string): Promise<ProducePlanFreezeResult> {
    const agg = await this.aggregatePlan(date);
    const { plans, existingDaily, existingDetails, dishMap } = agg;
    const dailyOf = new Map(existingDaily.map((d) => [`${d.supplierId}:${d.dishId}`, d]));
    const detailOf = new Map(
      existingDetails.map((d) => [`${d.supplierId}:${d.dishId}:${d.distributionCenterId}`, d]),
    );

    const insDaily: Array<Partial<SupplierDishDaily>> = [];
    const insDetails: Array<Partial<SupplierDishCenterDaily>> = [];
    let updatedDaily = 0;
    let updatedDetails = 0;
    let skippedFrozen = 0;
    let totalQuantity = 0;

    for (const plan of plans.values()) {
      // 与原实现同一条纪律：不生成 0 份的计划（否则 P21 长出一串空卡片）
      if (plan.total <= 0) continue;
      totalQuantity += plan.total;

      const key = `${plan.supplierId}:${plan.dishId}`;
      const existed = dailyOf.get(key);
      if (!existed) {
        insDaily.push({
          supplierId: plan.supplierId,
          dishId: plan.dishId,
          produceDate: date,
          planQuantity: plan.total,
          unitPrice: dishMap.get(plan.dishId)?.costPrice ?? '0.00',
          status: DAILY_PENDING,
        });
      } else if (existed.status === DAILY_PENDING && Number(existed.planQuantity) !== plan.total) {
        await this.dailyRepo.update(
          { id: existed.id },
          { planQuantity: plan.total, version: (existed.version ?? 0) + 1 },
        );
        updatedDaily += 1;
      } else if (existed.status !== DAILY_PENDING) {
        skippedFrozen += 1;
      }

      for (const [dcId, qty] of plan.centers) {
        if (qty <= 0) continue;
        const dKey = `${key}:${dcId}`;
        const existedDetail = detailOf.get(dKey);
        if (!existedDetail) {
          insDetails.push({
            supplierId: plan.supplierId,
            dishId: plan.dishId,
            produceDate: date,
            distributionCenterId: dcId,
            planQuantity: qty,
            status: DETAIL_PENDING,
          });
        } else if (
          existedDetail.status === DETAIL_PENDING &&
          Number(existedDetail.planQuantity) !== qty
        ) {
          await this.detailRepo.update(
            { id: existedDetail.id },
            { planQuantity: qty, version: (existedDetail.version ?? 0) + 1 },
          );
          updatedDetails += 1;
        }
      }
    }

    if (insDaily.length) await this.dailyRepo.save(this.dailyRepo.create(insDaily));
    if (insDetails.length) await this.detailRepo.save(this.detailRepo.create(insDetails));

    this.logger.log(
      `截单刷新生产计划 date=${date} 合计 ${totalQuantity} 份 ` +
        `父行（新增 ${insDaily.length} / 更新 ${updatedDaily}）` +
        `明细（新增 ${insDetails.length} / 更新 ${updatedDetails}）` +
        (skippedFrozen ? ` 已开工跳过 ${skippedFrozen}` : ''),
    );
    if (skippedFrozen) {
      this.logger.warn(
        `date=${date} 有 ${skippedFrozen} 道菜的生产计划已开工（cooking/done），` +
          '未按截单量覆盖 —— 请人工核对是否漏产',
      );
    }

    return {
      date,
      totalQuantity,
      createdDaily: insDaily.length,
      updatedDaily,
      createdDetails: insDetails.length,
      updatedDetails,
      skippedStarted: skippedFrozen,
      supplierCount: new Set([...plans.values()].map((p) => p.supplierId)).size,
    };
  }

  /**
   * 聚合「某日各供应商各菜、按加工场所分别多少份」
   *
   * `ensureProducePlan`（补齐）与 `freezeProducePlan`（覆盖）共用本方法 ——
   * 两处若各写一遍聚合，迟早出现「补齐时说 100 份、覆盖时说 120 份」这种自相矛盾。
   */
  private async aggregatePlan(date: string, onlySupplierId?: number) {
    const assignments = await this.maRepo.find({ where: { mealDate: date, status: 'active' } });
    const usable = assignments.filter((a) => a.distributionCenterId);

    const plans = new Map<string, DerivedPlan>();
    if (usable.length) {
      const setMealIds = [...new Set(usable.map((a) => a.setMealId))];
      const items = setMealIds.length
        ? await this.itemRepo.find({ where: { setMealId: In(setMealIds) } })
        : [];
      const itemsOf = new Map<number, SetMealItem[]>();
      for (const it of items) {
        const list = itemsOf.get(it.setMealId) ?? [];
        list.push(it);
        itemsOf.set(it.setMealId, list);
      }

      // 聚合：一道菜在同一天要分别送几个加工场所各多少份
      for (const a of usable) {
        const dcId = a.distributionCenterId as number;
        for (const it of itemsOf.get(a.setMealId) ?? []) {
          if (onlySupplierId && it.supplierId !== onlySupplierId) continue;
          const key = `${it.supplierId}:${it.dishId}`;
          const plan =
            plans.get(key) ??
            ({
              supplierId: it.supplierId,
              dishId: it.dishId,
              total: 0,
              centers: new Map(),
            } as DerivedPlan);
          plan.total += a.soldCount;
          plan.centers.set(dcId, (plan.centers.get(dcId) ?? 0) + a.soldCount);
          plans.set(key, plan);
        }
      }
    }

    const [existingDaily, existingDetails] = await Promise.all([
      this.dailyRepo.find({ where: { produceDate: date } }),
      this.detailRepo.find({ where: { produceDate: date } }),
    ]);
    const dishMap = await this.dishMapOf([...plans.values()].map((p) => p.dishId));

    return { plans, existingDaily, existingDetails, dishMap };
  }

  private async ensureProducePlan(date: string, onlySupplierId?: number): Promise<void> {
    const { plans, existingDaily, existingDetails, dishMap } = await this.aggregatePlan(
      date,
      onlySupplierId,
    );
    if (!plans.size) return;

    const dailyKey = new Set(existingDaily.map((d) => `${d.supplierId}:${d.dishId}`));
    const detailKey = new Set(
      existingDetails.map((d) => `${d.supplierId}:${d.dishId}:${d.distributionCenterId}`),
    );

    const newDaily: Array<Partial<SupplierDishDaily>> = [];
    const newDetails: Array<Partial<SupplierDishCenterDaily>> = [];

    for (const plan of plans.values()) {
      // ⚠️ 只生成**确有产量**的计划：`status=active` 但 `sold_count=0` 的分配很常见
      //    （种子即有 —— bg3 用 setMeal2 但一份没卖），照单生成会让供应商在 P21
      //    看到一串「0 份」的菜，而它们根本没有生产任务。
      if (plan.total <= 0) continue;
      const key = `${plan.supplierId}:${plan.dishId}`;
      if (!dailyKey.has(key)) {
        newDaily.push({
          supplierId: plan.supplierId,
          dishId: plan.dishId,
          produceDate: date,
          planQuantity: plan.total,
          unitPrice: dishMap.get(plan.dishId)?.costPrice ?? '0.00',
          status: DAILY_PENDING,
        });
      }
      for (const [dcId, qty] of plan.centers) {
        if (qty <= 0) continue;
        if (detailKey.has(`${key}:${dcId}`)) continue;
        newDetails.push({
          supplierId: plan.supplierId,
          dishId: plan.dishId,
          produceDate: date,
          distributionCenterId: dcId,
          planQuantity: qty,
          status: DETAIL_PENDING,
        });
      }
    }

    if (newDaily.length) await this.dailyRepo.save(this.dailyRepo.create(newDaily));
    if (newDetails.length) await this.detailRepo.save(this.detailRepo.create(newDetails));
    if (newDaily.length || newDetails.length) {
      this.logger.log(
        `出餐计划生成 date=${date} 父行+${newDaily.length} 明细+${newDetails.length}` +
          (onlySupplierId ? `（仅供应商 ${onlySupplierId}）` : '（全量）'),
      );
    }
  }

  // =====================================================================
  // 校验 / 工具
  // =====================================================================

  /** 取当前账号绑定的供应商（未绑定 / 已停用一律 50006） */
  private async loadSupplier(supplierId: number | null | undefined): Promise<Supplier> {
    if (!supplierId) {
      throw new BizException(
        ErrorCode.SUPPLIER_NOT_FOUND,
        '当前账号未绑定供应商，无法查看出餐任务（请联系运营在后台「账号管理」中绑定）',
      );
    }
    const s = await this.supplierRepo.findOne({ where: { id: supplierId } });
    if (!s || s.status !== SupplierStatus.ACTIVE) {
      throw new BizException(ErrorCode.SUPPLIER_NOT_FOUND, '供应商不存在或已停用');
    }
    return s;
  }

  /** 出餐前置：合作中 ∧ 资质已通过 ∧ 证照未过期（与 D23 `canServe` 同一判据） */
  private assertCanServe(s: Supplier): void {
    if (this.canServe(s)) return;
    const reason =
      s.status !== SupplierStatus.ACTIVE
        ? '合作已停用'
        : s.auditStatus !== SupplierAuditStatus.APPROVED
          ? `资质${SUPPLIER_AUDIT_STATUS_LABEL[s.auditStatus as keyof typeof SUPPLIER_AUDIT_STATUS_LABEL] ?? s.auditStatus}`
          : '证照已过期';
    throw new BizException(
      ErrorCode.SUPPLIER_NOT_QUALIFIED,
      `当前不能出餐（${reason}）—— 请补充或更新资质后由运营重新核验`,
    );
  }

  /** 时间闸门：迟于出餐日 09:30 → 50009（fail-closed） */
  private assertNotOverdue(date: string): void {
    const deadline = this.deadlineOf(date);
    if (Date.now() <= deadline.getTime()) return;
    throw new BizException(
      ErrorCode.COOK_CONFIRM_OVERDUE,
      `出餐确认截止时间为出餐日当天 ${CONFIRM_DEADLINE_TEXT}，本次针对 ${date} 的确认已超时。` +
        '为避免记录失真，系统不再受理补确认 —— 请联系运营线下处理。',
    );
  }

  private deadlineOf(date: string): Date {
    return bjDateTime(date, CONFIRM_DEADLINE_HOUR, CONFIRM_DEADLINE_MINUTE);
  }

  private canServe(s: Supplier): boolean {
    return (
      s.status === SupplierStatus.ACTIVE &&
      s.auditStatus === SupplierAuditStatus.APPROVED &&
      this.licenseStateOf(s.licenseExpireAt) !== LicenseState.EXPIRED
    );
  }

  /** 证照有效期档位（派生值，不落库）—— 与 D23/D25 同一口径 */
  private licenseStateOf(expire?: string | null): LicenseState {
    if (!expire) return LicenseState.UNKNOWN;
    const today = todayBj();
    if (expire < today) return LicenseState.EXPIRED;
    if (expire <= addDays(today, LICENSE_EXPIRING_DAYS)) return LicenseState.EXPIRING;
    return LicenseState.NORMAL;
  }

  /** `date` 缺省：该供应商「最近一个有生产计划的出餐日」，无则明日 */
  private async defaultDate(supplierId: number): Promise<string> {
    const today = todayBj();
    const row = await this.dailyRepo
      .createQueryBuilder('d')
      .select('MIN(d.produce_date)', 'date')
      .where('d.supplier_id = :supplierId AND d.produce_date >= :today', { supplierId, today })
      .getRawOne<{ date: string | null }>();
    return row?.date ?? tomorrowBj();
  }

  /**
   * 打包任务的 `date` 缺省：**全局**最近一个有生产计划的出餐日，无则明日
   *
   * ⚠️ 刻意**不复用** `defaultDate(supplierId)`：那个是本主体范围。打包页要看到所有场所 /
   *    所有供应商，缺省日也必须取全局 —— 否则「本主体当日无计划、别家有」的日子会被判成空。
   */
  private async defaultPackingDate(): Promise<string> {
    const today = todayBj();
    const row = await this.dailyRepo
      .createQueryBuilder('d')
      .select('MIN(d.produce_date)', 'date')
      .where('d.produce_date >= :today', { today })
      .getRawOne<{ date: string | null }>();
    return row?.date ?? tomorrowBj();
  }

  private async dishMapOf(ids: number[]): Promise<Map<number, Dish>> {
    const uniq = [...new Set(ids)].filter((id) => Number.isFinite(id));
    if (!uniq.length) return new Map();
    const rows = await this.dishRepo.find({ where: { id: In(uniq) } });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async centerMapOf(ids: number[]): Promise<Map<number, DistributionCenter>> {
    const uniq = [...new Set(ids)].filter((id) => Number.isFinite(id));
    if (!uniq.length) return new Map();
    const rows = await this.dcRepo.find({ where: { id: In(uniq), deletedAt: IsNull() } });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async supplierNameMap(): Promise<Map<number, string>> {
    const rows = await this.supplierRepo.find();
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private groupByDish(rows: SupplierDishCenterDaily[]): Map<number, SupplierDishCenterDaily[]> {
    const map = new Map<number, SupplierDishCenterDaily[]>();
    for (const r of rows) {
      const list = map.get(r.dishId) ?? [];
      list.push(r);
      map.set(r.dishId, list);
    }
    return map;
  }

  /**
   * 配送上下文：启用中的楼群 + 楼群→楼栋 + 楼群→当日已售份数
   *
   * ⚠️ 与 `building-admin.service.routeNoMap()` **同口径**（路线号按主集散中心 id 升序）。
   *    两处各自实现是刻意的：跨模块 import 会在「办公楼模块」与「供应商模块」间
   *    拉出一条服务依赖链，而这段逻辑只有十几行、且变更是全局性的（要改一起改）。
   */
  private async loadDeliveryContext(date: string) {
    const [groups, buildings, assignments] = await Promise.all([
      this.groupRepo.find({ where: { status: 1 } }),
      this.buildingRepo.find({ where: { deletedAt: IsNull() } }),
      this.maRepo.find({ where: { mealDate: date, status: 'active' } }),
    ]);

    const buildingOf = new Map<number, Building[]>();
    for (const b of buildings) {
      if (!b.buildingGroupId) continue;
      const list = buildingOf.get(b.buildingGroupId) ?? [];
      list.push(b);
      buildingOf.set(b.buildingGroupId, list);
    }

    const soldOf = new Map<number, number>();
    for (const a of assignments) {
      soldOf.set(a.buildingGroupId, (soldOf.get(a.buildingGroupId) ?? 0) + a.soldCount);
    }

    return { groups: groups.filter((g) => !g.deletedAt), assignments: { buildingOf, soldOf } };
  }

  /**
   * 楼群 → 主集散中心（服务该楼群、启用中 id 最小者）
   * 与 `building-admin.service.centerPair()` 同口径。
   */
  private primaryCenterOf(groupId: number, centers: DistributionCenter[]): number | null {
    const serving = centers
      .filter((c) => (c.serviceGroups ?? []).includes(groupId))
      .sort((a, b) => a.id - b.id);
    return serving.length ? serving[0].id : null;
  }

  /** 楼群 → 路线号（R1…Rn）· 按主集散中心 id 升序编号 */
  private routeNoMap(centers: DistributionCenter[]): Map<number, string> {
    const groupIds = new Set<number>();
    for (const c of centers) for (const g of c.serviceGroups ?? []) groupIds.add(g);

    const withPrimary = [...groupIds]
      .map((g) => ({ groupId: g, centerId: this.primaryCenterOf(g, centers) }))
      .filter((x) => x.centerId !== null) as Array<{ groupId: number; centerId: number }>;

    const centerOrder = [...new Set(withPrimary.map((x) => x.centerId))].sort((a, b) => a - b);
    const noOf = new Map<number, string>();
    withPrimary
      .sort((a, b) => {
        const d = centerOrder.indexOf(a.centerId) - centerOrder.indexOf(b.centerId);
        return d !== 0 ? d : a.groupId - b.groupId;
      })
      .forEach((x, i) => noOf.set(x.groupId, `R${i + 1}`));
    return noOf;
  }
}

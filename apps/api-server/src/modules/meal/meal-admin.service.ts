import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { BizConfigService } from '../../common/services/biz-config.service';
import { paginate, PageResult } from '../../common/utils/response';
import {
  addDays,
  cutoffAtOf,
  isAfterCutoff,
  isDateStr,
  toBjIso,
  todayBj,
} from '../../common/utils/time';
import { Building, BuildingGroup } from '../../database/entities/building.entity';
import { DistributionCenter } from '../../database/entities/finance.entity';
import { MealAssignment, SetMeal, SetMealItem } from '../../database/entities/meal.entity';
import { Dish, Supplier } from '../../database/entities/supplier.entity';
import {
  CopyAssignmentsDto,
  CreateAssignmentDto,
  CreateSetMealTemplateDto,
  MATRIX_MAX_DAYS,
  MealMatrixQueryDto,
  SetMealTemplateQueryDto,
  UpdateAssignmentDto,
} from './dto/meal-admin.dto';
import { SLOT_LABEL } from './dto/meal.dto';

/** 矩阵网格数上限（dates × groups）：超过则拒绝，避免一次查询把端上撑爆 */
const MAX_CELLS = 400;

/** 分配状态 → 说明（与 ab_meal_assignment.status 一致） */
const STATUS_HINT: Record<string, string> = {
  pending: '已排期未上架',
  active: '已上架',
  cancelled: '已取消',
};

interface MatrixGroup {
  id: number;
  name: string;
  buildingIds: number[];
  /** 楼群内 status=1（合作中）的办公楼 —— 即「已分配」 */
  assignedBuildings: number[];
  /** 楼群内 status≠1（停用 / 待分配）的办公楼 —— 即 D1 契约里的 emptyBuildings */
  emptyBuildings: number[];
}

interface MatrixCell {
  mealDate: string;
  groupId: number;
  assignmentId: number | null;
  setMealId: number | null;
  setMealName: string | null;
  setMealPriceFen: number | null;
  status: string | null;
  statusHint: string | null;
  dishCount: number;
  distributionCenterId: number | null;
  distributionCenterName: string | null;
  assignedBuildings: number[];
  emptyBuildings: number[];
  soldCount: number;
  /** 是否已过硬截单时刻（T 日 00:00）—— 已截单则不可再上架 */
  cutoffPassed: boolean;
  canPublish: boolean;
}

interface TemplateRow {
  id: number;
  name: string | null;
  priceFen: number;
  costPriceFen: number;
  oneLiner: string | null;
  status: number;
  statusText: string;
  dishCount: number;
  items: Array<{
    dishId: number;
    slot: number;
    slotLabel: string;
    name: string;
    supplierId: number;
  }>;
  usedCount: number;
}

/**
 * 后台 · 套餐编排服务（《接口规范 v1.0》§6.1 D1–D7）
 *
 * ## 与 `MealService` 的分工
 * `MealService` 服务**用户端**（U1/U2/U3），只读且受 C8 约束（严禁吐供价/供应商状态）；
 * 本服务服务**运营后台**，可读写，且**必须**给出成本与供应商维度信息。
 * 两者共用 `ab_meal_assignment` 这一张表 —— 后台改的东西，用户端下一个请求就能看到，
 * 这正是「编排 → 上架 → 用户可下单」闭环的基础。
 *
 * ## 三个必须守住的契约（否则用户端与后台会各说各话）
 * 1. **`ab_meal_assignment` 的粒度是「出餐日 × 楼群」**，没有「楼栋级分配」表。
 *    因此 D1 的 `assignedBuildings` / `emptyBuildings` 是**派生值**：
 *    楼群内 `status=1`（合作中）的楼栋算已分配，`status≠1`（停用 / 待分配）算未分配。
 *    原型 P27 里「C 座 · 待分配」是禁用复选框，与本口径同源。
 * 2. **创建 ≠ 上架**：D2 建出来的分配是 `pending`，用户端看到的是「今日未开团」；
 *    必须再走 D4 `publish` 才变 `active`、用户端才 `canOrder=true`。
 *    两步分离的意义是「编排可以提前几天做，开团是临近时的动作」。
 * 3. **已过硬截单（T 日 00:00）不许再上架** → `30013`。
 *    放行的话用户端会显示「可下单」，但下单必被截单硬闸（`30001`）拦下 ——
 *    等于让运营亲手制造一个「看得见点不动」的套餐。
 */
@Injectable()
export class MealAdminService {
  private readonly logger = new Logger('MealAdmin');

  constructor(
    @InjectRepository(MealAssignment) private readonly assignmentRepo: Repository<MealAssignment>,
    @InjectRepository(SetMeal) private readonly setMealRepo: Repository<SetMeal>,
    @InjectRepository(SetMealItem) private readonly itemRepo: Repository<SetMealItem>,
    @InjectRepository(Dish) private readonly dishRepo: Repository<Dish>,
    @InjectRepository(Supplier) private readonly supplierRepo: Repository<Supplier>,
    @InjectRepository(DistributionCenter) private readonly dcRepo: Repository<DistributionCenter>,
    @InjectRepository(BuildingGroup) private readonly groupRepo: Repository<BuildingGroup>,
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    private readonly bizConfig: BizConfigService,
    private readonly dataSource: DataSource,
  ) {}

  // ==========================================================================
  // D1 · 日期 × 楼群 二维矩阵
  // ==========================================================================

  /**
   * 矩阵返回**完整网格**（dates × groups 每格都有 cell，无分配时 `assignmentId=null`）。
   * 只回「有分配的格子」会让前端不得不自己拼空格，且「哪几天漏排了」这件事
   * 恰恰是运营最需要一眼看到的 —— 空格子本身就是信息。
   */
  async matrix(q: MealMatrixQueryDto) {
    const startDate = q.startDate ?? todayBj();
    const endDate = q.endDate ?? addDays(startDate, 6);

    if (endDate < startDate) {
      throw new BizException(ErrorCode.PARAM_INVALID, 'endDate 不能早于 startDate');
    }
    const dates = dateRange(startDate, endDate);
    if (dates.length > MATRIX_MAX_DAYS) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `一次最多查询 ${MATRIX_MAX_DAYS} 天（当前 ${dates.length} 天）`,
      );
    }

    const groups = await this.groupRepo.find({ where: { status: 1 }, order: { id: 'ASC' } });
    if (dates.length * groups.length > MAX_CELLS) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `网格过大（${dates.length} 天 × ${groups.length} 楼群 = ${dates.length * groups.length} 格，上限 ${MAX_CELLS}）`,
      );
    }

    const [allBuildings, assignments] = await Promise.all([
      this.buildingRepo.find(),
      this.assignmentRepo
        .createQueryBuilder('a')
        .where('a.meal_date BETWEEN :s AND :e', { s: startDate, e: endDate })
        .getMany(),
    ]);
    // ⚠️ 不在 SQL 里写 `building_group_id != NULL`（SQL 三值逻辑下恒为假 → 一行都查不到），
    //    改为取全量后在内存过滤。办公楼数量是「几十」量级，成本可忽略。
    const buildings = allBuildings.filter(
      (b) => b.buildingGroupId !== null && b.buildingGroupId !== undefined,
    );

    const grouped: MatrixGroup[] = groups.map((g) => {
      const mine = buildings.filter((b) => b.buildingGroupId === g.id);
      return {
        id: g.id,
        name: g.name,
        buildingIds: mine.map((b) => b.id),
        assignedBuildings: mine.filter((b) => b.status === 1).map((b) => b.id),
        emptyBuildings: mine.filter((b) => b.status !== 1).map((b) => b.id),
      };
    });

    // 批量取套餐名 / 菜品数 / 集散中心名，避免网格里 N+1 查询
    const setMealIds = [...new Set(assignments.map((a) => a.setMealId))];
    const dcIds = [
      ...new Set(
        assignments
          .map((a) => a.distributionCenterId)
          .filter((v): v is number => typeof v === 'number'),
      ),
    ];

    const [setMeals, itemCounts, dcs] = await Promise.all([
      setMealIds.length ? this.setMealRepo.find({ where: { id: In(setMealIds) } }) : [],
      setMealIds.length
        ? this.itemRepo
            .createQueryBuilder('i')
            .select('i.set_meal_id', 'setMealId')
            .addSelect('COUNT(*)', 'n')
            .where('i.set_meal_id IN (:...ids)', { ids: setMealIds })
            .groupBy('i.set_meal_id')
            .getRawMany<{ setMealId: number; n: string }>()
        : [],
      dcIds.length ? this.dcRepo.find({ where: { id: In(dcIds) } }) : [],
    ]);

    const setMealMap = new Map(setMeals.map((s) => [s.id, s]));
    const dishCountMap = new Map(itemCounts.map((r) => [Number(r.setMealId), Number(r.n)]));
    const dcMap = new Map(dcs.map((d) => [d.id, d]));
    const asgMap = new Map(assignments.map((a) => [`${a.mealDate}#${a.buildingGroupId}`, a]));

    const cells: MatrixCell[] = [];
    let assignedCells = 0;
    let publishedCells = 0;
    let totalSold = 0;

    for (const date of dates) {
      for (const g of grouped) {
        const a = asgMap.get(`${date}#${g.id}`) ?? null;
        const sm = a ? setMealMap.get(a.setMealId) : null;
        const cutoffPassed = isAfterCutoff(date);
        if (a) {
          assignedCells += 1;
          if (a.status === 'active') publishedCells += 1;
          totalSold += a.soldCount ?? 0;
        }
        cells.push({
          mealDate: date,
          groupId: g.id,
          assignmentId: a?.id ?? null,
          setMealId: a?.setMealId ?? null,
          setMealName: sm?.name ?? null,
          setMealPriceFen: sm ? Math.round(Number(sm.price) * 100) : null,
          status: a?.status ?? null,
          statusHint: a ? (STATUS_HINT[a.status] ?? a.status) : null,
          dishCount: a ? (dishCountMap.get(a.setMealId) ?? 0) : 0,
          distributionCenterId: a?.distributionCenterId ?? null,
          distributionCenterName: a?.distributionCenterId
            ? (dcMap.get(a.distributionCenterId)?.name ?? null)
            : null,
          assignedBuildings: g.assignedBuildings,
          emptyBuildings: g.emptyBuildings,
          soldCount: a?.soldCount ?? 0,
          cutoffPassed,
          // 无分配可上架吗？不可 —— 上架的前提是先有分配（D2）
          canPublish: !!a && !cutoffPassed,
        });
      }
    }

    return {
      startDate,
      endDate,
      dates,
      groups: grouped,
      cells,
      stats: {
        dateCount: dates.length,
        groupCount: grouped.length,
        cellCount: cells.length,
        assignedCells,
        publishedCells,
        emptyCells: cells.length - assignedCells,
        totalSold,
      },
      note:
        'assignedBuildings = 楼群内「合作中」办公楼；emptyBuildings = 停用 / 待分配办公楼（UI 以禁用复选框呈现）。' +
        '单元格 status：pending 已排期未上架 / active 已上架 / cancelled 已取消。',
    };
  }

  // ==========================================================================
  // D2 · 创建套餐分配
  // ==========================================================================

  async createAssignment(dto: CreateAssignmentDto) {
    await this.assertSetMeal(dto.setMealId);
    await this.assertGroup(dto.buildingGroupId);
    if (dto.distributionCenterId) await this.assertDistributionCenter(dto.distributionCenterId);

    const existing = await this.assignmentRepo.findOne({
      where: { mealDate: dto.mealDate, buildingGroupId: dto.buildingGroupId },
    });

    if (existing && existing.status !== 'cancelled') {
      throw new BizException(
        ErrorCode.MEAL_ASSIGNMENT_EXISTS,
        `${dto.mealDate} 该楼群已有套餐分配（#${existing.id}），请直接编辑`,
      );
    }

    // 已取消的历史行复用（唯一索引 uk_meal_assignment_date_group 占着这个位）
    if (existing) {
      existing.setMealId = dto.setMealId;
      existing.distributionCenterId = dto.distributionCenterId ?? null;
      existing.status = 'pending';
      existing.publishAt = null;
      existing.cutoffAt = cutoffAtOf(dto.mealDate);
      existing.soldCount = 0;
      await this.assignmentRepo.save(existing);
      this.logger.log(
        `复用已取消的分配 #${existing.id}（${dto.mealDate} / 楼群 ${dto.buildingGroupId}）`,
      );
      return this.assignmentView(existing);
    }

    const saved = await this.assignmentRepo.save(
      this.assignmentRepo.create({
        mealDate: dto.mealDate,
        buildingGroupId: dto.buildingGroupId,
        setMealId: dto.setMealId,
        distributionCenterId: dto.distributionCenterId ?? null,
        status: 'pending',
        // pending 阶段不写 publishAt（它记录的是「实际开团时刻」）；cutoff_at 由日期决定，先冗余落库
        cutoffAt: cutoffAtOf(dto.mealDate),
        soldCount: 0,
      }),
    );
    return this.assignmentView(saved);
  }

  // ==========================================================================
  // D3 · 编辑套餐分配
  // ==========================================================================

  /**
   * 只允许改「套餐」与「集散中心」。
   * 改「出餐日 / 楼群」不在这里 —— 那等于换成另一条分配，语义上是「删旧建新」，
   * 混进 PUT 会让幂等与操作日志的「改前值 / 改后值」都失去意义。
   * 已过截单日期的分配不可再改（订单已产生，改套餐会让「用户买到的」与「后台记的」不一致）。
   */
  async updateAssignment(id: number, dto: UpdateAssignmentDto) {
    const a = await this.assignmentRepo.findOne({ where: { id } });
    if (!a) throw new BizException(ErrorCode.MEAL_ASSIGNMENT_NOT_FOUND);

    if (isAfterCutoff(a.mealDate)) {
      throw new BizException(
        ErrorCode.ORDER_STATUS_ILLEGAL,
        `${a.mealDate} 已截单，不能再修改套餐分配`,
      );
    }

    if (dto.setMealId !== undefined) {
      await this.assertSetMeal(dto.setMealId);
      a.setMealId = dto.setMealId;
    }
    if (dto.distributionCenterId !== undefined) {
      await this.assertDistributionCenter(dto.distributionCenterId);
      a.distributionCenterId = dto.distributionCenterId;
    }

    await this.assignmentRepo.save(a);
    return this.assignmentView(a);
  }

  // ==========================================================================
  // D4 · 上架 / 下架
  // ==========================================================================

  /**
   * `publish`：pending → active（写 `publish_at` = 当前时刻，`cutoff_at` = T 日 00:00）
   * `unpublish`：active → pending（清 `publish_at`）
   *
   * **幂等**：重复上架 / 重复下架都返回当前状态，不报错 —— 运营双击按钮不该看到红字。
   * 注意这与「按 `Idempotency-Key` 去重」是两套机制：这里的状态迁移本身天然幂等，
   * 不需要调用方额外带幂等键。
   *
   * ⚠️ 下架**不设**截单闸门：紧急下架是安全阀（套餐出问题要立刻停止接单）。
   *    已产生的订单不受影响，需要退款走 D11 强制退款。
   */
  async publishAssignment(id: number, action: 'publish' | 'unpublish') {
    const a = await this.assignmentRepo.findOne({ where: { id } });
    if (!a) throw new BizException(ErrorCode.MEAL_ASSIGNMENT_NOT_FOUND);

    if (action === 'publish') {
      if (a.status === 'active') return this.assignmentView(a);
      if (isAfterCutoff(a.mealDate)) {
        throw new BizException(
          ErrorCode.MEAL_PUBLISH_AFTER_CUTOFF,
          `${a.mealDate} 已过截单时刻（T 日 00:00），上架后用户端也无法下单`,
        );
      }
      a.status = 'active';
      a.publishAt = new Date();
      a.cutoffAt = cutoffAtOf(a.mealDate);
    } else {
      if (a.status === 'pending') return this.assignmentView(a);
      a.status = 'pending';
      a.publishAt = null;
    }

    await this.assignmentRepo.save(a);
    return this.assignmentView(a);
  }

  // ==========================================================================
  // D5 · 批量复制
  // ==========================================================================

  /**
   * 把某日的编排复制到若干目标日期。
   *
   * 三条口径（都是为了让「复制」这个动作**不会悄悄改变已有安排**）：
   * 1. **不覆盖**：目标日已有该楼群的分配 → 跳过并在 `skipped[]` 里说明原因。
   *    运营复制时最怕的就是「覆盖了我昨天精心调过的排期」。
   * 2. **一律重置为 `pending`**：绝不能把源日的 `active` 复制成目标日也 `active` ——
   *    那样会绕过 D4 的开团动作，让未来若干天的套餐同时对外可下单。
   * 3. **已截单的目标日跳过**：过去的日期补排餐没有意义。
   */
  async copyAssignments(dto: CopyAssignmentsDto) {
    const sources = await this.assignmentRepo.find({
      where: {
        mealDate: dto.fromDate,
        ...(dto.buildingGroupIds?.length ? { buildingGroupId: In(dto.buildingGroupIds) } : {}),
      },
      order: { buildingGroupId: 'ASC' },
    });

    if (sources.length === 0) {
      throw new BizException(
        ErrorCode.MEAL_ASSIGNMENT_NOT_FOUND,
        `${dto.fromDate} 没有可复制的套餐分配`,
      );
    }

    // 去重 + 排除源日本身（把 9-16 复制到 9-16 是无操作，不该报错也不该算创建）
    const targets = [...new Set(dto.targetDates)].filter((d) => d !== dto.fromDate);

    const created: Array<{ mealDate: string; buildingGroupId: number; assignmentId: number }> = [];
    const skipped: Array<{ mealDate: string; buildingGroupId: number; reason: string }> = [];

    if (targets.length === 0) {
      return {
        fromDate: dto.fromDate,
        targetDates: [],
        created,
        createdCount: 0,
        skipped,
        skippedCount: 0,
        note: '目标日期里没有需要复制的日期（与源日相同已自动剔除）。',
      };
    }

    const sourceGroupIds = [...new Set(sources.map((s) => s.buildingGroupId))];
    const existing = await this.assignmentRepo
      .createQueryBuilder('a')
      .where('a.meal_date IN (:...dates)', { dates: targets })
      .andWhere('a.building_group_id IN (:...gids)', { gids: sourceGroupIds })
      .getMany();
    const taken = new Set(existing.map((a) => `${a.mealDate}#${a.buildingGroupId}`));

    const rows: MealAssignment[] = [];
    for (const date of targets) {
      for (const s of sources) {
        if (isAfterCutoff(date)) {
          skipped.push({ mealDate: date, buildingGroupId: s.buildingGroupId, reason: '已截单' });
          continue;
        }
        if (taken.has(`${date}#${s.buildingGroupId}`)) {
          skipped.push({
            mealDate: date,
            buildingGroupId: s.buildingGroupId,
            reason: '已存在分配',
          });
          continue;
        }
        rows.push(
          this.assignmentRepo.create({
            mealDate: date,
            buildingGroupId: s.buildingGroupId,
            setMealId: s.setMealId,
            distributionCenterId: s.distributionCenterId ?? null,
            status: 'pending',
            publishAt: null,
            cutoffAt: cutoffAtOf(date),
            soldCount: 0,
          }),
        );
      }
    }

    if (rows.length) {
      // 一个事务写入：批量复制的语义是「要么都建好，要么都不建」，
      // 部分成功会让运营无法判断到底哪几天已经排好了。
      const saved = await this.dataSource.transaction((m) => m.save(rows));
      for (const s of saved) {
        created.push({
          mealDate: s.mealDate,
          buildingGroupId: s.buildingGroupId,
          assignmentId: s.id,
        });
      }
    }

    return {
      fromDate: dto.fromDate,
      targetDates: targets,
      created,
      createdCount: created.length,
      skipped,
      skippedCount: skipped.length,
      note: '复制出的分配一律为 pending（未上架），需另行上架才会对用户端开放下单。',
    };
  }

  // ==========================================================================
  // D6 · 套餐模板库
  // ==========================================================================

  async listTemplates(q: SetMealTemplateQueryDto): Promise<PageResult<TemplateRow>> {
    const page = Number(q.page) >= 1 ? Math.floor(Number(q.page)) : 1;
    const pageSize = q.pageSize ? Math.min(Math.max(Math.floor(q.pageSize), 1), 100) : 20;

    const qb = this.setMealRepo.createQueryBuilder('s');
    if (q.keyword) qb.andWhere('s.name LIKE :kw', { kw: `%${q.keyword}%` });
    if (q.status !== undefined) qb.andWhere('s.status = :st', { st: q.status });
    qb.orderBy('s.id', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [rows, total] = await qb.getManyAndCount();
    const ids = rows.map((r) => r.id);
    const items = ids.length
      ? await this.itemRepo.find({ where: { setMealId: In(ids) }, order: { slot: 'ASC' } })
      : [];
    const dishIds = [...new Set(items.map((i) => i.dishId))];
    const dishes = dishIds.length ? await this.dishRepo.find({ where: { id: In(dishIds) } }) : [];
    const dishMap = new Map(dishes.map((d) => [d.id, d]));

    // 该模板被多少个「未取消的分配」用过 —— 模板库里最有用的一列
    const used = ids.length
      ? await this.assignmentRepo
          .createQueryBuilder('a')
          .select('a.set_meal_id', 'setMealId')
          .addSelect('COUNT(*)', 'n')
          .where('a.set_meal_id IN (:...ids)', { ids })
          .andWhere('a.status != :c', { c: 'cancelled' })
          .groupBy('a.set_meal_id')
          .getRawMany<{ setMealId: number; n: string }>()
      : [];
    const usedMap = new Map(used.map((u) => [Number(u.setMealId), Number(u.n)]));

    const list: TemplateRow[] = rows.map((r) => {
      const mine = items.filter((i) => i.setMealId === r.id);
      return {
        id: r.id,
        name: r.name ?? null,
        priceFen: Math.round(Number(r.price) * 100),
        costPriceFen: Math.round(Number(r.costPrice) * 100),
        oneLiner: r.oneLiner ?? null,
        status: r.status,
        statusText: r.status === 1 ? '启用' : '停用',
        dishCount: mine.length,
        items: mine.map((i) => ({
          dishId: i.dishId,
          slot: i.slot,
          slotLabel: SLOT_LABEL[i.slot] ?? String(i.slot),
          name: dishMap.get(i.dishId)?.name ?? `菜品 ${i.dishId}`,
          supplierId: i.supplierId,
        })),
        usedCount: usedMap.get(r.id) ?? 0,
      };
    });

    return paginate(list, total, page, pageSize);
  }

  // ==========================================================================
  // D7 · 存为模板
  // ==========================================================================

  /**
   * 菜品项两种来源：显式 `items[]` 或 `sourceSetMealId`（另存现有套餐）。
   * `supplierId` 由菜品反查、`costPrice` 由菜品供价求和 —— 见 DTO 注释里的理由。
   */
  async createTemplate(dto: CreateSetMealTemplateDto, operatorId?: number) {
    let plan: Array<{ dishId: number; slot: number }>;

    if (dto.items?.length) {
      plan = dto.items.map((i) => ({ dishId: i.dishId, slot: i.slot }));
    } else if (dto.sourceSetMealId) {
      const src = await this.setMealRepo.findOne({ where: { id: dto.sourceSetMealId } });
      if (!src) throw new BizException(ErrorCode.MEAL_NOT_FOUND);
      const srcItems = await this.itemRepo.find({ where: { setMealId: src.id } });
      if (srcItems.length === 0) {
        throw new BizException(ErrorCode.MEAL_NOT_FOUND, '被复制的套餐没有菜品明细');
      }
      plan = srcItems.map((i) => ({ dishId: i.dishId, slot: i.slot }));
    } else {
      throw new BizException(ErrorCode.PARAM_INVALID, 'items 与 sourceSetMealId 至少给一个');
    }

    // 同一道菜不允许重复出现（「两道素菜」可以是两道**不同**的素菜）
    const dishIds = plan.map((p) => p.dishId);
    if (new Set(dishIds).size !== dishIds.length) {
      throw new BizException(ErrorCode.PARAM_INVALID, '同一道菜不能重复出现');
    }

    const dishes = await this.dishRepo.find({ where: { id: In(dishIds) } });
    const dishMap = new Map(dishes.map((d) => [d.id, d]));
    const missing = dishIds.filter((id) => !dishMap.has(id));
    if (missing.length) {
      throw new BizException(ErrorCode.MEAL_NOT_FOUND, `菜品不存在：${missing.join(', ')}`);
    }
    const offShelf = dishIds.filter((id) => dishMap.get(id)?.status !== 1);
    if (offShelf.length) {
      throw new BizException(ErrorCode.MEAL_NOT_FOUND, `菜品已下架：${offShelf.join(', ')}`);
    }

    const price = dto.price ?? (await this.bizConfig.unitPriceYuan());
    const costPrice = plan
      .reduce((sum, p) => sum + Number(dishMap.get(p.dishId)?.costPrice ?? 0), 0)
      .toFixed(2);

    const saved = await this.dataSource.transaction(async (m) => {
      const sm = await m.save(
        m.create(SetMeal, {
          name: dto.name,
          price: price.toFixed(2),
          costPrice,
          oneLiner: dto.oneLiner ?? null,
          description: dto.description ?? null,
          coverUrl: dto.coverUrl ?? null,
          status: 1,
          createdBy: operatorId ?? null,
        }),
      );
      await m.save(
        plan.map((p) =>
          m.create(SetMealItem, {
            setMealId: sm.id,
            dishId: p.dishId,
            supplierId: dishMap.get(p.dishId)!.supplierId,
            // 分账单价 = 该菜品供价（C9：逐菜协商价，不再用供应商整体分成比例）
            shareAmount: dishMap.get(p.dishId)!.costPrice,
            slot: p.slot,
          }),
        ),
      );
      return sm;
    });

    this.logger.log(
      `新建套餐模板 #${saved.id}「${dto.name}」· ${plan.length} 项 · 成本 ¥${costPrice}`,
    );
    return this.templateView(saved, plan, dishMap);
  }

  // ==========================================================================
  // 辅助 · 菜品选择器（D7 编排页的前置数据源）
  // ==========================================================================

  /**
   * 菜品库（供 D7「选菜品组成一饭四菜」）
   *
   * 菜品的**管理**属供应商模块（D23–D32），本接口只做**只读挑选用**，
   * 因此刻意不放进 `admin/supplier/*` —— 编排页不该依赖尚未落地的模块。
   *
   * 只返回上架菜品（`status=1`）：编排页选中一道已下架的菜，D7 提交时必被
   * `createTemplate` 的「菜品已下架」校验打回 —— 与其让运营在提交后才发现，
   * 不如根本不给选。类别倒序排列（主荤在前），贴合「一饭四菜」的选菜顺序。
   */
  async dishOptions(keyword?: string) {
    const qb = this.dishRepo
      .createQueryBuilder('d')
      .where('d.status = :st', { st: 1 })
      .orderBy('d.category', 'ASC')
      .addOrderBy('d.id', 'ASC');
    if (keyword) qb.andWhere('d.name LIKE :kw', { kw: `%${keyword}%` });

    const dishes = await qb.getMany();
    const supplierIds = [...new Set(dishes.map((d) => d.supplierId))];
    const suppliers = supplierIds.length
      ? await this.supplierRepo.find({ where: { id: In(supplierIds) } })
      : [];
    const supplierMap = new Map(suppliers.map((s) => [s.id, s]));

    return {
      // 档位选项由服务端给出：端上不需要维护一份「1=主荤…」的映射（口径唯一）
      slots: Object.entries(SLOT_LABEL).map(([value, label]) => ({ value: Number(value), label })),
      list: dishes.map((d) => ({
        id: d.id,
        name: d.name,
        category: d.category ?? null,
        imageUrl: d.imageUrl ?? null,
        supplierId: d.supplierId,
        supplierName: supplierMap.get(d.supplierId)?.name ?? null,
        supplierStatus: supplierMap.get(d.supplierId)?.status ?? null,
        costPriceFen: Math.round(Number(d.costPrice) * 100),
        status: d.status,
      })),
      total: dishes.length,
    };
  }

  // ==========================================================================
  // 辅助 · 集散中心选择器（D2/D3 的前置数据源）
  // ==========================================================================

  /**
   * 集散中心（供 D2 创建 / D3 编辑时挑选）
   *
   * 与 `dishOptions` 同一理由：集散中心的**管理**属供应商模块（D29–D32），
   * 本接口只做**只读挑选用**。集散中心是可选字段 —— C9 口径下集散复用合作供应商
   * 场地，场地费默认 ¥0，因此「不选」是合法状态，前端需允许清空。
   */
  async distributionCenterOptions() {
    const dcs = await this.dcRepo.find({ order: { id: 'ASC' } });
    const supplierIds = [...new Set(dcs.map((d) => d.supplierId))];
    const suppliers = supplierIds.length
      ? await this.supplierRepo.find({ where: { id: In(supplierIds) } })
      : [];
    const supplierMap = new Map(suppliers.map((s) => [s.id, s]));

    return {
      list: dcs.map((d) => ({
        id: d.id,
        name: d.name,
        supplierId: d.supplierId,
        supplierName: supplierMap.get(d.supplierId)?.name ?? null,
        address: d.address ?? null,
        status: d.status,
      })),
      total: dcs.length,
    };
  }

  // ==========================================================================
  // 私有
  // ==========================================================================

  private async assertSetMeal(id: number): Promise<SetMeal> {
    const sm = await this.setMealRepo.findOne({ where: { id } });
    if (!sm) throw new BizException(ErrorCode.MEAL_NOT_FOUND);
    if (sm.status !== 1) throw new BizException(ErrorCode.MEAL_NOT_FOUND, '该套餐模板已停用');
    return sm;
  }

  private async assertGroup(id: number): Promise<void> {
    const g = await this.groupRepo.findOne({ where: { id } });
    if (!g) throw new BizException(ErrorCode.NOT_FOUND, `楼群不存在：#${id}`);
  }

  private async assertDistributionCenter(id: number): Promise<void> {
    const dc = await this.dcRepo.findOne({ where: { id } });
    if (!dc) throw new BizException(ErrorCode.NOT_FOUND, `集散中心不存在：#${id}`);
  }

  private async assignmentView(a: MealAssignment) {
    const sm = await this.setMealRepo.findOne({ where: { id: a.setMealId } });
    return {
      id: a.id,
      mealDate: a.mealDate,
      buildingGroupId: a.buildingGroupId,
      setMealId: a.setMealId,
      setMealName: sm?.name ?? null,
      distributionCenterId: a.distributionCenterId ?? null,
      status: a.status,
      statusHint: STATUS_HINT[a.status] ?? a.status,
      publishAt: toBjIso(a.publishAt),
      cutoffAt: toBjIso(a.cutoffAt),
      cutoffPassed: isAfterCutoff(a.mealDate),
      soldCount: a.soldCount,
    };
  }

  private templateView(
    sm: SetMeal,
    plan: Array<{ dishId: number; slot: number }>,
    dishMap: Map<number, Dish>,
  ) {
    return {
      id: sm.id,
      name: sm.name ?? null,
      priceFen: Math.round(Number(sm.price) * 100),
      costPriceFen: Math.round(Number(sm.costPrice) * 100),
      oneLiner: sm.oneLiner ?? null,
      status: sm.status,
      dishCount: plan.length,
      items: plan.map((p) => ({
        dishId: p.dishId,
        slot: p.slot,
        slotLabel: SLOT_LABEL[p.slot] ?? String(p.slot),
        name: dishMap.get(p.dishId)?.name ?? null,
        supplierId: dishMap.get(p.dishId)?.supplierId ?? null,
      })),
    };
  }
}

/** 闭区间日期序列（含首含尾）· 纯 UTC 运算，跨月/跨年安全 */
function dateRange(start: string, end: string): string[] {
  if (!isDateStr(start) || !isDateStr(end)) return [];
  const out: string[] = [];
  let cur = start;
  // 双保险：即便调用方绕过 DTO 校验，也不会死循环
  for (let i = 0; i <= MATRIX_MAX_DAYS * 4 && cur <= end; i += 1) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

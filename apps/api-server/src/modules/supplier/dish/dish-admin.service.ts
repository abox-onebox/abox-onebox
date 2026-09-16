import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { DISH_CATEGORY_LABEL, DISH_CATEGORY_OPTIONS, DishCategory } from '@abox/shared-types';

import { ErrorCode } from '../../../common/constants/error-code';
import { BizException } from '../../../common/exceptions/biz.exception';
import { toFen, toYuan } from '../../../common/utils/money';
import { normalizePage, paginate, PageResult } from '../../../common/utils/response';
import { Dish, Supplier } from '../../../database/entities/supplier.entity';
import {
  AdminDishesQueryDto,
  BatchDishStatusDto,
  CreateDishDto,
  UpdateDishDto,
} from '../dto/supplier-admin.dto';

type DishListResult = PageResult<Record<string, unknown>> & {
  summary: Record<string, unknown>;
  categoryOptions: Array<Record<string, unknown>>;
  supplierOptions: Array<Record<string, unknown>>;
  actions: { canManage: boolean };
  notes?: Record<string, string>;
};

/**
 * 后台 · 菜品库服务（原型 P33「菜品库」页 · 扩展接口，无 D 编号）
 *
 * ## 为什么必须有这个模块（不是一个「可选的锦上添花」）
 *
 * D7 明确：套餐编排**不收 `supplierId` / `costPrice`**，「供应商由菜品反查
 * （`ab_dish.supplier_id`）、成本由菜品供价求和」。也就是说**菜品是唯一的供价载体**。
 * 在 M3-6 之前，`ab_dish` 只有种子数据能写 —— 运营想加一道菜、想按新协商价
 * 改一道菜，都无接口可用，只能改库。这是真实的功能缺口，不是设计偏好。
 *
 * ## 三条纪律
 *
 * 1. **供价是钱，改动要留痕**：`cost_price` 直接决定供应商应付与平台毛利（C9 等式），
 *    故新增/改价都走 `@OperationLog`；且入参用「分」，落库用 `money()` 两位小数串，
 *    杜绝 `7.5 * 100 = 750.0000000000001` 这类浮点暗雷。
 * 2. **换供应商 = 新建菜品**：编辑接口刻意**不含 `supplierId`** —— 同一道菜换个商家做，
 *    历史分账流水（`ab_supplier_share.dish_id`）会全部指向新主体，账就串了。
 * 3. **批量下架必填原因**：证照过期联动、食安检查、商家退出都会引发批量下架，
 *    事后复盘时要能回答「这批菜是谁、因为什么下的」。
 */
@Injectable()
export class DishAdminService {
  constructor(
    @InjectRepository(Dish) private readonly dishRepo: Repository<Dish>,
    @InjectRepository(Supplier) private readonly supplierRepo: Repository<Supplier>,
  ) {}

  /** 菜品库列表（可按供应商 / 档位 / 上下架 / 菜名筛选） */
  async list(q: AdminDishesQueryDto, viewerRole: string): Promise<DishListResult> {
    const { page, pageSize, skip } = normalizePage(q);
    const qb = this.dishRepo.createQueryBuilder('d').where('d.deleted_at IS NULL');

    if (q.supplierId) qb.andWhere('d.supplier_id = :sid', { sid: q.supplierId });
    if (q.category) qb.andWhere('d.category = :cat', { cat: q.category });
    if (q.status !== undefined) qb.andWhere('d.status = :st', { st: q.status });
    if (q.keyword) qb.andWhere('d.name LIKE :kw', { kw: `%${q.keyword}%` });

    const all = await qb.clone().orderBy('d.id', 'ASC').getMany();
    const [rows, total] = await qb
      .clone()
      .orderBy('d.status', 'DESC')
      .addOrderBy('d.id', 'ASC')
      .skip(skip)
      .take(pageSize)
      .getManyAndCount();

    // 供应商名一次性映射（N+1 防呆）：菜品列表天然要显示「这道菜谁做的」
    const supplierIds = [...new Set(all.map((d) => Number(d.supplierId)))];
    const suppliers = supplierIds.length
      ? await this.supplierRepo.find({ where: { id: In(supplierIds) } })
      : [];
    const nameMap = new Map(suppliers.map((s) => [Number(s.id), s.name]));

    const avg =
      all.length > 0
        ? Math.round(all.reduce((a, d) => a + toFen(Number(d.costPrice)), 0) / all.length)
        : 0;

    return {
      ...paginate(
        rows.map((d) => this.decorate(d, nameMap)),
        total,
        page,
        pageSize,
      ),
      summary: {
        totalCount: all.length,
        onSaleCount: all.filter((d) => d.status === 1).length,
        offSaleCount: all.filter((d) => d.status === 0).length,
        /** 平均供价（分 · 全量口径）—— 一眼看出「是不是悄悄涨了价」 */
        avgPriceFen: avg,
        totalSaleCount: all.reduce((a, d) => a + d.saleCount, 0),
      },
      categoryOptions: DISH_CATEGORY_OPTIONS,
      supplierOptions: suppliers
        .map((s) => ({ value: Number(s.id), label: s.name }))
        .sort((a, b) => a.value - b.value),
      actions: { canManage: viewerRole === 'super_admin' || viewerRole === 'admin' },
      notes: {
        category:
          '档位取值 main 主荤 / half 半荤 / veg 素菜 / soup 汤品 / staple 主食，' +
          '**与套餐槽位 DishSlot（main/vegetable/side/soup/staple）是两套枚举**，不要互相映射。',
        costPrice:
          '供价（costPriceFen）为**逐菜协商价**（C9），不是固定口径；它是 D7 套餐成本与' +
          '供应商应付的唯一来源（编排页不收供应商与成本，全部由菜品反查）。',
      },
    };
  }

  /** 新增菜品 */
  async create(dto: CreateDishDto) {
    await this.assertSupplier(dto.supplierId);
    const saved = await this.dishRepo.save(
      this.dishRepo.create({
        supplierId: dto.supplierId,
        name: dto.name,
        category: dto.category,
        costPrice: this.yuanStr(dto.costPriceFen),
        description: dto.description ?? null,
        imageUrl: dto.imageUrl ?? null,
        status: dto.status ?? 1,
      }),
    );
    return { id: Number(saved.id), name: saved.name, costPriceFen: toFen(Number(saved.costPrice)) };
  }

  /**
   * 编辑菜品
   *
   * ⚠️ 刻意不含 `supplierId`：换供应商＝历史分账流水（按 `dish_id` 归属）全部改挂到新主体，
   *    已出的结算单会与菜品对不上。要换主体请新建菜品并下架旧的。
   */
  async update(id: number, dto: UpdateDishDto) {
    const d = await this.assertDish(id);
    if (dto.name !== undefined) d.name = dto.name;
    if (dto.category !== undefined) d.category = dto.category;
    if (dto.description !== undefined) d.description = dto.description;
    if (dto.imageUrl !== undefined) d.imageUrl = dto.imageUrl;
    if (dto.status !== undefined) d.status = dto.status;
    if (dto.costPriceFen !== undefined) d.costPrice = this.yuanStr(dto.costPriceFen);
    d.version += 1;
    await this.dishRepo.save(d);
    return {
      id: Number(d.id),
      name: d.name,
      category: d.category,
      categoryLabel: DISH_CATEGORY_LABEL[d.category as DishCategory] ?? d.category,
      costPriceFen: toFen(Number(d.costPrice)),
      status: d.status,
    };
  }

  /**
   * 批量上下架
   *
   * 下架**必须给原因**：批量下架是「一道菜在多个办公楼同时消失」的动作，
   * 而它会连带影响已上架的套餐（D7 反查菜品供价），事后复盘必须能回答
   * 「谁在什么时候、因为什么把这一批菜下了」。
   */
  async batchStatus(dto: BatchDishStatusDto) {
    const ids = [...new Set(dto.ids)];
    if (!ids.length) throw new BizException(ErrorCode.PARAM_INVALID, '请至少选择一道菜品');
    if (dto.status === 0 && (!dto.reason || dto.reason.trim().length < 2)) {
      throw new BizException(ErrorCode.PARAM_INVALID, '批量下架必须填写原因（≥2 字）');
    }

    const found = await this.dishRepo.find({ where: { id: In(ids) } });
    if (found.length !== ids.length) {
      throw new BizException(
        ErrorCode.NOT_FOUND,
        `有 ${ids.length - found.length} 道菜品不存在，请刷新后重试（不做「部分成功」）`,
      );
    }

    const target = found.filter((d) => d.status !== dto.status);
    if (!target.length) {
      throw new BizException(ErrorCode.PARAM_INVALID, '所选菜品均已是目标状态，无需变更');
    }

    await this.dishRepo.update({ id: In(target.map((d) => Number(d.id))) }, { status: dto.status });
    return {
      requested: ids.length,
      changed: target.length,
      /** 「没变」的条数也回报 —— 与 changed 相加应等于 requested，运营才能核对 */
      skipped: ids.length - target.length,
      status: dto.status,
      reason: dto.reason ?? null,
    };
  }

  // ---------------------------------------------------------------- 私有

  private decorate(d: Dish, nameMap: Map<number, string>) {
    const supplierId = Number(d.supplierId);
    return {
      id: Number(d.id),
      supplierId,
      supplierName: nameMap.get(supplierId) ?? null,
      name: d.name,
      category: d.category ?? null,
      categoryLabel: DISH_CATEGORY_LABEL[d.category as DishCategory] ?? d.category,
      costPriceFen: toFen(Number(d.costPrice)),
      /** 元串：仅用于前端输入框回填（避免「分转元」在两端各写一遍） */
      costPriceYuan: toYuan(toFen(Number(d.costPrice))).toFixed(2),
      status: d.status,
      statusLabel: d.status === 1 ? '上架' : '下架',
      saleCount: d.saleCount,
      rating: Number(d.rating),
      description: d.description ?? null,
      imageUrl: d.imageUrl ?? null,
    };
  }

  /** 分 → DECIMAL(8,2) 的两位小数串（落库形态统一为字符串） */
  private yuanStr(fen: number): string {
    return toYuan(fen).toFixed(2);
  }

  private async assertDish(id: number): Promise<Dish> {
    const d = await this.dishRepo.findOne({ where: { id } });
    if (!d || d.deletedAt) throw new BizException(ErrorCode.NOT_FOUND, `菜品不存在：#${id}`);
    return d;
  }

  private async assertSupplier(id: number): Promise<void> {
    const s = await this.supplierRepo.findOne({ where: { id } });
    if (!s || s.deletedAt) throw new BizException(ErrorCode.SUPPLIER_NOT_FOUND);
  }
}

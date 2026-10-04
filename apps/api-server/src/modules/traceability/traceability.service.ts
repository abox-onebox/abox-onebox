import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';

import type {
  SupplierQualificationDetail,
  SupplierQualificationEntry,
  SupplierQualificationItem,
  SupplierQualificationListResult,
  TraceabilityDishView,
  TraceabilityQualification,
  TraceabilitySupplierView,
  TraceabilityTodayResult,
} from '@abox/shared-types';
import {
  SUPPLIER_AUDIT_STATUS_LABEL,
  SupplierAuditStatus,
  TRACEABILITY_QUALIFICATION_LABEL,
} from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { canServeSupplier } from '../../common/utils/supplier-qualification';
// ⚠️ 2026-10-04：原 `readTakeoutLinks` 导入已删除 —— 面向小程序的出参不再读取外卖链接
//    （5.10 互推）。后台 `takeout_links` 的读写口仍在 `common/utils/takeout.ts`，留给 admin 端。
import { tomorrowBj } from '../../common/utils/time';
import { Building } from '../../database/entities/building.entity';
import { DistributionCenter } from '../../database/entities/finance.entity';
import { MealAssignment, SetMeal, SetMealItem } from '../../database/entities/meal.entity';
import { Dish, Supplier } from '../../database/entities/supplier.entity';

/**
 * 今日这盒 · 商家溯源服务（**U5** · 《接口规范 v1.0》§3.2 · 原型 P38 · M5-14）
 *
 * ## 职责边界
 * 只回答「今天这一盒是谁做的、出品方持有哪些已核验资质」。
 *
 * ⚠️ 原文案是「……我能不能**直接去找他们点单**」：那是外卖平台跳转时代的描述，
 *    跳转已于 2026-10-03/04 移除（5.10 互推，处理 = 下架），描述不得继续说着旧话。
 * **不回答**「这家是不是我们的合作伙伴」—— C8 硬约束：出参严禁包含
 * `status`（合作中 / 备选）、`commission`、`shareRate`、备选商家清单、联系方式。
 * 能跳转 ≠ 是合作伙伴；平台一旦下发「哪些是备选商家」，就等于替未合作主体背书。
 *
 * ## 与 `MealService.dishesOfSetMeal` 的关系（为什么不复用）
 * 两者都从 `ab_set_meal_item` 出发，但**出参粒度不同**且**背的道不同**：
 *   · U1 只到「菜名 + 档位 + 图片 + 供应商展示名」，是**下单页**的菜单视图；
 *   · U5 还要带**该供应商的资质**，是**溯源页**的证据视图
 *     （原「资质与外卖跳转」—— 跳转已移除，见上）。
 * 强行合并会让下单页的契约里凭空多出一组它永远不渲染的字段（而多出来的字段
 * 迟早会被人当「反正有，顺手用一下」——那时下单页就开始泄露溯源页才该有的信息）。
 * 共享的是**底层读取口**（实体 / 资质判据），不是出参。
 *
 * ## N+1 收敛
 * 菜品与供应商各一次 `IN` 批量取，供应商视图**按 id 缓存**（一家供两道菜时
 * 不重复解析 `takeout_links`）。整页固定 4 次查询，与菜数无关。
 *
 * ## 缓存
 * 契约 §3.2 曾提「Redis `trace:{buildingId}:{mealDate}` TTL ≤ 5 分钟」——
 * **一期未实装**：本仓库尚无 Redis 缓存层（Redis 仅作队列驱动），而溯源是
 * **低频只读**且查询已收敛为常数条。引入缓存层要连带处理失效与一致性，
 * 收益不抵成本。待真有缓存基础设施时再补（已在《接口规范》变更记录登记）。
 */
/** 详情页最多展示几个在册菜品（规模陈述用，不做分页） */
const MAX_DETAIL_DISHES = 6;

/** `ab_dish.status` = 1 上架（与实体头注同值；此处具名只为可读性） */
const DISH_ON_SALE = 1;

@Injectable()
export class TraceabilityService {
  constructor(
    @InjectRepository(MealAssignment) private readonly assignmentRepo: Repository<MealAssignment>,
    @InjectRepository(SetMeal) private readonly setMealRepo: Repository<SetMeal>,
    @InjectRepository(SetMealItem) private readonly itemRepo: Repository<SetMealItem>,
    @InjectRepository(Dish) private readonly dishRepo: Repository<Dish>,
    @InjectRepository(Supplier) private readonly supplierRepo: Repository<Supplier>,
    @InjectRepository(DistributionCenter)
    private readonly centerRepo: Repository<DistributionCenter>,
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
  ) {}

  /**
   * U5 · 今日这盒溯源
   *
   * @param buildingId 办公楼 id（**必传** —— 见 DTO 头注：`@Public()` 下拿不到身份）
   * @param mealDate 出餐日，缺省 = 明日 T+1
   */
  async today(buildingId?: number, mealDate?: string): Promise<TraceabilityTodayResult> {
    const targetDate = mealDate ?? tomorrowBj();
    const groupId = await this.resolveGroup(buildingId);

    const assignment = await this.assignmentRepo.findOne({
      where: { mealDate: targetDate, buildingGroupId: groupId, status: Not('cancelled') },
    });

    /**
     * 未开团**不抛错**，而是回一个带说明的空结果。
     *
     * 与 U1 `MEAL_NOT_PUBLISHED` 的选择不同，是因为两侧语义不同：
     * U1 是**交易页**（`canOrder=false` 时用户有明确下一步：等开团 / 明天再来），
     * 报错能把「为什么不能下单」说清；U5 是**信任页**，用户此刻只想确认
     * 「这盒谁做的」，无团可溯的日子他无从 action，一个红色 toast 只会让人以为坏了。
     * 端上据 `dishes: []` 走空态即可。
     */
    if (!assignment) {
      return {
        mealDate: targetDate,
        setName: null,
        dishes: [],
        distributionCenter: null,
        traceNote: `${targetDate} 该办公楼未开团，暂无出品方信息。`,
      };
    }

    const [setMeal, items, center] = await Promise.all([
      this.setMealRepo.findOne({ where: { id: assignment.setMealId } }),
      this.itemRepo.find({ where: { setMealId: assignment.setMealId }, order: { slot: 'ASC' } }),
      assignment.distributionCenterId
        ? this.centerRepo.findOne({ where: { id: assignment.distributionCenterId } })
        : Promise.resolve(null),
    ]);

    let dishes: TraceabilityDishView[] = [];

    if (items.length) {
      const [dishRows, supplierRows] = await Promise.all([
        this.dishRepo.find({ where: { id: In(items.map((i) => i.dishId)) } }),
        this.supplierRepo.find({ where: { id: In([...new Set(items.map((i) => i.supplierId))]) } }),
      ]);

      const dishMap = new Map(dishRows.map((d) => [Number(d.id), d]));
      const supMap = new Map(supplierRows.map((s) => [Number(s.id), s]));

      // 一家供应商供多道菜时复用同一份视图（含它的资质）
      const supplierViews = new Map<number, TraceabilitySupplierView>();
      const viewOf = (supplierId: number): TraceabilitySupplierView => {
        const cached = supplierViews.get(supplierId);
        if (cached) return cached;
        const row = supMap.get(supplierId);
        const view = row
          ? this.supplierView(row)
          : {
              // 数据不一致（套餐引用了不存在的供应商）时不隐藏这道菜 ——
              // 「有一道菜的出品方查不到」是必须被看见的异常，静默丢弃只会让运营永远不知道
              id: supplierId,
              name: `供应商 #${supplierId}`,
              qualifications: [],
            };
        supplierViews.set(supplierId, view);
        return view;
      };

      dishes = items.map((i) => {
        const dish = dishMap.get(Number(i.dishId));
        return {
          dishName: dish?.name ?? `菜品 #${i.dishId}`,
          category: dish?.category ?? null,
          imageUrl: dish?.imageUrl ?? null,
          supplier: viewOf(Number(i.supplierId)),
        };
      });
    }

    return {
      mealDate: targetDate,
      setName: setMeal?.name ?? null,
      dishes,
      distributionCenter: center ? { name: center.name, address: center.address } : null,
      traceNote: this.buildTraceNote(dishes, center),
    };
  }

  /**
   * 供应商资质墙 · 列表（**免登录只读** · 2026-10-03 新增）
   *
   * ## 为什么不再给外卖跳转
   * 原先「这家店靠不靠谱」是由**跳去美团 / 京东 / 淘宝的店铺页**来证明的。
   * 2026-10-03 逐字复核《微信小程序平台运营规范》确认此路不通：
   *   · 5.10 互推行为（对其他 APP 推荐、推广或提供协助便利 → **下架**）；
   *   · 5.20 诱导下载行为（含「利用剪切板能力达到诱导跳转 / 下载 APP 目的」）；
   *   · 5.15.4 / 5.16（滥用剪切板 → 封禁剪切板能力直至封号）。
   * 故信任证据改由**自持证照**承载 —— 这恰好也是用户真正要看的东西
   * （有没有证、过没过期、审没审过），且完全落在自己域内。
   *
   * ## 分组判据
   * `serving` 与 S1 出餐前置 `canServe` **共用同一处实现**
   * （`common/utils/supplier-qualification.ts`）—— 不在本文件另写一份，
   * 否则会出现「这家今天在出餐、资质墙里却查不到它」的静默矛盾。
   */
  async supplierList(): Promise<SupplierQualificationListResult> {
    const rows = await this.supplierRepo.find({
      where: { deletedAt: IsNull() },
      order: { id: 'ASC' },
    });

    const serving: SupplierQualificationItem[] = [];
    const inactive: SupplierQualificationItem[] = [];

    for (const s of rows) {
      const ok = canServeSupplier(s);
      const item: SupplierQualificationItem = {
        id: Number(s.id),
        name: s.name,
        category: s.category ?? null,
        // 暂未供应组一律不带资质与有效期：把过期 / 未核验证照摆上资质墙比不摆更糟
        qualifications: ok ? this.qualificationsOf(s) : [],
        licenseExpireAt: ok ? (s.licenseExpireAt ?? null) : null,
        serving: ok,
        totalServed: s.totalServed ?? 0,
      };
      (ok ? serving : inactive).push(item);
    }

    return { serving, inactive, note: this.buildQualificationNote(serving.length) };
  }

  /**
   * 供应商资质墙 · 详情（**免登录只读**）
   *
   * ⚠️ 不在供时**不下发证照**（`entries` 为空）：用户会把摆出来的证照当成仍然有效。
   *    但**必须给一句话说明**原因 —— 点进一家却看到空白页，只会以为程序坏了。
   */
  async supplierDetail(id: number): Promise<SupplierQualificationDetail> {
    if (!Number.isFinite(id) || id <= 0) {
      throw new BizException(ErrorCode.PARAM_INVALID, '出品方 id 不合法');
    }

    const s = await this.supplierRepo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!s) {
      throw new BizException(ErrorCode.NOT_FOUND, `出品方 #${id} 不存在`);
    }

    const serving = canServeSupplier(s);
    const qualifications = this.qualificationsOf(s);

    const entries: SupplierQualificationEntry[] = serving
      ? qualifications.map((q) => ({
          key: q,
          label: TRACEABILITY_QUALIFICATION_LABEL[q],
          code: q === 'business_license' ? (s.businessLicense ?? null) : (s.foodLicense ?? null),
          expireAt: s.licenseExpireAt ?? null,
        }))
      : [];

    const dishRows = await this.dishRepo.find({
      where: { supplierId: id, status: DISH_ON_SALE, deletedAt: IsNull() },
      order: { saleCount: 'DESC' },
      take: MAX_DETAIL_DISHES,
    });

    return {
      id: Number(s.id),
      name: s.name,
      category: s.category ?? null,
      serving,
      entries,
      dishes: dishRows.map((d) => d.name),
      note: this.buildDetailNote(serving, qualifications.length, s.auditStatus),
    };
  }

  // ---------------------------------------------------------------------------
  // 私有
  // ---------------------------------------------------------------------------

  /** 办公楼 → 楼群（缺失即报错，不猜） */
  private async resolveGroup(buildingId?: number): Promise<number> {
    if (!buildingId) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        '缺少 buildingId，无法定位该办公楼的当日套餐',
      );
    }

    const building = await this.buildingRepo.findOne({ where: { id: buildingId } });
    if (!building) {
      throw new BizException(ErrorCode.NOT_FOUND, `办公楼 #${buildingId} 不存在`);
    }
    if (!building.buildingGroupId) {
      throw new BizException(ErrorCode.NOT_FOUND, '所属办公楼未配置楼群，请联系运营');
    }
    return Number(building.buildingGroupId);
  }

  /**
   * 供应商视图（**C8 收口点**）
   *
   * 出参只有五项：id / 名称 / 资质 / 推荐平台 / 三平台跳转。
   * 状态、联系方式、供价、分账比例一律**不出现** —— 不是「忘了带」，
   * 而是这里就是唯一的组装点，谁想加字段都得先过这一关。
   *
   * ⭐ M5-17 新增 `id`：首页「来自：X」跳本页时按 id 定位到具体这张卡
   *    （`name` 无唯一约束，按名定位会弹错店）。id 不属于 C8 的任一项禁忌。
   */
  private supplierView(s: Supplier): TraceabilitySupplierView {
    //
    // ⚠️⭐ 2026-10-04：这里**不再读取** `s.takeoutLinks`（原 `readTakeoutLinks(...)`）
    //
    //   `TraceabilitySupplierView` 的 `recommended` / `takeoutLinks` 两字段已删除，
    //   理由见该 DTO 的注释 —— 下发的 url 是**小程序路径**，配合 appid 即构成
    //   《运营规范》**5.10 互推行为**（处理 = 下架）。
    //
    //   ⚠️ 只删「读」不删「存」：`ab_supplier.takeout_links` 与其后台配置页**保留**
    //   （后台网页不受小程序审核约束）。但**面向小程序的出参永不读它** ——
    //   后台能配 ≠ 小程序可以带出去。谁想在这里加回读取，先去重读那条判定。
    //
    return {
      id: Number(s.id),
      name: s.name,
      qualifications: this.qualificationsOf(s),
    };
  }

  /**
   * 在册且**已核验**的资质项
   *
   * ⚠️ 判据是 `audit_status === 'approved'`，**不是**「证照字段非空」：
   *    「上传了文件」与「平台核验过」是两件事（`ab_supplier` 头注已明确 D26 的语义 ——
   *    审核回答「有没有合规资格」，停用回答「要不要合作」）。仅凭字段非空就说
   *    「已通过核验」，是在食品安全叙事上替运营做了没做过的承诺。
   *    故未通过审核 = 不下发任何资质项（端上该卡就不显示核验行）。
   *
   * ⚠️ 只列 `food_business_license` / `business_license` 两项。原型 P38 卡片写的
   *    第三项「健康证」**刻意不输出**：见 `shared-types/dto/traceability.dto.ts`
   *    的 `TraceabilityQualification` 头注（自营下健康证的主体是 ABox 自有加工人员，
   *    不是半成品供货方，且库里没有对应列）。
   */
  private qualificationsOf(s: Supplier): TraceabilityQualification[] {
    if (s.auditStatus !== SupplierAuditStatus.APPROVED) return [];

    const out: TraceabilityQualification[] = [];
    if (s.foodLicense) out.push('food_business_license');
    if (s.businessLicense) out.push('business_license');
    return out;
  }

  /**
   * 页面顶部溯源说明（**由本次真实数据生成**，不写死文案）
   *
   * 刻意不硬编码「已通过 食品经营许可证 · 营业执照 · 健康证 三重核验」这类句子：
   * 硬编码的合规声明与真实资质是**两份表述**，数据一变（某个供应商被驳回、
   * 只上传了一个证）声明就会继续说着旧话 —— 那正是本项目反复踩的缺陷形状。
   * 这里把核验项**从本次出参里的实际资质并集**取出来，声明与数据不可能漂移。
   */
  private buildTraceNote(
    dishes: TraceabilityDishView[],
    center: DistributionCenter | null,
  ): string {
    const supplierCount = new Set(dishes.map((d) => d.supplier.name)).size;
    const parts: string[] = [];

    if (supplierCount > 0) {
      parts.push(
        center
          ? `这一盒由 ${supplierCount} 家菜品供应商 + 1 个集散中心（${center.name}）联合出品。`
          : `这一盒由 ${supplierCount} 家菜品供应商联合出品。`,
      );
    }

    const labels = [
      ...new Set(
        dishes
          .flatMap((d) => d.supplier.qualifications)
          .map((q) => TRACEABILITY_QUALIFICATION_LABEL[q]),
      ),
    ];
    if (labels.length) {
      parts.push(`所列出品方均已通过 ${labels.join(' · ')} 核验。`);
    }

    //
    // ⚠️⭐ 2026-10-04：原「如果今日套餐不合口味，也可以点进下方店铺，直接点他们的外卖」整段删除
    //
    //   这是**面向用户可见**的站外引导，命中《运营规范》**5.10 互推行为**（处理 = 下架）。
    //   更要命的是它同时是**假话**：端上的店铺卡片早已随跳转一并删除，
    //   文案说「点进下方店铺」而页面上根本没有店铺 —— 违规 + 逻辑矛盾叠在一起。
    //
    //   ⚠️ 删除的是「引导」，不是「售后」：用户用餐有问题仍可联系客服（客服页保留），
    //   只是不再把他推向第三方平台。
    //
    parts.push('用餐有任何问题都可以联系我们协助处理。');

    return parts.join('');
  }

  /**
   * 资质墙列表说明（**由本次真实数据生成**，不写死文案）
   *
   * 与 `buildTraceNote` 同一条纪律：硬编码的合规声明与真实资质是**两份表述**，
   * 数据一变（某家被驳回、只登记了一个证）声明就会继续说着旧话。
   */
  private buildQualificationNote(servingCount: number): string {
    if (servingCount === 0) {
      return '当前没有正在供应的出品方，资质信息暂不可查。';
    }
    return `以下 ${servingCount} 家出品方的证照均已通过平台核验且在有效期内，可点开查看证照编号与有效期。`;
  }

  /**
   * 详情页说明（**无资质时必须说清是哪一种事实**）
   *
   * 「资质尚在核验中」「证照已过期」「暂未合作」是三种不同的事实，
   * 合成一句「暂无资质」会把责任推给供应商 —— 用户只会以为这家有问题。
   */
  private buildDetailNote(
    serving: boolean,
    qualificationCount: number,
    auditStatus: string,
  ): string {
    if (serving && qualificationCount > 0) {
      return `该出品方已通过平台核验，下列 ${qualificationCount} 项证照在有效期内。`;
    }
    if (serving) {
      return '该出品方当前可在供，但尚未登记任何证照，平台正在补齐核验材料。';
    }
    const label =
      SUPPLIER_AUDIT_STATUS_LABEL[auditStatus as keyof typeof SUPPLIER_AUDIT_STATUS_LABEL] ??
      auditStatus;
    return `该出品方当前未在供应名单中（资质状态：${label}），暂不展示其证照。`;
  }
}

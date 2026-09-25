import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import type {
  DishRatingRow,
  DishRatingView,
  OrderRatingView,
  RatingSubmitResult,
} from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { toBjIso } from '../../common/utils/time';
import { DishRating, Order } from '../../database/entities/order.entity';
import { SetMealItem } from '../../database/entities/meal.entity';
import { Dish, Supplier } from '../../database/entities/supplier.entity';
import { resolveStatsRange } from '../stats/stats.constants';
import type { DishRatingQueryDto, RatingSubmitReqDto } from './dto/rating.dto';
import {
  RATING_ALLOWED_STATUSES,
  RATING_RECENT_REASONS_MAX,
  RATING_RED_LINE_MONTHLY,
  RATING_WORST_COUNT,
} from './rating.constants';

/**
 * P1-U2 口味评价服务 —— U20 提交（用户侧）+ D69 聚合（后台红黑榜）
 *
 * 真源：《创业系统地图与开发路线 v1.0》U2「口味评价与菜品迭代闭环」。
 *
 * ## 两个端点为什么放在同一个服务
 * 「提交的口径」与「聚合的口径」必须互相知道：聚合只数 `rating=3`（不好）当投诉、
 * 区间按 `meal_date` 切、菜名用快照 —— 这三条任一条只在其中一侧声明，另一侧
 * 就会自己发明一个（第二真相）。同一个文件里，两侧改任何一条都会**先撞见对方**。
 */

/* ------------------------------------------------------------------ *
 * 纯函数区（导出供单元测试直接钉口径 —— 同 order-state-machine.spec 先例）
 * ------------------------------------------------------------------ */

/** 聚合的输入行（服务层取行后转成纯数据，聚合零 IO —— 可测） */
export interface RatingAggRow {
  dishId: number;
  dishName: string;
  supplierId: number;
  supplierName: string;
  mealDate: string;
  rating: number;
  reason: string | null;
  id: number;
}

/**
 * ⭐ 聚合纯函数：输入**全部**评价行（含区间外），输出红黑榜视图。
 *
 * 为什么把「区间过滤」也放在纯函数里：过滤口径（`meal_date` 含端点 /
 * 「本月」= 锚点月）是**聚合口径的一部分**，放服务层会让测试只能走 HTTP 一条路径
 * （F5 的教训：`rateOf` 导出时写「避免只有 HTTP 一条验证路径」，结果全仓无人引用）。
 *
 * @param rows       全量评价行（服务层只负责取数；过滤在这里做才可测）
 * @param startDate  区间出餐日起（含）
 * @param endDate    区间出餐日止（含）；「本月投诉」= endDate 所在自然月
 */
export function aggregateDishRatings(
  rows: RatingAggRow[],
  startDate: string,
  endDate: string,
): Omit<DishRatingView, 'range' | 'redLineThreshold'> {
  const monthPrefix = endDate.slice(0, 7); // YYYY-MM（锚点月）

  type Acc = {
    dishId: number;
    dishName: string;
    supplierId: number;
    supplierName: string;
    ratedCount: number;
    goodCount: number;
    okCount: number;
    badCount: number;
    monthBadCount: number;
    reasons: Array<{ id: number; reason: string }>;
  };

  const acc = new Map<number, Acc>();
  let totalRatings = 0;

  for (const r of rows) {
    // 区间过滤（含端点）：红黑榜按「吃到的日子」切，不按「评价提交的日子」
    if (r.mealDate < startDate || r.mealDate > endDate) continue;

    let cur = acc.get(r.dishId);
    if (!cur) {
      cur = {
        dishId: r.dishId,
        dishName: r.dishName,
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        ratedCount: 0,
        goodCount: 0,
        okCount: 0,
        badCount: 0,
        monthBadCount: 0,
        reasons: [],
      };
      acc.set(r.dishId, cur);
    }

    cur.ratedCount += 1;
    totalRatings += 1;
    if (r.rating === 1) cur.goodCount += 1;
    else if (r.rating === 2) cur.okCount += 1;
    else if (r.rating === 3) {
      cur.badCount += 1;
      // ⭐ 红线分子 = 「不好」且出餐日在锚点月 —— 真源原句「这道菜本月第几次被投诉」
      if (r.mealDate.slice(0, 7) === monthPrefix) cur.monthBadCount += 1;
      if (r.reason && r.reason.trim()) cur.reasons.push({ id: r.id, reason: r.reason.trim() });
    }
  }

  const items: DishRatingRow[] = [...acc.values()]
    .map((v) => ({
      dishId: v.dishId,
      dishName: v.dishName,
      supplierId: v.supplierId,
      supplierName: v.supplierName,
      ratedCount: v.ratedCount,
      goodCount: v.goodCount,
      okCount: v.okCount,
      badCount: v.badCount,
      // ratedCount ≥ 1 才会进 acc ⇒ 分母恒 ≥ 1，badRate 恒可算（不存在 null 态）
      badRate: Number((v.badCount / v.ratedCount).toFixed(4)),
      monthBadCount: v.monthBadCount,
      redLine: v.monthBadCount >= RATING_RED_LINE_MONTHLY,
      // 新 → 旧（id 大者在前），截最近 N 条
      recentReasons: v.reasons
        .sort((a, b) => b.id - a.id)
        .slice(0, RATING_RECENT_REASONS_MAX)
        .map((x) => x.reason),
    }))
    // 黑榜序：投诉次数降序 → 同投诉次数下样本越少越扎眼（差评率越高）→ dishId 稳定序
    .sort((a, b) => b.badCount - a.badCount || a.ratedCount - b.ratedCount || a.dishId - b.dishId);

  // P1 验收判据的直接答案：「能说出本周最差的三道菜」
  const worstThree = items
    .filter((i) => i.badCount >= 1)
    .slice(0, RATING_WORST_COUNT)
    .map((i) => ({ dishId: i.dishId, dishName: i.dishName, badCount: i.badCount }));

  return { totalRatings, dishCount: items.length, worstThree, items };
}

/* ------------------------------------------------------------------ *
 * 服务
 * ------------------------------------------------------------------ */

@Injectable()
export class RatingService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(DishRating)
    private readonly ratingRepo: Repository<DishRating>,
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @InjectRepository(SetMealItem)
    private readonly itemRepo: Repository<SetMealItem>,
    @InjectRepository(Dish)
    private readonly dishRepo: Repository<Dish>,
    @InjectRepository(Supplier)
    private readonly supplierRepo: Repository<Supplier>,
  ) {}

  /* -------------------- U20 · 提交（逐菜三键 · 一次定稿） -------------------- */

  async submit(
    userId: number,
    orderNo: string,
    dto: RatingSubmitReqDto,
  ): Promise<RatingSubmitResult> {
    // 归属校验与 U10/U11 同判据：不区分「不存在」与「非本人」（防越权探测订单号）
    const order = await this.orderRepo.findOne({ where: { orderNo } });
    if (!order || order.userId !== userId) {
      throw new BizException(ErrorCode.ORDER_NOT_FOUND);
    }

    const status = order.status as string;
    if (!RATING_ALLOWED_STATUSES.includes(status)) {
      // 30020：回带当前状态与可评集合，端上据此引导「送达后可评价」而不是干报错
      throw new BizException(ErrorCode.RATING_NOT_ALLOWED, undefined, undefined, {
        status,
        allowed: RATING_ALLOWED_STATUSES,
      });
    }

    // 一次提交即定稿（裁决 ④）：该单已有任何评价行即拒绝（30021 回带 ratedAt）
    const existing = await this.ratingRepo.findOne({
      where: { orderId: Number(order.id) },
      order: { id: 'ASC' },
    });
    if (existing) {
      throw new BizException(ErrorCode.RATING_ALREADY_SUBMITTED, undefined, undefined, {
        ratedAt: toBjIso(existing.createdAt),
      });
    }

    // 菜品必须属于该单的套餐（快照来源也在这里取：ab_set_meal_item + ab_dish/ab_supplier）
    const items = await this.itemRepo.find({
      where: { setMealId: Number(order.setMealId) },
      order: { slot: 'ASC' },
    });
    const itemByDish = new Map(items.map((i) => [Number(i.dishId), i]));
    const seen = new Set<number>();
    for (const it of dto.items) {
      const mealItem = itemByDish.get(it.dishId);
      if (!mealItem) {
        // 10001：请求内容与订单事实不符（客户端拼错/换单后重放），不是业务态
        throw new BizException(ErrorCode.PARAM_INVALID, `菜品 ${it.dishId} 不在本单套餐内`);
      }
      if (seen.has(it.dishId)) {
        throw new BizException(ErrorCode.PARAM_INVALID, `菜品 ${it.dishId} 重复提交`);
      }
      seen.add(it.dishId);
    }

    // 名字快照（落库后改名/下架/软删都不影响历史行）
    const dishRows = await this.dishRepo.find({ where: { id: In([...seen]) } });
    const dishName = new Map(dishRows.map((d) => [Number(d.id), d.name]));
    const supplierRows = await this.supplierRepo.find({
      where: { id: In([...new Set(items.map((i) => Number(i.supplierId)))]) },
    });
    const supplierName = new Map(supplierRows.map((s) => [Number(s.id), s.name]));

    const nowDate = new Date();
    const rows = dto.items.map((it) => {
      const mealItem = itemByDish.get(it.dishId)!;
      const sid = Number(mealItem.supplierId);
      return this.ratingRepo.create({
        orderId: Number(order.id),
        orderNo: order.orderNo,
        userId,
        mealDate: order.mealDate,
        dishId: it.dishId,
        // 快照兜底：菜品行已被硬删（软删不影响 name 读取）时仍要有可展示的名字
        dishName: dishName.get(it.dishId) ?? `菜品#${it.dishId}`,
        supplierId: sid,
        supplierName: supplierName.get(sid) ?? `供应商#${sid}`,
        slot: mealItem.slot,
        rating: it.rating,
        reason: it.reason?.trim() || null,
        createdAt: nowDate,
      });
    });

    // 整批单事务：要么全落、要么全不落（半批落库会让「已评 2 个菜」既不能续评也不能重评）
    await this.dataSource.transaction(async (em) => {
      await em.save(DishRating, rows);
    });

    return {
      orderNo: order.orderNo,
      ratedCount: rows.length,
      ratedAt: toBjIso(nowDate)!,
    };
  }

  /* -------------------- U10 详情的评价状态块 -------------------- */

  /** U10 详情内嵌的评价状态（canRate / rated / 已评内容回显） */
  async orderRatingView(
    order: { id: number; status: string },
    items: SetMealItem[],
  ): Promise<OrderRatingView> {
    const rows = await this.ratingRepo.find({
      where: { orderId: Number(order.id) },
      order: { id: 'ASC' },
    });
    const rated = rows.length > 0;
    return {
      canRate: !rated && RATING_ALLOWED_STATUSES.includes(order.status) && items.length > 0,
      rated,
      ratedAt: rated ? toBjIso(rows[0].createdAt) : null,
      items: rows.map((r) => ({
        dishId: Number(r.dishId),
        rating: r.rating,
        reason: r.reason ?? null,
      })),
    };
  }

  /* -------------------- D69 · 口味红黑榜（后台） -------------------- */

  async dishRating(q: DishRatingQueryDto): Promise<DishRatingView> {
    const range = resolveStatsRange(q.range, q.date);

    // 只取需要的列；聚合在纯函数里完成（跨 mysql/sqlite 逐分一致 · 同 D49 选型理由）
    const rows: RatingAggRow[] = (await this.ratingRepo.find({ order: { id: 'ASC' } })).map(
      (r) => ({
        dishId: Number(r.dishId),
        dishName: r.dishName,
        supplierId: Number(r.supplierId),
        supplierName: r.supplierName,
        mealDate: r.mealDate,
        rating: r.rating,
        reason: r.reason ?? null,
        id: Number(r.id),
      }),
    );

    const agg = aggregateDishRatings(rows, range.startDate, range.endDate);

    return {
      range,
      redLineThreshold: RATING_RED_LINE_MONTHLY,
      ...agg,
    };
  }
}

import { aggregateDishRatings } from '../../src/modules/rating/rating.service';

/**
 * P1-U2 · aggregateDishRatings 纯函数口径锁定
 *
 * e2e-m3 §40 走 HTTP 路径；本文件钉**纯逻辑**的三条易碎口径：
 *   ① 月界：badCount（区间）与 monthBadCount（锚点月）必须**分道** ——
 *      上月旧账进区间不进月度，否则「本月投诉 ≥3 标红」月初天天误报；
 *   ② 黑榜序：投诉次数降序 → 同投诉次数下样本越少越扎眼 → dishId 稳定序；
 *   ③ 边界含端点 + 锚点后一行都不算。
 */

const row = (over: Partial<Parameters<typeof aggregateDishRatings>[0][number]>) => ({
  dishId: 1,
  dishName: '菜',
  supplierId: 1,
  supplierName: '供应商',
  mealDate: '2026-01-10',
  rating: 3,
  reason: null,
  id: 1,
  ...over,
});

describe('aggregateDishRatings（口味红黑榜聚合纯函数）', () => {
  it('空输入 → 空视图（空是合法业务态，不是错误）', () => {
    const v = aggregateDishRatings([], '2026-01-04', '2026-01-10');
    expect(v.totalRatings).toBe(0);
    expect(v.dishCount).toBe(0);
    expect(v.items).toEqual([]);
    expect(v.worstThree).toEqual([]);
  });

  it('⭐ 月界命门：上月差评进 badCount、不进 monthBadCount（两者分道）', () => {
    const v = aggregateDishRatings(
      [
        row({ mealDate: '2026-01-05', rating: 3, id: 1 }),
        row({ mealDate: '2026-01-06', rating: 3, id: 2 }),
        row({ mealDate: '2025-12-31', rating: 3, id: 3 }), // 上月旧账：30d 窗口内、锚点月外
      ],
      '2025-12-12',
      '2026-01-10',
    );
    const dish = v.items[0];
    expect(dish.badCount).toBe(3); // 区间投诉：含上月
    expect(dish.monthBadCount).toBe(2); // 本月投诉：不含上月
    expect(dish.redLine).toBe(false); // 3 ≥ 3 若按 badCount 判会误标红 —— 正是本条防的
  });

  it('红线：monthBadCount ≥ 3 才 redLine（计数分母与「最近原因」条数上限）', () => {
    const v = aggregateDishRatings(
      [
        row({ mealDate: '2026-01-05', rating: 3, reason: 'r1', id: 1 }),
        row({ mealDate: '2026-01-06', rating: 3, reason: 'r2', id: 2 }),
        row({ mealDate: '2026-01-07', rating: 3, reason: 'r3', id: 3 }),
        row({ mealDate: '2026-01-08', rating: 3, reason: 'r4', id: 4 }), // 第 4 条原因被截
      ],
      '2026-01-04',
      '2026-01-10',
    );
    const dish = v.items[0];
    expect(dish.monthBadCount).toBe(4);
    expect(dish.redLine).toBe(true);
    expect(dish.recentReasons).toEqual(['r4', 'r3', 'r2']); // id 大者在前、只留 3 条
    expect(dish.badRate).toBe(1); // 4/4
  });

  it('区间含端点：startDate/endDate 当日的行都算，锚点后的行一行不算', () => {
    const v = aggregateDishRatings(
      [
        row({ mealDate: '2026-01-04', rating: 1, id: 1 }), // = startDate（含）
        row({ mealDate: '2026-01-10', rating: 1, id: 2 }), // = endDate（含）
        row({ mealDate: '2026-01-11', rating: 3, id: 3 }), // 锚点后（不算）
      ],
      '2026-01-04',
      '2026-01-10',
    );
    expect(v.totalRatings).toBe(2);
    expect(v.dishCount).toBe(1);
    expect(v.items[0].goodCount).toBe(2);
    expect(v.items[0].badCount).toBe(0);
  });

  it('黑榜序：投诉次数降序 → 同投诉次数下样本越少越扎眼（差评率高者前）→ dishId 稳定序', () => {
    const v = aggregateDishRatings(
      [
        // 甲：2 投诉 / 10 评（差评率 0.2）
        ...Array.from({ length: 10 }, (_, i) =>
          row({ dishId: 10, dishName: '甲', rating: i < 2 ? 3 : 1, id: i + 1 }),
        ),
        // 乙：2 投诉 / 4 评（差评率 0.5）—— 与甲同投诉数，样本更少更扎眼 ⇒ 排前
        ...Array.from({ length: 4 }, (_, i) =>
          row({ dishId: 20, dishName: '乙', rating: i < 2 ? 3 : 1, id: 20 + i }),
        ),
        // 丙：1 投诉（垫底）
        row({ dishId: 30, dishName: '丙', rating: 3, id: 30 }),
        row({ dishId: 30, dishName: '丙', rating: 1, id: 31 }),
      ],
      '2026-01-04',
      '2026-01-10',
    );
    expect(v.items.map((i) => i.dishName)).toEqual(['乙', '甲', '丙']);
    expect(v.worstThree.map((w) => w.dishName)).toEqual(['乙', '甲', '丙']);
  });

  it('worstThree 只收有投诉的菜（无差评的菜不进「最差」名单）', () => {
    const v = aggregateDishRatings(
      [row({ dishId: 1, rating: 1, id: 1 }), row({ dishId: 2, rating: 3, id: 2 })],
      '2026-01-04',
      '2026-01-10',
    );
    expect(v.worstThree.map((w) => w.dishId)).toEqual([2]);
  });
});

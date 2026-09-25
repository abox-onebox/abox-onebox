/**
 * 口味评价契约（P1-U2 · U20 提交 / D69 聚合 · 《接口规范》U2 实现口径）
 *
 * 真源：《创业系统地图与开发路线 v1.0》U2 ——
 * 「每餐后一键评价（好吃 / 一般 / 不好，可选填原因）→ 按菜品聚合 → 出菜品红黑榜
 *   → 加上『这道菜本月第几次被投诉』的红线告警」。
 * P1 验收判据：「U2 能说出本周最差的三道菜」。
 *
 * 2026-09-25 四项裁决（P1-U2 开工前）：
 *   ① 粒度 = **逐菜三键**（整餐一键无法按菜聚合，红黑榜不成立）；
 *   ② 红黑榜落点 = 后台「菜品热度」页第二个 Tab（同域 · F5 在 P36 加 Tab 有先例）；
 *   ③ 红线阈值 = **代码常量**（不进 ab_config —— 避开 D-1 fallback 恒不生效缺陷）；
 *   ④ 评价**一次提交即定稿、不可改**（聚合口径要稳 · 极简）。
 */

/** U20 提交结果 */
export interface RatingSubmitResult {
  orderNo: string;
  /** 本次落库的评价行数（= 提交的菜品数） */
  ratedCount: number;
  /** 首次提交时刻（ISO 8601 +08:00） */
  ratedAt: string;
}

/**
 * 档位文案（好吃/一般/不好）—— 端上展示的**唯一合法来源**。
 * ⚠️ 契约里既有数字又有文案：数字是落库值、文案给人看，两者必须同源下发，
 * 否则端上自建一份映射，改文案时服务端错误信息与端上按钮就会对不上。
 */
export const RATING_LEVEL_LABELS: Record<number, string> = {
  1: '好吃',
  2: '一般',
  3: '不好',
};

/** D69 红黑榜单行 */
export interface DishRatingRow {
  dishId: number;
  /** 评价落库时的**快照名**（菜品可能被改名/下架，聚合展示不追新名） */
  dishName: string;
  supplierId: number;
  supplierName: string;
  /** 区间内被评次数 */
  ratedCount: number;
  goodCount: number;
  okCount: number;
  /** 「不好」次数 = 投诉次数（红线分子） */
  badCount: number;
  /** 差评率（0–1 · 保留 4 位）；ratedCount=0 的菜不进列表，故此处**恒非 null** */
  badRate: number;
  /** 本月（锚点月）被投诉次数 —— 真源原句「这道菜本月第几次被投诉」 */
  monthBadCount: number;
  /** monthBadCount ≥ 阈值 ⇒ 红线告警（行内标红） */
  redLine: boolean;
  /** 最近的差评原因（最多 3 条 · 新→旧）；无差评或都未填原因为空数组 */
  recentReasons: string[];
}

/** D69 聚合结果 */
export interface DishRatingView {
  /** 区间（与 D47–D50 同一套：range 定长度、date 定终点锚） */
  range: {
    range: string;
    label: string;
    startDate: string;
    endDate: string;
    days: number;
  };
  /** 红线阈值（本月投诉次数 ≥ 此值标红；代码常量 RATING_RED_LINE_MONTHLY） */
  redLineThreshold: number;
  /** 区间内评价总行数 */
  totalRatings: number;
  /** 参与聚合的菜品数 */
  dishCount: number;
  /** 本周（区间内）最差三道菜（badCount≥1 者按 badCount 降序取前 3）—— P1 验收判据的直接答案 */
  worstThree: Array<{ dishId: number; dishName: string; badCount: number }>;
  /** 全量菜品行（按 badCount 降序、ratedCount 升序、dishId 升序） */
  items: DishRatingRow[];
}

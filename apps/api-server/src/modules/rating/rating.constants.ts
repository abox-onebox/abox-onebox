import { OrderStatus } from '@abox/shared-types';

/**
 * P1-U2 口味评价 · 口径**单一真相**
 *
 * ⚠️ 与 stats.constants.ts 同理：可评状态、档位值、红线阈值**只在这里声明一次**。
 * 服务层（提交闸门 / 聚合）、控制器（Swagger 描述）、e2e（断言）全部 import 本文件。
 *
 * 四项裁决（2026-09-25 · P1-U2 开工前）：
 *   ① 粒度 = 逐菜三键；② 红黑榜落点 = 菜品热度页第二 Tab；
 *   ③ 红线阈值 = 代码常量（不进 ab_config —— 避开 D-1 fallback 恒不生效缺陷）；
 *   ④ 一次提交即定稿、不可改。
 */

/**
 * ⭐ **可评状态 = 已送达 / 已完成**
 *
 * 逐态理由：
 * - `delivered` —— 饭已到楼栋大堂，「吃到了」成立，评价的是**口味**；
 * - `completed` —— 已取餐确认，同上；
 * - `paid` / `cut_off` / `cooked` / `delivering` —— **还没吃到**：此时提交的
 *   是「预期不满」而非「口味反馈」，会污染红黑榜（那类反馈走客服/退款通道）；
 * - `cancelled` / `refund_*` —— 没吃到或不该算数；⚠️ 评价**之后**订单退款
 *   **不追溯删评价**（「当时觉得难吃」与「后来退了钱」是两件事，都该留）。
 */
export const RATING_ALLOWED_STATUSES: string[] = [OrderStatus.DELIVERED, OrderStatus.COMPLETED];

/** 评价档位：1 好吃 / 2 一般 / 3 不好（落库值 = ab_dish_rating.rating） */
export const RATING_LEVELS = [1, 2, 3] as const;
export type RatingLevel = (typeof RATING_LEVELS)[number];

// 档位中文文案（好吃/一般/不好）在 @abox/shared-types 的 RATING_LEVEL_LABELS ——
// 端上与服务端同源；本文件只留**数值域**（校验与落库），不留第二份文案映射。

/**
 * ⭐ **红线阈值：本月被投诉 ≥ 3 次标红**（真源：「这道菜本月第几次被投诉」的红线告警）
 *
 * ⚠️ **刻意是代码常量、不进 `ab_config`**（2026-09-25 裁决）：
 *   `BizConfigService.getNumber()` 存在已登记的真缺陷 D-1（`fallback` 恒不生效 ——
 *   后台显示 30 / 运行时取 0）。阈值若走配置，本批就得连带修 D-1 并补 e2e，
 *   工期外溢；且「月投诉 ≥3 次就该换菜」是**经营判断**而非运营参数，改动频率低。
 *   出参仍**下发本值**（`redLineThreshold`），端上不写死 —— 改阈值时端上文案自动跟。
 */
export const RATING_RED_LINE_MONTHLY = 3;

/** 每菜最近差评原因的回看条数（红黑榜「最近原因」列） */
export const RATING_RECENT_REASONS_MAX = 3;

/** 「最差三道菜」的固定条数 —— P1 验收判据原文「能说出本周最差的三道菜」 */
export const RATING_WORST_COUNT = 3;

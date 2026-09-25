import { OrderStatus } from '@abox/shared-types';
import { shiftBizDate } from '@abox/shared-utils';

/**
 * D47–D50 数据看板 · 统计口径**单一真相**
 *
 * ⚠️ 为什么要有这个文件：
 *   看板的每个数都是「多张表 + 一组状态 + 一个时间轴」聚合出来的，
 *   而**同一指标极容易在两个端点里各算一套**（D47 的 GMV 与 D48 的楼群 GMV、
 *   D49 的菜品份数）—— 一旦两处口径漂移，运营会看到「总额 ¥4,798 但分项加起来 ¥4,301」，
 *   从此不再信任任何一个数。故：状态集合、区间定义、基数选择**全部收在本文件**。
 *
 * 权威口径出处：《接口规范 v1.0》§6.6「关键指标口径」+「M3-11 实现口径」
 *   GMV = Σ 有效订单 `unitPriceFen × quantity`（有效 = 状态 ∉ {未支付, 已取消, 已退款}，**含在途退款**）
 *   经营毛利 = GMV − 半成品采购款（**净额**）− 履约成本（场所摊销 + 打包人工 + 配送费 × 份数）− 佣金（**净额**）
 *   退款率 = 退款三态订单数 ÷ 总订单数
 *   佣金支出 = Σ `ab_commission.amount`（`normal` 正项 + `reversal` 负项，`cancelled` 剔除）
 */

/** 统计区间（`range` 查询参数取值） */
export const STATS_RANGES = ['today', '7d', '30d'] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

/** 每档区间覆盖的**出餐日**天数（含末日） */
export const STATS_RANGE_DAYS: Record<StatsRange, number> = {
  today: 1,
  '7d': 7,
  '30d': 30,
};

/** 区间中文文案（出参回显，端上不再自建第二份） */
export const STATS_RANGE_LABELS: Record<StatsRange, string> = {
  today: '今日',
  '7d': '近 7 日',
  '30d': '近 30 日',
};

/** 默认区间：原型 P35 首屏是「近 7 日订单趋势」，故默认 7 日 */
export const STATS_DEFAULT_RANGE: StatsRange = '7d';

/**
 * ⭐ **计入 GMV 的订单状态** = 全部 11 态 − 未支付 − 已取消 − 已退款
 *
 * 逐态理由：
 * - `pending_pay` 未支付 —— 钱没到手，计入 GMV 就是虚增
 * - `cancelled` —— 截单前自助取消 / 超时未支付 / 截单兜底，均未成交
 * - `refunded` —— 钱已退回。**注意**：它的采购款仍要付给供应商（《自营结算口径定义》§5.1
 *   「退款不冲减供应商应付」），因此「GMV 不含它、采购款却含它」会让退款那部分的
 *   **经营毛利为负** —— 这是**刻意保留**的经营风险信号，不是 bug
 * - `refund_applying` / `refunding` —— 钱**尚未**退回，且此刻佣金（`normal`）尚未冲销，
 *   两边一致，故**计入**。（若把在途退款也剔出 GMV，就会出现「钱已收但 GMV 不计、
 *   佣金却还在支出」的错配，毛利被双向下拉）
 *
 * 即：**GMV 口径与「佣金/采购款的净额口径」严格对齐**，四个数放进同一个等式才算得平。
 *
 * ⚠️ 端上文案是本口径的**投影**：`core-metrics.vue` 的 GMV 副标题必须写
 *    「不含未支付 / 已取消 / 已退款（**在途退款计入**）」。**口径只改这里，文案跟着改** ——
 *    否则会出现「服务端含在途退款、页面上写着不含」的双真相（曾真实存在，M3-11 已修）。
 */
export const STATS_VALID_STATUSES: string[] = [
  OrderStatus.PAID,
  OrderStatus.CUT_OFF,
  OrderStatus.COOKED,
  OrderStatus.DELIVERING,
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
  OrderStatus.REFUND_APPLYING,
  OrderStatus.REFUNDING,
];

/**
 * ⭐ **退款率的分子 = 「处于退款流程中或已退款」的订单数**
 *
 * ⚠️ 是**订单数**，不是 `ab_refund` 条数 —— 一单被驳回后再申请就是两条 `ab_refund`
 *    记录，但只算**一次事故**（否则反复申请能把退款率刷到 100%）。
 *    正因为按订单态取，`rejected`（审批驳回、钱一分没退、订单已回退原状态）
 *    **天然不在三态内** —— 不需要再维护一份「退款率排除哪些退款单状态」的名单
 *    （曾经有过 `REFUND_RATE_EXCLUDED_STATUSES`，但它描述的是「按 `ab_refund` 算」
 *    这套**没有采用**的算法，留着只会让后来者照它实现出第二套口径，已删除）。
 */
export const STATS_REFUND_STATUSES: string[] = [
  OrderStatus.REFUND_APPLYING,
  OrderStatus.REFUNDING,
  OrderStatus.REFUNDED,
];

/**
 * 采购应付「已失效」的状态（不计入采购款总额）
 *
 * `reversed` 与 `cancelled` 都表示该行已被纠错冲销 —— 负数的 `type='reversal'` 行
 * 自身有效（status 为 pending/success），两行相加即净额。
 */
export const PURCHASE_VOID_STATUSES: string[] = ['cancelled', 'reversed'];

/** 佣金「已失效」状态（同上：冲销后原 `normal` 行翻 `cancelled`，负行有效） */
export const COMMISSION_VOID_STATUSES: string[] = ['cancelled'];

/** 菜品热度默认 TOP N */
export const DISH_HEAT_DEFAULT_TOP_N = 10;

/** 菜品热度 TOP N 上限（防一次拉全量菜品拖垮页面） */
export const DISH_HEAT_MAX_TOP_N = 50;

/** 留存分析默认观察的 cohort 周数 */
export const RETENTION_DEFAULT_COHORT_WEEKS = 4;

/**
 * ⭐ **区间解析的单一实现**（2026-09-25 自 StatsService 私有方法上提 · P1-U2）
 *
 * ## 为什么上提
 * D69（口味红黑榜）与 D47–D50 用**同一套**区间语义（`range` 定长度、`date` 定终点锚、
 * 缺省今日）。此前 `resolveRange` 是 `StatsService` 的私有方法，D69 要么注入 StatsService
 * （把整张看板服务拖进来，只为一个纯函数），要么**抄一份** —— 抄一份的后果是
 * 「缺省锚 = 今日」这类语义在两处各自演化（口径只允许声明一次）。
 * 上提为纯函数：`StatsService.resolveRange` 委托到它，D69 直接 import。
 *
 * ## 语义（与 D47–D50 既有行为逐字一致 · 不改任何口径）
 * - `range` 缺省 = `STATS_DEFAULT_RANGE`（今日锚 + 7 日）；
 * - `date` 是**终点锚点**不是自由起止 —— 期末复核要看已过完的那几天；
 * - `startDate` = 终点往前推 `days − 1` 天（含端点）。
 */
export function resolveStatsRange(
  range?: string,
  date?: string,
): {
  range: StatsRange;
  label: string;
  startDate: string;
  endDate: string;
  days: number;
} {
  const key = (range ?? STATS_DEFAULT_RANGE) as StatsRange;
  const days = STATS_RANGE_DAYS[key] ?? STATS_RANGE_DAYS[STATS_DEFAULT_RANGE];
  const endDate = date?.trim() || shiftBizDate(new Date(), 0);
  return {
    range: key,
    label: STATS_RANGE_LABELS[key],
    startDate: shiftBizDate(endDate, -(days - 1)),
    endDate,
    days,
  };
}

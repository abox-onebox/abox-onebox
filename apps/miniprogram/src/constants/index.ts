/**
 * ABox 一盒 · 全局业务常量（前端侧）
 * ⚠️ 权威来源：docs/ 下的交接包 v1.3 + PRD v2.1 + 订单状态机 v1.0
 * ⚠️ 数值变更流程：先改 docs/ → 再改本文件 → 同步 ab_config 种子
 * 运行期以服务端下发的 ab_config 为准，本文件仅作默认值与类型约束。
 */
export * from './env';

/** C1 · 套餐统一价（元） */
export const UNIT_PRICE = 25.8;

/** C9 · 单份结算口径（元） */
export const SETTLEMENT = {
  supplierTotal: 14.0,
  distributionCenter: 5.0,
  rice: 2.0,
  packing: 3.0,
  platformGrossProfit: 3.7,
} as const;

/** C2 · 4 级佣金费率 */
export const COMMISSION_RATE = {
  trainee: 0.08,
  regular: 0.09,
  gold: 0.1,
  chief: 0.12,
} as const;

/** C2 · 升级门槛（月单 **且** 介绍 N 名转正团长，双条件须同时满足） */
export const LEVEL_UP_RULE = [
  { level: 'trainee', label: '见习', rate: 0.08, monthlyOrders: 0, referrals: 0,
    note: '提交申请即生效；30 天未促单自动取消资格' },
  { level: 'regular', label: '正式', rate: 0.09, monthlyOrders: 30, referrals: 1,
    note: '月单 > 30 且介绍 1 名转正团长' },
  { level: 'gold', label: '金牌', rate: 0.1, monthlyOrders: 60, referrals: 2,
    note: '月单 > 60 且介绍 2 名转正团长' },
  { level: 'chief', label: '首席', rate: 0.12, monthlyOrders: 100, referrals: 3,
    note: '月单 > 100 且介绍 3 名转正团长' },
] as const;

/** L3 / L4 · 关键时间锚点 */
export const TIME_ANCHOR = {
  orderOpenHour: 14,        // T-1 14:00 开团
  cutoffHour: 24,           // T-1 24:00 截单（关键锚点 1）
  deliveryGenerateAt: '00:30',
  cookStart: '06:00',
  cookDeadline: '09:30',
  deliverArrive: '11:30',
  pickupWindowEnd: '12:30',
  autoConfirmHour: 14,      // T 日 14:00 自动确认收货（关键锚点 2）
  settleBatchAt: '02:00',   // T+1 02:00 跑批
  payTimeoutMinutes: 30,
} as const;

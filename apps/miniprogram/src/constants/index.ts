/**
 * ABox 一盒 · 全局业务常量（前端侧）
 * ⚠️ 权威来源：docs/ 下的交接包 v1.3 + PRD v2.1 + 订单状态机 v1.0
 * ⚠️ 数值变更流程：先改 docs/ → 再改本文件 → 同步 ab_config 种子
 * 运行期以服务端下发的 ab_config 为准，本文件仅作默认值与类型约束。
 */
export * from './env';

/** C1 · 套餐统一价（元） */
export const UNIT_PRICE = 25.8;

/**
 * 单笔订单份数上限（**默认值**）
 * ⚠️ 权威值在服务端 `ab_config.order.max_quantity`（超限返回 `30002`）；
 *    此处仅用于端上步进器封顶，避免用户白填一遍再被拒。
 */
export const ORDER_MAX_QUANTITY = 20;

/**
 * 列表分页默认条数（与《接口规范》§1.3 `PAGE_DEFAULT.pageSize` 一致）
 * ⚠️ 权威值在 `@abox/shared-types` 的 `PAGE_DEFAULT`；此处仅供端上分页请求复用。
 */
export const PAGE_SIZE = 20;

/** C9 · 单份成本项「默认 / 示例值」（元）
 * ⚠️ 口径修订 2026-09-15：**成本项不写死**，按实际执行；平台毛利为**结果值**。
 *    运行期以服务端下发的 ab_config + 供应商采购价表为准，此处仅为默认值与兜底。
 *    等式：售价 = 供应商供价 + 集散/场地费 + 打包人工 + 配送费 + 佣金 + 平台毛利
 */
export const SETTLEMENT = {
  /** 供应商供价合计（与各供应商**逐菜协商**） */
  supplierTotal: 14.0,
  /** 集散 / 场地费（集散中心**复用合作供应商场地 → 默认 0**） */
  siteFee: 0.0,
  /** 打包人工（雇佣**兼职**打包，按件/按时/按班次） */
  packingLaborFee: 0.0,
  /** 配送费（安排**货拉拉**送货，按趟/按路线） */
  deliveryFee: 0.0,
} as const;

/**
 * C9 · 单份结算明细（平台毛利为**结果值**，不再预设常量）
 * 售价 = 供应商供价 + 场地费 + 打包人工 + 配送费 + 佣金 + 毛利
 */
export function calcSettlement(
  items: Partial<typeof SETTLEMENT>,
  commissionRate: number,
  unitPrice: number = UNIT_PRICE,
) {
  const supplierTotal = items.supplierTotal ?? SETTLEMENT.supplierTotal;
  const siteFee = items.siteFee ?? SETTLEMENT.siteFee;
  const packingLaborFee = items.packingLaborFee ?? SETTLEMENT.packingLaborFee;
  const deliveryFee = items.deliveryFee ?? SETTLEMENT.deliveryFee;
  const commission = Number((unitPrice * commissionRate).toFixed(2));
  const platformGrossProfit = Number(
    (unitPrice - (supplierTotal + siteFee + packingLaborFee + deliveryFee) - commission).toFixed(2),
  );
  return {
    unitPrice,
    supplierTotal,
    siteFee,
    packingLaborFee,
    deliveryFee,
    commission,
    platformGrossProfit,
  };
}

/** C2 · 4 级佣金费率 */
export const COMMISSION_RATE = {
  trainee: 0.08,
  regular: 0.09,
  gold: 0.1,
  chief: 0.12,
} as const;

/** C2 · 升级门槛（月单 **且** 介绍 N 名转正团长，双条件须同时满足） */
export const LEVEL_UP_RULE = [
  {
    level: 'trainee',
    label: '见习',
    rate: 0.08,
    monthlyOrders: 0,
    referrals: 0,
    note: '提交申请即生效；30 天未促单自动取消资格',
  },
  {
    level: 'regular',
    label: '正式',
    rate: 0.09,
    monthlyOrders: 30,
    referrals: 1,
    note: '月单 > 30 且介绍 1 名转正团长',
  },
  {
    level: 'gold',
    label: '金牌',
    rate: 0.1,
    monthlyOrders: 60,
    referrals: 2,
    note: '月单 > 60 且介绍 2 名转正团长',
  },
  {
    level: 'chief',
    label: '首席',
    rate: 0.12,
    monthlyOrders: 100,
    referrals: 3,
    note: '月单 > 100 且介绍 3 名转正团长',
  },
] as const;

/** L3 / L4 · 关键时间锚点 */
export const TIME_ANCHOR = {
  orderOpenHour: 14, // T-1 14:00 开团
  cutoffHour: 24, // T-1 24:00 截单（关键锚点 1）
  deliveryGenerateAt: '00:30',
  cookStart: '06:00',
  cookDeadline: '09:30',
  deliverArrive: '11:30',
  pickupWindowEnd: '12:30',
  autoConfirmHour: 14, // T 日 14:00 自动确认收货（关键锚点 2）
  settleBatchAt: '02:00', // T+1 02:00 跑批
  payTimeoutMinutes: 30,
} as const;

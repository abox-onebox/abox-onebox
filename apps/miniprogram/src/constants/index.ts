/**
 * ABox 一盒 · 全局业务常量（前端侧）
 * ⚠️ 权威来源：docs/ 下的交接包 v1.3 + PRD v2.1 + 订单状态机 v1.0
 * ⚠️ 数值变更流程：先改 docs/ → 再改本文件 → 同步 ab_config 种子
 * 运行期以服务端下发的 ab_config 为准，本文件仅作默认值与类型约束。
 */
export * from './env';
// ⚠️ 协议**正文**在 `./agreements`（唯一真源）；此处在桶文件里再导出一次，便于统一从 `@/constants` 取用。
export * from './agreements';

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
  formal: 0.09,
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
    level: 'formal',
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

/**
 * ⭐ 已**删除** `TIME_ANCHOR` 常量表（PR-02 收口 · 2026-09-21）
 *
 * 它原先在此声明了 10 个业务时刻（`orderOpenHour` / `cutoffHour` / `deliverArrive` …）。
 * 删除依据（机械核实，非印象）：
 *   · **10/10 成员零消费** —— 全仓（`apps/` `packages/` `scripts/`）grep 无任何读取点；
 *   · 它是**服务端时间轴的第二份表述**（真源 `order-timeline.ts` 的 `DEFAULT_TIMELINE`
 *     + `ab_config` 覆写）；留着**不会报错**，只会让人误以为「端上也能改时刻」。
 *
 * ⚠️ 端上**不要再建任何时刻常量表**：
 *   · 需要展示的时刻**一律从响应取** —— `HomeDailyResult.cutoffAt/deliverAt`、
 *     `OrderDetailResult.pickup.expectAt`、`LeaderInviteLanding.deliverAt`；
 *   · 真源只有一处：`apps/api-server/src/common/utils/order-timeline.ts`。
 */

//
// ⚠️⭐ 2026-10-04：原 `TAKEOUT_MINI_PROGRAM_APPID` 常量已删除（死代码 + 复活通道）
//
//   判定依据（2026-10-03 作出，勿推翻）：溯源页跳转美团/淘宝/京东撞《微信小程序平台
//   运营规范》**5.10 互推行为** —— 不得为他人 APP/小程序集中设立跳转、或为其推荐、
//   推广、提供协助或便利（处理 = **下架**）。
//
//   ⚠️ 技术门槛已消失 ≠ 风险消失：`navigateToMiniProgramAppIdList` 白名单已于
//   2020-04-24 取消、数量不限，现行只剩「用户点击触发 + 跳转前弹窗确认」。
//   ⇒ 下面这段旧注释里「须进后台名单 / 对方同意 / 同开放平台主体」的说法**已过时**，
//      真正的拦路虎 100% 是运营规范，不是技术。**不要据此判断"技术上行就行"。**
//
//   ⚠️ 同理，「复制店名引导去平台内搜索」的降级路径也**不可行**：官方 5.20 诱导下载
//      行为逐字含「通过利用剪切板能力达到诱导跳转/下载 APP 目的」，5.10 现行原文更已
//      删掉「未经腾讯书面同意」前缀、明写不得提供任何**协助或便利**。
//
//   ⇒ 铁律：**小程序内不得出现任何第三方平台的名称 / 标识 / 链接 / 可跳转物 / 可复制口令。**
//      信任改由**供应商资质墙**承载（`pages/supplier/*`），那才是用户真正要看的东西。
//
//   服务端同样已停止下发（`traceability.service.ts` / `traceability.dto.ts` 的对应改动）。
//

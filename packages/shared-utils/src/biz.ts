/**
 * 业务常量
 * ⚠️ 变更流程：先改 docs/ → 再改此处 → 同步 ab_config 种子。
 *
 * 【口径修订 2026-09-15 · C9 由「常量等式」改为「可变成本 + 结果毛利」】
 * - **锁定**（业务规则，不随成本浮动）：售价 ¥25.80 · 4 级佣金费率 · 结算等式结构 · 退款按同结构反向回退（毛利留存）
 * - **可配置**（不写死，按实际执行）：
 *     · 供应商供价 —— 与各供应商**逐菜协商**（见供应商采购价表）
 *     · 集散/场地费 —— 集散中心**复用合作供应商场地 → 默认 ¥0**（科目保留，按实际登记）
 *     · 打包人工 —— 雇佣**兼职**打包（按件 / 按时 / 按班次）
 *     · 配送费 —— 安排**货拉拉**送货（按趟 / 按路线）
 * - **平台毛利 = 售价 − 成本合计 − 佣金（结果值）**，随成本浮动，**不再设为预设常量**
 *
 * 等式：售价 = 供应商供价 + 集散/场地费 + 打包人工 + 配送费 + 团长佣金 + 平台毛利
 *
 * ⚠️ 【口径修订 2026-09-16 · 路线裁定「单主体自营 + 半成品供应链」】
 * **等式结构不变**，但科目语义换血 —— 详见《ABox一盒自营结算口径定义v1.0.md》：
 * - 供应商供价 → **半成品采购款**（单价 × **实收量**，实收量取 S2 出餐确认的 actual_quantity）
 * - 场地费 → **ABox 自有持证场所摊销**（不再「复用供应商场地」，**默认值不再为 0**）
 * - 打包人工 / 配送费 → **ABox 自身履约成本**（不进应付结算单，只进成本核算）
 * - 平台毛利 → 中文口径改称「**经营毛利**」（字段名保持不变以免牵动已消费端）；
 *   **经营毛利 ≠ 实际净利**（后者还要再扣上述履约成本）
 * - **应付对象只剩供应商**；`payee_type='distribution_center'` 已冻结
 * - ⚠️ **用户退款不冲减供应商应付**（半成品已交付）—— 与 M3-3 旧实现相反，待回退
 */
export const BIZ = {
  /** C1 · 套餐统一价（锁定；存 ab_config：set_meal.default_price） */
  unitPrice: 25.8,
  /** C2 · 4 级佣金费率（锁定） */
  commissionRate: { trainee: 0.08, formal: 0.09, gold: 0.1, chief: 0.12 },
  /** L3 · 截单时刻（24 点即次日 00:00） */
  cutoffHour: 24,
  /** 未支付订单有效期（分钟） */
  payTimeoutMinutes: 30,
  /** 订单份数上限 */
  maxQuantityPerOrder: 20,
} as const;

/**
 * C9 · 单份成本项「默认 / 示例值」（元）
 * ⚠️ **非锁定常量**：运行期一律以 `ab_config` + 供应商采购价表为准；
 *    此处仅用于本地种子数据与缺省兜底，**禁止**在业务逻辑中当作固定口径使用。
 * ⚠️ 自营口径（2026-09-16）：`0` 只表示「尚未登记实际值」，**不代表真实成本为零** ——
 *    自营下场地（自有场所摊销）、打包（ABox 用工）、配送（ABox 履约）**都是有成本的**，
 *    因此折算出的「经营毛利」是**上限**，实际净利必定更低。详见《自营结算口径定义v1.0.md》§2.3。
 */
export const SETTLEMENT_DEFAULTS = {
  /** 半成品采购款合计（逐菜逐供应商协商采购价 × 实收量） */
  supplierTotal: 14.0,
  /** ABox 自有持证场所摊销（自营口径：不再「复用供应商场地」，默认 0 仅表示未登记） */
  siteFee: 0.0,
  /** ABox 加工场所用工（工资 / 劳务报酬） */
  packingLaborFee: 0.0,
  /** ABox 履约配送成本（自有或外包运费） */
  deliveryFee: 0.0,
} as const;

/** 单份成本项（全部可配置；由运营在后台维护） */
export interface SettlementCostItems {
  /** 供应商供价合计（按实际协商价） */
  supplierTotal: number;
  /** 集散 / 场地费（复用地 → 通常为 0） */
  siteFee: number;
  /** 打包人工（兼职） */
  packingLaborFee: number;
  /** 配送费（货拉拉） */
  deliveryFee: number;
}

/** 单份结算明细（平台毛利为**结果值**） */
export interface SettlementBreakdown extends SettlementCostItems {
  /** 套餐售价 */
  unitPrice: number;
  /** 团长佣金 */
  commission: number;
  /** 平台毛利 = 售价 − 成本合计 − 佣金（可能为负，业务侧需关注） */
  platformGrossProfit: number;
}

/** 成本项合计（不含佣金） */
export function settlementCostTotal(items: SettlementCostItems): number {
  return Number(
    (items.supplierTotal + items.siteFee + items.packingLaborFee + items.deliveryFee).toFixed(2),
  );
}

/**
 * 计算单份结算明细（毛利为差额结果值）。
 * @param items 各成本项；缺省项回落到 {@link SETTLEMENT_DEFAULTS}
 * @param commissionRate 团长佣金费率（如首席 0.12）
 * @param unitPrice 售价，缺省取 {@link BIZ.unitPrice}（锁定 25.80）
 */
export function calcSettlement(
  items: Partial<SettlementCostItems>,
  commissionRate: number,
  unitPrice: number = BIZ.unitPrice,
): SettlementBreakdown {
  const supplierTotal = items.supplierTotal ?? SETTLEMENT_DEFAULTS.supplierTotal;
  const siteFee = items.siteFee ?? SETTLEMENT_DEFAULTS.siteFee;
  const packingLaborFee = items.packingLaborFee ?? SETTLEMENT_DEFAULTS.packingLaborFee;
  const deliveryFee = items.deliveryFee ?? SETTLEMENT_DEFAULTS.deliveryFee;

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

/**
 * 单份结算「等式闭合」校验。
 * 售价 = 供应商供价 + 场地费 + 打包人工 + 配送费 + 佣金 + 毛利 —— 恒应闭合。
 * 用于验证配置值 / 计算值 / 落库值三者一致（如对账、退款反向回退）。
 */
export function assertSettlementClosed(
  items: Partial<SettlementCostItems>,
  commissionRate: number,
  unitPrice: number = BIZ.unitPrice,
): boolean {
  const b = calcSettlement(items, commissionRate, unitPrice);
  const sum = Number(
    (
      b.supplierTotal +
      b.siteFee +
      b.packingLaborFee +
      b.deliveryFee +
      b.commission +
      b.platformGrossProfit
    ).toFixed(2),
  );
  return Math.abs(sum - b.unitPrice) < 0.005;
}

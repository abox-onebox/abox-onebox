/**
 * 业务常量（C1 / C2 / C9 锁定值）
 * ⚠️ 变更流程：先改 docs/ → 再改此处 → 同步 ab_config 种子。
 */
export const BIZ = {
  /** C1 · 套餐统一价 */
  unitPrice: 25.8,
  /** C9 · 集散中心 ¥5/份 = 米饭 ¥2 + 打包 ¥3 */
  rice: 2.0,
  packing: 3.0,
  distributionCenter: 5.0,
  /** C9 · 4 家菜品供应商合计（按菜品成本单价） */
  supplierTotal: 14.0,
  /** C9 · 平台毛利 */
  platformGrossProfit: 3.7,
  /** C2 · 4 级佣金费率 */
  commissionRate: { trainee: 0.08, regular: 0.09, gold: 0.1, chief: 0.12 },
  /** L3 · 截单时刻（24 点即次日 00:00） */
  cutoffHour: 24,
  /** 未支付订单有效期（分钟） */
  payTimeoutMinutes: 30,
  /** 订单份数上限 */
  maxQuantityPerOrder: 20,
} as const;

/** 单份结算自校验：¥14.00 + ¥5.00 + ¥3.10 + ¥3.70 = ¥25.80 */
export function assertSettlementClosed(commissionRate: number): boolean {
  const commission = Number((BIZ.unitPrice * commissionRate).toFixed(3));
  const sum = Number(
    (BIZ.supplierTotal + BIZ.distributionCenter + commission + BIZ.platformGrossProfit).toFixed(2),
  );
  return Math.abs(sum - BIZ.unitPrice) < 0.005;
}

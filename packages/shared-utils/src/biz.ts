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
 * ⭐ **「一饭四菜」套餐构成**（锁定口径 · M5-15 收敛）
 *
 * 此前这条口径**只存在于文案与种子数据里**，两份表述各说各话：
 *   · `seeds/seed.ts` 与全部 7 个种子模板：**4 项**（主荤/半荤/素菜/汤），
 *     并注明「主食由集散中心统一供米（¥2/份），不计入供应商菜品成本，故不建 item」；
 *   · 后台编排页 `views/meal/edit.vue`：按「**五个**档位各选一道菜」渲染，
 *     且只把 1 号档标成「核心」（= 只强制一道） → 于是**只有 1 道菜的套餐也能存**，
 *     而用户端横幅照旧写着「一饭四菜」。
 *
 * 收敛后：真源在此，服务端（校验）与后台（渲染）**同读一份**。
 *
 * - `requiredSlots`：四个**必选**菜位，各一道，不缺不重；
 * - `stapleSlot`：**主食档位号 —— 不作为菜品项**。米饭由集散中心统一供，
 *   把米饭也建成一道菜会让同一份 ¥2 同时进「菜品成本」与「主食成本」，
 *   结算时才发现重复计。故服务端**拒绝**该档位出现在 `items` 里。
 * - `rule`：给人看的一句话（校验失败提示 / 后台提示条**共用同一句**，避免措辞漂移）。
 */
export const SET_MEAL_COMPOSITION = {
  requiredSlots: [1, 2, 3, 4] as const,
  stapleSlot: 5,
  rule: '一饭四菜：需恰好包含「主荤 / 半荤 / 素菜 / 汤」四个档位各一道（主食米饭由集散中心统一供，不建菜品项）',
} as const;

/** 档位文案（`ab_set_meal_item.slot`）—— 服务端与后台**共用**，避免两处各写一份中文 */
export const SET_MEAL_SLOT_LABEL: Record<number, string> = {
  1: '主荤',
  2: '半荤',
  3: '素菜',
  4: '汤',
  5: '主食',
};

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

/* ------------------------------------------------------------------ *
 * C9 履约成本「是否已登记」判据（自营口径 2026-09-16）
 *
 * ⭐ 为什么需要一列「是否已登记」：
 *   自营口径下场所摊销 / 打包人工 / 配送费**都是 ABox 的真实成本**，
 *   `0.00` 只可能表示「运营还没填」。但配置表里存的就是 `0.00` ——
 *   单看数字无法区分「成本真的是 0」和「忘了填」。
 *   经营毛利（D47）必须据此判断自己给的是**真实值**还是**上限值**，
 *   否则运营会拿一个被系统性高估的毛利去做决策。
 *
 * ⚠️ 判据只有这一份实现：D57 系统配置页的「未登记」标记与
 *    D47 数据看板的「毛利为上限值」提示**共用本函数** —— 两处各自实现，
 *    必然出现「配置页说已登记、看板说未登记」这种自相矛盾。
 * ------------------------------------------------------------------ */

/** 单份履约成本项 ↔ `ab_config` 配置键 */
export const SETTLEMENT_COST_CONFIG_KEYS = {
  siteFee: 'settlement.site_fee',
  packingLaborFee: 'settlement.packing_labor_fee',
  deliveryFee: 'settlement.delivery_fee',
} as const;

/** 履约成本项中文名（端上直接展示，不再各写一份） */
export const SETTLEMENT_COST_LABELS = {
  siteFee: '场所摊销',
  packingLaborFee: '打包人工',
  deliveryFee: '配送费',
} as const;

/** 需要登记的履约成本项（**不含**供应商供价 —— 那是逐菜协商价，不在这三项里） */
export type SettlementCostKey = keyof typeof SETTLEMENT_COST_CONFIG_KEYS;

export const SETTLEMENT_COST_KEYS: SettlementCostKey[] = [
  'siteFee',
  'packingLaborFee',
  'deliveryFee',
];

export interface SettlementCostRegistration {
  /** 三项是否全部已登记 */
  allRegistered: boolean;
  /** 逐项登记状态 */
  registered: Record<SettlementCostKey, boolean>;
  /** 未登记的项（键名，供程序分支） */
  missingKeys: SettlementCostKey[];
  /** 未登记的项（中文名，**可直接展示**） */
  missingLabels: string[];
  /** 三项合计（元/份）—— 未登记的项按 0 计入，故该值同样是**下限** */
  total: number;
}

/**
 * 单个成本值是否「已登记」
 *
 * 判据：`> 0`。自营下三项成本不可能为零（场地要摊销、打包要付工钱、送货要付运费），
 * 所以 `0` / 空 / 非数字一律视为**未登记**。
 */
export function isCostRegistered(value: unknown): boolean {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

/** 汇总三项履约成本的登记状态（D57 配置页 / D47 看板共用） */
export function summarizeCostRegistration(
  items: Partial<Record<SettlementCostKey, number>>,
): SettlementCostRegistration {
  const registered = {} as Record<SettlementCostKey, boolean>;
  const missingKeys: SettlementCostKey[] = [];
  const missingLabels: string[] = [];
  let total = 0;

  for (const key of SETTLEMENT_COST_KEYS) {
    const value = items[key] ?? 0;
    const ok = isCostRegistered(value);
    registered[key] = ok;
    if (!ok) {
      missingKeys.push(key);
      missingLabels.push(SETTLEMENT_COST_LABELS[key]);
    }
    if (Number.isFinite(value)) total += value;
  }

  return {
    allRegistered: missingKeys.length === 0,
    registered,
    missingKeys,
    missingLabels,
    total: Number(total.toFixed(2)),
  };
}

/** 未登记时的统一提示（配置页与看板用同一句话，避免两处口径打架） */
export function costRegistrationWarning(missingLabels: string[]): string {
  const names = missingLabels.join(' / ');
  return (
    `履约成本「${names}」尚未登记（当前按 0 计），因此经营毛利只是**上限值**，` +
    `会被系统性高估。请到「系统配置 → 履约成本」填写真实值。`
  );
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

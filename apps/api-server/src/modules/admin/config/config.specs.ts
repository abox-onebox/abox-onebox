/**
 * 系统配置规格清单（D57 / D58 的**唯一真相**）
 *
 * 依据：《接口规范 v1.0》§6.7 D57 / D58 · 《自营结算口径定义 v1.0》· 《协作规范》第 4 处纪律
 *
 * ## 为什么要有这份清单
 * `ab_config` 是**键值表** —— 表本身不告诉你「这个键是什么、能不能改、改了谁受影响」。
 * 若把中文标签写在前端、把校验规则分散在 DTO 里、把可写判定藏在服务方法里，
 * 同一个键就会有三份互相漂移的定义（本项目的头号顽疾：**两个真相**）。
 * 因此这里用**一份声明**同时驱动：D57 出参分组与文案 / D58 白名单与校验 / 前端控件类型。
 *
 * ## ⭐ `wiring` —— 本清单最重要的一列
 * 排查中发现：种子里 **9 个键被配置了，但服务端代码从不读取**。
 *   · 时间类（`set_meal.publish_time` / `cutoff_time` / `delivery_arrival_time` /
 *     `commission.auto_confirm_time` / `commission.settle_hour`）—— 实际调度**硬编码在
 *     `@Cron()` 装饰器里**（NestJS 的 cron 是静态元数据，不读配置）；
 *   · `distribution_center.*`（3 项）/ `supplier.settle_cycle`
 *     —— 相关口径已改由表驱动或由代码常量确定。
 *
 * 这些键**继续允许在页面上看到**（它们是口径记录，删掉反而丢失信息），
 * 但必须**如实标注「改此值不生效」**，并标为只读。
 *
 * ⚠️ 为什么不「顺手把配置接到 cron 上」：那要改 `SchedulerRegistry` 动态注册或
 *    `@Interval` + 运行期判断，会动到**下单窗口**（e2e 全量依赖 14:00–23:00 时间窗），
 *    属独立验收项。混在本批次里，只会让「配置页做完了」掩盖「调度还没接线」。
 *    已登记为独立待办（见《缺陷与陷阱》#49）。
 */

/** 值的语义类型 —— 决定前端控件与服务端校验规则 */
export type ConfigValueType =
  | 'money' // 金额（元，两位小数；存储为字符串）
  | 'percent' // 百分比（**入参/出参均为百分数**，如 8 表示 8%；存储为 0.0800）
  | 'int' // 整数
  | 'text' // 文本
  | 'time' // HH:mm
  | 'enum' // 枚举（须在 options 内）
  | 'policy'; // 策略标识（非金额、非数值，仅记录口径）

/** 该键影响哪个域 —— 供前端按「资金口径 / 运营文案」分级提示 */
export type ConfigImpact = 'pricing' | 'commission' | 'settlement' | 'order' | 'service' | 'master';

/**
 * 接线状态 —— **本清单的核心信息**
 * - `live`    已接线：代码真的会读它，改了就生效
 * - `unwired` 未接线：值存在但不被任何代码读取，**改了不生效**（只读 + 注明原因）
 * - `policy`  策略标识：记录的是策略名而非金额（如 `negotiated`），不可写
 */
export type ConfigWiring = 'live' | 'unwired' | 'policy';

export interface ConfigOption {
  value: string;
  label: string;
}

export interface ConfigSpec {
  key: string;
  group: string;
  label: string;
  type: ConfigValueType;
  impact: ConfigImpact;
  wiring: ConfigWiring;
  /** 这个键是干什么的（写给运营看，不是写给开发看） */
  description: string;
  /** 单位（money → 元；percent → %；int 按语义填「份 / 分钟」） */
  unit?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  options?: ConfigOption[];
  /**
   * 代码兜底值（**库中无此行**时实际生效的值）
   *
   * ⚠️ 排查发现有两个键**不在种子数据里**（`order.pay_timeout_minutes` /
   *    `settlement.supplier_total_default`）—— 它们靠 `BizConfigService` 的
   *    `getNumber(key, fallback)` 兜底。若不显式声明，D57 只能显示空白，
   *    运营会以为「配置丢了」，而实际系统正按某个值运行。
   */
  fallbackValue?: string;
  /**
   * 成本类专属：**值为 0 表示「未登记」，而不是「成本为零」**
   *
   * 自营口径（2026-09-16 裁定）：场所摊销 / 打包人工 / 配送费都是 ABox 的**真实成本**，
   * `0.00` 只可能是「还没填」。D47 经营毛利据此判断是否只能给出**上限值**。
   */
  zeroMeansUnregistered?: boolean;
  /** 未接线时的原因（`wiring='unwired'` 必填）—— 要能回答「为什么改了没用」 */
  unwiredReason?: string;
  /**
   * 改了会影响谁 —— 直接回答运营最关心的问题
   *
   * ⚠️ 这一列是排查出来的**事实**（代码里 grep 到的消费点），不是设计意图。
   *    两者不符时以事实为准，并把差异登记进《缺陷与陷阱》。
   */
  consumedBy: string;
}

/** 分组（顺序即页面渲染顺序） */
export const CONFIG_GROUPS: Array<{ group: string; label: string; description: string }> = [
  {
    group: 'pricing',
    label: '套餐与价格',
    description:
      '售价口径 C1：¥25.80 统一定价。改后只影响**新建的开团计划**，历史订单用下单时的单价快照。',
  },
  {
    group: 'commission',
    label: '团长佣金',
    description:
      '佣金口径 C2：四级费率 8 / 9 / 10 / 12%。⚠️ 改费率**不影响已建档团长** —— ' +
      '每人有自己的 `commission_rate` 快照，此处的值只在**团长晋级**时写入。',
  },
  {
    group: 'settlement',
    label: '履约成本（自营口径）',
    description:
      '⭐ 自营口径下这三项是 ABox 自己的成本（不是付给第三方的费用），**都必须登记真实值**。' +
      '留 0 只表示「尚未登记」，会让经营毛利**被系统性高估**（该值退化为上限值）。',
  },
  {
    group: 'order',
    label: '交易规则',
    description: '下单与支付环节的硬约束。改动**立即生效**（进程内缓存同步失效）。',
  },
  {
    group: 'service',
    label: '客服入口',
    description:
      '一期不做在线客服，统一引导用户添加客服微信（U17）。此处是端上唯一的联系方式来源。',
  },
  {
    group: 'master',
    label: '调度与预留（当前未接线）',
    description:
      '⚠️ 以下键**改了对系统没有任何影响** —— 它们的值被硬编码在代码或定时任务里。' +
      '保留展示是为了留下口径记录，避免「这个参数到底定的是多少」只能翻代码。',
  },
];

/**
 * 配置规格（覆盖 `ab_config` 全量键）
 *
 * ⚠️ 未列入本清单的键 = **D58 不可写**（白名单，不静默忽略）。
 *    这是安全设计：`ab_config` 里可能有内部键，放开「任意 key 都能改」等于开后门。
 */
export const CONFIG_SPECS: ConfigSpec[] = [
  // ------------------------------------------------------------ pricing 套餐与价格
  {
    key: 'set_meal.default_price',
    group: 'pricing',
    label: '套餐默认售价',
    type: 'money',
    impact: 'pricing',
    wiring: 'live',
    description: '一饭四菜的统一定价（C1）。新建套餐模板时的默认值，也是下单校验的单价来源。',
    unit: '元',
    min: 0.01,
    max: 9999.99,
    consumedBy: '`meal.service` 下单校验取价 · `meal-admin.service` 建套餐默认价',
  },

  // ------------------------------------------------------------ commission 团长佣金
  {
    key: 'commission.rate.trainee',
    group: 'commission',
    label: '见习团长费率',
    type: 'percent',
    impact: 'commission',
    wiring: 'live',
    description: 'C2 四级佣金之一。⚠️ 仅在**团长晋级 / 建档**时写入其 `commission_rate` 快照。',
    unit: '%',
    min: 0,
    max: 100,
    consumedBy: '`promotion.service` 晋级时写入团长费率快照',
  },
  {
    key: 'commission.rate.formal',
    group: 'commission',
    label: '正式团长费率',
    type: 'percent',
    impact: 'commission',
    wiring: 'live',
    description: 'C2 四级佣金之一（转正门槛：月单 >30 + 介绍 1 人）。',
    unit: '%',
    min: 0,
    max: 100,
    consumedBy: '`promotion.service` 晋级时写入团长费率快照',
  },
  {
    key: 'commission.rate.gold',
    group: 'commission',
    label: '金牌团长费率',
    type: 'percent',
    impact: 'commission',
    wiring: 'live',
    description: 'C2 四级佣金之一（门槛：月单 >60 + 介绍 2 人）。',
    unit: '%',
    min: 0,
    max: 100,
    consumedBy: '`promotion.service` 晋级时写入团长费率快照',
  },
  {
    key: 'commission.rate.chief',
    group: 'commission',
    label: '首席团长费率',
    type: 'percent',
    impact: 'commission',
    wiring: 'live',
    description: 'C2 四级佣金之一（门槛：月单 >100 + 介绍 3 人）。',
    unit: '%',
    min: 0,
    max: 100,
    consumedBy: '`promotion.service` 晋级时写入团长费率快照',
  },
  {
    key: 'commission.min_withdraw',
    group: 'commission',
    label: '最低提现金额',
    type: 'money',
    impact: 'commission',
    wiring: 'live',
    description: '团长发起提现的金额下限；低于此值直接拒绝，避免小额出款被手续费吃掉。',
    unit: '元',
    min: 0,
    max: 99999,
    consumedBy: '`commission.service` 提现校验 · `withdraw.service` 提现校验',
  },
  {
    key: 'commission.payout_channel',
    group: 'commission',
    label: '佣金出款通道',
    type: 'enum',
    impact: 'commission',
    wiring: 'live',
    description:
      'C11 出款通道。一期走灵活用工平台**人工**通道（FLEX_MANUAL）；' +
      'FLEX_API 为二期（平台侧有 API 后切换）。',
    options: [
      { value: 'FLEX_MANUAL', label: '灵活用工平台 · 人工提交（一期）' },
      { value: 'FLEX_API', label: '灵活用工平台 · API 直连（二期）' },
    ],
    consumedBy: '`commission.service` 待打款清单 · `withdraw.service` 生成打款批次',
  },

  // ------------------------------------------------------------ settlement 履约成本
  {
    key: 'settlement.site_fee',
    group: 'settlement',
    label: '场所摊销',
    type: 'money',
    impact: 'settlement',
    wiring: 'live',
    description:
      'ABox **自有持证场所**的摊销（加工/集散场地租金、水电等）。' +
      '⚠️ 0 表示**尚未登记**，不代表没有成本 —— 自营场所是实打实的支出。',
    unit: '元/份',
    min: 0,
    max: 999,
    zeroMeansUnregistered: true,
    consumedBy: '`BizConfigService.settlementCostItems()` → **经营毛利**（D47 数据看板）',
  },
  {
    key: 'settlement.packing_labor_fee',
    group: 'settlement',
    label: '打包人工',
    type: 'money',
    impact: 'settlement',
    wiring: 'live',
    description: 'ABox 雇佣兼职打包的用工成本。⚠️ 0 表示尚未登记。',
    unit: '元/份',
    min: 0,
    max: 999,
    zeroMeansUnregistered: true,
    consumedBy: '`BizConfigService.settlementCostItems()` → **经营毛利**（D47 数据看板）',
  },
  {
    key: 'settlement.delivery_fee',
    group: 'settlement',
    label: '配送费',
    type: 'money',
    impact: 'settlement',
    wiring: 'live',
    description: '履约配送成本（货拉拉按趟计费，折算到单份）。⚠️ 0 表示尚未登记。',
    unit: '元/份',
    min: 0,
    max: 999,
    zeroMeansUnregistered: true,
    consumedBy: '`BizConfigService.settlementCostItems()` → **经营毛利**（D47 数据看板）',
  },
  {
    key: 'settlement.supplier_purchase_price',
    group: 'settlement',
    label: '供价来源策略',
    type: 'policy',
    impact: 'settlement',
    wiring: 'policy',
    description:
      '策略标识（非金额）：供应商供价与各供应商**逐菜协商**，落在采购价表与出餐计划快照里，' +
      '不是本配置能定义的单一数字。',
    consumedBy: '仅作口径记录 —— 实际供价取 `ab_supplier_dish_daily.unit_price` 冻结快照',
  },
  {
    key: 'settlement.supplier_total_default',
    group: 'settlement',
    label: '供价合计兜底值',
    type: 'money',
    impact: 'settlement',
    wiring: 'live',
    description:
      '协商价缺失时的兜底单份供价（示例值 14.00）。⚠️ 该键**不在种子数据中**，' +
      '未设置时回落到代码常量 `SETTLEMENT_DEFAULTS.supplierTotal`。',
    unit: '元/份',
    min: 0,
    max: 999,
    fallbackValue: '14.00',
    consumedBy: '`BizConfigService.settlementCostItems()` 的 `supplierTotal` 项',
  },

  // ------------------------------------------------------------ order 交易规则
  {
    key: 'order.max_quantity',
    group: 'order',
    label: '单次下单份数上限',
    type: 'int',
    impact: 'order',
    wiring: 'live',
    description: '单个订单可购买的份数上限，超限拒绝下单。',
    unit: '份',
    min: 1,
    max: 999,
    consumedBy: '`order.service` 下单校验 · `order-admin.service` 改单校验',
  },
  {
    key: 'order.cutoff_window_minutes',
    group: 'order',
    label: '截单前禁下单窗口',
    type: 'int',
    impact: 'order',
    wiring: 'live',
    description: '截单前 N 分钟内禁止下单，给运营留出汇总与备料时间。',
    unit: '分钟',
    min: 0,
    max: 720,
    consumedBy: '`meal.service` canOrder 判定 · `order.service` 下单校验',
  },
  {
    key: 'order.pay_timeout_minutes',
    group: 'order',
    label: '未支付订单有效期',
    type: 'int',
    impact: 'order',
    wiring: 'live',
    description:
      '下单后多少分钟内未支付则自动取消（T3）。⚠️ 该键**不在种子数据中**，' +
      '未设置时回落到代码常量（30 分钟）。',
    unit: '分钟',
    min: 5,
    max: 1440,
    fallbackValue: '30',
    consumedBy: '`order.service` 支付超时判定',
  },

  // ------------------------------------------------------------ service 客服入口
  {
    key: 'service.wechat_id',
    group: 'service',
    label: '客服微信号',
    type: 'text',
    impact: 'service',
    wiring: 'live',
    description:
      '⚠️ 种子内为**演示占位值**（`abox_service`），上线前必须替换为真实客服号。' +
      '用户端「联系客服」页的唯一来源。',
    maxLength: 64,
    consumedBy: '`BizConfigService.supportContact()` → U17 客服页',
  },
  {
    key: 'service.wechat_qrcode',
    group: 'service',
    label: '客服二维码图片地址',
    type: 'text',
    impact: 'service',
    wiring: 'live',
    description: '留空则端上隐藏二维码区域（不显示占位图）。',
    maxLength: 512,
    consumedBy: '`BizConfigService.supportContact()` → U17 客服页',
  },
  {
    key: 'service.phone',
    group: 'service',
    label: '客服电话',
    type: 'text',
    impact: 'service',
    wiring: 'live',
    description: '可留空（留空则端上不显示电话入口）。',
    maxLength: 32,
    consumedBy: '`BizConfigService.supportContact()` → U17 客服页',
  },
  {
    key: 'service.hours',
    group: 'service',
    label: '客服服务时间',
    type: 'text',
    impact: 'service',
    wiring: 'live',
    description: '展示给用户的服务时段文案。',
    maxLength: 64,
    consumedBy: '`BizConfigService.supportContact()` → U17 客服页',
  },
  {
    key: 'service.tips',
    group: 'service',
    label: '客服页提示文案',
    type: 'text',
    impact: 'service',
    wiring: 'live',
    description: '客服页的引导话术（端上不自造文案，一律从此处下发）。',
    maxLength: 512,
    consumedBy: '`BizConfigService.supportContact()` → U17 客服页',
  },

  // ------------------------------------------------------------ master 未接线（如实标注）
  // ⚠️ 以下 10 项里，9 项为「未接线」、1 项为「策略标识」（`gross_profit_policy`）。
  //    未接线 = 改了不生效。保留展示 + 只读 + 注明原因，见本文件头部说明。
  {
    key: 'set_meal.publish_time',
    group: 'master',
    label: '开团时间',
    type: 'time',
    impact: 'master',
    wiring: 'unwired',
    description: '口径记录：T-1 14:00 开放次日预订。',
    unwiredReason: '实际由 `meal-publish.task` 的 `@Cron("0 0 14 * * *")` 硬编码，不读本键。',
    consumedBy: '无 —— 调度硬编码在定时任务装饰器里',
  },
  {
    key: 'set_meal.cutoff_time',
    group: 'master',
    label: '截单时间',
    type: 'time',
    impact: 'master',
    wiring: 'unwired',
    description: '口径记录：T-1 24:00 截单（语义 = 当日 23:59）。',
    unwiredReason:
      '实际由 `cutoff.task` 的 `@Cron("0 0 0 * * *")` 在 00:00 执行；' +
      '用户可下单窗口另由 `isOrderable()` 计算（截止 23:00），两者都以代码为准。',
    consumedBy: '无 —— 调度硬编码在定时任务装饰器里',
  },
  {
    key: 'set_meal.delivery_arrival_time',
    group: 'master',
    label: '送达时间',
    type: 'time',
    impact: 'master',
    wiring: 'unwired',
    description: '口径记录：次日 11:30 送达办公楼。',
    unwiredReason: '实际送达时点写在 `ab_delivery_record.expected_at` 的生成逻辑里，不读本键。',
    consumedBy: '无 —— 送达时点在生成送货记录时计算',
  },
  {
    key: 'commission.auto_confirm_time',
    group: 'master',
    label: '自动确认收货时间',
    type: 'time',
    impact: 'master',
    wiring: 'unwired',
    description: '口径记录：T 日 14:00 自动确认收货。',
    unwiredReason: '实际由 `auto-confirm.task` 的 `@Cron("0 0 14 * * *")` 硬编码，不读本键。',
    consumedBy: '无 —— 调度硬编码在定时任务装饰器里',
  },
  {
    key: 'commission.settle_hour',
    group: 'master',
    label: '佣金结算时点',
    type: 'time',
    impact: 'master',
    wiring: 'unwired',
    description: '口径记录：T+1 02:00 结算佣金。',
    unwiredReason: '实际由 `commission-settle.task` 的 `@Cron("0 0 2 * * *")` 硬编码，不读本键。',
    consumedBy: '无 —— 调度硬编码在定时任务装饰器里',
  },
  {
    key: 'supplier.settle_cycle',
    group: 'master',
    label: '供应商结算周期',
    type: 'enum',
    impact: 'master',
    wiring: 'unwired',
    description: '口径记录：供应商应付**日结**（C11）。',
    options: [{ value: 'daily', label: '日结（T+1）' }],
    unwiredReason:
      '实际由 `supplier-share.task` 的 `@Cron("0 10 2 * * *")` 硬编码为日结，不读本键。',
    consumedBy: '无 —— 跑批时间硬编码在定时任务装饰器里',
  },
  {
    key: 'distribution_center.default_count',
    group: 'master',
    label: '集散中心默认数量',
    type: 'int',
    impact: 'master',
    wiring: 'unwired',
    description:
      '口径记录：早期按固定数量建集散中心，后改为 `ab_distribution_center` 表驱动（C4）。',
    unwiredReason: '集散中心已改为表驱动（C4），本键是表驱动之前的遗留计数。',
    consumedBy: '无 —— 已由 `ab_distribution_center` 表取代',
  },
  {
    key: 'distribution_center.rice_fee',
    group: 'master',
    label: '米饭成本',
    type: 'money',
    impact: 'master',
    wiring: 'unwired',
    description: '口径记录：米饭成本默认并入供应商供价。',
    unwiredReason: 'C9 口径修订后，米饭成本并入供应商逐菜协商供价，不再单列。',
    consumedBy: '无 —— 已并入供应商供价',
  },
  {
    key: 'distribution_center.pack_fee',
    group: 'master',
    label: '打包费（集散）',
    type: 'money',
    impact: 'master',
    wiring: 'unwired',
    description: '口径记录：早期由集散中心收取打包费。',
    unwiredReason:
      '自营口径下打包由 ABox 自行承担 → 改由 `settlement.packing_labor_fee` 统计，本键作废。',
    consumedBy: '无 —— 语义已迁移到 `settlement.packing_labor_fee`',
  },
  {
    key: 'settlement.gross_profit_policy',
    group: 'master',
    label: '毛利计算口径',
    type: 'policy',
    impact: 'master',
    wiring: 'policy',
    description:
      '策略标识（非数值）：`residual` = 经营毛利为**结果值** ' +
      '（售价 − 成本合计 − 佣金），不预设固定毛利。',
    consumedBy: '仅作口径记录 —— 计算逻辑落在 `shared-utils/src/biz.ts` 的 `calcSettlement()`',
  },
];

/** key → spec 索引（O(1) 查表，D58 白名单校验用） */
export const CONFIG_SPEC_MAP: Map<string, ConfigSpec> = new Map(
  CONFIG_SPECS.map((s) => [s.key, s]),
);

/** 分组标签 */
export const CONFIG_GROUP_LABEL: Record<string, string> = Object.fromEntries(
  CONFIG_GROUPS.map((g) => [g.group, g.label]),
);

/**
 * 是否可写
 *
 * ⚠️ **只有 `live` 可直接写**：`unwired` 写进去也不会生效（给运营假承诺），
 *    `policy` 存的是策略名（写个金额进去就把口径记录污染了）。
 */
export function isEditable(spec: ConfigSpec): boolean {
  return spec.wiring === 'live';
}

/** 该键是否属于「成本项 + 0 视为未登记」 */
export function isZeroMeansUnregistered(spec: ConfigSpec): boolean {
  return spec.zeroMeansUnregistered === true;
}

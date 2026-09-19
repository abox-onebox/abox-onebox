/**
 * 供应商管理域枚举（M3-6 · 《接口规范 v1.0》§6.4 D23–D32 · 原型 P33）
 *
 * ⚠️ 与 M3-4/M3-5 同一纪律：**文案映射落 shared-types，端上不维护第二份**。
 *    后台表格 / Tag / 筛选器一律引用此处，避免「同状态两个中文名」。
 *
 * ⚠️ 本文件的枚举值必须与 `ab_supplier.type` / `ab_supplier.audit_status`
 *    的落库值逐字一致 —— 枚举是**契约**，不是展示层装饰。
 */

/**
 * 供应商类型（`ab_supplier.type`）
 *
 * ⚠️ **已停用（M4-0 · 自营口径 · 2026-09-16）—— 仅供读取历史数据时对照中文，不参与任何判定**
 *
 * 「出餐型 / 集散型 / 混合型」建立在「供应商入驻 + 供应商自己承担集散」之上；
 * 单主体自营 + 半成品供应链后，供应商只有一种角色：**半成品供货方**。
 * 与之相关的整条链路已下线：D27 设置类型端点删除、D24/D25 新建编辑不再收、
 * D23 筛选与展示移除、`SUPPLIER_TYPE_CONFLICT`(50008) 三处闸门删除（号位保留）。
 *
 * 保留本枚举的唯一理由：`ab_supplier.type` 列里还躺着自营前的历史值，
 * 排查老数据时需要一份「值 → 中文」的对照。**新代码不得再读它做判断。**
 */
export enum SupplierType {
  /** 出餐型：只做菜，不承担集散 */
  DISH = 'dish',
  /** 集散型：只做集散（复用合作供应商场地） */
  DISTRIBUTE = 'distribute',
  /** 混合型：既出餐也集散（如三味屋「主菜 + 集散」） */
  BOTH = 'both',
}

/** ⚠️ 已停用（M4-0）· 仅供历史数据对照，见上方 `SupplierType` 注释 */
export const SUPPLIER_TYPE_LABEL: Record<SupplierType, string> = {
  [SupplierType.DISH]: '出餐型',
  [SupplierType.DISTRIBUTE]: '集散型',
  [SupplierType.BOTH]: '混合型',
};

// ⚠️ M4-0 删除了 `SUPPLIER_TYPE_OPTIONS`（类型下拉项）：
// 它没有任何消费方了，而留着一个「现成的类型选择器」最容易被人重新接回页面上 ——
// 那时运营又会看到一个「选了三个值、选哪个都一样」的下拉。

/**
 * 资质审核状态（`ab_supplier.audit_status` · D26 落点）
 *
 * ⚠️ 与「合作中/停用」（`status`）**正交**：
 *    · `audit_status` 回答「这家有没有合规经营资格」（监管口径）
 *    · `status` 回答「平台现在要不要跟它合作」（经营口径）
 *    驳回资质**不自动停用** —— 审核是事实判定，停用是经营决策，别替运营拍板。
 *    但出餐前置校验（S2）会读 `audit_status`，未通过即 50001。
 */
export enum SupplierAuditStatus {
  /** 待审核：新建供应商的初值（D24） */
  PENDING = 'pending',
  /** 已通过：可作为出餐方参与套餐编排 */
  APPROVED = 'approved',
  /** 已驳回：资质不合规，出餐前置校验会拦（50001） */
  REJECTED = 'rejected',
}

export const SUPPLIER_AUDIT_STATUS_LABEL: Record<SupplierAuditStatus, string> = {
  [SupplierAuditStatus.PENDING]: '待审核',
  [SupplierAuditStatus.APPROVED]: '已通过',
  [SupplierAuditStatus.REJECTED]: '已驳回',
};

/**
 * 资质有效期状态（**派生值，不落库**）
 *
 * 由 `license_expire_at` 与「今天（北京时间）」实时算出，三个档位对应三套界面动作：
 * `normal` 不必提示 / `expiring` 提醒补办 / `expired` 必须下架关联菜品。
 * 落库会立刻产生「字段说没过期、日期说过期了」的双真相。
 */
export enum LicenseState {
  NORMAL = 'normal',
  /** 30 天内到期（`LICENSE_EXPIRING_DAYS`） */
  EXPIRING = 'expiring',
  EXPIRED = 'expired',
  /** 未登记有效期（历史数据 / 后置收集，不当作过期处理） */
  UNKNOWN = 'unknown',
}

/** 「即将到期」的阈值（天）· P33 KPI「资质 30 天内到期」 */
export const LICENSE_EXPIRING_DAYS = 30;

export const LICENSE_STATE_LABEL: Record<LicenseState, string> = {
  [LicenseState.NORMAL]: '有效',
  [LicenseState.EXPIRING]: '即将到期',
  [LicenseState.EXPIRED]: '已过期',
  [LicenseState.UNKNOWN]: '未登记',
};

/**
 * 外卖平台（`ab_supplier.takeout_links` 的键 · 原型 P33「外卖平台店铺链接配置」）
 *
 * 用途：用户端 P38「今日这盒 · 商家溯源」页的外卖跳转。
 * ⚠️ C8 硬约束：跳转**不代表合作** —— 平台永不下发「哪些是备选商家」，
 *    只下发「今日这盒的出品方各自可在哪个平台被找到」。
 */
export enum TakeoutPlatform {
  MEITUAN = 'meituan',
  TAOBAO = 'taobao',
  JD = 'jd',
}

export const TAKEOUT_PLATFORM_LABEL: Record<TakeoutPlatform, string> = {
  [TakeoutPlatform.MEITUAN]: '美团外卖',
  [TakeoutPlatform.TAOBAO]: '淘宝闪购',
  [TakeoutPlatform.JD]: '京东外卖',
};

/**
 * 平台**短名**（角标用）—— 与 `TAKEOUT_PLATFORM_LABEL`（全名）**同源登记**
 *
 * 用户端 P38 溯源卡的出品方卡片只有 1 行位置放三个平台的角标，写全名会挤成两行；
 * 原型卡片上用的也是短名（美团 / 淘宝 / 京东）。故把短名一并设在此处，
 * 端上**不得**另写一份 `{meituan:'美团'}` —— 否则平台改名时两份必然漂移。
 */
export const TAKEOUT_PLATFORM_SHORT: Record<TakeoutPlatform, string> = {
  [TakeoutPlatform.MEITUAN]: '美团',
  [TakeoutPlatform.TAOBAO]: '淘宝',
  [TakeoutPlatform.JD]: '京东',
};

/** 外卖链接（可选：商家可能只在部分平台入驻，未入驻的置 null） */
export interface TakeoutLink {
  /** 小程序路径（`pages/shop/index?shop_id=xxx`）或 H5 地址 */
  url: string | null;
  /** 平台内店铺标识（运营便于核对，不对外展示） */
  shopId?: string | null;
}

export type TakeoutLinks = Partial<Record<TakeoutPlatform, TakeoutLink>>;

/** 状态位（`ab_supplier.status`）—— 语义同名不同表，勿与 tinyint 1/2 的系统位混用 */
export enum SupplierStatus {
  /** 合作中 */
  ACTIVE = 1,
  /** 停用 */
  SUSPENDED = 0,
}

export const SUPPLIER_STATUS_LABEL: Record<number, string> = {
  [SupplierStatus.ACTIVE]: '合作中',
  [SupplierStatus.SUSPENDED]: '已停用',
};

/**
 * 菜品档位（`ab_dish.category`）
 *
 * ⚠️ **与 `DishSlot` 不是同一套值**，两套并存且各有用途，别互相映射：
 *   · `ab_dish.category`（本枚举）：描述**菜品自身是荤是素**——种子数据的实际落库值
 *     是 `main` / `half` / `veg` / `soup`（红烧肉=main、清炒时蔬=veg、卤蛋=half）。
 *   · `DishSlot`：描述**套餐里的槽位**——`main/vegetable/side/soup/staple`
 *     （「一饭四菜 = 主菜 1 + 素菜/配菜 + 汤品 + 主食」），面向 U1 套餐展示。
 *   把两者合并会立刻产生「菜品档位」与「槽位」互相污染的连锁改造，故保持分离，
 *   并在《接口规范》§6.4 的扩展接口处登记该差异。
 */
export enum DishCategory {
  /** 主荤（红烧肉 / 东坡肉） */
  MAIN = 'main',
  /** 半荤（卤蛋 / 酱牛肉） */
  HALF = 'half',
  /** 素菜（清炒时蔬） */
  VEG = 'veg',
  /** 汤品（酸辣汤） */
  SOUP = 'soup',
  /** 主食（米饭 / 面点） */
  STAPLE = 'staple',
}

export const DISH_CATEGORY_LABEL: Record<DishCategory, string> = {
  [DishCategory.MAIN]: '主荤',
  [DishCategory.HALF]: '半荤',
  [DishCategory.VEG]: '素菜',
  [DishCategory.SOUP]: '汤品',
  [DishCategory.STAPLE]: '主食',
};

export const DISH_CATEGORY_OPTIONS = (Object.values(DishCategory) as DishCategory[]).map((v) => ({
  value: v,
  label: DISH_CATEGORY_LABEL[v],
}));

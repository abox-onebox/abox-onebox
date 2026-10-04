/**
 * 今日这盒 · 商家溯源契约（**U5** · 《接口规范 v1.0》§3.2 · 原型 P38）
 *
 * ## 这一页在回答什么
 * 「我这一盒到底是谁做的、出品方持有哪些已核验资质。」
 * 因此出参只有一件事：**出品方是谁**（含资质）。
 *
 * ⚠️⭐ 2026-10-04：原文案里的「我能不能在不合口味时**直接去找他们点单**」与
 *     「它各自在**哪些外卖平台能被找到**」已随外卖跳转一并作废 ——
 *     《微信小程序平台运营规范》**5.10 互推行为**（处理 = **下架**）。
 *     本契约**不得包含任何第三方平台的名称 / 标识 / 链接 / 可跳转物 / 可复制口令**。
 *
 * ## ⚠️ C8 硬约束（出参**严禁**包含）
 * `status`（合作中 / 备选）、`commission`、`shareRate`、备选商家清单、供应商联系方式、
 * 第三方平台信息（见上）。
 * 理由：能展示资质 ≠ 是合作伙伴 —— 平台一旦下发「哪些是备选商家」，就等于在为用户端
 * 推荐尚未合作的主体背书。
 *
 * ## 与原型 P38 的对应
 * 原型把 5 张卡片画成「4 家菜品供应商 + 1 个集散中心」—— 本契约**照此结构**：
 * `dishes[]` 是那 4 张（`ab_set_meal_item` 一行一菜一供应商），
 * `distributionCenter` 是第 5 张（主食 / 打包）。
 */
// ⚠️ 2026-10-04：原 `import type { TakeoutPlatform }` 已删除 ——
//    本文件不再有任何第三方平台相关字段（5.10 互推）。

/**
 * 资质核验项（**已核验的在册项**）
 *
 * ⚠️ 为什么只有两项、而不是原型卡片上的三项
 * 原型 P38 的卡片文案是「食品经营许可证 · 营业执照 · 健康证」，但那是 **v4.7（自营路线
 * 裁定之前）** 的表述。自营（2026-09-16 裁定）之后主体关系变了：
 *   · **供应商** = 半成品供货方（B2B）→ 由其自身经营资格管辖：**营业执照 + 食品经营许可证**
 *     （恰好对应 `ab_supplier.business_license` / `food_license` 两列，**有据可查**）；
 *   · **从业人员健康证** 管辖的是**食品加工操作人员** —— 自营下热加工与打包由 ABox
 *     在自有持证场所完成（见 `ab_distribution_center` 头注），其主体是 **ABox 自己**，
 *     不是供货方。
 * 故本枚举**只列在册且可机械核验的两项**：`ab_supplier` 里既没有健康证列、自营下
 * 它也不该挂在供应商身上 —— 若照抄原型输出第三项，就是在**食品安全叙事上虚报资质**，
 * 这比少显示一项严重得多。待「ABox 自有加工人员健康证」有落库载体后，
 * 由 `distributionCenter` 一侧另行表达（届时扩展本枚举，不复用供应商侧）。
 */
export type TraceabilityQualification =
  /** 食品经营许可证（`ab_supplier.food_license` 非空） */
  | 'food_business_license'
  /** 营业执照（`ab_supplier.business_license` 非空） */
  | 'business_license';

/** 资质中文名 · 端上引用此处，不维护第二份 */
export const TRACEABILITY_QUALIFICATION_LABEL: Record<TraceabilityQualification, string> = {
  food_business_license: '食品经营许可证',
  business_license: '营业执照',
};

//
// ⚠️⭐ 2026-10-04：原 `TraceabilityTakeoutLink` 接口（单个平台的外卖入口）已删除
//
//   它的 `url` 存的是**小程序路径**，正是喂给 `wx.navigateToMiniProgram` 的形态 ——
//   随 `TraceabilitySupplierView.takeoutLinks` 一并移除（5.10 互推，处理 = 下架）。
//   后台侧的外卖链接契约在 `dto/supplier-admin.dto.ts` 的 `TakeoutLinkItem`，
//   与本文件无关（后台网页不受小程序审核约束）。
//

/** 出品方（一家供应商）视图 */
export interface TraceabilitySupplierView {
  /**
   * 出品方 id（`ab_supplier.id`）
   *
   * ⭐ 用途单一：首页「来自：X」跳本页时带 `supplierId`，本页**按 id 定位**到这张卡
   * 并高亮它。按 id 而不是按 `name` 定位 —— `ab_supplier.name`
   * 无唯一约束，同名两家会让用户认错店。
   *
   * ⚠️ 原文案曾写「弹出它的**平台选择层**」：那是外卖平台跳转时代的描述，
   *    跳转已于 2026-10-03 移除（5.10 互推），描述不得继续说着旧话。
   *
   * ⚠️ C8 不受影响：id 不是合作状态、不是供价 / 分账、不是联系方式。
   *    「能拿到 id」与「知道谁是合作伙伴」是两件事。
   */
  id: number;
  name: string;
  /** **只含实际在册的项**（见 `TraceabilityQualification`），不补默认值 */
  qualifications: TraceabilityQualification[];
  //
  // ⚠️⭐ 2026-10-04 移除 `recommended` / `takeoutLinks` 两字段（原 79-81 行）
  //
  //   《微信小程序平台运营规范》**5.10 互推行为**：不得为他人 APP/小程序集中设立跳转，
  //   或为其推荐、推广、提供协助或便利（处理 = **下架**）。而下发的 `takeoutLinks` 里
  //   存的是**小程序路径**（`pages/shop/index?shop_id=xxx`），正是喂给
  //   `wx.navigateToMiniProgram` 的形态 —— 配合 `TAKEOUT_MINI_PROGRAM_APPID` 填一个
  //   appid 就是完整互推链路，命中得比 http 链接更彻底。
  //
  //   注意区分两件事：
  //     · 后台（admin-web）**不受小程序审核约束**，`ab_supplier.takeout_links` 与其配置页保留；
  //     · 但**面向小程序的出参永不读取**它 —— 后台能配 ≠ 小程序可以带出去。
  //
  //   端上（apps/miniprogram）经 grep 确认**从不引用**这两个字段，删除无孤儿引用。
}

/** 一道菜的出品溯源 */
export interface TraceabilityDishView {
  dishName: string;
  category: string | null;
  imageUrl: string | null;
  supplier: TraceabilitySupplierView;
}

/** 集散中心（= ABox 自有加工 / 出餐场所 · 主食与打包） */
export interface TraceabilityCenterView {
  name: string;
  address: string;
}

/** U5 出参 */
export interface TraceabilityTodayResult {
  mealDate: string;
  setName: string | null;
  /** 本餐出品方逐菜列出（一行一菜一供应商） */
  dishes: TraceabilityDishView[];
  /** 集散中心；当日无分配时为 null */
  distributionCenter: TraceabilityCenterView | null;
  /** 页面顶部溯源说明文案（服务端下发，端上不拼） */
  traceNote: string;
}

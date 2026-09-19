/**
 * 今日这盒 · 商家溯源契约（**U5** · 《接口规范 v1.0》§3.2 · 原型 P38）
 *
 * ## 这一页在回答什么
 * 「我这一盒到底是谁做的、我能不能在不合口味时直接去找他们点单。」
 * 因此出参只有两件事：**出品方是谁**（含资质）与**它各自在哪些外卖平台能被找到**。
 *
 * ## ⚠️ C8 硬约束（出参**严禁**包含）
 * `status`（合作中 / 备选）、`commission`、`shareRate`、备选商家清单、供应商联系方式。
 * 理由：能跳转 ≠ 是合作伙伴 —— 平台一旦下发「哪些是备选商家」，就等于在为用户端
 * 推荐尚未合作的主体背书。跳转只是**告知「这家店在平台上也存在」**。
 *
 * ## 与原型 P38 的对应
 * 原型把 5 张卡片画成「4 家菜品供应商 + 1 个集散中心」—— 本契约**照此结构**：
 * `dishes[]` 是那 4 张（`ab_set_meal_item` 一行一菜一供应商），
 * `distributionCenter` 是第 5 张（主食 / 打包，**不参与外卖跳转**）。
 */
import type { TakeoutPlatform } from '../enums/supplier-admin';

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

/** 单个平台的外卖入口 */
export interface TraceabilityTakeoutLink {
  platform: TakeoutPlatform;
  /** 平台中文名（"美团外卖" / "淘宝闪购" / "京东外卖"）· 与后台 P33 同一份文案 */
  label: string;
  /**
   * 小程序路径（`pages/shop/index?shop_id=xxx`）或 H5 地址；
   * **`null` = 该平台未入驻**（合法状态，端上置灰而不是整行不渲染 ——
   * 「缺京东」这件事必须看得见，否则运营不知道要去谈哪家）
   */
  url: string | null;
  configured: boolean;
}

/** 出品方（一家供应商）视图 */
export interface TraceabilitySupplierView {
  name: string;
  /** **只含实际在册的项**（见 `TraceabilityQualification`），不补默认值 */
  qualifications: TraceabilityQualification[];
  /** 默认推荐跳哪个平台；无推荐时为 null（端上不显示「推荐」角标） */
  recommended: TakeoutPlatform | null;
  /** **恒为 3 条**（美团 / 淘宝 / 京东，顺序固定），未入驻的 `configured=false` */
  takeoutLinks: TraceabilityTakeoutLink[];
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

/**
 * 供应商资质墙契约（**用户端免登录只读** · 2026-10-03 新增）
 *
 * ## 为什么要有这一组接口（来龙去脉，勿删）
 * 原 P38 溯源页把「这家店到底靠不靠谱」寄托在**跳去美团 / 京东 / 淘宝看店铺页**上。
 * 2026-10-03 逐字复核《微信小程序平台运营规范》后确认那条路**走不通**：
 *   · **5.10 互推行为**：不得对其他 APP 进行推荐、推广，也不得为上述行为提供
 *     任何协助或便利 —— 处理规则是**下架**（且现行原文已删去「未经腾讯书面同意」前缀）；
 *   · **5.20 诱导下载行为**：逐字含「通过利用**剪切板**能力来达到诱导跳转/下载 APP 目的」；
 *   · **5.15.4 / 5.16**：滥用操作剪切板接口 → 封禁剪切板能力直至封号。
 * ⇒ 结论：**小程序内不得出现任何第三方平台的名称 / 标识 / 链接 / 可跳转物 / 可复制口令**。
 *   （「复制一串口令、自己去美团粘贴」看似绕开了跳转，实则正落在 5.20 上，
 *    比跳转更典型地命中「规避平台规则」这一形态。）
 *
 * 于是信任证据改由**自持证照**承载。这恰好也是用户真正要看的东西
 * （「有没有证、过没过期、审没审过」），且完全落在自己域内，不依赖任何外部平台。
 *
 * ## ⚠️ C8 硬约束（沿用 U5，一条不松）
 * 不下发：合作状态 `status`、联系方式（`contact_name` / `contact_phone`）、
 * 银行与账户信息、供价 `cost_price`、分账 `share_rate`、审核意见 `audit_remark`。
 * 「资质已通过」与「当前是否合作中」是两件事 —— 用户端只需要知道前者，
 * 后者一露出就等于替平台做了经营背书。
 *
 * ## ⭐ 分组判据（本契约的核心）
 * `serving = 合作中 ∧ 资质已通过 ∧ 证照未过期` —— 与 S1 出餐前置校验 `canServe`
 * **同一套判据**，只是不在同一处实现：S1 是**拦截**（不合格不许出餐），
 * 这里则是**展示**（不合格就不出现在资质墙里）。
 *
 * ⚠️「暂未供应」组**只给名字与品类、不给资质**：把一张过期证照或未核验证照
 * 摆上资质墙，比不摆更糟 —— 用户会当成它仍然有效。
 */
import type { TraceabilityQualification } from './traceability.dto';

/** 一项证照（含编号与有效期，供详情页逐条展示） */
export interface SupplierQualificationEntry {
  /** 与 `TraceabilityQualification` 同域（复用同一份中文名映射） */
  key: TraceabilityQualification;
  /** 证照中文名（端上引用 `TRACEABILITY_QUALIFICATION_LABEL`，不维护第二份） */
  label: string;
  /**
   * 证照编号（`ab_supplier.food_license` / `business_license`）
   *
   * ⚠️ 这里**不脱敏**：证照编号属于企业信息而非个人信息，
   * 「亮照亮证」的意义就在于能拿去国家企业信用信息公示系统核对；
   * 抹掉一半的编号等于给了个无法核验的字符串，比不给更有误导性。
   * 真正一律不下发的是**自然人信息**（法人姓名、身份证、手机号、银行账户）。
   */
  code: string | null;
  /** 有效期 `YYYY-MM-DD`；未登记为 null */
  expireAt: string | null;
}

/** 资质墙列表项 */
export interface SupplierQualificationItem {
  /** `ab_supplier.id` —— 列表跳详情按 id，不按 name（`name` 无唯一约束） */
  id: number;
  name: string;
  /** 主营品类（本帮菜 / 时蔬 / 京味 / 汤品…）；未登记为 null */
  category: string | null;
  /**
   * 已核验在册的资质项
   *
   * ⚠️ 判据是 `audit_status === 'approved'`，不是「证照字段非空」——
   * 「上传了文件」与「平台核验过」是两件事。
   * ⚠️「暂未供应」组恒为空数组（见本文件头注的分组判据）。
   */
  qualifications: TraceabilityQualification[];
  /** 证照有效期；「暂未供应」组恒为 null */
  licenseExpireAt: string | null;
  /** 是否在供（合作中 ∧ 资质已通过 ∧ 证照未过期） */
  serving: boolean;
  /** 累计供餐份数（`ab_supplier.total_served`）· 仅作规模陈述，不构成任何承诺 */
  totalServed: number;
}

/** 资质墙列表出参 */
export interface SupplierQualificationListResult {
  /** 正在供应（资质有效）—— 资质墙的主体 */
  serving: SupplierQualificationItem[];
  /** 暂未供应（停用 / 资质未过审 / 证照过期）—— 只列名与品类 */
  inactive: SupplierQualificationItem[];
  /** 列表顶部说明（服务端按真实数据生成，端上不拼文案） */
  note: string;
}

/** 供应商资质详情出参 */
export interface SupplierQualificationDetail {
  id: number;
  name: string;
  category: string | null;
  serving: boolean;
  /** 证照逐条；未通过核验或不在供时为空数组（原因写在 `note` 里，不静默留白） */
  entries: SupplierQualificationEntry[];
  /** 该出品方在册的菜品名（最多 6 个，只取上架的） */
  dishes: string[];
  /**
   * 说明文案（服务端生成）
   *
   * ⭐ 为什么**无资质时也要给一句话**而不是让端上留白：
   * 用户点进一家却看到一张空白页，只会以为程序坏了。
   * 「该出品方资质尚在核验中」与「没有任何证照」是两种完全不同的事实，必须说清。
   */
  note: string;
}

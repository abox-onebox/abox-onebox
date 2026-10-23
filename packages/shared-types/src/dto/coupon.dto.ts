/**
 * 代金券系统契约（独立券系统 · 2026-10-23）
 *
 * 数据模型：`ab_coupon`（券种定义，后台管理）+ `ab_user_coupon`（用户持有券）。
 * 金额一律**整数分**（§1.6）；有效期 datetime 一律 ISO 8601 带 `+08:00`。
 *
 * ## 机制定位
 * 「代金券」是平台侧的**补偿 / 激励**通道，不是营销满减主玩法：
 *   · `referral`     —— 推荐人转正团长时返给推荐人的返券（用户定调：5 元）
 *   · `compensation` —— 售后客服给用户发的补偿券
 *   · `manual`       —— 后台手动发放
 *   · `system` / `activity` —— 预留（系统 / 活动）
 * 下单时可选用一张可用券抵扣，落到订单 `discount_amount`（既有列，原恒 0）。
 */

/** 券有效期类型 */
export type CouponValidityType = 'days' | 'period';

/** 用户持有券状态 */
export type UserCouponStatus = 'unused' | 'used' | 'expired';

/** 券来源（发放通道） */
export type CouponObtainedFrom = 'referral' | 'compensation' | 'manual' | 'system' | 'activity';

/** 券种定义（后台管理） */
export interface CouponDefResult {
  id: number;
  name: string;
  /** 面额（分） */
  faceValueFen: number;
  /** 使用门槛（分）；0 = 无门槛 */
  thresholdFen: number;
  validityType: CouponValidityType;
  /** validityType=days 时有效：领取后 N 天有效 */
  validDays: number | null;
  /** validityType=period 时有效：生效日 `YYYY-MM-DD` */
  validFrom: string | null;
  /** validityType=period 时有效：失效日 `YYYY-MM-DD` */
  validTo: string | null;
  /** 发行总量上限；null = 不限 */
  totalLimit: number | null;
  /** 已发放数 */
  issuedCount: number;
  status: 'active' | 'inactive';
  remark: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 用户持有券（可用券列表 / 发放记录） */
export interface UserCouponResult {
  id: number;
  /** 唯一券码 */
  code: string;
  name: string;
  /** 面额（分） */
  faceValueFen: number;
  /** 使用门槛（分）；0 = 无门槛 */
  thresholdFen: number;
  /** 生效时刻（ISO 8601 +08:00） */
  validFrom: string;
  /** 失效时刻（ISO 8601 +08:00） */
  validTo: string;
  status: UserCouponStatus;
  obtainedFrom: CouponObtainedFrom;
  /** 核销时刻；未核销为 null */
  usedAt: string | null;
  /** 核销订单号；未核销为 null */
  orderNo: string | null;
  createdAt: string;
}

/** 我的券（带可用性判据，前端直接据此置灰 / 提示） */
export interface MyCouponResult extends UserCouponResult {
  /** 当前是否可用于下单（未使用 + 在有效期内）；门槛是否满足由选用时按订单额判定 */
  available: boolean;
  /** available=false 时的原因（如「已使用」「已过期」「未到生效日」） */
  unavailableReason?: string;
}

/** 后台创建 / 更新券种定义（period 类型给 validFrom/validTo；days 类型给 validDays） */
export interface UpsertCouponDefBodyDto {
  name: string;
  /** 面额（分） */
  faceValueFen: number;
  /** 使用门槛（分）；0 = 无门槛 */
  thresholdFen: number;
  validityType: CouponValidityType;
  /** validityType=days 时必填 */
  validDays?: number | null;
  /** validityType=period 时必填（`YYYY-MM-DD`） */
  validFrom?: string | null;
  /** validityType=period 时必填（`YYYY-MM-DD`） */
  validTo?: string | null;
  /** 发行总量上限；省略 / null = 不限 */
  totalLimit?: number | null;
  remark?: string | null;
}

/** 后台手动发放（客服补偿场景，可不关联券种定义） */
export interface GrantCouponBodyDto {
  /** 接收用户 id（与 `userPhone` 二选一；都给优先 id） */
  userId?: number;
  /** 接收用户手机号（反查用户） */
  userPhone?: string;
  /** 关联券种定义 id（用于回写 issuedCount / 限量校验）；纯补偿券可省略 */
  couponDefId?: number | null;
  /** 券名称（省略时取券种定义名） */
  name?: string;
  /** 面额（分，必填） */
  faceValueFen: number;
  /** 使用门槛（分）；0 = 无门槛 */
  thresholdFen?: number;
  validityType: CouponValidityType;
  validDays?: number | null;
  validFrom?: string | null;
  validTo?: string | null;
  obtainedFrom?: CouponObtainedFrom;
  remark?: string | null;
}

/** 可用券列表项（选用时返回，已按订单额判定门槛是否满足） */
export interface AvailableCouponResult extends UserCouponResult {
  /** 是否可作用于当前订单（未使用 + 在有效期 + 门槛满足） */
  applicable: boolean;
  /** 作用于当前订单的实际抵扣额（分）= min(面额, 订单额)；不满足门槛时为 0 */
  discountFen: number;
}

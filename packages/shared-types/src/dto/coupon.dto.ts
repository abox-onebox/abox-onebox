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

/**
 * 用户持有券状态
 *
 * - `unused`  未使用（**过期不落库**：`valid_to` 已过仍存 `unused`，由查询期判定，见 service 头注）
 * - `used`    已核销（下单时与建单同事务置位，取消/退款时由 `releaseForOrder` 还原）
 * - `revoked` 已回收（2026-10-29 批量发券配套：**只有 `unused` 可撤**；已核销的券撤了
 *              等于让订单白拿抵扣，故拒绝）
 */
export type UserCouponStatus = 'unused' | 'used' | 'revoked' | 'expired';

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
  /** 批量发放批次号；单人发券为 null（幂等锚，见 `GrantCouponBatchBodyDto`） */
  grantBatchNo: string | null;
  /** 回收时刻；未回收为 null */
  revokedAt: string | null;
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

/** 批量发放的人群选择方式 */
export type CouponGrantScope =
  /** 全平台用户（排除黑名单 / 已注销） */
  | 'all'
  /** 某栋楼的用户（`buildingId` 必填） */
  | 'building'
  /** 指定手机号清单（`phones` 必填；查无此人的号码在 `unmatchedPhones` 里回传） */
  | 'phones'
  /** 指定用户 id 清单（`userIds` 必填） */
  | 'userIds';

/**
 * 后台批量发放（2026-10-29）
 *
 * ## 为什么必须先「试算」再「实发」
 * 批量发券是**一次操作、几十张券**的动作，且券**发出即承诺**（用户端立刻看得见）。
 * 误发的代价远大于单人发券：金额填错一个零、人群选错一栋楼，都是几十份既成事实。
 * 故把「试算」做成**同一个端点的 `dryRun: true`** —— 前后端共用同一套人群解析与
 * 幂等判据，不会出现「试算说 73 人、实发 80 人」这种两套算法各自漂移的问题。
 *
 * ## 幂等
 * `idempotencyKey` 相同 = 同一批。后端据此派生批次号，重放时「这一批已发过谁」
 * 会被跳过并在 `skippedCount` 里如实回传 —— 双击提交不会发出两批。
 */
export interface GrantCouponBatchBodyDto {
  scope: CouponGrantScope;
  /** scope=building 时必填 */
  buildingId?: number | null;
  /** scope=phones 时必填（最多 500 个） */
  phones?: string[];
  /** scope=userIds 时必填（最多 500 个） */
  userIds?: number[];
  /** 关联券种定义 id（回写 issuedCount / 限量校验）；纯补偿券可省略 */
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
  /** 发放原因（必填，进券的 remark 与操作日志） */
  remark?: string | null;
  /** `true` = 只试算、不写库（返回预计命中数等，供端上二次确认） */
  dryRun?: boolean;
  /** 幂等键；同一键重复提交视为同一批，已发过的用户自动跳过 */
  idempotencyKey?: string | null;
  /** 是否排除黑名单用户（默认 `true`） */
  excludeBlacklist?: boolean;
}

/** 批量发放结果（试算与实发同构，端上只按 `dryRun` 区分展示文案） */
export interface CouponGrantBatchResult {
  dryRun: boolean;
  /** 批次号（试算时为「即将使用的」批次号，实发后可用它追溯这一批） */
  batchNo: string;
  /** 本次实际（或预计）发放张数 */
  grantedCount: number;
  /** 因「同一批次已发过」而跳过的张数（幂等命中） */
  skippedCount: number;
  /** 本次发放面额合计（分） */
  totalFaceValueFen: number;
  /** 被排除的人数（黑名单 / 已注销），试算也回传 —— 让运营知道口径 */
  excludedCount: number;
  /** `phones` 人群里查无此人的号码（不静默丢弃，如实回传） */
  unmatchedPhones: string[];
  /** 命中用户样例（脱敏手机号，最多 5 个），供运营肉眼核对人群有没有选错 */
  samplePhones: string[];
  /** 实发时回传的券码（最多 20 个，避免响应过大） */
  codes: string[];
}

/** 后台回收代金券 */
export interface RevokeCouponBodyDto {
  /** 回收原因（必填，进操作日志；不占业务表列） */
  reason: string;
}

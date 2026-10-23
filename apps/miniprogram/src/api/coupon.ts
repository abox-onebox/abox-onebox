/**
 * api/coupon —— 代金券（用户端 · 2026-10-23）
 *
 * 两个接口，分工与后端 `CouponController` 一一对应：
 *   · `GET /coupon/my`          —— **我的优惠券**（全部，含可用性判据与不可用原因）
 *   · `GET /coupon/my-available` —— **下单可用券**（按订单额算门槛，含实际抵扣额）
 *
 * ⚠️ 为什么是两个而不是一个：
 *   「我的券」页要展示**已用过 / 已过期**的券（那是用户的资产记录，不能藏）；
 *   「下单选券」只该出现**当下真能抵**的那些。合成一个接口的话，
 *   下单页要么自己再算一遍门槛（第二份判据 → 迟早漂移），
 *   要么把过期券也列给用户选（选了才报错）。
 *
 * ⚠️ 金额口径：**全部为整数分**（与全工程一致，`toFen` 转换只发生在渲染层）。
 * ⚠️ `unavailableReason` / 有效期文案一律取服务端，端上不自造。
 */
import { http, query } from './request';

/** 券状态（与后端 `ab_user_coupon.status` 一致） */
export type CouponStatus = 'unused' | 'used';

/** 券来源（与后端 `obtained_from` 一致） */
export type CouponObtainedFrom = 'referral' | 'compensation' | 'manual';

/** 一张券的基础出参 */
export interface UserCouponItem {
  id: number;
  /** 唯一券码（核销凭据） */
  code: string;
  name: string;
  /** 面额（整数分） */
  faceValueFen: number;
  /** 使用门槛（整数分）；0 = 无门槛 */
  thresholdFen: number;
  /** 生效时刻（ISO +08:00） */
  validFrom: string;
  /** 失效时刻（ISO +08:00） */
  validTo: string;
  status: CouponStatus;
  obtainedFrom: CouponObtainedFrom;
  /** 核销时刻；未使用为 null */
  usedAt: string | null;
  /** 核销订单号；未使用为 null */
  orderNo: string | null;
  createdAt: string;
}

/** 「我的优惠券」项 = 基础出参 + 可用性判据 */
export interface MyCouponItem extends UserCouponItem {
  /** 当下能否使用（未使用 且 在有效期窗口内） */
  available: boolean;
  /** 不可用原因（服务端给文案；可用时为 undefined） */
  unavailableReason?: string;
}

/** 「下单可用券」项 = 基础出参 + 本单判据 */
export interface AvailableCouponItem extends UserCouponItem {
  /** 本单能否用（门槛已按订单额判定） */
  applicable: boolean;
  /** 本单实际抵扣额（整数分）；不适用时为 0 */
  discountFen: number;
}

/** U · 我的优惠券（全部） */
export function fetchMyCoupons(): Promise<MyCouponItem[]> {
  return http.get<MyCouponItem[]>('/coupon/my');
}

/** U · 本单可用券（按订单总额判定门槛） */
export function fetchAvailableCoupons(totalFen: number): Promise<AvailableCouponItem[]> {
  return http.get<AvailableCouponItem[]>(`/coupon/my-available${query({ totalFen })}`);
}

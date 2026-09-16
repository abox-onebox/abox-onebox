/**
 * 业务单号生成（《接口规范》§1.6 / U10 示例 `AB2026091500071234`）
 *
 * 规则：`前缀 + yyyyMMdd(北京时间) + 8 位随机数字`，长度 18 ≤ 列宽 varchar(32)
 *   AB —— 订单号 ab_order.order_no
 *   RF —— 退款单号 ab_refund.refund_no
 *   SH —— 应付结算单号 ab_supplier_share.share_no
 *   WD —— 提现单号 ab_withdraw.withdraw_no
 *   AJ —— 余额调整单号 ab_balance_log.related_id（M3-14）
 *
 * ⚠️ 唯一性由 DB 唯一索引兜底（uk_order_no / uk_refund_no / uk_share_no），
 *    本函数只保证「高概率不重复」，不承担唯一性保证。
 */
import { randomInt } from 'crypto';

import { todayBj } from './time';

const PREFIX = {
  ORDER: 'AB',
  REFUND: 'RF',
  SHARE: 'SH',
  WITHDRAW: 'WD',
  ADJUST: 'AJ',
} as const;

type NoKind = keyof typeof PREFIX;

function generate(kind: NoKind, at?: Date): string {
  const datePart = todayBj(at).replace(/-/g, '');
  const rand = String(randomInt(0, 100_000_000)).padStart(8, '0');
  return `${PREFIX[kind]}${datePart}${rand}`;
}

/** 订单号：AB + yyyyMMdd + 8 位随机 */
export const genOrderNo = (at?: Date): string => generate('ORDER', at);

/** 退款单号：RF + yyyyMMdd + 8 位随机 */
export const genRefundNo = (at?: Date): string => generate('REFUND', at);

/** 应付结算单号：SH + yyyyMMdd + 8 位随机 */
export const genShareNo = (at?: Date): string => generate('SHARE', at);

/** 提现单号：WD + yyyyMMdd + 8 位随机（`ab_withdraw.withdraw_no`） */
export const genWithdrawNo = (at?: Date): string => generate('WITHDRAW', at);

/**
 * 余额调整单号：AJ + yyyyMMdd + 8 位随机（写入 `ab_balance_log.related_id`）
 *
 * ⚠️ 管理端手工调账**没有**业务单据可挂（不是订单、不是退款、不是提现），
 *    故自造单号作为追溯锚点。否则事后只能靠「操作人 + 时间 + 金额」反查，
 *    同一人同一天多笔同额调整时无法定位到具体哪一笔。
 */
export const genAdjustNo = (at?: Date): string => generate('ADJUST', at);

/** 订单号格式校验（入参兜底，避免脏 orderNo 打到 DB） */
export const isOrderNo = (v: string): boolean => /^AB\d{16}$/.test(v);

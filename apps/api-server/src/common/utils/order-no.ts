/**
 * 业务单号生成（《接口规范》§1.6 / U10 示例 `AB2026091500071234`）
 *
 * 规则：`前缀 + yyyyMMdd(北京时间) + 8 位随机数字`，长度 18 ≤ 列宽 varchar(32)
 *   AB —— 订单号 ab_order.order_no
 *   RF —— 退款单号 ab_refund.refund_no
 *   SH —— 应付结算单号 ab_supplier_share.share_no
 *   WD —— 提现单号 ab_withdraw.withdraw_no
 *   AJ —— 余额调整单号 ab_balance_log.related_id（M3-14）
 *   PB —— 出款批次号 ab_withdraw.payout_batch_no（M4-4 · **按日聚合，无随机位**）
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

/**
 * 出款批次号：`PB` + yyyyMMdd（**按审批日聚合，刻意不含随机位**）
 *
 * ⚠️ 与上面四个单号**语义不同**，故不走 `generate()`：
 *    单号要「一单一号」（唯一），批次号要「同日同批」（**聚合**）。
 *    C11 一期是人工通道 —— 运营每天集中把当天批准的提现汇总成一份清单提交灵活用工平台，
 *    回执也整批回来。故批次号 = 自然日，天然满足「这一天批的钱是一批」；
 *    若给批次号也加随机位，同一天审批的两笔会落到两个批次里，
 *    运营得提交两次、对两回账，而这没有任何业务理由。
 *
 * ⚠️ 需要一天内分多批提交时，由运营在 D46 入参里**显式给 `payoutBatchNo`** 覆盖，
 *    不自造「当日第 N 批」计数器 —— 计数器要跨请求读-改-写，并发下会撞号，
 *    而批次号本身**不是**资金主键（提现单号才是），不值得为它引入锁。
 *
 * 列宽：`ab_withdraw.payout_batch_no` varchar(32)，本号长 10。
 */
export const payoutBatchNoOf = (at?: Date): string => `PB${todayBj(at).replace(/-/g, '')}`;

/** 订单号格式校验（入参兜底，避免脏 orderNo 打到 DB） */
export const isOrderNo = (v: string): boolean => /^AB\d{16}$/.test(v);

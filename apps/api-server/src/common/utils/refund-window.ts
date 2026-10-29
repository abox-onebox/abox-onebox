/**
 * H9 · 「订单完成后可退时限」的**判据纯函数**（2026-10-29）
 *
 * ## 为什么要有这条
 * `REFUNDABLE_STATUS` 含 `COMPLETED`，且此前**没有任何时限** ⇒ 订单完成
 * 几个月后仍可发起团长代退。而 completed 之后佣金已结算入账、团长可能**已经提现**，
 * 此时退款要把已入账的佣金冲销回来 —— 钱已被提走 ⇒ 余额被扣成**负数**（欠款）。
 *
 * ⚠️ 欠款本身**是允许的设计**（`reversal.service.ts`：形成欠款由后续佣金抵扣），
 *    本函数要解决的不是「不要欠款」，而是「**欠款不能无限期地突然出现**」。
 *
 * ## 为什么必须是纯函数
 * `refund.service.ts` 全仓没有单测 —— 判据写在服务方法里就没有任何机械检查会拦它。
 * 抽成纯函数后可直接喂样本断言（见 `test/unit/refund-window.spec.ts`）。
 */

export interface RefundWindowInput {
  /** 订单当前状态（字符串，与 `ab_order.status` 一致） */
  status: string;
  /** 订单完成时刻（`completedAt`）；未完成则为 null */
  completedAt: Date | null | undefined;
  /** 时限（小时）；**0 或负数 = 不限**（与缺省行为一致） */
  windowHours: number;
  /** 当前时刻（注入以便测试，不用假时钟） */
  now: Date;
}

export interface RefundWindowVerdict {
  /** 是否因超期而不可退（false = 可退，含「未配置时限」与「非 completed」） */
  expired: boolean;
  /** 人话说明（进异常 message 与日志） */
  note: string;
}

/**
 * 是否超出「完成后的可退时限」
 *
 * ## 三条判定规则（顺序有意义）
 * 1. **时限 ≤ 0 ⇒ 一律不拦**（不限）。缺省就是不限，这是上线的**安全默认**：
 *    配错成 0 只会退回旧行为，不会把退款口子悄悄关掉。
 * 2. **非 `completed` ⇒ 不拦**。其余可退状态（paid / cut_off / cooked /
 *    delivering / delivered）的佣金尚未结算入账，冲销不涉及已提现的钱，
 *    不存在欠款风险 —— 拦它们是**无谓地堵住用户退款**。
 * 3. **`completed` 但没有 `completedAt`** ⇒ **不拦**（fail-open）。
 *    这是数据残缺，不是「超期」；此时拦掉会让用户拿不回钱，
 *    而放行最坏结果是产生一笔欠款（可追、可控）。两者后果不对称。
 *
 * ⛔ 本判据**只**服务团长代退 / 用户自助入口；`forceRefund`（D11）**刻意不调用它** ——
 *    兜底通道必须永远可用，否则「钱在系统里、谁也退不出来」。
 */
export function isRefundWindowExpired(input: RefundWindowInput): RefundWindowVerdict {
  const { status, completedAt, windowHours, now } = input;

  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    return { expired: false, note: '未配置可退时限（不限）' };
  }

  if (status !== 'completed') {
    return { expired: false, note: `状态 ${status} 不适用完成后时限（佣金尚未结算入账）` };
  }

  if (!completedAt) {
    return {
      expired: false,
      note: '订单已完成但缺少完成时刻，无法判定是否超期 —— 按未超期处理（fail-open）',
    };
  }

  const elapsedHours = (now.getTime() - completedAt.getTime()) / 3_600_000;
  if (elapsedHours <= windowHours) {
    return {
      expired: false,
      note: `完成 ${elapsedHours.toFixed(1)} 小时，在时限 ${windowHours} 小时内`,
    };
  }

  return {
    expired: true,
    note:
      `订单已完成 ${elapsedHours.toFixed(1)} 小时，超出可退时限 ${windowHours} 小时` +
      '（佣金可能已结算并被提现，继续退款会把团长余额扣成欠款；确需退款请走后台强制退款）',
  };
}

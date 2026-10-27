/**
 * `ab_config` 取值判据（纯函数 · 零 IO）
 *
 * ## 为什么要有它（2026-10-27 · 卜宕机 报出的 P1 缺陷）
 *
 * 原 `BizConfigService.getNumber` 写的是：
 *
 * ```ts
 * const n = Number(raw);            // raw 缺失时是 null
 * return Number.isFinite(n) ? n : fallback;
 * ```
 *
 * 而 **`Number(null) === 0`，0 又过得了 `Number.isFinite`** ⇒ 键缺失时拿到的是 **0，
 * 不是 fallback** —— `fallback` 成了死代码，且方向还**不一致**：
 *   · `suspend_force_max_count`（缺省 20）缺键 → 实得 0 ⇒ 1 笔未完结订单就触发 60012；
 *   · `commission.withdraw_daily_limit/count`（缺省 2000 / 1）缺键 → 实得 0，
 *     而这两处的 0 被 `withdraw.service` 解释成「**不限**」⇒ 提现无日限额、无日笔数限制
 *     （fail-open，且与 D3 定稿的「当日 1 笔」相反）；
 *   · `order.pay_timeout_minutes`（缺省 30）缺键 → 实得 0 ⇒ 订单创建即过期。
 * 同一个成因，一处收紧、一处放开 —— 这正是它危险的地方：单看任一处都像「本来就该这样」。
 *
 * ⚠️ 判据抽成纯函数是因为**这类缺陷只能靠单测拦**：它不抛错、不告警、类型全对、
 *    `tsc` 与 e2e 都过得去，只有把「缺键」当输入喂进去才会暴露。
 */

/**
 * 该值算不算「没配」
 *
 * ⚠️ 空串 / 纯空白**同样算没配**：`Number('')` 与 `Number('   ')` 都是 0，
 *    和 `Number(null)` 是同一个坑，只判 `null` 会漏掉后台把值清空的情况。
 */
export function isMissingConfigValue(raw: string | null | undefined): boolean {
  return raw == null || raw.trim() === '';
}

/**
 * 取数字配置：**没配 / 非数字 ⇒ 回落 fallback**，绝不产出 0 冒充「配了 0」
 */
export function pickConfigNumber(raw: string | null | undefined, fallback: number): number {
  if (isMissingConfigValue(raw)) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

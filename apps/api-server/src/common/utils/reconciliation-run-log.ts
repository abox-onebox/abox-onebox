/**
 * S5 · 对账跑批「执行留痕」的判据纯函数（2026-10-29）
 *
 * ## 缺的是什么（先说清，别为了建表而建表）
 * 台账给 S5 的原文是「对账自动化 · 缺口：**无任务执行记录表**」。但项目有显式不变量
 * 「**派生值不落库**」（`schedule.service.ts` 头注，另 6 处引用）—— 跑批的执行结果是
 * 派生值，为它建表要先推翻一条被反复确认过的设计边界。**裁决：不建表。**
 *
 * 于是真正要解决的就只剩一件事：**「今天到底核过账没有」无从回答**。
 * 现状是 —— 不平才落一条 `ab_operation_log`（`对账不平`），**平了什么都不写**。
 * 后果有两个，都指向同一种静默：
 *   ① 运营打开对账页看到「没有告警」，不知道那是「核过了且是平的」还是「根本没跑」；
 *   ② 任务注册失败 / 进程重启后没恢复 / 锁没释放 ⇒ 一天没跑，**没有任何信号**。
 * 「没告警」被当成「没问题」，是这类自动化最常见的失效方式。
 *
 * ⇒ 收口：**每次执行都写一条 `对账执行`**（平与不平都写），与 `对账不平` 分工不同 ——
 *    前者是**审计信号**（核过了、核了什么），后者是**待办信号**（要人去跟进）。
 *    两条并存、都不建表、零 DDL。
 *
 * ## ⚠️ 为什么「平」也必须带 local_only 那句话
 * 一期拿不到微信账单（无商户号 + 无证书），`reconcile()` 只核**本地三头**。
 * 一条写着「已平」的留痕如果省略这句话，三个月后没人记得它只核了三头 ——
 * 那这条留痕就从「证据」变成了「误导」。故本文件生成的**任何**文案都强制带上。
 */

import { money } from './money';

/** 留痕落点（与 `对账不平` 同 module，靠 action 区分两件事） */
export const RECON_RUN_MODULE = 'finance';
export const RECON_RUN_ACTION = '对账执行';

export const RECON_RUN_TRIGGERS = ['cron', 'manual'] as const;
export type ReconRunTrigger = (typeof RECON_RUN_TRIGGERS)[number];

/** 一句话结论的最大长度（`snapshot` 是 JSON，这里只是不让它无限膨胀） */
export const RECON_SUMMARY_MAX = 300;

export interface ReconRunFact {
  /** 被核对的日期（**支付日**，不是出餐日 —— 与 D43 的 `anchor` 一致） */
  date: string;
  balanced: boolean;
  orderFen: number;
  logFen: number;
  refundFen: number;
  netFen: number;
  diffFen: number;
  diffCount: number;
  /** 恒 `'local_only'`（一期）；留痕里必须原样带上 */
  channelSource: string;
  billAvailable: boolean;
  /** 差异类型分布（只放统计，不放明细 —— 明细可能上百行） */
  diffTypeStats?: { type: string; label: string; count: number }[];
  durationMs?: number | null;
  /** 定时跑批还是人工补跑（排查「为什么这天有两条」时的第一个问题） */
  trigger: ReconRunTrigger;
}

export interface ReconRunLogPlan {
  module: string;
  action: string;
  /** 目标日期 —— 同一天只保留一条（后到的**覆盖**先到的，见下方说明） */
  targetId: string;
  requestData: Record<string, unknown>;
  snapshot: Record<string, unknown>;
}

/**
 * 生成「对账执行」留痕
 *
 * ⚠️ **同一日期覆盖而不是跳过**：补跑的价值就在于「拿最新结果替掉旧结果」。
 *    若照 `对账不平` 那样「已有则不写」，一次补跑成功后的页面会一直显示凌晨那条
 *    「不平」—— 明明已经核平了却还挂着，比不写更糟。
 *    ⇒ 覆盖写，`runs` 累加，看得出这一天核过几次。
 */
export function buildReconRunLog(fact: ReconRunFact, prevRuns: number): ReconRunLogPlan {
  // ⚠️ `Math.max(0, NaN)` 是 **NaN**（不是 0）—— 旧留痕里的 `runs` 若被写脏，
  //    会让计数从此变成 NaN 并一路传染（补跑次数再也数不出来）。故先判有限性。
  const base = Number.isFinite(prevRuns) ? Math.max(0, prevRuns) : 0;
  const runs = base + 1;
  return {
    module: RECON_RUN_MODULE,
    action: RECON_RUN_ACTION,
    targetId: fact.date,
    requestData: {
      task: 'reconciliation',
      date: fact.date,
      trigger: fact.trigger,
      runs,
    },
    snapshot: {
      source: 'system',
      task: 'reconciliation',
      trigger: fact.trigger,
      runs,
      balanced: fact.balanced,
      orderFen: fact.orderFen,
      logFen: fact.logFen,
      refundFen: fact.refundFen,
      netFen: fact.netFen,
      diffFen: fact.diffFen,
      diffCount: fact.diffCount,
      diffTypeStats: fact.diffTypeStats ?? [],
      channelSource: fact.channelSource,
      billAvailable: fact.billAvailable,
      durationMs: fact.durationMs ?? null,
      summary: reconRunSummary(fact),
      // ⚠️ 平与不平都要有：留痕里少这一句，它就从证据变成误导
      caveat: '仅本地三头核对（订单 ↔ 支付流水 ↔ 退款），**不等于已与微信侧对平**',
    },
  };
}

/** 一句话结论（进 `snapshot.summary`，也直接给端上展示） */
export function reconRunSummary(fact: ReconRunFact): string {
  const head = fact.balanced
    ? `本地三头已平：订单 ¥${money(fact.orderFen / 100)} − 流水 ¥${money(fact.logFen / 100)}` +
      ` − 退款 ¥${money(fact.refundFen / 100)}（净 ¥${money(fact.netFen / 100)}）`
    : `本地三头**不平**：差异 ${fact.diffCount} 笔 / ¥${money(fact.diffFen / 100)}`;

  return `${head}｜不含微信侧（${fact.channelSource}${fact.billAvailable ? '' : ' · 无账单'}）`.slice(
    0,
    RECON_SUMMARY_MAX,
  );
}

// --------------------------------------------------------------------------
// 「有没有按时核」—— 静默失败的判据
// --------------------------------------------------------------------------

export type ReconFreshness =
  /** 已核到应核日期（含更晚） */
  | 'fresh'
  /** 有记录，但没核到应核日期 ⇒ 中间漏了，很可能就是没跑 */
  | 'stale'
  /** 一条都没有 ⇒ 从未自动核过 */
  | 'never';

/**
 * 最近一次执行是否覆盖到「应核日期」
 *
 * @param lastRunDate 库里最近一次 `对账执行` 的日期（YYYY-MM-DD），没有则 null
 * @param expectedDate 应核日期（对账是 T+1 核**昨日**，由调用方算好传进来）
 *
 * ⚠️ 比较用**字符串**：`YYYY-MM-DD` 字典序 == 时间序，不必引入日期库，
 *    也避免「时区差一天」这类在纯函数里最难查的错。
 * ⚠️ 晚于 expectedDate 也算 fresh：说明核过更晚的日期，应核日期自然已被覆盖。
 */
export function reconFreshness(
  lastRunDate: string | null | undefined,
  expectedDate: string,
): ReconFreshness {
  if (!lastRunDate) return 'never';
  return lastRunDate >= expectedDate ? 'fresh' : 'stale';
}

/** freshness 的人话（端上直接展示，不自己拼） */
export function reconFreshnessTip(
  freshness: ReconFreshness,
  opt: { lastRunDate?: string | null; expectedDate: string } = { expectedDate: '' },
): string {
  switch (freshness) {
    case 'never':
      return (
        '**从未记录自动对账**：任务可能没注册、或进程重启后没恢复。' +
        '页面上的「无告警」不等于「已核过」，请先到「定时任务」页确认对账任务在跑'
      );
    case 'stale':
      return (
        `最近一次自动对账是 ${opt.lastRunDate ?? '—'}，**没核到应核日期 ${opt.expectedDate}**` +
        ' —— 中间至少漏跑一天，请手动补跑或检查定时任务'
      );
    case 'fresh':
      return `最近一次自动对账：${opt.lastRunDate ?? '—'}（已覆盖应核日期 ${opt.expectedDate}）`;
  }
}

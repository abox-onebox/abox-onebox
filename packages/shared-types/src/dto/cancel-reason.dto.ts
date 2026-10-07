/**
 * 取消理由契约（2026-10-04 新增）
 *
 * ## 为什么要存「来源」而不只是「理由」
 * 系统里有三条各自独立的取消路径，过去它们都只把订单置为 `cancelled`，
 * 从订单表看不出是谁取消的：
 *
 *   ① 用户自助取消（U11）—— 用户主动放弃，是流失信号
 *   ② 截单批量取消未支付单（`cutoffByDate`）—— 用户忘了付款被系统清掉，量通常最大
 *   ③ 团长代退（`refund.service#applyByLeader`）—— 事后质量问题
 *
 * 这三类混在一行 `status='cancelled'` 里做统计，「用户主动放弃」会被
 * 「忘付款被清」稀释，结论正好相反。所以 `cancel_source` 是本功能的**核心字段**，
 * `cancel_reason` 只是它的补充。
 *
 * ## 为什么三处的 reason 不强行统一成一套枚举
 * 团长代退**已有一套独立的退款原因体系**（`RefundReasonType`：QUALITY 等，
 * 落在 `ab_refund.reason_type`），那是给财务与供应商追责用的，语义比
 * 「用户为什么不要了」重得多。强行合并会破坏既有统计口径。
 * ⇒ 统一的是 `cancel_source`（一张表内可比），`cancel_reason` 各域保留原语义。
 *
 * ## 用户侧为什么用预置选项而不是自由文本
 * 自由文本写 100 条能有 80 种写法，最后还得人工归类，等于没做分析。
 * 预置选项直接可 `GROUP BY cancel_reason` 出占比。
 * `other` 保留一条自由输入通道，用于收集选项没覆盖到的真实原因
 * （收集一段时间后，出现频次高的应升格为正式选项）。
 *
 * ## 可跳过（用户 2026-10-04 裁定）
 * 理由**非必填**，端上给「不说明，直接取消」入口。
 * ⚠️ 后果要认：总会有一部分人不填，占比分析存在缺口 —— 统计时
 * **必须先按 `cancel_source` 分层再看 `cancel_reason` 为 null 的比例**，
 * 不要拿「填了理由的人」当全体样本。
 */

/** 取消来源（本功能的核心维度） */
export const CANCEL_SOURCE = {
  /** 用户自助取消 */
  USER: 'user',
  /** 系统自动取消（截单清未支付单） */
  SYSTEM: 'system',
  /** 团长代退 */
  LEADER: 'leader',
} as const;

export type CancelSource = (typeof CANCEL_SOURCE)[keyof typeof CANCEL_SOURCE];

export const CANCEL_SOURCES: readonly CancelSource[] = Object.values(CANCEL_SOURCE);

/** 取消来源中文名（后台列表展示用） */
export const CANCEL_SOURCE_LABEL: Record<CancelSource, string> = {
  user: '用户自助',
  system: '系统截单',
  leader: '团长代退',
};

/**
 * 用户自助取消时可填的理由（端上选项列表按此顺序展示）
 *
 * ⚠️ `timeout_unpaid` **不在**这里 —— 那是系统专用，用户不该选到。
 */
export const CANCEL_REASONS = [
  'not_in_office',
  'dish_dislike',
  'price',
  'delivery_time',
  'ate_elsewhere',
  'duplicate',
  'other',
] as const;

export type CancelReason = (typeof CANCEL_REASONS)[number];

/** 系统自动取消专用理由 */
export const CANCEL_REASON_TIMEOUT_UNPAID = 'timeout_unpaid';

/** 用户理由 + 系统理由的完整集合（后台展示 / 导出用） */
export const CANCEL_REASON_LABEL: Record<string, string> = {
  not_in_office: '临时有事/不在办公室',
  dish_dislike: '菜品不合口味',
  price: '价格/预算',
  delivery_time: '送餐时间不合适',
  ate_elsewhere: '改在别处吃',
  duplicate: '重复下单/下错了',
  other: '其他',
  timeout_unpaid: '超时未支付（系统截单）',
};

/**
 * 取消理由补充说明的**接口校验上限**
 *
 * ⚠️ 2026-10-04 整体复查（报告 28）更正：此处原注释写「与 `cancel_note` 列长 **一致**」，
 *    是**错的** —— 列是 `VARCHAR(128)`，这里卡 100，是**刻意留 28 字余量**
 *    （迁移 `1700000000004-cancel-reason.ts` 与实体 `order.entity.ts:148-150` 均可复核）。
 *    留余量的理由：将来若要在说明后追加「（由后台补录）」之类的后缀，不必改列。
 *    ⇒ 两个数**不该**被拉平；校验上限只收紧到 100，落库侧容到 128。
 */
export const CANCEL_NOTE_MAX = 100;

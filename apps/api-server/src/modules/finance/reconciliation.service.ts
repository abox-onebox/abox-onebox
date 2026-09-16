import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { addDays, bjDateTime, isRealDate, toBjIso, todayBj } from '../../common/utils/time';
import { toFen } from '../../common/utils/money';
import { normalizePage, paginate } from '../../common/utils/response';
import { Order, PaymentLog, Refund } from '../../database/entities/order.entity';
import { AdminReconciliationQueryDto, ReconDiffType } from './dto/finance.dto';

/**
 * 后台 · 微信支付对账（《接口规范 v1.0》§6.5 · **D43** · 原型 P34 · 模块 M35-06）
 *
 * ## 这一页要回答的问题
 * 「**今天的钱，哪几笔对不上**」—— 不是一个流水列表（那去 D33 / D40 看），
 * 而是一份**差异清单**，且每条差异都自带「该找谁、下一步做什么」。
 * 故本服务的主体是 `list: ReconDiffRow[]`，`summary` 只是它的标题行。
 *
 * ## 三层口径（e2e 钉死恒等式）
 * ```
 *   订单侧 orderFen  = Σ ab_order.pay_amount      （paid_at 当日 · 状态非 未支付/已取消）
 *   流水侧 logFen    = Σ ab_payment_log.pay_amount（paid_at 当日 · status = success）
 *   退款侧 refundFen = Σ ab_refund.amount          （refunded_at 当日 · status = refunded）
 *
 *   diffFen = orderFen − logFen   ← 正常必须为 0
 *   netFen  = orderFen − refundFen ← 净入账
 * ```
 *
 * ## ⚠️⚠️ 本批次最重要的一条纪律：**不许假装已经跟微信对过账**
 * D43 的名字叫「与微信支付对账」，但**一期物理上拿不到微信账单**（无商户号 +
 * 无 API 证书）。若实现成「内部两表比对通过 → `balanced: true`」，运营会以为
 * 「**微信侧也平了**」—— 这是最危险的一类假绿：真正的差异（微信收了钱、
 * 我们不知道）在那一天**永远不会被发现**。
 *
 * 故出参**强制**带 `channel.source = 'local_only'` + `billAvailable: false` +
 * 一句人话 `note`，把「本页当前只对了**本地三头**」印在返回体里（端上原样展示）。
 * 接入账单下载后，只需补 `channel.source = 'bill'` 与账单比对段，口径不变。
 *
 * ## ⚠️ `date` 是**支付日**，不是出餐日
 * 对账对象是微信账单，微信**按支付日切日**。这是财务域里唯一一个 `date` 不指
 * 出餐日的端点，故出参回显 `anchor: 'paidAt'` + `anchorLabel: '支付日'`。
 * 拿它去对 D33 / D34 / D36 的出餐日数字必然对不上 —— 那是两个时间轴，不是 bug。
 */
@Injectable()
export class ReconciliationService {
  constructor(
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(PaymentLog) private readonly payRepo: Repository<PaymentLog>,
    @InjectRepository(Refund) private readonly refundRepo: Repository<Refund>,
  ) {}

  /**
   * D43 对账（按支付日）
   *
   * 三条查询各自负责一个方向，**缺一条就会漏一类差异**：
   *  - ① 当日订单 → 检出「订单说付了、钱没记录」
   *  - ② 当日订单的**全部**流水（不限日期）→ 检出「有流水但没成功 / 金额不一致」
   *    （不能只查当日流水：回调丢失时流水停在 `pending` 且 `paid_at` 为空，
   *      按日期切就把它切没了，恰好漏掉最该抓的那一类）
   *  - ③ 当日成功流水 + 当日退款 → 检出「钱收了但订单没标」与退款侧
   */
  async reconcile(q: AdminReconciliationQueryDto): Promise<ReconciliationView> {
    const date = q.date ?? todayBj();
    /**
     * ⚠️ **服务层兜底**真实日期校验：DTO 的正则挡得住 `2026-13-01`，却挡不住
     *    `2026-02-30`（格式合法、日历上不存在）。不校验就会由 `Date.UTC` **静默滚动**
     *    到 3 月 2 日 —— 运营看到的是一份**别的日期**的对账，且没有任何提示。
     */
    if (!isRealDate(date)) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `date「${date}」不是一个真实存在的日期（如 2026-13-01 / 2026-02-30）`,
        undefined,
        { field: 'date' },
      );
    }
    const start = bjDateTime(date, 0);
    const end = bjDateTime(addDays(date, 1), 0);
    const { page, pageSize, skip } = normalizePage(q);

    // ① 当日（支付日）已付款订单
    const orders = await this.orderRepo
      .createQueryBuilder('o')
      .select(['o.id', 'o.orderNo', 'o.payAmount', 'o.status', 'o.paidAt'])
      .where('o.paid_at >= :start AND o.paid_at < :end', { start, end })
      .andWhere('o.status NOT IN (:...ex)', { ex: ORDER_EXCLUDED_STATUSES })
      .getMany();

    // ② 上述订单的**全部**流水（不限日期）—— 见方法注释「缺一条就会漏一类差异」
    const logsForOrders = orders.length
      ? await this.payRepo
          .createQueryBuilder('p')
          .where(
            `p.order_id IN (
               SELECT o.id FROM ab_order o
               WHERE o.paid_at >= :start AND o.paid_at < :end AND o.status NOT IN (:...ex)
             )`,
            { start, end, ex: ORDER_EXCLUDED_STATUSES },
          )
          .getMany()
      : [];

    // ③ 当日成功流水（只有成功才有 `paid_at`）与当日已退款
    const [daySuccessLogs, dayRefunds] = await Promise.all([
      this.payRepo
        .createQueryBuilder('p')
        .select([
          'p.id',
          'p.orderId',
          'p.orderNo',
          'p.transactionId',
          'p.payAmount',
          'p.status',
          'p.paidAt',
        ])
        .where('p.paid_at >= :start AND p.paid_at < :end', { start, end })
        .andWhere('p.status = :ok', { ok: PAY_SUCCESS })
        .getMany(),
      this.refundRepo
        .createQueryBuilder('r')
        .select(['r.id', 'r.refundNo', 'r.orderNo', 'r.amount', 'r.status', 'r.refundedAt'])
        .where('r.status = :done', { done: REFUND_DONE })
        .andWhere('r.refunded_at >= :start AND r.refunded_at < :end', { start, end })
        .getMany(),
    ]);

    // ---------------------------------------------------------------- 差异检测
    const logByOrderId = new Map<number, PaymentLog>();
    for (const l of logsForOrders) {
      const key = Number(l.orderId);
      const prev = logByOrderId.get(key);
      // 同一订单若有多条流水，**优先保留成功那条**（重复回调在下面单独报）
      if (!prev || (prev.status !== PAY_SUCCESS && l.status === PAY_SUCCESS)) {
        logByOrderId.set(key, l);
      }
    }

    const dayOrderIds = new Set(orders.map((o) => Number(o.id)));
    const diffs: ReconDiffRow[] = [];
    let matchedCount = 0;

    // (a) 订单 → 流水方向
    for (const o of orders) {
      const log = logByOrderId.get(Number(o.id));
      const orderFen = toFen(Number(o.payAmount));
      if (!log) {
        diffs.push(
          this.row('order_paid_no_log', {
            orderId: Number(o.id),
            orderNo: o.orderNo,
            orderFen,
            logFen: null,
            paidAt: toBjIso(o.paidAt),
            statusText: `订单 ${o.status}`,
          }),
        );
        continue;
      }
      if (log.status !== PAY_SUCCESS) {
        diffs.push(
          this.row('order_paid_no_log', {
            orderId: Number(o.id),
            orderNo: o.orderNo,
            orderFen,
            logFen: toFen(Number(log.payAmount)),
            transactionId: log.transactionId ?? null,
            paidAt: toBjIso(o.paidAt),
            statusText: `订单已付款，但流水停在 ${log.status}`,
          }),
        );
        continue;
      }
      const logFen = toFen(Number(log.payAmount));
      if (logFen !== orderFen) {
        diffs.push(
          this.row('amount_mismatch', {
            orderId: Number(o.id),
            orderNo: o.orderNo,
            orderFen,
            logFen,
            diffFen: orderFen - logFen,
            transactionId: log.transactionId ?? null,
            paidAt: toBjIso(o.paidAt),
            statusText: '金额不一致',
          }),
        );
        continue;
      }
      matchedCount += 1;
    }

    // (b) 流水 → 订单方向（当日成功流水）
    for (const l of daySuccessLogs) {
      if (!l.transactionId) {
        diffs.push(
          this.row('no_transaction_id', {
            orderId: Number(l.orderId),
            orderNo: l.orderNo,
            logFen: toFen(Number(l.payAmount)),
            paidAt: toBjIso(l.paidAt),
            statusText: '流水成功但无微信交易号',
          }),
        );
      }
      if (!dayOrderIds.has(Number(l.orderId))) {
        diffs.push(
          this.row('log_success_no_order', {
            orderId: Number(l.orderId),
            orderNo: l.orderNo,
            logFen: toFen(Number(l.payAmount)),
            transactionId: l.transactionId ?? null,
            paidAt: toBjIso(l.paidAt),
            statusText: '当日成功流水的订单不在当日已付款清单内',
          }),
        );
      }
    }

    // (c) 重复交易号（同日在当日成功流水内检出）
    const byTxn = new Map<string, PaymentLog[]>();
    for (const l of daySuccessLogs) {
      if (!l.transactionId) continue;
      const arr = byTxn.get(l.transactionId) ?? [];
      arr.push(l);
      byTxn.set(l.transactionId, arr);
    }
    for (const [txn, group] of byTxn) {
      if (group.length < 2) continue;
      for (const l of group) {
        diffs.push(
          this.row('duplicate_transaction', {
            orderId: Number(l.orderId),
            orderNo: l.orderNo,
            logFen: toFen(Number(l.payAmount)),
            transactionId: txn,
            paidAt: toBjIso(l.paidAt),
            statusText: `同一交易号出现 ${group.length} 次`,
          }),
        );
      }
    }

    // ---------------------------------------------------------------- 汇总
    const orderFen = orders.reduce((s, o) => s + toFen(Number(o.payAmount)), 0);
    const logFen = daySuccessLogs.reduce((s, l) => s + toFen(Number(l.payAmount)), 0);
    const refundFen = dayRefunds.reduce((s, r) => s + toFen(Number(r.amount)), 0);
    const diffFen = orderFen - logFen;

    const summary: ReconSummary = {
      orderFen,
      logFen,
      diffFen,
      refundFen,
      netFen: orderFen - refundFen,
      orderCount: orders.length,
      logCount: daySuccessLogs.length,
      refundCount: dayRefunds.length,
      matchedCount,
      diffCount: diffs.length,
      /**
       * ⭐ `balanced` 同时要求**金额相等** 与 **无结构差异**：
       *    重复交易号 / 缺交易号可能不影响两侧合计（金额一样、只是凭证重复），
       *    只比金额会报「已平」，而凭证重复恰恰是重复入账的前兆。
       */
      balanced: diffFen === 0 && diffs.length === 0,
    };

    // ---------------------------------------------------------------- 出参
    //
    // 差异清单排序：先按类型分组（同一类问题一起处理），组内按订单号 —— 运营
    // 拿着这份清单是「一类一类去处理」，不是「按时间顺序看」。
    const sorted = [...diffs].sort(
      (a, b) =>
        RECON_DIFF_TYPES_ORDER.indexOf(a.type) - RECON_DIFF_TYPES_ORDER.indexOf(b.type) ||
        String(a.orderNo ?? '').localeCompare(String(b.orderNo ?? '')),
    );

    const diffTypeStats = RECON_DIFF_TYPES_ORDER.map((t) => ({
      type: t,
      label: RECON_DIFF_LABEL[t],
      count: sorted.filter((d) => d.type === t).length,
    }));

    return {
      date,
      anchor: 'paidAt',
      anchorLabel: '支付日',
      channel: RECON_CHANNEL,
      summary,
      diffTypeStats,
      ...paginate(sorted.slice(skip, skip + pageSize), sorted.length, page, pageSize),
      note: RECON_NOTE,
    };
  }

  /** 组装一条差异行（中文文案与「下一步」由服务端下发，端上不自造） */
  private row(
    type: ReconDiffType,
    v: {
      orderId?: number | null;
      orderNo?: string | null;
      orderFen?: number | null;
      logFen?: number | null;
      diffFen?: number | null;
      transactionId?: string | null;
      paidAt?: string | null;
      statusText: string;
    },
  ): ReconDiffRow {
    return {
      type,
      typeText: RECON_DIFF_LABEL[type],
      orderId: v.orderId ?? null,
      orderNo: v.orderNo ?? null,
      orderFen: v.orderFen ?? null,
      logFen: v.logFen ?? null,
      diffFen: v.diffFen ?? null,
      transactionId: v.transactionId ?? null,
      paidAt: v.paidAt ?? null,
      statusText: v.statusText,
      nextAction: RECON_DIFF_NEXT_ACTION[type],
    };
  }
}

// ==================================================================== 出参与常量

/** 订单侧排除的状态：`paid_at` 理论上不会落在它们上，此处为**防御性**过滤 */
const ORDER_EXCLUDED_STATUSES = ['pending_pay', 'cancelled'];
const REFUND_DONE = 'refunded';
/** `ab_payment_log.status` 的成功态 */
const PAY_SUCCESS = 'success';

/**
 * 差异类型**展示顺序**（也是分组顺序）
 *
 * 先「订单有钱、账上没有」再「账上有钱、订单没有」再凭证类 —— 与运营的处理
 * 优先级一致：先查**钱去哪了**，再查状态，最后补凭证。
 */
const RECON_DIFF_TYPES_ORDER: ReconDiffType[] = [
  'order_paid_no_log',
  'log_success_no_order',
  'amount_mismatch',
  'duplicate_transaction',
  'no_transaction_id',
];

/** 差异类型 → 中文文案（服务端唯一来源） */
export const RECON_DIFF_LABEL: Record<ReconDiffType, string> = {
  order_paid_no_log: '订单已付款、支付流水缺失',
  log_success_no_order: '支付流水成功、订单未标已付',
  amount_mismatch: '订单金额与实收金额不一致',
  duplicate_transaction: '同一微信交易号出现多次',
  no_transaction_id: '流水成功但缺微信交易号',
};

/**
 * 差异类型 → **下一步动作**（人话，含「不要做什么」）
 *
 * ⭐ 这一段是本接口对运营的全部价值所在：「对账不平」四个字无法执行，
 *    而「去商户平台按订单号查该笔是否真实收款」可以。
 */
export const RECON_DIFF_NEXT_ACTION: Record<ReconDiffType, string> = {
  order_paid_no_log:
    '微信回调可能丢失：到商户平台按订单号查该笔**是否真实收款**；确认已收则补记流水，确认未收则把订单回退 —— 不要直接改库',
  log_success_no_order:
    '钱已收到但订单状态未推进（或被误取消）：核对订单状态机与回调处理，必要时人工补流转并留痕',
  amount_mismatch:
    '应付额 ≠ 实收额：查是否有优惠 / 部分支付 / 手工改价；差异需留痕说明，不能靠调平掩盖',
  duplicate_transaction:
    '同一交易号被记了多次：**查回调是否重复消费**（可能是重复入账的前兆），确认后冲正多余的那条',
  no_transaction_id:
    '本地记成功但无微信回执凭证：**不可作为税前扣除凭证**，需补交易号；补不到的按「收款未确认」单独挂账',
};

/**
 * 渠道信息（**本批最重要的诚实标注**）
 *
 * 一期无商户号 + 无 API 证书 → **拿不到微信账单**，故本页只能做「本地账实核对」。
 * `billAvailable: false` + `note` 必须原样展示在页面上：若让运营以为「对平了 =
 * 跟微信也对平了」，那么真正危险的差异（微信收了钱、系统不知道）将永远不可见。
 */
export interface ReconChannel {
  /** `local_only` = 仅本地三头核对；接入账单下载后为 `bill` */
  source: 'local_only' | 'bill';
  /** 微信账单是否可得（一期恒 `false`） */
  billAvailable: boolean;
  label: string;
  note: string;
}

export const RECON_CHANNEL: ReconChannel = {
  source: 'local_only',
  billAvailable: false,
  label: '本地账实核对',
  note:
    '尚未接入微信支付账单下载（需商户号 + API 证书）。本页当前为**本地账实核对**：' +
    '订单侧（ab_order）↔ 支付流水侧（ab_payment_log）↔ 退款侧（ab_refund）。' +
    '⚠️ **这不等于已与微信侧对平** —— 微信侧未核对，接入后此处补账单文件比对。',
};

export const RECON_NOTE =
  '口径：`date` 是**支付日**（微信账单按支付日切日），**不是出餐日** —— ' +
  '拿它对 D33 / D34 / D36 的出餐日数字必然对不上（两个时间轴）。' +
  '`diffFen` 正常必须为 0；`balanced` 还额外要求**无结构差异**（重复交易号、缺交易号）。' +
  '本接口**刻意不提供「一键平账」**：对账的作用是暴露差异，不是把差异抹掉。';

/** D43 单条差异 */
export interface ReconDiffRow {
  type: ReconDiffType;
  typeText: string;
  orderId: number | null;
  orderNo: string | null;
  /** 订单侧金额（分）；不适用为 `null` */
  orderFen: number | null;
  /** 流水侧金额（分）；不适用为 `null` */
  logFen: number | null;
  /** 差额（分，`orderFen − logFen`）；不适用为 `null` */
  diffFen: number | null;
  transactionId: string | null;
  paidAt: string | null;
  statusText: string;
  nextAction: string;
}

/** D43 汇总（不受分页影响） */
export interface ReconSummary {
  /** 订单侧已付款金额（分） */
  orderFen: number;
  /** 流水侧成功金额（分） */
  logFen: number;
  /** `orderFen − logFen`：**正常必须为 0** */
  diffFen: number;
  /** 当日已退款金额（分） */
  refundFen: number;
  /** `orderFen − refundFen` 净入账（分） */
  netFen: number;
  orderCount: number;
  logCount: number;
  refundCount: number;
  /** 订单与流水**逐笔匹配**的数量（用于看「匹配率」，不列明细） */
  matchedCount: number;
  diffCount: number;
  balanced: boolean;
}

/** D43 出参 */
export interface ReconciliationView {
  date: string;
  /** 恒 `'paidAt'`：提醒调用方「这里的 date 不是出餐日」 */
  anchor: 'paidAt';
  anchorLabel: string;
  channel: ReconChannel;
  summary: ReconSummary;
  diffTypeStats: { type: string; label: string; count: number }[];
  list: ReconDiffRow[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  note: string;
}

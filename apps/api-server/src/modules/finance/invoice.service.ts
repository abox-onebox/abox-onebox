import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { monthRangeOf, toBjIso } from '../../common/utils/time';
import { toFen } from '../../common/utils/money';
import { normalizePage, paginate } from '../../common/utils/response';
import { SupplierShare } from '../../database/entities/finance.entity';
import { Supplier } from '../../database/entities/supplier.entity';
import { PURCHASE_VOID_STATUSES } from '../stats/stats.constants';
import { AdminInvoicesQueryDto, INVOICE_STATUS_LABEL, InvoiceStatus } from './dto/finance.dto';

/**
 * 后台 · 发票管理（《接口规范 v1.0》§6.5 · **D44** · 原型 P34 · 模块 M35-07）
 *
 * ## 发票是什么票
 * **进项票** —— 供应商开给 ABox 的增值税发票。自营口径下它是
 * **税前扣除凭证**（见 §6.5 D37 注：「自营下须索取增值税发票」），
 * 故「钱付了、票没到」是一项**实打实的税务风险**，不是一张待办。
 *
 * ## ⭐⭐ 零 DDL：发票不建表，从应付单**派生**
 * 项目表数已冻结（27 张），且发票的全部事实都已经躺在 `ab_supplier_share` 里：
 * `invoice_no`（D37 付款登记时录入）+ `paid_at`（付没付）+ `payee_id`（谁的票）。
 * 建一张 `ab_invoice` 只会立刻产生**第二份真相** —— 「应付表说付了、发票表说没票」
 * 时以谁为准？故本服务是**纯读**视图，与项目「派生值不落库」不变量一致。
 *
 * ## ⭐⭐ 粒度 = 「供应商 × 月份」，不是单条应付行
 * 发票实务上按**月**开一张。若按应付行展示，运营看到的是「同一个发票号重复出现在
 * 30 行里」，**完全看不出**「这家这个月只开了一半」—— 而这恰恰是最需要被发现的
 * 状态。故聚合 + 三态（`none` / `partial` / `full`），`partial` 是本页存在的理由。
 *
 * ## ⚠️ 两个必须写清的口径
 * 1. **月份锚 = `share_date`（应付单生成日）的月**，不是付款月。它是一份
 *    「这个月平台欠你多少、票到没到」的**台账**；跨月付款（8 月账单 9 月付）
 *    仍归 8 月台账。这是**权责发生**视角，与收付实现制刻意不同。
 * 2. **分母只含「已付款」行**：未付款就要票，供应商不会给。未付款的应付额
 *    **单列为 `unpaidAmountFen`**，不参与开票状态判定（否则一个刚出单的日子
 *    会显示成「大面积未开票」，把真正的欠票淹没）。
 */
@Injectable()
export class InvoiceService {
  constructor(
    @InjectRepository(SupplierShare) private readonly shareRepo: Repository<SupplierShare>,
    @InjectRepository(Supplier) private readonly supplierRepo: Repository<Supplier>,
  ) {}

  /**
   * D44 发票台账
   *
   * ⚠️ **分月必须在服务端内存里做，不能用 SQL 的日期格式化函数**：
   *    `strftime('%Y-%m', …)`（SQLite）与 `DATE_FORMAT(…, '%Y-%m')`（MySQL）
   *    是**驱动相关**语法 —— 用了就破坏「四驱动零改动切换」这条项目不变量，
   *    而且本地全绿、换驱动才炸。这与 M3-6/D29 楼群筛选「一律服务端内存过滤」
   *    是同一处理。
   *    数据量可控：应付单按「供应商 × 出餐日」一行，一年量级为千行。
   */
  async list(q: AdminInvoicesQueryDto): Promise<InvoiceListView> {
    const { page, pageSize, skip } = normalizePage(q);

    // ---- 供应商（既是行内名称来源，也是 keyword / supplierId 的过滤依据）----
    const supQb = this.supplierRepo
      .createQueryBuilder('sp')
      .select(['sp.id', 'sp.name', 'sp.invoiceTitle']);
    if (q.supplierId) supQb.andWhere('sp.id = :sid', { sid: q.supplierId });
    if (q.keyword) supQb.andWhere('sp.name LIKE :kw', { kw: `%${q.keyword}%` });
    const suppliers = await supQb.getMany();
    const supById = new Map(suppliers.map((s) => [Number(s.id), s]));
    /** 仅当给了筛选条件时才用供应商集合反筛应付行；否则「供应商已被删」的行也要留着可见 */
    const payeeFilter = q.supplierId || q.keyword ? new Set(supById.keys()) : null;

    // ---- 应付行 ----
    const qb = this.shareRepo
      .createQueryBuilder('s')
      .select([
        's.id',
        's.payeeId',
        's.payeeType',
        's.type',
        's.amount',
        's.status',
        's.invoiceNo',
        's.paidAt',
        's.shareDate',
      ])
      // 自营口径下 `payee_type` 恒为 `supplier`（`distribution_center` 已冻结），此处仍显式声明
      .andWhere('s.payee_type = :pt', { pt: 'supplier' });
    if (q.supplierId) qb.andWhere('s.payee_id = :sid', { sid: q.supplierId });
    if (q.month) {
      /** ⭐ 复用 `monthRangeOf` —— 项目里**月份边界的唯一实现**（佣金/晋级审计同源） */
      const { from, to } = monthRangeOf(`${q.month}-01`);
      qb.andWhere('s.share_date >= :from AND s.share_date <= :to', { from, to });
    }
    const shares = await qb.getMany();

    // ---------------------------------------------------------------- 内存聚合
    interface Acc {
      payeeId: number;
      month: string;
      paidFen: number;
      invoicedFen: number;
      unpaidFen: number;
      reversalFen: number;
      rowCount: number;
      paidRowCount: number;
      unpaidRowCount: number;
      invoiceNos: Set<string>;
      /** 未开票的**已付款**行的最早付款时刻（用于逾期天数） */
      earliestUninvoicedPaidAt: Date | null;
      firstPaidAt: Date | null;
      lastPaidAt: Date | null;
    }

    const accs = new Map<string, Acc>();
    for (const s of shares) {
      const payeeId = Number(s.payeeId);
      if (payeeFilter && !payeeFilter.has(payeeId)) continue;

      const month = String(s.shareDate ?? '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) continue;

      const key = `${payeeId}|${month}`;
      let acc = accs.get(key);
      if (!acc) {
        acc = {
          payeeId,
          month,
          paidFen: 0,
          invoicedFen: 0,
          unpaidFen: 0,
          reversalFen: 0,
          rowCount: 0,
          paidRowCount: 0,
          unpaidRowCount: 0,
          invoiceNos: new Set(),
          earliestUninvoicedPaidAt: null,
          firstPaidAt: null,
          lastPaidAt: null,
        };
        accs.set(key, acc);
      }

      const amountFen = toFen(Number(s.amount));

      // 纠错冲销行：负数，**不进发票分母**（见出参 `note`），仅作提示单独累计
      if (s.type === 'reversal') {
        acc.reversalFen += amountFen;
        continue;
      }
      // 已失效（冲销 / 作废）不计 —— 复用 stats 侧的失效状态集合，避免第二份名单
      if (PURCHASE_VOID_STATUSES.includes(s.status)) continue;

      acc.rowCount += 1;
      if (s.status === SHARE_PAID) {
        acc.paidRowCount += 1;
        acc.paidFen += amountFen;
        const no = s.invoiceNo?.trim();
        if (no) {
          acc.invoicedFen += amountFen;
          acc.invoiceNos.add(no);
        } else {
          const at = s.paidAt ? new Date(s.paidAt) : null;
          if (at && (!acc.earliestUninvoicedPaidAt || at < acc.earliestUninvoicedPaidAt)) {
            acc.earliestUninvoicedPaidAt = at;
          }
        }
        const at = s.paidAt ? new Date(s.paidAt) : null;
        if (at) {
          if (!acc.firstPaidAt || at < acc.firstPaidAt) acc.firstPaidAt = at;
          if (!acc.lastPaidAt || at > acc.lastPaidAt) acc.lastPaidAt = at;
        }
      } else {
        acc.unpaidRowCount += 1;
        acc.unpaidFen += amountFen;
      }
    }

    // ---------------------------------------------------------------- 组装行
    const now = Date.now();
    let rows: InvoiceRow[] = [...accs.values()].map((a) => {
      const uninvoicedFen = a.paidFen - a.invoicedFen;
      const status: InvoiceStatus =
        a.paidFen <= 0
          ? 'none'
          : uninvoicedFen <= 0
            ? 'full'
            : a.invoicedFen <= 0
              ? 'none'
              : 'partial';
      const overdueDays = a.earliestUninvoicedPaidAt
        ? Math.floor((now - a.earliestUninvoicedPaidAt.getTime()) / 86400000)
        : null;
      const sup = supById.get(a.payeeId);
      const invoiceTitle = sup?.invoiceTitle?.trim() || null;
      return {
        payeeId: a.payeeId,
        supplierName: sup?.name ?? '（供应商已不存在）',
        /** 开票抬头（D28 独立成列）；展示名与开票名不一致是常态（个体户尤其） */
        invoiceTitle,
        /** ⭐ `true` 时端上引导「去 D28 补开票抬头」—— 抬头缺失票开不出来 */
        titleMissing: !invoiceTitle,
        month: a.month,
        rowCount: a.rowCount,
        paidRowCount: a.paidRowCount,
        unpaidRowCount: a.unpaidRowCount,
        paidAmountFen: a.paidFen,
        invoicedFen: a.invoicedFen,
        uninvoicedFen,
        unpaidAmountFen: a.unpaidFen,
        reversalFen: a.reversalFen,
        invoiceNos: [...a.invoiceNos],
        status,
        statusText: INVOICE_STATUS_LABEL[status],
        firstPaidAt: toBjIso(a.firstPaidAt),
        lastPaidAt: toBjIso(a.lastPaidAt),
        overdueDays,
        /** 已付款超过 `INVOICE_OVERDUE_DAYS` 天仍无票 = 税务风险提示 */
        overdue: overdueDays !== null && overdueDays > INVOICE_OVERDUE_DAYS && uninvoicedFen > 0,
      };
    });

    // ---------------------------------------------------------------- 汇总（**筛选后全量**）
    //
    // ⚠️ 先于分页、便宜地算在完整集合上 —— 与 D8/D34/D36/D40 同一约定：
    //    「汇总不受分页影响」，否则运营翻到第 2 页会发现合计变小。
    const summary: InvoiceSummary = {
      monthCount: new Set(rows.map((r) => r.month)).size,
      supplierCount: new Set(rows.map((r) => r.payeeId)).size,
      paidAmountFen: rows.reduce((s, r) => s + r.paidAmountFen, 0),
      invoicedFen: rows.reduce((s, r) => s + r.invoicedFen, 0),
      uninvoicedFen: rows.reduce((s, r) => s + r.uninvoicedFen, 0),
      unpaidAmountFen: rows.reduce((s, r) => s + r.unpaidAmountFen, 0),
      reversalFen: rows.reduce((s, r) => s + r.reversalFen, 0),
      noneCount: rows.filter((r) => r.status === 'none').length,
      partialCount: rows.filter((r) => r.status === 'partial').length,
      fullCount: rows.filter((r) => r.status === 'full').length,
      overdueCount: rows.filter((r) => r.overdue).length,
      overdueDays: INVOICE_OVERDUE_DAYS,
      statusOptions: INVOICE_STATUS_OPTIONS,
    };

    // `status` 是**派生值**，只能聚合完再筛（库里的三态是 pending/success/…）
    if (q.status) rows = rows.filter((r) => r.status === q.status);

    // 排序：月份降序（先看最近的月），组内**未开票金额降序**（最该催的排最前）
    rows.sort(
      (a, b) =>
        b.month.localeCompare(a.month) ||
        b.uninvoicedFen - a.uninvoicedFen ||
        a.payeeId - b.payeeId,
    );

    return {
      summary,
      ...paginate(rows.slice(skip, skip + pageSize), rows.length, page, pageSize),
      note: INVOICE_NOTE,
    };
  }
}

// ==================================================================== 出参与常量

const SHARE_PAID = 'success';

/** 已付款后多少天仍未收到发票 → 判定逾期（税务风险提示） */
export const INVOICE_OVERDUE_DAYS = 30;

export const INVOICE_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'none', label: INVOICE_STATUS_LABEL.none },
  { value: 'partial', label: INVOICE_STATUS_LABEL.partial },
  { value: 'full', label: INVOICE_STATUS_LABEL.full },
];

export const INVOICE_NOTE =
  '口径：① 月份是**应付单生成月**（`share_date`）—— 这是一份权责发生制台账，' +
  '跨月付款仍归原月；② 开票分母**只含已付款行**（未付款就要票，供应商不会给），' +
  '`unpaidAmountFen` 是尚未付款的应付额，不参与开票状态判定；' +
  '③ `reversalFen` 是当月纠错冲销额（负数）—— **冲销行不进发票分母**，' +
  '若已按原金额开票，需与供应商**另行换票**（本期不做换票流程，故此处只作提示）；' +
  `④ 已付款超过 ${INVOICE_OVERDUE_DAYS} 天仍无票 → 标逾期（税前扣除凭证缺失）。`;

/** D44 单行（**供应商 × 月份**） */
export interface InvoiceRow {
  payeeId: number;
  supplierName: string;
  /** 开票抬头（`ab_supplier.invoice_title`，D28 独立成列）；未登记为 `null` */
  invoiceTitle: string | null;
  /** 抬头未登记 —— 端上引导去 D28 补（没有抬头票开不出来） */
  titleMissing: boolean;
  /** 应付单生成月 `YYYY-MM` */
  month: string;
  rowCount: number;
  paidRowCount: number;
  unpaidRowCount: number;
  /** 已付款应付额（**开票分母**） */
  paidAmountFen: number;
  /** 其中已开票金额 */
  invoicedFen: number;
  /** 其中未开票金额（**该催的**） */
  uninvoicedFen: number;
  /** 尚未付款的应付额（不进开票状态判定） */
  unpaidAmountFen: number;
  /** 当月纠错冲销额（负数）—— 需另行换票 */
  reversalFen: number;
  invoiceNos: string[];
  status: InvoiceStatus;
  statusText: string;
  firstPaidAt: string | null;
  lastPaidAt: string | null;
  /** 最早一笔未开票已付款行距今天数；无未开票行时为 `null` */
  overdueDays: number | null;
  overdue: boolean;
}

/** D44 汇总（**不受分页影响**） */
export interface InvoiceSummary {
  monthCount: number;
  supplierCount: number;
  paidAmountFen: number;
  invoicedFen: number;
  uninvoicedFen: number;
  unpaidAmountFen: number;
  reversalFen: number;
  noneCount: number;
  partialCount: number;
  fullCount: number;
  overdueCount: number;
  overdueDays: number;
  statusOptions: { value: string; label: string }[];
}

/** D44 出参 */
export interface InvoiceListView {
  summary: InvoiceSummary;
  list: InvoiceRow[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  note: string;
}

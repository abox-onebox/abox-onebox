import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import {
  LICENSE_EXPIRING_DAYS,
  LicenseState,
  SupplierAuditStatus,
  SupplierStatus,
} from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { money, round2, toFen } from '../../common/utils/money';
import { genShareNo } from '../../common/utils/order-no';
import { addDays, toBjIso, todayBj } from '../../common/utils/time';
import { SupplierShare } from '../../database/entities/finance.entity';
import { Dish, Supplier, SupplierDishDaily } from '../../database/entities/supplier.entity';
import {
  GenerateSharesDto,
  RegisterPaymentDto,
  SHARE_STATUS_LABEL,
  ShareExceptionsQueryDto,
  SupplierShareListQueryDto,
} from './dto/supplier-share.dto';

/**
 * 应付结算服务（S9 · 后台 P34 / 供应商端 P25）—— **自营口径 2026-09-16**
 *
 * 口径唯一权威源：《ABox一盒自营结算口径定义v1.0.md》
 *
 * ## 一句话口径
 * **应付 = 实收量 × 逐菜协商采购价**，对象**只有供应商**（半成品采购款），按
 * `(供应商, 菜品, 出餐日)` 一行出单；财务**人工对公转账**后回填银行回单号（C10）。
 * 场所摊销 / 打包人工 / 配送费是 ABox 自身成本，**不出付款单**，只进成本核算（§3.1）。
 *
 * ## 计费基数是「实收量」而不是「订单销量」
 * 这是本次路线裁定带来的最大变化。旧口径下应付 = 「用户实际买走多少份 × 分成比例」，
 * 用户退款还要反向冲减；自营下采购的本质是「**供应商交了多少，我付多少**」——
 * 与用户卖没卖出去无关（半成品在出餐日已交付并投入使用）。因此：
 *   · 基数取 `ab_supplier_dish_daily.actual_quantity`（S2 出餐确认申报的实送量，
 *     未申报 = 计划量，语义见 §4.1）
 *   · ⭐ **用户退款不冲减本表**（`reversal.service.ts` 已按此回退，见 §5.1）
 *   · `type='reversal'` 改义为「应付单生成后发现算错」的**纠错冲销**，不再由退款触发
 *
 * ## 三处 fail-closed（缺关键输入时不猜默认值）
 *   1. **该菜当日未全部确认完成** → 不出单（父行 `status != 'done'`，进异常清单）。
 *      此时父行实收量**只覆盖已确认的中心**：按它出单会**少付**、按计划量补齐会**多付**
 *      —— 两种猜法都在钱上出错，故不猜。与 M3-8 的 `50009`、D41/D42 的 `40014` 同一纪律。
 *   2. **供应商资质异常** → 不出单（资质未核验期间的供货不进结算，与 S2 的 50001 同判据）。
 *   3. **付款登记**只接受 `pending`；缺回单号 → `50013`。已付款再登记一次就是**重复出款**，
 *      钱转出去追不回来。同理**已付款的应付单不得改写** —— 纠错走 `type='reversal'` 负行
 *      挂下期抵扣，这是 C9「原记录一律不得改写」在本表的落地。
 *
 * ## 幂等
 * 幂等键 = `(供应商, 菜品, 出餐日)` 且 `type='normal'`：已存在则跳过（进 `skipped`）。
 * 跑批支持**重跑**（先 fail-closed 的项在补确认后重跑即可补出），重复跑不会多出单。
 * ⚠️ 刻意把该键放在**软件层**而非 DB 唯一索引：本表还要容纳 `type='reversal'` 的负行
 *   （同一键会有正负两行），唯一索引会把合法的冲销行一起挡掉。
 *
 * ⚠️ **不变量 I1**：本服务出参不含终端售价 ¥25.80、佣金、毛利、成本合计。
 *    供应商端（`GET /supplier/settlement`）复用同一份行结构，故这条不变量在
 *    **数据源头**即成立，不依赖前端自觉。
 */
@Injectable()
export class SupplierShareService {
  private readonly logger = new Logger('SupplierShare');

  constructor(
    @InjectRepository(SupplierShare) private readonly shareRepo: Repository<SupplierShare>,
    @InjectRepository(Supplier) private readonly supplierRepo: Repository<Supplier>,
    @InjectRepository(Dish) private readonly dishRepo: Repository<Dish>,
    @InjectRepository(SupplierDishDaily)
    private readonly dailyRepo: Repository<SupplierDishDaily>,
  ) {}

  // =====================================================================
  // 出单
  // =====================================================================

  /**
   * S9 `POST /admin/supplier-shares/generate` —— 生成应付单（幂等 · 可重跑）
   *
   * 跑批 `supplier-share.task` 与运营手动补跑共用本方法（唯一执行口）。
   * 出参把「出了什么 / 跳过了什么 / 为什么没出」三件事一起给出 ——
   * 运营点完按钮最想知道的是**第 3 件**（哪些单没出来、要不要处理）。
   */
  async generate(dto: GenerateSharesDto, operatorId?: number | null) {
    const { date, supplierId } = dto;
    const { candidates, exceptions } = await this.scan(date, supplierId);

    // 幂等闸门：同一 (供应商, 菜品, 出餐日) 已有 normal 行 → 跳过
    const existed = await this.shareRepo.find({
      where: {
        mealDate: date,
        payeeType: PAYEE_SUPPLIER,
        type: 'normal',
        ...(supplierId ? { payeeId: supplierId } : {}),
      },
    });
    const existedKey = new Map(existed.map((s) => [`${s.payeeId}:${s.dishId}`, s.shareNo]));

    const rows: Array<Partial<SupplierShare>> = [];
    const created: Array<Record<string, unknown>> = [];
    const skipped: Array<Record<string, unknown>> = [];

    for (const c of candidates) {
      const key = `${c.supplierId}:${c.dishId}`;
      const hit = existedKey.get(key);
      if (hit) {
        skipped.push({
          supplierId: c.supplierId,
          supplierName: c.supplierName,
          dishId: c.dishId,
          dishName: c.dishName,
          reason: 'already_generated',
          shareNo: hit,
        });
        continue;
      }

      const shareNo = genShareNo();
      rows.push({
        shareNo,
        // 两个日期都要留：「哪天的量」（meal_date）与「哪天出的单」（share_date）
        // 在对账时是两个不同的问题
        shareDate: todayBj(),
        mealDate: date,
        payeeType: PAYEE_SUPPLIER,
        payeeId: c.supplierId,
        dishId: c.dishId,
        quantity: c.quantity,
        unitPrice: c.unitPrice,
        amount: money(c.amountYuan),
        type: 'normal',
        channel: 'manual',
        status: 'pending',
      });
      created.push({
        shareNo,
        supplierId: c.supplierId,
        supplierName: c.supplierName,
        dishId: c.dishId,
        dishName: c.dishName,
        planQuantity: c.planQuantity,
        quantity: c.quantity,
        unitPriceFen: toFen(Number(c.unitPrice)),
        amountFen: toFen(c.amountYuan),
      });
    }

    if (rows.length) {
      const saved = await this.shareRepo.save(this.shareRepo.create(rows));
      // 回填 id：运营拿到 `created` 后要能**直接对某条登记付款** ——
      // 只回 shareNo 等于让人再去列表里搜一遍（页面「出单后立刻付款」的常见路径）
      const idOf = new Map(saved.map((s) => [s.shareNo, s.id]));
      for (const c of created) c.id = idOf.get(String(c.shareNo)) ?? null;
    }

    const createdAmountFen = created.reduce((s, r) => s + Number(r.amountFen ?? 0), 0);
    if (rows.length) {
      this.logger.log(
        `S9 出单 date=${date} 新增 ${rows.length} 单 ¥${money(createdAmountFen / 100)}` +
          ` 跳过 ${skipped.length} 异常 ${exceptions.length}` +
          (operatorId ? `（操作人#${operatorId}）` : '（跑批）'),
      );
    }

    return {
      date,
      created,
      skipped,
      exceptions,
      summary: {
        createdCount: created.length,
        createdAmountFen,
        skippedCount: skipped.length,
        exceptionCount: exceptions.length,
        candidateCount: candidates.length,
      },
      notes: {
        baseRule:
          '计费基数 = **实收量**（供应商出餐确认申报的实送份数；未申报视为足额）。' +
          '短送即少付，无需人工对账 —— 请供应商如实申报。',
        priceRule:
          '单价 = 逐菜协商采购价，取**出餐计划生成时冻结的快照**（`ab_supplier_dish_daily.unit_price`）；' +
          '计划缺该值时回落到菜品当前协商价。计划冻结后改价**不影响已生成计划的出单**。',
        idempotentRule:
          '同一（供应商 · 菜品 · 出餐日）已有应付行则跳过 —— 本接口可安全重跑，不会重复出单。',
        exceptionRule:
          '未出单的项在 `exceptions` 里给出原因；补齐后（如催供应商确认出餐）重跑本接口即可补出。',
      },
    };
  }

  /**
   * 跑批入口（T+1 02:00 · 由 `tasks/supplier-share.task.ts` 委托）
   *
   * 缺省出「**昨日**」的单 —— 应付的对象是**已经发生**的交付。
   * 与 `generate()` 共用同一执行口，跑批与手动补跑不会长出第二套口径。
   */
  async runDaily(date?: string) {
    const target = date ?? addDays(todayBj(), -1);
    const r = await this.generate({ date: target });
    return { ...r, ranAt: toBjIso(new Date()) };
  }

  // =====================================================================
  // 查询
  // =====================================================================

  /** S9 `GET /admin/supplier-shares` —— 应付单列表（汇总取同条件全量，不受分页影响） */
  async list(q: SupplierShareListQueryDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;

    const qb = this.shareRepo
      .createQueryBuilder('s')
      .where('s.payee_type = :pt', { pt: PAYEE_SUPPLIER });
    if (q.date) qb.andWhere('s.meal_date = :date', { date: q.date });
    if (q.supplierId) qb.andWhere('s.payee_id = :sid', { sid: q.supplierId });
    if (q.status && q.status !== 'all') qb.andWhere('s.status = :st', { st: q.status });
    if (q.keyword) {
      qb.andWhere(
        '(s.share_no LIKE :kw OR s.payment_voucher_no LIKE :kw OR s.invoice_no LIKE :kw)',
        {
          kw: `%${q.keyword}%`,
        },
      );
    }

    // 汇总取**同一过滤条件的全量** —— 与 D8/D40 同一纪律：否则「本页合计」
    // 会被页面误读成「全部合计」。
    const all = await qb.clone().orderBy('s.id', 'DESC').getMany();
    const pageRows = all.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
    const list = await this.decorate(pageRows);

    const sumOf = (rows: SupplierShare[]) => rows.reduce((s, r) => s + toFen(Number(r.amount)), 0);
    const pending = all.filter((r) => r.status === 'pending');
    const paid = all.filter((r) => r.status === 'success');
    const reversed = all.filter((r) => r.status === 'reversed');

    return {
      list,
      total: all.length,
      page,
      pageSize,
      date: q.date ?? null,
      summary: {
        rowCount: all.length,
        amountFen: sumOf(all),
        pendingCount: pending.length,
        pendingAmountFen: sumOf(pending),
        paidCount: paid.length,
        paidAmountFen: sumOf(paid),
        reversedCount: reversed.length,
        reversedAmountFen: sumOf(reversed),
        supplierCount: new Set(all.map((r) => r.payeeId)).size,
      },
      /** 服务端下发枚举映射，端上不维护第二份（避免漂移） */
      statusOptions: Object.entries(SHARE_STATUS_LABEL).map(([value, label]) => ({ value, label })),
    };
  }

  /**
   * S9 `GET /admin/supplier-shares/exceptions` —— 未出单异常清单
   *
   * 「某一天为什么没出单」的可执行答案。**已出单的行会被过滤掉** ——
   * 清单上残留「其实已经出过单」的项，会让运营反复做无用功；而
   * 「先 fail-closed → 补确认 → 重跑出单」本来就是**正常路径**，不是异常。
   */
  async exceptions(q: ShareExceptionsQueryDto) {
    const { exceptions } = await this.scan(q.date, q.supplierId);

    const existed = await this.shareRepo.find({
      where: {
        mealDate: q.date,
        payeeType: PAYEE_SUPPLIER,
        type: 'normal',
        ...(q.supplierId ? { payeeId: q.supplierId } : {}),
      },
    });
    const keys = new Set(existed.map((s) => `${s.payeeId}:${s.dishId}`));
    const list = exceptions.filter((e) => !keys.has(`${e.supplierId}:${e.dishId}`));

    const byReason: Record<string, number> = {};
    for (const e of list) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;

    return {
      date: q.date,
      list,
      summary: {
        count: list.length,
        supplierCount: new Set(list.map((e) => e.supplierId)).size,
        dishCount: new Set(list.map((e) => e.dishId)).size,
        byReason,
      },
      notes: {
        ruleText:
          '这些项**不会**被自动出单 —— 系统缺关键输入时不猜默认值（按已确认量出会少付、' +
          '按计划量出会多付）。补齐后重跑「生成应付」即可补出。',
      },
    };
  }

  // =====================================================================
  // 付款登记
  // =====================================================================

  /**
   * S9 `POST /admin/supplier-shares/:id/payment` —— 付款登记（C10：只记账，不走通道）
   *
   * ⚠️ 两个 fail-closed：
   *   · 非 `pending` → `50012`（已付款的单再登记一次就是**重复出款**）
   *   · 缺回单号 → `50013`（回单号是「这笔钱确实付了」的唯一凭证）
   * 重复回单号 → `10001`：一个回单只能对应一笔付款，否则两笔支出挂同一凭证，
   * 对账时无法分辨哪笔是真的付了。
   */
  async registerPayment(id: number, dto: RegisterPaymentDto, operatorId?: number | null) {
    const row = await this.shareRepo.findOne({ where: { id } });
    if (!row || row.payeeType !== PAYEE_SUPPLIER) {
      throw new BizException(
        ErrorCode.SUPPLIER_SHARE_NOT_PAYABLE,
        `应付单 #${id} 不存在（付款登记只针对供应商采购应付）`,
      );
    }
    if (row.status !== 'pending' || row.type !== 'normal') {
      throw new BizException(
        ErrorCode.SUPPLIER_SHARE_NOT_PAYABLE,
        `应付单 ${row.shareNo} 当前状态为「${SHARE_STATUS_LABEL[row.status] ?? row.status}」，` +
          '不能登记付款。已付款的单重复登记就是重复出款，钱转出去追不回来 —— ' +
          '若确系付错，请走「纠错冲销」（写反向行挂下期抵扣，原记录不改写）。',
      );
    }

    const voucher = dto.paymentVoucherNo.trim();
    if (!voucher) {
      throw new BizException(
        ErrorCode.PAYMENT_VOUCHER_REQUIRED,
        '请填写银行回单号 —— 它是「这笔钱确实付了」的唯一凭证',
      );
    }
    const dup = await this.shareRepo.findOne({ where: { paymentVoucherNo: voucher } });
    if (dup && Number(dup.id) !== Number(row.id)) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `回单号 ${voucher} 已用于应付单 ${dup.shareNo} —— 一个回单只能对应一笔付款，` +
          '否则两笔支出会挂同一个凭证，对账时无法分辨哪笔是真的付了',
      );
    }

    row.paymentVoucherNo = voucher;
    if (dto.invoiceNo !== undefined) row.invoiceNo = dto.invoiceNo.trim() || null;
    row.status = 'success';
    // 付款时刻取系统当前时间（刻意不收 `paidAt` 入参）—— 对账要的是诚实的时间戳
    row.paidAt = new Date();
    row.settledAt = new Date();
    await this.shareRepo.save(row);

    this.logger.log(
      `S9 付款登记 ${row.shareNo} 供应商#${row.payeeId} ¥${row.amount} 回单=${voucher}` +
        (row.invoiceNo ? ` 发票=${row.invoiceNo}` : '') +
        (operatorId ? `（操作人#${operatorId}）` : ''),
    );

    const [decorated] = await this.decorate([row]);
    return {
      ...decorated,
      tips:
        '付款已登记（仅记账）—— 系统不发起任何通道付款，实际转账由财务走对公账户完成（C10）。' +
        '请留存银行回单与供应商发票备查。',
    };
  }

  // =====================================================================
  // 供应商端自查（P25）
  // =====================================================================

  /**
   * 供应商端 `GET /supplier/settlement?date=` —— 我的应付结算明细（原型 P25）
   *
   * 与后台 S9 列表**共用同一份行结构与同一套状态文案**（都走 `decorate()`），差别只有两点：
   *   · 数据范围由 `supplierId` 收窄（调用方只传 token 里的 id，**请求体不收**）
   *   · 出参**不含**终端售价 ¥25.80 / 佣金 / 毛利 / 成本合计（不变量 I1）
   *     —— 这不是靠前端「不显示」，而是本方法只读 `ab_supplier_share` 的采购口径字段，
   *     **结构上就没有那些数**。放在财务服务里实现，正是为了让它只有一份实现。
   *
   * ⚠️ 「还欠我多少」用**跨日期的合计**给出：供应商真正关心的是这个数，
   *    而不是「某一天多少钱」。逐日明细供对账，合计供心里有数。
   */
  async supplierView(supplierId: number | null | undefined, date?: string) {
    if (!supplierId) {
      throw new BizException(
        ErrorCode.SUPPLIER_NOT_FOUND,
        '当前账号未绑定供应商，无法查看结算明细（请联系运营在后台「账号管理」中绑定）',
      );
    }
    const supplier = await this.supplierRepo.findOne({ where: { id: supplierId } });
    if (!supplier || supplier.status !== SupplierStatus.ACTIVE) {
      throw new BizException(ErrorCode.SUPPLIER_NOT_FOUND, '供应商不存在或已停用');
    }
    const target = date ?? todayBj();

    const rows = await this.shareRepo.find({
      where: { payeeType: PAYEE_SUPPLIER, type: 'normal', payeeId: supplier.id, mealDate: target },
      order: { id: 'ASC' },
    });
    const list = await this.decorate(rows);

    const pendingAll = await this.shareRepo.find({
      where: { payeeType: PAYEE_SUPPLIER, type: 'normal', payeeId: supplier.id, status: 'pending' },
    });
    const pending = rows.filter((r) => r.status === 'pending');
    const paid = rows.filter((r) => r.status === 'success');
    const sumFen = (arr: SupplierShare[]) => arr.reduce((s, r) => s + toFen(Number(r.amount)), 0);

    return {
      date: target,
      supplier: { id: supplier.id, name: supplier.name },
      list,
      summary: {
        rowCount: rows.length,
        quantity: rows.reduce((s, r) => s + Number(r.quantity), 0),
        amountFen: sumFen(rows),
        pendingCount: pending.length,
        pendingAmountFen: sumFen(pending),
        paidCount: paid.length,
        paidAmountFen: sumFen(paid),
        /** 全量待付合计（不限日期）—— 供应商最关心的一个数 */
        pendingTotalAmountFen: sumFen(pendingAll),
        pendingTotalRowCount: pendingAll.length,
        /** 该日尚未出单（跑批在 T+1 02:00，或当日出餐确认未完成）—— 端上走空态文案 */
        empty: rows.length === 0,
      },
      notes: {
        baseRule:
          '计费基数 = **实收量**，即你在「出餐确认」里申报的实送份数（未申报视为足额）。' +
          '短送即少付 —— 这既是对账依据，也是你自己的收入依据。',
        priceRule: '单价 = 双方协商的采购价，按菜逐项列示。',
        payRule:
          '付款方式为**人工对公转账**：平台财务转账后回填银行回单号，回单号即付款完成的唯一凭证。' +
          '如需发票对接，请联系运营登记发票号。',
        disputeRule: '对份数有异议时，以「出餐确认」的时间戳与备注为准（那是交付当时的留痕）。',
        timingRule: '应付单在**次日凌晨**按前一日实际交付量生成 —— 当日看不到单属正常，不是漏算。',
      },
    };
  }

  // =====================================================================
  // 内部：扫描 / 单价 / 装饰
  // =====================================================================

  /**
   * 扫描某出餐日的全部生产计划，分出「可出单」与「不能出单（附原因）」
   *
   * `generate()` 与 `exceptions()` 共用本方法 —— 两处若各写一遍判定，
   * 迟早出现「异常清单说不能出、出单接口却出了」这种自相矛盾。
   */
  private async scan(
    date: string,
    supplierId?: number,
  ): Promise<{ candidates: ShareCandidate[]; exceptions: ShareExceptionItem[] }> {
    const dailies = await this.dailyRepo.find({
      where: { produceDate: date, ...(supplierId ? { supplierId } : {}) },
      order: { id: 'ASC' },
    });
    if (!dailies.length) return { candidates: [], exceptions: [] };

    const supplierIds = [...new Set(dailies.map((d) => d.supplierId))];
    const dishIds = [...new Set(dailies.map((d) => d.dishId))];
    const [suppliers, dishes] = await Promise.all([
      this.supplierRepo.find({ where: { id: In(supplierIds) } }),
      this.dishRepo.find({ where: { id: In(dishIds) } }),
    ]);
    const supplierOf = new Map(suppliers.map((s) => [s.id, s]));
    const dishOf = new Map(dishes.map((d) => [d.id, d]));

    const candidates: ShareCandidate[] = [];
    const exceptions: ShareExceptionItem[] = [];

    for (const d of dailies) {
      const supplier = supplierOf.get(d.supplierId);
      const supplierName = supplier?.name ?? `供应商 ${d.supplierId}`;
      const dishName = dishOf.get(d.dishId)?.name ?? `菜品 ${d.dishId}`;
      const planQuantity = Number(d.planQuantity);

      const reject = (reason: ShareExceptionReason) => {
        exceptions.push({
          supplierId: d.supplierId,
          supplierName,
          dishId: d.dishId,
          dishName,
          planQuantity,
          dailyStatus: d.status,
          reason,
          reasonText: EXCEPTION_TEXT[reason],
        });
      };

      // ① 资质闸门优先（与 S2 的 50001 同判据、同顺序：先判「有没有资格」）
      if (!supplier || !this.canServe(supplier)) {
        reject('license_invalid');
        continue;
      }
      // ② 确认完整性（fail-closed · 见类注释第 1 条）
      if (d.status !== DAILY_DONE) {
        reject(d.status === DAILY_PENDING ? 'not_started' : 'incomplete');
        continue;
      }
      // ③ 实收量（口径 §4.1：申报优先，未申报视为足额）
      const qty = d.actualQuantity ?? null;
      if (qty === null) {
        reject('actual_missing');
        continue;
      }
      if (Number(qty) <= 0) {
        reject('zero_quantity');
        continue;
      }

      const unitPrice = this.unitPriceOf(d, dishOf.get(d.dishId));
      candidates.push({
        supplierId: d.supplierId,
        supplierName,
        dishId: d.dishId,
        dishName,
        planQuantity,
        quantity: Number(qty),
        unitPrice,
        amountYuan: round2(Number(qty) * Number(unitPrice)),
      });
    }

    return { candidates, exceptions };
  }

  /**
   * 采购单价（逐菜协商）
   *
   * ⭐ 取值优先级：`ab_supplier_dish_daily.unit_price`（**出餐计划生成时冻结的快照**）
   *    → `ab_dish.cost_price`（兜底）。
   *
   * 为什么不直接用 `ab_dish.cost_price`（口径文档 §4.1 表格的初版写法）：
   *   出餐计划一旦生成即**冻结**（M3-8 的核心纪律），计划里的 `unit_price` 就是当日
   *   对供应商的**承诺价**。若事后有人改了菜品采购价、出单时按新价算，就会出现
   *   「T 日按 ¥7.50 交货、结算时按 ¥8.00 付」—— 供应商对账时必然拒绝。
   *   **谁被冻结，就按谁结算。** 该修正已回报《自营结算口径定义 v1.0》§4.1。
   */
  private unitPriceOf(daily: SupplierDishDaily, dish?: Dish): string {
    const frozen = Number(daily.unitPrice ?? 0);
    if (frozen > 0) return daily.unitPrice;
    return dish?.costPrice ?? '0.00';
  }

  /** 行装饰：补齐供应商名 / 菜名 + 端上要的文案与按钮口径（避免前端 N+1） */
  private async decorate(rows: SupplierShare[]): Promise<Array<Record<string, unknown>>> {
    const supplierIds = [...new Set(rows.map((r) => r.payeeId))];
    const dishIds = [...new Set(rows.map((r) => r.dishId).filter((v): v is number => !!v))];
    const [suppliers, dishes] = await Promise.all([
      this.supplierRepo.find({ where: { id: In(supplierIds) } }),
      this.dishRepo.find({ where: { id: In(dishIds) } }),
    ]);
    const supplierOf = new Map(suppliers.map((s) => [s.id, s]));
    const dishOf = new Map(dishes.map((d) => [d.id, d]));

    return rows.map((r) => {
      const statusLabel = SHARE_STATUS_LABEL[r.status] ?? r.status;
      const payable = r.status === 'pending' && r.type === 'normal';
      return {
        id: r.id,
        shareNo: r.shareNo,
        shareDate: r.shareDate,
        mealDate: r.mealDate,
        payeeType: r.payeeType,
        supplierId: r.payeeId,
        supplierName: supplierOf.get(r.payeeId)?.name ?? `供应商 ${r.payeeId}`,
        dishId: r.dishId ?? null,
        dishName: r.dishId ? (dishOf.get(r.dishId)?.name ?? `菜品 ${r.dishId}`) : null,
        /** 实收量（采购计费基数） */
        quantity: Number(r.quantity),
        unitPriceFen: toFen(Number(r.unitPrice)),
        amountFen: toFen(Number(r.amount)),
        type: r.type,
        channel: r.channel,
        status: r.status,
        statusLabel,
        paymentVoucherNo: r.paymentVoucherNo ?? null,
        invoiceNo: r.invoiceNo ?? null,
        paidAt: toBjIso(r.paidAt),
        settledAt: toBjIso(r.settledAt),
        createdAt: toBjIso(r.createdAt),
        /** 按钮可用性口径唯一在服务端（与 D40 同一纪律） */
        canRegisterPayment: payable,
        blockReason: payable ? null : `当前状态为「${statusLabel}」，不能登记付款`,
      };
    });
  }

  // =====================================================================
  // 资质判据（与 `supplier.service.canServe` 同口径 · 各自实现避免跨模块依赖）
  // =====================================================================

  /** 合作中 ∧ 资质已通过 ∧ 证照未过期（与 D23 / S2 同一判据） */
  private canServe(s: Supplier): boolean {
    return (
      s.status === SupplierStatus.ACTIVE &&
      s.auditStatus === SupplierAuditStatus.APPROVED &&
      this.licenseStateOf(s.licenseExpireAt) !== LicenseState.EXPIRED
    );
  }

  private licenseStateOf(expire?: string | null): LicenseState {
    if (!expire) return LicenseState.UNKNOWN;
    const today = todayBj();
    if (expire < today) return LicenseState.EXPIRED;
    if (expire <= addDays(today, LICENSE_EXPIRING_DAYS)) return LicenseState.EXPIRING;
    return LicenseState.NORMAL;
  }
}

/** 应付对象类型 —— 自营口径下**只剩供应商**（《自营结算口径定义 v1.0》§3.2） */
const PAYEE_SUPPLIER = 'supplier';

/** `ab_supplier_dish_daily.status`（沿用 M3-8 三值，未扩枚举） */
const DAILY_PENDING = 'pending';
const DAILY_DONE = 'done';

/** 出单异常原因（`generate` 与 `GET exceptions` 共用同一份判定） */
export type ShareExceptionReason =
  'not_started' | 'incomplete' | 'actual_missing' | 'license_invalid' | 'zero_quantity';

const EXCEPTION_TEXT: Record<ShareExceptionReason, string> = {
  not_started: '出餐确认尚未开始（一次都没确认）—— 既无交付依据也无实收量，不出单',
  incomplete:
    '出餐确认未全部完成 —— 父行实收量只覆盖已确认的中心：按它出单会少付、按计划量补齐会多付，故不猜',
  actual_missing: '出餐确认已置完成但实收量为空（历史数据）—— 请先补确认，不要在缺数时出单',
  license_invalid:
    '供应商资质异常（未通过核验 / 合作已停用 / 证照过期）—— 资质未核验期间的供货不进结算',
  zero_quantity: '实收量为 0 —— 没有采购事实，不出单',
};

/** 出单候选（内部结构，不直接出参） */
interface ShareCandidate {
  supplierId: number;
  supplierName: string;
  dishId: number;
  dishName: string;
  planQuantity: number;
  /** 实收量（= 计费基数） */
  quantity: number;
  unitPrice: string;
  amountYuan: number;
}

/** 未出单项（出参用） */
interface ShareExceptionItem {
  supplierId: number;
  supplierName: string;
  dishId: number;
  dishName: string;
  planQuantity: number;
  dailyStatus: string;
  reason: ShareExceptionReason;
  reasonText: string;
}

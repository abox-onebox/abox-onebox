import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { money, round2, toFen } from '../../common/utils/money';
import { Balance, BalanceLog, Commission } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { Order, Refund } from '../../database/entities/order.entity';

/**
 * 反向结算服务（C6 第三段 · **自营口径 2026-09-16 修订**）
 *
 * 落点：`modules/finance/reversal.service`（《开发里程碑计划 v1.0》3.4）
 *
 * ## 为什么单独成服务
 * 「退款」这件事有两个完全不同的部分：
 *   ① **钱怎么退出去** —— 微信原路退（`WxPayProvider.refund`），属支付通道；
 *   ② **账怎么改回来** —— 佣金要冲销、余额抵扣要退回，属账务。
 * 二者失败模式不同（② 不能因为 ① 的通道抖动就整段回滚），调用点却相同
 * （D11 后台强制退款、D41 退款审批通过）。故拆开：通道在 `RefundService`，
 * 账务在本服务。
 *
 * ## 三条不可违背的口径
 * 1. **原记录一律不得改写**（C9）：佣金冲销写新行 `type='reversal'`（金额取负），
 *    不把原 `normal` 行的金额改成 0 —— 否则佣金明细的「发生额」就永久失真了。
 *    唯一的字段改写是原行 `status → cancelled`，表示「该笔已被冲销」。
 * 2. **平台毛利留存**：毛利是**结果值**（售价 − 成本 − 佣金），退款只回退
 *    佣金与用户余额，从不「退毛利」—— 因为它从来没有被单独记过账。
 * 3. ⭐ **供应商采购应付不参与退款**（自营口径裁定 1，取代旧第 3 条）：
 *    路线裁定为「单主体自营 + 半成品供应链」后，应付基数是**实收量**
 *    （供应商实际交付的半成品），**与用户是否卖出无关**。半成品在**出餐日当日
 *    已交付并投入使用**，退款发生在交付之后 → **钱照付**，退款属 ABox 自身
 *    经营风险（极端情形下该单毛利为负，属正常经营承担，不是系统缺陷）。
 *    `ab_supplier_share` 的 `type='reversal'` 保留但**改义**为「应付单生成后
 *    发现算错」的**纠错冲销**（运营主动动作），不再由退款触发。
 *
 * ## 修订留痕（2026-09-16 · M3-9 开工前置）
 * 本服务原 `reverseSupplierShares()` 的旧前提「应付按 **有效订单** 汇总」是**分账**
 * 语境，自营下不成立，已整段移除。对账口径见《ABox一盒自营结算口径定义v1.0.md》
 * §5.1 / §5.3；被移除的三态（`not_generated` / `reduced` / `offset`）不再产生。
 */
@Injectable()
export class ReversalService {
  private readonly logger = new Logger('ReversalService');

  /**
   * 退款落地后的全部账务影响（幂等）
   *
   * 调用前提：调用方已把订单置为终态或正在置终态，且**在同一个事务里**调用。
   * 事务边界刻意留在调用方 —— 退款单状态推进、订单状态推进、账务冲销三者
   * 必须同生共死，否则会出现「订单已退款但佣金没冲」这种查不出来的账。
   */
  async applyRefundEffects(
    m: EntityManager,
    order: Order,
    refund: Refund,
  ): Promise<ReversalResult> {
    const notes: string[] = [];

    // ① 余额抵扣部分退回可用余额（微信实付部分由通道原路退，不在此处）
    const balanceRefundedFen = await this.refundBalancePart(m, order, refund.refundNo);

    // ② 佣金反向冲销（写 reversal 负行 + 扣减团长余额）
    const commission = await this.reverseCommission(m, order, refund, notes);

    // ③ 供应商采购应付：**不冲减**（自营口径裁定 1）
    //    这条说明刻意进 notes 而不是静默 —— 「退款后应付分文未动」是**反直觉**的，
    //    操作员看到应付数字没变，必须能立刻分辨这是设计而非漏算。
    notes.push(SUPPLIER_SHARE_NOT_APPLICABLE_NOTE);

    this.logger.log(
      `反向结算完成 refundNo=${refund.refundNo} orderNo=${order.orderNo} ` +
        `佣金冲销=${commission.reversedFen}分 余额退回=${balanceRefundedFen}分 ` +
        `供应商应付=不冲减（自营口径）`,
    );

    return {
      balanceRefundedFen,
      commissionReversedFen: commission.reversedFen,
      commissionReversedQuantity: commission.quantity,
      supplierShareAdjusted: 0,
      supplierShareMode: 'not_applicable',
      notes,
    };
  }

  // ==========================================================================
  // ① 余额退回
  // ==========================================================================

  /**
   * 退回「下单时用余额抵扣」的那部分（T4）
   *
   * ⚠️ 这段钱**从不进微信退款通道** —— 它当初就没走微信收，原路退回余额才对得上账。
   *    与 `OrderService.refundBalance` 同口径（截单前自助取消走那条，
   *    截单后退款走这条），两处都写 `ab_balance_log(type='refund', direction=1)`。
   */
  private async refundBalancePart(
    m: EntityManager,
    order: Order,
    refundNo: string,
  ): Promise<number> {
    const amountFen = toFen(Number(order.balanceUsed));
    if (amountFen <= 0) return 0;

    const account = await m.findOne(Balance, { where: { userId: Number(order.userId) } });
    if (!account) {
      this.logger.warn(`订单 ${order.orderNo} 有余额抵扣 ¥${order.balanceUsed} 但无余额账户，跳过`);
      return 0;
    }

    const balance = round2(Number(account.balance) + amountFen / 100);
    await m
      .createQueryBuilder()
      .update(Balance)
      .set({ balance: money(balance), version: () => 'version + 1' })
      .where('id = :id', { id: account.id })
      .execute();

    await m.save(
      m.create(BalanceLog, {
        userId: Number(order.userId),
        type: 'refund',
        direction: 1,
        amount: money(amountFen / 100),
        balanceAfter: money(balance),
        relatedId: refundNo,
        remark: `退款退回（原余额抵扣部分 · ${order.orderNo}）`,
      }),
    );
    return amountFen;
  }

  // ==========================================================================
  // ② 佣金反冲
  // ==========================================================================

  /**
   * 佣金反向冲销
   *
   * 三种「无需冲销」的情形，各自有明确原因（都不算错误）：
   *   · 该单**从未计佣**（截单前取消 / 未走到 `completed`）→ 无原行
   *   · 已有冲销行（重复退款 / 重放）→ `uk_commission_order_type` 唯一索引兜底
   *   · 找不到团长（数据异常）→ 仍写冲销行，但不动余额，`notes` 里留痕
   *
   * ⚠️ 余额允许被扣成负数：团长可能已经把佣金提现走了。这不是 bug ——
   *    真实业务里就是要形成「欠款」由其后续佣金抵扣，硬拦会把退款卡死。
   */
  private async reverseCommission(
    m: EntityManager,
    order: Order,
    refund: Refund,
    notes: string[],
  ): Promise<{ reversedFen: number; quantity: number }> {
    const orderId = Number(order.id);

    const origin = await m.findOne(Commission, { where: { orderId, type: 'normal' } });
    if (!origin) {
      notes.push('该单未计佣（未走到 completed 或截单前已取消），无佣金需冲销');
      return { reversedFen: 0, quantity: 0 };
    }
    const existed = await m.findOne(Commission, { where: { orderId, type: 'reversal' } });
    if (existed) {
      notes.push(`佣金冲销已存在（${existed.id}），跳过`);
      return { reversedFen: 0, quantity: 0 };
    }

    const amountYuan = -Math.abs(Number(origin.amount));
    const quantity = -Math.abs(Number(origin.quantity));

    await m.save(
      m.create(Commission, {
        orderId,
        orderNo: order.orderNo,
        teamLeaderId: Number(origin.teamLeaderId),
        leaderLevel: origin.leaderLevel,
        rate: origin.rate,
        baseAmount: origin.baseAmount,
        quantity,
        amount: money(amountYuan),
        type: 'reversal',
        status: 'settled',
        settledAt: new Date(),
        mealDate: origin.mealDate,
        payoutChannel: origin.payoutChannel,
        taxWithheldAmount: '0.00',
      }),
    );

    // 原行标记「已冲销」—— 金额保持原值，发生额历史不可改写（C9）
    origin.status = 'cancelled';
    await m.save(origin);

    const leader = await m.findOne(TeamLeader, { where: { id: Number(origin.teamLeaderId) } });
    if (!leader) {
      notes.push(`佣金冲销已记账，但团长 #${origin.teamLeaderId} 不存在，余额未扣减`);
      return { reversedFen: toFen(Math.abs(amountYuan)), quantity };
    }

    const userId = Number(leader.userId);
    const account = await m.findOne(Balance, { where: { userId } });
    if (!account) {
      notes.push('团长无余额账户，冲销仅记账');
      return { reversedFen: toFen(Math.abs(amountYuan)), quantity };
    }

    const balance = round2(Number(account.balance) + amountYuan);
    await m
      .createQueryBuilder()
      .update(Balance)
      .set({ balance: money(balance), version: () => 'version + 1' })
      .where('id = :id', { id: account.id })
      .execute();

    await m.save(
      m.create(BalanceLog, {
        userId,
        type: 'refund',
        direction: -1,
        amount: money(Math.abs(amountYuan)),
        balanceAfter: money(balance),
        relatedId: refund.refundNo,
        remark: `退款佣金冲销（${order.orderNo}）`,
        payoutChannel: origin.payoutChannel,
        taxWithheldAmount: '0.00',
      }),
    );

    if (balance < 0) {
      notes.push(`团长余额被扣为负（${money(balance)} 元）—— 佣金已提现，形成欠款由后续佣金抵扣`);
    }
    // ⚠️ 出参符号口径：**金额恒正、份数为负**（与 `ReversalResult` 契约一致）。
    //    记账行本身是负的（`amount: -Math.abs(...)`），但出参不给前端负号 ——
    //    「冲销了多少钱」是个正数事实，端上按 `−${commissionReversedFen}` 展示即可；
    //    否则每个消费点都要自己 `Math.abs`，迟早漏一个、把负数当正数求和。
    return { reversedFen: toFen(Math.abs(amountYuan)), quantity };
  }
}

/** 「退款不动供应商应付」的固定说明（进 `ReversalResult.notes`，供端上原样展示） */
export const SUPPLIER_SHARE_NOT_APPLICABLE_NOTE =
  '自营口径（2026-09-16 裁定）：采购应付按**实收量**出单，与用户退款无关 —— 半成品在出餐日已交付，本次退款**不冲减**供应商应付';

/**
 * 退款对「供应商应付」的影响方式
 *
 * 自营口径下只有一个取值：**不适用**。保留该字段（而非从契约里删掉）的原因是
 * 它是一条**可断言的事实**：退款接口的出参里显式写着「应付分文未动」，
 * 比「契约里没有这个字段」更能防止将来有人把冲减逻辑悄悄加回来。
 */
export type SupplierShareAdjustMode = 'not_applicable';

/** 一次退款带来的账务变化汇总（写进 D11/D41 的响应与操作日志） */
export interface ReversalResult {
  /** 退回用户余额的金额（分） */
  balanceRefundedFen: number;
  /** 佣金冲销金额（分，正数表示冲掉的金额） */
  commissionReversedFen: number;
  /** 佣金冲销份数（负数） */
  commissionReversedQuantity: number;
  /** 被调整的应付行数 —— 自营口径下**恒为 0**（退款不冲减采购应付） */
  supplierShareAdjusted: number;
  /** 应付调整方式 —— 自营口径下**恒为 `not_applicable`** */
  supplierShareMode: SupplierShareAdjustMode;
  /** 需要人工留意的说明（余额扣成负数、应付不冲减的固定说明等） */
  notes: string[];
}

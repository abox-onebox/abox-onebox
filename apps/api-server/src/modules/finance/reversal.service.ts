import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, In, Not } from 'typeorm';

import { SupplierShareStatus } from '@abox/shared-types';

import { money, round2, toFen } from '../../common/utils/money';
import { todayBj } from '../../common/utils/time';
import {
  Balance,
  BalanceLog,
  Commission,
  SupplierShare,
} from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { SetMealItem } from '../../database/entities/meal.entity';
import { Order, Refund } from '../../database/entities/order.entity';

/**
 * 反向结算服务（C9 / C6 第三段）
 *
 * 落点：`modules/finance/reversal.service`（《开发里程碑计划 v1.0》3.4）
 *
 * ## 为什么单独成服务
 * 「退款」这件事有两个完全不同的部分：
 *   ① **钱怎么退出去** —— 微信原路退（`WxPayProvider.refund`），属支付通道；
 *   ② **账怎么改回来** —— 佣金要冲销、供应商应付要冲减、余额抵扣要退回，属账务。
 * 二者失败模式不同（② 不能因为 ① 的通道抖动就整段回滚），调用点却相同
 * （D11 后台强制退款、D41 退款审批通过）。故拆开：通道在 `RefundService`，
 * 账务在本服务。
 *
 * ## 三条不可违背的口径
 * 1. **原记录一律不得改写**（C9）：佣金冲销写新行 `type='reversal'`（金额取负），
 *    不把原 `normal` 行的金额改成 0 —— 否则佣金明细的「发生额」就永久失真了。
 *    唯一的字段改写是原行 `status → cancelled`，表示「该笔已被冲销」。
 * 2. **平台毛利留存**：毛利是**结果值**（售价 − 成本 − 佣金），退款只回退
 *    成本与佣金，从不「退毛利」—— 因为它从来没有被单独记过账。
 * 3. **应付未生成的场景不是异常**：T+1 02:00 才跑应付（§3.9），而退款多发生在
 *    T 日当天。此时无应付可冲，返回 `not_generated` 即可 —— 后续跑批按
 *    「有效订单」口径汇总，已退款单自然不在其中。**不要造一条空冲销行**。
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

    // ③ 供应商 / 集散应付冲减
    const share = await this.reverseSupplierShares(m, order, refund, notes);

    this.logger.log(
      `反向结算完成 refundNo=${refund.refundNo} orderNo=${order.orderNo} ` +
        `佣金冲销=${commission.reversedFen}分 余额退回=${balanceRefundedFen}分 ` +
        `应付调整=${share.count}行(${share.mode})`,
    );

    return {
      balanceRefundedFen,
      commissionReversedFen: commission.reversedFen,
      commissionReversedQuantity: commission.quantity,
      supplierShareAdjusted: share.count,
      supplierShareMode: share.mode,
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

  // ==========================================================================
  // ③ 供应商 / 集散应付冲减
  // ==========================================================================

  /**
   * 供应商应付冲减（C9「原记录不得改写」+「已付款走反向流水」）
   *
   * 匹配粒度：**出餐日 × 菜品**。`ab_supplier_share` 不按订单拆行
   * （一个出餐日一道菜一条汇总行），故退款时按「该订单份数 × 该菜结算单价」
   * 从对应行里扣减份数与金额 —— 这是我们能还原出的最细粒度。
   *
   * 三种结果：
   *   · `not_generated` —— 应付尚未生成（T+1 02:00 才跑批，退款多发生在 T 日）。
   *                        后续跑批按「有效订单」汇总，已退款单自然不在其中，
   *                        **因此无需补冲销行**。
   *   · `reduced`       —— 命中未付款行，直接扣减（扣到 0 则置 `reversed`）。
   *   · `offset`        —— 命中已付款行（`success`），写反向流水挂到**下期**抵扣，
   *                        原行不动（钱已经转出去了，改写它等于篡改已发生的付款）。
   */
  private async reverseSupplierShares(
    m: EntityManager,
    order: Order,
    refund: Refund,
    notes: string[],
  ): Promise<{ count: number; mode: 'not_generated' | 'reduced' | 'offset' }> {
    const items = await m.find(SetMealItem, { where: { setMealId: Number(order.setMealId) } });
    const dishIds = items.map((i) => Number(i.dishId));
    if (!dishIds.length) {
      notes.push('套餐无菜品明细，无法定位应付行');
      return { count: 0, mode: 'not_generated' };
    }

    const shares = await m.find(SupplierShare, {
      where: {
        mealDate: order.mealDate,
        dishId: In(dishIds),
        type: 'normal',
        status: Not(SupplierShareStatus.REVERSED),
      },
    });
    if (!shares.length) {
      notes.push(
        `出餐日 ${order.mealDate} 尚未生成供应商应付（T+1 02:00 跑批），` +
          '跑批按有效订单口径汇总，已退款单自然排除',
      );
      return { count: 0, mode: 'not_generated' };
    }

    const perDishQty = new Map<number, number>();
    for (const it of items) {
      // 同一道菜只应出现一次（D7 已拦），出现两次也只按一次计
      perDishQty.set(Number(it.dishId), Number(order.quantity));
    }

    let mode: 'reduced' | 'offset' = 'reduced';
    let count = 0;

    for (const row of shares) {
      const qty = perDishQty.get(Number(row.dishId)) ?? 0;
      if (qty <= 0) continue;
      const cutYuan = round2(qty * Number(row.unitPrice));
      if (cutYuan <= 0) continue;

      if (row.status === SupplierShareStatus.SUCCESS) {
        // 已付款：写反向流水挂下期抵扣，原行不动（C9）
        mode = 'offset';
        await m.save(
          m.create(SupplierShare, {
            shareNo: `RV${refund.refundNo.slice(-12)}${String(count).padStart(2, '0')}`,
            shareDate: todayBj(), // 冲减登记日 → 下期结算抵扣
            mealDate: order.mealDate,
            payeeType: row.payeeType,
            payeeId: Number(row.payeeId),
            dishId: Number(row.dishId),
            quantity: -qty,
            unitPrice: row.unitPrice,
            amount: money(-cutYuan),
            type: 'reversal',
            channel: row.channel,
            status: SupplierShareStatus.PENDING,
            originId: Number(row.id),
            failReason: `订单 ${order.orderNo} 退款冲减（原应付已付款）`,
          }),
        );
        count += 1;
        continue;
      }

      // 未付款：直接扣减（份数与金额同步扣，扣空则置 reversed）
      const leftQty = Number(row.quantity) - qty;
      const leftYuan = round2(Number(row.amount) - cutYuan);
      row.quantity = Math.max(0, leftQty);
      row.amount = money(Math.max(0, leftYuan));
      if (leftQty <= 0) {
        row.status = SupplierShareStatus.REVERSED;
        row.failReason = `订单 ${order.orderNo} 退款冲减后无余额`;
      }
      await m.save(row);
      count += 1;
    }

    if (count === 0) {
      notes.push('应付行存在但无匹配菜品，未做冲减');
      return { count: 0, mode: 'not_generated' };
    }
    return { count, mode };
  }
}

/** 一次退款带来的账务变化汇总（写进 D11/D41 的响应与操作日志） */
export interface ReversalResult {
  /** 退回用户余额的金额（分） */
  balanceRefundedFen: number;
  /** 佣金冲销金额（分，正数表示冲掉的金额） */
  commissionReversedFen: number;
  /** 佣金冲销份数（负数） */
  commissionReversedQuantity: number;
  /** 被调整的应付行数 */
  supplierShareAdjusted: number;
  /** 应付处理方式（见方法注释） */
  supplierShareMode: 'not_generated' | 'reduced' | 'offset';
  /** 需要人工留意的说明（余额扣成负数、应付未生成等） */
  notes: string[];
}

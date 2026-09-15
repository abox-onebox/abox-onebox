import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';

import { OrderStatus, RefundApplySource, RefundReasonType, RefundStatus } from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { money, round2, toFen } from '../../common/utils/money';
import { genRefundNo } from '../../common/utils/order-no';
import { TeamLeader } from '../../database/entities/leader.entity';
import { Order, Refund } from '../../database/entities/order.entity';
import { WX_PAY_PROVIDER, WxPayProvider } from '../../providers/wx-pay/wx-pay.provider';
import { RefundApplyReqDto } from './dto/finance.dto';
import { ReversalResult, ReversalService } from './reversal.service';

/**
 * 退款服务（C6 三段式）
 *
 * 落点：`modules/finance/refund.service`
 *
 * ```
 * ① 申请  团长代退申请（M2 · applyByLeader）  → ab_refund.status='applying' + 订单转 refund_applying
 *                                             ⚠️ 资金零变动（不动订单金额、不发起退款、不回退分账）
 * ② 审批  后台 D41 通过 / D42 驳回            → approved / rejected（属 M3-4 批次）
 * ③ 实退  执行退款（本文件的 executeRefund）  → 微信原路退 + 反向结算 + 状态收口
 * ```
 *
 * 本文件已实现：
 *   · `applyByLeader`（① 第一段 · M2）
 *   · `forceRefund`（③ · D11 后台强制退款，跳过申请与审批，客诉兜底通道）
 *   · `executeRefund`（③ 的**唯一执行口**，M3-4 的 D41 审批通过后也走它）
 *
 * ⚠️ **C6 口径**：截单后用户不可自助退款（U11 返回 40004），常规入口是团长代退；
 *    `forceRefund` 是**例外通道**，必须填原因并全程写 `ab_operation_log`。
 */

/** 可发起代退 / 强制退款的订单状态（已支付之后、未进入退款流程） */
const REFUNDABLE_STATUS: string[] = [
  OrderStatus.PAID,
  OrderStatus.CUT_OFF,
  OrderStatus.COOKED,
  OrderStatus.DELIVERING,
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
];

/** 已在退款流程中的状态 —— 重复申请返回 40008 */
const IN_REFUND_STATUS: string[] = [
  OrderStatus.REFUND_APPLYING,
  OrderStatus.REFUNDING,
  OrderStatus.REFUNDED,
];

/** 「未终结」的退款单状态（幂等闸门） */
const ACTIVE_REFUND_STATUS: RefundStatus[] = [
  RefundStatus.APPLYING,
  RefundStatus.APPROVED,
  RefundStatus.REFUNDING,
];

/** D11 强制退款入参（由 `order-admin.dto` 校验后透传，避免 finance 反向依赖 order 模块） */
export interface ForceRefundInput {
  reason: string;
  reasonType?: string;
  /** 可选：显式指定退款金额（分）。仅作**防误操作**校验 —— 与可退金额不符即 40011 */
  amountFen?: number;
}

@Injectable()
export class RefundService {
  private readonly logger = new Logger('RefundService');

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(Refund) private readonly refundRepo: Repository<Refund>,
    private readonly reversal: ReversalService,
    @Inject(WX_PAY_PROVIDER) private readonly wxPay: WxPayProvider,
  ) {}

  // ==========================================================================
  // ① 团长代退申请（C6 第一段 · M2 · L7）
  // ==========================================================================

  /**
   * L7 · 团长代退申请（C6 第一段）
   *
   * 校验顺序（每条都有独立错误码，便于端上分支）：
   *   1. 订单存在                     → 30010
   *   2. 订单属于本团长所辖楼栋        → 10003（跨楼越权防护）
   *   3. 状态已在退款流程中            → 40008（重复申请）
   *   4. 状态不允许退款（待支付/已取消）→ 30003
   *   5. 同订单已有未终结申请          → 40008
   *
   * 事务内：写 ab_refund + 订单状态条件更新（乐观锁防并发重复申请）。
   */
  async applyByLeader(leader: TeamLeader, orderNo: string, dto: RefundApplyReqDto) {
    const order = await this.orderRepo.findOne({ where: { orderNo } });
    if (!order) throw new BizException(ErrorCode.ORDER_NOT_FOUND);

    // 2) 越权防护：只能对「本楼」订单发起代退
    //    （订单已绑团长则须为本人；未绑团长的历史单按楼栋放行）
    const belongsToLeader =
      order.teamLeaderId != null
        ? Number(order.teamLeaderId) === Number(leader.id)
        : Number(order.buildingId) === Number(leader.buildingId);
    if (!belongsToLeader) {
      throw new BizException(ErrorCode.FORBIDDEN, '只能对本楼订单发起代退申请');
    }

    // 3) 已在退款流程
    if (IN_REFUND_STATUS.includes(order.status)) {
      throw new BizException(
        ErrorCode.REFUND_DUPLICATED,
        order.status === OrderStatus.REFUNDED ? '订单已退款，无需重复申请' : '退款申请已存在',
      );
    }

    // 4) 状态不允许
    if (!REFUNDABLE_STATUS.includes(order.status)) {
      throw new BizException(
        ErrorCode.ORDER_STATUS_ILLEGAL,
        order.status === OrderStatus.PENDING_PAY
          ? '订单未支付，无需申请退款'
          : '订单已取消，无法申请退款',
      );
    }

    // 5) 同订单是否已有未终结的申请（防历史脏数据绕过状态位）
    const pending = await this.refundRepo.findOne({
      where: { orderId: Number(order.id), status: In(ACTIVE_REFUND_STATUS) },
    });
    if (pending) throw new BizException(ErrorCode.REFUND_DUPLICATED);

    // 退款金额 = 用户实付总额 = 订单总额 − 优惠（= 微信实付 + 余额抵扣）
    // ⚠️ 修正（M3-3）：此前取 `order.payAmount`（仅微信实付），余额抵扣部分被漏记，
    //    导致「退款单金额 < 用户实际付出去的钱」，与执行侧的退回总额对不上账。
    const amount = refundableYuan(order);
    const reasonText = [dto.reason?.trim(), dto.remark?.trim()].filter(Boolean).join(' | ');

    const result = await this.dataSource.transaction(async (m) => {
      const refund = m.create(Refund, {
        refundNo: genRefundNo(),
        orderId: Number(order.id),
        orderNo: order.orderNo,
        userId: Number(order.userId),
        teamLeaderId: Number(leader.id),
        applySource: RefundApplySource.LEADER, // C6 第一段：团长代退
        amount: money(amount),
        reasonType: dto.reasonType,
        reason: reasonText ? reasonText.slice(0, 256) : null,
        status: RefundStatus.APPLYING, // 只登记，不退款
        auditorId: null,
        auditAt: null,
        reversed: 0,
      });
      const saved = await m.save(refund);

      // 乐观锁：仅当状态仍为申请时的状态才推进，防并发重复
      const upd = await m
        .createQueryBuilder()
        .update(Order)
        .set({ status: OrderStatus.REFUND_APPLYING })
        .where('id = :id AND status = :from', { id: order.id, from: order.status })
        .execute();
      if (!upd.affected) {
        throw new BizException(ErrorCode.REFUND_DUPLICATED, '订单状态已变更，请刷新后重试');
      }

      return saved;
    });

    this.logger.log(
      `代退申请：团长#${leader.id} 订单 ${orderNo} 退款单 ${result.refundNo} 金额 ¥${money(amount)}（资金未动）`,
    );

    return {
      refundNo: result.refundNo,
      orderNo: order.orderNo,
      status: RefundStatus.APPLYING,
      statusText: '退款申请中',
      amountFen: toFen(amount),
      reasonType: dto.reasonType,
      /** 明确回执：本步资金零变动 */
      fundsMoved: false,
      tips: '申请已提交，运营审批通过后退款原路返回（1–3 个工作日）',
    };
  }

  // ==========================================================================
  // ③ 后台强制退款（D11 · C6 第三段 · 客诉兜底通道）
  // ==========================================================================

  /**
   * D11 · 后台强制退款
   *
   * 与 D41「审批团长代退」的区别：
   *   · D41 处理的是一张**已存在**的 `applying` 退款单（走完了 C6 第一段）；
   *   · D11 是**跳过申请与审批**直接退款 —— 现场客诉、餐品严重问题、团长失联时用。
   *
   * 因此这里**刻意不做**「已有申请就走审批」的隐式分流：订单一旦处于
   * `refund_applying`，说明团长已提交申请，正确动作是去审批（D41），
   * 而不是让运营在两个入口之间猜。此时返回 40008 并在 message 里讲清楚。
   *
   * `amountFen` 是**防误操作参数**而非部分退款：后台强制退款一期只支持全额，
   * 传了就必须与可退金额一致，否则 40011。前端把可退金额显示在二次确认弹窗里，
   * 运营照着填 —— 这一填，就排除了「看错订单」这类错误。
   */
  async forceRefund(
    orderNo: string,
    input: ForceRefundInput,
    operatorId: number,
  ): Promise<{
    refundNo: string;
    orderNo: string;
    status: RefundStatus;
    refundedFen: number;
    wxRefundedFen: number;
    balanceRefundedFen: number;
    reversal: ReversalResult;
    tips: string;
  }> {
    const order = await this.orderRepo.findOne({ where: { orderNo } });
    if (!order) throw new BizException(ErrorCode.ORDER_NOT_FOUND);

    if (order.status === OrderStatus.REFUND_APPLYING) {
      throw new BizException(
        ErrorCode.REFUND_DUPLICATED,
        '该订单已有团长代退申请，请走「退款审批」处理',
      );
    }
    if (IN_REFUND_STATUS.includes(order.status)) {
      throw new BizException(
        ErrorCode.REFUND_DUPLICATED,
        order.status === OrderStatus.REFUNDED ? '订单已退款，无需重复操作' : '订单退款处理中',
      );
    }
    if (!REFUNDABLE_STATUS.includes(order.status)) {
      throw new BizException(
        ErrorCode.ORDER_STATUS_ILLEGAL,
        order.status === OrderStatus.PENDING_PAY ? '订单未支付，无需退款' : '订单已取消，无法退款',
      );
    }

    const pending = await this.refundRepo.findOne({
      where: { orderId: Number(order.id), status: In(ACTIVE_REFUND_STATUS) },
    });
    if (pending) throw new BizException(ErrorCode.REFUND_DUPLICATED);

    const refundableFen = toFen(refundableYuan(order));
    if (input.amountFen !== undefined && input.amountFen !== refundableFen) {
      throw new BizException(
        ErrorCode.REFUND_AMOUNT_MISMATCH,
        `可退金额为 ¥${money(refundableFen / 100)}，与提交的金额不一致`,
      );
    }

    const result = await this.dataSource.transaction(async (m) => {
      const refund = await m.save(
        m.create(Refund, {
          refundNo: genRefundNo(),
          orderId: Number(order.id),
          orderNo: order.orderNo,
          userId: Number(order.userId),
          teamLeaderId: order.teamLeaderId ?? null,
          applySource: RefundApplySource.ADMIN, // 后台强制
          amount: money(refundableFen / 100),
          reasonType: input.reasonType ?? RefundReasonType.OTHER,
          reason: input.reason.slice(0, 256),
          status: RefundStatus.REFUNDING,
          auditorId: operatorId, // 强制退款即为「自己批准」
          auditAt: new Date(),
          auditRemark: `后台强制退款：${input.reason}`.slice(0, 256),
          reversed: 0,
        }),
      );
      return this.executeRefund(m, order, refund);
    });

    this.logger.warn(
      `后台强制退款：操作人#${operatorId} 订单 ${orderNo} 退款单 ${result.refund.refundNo} ` +
        `合计 ¥${money(refundableFen / 100)}（微信 ¥${money(result.wxFen / 100)} + 余额 ¥${money(result.balanceFen / 100)}）` +
        ` 佣金冲销 ¥${money(result.reversal.commissionReversedFen / 100)}`,
    );

    return {
      refundNo: result.refund.refundNo,
      orderNo: order.orderNo,
      status: RefundStatus.REFUNDED,
      refundedFen: refundableFen,
      wxRefundedFen: result.wxFen,
      balanceRefundedFen: result.balanceFen,
      reversal: result.reversal,
      tips: '退款已发起，微信原路退回 1–3 个工作日到账；余额抵扣部分已即时退回余额',
    };
  }

  // ==========================================================================
  // ③ 执行口（被 D11 与后续 D41 共用）
  // ==========================================================================

  /**
   * 实际退款（C6 第三段）—— **必须在事务内调用**
   *
   * 顺序刻意如此：
   *   1. 先调微信退款（外部副作用，不可回滚）—— 失败即抛 `40010` 让整个事务回滚，
   *      此时 `ab_refund` 随事务消失，不会留下「有退款单但没退款」的哑单
   *   2. 再走账务冲销（佣金 / 应付 / 余额）—— 与订单状态在同一事务，账单一致
   *   3. 最后收口状态（退款单 → `refunded`、订单 → `refunded`）
   *
   * ⚠️ 退款金额拆两路：**微信实付**走通道原路退，**余额抵扣**直接退回余额
   *    （它当初就没走微信，喂给通道会被微信拒；喂进去了则是重复出款）。
   */
  private async executeRefund(
    m: EntityManager,
    order: Order,
    refund: Refund,
  ): Promise<{ refund: Refund; wxFen: number; balanceFen: number; reversal: ReversalResult }> {
    const now = new Date();
    const wxFen = toFen(Number(order.payAmount));
    const balanceFen = toFen(Number(order.balanceUsed));

    let wxRefundNo: string | null = null;
    if (wxFen > 0) {
      const r = await this.wxPay.refund({
        orderNo: order.orderNo,
        refundNo: refund.refundNo,
        refundFen: wxFen,
        totalFen: toFen(Number(order.totalAmount)),
        reason: refund.reason ?? '后台退款',
      });
      if (r.status !== 'SUCCESS' && r.status !== 'PROCESSING') {
        throw new BizException(
          ErrorCode.REFUND_FAILED,
          `微信退款未受理（状态 ${r.status}），订单未变更，可稍后重试`,
        );
      }
      wxRefundNo = r.refundId;
    }

    // 账务冲销（余额退回 / 佣金反冲 / 应付冲减）
    const reversal = await this.reversal.applyRefundEffects(m, order, refund);

    refund.status = RefundStatus.REFUNDED;
    refund.wxRefundNo = wxRefundNo;
    refund.refundedAt = now;
    refund.auditorId = refund.auditorId ?? null;
    refund.auditAt = refund.auditAt ?? now;
    refund.reversed = 1;
    refund.reversedAt = now;
    refund.version = (refund.version ?? 0) + 1;
    const saved = await m.save(refund);

    // 订单收口到 refunded。`cancelled_at` 按《状态机》既有约定近似承载退款时刻
    // （时间线异常区节点取它作为「发生时间」，无独立 refunded_at 列）。
    await m
      .createQueryBuilder()
      .update(Order)
      .set({
        status: OrderStatus.REFUNDED,
        cancelledAt: now,
        version: (order.version ?? 0) + 1,
      })
      .where('id = :id', { id: order.id })
      .execute();

    return { refund: saved, wxFen, balanceFen, reversal };
  }

  /** 订单是否存在未终结的退款申请（供订单视图标注） */
  async findActiveByOrderId(orderId: number): Promise<Refund | null> {
    return this.refundRepo.findOne({
      where: { orderId: Number(orderId), status: In(ACTIVE_REFUND_STATUS) },
    });
  }
}

/**
 * 可退金额（元）= 订单总额 − 优惠
 *
 * 即**用户实际付出去的钱**：微信实付（`pay_amount`）+ 余额抵扣（`balance_used`）。
 * `discountAmount` 为营销优惠位（一期恒 0），退回时不再区分来源，
 * 因为「优惠是平台让的利」—— 用户没为它付过钱。
 */
export function refundableYuan(order: Order): number {
  return round2(Number(order.totalAmount) - Number(order.discountAmount));
}

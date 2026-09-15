import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { OrderStatus, RefundApplySource, RefundStatus } from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { genRefundNo } from '../../common/utils/order-no';
import { TeamLeader } from '../../database/entities/leader.entity';
import { Order, Refund } from '../../database/entities/order.entity';
import { RefundApplyReqDto } from './dto/finance.dto';

/**
 * 退款服务（C6 三段式）
 *
 * 落点：`modules/finance/refund`（《开发里程碑计划 v1.0》2.4）
 *
 * **本服务在 M2 只做第一段 —— 团长代退申请**：
 *   ```
 *   ① 申请（本文件 applyByLeader）  → ab_refund.status='applying' + 订单转 refund_applying
 *                                     ⚠️ 资金零变动（不动订单金额、不发起退款、不回退分账）
 *   ② 审批（M3 · 后台 D46）         → 通过 → approved → 调微信退款
 *   ③ 实退（M3 · 后台 D46/D47）     → refunded + 反向结算（reversal.service）
 *   ```
 *
 * ⚠️ C6 口径：**截单后用户不可自助退款**（U11 返回 40004），唯一入口就是团长代退申请。
 */

/** 可发起代退的订单状态（已支付之后、未进入退款流程） */
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

@Injectable()
export class RefundService {
  private readonly logger = new Logger('RefundService');

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(Refund) private readonly refundRepo: Repository<Refund>,
  ) {}

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
      where: {
        orderId: Number(order.id),
        status: In([RefundStatus.APPLYING, RefundStatus.APPROVED, RefundStatus.REFUNDING]),
      },
    });
    if (pending) throw new BizException(ErrorCode.REFUND_DUPLICATED);

    // 退款金额 = 该笔订单用户实付（余额抵扣部分由实退环节原路退回余额，见 T4）
    const amount = Number(order.payAmount);
    const reasonText = [dto.reason?.trim(), dto.remark?.trim()].filter(Boolean).join(' | ');

    const result = await this.dataSource.transaction(async (m) => {
      const refund = m.create(Refund, {
        refundNo: genRefundNo(),
        orderId: Number(order.id),
        orderNo: order.orderNo,
        userId: Number(order.userId),
        teamLeaderId: Number(leader.id),
        applySource: RefundApplySource.LEADER, // C6 第一段：团长代退
        amount: amount.toFixed(2),
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
      `代退申请：团长#${leader.id} 订单 ${orderNo} 退款单 ${result.refundNo} 金额 ¥${amount.toFixed(2)}（资金未动）`,
    );

    return {
      refundNo: result.refundNo,
      orderNo: order.orderNo,
      status: RefundStatus.APPLYING,
      statusText: '退款申请中',
      amountFen: Math.round(amount * 100),
      reasonType: dto.reasonType,
      /** 明确回执：本步资金零变动 */
      fundsMoved: false,
      tips: '申请已提交，运营审批通过后退款原路返回（1–3 个工作日）',
    };
  }

  /** 订单是否存在未终结的退款申请（供订单视图标注） */
  async findActiveByOrderId(orderId: number): Promise<Refund | null> {
    return this.refundRepo.findOne({
      where: {
        orderId: Number(orderId),
        status: In([RefundStatus.APPLYING, RefundStatus.APPROVED, RefundStatus.REFUNDING]),
      },
    });
  }
}

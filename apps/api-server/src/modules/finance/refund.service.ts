import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not, Repository } from 'typeorm';

import {
  ORDER_STATUS_VIEW,
  OrderStatus,
  REFUND_STATUS_LABEL,
  RefundApplySource,
  RefundReasonType,
  RefundStatus,
} from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { QueueService } from '../../common/queue/queue.service';
import { money, round2, toFen } from '../../common/utils/money';
import { genRefundNo } from '../../common/utils/order-no';
import { toBjIso } from '../../common/utils/time';
import { TeamLeader } from '../../database/entities/leader.entity';
import { Order, Refund } from '../../database/entities/order.entity';
import { OperationLog } from '../../database/entities/system.entity';
import { WX_PAY_PROVIDER, WxPayProvider } from '../../providers/wx-pay/wx-pay.provider';
import { MessageService } from '../message/message.service';
import { NOTIFY_PAGES } from '../admin/template/message-template.specs';
import { RefundApplyPayload } from '../../queues/queue-payloads';
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
 * ③ 实退  执行退款                            → 账务冲销落库（事务） + 微信原路退（事务外） + 收口
 * ```
 *
 * ## ⭐ M4-3：外部通道调用已移出 DB 事务
 *
 * **改造前**：`executeRefund` 在事务内**先调微信退款**，失败即抛 `40010` 让整个事务回滚。
 * 这样确实避免了「有退款单但没退款」的哑单，但存在**更严重且不可自愈**的反面：
 * **微信退款成功之后，事务若因任何原因失败（冲销报错 / 连接断），钱已经出去了，
 * 而系统里没有退款单、订单也没变** —— 账实不符，且没有任何机制能发现它。
 *
 * **改造后**：③ 拆成「事务内」与「事务外」两段：
 * ```text
 * 事务 A（纯 DB，先提交）  冲销（余额退回 / 佣金反冲）+ 退款单 status='refunding'
 *                          + 订单收口 refunded
 *       ↓ 提交（此后**不可能**出现「钱退了但系统没记录」）
 * 事务外                  调微信退款（外部副作用）
 *       ├─ 成功 → 事务 B：退款单 → refunded + wx_refund_no + refunded_at
 *       └─ 失败 → 退款单 → failed + **入队 `refund-apply` 退避重试**
 * ```
 * 重试的安全性由 `refundNo` 保证：它是微信侧的幂等键（`out_refund_no`），
 * 重试携带同一个号 → 微信识别为同一笔退款，**不会重复出款**。
 *
 * ⚠️ 因此失败时的对外语义也变了：不再是「整个退款没发生、请重试」，
 * 而是「**已受理，微信通道那一段待重试**」—— 退款单 `failed` + 队列重试中，
 * 重试耗尽会写一条 `module=queue` 的操作日志供人工接手。
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

/**
 * 允许被退款流程「**原子占位**」的订单状态集合（M5-7 · 缺陷 #77/#80 收口）
 *
 * 两条入口的起点不同，故取**并集**：
 *   · `approveByAdmin`（D41）—— 起点必是 `refund_applying`（申请段已把订单推进过）；
 *   · `forceRefund`（D11）—— 跳过申请与审批，起点是 `REFUNDABLE_STATUS` 里任一。
 *
 * ⚠️ **刻意窄于「除 refunded 之外的一切」**：占位条件越具体，
 *    误伤（把一笔本不该退的单锁住）越不可能。它同时也是「订单状态机」里
 *    已声明的迁移边集合，与状态机对账时能直接对上。
 */
const CLAIMABLE_ORDER_STATUS: string[] = [...REFUNDABLE_STATUS, OrderStatus.REFUND_APPLYING];

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
    private readonly message: MessageService,
    private readonly queue: QueueService,
    @InjectRepository(OperationLog) private readonly opLogRepo: Repository<OperationLog>,
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
        // C6 第二段的唯一依据：记下**申请前**的订单状态。
        // 状态机对退款分支只有单向箭头，不记就该「驳回」时无家可归。
        orderStatusBefore: order.status,
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
    /** ⭐ M4-3：微信通道是否已受理（`false` = 已入队重试） */
    wxDelivered: boolean;
    retryQueued: boolean;
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
          // D11 不经过「驳回」分支，此处仅作审计留痕（该单从哪个状态被强制退回）
          orderStatusBefore: order.status,
        }),
      );
      return this.settleRefundDb(m, order, refund);
    });

    this.logger.warn(
      `后台强制退款（账务已落库，待通道执行）：操作人#${operatorId} 订单 ${orderNo} 退款单 ${result.refund.refundNo} ` +
        `合计 ¥${money(refundableFen / 100)}（微信 ¥${money(result.wxFen / 100)} + 余额 ¥${money(result.balanceFen / 100)}）` +
        ` 佣金冲销 ¥${money(result.reversal.commissionReversedFen / 100)}` +
        ' 供应商应付=不冲减（自营口径）',
    );

    // 阶段 2（事务外）：调微信通道；失败则入队退避重试，**不回滚已落库的账务**
    const delivery = await this.deliverOrQueueRefund({
      refundId: Number(result.refund.id),
      orderNo: order.orderNo,
      refundNo: result.refund.refundNo,
      wxFen: result.wxFen,
      totalFen: toFen(Number(order.totalAmount)),
      reason: `后台强制退款：${input.reason}`,
    });

    await this.notifyRefundResult(
      { userId: order.userId ?? null, orderNo: order.orderNo },
      result.refund.refundNo,
      refundableFen,
    );

    return {
      refundNo: result.refund.refundNo,
      orderNo: order.orderNo,
      status: delivery.ok ? RefundStatus.REFUNDED : RefundStatus.FAILED,
      refundedFen: refundableFen,
      wxRefundedFen: result.wxFen,
      balanceRefundedFen: result.balanceFen,
      reversal: result.reversal,
      /** ⭐ M4-3：微信通道是否已受理（`false` = 已排入队列重试，见 `tips`） */
      wxDelivered: delivery.ok,
      retryQueued: !delivery.ok,
      tips: delivery.ok
        ? '退款已发起，微信原路退回 1–3 个工作日到账；余额抵扣部分已即时退回余额'
        : '账务冲销与余额退回已完成；**微信退款通道暂时失败，已自动排队重试**，无需重复提交',
    };
  }

  // ==========================================================================
  // ② 后台审批（D41 通过 → 实退 · D42 驳回 → 回原状态）
  // ==========================================================================

  /**
   * D41 · 审批通过 → 实际退款（C6 第二段落地第三段）
   *
   * 与 D11 的分工见 `forceRefund` 注释：**本接口只处理已存在的 `applying` 退款单**，
   * 也就是「用户找团长 → 团长提交申请」这条常规通道的第二段。
   *
   * ## 审批与实退同事务（一期口径）
   * `approved` 只是个中间态，一期由本方法**在同一事务内**一路推到 `refunded`，
   * 因为没有异步回调前它对外不可观测。这样做的收益是：微信退款受理失败（`40010`）
   * 会让**审批一并回滚**，不会留下「已审批通过但钱没退」的悬空单
   * —— 运营重试一次即可，而不是对着一条已批准的申请不知道该怎么办。
   * 二期接 W2 退款结果通知后，再把「审批」与「实退」拆成两段异步。
   *
   * ## 审批前的最后一道闸
   * 重新算一遍可退金额（`total_amount − discount_amount`）。申请与审批之间虽然
   * 理论上改不了单（`refund_applying` 已过截单，D10 会拦 30014），但**退款是不可逆
   * 的资金动作**，哪怕只有万分之一的数据异常，也要在出款前拦住，而不是退错钱。
   */
  async approveByAdmin(
    refundId: number,
    adminId: number,
    remark?: string,
  ): Promise<{
    refundNo: string;
    orderNo: string;
    status: RefundStatus;
    refundedFen: number;
    wxRefundedFen: number;
    balanceRefundedFen: number;
    reversal: ReversalResult;
    orderStatusBefore: string | null;
    auditorId: number;
    auditAt: string;
    /** ⭐ M4-3：微信通道是否已受理（`false` = 已入队重试） */
    wxDelivered: boolean;
    retryQueued: boolean;
    tips: string;
  }> {
    const result = await this.dataSource.transaction(async (m) => {
      const refund = await m.findOne(Refund, { where: { id: Number(refundId) } });
      if (!refund) throw new BizException(ErrorCode.REFUND_NOT_FOUND);
      if (refund.status !== RefundStatus.APPLYING) {
        throw new BizException(
          ErrorCode.REFUND_STATUS_ILLEGAL,
          `退款单当前状态为「${refundStatusText(refund.status)}」，只有「待审批」的申请可以通过`,
        );
      }

      const order = await m.findOne(Order, { where: { id: Number(refund.orderId) } });
      if (!order) throw new BizException(ErrorCode.ORDER_NOT_FOUND);
      if (order.status !== OrderStatus.REFUND_APPLYING) {
        throw new BizException(
          ErrorCode.REFUND_STATUS_ILLEGAL,
          `订单当前状态为「${adminStatusText(order.status)}」，与退款申请不一致，请刷新后重试`,
        );
      }

      const expectFen = toFen(refundableYuan(order));
      if (toFen(Number(refund.amount)) !== expectFen) {
        throw new BizException(
          ErrorCode.REFUND_AMOUNT_MISMATCH,
          `订单可退金额 ¥${money(expectFen / 100)} 与退款单 ¥${refund.amount} 不一致，` +
            '请驳回后让团长重新提交申请',
        );
      }

      // 审批信息先落库（仍在同一事务内）—— 即便后续退款失败回滚，也不会出现
      // 「审批人缺失」的半截记录；反过来若回滚，则审批本身也不算生效。
      // ⭐ 原子占位：审批信息落库与「占住这张单」合成**一条带条件的 UPDATE**。
      //    旧写法是「前面 `findOne` 判过状态，然后 `m.save(refund)`」—— `save` 是**无条件全列覆盖**，
      //    在 MySQL 下并发第二次审批的 `findOne` 可能读到**事务快照里的旧值**（REPEATABLE READ）
      //    → 两道检查全过、无条件覆盖 → 双退（缺陷 #80）。
      //    现在「判状态」与「写状态」合并成一条原子动作，`affected = 0` 就是可靠的归属判据。
      const now = new Date();
      const auditRemark = (remark?.trim() || '审批通过').slice(0, 256);
      const claim = await m
        .createQueryBuilder()
        .update(Refund)
        .set({
          status: RefundStatus.APPROVED,
          auditorId: adminId,
          auditAt: now,
          auditRemark,
          version: () => 'version + 1',
        })
        .where('id = :id AND status = :expect', {
          id: Number(refundId),
          expect: RefundStatus.APPLYING,
        })
        .execute();
      if (!claim.affected) {
        throw new BizException(
          ErrorCode.REFUND_STATUS_ILLEGAL,
          '该申请已被处理（可能由另一位操作员同时审批），请刷新后查看最新状态',
        );
      }
      // 内存对象同步到落库值（后续 `settleRefundDb` 会再推进一步并 `save`）
      refund.status = RefundStatus.APPROVED;
      refund.auditorId = adminId;
      refund.auditAt = now;
      refund.auditRemark = auditRemark;
      refund.version = (refund.version ?? 0) + 1;
      const approved = refund;

      const settled = await this.settleRefundDb(m, order, approved);
      return {
        ...settled,
        orderStatusBefore: refund.orderStatusBefore ?? null,
        // 事务外发通知 / 调通道需要的信息：只带出**必要字段**，不把已脱离会话的实体拿到外面
        notifyTarget: { userId: order.userId ?? null, orderNo: order.orderNo },
        orderTotalFen: toFen(Number(order.totalAmount)),
      };
    });

    this.logger.log(
      `D41 审批通过（账务已落库，待通道执行）：审批人#${adminId} 退款单 ${result.refund.refundNo} 订单 ${result.refund.orderNo} ` +
        `合计 ¥${money(toFen(Number(result.refund.amount)) / 100)}` +
        `（微信 ¥${money(result.wxFen / 100)} + 余额 ¥${money(result.balanceFen / 100)}）` +
        ` 佣金冲销 ¥${money(result.reversal.commissionReversedFen / 100)}`,
    );

    // 阶段 2（事务外）：调微信通道；失败则入队退避重试，**不回滚已落库的账务**
    const delivery = await this.deliverOrQueueRefund({
      refundId: Number(result.refund.id),
      orderNo: result.refund.orderNo,
      refundNo: result.refund.refundNo,
      wxFen: result.wxFen,
      totalFen: result.orderTotalFen,
      reason: result.refund.reason ?? '后台审批退款',
    });

    await this.notifyRefundResult(
      result.notifyTarget,
      result.refund.refundNo,
      toFen(Number(result.refund.amount)),
    );

    return {
      refundNo: result.refund.refundNo,
      orderNo: result.refund.orderNo,
      status: delivery.ok ? RefundStatus.REFUNDED : RefundStatus.FAILED,
      refundedFen: toFen(Number(result.refund.amount)),
      wxRefundedFen: result.wxFen,
      balanceRefundedFen: result.balanceFen,
      reversal: result.reversal,
      orderStatusBefore: result.orderStatusBefore,
      auditorId: adminId,
      auditAt: (result.refund.auditAt ?? new Date()).toISOString(),
      /** ⭐ M4-3：微信通道是否已受理（`false` = 已排入队列重试，见 `tips`） */
      wxDelivered: delivery.ok,
      retryQueued: !delivery.ok,
      tips: delivery.ok
        ? '退款已发起，微信原路退回 1–3 个工作日到账；余额抵扣部分已即时退回余额'
        : '账务冲销与余额退回已完成；**微信退款通道暂时失败，已自动排队重试**，无需重复审批',
    };
  }

  /**
   * D42 · 审批驳回 → 订单回到**申请前**的状态（C6 第二段）
   *
   * ## 资金零变动
   * 驳回只做两件事：退款单转 `rejected`、订单状态回退。**不碰** `ab_balance`、
   * 不写 `ab_commission`、不动 `ab_supplier_share` —— 因为第一段（申请）本身
   * 就没有动过任何资金，驳回自然也只能是「把状态改回去」。
   *
   * ## 「原状态」从哪来
   * 取 `refund.order_status_before`（申请时写入）。**缺列值一律拒绝**（`40014`）：
   * 靠时间猜会退到错误的节点（已 `completed` 的单被退成 `paid`，佣金基数与取餐
   * 事实一起被抹掉），而运营并不因此无路可走 —— D11 强制退款正是为此准备的
   * 兜底通道。宁可让一次操作失败并说明原因，也不写一个看起来成功的错状态。
   */
  async rejectByAdmin(
    refundId: number,
    adminId: number,
    reason: string,
  ): Promise<{
    refundNo: string;
    orderNo: string;
    refundStatus: RefundStatus;
    orderStatus: string;
    orderStatusText: string;
    fundsMoved: false;
    tips: string;
  }> {
    const result = await this.dataSource.transaction(async (m) => {
      const refund = await m.findOne(Refund, { where: { id: Number(refundId) } });
      if (!refund) throw new BizException(ErrorCode.REFUND_NOT_FOUND);
      if (refund.status !== RefundStatus.APPLYING) {
        throw new BizException(
          ErrorCode.REFUND_STATUS_ILLEGAL,
          `退款单当前状态为「${refundStatusText(refund.status)}」，只有「待审批」的申请可以驳回`,
        );
      }

      const order = await m.findOne(Order, { where: { id: Number(refund.orderId) } });
      if (!order) throw new BizException(ErrorCode.ORDER_NOT_FOUND);

      const back = refund.orderStatusBefore;
      if (!back || !REFUNDABLE_STATUS.includes(back)) {
        throw new BizException(
          ErrorCode.REFUND_ORIGIN_UNKNOWN,
          '该申请缺少可用的原状态记录，驳回后订单无法回到正确节点；' +
            '请改用「强制退款」处理，或联系开发排查',
        );
      }

      const now = new Date();
      refund.status = RefundStatus.REJECTED;
      refund.auditorId = adminId;
      refund.auditAt = now;
      refund.auditRemark = `驳回：${reason}`.slice(0, 256);
      refund.version = (refund.version ?? 0) + 1;
      const saved = await m.save(refund);

      // 乐观锁：仅当订单仍停在 refund_applying 时才回退（防与并发退款打架）
      const upd = await m
        .createQueryBuilder()
        .update(Order)
        .set({ status: back, version: (order.version ?? 0) + 1 })
        .where('id = :id AND status = :from', { id: order.id, from: OrderStatus.REFUND_APPLYING })
        .execute();
      if (!upd.affected) {
        throw new BizException(ErrorCode.REFUND_STATUS_ILLEGAL, '订单状态已变更，请刷新后重试');
      }

      return { refund: saved, back, now };
    });

    this.logger.log(
      `D42 驳回：审批人#${adminId} 退款单 ${result.refund.refundNo} 订单 ${result.refund.orderNo} ` +
        `→ 订单回到 ${result.back}（资金零变动）`,
    );

    return {
      refundNo: result.refund.refundNo,
      orderNo: result.refund.orderNo,
      refundStatus: RefundStatus.REJECTED,
      orderStatus: result.back,
      orderStatusText: adminStatusText(result.back),
      fundsMoved: false,
      tips: '已驳回；订单状态已回到申请前的节点，资金未发生任何变动',
    };
  }

  // ==========================================================================
  // ③ 执行口（被 D11 与 D41 共用）
  // ==========================================================================

  /**
   * 实际退款 · **事务内那一段**（C6 第三段 · M4-3 拆分）
   *
   * ⚠️ **本方法不调任何外部通道** —— 这是 M4-3 的核心改动（理由见类头）。
   * 它只做「钱在账本上的定稿」：
   *   1. 账务冲销（余额退回 / 佣金反冲；自营口径下**不冲减供应商应付**）
   *   2. 退款单 → 有微信金额时 `refunding`（通道那段由 `attemptWxRefund` 收口）；
   *      **纯余额退款**（无微信实付）没有通道那一段，直接 `refunded`
   *   3. 订单 → `refunded`
   *
   * ## 为什么订单此时就能置 `refunded`
   * 余额抵扣部分**已即时退回**，微信实付部分对外承诺「1–3 个工作日到账」（文案一直如此）。
   * 订单状态表达的是「**这笔业务已受理退款**」，而「**通道是否已受理**」由退款单状态
   * （`refunding` → `refunded` / `failed`）表达 —— 两个状态各说一件事，不再混为一谈。
   *
   * ⚠️ 金额拆两路：**微信实付**走通道原路退，**余额抵扣**直接退回余额
   *    （它当初就没走微信，喂给通道会被微信拒；喂进去了则是重复出款）。
   *
   * ## ⭐⭐ 并发闸门：第一件事就是「**原子占住订单**」（M5-7 · 缺陷 #77/#80 收口）
   *
   * 旧写法是「先把账务冲销、最后再无条件把订单改成 `refunded`」，
   * 而两层闸门（退款单状态 / 订单状态）**都是「读一次再写」**：
   *
   *   · `approveByAdmin` 里是 `findOne` + 判 `status`，然后 `m.save(refund)`（无条件覆盖）；
   *   · `forceRefund` 是事务外 `findOne` 查「有没有进行中的退款单」，而后**新建一张全新的单**。
   *
   * 于是：同一订单在真并发下会走到两次冲销（余额退两次）。而且因为
   * `genRefundNo()` 每次生成**新单号**、而它就是微信侧的幂等键 `out_refund_no` ——
   * **两个不同的幂等键对微信来说就是两笔单**，微信不会去重，**真双付**。
   *
   * 修法就是下面第一步那条 `UPDATE ... WHERE id = ? AND status IN (...)`：
   *
   *   · 它走的是**当前读 + 行锁**，不会像 `findOne` 那样读到事务快照
   *     （MySQL REPEATABLE READ 下并发第二次可能读到「还是旧状态」）；
   *   · `affected = 0` 就是可靠的「**这张单已经不归我了**」判据，异常时直接回滚整个事务；
   *   · **一处占位同时守住三段**：余额退回 / 佣金冲销 / 通道调用的入口（三者同在本方法后续步骤内）。
   *
   * ⚠️ 第一步把「占位成功」与「最终状态 `refunded`」合并成一次写：本方法无论后续成功与否
   *    都在**同一事务**内，失败会连占位一起回滚 —— 不会留下「占住了但没退」的僵尸。
   */
  private async settleRefundDb(
    m: EntityManager,
    order: Order,
    refund: Refund,
  ): Promise<{ refund: Refund; wxFen: number; balanceFen: number; reversal: ReversalResult }> {
    const now = new Date();
    const wxFen = toFen(Number(order.payAmount));

    // ⭐⭐ 第一步：**原子占住订单** —— 并发闸门，也是全链最外层的幂等闸。
    // 完整推理论证见本方法 JSDoc 的「并发闸门」一节；一句话：
    // `UPDATE ... WHERE status IN (...)` 是当前读 + 行锁，`affected` 可信；
    // 而 `findOne` 是快照读，在 MySQL REPEATABLE READ 下可能读到「该单还可退」的旧值。
    // ⚠️ 占位与收口合并为一次写：成功就直接是终态 `refunded`
    //    （不引入新的中间态，状态机无需改）；后续任一步报错都会把它一起回滚。
    const claim = await m
      .createQueryBuilder()
      .update(Order)
      .set({
        status: OrderStatus.REFUNDED,
        cancelledAt: now,
        version: () => 'version + 1',
      })
      .where('id = :id AND status IN (:...ok)', {
        id: Number(order.id),
        ok: CLAIMABLE_ORDER_STATUS,
      })
      .execute();
    if (!claim.affected) {
      throw new BizException(
        ErrorCode.REFUND_DUPLICATED,
        '该订单的退款已被处理（可能由另一位操作员同时提交），请刷新后查看',
      );
    }

    // ⭐ 第二步：账务冲销（余额退回 / 佣金反冲；自营口径：不冲减供应商应付）
    const reversal = await this.reversal.applyRefundEffects(m, order, refund);

    // ⭐ 第三步：退款单收口
    refund.status = wxFen > 0 ? RefundStatus.REFUNDING : RefundStatus.REFUNDED;
    refund.refundedAt = wxFen > 0 ? null : now;
    refund.auditorId = refund.auditorId ?? null;
    refund.auditAt = refund.auditAt ?? now;
    refund.reversed = 1;
    refund.reversedAt = now;
    refund.version = (refund.version ?? 0) + 1;
    const saved = await m.save(refund);

    // ⚠️ `cancelled_at` 按《状态机》既有约定近似承载退款时刻
    //    （时间线异常区节点取它作为「发生时间」，无独立 refunded_at 列）——
    //    它已在上面第一步的占位里一并写好，此处不再重复写。

    // ⭐ 余额退回额取**账务的真实返回值**（`reversal.balanceRefundedFen`），
    //    不再从订单 `balanceUsed` 反算。旧写法是无条件赋值，
    //    于是「钱没退但出参说已退」—— 缺陷 #82。
    return { refund: saved, wxFen, balanceFen: reversal.balanceRefundedFen, reversal };
  }

  // ==========================================================================
  // ③ 通道执行（事务外 · 可重试）—— M4-3
  // ==========================================================================

  /**
   * 单次尝试：调微信退款 → 收口退款单
   *
   * **由队列消费者调用**（`refund-apply.consumer`），也是 `deliverOrQueueRefund`
   * 内部首次同步尝试的执行体。抛错 = 需要重试（交给队列的退避策略）。
   *
   * ## 幂等（**允许自动重试的前提**）
   *   · 单据已是 `refunded` → 直接返回（上一次其实成功了，只是收口那一步没跑完）；
   *   · 微信侧用 `refundNo`（`out_refund_no`）作幂等键：同一个号重复请求，
   *     微信识别为**同一笔**退款，因此重试**不会变成重复出款**。
   *
   * ⚠️ 单据已被驳回（`rejected`）时不重试：那是一条本不该存在的任务，
   *    重试三次只会白等 —— 记一条 WARN 后正常结束（异常由死信机制兜不住，
   *    所以这里**必须自己判断**，见 `queue.types.ts` 的处理器契约）。
   */
  async attemptWxRefund(payload: RefundApplyPayload): Promise<void> {
    const refund = await this.refundRepo.findOne({ where: { id: Number(payload.refundId) } });
    if (!refund) {
      throw new BizException(
        ErrorCode.REFUND_NOT_FOUND,
        `退款单 #${payload.refundId} 不存在，无法执行通道退款`,
      );
    }

    if (refund.status === RefundStatus.REFUNDED) return;

    if (refund.status === RefundStatus.REJECTED) {
      this.logger.warn(`退款单 ${refund.refundNo} 已驳回，跳过通道退款（队列任务作废，不再重试）`);
      return;
    }

    // 纯余额退款：没有通道那一段，直接收口
    if (payload.wxFen <= 0) {
      await this.finalizeWxRefund(Number(refund.id), null);
      return;
    }

    const r = await this.wxPay.refund({
      orderNo: payload.orderNo,
      // ⭐ 幂等键：重试必须带**同一个** refundNo
      refundNo: payload.refundNo,
      refundFen: payload.wxFen,
      totalFen: payload.totalFen,
      reason: payload.reason.slice(0, 128),
    });
    if (r.status !== 'SUCCESS' && r.status !== 'PROCESSING') {
      // 抛错 → 队列按退避重试（`refundNo` 保证不会重复出款）
      throw new Error(`微信退款未受理（状态 ${r.status}）`);
    }

    await this.finalizeWxRefund(Number(refund.id), r.refundId);
  }

  /**
   * 事务外：**首次同步尝试 + 失败入队重试**
   *
   * 三条路径共用（正常退款审批 / 后台强制退款 / 订单取消），因此是 `public`：
   *   · `finance` 内部：`forceRefund` / `approveByAdmin`
   *   · `order` 模块：`cancel`（截单前自助取消）、`markPaid`（延迟到账自动退款）
   *
   * 保留「同步试一次」的原因：微信退款正常情况下是**秒级**的，同步成功时
   * 用户/运营立即看到「已退款」，与改造前的体验一致；只有失败才转入异步重试。
   *
   * @returns `ok=false` 表示通道未受理、**已入队重试**（不是「什么都没做」）
   */
  async deliverOrQueueRefund(payload: RefundApplyPayload): Promise<{ ok: boolean }> {
    if (payload.wxFen <= 0) return { ok: true };

    try {
      await this.attemptWxRefund(payload);
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`微信退款失败（退款单 ${payload.refundNo}），已转入队列重试：${msg}`);
      await this.markWxRefundFailed(payload.refundId, msg);
      await this.enqueueRefundRetry(payload);
      return { ok: false };
    }
  }

  /**
   * 入队重试（**入队失败也要留痕**）
   *
   * ⚠️ 这里是整套自动重试的**唯一入口**：如果这里静默失败（Redis 抖动），
   *    「微信退款失败」这件事就既不会重试、也不会有人知道 —— 账务已冲销、
   *    余额已退回，用户却永远收不到微信那部分钱。故入队失败时**必须**写一条
   *    操作日志（`module=queue`），让它进入运维能查到的范围。
   */
  private async enqueueRefundRetry(payload: RefundApplyPayload): Promise<boolean> {
    try {
      await this.queue.enqueue('refund-apply', payload);
      return true;
    } catch (e) {
      this.logger.error(
        `⚠️ 退款重试任务入队失败（退款单 ${payload.refundNo}）：${(e as Error).message} —— ` +
          '该笔退款不会自动重试，需人工介入',
      );
      await this.writeRetryLostLog(payload, (e as Error).message);
      return false;
    }
  }

  /** 退款单收口为已退款（事务 B · 独立短事务，与业务事务解耦） */
  private async finalizeWxRefund(refundId: number, wxRefundNo: string | null): Promise<void> {
    await this.refundRepo
      .createQueryBuilder()
      .update(Refund)
      .set({
        status: RefundStatus.REFUNDED,
        wxRefundNo,
        refundedAt: new Date(),
        version: () => 'version + 1',
      })
      .where('id = :id', { id: Number(refundId) })
      .execute();
  }

  /**
   * 标记「通道那一段失败」
   *
   * ⚠️ 只改退款单状态与备注，**不回调账务与订单** —— 它们已经按「已受理」定稿，
   *    回退会造成「余额退回来了又扣走」这种用户可见的反复。
   *    原因**追加**到 `audit_remark`（不覆盖审批备注，运营两头都看得到）。
   */
  private async markWxRefundFailed(refundId: number, errMsg: string): Promise<void> {
    try {
      const row = await this.refundRepo.findOne({ where: { id: Number(refundId) } });
      const merged = [row?.auditRemark, `通道失败：${errMsg}`]
        .filter(Boolean)
        .join(' | ')
        .slice(0, 256);
      await this.refundRepo
        .createQueryBuilder()
        .update(Refund)
        .set({ status: RefundStatus.FAILED, auditRemark: merged, version: () => 'version + 1' })
        .where('id = :id', { id: Number(refundId) })
        .execute();
    } catch (e) {
      // 标记失败不能影响「入队重试」这个主动作
      this.logger.warn(`标记退款单失败态时出错（不影响重试）：${(e as Error).message}`);
    }
  }

  /** 「重试入口丢失」操作日志（入队失败时写，见 `enqueueRefundRetry`） */
  private async writeRetryLostLog(payload: RefundApplyPayload, err: string): Promise<void> {
    try {
      await this.opLogRepo.insert({
        adminUserId: null,
        module: 'queue',
        action: '重试任务入队失败',
        targetId: payload.orderNo,
        requestData: { refundNo: payload.refundNo, wxFen: payload.wxFen },
        snapshot: {
          source: 'system',
          reason: err.slice(0, 256),
          hint:
            '微信退款已失败且重试任务未能入队（队列不可用）。账务已冲销、余额已退回，' +
            '**微信实付部分未退**，需人工核对该笔退款单后手工重试。',
        },
      });
    } catch (e) {
      this.logger.error(`写「重试入队失败」操作日志也未成功：${(e as Error).message}`);
    }
  }

  /**
   * 退款结果通知（M3-12 · 原型标注的**必推项**）
   *
   * ## 三个刻意的选择
   *
   * 1. **调用点在事务之外**（两个调用点都在 `dataSource.transaction()` 返回之后）。
   *    放进 `executeRefund` 就是事务内 —— 一旦回滚，用户已收到「退款成功」的通知
   *    而钱并没退，这是退款链路最忌讳的「说不清」。通知是**既成事实的告知**，
   *    必须发生在事实确立之后。
   * 2. **通知失败不影响退款结果**。`MessageService.notify()` 已承诺不抛异常，
   *    此处再兜一层 try —— 双保险，确保「通知」永远无法把一笔成功的退款变成失败。
   * 3. **未启用就不发**（场景开关在 `ab_message_template`）。一期没有微信订阅消息
   *    模板 ID，`refund_result` 的启用闸门会拦住启用，故此路径当前是「静默跳过」——
   *    这是**如实状态**，不是漏了。
   *
   * ⚠️ 一期 `wxData` 的 key 用**我们自己的变量名**（`orderNo` / `amount` / `refundedAt`）：
   *    真实微信模板要求 `thing1` / `time2` 这类 keyword，业务变量名 → keyword 的映射
   *    要等微信模板创建后才能定，届时在**本方法一处**完成映射即可（不要在别处再拼一份）。
   */
  private async notifyRefundResult(
    target: { userId: number | null; orderNo: string },
    refundNo: string,
    amountFen: number,
  ): Promise<void> {
    try {
      const at = toBjIso(new Date());
      const amount = money(amountFen / 100);
      const result = await this.message.notify({
        scene: 'refund_result',
        userId: target.userId,
        // ⚠️ M4-3 修正：原值 `pages/order/detail` 与 `pages.json` 的真实路由
        //    （`pages/order-detail/order-detail`）不符 —— 投递日志显示成功，
        //    但用户点开通知会落到不存在的页面。改用 `NOTIFY_PAGES` 单一真相。
        page: NOTIFY_PAGES.orderDetail,
        variables: {
          orderNo: target.orderNo,
          refundNo,
          amount: amount ?? '0.00',
          refundedAt: at ?? '',
        },
        wxData: {
          orderNo: { value: target.orderNo },
          amount: { value: amount ?? '0.00' },
          refundedAt: { value: at ?? '' },
        },
      });
      if (!result.delivered) {
        this.logger.log(`退款通知未投递（订单 ${target.orderNo}）：${result.reason ?? '-'}`);
      }
    } catch (e) {
      // 双保险：确保通知永远无法影响退款结果
      this.logger.warn(
        `退款通知异常（订单 ${target.orderNo}）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * 特殊通道：支付回调**延迟到达**且订单已取消 → 自动原路退款
   *
   * 场景：订单在 T-1 24:00 截单时因未支付被取消，而微信回调之后才到达
   * （微信侧或网络延迟）。钱收了、单没了 → 必须原路退回，否则就是「收了钱没给饭」。
   *
   * ## 与原实现的区别（M4-3）
   * 原实现把「建单 + 调微信」放在**同一个事务**里（`OrderService.refundViaWxpay`），
   * 现在拆成：事务内只建单（DB）→ 事务后**入队**执行通道退款。
   *
   * 为什么这条路径**不做同步首次尝试**：它是**罕见异常路径**（用户已取消、
   * 钱会退回，不要求秒级），异步反而更稳 —— 回调路径本就该尽快返回，
   * 且入队后的重试由队列负责，不需要微信再回调一次。
   *
   * @returns `queued=false` 时看 `reason`（订单不存在 / 已有未终结退款单）
   */
  async refundLatePayment(
    orderNo: string,
    amountFen: number,
    reason: string,
  ): Promise<{ queued: boolean; refundNo?: string; reason?: string }> {
    const order = await this.orderRepo.findOne({ where: { orderNo } });
    if (!order) return { queued: false, reason: 'order_not_found' };

    const payload = await this.dataSource.transaction(async (m) => {
      const row = await this.buildRefundRow(m, order, amountFen, reason);
      if (!row) return null;
      const p: RefundApplyPayload = {
        refundId: Number(row.id),
        orderNo: order.orderNo,
        refundNo: row.refundNo,
        wxFen: amountFen,
        totalFen: toFen(Number(order.totalAmount)),
        reason,
      };
      return p;
    });

    if (!payload) return { queued: false, reason: 'exists' };

    // 异常路径：不做同步尝试，直接入队（理由见方法注释）
    const queued = await this.enqueueRefundRetry(payload);

    this.logger.warn(
      `回调延迟到账自动退款：订单 ${orderNo} 退款单 ${payload.refundNo} 金额 ${amountFen} 分` +
        `（入队${queued ? '成功' : '失败，需人工介入'}）`,
    );

    return { queued, refundNo: payload.refundNo };
  }

  /**
   * 事务内：为「不走审批的即时退款」建一条退款单（**幂等**）
   *
   * 服务两个通道（都是「钱已收、要立即退」的场景）：
   *   · **订单取消**（截单前用户自助取消 · `order.service.cancel`）
   *   · **支付回调延迟到达且订单已取消**（`order.service.markPaid` → `refundLatePayment`）
   *
   * ## 两个刻意的选择
   * 1. **不走冲销**（`reversed=0`）：这两个场景订单都还没截单/出餐，没有佣金与
   *    供应商应付需要反冲；余额抵扣部分由调用方负责（取消链路释放冻结）。
   *    若在这里硬套 `applyRefundEffects`，会去冲一笔并不存在的佣金。
   * 2. **幂等返回 `null`**：同一订单已有非驳回退款单时不建第二条 ——
   *    微信回调可能重复到达，取消接口也可能被并发调用。
   *
   * ⚠️ **只建单、不调通道** —— 通道调用属事务外（`deliverOrQueueRefund`），
   *    这是 M4-3 的核心纪律：外部副作用绝不能与 DB 事务同生共死。
   */
  async buildRefundRow(
    m: EntityManager,
    order: Order,
    wxFen: number,
    reason: string,
  ): Promise<Refund | null> {
    const existed = await m.findOne(Refund, {
      where: { orderId: Number(order.id), status: Not(RefundStatus.REJECTED) },
    });
    if (existed) return null;

    return m.save(
      m.create(Refund, {
        refundNo: genRefundNo(),
        orderId: Number(order.id),
        orderNo: order.orderNo,
        userId: Number(order.userId),
        teamLeaderId: order.teamLeaderId ?? null,
        applySource: RefundApplySource.USER,
        amount: money(wxFen / 100),
        reasonType: RefundReasonType.OTHER,
        reason: reason.slice(0, 256),
        status: RefundStatus.REFUNDING,
        auditorId: null,
        auditAt: null,
        reversed: 0,
      }),
    );
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

/** 退款单状态中文文案（错误提示与列表共用，端上不维护第二份映射） */
function refundStatusText(status: string): string {
  return REFUND_STATUS_LABEL[status] ?? status;
}

/** 订单状态（后台视角）中文文案 */
function adminStatusText(status: string): string {
  return ORDER_STATUS_VIEW[status as OrderStatus]?.admin ?? status;
}

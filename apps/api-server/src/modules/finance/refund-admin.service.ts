import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import {
  ORDER_STATUS_VIEW,
  OrderStatus,
  REFUND_REASON_LABEL,
  REFUND_SOURCE_LABEL,
  REFUND_STATUS_LABEL,
  RefundReasonType,
  RefundStatus,
} from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { maskPhone } from '../../common/utils/crypto';
import { money, toFen } from '../../common/utils/money';
import { normalizePage, paginate, PageResult } from '../../common/utils/response';
import { toBjIso } from '../../common/utils/time';
import { TeamLeader } from '../../database/entities/leader.entity';
import { Order, Refund } from '../../database/entities/order.entity';
import { User } from '../../database/entities/user.entity';
import { AdminRefundsQueryDto } from './dto/refund-admin.dto';
import { RefundService } from './refund.service';

/**
 * 后台 · 退款审批（《接口规范 v1.0》§6.5 D40–D42 · 原型 P34）
 *
 * ## 这一页在 C6 三段式里的位置
 * ```
 * ① 用户找团长 → 团长代退申请（L7）   → ab_refund.status = applying   ← M2 已落地
 * ② 运营在这里审批（D41 通过 / D42 驳回）                              ← 本文件
 * ③ 实际退款（refund.service.executeRefund，D11 与 D41 共用唯一执行口） ← M3-3 已落地
 * ```
 * 因此本服务**只做两件事**：把流程收口（调 `RefundService`）+ 给运营一个能查、能看、
 * 敢点的列表。**不重复实现任何账务** —— 佣金冲销 / 余额退回 / 应付冲减全在
 * `ReversalService`，两条路径共用同一份口径才不会分叉。
 *
 * ## Tab 与「汇总」的口径
 * `tab` 由服务端展开成状态集合（端上不自己拼），`summary` 按**同一过滤条件的全量**
 * 统计而不受分页影响 —— 与 D8/L10/L19 同一约定，翻页时数字不会跳。
 */
@Injectable()
export class RefundAdminService {
  private readonly logger = new Logger('RefundAdminService');

  constructor(
    @InjectRepository(Refund) private readonly refundRepo: Repository<Refund>,
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>,
    private readonly refundService: RefundService,
  ) {}

  /** Tab → 状态集合（终态与中间态的分组口径写在服务端） */
  private static readonly TAB_STATUS: Record<string, string[]> = {
    pending: [RefundStatus.APPLYING],
    approved: [RefundStatus.APPROVED, RefundStatus.REFUNDING],
    rejected: [RefundStatus.REJECTED, RefundStatus.FAILED],
    refunded: [RefundStatus.REFUNDED],
    all: [],
  };

  // ==========================================================================
  // D40 · 退款流水 / 审批列表
  // ==========================================================================
  async list(q: AdminRefundsQueryDto): Promise<
    PageResult<Record<string, unknown>> & {
      tab: string;
      summary: {
        pendingCount: number;
        pendingAmountFen: number;
        approvedCount: number;
        refundedCount: number;
        refundedAmountFen: number;
        rejectedCount: number;
      };
      statusOptions: { value: string; label: string }[];
      sourceOptions: { value: string; label: string }[];
    }
  > {
    const { page, pageSize, skip } = normalizePage(q);
    const tab = q.tab ?? 'all';
    const statuses = q.status ? [q.status] : RefundAdminService.TAB_STATUS[tab];

    const build = () => {
      const qb = this.refundRepo.createQueryBuilder('r');
      if (statuses?.length) qb.andWhere('r.status IN (:...statuses)', { statuses });
      if (q.mealDate) {
        // 出餐日在订单上：用子查询而非 JOIN，避免与分页的 count 查询互相干扰
        qb.andWhere(
          'r.order_id IN (SELECT o1.id FROM ab_order o1 WHERE o1.meal_date = :mealDate)',
          { mealDate: q.mealDate },
        );
      }
      if (q.keyword) {
        const kw = `%${q.keyword.trim()}%`;
        qb.andWhere(
          '(r.refund_no LIKE :kw OR r.order_no LIKE :kw OR r.user_id IN ' +
            '(SELECT u1.id FROM ab_user u1 WHERE u1.nickname LIKE :nick))',
          { kw, nick: kw },
        );
      }
      return qb;
    };

    const [rows, total] = await build()
      .clone()
      .orderBy('r.id', 'DESC')
      .skip(skip)
      .take(pageSize)
      .getManyAndCount();

    // 汇总取**同一过滤条件的全量**（不受分页影响）
    const all = await build().clone().orderBy('r.id', 'ASC').getMany();
    const sumOf = (list: Refund[]) => list.reduce((s, r) => s + toFen(Number(r.amount)), 0);
    const pending = all.filter((r) => r.status === RefundStatus.APPLYING);
    const approved = all.filter((r) =>
      [RefundStatus.APPROVED, RefundStatus.REFUNDING].includes(r.status as RefundStatus),
    );
    const refunded = all.filter((r) => r.status === RefundStatus.REFUNDED);
    const rejected = all.filter((r) =>
      [RefundStatus.REJECTED, RefundStatus.FAILED].includes(r.status as RefundStatus),
    );

    return {
      ...paginate(await this.decorate(rows), total, page, pageSize),
      tab,
      summary: {
        pendingCount: pending.length,
        pendingAmountFen: sumOf(pending),
        approvedCount: approved.length,
        refundedCount: refunded.length,
        refundedAmountFen: sumOf(refunded),
        rejectedCount: rejected.length,
      },
      statusOptions: Object.entries(REFUND_STATUS_LABEL).map(([value, label]) => ({
        value,
        label,
      })),
      sourceOptions: Object.entries(REFUND_SOURCE_LABEL).map(([value, label]) => ({
        value,
        label,
      })),
    };
  }

  // ==========================================================================
  // D41 · 审批通过 → 实际退款
  // ==========================================================================
  async approve(id: number, adminId: number, remark?: string) {
    const result = await this.refundService.approveByAdmin(id, adminId, remark);
    const order = await this.orderRepo.findOne({ where: { orderNo: result.orderNo } });

    return {
      ...result,
      /** 审批后的订单快照（前端据此更新详情页，不必二次请求） */
      order: order
        ? {
            orderNo: order.orderNo,
            status: order.status,
            statusText: adminStatusText(order.status),
          }
        : null,
      /** 执行链留痕：运营在页面上能立刻看到「钱去哪了」 */
      executionChain: [
        `退款单 → ${RefundStatus.REFUNDED}（${REFUND_STATUS_LABEL[RefundStatus.REFUNDED]}）`,
        `微信原路退 ¥${money(result.wxRefundedFen / 100)}`,
        `余额抵扣退回 ¥${money(result.balanceRefundedFen / 100)}`,
        `佣金冲销 ¥${money(result.reversal.commissionReversedFen / 100)}`,
        `应付调整 ${result.reversal.supplierShareAdjusted} 行（${result.reversal.supplierShareMode}）`,
      ],
    };
  }

  // ==========================================================================
  // D42 · 审批驳回 → 订单回原状态
  // ==========================================================================
  async reject(id: number, adminId: number, reason: string) {
    const result = await this.refundService.rejectByAdmin(id, adminId, reason);
    this.logger.log(`D42 驳回退款单#${id}（${result.refundNo}）→ 订单回到 ${result.orderStatus}`);
    return result;
  }

  // ==========================================================================
  // 行装饰：一次补齐用户 / 团长 / 订单侧信息（避免前端 N+1）
  // ==========================================================================
  private async decorate(rows: Refund[]): Promise<Record<string, unknown>[]> {
    if (!rows.length) return [];

    const orderIds = [...new Set(rows.map((r) => Number(r.orderId)))];
    const userIds = [...new Set(rows.map((r) => Number(r.userId)))];
    const leaderIds = [...new Set(rows.map((r) => Number(r.teamLeaderId)).filter((x) => x > 0))];

    const [orders, users, leaders] = await Promise.all([
      this.orderRepo.find({ where: { id: In(orderIds) } }),
      this.userRepo.find({ where: { id: In(userIds.concat([0])) } }),
      leaderIds.length
        ? this.leaderRepo.find({ where: { id: In(leaderIds) } })
        : Promise.resolve([] as TeamLeader[]),
    ]);

    const orderMap = new Map(orders.map((o) => [Number(o.id), o]));
    const userMap = new Map(users.map((u) => [Number(u.id), u]));
    const leaderMap = new Map(leaders.map((l) => [Number(l.id), l]));

    return rows.map((r) => {
      const order = orderMap.get(Number(r.orderId));
      const user = userMap.get(Number(r.userId));
      const leader = r.teamLeaderId ? leaderMap.get(Number(r.teamLeaderId)) : null;
      const isPending = r.status === RefundStatus.APPLYING;
      // 拆分口径与执行口一致：微信实付走通道，余额抵扣单独退（P34 通过弹窗照此展示）
      const wxFen = order ? toFen(Number(order.payAmount)) : 0;
      const balanceFen = order ? toFen(Number(order.balanceUsed)) : 0;

      return {
        id: Number(r.id),
        refundNo: r.refundNo,
        orderNo: r.orderNo,
        orderId: Number(r.orderId),
        mealDate: order?.mealDate ?? null,
        quantity: order ? Number(order.quantity) : null,

        amountFen: toFen(Number(r.amount)),
        /** 拆两路展示用：微信原路退 / 余额抵扣退回 */
        wxAmountFen: wxFen,
        balanceAmountFen: balanceFen,

        status: r.status,
        statusText: REFUND_STATUS_LABEL[r.status] ?? r.status,
        applySource: r.applySource,
        applySourceText: REFUND_SOURCE_LABEL[r.applySource] ?? r.applySource,
        reasonType: r.reasonType ?? null,
        reasonTypeText: r.reasonType
          ? (REFUND_REASON_LABEL[r.reasonType as RefundReasonType] ?? r.reasonType)
          : null,
        reason: r.reason ?? null,

        user: {
          id: Number(r.userId),
          nickname: user?.nickname ?? null,
          /** 后台列表**同样脱敏** —— 全号属于 D12 导出那条受审计的通道 */
          phoneMasked: maskPhone(user?.phone ?? null),
        },
        leader: leader
          ? { id: Number(leader.id), realName: leader.realName ?? null, level: leader.level }
          : null,

        /** C6 第二段依据：申请前的订单状态（P34 用于说明「驳回将回到…」） */
        orderStatusBefore: r.orderStatusBefore ?? null,
        orderStatusBeforeText: r.orderStatusBefore ? adminStatusText(r.orderStatusBefore) : null,
        orderStatus: order?.status ?? null,
        orderStatusText: order ? adminStatusText(order.status) : null,

        auditorId: r.auditorId ?? null,
        auditAt: r.auditAt ? toBjIso(r.auditAt) : null,
        auditRemark: r.auditRemark ?? null,
        wxRefundNo: r.wxRefundNo ?? null,
        refundedAt: r.refundedAt ? toBjIso(r.refundedAt) : null,
        reversed: Number(r.reversed ?? 0) === 1,
        createdAt: toBjIso(r.createdAt),

        /** 按钮可用性口径唯一在服务端（同 D9 的做法） */
        canApprove: isPending,
        canReject: isPending,
        blockReason: isPending
          ? null
          : `当前状态「${REFUND_STATUS_LABEL[r.status] ?? r.status}」不可审批`,
      };
    });
  }

  /** 审批前取单条（供「通过」弹窗二次确认，避免端上自己拼金额） */
  async detail(id: number) {
    const refund = await this.refundRepo.findOne({ where: { id: Number(id) } });
    if (!refund) throw new BizException(ErrorCode.REFUND_NOT_FOUND);
    const [row] = await this.decorate([refund]);
    return row;
  }
}

/** 订单状态（后台视角）中文文案 */
function adminStatusText(status: string): string {
  return ORDER_STATUS_VIEW[status as OrderStatus]?.admin ?? status;
}

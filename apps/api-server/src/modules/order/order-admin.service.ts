import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository, SelectQueryBuilder } from 'typeorm';

import {
  ORDER_STATUS_VIEW,
  OrderStatus,
  REFUND_REASON_LABEL,
  RefundApplySource,
  RefundReasonType,
  RefundStatus,
} from '@abox/shared-types';

import { BizException } from '../../common/exceptions/biz.exception';
import { ErrorCode } from '../../common/constants/error-code';
import { BizConfigService } from '../../common/services/biz-config.service';
import { maskPhone } from '../../common/utils/crypto';
import { money, round2, toFen } from '../../common/utils/money';
import { normalizePage, paginate, PageResult } from '../../common/utils/response';
import { cutoffAtOf, isAfterCutoff, toBjIso } from '../../common/utils/time';
import { Building, BuildingGroup } from '../../database/entities/building.entity';
import { Commission } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { MealAssignment, SetMeal, SetMealItem } from '../../database/entities/meal.entity';
import { Order, PaymentLog, Refund } from '../../database/entities/order.entity';
import { OperationLog } from '../../database/entities/system.entity';
import { Dish, Supplier } from '../../database/entities/supplier.entity';
import { User } from '../../database/entities/user.entity';
import { RefundService } from '../finance/refund.service';
import { adminStatusText, buildTimeline } from './order-state-machine';
import { OrderService } from './order.service';
import { AdminOrdersQueryDto, ManualAdjustDto } from './dto/order-admin.dto';

/**
 * 后台 · 订单中心（《接口规范 v1.0》§6.2 D8–D12 · 原型 P30/P31）
 *
 * ## 与团长侧的边界
 * 团长侧（`LeaderOrderService`）看的是「**我所辖**订单」，手机号一律脱敏，导出才给全号。
 * 后台是**全平台**视图，口径更宽松（可筛楼群/团长/全状态），但**手机号同样脱敏** ——
 * 只有 D12 导出给完整号且必须写操作日志。两处越权与脱敏规则一致，不给后台开后门。
 *
 * ## 「异常订单」的口径（服务端定义，端上不自造）
 * `pending_pay` 待支付超时 + `refund_applying` 退款待审批 + `refunding` 退款处理中。
 * **`cancelled` 不算异常** —— 它是一个正常终态，把它算进去会让这个 Tab 永远噪杂。
 */
@Injectable()
export class OrderAdminService {
  private readonly logger = new Logger('OrderAdminService');

  constructor(
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(Refund) private readonly refundRepo: Repository<Refund>,
    @InjectRepository(PaymentLog) private readonly paymentRepo: Repository<PaymentLog>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    @InjectRepository(BuildingGroup) private readonly groupRepo: Repository<BuildingGroup>,
    @InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>,
    @InjectRepository(SetMeal) private readonly setMealRepo: Repository<SetMeal>,
    @InjectRepository(SetMealItem) private readonly itemRepo: Repository<SetMealItem>,
    @InjectRepository(Dish) private readonly dishRepo: Repository<Dish>,
    @InjectRepository(Supplier) private readonly supplierRepo: Repository<Supplier>,
    @InjectRepository(MealAssignment)
    private readonly assignmentRepo: Repository<MealAssignment>,
    @InjectRepository(Commission) private readonly commissionRepo: Repository<Commission>,
    @InjectRepository(OperationLog) private readonly opLogRepo: Repository<OperationLog>,
    private readonly bizConfig: BizConfigService,
    private readonly refundService: RefundService,
    private readonly orderService: OrderService,
  ) {}

  // ==========================================================================
  // D8 · 全平台订单流
  // ==========================================================================
  async list(q: AdminOrdersQueryDto): Promise<
    PageResult<Record<string, unknown>> & {
      summary: {
        totalCount: number;
        validCount: number;
        validQuantity: number;
        validAmountFen: number;
        abnormalCount: number;
        pendingPayCount: number;
        refundingCount: number;
      };
      tab: 'all' | 'abnormal';
    }
  > {
    const { page, pageSize, skip } = normalizePage(q);
    const tab = q.tab ?? 'all';

    const base = this.buildQuery(q, tab);
    const [rows, total] = await base
      .clone()
      .orderBy('o.mealDate', 'DESC')
      .addOrderBy('o.id', 'DESC')
      .skip(skip)
      .take(pageSize)
      .getManyAndCount();

    // 汇总按**同一过滤条件的全量**统计（不受分页影响）—— 与 L10/L19 同一约定
    const all = await base.clone().orderBy('o.id', 'ASC').getMany();
    const valid = all.filter((o) => !INVALID_FOR_SUMMARY.includes(o.status));

    const summary = {
      totalCount: all.length,
      validCount: valid.length,
      validQuantity: valid.reduce((s, o) => s + Number(o.quantity || 0), 0),
      validAmountFen: valid.reduce((s, o) => s + toFen(Number(o.totalAmount)), 0),
      abnormalCount: all.filter((o) => ABNORMAL_STATUSES.includes(o.status)).length,
      pendingPayCount: all.filter((o) => o.status === OrderStatus.PENDING_PAY).length,
      refundingCount: all.filter((o) =>
        [OrderStatus.REFUND_APPLYING, OrderStatus.REFUNDING].includes(o.status as OrderStatus),
      ).length,
    };

    return {
      ...paginate(await this.decorate(rows), total, page, pageSize),
      summary,
      tab,
    };
  }

  // ==========================================================================
  // D9 · 订单详情 + 操作日志
  // ==========================================================================
  async detail(orderNo: string) {
    const order = await this.orderRepo.findOne({ where: { orderNo } });
    if (!order) throw new BizException(ErrorCode.ORDER_NOT_FOUND);

    const [decorated] = await this.decorate([order], true);
    const [items, refund, payment, logs, leader, commission] = await Promise.all([
      this.itemRepo.find({ where: { setMealId: order.setMealId }, order: { slot: 'ASC' } }),
      this.refundRepo.findOne({ where: { orderId: Number(order.id) }, order: { id: 'DESC' } }),
      this.paymentRepo.findOne({ where: { orderId: Number(order.id) }, order: { id: 'DESC' } }),
      this.opLogRepo.find({
        where: { module: 'order', targetId: orderNo },
        order: { id: 'DESC' },
        take: 50,
      }),
      order.teamLeaderId
        ? this.leaderRepo.findOne({ where: { id: Number(order.teamLeaderId) } })
        : Promise.resolve(null),
      this.commissionRepo.find({ where: { orderId: Number(order.id) }, order: { id: 'ASC' } }),
    ]);

    const dishNames = new Map(
      (await this.dishRepo.find({ where: { id: In(items.map((i) => i.dishId).concat([0])) } })).map(
        (d) => [Number(d.id), d.name],
      ),
    );
    const supNames = new Map(
      (
        await this.supplierRepo.find({
          where: { id: In([...new Set(items.map((i) => i.supplierId))].concat([0])) },
        })
      ).map((s) => [Number(s.id), s.name]),
    );

    const timeline = buildTimeline({
      status: order.status,
      paidAt: order.paidAt,
      completedAt: order.completedAt,
      cancelledAt: order.cancelledAt,
      cutoffAt: cutoffAtOf(order.mealDate),
      createdAt: order.createdAt,
    }).map((n) => ({ node: n.node, at: toBjIso(n.at), done: n.done, text: n.text }));

    const refundableFen = toFen(round2(Number(order.totalAmount) - Number(order.discountAmount)));

    return {
      order: decorated,
      dishes: items.map((i) => ({
        slot: i.slot,
        slotLabel: SLOT_LABEL[i.slot] ?? `档位 ${i.slot}`,
        dishId: Number(i.dishId),
        name: dishNames.get(Number(i.dishId)) ?? `菜品 ${i.dishId}`,
        supplierId: Number(i.supplierId),
        supplierName: supNames.get(Number(i.supplierId)) ?? null,
        shareAmountFen: i.shareAmount != null ? toFen(Number(i.shareAmount)) : null,
      })),
      timeline,
      refund: refund
        ? {
            refundNo: refund.refundNo,
            status: refund.status,
            statusText: REFUND_STATUS_TEXT[refund.status] ?? refund.status,
            amountFen: toFen(Number(refund.amount)),
            applySource: refund.applySource,
            applySourceText: APPLY_SOURCE_TEXT[refund.applySource] ?? refund.applySource,
            reasonType: refund.reasonType ?? null,
            reasonTypeText: refund.reasonType
              ? (REFUND_REASON_LABEL[refund.reasonType as RefundReasonType] ?? refund.reasonType)
              : null,
            reason: refund.reason ?? null,
            teamLeaderId: refund.teamLeaderId ?? null,
            auditorId: refund.auditorId ?? null,
            auditAt: toBjIso(refund.auditAt),
            auditRemark: refund.auditRemark ?? null,
            wxRefundNo: refund.wxRefundNo ?? null,
            refundedAt: toBjIso(refund.refundedAt),
            reversed: Number(refund.reversed) === 1,
            createdAt: toBjIso(refund.createdAt),
          }
        : null,
      payment: payment
        ? {
            transactionId: payment.transactionId ?? null,
            payMethod: payment.payMethod,
            amountFen: toFen(Number(payment.payAmount)),
            status: payment.status,
            paidAt: toBjIso(payment.paidAt),
          }
        : null,
      commission: commission.map((c) => ({
        id: Number(c.id),
        type: c.type,
        status: c.status,
        leaderId: Number(c.teamLeaderId),
        leaderLevel: c.leaderLevel,
        rate: Number(c.rate),
        baseAmountFen: toFen(Number(c.baseAmount)),
        quantity: Number(c.quantity),
        amountFen: toFen(Number(c.amount)),
        mealDate: c.mealDate,
        settledAt: toBjIso(c.settledAt),
      })),
      leader: leader
        ? {
            id: Number(leader.id),
            name: leader.realName ?? null,
            phoneMasked: maskPhone(leader.phone),
            level: leader.level,
            commissionRate: Number(leader.commissionRate),
            status: Number(leader.status),
          }
        : null,
      /** 端上据此置灰按钮并显示原因 —— 口径唯一在服务端，不由前端各判一套 */
      actions: {
        canAdjust: this.adjustBlockReason(order) === null,
        adjustBlockReason: this.adjustBlockReason(order),
        canForceRefund: this.refundBlockReason(order) === null,
        refundBlockReason: this.refundBlockReason(order),
        refundableFen,
      },
      operationLogs: logs.map((l) => ({
        id: Number(l.id),
        adminUserId: l.adminUserId ?? null,
        operator: (l.snapshot as { operator?: string } | null)?.operator ?? null,
        action: l.action,
        requestIp: l.requestIp ?? null,
        requestData: l.requestData ?? null,
        responseData: l.responseData ?? null,
        createdAt: toBjIso(l.createdAt),
      })),
    };
  }

  // ==========================================================================
  // D10 · 手动改单
  // ==========================================================================
  /**
   * ## 一期口径（把「不能做什么」也讲清楚）
   *
   * | 动作 | 允许的状态 | 原因 |
   * |---|---|---|
   * | `change_quantity` | **仅 `pending_pay`** | 已支付的订单改份数 = 补收或退款，那是**支付通道动作**，不是改单。一期不做部分退款 / 补收，故拦住并引导「先退款重下单」 |
   * | `change_building` | `pending_pay` / `paid` | 只改取餐楼，不涉金额。**目标楼必须与原楼同楼群**（楼群决定套餐分配与集散，跨楼群换楼等于换了一套履约） |
   *
   * 两者都要求**未过截单**（过点后供应商已按原份数备货，再改会让备货与单据对不上 → `30014`）。
   * 改单**不改用户的归属楼**（`ab_user.building_id` 是长期属性，这一单的取餐地是短期事实）。
   */
  async manualAdjust(dto: ManualAdjustDto, operatorId: number) {
    const order = await this.orderRepo.findOne({ where: { orderNo: dto.orderNo } });
    if (!order) throw new BizException(ErrorCode.ORDER_NOT_FOUND);

    const block = this.adjustBlockReason(order, dto.action);
    if (block) {
      throw new BizException(
        block.startsWith('已过截单')
          ? ErrorCode.ORDER_ADJUST_AFTER_CUTOFF
          : ErrorCode.ORDER_STATUS_ILLEGAL,
        block,
      );
    }

    const before = {
      quantity: Number(order.quantity),
      buildingId: Number(order.buildingId),
      totalAmountFen: toFen(Number(order.totalAmount)),
      balanceUsedFen: toFen(Number(order.balanceUsed)),
      payAmountFen: toFen(Number(order.payAmount)),
      status: order.status,
    };

    if (dto.action === 'change_quantity') {
      const quantity = Number(dto.quantity);
      const maxQty = await this.bizConfig.maxQuantity();
      if (quantity > maxQty) {
        throw new BizException(ErrorCode.QUANTITY_EXCEED, `份数上限为 ${maxQty}`);
      }

      const unitPriceFen = toFen(Number(order.unitPrice));
      const totalAmountFen = unitPriceFen * quantity;
      // 抵扣额不得超过新总额；只可能变小（份数变少），故冻结额只会解冻
      const balanceUsedFen = Math.min(toFen(Number(order.balanceUsed)), totalAmountFen);
      const payAmountFen = totalAmountFen - balanceUsedFen;

      const frozenDelta = await this.orderService.syncFrozenBalance(
        Number(order.id),
        balanceUsedFen,
      );
      await this.orderRepo.update(
        { id: order.id },
        {
          quantity,
          totalAmount: money(totalAmountFen / 100),
          payAmount: money(payAmountFen / 100),
          version: (order.version ?? 0) + 1,
        },
      );

      this.logger.log(
        `运营#${operatorId} 改单 ${order.orderNo}：份数 ${before.quantity} → ${quantity}` +
          `（总额 ${before.totalAmountFen} → ${totalAmountFen} 分 · 冻结调整 ${frozenDelta} 分）` +
          ` 原因：${dto.reason}`,
      );

      return {
        orderNo: order.orderNo,
        action: dto.action,
        reason: dto.reason,
        changed: before.quantity !== quantity,
        before,
        after: { quantity, balanceUsedFen, totalAmountFen, payAmountFen },
        frozenDeltaFen: frozenDelta,
        tips:
          payAmountFen > 0
            ? `订单金额已更新为 ¥${money(payAmountFen / 100)}，用户按新金额支付`
            : '余额已全额覆盖，订单将直接完成支付',
      };
    }

    // change_building
    const target = await this.buildingRepo.findOne({
      where: { id: Number(dto.buildingId) },
    });
    if (!target) throw new BizException(ErrorCode.NOT_FOUND, '目标办公楼不存在');
    if (Number(target.buildingGroupId) !== Number(order.buildingGroupId)) {
      throw new BizException(
        ErrorCode.ORDER_ADJUST_CROSS_GROUP,
        `「${target.name}」与原办公楼不在同一楼群 —— 跨楼群改单会连套餐与集散一起变，` +
          '请改走「取消 + 重新下单」',
      );
    }

    await this.orderRepo.update(
      { id: order.id },
      { buildingId: Number(target.id), version: (order.version ?? 0) + 1 },
    );

    this.logger.log(
      `运营#${operatorId} 改单 ${order.orderNo}：取餐楼 ${before.buildingId} → ${target.id}` +
        `（${target.name}）原因：${dto.reason}`,
    );

    return {
      orderNo: order.orderNo,
      action: dto.action,
      reason: dto.reason,
      changed: before.buildingId !== Number(target.id),
      before,
      after: { buildingId: Number(target.id), buildingName: target.name },
      frozenDeltaFen: 0,
      tips: '取餐地址已变更，请同步通知用户与团长',
    };
  }

  // ==========================================================================
  // D11 · 后台强制退款（委托 RefundService，本处只做「订单视角」的包装）
  // ==========================================================================
  async forceRefund(
    orderNo: string,
    input: { reason: string; reasonType?: string; amountFen?: number },
    operatorId: number,
  ) {
    return this.refundService.forceRefund(orderNo, input, operatorId);
  }

  // ==========================================================================
  // D12 · 导出（完整手机号 + 强制留痕）
  // ==========================================================================
  /**
   * 出参为「表头 + 二维数组」而非二进制 xlsx —— 与团长侧 L5 同一约定：
   * 端上据表头拼 CSV，服务端不引入 exceljs（省一个依赖，也避免服务端内存里
   * 多一份含全量手机号的中间件）。
   */
  async exportOrders(q: AdminOrdersQueryDto, operatorId: number, ip?: string) {
    const rows = await this.buildQuery(q, q.tab ?? 'all')
      .orderBy('o.mealDate', 'ASC')
      .addOrderBy('o.id', 'ASC')
      .take(EXPORT_MAX_ROWS)
      .getMany();

    const decorated = await this.decorate(rows, true);
    const userIdOf = new Map(rows.map((r) => [r.orderNo, Number(r.userId)]));
    const users = new Map(
      (
        await this.userRepo.find({
          where: { id: In([...new Set(rows.map((r) => Number(r.userId)))].concat([0])) },
        })
      ).map((u) => [Number(u.id), u]),
    );

    await this.opLogRepo.save(
      this.opLogRepo.create({
        adminUserId: operatorId,
        module: 'order',
        action: '导出订单明细',
        targetId: q.mealDate ?? `${q.startDate ?? '不限'}~${q.endDate ?? '不限'}`,
        requestIp: ip ?? null,
        requestData: {
          mealDate: q.mealDate ?? null,
          startDate: q.startDate ?? null,
          endDate: q.endDate ?? null,
          buildingId: q.buildingId ?? null,
          groupId: q.groupId ?? null,
          leaderId: q.leaderId ?? null,
          status: q.status ?? null,
          tab: q.tab ?? 'all',
        },
        responseData: { count: decorated.length },
        snapshot: {
          exportedPhoneCount: rows.filter((r) => users.get(Number(r.userId))?.phone).length,
        },
      }),
    );
    this.logger.warn(`运营#${operatorId} 导出订单明细（含完整手机号）共 ${rows.length} 条`);

    const fileName = q.mealDate
      ? `ABox_订单明细_${q.mealDate}.csv`
      : `ABox_订单明细_${q.startDate ?? '起始'}~${q.endDate ?? '至今'}.csv`;

    return {
      fileName,
      count: decorated.length,
      /** 超过上限时截断，端上据此提示运营缩小范围 */
      truncated: decorated.length >= EXPORT_MAX_ROWS,
      headers: [
        '订单号',
        '出餐日',
        '用户昵称',
        '手机号',
        '办公楼',
        '楼群',
        '团长',
        '份数',
        '单价(元)',
        '总额(元)',
        '余额抵扣(元)',
        '微信实付(元)',
        '状态',
        '备注',
        '下单时间',
        '支付时间',
      ],
      list: decorated.map((v) => [
        v.orderNo,
        v.mealDate,
        v.userName ?? '',
        users.get(userIdOf.get(v.orderNo as string) ?? 0)?.phone ?? '',
        v.buildingName ?? '',
        v.groupName ?? '',
        v.leaderName ?? '',
        String(v.quantity),
        (Number(v.unitPriceFen) / 100).toFixed(2),
        (Number(v.totalAmountFen) / 100).toFixed(2),
        (Number(v.balanceUsedFen) / 100).toFixed(2),
        (Number(v.payAmountFen) / 100).toFixed(2),
        v.statusText,
        v.remark ?? '',
        formatBj(v.createdAt as string),
        v.paidAt ? formatBj(v.paidAt as string) : '',
      ]),
    };
  }

  // ==========================================================================
  // 筛选项（D8/D12 前置数据源 · 只读）
  // ==========================================================================
  /**
   * 楼群 / 办公楼 / 团长下拉
   *
   * ⚠️ 为什么放在订单中心而不是等 3.5（团长名录）/ 3.7（办公楼管理）：
   *    订单列表的核心筛选就是「哪个楼群、哪栋楼、哪个团长」—— 没有这三项，
   *    P30 只剩一个能翻页的全量表。**管理**这些对象属于那两批，
   *    这里只要**能选**；与套餐批次提供 `/admin/meal/dishes` 选择器同一取舍。
   */
  async filterOptions() {
    const [groups, buildings, leaders] = await Promise.all([
      this.groupRepo.find({ order: { id: 'ASC' } }),
      this.buildingRepo.find({ where: { status: 1 }, order: { id: 'ASC' } }),
      this.leaderRepo.find({ order: { id: 'ASC' } }),
    ]);

    return {
      groups: groups.map((g) => ({ id: Number(g.id), name: g.name, status: Number(g.status) })),
      buildings: buildings.map((b) => ({
        id: Number(b.id),
        name: b.name,
        groupId: b.buildingGroupId != null ? Number(b.buildingGroupId) : null,
      })),
      leaders: leaders.map((l) => ({
        id: Number(l.id),
        name: l.realName ?? `团长 ${l.id}`,
        buildingId: l.buildingId != null ? Number(l.buildingId) : null,
        level: l.level,
        status: Number(l.status),
      })),
      statuses: ADMIN_ORDER_STATUS_OPTIONS,
    };
  }

  // ==========================================================================
  // 私有
  // ==========================================================================

  /** 过滤条件（D8 与 D12 共用，保证「导出的是你筛出来的那批」） */
  private buildQuery(q: AdminOrdersQueryDto, tab: 'all' | 'abnormal'): SelectQueryBuilder<Order> {
    const qb = this.orderRepo.createQueryBuilder('o');

    if (q.mealDate) qb.andWhere('o.mealDate = :mealDate', { mealDate: q.mealDate });
    else if (q.startDate && q.endDate) {
      qb.andWhere('o.mealDate BETWEEN :from AND :to', { from: q.startDate, to: q.endDate });
    } else if (q.startDate) {
      qb.andWhere('o.mealDate >= :from', { from: q.startDate });
    } else if (q.endDate) {
      qb.andWhere('o.mealDate <= :to', { to: q.endDate });
    }

    if (q.buildingId) qb.andWhere('o.buildingId = :bid', { bid: q.buildingId });
    if (q.groupId) qb.andWhere('o.buildingGroupId = :gid', { gid: q.groupId });
    if (q.leaderId) qb.andWhere('o.teamLeaderId = :lid', { lid: q.leaderId });
    if (q.status) qb.andWhere('o.status = :st', { st: q.status });

    if (q.keyword?.trim()) {
      const kw = `%${q.keyword.trim()}%`;
      // 关键词命中订单号，或命中下单用户的昵称（昵称要子查询，无法只靠 o.* 表达）
      qb.andWhere(
        new Brackets((w) => {
          w.where('o.orderNo LIKE :kw', { kw }).orWhere(
            'o.userId IN (SELECT u.id FROM ab_user u WHERE u.nickname LIKE :kw)',
            { kw },
          );
        }),
      );
    }

    if (tab === 'abnormal') {
      qb.andWhere('o.status IN (:...ab)', { ab: ABNORMAL_STATUSES });
    }
    return qb;
  }

  /** 批量补齐关联信息（避免 N+1），并按需挂上退款单状态 */
  private async decorate(rows: Order[], withUserId = false): Promise<Record<string, unknown>[]> {
    if (!rows.length) return [];

    const userIds = [...new Set(rows.map((r) => Number(r.userId)))].concat([0]);
    const buildingIds = [...new Set(rows.map((r) => Number(r.buildingId)))].concat([0]);
    const groupIds = [...new Set(rows.map((r) => Number(r.buildingGroupId)))].concat([0]);
    const leaderIds = [...new Set(rows.map((r) => Number(r.teamLeaderId)).filter(Boolean))].concat([
      0,
    ]);
    const setMealIds = [...new Set(rows.map((r) => Number(r.setMealId)))].concat([0]);
    const orderIds = rows.map((r) => Number(r.id));

    const [users, buildings, groups, leaders, setMeals, refunds, items] = await Promise.all([
      this.userRepo.find({ where: { id: In(userIds) } }),
      this.buildingRepo.find({ where: { id: In(buildingIds) } }),
      this.groupRepo.find({ where: { id: In(groupIds) } }),
      this.leaderRepo.find({ where: { id: In(leaderIds) } }),
      this.setMealRepo.find({ where: { id: In(setMealIds) } }),
      this.refundRepo.find({ where: { orderId: In(orderIds) }, order: { id: 'DESC' } }),
      this.itemRepo.find({ where: { setMealId: In(setMealIds), slot: 1 } }),
    ]);

    const dishNames = new Map(
      (
        await this.dishRepo.find({
          where: { id: In(items.map((i) => i.dishId).concat([0])) },
        })
      ).map((d) => [Number(d.id), d.name]),
    );

    const userMap = new Map(users.map((u) => [Number(u.id), u]));
    const buildingMap = new Map(buildings.map((b) => [Number(b.id), b]));
    const groupMap = new Map(groups.map((g) => [Number(g.id), g]));
    const leaderMap = new Map(leaders.map((l) => [Number(l.id), l]));
    const setMealMap = new Map(setMeals.map((s) => [Number(s.id), s]));
    const mainDishMap = new Map(
      items.map((i) => [Number(i.setMealId), dishNames.get(Number(i.dishId)) ?? null]),
    );
    // 一单多条退款时取最新那条（order by id DESC，先到先占）
    const refundMap = new Map<number, Refund>();
    for (const r of refunds)
      if (!refundMap.has(Number(r.orderId))) refundMap.set(Number(r.orderId), r);

    return rows.map((o) => {
      const u = userMap.get(Number(o.userId));
      const r = refundMap.get(Number(o.id));
      return {
        orderNo: o.orderNo,
        mealDate: o.mealDate,
        status: o.status,
        statusText: adminStatusText(o.status),
        quantity: Number(o.quantity),
        unitPriceFen: toFen(Number(o.unitPrice)),
        totalAmountFen: toFen(Number(o.totalAmount)),
        balanceUsedFen: toFen(Number(o.balanceUsed)),
        payAmountFen: toFen(Number(o.payAmount)),
        userName: u?.nickname ?? null,
        /** ⚠️ 后台列表同样脱敏（只有 D12 导出给全号） */
        phoneMasked: maskPhone(u?.phone),
        ...(withUserId ? { userId: Number(o.userId) } : {}),
        buildingId: Number(o.buildingId),
        buildingName: buildingMap.get(Number(o.buildingId))?.name ?? null,
        groupId: Number(o.buildingGroupId),
        groupName: groupMap.get(Number(o.buildingGroupId))?.name ?? null,
        leaderId: o.teamLeaderId ? Number(o.teamLeaderId) : null,
        leaderName: o.teamLeaderId
          ? (leaderMap.get(Number(o.teamLeaderId))?.realName ?? null)
          : null,
        setMealId: Number(o.setMealId),
        setMealName: setMealMap.get(Number(o.setMealId))?.name ?? null,
        mainDishName: mainDishMap.get(Number(o.setMealId)) ?? null,
        remark: o.remark ?? null,
        createdAt: toBjIso(o.createdAt),
        paidAt: toBjIso(o.paidAt),
        completedAt: toBjIso(o.completedAt),
        refund: r
          ? {
              refundNo: r.refundNo,
              status: r.status,
              statusText: REFUND_STATUS_TEXT[r.status] ?? r.status,
              amountFen: toFen(Number(r.amount)),
              applySource: r.applySource,
              applySourceText: APPLY_SOURCE_TEXT[r.applySource] ?? r.applySource,
            }
          : null,
      };
    });
  }

  /** 改单闸门；返回 null 表示可改，否则返回**给运营看的原因** */
  private adjustBlockReason(order: Order, action?: string): string | null {
    if (isAfterCutoff(order.mealDate)) {
      return `已过截单时刻（${order.mealDate} 00:00），供应商已按原份数备货，不能再改单`;
    }
    const status = order.status as OrderStatus;
    if (status === OrderStatus.PENDING_PAY) return null;
    if (status === OrderStatus.PAID) {
      if (action === 'change_quantity') {
        return '订单已支付：改份数涉及补收或退款（支付通道动作，一期不支持）。请先强制退款，让用户重新下单';
      }
      return null;
    }
    return `当前状态「${adminStatusText(order.status)}」不支持改单`;
  }

  /** 强制退款闸门；返回 null 表示可退 */
  private refundBlockReason(order: Order): string | null {
    const status = order.status as OrderStatus;
    if (status === OrderStatus.REFUND_APPLYING) {
      return '该订单已有团长代退申请，请走「退款审批」处理';
    }
    if (status === OrderStatus.REFUNDING) return '退款处理中，请等待通道结果';
    if (status === OrderStatus.REFUNDED) return '订单已退款';
    if (status === OrderStatus.CANCELLED) return '订单已取消，无可退金额';
    if (status === OrderStatus.PENDING_PAY) return '订单未支付，无可退金额';
    return null;
  }
}

/** 「异常订单」Tab 口径 —— 见类注释。`cancelled` 刻意不在其中 */
const ABNORMAL_STATUSES: string[] = [
  OrderStatus.PENDING_PAY,
  OrderStatus.REFUND_APPLYING,
  OrderStatus.REFUNDING,
];

/** 汇总口径剔除的终态（已取消 / 已退款不算有效营收） */
const INVALID_FOR_SUMMARY: string[] = [OrderStatus.CANCELLED, OrderStatus.REFUNDED];

/** 导出上限：一次最多导这么多行，超出截断并提示（防把内存拉爆） */
const EXPORT_MAX_ROWS = 5000;

const SLOT_LABEL: Record<number, string> = {
  1: '主荤',
  2: '半荤',
  3: '素菜',
  4: '汤',
  5: '主食',
};

const REFUND_STATUS_TEXT: Record<string, string> = {
  [RefundStatus.APPLYING]: '待审批',
  [RefundStatus.APPROVED]: '已批准',
  [RefundStatus.REFUNDING]: '退款中',
  [RefundStatus.REFUNDED]: '已退款',
  [RefundStatus.REJECTED]: '已驳回',
  [RefundStatus.FAILED]: '退款失败',
};

const APPLY_SOURCE_TEXT: Record<string, string> = {
  [RefundApplySource.USER]: '用户自助',
  [RefundApplySource.LEADER]: '团长代退',
  [RefundApplySource.ADMIN]: '后台强制',
};

/** 北京时间 yyyy-MM-dd HH:mm（导出用，入参是 `toBjIso` 产出的 `+08:00` 串） */
function formatBj(iso: string): string {
  return String(iso).slice(0, 16).replace('T', ' ');
}

/** 状态文案表（供端上落格用，与 `ORDER_STATUS_VIEW.admin` 同源） */
export const ADMIN_ORDER_STATUS_OPTIONS = Object.entries(ORDER_STATUS_VIEW).map(([value, v]) => ({
  value,
  label: v.admin,
}));

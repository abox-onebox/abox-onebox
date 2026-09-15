import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not, Repository } from 'typeorm';

import type {
  CancelOrderResult,
  CreateOrderResult,
  OrderDetailResult,
  OrderListItem,
  OrderTimelineNode,
} from '@abox/shared-types';
import { OrderStatus } from '@abox/shared-types';
import { PAGE_DEFAULT } from '@abox/shared-types';
import { LeaderStatus } from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { BizConfigService } from '../../common/services/biz-config.service';
import { maskPhone } from '../../common/utils/crypto';
import { genOrderNo, genRefundNo } from '../../common/utils/order-no';
import { normalizePage, paginate, PageResult } from '../../common/utils/response';
import {
  cutoffAtOf,
  isAfterCutoff,
  isOrderable,
  payExpireAt,
  toBjIso,
  tomorrowBj,
} from '../../common/utils/time';
import { Building } from '../../database/entities/building.entity';
import { Balance, BalanceLog } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { MealAssignment, SetMealItem } from '../../database/entities/meal.entity';
import { Order, PaymentLog, Refund } from '../../database/entities/order.entity';
import { Dish, Supplier } from '../../database/entities/supplier.entity';
import { User } from '../../database/entities/user.entity';
import { WX_PAY_PROVIDER, WxPayProvider } from '../../providers/wx-pay/wx-pay.provider';
import { buildTimeline, explainSelfCancelBlock, userStatusText } from './order-state-machine';
import { CreateOrderReqDto } from './dto/order.dto';

/** 元 → 分（金额跨层只在 service 边界换算一次） */
const toFen = (yuan: number | string): number => Math.round(Number(yuan) * 100);
/** 分 → 元（两位小数字符串，落 DECIMAL 列） */
const toYuanStr = (fen: number): string => (fen / 100).toFixed(2);

/**
 * 订单服务
 *
 * 覆盖《接口规范 v1.0》：U6 创建订单、U9 订单列表、U10 订单详情、U11 自助取消
 * 状态机依据《订单状态机与全链路流转 v1.0》§二（T1/T3/T4）
 *
 * 幂等（§1.4）分两层：
 *   ① 传输层 —— `Idempotency-Key` 请求头（IdempotentInterceptor，10 分钟内重复即回放首次结果）
 *   ② 业务层 —— 「同用户 + 同出餐日」唯一订单（DB 查重 → `30004`），兜住端上漏传幂等键的情况
 */
@Injectable()
export class OrderService {
  private readonly logger = new Logger('OrderService');

  constructor(
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(PaymentLog) private readonly paymentLogRepo: Repository<PaymentLog>,
    @InjectRepository(Refund) private readonly refundRepo: Repository<Refund>,
    @InjectRepository(Balance) private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    @InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>,
    @InjectRepository(MealAssignment)
    private readonly assignmentRepo: Repository<MealAssignment>,
    @InjectRepository(SetMealItem) private readonly itemRepo: Repository<SetMealItem>,
    @InjectRepository(Dish) private readonly dishRepo: Repository<Dish>,
    @InjectRepository(Supplier) private readonly supplierRepo: Repository<Supplier>,
    private readonly dataSource: DataSource,
    private readonly bizConfig: BizConfigService,
    @Inject(WX_PAY_PROVIDER) private readonly wxPay: WxPayProvider,
  ) {}

  // ==========================================================================
  // U6 · 创建订单
  // 校验顺序严格对照《接口规范》§3.3：canOrder → 份数 → 团长 → 余额 → 落库
  // ==========================================================================
  async create(userId: number, dto: CreateOrderReqDto): Promise<CreateOrderResult> {
    const mealDate = dto.mealDate ?? tomorrowBj();

    const [cutoffWindow, maxQty, unitPriceYuan, payTimeout] = await Promise.all([
      this.bizConfig.cutoffWindowMinutes(),
      this.bizConfig.maxQuantity(),
      this.bizConfig.unitPriceYuan(),
      this.bizConfig.payTimeoutMinutes(),
    ]);

    // ① 截单窗口（canOrder）→ 30001
    if (!isOrderable(mealDate, cutoffWindow)) {
      throw new BizException(ErrorCode.ORDER_CUTOFF, `${mealDate} 今日 24:00 已截单，明日请早`);
    }

    // ② 份数 1–N（上限读 ab_config）→ 30002
    if (!Number.isInteger(dto.quantity) || dto.quantity < 1 || dto.quantity > maxQty) {
      throw new BizException(
        ErrorCode.QUANTITY_EXCEED,
        `份数需在 1–${maxQty} 之间（当前 ${dto.quantity}）`,
      );
    }

    // ③ 余额抵扣合法性（整数分、非负）→ 30006
    const useBalanceFen = dto.useBalanceFen ?? 0;
    if (!Number.isInteger(useBalanceFen) || useBalanceFen < 0) {
      throw new BizException(ErrorCode.BALANCE_AMOUNT_INVALID);
    }

    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BizException(ErrorCode.USER_NOT_FOUND);

    // ④ 团长归属（邀请码优先，回落用户默认绑定）→ 30007
    const leader = await this.resolveLeader(dto.leaderCode, user);

    // ⑤ 楼群与分配矩阵命中 → 30005
    const buildingGroupId = await this.resolveGroup(user);
    const assignment = await this.assignmentRepo.findOne({
      where: { mealDate, buildingGroupId },
    });
    if (!assignment || assignment.status !== 'active') {
      throw new BizException(ErrorCode.MEAL_NOT_PUBLISHED, `${mealDate} 该办公楼未开团`);
    }

    // ⑥ 同用户同出餐日重复下单 → 30004（业务层幂等兜底）
    const duplicated = await this.orderRepo.findOne({
      where: { userId, mealDate, status: Not(OrderStatus.CANCELLED) },
      order: { id: 'DESC' },
    });
    if (duplicated) {
      throw new BizException(
        ErrorCode.DUPLICATE_ORDER,
        `你已提交过 ${mealDate} 的订单（${duplicated.orderNo}），请勿重复下单`,
      );
    }

    // ⑦ 金额计算：元为业务口径，落库 DECIMAL(10,2)
    const unitPriceStr = unitPriceYuan.toFixed(2);
    const totalAmountFen = toFen(unitPriceYuan * dto.quantity);
    const balanceUsedFen = useBalanceFen;

    if (balanceUsedFen > totalAmountFen) {
      // 抵扣不得超过订单总额（超出的部分无意义，且会让实付为负）
      throw new BizException(ErrorCode.BALANCE_AMOUNT_INVALID, '余额抵扣不得超过订单总额');
    }
    const payAmountFen = totalAmountFen - balanceUsedFen;

    const now = new Date();
    const orderNo = genOrderNo(now);

    // ⑧ 落库 + 冻结余额（同一事务，避免「订单建成但余额没冻」）
    const order = await this.dataSource.transaction(async (m: EntityManager) => {
      if (balanceUsedFen > 0) {
        const bal = await this.getOrCreateBalance(m, userId);
        if (toFen(bal.balance) < balanceUsedFen) {
          // ⑤/④ 的余额校验 → 40002
          throw new BizException(
            ErrorCode.BALANCE_NOT_ENOUGH,
            `可用余额 ¥${bal.balance} 不足抵扣 ¥${toYuanStr(balanceUsedFen)}`,
          );
        }
        await this.freezeBalance(m, userId, balanceUsedFen, orderNo);
      }

      const entity = m.getRepository(Order).create({
        orderNo,
        userId,
        teamLeaderId: leader.id,
        buildingId: user.buildingId!,
        buildingGroupId,
        setMealId: assignment.setMealId,
        assignmentId: assignment.id,
        mealDate,
        quantity: dto.quantity,
        unitPrice: unitPriceStr,
        totalAmount: toYuanStr(totalAmountFen),
        balanceUsed: toYuanStr(balanceUsedFen),
        discountAmount: '0.00',
        payAmount: toYuanStr(payAmountFen),
        remark: dto.remark ?? null,
        status: OrderStatus.PENDING_PAY,
        version: 0,
      });
      return m.getRepository(Order).save(entity);
    });

    const expireAt = payExpireAt(order.createdAt ?? now, payTimeout);

    // ⑨ 全额余额支付（实付 0 分）：无微信收款环节，直接入账转 `paid`
    //    否则订单会永远停在 pending_pay —— 端上无「需支付金额」可付。
    let finalStatus: string = order.status;
    if (payAmountFen === 0) {
      await this.markPaid(order.orderNo, `BALANCE_${order.orderNo}`, 0, {
        via: 'balance_full_settle',
      });
      finalStatus = OrderStatus.PAID;
    }

    this.logger.log(
      `下单成功 orderNo=${orderNo} user=${userId} mealDate=${mealDate} ×${dto.quantity} ` +
        `总额=${totalAmountFen}分 余额抵扣=${balanceUsedFen}分 实付=${payAmountFen}分 ` +
        `状态=${finalStatus}`,
    );

    return {
      orderNo: order.orderNo,
      mealDate: order.mealDate,
      quantity: order.quantity,
      status: finalStatus,
      unitPriceFen: toFen(order.unitPrice),
      totalAmountFen: toFen(order.totalAmount),
      balanceUsedFen: toFen(order.balanceUsed),
      payAmountFen: toFen(order.payAmount),
      expireAt: toBjIso(expireAt)!,
    };
  }

  /** 订单实付金额（分）；供支付调试端点复用 */
  async payAmountFenOf(orderNo: string): Promise<number> {
    const order = await this.orderRepo.findOne({ where: { orderNo } });
    if (!order) throw new BizException(ErrorCode.ORDER_NOT_FOUND);
    return toFen(order.payAmount);
  }

  // ==========================================================================
  // U9 · 订单列表
  // ==========================================================================
  async list(
    userId: number,
    query: { status?: string; page?: unknown; pageSize?: unknown },
  ): Promise<PageResult<OrderListItem>> {
    const { page, pageSize, skip } = normalizePage(query);

    const where: Record<string, unknown> = { userId };
    if (query.status) where.status = query.status;

    const [rows, total] = await this.orderRepo.findAndCount({
      where,
      order: { mealDate: 'DESC', id: 'DESC' },
      skip,
      take: pageSize,
    });

    const mainDish = await this.mainDishNameMap(rows);

    const list: OrderListItem[] = rows.map((o) => ({
      orderNo: o.orderNo,
      status: o.status,
      statusText: userStatusText(o.status),
      mealDate: o.mealDate,
      quantity: o.quantity,
      unitPriceFen: toFen(o.unitPrice),
      totalAmountFen: toFen(o.totalAmount),
      mainDishName: mainDish.get(o.setMealId) ?? null,
      createdAt: toBjIso(o.createdAt)!,
    }));

    return paginate(list, total, page, pageSize);
  }

  // ==========================================================================
  // U10 · 订单详情（含状态机时间线）
  // ==========================================================================
  async detail(userId: number, orderNo: string): Promise<OrderDetailResult> {
    const order = await this.loadOwnOrder(userId, orderNo);

    const [items, leader] = await Promise.all([
      this.itemRepo.find({ where: { setMealId: order.setMealId }, order: { slot: 'ASC' } }),
      order.teamLeaderId
        ? this.leaderRepo.findOne({ where: { id: order.teamLeaderId } })
        : Promise.resolve(null),
    ]);

    const dishNames = new Map(
      (
        await this.dishRepo.find({
          where: { id: In(items.map((i) => i.dishId).concat([0])) },
        })
      ).map((d) => [d.id, d.name]),
    );
    const supNames = new Map(
      (
        await this.supplierRepo.find({
          where: { id: In([...new Set(items.map((i) => i.supplierId))].concat([0])) },
        })
      ).map((s) => [s.id, s.name]),
    );

    const building = order.teamLeaderId
      ? await this.buildingRepo.findOne({ where: { id: order.buildingId } })
      : null;

    const timeline: OrderTimelineNode[] = buildTimeline({
      status: order.status,
      paidAt: order.paidAt,
      completedAt: order.completedAt,
      cancelledAt: order.cancelledAt,
      cutoffAt: cutoffAtOf(order.mealDate),
      createdAt: order.createdAt,
    }).map((n) => ({ node: n.node, at: toBjIso(n.at), done: n.done, text: n.text }));

    const leaderContact = leader
      ? { name: leader.realName ?? null, phone: maskPhone(leader.phone) }
      : null;

    return {
      orderNo: order.orderNo,
      status: order.status,
      statusText: userStatusText(order.status),
      mealDate: order.mealDate,
      quantity: order.quantity,
      unitPriceFen: toFen(order.unitPrice),
      totalAmountFen: toFen(order.totalAmount),
      balanceUsedFen: toFen(order.balanceUsed),
      payAmountFen: toFen(order.payAmount),
      remark: order.remark ?? null,
      dishes: items.map((i) => ({
        name: dishNames.get(i.dishId) ?? `菜品 ${i.dishId}`,
        slot: i.slot,
        supplierName: supNames.get(i.supplierId) ?? null,
      })),
      timeline,
      pickup: {
        point: building ? `${building.name} 1 楼大堂` : '待确认',
        leaderName: leader?.realName ?? null,
        leaderPhone: maskPhone(leader?.phone),
      },
      createdAt: toBjIso(order.createdAt)!,
      paidAt: toBjIso(order.paidAt),
      leaderContact,
    };
  }

  // ==========================================================================
  // U11 · 自助取消（T4：仅截单前 + pending_pay/paid）
  // ==========================================================================
  async cancel(userId: number, orderNo: string): Promise<CancelOrderResult> {
    const order = await this.loadOwnOrder(userId, orderNo);
    const status = order.status as OrderStatus;

    const block = explainSelfCancelBlock(status, isAfterCutoff(order.mealDate));
    if (block === 'cutoff') {
      // 40004：已截单 → 引导联系团长代退（附团长联系方式）
      const leader = order.teamLeaderId
        ? await this.leaderRepo.findOne({ where: { id: order.teamLeaderId } })
        : null;
      throw new BizException(
        ErrorCode.REFUND_NOT_ALLOWED,
        '截单后无法自助退款，请联系团长协助',
        undefined,
        {
          leaderContact: leader
            ? { name: leader.realName ?? null, phone: maskPhone(leader.phone) }
            : null,
        },
      );
    }
    if (block === 'status') {
      throw new BizException(
        ErrorCode.ORDER_STATUS_ILLEGAL,
        `当前状态「${userStatusText(status)}」不支持自助取消`,
      );
    }

    const now = new Date();
    const balanceUsedFen = toFen(order.balanceUsed);
    const payAmountFen = toFen(order.payAmount);
    let refundInitiated = false;

    await this.dataSource.transaction(async (m: EntityManager) => {
      if (status === OrderStatus.PENDING_PAY) {
        // 未支付：解冻余额即可（T4 前半段，未收款无需退款）
        if (balanceUsedFen > 0) {
          await this.releaseBalance(m, userId, balanceUsedFen, order.orderNo);
        }
      } else {
        // 已支付：退回余额部分 + 原路退微信部分（系统自动，T4 后半段）
        if (balanceUsedFen > 0) {
          await this.refundBalance(m, userId, balanceUsedFen, order.orderNo);
        }
        if (payAmountFen > 0) {
          refundInitiated = await this.refundViaWxpay(m, order, payAmountFen, '截单前用户自助取消');
        }
      }

      await m.getRepository(Order).update(
        { id: order.id },
        {
          status: OrderStatus.CANCELLED,
          cancelledAt: now,
          version: (order.version ?? 0) + 1,
        },
      );
    });

    this.logger.log(
      `订单已取消 orderNo=${orderNo} 原状态=${status} 退余额=${balanceUsedFen}分 ` +
        `原路退款=${payAmountFen}分 已发起=${refundInitiated}`,
    );

    return {
      orderNo: order.orderNo,
      status: OrderStatus.CANCELLED,
      statusText: userStatusText(OrderStatus.CANCELLED),
      refundInitiated,
      refundedBalanceFen: balanceUsedFen,
    };
  }

  // ==========================================================================
  // 支付成功入账（由 payment 域在回调/轮询确认后调用，T2）
  // ==========================================================================
  async markPaid(
    orderNo: string,
    transactionId: string,
    amountFen: number,
    raw?: unknown,
  ): Promise<{ changed: boolean; reason?: string }> {
    const order = await this.orderRepo.findOne({ where: { orderNo } });
    if (!order) {
      this.logger.error(`支付回调对应的订单不存在：orderNo=${orderNo}（不予入账）`);
      return { changed: false, reason: 'order_not_found' };
    }

    // 幂等：已是 paid 及之后的状态，直接返回（微信重复通知）
    if (order.status !== OrderStatus.PENDING_PAY) {
      if (order.status === OrderStatus.CANCELLED) {
        // 状态机 §七 风险项：回调延迟到账（>30min 已取消）→ 自动原路退款 + 告警
        this.logger.error(
          `⚠️ 支付回调延迟到达，订单已取消 orderNo=${orderNo}，将自动原路退款 ${amountFen} 分`,
        );
        if (amountFen > 0) {
          await this.dataSource.transaction(async (m) => {
            await this.refundViaWxpay(m, order, amountFen, '回调延迟到达（订单已取消）自动退款');
          });
        }
      }
      return { changed: false, reason: `status=${order.status}` };
    }

    // 金额核对：实付金额必须与订单 payAmount 一致，否则告警但不入账（防篡改）
    const expectedFen = toFen(order.payAmount);
    if (amountFen !== expectedFen) {
      this.logger.error(
        `⚠️ 支付金额不一致，拒绝入账 orderNo=${orderNo} 期望=${expectedFen}分 实收=${amountFen}分`,
      );
      return { changed: false, reason: 'amount_mismatch' };
    }

    const now = new Date();
    await this.dataSource.transaction(async (m: EntityManager) => {
      // 余额抵扣由冻结转为实际支出（T2）
      const balanceUsedFen = toFen(order.balanceUsed);
      if (balanceUsedFen > 0) {
        await this.consumeBalance(m, order.userId, balanceUsedFen, order.orderNo);
      }

      await m.getRepository(Order).update(
        { id: order.id },
        {
          status: OrderStatus.PAID,
          paidAt: now,
          version: (order.version ?? 0) + 1,
        },
      );

      // 支付流水（永久保留 · 合规要求）；uk_payment_order 保证一单一条
      const logs = m.getRepository(PaymentLog);
      const existed = await logs.findOne({ where: { orderId: order.id } });
      if (existed) {
        // 用实体赋值 + save（而非 update 的 partial）：`raw_response` 列类型为 json/unknown，
        // TypeORM 的 _QueryDeepPartialEntity 无法收窄 unknown → update() 会报 TS2322。
        existed.transactionId = transactionId;
        existed.payAmount = toYuanStr(amountFen);
        existed.status = 'success';
        existed.paidAt = now;
        existed.rawResponse = raw ?? null;
        await logs.save(existed);
      } else {
        await logs.save(
          logs.create({
            orderId: order.id,
            orderNo: order.orderNo,
            transactionId,
            payAmount: toYuanStr(amountFen),
            payMethod: 'wxpay_jsapi',
            status: 'success',
            paidAt: now,
            rawResponse: raw ?? null,
          }),
        );
      }
    });

    this.logger.log(`订单已支付 orderNo=${orderNo} 实付=${amountFen}分 txn=${transactionId}`);
    return { changed: true };
  }

  /** 支付单创建前需要的信息（供 payment 域 U7 使用） */
  async preparePrepay(userId: number, orderNo: string) {
    const order = await this.loadOwnOrder(userId, orderNo);
    if (order.status !== OrderStatus.PENDING_PAY) {
      throw new BizException(
        ErrorCode.ORDER_STATUS_ILLEGAL,
        `订单当前状态「${userStatusText(order.status)}」不可发起支付`,
      );
    }
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BizException(ErrorCode.USER_NOT_FOUND);

    return {
      orderNo: order.orderNo,
      openid: user.openid,
      quantity: order.quantity,
      payAmountFen: toFen(order.payAmount),
      mealDate: order.mealDate,
    };
  }

  /** U8 支付结果（端上轮询 / 回跳） */
  async payResult(userId: number, orderNo: string) {
    const order = await this.loadOwnOrder(userId, orderNo);
    return {
      orderNo: order.orderNo,
      status: order.status,
      statusText: userStatusText(order.status),
      paid: [
        OrderStatus.PAID,
        OrderStatus.CUT_OFF,
        OrderStatus.COOKED,
        OrderStatus.DELIVERING,
        OrderStatus.DELIVERED,
        OrderStatus.COMPLETED,
      ].includes(order.status as OrderStatus),
      payAmountFen: toFen(order.payAmount),
      paidAt: toBjIso(order.paidAt),
      failReason:
        order.status === OrderStatus.CANCELLED ? '订单已取消（超时未支付或主动取消）' : null,
    };
  }

  // ==========================================================================
  // 内部工具
  // ==========================================================================

  private async loadOwnOrder(userId: number, orderNo: string): Promise<Order> {
    const order = await this.orderRepo.findOne({ where: { orderNo } });
    // 不区分「不存在」与「非本人」，避免越权探测订单号是否存在
    if (!order || order.userId !== userId) {
      throw new BizException(ErrorCode.ORDER_NOT_FOUND);
    }
    return order;
  }

  private async resolveLeader(leaderCode: string | undefined, user: User): Promise<TeamLeader> {
    if (leaderCode) {
      const m = /^LDR(\d{4,})$/i.exec(leaderCode.trim());
      const id = m ? Number(m[1]) : Number(leaderCode);
      const byCode =
        Number.isInteger(id) && id > 0 ? await this.leaderRepo.findOne({ where: { id } }) : null;
      if (!byCode || byCode.status !== LeaderStatus.ACTIVE) {
        throw new BizException(ErrorCode.LEADER_NOT_FOUND, `团长邀请码 ${leaderCode} 无效`);
      }
      return byCode;
    }

    const own = user.teamLeaderId
      ? await this.leaderRepo.findOne({ where: { id: user.teamLeaderId } })
      : null;
    if (own && own.status === LeaderStatus.ACTIVE) return own;

    if (user.buildingId) {
      const fallback = await this.leaderRepo.findOne({
        where: { buildingId: user.buildingId, status: 1 },
        order: { id: 'ASC' },
      });
      if (fallback) return fallback;
    }
    throw new BizException(ErrorCode.LEADER_NOT_FOUND, '未绑定团长，请通过团长邀请链接进入');
  }

  private async resolveGroup(user: User): Promise<number> {
    if (!user.buildingId) {
      throw new BizException(ErrorCode.NOT_FOUND, '你还未绑定办公楼，请通过团长邀请链接进入');
    }
    const building = await this.buildingRepo.findOne({ where: { id: user.buildingId } });
    if (!building?.buildingGroupId) {
      throw new BizException(ErrorCode.NOT_FOUND, '所属办公楼未配置楼群，请联系运营');
    }
    return building.buildingGroupId;
  }

  /** 批量取「主荤菜名」（slot=1），避免列表页 N+1 */
  private async mainDishNameMap(orders: Order[]): Promise<Map<number, string | null>> {
    const map = new Map<number, string | null>();
    const setMealIds = [...new Set(orders.map((o) => o.setMealId))];
    if (setMealIds.length === 0) return map;

    const items = await this.itemRepo.find({ where: { setMealId: In(setMealIds), slot: 1 } });
    if (items.length === 0) return map;

    const dishes = await this.dishRepo.find({ where: { id: In(items.map((i) => i.dishId)) } });
    const dishNames = new Map(dishes.map((d) => [d.id, d.name]));
    for (const it of items) {
      map.set(it.setMealId, dishNames.get(it.dishId) ?? null);
    }
    return map;
  }

  private async getOrCreateBalance(m: EntityManager, userId: number): Promise<Balance> {
    const repo = m.getRepository(Balance);
    let row = await repo.findOne({ where: { userId } });
    if (!row) {
      row = await repo.save(repo.create({ userId, balance: '0.00', frozen: '0.00' }));
    }
    return row;
  }

  /** 余额流水（direction：1 收入 / -1 支出） */
  private async writeBalanceLog(
    m: EntityManager,
    userId: number,
    type: string,
    direction: number,
    amountFen: number,
    balanceAfterYuan: string,
    remark: string,
    relatedId: string,
  ): Promise<void> {
    const repo = m.getRepository(BalanceLog);
    await repo.save(
      repo.create({
        userId,
        type,
        direction,
        amount: toYuanStr(amountFen),
        balanceAfter: balanceAfterYuan,
        relatedId,
        remark,
      }),
    );
  }

  /** T1 · 冻结余额（可用 → 冻结） */
  private async freezeBalance(
    m: EntityManager,
    userId: number,
    amountFen: number,
    orderNo: string,
  ): Promise<void> {
    const row = await this.getOrCreateBalance(m, userId);
    const balance = toFen(row.balance) - amountFen;
    const frozen = toFen(row.frozen) + amountFen;
    await m
      .getRepository(Balance)
      .update(
        { id: row.id },
        { balance: toYuanStr(balance), frozen: toYuanStr(frozen), version: (row.version ?? 0) + 1 },
      );
    await this.writeBalanceLog(
      m,
      userId,
      'order_pay',
      -1,
      amountFen,
      toYuanStr(balance),
      '下单冻结（余额抵扣）',
      orderNo,
    );
  }

  /** T4（未支付）· 解冻（冻结 → 可用） */
  private async releaseBalance(
    m: EntityManager,
    userId: number,
    amountFen: number,
    orderNo: string,
  ): Promise<void> {
    const row = await this.getOrCreateBalance(m, userId);
    const frozen = Math.max(0, toFen(row.frozen) - amountFen);
    const balance = toFen(row.balance) + amountFen;
    await m
      .getRepository(Balance)
      .update(
        { id: row.id },
        { balance: toYuanStr(balance), frozen: toYuanStr(frozen), version: (row.version ?? 0) + 1 },
      );
    await this.writeBalanceLog(
      m,
      userId,
      'order_pay',
      1,
      amountFen,
      toYuanStr(balance),
      '取消订单解冻（余额退回）',
      orderNo,
    );
  }

  /** T2 · 消费冻结（冻结 → 累计支出） */
  private async consumeBalance(
    m: EntityManager,
    userId: number,
    amountFen: number,
    orderNo: string,
  ): Promise<void> {
    const row = await this.getOrCreateBalance(m, userId);
    const frozen = Math.max(0, toFen(row.frozen) - amountFen);
    const totalOut = toFen(row.totalOut) + amountFen;
    await m.getRepository(Balance).update(
      { id: row.id },
      {
        frozen: toYuanStr(frozen),
        totalOut: toYuanStr(totalOut),
        version: (row.version ?? 0) + 1,
      },
    );
    await this.writeBalanceLog(
      m,
      userId,
      'order_pay',
      -1,
      amountFen,
      row.balance,
      '支付成功（余额抵扣已消费）',
      orderNo,
    );
  }

  /** T4（已支付）· 退回可用余额（原余额支付部分不进微信退款通道） */
  private async refundBalance(
    m: EntityManager,
    userId: number,
    amountFen: number,
    orderNo: string,
  ): Promise<void> {
    const row = await this.getOrCreateBalance(m, userId);
    const balance = toFen(row.balance) + amountFen;
    const totalOut = Math.max(0, toFen(row.totalOut) - amountFen);
    await m.getRepository(Balance).update(
      { id: row.id },
      {
        balance: toYuanStr(balance),
        totalOut: toYuanStr(totalOut),
        version: (row.version ?? 0) + 1,
      },
    );
    await this.writeBalanceLog(
      m,
      userId,
      'refund',
      1,
      amountFen,
      toYuanStr(balance),
      '取消订单退回（原余额支付部分）',
      orderNo,
    );
  }

  /**
   * 调微信原路退款并落 `ab_refund`
   *
   * ⚠️ C6 三段式：截单**前**用户自助取消走**系统自动退款**（本方法），
   *    截单**后**必须走「团长代退申请 → 后台审批」，不得由本方法直接触发。
   * ⚠️ C9：反向结算（成本项 + 佣金冲销、毛利留存）在截单后才产生，
   *    故截单前取消**不写** `ab_supplier_share` 冲销，仅置 `reversed=0`。
   * @returns 是否已向微信发起退款
   */
  private async refundViaWxpay(
    m: EntityManager,
    order: Order,
    amountFen: number,
    reason: string,
  ): Promise<boolean> {
    const refundNo = genRefundNo();
    const repo = m.getRepository(Refund);

    // 幂等：同一订单不应产生第二条「非驳回」退款单
    const existed = await repo.findOne({
      where: { orderId: order.id, status: Not('rejected') },
    });
    if (existed) {
      this.logger.warn(`订单 ${order.orderNo} 已存在退款单 ${existed.refundNo}，跳过重复发起`);
      return false;
    }

    const row = await repo.save(
      repo.create({
        refundNo,
        orderId: order.id,
        orderNo: order.orderNo,
        userId: order.userId,
        teamLeaderId: order.teamLeaderId ?? null,
        applySource: 'user',
        amount: toYuanStr(amountFen),
        reasonType: 'other',
        reason,
        status: 'refunding',
        reversed: 0,
      }),
    );

    const result = await this.wxPay.refund({
      orderNo: order.orderNo,
      refundNo,
      refundFen: amountFen,
      totalFen: toFen(order.totalAmount),
      reason,
    });

    const succeeded = result.status === 'SUCCESS' || result.status === 'PROCESSING';
    await repo.update(
      { id: row.id },
      {
        status: succeeded ? 'refunded' : 'failed',
        wxRefundNo: result.refundId,
        refundedAt: succeeded ? new Date() : null,
      },
    );
    return succeeded;
  }
}

/** 供其它模块复用的默认值导出（避免各处硬编码 pageSize） */
export const DEFAULT_PAGE = PAGE_DEFAULT;

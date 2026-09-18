import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm';

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
// ⚠️ M4-3：`genRefundNo` 已随「退款单建单下沉到 `RefundService.buildRefundRow`」一并移除
//    —— 本模块不再自己造退款单号（第二份实现必然漂移）
import { genOrderNo } from '../../common/utils/order-no';
import { normalizePage, paginate, PageResult } from '../../common/utils/response';
import {
  cutoffAtOf,
  isAfterCutoff,
  isOrderable,
  now,
  payExpireAt,
  toBjIso,
  tomorrowBj,
} from '../../common/utils/time';
import { Building } from '../../database/entities/building.entity';
import { Balance, BalanceLog } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { MealAssignment, SetMealItem } from '../../database/entities/meal.entity';
import { Order, PaymentLog, Refund } from '../../database/entities/order.entity';
import { OperationLog } from '../../database/entities/system.entity';
import { Dish, Supplier } from '../../database/entities/supplier.entity';
import { User } from '../../database/entities/user.entity';
import { WX_PAY_PROVIDER, WxPayProvider } from '../../providers/wx-pay/wx-pay.provider';
import { RefundApplyPayload } from '../../queues/queue-payloads';
import { CommissionService } from '../finance/commission.service';
import { RefundService } from '../finance/refund.service';
import { LeaderPromotionService } from '../team-leader/promotion.service';
import { buildTimeline, explainSelfCancelBlock, userStatusText } from './order-state-machine';
import { CreateOrderReqDto } from './dto/order.dto';

/** 元 → 分（金额跨层只在 service 边界换算一次） */
const toFen = (yuan: number | string): number => Math.round(Number(yuan) * 100);
/** 分 → 元（两位小数字符串，落 DECIMAL 列） */
const toYuanStr = (fen: number): string => (fen / 100).toFixed(2);

/** 截单出参（`cutoffByDate` · 跑批与手动补跑共用同一形状） */
export interface CutoffByDateResult {
  date: string;
  /** ① 未支付兜底取消 */
  autoCancelled: { count: number; orderNos: string[]; releasedBalanceFen: number };
  /** ② 已支付锁定 */
  locked: { count: number; orderNos: string[]; totalQuantity: number };
  /** ③ 备料量定格（按楼群） */
  soldByGroup: Array<{ buildingGroupId: number; quantity: number }>;
  totalSoldQuantity: number;
}

/** 自动确认兜底出参（`autoConfirmByDate` · 跑批与手动补跑共用同一形状） */
export interface AutoConfirmByDateResult {
  date: string;
  /** 本次推进为 `completed` 的订单数 */
  confirmedCount: number;
  confirmedQuantity: number;
  /** 本次**计佣**金额（分）—— 两段式：将于次日 02:00 入账，**不是已到账** */
  commissionFen: number;
  /** 按团长拆分（运营最关心「谁被确认了多少」） */
  leaders: Array<{
    leaderId: number;
    leaderName: string;
    count: number;
    quantity: number;
    commissionFen: number;
  }>;
  /**
   * ⭐ 该出餐日**既未送达、也未取消/退款**的订单 —— **履约异常**，如实计数、**不改状态**。
   *
   * T 日 11:30 应已送达，到 14:00 仍停在 `paid`/`cut_off`/`cooked`/`delivering`，
   * 说明出餐或配送环节掉了链子。**不猜**（既不能当已送达而确认，也不能替运营取消），
   * 只如实报出来，由人工处理 —— fail-closed。
   */
  notDelivered: { count: number; byStatus: Record<string, number>; orderNos: string[] };
  /**
   * 无归属团长、但订单仍被确认完成的数量。
   *
   * 履约**已经发生**（货送到了），状态必须收口；但 `team_leader_id` 为空时**没有佣金对象**，
   * 故**不猜团长**（不按楼栋反推），只计数并告警 —— 佣金归零比佣金错付安全。
   */
  orphanConfirmed: number;
  /** 本次确认后触发晋级的团长（C2），供日志与端上展示 */
  promotions: Array<{ leaderId: number; from: string; to: string; rate: number }>;
}

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
    /** M4-2 · 4.4 自动确认兜底要计佣（与 L9 共用同一计佣口径） */
    private readonly commission: CommissionService,
    /** M4-2 · 4.4 确认后触发 C2 晋级审计（与 L9 一致） */
    private readonly promotion: LeaderPromotionService,
    /**
     * M4-3 · 退款单构建 + 通道执行（事务外）
     *
     * ⚠️ 取消订单 / 回调延迟到账都要「退微信实付」，这两条路径原本在 `OrderService`
     *    里自己写了一遍「建单 + 调通道」（`refundViaWxpay`），与 `RefundService`
     *    的退款链路是**两套实现**。M4-3 起统一走 `RefundService`：
     *    建单（事务内）与通道调用（事务外，失败入队重试）只有一处实现。
     */
    private readonly refundService: RefundService,
  ) {}

  /**
   * 14:00 仍未送达即视为**履约异常**的状态集（`autoConfirmByDate` 用）
   *
   * ⚠️ 只列「仍在履约途中」的状态：`completed`/`cancelled` 是正常终态，退款各态
   *    有自己的流程（用户主动发起，不是履约事故），故都不算异常。
   *    `pending_pay` 在截单时就应被兜底取消，若 14:00 还存在也是异常 —— 一并纳入。
   */
  private static readonly NOT_DELIVERED_STATUSES: OrderStatus[] = [
    OrderStatus.PENDING_PAY,
    OrderStatus.PAID,
    OrderStatus.CUT_OFF,
    OrderStatus.COOKED,
    OrderStatus.DELIVERING,
  ];

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

    // 事务内：**只落 DB**（余额退回 + 建微信退款单 + 订单取消），不调外部通道（M4-3）
    const refundPayload = await this.dataSource.transaction(
      async (m: EntityManager): Promise<RefundApplyPayload | null> => {
        let payload: RefundApplyPayload | null = null;

        if (status === OrderStatus.PENDING_PAY) {
          // 未支付：解冻余额即可（T4 前半段，未收款无需退款）
          if (balanceUsedFen > 0) {
            await this.releaseBalance(m, userId, balanceUsedFen, order.orderNo);
          }
        } else {
          // 已支付：退回余额部分 + **建单**原路退微信部分（T4 后半段）
          if (balanceUsedFen > 0) {
            await this.refundBalance(m, userId, balanceUsedFen, order.orderNo);
          }
          if (payAmountFen > 0) {
            const row = await this.refundService.buildRefundRow(
              m,
              order,
              payAmountFen,
              '截单前用户自助取消',
            );
            if (row) {
              payload = {
                refundId: Number(row.id),
                orderNo: order.orderNo,
                refundNo: row.refundNo,
                wxFen: payAmountFen,
                totalFen: toFen(Number(order.totalAmount)),
                reason: '截单前用户自助取消',
              };
            }
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

        return payload;
      },
    );

    // 事务外：调微信通道（同步试一次，失败入队重试 —— 不回滚已落库的取消与余额退回）
    if (refundPayload) {
      const r = await this.refundService.deliverOrQueueRefund(refundPayload);
      refundInitiated = r.ok;
    }

    this.logger.log(
      `订单已取消 orderNo=${orderNo} 原状态=${status} 退余额=${balanceUsedFen}分 ` +
        `原路退款=${payAmountFen}分 通道受理=${refundInitiated}` +
        (refundPayload && !refundInitiated ? '（已入队重试）' : ''),
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
  // 截单（T-1 24:00 · T5 / T6）—— 跑批入口，由 `tasks/cutoff.task.ts` 委托
  // ==========================================================================

  /**
   * 截单：① 未支付兜底取消 ② 已支付锁定 ③ 定格备料量基数
   *
   * 口径依据：《订单状态机与全链路流转 v1.0》§3 T-1 24:00 · §二 T5/T6
   *
   * ## 为什么这一整套必须写在订单域
   * 截单要动两样东西：**订单状态**与**分配表的备料量基数**。后者的口径是
   * 「**哪些订单算生产**」—— 这个判断只有订单域做得对（要区分 `pending_pay` 未付款、
   * `cancelled` 已取消、以及后续可能出现的退款态）。若让 meal 域或 supplier 域
   * 各自去查订单表，同一句「哪些订单算数」就会有第二份实现（本项目头号顽疾）。
   *
   * ## ⭐ 为什么顺带回写 `sold_count`（本次修复的真实缺口）
   * `ab_meal_assignment.sold_count` 注释写着「已订份数（实时累加）」，但**全仓没有任何
   * 累加点** —— 下单不加、取消不减、退款不管，它只在种子里被赋过值。而供应商的
   * 备料量（`ab_supplier_dish_daily.plan_quantity`）正是拿它当聚合基数，
   * 于是**跑批推给供应商的份数恒为 0**（`ensureProducePlan` 里那句
   * 「`sold_count=0` 的分配很常见」其实不是「常见」，是「唯一可能」）。
   *
   * 收口方式与「生产计划生成即冻结」同族：**不引入实时累加**（那要在下单 / 取消 /
   * 超时 / 退款四条路径上同步维护，漏一条就是静默错账），而是**在截单这一「定格」
   * 时刻从订单表聚合一次并落库**。语义随之明确为「**截单定格的已售份数**」：
   *   · 截单前：可能为 0 或种子值 —— 此时它不承诺准确（页面勿据此下结论）
   *   · 截单后：**定格**，不再随退款 / 改单变化
   *
   * ## 备料量口径
   * 计入 `status NOT IN ('pending_pay', 'cancelled')` 的订单：
   *   · 排除未支付 —— 钱没到、单已作废
   *   · 排除已取消 —— 截单时刚被本方法置为取消
   *   · **包含后续状态（cooked / delivered / …）与退款态** —— 手动补跑时订单可能已
   *     流转到 T 日之后；而这些货**已经做了**（自营口径下采购款按实收量付，与用户
   *     是否退款无关），所以计在生产量内。截单定格后也不会因退款而回退。
   *
   * ## 幂等
   * 以 `meal_date` 为键：第二次执行时已无 `pending_pay` / `paid` 的订单，
   * 两个分支各自自然为空 —— **不需要额外幂等占位表**（与 4.11 一致）。
   *
   * ## ⚡ 批量化与并发（M5-6 · 收口报告 §二 P1-2）
   * 改前每个分支是「逐单 `findOne` 复核 + 逐单 `update` + 逐单 `insert` 审计」，
   * N 单 ≈ 3N 条 SQL，而且**每一对「复核 + 改写」之间都有一个窗口**。本批两件事一起做：
   *
   *  ① **读与审计批量化**（语义不变，纯省往返）
   *     · `findOne` ×N → 一条 `id IN (…)`。分支 ① 要的是事务内**当下**的 `balance_used`
   *       —— 运营改抵扣额走 `order-admin.service.ts#syncFrozenBalance` 会动这一列，
   *       故**不能**复用事务外 `find()` 的快照（拿旧值解冻 = 少退/多退，都是钱）。
   *     · `ab_operation_log` 逐条 `insert` → 事务末尾**一条多值 INSERT**。
   *  ② **把「复核 + 改写」合成原子占位**（顺带修掉一个同族并发缺陷）
   *     改前是「先 `findOne` 看状态、再**无条件** `update`」，两条语句之间任何并发迁移
   *     都会被**覆盖**回去：分支 ① 会**重复解冻余额**（平台多退一份钱）；
   *     分支 ② 会把一笔正在退款流程里的单**硬拉回** `cut_off`（`REFUNDABLE_STATUS`
   *     明确含 `paid`）。改后以条件更新的 `affected` 判定归属 —— **占位失败的绝不往下走**，
   *     与 P1-1（退款冲销）同一收口方式。
   *
   * ⚠️ 剩下的 **N 条条件更新是刻意保留的，不是漏改**：集合更新只回总数、不回「哪几行归我」，
   *    而每张订单都要落**独立**审计行、`balance_used` 也因人而异。替代方案三条都比它风险大：
   *    MySQL 8 无 `UPDATE … RETURNING`；`SELECT … FOR UPDATE` 在 sqlite 上不受支持
   *    （本地/生产会分叉）；基于时间戳的归因在「两次并发补跑」下会重复认领。
   *    故本批把往返数从 ~3N+1 降到 ~N+3，**没有**把 O(N) 洗成 O(1)。
   *
   * @param date 出餐日（由 `ScheduleService.targetDate('today')` 得出，即 T 日）
   */
  async cutoffByDate(date: string, operatorId?: number | null): Promise<CutoffByDateResult> {
    const now = new Date();
    const logRepoOf = (m: EntityManager) => m.getRepository(OperationLog);

    // ---- ① 未支付 → 取消（解冻余额）--------------------------------------
    const pendings = await this.orderRepo.find({
      where: { mealDate: date, status: OrderStatus.PENDING_PAY },
      order: { id: 'ASC' },
    });
    const cancelledNos: string[] = [];
    let releasedBalanceFen = 0;

    if (pendings.length) {
      await this.dataSource.transaction(async (m: EntityManager) => {
        // ⚡ 批量重读（**1 条 SQL 取代 N 条 `findOne`**）：要的是事务内「当下」的值。
        //    ⚠️ 不能复用事务外那次 `find()` 的快照 —— `balance_used` 在 `pending_pay`
        //    期间**并非只读**：运营改抵扣额走 `order-admin.service.ts#syncFrozenBalance`，
        //    它改的正是这一列。拿旧值解冻 = 少退 / 多退，都是钱。
        const freshById = new Map(
          (await m.find(Order, { where: { id: In(pendings.map((o) => o.id)) } })).map((r) => [
            r.id,
            r,
          ]),
        );

        // 审计行先攒起来，事务末尾**一次多值 INSERT** 落库（N 条 INSERT → 1 条）
        const logs: QueryDeepPartialEntity<OperationLog>[] = [];

        for (const o of pendings) {
          const fresh = freshById.get(o.id);
          if (!fresh) continue; // 行已不存在（理论不可达：刚查出来过）

          /**
           * ⭐ 原子占位（本批修正 ①）
           *
           * 改前是「先 `findOne` 复核状态、再**无条件** `update`」——
           * 两条语句之间并发的用户自助取消（T4）可以插进来，后果是**重复解冻余额**：
           *   本跑批 `findOne` 读到 `pending_pay` → 用户取消（解冻一次）→ 本跑批再解冻
           *   第二次 = 平台**多退一份钱**；同时把对方的 `cancelledAt` / `version` 覆盖掉。
           * 与 P1-1（退款冲销「先查后写」）是**同一族**缺陷。
           *
           * 收口方式同族：把「状态复核」与「状态改写」合成**一条**条件更新，以 `affected`
           * 判定归属 —— **占位失败的绝不往下走**（钱一动不动）。
           * 这也是**批量化不能被压成一条集合更新**的原因：集合更新只给总数、不给
           * 「哪几行归我」，而下面每一行都要落一条独立审计、且`balanceUsed` 因人而异。
           */
          const claim = await m
            .createQueryBuilder()
            .update(Order)
            .set({
              status: OrderStatus.CANCELLED,
              cancelledAt: now,
              version: () => 'version + 1',
            })
            .where('id = :id', { id: o.id })
            .andWhere('status = :st', { st: OrderStatus.PENDING_PAY })
            .execute();
          if ((claim.affected ?? 0) === 0) continue; // 已被 T4 自助取消处理 → 不重复退钱

          const fen = toFen(fresh.balanceUsed);
          if (fen > 0) {
            await this.releaseBalance(m, fresh.userId, fen, fresh.orderNo);
            releasedBalanceFen += fen;
          }

          // 状态机 §2.1.5：每次迁移落 `ab_operation_log`。跑批没有 HTTP 请求，
          // 全局拦截器不生效，故在此**显式写入**（来源标 system）。
          logs.push({
            adminUserId: operatorId ?? null,
            module: 'order',
            action: '截单取消',
            targetId: String(fresh.id),
            requestData: { orderNo: fresh.orderNo, mealDate: date },
            snapshot: {
              fromStatus: OrderStatus.PENDING_PAY,
              toStatus: OrderStatus.CANCELLED,
              source: 'system',
              reason: 'T-1 24:00 截单：未支付兜底取消',
            },
          });
          cancelledNos.push(fresh.orderNo);
        }

        if (logs.length) await logRepoOf(m).insert(logs);
      });
    }

    // ---- ② 已支付 → 已截单（锁定，不可逆）--------------------------------
    const paids = await this.orderRepo.find({
      where: { mealDate: date, status: OrderStatus.PAID },
      order: { id: 'ASC' },
    });
    const lockedNos: string[] = [];
    let lockedQuantity = 0;

    if (paids.length) {
      await this.dataSource.transaction(async (m: EntityManager) => {
        const logs: QueryDeepPartialEntity<OperationLog>[] = [];

        for (const o of paids) {
          /**
           * ⭐ 原子占位（本批修正 ②）：同 ①，但**后果更重** —— `cut_off` 是
           * 状态机里**不可逆**的节点（`cut_off → 退款` 只能走 C6 三段式）。
           *
           * 改前是「先 `findOne` 复核、再**无条件** `update`」。并发的团长代退
           * （`REFUNDABLE_STATUS` 明确包含 `paid`，见 `refund.service.ts`）会把订单
           * 移出 `paid`，而随后的无条件 update 把它**硬拉回** `cut_off`：
           * 一笔正在退款流程里的单被重新锁死，退款链路的 `order_status_before`
           * 与真实状态就此错位。条件更新让这种行 `affected=0`，**放过而不是覆盖**。
           */
          const claim = await m
            .createQueryBuilder()
            .update(Order)
            .set({ status: OrderStatus.CUT_OFF, version: () => 'version + 1' })
            .where('id = :id', { id: o.id })
            .andWhere('status = :st', { st: OrderStatus.PAID })
            .execute();
          if ((claim.affected ?? 0) === 0) continue;

          // 状态机 §2.1.5：每次迁移落 `ab_operation_log`。跑批没有 HTTP 请求，
          // 全局拦截器不生效，故在此**显式写入**（来源标 system）。
          logs.push({
            adminUserId: operatorId ?? null,
            module: 'order',
            action: '截单锁定',
            targetId: String(o.id),
            requestData: { orderNo: o.orderNo, mealDate: date },
            snapshot: {
              fromStatus: OrderStatus.PAID,
              toStatus: OrderStatus.CUT_OFF,
              source: 'system',
              reason: 'T-1 24:00 截单：锁定并不可逆',
            },
          });
          lockedNos.push(o.orderNo);
          lockedQuantity += Number(o.quantity ?? 0);
        }

        if (logs.length) await logRepoOf(m).insert(logs);
      });
    }

    // ---- ③ 定格备料量基数 ------------------------------------------------
    const sold = await this.freezeSoldCounts(date);

    this.logger.log(
      `截单完成 date=${date} 取消未支付 ${cancelledNos.length} 单（解冻 ${releasedBalanceFen} 分）` +
        `锁定已支付 ${lockedNos.length} 单（${lockedQuantity} 份）` +
        `备料量定格 ${sold.totalQuantity} 份 / ${sold.byGroup.length} 个楼群` +
        (operatorId ? `（操作人#${operatorId}）` : '（跑批）'),
    );

    return {
      date,
      autoCancelled: {
        count: cancelledNos.length,
        orderNos: cancelledNos,
        releasedBalanceFen,
      },
      locked: { count: lockedNos.length, orderNos: lockedNos, totalQuantity: lockedQuantity },
      soldByGroup: sold.byGroup,
      totalSoldQuantity: sold.totalQuantity,
    };
  }

  // ==========================================================================
  // 自动确认兜底（T 日 14:00 · T11）—— 跑批入口，由 `tasks/auto-confirm.task.ts` 委托
  // ==========================================================================

  /**
   * 自动确认兜底：把 `delivered` 的单批量转 `completed` 并计佣
   *
   * 口径依据：《订单状态机与全链路流转 v1.0》§3 「T 日 14:00 auto-confirm.task ⚠️锚点2
   * 自动确认收货」+ §二 T11（`delivered → completed`，系统批量）。
   *
   * ## 为什么要它
   * 团长可能根本不点「一键分发」（忘了 / 忙 / 失联）。若没有兜底，这些单会永远停在
   * `delivered`：**订单不闭环、佣金不到账、用户端一直显示「待取餐」**。这条任务是
   * 「**不依赖人操作**」的兜底能力 —— 团长配合时走 L9（即时），不配合时走它。
   *
   * ## ⭐ 只转 `delivered`（用户 2026-09-17 裁定）
   * 状态机 T11 只写了一条边：`delivered → completed`。仍停在 `paid`/`cut_off`/`cooked`/
   * `delivering` 的单说明**货没送到**（T 日 11:30 应已送达）—— 那是**履约异常**，
   * 不是「该确认没确认」。对它们：
   *   · **不改状态**（既不能当已送达而确认，也不能替运营取消）
   *   · 计入出参 `notDelivered` 并按状态分类，让运营看见
   *   —— fail-closed：**缺关键事实时不猜**（同 M3-8 `50009`、D41 `40014` 的纪律）。
   *
   * ⚠️ 已知口径差异（**待裁决，见文档**）：`L9 confirmPickup` 放行 `delivering`
   *    （团长能确认「配送中」的单），本方法不放行。两者宽严不同是**刻意**的 ——
   *    团长站在现场，他确认「我收到了」是有信息支撑的；而系统在 14:00 只凭状态
   *    推断，`delivering` 也可能是「正在路上」，替用户确认收货风险更大。
   *
   * ## 幂等
   * 逐单条件更新（`WHERE id=? AND status='delivered'`），以 `affected` 判定归属 ——
   * 并发下已被 L9 或上一次跑批确认过的单 `affected=0`，跳过、且**不计佣**
   * （计佣本身还有 `uk_commission_order_type` 兜底，双层保险）。
   * 故**重跑与手动补跑都安全**，且能补上「上次因故没跑到的单」。
   *
   * ⚡ M5-6 批量化：审计行改为**每个事务末尾一次多值 `INSERT`**（N 条 → 1 条）。
   *    判定归属的条件更新**保留逐条**，理由见 `cutoffByDate` 的「批量化与并发」小节
   *    （集合更新不回「哪几行归我」，而每张单都要落独立审计行）。
   *
   * ## 事务边界：**按团长分批**
   * 每个团长一个事务（而不是全量一个大事务）：某个团长的数据异常不会把其他团长的
   * 确认与佣金一起回滚掉。代价是理论上可能「A 团长成功、B 团长失败」—— 而失败会
   * 触发锁释放（见 `ScheduleService.run()`），补跑一遍即可，且补跑是幂等的。
   *
   * ⚠️ **晋级审计在事务外**（与 L9 一致）：钱已经计了，审计失败不该把「已确认 + 已计佣」
   *    整体回滚，故只记日志、不抛错。
   */
  async autoConfirmByDate(
    date: string,
    operatorId?: number | null,
  ): Promise<AutoConfirmByDateResult> {
    const at = now();
    const logRepoOf = (m: EntityManager) => m.getRepository(OperationLog);

    // ---- ① 履约异常：14:00 仍未送达（如实计数，绝不改状态）------------------
    const abnormal = await this.orderRepo.find({
      where: { mealDate: date, status: In(OrderService.NOT_DELIVERED_STATUSES) },
      order: { id: 'ASC' },
    });
    const byStatus: Record<string, number> = {};
    for (const o of abnormal) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

    // ---- ② 待确认：delivered（按团长分组）----------------------------------
    const delivereds = await this.orderRepo.find({
      where: { mealDate: date, status: OrderStatus.DELIVERED },
      order: { id: 'ASC' },
    });

    const byLeader = new Map<number, Order[]>();
    const orphans: Order[] = [];
    for (const o of delivereds) {
      const lid = o.teamLeaderId == null ? null : Number(o.teamLeaderId);
      if (!lid) {
        orphans.push(o);
        continue;
      }
      const list = byLeader.get(lid) ?? [];
      list.push(o);
      byLeader.set(lid, list);
    }

    const leaders: AutoConfirmByDateResult['leaders'] = [];
    const promotions: AutoConfirmByDateResult['promotions'] = [];
    let confirmedCount = 0;
    let confirmedQuantity = 0;
    let commissionFen = 0;

    for (const [leaderId, orders] of byLeader) {
      const leader = await this.leaderRepo.findOne({ where: { id: leaderId } });
      if (!leader) {
        // 团长档案已不存在 → 单仍要收口（履约已发生），但**不猜团长、不计佣**。
        // 归入 orphan 统计（下面统一处理），并留下告警。
        this.logger.warn(`自动确认：团长档案 #${leaderId} 不存在，${orders.length} 单转无归属处理`);
        orphans.push(...orders);
        continue;
      }

      const outcome = await this.dataSource.transaction(async (m: EntityManager) => {
        const transitioned: Order[] = [];
        const logs: QueryDeepPartialEntity<OperationLog>[] = [];
        for (const o of orders) {
          // 条件更新：仅当仍是 `delivered` 才推进（防与 L9 / 重复跑批并发）
          const upd = await m
            .createQueryBuilder()
            .update(Order)
            .set({ status: OrderStatus.COMPLETED, completedAt: at })
            .where('id = :id', { id: o.id })
            .andWhere('status = :st', { st: OrderStatus.DELIVERED })
            .execute();
          if ((upd.affected ?? 0) === 0) continue;

          transitioned.push(o);
          // 状态机 §2.1.5：每次迁移落 `ab_operation_log`。跑批没有 HTTP 请求，
          // 全局拦截器不生效，故在此**显式写入**（来源标 system）。
          // ⚡ 攒到事务末尾**一次多值 INSERT**（N 条 INSERT → 1 条）——
          //    `affected` 已经把「哪些真的迁移了」判死，故归因不受批量化影响。
          logs.push({
            adminUserId: operatorId ?? null,
            module: 'order',
            action: '自动确认收货',
            targetId: String(o.id),
            requestData: { orderNo: o.orderNo, mealDate: date, teamLeaderId: leaderId },
            snapshot: {
              fromStatus: OrderStatus.DELIVERED,
              toStatus: OrderStatus.COMPLETED,
              source: 'system',
              reason: 'T 日 14:00 自动确认兜底（团长未确认收货）',
            },
          });
        }
        if (logs.length) await logRepoOf(m).insert(logs);

        // 计佣：只对**本次真正推进**的单计（口径与 L9 共用 `accrueForOrders`，写 pending）
        const acc = await this.commission.accrueForOrders(leader, transitioned, 'FLEX_MANUAL', m);
        return { transitioned, acc };
      });

      confirmedCount += outcome.transitioned.length;
      confirmedQuantity += outcome.acc.quantity;
      commissionFen += outcome.acc.amountFen;

      if (outcome.transitioned.length) {
        leaders.push({
          leaderId,
          leaderName: leader.realName ?? '',
          count: outcome.transitioned.length,
          quantity: outcome.acc.quantity,
          commissionFen: outcome.acc.amountFen,
        });
      }

      // C2 晋级审计（事务外，与 L9 一致）：计佣即改变「月单」，故必须重算。
      // ⚠️ `monthOrdersOf` 两段式后已改为统计 `pending + settled`
      //    （见 `promotion.service.ts`），否则晋级会晚一天。
      try {
        const audit = await this.promotion.audit(leaderId);
        if (audit?.promoted) {
          promotions.push({
            leaderId,
            from: audit.before,
            to: audit.after,
            rate: audit.rate,
          });
        }
      } catch (e) {
        this.logger.warn(
          `自动确认：团长 #${leaderId} 晋级审计失败（不影响确认与计佣）：${(e as Error).message}`,
        );
      }
    }

    // ---- ③ 无归属团长的单：收口但不计佣 ------------------------------------
    let orphanConfirmed = 0;
    if (orphans.length) {
      await this.dataSource.transaction(async (m: EntityManager) => {
        const logs: QueryDeepPartialEntity<OperationLog>[] = [];
        for (const o of orphans) {
          const upd = await m
            .createQueryBuilder()
            .update(Order)
            .set({ status: OrderStatus.COMPLETED, completedAt: at })
            .where('id = :id', { id: o.id })
            .andWhere('status = :st', { st: OrderStatus.DELIVERED })
            .execute();
          if ((upd.affected ?? 0) === 0) continue;

          orphanConfirmed += 1;
          logs.push({
            adminUserId: operatorId ?? null,
            module: 'order',
            action: '自动确认收货',
            targetId: String(o.id),
            requestData: { orderNo: o.orderNo, mealDate: date },
            snapshot: {
              fromStatus: OrderStatus.DELIVERED,
              toStatus: OrderStatus.COMPLETED,
              source: 'system',
              reason: '无归属团长的单：履约已发生，收口但不计佣',
            },
          });
        }
        if (logs.length) await logRepoOf(m).insert(logs);
      });
    }

    const notDeliveredCount = abnormal.length;
    this.logger.log(
      `自动确认 date=${date} 确认 ${confirmedCount} 单（${confirmedQuantity} 份 / ${leaders.length} 个团长）` +
        `计佣 ¥${(commissionFen / 100).toFixed(2)}（pending，次日 02:00 入账）` +
        `· 无归属收口 ${orphanConfirmed} 单` +
        `· 履约异常 ${notDeliveredCount} 单${notDeliveredCount ? '（需人工处理）' : ''}` +
        (operatorId ? `（操作人#${operatorId}）` : '（跑批）'),
    );
    if (notDeliveredCount) {
      this.logger.warn(
        `自动确认 date=${date} 有 ${notDeliveredCount} 单到 14:00 仍未送达` +
          `（${Object.entries(byStatus)
            .map(([s, n]) => `${s}=${n}`)
            .join(' / ')}）—— 已保持原状态，请检查出餐与配送环节`,
      );
    }

    return {
      date,
      confirmedCount,
      confirmedQuantity,
      commissionFen,
      leaders,
      notDelivered: {
        count: notDeliveredCount,
        byStatus,
        orderNos: abnormal.map((o) => o.orderNo),
      },
      orphanConfirmed,
      promotions,
    };
  }

  /**
   * 按楼群聚合「计入生产」的订单份数，回写 `ab_meal_assignment.sold_count`
   *
   * 口径见 `cutoffByDate()` 注释。本方法**幂等**（每次按当前订单重算覆盖），
   * 因此手动补跑能得到与跑批相同的数。
   */
  private async freezeSoldCounts(date: string): Promise<{
    byGroup: Array<{ buildingGroupId: number; quantity: number }>;
    totalQuantity: number;
  }> {
    const rows = await this.orderRepo
      .createQueryBuilder('o')
      .select('o.building_group_id', 'buildingGroupId')
      .addSelect('SUM(o.quantity)', 'quantity')
      .where('o.meal_date = :date', { date })
      .andWhere('o.status NOT IN (:...excluded)', {
        excluded: [OrderStatus.PENDING_PAY, OrderStatus.CANCELLED],
      })
      .groupBy('o.building_group_id')
      .getRawMany<{ buildingGroupId: string | number; quantity: string | number }>();

    const byGroup = rows.map((r) => ({
      buildingGroupId: Number(r.buildingGroupId),
      quantity: Number(r.quantity ?? 0),
    }));

    const assignments = await this.assignmentRepo.find({ where: { mealDate: date } });
    const qtyOf = new Map(byGroup.map((g) => [g.buildingGroupId, g.quantity]));
    for (const a of assignments) {
      const next = qtyOf.get(a.buildingGroupId) ?? 0;
      if (Number(a.soldCount) === next) continue;
      await this.assignmentRepo.update(
        { id: a.id },
        { soldCount: next, version: (a.version ?? 0) + 1 },
      );
    }

    return {
      byGroup,
      totalQuantity: byGroup.reduce((s, g) => s + g.quantity, 0),
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
      if (order.status === OrderStatus.CANCELLED && amountFen > 0) {
        // 状态机 §七 风险项：回调延迟到账（>30min 已取消）→ 自动原路退款 + 告警
        this.logger.error(
          `⚠️ 支付回调延迟到达，订单已取消 orderNo=${orderNo}，将自动原路退款 ${amountFen} 分`,
        );
        // M4-3：建单在事务内、通道调用走队列（异常路径不要求即时，自愈优先）。
        // ⚠️ 三处「退微信实付」的路径（取消 / 延迟到账 / 审批退款）从此共用
        //    RefundService 的建单 + 通道执行，不再各写一套。
        const r = await this.refundService.refundLatePayment(
          orderNo,
          amountFen,
          '回调延迟到达（订单已取消）自动退款',
        );
        if (!r.queued) {
          this.logger.error(`⚠️ 自动退款未入队（${r.reason ?? '-'}），订单 ${orderNo} 需人工核对`);
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

  /**
   * D10 改单专用：把该订单的**冻结余额**同步到新的抵扣额
   *
   * 为什么必须单独有这个方法：下单时 `balanceUsed` 是从可用余额**冻结**过去的
   * （`freezeBalance`），并没有真正花掉。改单改了抵扣额却不调整冻结额，
   * 就会出现「订单只抵 ¥10、却冻着 ¥25.80」—— 用户余额凭空少了一截，
   * 而且在他自己那侧看不到任何解释。
   *
   * 余额的四个动作（冻结 / 解冻 / 消费 / 退回）都留在本文件，
   * 就是为了让「钱的状态」只有一处实现、只有一处能改错。
   *
   * @returns `deltaFen > 0` 表示多冻了，`< 0` 表示解冻了
   */
  async syncFrozenBalance(orderId: number, newBalanceUsedFen: number): Promise<number> {
    return this.dataSource.transaction(async (m: EntityManager) => {
      const order = await m.findOne(Order, { where: { id: orderId } });
      if (!order) throw new BizException(ErrorCode.ORDER_NOT_FOUND);

      const oldFen = toFen(order.balanceUsed);
      const delta = newBalanceUsedFen - oldFen;
      if (delta === 0) return 0;

      if (delta > 0) {
        // 抵扣额变大 → 再冻一部分（可用余额不足 → 40002）
        const bal = await this.getOrCreateBalance(m, order.userId);
        if (toFen(bal.balance) < delta) {
          throw new BizException(
            ErrorCode.BALANCE_NOT_ENOUGH,
            `可用余额 ¥${bal.balance} 不足以再多抵扣 ¥${toYuanStr(delta)}`,
          );
        }
        await this.freezeBalance(m, order.userId, delta, order.orderNo);
      } else {
        // 抵扣额变小 → 解冻差额（冻结额不会小于抵扣额，故不会解出负数）
        await this.releaseBalance(m, order.userId, -delta, order.orderNo);
      }

      await m
        .getRepository(Order)
        .update(
          { id: order.id },
          { balanceUsed: toYuanStr(newBalanceUsedFen), version: (order.version ?? 0) + 1 },
        );
      return delta;
    });
  }

  /** 支付单创建前需要的信息（供 payment 域 U7 使用） */ async preparePrepay(
    userId: number,
    orderNo: string,
  ) {
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
}

/** 供其它模块复用的默认值导出（避免各处硬编码 pageSize） */
export const DEFAULT_PAGE = PAGE_DEFAULT;

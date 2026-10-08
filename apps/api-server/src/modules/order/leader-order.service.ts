import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';

import { DELIVERY_STATUS_LABEL, ORDER_STATUS_VIEW, OrderStatus } from '@abox/shared-types';

import { maskPhone } from '../../common/utils/crypto';
import { toFen } from '../../common/utils/money';
import { normalizePage, paginate } from '../../common/utils/response';
import { todayBj } from '../../common/utils/time';
import { TeamLeader } from '../../database/entities/leader.entity';
import { DeliveryRecord, Order } from '../../database/entities/order.entity';
import { OperationLog } from '../../database/entities/system.entity';
import { User } from '../../database/entities/user.entity';
import { CommissionService } from '../finance/commission.service';
import { LeaderPromotionService } from '../team-leader/promotion.service';
import {
  LeaderAbnormalQueryDto,
  LeaderExportQueryDto,
  LeaderOrdersQueryDto,
  PickupConfirmReqDto,
} from './dto/leader-order.dto';

/**
 * L9「一键分发」**允许被确认的源状态**（单一真相 · 本文件只此一处）
 *
 * ## ⭐ 口径（2026-10-08 裁决 · 缺陷 BE-01 收口）
 * 只允许 `delivered → completed`。`delivering`（货在路上、配送单尚未标记送达）
 * **不得**被顺手推进：替一张没送到的单确认收货，会把「货没到」这个事实永久抹掉，
 * 且团长可据此**提前拿到佣金**。
 *
 * ## 三处必须一致的来源（改任意一处都要同步另两处）
 *   ① 本常量（实现）；
 *   ② `order-state-machine.ts` 的 `ORDER_TRANSITIONS` —— 本常量必须等于
 *      「`ORDER_TRANSITIONS[from]` 含 `COMPLETED` 的那些 `from`」；
 *      （当前只有 `delivered`；`delivering` 的出边是 `[delivered, refund_applying]`）
 *   ③ `scripts/e2e-m3.mjs:11025-11027` —— 4.4 自动确认已断言
 *      「`delivering` 的单报为履约异常、不转 completed」，手动路径必须同口径。
 *
 * ⚠️ 现状的原缺陷形状就是「SELECT 与 UPDATE 各写一份状态集合」，两份迟早漂移；
 *    故此处收敛为一个常量，两处（SELECT / UPDATE）都引用它。
 */
export const CONFIRMABLE_FROM_STATUSES: OrderStatus[] = [OrderStatus.DELIVERED];

/**
 * 团长侧订单服务（M2 · 2.3 / 2.5）
 *
 * 落点：`modules/order`（《开发里程碑计划 v1.0》2.3、2.5）
 * 覆盖《接口规范》§4.2 订单聚合（L4/L5/L6）与 §4.3 取餐确认（L8/L9）。
 *
 * **「所辖订单」口径**：`team_leader_id = 本团长`，或历史未绑团长的单按
 * `building_id = 本团长所属楼` 兜底 —— 与《接口规范》§4.2「所辖订单」一致。
 *
 * ⚠️ 手机号出参**一律脱敏**（§1.6）；仅 L5 导出返回完整号且**必须写操作日志**。
 * ⚠️ 计佣基数 = **实发份数**（M2 风险项），由 `CommissionService.accrueForOrders` 承担，
 *    本服务只负责「确认分发」这一触发点。
 */
@Injectable()
export class LeaderOrderService {
  private readonly logger = new Logger('LeaderOrderService');

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(DeliveryRecord) private readonly deliveryRepo: Repository<DeliveryRecord>,
    @InjectRepository(OperationLog) private readonly opLogRepo: Repository<OperationLog>,
    private readonly commissionService: CommissionService,
    private readonly promotionService: LeaderPromotionService,
  ) {}

  // ---------------------------------------------------------------------------
  // L4 · 订单列表（手机号脱敏）
  // ---------------------------------------------------------------------------
  async listOrders(leader: TeamLeader, q: LeaderOrdersQueryDto) {
    const mealDate = q.mealDate?.trim() || todayBj();
    const { page, pageSize, skip } = normalizePage(q);

    const qb = this.orderRepo.createQueryBuilder('o').where('o.mealDate = :mealDate', { mealDate });
    this.applyScope(qb, leader);

    if (q.status?.trim()) qb.andWhere('o.status = :st', { st: q.status.trim() });
    if (q.keyword?.trim()) qb.andWhere('o.orderNo LIKE :kw', { kw: `%${q.keyword.trim()}%` });

    const [rows, total] = await qb
      .orderBy('o.createdAt', 'DESC')
      .skip(skip)
      .take(pageSize)
      .getManyAndCount();

    const users = await this.loadUsers(rows);
    return {
      mealDate,
      ...paginate(
        rows.map((o) => this.toView(o, users.get(Number(o.userId)))),
        total,
        page,
        pageSize,
      ),
    };
  }

  // ---------------------------------------------------------------------------
  // L5 · 导出（完整手机号 + 写操作日志）
  // ---------------------------------------------------------------------------
  async exportOrders(leader: TeamLeader, q: LeaderExportQueryDto, ip?: string) {
    const mealDate = q.mealDate?.trim() || todayBj();

    const qb = this.orderRepo
      .createQueryBuilder('o')
      .where('o.mealDate = :mealDate', { mealDate })
      .andWhere('o.status NOT IN (:...ex)', { ex: [OrderStatus.CANCELLED] });
    this.applyScope(qb, leader);

    const rows = await qb.orderBy('o.createdAt', 'ASC').getMany();
    const users = await this.loadUsers(rows);

    // ⚠️ 合规要求：导出完整手机号必须留痕（《接口规范》§4.2 L5）
    await this.opLogRepo.save(
      this.opLogRepo.create({
        adminUserId: null,
        module: 'leader',
        action: 'export_orders',
        targetId: mealDate,
        requestIp: ip ?? null,
        requestData: { leaderId: Number(leader.id), mealDate },
        responseData: { count: rows.length },
        snapshot: {
          exportedPhoneCount: rows.filter((o) => users.get(Number(o.userId))?.phone).length,
        },
      }),
    );
    this.logger.warn(
      `团长#${leader.id} 导出 ${mealDate} 订单明细（含完整手机号）共 ${rows.length} 条`,
    );

    return {
      fileName: `ABox_订单明细_${mealDate}_${leader.realName}.csv`,
      mealDate,
      count: rows.length,
      /** 导出列（端上据表头写 CSV） */
      headers: ['订单号', '用户昵称', '手机号', '份数', '金额(元)', '状态', '备注', '下单时间'],
      list: rows.map((o) => {
        const u = users.get(Number(o.userId));
        return [
          o.orderNo,
          u?.nickname ?? '',
          u?.phone ?? '', // 完整手机号（仅此接口）
          String(o.quantity),
          Number(o.totalAmount).toFixed(2),
          ORDER_STATUS_VIEW[o.status as OrderStatus]?.leader ?? o.status,
          o.remark ?? '',
          formatBj(o.createdAt),
        ];
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // L6 · 异常订单（待支付催促）
  // ---------------------------------------------------------------------------
  async listAbnormal(leader: TeamLeader, q: LeaderAbnormalQueryDto) {
    const mealDate = q.mealDate?.trim() || todayBj();

    const qb = this.orderRepo
      .createQueryBuilder('o')
      .where('o.mealDate = :mealDate', { mealDate })
      .andWhere('o.status = :st', { st: OrderStatus.PENDING_PAY });
    this.applyScope(qb, leader);

    const rows = await qb.orderBy('o.createdAt', 'ASC').getMany();
    const users = await this.loadUsers(rows);
    const now = Date.now();

    return {
      mealDate,
      count: rows.length,
      totalQuantity: rows.reduce((s, o) => s + Number(o.quantity || 0), 0),
      list: rows.map((o) => {
        const u = users.get(Number(o.userId));
        const ageMin = Math.max(0, Math.floor((now - new Date(o.createdAt).getTime()) / 60000));
        return {
          ...this.toView(o, u),
          /** 未支付已持续分钟数，供端上标红催促 */
          unpaidMinutes: ageMin,
          urgeLevel: ageMin >= 20 ? 'high' : ageMin >= 10 ? 'mid' : 'low',
        };
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // L8 · 本楼今日取餐
  // ---------------------------------------------------------------------------
  async pickupToday(leader: TeamLeader, mealDateInput?: string) {
    const mealDate = mealDateInput?.trim() || todayBj();

    const qb = this.orderRepo
      .createQueryBuilder('o')
      .where('o.mealDate = :mealDate', { mealDate })
      .andWhere('o.status NOT IN (:...ex)', {
        ex: [OrderStatus.CANCELLED, OrderStatus.REFUNDED],
      });
    this.applyScope(qb, leader);

    const rows = await qb.orderBy('o.createdAt', 'ASC').getMany();
    const users = await this.loadUsers(rows);

    const deliveredStatuses = [OrderStatus.DELIVERED, OrderStatus.COMPLETED];
    const totalQuantity = rows.reduce((s, o) => s + Number(o.quantity || 0), 0);
    const doneQuantity = rows
      .filter((o) => deliveredStatuses.includes(o.status as OrderStatus))
      .reduce((s, o) => s + Number(o.quantity || 0), 0);

    // 配送记录按楼群维度（uk_delivery_date_group = mealDate + buildingGroupId）
    const groupId = rows[0]?.buildingGroupId;
    const delivery = groupId
      ? await this.deliveryRepo.findOne({
          where: { mealDate, buildingGroupId: Number(groupId) },
        })
      : null;

    return {
      mealDate,
      totalQuantity,
      /** 已确认（completed）份数 */
      confirmedQuantity: rows
        .filter((o) => o.status === OrderStatus.COMPLETED)
        .reduce((s, o) => s + Number(o.quantity || 0), 0),
      /** 待取餐 + 已送达 份数（可确认范围） */
      pendingQuantity: totalQuantity - doneQuantity,
      /**
       * ⭐ 与 L9 **同源**：`CONFIRMABLE_FROM_STATUSES`（方法头裁决①）。
       *
       * 改前这里写死 `[delivering, delivered]` —— 与 L9 实际只认 `delivered` 的口径**不一致**：
       * 团长的确认按钮亮着（本字段为 true），点下去却被 L9 判「货还在路上、没有待确认」而空转。
       * 同一口径各写一份必然漂移，故此处不再复写字面量。
       */
      canConfirm: rows.some((o) => CONFIRMABLE_FROM_STATUSES.includes(o.status as OrderStatus)),
      delivery: delivery
        ? {
            status: delivery.status,
            statusText: DELIVERY_STATUS_LABEL[delivery.status] ?? delivery.status,
            expectedAt: delivery.expectedAt,
            actualAt: delivery.actualAt ?? null,
            driverName: delivery.driverName ?? null,
            driverPhone: delivery.driverPhone ?? null,
            plateNo: delivery.plateNo ?? null,
          }
        : null,
      members: rows.map((o) => this.toView(o, users.get(Number(o.userId)))),
    };
  }

  // ---------------------------------------------------------------------------
  // L9 · 确认收货并一键分发（幂等 · 按实发份数计佣）
  // ---------------------------------------------------------------------------
  /**
   * L9 · 确认收货并一键分发（幂等 · 按实发份数计佣）
   *
   * ## ⭐ 2026-10-08 裁决（缺陷 BE-01 / BE-02 收口 —— 改前这两处都在偷偷犯错）
   *
   *   ① **只认 `delivered`**（`CONFIRMABLE_FROM_STATUSES`）：`delivering` —— 货在路上、
   *      配送单尚未标记送达 —— **不许**被顺手推进成 `completed`。替一张没送到的单确认
   *      收货，会把「货没到」这个事实永久抹掉，而团长凭这一下就能**提前拿到佣金**。
   *      同一口径在「4.4 自动确认」上早已被 e2e 钉死：
   *      `scripts/e2e-m3.mjs:11025-11027` 断言 `delivering` 的单报为履约异常、不转 completed。
   *      ⚠️ 源状态集合此前在 SELECT 与 UPDATE 各写一份（两份迟早漂移），现已收敛为常量。
   *   ② **`delivering` 的单必须如实暴露，不许静默消失**：单独计数后以
   *      `skippedDeliveringCount` 下发，端上据此提示「还有 N 单未送达，送达后才能确认」。
   *      静默跳过后团长看到的是「没有待确认的订单」—— 而真实原因是货没到：
   *      前者他只能反复点按钮，后者他可以去催配送。
   *   ③ **计佣入参 = 真正推进成功的行**（BE-02）：改为逐单条件更新、收集 `affected = 1`
   *      的那些单。集合 UPDATE 只回一个总数、**不回「哪几行归我」**（本仓
   *      `order.service.ts:674-678` 已就这一取舍写过裁决）；若拿 SELECT 读到的集合去计佣，
   *      并发下被别人抢走的单会被照算佣金，并污染 `ab_team_leader.total_orders`。
   */
  async confirmPickup(leader: TeamLeader, dto: PickupConfirmReqDto) {
    const mealDate = todayBj();

    const orders = await this.buildPickupQuery(leader, mealDate, dto.orderNos)
      .andWhere('o.status IN (:...st)', { st: CONFIRMABLE_FROM_STATUSES })
      .getMany();

    /**
     * ⭐ 在配送途中、本次**刻意不推进**的单（同范围：`mealDate` + 团长所辖 + 同批单号）
     *
     * 复用 `applyScope` 收窄，避免把别团长的 `delivering` 单算进来（IDOR）。
     */
    const skippedDeliveringCount = await this.buildPickupQuery(leader, mealDate, dto.orderNos)
      .andWhere('o.status = :st', { st: OrderStatus.DELIVERING })
      .getCount();

    if (!orders.length) {
      // 已全部确认时重复点击：返回零值而非报错（幂等友好）
      return {
        mealDate,
        confirmedCount: 0,
        confirmedQuantity: 0,
        commissionFen: 0,
        repeated: true,
        /** 见方法头裁决②：有货在路上的单时，把「为什么没有待确认」如实给端上 */
        skippedDeliveringCount,
        tips:
          skippedDeliveringCount > 0
            ? `还有 ${skippedDeliveringCount} 单在配送途中，送达后才能确认分发`
            : '没有待确认的订单（可能已全部确认）',
      };
    }

    const now = new Date();
    const { confirmed, accrued } = await this.dataSource.transaction(async (m) => {
      /**
       * ⭐ 逐单条件更新（防并发重复确认 + 拿到「哪几行归我」）
       *
       * 改前是一条集合 UPDATE：`affected` 只给总数，随后却拿**全部 SELECT 结果**去计佣
       * ⇒ 被并发抢走的单照样计佣（BE-02）。逐单后 `confirmed` 就是唯一可信的集合。
       */
      const transitioned: Order[] = [];
      for (const o of orders) {
        const upd = await m
          .createQueryBuilder()
          .update(Order)
          .set({ status: OrderStatus.COMPLETED, completedAt: now })
          .where('id = :id', { id: o.id })
          .andWhere('status IN (:...st)', { st: CONFIRMABLE_FROM_STATUSES })
          .execute();
        if ((upd.affected ?? 0) === 0) continue; // 已被别处推进 / 已转退款 → 不计佣
        transitioned.push(o);
      }

      if (transitioned.length !== orders.length) {
        // 不静默：并发下「看到了 N 单、只推进了 M 单」是可对账的事实，必须留痕
        this.logger.warn(
          `一键分发：团长#${leader.id} 选中 ${orders.length} 单，实际推进 ${transitioned.length} 单` +
            `（${orders.length - transitioned.length} 单已被别处处理，本次不计佣）`,
        );
      }

      // 计佣（幂等：已计佣的订单会被跳过）—— 入参**只**是真正推进成功的行
      const acc = await this.commissionService.accrueForOrders(leader, transitioned, undefined, m);
      return { confirmed: transitioned, accrued: acc };
    });

    this.logger.log(
      `一键分发：团长#${leader.id} 确认 ${confirmed.length} 单 / ${accrued.quantity} 份，` +
        `计佣 ¥${(accrued.amountFen / 100).toFixed(2)}（费率 ${Number(leader.commissionRate) * 100}%）` +
        (skippedDeliveringCount ? ` · 配送途中未确认 ${skippedDeliveringCount} 单` : ''),
    );

    // C2 晋级审计（M2-2.9）：计佣即改变「月单」，故在事务**外**重算并落表。
    // ⚠️ 放事务外是刻意的 —— 审计失败不该把「已确认分发 + 已计佣」整体回滚
    //    （钱已经进账了），故此处只记日志、不抛错。
    let level: string = leader.level;
    let rate = Number(leader.commissionRate);
    try {
      const audit = await this.promotionService.audit(Number(leader.id));
      if (audit) {
        level = audit.after;
        rate = audit.rate;
      }
    } catch (e) {
      this.logger.warn(`晋级审计失败（不影响分发与计佣）：${(e as Error).message}`);
    }

    return {
      mealDate,
      /** 本次**真正**完成状态推进的订单数（== 计佣入参的行数，见方法头裁决③） */
      confirmedCount: confirmed.length,
      confirmedQuantity: accrued.quantity,
      /**
       * 本次**计佣**金额（分）—— 验收标准 3：实发份数 × 等级费率
       *
       * ⚠️ **不是「本次到账金额」**（M4-2 两段式后语义变化）：佣金先记 `pending`，
       *    T+1 02:00 由 `commission-settle.task` 统一入账。端上文案须写明
       *    「将于次日 02:00 入账」，否则团长确认后看不到余额变，会以为钱丢了。
       */
      commissionFen: accrued.amountFen,
      commissionYuan: (accrued.amountFen / 100).toFixed(2),
      /** 本次确认的订单单号（端上展示「已确认哪几单」） */
      orderNos: accrued.orderNos,
      rate,
      level,
      repeated: false,
      /** 见方法头裁决②：同范围内 `delivering` 的单数（本次未确认，送达后才可确认） */
      skippedDeliveringCount,
      confirmedAt: now,
    };
  }

  // ---------------------------------------------------------------------------
  // 内部工具
  // ---------------------------------------------------------------------------

  /**
   * L9 的选单范围（`mealDate` + 团长所辖 + 可选单号集合）
   *
   * ⭐ **每次调用都新建一个 QB**：`applyScope` 是**原地** `andWhere`，复用同一个实例
   *    会把两个不同状态的查询条件叠在一起（查「已送达」与查「配送途中」各要一份）。
   */
  private buildPickupQuery(
    leader: TeamLeader,
    mealDate: string,
    orderNos?: string[],
  ): SelectQueryBuilder<Order> {
    const qb = this.orderRepo.createQueryBuilder('o').where('o.mealDate = :mealDate', { mealDate });
    this.applyScope(qb, leader);
    if (orderNos?.length) qb.andWhere('o.orderNo IN (:...nos)', { nos: orderNos });
    return qb;
  }

  /** 所辖订单范围：本团长单，或历史未绑团长时按楼栋兜底 */
  private applyScope(qb: SelectQueryBuilder<Order>, leader: TeamLeader): void {
    qb.andWhere(
      new Brackets((w) => {
        w.where('o.teamLeaderId = :leaderId', { leaderId: Number(leader.id) }).orWhere(
          '(o.teamLeaderId IS NULL AND o.buildingId = :buildingId)',
          { buildingId: Number(leader.buildingId) },
        );
      }),
    );
  }

  /** 批量取用户（避免 N+1） */
  private async loadUsers(rows: Order[]): Promise<Map<number, User>> {
    const ids = [...new Set(rows.map((r) => Number(r.userId)))];
    if (!ids.length) return new Map();
    const users = await this.userRepo.find({ where: { id: In(ids) } });
    return new Map(users.map((u) => [Number(u.id), u]));
  }

  /** 团长视角订单视图（手机号脱敏） */
  private toView(o: Order, u?: User) {
    return {
      orderNo: o.orderNo,
      userName: u?.nickname ?? null,
      /** ⚠️ 脱敏：138****0007 */
      phoneMasked: maskPhone(u?.phone),
      quantity: Number(o.quantity || 0),
      unitPriceFen: toFen(Number(o.unitPrice)),
      totalAmountFen: toFen(Number(o.totalAmount)),
      payAmountFen: toFen(Number(o.payAmount)),
      status: o.status,
      statusText: ORDER_STATUS_VIEW[o.status as OrderStatus]?.leader ?? o.status,
      mealDate: o.mealDate,
      remark: o.remark ?? null,
      createdAt: o.createdAt,
      completedAt: o.completedAt ?? null,
    };
  }
}

/** 北京时间 yyyy-MM-dd HH:mm（导出用） */
function formatBj(d: Date): string {
  const t = new Date(new Date(d).getTime() + 8 * 3600 * 1000);
  return t.toISOString().slice(0, 16).replace('T', ' ');
}

import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
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
      // ⭐ fail-closed（2026-09-18 · 缺陷 #82 收口）
      // 旧写法是 `logger.warn` + `return 0`（静默跳过），而调用链把 `order.balanceUsed`
      // 当作「余额已退回」报给运营与端上 → 钱没退、无流水、出参还说已退，
      // **三处同时错且对账无痕**（没有流水行可以比对）。
      // 现在停住：宁可让运营看到一条明确的错误（走 D11 兜底通道人工处理），
      // 也不能让一笔退款「看起来成功了」。
      throw new BizException(
        ErrorCode.BALANCE_ACCOUNT_MISSING,
        `订单 ${order.orderNo} 使用了 ¥${order.balanceUsed} 余额抵扣，` +
          `但用户 #${order.userId} 没有余额账户 —— 退款已中止（数据异常，请技术核对余额数据）`,
      );
    }

    const balance = round2(Number(account.balance) + amountFen / 100);
    // ⭐ 乐观锁（与 `withdraw.service.ts:96` / `balance-admin.service.ts:321` 同款 · 缺陷 #81 收口）
    // 旧写法只写 `WHERE id = :id`：`account.balance` 是**读出来在 JS 里加**的，
    // 读与写之间若有另一路写点（T+1 02:00 佣金入账跑批 / 另一笔退款退回）提交，
    // 这里会把**过期值**写回去 —— 丢更新；而且 `ab_balance_log.balanceAfter`
    // 记的是**自己算的那个错值**，流水与余额**一起错、彼此自洽**，事后对账抓不住。
    const upd = await m
      .createQueryBuilder()
      .update(Balance)
      .set({ balance: money(balance), version: () => 'version + 1' })
      .where('id = :id AND version = :v', { id: account.id, v: account.version })
      .execute();
    if (!upd.affected) {
      throw new BizException(
        ErrorCode.BALANCE_CONCURRENT_MODIFIED,
        '退款退回余额时发现余额已被其它操作改动，本次退款未执行，请重试',
      );
    }

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
   * 五种「无需扣余额」的情形，各自有明确原因（都不算错误）：
   *   · 该单**从未计佣**（截单前取消 / 未走到 `completed`）→ 无原行
   *   · 已有冲销行（重复退款 / 重放）→ `uk_commission_order_type` 唯一索引兜底
   *   · **原佣金仍为 `pending`（已计佣、尚未入账）→ 直接作废原行，见下** ⭐ M4-2 新增
   *   · **原行状态不是 `settled` / `pending`（如已 `cancelled`）→ 本次是重复或并发退款** ⭐ 本批新增
   *   · **并发占位失败（`affected = 0`）→ 另一次冲销已推进该行** ⭐ 本批新增
   *   · 找不到团长（数据异常）→ 仍写冲销行，但不动余额，`notes` 里留痕
   *
   * ⚠️ 余额允许被扣成负数：团长可能已经把佣金提现走了。这不是 bug ——
   *    真实业务里就是要形成「欠款」由其后续佣金抵扣，硬拦会把退款卡死。
   *
   * ⭐ **两段式（M4-2）带来的新分支**：佣金两段式后，`pending` 成为每天都会出现的
   *    正常中间态（T 日确认计佣 → T+1 02:00 入账）。用户在**这个窗口内**申请退款，
   *    原佣金还停在 `pending`，钱**从未进过团长余额**。此时若照 `settled` 的路径走，
   *    会从余额里扣一笔**从未入账**的钱 —— 团长余额被凭空扣减、甚至扣成负数形成
   *    **假欠款**，而且**没有任何地方会报错**（余额本来就可以为负，见上）。
   *    故 `pending` 必须单独走「只作废、不动钱」的路径。
   *
   * ⭐⭐ **并发安全（本批修正）**：判定「原行可否冲销」**只由一次条件更新决定**
   *    （`WHERE id = ? AND status = ?`，以 `affected` 判定归属），不再依赖
   *    「先 `findOne` 看一眼再写」—— 后者在两次并发退款下会让同一单被冲销两次。
   *    详见方法体内「原子占位」注释。
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

    /**
     * ⭐ **可冲销的状态只有两个**：`pending`（钱未入账）与 `settled`（钱已入账）。
     *
     * ⚠️ 这里刻意写成**白名单**，而不是「`pending` 走特殊分支、其余一律按 `settled` 处理」——
     *    后者的隐含前提是「不是 `pending` 就一定是 `settled`」，而这个前提**不成立**：
     *    本方法第一次被调用时若原行是 `pending`，会把它推进到 `cancelled`（见下），
     *    于是**第二次**调用就落进 `settled` 分支 —— 凭空写一条 −X 的冲销行，
     *    并从团长余额里扣掉一笔**从未入账**的钱，形成**假欠款**。
     *    该路径既不报错也无告警（余额本来就可以为负，见上方方法注释），
     *    只在团长自己核对时表现为「少钱了」。
     *    同族的坑见《缺陷与陷阱》#63（一张表里行本身带符号 → 漏一个状态判断就静默算错）。
     */
    const status = String(origin.status);
    if (status !== 'settled' && status !== 'pending') {
      notes.push(`该单佣金已是「${status}」，本次无需冲销（重复或并发退款，未动余额）`);
      return { reversedFen: 0, quantity: 0 };
    }
    /** 只有 `settled`（钱真的进过余额）才允许反向扣减；`pending` 只作废、不碰钱 */
    const payFromBalance = status === 'settled';

    const existed = await m.findOne(Commission, { where: { orderId, type: 'reversal' } });
    if (existed) {
      notes.push(`佣金冲销已存在（${existed.id}），跳过`);
      return { reversedFen: 0, quantity: 0 };
    }

    /**
     * ⭐⭐ **原子占位（并发下的唯一真相）**
     *
     * 「先查后写」在并发下是错的：两次退款可能**都**读到 `settled`、都判定「可冲销」，
     * 各自写一条冲销负行、各扣一次团长余额 —— 对外表现为**同一单被冲销两次**。
     * 唯一索引 `uk_commission_order_type` 拦得住第二条负行，但那是**数据库报错**、
     * 不是幂等：调用方拿到的是一个未分类的驱动异常，能不能兜住还取决于
     * 「负行写入」与「余额扣减」的先后顺序。**靠报错兜底 = 把正确性寄托在错误发生的时机上。**
     *
     * 故把「原行是否仍可冲销」交给**数据库判定**：`WHERE id = ? AND status = ?` 的条件更新，
     * 以 `affected` 判定归属 —— 只有一个调用者能把行推进到 `cancelled`，
     * 另一个拿到 0 → 直接返回且**一分钱都不动**。
     *
     * ⭐ 这与同模块 `settlePending` 的 `UPDATE … WHERE id = ? AND status = 'pending'` 是
     *   **同一族做法**（同一模块内不允许出现两种幂等范式）。
     * ⭐ 本表**无 `version` 列**，故不写 `version + 1`：`pending|settled → cancelled`
     *   是**值一定改变**的更新，MySQL 的 changed-rows 与 sqlite 的 `changes` 都返回 1，
     *   不存在「值没变 → affected=0 被误判成冲突」的陷阱（M5-1 D62 踩过的那个）。
     */
    const claim = await m
      .createQueryBuilder()
      .update(Commission)
      .set({ status: 'cancelled' })
      .where('id = :id', { id: origin.id })
      .andWhere('status = :expected', { expected: status })
      .execute();
    if ((claim.affected ?? 0) === 0) {
      notes.push('并发退款：该笔佣金已被另一次冲销处理，本次跳过（未动余额）');
      return { reversedFen: 0, quantity: 0 };
    }

    /**
     * ⭐ 关键分支：原佣金仍为 `pending` —— 钱还在「待入账」，从未进过余额。
     *
     * 处理：**只把原行作废（`pending → cancelled`），不写冲销行、不写余额流水**。
     *   · 作废本身已由上面的「原子占位」完成，此处**不再写库**（重复写会多一次空更新）。
     *   · 净效果与 `settled` 路径**一致**（这笔佣金不再支付），故出参仍如实报
     *     「冲销了多少」（`reversedFen` = 原行金额）—— 端上「本次冲掉佣金 ¥X」
     *     的展示与已入账情形无差别，不需要分叉。
     *   · 但**账目形态不同**：不写冲销行，是因为钱没有发生过，没有可反向的账；
     *     写一条 -X 的冲销行反而会凭空多出一笔「支出」。
     */
    if (!payFromBalance) {
      notes.push(
        `该单佣金尚未入账（pending），已直接作废、**未动余额** —— ` +
          `退款发生在「T 日确认计佣」与「T+1 02:00 入账」之间`,
      );
      return {
        reversedFen: toFen(Math.abs(Number(origin.amount))),
        quantity: -Math.abs(Number(origin.quantity)),
      };
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

    // 原行**已由上面的「原子占位」置为 `cancelled`**，此处不再重复写库。
    // 金额保持原值 —— 发生额历史不可改写（C9）；唯一的字段改写就是那个 `status`。

    const leader = await m.findOne(TeamLeader, { where: { id: Number(origin.teamLeaderId) } });
    if (!leader) {
      notes.push(`佣金冲销已记账，但团长 #${origin.teamLeaderId} 不存在，余额未扣减`);
      return { reversedFen: toFen(Math.abs(amountYuan)), quantity };
    }

    const userId = Number(leader.userId);
    const account = await m.findOne(Balance, { where: { userId } });
    if (!account) {
      // ⚠️ 这里**刻意保留**「仅记账不扣款」，与 ① 的 fail-closed **不同**，别当漏改：
      // 团长从未领过佣金时本来就没有余额账户行（账户由 `creditCommissions` 首次入账时创建），
      // 「无账户」 = 「余额恒为 0」，不扣是对的。
      // 而 ① 的场景里用户**确实用过余额抵扣**却查不到账户，那才是数据异常。
      // 两者的分界是：**这笔钱当初有没有进过这个账本**。
      notes.push('团长无余额账户，冲销仅记账');
      return { reversedFen: toFen(Math.abs(amountYuan)), quantity };
    }

    const balance = round2(Number(account.balance) + amountYuan);
    // ⭐ 乐观锁 · 缺陷 #81 收口（同 ②：读-改-写窗口内可能被跑批入账抢先）
    const upd = await m
      .createQueryBuilder()
      .update(Balance)
      .set({ balance: money(balance), version: () => 'version + 1' })
      .where('id = :id AND version = :v', { id: account.id, v: account.version })
      .execute();
    if (!upd.affected) {
      throw new BizException(
        ErrorCode.BALANCE_CONCURRENT_MODIFIED,
        '退款佣金冲销时发现团长余额已被其它操作改动，本次退款未执行，请重试',
      );
    }

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

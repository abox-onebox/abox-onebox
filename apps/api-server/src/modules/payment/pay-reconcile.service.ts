import { Injectable, Logger } from '@nestjs/common';

import { decideReconcileAction, ReconcileAction } from '../../common/utils/pay-reconcile';
import { BizException } from '../../common/exceptions/biz.exception';
import { now } from '../../common/utils/time';
import { OrderService } from '../order/order.service';
import { WxpayService } from './wxpay.service';

/**
 * P3 · 支付单边账补齐（2026-10-29）
 *
 * ## 它补的是什么洞
 * 微信支付成功的唯一权威信号是**回调**。回调会丢（网络、验签失败、进程重启、
 * 微信重试窗口过后放弃）。丢了的后果是：钱已收，本地订单**永远停在 `pending_pay`**——
 * 用户看到「未支付」，而截单跑批会把它当未支付**取消**掉。这是 P0 六条里
 * **唯一可能造成资金差错**的一条（另五条是可观测 / 举证 / 效率问题）。
 *
 * 补齐手段：向微信**查单**（`WxPayProvider.queryOrder`），按真实状态决定补入账还是不动。
 *
 * ## ⛔ 三条红线（改动前先读）
 * 1. **查询失败 ⇒ 不动单**。查单失败时绝不能猜「大概没付」去关单 ——
 *    「收了钱还把单关了」是资金差错，比「多挂一会儿」危险得多。
 * 2. **`found:false` ≠ 没付**。那是「微信没这笔单」（订单号可能压根没送到微信），
 *    只记一笔交人工，不自动关单。
 * 3. **金额不符 ⇒ 不入账**（判据在 `decideReconcileAction`，本处不重写第二份）。
 *
 * ## 幂等
 * 重复跑是安全的：已转 `paid` 的订单不再出现在扫描结果里；
 * 即便并发重复，`markPaid()` 自带 `WHERE status = pending_pay` 的状态守卫。
 */

/** 宽限期（分钟）：回调一般秒级到达，超过这个时间仍挂 pending_pay 才值得查微信 */
const DEFAULT_GRACE_MINUTES = 5;

/** 单轮最多处理多少单（防一次扫出上千单把接口打满） */
const DEFAULT_LIMIT = 200;

export interface PayReconcileDetail {
  orderNo: string;
  action: ReconcileAction | 'failed';
  note: string;
}

export interface PayReconcileOutcome {
  /** 扫到的滞留待支付订单数 */
  scanned: number;
  /** 补齐入账成功数（本轮真正挽回的单边账） */
  paid: number;
  /** 微信明确未支付 / 不可判定（保持原状） */
  stillUnpaid: number;
  /** 微信查无此单（需人工核对） */
  notFound: number;
  /** 金额不符（**未入账**，需人工核对） */
  mismatch: number;
  /** 查单失败（**未动单**，等下轮重试） */
  failed: number;
  details: PayReconcileDetail[];
}

@Injectable()
export class PayReconcileService {
  private readonly logger = new Logger('PayReconcile');

  constructor(
    private readonly orders: OrderService,
    private readonly wxpay: WxpayService,
  ) {}

  /**
   * 扫描并补齐滞留的待支付订单
   *
   * @param graceMinutes 宽限期（分钟）；缺省 5 分钟
   * @param limit        单轮上限；缺省 200
   */
  async reconcile(opts?: { graceMinutes?: number; limit?: number }): Promise<PayReconcileOutcome> {
    const graceMinutes = opts?.graceMinutes ?? DEFAULT_GRACE_MINUTES;
    const limit = opts?.limit ?? DEFAULT_LIMIT;

    const deadline = new Date(now().getTime() - graceMinutes * 60_000);
    const rows = await this.orders.listStalePendingPay(deadline, limit);

    const outcome: PayReconcileOutcome = {
      scanned: rows.length,
      paid: 0,
      stillUnpaid: 0,
      notFound: 0,
      mismatch: 0,
      failed: 0,
      details: [],
    };

    for (const row of rows) {
      // ⛔ 查询失败必须被接住并计 failed，**不得**让异常中断整轮
      //    （一张单查不动，不能连累后面几十张可补的单）
      let query;
      try {
        query = await this.wxpay.queryOrder(row.orderNo);
      } catch (e) {
        const msg = e instanceof BizException ? `${e.code} ${e.message}` : (e as Error).message;
        outcome.failed += 1;
        outcome.details.push({
          orderNo: row.orderNo,
          action: 'failed',
          note: `查单失败（未动单，下轮重试）：${msg}`,
        });
        this.logger.error(`查单失败 orderNo=${row.orderNo}：${msg}`);
        continue;
      }

      const d = decideReconcileAction({ payAmountFen: row.payAmountFen, query });

      if (d.action === 'paid') {
        // ⭐ 补齐动作**复用** markPaid：金额核对、状态抢占、幂等全在它里面，
        //    本处不写第二套入账逻辑（写两套 = 两套都会漂移）
        const r = await this.orders.markPaid(
          row.orderNo,
          query.transactionId ?? `QRY_${row.orderNo}`,
          row.payAmountFen,
          {
            via: 'pay_reconcile',
            tradeState: query.tradeState,
          },
        );
        if (r.changed) {
          outcome.paid += 1;
          outcome.details.push({ orderNo: row.orderNo, action: 'paid', note: d.note });
          this.logger.warn(
            `⚠️ 补齐一笔单边账 orderNo=${row.orderNo}（回调丢失，已按微信查单结果入账）`,
          );
        } else {
          // 并发下订单已不是 pending_pay（例如刚好被回调/取消推进）⇒ 计为未动单
          outcome.stillUnpaid += 1;
          outcome.details.push({
            orderNo: row.orderNo,
            action: 'still_unpaid',
            note: `入账未生效（${r.reason ?? '-'}）：订单状态已变化，未动单`,
          });
        }
        continue;
      }

      if (d.action === 'amount_mismatch') {
        outcome.mismatch += 1;
        this.logger.error(`⚠️ 查单金额不符，未入账 orderNo=${row.orderNo}：${d.note}`);
      } else if (d.action === 'not_found') {
        outcome.notFound += 1;
        this.logger.warn(`查无此单 orderNo=${row.orderNo}：${d.note}`);
      } else {
        outcome.stillUnpaid += 1;
      }
      outcome.details.push({ orderNo: row.orderNo, action: d.action, note: d.note });
    }

    this.logger.log(
      `支付查单补齐完成：扫描 ${outcome.scanned} / 补齐 ${outcome.paid} / 未付 ${outcome.stillUnpaid} / ` +
        `查无此单 ${outcome.notFound} / 金额不符 ${outcome.mismatch} / 查单失败 ${outcome.failed}`,
    );

    return outcome;
  }
}

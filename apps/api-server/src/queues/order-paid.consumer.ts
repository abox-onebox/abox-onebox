import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { QueueService } from '../common/queue/queue.service';
import { OrderService } from '../modules/order/order.service';
import { OrderPaidPayload } from './queue-payloads';

/**
 * `order-paid` 消费者 —— 支付入账失败重试（M4-3）
 *
 * ## 为什么需要它
 *
 * 微信支付回调（以及 mock 的自动回调）**必须快速回 `SUCCESS`**：回 `FAIL` 会被
 * 微信持续重推，形成风暴（`payment.service.ts` 里对此有明确注释）。
 * 于是「回调到了、但入账失败」（DB 抖动 / 连接闪断）就变成一个**没有下家**的状态：
 * 此前只能等次日 04:00 对账跑批发现差异 —— 而用户当天就会发现「付了钱没订上」。
 *
 * `markPaid` 本身**已经幂等**（`status !== pending_pay` 直接返回 + `uk_payment_order`
 * 保证一单一条流水），所以它可以被安全地重试 —— 这个消费者就是把这件事做起来。
 *
 * ## ⚠️ 生产端只在「同步入账失败」时入队
 *
 * 回调路径会**先同步尝试一次**，失败才入队（见 `PaymentService`）：
 * 成功是常态（秒级），不该让正常支付也绕一圈队列。
 */
@Injectable()
export class OrderPaidConsumer implements OnModuleInit {
  private readonly logger = new Logger('Queue:order-paid');

  constructor(
    private readonly queue: QueueService,
    private readonly order: OrderService,
  ) {}

  onModuleInit(): void {
    this.queue.register('order-paid', (payload) => this.handle(payload as OrderPaidPayload));
  }

  /**
   * 重试一次入账
   *
   * ⚠️ 这里最关键的是**区分「失败」与「本来就不需要做」**：
   * `markPaid` 返回 `changed=false` 有三种完全不同的含义，其中只有两种该重试。
   */
  private async handle(payload: OrderPaidPayload): Promise<void> {
    const r = await this.order.markPaid(
      payload.orderNo,
      payload.transactionId,
      payload.amountFen,
      payload.raw,
    );

    if (r.changed) {
      this.logger.log(`补入账成功 orderNo=${payload.orderNo}（第 ${payload.amountFen} 分）`);
      return;
    }

    // 「订单不在待支付态」= 上一次其实已经入账（或订单已被取消）→ **正常结束，不重试**。
    // 若这里盲目抛错，微信重复回调导致的任务会被重试三次、再进死信，
    // 让真正的失败淹没在噪音里。
    if (r.reason?.startsWith('status=')) {
      this.logger.log(`订单 ${payload.orderNo} 无需入账（${r.reason}）`);
      return;
    }

    // 订单不存在 / 金额不符 → 抛错交给队列重试；三次后进死信并写操作日志
    throw new Error(`支付入账未完成：${r.reason ?? '未知原因'}`);
  }
}

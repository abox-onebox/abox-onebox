import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { QueueService } from '../common/queue/queue.service';
import { RefundService } from '../modules/finance/refund.service';
import { RefundApplyPayload } from './queue-payloads';

/**
 * `refund-apply` 消费者 —— 微信退款的**执行与重试**（M4-3）
 *
 * ## 为什么会有这条队列
 *
 * M4-3 之前，微信退款是**在 DB 事务里**调的（`executeRefund`）：退款单、账务冲销、
 * 通道退款三者绑死在同一个事务上，两个方向都不对：
 *   · 通道成功 + 事务回滚 → **钱退了、系统没记录**（账实不符，且不可自愈）；
 *   · 通道失败 → 整笔退款被拒（`40010`），运营只能从头再来。
 * 现在的划分是：**事务内只落账务**（冲销 + 退款单 + 订单状态，全 DB、可回滚）
 * → **事务提交后**才碰外部通道（`deliverOrQueueRefund` 同步试一次，失败入本队列）。
 *
 * ## ⭐ 本消费者的职责**刻意很薄**
 *
 * 「微信退款怎么调、什么时候算完成、失败怎么写单据」全在
 * `RefundService.attemptWxRefund()` —— 那里有幂等判断（单据已 `refunded` 直接返回、
 * 已 `rejected` 不重试）与 `refundNo` 幂等键。消费者**不做任何业务判断**，
 * 否则同一套判断就有两份实现（本项目头号顽疾「两个真相」）。
 * 这与 `order-paid` 消费者只调 `markPaid` 是同一个写法。
 *
 * ## ⭐ 幂等键 = `refundNo`（允许自动重试的前提）
 *
 * 重试携带**同一个** `refundNo`（微信 `out_refund_no`），微信侧识别为同一笔退款 ——
 * 因此「重试」永远不会变成「重复出款」。**这个不变量一旦被打破，自动重试就是危险的**
 * （故 `queue-payloads.ts` 里把 `refundNo` 标成必带字段）。
 */
@Injectable()
export class RefundApplyConsumer implements OnModuleInit {
  private readonly logger = new Logger('Queue:refund-apply');

  constructor(
    private readonly queue: QueueService,
    private readonly refund: RefundService,
  ) {}

  onModuleInit(): void {
    this.queue.register('refund-apply', (payload) => this.handle(payload as RefundApplyPayload));
  }

  /**
   * 调一次微信退款并收口退款单
   *
   * 抛错 = 交给队列退避重试（`refundNo` 保证不会重复出款）。
   * 「本来就不需要做」的两种情况（单据已退 / 已驳回）由 `attemptWxRefund`
   * 内部正常返回 —— 见该方法注释里为什么不能用抛错表达「不需要重试」。
   */
  private async handle(payload: RefundApplyPayload): Promise<void> {
    this.logger.log(
      `执行微信退款 refundNo=${payload.refundNo} orderNo=${payload.orderNo}` +
        ` ${payload.wxFen} 分（重试任务）`,
    );
    await this.refund.attemptWxRefund(payload);
  }
}

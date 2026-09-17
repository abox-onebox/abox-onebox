import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { QueueService } from '../common/queue/queue.service';
import { CommissionService } from '../modules/finance/commission.service';
import { SettleOrdersPayload } from './queue-payloads';

/**
 * `settle-orders` 消费者 —— 佣金入账通知投递（M4-3）
 *
 * ## 为什么通知要离开跑批主路径
 *
 * `commission-settle` 跑批（T+1 02:00）把 `pending` 佣金入账，入账本身是**一笔 DB 事务**；
 * 通知是**外部 IO**（微信订阅消息，网络往返 + 可能重试）。把通知写在跑批里有两个问题：
 *   · 通知慢 → 跑批拖长；通知抛错 → 整批回滚（**钱没入账，只因为一条通知发不出去**）；
 *   · 跑批**不会**为「通知失败」重跑（它次日才再跑一次，那时入账已完成，
 *     通知就永远补不上了）。
 * 故：入账归入账（事务），通知入队（尽力立刻、失败可重试）。
 *
 * ## 为什么是**一个团长一条任务**（而不是整批一条）
 *
 * 订阅消息必须指定收件人。整批一条的载荷里没有收件人，消费者只能写日志 ——
 * 「通知用户」实际没发生却看起来成功。拆成一人一条后：独立重试、死信粒度到人、
 * 某个团长投递失败不连累其他人。详见 `queue-payloads.ts` 的 `SettleOrdersPayload`。
 *
 * ## 同样很薄
 *
 * `leader → userId → openid` 的换算与文案组装在
 * `CommissionService.notifySettled()`：那里更接近团长数据，且文案变量必须与
 * `MESSAGE_TEMPLATE_SPECS.commission_settled` 的白名单一致。
 *
 * ## 抛错语义
 *
 * `notifySettled` 只在「查库异常」时抛错（重试有意义）；
 * 「团长档案不存在」「场景未启用 / 缺模板 ID」都**正常返回**（重试三次也不会有档案、
 * 或缺的模板 ID 不会自己长出来）—— 见 `queue.types.ts` 的处理器契约：
 * **不要用抛错表达「业务上不需要重试」**。
 */
@Injectable()
export class SettleOrdersConsumer implements OnModuleInit {
  private readonly logger = new Logger('Queue:settle-orders');

  constructor(
    private readonly queue: QueueService,
    private readonly commissions: CommissionService,
  ) {}

  onModuleInit(): void {
    this.queue.register('settle-orders', (payload) => this.handle(payload as SettleOrdersPayload));
  }

  private async handle(payload: SettleOrdersPayload): Promise<void> {
    this.logger.log(
      `投递佣金入账通知 leader=#${payload.leaderId} date=${payload.mealDate}` +
        ` ${payload.settledCount} 笔 / ${payload.amountFen} 分`,
    );
    await this.commissions.notifySettled(payload);
  }
}

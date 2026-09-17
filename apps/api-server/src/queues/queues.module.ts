import { Module } from '@nestjs/common';

import { FinanceModule } from '../modules/finance/finance.module';
import { MessageModule } from '../modules/message/message.module';
import { OrderModule } from '../modules/order/order.module';
import { OrderPaidConsumer } from './order-paid.consumer';
import { QueueAdminController } from './queue-admin.controller';
import { RefundApplyConsumer } from './refund-apply.consumer';
import { SettleOrdersConsumer } from './settle-orders.consumer';

/**
 * 队列模块（MVP 用 Redis + BullMQ，不引入 RabbitMQ —— 《目录结构 v2.0》§四）
 *
 * ## 三个消费者各接到哪条链路的「后续」
 *
 * | 队列 | 生产端（谁入队） | 消费者做什么 |
 * |------|------------------|--------------|
 * | `order-paid`    | 支付回调 / mock 自动回调 | 入账失败的**重试**（回调已回 SUCCESS，入账不能只等次日对账） |
 * | `refund-apply`  | 退款审批 / 强制退款 | 微信退款的**执行与重试**（外部通道调用已移出 DB 事务） |
 * | `settle-orders` | 佣金入账跑批 | 入账通知投递（失败重试，不阻塞跑批） |
 *
 * ## 一条贯穿三者的纪律
 *
 * 入队点的**业务动作必须已经落定**（订单已 paid、退款单已生成、佣金已 settled）——
 * 队列只承接「**后续**」，不承接「业务本身」。否则一次队列故障就会变成业务故障，
 * 而队列的价值恰恰在于「后续失败不拖垮主流程」。
 *
 * ⚠️ 队列实例（`QueueService`）由全局 `CommonModule` 提供，本模块不重复 import。
 */
@Module({
  imports: [OrderModule, FinanceModule, MessageModule],
  controllers: [QueueAdminController],
  providers: [OrderPaidConsumer, RefundApplyConsumer, SettleOrdersConsumer],
})
export class QueuesModule {}

import { Module } from '@nestjs/common';
import { OrderPaidConsumer } from './order-paid.consumer';
import { RefundApplyConsumer } from './refund-apply.consumer';
import { SettleOrdersConsumer } from './settle-orders.consumer';

/** 队列模块（MVP 用 Redis + BullMQ，不引入 RabbitMQ） */
@Module({
  providers: [OrderPaidConsumer, RefundApplyConsumer, SettleOrdersConsumer],
})
export class QueuesModule {}

import { Injectable } from '@nestjs/common';

/** 支付成功后续：确认支付、推送订阅消息、写支付流水 */
@Injectable()
export class OrderPaidConsumer {}

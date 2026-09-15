import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

/**
 * 每日 04:00 与微信支付对账
 * ⚠️ 必须幂等：以 meal_date / date 为幂等键，重复触发返回首次结果
 * 见《订单状态机与全链路流转 v1.0》§3.1 定时任务清单
 */
@Injectable()
export class ReconciliationTask {
  private readonly logger = new Logger(ReconciliationTask.name);

  @Cron('0 0 4 * * *', { timeZone: 'Asia/Shanghai' })
  async handle(): Promise<void> {
    this.logger.log('ReconciliationTask 触发（占位实现）');
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

/**
 * T 日 00:30 生成配送单
 * ⚠️ 必须幂等：以 meal_date / date 为幂等键，重复触发返回首次结果
 * 见《订单状态机与全链路流转 v1.0》§3.1 定时任务清单
 */
@Injectable()
export class DeliveryGenerateTask {
  private readonly logger = new Logger(DeliveryGenerateTask.name);

  @Cron('0 30 0 * * *', { timeZone: 'Asia/Shanghai' })
  async handle(): Promise<void> {
    this.logger.log('DeliveryGenerateTask 触发（占位实现）');
  }
}

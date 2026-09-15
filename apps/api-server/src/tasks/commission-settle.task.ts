import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

/**
 * T+1 02:00 佣金入账（计入佣金余额）
 * ⚠️ 必须幂等：以 meal_date / date 为幂等键，重复触发返回首次结果
 * 见《订单状态机与全链路流转 v1.0》§3.1 定时任务清单
 */
@Injectable()
export class CommissionSettleTask {
  private readonly logger = new Logger(CommissionSettleTask.name);

  @Cron('0 0 2 * * *', { timeZone: 'Asia/Shanghai' })
  async handle(): Promise<void> {
    this.logger.log('CommissionSettleTask 触发（占位实现）');
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

/**
 * 每日 03:00 见习团长 30 天未促单失效（C2）
 * ⚠️ 必须幂等：以 meal_date / date 为幂等键，重复触发返回首次结果
 * 见《订单状态机与全链路流转 v1.0》§3.1 定时任务清单
 */
@Injectable()
export class LeaderExpireTask {
  private readonly logger = new Logger(LeaderExpireTask.name);

  @Cron('0 0 3 * * *', { timeZone: 'Asia/Shanghai' })
  async handle(): Promise<void> {
    this.logger.log('LeaderExpireTask 触发（占位实现）');
  }
}

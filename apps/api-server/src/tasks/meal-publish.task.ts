import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

/**
 * T-1 14:00 套餐上架（开团）
 * ⚠️ 必须幂等：以 meal_date / date 为幂等键，重复触发返回首次结果
 * 见《订单状态机与全链路流转 v1.0》§3.1 定时任务清单
 */
@Injectable()
export class MealPublishTask {
  private readonly logger = new Logger(MealPublishTask.name);

  @Cron('0 0 14 * * *', { timeZone: 'Asia/Shanghai' })
  async handle(): Promise<void> {
    this.logger.log('MealPublishTask 触发（占位实现）');
  }
}

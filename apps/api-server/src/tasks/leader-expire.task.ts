import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { LeaderPromotionService } from '../modules/team-leader/promotion.service';

/**
 * 每日 03:00 · 见习团长 30 天未促单失效（C2）
 *
 * 口径（《接口规范》§4.5 附注 + §4.6 `expireRule`）：
 *   「见习团长 30 天未促成订单自动取消资格」——
 *   判据 `last_order_at` 距今 > 30 天；**从未促单者以建档时间起算**
 *   （否则「从未出过单」的见习团长永久免于失效，与 C2 语义相反）。
 *
 * 处置：`ab_team_leader.status` 置 2（停职）—— **不是删除**，档案与历史全留，
 *   日后可重新申请（`apply` 对停职者有「复职并重置为见习」分支）。
 *
 * ⚠️ 幂等：只有「在职 + 见习 + 超期」三者同时成立才动作，第二次执行必然为空。
 *    e2e / 运维手动触发走 `LeaderPromotionService.expireTrainees()`，不经本任务。
 * 见《订单状态机与全链路流转 v1.0》§3.1 定时任务清单。
 */
@Injectable()
export class LeaderExpireTask {
  private readonly logger = new Logger(LeaderExpireTask.name);

  constructor(private readonly promotionService: LeaderPromotionService) {}

  @Cron('0 0 3 * * *', { timeZone: 'Asia/Shanghai' })
  async handle(): Promise<void> {
    try {
      const expired = await this.promotionService.expireTrainees(30);
      this.logger.log(
        `见习失效扫描完成：停职 ${expired.length} 名${expired.length ? `（#${expired.join(' #')}）` : ''}`,
      );
    } catch (e) {
      // 定时任务失败不得让进程崩：记录后由下一日重跑（判定幂等，重跑安全）
      this.logger.error(`见习失效扫描失败：${(e as Error).message}`);
    }
  }
}

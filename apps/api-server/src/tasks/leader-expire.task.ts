import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { LeaderPromotionService } from '../modules/team-leader/promotion.service';
import { ScheduleService, TASK_SCHEDULES } from './schedule.service';

const NAME = 'leader-expire' as const;
const SPEC = TASK_SCHEDULES[NAME];

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

  constructor(
    private readonly sched: ScheduleService,
    private readonly promotionService: LeaderPromotionService,
  ) {}

  @Cron(SPEC.cron, { timeZone: SPEC.timeZone })
  async handle(): Promise<void> {
    // 本任务 `dateKind = null`（全量扫描，与出餐日无关）—— 锁键按「当日」防同日重复跑
    const outcome = await this.sched.run(NAME, () => this.runOnce());

    if (outcome.error || !outcome.result) return; // `run()` 已记录失败原因
    const expired = outcome.result;
    this.logger.log(
      `见习失效扫描完成：停职 ${expired.length} 名${expired.length ? `（#${expired.join(' #')}）` : ''}`,
    );
  }

  /**
   * 业务执行口（**不含锁**）—— 跑批与手动补跑共用
   *
   * 本任务与出餐日无关（全量扫描），故不接受 `date` 参数 —— 后台补跑口会传，
   * 此处显式忽略（`_date`），以免调用方误以为「某个日期没扫到」。
   *
   * 手动补跑：`POST /admin/schedule/leader-expire/run`（不带锁）。
   */
  async runOnce(_date?: string) {
    return this.promotionService.expireTrainees(30);
  }
}

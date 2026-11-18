import { Injectable, Logger } from '@nestjs/common';

import { LeaderPromotionService } from '../modules/team-leader/promotion.service';
import { ScheduleService } from './schedule.service';

const NAME = 'trainee-warn' as const;

/**
 * 每日 10:00 · 见习到期预警（团长激活三件套之一 · 2026-11-18）
 *
 * ## 它补的是「沉默的死」
 *
 * 见习团长 30 天未促单会被 `leader-expire`（03:00）**直接停职** —— 停职后
 * `LeaderGuard` 挡住所有团长端接口、端上团长入口凭空消失。此前这条链路上
 * **没有任何中途提示**：团长照常过完第 29 天，第 30 天早上身份就没了。
 *
 * 而被停职的人本来是**可以救的**：他只要在此之前出一单就续上。
 * 前提是他知道自己在倒计时 —— 这就是本任务存在的全部理由。
 *
 * ## 为什么定 10:00（而不是跟着 03:00 一起跑）
 *
 * 夜里发提醒只有负收益：他看到时已经过了一夜，且「凌晨三点收到还差几天到期」
 * 本身就是一种打扰。上午 10 点是他最可能看到、并**当天**做出反应的时刻。
 * （同一条取舍 2026-11-18 已在截单提醒上定过一次：零点发没有意义。）
 *
 * ## ⚠️ 判据「恰好剩 7 天」，不是「最后 7 天每天发」
 *
 * 详见 `LeaderPromotionService.warnExpiringTrainees()` 的注释：等于判据天然幂等，
 * 不依赖任何「发过没发过」的落库状态；代价是漏跑一天就少一次提醒，
 * 由 7 天后的停职通知兜底。
 *
 * ## ⚠️ 本类不含 `@Cron` 装饰器
 *
 * 与其余 9 个任务同理（缺陷 #49）：装饰器参数在模块加载时求值一次，
 * 后台改配置不可能影响它。实际 cron 由 `ScheduleRegistrar` 在 `onModuleInit`
 * 按 `TASK_SCHEDULES['trainee-warn']` 动态注册。
 */
@Injectable()
export class TraineeWarnTask {
  private readonly logger = new Logger(TraineeWarnTask.name);

  constructor(
    private readonly sched: ScheduleService,
    private readonly promotionService: LeaderPromotionService,
  ) {}

  /** 跑批入口（**带锁**）—— 由 `ScheduleRegistrar` 动态注册后触发 */
  async handle(): Promise<void> {
    const outcome = await this.sched.run(NAME, () => this.runOnce());

    // ⚠️ 不能用 `!outcome.result` 判空：`0` 是**正常结果**（今天没人到期），
    //    用假值判定会把「扫了但没人需要提醒」当成失败静默掉。
    if (outcome.error || outcome.result === null || outcome.result === undefined) return;
    this.logger.log(`见习到期预警扫描完成：成功提醒 ${outcome.result} 名`);
  }

  /**
   * 业务执行口（**不含锁**）—— 跑批与手动补跑共用
   *
   * 与出餐日无关（全量扫描），故忽略 `_date`。
   * 手动补跑：`POST /admin/schedule/trainee-warn/run`。
   */
  async runOnce(_date?: string) {
    return this.promotionService.warnExpiringTrainees();
  }
}

import { Injectable, Logger } from '@nestjs/common';

import { PayReconcileOutcome, PayReconcileService } from '../modules/payment/pay-reconcile.service';
import { ScheduleService } from './schedule.service';

const NAME = 'pay-reconcile' as const;

/**
 * P3 · 支付查单补齐跑批（2026-10-29）
 *
 * ## 为什么它是**高频**任务，而其余 8 个都是每日一次
 * 其余任务动的是「某一天的数据」（开团 / 截单 / 结算），一天跑一次就够；
 * 本任务动的是「**此刻**挂着的待支付订单」—— 支付回调是秒级事件，
 * 若按每日一次，用户从支付到被补齐最长要等 24 小时，那期间订单已被截单取消，
 * 补齐就失去意义了。故它是**唯一**不走 `BusinessTimeline` 的任务
 * （`cronOf()` 只能表达「每日某时刻」，表达不了「每 30 分钟」）。
 *
 * ⚠️ 因此 `TASK_SCHEDULES` 里它的 `timelineKey` 为 `null`、`cron` 直接写死 ——
 *    这是**刻意的例外**，不是忘了接线（已在 `schedule.service.ts` 注明）。
 *
 * ## 锁的语义（与每日型任务不同）
 * `dateKind = null` ⇒ 锁键按当日（「同一天」），TTL 30 分钟。
 * 于是每 30 分钟触发 + 30 分钟锁 ≈ 实际每 30 分钟推进一批；
 * 失败时 `run()` 会**立即释放锁**，下一次触发（30 分钟后）可重放。
 *
 * ## 它不写业务
 * 扫描与补齐全在 `PayReconcileService` —— 跑批与后台补跑共用同一执行口，
 * 避免「定时跑一种逻辑、点按钮跑另一种」。
 */
@Injectable()
export class PayReconcileTask {
  private readonly logger = new Logger(PayReconcileTask.name);

  constructor(
    private readonly sched: ScheduleService,
    private readonly reconcile: PayReconcileService,
  ) {}

  /**
   * 跑批入口 —— **由 `ScheduleRegistrar` 在运行时动态注册**，本类不含 `@Cron`。
   *
   * ⚠️ 不用装饰器的原因（缺陷 #49）：`@Cron()` 在模块加载时求值一次即成静态元数据，
   *    本任务的 cron 是「每 30 分钟」，不属于任何配置项，靠装饰器同样没问题，
   *    但为与其余任务**保持同一条注册路径**（否则「注册环节出问题 ⇒ 静默不跑」
   *    的风险会从一个入口变成两个），仍统一由注册器装载。
   */
  async handle(): Promise<void> {
    const outcome = await this.sched.run(NAME, () => this.runOnce());

    if (outcome.error || !outcome.result) return; // `run()` 已记录失败原因
    const o: PayReconcileOutcome = outcome.result;

    // ⭐ 补齐成功 = **发生过回调丢失**，是异常信号，必须 WARN（不是 log）
    if (o.paid > 0) {
      this.logger.warn(
        `⚠️ 支付查单补齐【挽回 ${o.paid} 笔单边账】—— 说明存在回调丢失，请排查支付回调链路`,
      );
    }
    // 金额不符 / 查无此单 / 查单失败：都要人看，不能只留在 counts 里
    if (o.mismatch > 0) {
      this.logger.error(
        `⚠️ 查单金额不符 ${o.mismatch} 笔（**未入账**），需人工核对：见回执 details`,
      );
    }
    if (o.notFound > 0) {
      this.logger.warn(`微信查无此单 ${o.notFound} 笔（订单号可能未送达微信），需人工核对`);
    }
    if (o.failed > 0) {
      this.logger.error(`查单失败 ${o.failed} 笔（未动单，下轮重试）`);
    }
  }

  /**
   * 业务执行口（**不含锁**）—— 跑批与手动补跑共用
   *
   * 本任务与出餐日无关（扫的是「此刻」的滞留单），故不接受 `date` 参数 ——
   * 后台补跑口会传，此处显式忽略（`_date`）。
   *
   * 手动补跑：`POST /admin/schedule/pay-reconcile/run`（不带锁）。
   */
  async runOnce(_date?: string): Promise<PayReconcileOutcome> {
    return this.reconcile.reconcile();
  }
}

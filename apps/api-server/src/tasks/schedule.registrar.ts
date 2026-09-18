import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { BizConfigService } from '../common/services/biz-config.service';
import {
  DEFAULT_TIMELINE,
  TIMELINE_LABEL,
  TimelineDiff,
  formatTimeOfDay,
  onTimelineChange,
} from '../common/utils/order-timeline';
import { AutoConfirmTask } from './auto-confirm.task';
import { CommissionSettleTask } from './commission-settle.task';
import { CutoffTask } from './cutoff.task';
import { DeliveryGenerateTask } from './delivery-generate.task';
import { LeaderExpireTask } from './leader-expire.task';
import { MealPublishTask } from './meal-publish.task';
import { ReconciliationTask } from './reconciliation.task';
import { TASK_SCHEDULES, TaskName, cronFor } from './schedule.service';
import { SupplierShareTask } from './supplier-share.task';

/**
 * 定时任务注册器 —— 让**后台配置真的能改变跑批时刻**（缺陷 #49 的接线部分）
 *
 * ## 为什么不能继续用 `@Cron(SPEC.cron)`
 * `@Cron()` 是**装饰器参数**：它在**模块加载时**求值一次，之后就是静态元数据
 * （由调度库读真实钟）。因此 `TASK_SCHEDULES` 里的 cron 是「编译期常量」，
 * 后台改配置**永远不可能**影响到它 —— 这就是「配了不生效」的机制性原因。
 *
 * NestJS 提供了运行时可用的出口：`SchedulerRegistry.addCronJob()`。
 * 于是本类在 `onModuleInit` 时：
 *   1. 读 `ab_config` → 解析出**生效时间轴**（`BizConfigService.timeline()`）
 *   2. 按时间轴**生成**每个任务的 cron（`cronFor()`，时刻来自 `order-timeline.ts`）
 *   3. 动态注册 8 个 `CronJob`
 *
 * ## ⭐ 注册 ≠ 只在启动时注册一次（否则等于把漂移换个位置复现）
 * 若只在启动时读一次配置，运营改完配置就必须**重启服务**才生效 —— 而「下单窗口」
 * 是**立即**跟着变的（`time.ts` 的锚点函数逐次读 `currentTimeline()`）。
 * 结果就会出现「用户已经不能下单了、截单跑批还在老时刻跑」这种**半生效**状态：
 * 比不接线更难查（配置页显示已生效、跑批按旧时刻，两处都不报错）。
 *
 * 故本类订阅 `onTimelineChange()`：任何**时刻类**配置写入 → 配置缓存 `invalidate()`
 * → 时间轴刷新 → 本类**热重载** cron。改配置与跑批时刻因此是**同一次变更**。
 * （纯金额/文案类配置变更不触发热重载 —— 见 `onTimelineChanged` 的字段过滤。）
 *
 * ## ⚠️ 这里最危险的失败形态是「任务静默不跑」
 * 少了 `@Cron` 装饰器之后，若注册环节出任何问题（名字拼错、异常被吞、`start()` 漏调），
 * 结果**不是报错**，而是「这个任务从此再也没有跑过」—— 而 e2e 全走补跑接口，
 * **不会发现**。故本类有三道防护：
 *   · 注册完**逐名核对** `doesExist('cron', name)`，缺一个立即抛错（**阻止进程启动**）
 *   · 启动横幅打印「已注册 N/8 + 各自 cron（含配置覆写标记）」
 *   · `GET /admin/schedule` 的 `registeredCron` 字段暴露**实际注册值**（外部可观测）
 */
@Injectable()
export class ScheduleRegistrar implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ScheduleRegistrar');

  /** 任务名 → 跑批处理器（**带锁**的那一个，与补跑口刻意不同） */
  private readonly handlers: ReadonlyMap<TaskName, () => Promise<void>>;

  /**
   * 「本注册器真正关心的时刻字段」—— 由声明表反查得出，**不手写**。
   *
   * 用途：过滤无关的配置变更。改 `settlement.site_fee` 也会触发 `invalidate()`，
   * 但那是成本单价、与跑批时刻无关，不该白重载 8 个 cron。
   */
  private readonly watchedFields: ReadonlySet<string> = new Set(
    (Object.values(TASK_SCHEDULES) as Array<{ timelineKey: string }>).map((s) => s.timelineKey),
  );

  /** 取消订阅（`OnModuleDestroy` 时回收；e2e 反复建/停服务时避免监听器累积） */
  private offTimeline: (() => void) | null = null;

  /**
   * 最近一次「注册/重注册」的进行中 promise（`null` = 当前无重载在跑）
   *
   * ⭐ 存在的理由：`GET /admin/schedule` 会回报**实际注册**的 cron。若重载正在进行中
   * （删除旧 job 与新增 job 之间），此刻读到的就是**中间态**：任务数少几个、
   * cron 是旧的 —— 一个「正在变更」的读数被当成「坏了」，比不报更误导人。
   * 故由 `settled()` 让读取方等重载落定（见 `ScheduleAdminService.list()`）。
   */
  private pending: Promise<unknown> | null = null;

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly bizConfig: BizConfigService,
    private readonly cfg: ConfigService,
    mealPublish: MealPublishTask,
    cutoff: CutoffTask,
    deliveryGenerate: DeliveryGenerateTask,
    autoConfirm: AutoConfirmTask,
    commissionSettle: CommissionSettleTask,
    supplierShare: SupplierShareTask,
    reconciliation: ReconciliationTask,
    leaderExpire: LeaderExpireTask,
  ) {
    this.handlers = new Map<TaskName, () => Promise<void>>([
      ['meal-publish', () => mealPublish.handle()],
      ['cutoff', () => cutoff.handle()],
      ['delivery-generate', () => deliveryGenerate.handle()],
      ['auto-confirm', () => autoConfirm.handle()],
      ['commission-settle', () => commissionSettle.handle()],
      ['supplier-share', () => supplierShare.handle()],
      ['reconciliation', () => reconciliation.handle()],
      ['leader-expire', () => leaderExpire.handle()],
    ]);
  }

  async onModuleInit(): Promise<void> {
    await this.registerAll();
    // 订阅放在注册**之后**：首帧注册已按生效配置完成，订阅只处理「后续变更」
    this.offTimeline = onTimelineChange((_tl, diffs) => this.onTimelineChanged(diffs));
  }

  onModuleDestroy(): void {
    this.offTimeline?.();
    this.offTimeline = null;
  }

  /**
   * 等待最近一次注册/重载**落定**（供读取方使用，见 `pending` 字段注释）
   *
   * ⚠️ 刻意不吞异常：`pending` 已在 `onTimelineChanged` 内部挂了 `.catch`，
   *    故此处的 `await` 不会抛 —— 调用方拿到的是「已结束」而非「成功了」。
   */
  async settled(): Promise<void> {
    await this.pending;
  }

  /**
   * 时间轴变更 → 必要时热重载 cron
   *
   * ⚠️ **必须同步返回**（订阅契约：不得同步抛出）。故异步重载用 `void ... .catch()` 兜底，
   *    失败只告警不抛出 —— 配置载入不该因为「重注册 cron 失败」而整体失败
   *    （那会让运营改一个金额都改不动），但必须在日志里留下重载失败的原因。
   */
  private onTimelineChanged(diffs: TimelineDiff[]): void {
    const relevant = diffs.filter((d) => this.watchedFields.has(d.field));
    if (!relevant.length) return;

    const desc = relevant.map((d) => `${TIMELINE_LABEL[d.field]} ${d.from}→${d.to}`).join(' · ');
    this.logger.log(`业务时刻配置变更，热重载跑批时刻：${desc}`);
    this.pending = this.registerAll().catch((e: unknown) => {
      this.logger.error(
        `跑批时刻热重载失败（配置已生效、但 cron 仍是旧时刻，需排查后重启服务）：${
          (e as Error).message
        }`,
      );
    });
  }

  /**
   * 按**当前生效配置**注册（或重注册）全部任务
   *
   * 幂等：已存在的注册先删再建，故可安全用于「配置变更后热重载」。
   */
  async registerAll(): Promise<{ registered: number; lines: string[] }> {
    const timeline = await this.bizConfig.timeline();
    const names = Object.keys(TASK_SCHEDULES) as TaskName[];

    // 先**无条件**摘掉旧注册 —— 关闭开关时也必须走这一步：否则「关掉」只是不再新增，
    // 已经在跑的那些会一直留到进程重启，看起来像生效了、其实没停。
    for (const name of names) {
      if (this.registry.doesExist('cron', name)) this.registry.deleteCronJob(name);
    }

    // ⭐ M5-7：接线 `TASKS_ENABLED`（此前是**死配置** —— `app.config.ts` 定义了它、
    //    全仓却没有任何读取点，整体审查报告 §二 已登记）。
    //    开关的价值在本地：调试时不想让跑批在后台改数据（e2e / 内部测试都不需要它，
    //    跑批一律走补跑接口）。生产默认 true，且**生产环境请确认这不是误配**。
    if (this.cfg.get<boolean>('app.tasksEnabled') === false) {
      this.logger.warn(
        `TASKS_ENABLED=false —— 本进程**不注册任何跑批任务**（共 ${names.length} 个）：` +
          '到点不会自动跑，需要时请走补跑接口。若这不是你想要的，检查环境变量。',
      );
      return { registered: 0, lines: ['TASKS_ENABLED=false · 全部跑批任务未注册'] };
    }

    const lines: string[] = [];
    for (const name of names) {
      const spec = TASK_SCHEDULES[name];
      const handler = this.handlers.get(name);
      if (!handler) {
        // 声明表加了任务却没接处理器 —— 必须报错，不能让它「看起来在跑」
        throw new Error(
          `任务「${name}」在 TASK_SCHEDULES 中有声明，但 ScheduleRegistrar 没有对应的处理器 —— ` +
            `请同时注册 handler（否则该任务永远不会跑，且不会有任何报错）`,
        );
      }

      const cron = cronFor(spec, timeline);
      const job = CronJob.from({
        cronTime: cron,
        onTick: () => void handler(),
        start: false,
        timeZone: spec.timeZone,
      });
      this.registry.addCronJob(name, job);
      job.start();

      const overridden =
        formatTimeOfDay(timeline[spec.timelineKey]) !==
        formatTimeOfDay(DEFAULT_TIMELINE[spec.timelineKey]);
      lines.push(
        `${name.padEnd(19)} ${cron}  (${TIMELINE_LABEL[spec.timelineKey]} ${formatTimeOfDay(
          timeline[spec.timelineKey],
        )}${overridden ? ' · 配置覆写' : ''})`,
      );
    }

    // 自证：注册结果必须与声明表逐条对齐（防「静默不跑」）
    const missing = names.filter((n) => !this.registry.doesExist('cron', n));
    if (missing.length) {
      throw new Error(
        `定时任务注册失败：${missing.length} 个任务未注册成功（${missing.join(' / ')}）—— ` +
          `这类故障**不会有任何运行时报错**，只会让任务永远不跑；故在此直接拒绝启动`,
      );
    }

    this.logger.log(
      `已注册 ${names.length}/${names.length} 个定时任务（时区 ${TASK_SCHEDULES[names[0]].timeZone}）：`,
    );
    for (const l of lines) this.logger.log(`  ${l}`);

    return { registered: names.length, lines };
  }

  /** 当前**实际注册**的 cron（供 `GET /admin/schedule` 暴露给外部观测） */
  actualCron(task: TaskName): string | null {
    if (!this.registry.doesExist('cron', task)) return null;
    const job = this.registry.getCronJob(task);
    // ⚠️ `cronTime.source` 在 cron v3 的类型是 `string | DateTime`（可传 Date 构造），
    //    故必须显式 `String()` 归一 —— 直接 `??` 返回会让出参类型不是字符串，
    //    且端上拿到非字符串时 `registeredCron` 的「非空即已注册」判据会静默失真。
    const src = job.cronTime?.source;
    return src === undefined ? null : String(src);
  }
}

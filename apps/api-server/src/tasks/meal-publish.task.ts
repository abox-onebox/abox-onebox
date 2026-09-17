import { Injectable, Logger } from '@nestjs/common';

import { MealAdminService, PublishByDateResult } from '../modules/meal/meal-admin.service';
import { ScheduleService } from './schedule.service';

const NAME = 'meal-publish' as const;

/**
 * T-1 14:00 · 开团（4.1）
 *
 * 口径：《订单状态机与全链路流转 v1.0》§3 「T-1 14:00 meal-publish.task 开团：
 *      次日套餐上架，用户可下单」（原型 P1 `can_order=true`）
 *
 * ## 目标日期是「**明日**」，不是「今日」
 * ⚠️ 本任务与 `auto-confirm` 的 cron **完全相同**（`0 0 14 * * *`），但两者动的
 *    是**不同的一天**：
 *      · `meal-publish`  开的是 **D+1** 的团 —— 因为 D+1 的开团时刻正是 D 日 14:00
 *      · `auto-confirm`  确认的是 **D** 日的单 —— D 日 14:00 收 D 日已送达的货
 *    把两者写反，代码照样编译、也未必立刻报错。故日期**不在这里算**，
 *    一律由 `ScheduleService.requireDateForTask()` 从声明表推导。
 *
 * ## 只做委托
 * 开团的状态迁移（`pending → active` + `publish_at` + `cutoff_at` + 过截单闸门）
 * 全在 `MealAdminService.publishByDate()` —— 与运营手动点「上架」共用同一段逻辑，
 * 跑批不会长出第二套口径。
 *
 * 手动补跑（e2e / 运维）：直接调 `MealAdminService.publishByDate(date)`，不经本任务。
 */
@Injectable()
export class MealPublishTask {
  private readonly logger = new Logger(MealPublishTask.name);

  constructor(
    private readonly sched: ScheduleService,
    private readonly meals: MealAdminService,
  ) {}

  /**
   * 跑批入口 —— **由 `ScheduleRegistrar` 在运行时按生效配置动态注册**，本类不含 `@Cron`。
   *
   * ⚠️ 不用装饰器的原因（缺陷 #49）：`@Cron()` 是**修饰器参数**，在模块加载时求值一次
   *    后即为静态元数据，后台改「开团/截单时刻」**不可能**影响它 —— 表现为「配了不生效」。
   *    改为动态注册后，配置变更可热替换（无需重启）。
   *    ⚠️ 这也意味着**删掉注册逻辑不会有任何报错，只会让任务永远不跑** ——
   *    故注册器内有逐名核对与启动横幅（见 schedule.registrar.ts）。
   */
  async handle(): Promise<void> {
    const outcome = await this.sched.run(NAME, (date) => this.runOnce(date));

    if (outcome.error || !outcome.result) return; // `run()` 已记录失败原因
    const r = outcome.result;
    const { date } = outcome;

    if (r.blockedByCutoff) {
      this.logger.warn(
        `开团未执行 date=${date} 已过截单时刻 —— 若该日出餐计划本就未排，属正常；` +
          '若预期有团，请检查排期日期是否正确',
      );
      return;
    }
    if (r.total === 0) {
      this.logger.warn(`开团 date=${date} 无分配记录 —— 该日出餐计划尚未排期，用户端不会出现套餐`);
      return;
    }
    this.logger.log(
      `开团完成 date=${date} 上架 ${r.published} 个楼群` +
        `（已上架 ${r.alreadyActive} / 已停团 ${r.skippedCancelled}）`,
    );
  }

  /**
   * 业务执行口（**不含锁**）—— 跑批与手动补跑共用
   *
   * · 跑批：`handle()` 经 `sched.run()` 调用（带锁，同一目标日期只跑一次）
   * · 手动补跑：`POST /admin/schedule/meal-publish/run`（**不带锁** ——
   *   补跑的意义正是「跑批没跑成/要重跑」，被锁挡住就失去用途）
   */
  async runOnce(date: string): Promise<PublishByDateResult> {
    return this.meals.publishByDate(date);
  }
}

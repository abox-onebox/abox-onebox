import { Injectable, Logger } from '@nestjs/common';

import { ErrorCode } from '../common/constants/error-code';
import { BizException } from '../common/exceptions/biz.exception';
import { isRealDate, todayBj } from '../common/utils/time';
import { AutoConfirmTask } from './auto-confirm.task';
import { CommissionSettleTask } from './commission-settle.task';
import { CutoffTask } from './cutoff.task';
import { DeliveryGenerateTask } from './delivery-generate.task';
import { LeaderExpireTask } from './leader-expire.task';
import { MealPublishTask } from './meal-publish.task';
import { ReconciliationTask } from './reconciliation.task';
import { ScheduleService, TASK_SCHEDULES, TaskName, isTaskName } from './schedule.service';
import { SupplierShareTask } from './supplier-share.task';

/** 跑批时刻表的一行（`GET /admin/schedule`） */
export interface ScheduleRow {
  task: TaskName;
  cron: string;
  timeZone: string;
  /** 操作的目标日期语义；`null` = 与出餐日无关（全量扫描） */
  dateKind: 'today' | 'tomorrow' | 'yesterday' | null;
  /** 中文日期语义（端上直接显示，不自行翻译） */
  dateKindLabel: string;
  what: string;
  /**
   * 是否已实装
   *
   * ⚠️ 如实标注：M4 分三个子批次推进（日切 / 结算 / 队列），
   *    本字段让运营在页面上**看得见哪几个任务的代码还没落地** ——
   *    而不是让一个「看起来在跑、其实只打了一行日志」的占位任务
   *    被当成功能已上线（同 #50「声明与闸门是同一件事的两面」的纪律）。
   */
  implemented: boolean;
  /** 未实装时说明会由哪个批次补齐（`implemented=false` 才有值） */
  pendingNote: string | null;
}

export interface ScheduleRunResult {
  task: TaskName;
  date: string;
  ranAt: string;
  durationMs: number;
  result: unknown;
}

/**
 * 定时任务后台服务（M4-1 · 手动补跑）
 *
 * ## 为什么需要它
 * 定时任务是**没有 HTTP 请求**的代码路径：跑批跑失败了，运营既看不见、也动不了，
 * 只能等第二天。M4 交付物明确要求「8 个定时任务上线，**可控触发（含手动补跑接口）**」。
 *
 * ## 关键纪律：补跑与跑批共用**同一个执行口**
 * 本服务不重写任何业务逻辑，只做两件事：**推导日期** + **调用任务暴露的 `runOnce()`**。
 * 而任务的 `runOnce()` 正是它 cron 处理器内部调用的那一个方法 ——
 * 所以「跑批算出来的数」与「手动补跑算出来的数」在结构上不可能不同。
 *
 * ⚠️ **补跑刻意不带锁**：锁的语义是「同一目标日期只跑一次（防并发重入）」。
 *    补跑的动机恰恰是「跑批没跑成」，被锁挡住就完全失去用途。
 *    重复补跑的安全性由各服务的业务幂等保证（以 `meal_date` 为键，见 4.11）。
 */
@Injectable()
export class ScheduleAdminService {
  private readonly logger = new Logger('ScheduleAdmin');

  /** 已实装任务的执行口 —— 键集就是「哪些任务真能跑」的唯一真相 */
  private readonly runners: ReadonlyMap<TaskName, (date: string) => Promise<unknown>>;

  constructor(
    private readonly sched: ScheduleService,
    mealPublish: MealPublishTask,
    cutoff: CutoffTask,
    deliveryGenerate: DeliveryGenerateTask,
    autoConfirm: AutoConfirmTask,
    commissionSettle: CommissionSettleTask,
    supplierShare: SupplierShareTask,
    reconciliation: ReconciliationTask,
    leaderExpire: LeaderExpireTask,
  ) {
    this.runners = new Map<TaskName, (date: string) => Promise<unknown>>([
      ['meal-publish', (d) => mealPublish.runOnce(d)],
      ['cutoff', (d) => cutoff.runOnce(d)],
      ['delivery-generate', (d) => deliveryGenerate.runOnce(d)],
      // M4-2：结算链路三个任务（此前 `implemented=false`，现已补齐）
      ['auto-confirm', (d) => autoConfirm.runOnce(d)],
      ['commission-settle', (d) => commissionSettle.runOnce(d)],
      ['supplier-share', (d) => supplierShare.runOnce(d)],
      ['reconciliation', (d) => reconciliation.runOnce(d)],
      ['leader-expire', (d) => leaderExpire.runOnce(d)],
    ]);
  }

  /** 跑批时刻表（8 行全列出，含未实装项 —— 如实告知，而不是隐藏） */
  list(): { list: ScheduleRow[]; summary: { total: number; implemented: number } } {
    const list = (Object.keys(TASK_SCHEDULES) as TaskName[]).map<ScheduleRow>((task) => {
      const s = TASK_SCHEDULES[task];
      const implemented = this.runners.has(task);
      return {
        task,
        cron: s.cron,
        timeZone: s.timeZone,
        dateKind: s.dateKind,
        dateKindLabel: DATE_KIND_LABEL[s.dateKind ?? 'none'],
        what: s.what,
        implemented,
        pendingNote: implemented ? null : (PENDING_NOTE[task] ?? '待后续批次实装'),
      };
    });
    return {
      list,
      summary: { total: list.length, implemented: list.filter((r) => r.implemented).length },
    };
  }

  /**
   * 手动补跑一次任务
   *
   * @param task 任务名（来自 `TASK_SCHEDULES` 的键）
   * @param date 目标日期；不传则按该任务的日期语义推导
   */
  async run(task: string, date?: string): Promise<ScheduleRunResult> {
    if (!isTaskName(task)) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `未知的定时任务「${task}」。可选：${Object.keys(TASK_SCHEDULES).join(' / ')}`,
      );
    }

    const runner = this.runners.get(task);
    if (!runner) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `任务「${task}」尚未实装，无法补跑 —— ${PENDING_NOTE[task] ?? '待后续批次实装'}`,
      );
    }

    // ⚠️ 必须用 `isRealDate` 而不是 `isDateStr`：后者只验**格式**，放行 `2026-02-30`
    //    —— 那不是「另一个日期」而是**静默滚动**（`Date.UTC(2026,1,30)` → 2026-03-02）。
    //    而本接口是「改写历史数据」的入口，选错一整天不会有任何提示：运营以为在补跑
    //    2 月 30 日（并看到「完成」），实际把 3 月 2 日的订单批量置成了已截单。
    //    DTO 的正则挡得住 `13` 月，挡不住 `02-30`，故服务层必须再兜一道（两者分工见 time.ts）。
    if (date !== undefined && date !== '' && !isRealDate(date)) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `date「${date}」不是合法日期（须为 yyyy-MM-dd，且日历上真实存在）`,
      );
    }

    const target = this.resolveDate(task, date);
    const startedAt = Date.now();
    this.logger.log(`手动补跑 task=${task} date=${target}`);

    const result = await runner(target);

    const durationMs = Date.now() - startedAt;
    this.logger.log(`手动补跑完成 task=${task} date=${target} ${durationMs}ms`);

    return { task, date: target, ranAt: new Date().toISOString(), durationMs, result };
  }

  /**
   * 推导目标日期：显式传入优先，否则按声明表的日期语义
   *
   * ⚠️ 与跑批**同源**（走 `ScheduleService.targetDate`）——
   *    若这里另写一套 `addDays`，立刻就会出现「补跑与跑批动的不是同一天」。
   */
  private resolveDate(task: TaskName, date?: string): string {
    if (date) return date;
    const kind = TASK_SCHEDULES[task].dateKind;
    return kind ? this.sched.targetDate(kind) : todayBj();
  }
}

/** 日期语义中文文案（服务端下发，端上不自造） */
const DATE_KIND_LABEL: Record<string, string> = {
  today: '当日（T 日）',
  tomorrow: '次日（T+1）',
  yesterday: '前一日（T-1）',
  none: '与出餐日无关（全量扫描）',
};

/**
 * 未实装任务的补齐批次说明
 *
 * ⭐ **M4-2 后本表为空** —— 8 个任务全部实装（日切 3 + 结算 3 + 既有 2），
 * `GET /admin/schedule` 的 `summary.implemented` 应为 `8/8`。
 *
 * ⚠️ **本表刻意保留**（而不是连同 `implemented` 字段一起删掉）：`implemented` 不是
 *    手写常量，而是 `runners.has(task)` 的**派生值** —— 将来若有人只往
 *    `TASK_SCHEDULES` 里加了任务却没写执行口，页面会自动如实显示「未实装」，
 *    而不是让一个「看起来在跑、其实只打了一行日志」的占位任务冒充已上线
 *    （#50「声明与闸门是同一件事的两面」）。跨批次实装的任务在此登记批次说明，
 *    留空则回落到下面的通用文案。
 */
const PENDING_NOTE: Partial<Record<TaskName, string>> = {};

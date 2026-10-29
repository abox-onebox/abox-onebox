import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { KvService } from '../common/cache/kv.service';
import {
  RUN_FAILED_ACTION,
  RUN_FAILED_MODULE,
  runFailureTargetId,
  shouldAlertRunFailure,
} from '../common/utils/schedule-run-log';
import { OperationLog } from '../database/entities/system.entity';
import {
  BusinessTimeline,
  DEFAULT_TIMELINE,
  cronOf,
  currentTimeline,
} from '../common/utils/order-timeline';
import { addDays, now, todayBj } from '../common/utils/time';
import { TZ } from '../common/utils/tz';

/**
 * 定时任务调度基座（M4）
 *
 * 权威口径：《ABox一盒订单状态机与全链路流转v1.0》§3.1 定时任务清单
 *
 * ## 这个文件解决什么问题
 * M4 之前，8 个任务各自在 `@Cron()` 装饰器里写死时刻、各自在方法体里自己算日期。
 * 于是**同一个自然日的不同任务，操作的是不同的「目标日期」** —— 这是 M4 最容易
 * 写错的地方，因为它**看不出来**：cron 表达式只写「几点触发」，不写「动哪一天的数据」。
 *
 * 一个真实例子：`meal-publish` 与 `auto-confirm` 的 cron **完全相同**
 * （`0 0 14 * * *`），但前者开的是「**明日**」的团、后者确认的是「**今日**」的单。
 * 把两者的日期写反，代码照样编译、e2e 照样可能有部分绿 —— 直到某天发现
 * 「套餐提前一天上架」或「订单被提前确认」。
 *
 * ## 所以本文件提供两件东西
 * 1. **`TASK_SCHEDULES` 声明表** —— 9 个任务一张表写清「几点触发」+「动哪一天」，
 *    是调度口径的**唯一真相**。任务从表里读，不各自硬编码。
 * 2. **`targetDate(kind)` 语义单点** —— 把 `today` / `tomorrow` / `yesterday`
 *    三种语义收在一处，杜绝各任务自写 `addDays(todayBj(), ±1)` 时正负号写错。
 *
 * ## 9 个任务的目标日期一览（改代码前先看这张表）
 * | 任务 | 触发 | 目标日期 | 理由 |
 * | --- | --- | --- | --- |
 * | `meal-publish` | T-1 14:00 | **明日** | D 日 14:00 开的是 D+1 的团（D+1 的开团时刻正是 D 日 14:00） |
 * | `cutoff` | T 00:00 | **今日** | D 日 00:00 截的是 D 日的单（D 日截单时刻正是 D 日 00:00） |
 * | `delivery-generate` | T 00:30 | **今日** | 为当日截单后的订单生成配送单 |
 * | `auto-confirm` | T 14:00 | **今日** | D 日 14:00 确认的是 D 日已送达的单 |
 * | `commission-settle` | T+1 02:00 | **昨日** | 入账的是 D 日已完成订单的佣金 |
 * | `supplier-share` | T+1 02:10 | **昨日** | 应付对象是**已发生**的交付 |
 * | `reconciliation` | 04:00 | **昨日** | 核**完整自然日**；04:00 对「今日」只能核 4 小时切片 |
 * | `leader-expire` | 03:00 | `null` | 全量扫描，与出餐日无关 |
 * | `pay-reconcile` | 每 30 分钟 | `null` | **高频**：扫的是「此刻」滞留的待支付订单，与出餐日无关 |
 *
 * ⚠️ `cutoff` / `delivery-generate` / `auto-confirm` 三个任务的 cron 落在**同一个
 *    自然日内**（00:00 / 00:30 / 14:00），但它们的「今日」指的都是该出餐日 T ——
 *    也就是说这几个任务**不需要**任何日期偏移，偏移只出现在「开明日团」（+1）
 *    与「T+1 凌晨结算」（-1）两处。
 *
 * ## 锁的边界（重要）
 * `run()` 用 `KvService.setNx` 加一把 `(任务, 目标日期)` 锁，防的是**并发重入**
 * （Nest 的 `@Cron` 在上一轮未跑完时**不会**自动跳过下一轮）。
 * 但它**不承担幂等** —— 幂等在业务服务层（以 `meal_date` 为键，见 4.11）。
 * 这样分工的原因：KV 在 `memory` 驱动下**重启即丢**，若把幂等托付给锁，
 * 一次重启就会重复执行跑批。**锁是加速器，不是保险丝。**
 *
 * ## 失败即释放锁
 * 4.11 明确要求「失败可重放」。若失败时保留锁，当天剩余时间里该任务再也跑不起来，
 * 只能人工删 key。故：**成功保留锁**（TTL 内不重复跑，体现「同一目标日期只跑一次」）、
 * **失败立即释放锁**（可马上重放）。
 *
 * ⚠️ 本服务**不落库**任何运行记录 —— 项目不变量「派生值不落库」，且运行日志由
 *    logger 承担。要查「昨夜跑批跑了什么」看日志，不查表。
 */
@Injectable()
export class ScheduleService {
  private readonly logger = new Logger('Schedule');

  /**
   * T1 · 每个任务**最近一次**执行结果（**进程内内存，重启即空**）
   *
   * ⚠️ 刻意**不落库**：执行结果是**派生值**，落库就违背项目不变量
   *    （见本文件头注「派生值不落库」）。它的定位与「跑批锁」完全相同 ——
   *    **加速器，不是保险丝**：看得见「刚才跑得怎么样」就够了，
   *    追历史故障靠**失败告警**（那条才落 `ab_operation_log`，见 `run()`）。
   */
  private readonly lastRuns = new Map<TaskName, TaskRunRecord>();

  constructor(
    private readonly kv: KvService,
    @InjectRepository(OperationLog) private readonly opLogRepo: Repository<OperationLog>,
  ) {}

  /** T1 · 供 `GET /admin/schedule` 展示「最近一次执行」 */
  lastRunOf(task: TaskName): TaskRunRecord | null {
    return this.lastRuns.get(task) ?? null;
  }

  // =====================================================================
  // 目标日期
  // =====================================================================

  /**
   * 目标日期语义单点
   *
   * `kind` 的取值与理由见文件头表格 —— **不要在任务里另写 `addDays(todayBj(), ±1)`**，
   * 那是「同刻不同日」写错的唯一入口。
   *
   * @param kind  `today` 当日 / `tomorrow` 次日 / `yesterday` 前一日
   * @param at    基准时刻（缺省取 `now()`；e2e 可经 `ABOX_SHIFT_TO_HOUR` 平移）
   */
  targetDate(kind: TaskDateKind, at: Date = now()): string {
    const today = todayBj(at);
    if (kind === 'today') return today;
    return addDays(today, kind === 'tomorrow' ? 1 : -1);
  }

  /**
   * 取某任务的**必有**目标日期（从 `TASK_SCHEDULES` 读 `dateKind`）
   *
   * ⚠️ 对 `dateKind === null` 的任务（全量扫描型，如 `leader-expire`）调用即抛 ——
   *    那是编程错误，不是运行时状况（此类任务本就不该有目标日期）。
   */
  requireDateForTask(task: TaskName, at: Date = now()): string {
    const kind = dateKindFor(task);
    if (!kind) {
      throw new Error(
        `任务 ${task} 声明为 dateKind=null（与出餐日无关），不应取目标日期 —— 请检查调用点`,
      );
    }
    return this.targetDate(kind, at);
  }

  /**
   * 跑批的**锁键日期**（内部使用）
   *
   * 有目标日期的任务 → 用目标日期（「同一目标日期只跑一次」）；
   * 无目标日期的全量扫描任务 → 用当日（「同一天只跑一次」）。
   */
  private keyDateFor(task: TaskName, at: Date = now()): string {
    const kind = dateKindFor(task);
    return kind ? this.targetDate(kind, at) : todayBj(at);
  }

  // =====================================================================
  // 跑批包装
  // =====================================================================

  /**
   * 执行一次跑批：推导目标日期 → 加锁 → 执行 → 失败时释放锁
   *
   * ⭐ **日期由本方法从声明表推导并回传给 `fn`** —— 任务体因此**永远不写日期计算**，
   *    「这个任务动哪一天」只有 `TASK_SCHEDULES` 一个来源。这是对「同刻不同日」
   *    陷阱最彻底的防御：任务里根本没有写错日期的地方。
   *
   * 跑批与「运维手动补跑」共用**同一个业务执行口**（`fn` 指向的服务方法），
   * 区别只在锁：手动补跑直接调服务方法，不经本包装 —— 所以补跑**不会被锁挡住**。
   *
   * @param task  任务名（同时是锁的一部分，必须取 `TASK_SCHEDULES` 的键）
   * @param fn    实际业务；入参 `date` 是推导出的目标日期，直接透传给服务方法即可
   *
   * ⚠️ 本方法**吞异常**并记入出参 `error` —— 定时任务失败不得让进程崩，
   *    且每日会再触发一次。调用方若需区分，读 `outcome.error`。
   */
  async run<T>(task: TaskName, fn: (date: string) => Promise<T>): Promise<TaskRunOutcome<T>> {
    const date = this.keyDateFor(task);
    const key = `${LOCK_PREFIX}:${task}:${date}`;
    const got = await this.kv.setNx(key, String(Date.now()), LOCK_TTL_SEC);
    const startedAt = Date.now();

    if (!got) {
      this.logger.warn(`⏭ ${task} date=${date} 跳过：该目标日期已有跑批在执行（锁 ${key} 未过期）`);
      const skipped: TaskRunOutcome<T> = {
        task,
        date,
        ran: false,
        skipped: 'locked',
        durationMs: 0,
      };
      this.rememberRun(skipped);
      return skipped;
    }

    try {
      const result = await fn(date);
      const durationMs = Date.now() - startedAt;
      this.logger.log(`${task} date=${date} 完成 ${durationMs}ms`);
      const ok: TaskRunOutcome<T> = { task, date, ran: true, durationMs, result };
      this.rememberRun(ok);
      return ok;
    } catch (e) {
      const error = (e as Error).message;
      // 失败即释放锁 → 满足 4.11「失败可重放」
      await this.kv.del(key);
      this.logger.error(`${task} date=${date} 失败（锁已释放，可立即重放）：${error}`);
      const failed: TaskRunOutcome<T> = {
        task,
        date,
        ran: true,
        durationMs: Date.now() - startedAt,
        error,
      };
      this.rememberRun(failed);
      // T2 · 失败告警落 `ab_operation_log`（**唯一**持久化的一条，见下方注释）
      await this.persistFailure(failed);
      return failed;
    }
  }

  // =====================================================================
  // T1 / T2 · 执行可观测
  // =====================================================================

  /** T1 · 记进内存（派生值**不落库**） */
  private rememberRun(outcome: TaskRunOutcome<unknown>): void {
    this.lastRuns.set(outcome.task, {
      date: outcome.date,
      ran: outcome.ran,
      skipped: outcome.skipped ?? null,
      durationMs: outcome.durationMs,
      error: outcome.error ?? null,
      at: new Date().toISOString(),
    });
  }

  /**
   * T2 · 失败才落 `ab_operation_log`
   *
   * ⚠️ **只落失败**：`pay-reconcile` 每 30 分钟跑一次，成功也写就是一年
   *    一万七千条噪音 —— 「每次都告警」等价于「没有告警」（`warnMissingOnce` 的教训）。
   *    成功与「被锁跳过」只进内存（`lastRunOf()`），供后台看最近一次即可。
   *
   * ⚠️ 落库**失败不得影响跑批本身**：这里 catch 掉只记日志 ——
   *    「写告警失败」不该让定时任务看起来是业务失败，也不该吞掉原始异常。
   *
   * 幂等：同（任务 + 目标日期）只写一条 —— 失败后锁已释放、可反复重放，
   * 每次都写会在操作日志里堆出几十行，与 `reconciliation` 的告警同一范式。
   */
  private async persistFailure(outcome: TaskRunOutcome<unknown>): Promise<void> {
    if (!shouldAlertRunFailure(outcome)) return;

    const targetId = runFailureTargetId(outcome.task, outcome.date);
    try {
      const existed = await this.opLogRepo
        .createQueryBuilder('l')
        .where('l.module = :m', { m: RUN_FAILED_MODULE })
        .andWhere('l.action = :a', { a: RUN_FAILED_ACTION })
        .andWhere('l.targetId = :t', { t: targetId })
        .getOne();

      if (existed) {
        this.logger.warn(
          `T2 告警已存在（操作日志 #${existed.id}，${targetId}）—— 未重复写；` +
            `最新错误：${outcome.error ?? '-'}`,
        );
        return;
      }

      await this.opLogRepo.insert({
        adminUserId: null,
        module: RUN_FAILED_MODULE,
        action: RUN_FAILED_ACTION,
        targetId,
        requestData: { task: outcome.task, date: outcome.date },
        snapshot: {
          source: 'system',
          durationMs: outcome.durationMs,
          error: outcome.error ?? null,
          reason: `定时任务 ${outcome.task}（目标日期 ${outcome.date}）执行失败，锁已释放可立即重放`,
        },
      });
      this.logger.warn(`⛔ T2 告警已落操作日志：${targetId} —— ${outcome.error ?? '-'}`);
    } catch (e) {
      // 写告警失败只记日志，不改变跑批结果
      this.logger.error(`T2 告警落库失败（${targetId}）：${(e as Error).message}`);
    }
  }
}

// =====================================================================
// 调度声明表（唯一真相）
// =====================================================================

/** 锁 TTL：任务可能跑几分钟，30 分钟足够长到不会误放，也短到不会卡住一天 */
const LOCK_TTL_SEC = 30 * 60;
const LOCK_PREFIX = 'sched:lock';

/** 目标日期语义 —— 见 `ScheduleService.targetDate()` */
export type TaskDateKind = 'today' | 'tomorrow' | 'yesterday';

export type TaskName =
  | 'meal-publish'
  | 'cutoff'
  | 'delivery-generate'
  | 'auto-confirm'
  | 'commission-settle'
  | 'supplier-share'
  | 'reconciliation'
  | 'leader-expire'
  /** P3（2026-10-29）：支付查单补齐 —— **高频**任务，不走时间轴（见 `TASK_SCHEDULES` 该条注释） */
  | 'pay-reconcile';

export interface TaskSchedule {
  /**
   * cron 表达式（秒级，6 段）—— **由 `DEFAULT_TIMELINE` 派生**，不是手写字面量。
   *
   * ⚠️ 运行时实际注册的 cron 可能**不是**这个值：`ScheduleRegistrar` 会用
   *    「配置覆写后的生效时间轴」重新生成（见 `cronFor(timeline)`）。
   *    本字段的用途是「出厂口径」展示与无配置时的默认值。
   */
  cron: string;
  /**
   * 该任务的触发时刻来自时间轴的哪一项（**唯一真相的挂钩点**）。
   *
   * 8 个「每日型」任务全部有值 —— 即「跑批几点触发」全部由 `order-timeline.ts` 决定，
   * 本文件不再出现任何硬编码时刻（缺陷 #49 的修法）。
   *
   * ⚠️ **`null` = 高频任务，不走时间轴**（目前仅 `pay-reconcile`）：
   *    `cronOf()` 只能把「时刻」翻译成「每天这个时刻」，表达不了「每 30 分钟」；
   *    而支付回调是**秒级事件**，补齐按天跑毫无意义（订单早被截单取消了）。
   *    此类任务直接读 `cron` 字段。
   */
  timelineKey: keyof BusinessTimeline | null;
  timeZone: string;
  /** 操作的目标日期；`null` = 与出餐日无关（全量扫描型任务） */
  dateKind: TaskDateKind | null;
  /** 一句话职责（用于日志与文档生成） */
  what: string;
}

/**
 * 按**指定**时间轴生成某任务的 cron（配置覆写后用这个，而不是读 `spec.cron`）
 *
 * ⚠️ `timelineKey === null` 的高频任务（`pay-reconcile`）**直接返回 `spec.cron`** ——
 *    它们不属于「每天某个时刻」这一族，没有对应的时间轴项可派生。
 */
export function cronFor(spec: TaskSchedule, tl: BusinessTimeline = DEFAULT_TIMELINE): string {
  if (!spec.timelineKey) return spec.cron;
  return cronOf(tl[spec.timelineKey]);
}

/**
 * 某任务的**目标日期语义** —— 由生效时间轴的派生，**不手写**
 *
 * 绝大多数任务与配置无关（`meal-publish` 永远是「前一日 14:00 开昨日的团 → 目标=次日」），
 * 但 **`cutoff` 是唯一例外**，且这个例外必须显式处理，否则「把截单时刻改成 23:30」会变成
 * 一次**静默锁错日期**：
 *
 * | 截单时刻 | 触发落在哪一天 | cron | 正确的 `dateKind` |
 * |---|---|---|---|
 * | `24:00`（默认） | **T 日** 00:00（`24:00` 折算为 0 点） | `0 0 0 * * *` | `today` |
 * | `23:30` | **T-1 日** 23:30 | `0 30 23 * * *` | `tomorrow` |
 *
 * 写成固定的 `today`，前一种对、后一种**错**——锁的是 T-1 的订单，而 T-1 的团早已截完，
 * 表现为「截单跑批成功了、但 T 日的订单一张都没锁」，**没有任何报错**。
 */
export function dateKindFor(
  task: TaskName,
  tl: BusinessTimeline = currentTimeline(),
): TaskDateKind | null {
  if (task === 'cutoff') {
    // `24:00` 折算后落在 **T 日** 0 点（目标即当日）；其余时刻落在 **T-1 日**（目标是次日）
    return tl.cutoff.hour === 24 ? 'today' : 'tomorrow';
  }
  return TASK_SCHEDULES[task].dateKind;
}

/**
 * 9 个任务的调度声明 —— **口径唯一真相**（时刻部分委托给 `order-timeline.ts`，
 * 高频任务 `pay-reconcile` 例外，见该条注释）
 *
 * ⚠️ 任务的 `@Cron()` 与 `targetDate()` 均**从本表读取**，不在任务里写第二遍。
 *    改触发时刻 → 改 `DEFAULT_TIMELINE`（或后台配置）；**不要**在这里写死 cron 字符串。
 */
export const TASK_SCHEDULES: Record<TaskName, TaskSchedule> = {
  'meal-publish': {
    timelineKey: 'publish',
    cron: cronOf(DEFAULT_TIMELINE.publish),
    timeZone: TZ,
    dateKind: 'tomorrow',
    what: 'T-1 开团：次日套餐上架，用户可下单',
  },
  cutoff: {
    timelineKey: 'cutoff',
    cron: cronOf(DEFAULT_TIMELINE.cutoff),
    timeZone: TZ,
    /**
     * ⚠️ 此处是**出厂口径**的展示值；运行时由 `dateKindFor()` 派生 ——
     * 截单时刻一旦从 `24:00` 改成 `23:30` 这类值，触发日就从 T 日挪到 T-1 日，
     * 目标日期必须跟着变成 `tomorrow`（否则**静默锁错日期**，见 `dateKindFor()` 注释）。
     */
    dateKind: 'today',
    what: 'T-1 截单：取消未支付 + 锁定已支付 + 推备料量',
  },
  'delivery-generate': {
    timelineKey: 'deliveryGenerate',
    cron: cronOf(DEFAULT_TIMELINE.deliveryGenerate),
    timeZone: TZ,
    dateKind: 'today',
    what: 'T 日按楼群生成配送单',
  },
  'auto-confirm': {
    timelineKey: 'autoConfirm',
    cron: cronOf(DEFAULT_TIMELINE.autoConfirm),
    timeZone: TZ,
    dateKind: 'today',
    what: 'T 日自动确认收货（仅 delivered）+ 计佣（写 pending，次日入账）',
  },
  'commission-settle': {
    timelineKey: 'commissionSettle',
    cron: cronOf(DEFAULT_TIMELINE.commissionSettle),
    timeZone: TZ,
    dateKind: 'yesterday',
    what: 'T+1 佣金入账到团长余额（把 T 日确认产生的 pending 置 settled）',
  },
  'supplier-share': {
    timelineKey: 'supplierShare',
    cron: cronOf(DEFAULT_TIMELINE.supplierShare),
    timeZone: TZ,
    dateKind: 'yesterday',
    what: 'T+1 生成供应商应付结算单（不拨款 · C10）',
  },
  reconciliation: {
    timelineKey: 'reconciliation',
    cron: cronOf(DEFAULT_TIMELINE.reconciliation),
    timeZone: TZ,
    /**
     * ⭐ `yesterday`，**不是 `today`**（2026-09-17 M4-2 改正，原文档写 today 是错的）
     *
     * 04:00 跑批若对「今日」，核对的只是 `00:00–04:00` 这 4 小时切片，而昨日
     * 23:00 之后的流水要等**次日**才被覆盖到 —— 等于每天都漏核一段。改对「昨日」后
     * 核的是**完整自然日**，且 T 日的下单窗口（T-1 开团–截单前）此时已闭合、流水齐全。
     */
    dateKind: 'yesterday',
    what: '每日对账（核对**昨日**本地三方流水；不谎称已与微信对平）',
  },
  'leader-expire': {
    timelineKey: 'leaderExpire',
    cron: cronOf(DEFAULT_TIMELINE.leaderExpire),
    timeZone: TZ,
    dateKind: null,
    what: '每日见习团长 30 天未促单失效（C2）',
  },
  /**
   * P3（2026-10-29）· 支付查单补齐 —— **9 个任务里唯一的高频任务**
   *
   * ⚠️ `timelineKey: null` 是**刻意**的：补齐的对象是「**此刻**滞留的待支付订单」，
   *    不是「某一天的数据」；`cronOf()` 只能表达「每天某时刻」，
   *    而支付回调丢失需要**分钟级**发现（等到次日，订单已被截单取消，补齐无意义）。
   *
   * 频率定为 **每 30 分钟**：
   *   · 与 `run()` 的锁 TTL（30 分钟）同频 —— 锁是「成功保留、失败即放」，
   *     失败时下一次触发（30 分钟后）即可重放，不会卡死；
   *   · 再快（如每 5 分钟）多数触发会被锁挡掉，只换来一堆 `skipped=locked` 日志。
   */
  'pay-reconcile': {
    timelineKey: null,
    cron: '0 */30 * * * *',
    timeZone: TZ,
    dateKind: null,
    what: '每 30 分钟扫描滞留待支付订单，向微信查单补齐（回调丢失的兜底）',
  },
};

/** 运行时判定某字符串是否为已知任务名（后台补跑口用它挡非法入参） */
export function isTaskName(v: string): v is TaskName {
  return Object.prototype.hasOwnProperty.call(TASK_SCHEDULES, v);
}

/**
 * T1 · 最近一次执行记录（**内存**，派生值不落库）
 *
 * ⚠️ 与 `TaskRunOutcome` 刻意**分开**：后者带业务出参 `result`（类型随任务而变），
 *    本结构只留「可观测字段」，供后台列表原样展示，不携带任何业务数据 ——
 *    这样它天然不会把业务派生值捎带进持久化（本结构也确实不落库）。
 */
export interface TaskRunRecord {
  date: string;
  ran: boolean;
  skipped: 'locked' | null;
  durationMs: number;
  error: string | null;
  /** 记录时刻（ISO，北京时间由上游 `TZ` 决定） */
  at: string;
}

/** 跑批出参 —— 让 task 能按结果记一条人话日志 */
export interface TaskRunOutcome<T> {
  task: TaskName;
  date: string;
  /** 锁是否抢到并执行（`false` = 被并发跑批占用，本次跳过） */
  ran: boolean;
  skipped?: 'locked';
  durationMs: number;
  result?: T;
  /** 业务异常信息（本方法吞异常，不抛） */
  error?: string;
}

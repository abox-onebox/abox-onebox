import { Injectable, Logger } from '@nestjs/common';

import { KvService } from '../common/cache/kv.service';
import { addDays, now, todayBj } from '../common/utils/time';

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
 * 1. **`TASK_SCHEDULES` 声明表** —— 8 个任务一张表写清「几点触发」+「动哪一天」，
 *    是调度口径的**唯一真相**。任务从表里读，不各自硬编码。
 * 2. **`targetDate(kind)` 语义单点** —— 把 `today` / `tomorrow` / `yesterday`
 *    三种语义收在一处，杜绝各任务自写 `addDays(todayBj(), ±1)` 时正负号写错。
 *
 * ## 8 个任务的目标日期一览（改代码前先看这张表）
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

  constructor(private readonly kv: KvService) {}

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
    const kind = TASK_SCHEDULES[task].dateKind;
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
    const kind = TASK_SCHEDULES[task].dateKind;
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
      return { task, date, ran: false, skipped: 'locked', durationMs: 0 };
    }

    try {
      const result = await fn(date);
      const durationMs = Date.now() - startedAt;
      this.logger.log(`${task} date=${date} 完成 ${durationMs}ms`);
      return { task, date, ran: true, durationMs, result };
    } catch (e) {
      const error = (e as Error).message;
      // 失败即释放锁 → 满足 4.11「失败可重放」
      await this.kv.del(key);
      this.logger.error(`${task} date=${date} 失败（锁已释放，可立即重放）：${error}`);
      return { task, date, ran: true, durationMs: Date.now() - startedAt, error };
    }
  }
}

// =====================================================================
// 调度声明表（唯一真相）
// =====================================================================

/** 全项目统一时区（与服务端 `bj*` 时间工具同源） */
const TZ = 'Asia/Shanghai';

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
  | 'leader-expire';

export interface TaskSchedule {
  /** cron 表达式（秒级，6 段） */
  cron: string;
  timeZone: string;
  /** 操作的目标日期；`null` = 与出餐日无关（全量扫描型任务） */
  dateKind: TaskDateKind | null;
  /** 一句话职责（用于日志与文档生成） */
  what: string;
}

/**
 * 8 个任务的调度声明 —— **口径唯一真相**
 *
 * ⚠️ 任务的 `@Cron()` 与 `targetDate()` 均**从本表读取**，不在任务里写第二遍。
 *    改触发时刻或目标日期，只改这里。
 */
export const TASK_SCHEDULES: Record<TaskName, TaskSchedule> = {
  'meal-publish': {
    cron: '0 0 14 * * *',
    timeZone: TZ,
    dateKind: 'tomorrow',
    what: 'T-1 14:00 开团：次日套餐上架，用户可下单',
  },
  cutoff: {
    cron: '0 0 0 * * *',
    timeZone: TZ,
    dateKind: 'today',
    what: 'T-1 24:00 截单：取消未支付 + 锁定已支付 + 推备料量',
  },
  'delivery-generate': {
    cron: '0 30 0 * * *',
    timeZone: TZ,
    dateKind: 'today',
    what: 'T 日 00:30 按楼群生成配送单',
  },
  'auto-confirm': {
    cron: '0 0 14 * * *',
    timeZone: TZ,
    dateKind: 'today',
    what: 'T 日 14:00 自动确认收货（仅 delivered）+ 计佣（写 pending，次日入账）',
  },
  'commission-settle': {
    cron: '0 0 2 * * *',
    timeZone: TZ,
    dateKind: 'yesterday',
    what: 'T+1 02:00 佣金入账到团长余额（把 T 日确认产生的 pending 置 settled）',
  },
  'supplier-share': {
    cron: '0 10 2 * * *',
    timeZone: TZ,
    dateKind: 'yesterday',
    what: 'T+1 02:10 生成供应商应付结算单（不拨款 · C10）',
  },
  reconciliation: {
    cron: '0 0 4 * * *',
    timeZone: TZ,
    /**
     * ⭐ `yesterday`，**不是 `today`**（2026-09-17 M4-2 改正，原文档写 today 是错的）
     *
     * 04:00 跑批若对「今日」，核对的只是 `00:00–04:00` 这 4 小时切片，而昨日
     * 23:00 之后的流水要等**次日**才被覆盖到 —— 等于每天都漏核一段。改对「昨日」后
     * 核的是**完整自然日**，且 T 日的下单窗口（T-1 14:00–23:00）此时已闭合、流水齐全。
     */
    dateKind: 'yesterday',
    what: '每日 04:00 对账（核对**昨日**本地三方流水；不谎称已与微信对平）',
  },
  'leader-expire': {
    cron: '0 0 3 * * *',
    timeZone: TZ,
    dateKind: null,
    what: '每日 03:00 见习团长 30 天未促单失效（C2）',
  },
};

/** 运行时判定某字符串是否为已知任务名（后台补跑口用它挡非法入参） */
export function isTaskName(v: string): v is TaskName {
  return Object.prototype.hasOwnProperty.call(TASK_SCHEDULES, v);
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

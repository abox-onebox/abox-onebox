import { http } from './request';

/**
 * api/schedule —— 运营后台「跑批时刻表」（M4-1 起有端点 · M5-12 才有页面）
 *
 * ## 为什么单独一个文件、而不是并进 `api/system.ts`
 * `api/system.ts` 管的是**后台自有的系统管理域**（账号 / 角色 / 操作日志 / 系统配置）。
 * 跑批控制台的控制器刻意**不在** `modules/admin/` 里（见 `schedule-admin.controller.ts`
 * 头部：放进去会让 `AdminModule` 反向依赖全部业务模块），前端同理另起一个文件。
 *
 * ## ⚠️ 三个「同名不同义」的字段，本文件是它们唯一的解释处
 * | 字段 | 含义 | 与另一个的区别 |
 * |---|---|---|
 * | `cron` | **出厂口径**（由 `DEFAULT_TIMELINE` 派生） | 与 `registeredCron` 不同即说明**配置覆写了时刻** |
 * | `registeredCron` | **运行时真的注册进调度器**的那个 cron | `null` = 该任务**根本不会被触发** |
 * | `effectiveAt` | 生效时刻（`HH:mm`，`24:00` **原样显示不折算**） | 与 `registeredCron` **同源**；折算成 `00:00` 会让人以为截单在当天早上 |
 *
 * ⚠️ 端上**不自己换算** `effectiveAt ↔ cron`：`24:00` 折算成 `0` 点是服务端的规则
 * （`order-timeline.ts` 的 `cronOf()`），端上再写一遍就是第二份真相。
 *
 * ⚠️ 类型在此**只作端上约束**，权威契约见《接口规范 v1.0》§6.8 与
 *    服务端 `tasks/schedule-admin.service.ts` 的 `ScheduleRow`。
 */

/** 目标日期语义 —— `null` = 与出餐日无关（全量扫描型任务） */
export type TaskDateKind = 'today' | 'tomorrow' | 'yesterday' | null;

export interface ScheduleRow {
  task: string;
  /** **出厂** cron（由 `DEFAULT_TIMELINE` 派生，不是运行时值） */
  cron: string;
  timeZone: string;
  dateKind: TaskDateKind;
  /** 中文日期语义（服务端下发，端上**不自造**映射） */
  dateKindLabel: string;
  /** 一句话职责 */
  what: string;
  /** 代码是否已实装（**派生值**，不是手写常量） */
  implemented: boolean;
  /** `implemented=false` 时的补齐批次说明 */
  pendingNote: string | null;
  /** **实际注册**到调度器的 cron；`null` = 未注册 ⇒ 该任务永远不会被触发 */
  registeredCron: string | null;
  /** 生效时刻（`HH:mm`；`24:00` 原样，**不折算**） */
  effectiveAt: string;
}

export interface ScheduleListResult {
  list: ScheduleRow[];
  summary: {
    total: number;
    implemented: number;
    /** 已注册的任务数 —— 「任务真的会被触发吗」的总量证据 */
    registered: number;
  };
}

/** 手动补跑出参（`result` 是各任务自己的业务出参，形状因任务而异） */
export interface ScheduleRunResult {
  task: string;
  /** 实际执行的目标日期（服务端推导 · 端上不传时也回带） */
  date: string;
  ranAt: string;
  durationMs: number;
  result: unknown;
}

/** D64 跑批时刻表（8 个任务全列出） */
export const fetchSchedule = () => http.get<ScheduleListResult>('/admin/schedule');

/**
 * D65 手动补跑一次任务
 *
 * ⚠️ `date` 建议**显式传**：不传时服务端按任务的日期语义推导（今日 / 次日 / 前一日），
 *    与跑批同一天 —— 但运营点「补跑」时心里想的往往是**某个具体日子**，
 *    页面上必须让人看见并确认这个日期（本页的补跑确认框强制回显）。
 *
 * ⚠️ 本调用会**改写历史数据**（如把某个已过日期的订单批量置为已截单），
 *    服务端仅对 `super_admin` / `admin` 开放（`operator` 不在白名单），
 *    且每次调用都会写操作日志。端上为此加了二次确认。
 *
 * ⚠️ 补跑**刻意不加幂等键**：与 D58 改配置不同，补跑是「跑批没跑成」的补救，
 *    重复补跑的安全性由各服务的**业务幂等**保证（以 `meal_date` 为键）。
 *    在这里自动挂幂等键反而会让「同一天补跑两次」被静默拦成一次 ——
 *    那正是补跑最需要的能力，故必须走 `http.post` 原样发出。
 */
export const runScheduleTask = (task: string, date?: string) =>
  http.post<ScheduleRunResult>(`/admin/schedule/${task}/run`, date ? { date } : {});

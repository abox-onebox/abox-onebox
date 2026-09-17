/**
 * 业务时间轴 —— **全项目业务时刻的唯一真相**
 *
 * ## 这个文件解决什么问题（缺陷 #49）
 * 在 M5-3 之前，同一批业务时刻在**三个地方各写了一遍**，且彼此**没有任何机械对账**：
 *
 * | # | 位置 | 形态 |
 * |---|------|------|
 * | 1 | `ab_config` 的 `set_meal.publish_time` 等 | **只作口径记录，没有任何代码读取**（标 `unwired`） |
 * | 2 | `TASK_SCHEDULES[*].cron` | 硬编码字符串 `'0 0 14 * * *'` |
 * | 3 | `time.ts` 的 `publishAtOf()` / `cutoffAtOf()` 等 | 硬编码数字 `14` / `0` / `11.5` |
 *
 * 三处不一致时**不会报错**：截单时刻配的是 `23:59`，而实际截单的 cron 是 `00:00` ——
 * 运营在配置页看到「23:59 截单」，用户实际可以下单到次日 00:00，**相差 1 分钟**，
 * 且**没有任何一处会因此变红**。这正是缺陷 #49 的形态。
 *
 * ## 解法：一处声明，两处派生
 * ```
 *           DEFAULT_TIMELINE（本文件 · 唯一真相）
 *                    │
 *        ┌───────────┴───────────┐
 *        ▼                       ▼
 *  TASK_SCHEDULES[*].cron    time.ts 的锚点函数
 *   （跑批几点触发）          （下单窗口开在哪、送达算几点）
 * ```
 * 两处都是**派生值**，不再手写第二遍 —— 三源漂移在结构上不可能再发生。
 *
 * ## 配置是「覆写」，不是「记录」
 * 5 个时刻可由后台配置覆盖（见 `TIMELINE_CONFIG_KEYS`）：
 * `set_meal.publish_time` / `set_meal.cutoff_time` / `set_meal.delivery_arrival_time`
 * / `commission.auto_confirm_time` / `commission.settle_hour`。
 *
 * 生效路径：`BizConfigService.refreshTimeline()` 把配置解析成 timeline →
 * `setCurrentTimeline()` 写入进程级生效值 → 锚点函数与 cron 注册器都读它。
 * 于是「配置改了」= **下单窗口与跑批时刻一起改**（不再是「写了不生效」）。
 *
 * ## ⚠️ 24:00 为什么必须被支持
 * 截单口径是 `T-1 24:00`（= T 日 00:00）。但配置校验原先只接受 `HH:mm` 的
 * 00:00–23:59，**数据模型无法表达 24:00** —— 于是种子值写成 `23:59` 当作近似，
 * 与真实的 `00:00` 差 1 分钟。这不是笔误，是**模型缺一个值**导致的长期偏差。
 * 本文件支持 `24:00`（仅整点），并在配置校验侧同步放宽。
 *
 * ## 进程级生效值的设计取舍（如实记录）
 * `currentTimeline()` 是**进程级可变单例**。之所以不改成「逐调用点显式传参」：
 * `cutoffAtOf` 全仓有 19 个调用点，显式传参**必然漏**，而漏掉的那处就是新的漂移。
 * 单例让「配置生效」是**全局且不可绕过**的 —— 代价是多实例部署下需要各实例各自刷新
 * （本项目一期单实例；若将来多实例，应把刷新做成配置变更事件广播）。
 */
import { TZ } from './tz';

/** 时刻（时:分）；`hour` 允许 **24**，表示次日 0 点（截单口径用得到） */
export interface TimeOfDay {
  hour: number;
  minute: number;
}

/** 业务时间轴的 9 个时刻 */
export interface BusinessTimeline {
  /** T-1 开团（次日套餐上架，用户可下单） */
  publish: TimeOfDay;
  /** T-1 截单；`24:00` = T 日 0 点（硬闸） */
  cutoff: TimeOfDay;
  /** T 日送达办公楼 */
  arrival: TimeOfDay;
  /** T 日自动确认收货 */
  autoConfirm: TimeOfDay;
  /** T 日生成配送单 */
  deliveryGenerate: TimeOfDay;
  /** T+1 佣金入账到团长余额 */
  commissionSettle: TimeOfDay;
  /** T+1 生成供应商应付结算单 */
  supplierShare: TimeOfDay;
  /** 每日对账 */
  reconciliation: TimeOfDay;
  /** 见习团长失效扫描 */
  leaderExpire: TimeOfDay;
}

/**
 * 业务口径默认值 —— **改这里等于改业务口径**，且改动会**同时**影响下单窗口与跑批时刻。
 * 权威来源：《订单状态机与全链路流转 v1.0》§1.2 关键锚点。
 */
export const DEFAULT_TIMELINE: BusinessTimeline = {
  publish: { hour: 14, minute: 0 },
  cutoff: { hour: 24, minute: 0 },
  arrival: { hour: 11, minute: 30 },
  autoConfirm: { hour: 14, minute: 0 },
  deliveryGenerate: { hour: 0, minute: 30 },
  commissionSettle: { hour: 2, minute: 0 },
  supplierShare: { hour: 2, minute: 10 },
  reconciliation: { hour: 4, minute: 0 },
  leaderExpire: { hour: 3, minute: 0 },
};

/**
 * 时刻 → `ab_config` 键（**单项真相**：`config.specs.ts` 的 `consumedBy` 由此派生）。
 * 未列出的时刻**不可配**（纯内部跑批节奏，没有对应的业务配置项）。
 */
export const TIMELINE_CONFIG_KEYS: Partial<Record<keyof BusinessTimeline, string>> = {
  publish: 'set_meal.publish_time',
  cutoff: 'set_meal.cutoff_time',
  arrival: 'set_meal.delivery_arrival_time',
  autoConfirm: 'commission.auto_confirm_time',
  commissionSettle: 'commission.settle_hour',
};

/** 反查：配置键 → 时刻名（`timelineFromRows` 与配置页共用） */
export const TIMELINE_KEY_BY_CONFIG: Record<string, keyof BusinessTimeline> = Object.fromEntries(
  Object.entries(TIMELINE_CONFIG_KEYS).map(([k, v]) => [v as string, k as keyof BusinessTimeline]),
);

/** 中文标签（启动告警与配置页文案，服务端下发，端上不自造） */
export const TIMELINE_LABEL: Record<keyof BusinessTimeline, string> = {
  publish: '开团时间（T-1）',
  cutoff: '截单时间（T-1）',
  arrival: '送达时间（T 日）',
  autoConfirm: '自动确认收货（T 日）',
  deliveryGenerate: '配送单生成（T 日）',
  commissionSettle: '佣金入账（T+1）',
  supplierShare: '供应商应付生成（T+1）',
  reconciliation: '对账跑批',
  leaderExpire: '见习失效扫描',
};

/** `HH:mm` 展示（`24:00` 原样显示，**不折算成 00:00** —— 折算会让人以为截单在当天早上） */
export const formatTimeOfDay = (t: TimeOfDay): string =>
  `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;

/**
 * 时刻 → 「T-1 当日 0 点起的分钟数」（`24:00` → `1440`）
 *
 * ⚠️ 存在的唯一理由：**同一天内比较两个时刻的先后**。时刻都挂在 T-1 这个基准日上
 *    （开团 `T-1 14:00`、截单 `T-1 24:00`），故整数值可比大小；`24:00` 必须映射成
 *    `1440` 而不是 `0`（映射成 0 会让「截单 24:00」看起来**早于**「开团 14:00」）。
 */
export const asBaseDayMinutes = (t: TimeOfDay): number => t.hour * 60 + t.minute;

/**
 * 时间轴的**跨键自洽性检查**（返回问题描述；`null` = 自洽）
 *
 * 为什么必须有：五个时刻各自都是「合法 `HH:mm`」，但**组合起来可以毫无意义** ——
 * 开团晚于截单 → 下单窗口是**空区间**（谁都下不了单），而每一项单独校验都会通过，
 * 系统照跑、没有任何报错。这与「配置写坏一个值」不同：它需要**同时看两个键**才看得出来。
 *
 * @param tl             待检查的时间轴
 * @param cutoffWindowMin `order.cutoff_window_minutes`（截单前多少分钟关窗）
 */
export function timelineConflict(tl: BusinessTimeline, cutoffWindowMin: number): string | null {
  const publish = asBaseDayMinutes(tl.publish);
  const cutoff = asBaseDayMinutes(tl.cutoff);
  const win = Math.max(0, cutoffWindowMin);

  if (publish >= cutoff) {
    return (
      `开团时间（T-1 ${formatTimeOfDay(tl.publish)}）必须早于截单时间（T-1 ${formatTimeOfDay(tl.cutoff)}）—— ` +
      `否则用户可下单窗口是空区间，谁都下不了单`
    );
  }
  if (cutoff - publish <= win) {
    return (
      `开团到截单只有 ${cutoff - publish} 分钟，不足以容纳「截单前 ${win} 分钟关窗」的规则` +
      `（窗口需要大于 ${win} 分钟）—— 否则下单窗口是空区间`
    );
  }
  return null;
}

/**
 * 解析 `HH:mm`。
 *
 * 接受 `00:00`–`23:59` 与 **`24:00`**（仅整点，`24:01` 非法 —— 「次日 0 点过 1 分」
 * 应写成 `00:01`，否则时区与日期语义会含混）。非法返回 `null`，由调用方决定回落还是报错。
 */
export function parseTimeOfDay(raw: string | null | undefined): TimeOfDay | null {
  const s = (raw ?? '').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (minute > 59) return null;
  if (hour === 24) return minute === 0 ? { hour: 24, minute: 0 } : null;
  if (hour > 23) return null;
  return { hour, minute };
}

/**
 * 时刻 → cron 表达式（秒级 6 段）
 *
 * `24:00` 折算为 `0` 点：cron 没有「24 点」这一说法，`0 0 0 * * *` 就是「每天 0 点」，
 * 与「T-1 24:00 = T 日 0 点」同义。
 */
export function cronOf(t: TimeOfDay): string {
  const hour = t.hour === 24 ? 0 : t.hour;
  return `0 ${t.minute} ${hour} * * *`;
}

/** 时间轴差异（供启动告警与文档生成） */
export interface TimelineDiff {
  field: keyof BusinessTimeline;
  configKey: string | null;
  from: string;
  to: string;
}

/** 比较两条时间轴，返回**有差异的项**（无差异返回空数组） */
export function diffTimeline(
  next: BusinessTimeline,
  base: BusinessTimeline = DEFAULT_TIMELINE,
): TimelineDiff[] {
  const out: TimelineDiff[] = [];
  for (const k of Object.keys(DEFAULT_TIMELINE) as Array<keyof BusinessTimeline>) {
    if (next[k].hour !== base[k].hour || next[k].minute !== base[k].minute) {
      out.push({
        field: k,
        configKey: TIMELINE_CONFIG_KEYS[k] ?? null,
        from: formatTimeOfDay(base[k]),
        to: formatTimeOfDay(next[k]),
      });
    }
  }
  return out;
}

/**
 * 从 `ab_config` 行构造生效时间轴。
 *
 * 规则：
 *   · 键不存在 → 用默认值（**不算异常**，配置项本就是可选覆写）
 *   · 键存在但值非法 → **回落默认值并记 warning**（不抛错：配置损坏不该让服务起不来，
 *     但必须留下痕迹，否则「配置写坏了」会静默退化成「配置没生效」）
 */
export function timelineFromRows(rows: Map<string, string>): {
  timeline: BusinessTimeline;
  applied: TimelineDiff[];
  warnings: string[];
} {
  const timeline: BusinessTimeline = JSON.parse(JSON.stringify(DEFAULT_TIMELINE));
  const applied: TimelineDiff[] = [];
  const warnings: string[] = [];

  for (const [field, key] of Object.entries(TIMELINE_CONFIG_KEYS) as Array<
    [keyof BusinessTimeline, string]
  >) {
    const raw = rows.get(key);
    if (raw === undefined || raw === '') continue;

    const parsed = parseTimeOfDay(raw);
    if (!parsed) {
      warnings.push(
        `配置项「${TIMELINE_LABEL[field]}」的值「${raw}」不是合法时刻（须为 HH:mm，截单口径可用 24:00），` +
          `已回落默认值 ${formatTimeOfDay(DEFAULT_TIMELINE[field])}`,
      );
      continue;
    }
    if (
      parsed.hour === DEFAULT_TIMELINE[field].hour &&
      parsed.minute === DEFAULT_TIMELINE[field].minute
    ) {
      continue; // 与默认值相同 → 不算覆写
    }
    timeline[field] = parsed;
    applied.push({
      field,
      configKey: key,
      from: formatTimeOfDay(DEFAULT_TIMELINE[field]),
      to: formatTimeOfDay(parsed),
    });
  }

  return { timeline, applied, warnings };
}

// ---------------------------------------------------------------------------
// 进程级生效值
// ---------------------------------------------------------------------------

let CURRENT: BusinessTimeline = DEFAULT_TIMELINE;

/**
 * 当前**生效**的业务时间轴。
 *
 * ⚠️ 一切「相对业务时刻」的判定（下单窗口 / 截单 / 送达 / 自动确认 / 跑批 cron）
 *    都必须经由此函数取值，**不要**去读 `DEFAULT_TIMELINE` —— 后者是「出厂值」，
 *    不是「正在生效的值」。两者在多处混用就等于又造了一层漂移。
 */
export const currentTimeline = (): BusinessTimeline => CURRENT;

/**
 * 时间轴变更监听器
 *
 * ⚠️ **契约：监听器必须自行消化异常，不得同步抛出。**
 *    它们运行在**配置载入的关键路径**上（`ensureLoaded → applyTimeline → setCurrentTimeline`），
 *    同步抛出会被 `ensureLoaded` 的 `catch` 当成「`ab_config` 读取失败」上报，
 *    把「监听方自己的 bug」伪装成「数据库坏了」—— 那是最难查的一类误导。
 *    异步工作请用 `void promise.catch(...)` 自行兜底。
 */
export type TimelineListener = (tl: BusinessTimeline, diffs: TimelineDiff[]) => void;

const LISTENERS = new Set<TimelineListener>();

/** 订阅时间轴变更；返回取消订阅函数 */
export function onTimelineChange(cb: TimelineListener): () => void {
  LISTENERS.add(cb);
  return () => {
    LISTENERS.delete(cb);
  };
}

/**
 * 写入生效值（由 `BizConfigService.applyTimeline()` 调用；返回是否发生变化）
 *
 * ⭐ **变化即通知**：定时任务的 cron 是在进程启动时按时间轴注册的静态 cron 表达式，
 *    若配置改了却不重注册，就会出现「下单窗口已经变了、跑批还在老时刻跑」——
 *    那正是缺陷 #49 的同一形态换个位置复现。故此处把「变更」广播出去，
 *    由 `ScheduleRegistrar` 订阅并热重载（见该文件）。
 */
export function setCurrentTimeline(tl: BusinessTimeline): boolean {
  const diffs = diffTimeline(tl, CURRENT);
  CURRENT = tl;
  if (diffs.length === 0) return false;
  for (const cb of LISTENERS) cb(tl, diffs);
  return true;
}

/** 复位到默认值（仅测试与本地排查使用） */
export function resetCurrentTimeline(): void {
  CURRENT = DEFAULT_TIMELINE;
}

/** 全项目统一时区（与 cron 注册使用同一常量） */
export { TZ as TIMELINE_TIMEZONE };

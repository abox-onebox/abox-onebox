/**
 * 时间工具（服务端 · 统一 Asia/Shanghai = UTC+8）
 *
 * 关键锚点（《订单状态机 v1.0》§1.2）：
 *   开团   T-1 14:00
 *   截单   T-1 24:00（即 T 日 00:00，硬闸）
 *   送达   T 日 11:30
 *   自动确认 T 日 14:00
 *   跑批   T+1 02:00
 *
 * 约定：`mealDate` 语义 = **出餐日（T 日）**，格式 `YYYY-MM-DD`。
 *
 * 实现说明：不引入 dayjs 插件（避免打包/运行时差异），直接用「显式带偏移量的
 * 字符串解析」+「UTC 字段做日期加减」，全链路不依赖宿主时区。
 */
export const TZ_OFFSET_MINUTES = 8 * 60;
const BJ_OFFSET_MS = TZ_OFFSET_MINUTES * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// e2e 可控时钟（**仅测试**；生产环境恒为 0）
// ---------------------------------------------------------------------------

/**
 * 时钟平移量（毫秒）。进程启动时**算一次**，之后恒定 —— 时间仍 1:1 前进
 * （不是「冻住时钟」），因此时间戳单调性、`created_at < paid_at` 这类
 * 先后关系全部保持成立。
 *
 * 为什么需要它：`isOrderable(T)` = `[T-1 14:00, T-1 23:00)` —— **任何**出餐日
 * 在窗口外都不可能下单（T-1 14:00 ≤ now < T-1 23:00 对整数日无解），
 * 于是端到端套件每天只有 9 小时能跑，凌晨到下午 14:00 恒红。这不是被测行为
 * 出错，而是断言依赖了环境时钟 —— 真回归会被 15 小时的假红淹没。
 *
 * 注入方式：`ABOX_SHIFT_TO_HOUR=20` → 把「北京时间小时」平移到 20:00，
 * **日历日不变**（真实 03:00 → 注入 20:00 同日；真实 22:00 → 注入 20:00 同日），
 * 所以脚本侧用真实时钟算出的 `todayBj()/tomorrowBj()` 与服务端仍然对齐，
 * 无需改动夹具。
 *
 * ⚠️ 边界与非目标（如实记录，别误当成能测一切）：
 *   1. **只在 `NODE_ENV !== 'production'` 时生效**，且必须显式设环境变量 ——
 *      生产不会因为漏配而跑在假时间上。
 *   2. **不改变 `@Cron()` 的真实触发时刻**（NestJS 的 cron 是静态元数据，
 *      由调度库读真实钟）。跑批验收一律走**补跑接口**（`POST /admin/schedule/:task/run`），
 *      它接收显式出餐日，与时钟无关。
 *   3. 只影响 `now()`。**存量 `new Date()` 的直接调用点（如 TypeORM 的
 *      `@CreateDateColumn`）仍写入真实时刻** —— 二者相差一个固定平移量，
 *      先后关系仍自洽；若某条断言要拿「落库时刻」与「服务端 now」比大小，
 *      注意二者的差值不是 0 而是本平移量。
 *   4. 平移后 `now()` 落在未来（如真实 11:00 → 注入 20:00），故**不要**拿它
 *      与真实墙钟做「距今多久」的断言。
 */
const SHIFT_MS = resolveShiftMs();

function resolveShiftMs(): number {
  if (process.env.NODE_ENV === 'production') return 0;
  const raw = process.env.ABOX_SHIFT_TO_HOUR;
  if (!raw) return 0;
  const target = Number(raw);
  if (!Number.isInteger(target) || target < 0 || target > 23) return 0;

  const bj = new Date(Date.now() + BJ_OFFSET_MS);
  const withinDayMs =
    ((bj.getUTCHours() * 60 + bj.getUTCMinutes()) * 60 + bj.getUTCSeconds()) * 1000 +
    bj.getUTCMilliseconds();
  return target * 3_600_000 - withinDayMs;
}

/**
 * 当前时刻 —— **全服务端唯一时间源**。
 *
 * 一切「相对现在」的判定（下单窗口 / 截单 / 倒计时 / 今日明日）都必须经由此函数，
 * 不要直接 `new Date()`，否则注入态下会出现两套互不相干的时间。
 */
export function now(): Date {
  return new Date(Date.now() + SHIFT_MS);
}

/** 是否处于时钟注入态（启动横幅据此如实告警，防止把假时刻误当真实时刻排查） */
export const isClockShifted = (): boolean => SHIFT_MS !== 0;

/** 注入平移量（毫秒，带符号）；供启动横幅打印 */
export const clockShiftMs = (): number => SHIFT_MS;

/** `YYYY-MM-DD` 格式校验 */
export const isDateStr = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * 是否**真实存在**的日历日（`'2026-02-30'` / `'2026-13-01'` → `false`）
 *
 * ⚠️ 为什么必须有它：`isDateStr` 只校验**格式**。而 `Date.UTC(2026, 12, 1)`
 *    会**静默滚动**成 `2027-01-01`、`Date.UTC(2026, 1, 30)` 滚成 `2026-03-02`
 *    —— 调用方拿到的是「另一个日期」且**没有任何报错**：运营以为在看「13 月」
 *    的数据，实际是次年 1 月；期末对账选错一整天也不会有任何提示。
 *
 * 判据：解析后**回读三个字段必须与输入一致**（滚动会让至少一个字段变化）。
 * 与 `isDateStr` 分开两个函数：格式校验用于 DTO（成本低、报错信息清晰），
 * 真实日期校验用于服务层兜底（DTO 的正则挡得住 `13` 月，挡不住 `02-30`）。
 */
export function isRealDate(v: unknown): v is string {
  if (!isDateStr(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * 把 `'12h'` / `'7d'` / `'30m'` / `'45s'` 这类时长字符串换算为秒。
 *
 * 用途：JWT 的 `expiresIn` 支持人类可读写法，但**出参契约要秒数**
 * （`{ expiresIn }` 端上用来算刷新时机），不能把 `'12h'` 直接透出去。
 * 无法解析时返回 0 —— 由调用方决定是否视为「不设过期」，不抛错。
 */
export function durationToSeconds(v: string | undefined): number {
  if (!v) return 0;
  const m = /^(\d+)\s*([smhd])?$/i.exec(v.trim());
  if (!m) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  const unit = (m[2] ?? 's').toLowerCase();
  const factor = unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  return Number(m[1]) * factor;
}

/** 北京时间「当天」的 yyyy-MM-dd */
export function todayBj(at: Date = now()): string {
  return new Date(at.getTime() + BJ_OFFSET_MS).toISOString().slice(0, 10);
}

/** 北京时间「次日」的 yyyy-MM-dd —— U1「明日套餐」的 T 日 */
export function tomorrowBj(at: Date = now()): string {
  return addDays(todayBj(at), 1);
}

/** 日期加减（纯 UTC 运算，跨月/跨年/闰年安全） */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d);
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` + 北京时间时刻 → 绝对时刻 */
export function bjDateTime(dateStr: string, hour: number, minute = 0): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  // UTC+8 换算：UTC 时刻 = 北京时刻 − 8h
  return new Date(Date.UTC(y, m - 1, d, hour, minute) - BJ_OFFSET_MS);
}

/** 该出餐日（T 日）的**开团时刻** T-1 14:00 */
export const publishAtOf = (mealDate: string): Date => bjDateTime(addDays(mealDate, -1), 14);

/** 该出餐日（T 日）的**截单时刻** T-1 24:00（= T 日 00:00 · 硬闸） */
export const cutoffAtOf = (mealDate: string): Date => bjDateTime(mealDate, 0);

/** 该出餐日的送达时刻 T 日 11:30 */
export const arrivalAtOf = (mealDate: string): Date => bjDateTime(mealDate, 11, 30);

/** 该出餐日的自动确认时刻 T 日 14:00 */
export const autoConfirmAtOf = (mealDate: string): Date => bjDateTime(mealDate, 14);

/**
 * 当前是否处于「可下单窗口」
 * 窗口 = [开团时刻, 截单时刻 − cutoffWindowMinutes)
 * 口径依据：§3.1 U1 附注 —— 截单前 `cutoff_window_minutes` 分钟即 canOrder=false。
 */
export function isOrderable(
  mealDate: string,
  cutoffWindowMinutes: number,
  at: Date = now(),
): boolean {
  const open = publishAtOf(mealDate).getTime();
  const close = cutoffAtOf(mealDate).getTime() - cutoffWindowMinutes * 60 * 1000;
  const now = at.getTime();
  return now >= open && now < close;
}

/** 距截单剩余秒数（已截单返回 0；U1 countdownSec） */
export function secondsToCutoff(mealDate: string, at: Date = now()): number {
  const diff = cutoffAtOf(mealDate).getTime() - at.getTime();
  return diff > 0 ? Math.floor(diff / 1000) : 0;
}

/** 是否已过截单时刻（硬闸判定） */
export const isAfterCutoff = (mealDate: string, at: Date = now()): boolean =>
  at.getTime() >= cutoffAtOf(mealDate).getTime();

/** 输出 `2026-09-15T11:30:00+08:00`（《接口规范》§1.6 时间传输格式） */
export function toBjIso(at: Date | null | undefined): string | null {
  if (!at) return null;
  const shifted = new Date(at.getTime() + BJ_OFFSET_MS);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

/** 未支付订单过期时刻 = 下单时刻 + payTimeoutMinutes（T3：30 分钟未支付自动取消） */
export const payExpireAt = (createdAt: Date, payTimeoutMinutes: number): Date =>
  new Date(createdAt.getTime() + payTimeoutMinutes * 60 * 1000);

/**
 * 自然月区间（含首含尾）
 *
 * 用途：C2「月单」统计（当月完成份数）、L10 佣金明细的 `range=month`。
 * `base = '2026-09-15'` → `{ from: '2026-09-01', to: '2026-09-30' }`
 *
 * ⚠️ 本函数是**月份边界的唯一实现** —— `commission.service.monthOrDayRange` 亦委托于此，
 *    避免「佣金明细」与「晋级审计」两处各算一套月区间而口径漂移。
 */
export function monthRangeOf(base: string): { from: string; to: string } {
  const [y, m] = base.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // 下月 0 日 = 本月最后一天
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(lastDay).padStart(2, '0')}` };
}

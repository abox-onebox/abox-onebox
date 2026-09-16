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
export function todayBj(at: Date = new Date()): string {
  return new Date(at.getTime() + BJ_OFFSET_MS).toISOString().slice(0, 10);
}

/** 北京时间「次日」的 yyyy-MM-dd —— U1「明日套餐」的 T 日 */
export function tomorrowBj(at: Date = new Date()): string {
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
  at: Date = new Date(),
): boolean {
  const open = publishAtOf(mealDate).getTime();
  const close = cutoffAtOf(mealDate).getTime() - cutoffWindowMinutes * 60 * 1000;
  const now = at.getTime();
  return now >= open && now < close;
}

/** 距截单剩余秒数（已截单返回 0；U1 countdownSec） */
export function secondsToCutoff(mealDate: string, at: Date = new Date()): number {
  const diff = cutoffAtOf(mealDate).getTime() - at.getTime();
  return diff > 0 ? Math.floor(diff / 1000) : 0;
}

/** 是否已过截单时刻（硬闸判定） */
export const isAfterCutoff = (mealDate: string, at: Date = new Date()): boolean =>
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

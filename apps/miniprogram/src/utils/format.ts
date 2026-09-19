/**
 * utils/format —— 展示层格式化
 *
 * ⚠️ 金额口径（《接口规范》§1.6）：**接口层一律整数分**，仅在展示时换算成元。
 *    端上不做任何「元 → 分」以外的运算，避免浮点误差进入业务判断。
 */
import { DishCategory } from '@abox/shared-types';

/** 分 → 元（两位小数字符串，如 2580 → "25.80"） */
export function fenToYuan(fen: number): string {
  return (Math.round(fen) / 100).toFixed(2);
}

/** 分 → 带符号金额（如 2580 → "¥25.80"） */
export function fenToYuanText(fen: number): string {
  return `¥${fenToYuan(fen)}`;
}

/** 元 → 分（四舍五入到分） */
export function yuanToFen(yuan: number | string): number {
  return Math.round(Number(yuan) * 100);
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** 菜品档位文案（与后端 `SLOT_LABEL` 同源） */
export const SLOT_LABEL: Record<number, string> = {
  1: '主荤',
  2: '半荤',
  3: '素菜',
  4: '汤',
  5: '主食',
};

/**
 * 菜品品类 → 图示字符
 *
 * ⚠️ **唯一来源**（M5-14 抽出）：该映射此前只写在 `pages/index/index.vue` 里。
 *    溯源页（P38）要显示同一批菜品的图示，若再抄一份，就会出现
 *    「首页显示 🍛、溯源页显示 🍱」这种同一道菜两个样子的漂移 ——
 *    即本项目反复踩的「同一件事两份表述」。故收敛到此处，两页共用。
 */
const DISH_EMOJI: Record<string, string> = {
  [DishCategory.MAIN]: '🍛',
  [DishCategory.HALF]: '🍳',
  [DishCategory.VEG]: '🥦',
  [DishCategory.SOUP]: '🍲',
  [DishCategory.STAPLE]: '🍚',
};

/** 品类 → 图示字符；未知 / 空值回落通用餐盒图（不抛错，页面不因脏数据开天窗） */
export function dishEmoji(category: string | null | undefined): string {
  return (category && DISH_EMOJI[category]) || '🍱';
}

/**
 * 出餐日 → 展示文案
 *
 * ⚠️ 不用 `new Date('2026-09-16')`：该写法按 **UTC** 解析，
 *    在东八区会整体偏移一天（'2026-09-16' → 本地 9-16 08:00 尚可，
 *    但 '2026-09-16T00:00:00' 形态在部分引擎上是 9-15）。此处手动解析，杜绝时区歧义。
 */
export function formatMealDate(mealDate: string): string {
  const [y, m, d] = mealDate.split('-').map(Number);
  if (!y || !m || !d) return mealDate;
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '';
  return `${m}月${d}日 ${weekday}`;
}

/** 出餐日 → "9/16" */
export function formatMealDateShort(mealDate: string): string {
  const [, m, d] = mealDate.split('-').map(Number);
  return m && d ? `${m}/${d}` : mealDate;
}

/**
 * ISO 8601（服务端固定 +08:00）→ "MM-DD HH:mm"
 *
 * ⚠️ 同样手动解析：直接取字符串里的北京时刻，不受设备时区影响 ——
 *    端上时区若被改到西五区，`new Date(iso).getHours()` 会显示错误时间。
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '--';
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/** ISO → "HH:mm" */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '--';
  const m = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}` : '--';
}

/** 剩余秒数 → 倒计时文本（天/时/分/秒，逐级省略） */
export function formatCountdown(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s <= 0) return '已截单';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d > 0) return `${d} 天 ${pad(h)}:${pad(m)}:${pad(ss)}`;
  return `${pad(h)}:${pad(m)}:${pad(ss)}`;
}

/** 剩余秒数 → 可读描述（用于「还剩 X」句式） */
export function formatRemainHuman(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s <= 0) return '已截单';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

/** 手机号脱敏（端上再兜一层，防止上游漏脱敏 —— §1.6） */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  return /^\d{11}$/.test(phone) ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone;
}

/**
 * 生成 UUID v4（用作 `Idempotency-Key` 与 `X-Request-Id`）
 *
 * ⚠️ 小程序无 `crypto.randomUUID`，此处用 `Math.random` 兜底 —— 幂等键只需
 *    「同一意图内稳定 + 跨请求唯一」，不用于安全场景，强度足够。
 */
export function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** 空值兜底 */
export function displayOr(value: string | number | null | undefined, fallback = '--'): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

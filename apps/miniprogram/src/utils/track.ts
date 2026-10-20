/**
 * utils/track —— 页面停留时长埋点（U15 · 2026-10-20 实装）
 *
 * ## 口径：匿名聚合
 * 只报「页面路径 + 进出时刻 + 时长」。**不发 token、不带任何身份字段** ——
 * 后端 DTO 在 `whitelist + forbidNonWhitelisted` 的 ValidationPipe 下也不收
 * 身份字段（详见 `api/track.ts` 与后端 `modules/track/dto/track.dto.ts` 头注）。
 *
 * ## 接线方式（各页面零改动）
 * `main.ts` 用**全局 mixin** 挂 `onShow` / `onHide`：uni-app 的页面生命周期在
 * mixin 中受支持，且 App 根组件同样走这一对钩子 ⇒ 「页面切换」与「app 前后台」
 * 都被覆盖，20+ 个页面无需逐个改。同页重复 onShow（如 app 前台恢复）由
 * `trackPageShow` 内部去重。
 *
 * ## 可靠性（弱网 / 离线不丢）
 * 上报失败不丢数据：事件进本地队列（uni storage 持久化，重启不丢），每次
 * 页面切换时 flush；队列有上限（`MAX_QUEUE`），超出丢最旧。
 *
 * ## 时钟口径
 * `durationMs` = 端上 `Date.now()` 差值，**自洽**（不依赖服务端时钟，客户端
 * 时钟偏移只影响 enter/leave 的绝对值）；服务端权威时刻是落库的 `created_at`。
 */
import type { PageDurationEvent } from '@/api/track';
import { reportPageDurations } from '@/api/track';

/** 本地队列存储键（版本化：改结构时换键，旧键自然废弃） */
const QUEUE_KEY = 'ab_track_queue_v1';
/** 单次上报条数上限（与后端 DTO `ArrayMaxSize` 对齐） */
const MAX_BATCH = 20;
/** 本地队列上限（超出丢最旧） */
const MAX_QUEUE = 100;
/** 单页停留时长上限：24h（防 app 挂后台几天后回来得到一个污染统计的值） */
const MAX_DWELL_MS = 24 * 60 * 60 * 1000;

/** 当前打开中、正在计时的页面（null = 无） */
let current: { page: string; pageQuery: string; enterAt: number } | null = null;

/** 待上报队列（内存是权威副本，storage 是持久化镜像） */
let queue: PageDurationEvent[] = loadQueue();

function isEvent(e: unknown): e is PageDurationEvent {
  if (!e || typeof e !== 'object') return false;
  const x = e as Partial<PageDurationEvent>;
  return (
    typeof x.page === 'string' &&
    typeof x.enterAt === 'number' &&
    typeof x.leaveAt === 'number' &&
    typeof x.durationMs === 'number'
  );
}

function loadQueue(): PageDurationEvent[] {
  try {
    const raw = uni.getStorageSync(QUEUE_KEY) as unknown;
    const arr = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
    return Array.isArray(arr) ? arr.filter(isEvent) : [];
  } catch {
    return [];
  }
}

function persistQueue(): void {
  try {
    uni.setStorageSync(QUEUE_KEY, queue.slice(-MAX_QUEUE));
  } catch {
    // 存储写入失败（空间满等）：静默 —— 内存队列仍在，本次会话内还能报
  }
}

/** query 对象 → `k=v&k=v`（键排序，保证「同页同参」可稳定比较） */
function serializeQuery(q: Record<string, string> | undefined): string {
  if (!q) return '';
  return Object.keys(q)
    .sort()
    .map((k) => `${k}=${q[k]}`)
    .join('&');
}

/**
 * 取当前页面路由 + query。
 *
 * 跨端差异（uni-app 两个终端的 page 实例形状不同）：
 *   · H5：query 在 `$page.query`；
 *   · 小程序：page 实例即页面 Page，query 在 `options`。
 * 两者都探，取不到返回空串（不阻塞主字段 `page`）。
 */
export function currentRouteSnapshot(): { page: string; pageQuery: string } {
  try {
    const pages = getCurrentPages() as unknown as Array<{
      route?: string;
      $page?: { query?: Record<string, string> };
      options?: Record<string, string>;
    }>;
    const last = pages[pages.length - 1];
    const route = last?.route ?? '';
    const q = last?.$page?.query ?? last?.options;
    return { page: route.replace(/^\//, ''), pageQuery: serializeQuery(q) };
  } catch {
    return { page: '', pageQuery: '' };
  }
}

/** 页面显示（onShow）：开一段新计时；同页重复触发（app 前台恢复）不重开 */
export function trackPageShow(page: string, pageQuery = ''): void {
  if (!page) return;
  if (current && current.page === page && current.pageQuery === pageQuery) return;
  closeCurrent();
  current = { page, pageQuery, enterAt: Date.now() };
}

/** 页面隐藏（onHide）：结算当前段并入队上报 */
export function trackPageHide(): void {
  closeCurrent();
}

/** 结算当前段：算时长、入队、落盘、触发上报 */
function closeCurrent(): void {
  if (!current) return;
  const leaveAt = Date.now();
  const durationMs = Math.max(0, Math.min(leaveAt - current.enterAt, MAX_DWELL_MS));
  queue.push({ ...current, enterAt: current.enterAt, leaveAt, durationMs });
  if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE);
  current = null;
  persistQueue();
  void flush();
}

/**
 * 把队列里的待报事件发出去（批量；失败保留，下次页面切换再试）。
 *
 * ⚠️ 不 await 给页面：埋点是旁路，页面流转不能被它拖住（调用方 `void flush()`）。
 * ⚠️ 逐批发完再发下一批；任一批失败即停 —— 剩余留队列。
 */
export async function flush(): Promise<void> {
  while (queue.length > 0) {
    const batch = queue.slice(0, MAX_BATCH);
    try {
      await reportPageDurations(batch);
      queue = queue.slice(batch.length);
      persistQueue();
    } catch {
      break;
    }
  }
}

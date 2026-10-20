/**
 * api/track —— 页面停留埋点上报（U15）
 * 契约：`POST /track/page-duration`（**匿名 · 免登录 · best-effort**）
 */
import { http } from './request';

/** 单条页面停留事件（与后端 `modules/track/dto/track.dto.ts` 逐字段对齐） */
export interface PageDurationEvent {
  /** 页面路由路径（如 pages/index/index） */
  page: string;
  /** 页面 query 序列化（如 buildingId=3；无 query 可省略） */
  pageQuery?: string;
  /** 进入时刻（端上 Date.now() 毫秒） */
  enterAt: number;
  /** 离开时刻（端上 Date.now() 毫秒） */
  leaveAt: number;
  /** 停留毫秒（端上计算，封顶 24h） */
  durationMs: number;
}

/**
 * U15 · 批量上报页面停留时长（一次 ≤ 20 条）
 *
 * ⚠️ `auth: false` —— **匿名口径，不携带 JWT**：未登录用户的行为（在哪儿流失）
 *    恰恰最该被看到；带上 token 反而与「服务端不认身份」的端点错配。
 * ⚠️ `keepAuthState: true` —— 旁路请求**无权裁决登录态**（语义见
 *    `api/request.ts` 的 `RequestOptions.keepAuthState` 头注）：埋点失败
 *    **绝不能**把用户的登录态清掉。
 * ⚠️ best-effort：失败由 `utils/track.ts` 留在本地队列重试，不抛给页面。
 */
export function reportPageDurations(events: PageDurationEvent[]): Promise<{ received: number }> {
  return http.post<{ received: number }>(
    '/track/page-duration',
    { events },
    { auth: false, keepAuthState: true, timeout: 5000 },
  );
}

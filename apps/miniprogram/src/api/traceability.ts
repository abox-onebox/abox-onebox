/**
 * api/traceability —— 今日这盒 · 商家溯源（**U5**）
 *
 * 契约：《接口规范 v1.0》§3.2 · 原型 P38「今日这盒 · 商家溯源」。
 *
 * ⚠️ 本文件在 M5-14 之前是**空壳**（内容只有 `export {}`，且页面是占位页）——
 *    即「文件名描述的是计划，不是事实」。现已实装，头部那段占位说明随之删除。
 *
 * ⚠️ `auth: false`：溯源是**免登录只读**端点（《接口规范》§1.1「首页、溯源可匿名只读」）。
 *    不携带 token 也能取数 —— 这一页的说服力正来自「不必登录也能查」。
 */
import type { TraceabilityTodayResult } from '@abox/shared-types';

import { http, query } from './request';

/**
 * U5 · 今日这盒溯源
 *
 * @param buildingId 办公楼 id（`ab_building.id`）· 免登录下服务端无从推楼群，**必传**
 * @param mealDate 出餐日 `YYYY-MM-DD`；缺省 = 服务端「明日」（T+1）
 */
export function fetchTraceabilityToday(
  buildingId: number,
  mealDate?: string,
): Promise<TraceabilityTodayResult> {
  return http.get<TraceabilityTodayResult>(
    `/traceability/today${query({ buildingId, mealDate })}`,
    { auth: false },
  );
}

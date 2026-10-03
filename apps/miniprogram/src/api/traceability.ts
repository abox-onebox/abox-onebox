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
import type {
  SupplierQualificationDetail,
  SupplierQualificationListResult,
  TraceabilityTodayResult,
} from '@abox/shared-types';

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

/**
 * 供应商资质墙 · 列表（**免登录只读** · 2026-10-03 新增）
 *
 * 取代原「跳转外卖平台看店铺」的信任路径 —— 那条路撞《运营规范》
 * 5.10 / 5.20 / 5.15.4 / 5.16，处理是下架乃至封禁剪切板能力。
 */
export function fetchSupplierQualifications(): Promise<SupplierQualificationListResult> {
  return http.get<SupplierQualificationListResult>('/traceability/suppliers', { auth: false });
}

/** 供应商资质墙 · 详情（**免登录只读**） */
export function fetchSupplierQualification(id: number): Promise<SupplierQualificationDetail> {
  return http.get<SupplierQualificationDetail>(`/traceability/suppliers/${id}`, { auth: false });
}

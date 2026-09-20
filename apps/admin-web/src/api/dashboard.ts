import { http } from './request';

/**
 * api/dashboard —— D66 后台工作台待办聚合（登录落点 `/dashboard` · M5-16）
 *
 * 口径出处：《接口规范 v1.0》§6.7 D66。本文件**只声明形状**，不复刻口径 ——
 * 「什么算待办」四个状态集合全部由服务端计算（见
 * `apps/api-server/src/modules/admin/dashboard/dashboard.service.ts`）。
 *
 * ⚠️ 前端的**唯一**职责是「按角色过滤渲染」：服务端对五个运营角色一律返回 4 条，
 *    但 `viewer` 只拥有看板菜单，指向 `/finance/*`、`/meal/*`、`/order/*` 的卡片
 *    它点不进去。端上按 `permission.visiblePaths` 过滤 —— 这是**渲染纪律**，
 *    不是安全边界（安全边界在各域控制器自己的 `@Roles`）。
 */

/** 待办键（与后端 `WorkbenchTodo['key']` 逐字一致） */
export type WorkbenchTodoKey =
  'refundApplying' | 'withdrawPending' | 'tomorrowGroupsUnassigned' | 'deliveriesLate';

export interface WorkbenchTodo {
  key: WorkbenchTodoKey;
  label: string;
  /** 待办条数；**0 也会下发**（端上据此渲染「已清空」，不靠猜） */
  count: number;
  /** 处理页路由（= 服务端 menu key，端上再按可见菜单过滤一次） */
  path: string;
  /** 口径说明，可直接展示 */
  hint: string;
}

/** 今日作业数字（与 `items` 同一次查询的副产物） */
export interface WorkbenchBrief {
  deliveryTotal: number;
  deliveryArrived: number;
  tomorrowGroupsTotal: number;
  tomorrowGroupsAssigned: number;
}

export interface WorkbenchTodosResult {
  /** 业务日（北京时间）= 今日出餐日 */
  businessDate: string;
  /** 明日出餐日（第 3 条待办与 `brief` 的基准） */
  tomorrowDate: string;
  items: WorkbenchTodo[];
  brief: WorkbenchBrief;
}

/** D66 工作台待办聚合 */
export const fetchWorkbenchTodos = () => http.get<WorkbenchTodosResult>('/admin/dashboard/todos');

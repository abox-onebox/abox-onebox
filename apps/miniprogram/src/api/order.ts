/**
 * api/order —— 订单（U6 创建、U9 列表、U10 详情、U11 自助取消）
 * 契约：《接口规范 v1.0》§3.3 / §3.4
 *
 * ⚠️ 幂等（§1.4 / §1.7）：创建订单**必须**带 `Idempotency-Key`。
 *    同一「下单意图」复用同一个键（本端在进入下单确认页时生成一次并持有），
 *    这样用户连点、网络重试都只会产生一单；
 *    服务端命中后回 `10006 + data=首次结果`，请求层已按 **成功** 解包。
 */
import type {
  CancelOrderResult,
  CreateOrderDto,
  CreateOrderResult,
  OrderDetailResult,
  OrderListItem,
  PageResult,
} from '@abox/shared-types';

import { http, query } from './request';

/** U6 · 创建订单（幂等） */
export function createOrder(
  dto: CreateOrderDto,
  idempotentKey: string,
): Promise<CreateOrderResult> {
  return http.post<CreateOrderResult>('/orders', { ...dto } as Record<string, unknown>, {
    idempotentKey,
  });
}

/** U9 · 我的订单列表 */
export function fetchOrders(
  params: { status?: string; page?: number; pageSize?: number } = {},
): Promise<PageResult<OrderListItem>> {
  return http.get<PageResult<OrderListItem>>(`/orders${query(params)}`);
}

/** U10 · 订单详情（含状态机时间线） */
export function fetchOrderDetail(orderNo: string): Promise<OrderDetailResult> {
  return http.get<OrderDetailResult>(`/orders/${encodeURIComponent(orderNo)}`);
}

/**
 * U11 · 自助取消（仅截单前 + pending_pay/paid）
 *
 * 截单后服务端返回 `40004`，并在 `payload.leaderContact` 里带团长联系方式 ——
 * 调用方需捕获 `ApiError` 并读取 `payload`，引导用户联系团长代退。
 */
export function cancelOrder(orderNo: string): Promise<CancelOrderResult> {
  return http.post<CancelOrderResult>(`/orders/${encodeURIComponent(orderNo)}/cancel`);
}

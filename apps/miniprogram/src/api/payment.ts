/**
 * api/payment —— 支付（U7 创建支付单、U8 支付结果、W1 调试触发）
 * 契约：《接口规范 v1.0》§3.3 / §七
 */
import type { PayCreateResult, PayResultView } from '@abox/shared-types';

import { http } from './request';

/**
 * U7 · 创建微信支付单（JSAPI，幂等）
 * 返回体可直接喂给 `uni.requestPayment`（另有 `orderNo` / `payAmountFen` 两个附加字段）。
 */
export function createPrepay(orderNo: string, idempotentKey: string): Promise<PayCreateResult> {
  return http.post<PayCreateResult>(`/orders/${encodeURIComponent(orderNo)}/pay`, undefined, {
    idempotentKey,
  });
}

/** U8 · 支付结果（轮询 / 回跳确认） */
export function fetchPayResult(orderNo: string): Promise<PayResultView> {
  return http.get<PayResultView>(`/orders/${encodeURIComponent(orderNo)}/pay-result`);
}

/**
 * 调试端点：手动触发支付成功（**仅 `PROVIDER_MODE=mock`**）
 *
 * 本地无微信商户号，`uni.requestPayment` 无法真正走通，
 * 故 mock 模式下由端上显式触发回调，等价于「微信通知到账」。
 */
export function mockPaid(orderNo: string, amountFen?: number): Promise<{ triggered: boolean }> {
  return http.post<{ triggered: boolean }>('/pay/mock/paid', { orderNo, amountFen });
}

/**
 * api/request —— 统一请求层（《接口规范 v1.0》§1.1 / §1.2 / §1.4 / §1.7）
 *
 * 职责：
 *   · 拼 baseUrl、注入 `Authorization` / `X-Client` / `X-Request-Id`
 *   · 注入 `Idempotency-Key`（下单 / 支付创建必填，§1.7）
 *   · 解包统一响应 `{ code, message, data, requestId, timestamp }`
 *   · 业务码 ≠ 0 一律转成 `ApiError`（**HTTP 200 也算失败** —— 见 §1.2 约定）
 *   · `10006 重复提交` 且携带 `data` 时按 **成功** 返回（幂等回放，§1.4）
 *
 * ⚠️ 本文件**不依赖任何 store / 登录流程**（否则与 utils/auth.ts 形成模块环）。
 *    需要「未登录先登录、401 自动重试」的调用方请用 `composables/use-request.ts`。
 */
import { HEADER } from '@abox/shared-types';
import type { ApiResponse } from '@abox/shared-types';

import { ENV } from '@/constants/env';
import { uuid } from '@/utils/format';
import { getToken, clearAuthStorage } from '@/utils/storage';

/** 成功码 */
export const CODE_OK = 0;
/** 幂等键命中（重复提交）—— 详见 §1.4 */
export const CODE_DUPLICATE_SUBMIT = 10006;
/** 未登录 / token 失效 */
export const CODE_UNAUTHORIZED = 10002;
/** 无权限 */
export const CODE_FORBIDDEN = 10003;
/** 触发限流 */
export const CODE_TOO_MANY_REQUESTS = 10005;
/** U11 截单后自助取消被拒 → 需团长代退（payload 带 leaderContact） */
export const CODE_REFUND_NOT_ALLOWED = 40004;

/** 业务异常（携带服务端 code / data / requestId，便于端上分支与排障） */
export class ApiError extends Error {
  readonly code: number;
  /** 业务载荷（如 U11 截单后的 leaderContact、幂等回放的首次结果） */
  readonly payload: unknown;
  readonly requestId: string;
  /** HTTP 状态码（仅 401/403/429 等语义码才有意义） */
  readonly httpStatus: number;

  constructor(
    code: number,
    message: string,
    payload: unknown = null,
    requestId = '',
    httpStatus = 0,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.payload = payload;
    this.requestId = requestId;
    this.httpStatus = httpStatus;
  }

  /** 是否「未登录 / 登录已过期」 */
  get isUnauthorized(): boolean {
    return this.code === CODE_UNAUTHORIZED || this.httpStatus === 401;
  }
}

export interface RequestOptions {
  /** 路径（不含 baseUrl），如 `/orders` */
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  data?: Record<string, unknown>;
  /** 是否携带 JWT（默认 true；登录 / 邀请落地等公开接口传 false） */
  auth?: boolean;
  /** 幂等键（`Idempotency-Key`，同一意图内复用同一个值） */
  idempotentKey?: string;
  /** 是否展示全屏 loading（默认 false，由页面按场景决定） */
  loading?: boolean;
  /** 超时（毫秒），默认 15s */
  timeout?: number;
}

interface RawResponse {
  statusCode: number;
  data: unknown;
}

let loadingCount = 0;

function showLoading(): void {
  if (loadingCount === 0) uni.showLoading({ title: '加载中', mask: true });
  loadingCount += 1;
}

function hideLoading(): void {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount === 0) uni.hideLoading();
}

/** 包一层 Promise：uni.request 的返回值类型因版本而异（Task / Promise），显式包最稳 */
function uniRequest(options: UniApp.RequestOptions): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    uni.request({
      ...options,
      success: (res) => resolve({ statusCode: res.statusCode, data: res.data }),
      fail: (err) => reject(new Error(err.errMsg || '网络异常，请检查网络后重试')),
    } as UniApp.RequestOptions);
  });
}

function isApiResponse(body: unknown): body is ApiResponse<unknown> {
  return (
    !!body && typeof body === 'object' && typeof (body as ApiResponse<unknown>).code === 'number'
  );
}

/** 统一请求入口 */
export async function request<T>(options: RequestOptions): Promise<T> {
  const {
    url,
    method = 'GET',
    data,
    auth = true,
    idempotentKey,
    loading = false,
    timeout = 15000,
  } = options;

  const header: Record<string, string> = {
    'Content-Type': 'application/json',
    [HEADER.CLIENT]: 'mp-weixin',
    [HEADER.REQUEST_ID]: uuid(),
  };
  const token = getToken();
  if (auth && token) header[HEADER.AUTHORIZATION] = `Bearer ${token}`;
  if (idempotentKey) header[HEADER.IDEMPOTENCY_KEY] = idempotentKey;

  if (loading) showLoading();

  let res: RawResponse;
  try {
    res = await uniRequest({
      url: `${ENV.apiBaseUrl}${url}`,
      method,
      data,
      header,
      timeout,
    } as UniApp.RequestOptions);
  } finally {
    if (loading) hideLoading();
  }

  const body = res.data;

  // 非统一结构（网关错误页 / HTML）—— 直接报网络级异常，避免误判为业务失败
  if (!isApiResponse(body)) {
    throw new ApiError(
      -1,
      res.statusCode === 200 ? '服务端返回格式异常' : `请求失败（HTTP ${res.statusCode}）`,
      null,
      '',
      res.statusCode,
    );
  }

  const { code, message, data: payload, requestId } = body;

  if (code === CODE_OK) return payload as T;

  // token 失效：清理本地登录态，交由上层（useRequest / 页面）重新登录后重试
  if (code === CODE_UNAUTHORIZED || res.statusCode === 401) {
    clearAuthStorage();
  }

  // §1.4 幂等回放：重复提交且带回首次结果 → **端上按成功处理**
  if (code === CODE_DUPLICATE_SUBMIT && payload !== null && payload !== undefined) {
    return payload as T;
  }

  throw new ApiError(code, message || '请求失败', payload, requestId, res.statusCode);
}

/** 便捷方法（GET 查询串由调用方拼好，端上不做嵌套序列化） */
export const http = {
  get: <T>(url: string, options: Omit<RequestOptions, 'url' | 'method'> = {}) =>
    request<T>({ url, method: 'GET', ...options }),
  post: <T>(
    url: string,
    data?: Record<string, unknown>,
    options: Omit<RequestOptions, 'url' | 'method' | 'data'> = {},
  ) => request<T>({ url, method: 'POST', data, ...options }),
  /** PUT —— 用于 M2 团长资料修改（L15）；**非幂等语义**，无需 `Idempotency-Key` */
  put: <T>(
    url: string,
    data?: Record<string, unknown>,
    options: Omit<RequestOptions, 'url' | 'method' | 'data'> = {},
  ) => request<T>({ url, method: 'PUT', data, ...options }),
};

/** 查询串拼装（含 undefined 跳过与编码） */
export function query(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

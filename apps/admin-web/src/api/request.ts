import axios, { AxiosError } from 'axios';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';

import { clearTokens, getToken } from '@/utils/auth';

/** 统一响应信封（《接口规范》§1.2） */
export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
  requestId?: string;
  timestamp?: number | string;
}

/**
 * 业务异常（`code !== 0`）
 *
 * ⚠️ **业务失败是 HTTP 200**（§1.4），所以调用方要判 `code` 而不是 HTTP 状态。
 *    本类把两者都带上（`code` 业务码 / `httpStatus` 真实 HTTP 码），
 *    便于页面按业务码分支（如 40003 提现低于限额 → 引导去设置金额）。
 */
export class ApiError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly httpStatus?: number;

  constructor(code: number, message: string, data?: unknown, httpStatus?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.data = data;
    this.httpStatus = httpStatus;
  }
}

/** 网络层失败（未拿到业务信封）的统一码 */
export const NETWORK_ERROR_CODE = -1;

const instance: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api/v1',
  timeout: 20000,
});

/**
 * 幂等键请求头名（与后端 `HEADER.IDEMPOTENCY_KEY` **同字面量** · 《接口规范》§1.7）
 */
const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/**
 * 幂等键的**时间窗**（毫秒）
 *
 * 窗口内「同方法 + 同地址 + 同请求体」视为**同一次用户操作** —— 于是「双击提交」
 * 与「超时后手动再点一次」都会命中同一个键，被后端幂等拦截器拦成第二次（`10006` + 首次结果）。
 *
 * ⚠️ 窗口**不能取消**（不留窗口 = 每次请求都是新键 = 兜底失效），也不能太长：
 *    60 秒是「一次提交动作」的自然时长上限。真要做**跨窗口**的严格幂等，
 *    得由调用点显式传一个**业务键**（如 `refund-approve-${id}`）——
 *    `api/finance.ts` 的余额调整就是这么做的，那也是**首选**做法，本函数只是兜底。
 */
const IDEMPOTENCY_WINDOW_MS = 60_000;

/** 需要幂等键的方法（读方法重复执行无害，不必带） */
const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);

/** FNV-1a 32 位 —— 只用于**去重**、不用于安全，故无需加密强度 */
function fingerprint(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 兜底生成幂等键（M5-7 · 缺陷 #80 另一半）—— 返回 `null` 表示「这个请求不需要」
 *
 * ⚠️ 只在请求头里**没有**幂等键时才生效：显式传键的调用点（`api/finance.ts` 的余额调整）
 *    语义完全不变 —— 业务键比指纹键精确，不该被这里覆盖。
 */
function idempotencyKeyOf(config: {
  method?: string;
  url?: string;
  params?: unknown;
  data?: unknown;
}): string | null {
  const method = (config.method ?? 'get').toLowerCase();
  if (!WRITE_METHODS.has(method)) return null;
  // FormData 无法稳定指纹（`JSON.stringify` 只会得到 `{}`），且上传类请求天然可重放
  if (typeof FormData !== 'undefined' && config.data instanceof FormData) return null;

  const timeWindow = Math.floor(Date.now() / IDEMPOTENCY_WINDOW_MS);
  const raw = [
    method,
    config.url ?? '',
    JSON.stringify(config.params ?? null),
    typeof config.data === 'string' ? config.data : JSON.stringify(config.data ?? null),
    String(timeWindow),
  ].join('|');
  return `${timeWindow}-${fingerprint(raw)}`;
}

instance.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;

  if (!config.headers[IDEMPOTENCY_HEADER]) {
    const auto = idempotencyKeyOf(config);
    if (auto) config.headers.set(IDEMPOTENCY_HEADER, auto);
  }
  return config;
});

/** 清态并跳登录（保留原路径，登录后回跳） */
function redirectToLogin(): void {
  clearTokens();
  const current = `${window.location.pathname}${window.location.search}`;
  if (window.location.pathname !== '/login') {
    window.location.replace(`/login?redirect=${encodeURIComponent(current)}`);
  }
}

instance.interceptors.response.use(
  (resp) => {
    const body = resp.data as ApiEnvelope<unknown> | undefined;

    // 非信封响应（文件流 / 第三方回跳）原样返回
    if (!body || typeof body.code !== 'number') return resp.data;

    if (body.code === 0) return body.data;

    // 仅 401 自动跳登录；403 交回页面处理（越权提示要留在当前上下文里才说得清）
    if (body.code === 10002) redirectToLogin();

    throw new ApiError(body.code, body.message || '请求失败', body.data, resp.status);
  },
  (error: AxiosError) => {
    const status = error.response?.status;
    const body = error.response?.data as ApiEnvelope<unknown> | undefined;
    const code = body?.code ?? (status === 403 ? 10003 : NETWORK_ERROR_CODE);

    if (code === 10002 || status === 401) redirectToLogin();

    const message =
      body?.message ||
      (status === 429
        ? '请求过于频繁，请稍后再试'
        : error.code === 'ECONNABORTED'
          ? '请求超时，请检查网络或后端服务'
          : (error.message ?? '网络异常'));

    return Promise.reject(new ApiError(code, message, body?.data, status));
  },
);

/**
 * 便捷方法（泛型即 `data` 的类型 —— 拦截器已拆包）
 *
 * ⚠️ `params` 用 `object` 而不是 `Record<string, unknown>`：接口类型（如
 *    `AdminAccountQuery`）没有索引签名，用 Record 会在调用处报 TS2345。
 */
export const http = {
  get: <T>(url: string, params?: object, config?: AxiosRequestConfig) =>
    instance.get<unknown, T>(url, { params, ...config }),

  post: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    instance.post<unknown, T>(url, data, config),

  put: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    instance.put<unknown, T>(url, data, config),

  patch: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    instance.patch<unknown, T>(url, data, config),

  delete: <T>(url: string, config?: AxiosRequestConfig) => instance.delete<unknown, T>(url, config),

  /**
   * 带鉴权头的文件下载（D12 Excel 导出、D43 对账文件等）
   *
   * ⚠️ 不能用 `window.open(url)`：那样不会带 `Authorization` 头，后端必然 401。
   *    必须走 axios 拿 blob 再本地触发下载。
   */
  async download(url: string, params: Record<string, unknown>, filename: string): Promise<void> {
    const blob = await instance.get<unknown, Blob>(url, { params, responseType: 'blob' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  },
};

export default instance;

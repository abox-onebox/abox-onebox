/**
 * utils/auth —— 后台令牌的本地存取
 *
 * ⚠️ **为什么放在 utils 而不是 store**：`api/request.ts` 要在拦截器里读 token，
 *    而 store 依赖 api 层 —— 若 request 反过来 import store 就成环。
 *    所以令牌的读写下沉到无依赖的 utils，store 与 request 共同消费它。
 *
 * ⚠️ 存 localStorage 的取舍：后台是 PC 场景，需要「关掉浏览器再打开还在」。
 *    代价是 XSS 可读 —— 一期无用户生成内容直出（无 v-html），风险可接受；
 *    二期若引入富文本渲染，应改为 httpOnly Cookie + CSRF 令牌。
 */
const TOKEN_KEY = 'abox_admin_token';
const REFRESH_KEY = 'abox_admin_refresh_token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function getRefreshToken(): string {
  return localStorage.getItem(REFRESH_KEY) ?? '';
}

export function setTokens(token: string, refreshToken?: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

/** 是否需要跳登录页（供路由守卫与请求层共用同一判据） */
export function hasToken(): boolean {
  return getToken() !== '';
}

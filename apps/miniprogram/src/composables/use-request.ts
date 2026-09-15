/**
 * composables/use-request —— 「自动登录 + 401 重试」的请求包装
 *
 * 为什么单独一层：`api/request.ts` 刻意**不依赖 store / 登录流程**
 * （否则与 `utils/auth.ts` 形成模块环：auth → api/auth → api/request → auth）。
 * 而页面几乎都需要「未登录先静默登录、token 过期自动续一次」，
 * 故把这段编排下沉到 composable，页面只写：
 *   const { run, loading } = useRequest();
 *   const data = await run(() => fetchDaily());
 */
import { ref } from 'vue';

import { ApiError } from '@/api/request';
import { ensureLogin } from '@/utils/auth';

export interface RunOptions {
  /** 401 时是否重新登录并重试一次（默认 true） */
  retryOnUnauthorized?: boolean;
}

export function useRequest() {
  const loading = ref(false);
  const error = ref<ApiError | null>(null);

  /**
   * 执行一次带登录保障的请求
   * ⚠️ 重试只做一次：避免「登录成功但接口持续 401」时陷入无限循环。
   */
  async function run<T>(task: () => Promise<T>, options: RunOptions = {}): Promise<T> {
    const { retryOnUnauthorized = true } = options;
    loading.value = true;
    error.value = null;
    try {
      await ensureLogin();

      try {
        return await task();
      } catch (e) {
        if (retryOnUnauthorized && e instanceof ApiError && e.isUnauthorized) {
          // request 层已清空本地登录态，此处强制重新登录后再试一次
          await ensureLogin(true);
          return await task();
        }
        throw e;
      }
    } catch (e) {
      const apiErr =
        e instanceof ApiError
          ? e
          : new ApiError(-1, (e as Error).message || '请求失败，请稍后重试');
      error.value = apiErr;
      throw apiErr;
    } finally {
      loading.value = false;
    }
  }

  return { run, loading, error };
}

/** 把异常转成用户可读文案（不弹提示，仅取文案，便于页面自行决定展示位置） */
export function apiErrorMessage(e: unknown, fallback = '操作失败，请稍后重试'): string {
  if (e instanceof ApiError) return e.message || fallback;
  if (e instanceof Error) return e.message || fallback;
  return fallback;
}

/** 统一错误提示（一次性 toast） */
export function toastApiError(e: unknown, fallback?: string): void {
  uni.showToast({ title: apiErrorMessage(e, fallback), icon: 'none', duration: 2200 });
}

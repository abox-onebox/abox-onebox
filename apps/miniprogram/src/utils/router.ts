/**
 * utils/router —— 路由跳转封装
 *
 * ⚠️ 本小程序**不用原生 tabBar**（团长入口要按身份动态出现，原生 tabBar 无法条件渲染），
 *    故「切换底部主 tab」用 `reLaunch`：清空页面栈，避免用户连点后栈无限增长。
 *    页面内下钻（如首页 → 下单确认）用 `navigateTo`，保留返回能力。
 */

/** 底部主 tab（reLaunch 切栈） */
export function switchTab(url: string): void {
  uni.reLaunch({
    url,
    fail: (err) => console.warn(`[router] reLaunch ${url} 失败`, err),
  });
}

/** 下钻（保留返回栈） */
export function navigateTo(url: string): void {
  uni.navigateTo({
    url,
    // 页面栈上限 10，溢出时降级为重定向（避免「点了没反应」）
    fail: (err) => {
      console.warn(`[router] navigateTo ${url} 失败，降级 redirectTo`, err);
      uni.redirectTo({ url, fail: () => undefined });
    },
  });
}

/** 替换当前页（下单 → 支付结果这类不可回退的流转） */
export function redirectTo(url: string): void {
  uni.redirectTo({
    url,
    fail: (err) => {
      console.warn(`[router] redirectTo ${url} 失败，降级 reLaunch`, err);
      uni.reLaunch({ url, fail: () => undefined });
    },
  });
}

/** 返回（栈底时回到首页） */
export function navigateBack(delta = 1): void {
  const pages = getCurrentPages();
  if (pages.length > delta) {
    uni.navigateBack({ delta });
  } else {
    switchTab('/pages/index/index');
  }
}

/** 拼接查询串（自动编码；空值跳过） */
export function buildUrl(path: string, query: Record<string, string | number | undefined>): string {
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `${path}?${parts.join('&')}` : path;
}

/** 页面参数读取（类型安全，避免页面里到处 as string） */
export function pageQuery(options: Record<string, unknown> | undefined, key: string): string {
  const raw = options?.[key];
  if (raw === undefined || raw === null) return '';
  return decodeURIComponent(String(raw));
}

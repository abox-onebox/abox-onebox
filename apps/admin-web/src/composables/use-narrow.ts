import { onUnmounted, ref, type Ref } from 'vue';

/**
 * 窄屏（移动端）判据 —— S8 后台移动端关键路径。
 *
 * ## 为什么必须有**单一**判据
 *
 * 本批只做**两条**关键路径（供应商配外卖链接 / 团长佣金结算），**不做全站响应式**。
 * 「只做两条」这件事要能被机械检查，前提是「窄屏」有唯一真源：
 * 一处写 `768`、SCSS 里再写一个 `@media (max-width: 768px)`，两处就会错开半像素，
 * 而**任何门禁都看不见**（CSS 断点与 JS 断点是两份表述）。
 *
 * ⇒ 断点值只在本文件出现一次；SCSS 侧**不写断点**，改为挂 `.is-narrow` 类名
 *   （见 `layouts/default-layout.vue` / 两个关键路径视图）。
 *
 * ## 为什么用 `matchMedia` 而不是监听 resize
 *
 * `resize` 在移动端滚动时高频触发（iOS 地址栏收起也会触发），逐次重算会掉帧；
 * `matchMedia` 只在**跨越断点**时回调一次，且语义就是「是否窄屏」，无中间态可漂移。
 *
 * ## 为什么同步初始化（不在 onMounted 里读）
 *
 * 若在 `onMounted` 才求值，移动端首帧会按桌面渲染一帧再切到移动版 —— 可见闪动。
 * 本函数在 `setup()` 期间同步求值，首帧即正确。
 */

/** 窄屏断点（px）。是「窄屏」的**唯一真源**。 */
export const NARROW_MAX = 768;

const QUERY = `(max-width: ${NARROW_MAX}px)`;

/** 仅浏览器可用（SSR / 单测下按桌面处理） */
function mediaQuery(): MediaQueryList | undefined {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
  return window.matchMedia(QUERY);
}

/** 响应式：当前是否窄屏。 */
export function useNarrow(): { narrow: Ref<boolean> } {
  const narrow = ref(mediaQuery()?.matches ?? false);
  const mq = mediaQuery();

  const onChange = (e: MediaQueryListEvent): void => {
    narrow.value = e.matches;
  };

  if (mq) mq.addEventListener('change', onChange);

  onUnmounted(() => {
    mq?.removeEventListener('change', onChange);
  });

  return { narrow };
}

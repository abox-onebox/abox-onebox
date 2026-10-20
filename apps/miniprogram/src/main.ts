import { createSSRApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { currentRouteSnapshot, trackPageHide, trackPageShow } from './utils/track';

export function createApp() {
  const app = createSSRApp(App);
  app.use(createPinia());
  /*
   * U15 · 页面停留埋点：全局 mixin 挂页面生命周期（各页面零改动）。
   *
   * uni-app 的页面生命周期（onShow / onHide）在 mixin 中受支持；App 根组件
   * 同样走这一对钩子，故「页面切换」与「app 前后台」都覆盖。同页重复
   * onShow 由 `trackPageShow` 内部去重（见 utils/track.ts 头注）。
   *
   * ⚠️ 刻意抽成**具名变量**再传给 `app.mixin`：onShow/onHide 不是 Vue 标准
   *    选项，对象字面量直传会被 TS 的「多余属性检查」拦下；具名变量的结构
   *    类型对该检查豁免（非 fresh literal）。
   */
  const trackMixin = {
    onShow() {
      const r = currentRouteSnapshot();
      trackPageShow(r.page, r.pageQuery);
    },
    onHide() {
      trackPageHide();
    },
  };
  app.mixin(trackMixin);
  return { app };
}

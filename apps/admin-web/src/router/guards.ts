import type { Router } from 'vue-router';
import NProgress from 'nprogress';
import 'nprogress/nprogress.css';

import { useAuthStore } from '@/stores/auth';
import { usePermissionStore } from '@/stores/permission';

NProgress.configure({ showSpinner: false });

/** 无需授权即可访问的路径 */
const WHITE_LIST = ['/login', '/403'];

/**
 * 路由守卫
 *
 * 链路：① 无 token → 登录页 ② **A5 会话求证** ③ 已登录访问 /login → 落地页
 *      ④ 菜单守卫（能访问的 path 必须在该角色菜单内）
 *
 * ⚠️ **为什么每次进路由都要 `restore()`**：它是幂等的（`restored` 标记，
 *    一次会话只打一次 A5）。第一跳求证，后续跳转直接命中缓存。
 *    这一跳的价值：本地 token 可能已过期/被吊销/账号已停用，
 *    只靠 localStorage 判断会让人看到「进去了但每个接口都 401」的鬼状态。
 *
 * ⚠️ **菜单守的是体验不是安全**：`/admin/*` 与 `/supplier/*` 的服务端拦截在
 *    `JwtAuthGuard`（主体隔离）+ `AdminGuard`（`@Roles()` 白名单）。
 *    即便有人手改 localStorage 的 menus 绕过本守卫，接口照样 403。
 */
export function setupGuards(router: Router): void {
  router.beforeEach(async (to) => {
    NProgress.start();

    const auth = useAuthStore();

    // ① 未登录
    if (!auth.isLoggedIn) {
      if (WHITE_LIST.includes(to.path)) return true;
      return { path: '/login', query: { redirect: to.fullPath } };
    }

    // ② 会话求证（幂等，一次会话只打一次 A5）
    const ok = await auth.restore();
    if (!ok) {
      if (to.path === '/login') return true;
      return { path: '/login', query: { redirect: to.fullPath } };
    }

    // ③ 已登录还想去登录页 → 送到该角色的落地页
    if (to.path === '/login') {
      const landing = usePermissionStore().landingPath;
      return landing ? { path: landing } : { path: '/403' };
    }

    if (WHITE_LIST.includes(to.path)) return true;

    // ④ 菜单守卫
    const perm = usePermissionStore();

    // 角色没配到任何菜单（或菜单被移除）→ 明确提示，不要白屏
    if (perm.visiblePaths.length === 0) {
      return { path: '/403', query: { reason: 'no-menu' } };
    }

    if (!perm.canAccessPath(to.path)) {
      return { path: '/403', query: { from: to.fullPath } };
    }

    return true;
  });

  router.afterEach(() => NProgress.done());
  router.onError(() => NProgress.done());
}

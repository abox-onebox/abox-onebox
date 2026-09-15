import type { Router } from 'vue-router';

/**
 * 鉴权守卫
 * - 未登录 → /login
 * - role=supplier 只能访问供应商菜单（P21–P26 对应视图）
 * - role=admin 可访问全部
 */
export function setupGuards(router: Router) {
  router.beforeEach((to) => {
    const token = localStorage.getItem('abox_admin_token');
    if (to.path !== '/login' && !token) {
      return { path: '/login', query: { redirect: to.fullPath } };
    }
    if (to.path === '/login' && token) {
      return { path: '/' };
    }
    return true;
  });
}

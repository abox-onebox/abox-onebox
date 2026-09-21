import { defineStore } from 'pinia';

import { ADMIN_NAV, SUPPLIER_NAV } from '@/constants';
import { canAccess, filterByMenus, filterGroupsByMenus } from '@/utils/permission';
import type { AboxIconName } from '@abox/shared-utils';
import { useAuthStore } from './auth';

export interface NavItem {
  path: string;
  title: string;
  page: string;
  module: string;
  /**
   * 菜单图标（见 `ADMIN_NAV` / `SUPPLIER_NAV` 每项的 `icon`）
   *
   * ⚠️ 必填且必须是 `ABOX_ICON_NAMES`（82 名 Tabler 子集）之一 ——
   *    写错名字的表现是**图标位置空白**（字形不存在，不报错）。
   *    机械门禁：`scripts/check-nav-consistency.mjs` 第 ⑥ 条同源校验。
   */
  icon: AboxIconName;
}

export interface NavGroup {
  group: string;
  items: NavItem[];
}

/**
 * stores/permission —— 侧边栏与路由可见性（按**服务端下发的 menus** 过滤）
 *
 * ## 单一事实来源
 * 「角色能看到哪些菜单」只在服务端定义（`api-server/common/constants/admin-role.ts`），
 * 经 A2/A5 的 `account.menus[]` 下发。本 store 只做**取交集**：
 * `NAV（前端的路由清单） ∩ menus（服务端的授权清单）`。
 *
 * ⚠️ 因此新增页面时**必须同时**在服务端 `ADMIN_MENU_KEYS` 里登记 path ——
 *    漏登记的表现是「路由能访问、菜单不显示」（被静默过滤），容易被误判成前端 bug。
 *
 * ⚠️ 这只是**体验层**。真正的越权拦截在服务端（`JwtAuthGuard` 主体隔离 +
 *    `AdminGuard` 的 `@Roles()`），手改 localStorage 的 menus 也进不去接口。
 */
export const usePermissionStore = defineStore('permission', {
  getters: {
    /** 当前账号可见的导航（分组已过滤，空分组自动隐藏） */
    navGroups(): NavGroup[] {
      const auth = useAuthStore();
      const menus = auth.menus;

      if (auth.isSupplier) {
        const items = filterByMenus(SUPPLIER_NAV, menus);
        return items.length > 0 ? [{ group: '商家', items }] : [];
      }

      return filterGroupsByMenus(ADMIN_NAV, menus) as NavGroup[];
    },

    /**
     * 登录后 / 访问无权页时的落地路径：第一个可见菜单。
     * 一个都没有（角色配错 / 菜单被移除）时返回空串，由守卫送到 `/403?reason=no-menu`。
     */
    landingPath(): string {
      return this.navGroups[0]?.items[0]?.path ?? '';
    },

    /** 平铺的可见 path（供调试 / 测试断言） */
    visiblePaths(): string[] {
      return this.navGroups.flatMap((g) => g.items.map((i) => i.path));
    },

    /** 路径是否可访问（含前缀匹配，用于路由守卫） */
    canAccessPath() {
      return (path: string): boolean => canAccess(useAuthStore().menus, path);
    },
  },
});

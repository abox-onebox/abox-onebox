/**
 * utils/permission —— 纯函数形式的菜单判定（无状态，便于单测与复用）
 *
 * 语义与 API 侧 `api-server/src/common/constants/admin-role.ts` 对齐：
 *   · menu key = 前端路由 path
 *   · `'*'` = 全量通配（super_admin）
 *   · 前缀匹配允许子路径（`/order/detail/123` 命中 `/order/detail`）
 *
 * ⚠️ 本文件只影响**看得到什么**，不影响**能做什么** —— 后者由服务端
 *    `AdminGuard` + `@Roles()` 决定（见 AdminGuard 注释）。
 */

export const MENU_WILDCARD = '*';

/** 是否持有全量通配 */
export function isWildcard(menus: readonly string[]): boolean {
  return menus.includes(MENU_WILDCARD);
}

/**
 * 能否访问某路径
 *
 * 先精确匹配再前缀匹配：`/supplier/list` 不应被 `/supplier` 误放行 ——
 * 因为前缀比较是「配置项 + `/`」而不是裸 startsWith。
 */
export function canAccess(menus: readonly string[], path: string): boolean {
  if (isWildcard(menus)) return true;
  const clean = path.split('?')[0];
  return menus.some((m) => clean === m || clean.startsWith(`${m}/`));
}

/** 按菜单过滤一组导航项（`{ path, ... }`） */
export function filterByMenus<T extends { path: string }>(
  items: readonly T[],
  menus: readonly string[],
): T[] {
  return items.filter((i) => canAccess(menus, i.path)).map((i) => ({ ...i }));
}

/** 过滤分组导航，并丢弃过滤后为空的分组 */
export function filterGroupsByMenus<
  G extends { group: string; items: ReadonlyArray<{ path: string }> },
>(
  groups: readonly G[],
  menus: readonly string[],
): Array<{ group: string; items: G['items'][number][] }> {
  return groups
    .map((g) => ({
      group: g.group,
      items: filterByMenus(g.items, menus),
    }))
    .filter((g) => g.items.length > 0);
}

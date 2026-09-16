/**
 * 后台角色与菜单矩阵（A2 登录出参 `account.menus[]` 的单一事实来源）
 *
 * ## 一期口径（2026-09-15 裁定）
 * **不建 `ab_admin_role` 表**：角色 → 菜单映射内置在本文件，`ab_admin_user.role`
 * 枚举驱动。理由：一期后台账号数 < 10，角色集合由代码定义（D54 只读矩阵 + D55
 * 落到「改账号角色」即 D53），引入表驱动纯属过度设计；等出现「运营自定义角色」
 * 诉求再迁表，届时本文件降级为默认种子。
 *
 * ## menu key = 前端路由 path
 * 前端 `ADMIN_NAV` / `SUPPLIER_NAV` 每项的 `path` 即 menu key，前端按
 * `menus.includes('*') || menus.includes(item.path)` 过滤侧边栏。
 * **改路由 path 必须同步改本文件**，否则该菜单对所有人消失（前端会静默过滤掉）。
 *
 * ## 权限边界（M3 验收标准 1）
 * 菜单过滤只是**视觉**，真正的越权拦截在服务端：
 *   · `JwtAuthGuard` —— `/admin/*` 与 `/supplier/*` 只收 `typ='admin'`
 *   · `AdminGuard` + `@Roles()` —— 角色白名单
 * 前端同时用 `route.meta.roles` 做二次路由守卫（体验层，不是安全边界）。
 */

/** 全量通配（super_admin 专用） */
export const MENU_WILDCARD = '*';

/** 运营侧菜单 key（与 admin-web `ADMIN_NAV` 的 path 逐项一致） */
export const ADMIN_MENU_KEYS = [
  '/dashboard',
  '/meal/matrix',
  '/meal/edit',
  '/meal/template',
  '/order/list',
  '/order/detail',
  '/leader/list',
  '/leader/apply',
  '/building/overview',
  '/building/list',
  '/building/groups',
  '/building/leader-binding',
  '/building/delivery-map',
  // 供应商（平台端 P33 · M34）—— ⚠️ `/supplier/dishes` 与 `/supplier/edit` 是**商家端**
  // P23/P24/P26 的 key（与 `SUPPLIER_MENU_KEYS` 重叠，属脚手架遗留）；平台端的
  // 菜品库与供应商表单另起 `/supplier/dish-library`、`/supplier/form`，避免两角色撞页。
  '/supplier/list',
  '/supplier/form',
  '/supplier/dish-library',
  '/supplier/distribution-center',
  '/supplier/takeout-links',
  '/supplier/edit',
  '/supplier/dishes',
  '/finance/overview',
  '/finance/commission',
  '/finance/balance',
  '/finance/supplier-share',
  '/finance/refund',
  '/finance/reconciliation',
  // M3-15：D44 发票管理（进项票台账 · 纯读派生视图）
  '/finance/invoices',
  '/stats/core-metrics',
  '/stats/building-rank',
  '/stats/dish-heat',
  '/stats/retention',
  '/system/config',
  '/system/admin-user',
  '/system/role',
  '/system/operation-log',
  '/system/message-template',
] as const;

/**
 * 供应商侧菜单 key（与 `admin-web/src/constants/index.ts` 的 `SUPPLIER_NAV` 逐项一致 · P21–P26）
 *
 * ⚠️ M3-8 起 `P21/P22` 有了真实页面（`/supplier/workbench`、`/supplier/cook-confirm`、
 *    `/supplier/packing`），不再借用 `/dashboard`、`/order/list` 顶替。
 *    `/order/list`（订单中心）**已从供应商角色移除** —— 供应商不需要看全量订单；
 *    `/dashboard` 保留为登录后的兜底落点。
 */
export const SUPPLIER_MENU_KEYS = [
  '/dashboard',
  '/supplier/workbench',
  '/supplier/cook-confirm',
  '/supplier/packing',
  '/supplier/dishes',
  '/supplier/edit',
  // ⚠️ M3-9：原先借用的 `/finance/supplier-share` 是**后台财务页**（组件调
  // `/admin/supplier-shares`），供应商点进去只会拿 10003 —— 页面直接坏掉。
  // 供应商自己的结算页是 `/supplier/settlement`（调 `/supplier/settlement`）。
  '/supplier/settlement',
] as const;

/** 角色 → 菜单 key */
export const ROLE_MENUS: Record<string, readonly string[]> = {
  super_admin: [MENU_WILDCARD],
  admin: ADMIN_MENU_KEYS,
  /** 运营专员：不开放系统管理与角色权限 */
  operator: ADMIN_MENU_KEYS.filter((k) => !k.startsWith('/system/')),
  /** 财务：财务 + 订单/套餐只读 + 看板，不碰团长与系统 */
  finance: [
    '/dashboard',
    '/finance/overview',
    '/finance/commission',
    '/finance/balance',
    '/finance/supplier-share',
    '/finance/refund',
    '/finance/reconciliation',
    // M3-15：财务要催票 —— 发票管理是 finance 角色的核心日常工作（D44）
    '/finance/invoices',
    '/order/list',
    '/order/detail',
    '/stats/core-metrics',
    '/stats/building-rank',
    '/stats/dish-heat',
    '/stats/retention',
  ],
  /** 只读观察者：仅看板 */
  viewer: [
    '/dashboard',
    '/stats/core-metrics',
    '/stats/building-rank',
    '/stats/dish-heat',
    '/stats/retention',
  ],
  /** 供应商：仅自己的 P21–P26 */
  supplier: SUPPLIER_MENU_KEYS,
};

/** 角色中文名（后台展示 / 操作日志） */
export const ROLE_LABEL: Record<string, string> = {
  super_admin: '超级管理员',
  admin: '管理员',
  operator: '运营专员',
  finance: '财务',
  viewer: '只读观察者',
  supplier: '供应商',
};

/** 全部合法角色（D52/D53 入参白名单；与 ab_admin_user.role 注释一致） */
export const ADMIN_ROLES = Object.keys(ROLE_MENUS);

/**
 * 取某角色的菜单；未知角色返回**空数组**（fail-closed：宁可侧边栏为空，
 * 也不能因为拼错角色名而放行全量菜单）。
 */
export function menusOf(role: string): string[] {
  return [...(ROLE_MENUS[role] ?? [])];
}

/**
 * 令牌吊销标记键（改角色 / 停用账号 / 重置密码时写入，值为毫秒时间戳）
 *
 * ⚠️ 为什么需要它：JWT 无状态，后台 access 有效期 12h。若改角色或停用账号后
 *    旧令牌仍能用到自然过期，就是长达 12 小时的特权滞留窗口 ——
 *    `AdminGuard` 比对「令牌 iat < 吊销时刻」即要求重新登录，把窗口压到 0。
 *    代价：非「立即生效」的角色调整每次都不必踢人（未写标记则完全不查）。
 */
export const adminRevokeKey = (adminUserId: number): string => `admin:revoked:${adminUserId}`;

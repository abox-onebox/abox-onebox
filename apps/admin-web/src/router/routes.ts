import type { RouteRecordRaw } from 'vue-router';

export const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/layouts/login-layout.vue'),
  },
  {
    path: '/',
    component: () => import('@/layouts/default-layout.vue'),
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('@/views/dashboard/index.vue'),
      },

      // 权限兜底（路由守卫拦下无权路径 / 菜单为空时落到这里）
      {
        path: '403',
        name: 'Forbidden',
        component: () => import('@/views/error/403.vue'),
      },

      // 套餐编排 M31 · P27–P29
      {
        path: 'meal/matrix',
        name: 'MealMatrix',
        component: () => import('@/views/meal/matrix.vue'),
      },
      { path: 'meal/edit', name: 'MealEdit', component: () => import('@/views/meal/edit.vue') },
      {
        path: 'meal/template',
        name: 'MealTemplate',
        component: () => import('@/views/meal/template.vue'),
      },

      // 订单中心 M32 · P30–P31
      { path: 'order/list', name: 'OrderList', component: () => import('@/views/order/list.vue') },
      {
        path: 'order/detail',
        name: 'OrderDetail',
        component: () => import('@/views/order/detail.vue'),
      },

      // 团长管理 M33 · P32
      {
        path: 'leader/list',
        name: 'LeaderList',
        component: () => import('@/views/leader/list.vue'),
      },
      {
        path: 'leader/apply',
        name: 'LeaderApply',
        component: () => import('@/views/leader/apply.vue'),
      },
      {
        path: 'leader/detail',
        name: 'LeaderDetail',
        component: () => import('@/views/leader/detail.vue'),
      },

      // ───────────────────────── 供应商相关（⚠️ 两角色共用本 SPA，路径必须分家） ─────────────────────────
      //
      // 平台端（role=admin/operator，P33 供应商管理 · M34）：list / form / dish-library /
      //   distribution-center / packing-center / takeout-links —— 组件调 `/admin/*`。
      // 商家端（role=supplier，P23/P24/P26 · M22/M24）：dishes / edit —— 将来组件调 `/supplier/*`。
      //
      // ⚠️ 为什么必须分开：`/supplier/dishes`、`/supplier/edit` 两个 key 同时在
      //    `admin-role.ts` 的 `ADMIN_MENU_KEYS` 与 `SUPPLIER_MENU_KEYS` 里（脚手架遗留）。
      //    若平台页占住这两个 path，商家点「我的菜品」会进入一个调 `/admin/dishes` 的页面，
      //    拿 10003（`JwtAuthGuard` 按 `typ` 拒绝）——页面直接坏掉。
      //    故平台端新增页一律另起非冲突 path；商家端两个 path 保留给 P23/P24/P26。

      // 平台端 P33
      {
        path: 'supplier/list',
        name: 'SupplierList',
        component: () => import('@/views/supplier/list.vue'),
      },
      {
        path: 'supplier/form',
        name: 'SupplierForm',
        component: () => import('@/views/supplier/form.vue'),
      },
      {
        path: 'supplier/dish-library',
        name: 'SupplierDishLibrary',
        component: () => import('@/views/supplier/dish-library.vue'),
      },
      {
        path: 'supplier/distribution-center',
        name: 'DistributionCenter',
        component: () => import('@/views/supplier/distribution-center.vue'),
      },
      {
        path: 'supplier/packing-center',
        name: 'PackingCenter',
        component: () => import('@/views/supplier/packing-center.vue'),
      },
      {
        path: 'supplier/takeout-links',
        name: 'TakeoutLinks',
        component: () => import('@/views/supplier/takeout-links.vue'),
      },

      // 商家端 P21 / P22（M3-8 实装 · 出餐链路 S1–S2）—— 组件调 `/supplier/*`
      //
      // ⚠️ M4-0：原 `supplier/packing`（S3 打包任务）**已下线** —— 打包闸门要看到
      //    **所有**供应商的到位情况，开给供应商就是泄露他方数据（I1）；
      //    且自营下加工场所属 ABox 自有，原判据「本主体名下有集散中心」也已失效。
      //    新落点 = 上面的 `supplier/packing-center`（运营后台，调 `/admin/packing-tasks`）。
      {
        path: 'supplier/workbench',
        name: 'SupplierWorkbench',
        component: () => import('@/views/supplier/workbench.vue'),
      },
      {
        path: 'supplier/cook-confirm',
        name: 'SupplierCookConfirm',
        component: () => import('@/views/supplier/cook-confirm.vue'),
      },
      // 商家端 P25（M3-9 实装 · 应付结算自查 S4）—— 组件调 `/supplier/settlement`
      {
        path: 'supplier/settlement',
        name: 'SupplierSettlement',
        component: () => import('@/views/supplier/settlement.vue'),
      },

      // 商家端 P23 / P24 / P26（占位 · 待后续批次实装）
      {
        path: 'supplier/edit',
        name: 'SupplierEdit',
        component: () => import('@/views/supplier/edit.vue'),
      },
      {
        path: 'supplier/dishes',
        name: 'SupplierDishes',
        component: () => import('@/views/supplier/dishes.vue'),
      },

      // 办公楼管理 M33 · P37（5 视图）
      {
        path: 'building/overview',
        name: 'BuildingOverview',
        component: () => import('@/views/building/overview.vue'),
      },
      {
        path: 'building/list',
        name: 'BuildingList',
        component: () => import('@/views/building/list.vue'),
      },
      {
        path: 'building/groups',
        name: 'BuildingGroups',
        component: () => import('@/views/building/groups.vue'),
      },
      {
        path: 'building/leader-binding',
        name: 'BuildingLeaderBinding',
        component: () => import('@/views/building/leader-binding.vue'),
      },
      {
        path: 'building/delivery-map',
        name: 'BuildingDeliveryMap',
        component: () => import('@/views/building/delivery-map.vue'),
      },

      // 财务结算 M35 · P34
      {
        path: 'finance/overview',
        name: 'FinanceOverview',
        component: () => import('@/views/finance/overview.vue'),
      },
      {
        path: 'finance/commission',
        name: 'FinanceCommission',
        component: () => import('@/views/finance/commission.vue'),
      },
      {
        path: 'finance/balance',
        name: 'FinanceBalance',
        component: () => import('@/views/finance/balance.vue'),
      },
      {
        path: 'finance/supplier-share',
        name: 'FinanceSupplierShare',
        component: () => import('@/views/finance/supplier-share.vue'),
      },
      {
        path: 'finance/refund',
        name: 'FinanceRefund',
        component: () => import('@/views/finance/refund.vue'),
      },
      {
        path: 'finance/reconciliation',
        name: 'FinanceReconciliation',
        component: () => import('@/views/finance/reconciliation.vue'),
      },
      {
        path: 'finance/invoices',
        name: 'FinanceInvoices',
        component: () => import('@/views/finance/invoices.vue'),
      },

      // 数据统计 M36 · P35
      {
        path: 'stats/core-metrics',
        name: 'StatsCoreMetrics',
        component: () => import('@/views/stats/core-metrics.vue'),
      },
      {
        path: 'stats/building-rank',
        name: 'StatsBuildingRank',
        component: () => import('@/views/stats/building-rank.vue'),
      },
      {
        path: 'stats/dish-heat',
        name: 'StatsDishHeat',
        component: () => import('@/views/stats/dish-heat.vue'),
      },
      {
        path: 'stats/retention',
        name: 'StatsRetention',
        component: () => import('@/views/stats/retention.vue'),
      },

      // 系统管理 M37 · P36
      {
        path: 'system/config',
        name: 'SystemConfig',
        component: () => import('@/views/system/config.vue'),
      },
      {
        path: 'system/admin-user',
        name: 'SystemAdminUser',
        component: () => import('@/views/system/admin-user.vue'),
      },
      {
        path: 'system/role',
        name: 'SystemRole',
        component: () => import('@/views/system/role.vue'),
      },
      {
        path: 'system/operation-log',
        name: 'SystemOperationLog',
        component: () => import('@/views/system/operation-log.vue'),
      },
      {
        path: 'system/message-template',
        name: 'SystemMessageTemplate',
        component: () => import('@/views/system/message-template.vue'),
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
];

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

      // 供应商管理 M34 · P33
      {
        path: 'supplier/list',
        name: 'SupplierList',
        component: () => import('@/views/supplier/list.vue'),
      },
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
      {
        path: 'supplier/distribution-center',
        name: 'DistributionCenter',
        component: () => import('@/views/supplier/distribution-center.vue'),
      },
      {
        path: 'supplier/takeout-links',
        name: 'TakeoutLinks',
        component: () => import('@/views/supplier/takeout-links.vue'),
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

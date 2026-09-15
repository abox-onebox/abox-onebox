/** 后台侧常量（与小程序端同源，权威值见 docs/） */
export const UNIT_PRICE = 25.8;

export const COMMISSION_RATE = {
  trainee: 0.08,
  regular: 0.09,
  gold: 0.1,
  chief: 0.12,
} as const;

export const SETTLEMENT = {
  supplierTotal: 14.0,
  distributionCenter: 5.0,
  rice: 2.0,
  packing: 3.0,
  platformGrossProfit: 3.7,
} as const;

/** 后台导航（运营 role=admin） */
export const ADMIN_NAV = [
  { group: '套餐', items: [
    { path: '/meal/matrix', title: '套餐矩阵', page: 'P27', module: 'M31-01' },
    { path: '/meal/edit', title: '新建套餐', page: 'P28', module: 'M31-02/03' },
    { path: '/meal/template', title: '套餐模板', page: 'P29', module: 'M31-04' },
  ] },
  { group: '订单', items: [
    { path: '/order/list', title: '订单中心', page: 'P30', module: 'M32-01/02/06' },
    { path: '/order/detail', title: '订单详情', page: 'P31', module: 'M32-03/04/05' },
  ] },
  { group: '业务', items: [
    { path: '/leader/list', title: '团长管理', page: 'P32', module: 'M33-03/04/05' },
    { path: '/supplier/list', title: '供应商管理', page: 'P33', module: 'M34' },
    { path: '/building/overview', title: '办公楼管理', page: 'P37', module: 'M33-01/02' },
    { path: '/finance/overview', title: '财务结算', page: 'P34', module: 'M35' },
    { path: '/stats/core-metrics', title: '数据看板', page: 'P35', module: 'M36' },
  ] },
  { group: '系统', items: [
    { path: '/system/config', title: '系统配置', page: 'P36', module: 'M37' },
    { path: '/system/admin-user', title: '账号管理', page: '—', module: 'M37' },
    { path: '/system/role', title: '角色权限', page: '—', module: 'M37' },
    { path: '/system/operation-log', title: '操作日志', page: '—', module: 'M37' },
  ] },
] as const;

/** 供应商导航（role=supplier · P21–P26） */
export const SUPPLIER_NAV = [
  { path: '/dashboard', title: '商家工作台', page: 'P21', module: 'M21-01' },
  { path: '/order/list', title: '出餐确认', page: 'P22', module: 'M21-02/03' },
  { path: '/supplier/dishes', title: '我的菜品', page: 'P23', module: 'M22-01' },
  { path: '/supplier/edit', title: '上架申请 / 商家资料', page: 'P24 / P26', module: 'M22-02 · M24' },
  { path: '/finance/supplier-share', title: '应付结算明细', page: 'P25', module: 'M23-01/02' },
] as const;

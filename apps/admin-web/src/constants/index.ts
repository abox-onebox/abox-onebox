/** 后台侧常量（与小程序端同源，权威值见 docs/） */
export const UNIT_PRICE = 25.8;

export const COMMISSION_RATE = {
  trainee: 0.08,
  formal: 0.09,
  gold: 0.1,
  chief: 0.12,
} as const;

/** C9 · 单份成本项「默认 / 示例值」（元）
 * ⚠️ 口径修订 2026-09-15：**成本项不写死**，按实际执行；平台毛利为**结果值**。
 *    运行期以 ab_config + 供应商采购价表为准，此处仅为默认值与兜底。
 *    等式：售价 = 供应商供价 + 集散/场地费 + 打包人工 + 配送费 + 佣金 + 平台毛利
 */
export const SETTLEMENT = {
  /** 供应商供价合计（与各供应商**逐菜协商**） */
  supplierTotal: 14.0,
  /** ABox 自有持证场所摊销（自营口径 2026-09-16：不再「复用供应商场地」；默认 0 仅表示未登记） */
  siteFee: 0.0,
  /** 打包人工（雇佣**兼职**打包） */
  packingLaborFee: 0.0,
  /** 配送费（安排**货拉拉**送货） */
  deliveryFee: 0.0,
} as const;

/** C9 · 计算单份结算明细（平台毛利为结果值） */
export function calcSettlement(
  items: Partial<typeof SETTLEMENT>,
  commissionRate: number,
  unitPrice: number = UNIT_PRICE,
) {
  const supplierTotal = items.supplierTotal ?? SETTLEMENT.supplierTotal;
  const siteFee = items.siteFee ?? SETTLEMENT.siteFee;
  const packingLaborFee = items.packingLaborFee ?? SETTLEMENT.packingLaborFee;
  const deliveryFee = items.deliveryFee ?? SETTLEMENT.deliveryFee;
  const commission = Number((unitPrice * commissionRate).toFixed(2));
  const platformGrossProfit = Number(
    (unitPrice - (supplierTotal + siteFee + packingLaborFee + deliveryFee) - commission).toFixed(2),
  );
  return {
    unitPrice,
    supplierTotal,
    siteFee,
    packingLaborFee,
    deliveryFee,
    commission,
    platformGrossProfit,
  };
}

/**
 * 后台导航（运营 role=admin / operator / finance / viewer · P27–P37）
 *
 * ⚠️ **每项的 `path` 即服务端 `account.menus[]` 里的 menu key**。
 *    新增页面必须**同时**在 `api-server/src/common/constants/admin-role.ts`
 *    的 `ADMIN_MENU_KEYS` 登记 —— 否则路由能进、菜单不显示（静默过滤掉）。
 */
export const ADMIN_NAV = [
  {
    group: '概览',
    items: [{ path: '/dashboard', title: '工作台', page: '—', module: '概览' }],
  },
  {
    group: '套餐',
    items: [
      { path: '/meal/matrix', title: '套餐矩阵', page: 'P27', module: 'M31-01' },
      { path: '/meal/edit', title: '新建套餐', page: 'P28', module: 'M31-02/03' },
      { path: '/meal/template', title: '套餐模板', page: 'P29', module: 'M31-04' },
    ],
  },
  {
    group: '订单',
    items: [
      { path: '/order/list', title: '订单中心', page: 'P30', module: 'M32-01/02/06' },
      { path: '/order/detail', title: '订单详情', page: 'P31', module: 'M32-03/04/05' },
    ],
  },
  {
    group: '业务',
    items: [
      { path: '/leader/list', title: '团长管理', page: 'P32', module: 'M33-03/04/05' },
      { path: '/supplier/list', title: '供应商管理', page: 'P33', module: 'M34' },
      { path: '/building/overview', title: '办公楼管理', page: 'P37', module: 'M33-01/02' },
      { path: '/finance/overview', title: '财务结算', page: 'P34', module: 'M35' },
      { path: '/stats/core-metrics', title: '数据看板', page: 'P35', module: 'M36' },
    ],
  },
  {
    group: '系统',
    items: [
      { path: '/system/config', title: '系统配置', page: 'P36', module: 'M37' },
      { path: '/system/admin-user', title: '账号管理', page: '—', module: 'M37' },
      { path: '/system/role', title: '角色权限', page: '—', module: 'M37' },
      { path: '/system/operation-log', title: '操作日志', page: '—', module: 'M37' },
    ],
  },
] as const;

/** 供应商导航（role=supplier · P21–P26） */
export const SUPPLIER_NAV = [
  { path: '/supplier/workbench', title: '商家工作台', page: 'P21', module: 'M21-01' },
  { path: '/supplier/cook-confirm', title: '出餐确认', page: 'P22', module: 'M21-02' },
  { path: '/supplier/packing', title: '打包任务', page: 'P22（下游）', module: 'M21-03' },
  { path: '/supplier/dishes', title: '我的菜品', page: 'P23', module: 'M22-01' },
  {
    path: '/supplier/edit',
    title: '上架申请 / 商家资料',
    page: 'P24 / P26',
    module: 'M22-02 · M24',
  },
  // ⚠️ M3-9：`/finance/supplier-share` 是**后台财务页**（调 `/admin/supplier-shares`），
  //    供应商进去只会拿 10003 —— 故供应商自己的结算页另起 `/supplier/settlement`。
  { path: '/supplier/settlement', title: '应付结算明细', page: 'P25', module: 'M23-01/02' },
  // ⚠️ 保留通用概览作为兜底落点（登录后默认路径不受菜单调整影响）。
  //    `P21/P22` 原先借用 `/dashboard`、`/order/list` 顶替，M3-8 已有真实页面，
  //    `/order/list`（订单中心）不再给供应商角色 —— 供应商不需要看全量订单。
  { path: '/dashboard', title: '概览', page: '—', module: '通用' },
] as const;

import { BIZ } from '@abox/shared-utils';

/**
 * ⭐ 锁定口径的**唯一真源** = `@abox/shared-utils` 的 `BIZ`（M5-7 收敛 · 整体审查报告 §二）
 *
 * 此前售价与佣金率在「后台 constants」与「后端 + `shared-utils`」**各写一份**：
 * 改一处漏一处，表现是「后台显示 ¥25.80、实际下单 ¥26.00」这类
 * **只在生产被发现**的错。现在直接引用真源，并**保留原导出名**（消费页面无需改动）。
 */
export const UNIT_PRICE = BIZ.unitPrice;
export const COMMISSION_RATE = BIZ.commissionRate;

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
      // M5-1：配送单管理（D61/D62）。原型无对应页，故 `page` 记 `—`；
      //   `module` 列记**接口编号**而不是原型模块号 —— 不编造一个并不存在的原型页。
      { path: '/order/delivery', title: '配送单管理', page: '—', module: 'D61/D62' },
    ],
  },
  {
    group: '业务',
    items: [
      { path: '/leader/list', title: '团长管理', page: 'P32', module: 'M33-03/04/05' },
      { path: '/supplier/list', title: '供应商管理', page: 'P33', module: 'M34' },
      // ⚠️ M4-0：打包任务从供应商端迁到运营后台（原 `GET /supplier/packing-tasks` 已下线）。
      //    闸门要看到**所有**供应商的到位情况，这份信息跨供应商，不能开给供应商端。
      //    它是**运营的日常作业页**（每天都要开包），故给一个**顶级菜单入口**，
      //    而不是像 `distribution-center` / `dish-library` 那样挂在供应商管理页里下钻。
      { path: '/supplier/packing-center', title: '加工场所打包', page: 'P39', module: 'M21-03' },
      { path: '/building/overview', title: '办公楼管理', page: 'P37', module: 'M33-01/02' },
      // ⚠️ M3-14 修复：原先财务域**只挂了 `/finance/overview` 一个入口**，其余子页
      //    （佣金 / 余额 / 应付 / 退款 / 对账）在服务端 `ADMIN_MENU_KEYS` 里**早已授权**，
      //    前端却没有任何菜单指向它们 —— 运营只能手输 URL 才能打开。
      //    「菜单与白名单同源」反过来同样成立：**授权了就必须有入口**，
      //    否则那些页面等同于不存在（本例正是新做的余额页在界面上点不到）。
      { path: '/finance/overview', title: '资金总览', page: 'P34', module: 'M35-01' },
      { path: '/finance/commission', title: '佣金结算', page: 'P34', module: 'M35-02' },
      { path: '/finance/balance', title: '余额账户', page: 'P34', module: 'M35-04' },
      { path: '/finance/supplier-share', title: '应付结算', page: 'P34 / P25', module: 'M35-03' },
      { path: '/finance/refund', title: '退款审批', page: 'P34', module: 'M35-05' },
      // M4-4：提现审批（D45/D46）—— 团长侧 L12 提交后**唯一**能推进它的地方。
      //    在此之前该页不存在，提现单永远停在 pending、冻结额只增不减。
      { path: '/finance/withdrawal', title: '提现审批', page: 'P34', module: 'M35-08' },
      { path: '/finance/reconciliation', title: '微信对账', page: 'P34', module: 'M35-06' },
      // M3-15：发票管理（进项票台账）—— 与 `admin-role.ts` 的 `ADMIN_MENU_KEYS` 同源
      { path: '/finance/invoices', title: '发票管理', page: 'P34', module: 'M35-07' },
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
      // ⚠️ M5-12 补登：`/system/message-template` 自 M3-12 就已在服务端
      //    `ADMIN_MENU_KEYS` 里授权、路由也早就存在，**却从来没进过本表** ——
      //    于是通知模板页「能进、但侧边栏点不到」，只能手输 URL（M3-14 修过
      //    `/finance/*` 五页的同一个毛病，这次是系统组）。判据同来源：
      //    **授权了就必须有入口**，否则等价于那些页面不存在。
      { path: '/system/message-template', title: '通知模板', page: '—', module: 'D59/D60' },
      // M5-12：跑批时刻表（D64/D65）—— 8 个定时任务的时刻 / 目标日期 / 实装状态 + 手动补跑
      { path: '/system/schedule', title: '跑批时刻表', page: '—', module: 'D64/D65' },
    ],
  },
] as const;

/** 供应商导航（role=supplier · P21–P26） */
export const SUPPLIER_NAV = [
  { path: '/supplier/workbench', title: '商家工作台', page: 'P21', module: 'M21-01' },
  { path: '/supplier/cook-confirm', title: '出餐确认', page: 'P22', module: 'M21-02' },
  // ⚠️ M4-0：原 `/supplier/packing`（P22 下游「打包任务」）**已从供应商端下线**。
  //    打包闸门必须看到**所有**供应商的到位情况 —— 开给供应商就是泄露他方经营数据（I1）；
  //    且自营下加工场所属 ABox 自有，原判据「本主体名下有没有启用中集散中心」本身也已失效
  //    （端点整体迁运营后台 `/admin/packing-tasks` · 菜单 `/supplier/packing-center`）。
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

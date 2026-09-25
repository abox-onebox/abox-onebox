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
 *
 * ## 分组的唯一依据 = 模块域（M5-16 重整 · 6 组 → 8 组）
 *
 * 此前是 6 组，其中「业务」一组塞了 **17 项**、横跨三个互不相干的域
 * （团长·楼宇 6 / 供应商·出餐 3 / 财务 8）—— 等于**没归类**：
 * 一个 17 项的平铺列表里，找「退款审批」和找「楼栋映射」的难度是一样的。
 * 现按《PRD v2.1》的模块号切开：
 *
 * | 组 | 模块域 | 项数 |
 * | --- | --- | --- |
 * | 概览 | 登录落点（工作台） | 1 |
 * | 套餐 | M31 | 3 |
 * | 订单 | M32 | 3 |
 * | 团长与楼宇 | M33 | 6 |
 * | 供应商与出餐 | M34 | 3 |
 * | 财务 | M35 | 8 |
 * | 数据 | M36 | 4 |
 * | 系统 | M37 | 6 |
 *
 * 刻意**不折叠**（保持平铺 + 组标题）：一期后台总共 34 个入口，
 * 运营要的是「一眼扫完今天该开哪几页」；8 个折叠面板会把这件事
 * 变成 8 次点击 + 记住每个面板里装了什么。
 *
 * ⚠️ 本次只动 `group` 字段，**path 一个字都不能改** —— path 是服务端 menu key，
 *    `scripts/check-nav-consistency.mjs` 会双向对账（改 path 会让该页对所有人消失）。
 * ⚠️ 组顺序 = 侧边栏顺序，且 **`permission.landingPath` 取「第一组第一项」**
 *    ⇒ `概览` / `/dashboard` 必须留在最前。
 *
 * ## `icon` 字段（S7-1 补 · 39 个唯一入口全覆盖）
 *
 * **为什么是必修项**：本表此前**没有任何 `icon` 字段**，后台是全文字侧边栏 ——
 * 34 个入口 / 8 个分组平铺在 216px 的窄栏里，找一页只能逐行读标题。
 * 图标提供的是**形状记忆**（同一页第二次找时认形状而不是读字）。
 *
 * **取值纪律**（机械门禁 = `scripts/check-nav-consistency.mjs` 第 ⑥ 条）：
 * - 必填，且必须是 `@abox/shared-utils` 的 `ABOX_ICON_NAMES`（82 名 Tabler 子集）之一；
 * - 写错名字**不会报错**，只是图标位置空白 —— 所以只能靠门禁拦，不能靠肉眼；
 * - 同组内尽量不复用（视觉区分度），跨组复用是允许的（如 `users` 在团长与系统各组各一次）。
 *
 * ⚠️ 图标是**功能性图形**（尺寸三档 16/20/24），不是装饰 —— 侧边栏固定取 16px 行内档。
 */
export const ADMIN_NAV = [
  {
    group: '概览',
    // ⚠️ M5-15：`/dashboard` 是**所有角色的登录落点**（根路由与 404 兜底都指向它，
    //    `permission.landingPath` 取的就是本组第一项），而它此前是一个**脚手架占位页** ——
    //    于是任何人登录后的第一屏都是空白页（人工测试里「后台缺某某模块」的印象，
    //    有一部分就来自"第一屏没东西"）。
    // ⚠️ M5-16 收口：它现在是**真工作台** —— 顶部 4 张待办卡（退款待审 / 提现待审 /
    //    明日未排套餐的楼群 / 今日逾期未送达，数据来自 D66 `GET /admin/dashboard/todos`），
    //    下面是按本表分组渲染的入口目录。故标题从 M5-15 的「运营概览」**改回「工作台」**：
    //    当时改名是因为它没有待办、叫工作台会让人以为那儿有活可干；
    //    现在那儿确实有活可干，叫回原名才是诚实的。
    //    数字看板仍在 `/stats/core-metrics`（本页只给待办数字，不给 GMV 趋势）。
    items: [{ path: '/dashboard', title: '工作台', page: '—', module: 'D66', icon: 'dashboard' }],
  },
  {
    group: '套餐',
    items: [
      { path: '/meal/matrix', title: '套餐矩阵', page: 'P27', module: 'M31-01', icon: 'layout' },
      { path: '/meal/edit', title: '新建套餐', page: 'P28', module: 'M31-02/03', icon: 'plus' },
      {
        path: '/meal/template',
        title: '套餐模板',
        page: 'P29',
        module: 'M31-04',
        icon: 'template',
      },
    ],
  },
  {
    group: '订单',
    items: [
      { path: '/order/list', title: '订单中心', page: 'P30', module: 'M32-01/02/06', icon: 'list' },
      {
        path: '/order/detail',
        title: '订单详情',
        page: 'P31',
        module: 'M32-03/04/05',
        icon: 'receipt',
      },
      // M5-1：配送单管理（D61/D62）。原型无对应页，故 `page` 记 `—`；
      //   `module` 列记**接口编号**而不是原型模块号 —— 不编造一个并不存在的原型页。
      { path: '/order/delivery', title: '配送单管理', page: '—', module: 'D61/D62', icon: 'truck' },
    ],
  },
  {
    // M33 · 团长与楼宇：一侧是「人」（团长），一侧是「地」（办公楼 / 楼群 / 绑定关系）。
    //   两者同属 M33，且在运营的日常里是同一条作业链 —— 楼群定下来才知道给谁开团，
    //   故合并为一组；此前 `/leader/*` 与 `/building/*` 被硬塞进 17 项的「业务」大组里，
    //   中间还隔着供应商与财务八页。
    group: '团长与楼宇',
    items: [
      {
        path: '/leader/list',
        title: '团长管理',
        page: 'P32',
        module: 'M33-03/04/05',
        icon: 'users',
      },
      // ⚠️⚠️ M5-15 补登（**同类缺陷第三次复发**）：`/building/*` 共 5 条在服务端
      //    `ADMIN_MENU_KEYS`（`admin-role.ts:39-43`）**全部早已授权**、路由也全在
      //    （`routes.ts:158-176`）、后端新建/编辑接口也全实现（`POST admin/buildings`
      //    · `assertBuildingNameFree` 重名校验），**而前端此前只挂了 `/building/overview`
      //    一条** —— 于是「新建办公楼」按钮所在的 `/building/list`
      //    （`views/building/list.vue:118-119`）**从菜单点不到，只能手输 URL**，
      //    人工测试中表现为「后台缺少办公楼建立模块」。
      //    同族历史：M3-14（财务五页）→ M5-12（通知模板）→ 本次（楼宇五页）。
      //    ⭐ 防复发门禁见 `scripts/check-nav-consistency.mjs`（已接入 `gate.mjs all`）。
      //    模块号取自《PRD v2.1》M33 与《项目目录结构 v2.0》「P37 · 5 视图 · M33-01/02」。
      {
        path: '/building/list',
        title: '办公楼台账',
        page: 'P37',
        module: 'M33-01',
        icon: 'building',
      },
      {
        path: '/building/groups',
        title: '楼群管理',
        page: 'P37',
        module: 'M33-02',
        icon: 'message',
      },
      {
        path: '/building/overview',
        title: '办公楼总览',
        page: 'P37',
        module: 'M33-01/02',
        icon: 'chart',
      },
      {
        path: '/building/leader-binding',
        title: '团长-楼栋绑定',
        page: 'P37',
        module: 'M33-01/02',
        icon: 'link',
      },
      {
        path: '/building/delivery-map',
        title: '楼栋-集散中心映射',
        page: 'P37',
        module: 'M33-01/02',
        icon: 'pin',
      },
    ],
  },
  {
    // M34 · 供应商与出餐：三页是**上游到出餐**的一条链 ——
    //   供应商台账 → 菜品库（菜品是套餐的上游）→ 加工场所打包（出餐当天的作业页）。
    group: '供应商与出餐',
    items: [
      { path: '/supplier/list', title: '供应商管理', page: 'P33', module: 'M34', icon: 'store' },
      // ⚠️ M5-15 补登：`/supplier/dish-library`（平台端菜品库）自 M3-x 就已在服务端
      //    `ADMIN_MENU_KEYS` 里授权、路由也在（`routes.ts:96`）、后端 CRUD 也齐
      //    （`POST/PUT /admin/dishes` + `batch-status`），**却从来没进过本表** ——
      //    原先只能从「供应商管理 → 菜品库」按钮下钻（`supplier/list.vue:487`）。
      //    但菜品是**套餐 → 模板 → 分配**的上游：找不到入口 = 后面三层都进不去，
      //    人工测试中表现为「后台缺少餐品创建模块」。判据仍是那句：
      //    **授权了就必须有入口**，否则等价于那些页面不存在。
      { path: '/supplier/dish-library', title: '菜品库', page: 'P33', module: 'M34', icon: 'menu' },
      // ⚠️ M4-0：打包任务从供应商端迁到运营后台（原 `GET /supplier/packing-tasks` 已下线）。
      //    闸门要看到**所有**供应商的到位情况，这份信息跨供应商，不能开给供应商端。
      //    它是**运营的日常作业页**（每天都要开包），故给一个**顶级菜单入口**。
      {
        path: '/supplier/packing-center',
        title: '加工场所打包',
        page: 'P39',
        module: 'M21-03',
        icon: 'package',
      },
    ],
  },
  {
    // M35 · 财务：8 页。**这是本次重整最大的受益者** ——
    //   此前 8 页财务页被压在「业务」大组的**最后**（第 10–17 项），
    //   而财务（`finance` 角色）的日常作业恰恰全在这里（导出提现清单 → 提交平台 → 登记回执）。
    //   但注意：M3-14 补的是「入口」，本次补的是「**找得到**」—— 入口存在≠能被找到，
    //   17 项平铺里第 10 项的位置，就是"压在下面没人翻"。
    // ⚠️ M3-14 修复：原先财务域**只挂了 `/finance/overview` 一个入口**，其余子页
    //    （佣金 / 余额 / 应付 / 退款 / 对账）在服务端 `ADMIN_MENU_KEYS` 里**早已授权**，
    //    前端却没有任何菜单指向它们 —— 运营只能手输 URL 才能打开。
    //    「菜单与白名单同源」反过来同样成立：**授权了就必须有入口**，
    //    否则那些页面等同于不存在（本例正是新做的余额页在界面上点不到）。
    group: '财务',
    items: [
      {
        path: '/finance/overview',
        title: '资金总览',
        page: 'P34',
        module: 'M35-01',
        icon: 'wallet',
      },
      {
        path: '/finance/commission',
        title: '佣金结算',
        page: 'P34',
        module: 'M35-02',
        icon: 'coins',
      },
      { path: '/finance/balance', title: '余额账户', page: 'P34', module: 'M35-04', icon: 'cash' },
      {
        path: '/finance/supplier-share',
        title: '应付结算',
        page: 'P34 / P25',
        module: 'M35-03',
        icon: 'split',
      },
      { path: '/finance/refund', title: '退款审批', page: 'P34', module: 'M35-05', icon: 'refund' },
      // M4-4：提现审批（D45/D46）—— 团长侧 L12 提交后**唯一**能推进它的地方。
      //    在此之前该页不存在，提现单永远停在 pending、冻结额只增不减。
      {
        path: '/finance/withdrawal',
        title: '提现审批',
        page: 'P34',
        module: 'M35-08',
        icon: 'withdraw',
      },
      {
        path: '/finance/reconciliation',
        title: '微信对账',
        page: 'P34',
        module: 'M35-06',
        icon: 'checklist',
      },
      // M3-15：发票管理（进项票台账）—— 与 `admin-role.ts` 的 `ADMIN_MENU_KEYS` 同源
      {
        path: '/finance/invoices',
        title: '发票管理',
        page: 'P34',
        module: 'M35-07',
        icon: 'invoice',
      },
    ],
  },
  {
    // ⚠️ M5-15 修复（**方向①：授权了但没有入口**）：P35 数据看板共**四页** ——
    //    `/stats/core-metrics`（M36-01）· `/stats/building-rank`（M36-02）·
    //    `/stats/dish-heat`（M36-03）· `/stats/retention`（M36-04）。
    //    四页自 M3 起就**全部**在服务端 `ADMIN_MENU_KEYS` 里授权、路由也全在
    //    （`routes.ts:225-242`）、视图文件也全在，**而本表只挂了 `core-metrics` 一条** ——
    //    另三页对 admin / operator / finance / viewer 四个角色都是
    //    「路由能进、侧边栏点不到」（`finance` / `viewer` 的菜单矩阵里甚至都明文列了它们，
    //    见 `admin-role.ts:133-136` / `:141-144`）⇒ 人工测试表现为「看板里少了几页」。
    //    借本次修复把 P35 四页收拢成**独立分组**，不再寄生在「业务」大组尾部。
    //    ⭐ 防复发门禁：`scripts/check-nav-consistency.mjs`（已接入 `gate.mjs all`）。
    group: '数据',
    items: [
      {
        path: '/stats/core-metrics',
        title: '数据看板',
        page: 'P35',
        module: 'M36-01',
        icon: 'chart',
      },
      {
        path: '/stats/building-rank',
        title: '楼宇排行',
        page: 'P35',
        module: 'M36-02',
        icon: 'medal',
      },
      // P1-U2：本页第二个 Tab「口味评价」= D69 口味红黑榜（同页双视角：热度=卖得多，口味=评价好）
      {
        path: '/stats/dish-heat',
        title: '菜品热度',
        page: 'P35',
        module: 'M36-03 · D69',
        icon: 'flame',
      },
      {
        path: '/stats/retention',
        title: '留存分析',
        page: 'P35',
        module: 'M36-04',
        icon: 'history',
      },
    ],
  },
  {
    group: '系统',
    items: [
      { path: '/system/config', title: '系统配置', page: 'P36', module: 'M37', icon: 'gear' },
      { path: '/system/admin-user', title: '账号管理', page: '—', module: 'M37', icon: 'users' },
      { path: '/system/role', title: '角色权限', page: '—', module: 'M37', icon: 'shield' },
      {
        path: '/system/operation-log',
        title: '操作日志',
        page: '—',
        module: 'M37',
        icon: 'history',
      },
      // ⚠️ M5-12 补登：`/system/message-template` 自 M3-12 就已在服务端
      //    `ADMIN_MENU_KEYS` 里授权、路由也早就存在，**却从来没进过本表** ——
      //    于是通知模板页「能进、但侧边栏点不到」，只能手输 URL（M3-14 修过
      //    `/finance/*` 五页的同一个毛病，这次是系统组）。判据同来源：
      //    **授权了就必须有入口**，否则等价于那些页面不存在。
      {
        path: '/system/message-template',
        title: '通知模板',
        page: '—',
        module: 'D59/D60 · D67/D68',
        icon: 'send',
      },
      // M5-12：跑批时刻表（D64/D65）—— 8 个定时任务的时刻 / 目标日期 / 实装状态 + 手动补跑
      {
        path: '/system/schedule',
        title: '跑批时刻表',
        page: '—',
        module: 'D64/D65',
        icon: 'clock',
      },
    ],
  },
] as const;

/**
 * 供应商导航（role=supplier · P21–P26）
 *
 * ⚠️ 与 `ADMIN_NAV` 共用同一套 `icon` 取值纪律（82 名 Tabler 子集，必填、门禁校验）。
 *    `/dashboard` 在本表与 `ADMIN_NAV` 概览组各出现一次（供应商的登录落点也是它），
 *    两处 `icon` 都是 `dashboard`。
 */
export const SUPPLIER_NAV = [
  { path: '/supplier/workbench', title: '商家工作台', page: 'P21', module: 'M21-01', icon: 'home' },
  {
    path: '/supplier/cook-confirm',
    title: '出餐确认',
    page: 'P22',
    module: 'M21-02',
    icon: 'cook',
  },
  // ⚠️ M4-0：原 `/supplier/packing`（P22 下游「打包任务」）**已从供应商端下线**。
  //    打包闸门必须看到**所有**供应商的到位情况 —— 开给供应商就是泄露他方经营数据（I1）；
  //    且自营下加工场所属 ABox 自有，原判据「本主体名下有没有启用中集散中心」本身也已失效
  //    （端点整体迁运营后台 `/admin/packing-tasks` · 菜单 `/supplier/packing-center`）。
  { path: '/supplier/dishes', title: '我的菜品', page: 'P23', module: 'M22-01', icon: 'soup' },
  {
    path: '/supplier/edit',
    title: '上架申请 / 商家资料',
    page: 'P24 / P26',
    module: 'M22-02 · M24',
    icon: 'edit',
  },
  // ⚠️ M3-9：`/finance/supplier-share` 是**后台财务页**（调 `/admin/supplier-shares`），
  //    供应商进去只会拿 10003 —— 故供应商自己的结算页另起 `/supplier/settlement`。
  {
    path: '/supplier/settlement',
    title: '应付结算明细',
    page: 'P25',
    module: 'M23-01/02',
    icon: 'receipt',
  },
  // ⚠️ 保留通用概览作为兜底落点（登录后默认路径不受菜单调整影响）。
  //    `P21/P22` 原先借用 `/dashboard`、`/order/list` 顶替，M3-8 已有真实页面，
  //    `/order/list`（订单中心）不再给供应商角色 —— 供应商不需要看全量订单。
  { path: '/dashboard', title: '概览', page: '—', module: '通用', icon: 'dashboard' },
] as const;

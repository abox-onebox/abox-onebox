#!/usr/bin/env node
/**
 * 门禁：后台菜单「授权 ↔ 入口」一致性（M5-15 · 防复发）
 *
 * ## 为什么必须有这条门禁
 *
 * 后台侧边栏 = `ADMIN_NAV ∩ account.menus[]`
 * （`apps/admin-web/src/stores/permission.ts:45` → `utils/permission.ts` 的
 *  `menus.includes('*') || menus.includes(item.path)`）。
 * 于是存在两个**静默**失效方向，两边都**不报错、不红、日志里什么都没有**：
 *
 *   ① **授权了但没有入口** —— 服务端 `ADMIN_MENU_KEYS` 里有 key、路由也在
 *      （`router/routes.ts`）、后端接口也实现，**而 `ADMIN_NAV` 从不列它**
 *      ⇒ 侧边栏永远不出现该项 ⇒ 只能手输 URL ⇒ 人工测试表现为「**缺某个模块**」。
 *   ② **有入口但没有授权** —— `ADMIN_NAV` 列了、服务端白名单没有
 *      ⇒ 该项**对任何角色都不显示**（super_admin 的 `*` 也救不了，因为 `ADMIN_NAV`
 *        本身才是渲染源）⇒ 死条目，谁点了都进不去。
 *
 * ## 它已经复发过三次（这才是加门禁的理由）
 *
 * | 批次 | 被漏掉的页面 |
 * |---|---|
 * | M3-14 | 财务域五页（佣金/余额/应付/退款/对账）—— 已修，并把教训写进 `constants/index.ts` 注释 |
 * | M5-12 | `/system/message-template`（通知模板）—— 系统组的同一个毛病 |
 * | M5-15 | `/building/*` 四页 + 平台端菜品库 —— **人工测试当场发现**：「缺办公楼建立模块」「缺餐品创建模块」 |
 *
 * ⭐ **M5-15 收口时本门禁首次运行即抓出 5 处历史遗留**（这就是"恒绿的检查"之外的另一种价值：
 *    新写的检查一旦跑在不干净的历史数据上，会立刻把**旧债**也一并照亮）：
 *      · `[授权无入口] × 4` —— `/leader/apply`（下钻，已豁免）、`/stats/building-rank`
 *        · `/stats/dish-heat` · `/stats/retention`（三页已补进 `ADMIN_NAV` 的「数据」组）
 *      · `[入口未授权] × 1` —— `/supplier/packing-center` **死条目**：前端有顶级入口、
 *        后端有控制器、本文件 `admin-role.ts:96` 的注释甚至**早已把它写作菜单 key**，
 *        而数组里就是没有 ⇒ 该页对任何角色都不显示（已补进 `ADMIN_MENU_KEYS`）。
 *
 * 三次都是同一形状：**同一件事有两份表述（服务端授权清单 / 前端导航清单），
 * 而没有任何自动化在比对它们**。（同族教训见 `schema:parity` / `index:parity` /
 * `state:audit` —— 项目里凡是「两份表述」的地方，不被执行的那份必然会错。）
 *
 * ## 判据
 *
 * 双向全等，**允许显式豁免**，且豁免必须自带机械证据（防「白名单腐烂」）：
 *
 *   ① `ADMIN_MENU_KEYS` 每条 → 必须在 `ADMIN_NAV`，或在豁免表里；
 *   ② `ADMIN_NAV` 每条 → 必须在 `ADMIN_MENU_KEYS`（否则是死条目）；
 *   ③ 豁免表**不允许过期**：某条已进 `ADMIN_NAV` ⇒ 要求从豁免表删除（自收紧）；
 *   ④ 豁免分两类，各自要有**可机械验证**的理由：
 *      - `drilldown`（刻意下钻）：必须真被 `via` 指名的那个页面文件引用到；
 *      - `legacy-duplicate`（脚手架遗留）：该 key **必须**同时存在于另一侧的角色菜单里
 *        （证明它确实是"别人家的页面"，而不是随手豁免）；
 *   ⑤ 供应商侧（`SUPPLIER_MENU_KEYS` ↔ `SUPPLIER_NAV`）同样双向对账。
 *   ⑥ 图标同源校验（S7-1）：每条必带 `icon`，且必须落在 `ABOX_ICON_NAMES` 内。
 *   ⑦ ⭐ **路由 → 必须已被登记**（P1-12 · 2026-10-08 全面复查补的方向）：
 *      `apps/admin-web/src/router/routes.ts` 里**每一个** path 都必须落在
 *      「授权清单 ∪ 导航清单 ∪ 显式豁免」里。
 *
 *      ## 为什么必须有 ⑦（前六条**结构上**测不到它）
 *
 *      后台一张页面要能被用上，需要**三处登记**同时成立：
 *        (a) 服务端 `ADMIN_MENU_KEYS` 授权 ⇒ 守卫放行（`router/guards.ts`）
 *        (b) 前端 `ADMIN_NAV` 有入口 ⇒ 侧边栏看得见
 *        (c) 前端 `router/routes.ts` 有路由 ⇒ 有组件可渲染
 *      ①②⑤ 只比对了 (a)↔(b)，**(c) 从来没人比过** —— 于是「路由里有、授权里没有」
 *      这一整类是**结构性盲区**：门禁全绿，而除 super_admin（持有 `*`）外的角色
 *      点了就跳 `/403?from=`。实例见 `/leader/detail` 的豁免条目。
 *
 *      ## 口径（刻意不猜"哪些算业务页"）
 *
 *      不对 path 做「像不像业务页」的启发式判断 —— 那正是会腐烂的第二份表述。
 *      改为：**routes.ts 里出现的每一个 path 都必须被解释**，解释方式三种之一：
 *        1. 在 `ADMIN_MENU_KEYS` / `SUPPLIER_MENU_KEYS`（授权）
 *        2. 在 `ADMIN_NAV` / `SUPPLIER_NAV`（入口）
 *        3. 在豁免表里（含 `kind: 'non-page'` —— 登录/兜底/父级/catchall 这类
 *           **不是页面**、本就不该进菜单语义的路径）
 *      于是"差集"这个概念被反过来用：**差集里的每一条都必须自带理由**，
 *      而不是"允许有例外"。新增任何一条未被解释的路由 ⇒ 当天就红。
 *
 * ## 自证（每次运行都做）
 *
 * 人为制造 12 种缺口 —— 幽灵授权 key / 幽灵导航项 / 过期豁免 / 腐烂豁免 /
 * 豁免理由不成立 / 图标缺失 / 图标悬空 / 图标集读空 / 导航读空 /
 * **幽灵路由** / **路由读空** / **non-page 豁免腐烂** —— **每一种都必须被报出**；
 * 报不出即门禁失败。
 * 另有两条**解析层**断言（归一化相对/绝对路径、真实路由必须抽得到），
 * 防止"判据还在、解析器已经失效"这种静默失效。
 * （理由同 `schema:parity`：**恒绿的检查比没有检查更糟**。）
 *
 * 用法：`node scripts/check-nav-consistency.mjs`
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROLE_FILE = join(ROOT, 'apps/api-server/src/common/constants/admin-role.ts');
const NAV_FILE = join(ROOT, 'apps/admin-web/src/constants/index.ts');
/** 图标名真源（S7-1 起菜单每条必带 icon，取值必须落在这一集内） */
const ICON_FILE = join(ROOT, 'packages/shared-utils/src/icons.ts');
const ADMIN_SRC = join(ROOT, 'apps/admin-web/src');
/**
 * 第三处登记源（P1-12 补）：前端路由表
 *
 * ⚠️ 它**直到 2026-10-08 才被本门禁读取** —— 在此之前「路由有、授权无」这一整类
 *    缺陷在结构上就是盲区（详见头注判据 ⑦）。
 */
const ROUTES_FILE = join(ROOT, 'apps/admin-web/src/router/routes.ts');

/**
 * 运营侧豁免表 —— **每一行都要能回答「为什么它不在侧边栏，却不算缺陷」**
 *
 * ⚠️ 加豁免前先问：能不能直接补进 `ADMIN_NAV`？能补就别豁免
 *    （M5-15 的 building 四页与菜品库就是这么处理的）。
 *
 * ⚠️ 本表自 P1-12 起**同时承担判据 ⑦（路由侧）的解释职责**：一条路由只要在本表
 *    里，就算"已被解释"。为此新增一类 `kind: 'non-page'` —— 专供
 *    `/login`、`/403`、父级 `/`、catchall 这类**根本不是页面**的路径。
 *    ⚠️ 为什么不为它们另开一张表：另开一张 = 同一件事两份表述，而本项目的
 *    头号病根正是这个。放进同一张表，它们就能被既有的「豁免无据 / 豁免腐烂」
 *    两条自收紧判据管住（`non-page` 只豁免③的"必须在授权清单里"这一条，
 *    但仍必须证明自己**真的存在于 routes.ts**，否则照样红）。
 */
const ADMIN_EXEMPT = [
  {
    key: '/leader/apply',
    kind: 'drilldown',
    via: 'views/leader/list.vue',
    why: '团长申请流水（M33-03 · 原型 P32）—— 由「团长管理」页的「申请流水」按钮进入（`leader/list.vue:593`）。它与 `/leader/list`（「团长管理」P32 · M33-03/04/05）同源同模块，是**观察流水**而非独立作业页，故不单列顶级菜单。',
  },
  {
    key: '/leader/detail',
    kind: 'drilldown',
    via: 'views/leader/list.vue',
    why: '团长详情（P0-3 · 2026-10-08 全面复查）—— 由「团长管理」列表每行的「详情」'
      + '按钮进入（`leader/list.vue:583`，另两处入口为 `leader/apply.vue:265` 的流水钻取'
      + '与 `leader/detail.vue:342` 的本页自跳转）。带 `?id=` 参数，是**看某一家的明细**'
      + '而非独立作业页，故不单列顶级菜单 —— 与同类 `/leader/apply` 处理方式一致。'
      + '⚠️ 该路由此前**从未被登记**：不在 `ADMIN_MENU_KEYS`、不在 `ADMIN_NAV`、也没有豁免，'
      + '而服务端 `@Roles`（`leader-admin.controller.ts:36`）本就放行 operator ⇒'
      + '除 `super_admin`（持有全量通配）外的角色点「详情」全被守卫拦到 `/403?from=`。'
      + '补 KEY 之后必须补本条豁免，才能让「授权无入口」判据不误报。',
  },
  {
    key: '/supplier/form',
    kind: 'drilldown',
    via: 'views/supplier/list.vue',
    why: '平台端 P33 新建/编辑供应商表单 —— 由「供应商管理」列表页的新建/编辑按钮进入（`supplier/list.vue:479`）。',
  },
  {
    key: '/supplier/distribution-center',
    kind: 'drilldown',
    via: 'views/supplier/list.vue',
    why: '集散中心配置（M34-05）—— 由「供应商管理」页进入（`supplier/list.vue:491`）。',
  },
  {
    key: '/supplier/takeout-links',
    kind: 'drilldown',
    via: 'views/supplier/list.vue',
    why: '第三方外卖链接配置（M5-14）—— 由「供应商管理」页**逐家**进入（`supplier/list.vue:483`），并按 supplierId 带参。',
  },
  {
    key: '/supplier/edit',
    kind: 'legacy-duplicate',
    why: '脚手架遗留（`admin-role.ts:44-46` 已注明）：这是**商家端** P24 的 key，供应商角色由 `SUPPLIER_MENU_KEYS` 提供；运营端本就**不该**有入口（运营不需要看某一家供应商的「商家资料」页）。',
  },
  {
    key: '/supplier/dishes',
    kind: 'legacy-duplicate',
    why: '脚手架遗留（同上）：**商家端** P23「我的菜品」的 key。运营端的对应页是 `/supplier/dish-library`（已补进 `ADMIN_NAV`）—— 两者刻意分家，见 `admin-role.ts:44-46`。',
  },

  // ============================================================ kind: 'non-page'
  // 以下 4 条**不是页面**，只是路由基础设施 —— 它们不进菜单、不进授权，
  // 但 `routes.ts` 里确实有这些 path 字面量，故按判据 ⑦ 的口径必须被解释。
  // ⚠️ 不解释它们，门禁首跑就会红 4 条噪声；而噪声比漏报更快把人训练成忽略告警
  //    （本项目在 `doc:tables` 的注释里已立过这条）。
  {
    key: '/login',
    kind: 'non-page',
    why: '登录页（`routes.ts:5`，`layouts/login-layout.vue`）—— 未登录时的唯一落点，'
      + '在 `router/guards.ts:11` 的 `WHITE_LIST` 里，本就不属任何角色菜单',
  },
  {
    key: '/403',
    kind: 'non-page',
    why: '无权限兜底页（`routes.ts:22`，`views/error/403.vue`）—— 守卫拦下无权路径 / '
      + '菜单为空时的落点，同样在 `router/guards.ts:11` 的 `WHITE_LIST` 里',
  },
  {
    key: '/',
    kind: 'non-page',
    why: '父级 Layout 路由（`routes.ts:10`，`layouts/default-layout.vue`）—— 只提供外壳'
      + '与 `redirect: /dashboard`，本身没有可渲染的业务页面',
  },
  {
    key: '/:pathMatch(.*)*',
    kind: 'non-page',
    why: '404 兜底（`routes.ts:306`）—— 未匹配路径统一重定向到 `/dashboard`，没有组件',
  },
];

/** 供应商侧豁免表（当前为空 —— 6 项授权 ↔ 6 项导航全等） */
const SUPPLIER_EXEMPT = [];

/** 剥掉 TS 注释 —— **必须先剥再抽取**（注释里出现的 `'/system/'` 之类会被误当成 key） */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      if (c === '\\') {
        out += c + (n ?? '');
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 取 `export const NAME = [ ... ] as const` 里的**字符串字面量**，只留以 `/` 开头的 */
function readStringKeys(src, exportName) {
  const start = src.indexOf(`export const ${exportName}`);
  if (start < 0) throw new Error(`未找到导出：${exportName}`);
  const end = src.indexOf('] as const', start);
  if (end < 0) throw new Error(`${exportName} 未找到数组结尾 "] as const"（解析口径已失效，请修门禁而不是改数据）`);
  const seg = src.slice(start, end);
  return [...seg.matchAll(/'([^']*)'/g)].map((m) => m[1]).filter((s) => s.startsWith('/'));
}

/** 取导航清单里的 `path: '/xxx'` */
function readNavPaths(src, exportName) {
  const start = src.indexOf(`export const ${exportName}`);
  if (start < 0) throw new Error(`未找到导出：${exportName}`);
  const end = src.indexOf('] as const', start);
  if (end < 0) throw new Error(`${exportName} 未找到数组结尾 "] as const"`);
  const seg = src.slice(start, end);
  return [...seg.matchAll(/path:\s*'([^']*)'/g)].map((m) => m[1]);
}

/**
 * 取导航清单里每个条目的 `{ path, icon }`（`icon` 缺失记 `null`）
 *
 * ⚠️ 对象体用 `[^{}]*?` 而不是 `.*?` —— 后者会**跨过对象边界**，把上一个条目的
 *    `path` 和下一个条目的 `icon` 配成一对（静默错配，门禁会假装通过）。
 *    `[^{}]` 是字符类、**含换行**，故单行与多行两种书写形态都能命中。
 */
function readNavItems(src, exportName) {
  const start = src.indexOf(`export const ${exportName}`);
  if (start < 0) throw new Error(`未找到导出：${exportName}`);
  const end = src.indexOf('] as const', start);
  if (end < 0) throw new Error(`${exportName} 未找到数组结尾 "] as const"`);
  const seg = src.slice(start, end);
  return [...seg.matchAll(/\{[^{}]*?path:\s*'([^']*)'[^{}]*?\}/g)].map((m) => {
    const ic = m[0].match(/icon:\s*'([^']*)'/);
    return { path: m[1], icon: ic ? ic[1] : null };
  });
}

/**
 * 相对路径 → 绝对路径（判据 ⑦ 用）
 *
 * ⚠️ 为什么必须显式做：`routes.ts` 里 Layout 的**子路由**写的是相对路径
 *    （`path: 'order/list'`），而菜单 key / 导航 path 是绝对路径（`/order/list`）。
 *    不做归一化，50 条里有 47 条会全部落进差集 —— 一眼看上去像"判据有巨量噪声"，
 *    实际是解析器自己写错了（实测教训：第一版算出 47 条假差集）。
 *    ⚠️ 反向同样要防：已经是绝对路径的（`/login`、`/`、catchall）**不能**再补一个斜杠。
 *    两侧各有自证样本，见 `SELF_CASES` 之外的 `parseSelfTest()`。
 */
function absPath(p) {
  return p.startsWith('/') ? p : `/${p}`;
}

/**
 * 取路由表里**所有** `path: 'xxx'` 并归一化成绝对路径
 *
 * ⚠️ 结尾锚 `\n];` 而不是 `] as const`（`routes.ts` 导出的是
 *    `export const routes: RouteRecordRaw[] = [...];`，没有 `as const`）。
 *    内层 `children: [...]` 的结尾是 `],`，不会命中 `\n];`。
 * ⚠️ 刻意**不**区分"业务页 / 非业务页"：按头注判据 ⑦ 的口径，
 *    路由表里出现的每一条都必须被解释，区分本身就是一份会腐烂的第二表述。
 */
function readRoutePaths(src) {
  const start = src.indexOf('export const routes');
  if (start < 0) throw new Error('未找到导出：routes');
  const end = src.indexOf('\n];', start);
  if (end < 0) {
    throw new Error('routes 未找到数组结尾 "\\n];"（解析口径已失效，请修门禁而不是改数据）');
  }
  return [...src.slice(start, end).matchAll(/path:\s*'([^']*)'/g)].map((m) => absPath(m[1]));
}

/** 取 `ABOX_ICON_NAMES = [ 'a', 'b', ... ]` 里的语义名 */
function readIconNames(src) {
  const m = src.match(/ABOX_ICON_NAMES\s*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error('未能在 shared-utils/icons.ts 里解析 ABOX_ICON_NAMES（解析口径失效，请修门禁）');
  return [...m[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]);
}

/**
 * 核心对账（抽成纯函数，便于自证时用「变异输入」再跑一遍）
 * @returns {string[]} 问题列表（空数组 = 通过）
 */
function check(input) {
  const {
    roleAdmin,
    roleSupplier,
    navAdmin,
    navSupplier,
    exemptAdmin,
    exemptSupplier,
    adminSrc,
    navItems,
    iconNames,
    routes,
  } = input;
  const problems = [];

  // ① 授权 → 必须有入口（或显式豁免）
  for (const key of roleAdmin) {
    if (navAdmin.includes(key)) continue;
    if (exemptAdmin.some((e) => e.key === key)) continue;
    problems.push(`[授权无入口] ${key} —— 服务端 ADMIN_MENU_KEYS 已授权，但 ADMIN_NAV 无此项且未豁免 ⇒ 侧边栏永远不出现，只能手输 URL`);
  }

  // ② 入口 → 必须有授权（否则是死条目）
  for (const p of navAdmin) {
    if (roleAdmin.includes(p)) continue;
    problems.push(`[入口未授权] ${p} —— ADMIN_NAV 有此项，但 ADMIN_MENU_KEYS 无 ⇒ 对任何角色都不显示（死条目）`);
  }

  // ③ 豁免不得过期（自收紧：一旦补进导航就必须删豁免）
  //    ⚠️ `non-page` 不参与本条：它们**本来就不该**进导航，也不在授权清单里
  //       （其自收紧判据在下面 ④ 里 —— 必须真的存在于 routes.ts）
  for (const e of exemptAdmin) {
    if (e.kind === 'non-page') continue;
    if (navAdmin.includes(e.key)) {
      problems.push(`[豁免过期] ${e.key} 已进 ADMIN_NAV，请从 ADMIN_EXEMPT 删除该条`);
    }
    if (!roleAdmin.includes(e.key)) {
      problems.push(`[豁免无据] ${e.key} 已不在 ADMIN_MENU_KEYS 里，豁免失去意义，请删除`);
    }
  }

  // ④ 豁免必须自带机械证据
  for (const e of exemptAdmin) {
    if (e.kind === 'non-page') {
      if (!e.why) {
        problems.push(`[豁免缺证据] ${e.key} 标为 non-page 但未给出 why`);
        continue;
      }
      // 自收紧：路由表里真有这条 path，豁免才成立；路由删了而豁免还在 = 腐烂
      if (!routes.includes(e.key)) {
        problems.push(`[豁免腐烂] ${e.key} 标为 non-page（非页面路由），但 router/routes.ts 里已无此路径 ⇒ 豁免悬空，请删除`);
      }
      continue;
    }
    if (e.kind === 'drilldown') {
      if (!e.via) {
        problems.push(`[豁免缺证据] ${e.key} 标为 drilldown 但未给出 via 文件`);
        continue;
      }
      const f = join(adminSrc, e.via);
      if (!existsSync(f)) {
        problems.push(`[豁免文件不存在] ${e.key} 的 via=${e.via} 不存在`);
        continue;
      }
      if (!readFileSync(f, 'utf8').includes(e.key)) {
        problems.push(`[豁免腐烂] ${e.via} 已不再引用 ${e.key} ⇒ 该页已无任何入口，应补进 ADMIN_NAV 或删除该页`);
      }
    } else if (e.kind === 'legacy-duplicate') {
      if (!roleSupplier.includes(e.key)) {
        problems.push(`[豁免无据] ${e.key} 标为 legacy-duplicate（"另一角色的页面"），但它并不在 SUPPLIER_MENU_KEYS 里 ⇒ 理由不成立`);
      }
    } else {
      problems.push(`[豁免类型未知] ${e.key} 的 kind=${e.kind}（只接受 drilldown / legacy-duplicate / non-page）`);
    }
  }

  // ⑤ 供应商侧同样双向对账
  for (const p of navSupplier) {
    if (!roleSupplier.includes(p)) {
      problems.push(`[供应商·入口未授权] ${p} —— SUPPLIER_NAV 有此项，但 SUPPLIER_MENU_KEYS 无 ⇒ 对供应商不显示（死条目）`);
    }
  }
  for (const key of roleSupplier) {
    if (navSupplier.includes(key)) continue;
    if (exemptSupplier.some((e) => e.key === key)) continue;
    problems.push(`[供应商·授权无入口] ${key} —— SUPPLIER_MENU_KEYS 已授权，但 SUPPLIER_NAV 无此项且未豁免`);
  }

  // ⑥ 图标同源校验（S7-1）—— 每条必带 `icon`，且必须落在图标集真源里
  //
  // 为什么必须机械校验：图标名的**错误形态是静默的** —— 字形表里没有该名字，
  // `ABOX_ICON_CODEPOINTS['typo-name']` 得到 undefined，渲染成一个空白位。
  // 不报错、不警告、构建通过、截图里只是"那块地方空着"，肉眼极易漏过。
  //
  // ⚠️ 先挡「空样本」：若解析出的条目为 0，下面的循环一次都不跑 ⇒ **恒绿**。
  //    恒绿的检查等于没有检查（实测教训），所以解析失效必须自己报出来。
  if (navItems.length === 0) {
    problems.push(
      '[解析失效] 未能从 NAV_FILE 解析出任何导航条目 ⇒ 图标校验空转（真实问题会被静默放过），请修门禁的解析口径',
    );
  }
  for (const it of navItems) {
    if (!it.icon) {
      problems.push(`[图标缺失] ${it.path} —— 导航条目没有 icon 字段 ⇒ 侧边栏该行图标位空白`);
      continue;
    }
    if (!iconNames.includes(it.icon)) {
      problems.push(
        `[图标悬空] ${it.path} 的 icon='${it.icon}' 不在 ABOX_ICON_NAMES（${iconNames.length} 名）内 ⇒ 字形不存在，渲染为空且不报错`,
      );
    }
  }

  // ⑦ 路由 → 必须已被登记（P1-12 新增方向 · 详见头注）
  //
  // ⚠️ 先挡「空样本」：解析出 0 条时下面的循环一次都不跑 ⇒ **恒绿**。
  //    恒绿的检查等于没有检查（实测教训），故解析失效必须自己报出来。
  if (routes.length === 0) {
    problems.push(
      '[解析失效] 未能从 ROUTES_FILE 解析出任何路由 path ⇒ 判据 ⑦ 空转（真实问题会被静默放过），请修门禁的解析口径',
    );
  }
  // 允许集 = 授权 ∪ 导航 ∪ 豁免（两侧角色都算）
  //   ⚠️ 为什么必须含供应商侧：routes.ts 是**同一个**路由表，
  //      `/supplier/workbench` `/cook-confirm` `/settlement` 是供应商专属页，
  //      它们只在 SUPPLIER_MENU_KEYS / SUPPLIER_NAV 里 —— 不含供应商侧就会误报 3 条。
  const allowed = new Set([
    ...roleAdmin,
    ...navAdmin,
    ...roleSupplier,
    ...navSupplier,
    ...exemptAdmin.map((e) => e.key),
    ...exemptSupplier.map((e) => e.key),
  ]);
  for (const p of routes) {
    if (allowed.has(p)) continue;
    problems.push(
      `[路由未登记] ${p} —— router/routes.ts 有此路由，但它既不在菜单授权清单、`
        + '也不在导航清单、更没有豁免 ⇒ 页面存在，却只有 super_admin（持有全量通配 `*`）'
        + '进得去，其余角色点进去会被守卫拦到 /403（三处登记缺了"授权"这一处）',
    );
  }

  return problems;
}

function loadInput() {
  const roleSrc = stripComments(readFileSync(ROLE_FILE, 'utf8'));
  const navSrc = stripComments(readFileSync(NAV_FILE, 'utf8'));
  const iconSrc = stripComments(readFileSync(ICON_FILE, 'utf8'));
  // ⚠️ routes.ts 同样要**先剥注释再抽**：注释里出现 `path: '/xxx'` 会被误当成路由
  return {
    roleAdmin: readStringKeys(roleSrc, 'ADMIN_MENU_KEYS'),
    roleSupplier: readStringKeys(roleSrc, 'SUPPLIER_MENU_KEYS'),
    navAdmin: readNavPaths(navSrc, 'ADMIN_NAV'),
    navSupplier: readNavPaths(navSrc, 'SUPPLIER_NAV'),
    exemptAdmin: ADMIN_EXEMPT,
    exemptSupplier: SUPPLIER_EXEMPT,
    adminSrc: ADMIN_SRC,
    // 图标校验覆盖两侧（供应商侧同样有侧边栏）
    navItems: [...readNavItems(navSrc, 'ADMIN_NAV'), ...readNavItems(navSrc, 'SUPPLIER_NAV')],
    iconNames: readIconNames(iconSrc),
    routes: readRoutePaths(stripComments(readFileSync(ROUTES_FILE, 'utf8'))),
  };
}

/**
 * 自证样本（判据层）—— 每一种缺口都必须被 `check()` 报出
 *
 * ⚠️ 提到模块级是为了让末尾的通过信息能报出**真实条数**：
 *    手写一个「自证 9/9」会和数组真实长度脱钩，而脱钩的数字正是
 *    "两份表述"的又一份（改了数组忘了改数字 ⇒ 报告在撒谎）。
 */
function selfCases(base) {
  return [
    {
      name: '幽灵授权 key（授权无入口）',
      input: { ...base, roleAdmin: [...base.roleAdmin, '/ghost/authorized'] },
      expect: '[授权无入口] /ghost/authorized',
    },
    {
      name: '幽灵导航项（入口未授权）',
      input: { ...base, navAdmin: [...base.navAdmin, '/ghost/nav'] },
      expect: '[入口未授权] /ghost/nav',
    },
    {
      name: '过期豁免（已进导航仍留豁免）',
      input: {
        ...base,
        exemptAdmin: [...base.exemptAdmin, { key: base.navAdmin[0], kind: 'drilldown', via: 'views/supplier/list.vue' }],
      },
      expect: '[豁免过期]',
    },
    {
      name: '腐烂豁免（via 页面不再引用）',
      input: {
        ...base,
        exemptAdmin: [...base.exemptAdmin, { key: '/supplier/ghost-drilldown', kind: 'drilldown', via: 'views/supplier/list.vue' }],
      },
      expect: '[豁免无据]',
    },
    {
      name: '豁免理由不成立（legacy-duplicate 但不在对方菜单里）',
      input: {
        ...base,
        exemptAdmin: [...base.exemptAdmin, { key: '/ghost/legacy', kind: 'legacy-duplicate' }],
      },
      expect: '[豁免无据]',
    },
    {
      name: '图标缺失（导航条目没有 icon 字段）',
      input: { ...base, navItems: [...base.navItems, { path: '/ghost/no-icon', icon: null }] },
      expect: '[图标缺失] /ghost/no-icon',
    },
    {
      name: '图标悬空（名字不在 ABOX_ICON_NAMES 内）',
      input: { ...base, navItems: [...base.navItems, { path: '/ghost/bad-icon', icon: 'not-in-the-set' }] },
      expect: '[图标悬空] /ghost/bad-icon',
    },
    {
      name: '图标集真源读空（改口径 / 解析失效）',
      input: { ...base, iconNames: [] },
      expect: '[图标悬空]',
    },
    {
      name: '导航条目读空（⇒ 图标校验空转，必须自曝）',
      input: { ...base, navItems: [] },
      expect: '[解析失效]',
    },

    // ---------------------------------------------------------- 判据 ⑦（P1-12）
    {
      name: '幽灵路由（routes 里有、授权无 —— 判据 ⑦ 要抓的主缺口）',
      input: { ...base, routes: [...base.routes, '/ghost/route'] },
      expect: '[路由未登记] /ghost/route',
    },
    {
      name: '路由读空（⇒ 判据 ⑦ 空转，必须自曝）',
      input: { ...base, routes: [] },
      expect: '[解析失效]',
    },
    {
      name: 'non-page 豁免腐烂（路由已删、豁免还在）',
      input: { ...base, routes: base.routes.filter((p) => p !== '/403') },
      expect: '[豁免腐烂] /403',
    },
  ];
}

/** 自证（判据层）：注入样本，每一种都必须被报出；干净输入必须零问题 */
function selfTest(base) {
  const cases = selfCases(base);
  const failures = [];
  for (const c of cases) {
    // 过期豁免用例里 `/supplier/ghost-drilldown` 不在授权清单 → 会先命中「豁免无据」，
    // 两种都算报出；这里只要求"目标缺口被点名"。
    const got = check(c.input);
    if (!got.some((p) => p.includes(c.expect))) {
      failures.push(`  自证失败：注入「${c.name}」后未报出 ${c.expect}（实际问题数 ${got.length}）`);
    }
  }
  // 干净输入必须**零问题**，否则门禁在"假红"上就失去了信号
  const clean = check(base);
  if (clean.length > 0) {
    failures.push(`  自证失败：干净输入下门禁仍报 ${clean.length} 处问题（真实问题会淹没在噪声里）：`);
    clean.forEach((p) => failures.push(`    · ${p}`));
  }
  return { failures, count: cases.length };
}

/**
 * 自证（解析层）—— 判据对不对，前提是**解析器没失效**
 *
 * ⚠️ 为什么必须单独做：`selfTest()` 用的是**变异输入**，它证明的是判据逻辑，
 *    证明不了「从真实文件里抽出来的东西是对的」。解析器静默失效的形态有两种，
 *    都不报错：抽到 0 条 ⇒ 恒绿；抽到错的东西 ⇒ 恒绿或恒红。
 *    故这里对**真实解析结果**下断言。
 */
function parseSelfTest(base) {
  const failures = [];

  // ① 归一化：相对 → 绝对；已经是绝对的**不能再补斜杠**（缺一侧就会静默漂移）
  const normCases = [
    ['order/list', '/order/list'],
    ['dashboard', '/dashboard'],
    ['403', '/403'],
    ['/login', '/login'],
    ['/', '/'],
    ['/:pathMatch(.*)*', '/:pathMatch(.*)*'],
  ];
  for (const [raw, want] of normCases) {
    const got = absPath(raw);
    if (got !== want) {
      failures.push(`  自证失败：absPath('${raw}') = '${got}'，期望 '${want}'`);
    }
  }

  // ② 真实路由必须抽得到 —— 绝对路径与相对路径两种写法都要命中
  const must = ['/login', '/', '/403', '/:pathMatch(.*)*', '/dashboard', '/leader/detail'];
  for (const p of must) {
    if (!base.routes.includes(p)) {
      failures.push(
        `  自证失败：routes.ts 里应能抽到 ${p}（实际 ${base.routes.length} 条）⇒ 解析口径已失效`,
      );
    }
  }

  // ③ 抽出来的必须全是绝对路径（漏归一化会表现为"几乎全是差集"的假噪声）
  const notAbs = base.routes.filter((p) => !p.startsWith('/'));
  if (notAbs.length > 0) {
    failures.push(`  自证失败：${notAbs.length} 条路由未归一化：${notAbs.slice(0, 3).join(', ')}`);
  }

  return failures;
}

const input = loadInput();

const selfResult = selfTest(input);
const selfFailures = [...selfResult.failures, ...parseSelfTest(input)];
if (selfFailures.length > 0) {
  console.error('✘ nav:consistency 自证失败 —— 门禁本身失效，先修门禁');
  selfFailures.forEach((f) => console.error(f));
  process.exit(1);
}

const problems = check(input);
if (problems.length > 0) {
  console.error(`✘ nav:consistency 发现 ${problems.length} 处「授权 ↔ 入口 ↔ 路由」不一致：`);
  problems.forEach((p) => console.error(`  · ${p}`));
  console.error(
    '\n修法：\n'
      + '  · [授权无入口] → 优先补进 ADMIN_NAV；确属刻意下钻才加豁免，并给出 via 文件\n'
      + '  · [入口未授权] → 把该 path 补进 ADMIN_MENU_KEYS\n'
      + '  · [路由未登记] → 三处登记缺了"授权"：补进 ADMIN_MENU_KEYS（或 SUPPLIER_MENU_KEYS）；'
      + '若确属下钻页，补 KEY **之后还要补一条 drilldown 豁免**，否则会被"授权无入口"判据拦下',
  );
  process.exit(1);
}

console.log(
  `✔ nav:consistency 通过：运营 ${input.roleAdmin.length} 授权 ↔ ${input.navAdmin.length} 入口` +
    `（豁免 ${ADMIN_EXEMPT.length}）· 供应商 ${input.roleSupplier.length} ↔ ${input.navSupplier.length}` +
    ` · 路由 ${input.routes.length} 条（三处登记全覆盖）` +
    ` · 图标 ${input.navItems.length} 条 / 真源 ${input.iconNames.length} 名` +
    // ⚠️ 条数取自数组真实长度，不手写「9/9」—— 手写会与数组脱钩（见 SELF_CASES 注释）
    ` · 自证 ${selfResult.count}/${selfResult.count} + 解析层 3 项`,
);

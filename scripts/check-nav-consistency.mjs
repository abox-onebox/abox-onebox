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
 *
 * ## 自证（每次运行都做）
 *
 * 人为制造 4 种缺口 —— 幽灵授权 key / 幽灵导航项 / 过期豁免 / 腐烂豁免 ——
 * **每一种都必须被报出**；报不出即门禁失败。
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
const ADMIN_SRC = join(ROOT, 'apps/admin-web/src');

/**
 * 运营侧豁免表 —— **每一行都要能回答「为什么它不在侧边栏，却不算缺陷」**
 *
 * ⚠️ 加豁免前先问：能不能直接补进 `ADMIN_NAV`？能补就别豁免
 *    （M5-15 的 building 四页与菜品库就是这么处理的）。
 */
const ADMIN_EXEMPT = [
  {
    key: '/leader/apply',
    kind: 'drilldown',
    via: 'views/leader/list.vue',
    why: '团长申请流水（M33-03 · 原型 P32）—— 由「团长管理」页的「申请流水」按钮进入（`leader/list.vue:593`）。它与 `/leader/list`（「团长管理」P32 · M33-03/04/05）同源同模块，是**观察流水**而非独立作业页，故不单列顶级菜单。',
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
 * 核心对账（抽成纯函数，便于自证时用「变异输入」再跑一遍）
 * @returns {string[]} 问题列表（空数组 = 通过）
 */
function check(input) {
  const { roleAdmin, roleSupplier, navAdmin, navSupplier, exemptAdmin, exemptSupplier, adminSrc } = input;
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
  for (const e of exemptAdmin) {
    if (navAdmin.includes(e.key)) {
      problems.push(`[豁免过期] ${e.key} 已进 ADMIN_NAV，请从 ADMIN_EXEMPT 删除该条`);
    }
    if (!roleAdmin.includes(e.key)) {
      problems.push(`[豁免无据] ${e.key} 已不在 ADMIN_MENU_KEYS 里，豁免失去意义，请删除`);
    }
  }

  // ④ 豁免必须自带机械证据
  for (const e of exemptAdmin) {
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
      problems.push(`[豁免类型未知] ${e.key} 的 kind=${e.kind}（只接受 drilldown / legacy-duplicate）`);
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

  return problems;
}

function loadInput() {
  const roleSrc = stripComments(readFileSync(ROLE_FILE, 'utf8'));
  const navSrc = stripComments(readFileSync(NAV_FILE, 'utf8'));
  return {
    roleAdmin: readStringKeys(roleSrc, 'ADMIN_MENU_KEYS'),
    roleSupplier: readStringKeys(roleSrc, 'SUPPLIER_MENU_KEYS'),
    navAdmin: readNavPaths(navSrc, 'ADMIN_NAV'),
    navSupplier: readNavPaths(navSrc, 'SUPPLIER_NAV'),
    exemptAdmin: ADMIN_EXEMPT,
    exemptSupplier: SUPPLIER_EXEMPT,
    adminSrc: ADMIN_SRC,
  };
}

/** 自证：4 种缺口分别注入，每一种都必须被报出 */
function selfTest(base) {
  const cases = [
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
  ];

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
  return failures;
}

const input = loadInput();

const selfFailures = selfTest(input);
if (selfFailures.length > 0) {
  console.error('✘ nav:consistency 自证失败 —— 门禁本身失效，先修门禁');
  selfFailures.forEach((f) => console.error(f));
  process.exit(1);
}

const problems = check(input);
if (problems.length > 0) {
  console.error(`✘ nav:consistency 发现 ${problems.length} 处「授权 ↔ 入口」不一致：`);
  problems.forEach((p) => console.error(`  · ${p}`));
  console.error('\n修法：优先补进 ADMIN_NAV / SUPPLIER_NAV；确属刻意下钻才加豁免，且豁免要给出 via 文件。');
  process.exit(1);
}

console.log(
  `✔ nav:consistency 通过：运营 ${input.roleAdmin.length} 授权 ↔ ${input.navAdmin.length} 入口` +
    `（豁免 ${ADMIN_EXEMPT.length}）· 供应商 ${input.roleSupplier.length} ↔ ${input.navSupplier.length}` +
    ` · 自证 ${5 + 1}/6`,
);

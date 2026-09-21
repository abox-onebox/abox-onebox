#!/usr/bin/env node
/**
 * 门禁：**真源字面量外溢**（dup-const）
 *
 * ## 为什么必须有这条门禁
 *
 * 本项目反复出现同一形状的缺陷：**同一个概念有 N 份表述，而被自动化执行的那一份唯一**，
 * 于是「抄来的那几份」改了真源也不会跟着改，**且没有任何门禁会红**。
 * 已发生并被人工记入《缺陷与陷阱》的实例（本门禁直接针对这两例）：
 *
 *   ① **档位文案**：真源 `packages/shared-utils/src/biz.ts` 的 `SET_MEAL_SLOT_LABEL`；
 *      而 `apps/miniprogram/src/utils/format.ts` 与
 *      `apps/api-server/src/modules/order/order-admin.service.ts` **各手抄了一份同值映射**
 *      （2026-09-21 已改为转发真源）。抄的时候内容是对的 —— 这正是它危险的地方：
 *      **改真源的那一刻它们就错了，而门禁全绿**。
 *   ② **送达时刻**：真源 `apps/api-server/src/common/utils/order-timeline.ts` 的
 *      `DEFAULT_TIMELINE.arrival`。PR-02 批次一次性收口了 **8 处**手写时刻，
 *      其中包含「同一 payload 里 `expectAt` 手写、紧邻的 `expectAtIso` 派生」这种
 *      **双真相并排**的形态（改一次配置当场分裂）。
 *
 * 两例的共同点：**修复靠人记得，而没有机器每次拦**。本门禁把它变成机器拦。
 *
 * ## 覆盖的三条判据（每条都附**本仓库实测基线**，不是想出来的）
 *
 * | 判据 | 查什么 | 真源 | 豁免 | 实测命中 |
 * |---|---|---|---|---|
 * | `slot-map`        | 数字键 → 档位中文 的**映射条目** | `shared-utils/src/biz.ts` | 无 | 5（全在真源内） |
 * | `arrival-literal`  | 独立字符串字面量 `'11:30'` | `common/utils/order-timeline.ts` | 行内声明 / `seeds/` | 0 |
 * | `date-parse`       | `.vue` 内联 `new Date(...T00:00:00)` | `miniprogram/src/utils/format.ts` 的 `formatMealDate` | 无 | 0 |
 *
 * ### 判据的取法（**为什么是这三条，而不是十条**）
 *
 * 判据全部选「**当前零命中且零误报**」的那些。理由：门禁最大的敌人不是漏报，是**误报** ——
 * **误报比漏报更快把人训练成忽略告警**（本项目在 `doc:tables` 的注释里已立过这条）。
 * 以下三条**看起来该查但实测噪音过大**，故**刻意不覆盖**，并如实登记在此供后人判断：
 *
 *   · **佣金费率 `0.08/0.09/0.10/0.12`** —— 实测 30 处，其中大半是 CSS 的
 *     `rgba(201,168,118,0.12)`（**与费率数字同形**）⇒ 纯字面量判据必然误报；
 *   · **售价 `25.80` / `2580`** —— 实测 81 处：订单单价**快照**、Swagger `example`、
 *     种子数据都**合法地**出现该数字 ⇒ 无法区分「快照」与「第二份口径」；
 *   · **档位中文作为普通字符串**（如 `'主荤'`）—— **两轴同形**：档位轴
 *     （`ab_set_meal_item.slot`：`1 主荤/2 半荤/3 素菜/4 汤/5 主食`）与品类轴
 *     （`ab_dish.category`：`main 主荤/half 半荤/veg 素菜/soup 汤品/staple 主食`）
 *     **共用 4 个中文词**，唯一区别是「汤 vs 汤品」。按字符串判「是否外溢」**必然误伤品类轴**
 *     （而品类轴出现在菜品库 / 角标 / 溯源页是**完全正确**的）。
 *     故只查**结构性**的数字键映射（`slot-map`），不查裸字符串。
 *
 * ## 自证（每次运行都做）
 *
 * 每条判据 × 每类样本都必须在**指定文件**下得到预期结论：
 *   · **必报**样本（普通文件）→ 必须报出；
 *   · **必不报**样本（普通文件 / 真源文件）→ 必须报不出。
 * 任一侧不符即门禁失败（同 `schema:parity` / `nav:consistency`：**恒绿或恒红的检查等于没有检查**）。
 *
 * 用法：`node scripts/check-dup-const.mjs`
 * 退出码 0 = 无外溢；非 0 = 有外溢（逐条打印 `文件:行` 与整改建议）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 扫描面：**只扫生产源码根** `apps/<app>/src` 与 `packages/<pkg>/src`。
 *
 * ⚠️ 为什么**刻意不扫** `scripts/`、各包的 `test/`、`dist` 与 `dist-h5`：
 *   · **验证层本来就需要硬编码期望值** —— 三个 e2e 脚本要断言「默认送达时刻 = 11:30」，
 *     那里的 `'11:30'` 是**判据**而不是「第二份口径」；把判据也禁掉，等于让门禁
 *     无法被验证（本脚本的自证样本同样是硬编码字面量）。
 *   · 若把本脚本自己扫进去，它**自己的样本数据**就会被报成违规 —— 这是**自引用**陷阱，
 *     首跑实测确实发生了（9 处「违规」中有 3 处来自本文件的 samples）。
 */
const WORKSPACES = ['apps', 'packages'];
const SCAN_EXT = new Set(['.ts', '.vue', '.js', '.mjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-h5', '.git', 'archive', '_stale-build']);

/** 扫描根清单（不存在则跳过，便于在子包增删时不报错） */
function scanRoots() {
  const out = [];
  for (const ws of WORKSPACES) {
    const base = join(ROOT, ws);
    if (!existsSync(base)) continue;
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const src = join(base, e.name, 'src');
      if (existsSync(src)) out.push(src);
    }
  }
  return out;
}

/** 行内显式声明的逃生口（**必须写理由**，比静默白名单更难腐烂） */
const ALLOW_TOKEN = 'dup-const-allow';

const SLOT_TRUTH = 'packages/shared-utils/src/biz.ts';
const ARRIVAL_TRUTH = 'apps/api-server/src/common/utils/order-timeline.ts';
const DATE_TRUTH = 'apps/miniprogram/src/utils/format.ts';

/** 普通（非真源）样本文件 —— 仅用于自证，不必真实存在 */
const PLAIN = 'apps/miniprogram/src/pages/__sample__/sample.vue';
const PLAIN2 = 'apps/api-server/src/modules/__sample__/sample.ts';

const RULES = [
  {
    id: 'slot-map',
    why:
      '档位映射（数字键 → 档位中文）只能写在真源里；在别处手抄一份 ⇒ 改真源时静默漂移。\n' +
      "      请改为 `export { SET_MEAL_SLOT_LABEL as SLOT_LABEL } from '@abox/shared-utils';`",
    truth: [SLOT_TRUTH],
    // ⚠️ **不锚定行首行尾**：`const SLOT_LABEL = { 4: '汤' };` 这类单行紧凑写法
    //    也要能报出（首版用了 `^…$` 锚定，被本脚本的自证样本当场抓出漏报）。
    test: (line) => /[^.\w][1-5]\s*:\s*['"](主荤|半荤|素菜|汤|主食)['"]/.test(line),
    exempt: () => false,
    samples: [
      // 必报：普通文件里的映射条目
      { file: PLAIN2, line: "const SLOT_LABEL = { 4: '汤' };", expect: 'hit' },
      { file: PLAIN2, line: "  1: '主荤',", expect: 'hit' },
      // 必不报：真源文件里的同一条
      { file: SLOT_TRUTH, line: "  4: '汤',", expect: 'miss' },
      // 必不报：引用（不是抄写）与品类轴（计算键，不同形）
      { file: PLAIN2, line: 'slotLabel: SLOT_LABEL[i.slot] ?? `档位 ${i.slot}`,', expect: 'miss' },
      { file: PLAIN2, line: "[DishCategory.SOUP]: '汤品',", expect: 'miss' },
    ],
  },
  {
    id: 'arrival-literal',
    why:
      '送达时刻只能由真源派生（`DEFAULT_TIMELINE.arrival` / 响应字段）：端上用响应里的\n' +
      '      `deliverAt` / `expectAt`，服务端用 `currentTimeline()`。若确为**离线不可联网**场景\n' +
      '      （如协议正文），在行内写明 `真源` 或 `人工同步点`，或加 `dup-const-allow` 并写理由。',
    truth: [ARRIVAL_TRUTH],
    test: (line) => /['"`]11:30['"`]/.test(line),
    exempt: (line, rel) =>
      rel.includes('/database/seeds/') || // 种子 = 配置初值的 bootstrap，不是「第二份口径」
      /真源|人工同步点/.test(line) ||
      line.includes(ALLOW_TOKEN),
    samples: [
      { file: PLAIN2, line: "if (hour === '11:30') return;", expect: 'hit' },
      { file: PLAIN2, line: "const x = '11:30'; // 人工同步点：协议正文离线可读", expect: 'miss' },
      { file: PLAIN2, line: "const y = '11:30'; // dup-const-allow: e2e 夹具", expect: 'miss' },
      {
        file: 'apps/api-server/src/database/seeds/__sample__.ts',
        line: "['set_meal.delivery_arrival_time', '11:30', '送达办公楼'],",
        expect: 'miss',
      },
      { file: ARRIVAL_TRUTH, line: "const t = '11:30';", expect: 'miss' },
      { file: PLAIN2, line: '// 真源见 order-timeline.ts', expect: 'miss' },
    ],
  },
  {
    id: 'date-parse',
    why:
      '`new Date(`${raw}T00:00:00`)` 按**本地时区**解析（旧 WebView / JSCore 有按 UTC 的历史行为）\n' +
      '      ⇒ 会整体偏移一天。请用 `formatMealDate()`（手工解析、不碰 Date 的时区语义）。\n' +
      '      该工具文件的注释里**逐字禁止了这种写法** —— 内联一遍等于绕过自己定的规则。',
    truth: [DATE_TRUTH],
    // ⚠️ 只判「日期串按本地时区解析」这一形态：显式带 `Z` / 偏移的（如 `T00:00:00Z`）**是正确写法**
    test: (line) => /new Date\([^)]*T00:00:00(?![Zz\d:+])/.test(line),
    exempt: (line, rel) => rel.endsWith('.ts') || line.includes(ALLOW_TOKEN),
    samples: [
      { file: PLAIN, line: 'const dt = new Date(`${raw}T00:00:00`);', expect: 'hit' },
      // 必不报：显式 UTC（这是对的，别误伤）
      { file: PLAIN, line: 'const dt = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 864e5);', expect: 'miss' },
      { file: PLAIN, line: 'const s = formatMealDate(raw);', expect: 'miss' },
      // 必不报：判据只作用于 .vue（服务端的 ISO 解析另有工具）
      { file: PLAIN2, line: 'const dt = new Date(`${raw}T00:00:00`);', expect: 'miss' },
      { file: DATE_TRUTH, line: 'const dt = new Date(`${raw}T00:00:00`);', expect: 'miss' },
    ],
  },
];

/** 判据作用域（默认全源码面） */
const RULE_SCOPE = { 'date-parse': (rel) => rel.endsWith('.vue') };

/** 纯注释行不参与判定（否则「讲这条规则的注释本身」会被判违规） */
const isCommentLine = (t) =>
  t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('<!--');

function scanLine(line, rel, rule) {
  const t = line.trim();
  if (isCommentLine(t)) return null;
  if (RULE_SCOPE[rule.id] && !RULE_SCOPE[rule.id](rel)) return null;
  if (rule.truth.includes(rel)) return null; // 真源内不做判定
  if (!rule.test(line)) return null;
  if (rule.exempt(line, rel)) return null;
  return { rel, text: t.slice(0, 120) };
}

// ---------------------------------------------------------------------------
// 自证
// ---------------------------------------------------------------------------
const selfFails = [];
for (const rule of RULES) {
  for (const s of rule.samples) {
    const got = scanLine(s.line, s.file, rule);
    const reported = got !== null;
    const want = s.expect === 'hit';
    if (reported !== want) {
      selfFails.push(
        `[${rule.id}] 期望 ${s.expect} 但实得 ${reported ? 'hit' : 'miss'} · ${s.file} · ${s.line.slice(0, 70)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------
const files = [];
for (const root of scanRoots()) {
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (SCAN_EXT.has(extname(e.name))) files.push(p);
    }
  })(root);
}

const violations = [];
for (const f of files) {
  const rel = relative(ROOT, f).replace(/\\/g, '/');
  const text = readFileSync(f, 'utf8');
  text.split('\n').forEach((line, i) => {
    for (const rule of RULES) {
      const v = scanLine(line, rel, rule);
      if (v) violations.push({ rule: rule.id, ...v, line: i + 1 });
    }
  });
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
console.log('=== dup-const · 真源字面量外溢 ===');
console.log(
  `扫描 ${files.length} 个源文件（${WORKSPACES.map((w) => `${w}/*/src`).join(' , ')}）· ${RULES.length} 条判据：${RULES.map((r) => r.id).join(' / ')}`,
);

if (selfFails.length) {
  console.log('\n✘ 自证未通过（门禁自身失效，比查出问题更严重）：');
  for (const s of selfFails) console.log('  ' + s);
  process.exit(2);
}
console.log(
  `自证：${RULES.reduce((n, r) => n + r.samples.length, 0)} 个样本全部符合预期（必报的报得出 / 必不报的不报）✔`,
);

if (!violations.length) {
  console.log('\n通过 ✔ 未发现真源字面量外溢（0 处）');
  process.exit(0);
}

console.log(`\n✘ 发现 ${violations.length} 处真源字面量外溢：`);
const byRule = new Map();
for (const v of violations) {
  if (!byRule.has(v.rule)) byRule.set(v.rule, []);
  byRule.get(v.rule).push(v);
}
for (const [id, list] of byRule) {
  const rule = RULES.find((r) => r.id === id);
  console.log(`\n── [${id}] ${list.length} 处 —— 真源：${rule.truth.join(' , ')}`);
  console.log(`     ${rule.why}`);
  for (const v of list) console.log(`     ${v.rel}:${v.line}  ${v.text}`);
}
process.exit(1);

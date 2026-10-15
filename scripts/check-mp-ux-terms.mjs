#!/usr/bin/env node
/**
 * ⛔ 小程序用户可见文案「去餐化术语一致性」防复发闸门 —— `mp:ux-terms`
 *
 * ## 缺陷本体（去餐化可读性的收口）
 * 项目做了两层去餐化：
 *   · X 批：自然语言「菜品 → 商品」+ 展示层 336 处中性化（commit `fdf6cb0`）；
 *   · Y 批：API 契约字段 `dish*` → `item*`（commit `8ec52d8`，仅契约层，不影响用户文案）。
 * 落地后人工逐页过一遍小程序，发现用户可见文案里仍有**两类不一致**，会让用户误以为
 * 「不是在买饭 / 在买商品」或单位混乱：
 *   · 把"菜/餐"叫成「商品」：`已选 N 件商品`、`没选的商品视为跳过`、`SLOT_LABEL[x] || '商品'`、
 *     `商品#id`（订单详情评价区 / 槽位兜底 / 孤儿评价）。
 *   · 份 / 件 单位混用：下单页 `明日组合（N 件）`、订单详情 `单价 × 件数`、取消页 `件数` 标签
 *     —— 而全站其它地方（首页 / 订单列表 / 下单计算行）都用「份」。
 * 上述 6+1 处已人工收口，本闸门把它们**固化成自动守护**，免得日后回归又得人工逐页翻。
 *
 * ## 取数依据（判据不是拍脑袋，来自真实分布扫描）
 *   扫 `apps/miniprogram/src` 全量后确认：
 *   · 用户可见「商品」一词只剩 `pages/supplier/detail.vue` 的「在册商品」（资质陈述，合法）
 *     与协议常量 `constants/agreements.ts`（法务措辞，合法）。
 *   · 「件 / 件数」在 `pages/leader/**`（团长端）大量出现（实发件数 / 总件数 … 是按件计佣的
 *     专业术语，**必须豁免**）；**用户端**只剩 `pages/order-cancel` 的「件数」标签与
 *     `pages/index` 营销语「每家只出一件拿手好物」（通顺、指一份，保留不动）。
 *   ⇒ 判据对 `leader / supplier / agreement` 三目录整体豁免，其余用户端页面零误报。
 *
 * ## 判据（两条，唯一真源见 `scanUxTerms`，自证与主流程共用）
 *   A. 去餐化泄漏：非豁免目录的 `pages/**\/*.vue` + `components/**\/*.vue`（剥注释后）出现「商品」 ⇒ 报。
 *   B. 单位不一致：同上范围（剥注释后）出现 `件商品` / `件数` / `（{{…}} 件）` / `（\d+ 件）` / `×\s*件数` ⇒ 报。
 *
 * ## ⭐ 为什么这道**有牙齿**（不是恒绿）
 *   现在 0 命中是因为源码真的收口干净了；谁日后在**用户端页面**新写一个「商品」或把「份」写成「件」
 *   ⇒ 立刻红并点名 `文件:行`。判据有牙齿。
 *
 * ## 已知局限（静态下界，**不是**缺陷，但要知道）
 *   · 只扫 `pages/**` + `components/**` 的 `.vue`（用户可见 UI 的主体）；`constants/*.ts` 里的协议
 *     正文（`agreements.ts`）属法务措辞，本就不扫（且不在豁免判断内，天然排除）。
 *   · 营销语「一件拿手好物」之类的「件」不在 B 模式内（读感通顺、指一份），故不报；若日后想收紧，
 *     在 B 的模式数组里加一条即可，自证会逼你补「必不报」样本。
 *
 * ## 0 样本守卫
 *   扫到 0 个用户端 `.vue` 文件 ⇒ 判 broken 并 EXIT=2（恒绿 / 恒 N/A = 没有检查）。
 *
 * 退出码：0 通过 · 1 有不一致 · 2 自证失败或样本为 0（**不静默放行**）
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'apps', 'miniprogram', 'src');

/**
 * 豁免前缀（相对 `apps/miniprogram/src`）：这些目录的 .vue 用「商品 / 件数」是合法术语或法务措辞，
 * 不是去餐化泄漏 —— 整体跳过，避免误伤团长端按件计佣、供应商资质陈述、协议正文。
 * ⚠️ 用**前缀**而非精确目录：`pages/leader` 既覆盖 `pages/leader/`（团长工作台子页），
 *   也覆盖 `pages/leader-apply`（团长申请页）—— 两者都是团长端，按件计佣术语合法。
 */
const EXEMPT_PREFIXES = ['pages/leader', 'pages/supplier', 'pages/agreement'];

// ── 词法工具 ──────────────────────────────────────────────────────────────

/** 按位抹掉注释内容，保留长度与换行 ⇒ 索引仍能映射回原始行号（同 check-mp-bare-call.mjs） */
function stripComments(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    // HTML 模板注释 <!-- ... -->（.vue 的 <template> 里大量存在，含「商品摘要」等词，必须先剥）
    if (src[i] === '<' && src[i + 1] === '!' && src[i + 2] === '-' && src[i + 3] === '-') {
      out[i] = out[i + 1] = out[i + 2] = out[i + 3] = ' ';
      i += 4;
      while (i < n && !(src[i] === '-' && src[i + 1] === '-' && src[i + 2] === '>')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) {
        out[i] = out[i + 1] = out[i + 2] = ' ';
        i += 3;
      }
    } else if (src[i] === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
    } else if (src[i] === '/' && src[i + 1] === '*') {
      out[i] = out[i + 1] = ' ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) {
        out[i] = out[i + 1] = ' ';
        i += 2;
      }
    } else if (src[i] === "'" || src[i] === '"' || src[i] === '`') {
      const q = src[i];
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
    } else i++;
  }
  return out.join('');
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (e.endsWith('.vue')) acc.push(p);
  }
  return acc;
}

// ── 判据真源（自证与主流程共用，禁止各写一份）──────────────────────────────
/**
 * @param {string} srcRoot 小程序 `src` 根目录
 * @returns {{ok:boolean, reason?:string, files:number, aHits:Array, bHits:Array, hits:Array}}
 *   `ok=false` 表示**样本为空**（目录缺失 / 0 文件）⇒ 调用方必须 EXIT=2。
 */
export function scanUxTerms(srcRoot) {
  const files = [
    ...walk(join(srcRoot, 'pages')),
    ...walk(join(srcRoot, 'components')),
  ].filter((p) => {
    const rel = relative(srcRoot, p).replace(/\\/g, '/');
    return !EXEMPT_PREFIXES.some((pre) => rel.startsWith(pre));
  });

  if (!existsSync(srcRoot)) return failTree(`src 目录不存在：${srcRoot}`);
  if (files.length === 0)
    return failTree(`${relative(ROOT, srcRoot)} 下未扫到任何用户端 .vue 文件（含豁免目录后）`);

  const aHits = []; // 判据 A：商品泄漏
  const bHits = []; // 判据 B：件/份单位不一致

  const B_PATTERNS = [
    /件商品/,
    /件数/,
    /（{{[^}]*}}\s*件）/,
    /（\d+\s*件）/,
    /×\s*件数/,
  ];

  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const src = stripComments(raw);
    const rel = relative(srcRoot, file).replace(/\\/g, '/');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const ln = i + 1;
      if (/商品/.test(line)) {
        aHits.push({ file: rel, line: ln, text: line.trim().slice(0, 60) });
      }
      for (const re of B_PATTERNS) {
        if (re.test(line)) {
          bHits.push({ file: rel, line: ln, text: line.trim().slice(0, 60) });
          break;
        }
      }
    });
  }

  const hits = [...aHits, ...bHits];
  return { ok: true, files: files.length, aHits, bHits, hits };

  function failTree(reason) {
    return { ok: false, reason, files: 0, aHits: [], bHits: [], hits: [] };
  }
}

// ── 自证（无条件前置跑：恒绿的检查比没有检查更糟）────────────────────────────
function selftest() {
  const cases = [];
  const base = join(tmpdir(), `abox-mp-ux-terms-${Date.now()}`);
  try {
    const srcRoot = join(base, 'apps', 'miniprogram', 'src');
    mkdirSync(join(srcRoot, 'pages', 'demo'), { recursive: true });
    mkdirSync(join(srcRoot, 'pages', 'leader'), { recursive: true });
    mkdirSync(join(srcRoot, 'pages', 'supplier'), { recursive: true });
    mkdirSync(join(srcRoot, 'components', 'demo'), { recursive: true });

    // ① 用户端页面：埋 3 个必报样本（商品泄漏 + 两种单位误用）
    writeFileSync(
      join(srcRoot, 'pages', 'demo', 'demo.vue'),
      [
        '<template>',
        '  <view>',
        '    <text>已选 N 件商品</text>', // 判据 A：商品泄漏
        '    <text>明日组合（{{ quantity }} 件）</text>', // 判据 B：（{{…}} 件）
        '    <text class="card__label">件数</text>', // 判据 B：件数
        '  </view>',
        '</template>',
      ].join('\n'),
    );
    // ①-补：组件里也埋一个商品泄漏，验证 components 也在扫描范围
    writeFileSync(
      join(srcRoot, 'components', 'demo', 'demo.vue'),
      ["<template>", "  <text>SLOT_LABEL[x] || '商品'</text>", '</template>'].join('\n'),
    );
    // ② 豁免目录：团长端「实发件数」、供应商「在册商品」—— 必不报
    writeFileSync(
      join(srcRoot, 'pages', 'leader', 'leader.vue'),
      ['<template>', '  <text>佣金按实发件数计</text>', '</template>'].join('\n'),
    );
    writeFileSync(
      join(srcRoot, 'pages', 'supplier', 'supplier.vue'),
      ['<template>', '  <text>在册商品</text>', '</template>'].join('\n'),
    );

    const r = scanUxTerms(srcRoot);
    cases.push(['① 样本非空：扫到用户端 .vue', r.ok && r.files > 0]);
    cases.push([
      '② 必报：用户端「商品」泄漏被报出（pages + components 共 2 处）',
      r.ok && r.aHits.length === 2,
    ]);
    cases.push([
      '③ 必报：用户端「件/份」单位误用被报出（件商品 / （{{…}} 件） / 件数 共 3 处）',
      r.ok && r.bHits.length === 3,
    ]);
    cases.push([
      '④ 必不报：团长端豁免（实发件数不在命中）',
      r.ok && !r.hits.some((h) => h.file.includes('pages/leader/')),
    ]);
    cases.push([
      '⑤ 必不报：供应商豁免（在册商品不在命中）',
      r.ok && !r.hits.some((h) => h.file.includes('pages/supplier/')),
    ]);

    // ⑥ 0 样本守卫：目录存在但 0 用户端 .vue ⇒ ok=false
    const emptyRoot = join(base, 'empty-src');
    mkdirSync(join(emptyRoot, 'pages', 'demo'), { recursive: true });
    cases.push(['⑥ 0 样本守卫：无用户端 .vue ⇒ ok=false（不许当通过）', scanUxTerms(emptyRoot).ok === false]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  const pass = cases.filter(([, ok]) => ok).length;
  for (const [name, ok] of cases) console.log(`  ${ok ? '✔' : '✘'} ${name}`);
  console.log(`[自证] 汇总 ${pass}/${cases.length}`);
  if (pass !== cases.length) {
    console.log('✘ 自证失败：检查器自身判据已坏，门禁不可用（不静默放行）');
    process.exit(2);
  }
}

// ⭐ ESM main guard：被 import 时只复用 `scanUxTerms`，不跑自证与主流程
const IS_MAIN = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN) {
  selftest();
  main();
}

// ── 主流程 ────────────────────────────────────────────────────────────────
function main() {
  const r = scanUxTerms(SRC);
  if (!r.ok) {
    console.log(`✘ 扫描样本为空：${r.reason}`);
    console.log('  0 样本时本闸门**不许**报通过（恒绿 = 没有检查）；请确认小程序 src 路径与文件后缀。');
    process.exit(2);
  }

  console.log(`③ 覆盖面：${r.files} 个用户端 .vue 文件（已豁免 supplier/leader/agreement 目录）`);

  if (r.hits.length > 0) {
    console.log(`✘ 去餐化术语不一致 ${r.hits.length} 处：`);
    for (const h of r.hits)
      console.log(`  - ${h.file}:${h.line}  ${h.text}`);
    console.log(
      '\n⛔ 去餐化只改契约层，用户看到的仍是「一盒饭、几道菜」的语境。修复方向：\n' +
        '   · 把「商品」改回食物语境词（菜 / 菜品 / 组合 / 本日精选）；\n' +
        '   · 把「件 / 件数」统一为「份 / 份数」（全站订单份数都用「份」）。\n' +
        '   ⚠️ 团长端（leader/*）按件计佣是合法术语，不要改。',
    );
    process.exit(1);
  }

  console.log(`✔ 用户端文案去餐化一致（${r.files} 个文件：商品泄漏 0 · 件/份混用 0）`);
}

#!/usr/bin/env node
/**
 * 端上「图标承载」门禁 —— 把图标规格从**文本**变成**可跑的断言**
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 规格 §五 锁了「功能图标三档 16/20/24px（= 32/40/48rpx）」，但 S7 实测：
 * **78 处渲染点，落在三档内 0 处**。根因有两条：
 *   ① 图标由各页 `import { ABOX_ICON_CHARS as I }` 直接把 PUA 字符塞进 `<text>`，
 *      字号由各页自己写 ⇒ 三档**无从机械校验**；
 *   ② `components/ab-icon/index.vue` **0 引用**（悬挂）—— 而它存在的唯一价值就是承载三档。
 *
 * ⚠️ 为什么端上不能让 `ab-icon` 组件承载：微信官方文档（text 组件 · Bug & Tip）原文
 *    「text 组件内**只支持 text 嵌套**」⇒ `<text>` **不能内嵌自定义组件**。端上绝大多数
 *    图标位是「图标 + 中文」混排在同一 `<text>` 里，写组件会被渲染层**静默丢弃**
 *    （不报错、不警告、位置空着）。⇒ 唯一可行写法是**统一 class 约定**：
 *       `<text class="abi abi-16">{{ I.chart }}</text>`
 *
 * ── 八条断言 ────────────────────────────────────────────────────────────────
 *   ① 渲染区真 emoji == 0（模板 + 脚本**字符串**内；脚本注释不计）
 *   ② `I.xxx` 出现在「非档位承载位」== 0
 *        · 模板里 `{{ }}` 之外（属性表达式 `:text="..."` 等）
 *        · `<script>` 段内任意出现（脚本里无法承载档位 class）
 *   ②-c **直取字符表** `ABOX_ICON_CHARS[...]`（import 语句除外）== 0
 *        · 这类取值同时逃过 ① ② ③：名字里没有 `I.`（② 认不出），
 *          `{{ ico }}` 里也没有 `I`（③ 的分母数的是 `{{ I… }}`）。
 *          实测事故：`ab-empty-state` 用 `{{ ico }}` + script 段
 *          `ABOX_ICON_CHARS[props.illustration]` 渲染插图，
 *          在 ①②③ 全绿的情况下，**整个文件对门禁不可见**。
 *        · 唯一许可形态：`import { ABOX_ICON_CHARS as I } from '@abox/shared-utils'`
 *          （跨行 import 也算许可 —— 判据抹的是**整条 import 语句**，不是「以 import 开头的行」）
 *   ③ `<template>` 里每个 `{{ I... }}` 必须被档位 class 包裹
 *   ④ 档位 class 取值必须落在两族内（功能 16/20/24 · 装饰 14/28/34/40）
 *   ⑤ 档位定义与真源一致（两端 icons.scss 各 7 档、数值成对）
 *   ⑥ `ab-icon` 组件引用计数自报（0 引用 = 悬挂组件，须处置）
 *   ⑦ 独立箭头元素（class 含 arrow/chev/caret）内不得是**裸字形**，必须是 `.abi` 图标
 *      —— 覆盖 `› (U+203A) ⌄ (U+2304)` 这类「排版上合法、独立承载位上是功能图标」的字形。
 *      判据只认**独立元素**：句内后缀（"进入工作台 ›"）是排版，不拦。
 *
 * ── 四个必须避开的判据坑（都实测踩过）──────────────────────────────────────
 *   · emoji 范围用 `String.fromCodePoint` 拼 —— `\U000002600`（9 位十六进制）会被截成
 *     U+0260，把半个 BMP 卷进来（实测 82 万条假命中）。
 *   · 剥注释必须**等长替换**（换行保留），否则 `count('\n',0,idx)` 拿剥后下标数原文行号，行号全错。
 *   · 不剥 HTML 注释，实测把 27 行 `<!-- ⭐ 版式基准 -->` 记成「渲染区 emoji」（假阳性）。
 *   · 取外层 `<template>` **必须深度配对** —— 非贪婪正则在第一个嵌套 `</template>` 处截断，
 *     实测 `withdraw.vue` 只截到 1128/12145 字符，后面 7 处未加档位的插值**全部漏扫**（假阴性）。
 *   · 免检区（import 语句 / 注释）**必须是「语句级」而不是「行级」** —— 按「行首是否 import」
 *     免检，一遇跨行花括号 import（`import {\n  ABOX_ICON_CHARS as I,\n} from '…'`）就会
 *     把第二行判成违规（假阳性），而下一个人只会把它改成一行了事。
 *
 * ── 自证（必做：恒绿的检查比没有检查更糟）─────────────────────────────────
 * 十四组合成样本：「必报的报得出 / 必不报的不报」，任一侧不符即 **exit 2**。
 *
 * 退出码：0 通过 · 1 有违规 · 2 自证失败（检查器自身坏掉 ⇒ 显式失败，不静默放行）
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'apps', 'miniprogram', 'src');
const CSS = {
  mp: join(ROOT, 'apps', 'miniprogram', 'src', 'styles', 'icons.scss'),
  admin: join(ROOT, 'apps', 'admin-web', 'src', 'styles', 'icons.scss'),
};

/* ---------------- 常量 ---------------- */

// emoji 范围（闭区间；用 fromCodePoint 拼，不写字面量）
const EMOJI_RANGES = [
  [0x1f300, 0x1faff],
  [0x2600, 0x27bf],
  [0x2300, 0x23ff], // ⏰ 在此区块 —— 上一版判据漏了它
  [0x2b00, 0x2bff],
  [0xfe0f, 0xfe0f],
  [0x200d, 0x200d],
];
const FN_TIERS = ['abi-16', 'abi-20', 'abi-24'];
const DECO_TIERS = ['abi-deco-14', 'abi-deco-28', 'abi-deco-34', 'abi-deco-40'];
const ALL_TIERS = [...FN_TIERS, ...DECO_TIERS];
const TIER_RE = /\babi-(?:deco-(?:14|28|34|40)|16|20|24)\b/;
const ANY_TIER_RE = /\babi-[a-z0-9-]+\b/g;

const EXPECT = {
  mp: { 'abi-16': '32rpx', 'abi-20': '40rpx', 'abi-24': '48rpx', 'abi-deco-14': '28rpx', 'abi-deco-28': '56rpx', 'abi-deco-34': '68rpx', 'abi-deco-40': '80rpx' },
  admin: { 'abi-16': '16px', 'abi-20': '20px', 'abi-24': '24px', 'abi-deco-14': '14px', 'abi-deco-28': '28px', 'abi-deco-34': '34px', 'abi-deco-40': '40px' },
};

// 图标引用：I.xxx / I['xxx'] / I[dynamic]
const ICON_REF_RE = /\bI(?:\.([A-Za-z0-9_$-]+)|\[([^\]]+)\])/g;

// ②-c 直取字符表
const CHAR_TABLE_RE = /\bABOX_ICON_CHARS\b/g;
/** 整条 import 语句（支持跨行花括号写法）；用于「语句级」免检 */
const IMPORT_STMT_RE = /^[ \t]*import\b[\s\S]*?from[ \t]*(['"])[^'"]*\1[ \t]*;?/gm;

// ⑦ 独立箭头元素
const ARROW_CLS_RE = /arrow|chev|caret/i;
const GLYPHS = new Set(
  [0x2039, 0x203a, 0x2303, 0x2304, 0x25b2, 0x25b4, 0x25b6, 0x25b8, 0x25ba, 0x25bc, 0x25be, 0x25c0, 0x25c2, 0x25c4, 0x27a4].map((c) =>
    String.fromCodePoint(c),
  ),
);

/* ---------------- 工具 ---------------- */

const inRanges = (ch, ranges) => {
  const cp = ch.codePointAt(0);
  return ranges.some(([a, b]) => cp >= a && cp <= b);
};
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

/**
 * 把注释区用空格覆盖（**等长**，换行保留）⇒ 行号守恒。
 * 有序状态机：从左到右一次走完。两遍法（先标字符串再剥注释）在注释里出现奇数个
 * 反引号时会把后面真代码误标成字符串 ⇒ 假阴性。
 */
function blankComments(text, isVue) {
  const out = text.split('');
  const n = text.length;
  let i = 0;
  while (i < n) {
    const two = text.slice(i, i + 2);
    if (two === '/*') {
      const f = text.indexOf('*/', i + 2);
      const j = f < 0 ? n : f + 2;
      for (let k = i; k < j; k++) if (out[k] !== '\n') out[k] = ' ';
      i = j;
      continue;
    }
    if (isVue && text.slice(i, i + 4) === '<!--') {
      const f = text.indexOf('-->', i + 4);
      const j = f < 0 ? n : f + 3;
      for (let k = i; k < j; k++) if (out[k] !== '\n') out[k] = ' ';
      i = j;
      continue;
    }
    if (two === '//') {
      const f = text.indexOf('\n', i);
      const j = f < 0 ? n : f;
      for (let k = i; k < j; k++) out[k] = ' ';
      i = j;
      continue;
    }
    if (text[i] === '"' || text[i] === "'" || text[i] === '`') {
      const q = text[i];
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === q) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** 把整条 import 语句用空格覆盖（**等长**，换行保留）⇒ 行号守恒、语句级免检 */
function blankImports(text) {
  return text.replace(IMPORT_STMT_RE, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * 取**最外层** <template>，按深度配对。
 * ⚠️ 不能用非贪婪 `/<template[^>]*>([\s\S]*?)<\/template>/`：会在第一个嵌套
 * `</template>` 处截断（`<template v-else>` 很常见）⇒ 截断区内的插值全部漏扫。
 */
function extractOuterTemplate(text) {
  const open = /<template\b[^>]*>/.exec(text);
  if (!open) return { body: '', start: 0 };
  const start = open.index + open[0].length;
  let depth = 1;
  let i = start;
  const CLOSE = '</template>';
  const OPEN = '<template';
  while (i < text.length && depth > 0) {
    const no = text.indexOf(OPEN, i);
    const nc = text.indexOf(CLOSE, i);
    if (nc < 0) break;
    if (no >= 0 && no < nc) {
      const after = text[no + OPEN.length];
      const gt = text.indexOf('>', no);
      if (gt < 0) break;
      const selfClose = text.slice(no, gt + 1).trimEnd().endsWith('/>');
      if (!/[A-Za-z0-9-]/.test(after ?? '') && !selfClose) depth++;
      i = no + OPEN.length;
    } else {
      depth--;
      i = nc + CLOSE.length;
    }
  }
  const end = depth === 0 ? i - CLOSE.length : text.length;
  return { body: text.slice(start, end), start };
}

/** 行号 → 'tpl' | 'script' | 'style'；未覆盖 → 'other' */
function segMap(text) {
  const out = new Map();
  const { body, start } = extractOuterTemplate(text);
  if (body) {
    const a = lineOf(text, start);
    const b = lineOf(text, start + body.length);
    for (let ln = a; ln <= b; ln++) out.set(ln, 'tpl');
  }
  for (const tag of ['script', 'style']) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
    let m;
    while ((m = re.exec(text))) {
      const a = lineOf(text, m.index + m[0].indexOf(m[1]));
      const b = lineOf(text, m.index + m[0].indexOf(m[1]) + m[1].length);
      for (let ln = a; ln <= b; ln++) out.set(ln, tag);
    }
  }
  return out;
}

function interpSpans(tpl) {
  const spans = [];
  const re = /\{\{([\s\S]*?)\}\}/g;
  let m;
  while ((m = re.exec(tpl))) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/** 找 pos 之前最近的、尚未闭合的开标签的属性串 */
function enclosingTagAttrs(tpl, pos) {
  const re = /<([A-Za-z][A-Za-z0-9-]*)\b([^>]*?)(\/?)>/g;
  const cands = [];
  let m;
  while ((m = re.exec(tpl)) && m.index < pos) cands.push(m);
  for (let k = cands.length - 1; k >= 0; k--) {
    const t = cands[k];
    if (t[1].startsWith('/')) continue;
    if (t[3] === '/') continue; // 自闭合标签包不住 pos
    const tail = tpl.slice(t.index + t[0].length, pos);
    if (new RegExp(`</${t[1]}\\b`).test(tail)) continue; // 已闭合 ⇒ 不是祖先
    return t[2];
  }
  return '';
}

function classOf(attrs) {
  const m = /class\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
  return m ? m[1] ?? m[2] ?? '' : '';
}

/* ---------------- 单文件扫描 ---------------- */

function scanFile(abs, rel) {
  const raw = readFileSync(abs, 'utf8');
  const segs = segMap(raw);
  const stripped = blankComments(raw, true);
  const lines = raw.split('\n');
  const res = {
    rel,
    emoji: [],
    bare: [],
    script: [],
    charTable: [],
    interpTotal: 0,
    tiered: 0,
    badTier: [],
    bareInterp: [],
    bareArrow: [],
  };

  // ① 渲染区真 emoji（注释已剥成空格 ⇒ 自动排除注释）
  stripped.split('\n').forEach((sline, k) => {
    const ln = k + 1;
    const seg = segs.get(ln);
    if (seg !== 'tpl' && seg !== 'script') return;
    const hit = [...sline].find((c) => inRanges(c, EMOJI_RANGES));
    if (hit) res.emoji.push([rel, ln, `U+${hit.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`, hit, lines[ln - 1].trim().slice(0, 90)]);
  });

  const { body: tpl, start: tplOff } = extractOuterTemplate(stripped);
  const spans = interpSpans(tpl);
  const inInterp = (i) => spans.some(([a, b]) => i >= a && i < b);

  // ②-a 模板属性表达式里的 I.xxx
  for (const m of tpl.matchAll(new RegExp(ICON_REF_RE.source, 'g'))) {
    if (!inInterp(m.index)) {
      const ln = lineOf(raw, tplOff + m.index);
      res.bare.push([rel, ln, m[0], (lines[ln - 1] ?? '').trim().slice(0, 90)]);
    }
  }

  // ③ 每个 `{{ I... }}` 是否被档位 class 包裹
  for (const m of tpl.matchAll(new RegExp(ICON_REF_RE.source, 'g'))) {
    if (!inInterp(m.index)) continue;
    res.interpTotal++;
    const cls = classOf(enclosingTagAttrs(tpl, m.index));
    if (TIER_RE.test(cls)) res.tiered++;
    else {
      const ln = lineOf(raw, tplOff + m.index);
      res.bareInterp.push([rel, ln, m[0], cls || '(无 class)', (lines[ln - 1] ?? '').trim().slice(0, 90)]);
    }
  }

  // ④ 模板里 abi-* 取值合法性
  for (const m of tpl.matchAll(new RegExp(ANY_TIER_RE.source, 'g'))) {
    if (!ALL_TIERS.includes(m[0])) res.badTier.push([rel, lineOf(raw, tplOff + m.index), m[0]]);
  }

  // ⑦ 独立箭头元素内的裸字形（`</text` 不要求紧跟 `>`：本仓库习惯写 `</text\n>`）
  for (const m of tpl.matchAll(/<text\b[^>]*class\s*=\s*["']([^"']*)["'][^>]*>([\s\S]{0,160}?)<\/text/g)) {
    if (!ARROW_CLS_RE.test(m[1])) continue;
    if (m[2].includes('abi')) continue;
    const hit = [...m[2]].find((c) => GLYPHS.has(c));
    if (hit) {
      res.bareArrow.push([rel, lineOf(raw, tplOff + m.index), `.${m[1]}`, `U+${hit.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`, m[2].trim().slice(0, 40)]);
    }
  }

  // ②-b script 段里的 I.xxx
  for (const m of stripped.matchAll(new RegExp(ICON_REF_RE.source, 'g'))) {
    const ln = lineOf(stripped, m.index);
    if (segs.get(ln) === 'script') res.script.push([rel, ln, m[0], (lines[ln - 1] ?? '').trim().slice(0, 90)]);
  }

  // ②-c 直取字符表（import 语句 + 注释已抹掉 ⇒ 剩下的都是「绕开别名的取值」）
  const noImport = blankImports(stripped);
  for (const m of noImport.matchAll(new RegExp(CHAR_TABLE_RE.source, 'g'))) {
    const ln = lineOf(noImport, m.index);
    res.charTable.push([rel, ln, (lines[ln - 1] ?? '').trim().slice(0, 90)]);
  }

  return res;
}

/* ---------------- ⑤ 档位定义 ---------------- */

function checkTiers() {
  const issues = [];
  for (const [key, path] of Object.entries(CSS)) {
    if (!existsSync(path)) {
      issues.push(`[⑤] ${key}: 缺少 ${path}`);
      continue;
    }
    const txt = readFileSync(path, 'utf8');
    for (const [tier, val] of Object.entries(EXPECT[key])) {
      const m = new RegExp(`\\.${tier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{\\s*font-size:\\s*([^;}]+);`).exec(txt);
      if (!m) issues.push(`[⑤] ${key}: 缺档位 .${tier}`);
      else if (m[1].trim() !== val) issues.push(`[⑤] ${key}: .${tier} = ${m[1].trim()}（应为 ${val}）`);
    }
    for (const m of txt.matchAll(/\.(abi-(?:deco-)?\d+)\s*\{/g)) {
      if (!ALL_TIERS.includes(m[1])) issues.push(`[⑤] ${key}: 非法档位 .${m[1]}（两族之外）`);
    }
  }
  return issues;
}

/* ---------------- ⑥ ab-icon 引用 ---------------- */

function walkVue(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkVue(p));
    else if (e.name.endsWith('.vue')) out.push(p);
  }
  return out.sort();
}

function countAbIcon(files) {
  let n = 0;
  const hits = [];
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    const c = (t.match(/<ab-icon\b/g) ?? []).length;
    if (c) hits.push([relative(SRC, f).split(sep).join('/'), c]);
    n += c;
  }
  return { n, hits };
}

/**
 * ⑥ 端上 `ab-icon` 组件的**存在性 × 引用数**四态（不是简单的「0 引用即报」）
 *
 * S7.5 裁定：端上图标一律走**字符 + class 约定**（因为 `<text>` 不能内嵌自定义组件，
 * 混排位写组件会被渲染层静默丢弃），故该组件已**移出**。
 * ⇒ 「0 引用且不存在」是**预期终态**；「存在但 0 引用」才是悬挂（会诱导后人去用，踩静默丢失）。
 */
function abIconState(files) {
  const comp = join(SRC, 'components', 'ab-icon', 'index.vue');
  const exists = existsSync(comp);
  const { n, hits } = countAbIcon(files);
  let level = 'ok';
  let msg;
  if (!exists && n === 0) {
    msg = '端上无 ab-icon 组件、无引用 —— 预期终态（图标走字符 + class 约定）';
  } else if (exists && n === 0) {
    level = 'warn';
    msg = `悬挂组件：components/ab-icon/index.vue 存在但 0 引用（用它会踩「<text> 不能内嵌组件、被静默丢弃」）`;
  } else if (!exists && n > 0) {
    level = 'bad';
    msg = `有 ${n} 处 \`<ab-icon>\` 引用，但组件不存在 ⇒ 构建会失败`;
  } else {
    msg = `组件在用：${hits.map(([f, c]) => `${f}×${c}`).join(', ')}（共 ${n} 处）`;
  }
  return { level, msg, hits: n };
}

/* ---------------- 自证 ---------------- */

function probeGeneric(txt) {
  const stripped = blankComments(txt, true);
  const { body: tpl } = extractOuterTemplate(stripped);
  const spans = interpSpans(tpl);
  const inInterp = (i) => spans.some(([a, b]) => i >= a && i < b);
  let bare = 0;
  let untiered = 0;
  let total = 0;
  for (const m of tpl.matchAll(new RegExp(ICON_REF_RE.source, 'g'))) {
    total++;
    if (!inInterp(m.index)) {
      bare++;
      continue;
    }
    if (!TIER_RE.test(classOf(enclosingTagAttrs(tpl, m.index)))) untiered++;
  }
  return { bare, untiered, total };
}

function probeArrow(txt) {
  let n = 0;
  for (const m of txt.matchAll(/<text\b[^>]*class\s*=\s*["']([^"']*)["'][^>]*>([\s\S]{0,160}?)<\/text/g)) {
    if (!ARROW_CLS_RE.test(m[1])) continue;
    if (m[2].includes('abi')) continue;
    if ([...m[2]].some((c) => GLYPHS.has(c))) n++;
  }
  return n;
}

/** ②-c 探针：直取字符表的次数（注释与整条 import 语句均不计） */
function probeCharTable(txt) {
  const t = blankImports(blankComments(txt, true));
  return [...t.matchAll(new RegExp(CHAR_TABLE_RE.source, 'g'))].length;
}

function selftest() {
  const t = [];
  const bad = '<template><text :text="`${I.check} 走`">x</text><view>{{ I.check }}</view></template>';
  const good = '<template><text class="abi abi-16">{{ I.check }}</text><view class="x"><text class="abi abi-20">{{ I.rice }}</text></view></template>';
  // 嵌套 template：外层后面还有裸 {{ I }} —— 非贪婪截断会漏掉它（实测踩过）
  const nested = '<template><view class="a">{{ I.home }}</view><template v-if="x"><text>x</text></template><view class="b">{{ I.gear }}</view></template>';

  const b = probeGeneric(bad);
  const g = probeGeneric(good);
  const nn = probeGeneric(nested);
  const a1 = probeArrow('<template><text class="menu__arrow">›</text></template>');
  const a2 = probeArrow('<template><text class="menu__arrow"><text class="abi abi-16">{{ I.chev }}</text></text></template>');
  const a3 = probeArrow('<template><text class="card__link">全部流水 ›</text></template>');

  t.push(['必报样本 bare=1', b.bare === 1]);
  t.push(['必报样本 untiered=1', b.untiered === 1]);
  t.push(['必不报 bare=0', g.bare === 0]);
  t.push(['必不报 untiered=0', g.untiered === 0]);
  t.push(['嵌套截断：命中=2（非贪婪会漏 1）', nn.total === 2]);
  t.push(['嵌套截断：untiered=2', nn.untiered === 2]);
  t.push(['⑦ 独立裸箭头应报', a1 === 1]);
  t.push(['⑦ 独立带图标不应报', a2 === 0]);
  t.push(['⑦ 句内后缀不应报', a3 === 0]);

  // ②-c 必报：script 段直取字符表（ab-empty-state 的真实形态）
  t.push([
    '②-c script 直取字符表应报',
    probeCharTable('<script setup lang="ts">const ico = ABOX_ICON_CHARS[props.illustration];</script>') === 1,
  ]);
  // ②-c 必报：模板位直取字符表（同样逃过 ③ 的分母）
  t.push([
    '②-c 模板位直取字符表应报',
    probeCharTable('<template><text class="abi abi-deco-34">{{ ABOX_ICON_CHARS.box }}</text></template>') === 1,
  ]);
  // ②-c 必不报：单行 import 是唯一许可形态
  t.push([
    '②-c 单行 import 不应报',
    probeCharTable(
      '<script setup lang="ts">\nimport { ABOX_ICON_CHARS as I, type AboxIconName } from \'@abox/shared-utils\';\nconst x = I.box;\n</script>',
    ) === 0,
  ]);
  // ②-c 必不报：跨行花括号 import（按「行首是否 import」免检会在这里假阳性）
  t.push([
    '②-c 跨行 import 不应报',
    probeCharTable(
      '<script setup lang="ts">\nimport {\n  ABOX_ICON_CHARS as I,\n  type AboxIconName,\n} from \'@abox/shared-utils\';\nconst x = I.box;\n</script>',
    ) === 0,
  ]);
  // ②-c 必不报：注释里的提及（本仓库大量注释会点名该常量）
  t.push([
    '②-c 注释里的提及不应报',
    probeCharTable('<script setup lang="ts">\n// 不要写 ABOX_ICON_CHARS[x]，走别名\n/* ABOX_ICON_CHARS[y] */\nconst x = I.box;\n</script>') === 0,
  ]);

  let ok = true;
  let pass = 0;
  for (const [name, p] of t) {
    if (p) pass++;
    else ok = false;
    console.log(`   [自证] ${p ? 'OK ' : 'FAIL'} ${name}`);
  }
  console.log(`   [自证] 汇总 ${pass}/${t.length}`);
  // 顺带清理：自证不需要落盘文件（纯内存探针）
  const tmp = join(SRC, '__selftest_icon_lock.vue');
  if (existsSync(tmp)) rmSync(tmp, { force: true });
  return ok;
}

/* ---------------- 主流程 ---------------- */

function main() {
  if (process.argv.includes('--selftest')) {
    console.log('---- 自证 ----');
    return selftest() ? 0 : 2;
  }

  const files = walkVue(SRC);
  const results = files.map((f) => scanFile(f, relative(SRC, f).split(sep).join('/')));

  const collect = (k) => results.flatMap((r) => r[k]);
  const emoji = collect('emoji');
  const bare = collect('bare');
  const script = collect('script');
  const charTable = collect('charTable');
  const bareInterp = collect('bareInterp');
  const badTier = collect('badTier');
  const bareArrow = collect('bareArrow');
  const interpTotal = results.reduce((a, r) => a + r.interpTotal, 0);
  const tiered = results.reduce((a, r) => a + r.tiered, 0);
  const tierIssues = checkTiers();
  const ab = abIconState(files);

  const dump = (title, rows, fmt) => {
    console.log(`\n===== ${title}：${rows.length} =====`);
    for (const r of rows) console.log('  ' + fmt(r));
  };
  dump('① 渲染区真 emoji（必须 0）', emoji, (r) => `${r[0]}:${r[1]}  ${r[2]} ${r[3]}  | ${r[4]}`);
  dump('②-a 模板属性表达式里的 I.xxx（必须 0）', bare, (r) => `${r[0]}:${r[1]}  ${r[2]}  | ${r[3]}`);
  dump('②-b script 段里的 I.xxx（必须 0）', script, (r) => `${r[0]}:${r[1]}  ${r[2]}  | ${r[3]}`);
  dump('②-c 直取 ABOX_ICON_CHARS（import 除外，必须 0）', charTable, (r) => `${r[0]}:${r[1]}  | ${r[2]}`);
  dump('③ 未被档位包裹的 `{{ I... }}`（必须 0）', bareInterp, (r) => `${r[0]}:${r[1]}  ${r[2]}  class=${r[3]}  | ${r[4]}`);
  dump('④ 非法档位取值（必须 0）', badTier, (r) => `${r[0]}:${r[1]}  ${r[2]}`);
  dump('⑤ 档位定义偏差（必须 0）', tierIssues, (r) => r);
  dump('⑦ 独立箭头元素内的裸字形（必须 0）', bareArrow, (r) => `${r[0]}:${r[1]}  ${r[2]}  ${r[3]}  | ${r[4]}`);

  console.log(`\n③ 覆盖率：${tiered}/${interpTotal} 个模板插值图标被档位包裹`);
  console.log(`②-c 直取字符表：${charTable.length} 处（唯一许可形态 = import 语句）`);
  console.log(`⑥ ${ab.level === 'ok' ? 'OK' : ab.level === 'warn' ? 'WARN' : 'BAD'} ${ab.msg}`);

  const bad_ =
    emoji.length + bare.length + script.length + charTable.length + bareInterp.length + badTier.length + tierIssues.length + bareArrow.length + (ab.level === 'bad' ? 1 : 0);
  console.log(`\n${bad_ === 0 ? '✅ 全部通过' : `❌ 共 ${bad_} 项未达标`}`);
  return bad_ === 0 ? 0 : 1;
}

process.exit(main());

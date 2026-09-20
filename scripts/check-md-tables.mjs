#!/usr/bin/env node
/**
 * 文档表格完整性门禁：**Markdown 表格被空行截断**（2026-09-20 · M5-15）
 *
 * ## 为什么需要它
 *
 * GFM 里**表格遇空行即结束**。于是「表行 → 空行 → 表行」这种写法会让**空行之后的行
 * 退化成带竖线的普通段落** —— 源文件「看着像表」、渲染出来不是表，
 * 而 **markdownlint / prettier / 任何构建工具都不会报错**（`docs/` 还在 `.prettierignore` 里，
 * 连格式门禁都不覆盖它）。
 *
 * 实测（M5-15 收尾）：**同一类缺陷在两份契约文档里已有 4 处存量**
 *   · `ABox一盒开发里程碑计划v1.0.md` 变更记录表 **3 处**（v1.1.4 / v1.1.5 / v1.1.7 三行）——
 *     `---` 前多了空行，整表**裂成 4 段**，中间三段渲染成正文；
 *   · `ABox一盒接口规范v1.0.md` 修订表 **1 处**（「最近修订（M5-14）」整行被**粘在 M5-8 行尾**，
 *     同一行出现两个「最近修订」⇒ 该行在渲染时**多出两列**）。
 *
 * ⚠️ 这类缺陷**极易在「用编辑器追加表格行」时引入**：把新行锚在 `---` 或文末，
 *    插入点落在空行之后，缺陷当场产生。故**必须机械检查**，而不是靠人眼。
 *
 * ## 判据（⚠️ 粗判据有假阳性，见下）
 *
 * 粗判据：`L[k]===''` 且 `L[k-1]` 与 `L[k+1]` 都以 `|` 开头。
 * ⭐ **但两张表相邻是合法的**：`表A → 空行 → 表B(表头) → 表B(分隔行)`。
 *    实测 `ABox一盒接口规范v1.0.md` §6.8 就是这种形态（跑批时刻表 + 紧随的口径表），
 *    粗判据会**误报**它 —— 而**误报比漏报更快把人训练成忽略告警**。
 *    故最终判据追加一条排除：若 `L[k+2]` 是**分隔行**（`|---|`），则这是**两张表的分界**，放过。
 *    （被截断的那一行后面跟的是**另一条表行**，永远等不到分隔行。）
 *
 * ## 自带自证（恒绿的检查比没有检查更糟）
 *
 * 每次运行先跑 4 个合成样本：**分离行必报** · **两表相邻必不报** · **表头后紧跟正文不报** ·
 * **表尾后紧跟正文不报**。任一不符即 **exit 1**（检查器自身坏了，而不是文档坏了）。
 *
 * ## 范围
 *
 * 扫仓库内 `docs/*.md`（**仓库内唯一事实来源**，且**镜像与根文档字节一致** —— 由
 * `scripts/sync-docs.mjs` 保证、`verify-manifest.mjs` 复核）。刻意**不**直接读工作区根目录：
 * 那是仓库外的路径，CI checkout 里不存在，会让门禁在 CI 上行为不确定。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = join(ROOT, 'docs');

/** 分隔行：`| --- | --- |`（允许 `:` 对齐符与空格；必须含 `---`） */
function isSeparator(line) {
  if (typeof line !== 'string') return false;
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|') && t.includes('---') && /^\|[\s:|-]+$/.test(t);
}

/** 找出「被空行截断的表行」：返回**被截断那一行**的行号数组（1-based） */
export function findBrokenTables(text) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let k = 1; k < lines.length - 1; k++) {
    if (lines[k] !== '') continue;
    const prev = lines[k - 1];
    const next = lines[k + 1];
    if (!prev.startsWith('|') || !next.startsWith('|')) continue;
    // 两张表相邻：空行之后是「表头 + 分隔行」⇒ 合法分界
    if (isSeparator(lines[k + 2])) continue;
    // 报「被截断的那一行」（k+1 是空行号，k+2 才是渲染出错的那一行）
    hits.push(k + 2);
  }
  return hits;
}

/* ────────────────────────── 自证 ────────────────────────── */
function selfTest() {
  const cases = [
    {
      name: '被空行截断的表行 → 必报',
      text: ['| a | b |', '| --- | --- |', '| 1 | 2 |', '', '| 3 | 4 |', '| 5 | 6 |'].join('\n'),
      expect: [5],
    },
    {
      name: '两张表相邻（空行后是表头+分隔行）→ 不报',
      text: ['| a | b |', '| --- | --- |', '| 1 | 2 |', '', '| c | d |', '| --- | --- |', '| 3 | 4 |'].join(
        '\n',
      ),
      expect: [],
    },
    {
      name: '表头后紧跟正文 → 不报',
      text: ['| a | b |', '| --- | --- |', '| 1 | 2 |', '', '正文段落', '更多正文'].join('\n'),
      expect: [],
    },
    {
      name: '表尾后紧跟正文 → 不报',
      text: ['正文', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', '## 下一节'].join('\n'),
      expect: [],
    },
  ];
  let ok = true;
  for (const c of cases) {
    const got = findBrokenTables(c.text);
    const pass = JSON.stringify(got) === JSON.stringify(c.expect);
    if (!pass) ok = false;
    console.log(`  ${pass ? '✔' : '✘'} 自证：${c.name}  期望=[${c.expect}] 实得=[${got}]`);
  }
  return ok;
}

/* ────────────────────────── 主流程 ────────────────────────── */
console.log('文档表格完整性门禁（Markdown 表格空行截断）\n');
console.log('— 自证 —');
const selfOk = selfTest();
if (!selfOk) {
  console.log('\n✘ 检查器自证失败 —— 先修检查器，再谈文档。');
  process.exit(1);
}

let files;
try {
  files = readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();
} catch {
  console.log(`\n✘ 读不到 ${DOCS_DIR}`);
  process.exit(1);
}
if (files.length === 0) {
  console.log(`\n✘ ${DOCS_DIR} 下没有 .md（同步未跑？先 node scripts/sync-docs.mjs）`);
  process.exit(1);
}

console.log('\n— 扫描 —');
let total = 0;
const badFiles = [];
for (const f of files) {
  const text = readFileSync(join(DOCS_DIR, f), 'utf8');
  const hits = findBrokenTables(text);
  if (hits.length) {
    total += hits.length;
    badFiles.push(f);
    console.log(`✘ ${f}`);
    const lines = text.split(/\r?\n/);
    for (const n of hits) {
      console.log(`    @${n}  ← 本行被空行截断（表在此处断开，本行会渲染成正文）`);
      console.log(`        上表最后一行: ${(lines[n - 3] ?? '').slice(0, 70)}`);
      console.log(`        本行        : ${(lines[n - 1] ?? '').slice(0, 70)}`);
    }
  }
}

console.log(
  `\n扫描 ${files.length} 份 · 命中 ${total} 处` +
    (badFiles.length ? ` · 文件：${badFiles.join(' / ')}` : ' · 无表格截断 ✅'),
);
if (total) {
  console.log(
    '\n修法：删掉那条空行（新表行必须紧贴上一表行）；若确实是两张表，让「表头 + |---| 分隔行」紧跟空行。',
  );
  process.exit(1);
}
process.exit(0);

#!/usr/bin/env node
/**
 * ⛔ 小程序端「未受保护的裸调」防复发闸门 —— `mp:no-bare-call`
 *
 * ## 缺陷本体（P1-16）
 * 请求层 `api/request.ts` 对 `10002 / 401 / 20014` 是**无条件** `clearAuthStorage()`。
 * 一条**裸调**（不走 `useRequest` 的 `run()`、也没挂 `keepAuthState: true`）拿到旧 token 时，
 * 会把别的腿刚重登写进去的**新 token 删掉** ⇒ 用户悄无声息掉线。
 * 详见 `mp:auth-state` 门禁（`scripts/check-mp-auth-state.mjs`）里的运行时实证。
 *
 * ## 本闸门与 `mp:auth-state` 的分工（**不要**合并、也不要互相替代）
 *   · `mp:auth-state` —— **运行时**、**深**：编译真 SFC 跑真场景，**只覆盖已登记的 6 个页面**；
 *   · `mp:no-bare-call` —— **静态**、**宽**：全仓 34 个页面文件**无差别**扫描。
 * 前者证明「机制对」，后者保证「**没有漏网之页**」。判据窄而深 + 判据宽而浅，各司其职。
 *
 * ## 判据（唯一）
 *   小程序端任何一处 api 调用点，若**既未被 `run()` 包裹**、**又未传 `keepAuthState: true`**
 *   ⇒ 报 `文件:行` 并 EXIT≠0。当前期望 **0 处**。
 *
 * ⭐ 为什么这道**不是恒绿**（与「相位校核」那道的本质区别）：
 *     现在 0 处是**因为前端真的把 16 条腿都挂上了 flag**（本仓库的真实状态）；
 *     谁新加一个裸调忘了挂 flag ⇒ **立刻红并点名 `文件:行`**。判据有牙齿。
 *     反过来，相位校核那道（flag 是否落在正确的形参位）已被 `typecheck:mp` 的 `TS2353`
 *     兜住、且锚点失效会 fail-loud ⇒ 单开就是恒绿。**本闸门刻意不收那一部分。**
 *
 * ## ⛔ 只收「扫描」，不收「相位校核」—— 两者的命运不同，别捆
 *   扫描：现在绿、将来会红 ⇒ 有牙齿，收。
 *   相位（`f(params, options)` 被写成 `f({ keepAuthState: true })`）：
 *     `typecheck:mp`（`gate.mjs:99`）以 `TS2353` 拦下；`mp:auth-state` 的变异针按
 *     **精确源码文本**锚定，形参位一错 ⇒ `writeMutants` 零命中抛错 ⇒ 两层都已兜住。
 *     捆进来只会把恒绿的东西塞回门禁（见 `check-mp-auth-state.mjs` 文件头 :114-123）。
 *
 * ## 取真度与误报把关（静态分析的**已知**边界，写在这免得后人重复踩）
 *   ① **先按位剥注释再分析**（`/* *\/` 与 `//` 内容换成空格、保留长度与换行）
 *      ⇒ 行号仍可映射，且不会把注释里提到的调用点当成真调用。
 *      （实测：不剥注释会把 `mine.vue` 的 7 个 `run()` 点数扫成 13 —— 注释里提了 6 次。）
 *   ② **不把 `api/*.ts` 里的定义当调用点**：真扫描范围只有
 *      `pages/**\/*.vue` + `App.vue` + `components/**\/*.vue`。
 *      （实测：`http.get/post` 全仓只出现在 `api/*.ts`，若把 api 目录纳入扫描 ⇒ 约 70 条全假。）
 *   ③ **不把 `run()` 的回调体误判成裸调**：对每个 `run(` 求配平括号范围，
 *      调用点索引落在范围内 ⇒ 记为「已受 `run()` 保护」。
 *   ④ **认别名**：`const { run: runLogs } = useRequest()` 与 `const { run } = useRequest()` 同权。
 *   ⑤ **认 `keepAuthState: true`**：只写真值（`false` 与「整段不传」等价有害，不算已挂）。
 *      （实测：当前真源码 `keepAuthState: true` 27 处字面量 / `false` 0 处。）
 *
 * ## 已知局限（静态分析的下界，**不是**本闸门的缺陷，但要知道）
 *   · 二阶封装（把裸调包进一个自写函数）识别不了；
 *   · 「是否主干数据」是人工判断，机器只给 `文件:行`，不猜。
 *
 * ## 0 样本守卫
 *   扫到 0 个页面文件 / 0 个调用点 ⇒ **判 broken 并 EXIT=2**，绝不许当成「0 违规」放行
 *   （记忆：恒绿 / 恒红 / 恒 N/A 三种都等于没有检查）。
 *
 * 退出码：0 通过 · 1 有裸调 · 2 自证失败或样本为 0（**不静默放行**）
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'apps', 'miniprogram', 'src');

// ── 词法工具 ──────────────────────────────────────────────────────────────

/** 按位抹掉注释内容，保留长度与换行 ⇒ 索引仍能映射回原始行号 */
function stripComments(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src[i] === '/' && src[i + 1] === '/') {
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

/** 求从 openIdx（指向开括号）起的配平范围；不配平返回 -1 */
function balanced(src, openIdx, open = '(', close = ')') {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return [openIdx, i];
    }
  }
  return [openIdx, -1];
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (e.endsWith('.vue')) acc.push(p);
  }
  return acc;
}

// ── ① api 模块的导出函数（**定义侧**，绝不作为调用点扫描）─────────────────
function collectApiExports(apiDir) {
  const map = new Map(); // 'xxx.ts' -> Set(fnName)
  if (!existsSync(apiDir)) return map;
  for (const f of readdirSync(apiDir)) {
    if (!f.endsWith('.ts')) continue;
    const src = stripComments(readFileSync(join(apiDir, f), 'utf8'));
    const set = new Set();
    const re = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;
    let m;
    while ((m = re.exec(src))) set.add(m[1]);
    map.set(f, set);
  }
  return map;
}

// ── ② 扫描：唯一的判据真源（自证与主流程**共用**，禁止各写一份）─────────────
/**
 * @param {string} srcRoot 小程序 `src` 根目录
 * @returns {{ok:boolean, reason?:string, files:number, total:number,
 *            runWrapped:number, flagged:number, bare:Array<{file:string,line:number,fn:string,kind:string}>,
 *            httpDirect:number}}
 *   `ok=false` 表示**样本为空**（目录缺失 / 0 文件 / 0 调用点）⇒ 调用方必须 EXIT=2。
 */
// ⭐ **导出**扫描函数：取证脚本（如用 `git show` 取改动前的页面复现判据）必须**复用同一个函数**，
//    绝不允许另抄一份判据 —— 抄一份就等于「判据改了而取证脚本不知道」。
export function scanBareCalls(srcRoot) {
  const apiDir = join(srcRoot, 'api');
  const apiExports = collectApiExports(apiDir);

  const files = [
    ...walk(join(srcRoot, 'pages')),
    join(srcRoot, 'App.vue'),
    ...walk(join(srcRoot, 'components')),
  ].filter((p) => existsSync(p));

  if (!existsSync(srcRoot)) return failTree(`src 目录不存在：${srcRoot}`);
  if (files.length === 0) return failTree(`${relative(ROOT, srcRoot)} 下未扫到任何 .vue 文件`);

  let total = 0;
  let runWrapped = 0;
  let flagged = 0;
  let httpDirect = 0;
  const bare = [];

  for (const file of files) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const rel = relative(srcRoot, file).replace(/\\/g, '/');

    // ②-1 api 引入映射：localName -> {mod, name}
    const imports = new Map();
    const impRe = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]*(?:^|\/)api\/[^'"]*)['"]/g;
    let m;
    while ((m = impRe.exec(src))) {
      const mod = (m[2].split('/').pop() || '') + '.ts';
      for (let part of m[1].split(',')) {
        part = part.trim();
        if (!part) continue;
        const [orig, alias] = part.split(/\s+as\s+/).map((x) => x.trim());
        imports.set(alias || orig, { mod, name: orig });
      }
    }

    // ②-2 `useRequest()` 的 run 别名
    const runNames = new Set(['run']);
    const useReqRe = /const\s*\{([^}]*)\}\s*=\s*useRequest\s*\(/g;
    while ((m = useReqRe.exec(src))) {
      for (let part of m[1].split(',')) {
        part = part.trim();
        if (!part) continue;
        const [orig, alias] = part.split(':').map((x) => x.trim());
        if (orig === 'run') runNames.add(alias || 'run');
      }
    }

    // ②-3 所有 run(...) 的配平范围（**含回调体**：`run(() => fetchX())` ⇒ fetchX 受保护）
    const runRanges = [];
    for (const rn of runNames) {
      const re = new RegExp(`(?<![.\\w])${rn}\\s*\\(`, 'g');
      let mt;
      while ((mt = re.exec(src))) {
        const [a, b] = balanced(src, mt.index + mt[0].length - 1);
        if (b > 0) runRanges.push([a, b]);
      }
    }

    // ②-4 逐个调用点分类
    for (const [local, info] of imports) {
      const exported = apiExports.get(info.mod);
      // 引入的不是 api 模块的导出函数（例如从 api 目录引了类型）⇒ 不参与
      if (!exported || !exported.has(info.name)) continue;
      const re = new RegExp(`(?<![.\\w])${local}\\s*\\(`, 'g');
      let mt;
      while ((mt = re.exec(src))) {
        const openIdx = mt.index + mt[0].length - 1;
        const [a, b] = balanced(src, openIdx);
        if (b < 0) continue;
        total++;
        const args = src.slice(a + 1, b);
        const wrapped = runRanges.some(([ra, rb]) => mt.index >= ra && mt.index <= rb);
        const hasFlag = /keepAuthState\s*:\s*true/.test(args);
        if (wrapped) {
          runWrapped++;
        } else if (hasFlag) {
          flagged++;
        } else {
          bare.push({
            file: rel,
            line: lineOf(src, mt.index),
            fn: `${local}()`,
            kind: '裸调 api',
          });
        }
      }
    }

    // ②-5 页面里直连 `http.*`（绕开 api 层 ⇒ 连 flag 都无处可挂，比裸调更糟）
    const httpRe = /(?<![.\w])http\s*\.\s*(get|post|put|patch|delete|request)\s*\(/g;
    let ht;
    while ((ht = httpRe.exec(src))) {
      httpDirect++;
      bare.push({
        file: rel,
        line: lineOf(src, ht.index),
        fn: `http.${ht[1]}()`,
        kind: '页面直连 http（未经 api 层）',
      });
    }
  }

  if (total === 0) return failTree('扫到 0 个 api 调用点 ⇒ 判据空转（不许当「0 违规」放行）');

  return { ok: true, files: files.length, total, runWrapped, flagged, bare, httpDirect };

  function failTree(reason) {
    return {
      ok: false,
      reason,
      files: 0,
      total: 0,
      runWrapped: 0,
      flagged: 0,
      bare: [],
      httpDirect: 0,
    };
  }
}

// ── 自证（无条件前置跑：恒绿的检查比没有检查更糟）────────────────────────────
function selftest() {
  const cases = [];
  const base = join(tmpdir(), `abox-mp-no-bare-call-${Date.now()}`);
  try {
    // ── 造一个**最小可运行**的临时小程序 src：含 api 定义 + 一个页面 ──
    const srcRoot = join(base, 'apps', 'miniprogram', 'src');
    mkdirSync(join(srcRoot, 'api'), { recursive: true });
    mkdirSync(join(srcRoot, 'pages', 'demo'), { recursive: true });
    writeFileSync(
      join(srcRoot, 'api', 'demo.ts'),
      "import { http } from './request';\n" +
        'export function fetchDemoA(params: any, options?: any) { return http.get("/a", options); }\n' +
        'export function fetchDemoB(params: any, options?: any) { return http.get("/b", options); }\n' +
        'export function fetchDemoC(params: any, options?: any) { return http.get("/c", options); }\n' +
        'export function fetchDemoD(params: any, options?: any) { return http.get("/d", options); }\n',
    );
    writeFileSync(
      join(srcRoot, 'pages', 'demo', 'demo.vue'),
      [
        "<script setup lang='ts'>",
        "import { fetchDemoA, fetchDemoB, fetchDemoC, fetchDemoD } from '@/api/demo';",
        "import { http } from '@/api/request';",
        'const { run } = useRequest(async () => 1);',
        '',
        '// ① 受 run() 保护（含回调体）⇒ 必不报',
        'function safe() { return run(() => fetchDemoA({})); }',
        '',
        '// ② 挂了 flag ⇒ 必不报',
        'async function flagged() { return fetchDemoB({}, { keepAuthState: true }); }',
        '',
        '// ③ 裸调 ⇒ 必报',
        'async function bare() { return fetchDemoC({}); }',
        '',
        '// ④ 页面直连 http ⇒ 必报',
        'async function raw() { return http.get("/x"); }',
        '',
        '// ⑤ flag 写成 false ⇒ 等价有害，必报',
        'async function wrong() { return fetchDemoD({}, { keepAuthState: false }); }',
        '</script>',
      ].join('\n'),
    );

    const r = scanBareCalls(srcRoot);

    // ① 必报：裸调 api（1 处）
    cases.push([
      '① 必报：裸调 api 调用点被报出',
      r.ok && r.bare.filter((b) => b.kind === '裸调 api' && b.fn === 'fetchDemoC()').length === 1,
    ]);
    // ② 必报：页面直连 http（1 处）
    cases.push([
      '② 必报：页面直连 http.* 被报出',
      r.ok && r.bare.filter((b) => b.fn === 'http.get()').length === 1,
    ]);
    // ③ 必报：`keepAuthState: false` 不算已挂（等价于整段不传）
    cases.push([
      '③ 必报：keepAuthState: false 不被当成「已挂 flag」',
      r.ok && r.bare.filter((b) => b.fn === 'fetchDemoD()').length === 1,
    ]);
    // ④ 必不报 + 分类正确：run() 包裹的 1 处、挂 flag 的 1 处，**都不进 bare**
    cases.push([
      '④ 必不报：run() 回调体不被误判成裸调（且计入 runWrapped=1）',
      r.ok && r.runWrapped === 1 && !r.bare.some((b) => b.fn === 'fetchDemoA()'),
    ]);
    cases.push([
      '⑤ 必不报：挂 keepAuthState: true 的不报（且计入 flagged=1）',
      r.ok && r.flagged === 1 && !r.bare.some((b) => b.fn === 'fetchDemoB()'),
    ]);
    // ⑥ 分母对得上：4 个调用点 = 1 run + 1 flag + 2 裸调中的 api 部分 + 1 http
    cases.push([
      '⑥ 判据：分类无吞字（total = run + flag + 裸调api）',
      r.ok && r.total === 4 && r.runWrapped + r.flagged + r.bare.filter((b) => b.kind === '裸调 api').length === 4,
    ]);

    // ⑦ 必不报：真实未改动的源码（当前 0 裸调，且样本非 0）
    const real = scanBareCalls(SRC);
    cases.push([
      `⑦ 必不报：真实 src（${real.total} 调用点）当前 0 裸调`,
      real.ok && real.total > 0 && real.bare.length === 0,
    ]);

    // ⑧ 判据：srcRoot 不存在 ⇒ ok=false（绝不能被当成「0 违规」放行）
    cases.push(['⑧ 判据：目录不存在 ⇒ ok=false', scanBareCalls(join(base, 'no-such-dir')).ok === false]);

    // ⑨ 判据：目录存在但 0 调用点 ⇒ ok=false（0 样本守卫）
    const emptyRoot = join(base, 'empty-src');
    mkdirSync(join(emptyRoot, 'pages'), { recursive: true });
    writeFileSync(join(emptyRoot, 'pages', 'blank.vue'), '<template><view/></template>\n');
    cases.push(['⑨ 判据：0 调用点 ⇒ ok=false（不许当通过）', scanBareCalls(emptyRoot).ok === false]);
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

// ⭐ ESM main guard：本文件被**取证脚本 import** 时只复用 `scanBareCalls`，不跑自证与主流程
//    （否则 `process.exit` 会把取证脚本一起带走）。`gate.mjs` 以 `node scripts/check-mp-bare-call.mjs`
//    调用 ⇒ `argv[1]` 命中 ⇒ 正常跑。
const IS_MAIN = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN) {
  selftest();
  main();
}

// ── 主流程 ────────────────────────────────────────────────────────────────
function main() {
  const r = scanBareCalls(SRC);
  if (!r.ok) {
    console.log(`✘ 扫描样本为空：${r.reason}`);
    console.log('  0 样本时本闸门**不许**报通过（恒绿 = 没有检查）；请确认 src 路径与文件后缀。');
    process.exit(2);
  }

  console.log(
    `③ 覆盖面：${r.files} 个页面文件 · ${r.total} 个 api 调用点` +
      `（${r.runWrapped} run() / ${r.flagged} flag / ${r.bare.length} 裸调）`,
  );

  if (r.bare.length > 0) {
    console.log(`✘ 未受保护的调用点 ${r.bare.length} 处：`);
    for (const b of r.bare) console.log(`  - ${b.file}:${b.line}  ${b.fn}  ${b.kind}`);
    console.log(
      '\n⛔ 裸调拿到旧 token 时会把重登刚写进去的新 token 清掉（P1-16）。修法二选一：\n' +
        '   · 能重登重试的 ⇒ 包进 `useRequest()` 的 `run()`；\n' +
        '   · 只取数、无权裁决 session 的 ⇒ 末参传 `{ keepAuthState: true }`。\n' +
        '   ⚠️ `keepAuthState: false` 与「整段不传」等价有害，不算已挂。',
    );
    process.exit(1);
  }

  console.log(
    `✔ 未受保护的裸调 0 处（${r.total} 个调用点：${r.runWrapped} 走 run() · ${r.flagged} 挂 flag）`,
  );
}

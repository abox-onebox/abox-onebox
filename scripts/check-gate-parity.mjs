#!/usr/bin/env node
/**
 * 门禁清单一致性（CI ↔ `gate.mjs` ↔ 文档条数）—— 对应 `gate.mjs` 的门禁 `gate:parity`
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 本项目反复出现的横向根因只有一条：**同一件事有 N 份表述，而不被自动化执行的那一份必然悄悄错掉**。
 * 本脚本治的是「门禁清单本身」被抄成两份：
 *
 *   ① `.github/workflows/ci.yml` 自工程仓重建（`0e9552e`）后**一次都没改过**，
 *      里面另写了一套 `pnpm lint / typecheck / test / build:*` 步骤，与本地
 *      `scripts/gate.mjs` 是**同一件事的两份表述**。CI 那份**缺** 8 道：
 *        schema:parity · index:parity · route:audit · security:scan ·
 *        nav:consistency · doc:tables · dup:const · state:audit
 *      ⇒ 这 8 道在 CI 从来没跑过；而往 `gate.mjs` 里加门禁也**不会**传到 CI。
 *      ⇒ 结论：在这种状态下 **CI 的绿灯不构成任何证据**（本地绿、CI 装作绿）。
 *
 *   ② 同一份 ci.yml 把 `NODE_VERSION` 写死 `20`，而 e2e 验收脚本用 `node:sqlite`
 *      （Node ≥ 22.5 才有）⇒ 「CI 跑 e2e」此前只是**一句声明**，从未真的跑过。
 *
 *   ③ 另一类同族高发病：**条数写死在多处**。文档里「`all` 18 道」这类数字
 *      每加一道门禁就会悄悄过期，而**没有任何工具会报错**。这里改为
 *      「文档写一个显式标记 + 本脚本与实算值比对」——数字只有**一个**真源（`gate.mjs`）。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────────
 *   ① CI 只许通过 `node scripts/gate.mjs <别名>` 调门禁；且 `all` 与 `verify`
 *      必须**全覆盖**到 `gate.mjs` 里实际存在的门禁（漏一道即红）。
 *   ② CI 的 `run:` 行里**不得**再出现逐包门禁命令（`pnpm lint|typecheck|test|build*`、
 *      裸 `eslint` / `jest` / `tsc` / `vue-tsc` / `prettier` / `nest build` / `vite build` /
 *      `uni build`）—— 那就是「第二份清单」的起点。
 *      唯一放行 `pnpm install*`（装依赖不是门禁）。
 *   ③ `MARKED_DOCS` 里的每个文档必须带上**与实算一致**的条数标记：
 *        <!-- gate-count: all=20 verify=4 -->
 *      （标记由本脚本消费；文档正文其余地方一律**不要再写死条数**。）
 *
 * ── 自证（必做，恒绿的检查比没有检查更糟）────────────────────────────────────
 * 内置 6 个合成样本：「必报的报得出 / 必不报的不报」，任一侧不符即 **exit 2**。
 *
 * 退出码：0 通过 · 1 有违规 · 2 自证失败（检查器自身坏掉 ⇒ 显式失败，不静默放行）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CI_PATH = join(ROOT, '.github', 'workflows', 'ci.yml');

/**
 * 必须携带条数标记的文档（仓库内镜像；CI checkout 里也存在）
 *
 * ⚠️ **刻意只有一处** —— 这本身就是本门禁要治的病：数字写死在多处，改一处就悄悄错。
 * 条数的唯一真源是 `gate.mjs`，文档侧只允许**一个**声明点（《本地开发手册》§6.1），
 * 其余文档要提条数一律**写指针**（指向手册），不写数字。
 */
const MARKED_DOCS = ['docs/ABox一盒本地开发手册v1.0.md'];

const MARKER_RE = /<!--\s*gate-count:\s*all=(\d+)\s+verify=(\d+)\s*-->/;

/** ⚠️ 反向判据：这些形态一出现就说明「又抄了一份门禁清单」 */
const FORBIDDEN = [
  {
    re: /\bpnpm\s+(?!install\b)(lint|typecheck|test|format|format:check|build)(?::[a-z-]+)?\b/,
    why: '逐包 pnpm script 是本地 `gate.mjs` 的重复表述',
  },
  {
    re: /(^|[\s'"/])(eslint|vue-tsc|tsc|jest|prettier)(\s|$)/,
    why: '裸调门禁工具绕过了 `gate.mjs` 的统一 env / outDir 处置',
  },
  { re: /(^|[\s'"/])(nest|vite)\s+build(\s|$)/, why: '三端构建应走 `gate.mjs build:api|build:admin' },
  { re: /(^|[\s'"/])uni\s+build(\s|$)/, why: '小程序构建应走 `gate.mjs build:mp`' },
];

// ─────────────────────────────────────────────────────────────────────────────
// 真源：由 `gate.mjs --json` 自报（门禁清单的唯一真源就是它）
// ─────────────────────────────────────────────────────────────────────────────
function loadTruth() {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'gate.mjs'), '--json'], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  if (r.status !== 0 || !r.stdout) {
    throw new Error(`无法读取门禁真源：gate.mjs --json 退出码 ${r.status} ${(r.stderr ?? '').slice(0, 200)}`);
  }
  return JSON.parse(r.stdout.trim());
}

/** 展开门禁名（别名 → 具体门禁）；未知名字原样返回，交由调用方判未知 */
function expandNames(names, truth) {
  const out = [];
  for (const n of names) {
    const list = truth.aliases[n];
    for (const x of list ?? [n]) if (!out.includes(x)) out.push(x);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 判据实现（纯函数：吃文本、吐发现 —— 便于用合成样本自证）
// ─────────────────────────────────────────────────────────────────────────────

/** ① CI 覆盖：调了哪些别名、是否覆盖 `all` + `verify` */
function checkCiCoverage(ciText, truth) {
  const used = [...ciText.matchAll(/gate\.mjs[ \t]+([A-Za-z:_-]+)/g)].map((m) => m[1]);
  const out = [];
  if (!used.length) {
    out.push('CI 里没有任何 `node scripts/gate.mjs …` 调用 —— 门禁在 CI 里等于不存在');
    return out;
  }
  const known = new Set([...truth.gates, ...Object.keys(truth.aliases)]);
  for (const u of used) if (!known.has(u)) out.push(`CI 调用了不存在的门禁 / 别名：\`${u}\``);

  const covered = new Set(expandNames(used, truth));
  for (const alias of ['all', 'verify']) {
    const missing = (truth.aliases[alias] ?? []).filter((g) => !covered.has(g));
    if (missing.length) {
      out.push(`CI 未覆盖 \`${alias}\` 里的 ${missing.length} 道门禁：${missing.join(' / ')}`);
    }
  }
  return out;
}

/** ② CI 不得另抄一份门禁清单 */
function checkCiNoDuplicate(ciText) {
  const out = [];
  const runs = [...ciText.matchAll(/^[ \t]*(?:-[ \t]*)?run:[ \t]*(.+)$/gm)].map((m) => m[1].trim());
  for (const line of runs) {
    if (/^pnpm\s+install\b/.test(line)) continue; // 装依赖不是门禁
    if (/gate\.mjs/.test(line)) continue; // 正规路径
    for (const { re, why } of FORBIDDEN) {
      if (re.test(line)) out.push(`CI 里出现了逐条门禁命令 \`${line}\` —— ${why}；应改为 \`node scripts/gate.mjs <别名>\``);
    }
  }
  return out;
}

/** ③ 文档条数标记与实算一致 */
function checkDocMarker(docText, truth, label) {
  const m = docText.match(MARKER_RE);
  const want = { all: truth.aliases.all?.length ?? 0, verify: truth.aliases.verify?.length ?? 0 };
  if (!m) {
    return [
      `${label} 缺少条数标记（应写入 \`<!-- gate-count: all=${want.all} verify=${want.verify} -->\`）` +
        `，或删掉正文里写死的条数`,
    ];
  }
  const got = { all: Number(m[1]), verify: Number(m[2]) };
  if (got.all !== want.all || got.verify !== want.verify) {
    return [
      `${label} 的条数标记已过期：写的是 all=${got.all} verify=${got.verify}，` +
        `实算是 all=${want.all} verify=${want.verify}（真源 = gate.mjs，请更新标记）`,
    ];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// 自证：断言「必报的报得出 / 必不报的不报」
// ─────────────────────────────────────────────────────────────────────────────
const SYNTH_TRUTH = {
  gates: ['lint', 'jest', 'b', 'c', 'e2e'],
  aliases: { all: ['lint', 'jest', 'b', 'c'], verify: ['e2e'], shared: [] },
};

function selfTest() {
  const bad = [];
  const t = (name, cond, detail = '') => {
    if (!cond) bad.push(`${name}${detail ? `（${detail}）` : ''}`);
  };
  const runs = (text) => text.split('\n').map((c) => `      - run: ${c}`).join('\n');

  // ① 必不报：完整覆盖
  t(
    '① 完整覆盖应通过',
    checkCiCoverage(runs('node scripts/gate.mjs all\nnode scripts/gate.mjs verify'), SYNTH_TRUTH).length === 0,
  );
  // ① 必报：漏掉 verify
  t(
    '① 漏 verify 应报出',
    checkCiCoverage(runs('node scripts/gate.mjs all'), SYNTH_TRUTH).some((x) => /未覆盖 `verify`/.test(x)),
  );
  // ① 必报：完全没有 gate.mjs 调用
  t('① 无任何调用应报出', checkCiCoverage(runs('pnpm lint'), SYNTH_TRUTH).length > 0);

  // ② 必不报：gate.mjs + pnpm install
  t(
    '② 正规路径 + install 应不报',
    checkCiNoDuplicate(runs('pnpm install --frozen-lockfile\nnode scripts/gate.mjs all')).length === 0,
  );
  // ② 必报：pnpm lint
  t('② pnpm lint 应报出', checkCiNoDuplicate(runs('pnpm lint')).length === 1);
  // ② 必报：裸 jest
  t('② 裸 jest 应报出', checkCiNoDuplicate(runs('npx jest --ci')).length === 1);
  // ② 必不报：注释行里的历史描述（不是 run: 行）
  t('② 注释里的 pnpm lint 应不报', checkCiNoDuplicate('# 旧 CI 曾写 pnpm lint / tsc\n      - run: node scripts/gate.mjs all').length === 0);

  // ③ 必报：标记过期 / 缺失
  t('③ 标记过期应报出', checkDocMarker('<!-- gate-count: all=3 verify=1 -->', SYNTH_TRUTH, '样本').length === 1);
  t('③ 标记缺失应报出', checkDocMarker('没有任何标记', SYNTH_TRUTH, '样本').length === 1);
  // ③ 必不报：标记正确
  t('③ 标记正确应不报', checkDocMarker('<!-- gate-count: all=4 verify=1 -->', SYNTH_TRUTH, '样本').length === 0);

  if (bad.length) {
    console.error('✘ 门禁自证失败（检查器本身不可信，拒绝给出结论）：');
    for (const b of bad) console.error(`   · ${b}`);
    process.exit(2);
  }
  console.log(`✔ 自证 10/10：必报的报得出、必不报的不报（合成样本）`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────
selfTest();

if (!existsSync(CI_PATH)) {
  console.error(`✘ 找不到 CI 配置：${CI_PATH} —— 「CI 与本地跑同一套门禁」无从保证`);
  process.exit(1);
}

const truth = loadTruth();
const ciText = readFileSync(CI_PATH, 'utf8');

const findings = [...checkCiCoverage(ciText, truth), ...checkCiNoDuplicate(ciText)];

for (const rel of MARKED_DOCS) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) {
    findings.push(`${rel} 不存在 —— 它是「门禁条数」的唯一文档载体，被删即等于数字无人看守`);
    continue;
  }
  findings.push(...checkDocMarker(readFileSync(p, 'utf8'), truth, rel));
}

const nAll = truth.aliases.all?.length ?? 0;
const nVerify = truth.aliases.verify?.length ?? 0;

if (findings.length) {
  console.error(`✘ 门禁清单不一致（${findings.length} 项）：`);
  for (const f of findings) console.error(`   · ${f}`);
  console.error(
    '\nℹ 处置：① 门禁只加到 `scripts/gate.mjs` 的 `GATES` / `ALIASES`；' +
      '② CI 只调 `node scripts/gate.mjs <别名>`；③ 文档只改条数标记。',
  );
  process.exit(1);
}

console.log(
  `✔ 门禁清单一致：定义 ${truth.gates.length} 道 · \`all\` ${nAll} 道 · \`verify\` ${nVerify} 道 · ` +
    `CI 已全覆盖且无重复表述 · 文档标记 ${MARKED_DOCS.length}/${MARKED_DOCS.length} 对齐`,
);

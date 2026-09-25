#!/usr/bin/env node
/**
 * e2e「错误码断言必须配套 message 断言」门禁 —— 对应 `gate.mjs` 的门禁 `e2e:msg`
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 《整体回归 2026-09-25》查出：e2e 脚本里存在大量**只断言 code、不断言 message** 的断言点。
 * 这种断言是**恒绿**的 —— 后端 `ERROR_MESSAGE` 映射缺失时：
 *   · HTTP 照旧返回那个 code ⇒ `assert(x.body?.code === 10001)` **照样通过**；
 *   · 而用户看到的是 `biz.exception.ts` 的兜底「业务异常」四个字，原因文案一个字都没有。
 * 也就是说：**代码里绿着、用户那里坏着，而没有任何一条失败路径**。
 *
 * 本轮已手工补齐 m3 136 处 / m2 9 处 / m1 7 处，三份脚本残留归零。
 * ⚠️ 但「补完」不是一个终态 —— 下次有人新增用例，最顺手的写法仍然是
 *    `assert(r.body?.code === 10001, 'xxx')`（写的人当时看得到 message，下一个看的人看不到）。
 * 故把判据固化成门禁：**是唯一能让这条教训活过本次对话的办法**。
 *
 * 它与 `errcode:message`（2026-09-25 同批）是**互补的两端**：
 *   · `errcode:message` 治「后端**没给**文案」（声明 ↔ 映射）；
 *   · `e2e:msg`       治「前端**没验**文案」（测试 ↔ 断言）。
 * 只做前者，文案缺失仍然可能绕过 e2e —— 因为 e2e 从未问过这个问题。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────────
 *   ① 正则 `/\.body\?\.code\s*(===|!==)\s*(\d+)/g` 捞出全部 code 比较点
 *      （`\s` 含换行 ⇒ **多行写法**也算命中，不会因为换行而静默漏掉）；
 *   ② 比较的数字为 `0` → **跳过**（成功态无人关心 message，`code === 0` 的断言无文案可言）；
 *   ③ 其余为「非零 code 断言点」，必须**配套**才放过：
 *        后续 1600 字符内出现 `.body?.message`  **或**  前置 400 字符内出现 `.body?.message`
 *      ⚠️ **前置窗口必须留**：本轮修复把内联 `(await call(...))` 提前 hoist 成了
 *         `const probeMsg123 = await call(...)` 再断言 —— 那个 const 落在断言**之前**，
 *         没有前置窗口就会把它们全判成残留（反过来又会逼人放宽判据 ⇒ 恒绿）。
 *   ④ 未配套的记残留，逐条输出 `文件:行号` + 上下文（截断 110 字符）——
 *      **只报「缺 N 条」等于没报**，必须能让人照着改。
 *
 * ⚠️ 判据边界（刻意**不放宽**，放宽到「整个文件出现过 `.body?.message` 就算覆盖」
 *    这道门禁立刻变成恒绿，等于没有）：窗口按**字符数**而非行数/整文件算，
 *    目的是要求「这条 code 断言**旁边**就有 message 断言」，而不是「别处有人写过」。
 *
 * ── 自证（本项目硬纪律：没有自证的检查等于没有检查）───────────────────────────
 * `node scripts/check-e2e-message-assert.mjs --selftest`（主流程**每次也会自动先跑一遍**，
 * 判据自身坏了就先红 —— 与 `check-error-code-message.mjs` 同款）：
 *   · **必报**：把三份**真实** e2e 脚本读到**内存副本**，各注入一处「断言非零 code
 *     但无配套 message 断言」的代码 ⇒ 必须报出、且**点名**那一处（注入只落内存，**不写磁盘**）；
 *   · **必不报**：磁盘上未改动的同一批真实脚本 ⇒ 必须残留 0、exit 0；
 *   · **反恒绿**：任一文件「非零 code 比较点 == 0」也算失败 —— 0 个点 ⇒ 残留必然 0，
 *     那正是本项目反复踩的「看起来绿的结论」（文件被移走 / 正则失效都会是这个形态）。
 * 任一条不符即 **exit 1**。
 *
 * 退出码：0 通过 · 1 有残留或自身不可信
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 被测目标（相对仓库根）—— 刻意**不扫全仓**：判据只对这三份 e2e 脚本成立 */
const TARGETS = ['scripts/e2e-m1.mjs', 'scripts/e2e-m2.mjs', 'scripts/e2e-m3.mjs'];

/** 后续窗口（字符数）：message 断言通常就写在同一次 assert 的条件里或紧随其后 */
const WINDOW_AFTER = 1600;
/** 前置窗口（字符数）：容纳被 hoist 到断言之前的 `const probeXxx = await call(...)` */
const WINDOW_BEFORE = 400;

/** 上下文截取：断言点前 90 字符 + 后 30 字符，最终截断到 110 字符 */
const CTX_LEAD = 90;
const CTX_TAIL = 30;
const CTX_MAX = 110;

const MSG_TOKEN = '.body?.message';

/** 注入样本里的锚点标记：自证用它确认「报出来的正是注进去的那一处」 */
const INJECT_MARK = 'E2E-MSG-GATE-SELFTEST';

/**
 * 主判据（纯函数：吃源码、吐结果 —— 便于用注入样本自证）
 *
 * @returns {{ total: number, residual: Array<{line:number, op:string, num:string, ctx:string}> }}
 */
function scanSource(src) {
  const re = /\.body\?\.code\s*(===|!==)\s*(\d+)/g;
  const residual = [];
  let total = 0;

  let m;
  while ((m = re.exec(src)) !== null) {
    const [, op, num] = m;
    if (num === '0') continue; // ② 成功态不需要 message
    total += 1;

    const start = m.index;
    const end = start + m[0].length;
    const after = src.slice(end, end + WINDOW_AFTER);
    const before = src.slice(Math.max(0, start - WINDOW_BEFORE), start);
    if (after.includes(MSG_TOKEN) || before.includes(MSG_TOKEN)) continue;

    let ctx = src
      .slice(Math.max(0, start - CTX_LEAD), end + CTX_TAIL)
      .replace(/\s+/g, ' ')
      .trim();
    if (ctx.length > CTX_MAX) ctx = ctx.slice(-CTX_MAX);

    residual.push({ line: src.slice(0, start).split('\n').length, op, num, ctx });
  }
  return { total, residual };
}

/** 读一份目标文件；缺失/读不动 ⇒ 抛（属于「跑不起来」，绝不允许被当作通过） */
function readTarget(relPath) {
  const abs = resolve(ROOT, relPath);
  if (!existsSync(abs)) throw new Error(`找不到被测文件：${relPath}`);
  return readFileSync(abs, 'utf8');
}

/** 统一显示相对路径（Windows 下 `path.relative` 产出 `\`，对齐成 `/`） */
const displayPath = (abs) => relative(ROOT, abs).split(sep).join('/');

// ─────────────────────────────────────────────────────────────────────────────
// 自证：必报的报得出（且点名）/ 必不报的不报 / 点数不能为 0
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 把注入样本接在文件尾部。
 * ⚠️ 中间垫 500 个换行（> WINDOW_BEFORE=400）：确保**前置窗口里没有** `.body?.message`，
 *    否则注入点会被文件尾部的真实 message 断言「顺手覆盖」⇒ 必报样本反而报不出 ⇒ 自证失去意义。
 *    注入点位于文件末端 ⇒ 后窗口同样是干净的。
 *    ⚠️ 追加内容**只会延长**已有断言点的后窗口，不会抽掉任何已有覆盖 ⇒ 既有残留数不变。
 */
const INJECT_LINE = `  assert(probeGateMsgCase.body?.code === 10001, '${INJECT_MARK} 注入样本', '');`;
const injectResidual = (src) => `${src}\n${'\n'.repeat(500)}${INJECT_LINE}\n`;

function selfTest() {
  const bad = [];
  let checks = 0;
  const t = (name, cond, detail = '') => {
    checks += 1;
    if (!cond) bad.push(`${name}${detail ? `（${detail}）` : ''}`);
  };

  for (const rel of TARGETS) {
    // 磁盘上的真实文件**只读**，注入只发生在内存副本里
    const src = readTarget(rel);
    const clean = scanSource(src);

    // ① 必不报：真实且未改动的输入 ⇒ 零残留
    t(`① [${rel}] 真实脚本必须零残留`, clean.residual.length === 0, `实际 ${clean.residual.length} 处`);

    // ② 反恒绿：比较点数为 0 ⇒ 判据已失效（正则错 / 文件被搬走），不许给出绿结论
    t(`② [${rel}] 非零 code 比较点不得为 0`, clean.total > 0, `实际 ${clean.total}`);

    // ③ 必报且点名：注入一处「断言非零 code、无配套 message 断言」
    const dirty = scanSource(injectResidual(src));
    t(`③ [${rel}] 注入一处必须多出一个比较点`, dirty.total === clean.total + 1, `${clean.total} → ${dirty.total}`);
    const named = dirty.residual.filter((r) => r.ctx.includes(INJECT_MARK));
    t(`③ [${rel}] 注入处必须被报出且**点名**`, named.length === 1, `命中 ${named.length} 处`);
    t(
      `③ [${rel}] 注入不得牵连出其它残留`,
      dirty.residual.length === 1,
      `残留 ${dirty.residual.length} 处：${dirty.residual.map((r) => r.line).join(',')}`,
    );
    if (named.length === 1) {
      t(`③ [${rel}] 注入处需给出行号`, Number.isInteger(named[0].line) && named[0].line > 0, `L${named[0].line}`);
    }
  }

  if (bad.length) {
    console.error('✘ e2e message 断言门禁自证失败（判据自身不可信，拒绝给出结论）：');
    for (const b of bad) console.error(`   · ${b}`);
    return false;
  }
  console.log(`✔ 自证 ${checks}/${checks}：必报的报得出（且点名）· 必不报的不报 · 比较点数非 0`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────
const SELFTEST = process.argv.includes('--selftest');

try {
  if (!selfTest()) process.exit(1);
  if (SELFTEST) process.exit(0); // 只跑自证：上面已全绿
} catch (e) {
  console.error(`✘ e2e message 断言门禁自证跑不起来：${e?.message ?? e}`);
  process.exit(1);
}

const perFile = [];
let grandTotal = 0;
let grandResidual = 0;

for (const rel of TARGETS) {
  const src = readTarget(rel);
  const { total, residual } = scanSource(src);
  grandTotal += total;
  grandResidual += residual.length;
  perFile.push({ rel, total, n: residual.length });

  for (const r of residual) {
    console.error(`✘ ${rel}:${r.line} 断言了 \`code ${r.op} ${r.num}\` 但没有配套的 message 断言`);
    console.error(`     …${r.ctx}`);
  }
}

if (grandResidual > 0) {
  console.error(
    `\n✘ e2e message 断言不全：扫 ${perFile.length} 个文件 · 非零 code 比较点 ${grandTotal} · ` +
      `残留 ${grandResidual} 处（上述逐条已点名）`,
  );
  console.error(
    '\nℹ 处置：在这些断言点**同一处**同时断言 `.body?.message`（推荐把 `await call(...)` ' +
      '先 hoist 成 `const probeXxx = await call(...)`，再同一条 assert 里判 code 与 message）；\n' +
      '  ⚠️ 只断言 code 的断言是**恒绿**的 —— ERROR_MESSAGE 缺映射时 code 照样返回，测试照样通过，' +
      '而用户只看到「业务异常」。',
  );
  process.exit(1);
}

console.log(
  `✔ e2e message 断言全覆盖：扫 ${perFile.length} 个文件 · 非零 code 比较点 ${grandTotal}` +
    `（${perFile.map((f) => `${f.rel.replace(/^scripts\//, '')} ${f.total}`).join(' / ')}）· 残留 0`,
);
process.exit(0);

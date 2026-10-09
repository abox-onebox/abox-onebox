/**
 * λ-1 · 「生产禁 mock」启动硬闸的**四场景 + 反证**探针（一次性取证，**刻意不挂门禁**）
 *
 * ## 为什么必须存在
 *
 * 新写的检查器，在被反证**打红过一次**之前，它的「绿」不构成任何证据 ——
 * 恒绿与真绿在汇总里同形。本探针把判据拉到**进程级**跑：每个场景真起一个子进程，
 * 由子进程 `import` **生产真正执行的那一份判据**（`apps/api-server/src/common/utils/prod-mock-gate.ts`），
 * 按判据结果 `process.exit(0/1)` ⇒ 表里每一行都是**真实退出码**，不是推演。
 *
 * ⚠️ **不测复刻**：判据只有一份（`.ts` 源文件），探针直接 import 它，不另抄一份判据
 * （§6.3②(b)：抄的那份一定会漂）。
 *
 * ## 用法
 *
 *     node scripts/probes/prod-mock-gate.mjs
 *
 * ⚠️ 子进程用 `node --experimental-strip-types` 直接吃 `.ts`（Node ≥ 22.6）。
 *    本机实测 v22.22.2 可用；将来若该 flag 退役（Node 23.6+ 已默认开启类型剥离），
 *    去掉 flag 即可 —— 探针会**先自检**一次类型剥离是否可用，不可用即报 `broken`（不静默绿）。
 *
 * ## 场景表（期望 vs 实得）
 *
 * | # | 场景 | 期望 |
 * | --- | --- | --- |
 * | V1 | 生产 + 未配 PROVIDER_MODE（现有 `assertProdSecrets` 拦） | 非 0（**结构性基线**；该函数非纯函数，不做行为实测） |
 * | V2 | 生产 + mock + 无逃生 | **退出码 1**，且输出含判据串 `PROD_MOCK_GATE` |
 * | V3 | 生产 + mock + `ALLOW_MOCK_IN_PROD=1`（/ `true` / `TRUE`） | 退出码 0 |
 * | V3b | 同上但开关塞 `0` / `false` / `yes` / 空串 / 随意值 | **退出码 1**（只认 `1`/`true`） |
 * | V4 | 生产 + real | 退出码 0 |
 *
 * ## 反证（必做）
 *
 * 把判据里的逃生开关改成「认任意非空串」⇒ 上表 V3b **必须红**；改回 ⇒ 绿。
 * ⚠️ 反证要**真的跑、真的看到红**，不许写「理论上会红」；改回后 `grep` 断言 0 残留。
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { spawnCapture } from '../lib/spawn-capture.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE_TS = join(ROOT, 'apps', 'api-server', 'src', 'common', 'utils', 'prod-mock-gate.ts');
/**
 * ⚠️ 子进程里必须用 **file:// URL**：Windows 绝对盘符路径（`C:\...`）喂给 `import()`
 *    会抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME` —— 首跑实测踩到，靠上面那条前置自检才没变成
 *    「判据根本没执行却显示全绿」。
 */
const GATE_URL = pathToFileURL(GATE_TS).href;
const MAIN_TS = join(ROOT, 'apps', 'api-server', 'src', 'main.ts');
const NODE = process.execPath;
const STRIP_FLAG = '--experimental-strip-types';

let pass = 0;
let fail = 0;
function ok(name, detail = '') {
  pass += 1;
  console.log(`  ✔ ${name}${detail ? `  › ${detail}` : ''}`);
}
function bad(name, detail = '') {
  fail += 1;
  console.log(`  ✘ ${name}${detail ? `  › ${detail}` : ''}`);
}
/** 断言：cond 为真记绿，否则记红 */
function t(name, cond, detail = '') {
  cond ? ok(name, detail) : bad(name, detail);
}

// ── 0. 前置自检：类型剥离是否可用（不可用 ⇒ 判据根本没被真正执行 ⇒ 不许给结论） ──
console.log('[前置] 类型剥离自检');
const probeChild = spawnCapture(
  NODE,
  [STRIP_FLAG, '-e', `import(${JSON.stringify(GATE_URL)}).then(m=>{process.stdout.write(String(typeof m.judgeProdMock));process.exit(m.judgeProdMock?0:2)}).catch(e=>{console.error(String(e));process.exit(3)})`],
  { cwd: ROOT },
);
if (probeChild.status === 0 && (probeChild.stdout ?? '').trim() === 'function') {
  ok('前置 · 子进程可直接 import 判据 `.ts`（`--experimental-strip-types` 可用）');
} else {
  bad(
    '前置 · 无法 import 判据 `.ts` ⇒ 下面所有场景都是空跑，结论不可信',
    `status=${probeChild.status} out=${(probeChild.stdout ?? '').slice(0, 120)} err=${(probeChild.stderr ?? '').slice(0, 200)}`,
  );
  console.log(`\n合计：通过 ${pass} · 失败 ${fail}`);
  process.exit(1);
}

/**
 * 跑一个场景：起子进程 → import 判据 → 按 `allow` 退出
 * @returns {{code:number|null, out:string, verdict:object|null}}
 */
function runScenario(input) {
  return runScenarioAt(GATE_URL, input);
}

/** 同上，但可指定判据来源（反证要喂**变异版**） */
function runScenarioAt(url, { nodeEnv, providerMode, allowMockInProd }) {
  const script =
    `import(${JSON.stringify(url)}).then(m=>{` +
    `const v=m.judgeProdMock({nodeEnv:${JSON.stringify(nodeEnv)},` +
    `providerMode:${JSON.stringify(providerMode)},` +
    `allowMockInProd:${JSON.stringify(allowMockInProd)}});` +
    `process.stdout.write('VERDICT='+JSON.stringify(v));` +
    `process.exit(v.allow?0:1)}).catch(e=>{console.error(String(e));process.exit(3)})`;
  const r = spawnCapture(NODE, [STRIP_FLAG, '-e', script], { cwd: ROOT });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = /VERDICT=(\{.*\})/.exec(out);
  return { code: r.status, out, verdict: m ? JSON.parse(m[1]) : null };
}

// ── V1 · 基线：现有 `assertProdSecrets` 没被改坏（**结构性**，不是行为实测） ──
/**
 * ⚠️ 为什么 V1 不做行为实测：`assertProdSecrets()` 在 `main.ts` 里**读 `process.env`
 * 且直接 `process.exit`**，不是纯函数；而 `main.ts` 结尾就是 `void bootstrap()`，
 * 任何 import 都会真起服务（要 DB / 端口）⇒ 行为实测的代价与风险都不成比例。
 * ⇒ 故 V1 只做**结构性确认**（那三处还在），并另补一条**行为**断言：
 *    「配置缺省时本闸**放行**，不越权重复拦 —— 那一档交给上游那道」。
 */
console.log('\n[V1] 基线 · 现有 `assertProdSecrets` 仍在（结构性）');
const mainSrc = readFileSync(MAIN_TS, 'utf8');
t(
  'V1a · `REQUIRED_IN_PROD` 仍含 `PROVIDER_MODE`（漏配即启动中止那道还在）',
  /const REQUIRED_IN_PROD = \[[^\]]*'PROVIDER_MODE'/s.test(mainSrc),
);
t(
  'V1b · `assertProdSecrets` 仍以 `process.exit(1)` 收尾',
  /function assertProdSecrets[\s\S]{0,1200}?process\.exit\(1\)/.test(mainSrc),
);
t(
  'V1c · `bootstrap()` 里仍调用 `assertProdSecrets()`（且早于本闸）',
  /assertProdSecrets\(\);[\s\S]*?assertProdProviderMode\(cfg\)/.test(mainSrc),
);
const v1 = runScenario({ nodeEnv: 'production', providerMode: undefined, allowMockInProd: undefined });
t(
  'V1d · 生产 + 配置缺省 ⇒ 本闸**放行**（不越权重复拦，那一档归 `assertProdSecrets`）',
  v1.code === 0 && v1.verdict?.allow === true,
  `code=${v1.code}`,
);

// ── V2 · 生产 + mock + 无逃生 ⇒ 必须 exit 1 且带判据串 ──
console.log('\n[V2] 生产 + mock + 无逃生 ⇒ 退出码 1');
for (const esc of [undefined, '', '0', 'no']) {
  const r = runScenario({ nodeEnv: 'production', providerMode: 'mock', allowMockInProd: esc });
  t(
    `V2 · allowMockInProd=${JSON.stringify(esc)} ⇒ 退出码 1 且含判据串`,
    r.code === 1 && r.out.includes('PROD_MOCK_GATE'),
    `code=${r.code}`,
  );
}

// ── V3 · 逃生开关真的认：`1` / `true` / `TRUE` ⇒ 放行 ──
console.log('\n[V3] 生产 + mock + `ALLOW_MOCK_IN_PROD=1|true|TRUE` ⇒ 退出码 0');
for (const esc of ['1', 'true', 'TRUE', ' 1 ']) {
  const r = runScenario({ nodeEnv: 'production', providerMode: 'mock', allowMockInProd: esc });
  t(
    `V3 · allowMockInProd=${JSON.stringify(esc)} ⇒ 放行（退出码 0）且 escapeOn=true + 带三件事文案`,
    r.code === 0 && r.verdict?.escapeOn === true && /怎么关/.test(r.verdict?.notice ?? ''),
    `code=${r.code}`,
  );
}

// ── V3b · 反方向的牙齿：其它一切值都必须视为未开（这条正是反证要打红的那条） ──
console.log('\n[V3b] 开关塞 `0` / `false` / `yes` / 空串 / 随意值 ⇒ 一律视为未开（退出码 1）');
for (const esc of ['0', 'false', 'yes', '', '随便塞个值', '2']) {
  const r = runScenario({ nodeEnv: 'production', providerMode: 'mock', allowMockInProd: esc });
  t(
    `V3b · allowMockInProd=${JSON.stringify(esc)} ⇒ 退出码 1（只认 1 / true）`,
    r.code === 1,
    `code=${r.code}`,
  );
}

// ── V4 · 生产 + real ⇒ 放行（且不打逃生告警） ──
console.log('\n[V4] 生产 + real ⇒ 退出码 0');
const v4 = runScenario({ nodeEnv: 'production', providerMode: 'real', allowMockInProd: undefined });
t(
  'V4 · providerMode=real ⇒ 放行且 escapeOn=false / notice=null',
  v4.code === 0 && v4.verdict?.escapeOn === false && v4.verdict?.notice === null,
  `code=${v4.code}`,
);
// 非生产 + mock 也必须是放行（本地开发与 e2e 全链路都靠 mock，本闸不许误伤）
const v5 = runScenario({ nodeEnv: 'development', providerMode: 'mock', allowMockInProd: undefined });
t(
  'V4b · 非生产 + mock ⇒ 放行（mock 是本地/e2e 的依赖，本闸不介入）',
  v5.code === 0,
  `code=${v5.code}`,
);

// ── 反证 · 判据写反时必须红（**本探针每次都跑**，不是一次性的） ──
/**
 * 用**真源码变形**出「判据被写反」的版本：把 `ESCAPE_ON.has(...)` 换成「任意非空串即开」，
 * 此时 `yes` 会被放行 ⇒ 相应地，上表 V3b 那一条**必须跟着红**（本探针的 V3b 与反证是成对的）。
 *
 * ⚠️ 变形后的源码落在**系统临时目录**（`os.tmpdir()`，**不在仓库内**）且用完即删：
 *    · 不用 `data:` URL —— 那要先手工剥 TS 类型，脆且错（首跑实测失败过一次）；
 *    · 不落进仓库 —— κ-5 的教训是「改真文件再改回」的残留风险只能靠 grep 兜，
 *      能不落盘就不落盘。
 * ⚠️ 本条证明的是「**变异能被检测出来**」；端到端的「改真文件 ⇒ 探针真的红」另在交付记录里
 *    单独跑一次（改回后 `grep` 断言 0 残留）。
 */
console.log('\n[反证] 判据写反 ⇒ 必须红');
const gateSrc = readFileSync(GATE_TS, 'utf8');
const NEEDLE = "return ESCAPE_ON.has((raw ?? '').trim().toLowerCase());";
const BROKEN_SRC = gateSrc.replace(NEEDLE, "return (raw ?? '').trim() !== ''; // LAMBDA-MUTATION-BROKEN");
if (BROKEN_SRC === gateSrc) {
  bad(
    '反证 · 变异没生效（真源码里找不到 `ESCAPE_ON.has(...)` 那一行）⇒ 这条反证本身是空的' +
      '（⚠️ 若真源码此刻**正处于变异态**，本条也会这样报 —— 那是它该有的反应，不是误报）',
  );
} else {
  const brokenPath = join(tmpdir(), `abox-lambda1-broken-gate-${Date.now()}.ts`);
  try {
    writeFileSync(brokenPath, BROKEN_SRC, 'utf8');
    const brokenUrl = pathToFileURL(brokenPath).href;
    const r = runScenarioAt(brokenUrl, {
      nodeEnv: 'production',
      providerMode: 'mock',
      allowMockInProd: 'yes',
    });
    t(
      '反证 · 判据改成「认任意非空串」后 `yes` 被放行 ⇒ 这条变异**确实能被检测出来**（V3b 随之红）',
      r.verdict?.allow === true,
      `allow=${r.verdict?.allow} code=${r.code}`,
    );
  } finally {
    try {
      rmSync(brokenPath, { force: true });
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
  }
}

console.log(`\n合计：通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/**
 * `lock:frozen-sync` · **跨方法 CAS 契约**静态门禁（κ-3 运行时断言的静态补位）
 *
 * ## 它看的是什么
 *
 * `OrderService.syncFrozenBalance` 动的是**钱**（冻结 / 解冻余额），它自己**不上锁**：
 * 锁由**调用方**先在同一事务里做一次真 CAS（`WHERE version = :v` + SQL 表达式自增）来提供。
 * κ-3 已把这条跨方法不变量做成**运行时断言**（调用方必须交出 `versionBeforeCas`，
 * 方法入口验「行上 version == 它 + 1」，不满足即抛 `30022`），并做了变异实测证明它真会红
 * （`versionBeforeCas` 偏移 1 ⇒ `e2e:m3` 立刻 1341/1346，红的正是 5 条 D10 断言）。
 *
 * ⚠️ 但运行时断言只对**被 e2e 覆盖到的调用点**成立。将来谁新增一个「传了事务却没做 CAS」
 *    的调用点、又没被现有断言覆盖 ⇒ 运行时也拦不住 ⇒ 本门禁补上静态这一半。
 *
 * ⚠️ 与 `lock:version` 的分工：那条只认 SET 里的 `version: (x.version ?? 0) + 1`
 *    （装饰性自增），扫不到本处的病 —— 本处的形态是「**条件性不带 version**」，
 *    病灶不在某一个方法里，而在**两个方法之间**。
 *
 * ## 判据（`lib/frozen-sync-rules.mjs`，纯函数、可 import 复用）
 *
 *   ① 全仓 `syncFrozenBalance(` 的**调用点**（`async syncFrozenBalance(` 是声明，跳过）必须
 *      交出 `versionBeforeCas`，缺了点名 `文件:行`；
 *   ② 契约真源 `FrozenSyncCasCtx` 的 `manager` / `versionBeforeCas` 必须仍**非可选**
 *      （防「把必填改回可选」⇒ ① 名存实亡 = 门禁被自己绕过）；
 *   ③ **0 调用点 ⇒ 报 broken**（扫到空返回绿 = 判据空转，与恒绿同罪）。
 *
 * ## 自证（**必报 + 必不报**，样本**从真源码变形派生**，不写死数字）
 *
 *   ① 真源码里的那个调用点（原样）        ⇒ **必不报**
 *   ② 同一个调用点删掉 `versionBeforeCas` ⇒ **必报**
 *   ③ 真源码里的 `FrozenSyncCasCtx`（原样） ⇒ **必不报**
 *   ④ 契约里把 `versionBeforeCas` 改成可选 ⇒ **必报**
 *   ⑤ 调用点集合为空                       ⇒ **必报**（判据空转）
 *
 * ⚠️ 样本一律以**真源码为底本再变形**：写死的样本会在某次改名 / 加字段后集体失真，
 *    而它红的形态看起来像「判据坏了」，极易被误读成要去改判据（本仓 §6.4①）。
 *
 * 用法：node scripts/check-frozen-sync.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  CTX_RE,
  balancedSlice,
  checkArgText,
  checkContract,
  extractCallSites,
  judge,
} from './lib/frozen-sync-rules.mjs';

const ROOT = resolve(import.meta.dirname, '..');

/** 扫描根：调用点只可能出现在源码包里（不含 node_modules / 产物 / 文档 / 脚本自身） */
const SCAN_DIRS = [join(ROOT, 'apps'), join(ROOT, 'packages')];
const EXCLUDED_DIRS = ['node_modules', 'dist', 'build', '.git', 'coverage'];
const EXCLUDED_SUFFIX = ['.d.ts'];

// ---------------------------------------------------------------------------
// 收集源码
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out; // 目录不存在 ⇒ 跳过，由「扫到 0 文件」判据兜底
  }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!EXCLUDED_DIRS.includes(name)) walk(p, out);
      continue;
    }
    if (name.endsWith('.ts') && !EXCLUDED_SUFFIX.some((s) => name.endsWith(s))) out.push(p);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(d));
const relOf = (p) => relative(ROOT, p).replace(/\\/g, '/');

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const results = [];
const log = (s) => process.stdout.write(`${s}\n`);
function ok(name, detail = '') {
  results.push({ name, pass: true });
  log(`✔ ${name}${detail ? `  › ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ name, pass: false });
  log(`✘ ${name}${detail ? `  › ${detail}` : ''}`);
}

// ---- 1. 真实扫描
const callSites = [];
const contractIssues = [];
let ctxFile = null;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  callSites.push(...extractCallSites(src, relOf(f)));
  for (const x of checkContract(src)) contractIssues.push(`${relOf(f)}: ${x}`);
  if (CTX_RE.test(src)) ctxFile = { path: f, src };
}
const { violations, count } = judge(callSites, contractIssues);

log(`扫描 ${files.length} 个源文件 · 命中调用点 ${count} 处`);
for (const c of callSites) log(`  · ${c.file}:${c.line}`);
log('');
if (!files.length)
  fail('真实扫描 · 扫到 0 个源文件（判据空转，结论不可信）', `SCAN_DIRS=${SCAN_DIRS.join(', ')}`);

if (violations.length) for (const v of violations) fail(v);
else
  ok(
    '真实扫描 · 全部调用点都交出了 `versionBeforeCas`，且契约字段仍非可选',
    `调用点=${count} · 契约真源=${ctxFile ? relOf(ctxFile.path) : '未找到'}`,
  );

// ---- 2. 自证（样本从真源码派生）
const truthCall = callSites.find((c) => c.argText != null) ?? null;
const truthContract = ctxFile
  ? balancedSlice(ctxFile.src, ctxFile.src.indexOf('{', CTX_RE.exec(ctxFile.src).index), '{', '}')
  : null;

if (!truthCall || truthContract == null) {
  fail(
    '自证 · 无法从真源取得样本（真调用点或 `FrozenSyncCasCtx` 缺失）⇒ 自证不可用，不许给出结论',
    `call=${!!truthCall} contract=${truthContract != null}`,
  );
} else {
  // ① 真调用点原样 ⇒ 必不报
  const cleanCall = judge([{ ...truthCall, argText: truthCall.argText }], []);
  if (cleanCall.violations.length === 0)
    ok('自证① · 真源码里的调用点**必不报**（原样交出 `versionBeforeCas`）', `${truthCall.file}:${truthCall.line}`);
  else fail('自证① · 真源码里的调用点**必不报**', cleanCall.violations.join(' | '));

  // ② 删掉 `versionBeforeCas` ⇒ 必报（真源码变形而来，不是写死的样本）
  const mutated = truthCall.argText.replace(/versionBeforeCas\s*:[^,\n]*,?/, '');
  if (mutated === truthCall.argText)
    fail('自证② · 变异没生效（未从真源码里删掉 `versionBeforeCas`）⇒ 这条自证本身是空的');
  else if (judge([{ ...truthCall, argText: mutated }], []).violations.length >= 1)
    ok('自证② · 删掉 `versionBeforeCas` 的调用点**必报**（真源码变形而来）');
  else fail('自证② · 删掉 `versionBeforeCas` 的调用点**必报**');

  // ③ 契约真源原样 ⇒ 必不报
  if (checkContract(`interface FrozenSyncCasCtx {${truthContract}}`).length === 0)
    ok('自证③ · 契约真源 `FrozenSyncCasCtx`（原样）**必不报**');
  else fail('自证③ · 契约真源（原样）**必不报**');

  // ④ 把 `versionBeforeCas` 改成可选 ⇒ 必报
  const looseContract = truthContract.replace(/(versionBeforeCas)\s*:/, '$1?:');
  if (looseContract === truthContract)
    fail('自证④ · 变异没生效（未把 `versionBeforeCas` 改成可选）⇒ 这条自证本身是空的');
  else {
    const loose = checkContract(`interface FrozenSyncCasCtx {${looseContract}}`);
    if (loose.length >= 1) ok('自证④ · 契约字段被改成可选**必报**（防「门禁被自己绕过」）', loose.join(' | '));
    else fail('自证④ · 契约字段被改成可选**必报**');
  }

  // ⑤ 0 调用点 ⇒ 必报（判据空转）
  if (judge([], []).violations.length >= 1) ok('自证⑤ · **0 调用点必报**（判据空转不许静默绿）');
  else fail('自证⑤ · **0 调用点必报**');
}

// ---- 自证汇总（`gate.mjs` 的 REPORT_RE 消费这一行；分母为 0 = 判据空转）
const synAll = results.filter((r) => r.name.startsWith('自证'));
const synPass = synAll.filter((r) => r.pass).length;
log(`[自证] ${synPass}/${synAll.length} 通过`);

// ---- 汇总
const failed = results.filter((r) => !r.pass);
log('');
log('──────── 汇总 ────────');
log(`通过 ${results.length - failed.length}/${results.length}${failed.length ? '' : ' · 全绿 ✅'}`);
process.exit(failed.length ? 1 : 0);

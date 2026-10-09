#!/usr/bin/env node
/**
 * `security:scan` · **git 历史三态**取证探针（κ-8 收编）
 *
 * ## 它测什么
 *
 * `scanGitHistory()` 的返回值有三态（`complete` / `shallow` / `unavailable`），
 * 而「历史到底扫没扫到」是 `mode` 的**投影**（`historyScanned = isHistoryFullyScanned(mode)`）。
 * 这个对儿**真的错过一次**：浅仓库在旧判据下是 `scanned: true` ⇒ 打印「已执行（完整历史）」
 * 而历史其实是截断的 ⇒ **静默绿**（κ-2 修的病，`security-scan.ts` 里留着记录）。
 *
 * ⇒ 本探针用**假 git** 把三态**确定性**逼出来，逐态断言：
 *      `[git-history] mode=<态>` 与「已执行（完整历史）」/`**不完整**` **必须自洽**，
 *      且真源里的映射**必须仍等于本文件顶上的 `CONTRACT`**。
 *
 * ## 为什么不挂 `gate.mjs`
 *
 * 它要起 3 次 ts-node（各约 6s），且**必须独占 PATH 最前**（假 git），不适合每次提交都跑。
 * 定位：**谁改了 `security-scan.ts` 一族，拿来一键复验三态行为没变**。
 *
 * ## 三条硬纪律（本仓规矩）
 *
 * ① **见证必须有自己的期望**：期望值若只从真源派生，判据被改反时探针会跟着恒绿
 *    （实测：把 `shallow` 翻成 true，三态断言和真源派生值一起翻 ⇒ 全绿）。
 *    故 `CONTRACT` 写死在本文件，并额外断言「真源映射 == CONTRACT」；
 * ② 自带自证：**必不报**（三态真样本）+ **真值表**（把真样本的状态行强制写成两侧各一次，
 *    逐格断言该报 / 该不报）—— 后者保证无论样本当前站在哪一侧都翻得动；
 * ③ 假 git **没被命中 ⇒ 报 `broken` 并 EXIT≠0** —— 否则「三态全绿」很可能只是
 *    **假 git 没生效、三次跑的都是同一个态**（κ-7 实测踩过，最糟的假绿）。
 *
 * 用法：node scripts/probes/security-history-modes.mjs
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildFakeGit,
  hitCount,
  runScan,
  runTsNodeScript,
  TSNODE_BIN,
} from '../lib/history-modes-shim.mjs';

const MODES = ['complete', 'shallow', 'unavailable'];

/**
 * 被守护的**契约**：每个态「该不该算完整扫过」
 *
 * ⚠️ 这是**见证**，不是判据的第二份实现 —— 见证必须有自己的期望，否则判据被改反时
 *    探针会跟着恒绿。⛔ 谁改 `isHistoryFullyScanned` 的语义，必须**同时**来改这张表并写明理由。
 */
const CONTRACT = { complete: true, shallow: false, unavailable: false };

/** 从真源取映射（跑的**就是生产真正执行的那一份** `isHistoryFullyScanned`） */
const MAP_SCRIPT =
  "import { isHistoryFullyScanned, type GitHistoryMode } from './src/common/security/security-scan'; " +
  "const m: Array<GitHistoryMode> = ['complete','shallow','unavailable']; " +
  "console.log('MAP=' + JSON.stringify(Object.fromEntries(m.map((x) => [x, isHistoryFullyScanned(x)]))));";

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

/**
 * 判据（**纯函数**，导出以便复用）
 *
 * @param text            一次扫描的完整 stdout
 * @param mode            期望的态
 * @param expectedScanned 该态按契约「该不该算扫过」
 */
export function judgeHistoryLines(text, mode, expectedScanned) {
  const m = /^\[git-history\] mode=(.*)$/m.exec(text ?? '');
  if (!m) return { ok: false, why: '未找到 `[git-history] mode=` 契约行' };
  const got = m[1].trim();
  if (got !== mode)
    return { ok: false, why: `契约行是 mode=${got}，期望 ${mode} ⇒ 假 git 没生效或态不对` };
  const saidDone = /git 历史扫描：已执行（完整历史）/.test(text);
  const saidIncomplete = /git 历史扫描：\*\*不完整\*\*/.test(text);
  if (saidDone === saidIncomplete)
    return { ok: false, why: '「已执行（完整历史）」与「**不完整**」必须**恰好**出现一个' };
  if (saidDone !== expectedScanned)
    return {
      ok: false,
      why:
        `派生的「扫没扫到」=${saidDone}（${saidDone ? '已执行（完整历史）' : '**不完整**'}），` +
        `期望 ${expectedScanned} ⇒ 与 mode=${mode} 不自洽（静默绿 / 静默红的形状）`,
    };
  return { ok: true, why: '' };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function broken(why, raw) {
  log(`✘ broken · ${why} ⇒ 不许给出结论`);
  if (raw) {
    log(`  退出码=${raw.status}`);
    log(
      (raw.text || '（无输出）')
        .trim()
        .split('\n')
        .slice(-8)
        .map((l) => `  ${l}`)
        .join('\n'),
    );
  }
  process.exit(2);
}

if (!TSNODE_BIN) broken('找不到 ts-node 的入口（`ts-node/dist/bin.js`）⇒ 无法跑被验的文件');

const derived = (() => {
  const { text, status } = runTsNodeScript(MAP_SCRIPT);
  const m = /MAP=(\{.*\})/.exec(text);
  if (!m) return null;
  try {
    return { value: JSON.parse(m[1]), status, text };
  } catch {
    return null;
  }
})();
if (!derived)
  broken(
    '无法从真源取得 `isHistoryFullyScanned` 的映射（ts-node 起不来 / 判据被改名 / 导出没了）',
    runTsNodeScript(MAP_SCRIPT),
  );
log(`真源映射（来自 isHistoryFullyScanned 本体）：${JSON.stringify(derived.value)}`);

for (const mode of MODES) {
  if (derived.value[mode] === CONTRACT[mode])
    ok(`判据见证 · ${mode} 的映射仍是 ${CONTRACT[mode]}（防「判据被改反」而探针恒绿）`);
  else
    fail(
      `判据见证 · ${mode} 的映射仍是 ${CONTRACT[mode]}`,
      `真源现在是 ${derived.value[mode]} ⇒ 「扫没扫到」的语义被改了（浅 clone 被算成已完整扫过，就是 κ-2 的静默绿）`,
    );
}

const tmpRoot = join(tmpdir(), `abox-histmodes-${process.pid}-${Date.now()}`);
mkdirSync(tmpRoot, { recursive: true });
const captured = {};

try {
  for (const mode of MODES) {
    const dir = join(tmpRoot, `shim-${mode}`);
    mkdirSync(dir, { recursive: true });
    const { exe, logPath } = buildFakeGit(dir, mode);
    if (!existsSync(exe)) {
      fail(`三态 · ${mode} · 假 git 构造失败`, `exe=${exe}`);
      captured[mode] = null;
      continue;
    }
    const { text, status } = runScan(dir);
    const hits = hitCount(logPath);
    if (hits === 0) {
      // ⛔ 硬前提：不命中就说明三态是假的（三次跑的其实是同一个态）
      fail(`三态 · ${mode} · 假 git **没被命中** ⇒ broken`, `退出码=${status}`);
      captured[mode] = null;
      continue;
    }
    captured[mode] = text;
    // ⛔ 期望用**契约**（CONTRACT），不用真源派生值 —— 否则判据被改反时探针恒绿
    const v = judgeHistoryLines(text, mode, CONTRACT[mode]);
    if (v.ok)
      ok(
        `三态 · ${mode} · 契约行与「扫没扫到」自洽（契约期望 scanned=${CONTRACT[mode]}）`,
        `假 git 命中 ${hits} 次`,
      );
    else fail(`三态 · ${mode} · 契约行与「扫没扫到」自洽`, v.why);
  }

  // ---- 自证①：必不报 —— 三态真样本本身必须不报
  for (const mode of MODES) {
    const text = captured[mode];
    if (text == null) {
      fail(`自证 · ${mode} 真样本**必不报**`, '样本缺失（上一节已报 broken）');
      continue;
    }
    const v = judgeHistoryLines(text, mode, CONTRACT[mode]);
    if (v.ok) ok(`自证 · ${mode} 真样本**必不报**`);
    else fail(`自证 · ${mode} 真样本**必不报**`, v.why);
  }

  // ---- 自证②：真值表 —— 把真样本的状态行**强制**写成两侧各一次，逐格断言该报 / 该不报
  //   （样本派生自真样本，不是写死的串；写成两侧 ⇒ 无论样本当前站在哪一侧，都翻得动）
  const DONE_LINE = 'git 历史扫描：已执行（完整历史）';
  const INCOMPLETE_LINE = 'git 历史扫描：**不完整** —— 变异样本（自证用）';
  for (const mode of MODES) {
    const base = captured[mode];
    if (base == null) {
      fail(`自证 · ${mode} 真值表`, '样本缺失（上一节已报 broken）');
      continue;
    }
    for (const [line, label] of [
      [DONE_LINE, '已执行（完整历史）'],
      [INCOMPLETE_LINE, '**不完整**'],
    ]) {
      const mutated = base.replace(/^git 历史扫描：.*$/m, line);
      if (!mutated.includes(line)) {
        fail(`自证 · ${mode} 真值表 · 状态行=${label}`, '替换没生效 ⇒ 这条自证本身是空的');
        continue;
      }
      const shouldPass = (line === DONE_LINE) === CONTRACT[mode];
      const v = judgeHistoryLines(mutated, mode, CONTRACT[mode]);
      const want = shouldPass ? '必不报' : '必报';
      if (v.ok === shouldPass) ok(`自证 · ${mode} 真值表 · 状态行=${label} ⇒ ${want}`);
      else fail(`自证 · ${mode} 真值表 · 状态行=${label} ⇒ ${want}`, v.why || '判据没按契约走 ⇒ 恒绿 / 恒红');
    }
  }

  // ---- 自证③：契约行整行消失 ⇒ 必须报（「扫没扫到」不可见 ⇒ 与静默同罪）
  {
    const base = captured.complete;
    if (base == null) fail('自证 · 契约行缺失**必报**', '样本缺失');
    else {
      const stripped = base.replace(/^\[git-history\] mode=.*$/m, '');
      if (!judgeHistoryLines(stripped, 'complete', CONTRACT.complete).ok)
        ok('自证 · 契约行缺失**必报**', '「这次到底扫没扫」不可见 ⇒ 不许算绿');
      else fail('自证 · 契约行缺失**必报**', '判据没抓到 ⇒ 判据恒绿');
    }
  }
} finally {
  // ⚠️ Windows 对**刚被执行过**的 `.exe` 有映像锁 ⇒ 删它可能 EPERM。
  //    清理失败**不影响结论**（与 `spawn-capture.mjs` 同一处置：由系统临时目录兜底），
  //    但不能让它把进程崩掉 —— 崩了会盖掉上面已经跑出来的结论。
  try {
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    log(`ℹ 临时目录未能完全清理（Windows 映像锁）：${tmpRoot} —— 由系统兜底，不影响结论`);
  }
}

const synAll = results.filter((r) => r.name.startsWith('自证'));
const synPass = synAll.filter((r) => r.pass).length;
log(`[自证] ${synPass}/${synAll.length} 通过`);

const failed = results.filter((r) => !r.pass);
log('');
log('──────── 汇总 ────────');
log(`通过 ${results.length - failed.length}/${results.length}${failed.length ? '' : ' · 全绿 ✅'}`);
process.exit(failed.length ? 1 : 0);

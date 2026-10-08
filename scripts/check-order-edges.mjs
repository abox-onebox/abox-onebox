#!/usr/bin/env node
/**
 * 门禁：订单状态机「**边级**」对账（P1-9 · `state:audit` 的第二层）
 *
 * ## 它补的是 `state:audit` 明确放弃的那一格
 *
 * `apps/api-server/src/modules/order/order-state-audit.ts:29-33` 自己写着：
 * 「⚠️ **本门禁不验证「边」**……守卫形态多变（`IN (:...ok)` / 变量 / 事务快照），
 * 静态配对必然误报」。于是出现一个**结构性盲区**：
 *
 *   · `state:audit` 只证明「`cooked` 这个**状态**有人写过」；
 *   · 它证明不了「`cut_off → cooked` 这条**迁移**是被允许的」。
 *
 * 而 `canTransit()`（`order-state-machine.ts:77`）**全仓零生产调用**（只有
 * `test/unit/*.spec.ts` 与 docs 引用它，见本脚本自证 S6）—— 也就是说
 * `ORDER_TRANSITIONS` 是一张**纯声明表**，任何 `UPDATE ab_order SET status=?`
 * 都能绕过它。这正是《缺陷汇总》#17 的原话：「任何代码都可以把 `cut_off`
 * 直写 `refunded` 而无人阻拦」。
 *
 * 本门禁把这一格补上：**扫描全仓真实的订单状态写入点，把它与其 `WHERE status`
 * 守卫配成「边」，再逐条对账声明表**。
 *
 * ## 判据
 *
 *   ① **实际写入边 ⊆ 声明边集**（`ORDER_TRANSITIONS` 的笛卡尔展开）。
 *      越界 ⇒ FAIL `[非法迁移]`，点名 `文件:行` 与那条边。
 *   ② **无守卫写入** = 从任意态都能跳过去 ⇒ FAIL `[无守卫写入]`。
 *      （`order.service.ts:1227` 的注释记着：全仓曾有一处 WHERE 只有 id，
 *       2026-10-07 才补齐 —— 这一条就是防它复发。）
 *   ③ **反向差集（声明了但从未写入）= advisory，不判红**。
 *      理由：一条声明边没人写，可能是「能力没做」（`#79` 那一族，已由
 *      `state:audit` 规则① 覆盖），也可能是**本门禁的守卫解析没覆盖到**；
 *      把它判红会把「解析器不够聪明」伪装成「产品违约」。故只列出，
 *      并**逐条给出解释**（能落到某个未解析站点 / 保留态，或标记为无解释）。
 *   ④ **豁免表自收紧**：`EDGE_EXEMPTIONS`
 *      - 豁免的边**不再被实际写入** ⇒ FAIL `[豁免已过期]`；
 *      - 豁免的边**已被补进声明表** ⇒ FAIL `[豁免与声明冲突]`（要求删豁免）。
 *      ⇒ 豁免只能**如实存在**，不能腐烂成第二份表述。
 *   ⑤ **恒绿反作弊**：扫到 0 条实际边 / 0 个声明边 / 0 个扫描文件
 *      ⇒ FAIL `[instrumentation broken]` 且**非零退出**。
 *      「恒绿的检查比没有检查更糟」—— 解析器失效时必须**红**，不能静默 pass。
 *
 * ## 为什么「声明边集」走运行时反射而不是解析源码
 *
 * 与 `state:audit` 同一决定（`order-state-audit.ts:35-38`）：`ORDER_TRANSITIONS`
 * 是 TS 对象字面量（键是 `OrderStatus.X` 计算属性），正则解析要自己实现常量求值，
 * 而那正是 `schema-parity` 的教训。本脚本**直接 `ts-node` 起来把真值 JSON 出来**，
 * 不手抄任何一个边。反射失败（ts-node 缺失 / JSON 解析失败 / 边数为 0）
 * 一律按 ⑤ 处理。
 *
 * ## 自证（每次运行必跑，不通过则脚本自身失败）
 *
 *   S1 判据非恒绿：往真实实际边集里塞一条声明集外的边 ⇒ 必须报 `[非法迁移]` 且点名它
 *   S2 豁免过期：把某条豁免边从实际边集里删掉 ⇒ 必须报 `[豁免已过期]`
 *   S3 豁免冲突：给一条**已声明**的边加豁免 ⇒ 必须报 `[豁免与声明冲突]`
 *   S4 恒绿反作弊（判定层）：实际边集为空 ⇒ 必须报 `[instrumentation broken]`
 *   S5 解析层（喂人造源码片段，防「判据还在、解析器已经失效」）：
 *      a. 单值守卫 `status = :st` + `OrderStatus.X` ⇒ 抽出 1 条边
 *      b. 常量数组守卫（含 `...OTHER` 展开，两级）⇒ 抽出 2 条边
 *      c. 动态守卫 `{ from: order.status }` ⇒ **必须未解析**（不得编出边、不得崩）
 *      d. 无写入点的片段 ⇒ 0 条（证明不是恒真）
 *      e. 注入 `paid → refunded` 的片段 ⇒ 判定必须 FAIL
 *   S6 反射层：反射回来的声明表必须含 ≥10 个源状态、≥12 条边，且含
 *      `pending_pay→paid` / `cut_off→cooked` / `refund_applying→refunded`
 *      （证明反射到的不是空壳或别的什么东西）
 *
 * 任一项不成立 ⇒ 脚本失败。「**恒绿的检查比没有检查更糟**」。
 *
 * 用法：`node scripts/check-order-edges.mjs [--list]`
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = join(ROOT, 'apps/api-server');
const SRC_ROOT = join(API_DIR, 'src');
const TS_NODE_BIN = join(API_DIR, 'node_modules', 'ts-node', 'dist', 'bin.js');
const TS_PATHS_REG = join(API_DIR, 'node_modules', 'tsconfig-paths', 'register.js');
const STATE_MACHINE_TS = 'src/modules/order/order-state-machine.ts';

// ---------------------------------------------------------------------------
// 豁免表 —— 每一行都要能回答「为什么这条实际写入的边不在声明表里」
//
// ⚠️ 加豁免前先问：**能不能直接补进 `ORDER_TRANSITIONS`？**
//    能补就别豁免 —— 本表越短越好（同 `state:audit` 的 `UNIMPLEMENTED_TARGETS`：
//    「表空着本身就是一条要被守住的结论」）。
//
// ⭐ 一旦有人把某条边补进 `ORDER_TRANSITIONS`，规则 ④ 会**立刻**以
//    `[豁免与声明冲突]` 要求删掉本表的对应行 —— 豁免无法腐烂。
//
// ⭐ **本表现在是空的**（P1-9 裁定 · 2026-10-08）：D11 强制退款的 6 条
//    `→ refunded` 边已由产品裁定**补进 `ORDER_TRANSITIONS`**（见
//    `order-state-machine.ts` 头注「D11 强制退款」段），本表对应 6 行随之删除。
//    补边前这里是 6 行；**空着本身就是一条要被守住的结论**，见自证 S2 的写法：
//    它**不再依赖本表非空**（否则「表空了」会让自证自己失败，等于逼着后人
//    为了自证通过而留一条豁免 —— 那正是豁免腐烂的入口）。
// ---------------------------------------------------------------------------

const EDGE_EXEMPTIONS = {};

// ---------------------------------------------------------------------------
// 源 A：声明边集（运行时反射，绝不手抄）
// ---------------------------------------------------------------------------

/**
 * 跑子进程并**拿回**它的 stdout/stderr
 *
 * ⚠️ 刻意**不用** `stdio: 'pipe'`：本机（`spawnSync` + 匿名管道）一律 EBUSY
 *    （同 `gate.mjs` 在全部门禁上踩过的那个坑，见 `_tmp/gatepipe/pipefix.cjs` 头注）。
 *    直接改成「**临时文件重定向 + 退出后回读**」—— 行为对齐 `pipe`，
 *    但不依赖任何外部垫片，换台机器照样跑（有管道的环境也不受影响）。
 *
 * ⭐ 顺带一条：子进程**根本没起来**时 `error` 会被摊到 stderr 上 ——
 *    否则只会看到「无输出」，又把**环境故障**伪装成**对账失败**。
 */
function spawnCapture(cmd, args, opts) {
  const tag = `order-edges-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const outFile = join(tmpdir(), `${tag}.out.log`);
  const errFile = join(tmpdir(), `${tag}.err.log`);
  const fdOut = openSync(outFile, 'w');
  const fdErr = openSync(errFile, 'w');
  let r;
  try {
    r = spawnSync(cmd, args, { ...opts, stdio: ['ignore', fdOut, fdErr] });
  } finally {
    closeSync(fdOut);
    closeSync(fdErr);
  }
  const read = (f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  const stdout = read(outFile);
  let stderr = read(errFile);
  for (const f of [outFile, errFile]) {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  if (r.error) stderr = `${stderr}[spawn] 子进程未能启动：${r.error.code ?? ''} ${r.error.message}\n`;
  return { status: r.status, error: r.error, stdout, stderr };
}

/**
 * 用 `ts-node` 把 `order-state-machine.ts` 的**真值** JSON 出来
 *
 * ⭐ 与 `gate.mjs` 里 `state:audit` 用的是同一条工具链
 *    （`ts-node -r tsconfig-paths/register`），不另起炉灶。
 */
function reflectStateMachine() {
  if (!existsSync(TS_NODE_BIN)) {
    return { ok: false, why: `找不到 ts-node（${TS_NODE_BIN}）—— 声明边集无法反射` };
  }
  const probe = [
    "const m = require('./" + STATE_MACHINE_TS.replace(/\\/g, '/') + "');",
    "const st = require('@abox/shared-types').OrderStatus;",
    'process.stdout.write(JSON.stringify({',
    '  transitions: m.ORDER_TRANSITIONS,',
    '  initial: m.ORDER_INITIAL_STATUS,',
    '  reserved: m.ORDER_RESERVED_STATUSES,',
    '  enumByName: st,',
    '}));',
  ].join('\n');

  const r = spawnCapture(process.execPath, [TS_NODE_BIN, '-T', '-r', TS_PATHS_REG, '--eval', probe], {
    cwd: API_DIR,
    maxBuffer: 32 * 1024 * 1024,
  });

  if (r.error) return { ok: false, why: `spawn 失败：${r.error.message}` };
  if (r.status !== 0) {
    return { ok: false, why: `ts-node 退出 ${r.status}：${String(r.stderr || '').slice(-400)}` };
  }
  const out = String(r.stdout || '').trim();
  const start = out.indexOf('{');
  if (start < 0) return { ok: false, why: `反射输出里没有 JSON：${out.slice(0, 200)}` };
  let parsed;
  try {
    parsed = JSON.parse(out.slice(start));
  } catch (e) {
    return { ok: false, why: `反射输出不是合法 JSON：${e.message}` };
  }
  if (!parsed.transitions || typeof parsed.transitions !== 'object') {
    return { ok: false, why: '反射结果里没有 ORDER_TRANSITIONS' };
  }
  const declared = [];
  for (const [from, tos] of Object.entries(parsed.transitions)) {
    for (const to of tos || []) declared.push({ from: String(from), to: String(to) });
  }
  return {
    ok: true,
    declared,
    initial: String(parsed.initial ?? ''),
    reserved: (parsed.reserved || []).map(String),
    enumByName: parsed.enumByName || {},
    sourceStates: Object.keys(parsed.transitions).length,
  };
}

// ---------------------------------------------------------------------------
// 源 B：实际写入边（机械提取）
// ---------------------------------------------------------------------------

/** 去掉 `//` 与 `/* *\/` 注释（保留字符串内容 —— SQL 守卫就在字符串里） */
function stripComments(src) {
  let out = '';
  let i = 0;
  let mode = 'code'; // code | single | double | tpl | line | block
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') {
        mode = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && n === '*') {
        mode = 'block';
        i += 2;
        continue;
      }
      if (c === "'") mode = 'single';
      else if (c === '"') mode = 'double';
      else if (c === '`') mode = 'tpl';
      out += c;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += c;
      }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code';
        i += 2;
        continue;
      }
      if (c === '\n') out += c; // 保留行号
      i += 1;
      continue;
    }
    // 字符串内部
    out += c;
    if (c === '\\') {
      out += src[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (
      (mode === 'single' && c === "'") ||
      (mode === 'double' && c === '"') ||
      (mode === 'tpl' && c === '`')
    ) {
      mode = 'code';
    }
    i += 1;
  }
  return out;
}

/** 从 `openIdx`（指向 `open` 字符）起找配对的 `close`，返回其下标；-1 = 找不到 */
function matchBracket(text, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      // 跳过字符串（安全带：本仓的状态写入点里没有含括号的 SQL 字面量会影响配平）
      const q = c;
      i += 1;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按顶层逗号切分数组字面量体 */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      cur += c;
      i += 1;
      while (i < body.length && body[i] !== q) {
        if (body[i] === '\\') {
          cur += body[i] + body[i + 1];
          i += 2;
          continue;
        }
        cur += body[i];
        i += 1;
      }
      cur += q;
      continue;
    }
    if (c === '[' || c === '{' || c === '(') depth += 1;
    else if (c === ']' || c === '}' || c === ')') depth -= 1;
    if (c === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter((p) => p.length > 0);
}

/** 行首下标表 → 二分定位行号（写入点是跨行的，必须整文件扫描后换算） */
function lineTable(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return (idx) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * 收集文件里的「顶层常量数组」：`const NAME = [ OrderStatus.X, 'lit', ...OTHER ];`
 *
 * ⚠️ 只认**全静态**的数组（元素必须是枚举成员 / 字符串字面量 / 对另一个同类的展开）。
 *    含任何别的东西（函数调用、变量、条件）⇒ 记为 unresolved，**绝不猜**。
 */
function collectConstArrays(text) {
  const map = new Map();
  const re = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\[/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const open = m.index + m[0].length - 1;
    const close = matchBracket(text, open, '[', ']');
    if (close < 0) continue;
    map.set(name, { body: text.slice(open + 1, close), done: false, value: null });
  }
  const resolve = (name, seen) => {
    const node = map.get(name);
    if (!node) return null;
    if (node.done) return node.value;
    if (seen.has(name)) return null; // 环
    seen.add(name);
    const vals = [];
    let ok = true;
    for (const el of splitTopLevel(node.body)) {
      const t = el.trim();
      const asEnum = /^OrderStatus\.([A-Za-z_$][\w$]*)$/.exec(t);
      const asLit = /^'([^']*)'$/.exec(t);
      const asSpread = /^\.\.\.([A-Za-z_$][\w$]*)$/.exec(t);
      if (asEnum) vals.push({ kind: 'enum', name: asEnum[1] });
      else if (asLit) vals.push({ kind: 'lit', value: asLit[1] });
      else if (asSpread) {
        const inner = resolve(asSpread[1], seen);
        if (!inner) {
          ok = false;
          break;
        }
        vals.push(...inner);
      } else {
        ok = false;
        break;
      }
    }
    node.done = true;
    node.value = ok ? vals : null;
    return node.value;
  };
  for (const name of [...map.keys()]) resolve(name, new Set());
  const out = new Map();
  for (const [name, node] of map) if (node.value) out.set(name, node.value);
  return out;
}

/** 把 `OrderStatus.X` / `'lit'` / 常量数组名 归一为 DB 取值集合 */
function resolveStatusValue(raw, constArrays, enumByName) {
  const t = String(raw).trim();
  const asEnum = /^OrderStatus\.([A-Za-z_$][\w$]*)$/.exec(t);
  if (asEnum) {
    const v = enumByName[asEnum[1]];
    return v === undefined ? null : [v];
  }
  const asLit = /^'([^']*)'$/.exec(t);
  if (asLit) return [asLit[1]];
  const arr = constArrays.get(t);
  if (!arr) return null;
  const out = [];
  for (const el of arr) {
    if (el.kind === 'lit') out.push(el.value);
    else {
      const v = enumByName[el.name];
      if (v === undefined) return null; // 枚举成员名打错 ⇒ 不猜
      out.push(v);
    }
  }
  return out.length ? out : null;
}

/** 订单状态写入点的锚点：`createQueryBuilder().update(Order)` / `repo.update(Order, ...)` */
const ANCHOR_RE = /\.update\(\s*Order\s*[,)]/g;
/** 建单初始态（不是迁移，不参与边级对账） */
const CREATE_RE = /getRepository\(\s*Order\s*\)\s*\.create\(/g;
/** 属性赋值（本仓当前 0 处；留着防以后有人绕过 `.update()`） */
const ASSIGN_RE = /\.status\s*=\s*(OrderStatus\.[A-Za-z_$][\w$]*)/g;

/**
 * 扫一个文件，返回写入站点
 *
 * 每个站点 = 「目标状态」+「守卫状态集」。两者**都要**静态可判定才产出边；
 * 任一不可判定 ⇒ 记为 unresolved 并**显式列出**（绝不静默跳过）。
 */
function scanFile(file, text) {
  const stripped = stripComments(text);
  const lineOf = lineTable(stripped);
  const constArrays = collectConstArrays(stripped);
  const sites = [];

  const push = (kind, anchorIdx, raw) =>
    sites.push({ file, line: lineOf(anchorIdx), kind, raw });

  // ---- 形态一：`.update(Order)` / `.update(Order, {...})` 链式 ----
  ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = ANCHOR_RE.exec(stripped)) !== null) {
    const start = m.index;
    // 语句窗口：到 `.execute()` 或 `;` 为止（取先到者）
    const execIdx = stripped.indexOf('.execute()', start);
    const semiIdx = stripped.indexOf(';', start);
    let end = stripped.length;
    for (const c of [execIdx, semiIdx]) if (c >= 0 && c < end) end = c;
    const win = stripped.slice(start, end);

    // —— 目标状态：`.set({ ... status: <RHS> ... })`（先配平花括号再找 `status:`）——
    let target = null;
    const setIdx = win.indexOf('.set(');
    if (setIdx >= 0) {
      const brace = win.indexOf('{', setIdx);
      if (brace >= 0) {
        const close = matchBracket(win, brace, '{', '}');
        if (close > brace) {
          const payload = win.slice(brace + 1, close);
          const tm = /(?:^|[,{\s])status\s*:\s*([^,\n]+)/.exec(payload);
          if (tm) target = tm[1].trim();
        }
      }
    }
    if (target === null) continue; // 这条 UPDATE 根本没碰 status ⇒ 不是状态迁移，跳过
    if (!/\bstatus\s*[:=]/.test(win)) continue;

    // —— 守卫状态集：`status = :st` / `status IN (:...ok)` ——
    const guards = [];
    const g1 = /\bstatus\s*=\s*:([A-Za-z_$][\w$]*)/g;
    const g2 = /\bstatus\s+IN\s*\(\s*:\.\.\.?([A-Za-z_$][\w$]*)\s*\)/g;
    const g3 = /\bstatus\s+IN\s*\(\s*:([A-Za-z_$][\w$]*)\s*\)/g;
    for (const re of [g1, g2, g3]) {
      re.lastIndex = 0;
      let g;
      while ((g = re.exec(win)) !== null) guards.push(g[1]);
    }
    //
    // ⚠️ `window` **必须保留全文**：守卫绑定（`{ st: OrderStatus.X }`）常常落在
    //    `.andWhere(...)` 里、距锚点几百字符之外。首版图省事把它截到 160 字符用于打印，
    //    结果 13 个写入点里 10 个「守卫未解析」—— 而真实原因只是**绑定在截断之后**。
    //    （这正是本门禁要防的那一类错：**观测口径被悄悄缩小 ⇒ 结论恒假**。）
    //    显示用的短串另存 `show`，两者**不共用**。
    const flat = win.replace(/\s+/g, ' ');
    sites.push({
      file,
      line: lineOf(start),
      kind: 'write',
      target,
      guards,
      window: flat,
      show: flat.slice(0, 160),
    });
  }

  // ---- 形态二：`entity.status = OrderStatus.X`（无 WHERE ⇒ 无守卫）----
  ASSIGN_RE.lastIndex = 0;
  while ((m = ASSIGN_RE.exec(stripped)) !== null) {
    sites.push({ file, line: lineOf(m.index), kind: 'write', target: m[1], guards: [] });
  }

  // ---- 建单初始态：不参与边级对账，但计数（防「扫描器读空」）----
  CREATE_RE.lastIndex = 0;
  while ((m = CREATE_RE.exec(stripped)) !== null) {
    push('initial', m.index, m[0]);
  }

  return { sites, constArrays };
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile() && p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.endsWith('.spec.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * 把站点解析成「边」（纯函数，便于自证喂人造输入）
 *
 * @returns {{edges: Map<string, Array<{file:string,line:number}>>, unresolved: Array}}
 */
function buildEdges(sites, constArraysByFile, enumByName) {
  const edges = new Map();
  const unresolved = [];
  for (const s of sites) {
    if (s.kind !== 'write') continue;
    const tos = resolveStatusValue(s.target, constArraysByFile.get(s.file) || new Map(), enumByName);
    if (!tos) {
      unresolved.push({ ...s, why: 'target' });
      continue;
    }
    if (!s.guards || s.guards.length === 0) {
      unresolved.push({ ...s, why: 'guard-missing' });
      continue;
    }
    let froms = [];
    let guardOk = true;
    for (const g of s.guards) {
      // 守卫参数名 → 绑定值：在窗口里找 `{ ..., <name>: <RHS>, ... }`
      const re = new RegExp('[{,]\\s*' + g + '\\s*:\\s*([^,\\n}]+)');
      const bm = re.exec(s.window || '');
      if (!bm) {
        guardOk = false;
        break;
      }
      const vals = resolveStatusValue(
        bm[1],
        constArraysByFile.get(s.file) || new Map(),
        enumByName,
      );
      if (!vals) {
        guardOk = false;
        break;
      }
      froms = froms.concat(vals);
    }
    if (!guardOk) {
      unresolved.push({ ...s, why: 'guard' });
      continue;
    }
    for (const from of new Set(froms)) {
      for (const to of tos) {
        const key = `${from}→${to}`;
        if (!edges.has(key)) edges.set(key, []);
        edges.get(key).push({ file: s.file, line: s.line });
      }
    }
  }
  return { edges, unresolved };
}

// ---------------------------------------------------------------------------
// 判定（纯函数）
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {Array<{from:string,to:string}>} input.declared 声明边集
 * @param {Map<string, Array>} input.actual             实际写入边 → 证据
 * @param {Record<string,string>} input.exempt          豁免表
 * @param {number} input.fileCount                      扫到的 *.ts 文件数
 * @param {number} input.siteCount                      订单状态写入点（锚点）数
 * @param {Array} input.unguarded                       写了 status 但 WHERE 无 status 条件的站点
 * @param {boolean} input.allowEmpty                    自证 S4 用：关掉反作弊以验证「它真的会报」
 */
function judge({ declared, actual, exempt, fileCount, siteCount, unguarded = [], allowEmpty = false }) {
  const findings = [];
  const declaredKeys = new Set(declared.map((d) => `${d.from}→${d.to}`));
  const actualKeys = new Set(actual.keys());

  // ⑤ 恒绿反作弊
  const broken = [];
  if (!declared || declared.length === 0) broken.push('声明边集为 0 条（反射失败或被清空）');
  if (!fileCount) broken.push('扫描到的 *.ts 文件数为 0');
  if (!siteCount) broken.push('订单状态写入点为 0 处');
  if (actualKeys.size === 0) broken.push('实际写入边为 0 条');
  if (broken.length && !allowEmpty) {
    findings.push({
      level: 'FAIL',
      rule: 'instrumentation-broken',
      detail: `本门禁**没有观测到任何东西**（${broken.join('；')}）—— ` +
        `这只能意味着扫描器/反射器已经失效，而**不能**解读为「一切正常」。` +
        `恒绿的检查比没有检查更糟，故此处判红。`,
    });
    return findings;
  }

  // ① 实际写入边 ⊆ 声明边集 ∪ 豁免
  for (const [key, ev] of [...actual.entries()].sort()) {
    if (declaredKeys.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(exempt, key)) continue;
    const where = ev.map((e) => `${e.file}:${e.line}`).join('、');
    findings.push({
      level: 'FAIL',
      rule: '非法迁移',
      detail: `边 \`${key}\` —— 写入点 ${where}。` +
        `\`ORDER_TRANSITIONS\` **没有声明这条迁移**，而 \`canTransit()\` 全仓零生产调用` +
        `（\#17）⇒ 没有任何东西拦得住它。要么把它补进声明表，要么删掉这次写入，` +
        `要么在 \`EDGE_EXEMPTIONS\` 里如实登记理由。`,
    });
  }

  // ② 无守卫写入
  for (const u of unguarded) {
    findings.push({
      level: 'FAIL',
      rule: '无守卫写入',
      detail: `${u.file}:${u.line} 写 \`status\` 但 **\`WHERE\` 里没有 status 条件** —— ` +
        `等于「从任意态都能跳过去」。` +
        `\`order.service.ts:1227\` 记着全仓曾有此一处（2026-10-07 才补齐）：` +
        `它会让已取消的单被支付回调复活，且乐观锁形同虚设。`,
    });
  }

  // ④ 豁免自收紧
  for (const key of Object.keys(exempt)) {
    if (!actualKeys.has(key)) {
      findings.push({
        level: 'FAIL',
        rule: '豁免已过期',
        detail: `\`EDGE_EXEMPTIONS\` 里的 \`${key}\` **已经没有对应的写入点**了 —— ` +
          `豁免只能如实存在，不能腐烂成一份对不上现实的文档。请删掉这一行。`,
      });
    }
    if (declaredKeys.has(key)) {
      findings.push({
        level: 'FAIL',
        rule: '豁免与声明冲突',
        detail: `\`EDGE_EXEMPTIONS\` 里的 \`${key}\` **已经被补进 \`ORDER_TRANSITIONS\`** —— ` +
          `声明表现在是权威，这条豁免必须删除（否则「声明与豁免两份表述」又开始了）。`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// 自证
// ---------------------------------------------------------------------------

function selfTest(declared, actual, exempt, enumByName) {
  const bad = [];
  const declaredKeys = new Set(declared.map((d) => `${d.from}→${d.to}`));
  const base = { declared, exempt, fileCount: 999, siteCount: 999 };

  // S1 判据非恒绿
  {
    const polluted = new Map(actual);
    polluted.set('__self_from__→__self_to__', [{ file: 'SELF', line: 1 }]);
    const f = judge({ ...base, actual: polluted });
    if (!f.some((x) => x.rule === '非法迁移' && x.detail.includes('__self_from__→__self_to__'))) {
      bad.push('S1 失败：塞入声明集外的边后未报 [非法迁移]，判据恒绿');
    }
  }

  // S2 豁免过期
  //
  // ⚠️ 用**自造**的探针 key，不依赖 `exempt` 非空：P1-9 裁定后豁免表已清空，
  //    若此处写成「取真实豁免表的第一条」，表一空 S2 就自己失败 —— 那等于
  //    **逼着后人为了自证通过而留一条豁免在表里**，正是豁免腐烂的入口
  //    （首版即这么写，清空当天就红，当场抓到）。
  {
    const probe = '__self_stale__';
    const f = judge({ ...base, actual, exempt: { ...exempt, [probe]: '自证用过期豁免' } });
    if (!f.some((x) => x.rule === '豁免已过期' && x.detail.includes(probe))) {
      bad.push('S2 失败：给一条没有任何写入点的边加豁免后未报 [豁免已过期]');
    }
  }

  // S3 豁免冲突
  {
    const probe = [...declaredKeys][0];
    const f = judge({ ...base, actual, exempt: { ...exempt, [probe]: '自证用冲突豁免' } });
    if (!f.some((x) => x.rule === '豁免与声明冲突' && x.detail.includes(probe))) {
      bad.push(`S3 失败：给已声明的边 \`${probe}\` 加豁免后未报 [豁免与声明冲突]`);
    }
  }

  // S4 恒绿反作弊（判定层）
  {
    const f = judge({ ...base, actual: new Map() });
    if (!f.some((x) => x.rule === 'instrumentation-broken')) {
      bad.push('S4 失败：实际边集为空时未报 [instrumentation broken]（会静默 pass）');
    }
  }

  // S5 解析层（喂人造源码片段）
  {
    const mk = (src) => {
      const r = scanFile('SELF.ts', src);
      const byFile = new Map([['SELF.ts', r.constArrays]]);
      return buildEdges(r.sites, byFile, enumByName);
    };

    // a. 单值守卫
    const a = mk(
      "const MY = 1;\n" +
        "await m.createQueryBuilder()\n" +
        "  .update(Order)\n" +
        "  .set({ status: OrderStatus.COOKED, version: () => 'version + 1' })\n" +
        "  .where('id = :id', { id: o.id })\n" +
        "  .andWhere('status = :st', { st: OrderStatus.CUT_OFF })\n" +
        "  .execute();\n",
    );
    if (!a.edges.has('cut_off→cooked') || a.edges.size !== 1) {
      bad.push(
        `S5a 失败：单值守卫片段应抽出 1 条 \`cut_off→cooked\`，实得 ${[...a.edges.keys()].join(',') || '空'}`,
      );
    }

    // b. 常量数组守卫（含两级展开）
    const b = mk(
      "const OTHER_SET: string[] = [OrderStatus.CUT_OFF];\n" +
        "const MY_SET: string[] = [OrderStatus.PAID, ...OTHER_SET];\n" +
        "await m.createQueryBuilder()\n" +
        "  .update(Order)\n" +
        "  .set({ status: OrderStatus.REFUNDED })\n" +
        "  .where('id = :id AND status IN (:...ok)', { id: 1, ok: MY_SET })\n" +
        "  .execute();\n",
    );
    const bk = [...b.edges.keys()].sort().join(',');
    if (bk !== 'cut_off→refunded,paid→refunded') {
      bad.push(`S5b 失败：常量数组守卫（含展开）应抽出 2 条边，实得 ${bk || '空'}`);
    }

    // c. 动态守卫 ⇒ 必须未解析，且不得编出边
    const c = mk(
      "await m.createQueryBuilder()\n" +
        "  .update(Order)\n" +
        "  .set({ status: OrderStatus.CANCELLED })\n" +
        "  .where('id = :id AND status = :from', { id: 1, from: order.status })\n" +
        "  .execute();\n",
    );
    if (c.edges.size !== 0 || !c.unresolved.some((u) => u.why === 'guard')) {
      bad.push(
        `S5c 失败：动态守卫必须记为 unresolved 且产出 0 条边，实得 ${c.edges.size} 条边 / ` +
          `${c.unresolved.length} 条 unresolved`,
      );
    }

    // d. 无写入点 ⇒ 0 条（证明不是恒真）
    const d = mk("const x = 1;\nconst y = { status: OrderStatus.PAID };\n");
    if (d.edges.size !== 0) {
      bad.push(`S5d 失败：无写入点片段应产出 0 条边，实得 ${[...d.edges.keys()].join(',')}`);
    }

    // e. 注入一条声明集外的边 ⇒ 判定必须 FAIL（且不是恒绿）
    //
    //    ⚠️ 样本**不能选已被声明的边**：P1-9 裁定把 `paid→refunded` 补进声明表之后，
    //       首版这条自证当场失败（它拿一条**合法**边去证明「非法边会被报」）。
    //       故此处先自检样本本身仍然非法，样本一旦失效就**明确报出来**，
    //       而不是让人以为「判据还在、只是样本选错了」。
    const illegal = 'pending_pay→completed';
    if (declaredKeys.has(illegal)) {
      bad.push(`S5e 失败：自证样本 \`${illegal}\` 已被声明，需换一条声明集外的边`);
    } else {
      const [ilFrom, ilTo] = illegal.split('→');
      const e = mk(
        'await m.createQueryBuilder()\n' +
          '  .update(Order)\n' +
          `  .set({ status: OrderStatus.${ilTo.toUpperCase()} })\n` +
          '  .where(\'id = :id\', { id: 1 })\n' +
          `  .andWhere('status = :st', { st: OrderStatus.${ilFrom.toUpperCase()} })\n` +
          '  .execute();\n',
      );
      if (!e.edges.has(illegal)) {
        bad.push(`S5e 失败：注入片段未抽出 \`${illegal}\`，无法继续自证`);
      } else {
        const f = judge({
          declared,
          actual: new Map([[illegal, [{ file: 'SELF.ts', line: 1 }]]]),
          exempt: {},
          fileCount: 999,
          siteCount: 999,
        });
        if (!f.some((x) => x.rule === '非法迁移' && x.detail.includes(illegal))) {
          bad.push(`S5e 失败：注入 \`${illegal}\` 后未报 [非法迁移]`);
        }
      }
    }
  }

  // S6 反射层：反射到的必须是**那张**状态机，不是空壳
  {
    const must = ['pending_pay→paid', 'cut_off→cooked', 'refund_applying→refunded'];
    const miss = must.filter((k) => !declaredKeys.has(k));
    if (miss.length) {
      bad.push(`S6 失败：反射回来的声明表缺边 ${miss.join('、')}（反射到的可能不是 ORDER_TRANSITIONS）`);
    }
    if (declaredKeys.size < 12) {
      bad.push(`S6 失败：反射回来的声明边只有 ${declaredKeys.size} 条（<12），疑似反射部分失败`);
    }
    if (!enumByName || Object.keys(enumByName).length < 8) {
      bad.push('S6 失败：`OrderStatus` 枚举反射失败或不完整');
    }
  }

  return { bad, cases: 6 + 5 };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  const t0 = Date.now();

  // ---- 源 A ----
  const refl = reflectStateMachine();
  if (!refl.ok) {
    console.log(`✘ [instrumentation-broken] 声明边集反射失败：${refl.why}`);
    console.log('    —— 反射失败时「实际边 ⊆ 声明边」无从判断，故直接失败（不可静默 pass）。');
    process.exit(1);
  }
  const { declared, initial, reserved, enumByName, sourceStates } = refl;
  const declaredKeys = new Set(declared.map((d) => `${d.from}→${d.to}`));

  // ---- 源 B ----
  const files = walk(SRC_ROOT);
  const sites = [];
  const constArraysByFile = new Map();
  for (const f of files) {
    const rel = relative(ROOT, f).split('\\').join('/');
    const r = scanFile(rel, readFileSync(f, 'utf8'));
    sites.push(...r.sites);
    constArraysByFile.set(rel, r.constArrays);
  }
  const writes = sites.filter((s) => s.kind === 'write');
  const { edges: actual, unresolved } = buildEdges(sites, constArraysByFile, enumByName);
  const unguarded = unresolved.filter((u) => u.why === 'guard-missing');

  console.log(`源：${files.length} 个 *.ts（apps/api-server/src）→ 订单状态写入点 ${writes.length} 处`);
  // ⭐ 下面四行是**对外契约**：`gate.mjs` 的 `REPORT_RE['order:edges']` 就用
  //    「实际写入边 / 声明边集 / 自证」三行判定本门禁**是否真的自报了覆盖面**
  //    （分母为 0 或整行缺失 ⇒ 视为判据空转，而不是「通过」）。
  //    改这里的措辞**必须同步改 `gate.mjs`**，否则门禁会变成「无输出」。
  console.log(`① 扫描面：${files.length} 个 *.ts → 订单状态写入点 ${writes.length} 处（未解析 ${unresolved.length}）`);
  console.log(`② 豁免表：${Object.keys(EDGE_EXEMPTIONS).length} 条`);
  console.log(`③ 实际写入边：${actual.size} 条`);
  console.log(`④ 声明边集：${declared.length} 条`);
  console.log(
    `  声明侧（运行时反射 · ${STATE_MACHINE_TS}）：${sourceStates} 个源状态 · ` +
      `${declared.length} 条声明边 · 初始态 ${initial} · 保留态 ${reserved.join('、') || '无'}`,
  );
  console.log(
    `  写入侧（机械提取）：解析出 ${actual.size} 条实际写入边 · ` +
      `未解析 ${unresolved.length} 处（守卫 ${unresolved.filter((u) => u.why === 'guard').length} · ` +
      `目标 ${unresolved.filter((u) => u.why === 'target').length} · ` +
      `无守卫 ${unguarded.length}） · 已登记豁免 ${Object.keys(EDGE_EXEMPTIONS).length} 条`,
  );

  if (process.argv.includes('--list')) {
    console.log('\n实际写入边清单（边 · 写入点）：');
    for (const [k, ev] of [...actual.entries()].sort()) {
      const tag = declaredKeys.has(k)
        ? '已声明'
        : Object.prototype.hasOwnProperty.call(EDGE_EXEMPTIONS, k)
          ? '已豁免'
          : '未声明';
      console.log(`  ${k}  [${tag}]  ${ev.map((e) => `${e.file}:${e.line}`).join('、')}`);
    }
    console.log('\n未解析写入点（静态推不出边，逐条列出 —— 绝不静默跳过）：');
    for (const u of unresolved) {
      const why =
        u.why === 'guard' ? '守卫是动态值' : u.why === 'target' ? '目标状态是动态值' : '无 status 守卫';
      console.log(`  ${u.file}:${u.line}  [${why}]  ‹ ${(u.show || u.window || u.raw || '').slice(0, 120)}`);
    }
  }

  // ---- 判定 ----
  const findings = judge({
    declared,
    actual,
    exempt: EDGE_EXEMPTIONS,
    fileCount: files.length,
    siteCount: writes.length,
    unguarded,
  });

  // ---- 自证 ----
  const { bad, cases } = selfTest(declared, actual, EDGE_EXEMPTIONS, enumByName);

  // ---- 反向差集（advisory，不判红）----
  const reverse = declared
    .map((d) => `${d.from}→${d.to}`)
    .filter((k) => !actual.has(k))
    .sort();

  for (const f of findings) console.log(`  ${f.level === 'FAIL' ? '✘' : '△'} [${f.rule}] ${f.detail}`);

  if (unresolved.length) {
    console.log('\n△ 未解析写入点（**静态推不出边**，本门禁的结论在**这几处**上未被覆盖）：');
    for (const u of unresolved) {
      const why =
        u.why === 'guard' ? '守卫是动态值' : u.why === 'target' ? '目标状态是动态值' : '无 status 守卫';
      console.log(`    ${u.file}:${u.line}  [${why}]  ‹ ${(u.show || u.window || u.raw || '').slice(0, 120)}`);
    }
  }

  if (reverse.length) {
    console.log(`\n△ 反向差集（声明了、但没有任何**可静态判定**的写入点 · advisory，不判红）：`);
    for (const k of reverse) {
      const [from, to] = k.split('→');
      // 逐条给解释 —— 「差集必须被逐条解释」，不允许「不知道」就算了
      let note;
      if (reserved.includes(from)) {
        note = `源状态 \`${from}\` 在 \`ORDER_RESERVED_STATUSES\` 里（保留态，订单不进）`;
      } else {
        const cover = unresolved.filter(
          (u) => u.why === 'guard' && String(u.target).includes(to.toUpperCase().replace(/-/g, '_')),
        );
        if (cover.length) {
          note = `可由未解析守卫站点解释：${cover.map((u) => `${u.file}:${u.line}`).join('、')}` +
            `（该写入点的目标就是 \`${to}\`，守卫是动态值 ⇒ 静态证明不了它覆盖这条边）`;
        } else {
          note = '**无解释** —— 既没有静态可判定的写入点，也没有未解析站点能对上；' +
            '要么是这条边根本没实现（`#79` 那一族，`state:audit` 规则① 会先红），' +
            '要么是本门禁的解析还没覆盖到。请人工确认。';
        }
      }
      console.log(`    ${k}  ${note}`);
    }
  }

  if (Object.keys(EDGE_EXEMPTIONS).length) {
    console.log(
      `\n△ 已登记豁免（**声明表之外、但确实被写入**的边 · ${Object.keys(EDGE_EXEMPTIONS).length} 条）：`,
    );
    for (const [k, why] of Object.entries(EDGE_EXEMPTIONS)) {
      console.log(`    ${k}  ←  ${why.slice(0, 110)}…`);
    }
    console.log(
      `    → 这 ${Object.keys(EDGE_EXEMPTIONS).length} 条是**真实存在的实现行为**：` +
        '要么补进 `ORDER_TRANSITIONS`（补完本门禁会立刻以 [豁免与声明冲突] 要求删豁免），' +
        '要么由产品裁定为「例外通道」并保留本登记。',
    );
  } else {
    console.log(
      '\n✔ 豁免表为空：**实际写入的每一条边都在 `ORDER_TRANSITIONS` 里**（P1-9 裁定前这里有 6 条 D11 边，' +
        '裁定后已补进声明表 —— 见 `order-state-machine.ts` 头注「D11 强制退款」段）。',
    );
  }

  if (bad.length) {
    console.log(`\n✘ 门禁自证未通过（${bad.length} 项）：`);
    for (const b of bad) console.log(`    ${b}`);
    console.log('    —— 自证不通过时，本门禁的「绿」不构成任何证据，故直接失败。');
    process.exit(1);
  }

  const fails = findings.filter((f) => f.level === 'FAIL');
  if (fails.length) {
    console.log(`\n✘ 订单状态边级对账未通过：${fails.length} 项阻断`);
    process.exit(1);
  }

  console.log(`\n[自证] ${cases}/${cases} 通过`);
  console.log(
    `\n✔ 订单状态边级对账通过：实际写入 ${actual.size} 条边 ⊆（声明 ${declared.length} 条 ∪ 已登记豁免 ` +
      `${Object.keys(EDGE_EXEMPTIONS).length} 条）· 无无守卫写入 · 豁免未腐烂 · ` +
      `自证 ${cases}/${cases} · ${Date.now() - t0}ms`,
  );
}

main();

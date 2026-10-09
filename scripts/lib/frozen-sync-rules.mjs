/**
 * `lock:frozen-sync` 的**判据**（纯函数 · 无 IO）
 *
 * ⚠️ 刻意**单独成文件**并被门禁脚本 `import` 复用（§6.3②(b)）
 *
 *   · ⛔ **绝不另抄第二份判据** —— 抄的那份一定会漂，最后变成「两个门禁各说各话，
 *     而没被执行的那份必然是错的」（本仓反复出现的横向根因）。
 *   · 取证脚本 / 变异探针要复用判据，一律 `import` 这儿，**不要**自己再写一遍正则。
 *   · 本文件**不含**任何 `readFileSync` / `process.exit`，可被单测直接 import。
 *
 * 判的是什么（背景见 `scripts/check-frozen-sync.mjs` 头注）：
 *   `OrderService.syncFrozenBalance` 动的是**钱**且**自己不上锁** —— 锁由调用方先在同一事务里
 *   做一次真 CAS 来提供。κ-3 把它做成运行时断言（必须交出 `versionBeforeCas`），
 *   本文件是它的**静态**侧：调用点必须交出凭证，且契约字段不许被改回可选。
 */
/** 声明本体：`async syncFrozenBalance(` —— 不是调用点 */
export const DECL_RE = /\basync\s+(syncFrozenBalance\s*\()/g;
/** 所有出现（含声明本体） */
export const ALL_RE = /syncFrozenBalance\s*\(/g;
/** 契约真源 */
export const CTX_RE = /\binterface\s+FrozenSyncCasCtx\s*\{/;
/** 契约里必须保持**非可选**的字段 */
export const CONTRACT_FIELDS = ['manager', 'versionBeforeCas'];

/**
 * ⚠️ 两个正则都带 `g`（`lastIndex` 会跨调用残留）⇒ 每次 exec 前**必须** `lastIndex = 0`。
 *    共享的模块级正则若漏了这一步，第二次调用会从半路开始扫 ⇒ 命中数悄悄变少。
 */

/** 把块注释整段抹成空格（避免注释里的 `{}` / `()` 干扰括号配对与字段解析） */
export function stripBlockComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * 从开括号处起取到**配对**的闭括号，返回其中文本（不含外层括号）
 *
 * ⚠️ 括号对是**参数传进来**的（`()` 取实参 / `{}` 取接口体）—— 首跑实测踩过一次：
 *    拿只数圆括号的版本去取 `FrozenSyncCasCtx` 的**花括号**体 ⇒ 永远配不上 ⇒ 返回 null
 *    ⇒ 契约体被当成空 ⇒ 自证③④ 假红。**同一个函数必须能同时服务两种括号**。
 *
 * @param {string} src 源码
 * @param {number} openIdx 开括号下标
 * @param {string} openCh 开括号字符
 * @param {string} closeCh 闭括号字符
 */
export function balancedSlice(src, openIdx, openCh = '(', closeCh = ')') {
  let depth = 0;
  let mode = 'code'; // code | sq | dq | tpl | line | block
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') {
        mode = 'line';
        i += 1;
        continue;
      }
      if (c === '/' && n === '*') {
        mode = 'block';
        i += 1;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        mode = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl';
        continue;
      }
      if (c === openCh) depth += 1;
      else if (c === closeCh) {
        depth -= 1;
        if (depth === 0) return src.slice(openIdx + 1, i);
      }
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') mode = 'code';
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code';
        i += 1;
      }
      continue;
    }
    // 字符串内：只处理转义与结束引号
    if (c === '\\') {
      i += 1;
      continue;
    }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) {
      mode = 'code';
    }
  }
  // 括号不配对 ⇒ 解析失败（宁可返回 null 让人看见，不要静默当成合规）
  return null;
}

/** 取实参文本：`syncFrozenBalance(` 的配对 `)` 之内 */
export function argTextAt(src, openIdx) {
  return balancedSlice(src, openIdx, '(', ')');
}

/**
 * 抽出一个源码里的**调用点**（排除声明本体）
 *
 * ⚠️ 声明下标必须**换算**：`DECL_RE` 的匹配从 `async` 起、`ALL_RE` 从 `syncFrozenBalance` 起，
 *    两者 `match.index` 落在不同字符上 —— 不换算就直接比对 ⇒ **声明永远排除不掉**，
 *    方法自己的定义会被当成调用点报一次假红（首跑实测就踩了）。
 *
 * @param {string} src 源码
 * @param {string} relKey 用于报错定位的相对路径
 */
export function extractCallSites(src, relKey) {
  const decl = new Set();
  DECL_RE.lastIndex = 0;
  let d;
  while ((d = DECL_RE.exec(src)) !== null) decl.add(d.index + (d[0].length - d[1].length));

  const out = [];
  ALL_RE.lastIndex = 0;
  let m;
  while ((m = ALL_RE.exec(src)) !== null) {
    if (decl.has(m.index)) continue; // 声明本体，不是调用点
    const open = src.indexOf('(', m.index);
    out.push({
      file: relKey,
      line: src.slice(0, m.index).split('\n').length,
      argText: open < 0 ? null : argTextAt(src, open),
    });
  }
  return out;
}

/** 判据①：单个调用点的实参是否交出了 `versionBeforeCas`（null = 合规） */
export function checkArgText(argText) {
  if (argText == null) return '实参括号不配对 ⇒ 无法确认是否交出 CAS 凭证（解析失败按违规处理）';
  if (!/versionBeforeCas\s*:/.test(argText)) {
    return (
      '调用点未交出 `versionBeforeCas` —— 本方法动的是钱且自己不上锁，' +
      "锁必须由调用方先在同一事务里做一次真 CAS（`WHERE version = :v` + `version: () => 'version + 1'`），" +
      '并把占位**之前**的 version 交进来；否则方法内的运行时断言必然红（或更糟：被绕过）'
    );
  }
  return null;
}

/**
 * 判据②：契约真源 `FrozenSyncCasCtx` 的字段是否仍**非可选**
 *
 * ⚠️ 这条防的是「**门禁被自己绕过**」：谁把 `manager` / `versionBeforeCas` 改回可选，
 *    判据①的「必填」就名存实亡，而改的人通常不会顺手删门禁 ⇒ 契约一松，静态侧必须立刻红。
 *
 * @param {string} src 源码
 * @returns {string[]} 问题清单（空数组 = 无问题；没有声明该文件也返回空）
 */
export function checkContract(src) {
  const m = CTX_RE.exec(src);
  if (!m) return []; // 契约只有一处，不在本文件属正常
  const open = src.indexOf('{', m.index);
  const body = stripBlockComments(balancedSlice(src, open, '{', '}') ?? '');
  const issues = [];
  for (const f of CONTRACT_FIELDS) {
    const hit = new RegExp(`\\b${f}\\s*(\\??)\\s*:`).exec(body);
    if (!hit) issues.push(`契约真源缺少字段 \`${f}\``);
    else if (hit[1] === '?') issues.push(`契约字段 \`${f}\` 被改成**可选** —— 等于把 κ-3 的收口撤了`);
  }
  return issues;
}

/**
 * 裁决
 *
 * @param {Array<{file:string,line:number,argText:string|null}>} callSites
 * @param {string[]} contractIssues
 * @returns {{violations: string[], count: number}}
 */
export function judge(callSites, contractIssues = []) {
  const violations = [];

  // ③ 判据空转：0 调用点 = 门禁没看任何东西
  if (!callSites.length) {
    violations.push(
      '**判据空转**：全仓扫到 0 个 `syncFrozenBalance(` 调用点 —— ' +
        '「0 处违规」在这里是恒绿，不是通过。要么调用点被误判为声明（检查正则），' +
        '要么本方法已无人调用（那就连本门禁一起删，不要留一个空转的检查）。',
    );
  }

  for (const c of callSites) {
    const why = checkArgText(c.argText);
    if (why) violations.push(`${c.file}:${c.line} —— ${why}`);
  }

  for (const i of contractIssues) violations.push(`契约真源 —— ${i}`);

  return { violations, count: callSites.length };
}

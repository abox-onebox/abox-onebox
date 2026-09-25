#!/usr/bin/env node
/**
 * 错误码文案覆盖率门禁（**新增错误码必须带文案**）—— 对应 `gate.mjs` 的门禁 `errcode:message`
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 《整体回归 2026-09-25》查出：`error-code.ts` 声明了 `RATING_NOT_ALLOWED = 30020`
 * / `RATING_ALREADY_SUBMITTED = 30021`，而 `ERROR_MESSAGE` 映射表里**没有这两条** ⇒
 * 落到 `biz.exception.ts:24` 的兜底（`message ?? ERROR_MESSAGE[code] ?? '业务异常'`），
 * 用户只看到「业务异常」四个字 —— 既没说清能不能评价，也没说清为什么。
 *
 * 报告对这条的定性是：**别按笔误修**。只补两行文案，下次新增错误码还会再犯 ——
 * 「声明」与「文案」是**同一件事的两份表述**，而不被自动化执行的那一份
 * （这里是 `ERROR_MESSAGE`）必然悄悄错掉。这与 `schema:parity` / `index:parity` /
 * `state:parity` / `dup:const` 是**同一族病根**，也必须用同一味药：机械对账。
 *
 * 补完 30020/30021 后，用脚本机算 `ErrorCode` 全枚举（82 个码）的覆盖度，
 * 又扫出同形的 `DELIVERY_CONFLICT = 30016` 与 `DELIVERY_NOT_FOUND = 30017`
 * —— 说明这不是「某一次手滑」，而是**结构性的覆盖缺口**。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────────
 *   ① `ErrorCode` 枚举里**声明的每个码**，都必须在 `ERROR_MESSAGE` 里有一条映射；
 *      缺了就**转红并逐个点名**（只报「缺 N 条」等于没报 —— 要能让人照着改）。
 *   ② 反向：`ERROR_MESSAGE` 里出现的键，必须是枚举里**声明过**的码
 *      （写了一个不存在的码 = 同样一份幽灵表述；TS 未必拦得住数字键）。
 *   ③ 同一个码不得被映射**两次**（后者静默覆盖前者，是「两份表述」的另一种形态）。
 *
 * ── 取数口径（为什么是自己扫文本，而不是引 ts 编译器）─────────────────────────
 * 与 `check-gate-parity.mjs`（治「门禁清单被抄成两份」）同源：引 ts 编译器会引入
 * **传递依赖漂移**，且本判据要的是「**声明处**与**文案处**逐条对齐」这种结构事实。
 * 故：注释剥离 → 花括号配平取块 → 逐条取键。**键的写法三种都认**：
 *   `[ErrorCode.NAME]:` / `[30016]:` / `30016:`（数值键按值反查声明名）。
 *
 * ── 自证（必做：恒绿或恒红的检查等于没有检查）─────────────────────────────────
 * 内置合成样本：「必报的报得出 / 必不报的不报」，任一侧不符即 **exit 2**。
 * 另外在**真文件上**做过一次人为删映射的实证（结论记在 gate.mjs 该门禁的注释里）。
 *
 * 退出码：0 通过 · 1 有违规 · 2 自证失败（检查器自身坏掉 ⇒ 显式失败，不静默放行）
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'apps', 'api-server', 'src', 'common', 'constants', 'error-code.ts');

/**
 * 剥离注释（保留字符串字面量内的内容）
 *
 * ⚠️ 为什么要保留字符串：本文件里存在 `10006` / `HTTP 200` 这类**写在注释里**的字样，
 *    若不区分字符串与注释，「剥离注释」这一步本身就会把判据喂成假数据。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let mode = 'code'; // code | line | block | sq | dq | tpl
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
      if (c === "'") {
        mode = 'sq';
        i += 1;
        out += c;
        continue;
      }
      if (c === '"') {
        mode = 'dq';
        i += 1;
        out += c;
        continue;
      }
      if (c === '`') {
        mode = 'tpl';
        i += 1;
        out += c;
        continue;
      }
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
      if (c === '\n') out += c; // 保留行数，便于报错定位
      i += 1;
      continue;
    }
    // 字符串内部：只关心自己的结束引号（`\` 转义跳过下一个字符）
    if (c === '\\') {
      out += c + (n ?? '');
      i += 2;
      continue;
    }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) {
      mode = 'code';
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 从 `startIdx` 处（应指向 `{`）切出**配平**的花括号块内容（不含外层花括号）
 * 返回 null 表示没找到闭合 —— 那必红：块缺一半正是「声明被吃掉」的形态。
 */
function cutBlock(src, startIdx) {
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return { body: src.slice(startIdx + 1, i), end: i };
    }
  }
  return null;
}

/** 取 `export enum ErrorCode { … }` 的块体 */
function cutEnumBody(src) {
  const m = /export\s+enum\s+ErrorCode\s*\{/.exec(src);
  if (!m) return null;
  const blk = cutBlock(src, m.index + m[0].length - 1);
  return blk ? blk.body : null;
}

/** 取 `export const ERROR_MESSAGE … = { … }` 的块体 */
function cutMessageBody(src) {
  const m = /export\s+const\s+ERROR_MESSAGE\b[^=]*=\s*\{/.exec(src);
  if (!m) return null;
  const blk = cutBlock(src, m.index + m[0].length - 1);
  return blk ? blk.body : null;
}

/** 枚举声明：`NAME = 30016,` —— 值必须是数字字面量（别名形态 `A = B` 不支持 ⇒ 显式报错） */
function parseDeclarations(body) {
  const out = [];
  for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*([^,\n]+)/g)) {
    const name = m[1];
    const raw = m[2].trim();
    if (!/^-?\d+$/.test(raw)) {
      out.push({ name, value: null, raw });
      continue;
    }
    out.push({ name, value: Number(raw), raw });
  }
  return out;
}

/**
 * 文案映射键：三种写法都取，返回 `{ kind:'name'|'num', key, raw }`
 * 覆盖 `[ErrorCode.X]:` / `[30016]:` / `30016:`
 */
function parseMappings(body) {
  const out = [];
  for (const m of body.matchAll(/\[\s*ErrorCode\.([A-Za-z_$][\w$]*)\s*\]\s*:/g)) {
    out.push({ kind: 'name', key: m[1], raw: m[0] });
  }
  for (const m of body.matchAll(/\[\s*(-?\d+)\s*\]\s*:/g)) {
    out.push({ kind: 'num', key: Number(m[1]), raw: m[0] });
  }
  // 裸数值键（行首数字 + 冒号）。⚠️ 必须排除 `dishId: 1` 这类**对象属性**误命中：
  // 故要求冒号前是行内第一个 token（前面只有空白或 `{` / `,`）。
  for (const m of body.matchAll(/(^|[{,]\s*)(-?\d+)\s*:/gm)) {
    out.push({ kind: 'num', key: Number(m[2]), raw: m[0].trim() });
  }
  return out;
}

/**
 * 主判据（纯函数：吃源码、吐发现 —— 便于用合成样本自证）
 *
 * 返回 { findings, declared, mapped, ok }
 */
function check(src, label = 'error-code.ts') {
  const findings = [];
  const clean = stripComments(src);

  const enumBody = cutEnumBody(clean);
  const msgBody = cutMessageBody(clean);
  if (enumBody === null) {
    findings.push(`${label}：找不到 \`export enum ErrorCode { … }\` 的配平块 —— 声明本身残缺`);
    return { findings, declared: [], mapped: [], ok: false };
  }
  if (msgBody === null) {
    findings.push(`${label}：找不到 \`export const ERROR_MESSAGE … = { … }\` 的配平块 —— 文案表残缺`);
    return { findings, declared: [], mapped: [], ok: false };
  }

  const declared = parseDeclarations(enumBody);
  const mappings = parseMappings(msgBody);

  // 声明侧的畸形：值不是数字字面量（枚举别名 / 表达式）—— 无法与文案表对齐
  const nameToValue = new Map();
  const valueToName = new Map();
  for (const d of declared) {
    if (d.value === null) {
      findings.push(`${label}：枚举项 \`${d.name}\` 的值不是数字字面量（\`${d.raw}\`）—— 无法与文案表机械对齐`);
      continue;
    }
    if (nameToValue.has(d.name)) {
      findings.push(`${label}：枚举项 \`${d.name}\` 被声明了两次`);
    }
    nameToValue.set(d.name, d.value);
    if (!valueToName.has(d.value)) valueToName.set(d.value, d.name);
  }

  // ① 每个声明必须有文案；③ 同一码不得被映射两次
  const seen = new Map();
  for (const m of mappings) {
    const code = m.kind === 'name' ? nameToValue.get(m.key) : m.key;
    const display = m.kind === 'name' ? `${m.key}${code === undefined ? '' : `(${code})`}` : `${m.key}`;
    if (code === undefined) {
      findings.push(`${label}：文案表里有一个**未声明**的码 \`${display}\` —— 幽灵表述（②）`);
      continue;
    }
    if (seen.has(code)) {
      findings.push(`${label}：码 \`${display}\` 被映射了两次（后者静默覆盖前者 —— 同一件事两份表述）`);
      continue;
    }
    seen.set(code, display);
  }

  const missing = [];
  for (const [name, value] of nameToValue) {
    if (!seen.has(value)) missing.push(`${name} = ${value}`);
  }
  if (missing.length) {
    findings.push(
      `${label}：${missing.length} 个已声明的错误码**在 ERROR_MESSAGE 里没有文案** ⇒ ` +
        `落到 biz.exception.ts 的「业务异常」兜底，用户看不到任何原因。缺的是：${missing.join(' / ')}`,
    );
  }

  return { findings, declared: [...nameToValue.keys()], mapped: [...seen.keys()], ok: findings.length === 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 自证：断言「必报的报得出 / 必不报的不报」
// ─────────────────────────────────────────────────────────────────────────────
/** 合成一个最小 error-code.ts（枚举 + 文案表） */
const synth = (enumLines, msgLines) =>
  [
    'export enum ErrorCode {',
    ...enumLines,
    '}',
    '',
    'export const ERROR_MESSAGE: Record<number, string> = {',
    ...msgLines,
    '};',
  ].join('\n');

function selfTest() {
  const bad = [];
  let n = 0;
  const t = (name, cond, detail = '') => {
    n++;
    if (!cond) bad.push(`${name}${detail ? `（${detail}）` : ''}`);
  };
  /** 报出的文本里必须点名到某个码 */
  const names = (src) => check(src, '样本').findings.join('\n');

  // ① 必不报：完全覆盖（含注释干扰 + 字符串里带 `//`）
  const cleanSrc = synth(
    ['  A = 1,', '  B = 2,', '  /** 注释里写 C = 3 也不能被当成声明 */', "  D = 4, // 'E = 5' 在引号里"],
    ["  [ErrorCode.A]: 'a',", "  [ErrorCode.B]: 'b',", "  [ErrorCode.D]: 'd',"],
  );
  t('① 完全覆盖应不报', check(cleanSrc).ok, JSON.stringify(check(cleanSrc).findings));

  // ① 必报且点名：删掉一条映射（本批缺陷的真实形状）
  const missingSrc = synth(
    ['  A = 1,', '  B = 2,', '  RATING_NOT_ALLOWED = 30020,'],
    ["  [ErrorCode.A]: 'a',", "  [ErrorCode.B]: 'b',"],
  );
  const missingFindings = names(missingSrc);
  t('① 缺映射应报出', !check(missingSrc).ok);
  t('① 缺映射必须**点名**到那个码', /RATING_NOT_ALLOWED\s*=\s*30020/.test(missingFindings), missingFindings);

  // ① 必报：数值键形态也得认（不能因为换了写法就静默放过）
  const numKeySrc = synth(['  A = 1,', '  B = 2,'], ["  [1]: 'a',", "  [ErrorCode.B]: 'b',"]);
  t('① 数值键形态应认得', check(numKeySrc).ok, JSON.stringify(check(numKeySrc).findings));
  const numKeyMissing = synth(['  A = 1,', '  B = 2,'], ["  [1]: 'a',"]);
  t(
    '① 数值键缺 B 应点名',
    !check(numKeyMissing).ok && /B\s*=\s*2/.test(names(numKeyMissing)),
    names(numKeyMissing),
  );

  // ② 必报：文案表里有未声明的码（幽灵表述）
  const ghostSrc = synth(['  A = 1,'], ["  [ErrorCode.A]: 'a',", "  [ErrorCode.GHOST]: 'g',"]);
  t('② 未声明的码应报出', /未声明/.test(names(ghostSrc)), names(ghostSrc));
  t('② 未声明的码应点名', /GHOST/.test(names(ghostSrc)), names(ghostSrc));

  // ③ 必报：同一个码映射两次
  const dupSrc = synth(['  A = 1,'], ["  [ErrorCode.A]: 'a1',", "  [ErrorCode.A]: 'a2',"]);
  t('③ 重复映射应报出', /映射了两次/.test(names(dupSrc)), names(dupSrc));

  // 结构性残缺必报（块不配平 ⇒ 不许静默放行）
  t('块残缺应报出', check('export enum ErrorCode { A = 1,').findings.length > 0);
  t('缺文案表应报出', check('export enum ErrorCode { A = 1, }').findings.length > 0);

  // 必不报：注释里出现的 `[ErrorCode.X]` 不构成映射（曾让同类判据恒绿的老陷阱）
  const commentedSrc = synth(['  A = 1,'], ["  [ErrorCode.A]: 'a',", '  // [ErrorCode.ZZZ]: 只是注释']);
  t('注释里的键不算映射', check(commentedSrc).ok, JSON.stringify(check(commentedSrc).findings));

  if (bad.length) {
    console.error('✘ 错误码文案门禁自证失败（检查器本身不可信，拒绝给出结论）：');
    for (const b of bad) console.error(`   · ${b}`);
    process.exit(2);
  }
  console.log(`✔ 自证 ${n}/${n}：必报的报得出、必不报的不报（合成样本）`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────
selfTest();

if (!existsSync(TARGET)) {
  console.error(`✘ 找不到错误码真源：${TARGET} —— 「声明 ↔ 文案」无从对账`);
  process.exit(1);
}

const rel = 'apps/api-server/src/common/constants/error-code.ts';
const { findings, declared, mapped, ok } = check(readFileSync(TARGET, 'utf8'), rel);

if (!ok) {
  console.error(`✘ 错误码文案覆盖不全（${findings.length} 项）：`);
  for (const f of findings) console.error(`   · ${f}`);
  console.error(
    '\nℹ 处置：在 `ERROR_MESSAGE` 里为被点名的每个码补一条文案；' +
      '若该码确已废弃，请连同枚举声明一起删除（只删一半就是两份表述）。',
  );
  process.exit(1);
}

console.log(
  `✔ 错误码文案全覆盖：声明 ${declared.length} 个码 · 文案 ${mapped.length} 条 · ` +
    `无幽灵码 · 无重复映射（真源 ${rel}）`,
);

#!/usr/bin/env node
/**
 * `lock:version` · **装饰性乐观锁**静态门禁
 *
 * ## 它看的是什么
 *
 * 本仓的乐观锁约定：写一行时要
 *   · SET 里用 **SQL 表达式**自增：`version: () => 'version + 1'`；
 *   · WHERE 里带占位谓词：`version = :v`（钱/订单状态）或 `status = :st`（状态占位）。
 *
 * 而下面这种写法是**装饰性的** —— `version` 用的是**内存快照值**，WHERE 里通常只有 `id`：
 *
 *   `.update({ id }, { quantity, version: (order.version ?? 0) + 1 })`
 *
 * 后果：两路并发都能成功，后写者用自己那份旧快照把前者**整行覆盖**，且**任何一方都不报错**
 * （表现是「改了但没生效」）。同族缺陷：#81（余额域已收口）+ 2026-10-08 复查 P1-5 / BE-05。
 *
 * ⇒ 本门禁的判据：**SET 里出现 `version: (X.version ?? 0) + 1` 即红**（除白名单）。
 *
 * ## ⚠️ 白名单不是「悄悄放行」
 *
 * 备货链路还有 3 处刻意保留该写法（`order.service.ts` 的 `soldCount`、
 * `supplier.service.ts` 的 `planQuantity` ×2），理由写在它们**原地注释**里
 * （「写派生值 + 单写者 + 幂等」）。本门禁对白名单有三条硬约束：
 *   ① 每条白名单**必须写明理由**（空理由 ⇒ 红）；
 *   ② 每条白名单**必须真的被命中**（没命中 ⇒ 红：要么代码已修好、白名单该删，
 *      要么键写错了在假装放行 —— 两种都必须浮出来）；
 *   ③ 白名单条目会被**显式打印**（含理由），不静默。
 *
 * ## 自证（**必报 + 必不报**双样本，防恒绿）
 *
 * 与 `state:audit` / `gate:parity` 同款：本脚本每次运行都拿合成样本验一遍自己 ——
 *   · 合成一段装饰性写法  ⇒ **必须报出**；
 *   · 合成一段正确写法    ⇒ **必须不报**；
 *   · 白名单未命中 ⇒ **必须报**；白名单命中 ⇒ **必须不报**。
 * 任何一条不满足即 EXIT 1（「恒绿的检查」比没有检查更糟）。
 *
 * 用法：node scripts/check-optimistic-lock.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'apps', 'api-server', 'src');

/** 装饰性写法：SET 里的 `version: (X.version ?? 0) + 1` */
const DECORATIVE_RE = /version:\s*\(\s*([A-Za-z_$][\w$.]*)\s*\?\?\s*0\s*\)\s*\+\s*1/g;

/** 扫描排除（测试 / 种子 / 迁移 / 声明文件） */
const EXCLUDED_DIRS = ['test', 'seeds', 'migrations', 'node_modules'];
const EXCLUDED_SUFFIX = ['.spec.ts', '.d.ts'];

/**
 * 白名单（**每条必须有 reason** · 键 = `相对路径:SET 里第一个字段`）
 *
 * ⚠️ 改这里的任何一条，都必须同步改代码里那处**原地注释**（两处必须说同一句话）。
 */
const ALLOWED = [
  {
    key: 'modules/order/order.service.ts:soldCount',
    reason:
      '备货定格：写的是**重算值**（按当日订单聚合）而非读-改-写，方法幂等；单写者（跑批 + 幂等补跑）。' +
      '出现第二个动 `sold_count` 的写点时须改真 CAS —— 原地注释已写明。',
  },
  {
    key: 'modules/supplier/supplier.service.ts:planQuantity',
    reason:
      '生产计划生成：写的是**派生值**（由计划重算）+ 带 `status = DAILY_PENDING` 闸门 + 单写者。' +
      '出现第二个动 `plan_quantity` 的写点时须改真 CAS —— 原地注释已写明（daily / detail 两处同一键名）。',
  },
];

/** 收集所有 .ts 源文件（排除目录与后缀） */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!EXCLUDED_DIRS.includes(name)) walk(p, out);
      continue;
    }
    if (name.endsWith('.ts') && !EXCLUDED_SUFFIX.some((s) => name.endsWith(s))) out.push(p);
  }
  return out;
}

/**
 * 去掉注释后再扫（**关键**）
 *
 * ⚠️ 本仓大量注释/JSDoc 会**引用**装饰性写法来讲解它（「改前写成 `version: (x.version ?? 0) + 1` …
 * 乐观锁等于没上」）。不剥注释的话，每一处**讲解**都会被判成违规 —— 注释越多越红，
 * 这是假阳性，且会逼着后人不敢在注释里引用旧写法（那才是真正的损失）。
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
      if (c === "'" || c === '"' || c === '`') {
        mode = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl';
        out += c;
        i += 1;
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
        // 保留一个空格，避免注释把两个 token 粘在一起
        out += ' ';
        continue;
      }
      if (c === '\n') out += c; // 保住行号
      i += 1;
      continue;
    }
    // 字符串内部：只处理转义与结束引号
    if (c === '\\') {
      out += c + (n ?? '');
      i += 2;
      continue;
    }
    if (
      (mode === 'sq' && c === "'") ||
      (mode === 'dq' && c === '"') ||
      (mode === 'tpl' && c === '`')
    ) {
      mode = 'code';
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 取 `version:` 所在 SET 对象里的**第一个字段**，用作白名单键的右半段 */
function firstFieldOfSet(text, matchStart) {
  const open = text.lastIndexOf('{', matchStart);
  if (open < 0) return '*';
  const head = text.slice(open + 1, matchStart);
  const m = /([A-Za-z_$][\w$]*)\s*:/.exec(head);
  return m ? m[1] : '*';
}

/**
 * 扫描一段源码文本，返回装饰性写法清单
 * @param {string} text 源码
 * @param {string} relKey 用于白名单匹配的 `相对路径`（合成样本传 '__synthetic__'）
 */
function scanText(text, relKey) {
  const found = [];
  const src = relKey === '__synthetic__' ? text : stripComments(text);
  DECORATIVE_RE.lastIndex = 0;
  let m;
  while ((m = DECORATIVE_RE.exec(src)) !== null) {
    const before = src.slice(0, m.index);
    const line = before.split('\n').length;
    found.push({
      file: relKey,
      line,
      field: firstFieldOfSet(src, m.index),
      expr: m[0],
      key: `${relKey}:${firstFieldOfSet(src, m.index)}`,
    });
  }
  return found;
}

/** 白名单裁决：返回 { violations, usedKeys } */
function judge(findings) {
  const violations = [];
  const used = new Set();

  for (const f of findings) {
    const allow = ALLOWED.find((a) => a.key === f.key);
    if (!allow) {
      violations.push(
        `装饰性乐观锁（无白名单依据）：${f.file}:${f.line} · SET 首个字段 \`${f.field}\` · \`${f.expr}\`` +
          ` ⇒ 改为 \`version: () => 'version + 1'\` 并在 WHERE 带 \`version = :v\`（或状态占位）`,
      );
      continue;
    }
    if (!allow.reason || !allow.reason.trim()) {
      violations.push(`白名单条目 \`${allow.key}\` 缺少理由 —— 不许静默放行`);
      continue;
    }
    used.add(allow.key);
  }

  // ② 白名单必须被命中（防「代码已修好 / 键写错」两种腐烂）
  for (const a of ALLOWED) {
    if (!used.has(a.key)) {
      violations.push(
        `白名单条目 \`${a.key}\` **未被命中** —— 要么该处已修好（请删掉这条白名单），` +
          `要么键写错了在假装放行。两种都必须处理，不许留着。`,
      );
    }
  }

  return { violations, usedKeys: used };
}

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
const files = walk(SRC);
const findings = [];
for (const f of files) {
  // 白名单键用**相对 src 的路径**（`modules/order/order.service.ts`），与 ALLOWED 对齐
  const rel = relative(SRC, f).replace(/\\/g, '/');
  findings.push(...scanText(readFileSync(f, 'utf8'), rel));
}
const { violations } = judge(findings);

log(`扫描 ${files.length} 个源文件 · 命中装饰性写法 ${findings.length} 处`);
for (const f of findings) {
  log(`  · ${f.file}:${f.line}  [${f.field}]  ${f.expr}`);
}
log('');
if (!files.length) {
  // ⚠️ 判据空转：扫到 0 个源文件时「0 命中」也会被判通过 —— 与「恒绿」同罪
  fail('真实扫描 · 扫到 0 个源文件（判据空转，结论不可信）', `SRC=${SRC}`);
}
if (ALLOWED.length) {
  log(`白名单 ${ALLOWED.length} 条（**显式列出**，不静默）：`);
  for (const a of ALLOWED) log(`  · ${a.key} —— ${a.reason}`);
  log('');
}

if (violations.length) {
  for (const v of violations) fail(v);
} else {
  ok('真实扫描 · 装饰性乐观锁 0 处违规（其余均在白名单且理由已写明）', `命中=${findings.length}`);
}

// ---- 2. 自证（**必报 + 必不报**双样本）
const SYN_DECORATIVE = `
  await this.repo.update(
    { id: x.id },
    { quantity: 3, version: (x.version ?? 0) + 1 },
  );
`;
const SYN_CORRECT = `
  await m.createQueryBuilder().update(Order)
    .set({ quantity: 3, version: () => 'version + 1' })
    .where('id = :id AND version = :v', { id: x.id, v: x.version })
    .execute();
`;

const synHit = scanText(SYN_DECORATIVE, '__synthetic__');
if (synHit.length === 1) ok('自证① · 装饰性写法**必报**（合成样本命中 1 条）');
else fail('自证① · 装饰性写法**必报**（合成样本应命中 1 条）', `实际=${synHit.length}`);

const synClean = scanText(SYN_CORRECT, '__synthetic__');
if (synClean.length === 0) ok('自证② · 正确写法**必不报**（SQL 表达式自增 + version 谓词）');
else fail('自证② · 正确写法**必不报**', `实际=${synClean.length}`);

// 自证③：合成命中落在白名单之外 ⇒ judge 必须报
const synJudge = judge([
  {
    file: '__synthetic__',
    line: 1,
    field: 'quantity',
    expr: 'version: (x.version ?? 0) + 1',
    key: '__synthetic__:quantity',
  },
]);
if (synJudge.violations.length >= 1) ok('自证③ · 白名单外的命中**必报**');
else fail('自证③ · 白名单外的命中**必报**', `实际 violations=${synJudge.violations.length}`);

// 自证④：真实扫描的结果若为空 ⇒ 白名单「未被命中」必报（防白名单腐烂）
const rotJudge = judge([]);
if (rotJudge.violations.length === ALLOWED.length)
  ok('自证④ · 白名单**未被命中必报**（防代码已修好却留着白名单）', `应报=${ALLOWED.length}`);
else
  fail(
    '自证④ · 白名单**未被命中必报**',
    `应报=${ALLOWED.length} 实际=${rotJudge.violations.length}`,
  );

// ---- 自证汇总（`gate.mjs` 的 REPORT_RE 消费这一行；分母为 0 = 判据空转）
const synAll = results.filter((r) => r.name.startsWith('自证'));
const synPass = synAll.filter((r) => r.pass).length;
log(`[自证] ${synPass}/${synAll.length} 通过`);

// ---- 汇总
const failed = results.filter((r) => !r.pass);
log('');
log(`──────── 汇总 ────────`);
log(`通过 ${results.length - failed.length}/${results.length}${failed.length ? '' : ' · 全绿 ✅'}`);
process.exit(failed.length ? 1 : 0);

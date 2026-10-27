#!/usr/bin/env node
/**
 * D3 提现规则 + N3 计数 fail-closed —— 静态约束门禁
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * D3 的规则（起提不限 / 单日 ¥2000 / 当日 1 笔）**分散在四处表述**：
 *   ① `config.specs.ts`（后台配置页登记）② `biz-config.service.ts`（默认值）
 *   ③ `error-code.ts`（错误码 + 文案）④ `withdraw.service.ts`（真正的判定）
 * 这四处是**同一件事的四份表述**，与 `schema:parity` / `errcode:message` 同族病根：
 * 不被自动化执行的那一份必然悄悄错掉。典型失效方式：
 *   · 后台加了配置项、配置页看得见，但 `apply()` 里忘了判 ⇒ **限额形同虚设**；
 *   · 判定写在了事务**外**（事务外读、事务内写 ⇒ 并发两个请求都读到旧值、都通过）
 *     ⇒ 看起来有校验，压测一并发就穿；
 *   · 时间区间手写 `.replace('Z','+08:00')` ⇒ 差 8 小时，跨零点算错自然日。
 *
 * N3 同族：`KvService.incr` 的 fail-closed 只是「一半」——
 * 若限流中间件仍是 fail-open，抛错后照样放行，**保护等于没做**。
 * 故本文件同时守「两处必须成对改」：`incr` 不许降级 + 安全规则必须 `failClosed`。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────────
 *   D3-1 三个提现配置键在 `config.specs.ts` 登记，`wiring: 'live'`
 *   D3-2 `biz-config.service.ts` 三个方法存在且默认值正确（0 / 2000 / 1）
 *        ⚠️ 起提缺省 = **0（不限起提）**，由项目负责人 2026-10-27 裁定。
 *           2026-10-27 白天曾按 `docs/ABox一盒接口规范v1.0.md` 的旧文案（≥ ¥10.00）
 *           改成 10，负责人复核后要「不限起提」，故代码与文档一并回 0。
 *           ⇒ 本条日后若被改成 10，属于**推翻已签字的业务裁定**，必须先重新签字。
 *   D3-3 错误码 40024 / 40025 在 enum 与 ERROR_MESSAGE **两处**都登记
 *   D3-4 两个新错误码的**判定发生在事务内**（防并发穿透）
 *   D3-5 自然日区间用 `bjDateTime(…, 24)` 含尾上界（禁手写时区偏移）
 *   D3-6 计入当日额度的状态**不含** REJECTED / FAILED（钱已解冻，再拦等于罚站长）
 *   D3-7 seed 与默认值一致（新环境出厂即「不限起提」，与 2026-10-27 裁定一致）
 *   D3-8 T+1 可观测：后台清单下发 waitHours / expectedArrivalAt / overdue
 *   N3-1 `incr` 方法体内**不得**出现降级路径（`useMemory` / `catch` / `degraded =`）
 *   N3-2 两条登录规则设 `failClosed: true`；`order:create` **不得**设（可用性优先）
 *   N3-3 中间件 catch 分支按 `rule.failClosed` 分流（否则 fail-closed 落不了地）
 *   N3-4 `auth.service` 登录失败计数 catch 内**抛 BizException 拒绝登录**（禁裸 Error、
 *        禁改回 fail-open）
 *   X1-1 `user.service` 不得再承诺那个并不存在的重算实现
 *        （⚠️ 连**解释性注释**里也不许复述旧词 —— 那会让本判据永远命中自己）
 *
 * ── 取数口径（为什么是自己扫文本，而不是引 ts 编译器）─────────────────────────
 * 与 `check-gate-parity.mjs` / `check-error-code-message.mjs` 同源：引编译器会引入
 * 传递依赖漂移，而本判据要的是「声明处与判定处逐条对齐」这种**结构事实**。
 *
 * ⚠️ **取块必须先剥注释**：括号配平会被注释里的括号破坏 —— 实测
 * `// 3 + 4)` 这一行里的 `)` 让事务块被截成 58 字符（判据因此恒红）。
 *
 * ── 自证（必做：恒绿或恒红的检查等于没有检查）─────────────────────────────────
 * 每条判据配一个**破化函数** `mutate`：从**真实文件**里破坏它守的那处表述，
 * 断言 `pred(mutate(realText)) === false`（必报的报得出）；
 * 并以**真实且未改动的文件**断言 `pred(realText) === true`（必不报的不报）。
 * 任一侧不符 ⇒ **exit 2**（检查器自身坏掉，不静默放行）。
 *
 * ⚠️ 首轮自证已抓出 5 条判据缺陷（配平被注释破坏 / 数组取块用了 `{` / mutate 没真正
 *    破坏判据 / 判据过宽），都是这类检查最典型的坑 —— 保留此段以免重蹈。
 *
 * 退出码：0 通过 · 1 有违规 · 2 自证失败
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'apps', 'api-server', 'src');
const F = {
  specs: join(SRC, 'modules', 'admin', 'config', 'config.specs.ts'),
  bizConfig: join(SRC, 'common', 'services', 'biz-config.service.ts'),
  errCode: join(SRC, 'common', 'constants', 'error-code.ts'),
  withdraw: join(SRC, 'modules', 'finance', 'withdraw.service.ts'),
  withdrawAdmin: join(SRC, 'modules', 'finance', 'withdraw-admin.service.ts'),
  kv: join(SRC, 'common', 'cache', 'kv.service.ts'),
  rateLimit: join(SRC, 'common', 'middleware', 'rate-limit.middleware.ts'),
  auth: join(SRC, 'modules', 'auth', 'auth.service.ts'),
  user: join(SRC, 'modules', 'user', 'user.service.ts'),
  seed: join(SRC, 'database', 'seeds', 'seed.ts'),
};

/**
 * 剥离注释（保留字符串字面量）
 *
 * ⚠️ 注释里的括号会破坏括号配平（实测 `// 3 + 4)` 把事务块截成 58 字符 ⇒ 判据恒红）。
 * ⚠️ 简化版：不识别正则字面量。已确认受检文件（`withdraw.service` / `kv.service`）
 *    不含正则字面量，故不会误删。
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
        continue;
      }
      i += 1;
      continue;
    }
    out += c;
    if (c === '\\') {
      out += src[i + 1] ?? '';
      i += 2;
      continue;
    }
    const end = mode === 'sq' ? "'" : mode === 'dq' ? '"' : '`';
    if (c === end) mode = 'code';
    i += 1;
  }
  return out;
}

/** 从 startMark 起按花括号配平取块 */
function blockOf(text, startMark) {
  const i = text.indexOf(startMark);
  if (i < 0) return '';
  const open = text.indexOf('{', i);
  if (open < 0) return '';
  let depth = 0;
  for (let j = open; j < text.length; j += 1) {
    if (text[j] === '{') depth += 1;
    else if (text[j] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return text.slice(i);
}

function methodOf(text, name) {
  return blockOf(text, `async ${name}(`);
}

/** 取 RATE_LIMIT_RULES 里 label 为 `x` 的那一条对象块 */
function ruleBlockOf(text, label) {
  const i = text.indexOf(`label: '${label}'`);
  if (i < 0) return '';
  const start = text.lastIndexOf('{', i);
  let depth = 0;
  for (let j = start; j < text.length; j += 1) {
    if (text[j] === '{') depth += 1;
    else if (text[j] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  return '';
}

/** 取 `this.dataSource.transaction(` 的整个调用（含回调体）。**必须先剥注释** */
function transactionBlockOf(text) {
  const i = text.indexOf('this.dataSource.transaction(');
  if (i < 0) return '';
  const open = text.indexOf('(', i);
  let depth = 0;
  for (let j = open; j < text.length; j += 1) {
    if (text[j] === '(') depth += 1;
    else if (text[j] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return text.slice(i);
}

// ── 判据：每条 `pred(text) === true` 表示**通过** ────────────────────────────
// `mutate` 从真实文本里破坏它守的那处表述（自证「必报的报得出」）
const RULES = [
  {
    id: 'D3-1',
    desc: '三个提现配置键在 config.specs 登记且 wiring: live',
    file: 'specs',
    pred: (t) => {
      for (const k of [
        'commission.min_withdraw',
        'commission.withdraw_daily_limit',
        'commission.withdraw_daily_count',
      ]) {
        const b = blockOf(t, `key: '${k}'`);
        if (!b || !/wiring:\s*'live'/.test(b)) return false;
      }
      return true;
    },
    mutate: (t) => t.replace("key: 'commission.withdraw_daily_limit'", "key: 'x_removed'"),
  },
  {
    id: 'D3-2',
    desc: 'biz-config 三个方法存在且默认值正确（min=0 不限起提 / limit=2000 / count=1）',
    file: 'bizConfig',
    pred: (t) =>
      /minWithdraw\(\)[\s\S]{0,200}?getNumber\('commission\.min_withdraw',\s*0\)/.test(t) &&
      /withdrawDailyLimit\(\)[\s\S]{0,200}?getNumber\('commission\.withdraw_daily_limit',\s*2000\)/.test(
        t,
      ) &&
      /withdrawDailyCount\(\)[\s\S]{0,200}?getNumber\('commission\.withdraw_daily_count',\s*1\)/.test(
        t,
      ),
    mutate: (t) =>
      t.replace("'commission.withdraw_daily_limit', 2000", "'commission.withdraw_daily_limit', 9999"),
  },
  {
    id: 'D3-3',
    desc: '错误码 40024 / 40025 在 enum 与 ERROR_MESSAGE 两处都登记',
    file: 'errCode',
    pred: (t) =>
      /WITHDRAW_DAILY_LIMIT_EXCEEDED = 40024/.test(t) &&
      /WITHDRAW_DAILY_DUPLICATED = 40025/.test(t) &&
      /\[ErrorCode\.WITHDRAW_DAILY_LIMIT_EXCEEDED\]/.test(t) &&
      /\[ErrorCode\.WITHDRAW_DAILY_DUPLICATED\]/.test(t),
    mutate: (t) => t.replace('  [ErrorCode.WITHDRAW_DAILY_DUPLICATED]:', '  // removed:'),
  },
  {
    id: 'D3-4',
    desc: '当日笔数/额度判定发生在事务内（防并发穿透）',
    file: 'withdraw',
    pred: (t) => {
      // ⚠️ 必须先剥注释：事务体里的 `// 3 + 4)` 会让括号配平提前闭合
      const tx = transactionBlockOf(stripComments(t));
      if (!tx) return false;
      return (
        tx.includes('WITHDRAW_DAILY_DUPLICATED') && tx.includes('WITHDRAW_DAILY_LIMIT_EXCEEDED')
      );
    },
    mutate: (t) => t.replace('WITHDRAW_DAILY_DUPLICATED,', 'WITHDRAW_BELOW_MIN,'),
  },
  {
    id: 'D3-5',
    desc: '自然日区间用 bjDateTime(todayBj(), 24) 取含尾上界（禁手写时区偏移）',
    file: 'withdraw',
    pred: (t) => /bjDateTime\(todayBj\(\),\s*24\)/.test(t),
    mutate: (t) => t.replace('bjDateTime(todayBj(), 24)', 'new Date()'),
  },
  {
    id: 'D3-6',
    desc: '计入当日额度的状态不含 REJECTED / FAILED',
    file: 'withdraw',
    pred: (t) => {
      /**
       * 该常量是数组字面量 `[...]`，不是块 —— 用 `]` 收尾，别用 blockOf（它找 `{`）。
       *
       * ⚠️ **必须跳过 `string[]` 里的那个 `]`**：直接写
       * `/const DAILY_COUNTED_STATUS[\s\S]*?\]/` 会在 `string[]` 处就结束，
       * 捕获到的根本不是数组内容 ⇒ 判据**恒绿**（首轮自证抓到的就是这个）。
       * 故显式跳过 `=`，从 `[` 之后开始取。
       */
      const m = t.match(/const DAILY_COUNTED_STATUS[^=]*=\s*\[([\s\S]*?)\]/);
      if (!m) return false;
      return !/REJECTED|FAILED/.test(m[1]);
    },
    mutate: (t) =>
      t.replace('\n  WithdrawStatus.PENDING,', '\n  WithdrawStatus.PENDING,\n  WithdrawStatus.REJECTED,'),
  },
  {
    id: 'D3-7',
    desc: 'seed 与缺省一致：起提 0.00（不限起提）· 上限 2000 · 笔数 1',
    file: 'seed',
    pred: (t) =>
      /\['commission\.min_withdraw',\s*'0\.00'/.test(t) &&
      /\['commission\.withdraw_daily_limit',\s*'2000\.00'/.test(t) &&
      /\['commission\.withdraw_daily_count',\s*'1'/.test(t),
    mutate: (t) => t.replace("['commission.min_withdraw', '0.00'", "['commission.min_withdraw', '10.00'"),
  },
  {
    id: 'D3-8',
    desc: 'T+1 可观测：后台清单下发 waitHours / expectedArrivalAt / overdue',
    file: 'withdrawAdmin',
    pred: (t) =>
      /private expectedArrivalOf\(/.test(t) &&
      /\bwaitHours,/.test(t) &&
      /expectedArrivalAt:/.test(t) &&
      /\boverdue,/.test(t),
    mutate: (t) => t.replace('        overdue,\n', ''),
  },
  {
    id: 'N3-1',
    desc: 'KvService.incr 体内不得有降级路径（useMemory / catch / degraded =）',
    file: 'kv',
    pred: (t) => {
      const b = methodOf(stripComments(t), 'incr');
      if (!b) return false;
      return !/useMemory\s*\(\)|catch|this\.degraded\s*=/.test(b);
    },
    // 把降级路径「加回」体内 —— 只改条件不引入 catch 的话，判据不会变红（首轮踩过）
    mutate: (t) =>
      t.replace(
        '      const n = await this.redis.incr(key);',
        '      try { const n = await this.redis.incr(key); } catch { this.degraded = true; return this.incr(key, ttlSec); } const n2 = 0;',
      ),
  },
  {
    id: 'N3-2',
    desc: '两条登录规则 failClosed: true；order:create 不得设',
    file: 'rateLimit',
    pred: (t) => {
      const a = ruleBlockOf(t, 'auth:admin-login');
      const b = ruleBlockOf(t, 'auth:login');
      const c = ruleBlockOf(t, 'order:create');
      if (!a || !b || !c) return false;
      return /failClosed:\s*true/.test(a) && /failClosed:\s*true/.test(b) && !/failClosed/.test(c);
    },
    mutate: (t) =>
      t.replace(
        '    // 同 `auth:admin-login`：登录是安全边界，计数不可用 ⇒ 不放行\n    failClosed: true,\n',
        '',
      ),
  },
  {
    id: 'N3-3',
    desc: '限流中间件 catch 分支按 rule.failClosed 分流（否则 fail-closed 落不了地）',
    file: 'rateLimit',
    pred: (t) => /if\s*\(rule\.failClosed\)/.test(t),
    mutate: (t) => t.replace('if (rule.failClosed) {', 'if (false) {'),
  },
  {
    id: 'N3-4',
    desc: 'auth 登录失败计数：catch 内抛 BizException 拒绝登录（禁裸 Error / 禁改回放行）',
    file: 'auth',
    pred: (t) => {
      const i = t.indexOf('await this.kv.incr(failKey, lockSec)');
      if (i < 0) return false;
      const tail = t.slice(i, i + 700);
      return (
        /\} catch \(/.test(tail) &&
        /拒绝登录（fail-closed）/.test(tail) &&
        /throw new BizException/.test(tail)
      );
    },
    mutate: (t) => t.replace('拒绝登录（fail-closed）', '本次放行（fail-open）'),
  },
  {
    id: 'X1-1',
    desc: 'user.service 不得再承诺那个并不存在的重算实现（连注释里也不行）',
    file: 'user',
    pred: (t) => !/待重算/.test(t),
    mutate: (t) => t.replace('并不存在的重算**', '待重算**'),
  },
];

// ── 自证 ────────────────────────────────────────────────────────────────────
const cache = new Map();
function read(key) {
  if (!cache.has(key)) cache.set(key, readFileSync(F[key], 'utf8'));
  return cache.get(key);
}

let selfFail = 0;
console.log('──────── 自证（每条判据：必报的报得出 · 必不报的不报）────────');
for (const r of RULES) {
  const real = read(r.file);

  // ① 必不报：真实且未改动的文件必须判「通过」
  const passOnReal = r.pred(real);
  // ② 必报：破化后的文本必须判「不通过」
  const broken = r.mutate(real);
  const changed = broken !== real;
  const failOnBroken = !r.pred(broken);

  const ok = passOnReal && changed && failOnBroken;
  if (!ok) {
    selfFail += 1;
    console.log(
      `✘ ${r.id} 自证失败 · 真文件通过=${passOnReal} · 破化生效=${changed} · 破化后报错=${failOnBroken}`,
    );
  } else {
    console.log(`✔ ${r.id} 自证通过`);
  }
}
if (selfFail) {
  console.error(`\n自证失败 ${selfFail} 条 ⇒ 检查器自身不可信，退出 2`);
  process.exit(2);
}

// ── 真检 ────────────────────────────────────────────────────────────────────
console.log('\n──────── 真检 ────────');
let bad = 0;
for (const r of RULES) {
  const ok = r.pred(read(r.file));
  if (!ok) {
    bad += 1;
    console.log(`✘ ${r.id} ${r.desc}`);
  } else {
    console.log(`✔ ${r.id} ${r.desc}`);
  }
}

console.log('\n──────── 汇总 ────────');
if (bad) {
  console.error(`不通过 ${bad}/${RULES.length} ❌`);
  process.exit(1);
}
console.log(`通过 ${RULES.length}/${RULES.length} · 全绿 ✅`);

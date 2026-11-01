#!/usr/bin/env node
/**
 * 从 api-server 源码生成「企微操作助手」可执行端点全目录。
 *
 * 为什么不用运行时 OpenAPI：
 *   线上 `/docs-json` 被 admin 前端静态站 fallback 掉了（实测返回 index.html），
 *   而本地起服务要连 DB。源码解析可复现、可在门禁里跑，且**不会**因为某个装饰器
 *   忘了加而静默漏掉端点 —— 漏了会在这里报出来。
 *
 * 产物：apps/api-server/src/modules/wecom-kb/op-catalog.generated.ts
 *
 * 数据以 **JSON 字符串字面量**内嵌（不是对象字面量）。原因：门禁要判断「目录与源码
 * 是否一致」，而对象字面量会被 prettier 反复重排（引号 / 尾逗号 / 换行）——
 * 实测连续三轮假红。字符串内容 prettier 不动，于是「生成 → 格式化 → 校验」稳定一致；
 * 校验侧 JSON.parse 后深比较，比的是事实（端点/角色/参数），不是排版。
 *
 * 自证（缺一不可）：
 *   ① 端点总数须等于独立探针（另一种算法）的数；
 *   ② 每个端点须能定位到「文件:行号」；
 *   ③ 样本 POST /admin/dishes 的必填字段须与 DTO 真源一致，且不许出现「装饰器续行被
 *      误判成字段」；
 *   ④ 角色常量必须展开（`@Roles(...FUND_ACTION_ROLES)` 不展开会变成「谁都不匹配」，
 *      比空数组更危险：看着有值、实则全错）。
 *
 * 用法：
 *   node scripts/gen-wecom-catalog.mjs            # 生成
 *   node scripts/gen-wecom-catalog.mjs --check    # 只校验（门禁）
 *   node scripts/gen-wecom-catalog.mjs --debug    # 附带解析诊断
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'apps/api-server/src');
const OUT = path.join(SRC, 'modules/wecom-kb/op-catalog.generated.ts');

const CHECK_ONLY = process.argv.includes('--check');
const DEBUG = process.argv.includes('--debug');

/** 去掉字符串字面量后再数括号，避免 description 里的括号把深度算歪 */
function countParens(line) {
  const stripped = line
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``');
  let d = 0;
  for (const ch of stripped) {
    if (ch === '(') d++;
    else if (ch === ')') d--;
  }
  return d;
}

function walkControllers(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkControllers(p, acc);
    else if (ent.name.endsWith('.controller.ts')) acc.push(p);
  }
  return acc;
}

function walkTs(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkTs(p, acc);
    else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.spec.ts')) acc.push(p);
  }
  return acc;
}

function collectDecoratorHints(line, pending) {
  if (/ApiPropertyOptional|@IsOptional/.test(line)) pending.optional = true;
  const desc = /description:\s*'([^']*)'/.exec(line);
  if (desc) pending.hints.push(desc[1]);
  const isIn = /@IsIn\(\s*\[([^\]]*)\]/.exec(line);
  if (isIn) pending.hints.push('取值：' + isIn[1].replace(/['"\s]/g, ''));
  const en = /@IsEnum\((\w+)\)/.exec(line);
  if (en) pending.hints.push('枚举：' + en[1]);
}

function inferType(t) {
  if (/\[\]$/.test(t) || /Array</.test(t)) return 'array';
  if (/number|bigint/i.test(t)) return 'number';
  if (/boolean/i.test(t)) return 'boolean';
  if (/^\{/.test(t)) return 'object';
  if (/^\w+Dto$|^\w+Query$/.test(t)) return 'object';
  return 'string';
}

/**
 * 解析 DTO 类字段。
 * ⚠️ 装饰器可能是多行的（`@ApiProperty({` … `})`），必须按括号深度整块跳过，
 *    否则续行 `description: '...'` 会被误判成一个叫 description 的字段（实测踩过）。
 */
function parseDtoClass(text, className) {
  const lines = text.split('\n');
  const startIdx = lines.findIndex((l) =>
    new RegExp(`^export\\s+class\\s+${className}\\b`).test(l.trim()),
  );
  if (startIdx < 0) return null;
  const params = [];
  let pending = { optional: false, hints: [] };
  let inDec = false;
  let depth = 0;

  for (let i = startIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!inDec && /^\}/.test(raw) && !raw.startsWith('  ')) break;
    if (!line) continue;
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;

    if (inDec) {
      collectDecoratorHints(line, pending);
      depth += countParens(line);
      if (depth <= 0) inDec = false;
      continue;
    }
    if (line.startsWith('@')) {
      collectDecoratorHints(line, pending);
      depth = countParens(line);
      inDec = depth > 0;
      continue;
    }
    const fm = /^([a-zA-Z_]\w*)\s*[!?]?\s*:\s*(.+?);?\s*$/.exec(line);
    if (fm) {
      const t = fm[2].replace(/;\s*$/, '').trim();
      params.push({
        name: fm[1],
        required: !pending.optional,
        type: inferType(t),
        hint: pending.hints.join('；').slice(0, 140) || undefined,
      });
      pending = { optional: false, hints: [] };
    }
  }
  return params.length ? params : null;
}

function buildDtoIndex() {
  const idx = new Map();
  for (const f of walkTs(SRC)) {
    const text = fs.readFileSync(f, 'utf8');
    const names = [...text.matchAll(/^export\s+class\s+(\w+)/gm)].map((m) => m[1]);
    for (const n of names) {
      if (!/Dto$|Query$|Params$|Body$/.test(n)) continue;
      const fields = parseDtoClass(text, n);
      if (fields) idx.set(n, fields);
    }
  }
  return idx;
}

/**
 * 收集角色常量（`export const X_ROLES = [...]` 与 `= Y_ROLES` 别名）。
 * ⚠️ 不展开会得到字面量 `...FUND_ACTION_ROLES`，权限判定变成「谁都不匹配」。
 */
function buildRoleConsts() {
  const arrays = new Map();
  const aliases = new Map();
  for (const f of walkTs(SRC)) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/export const (\w+)\s*=\s*\[([^\]]*)\]/g)) {
      const vals = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      if (vals.length) arrays.set(m[1], vals);
    }
    for (const m of text.matchAll(/export const (\w+)\s*=\s*(\w+)\s*;/g)) aliases.set(m[1], m[2]);
  }
  const resolve = (name, seen = new Set()) => {
    if (arrays.has(name)) return arrays.get(name);
    if (aliases.has(name) && !seen.has(name)) {
      seen.add(name);
      return resolve(aliases.get(name), seen);
    }
    return null;
  };
  const out = new Map();
  for (const n of new Set([...arrays.keys(), ...aliases.keys()])) {
    const v = resolve(n);
    if (v) out.set(n, v);
  }
  return out;
}

function resolveRoles(raw, roleConsts) {
  if (!raw) return { roles: null, unresolved: [] };
  const toks = raw
    .replace(/['"\s]/g, '')
    .split(',')
    .filter(Boolean);
  const out = new Set();
  const unresolved = [];
  for (const t0 of toks) {
    const t = t0.replace(/^\.{3}/, '');
    if (roleConsts.has(t)) for (const r of roleConsts.get(t)) out.add(r);
    else if (/^[a-z][a-z_]*$/.test(t)) out.add(t);
    else unresolved.push(t0);
  }
  return { roles: [...out], unresolved };
}

/**
 * 解析单个 controller。类级 @Roles 与方法级 @Roles 以 `export class` 行号分界：
 * 类级必在 class 之前，方法级必在之后。
 */
function parseController(file, dtoIndex, roleConsts) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const rel = path.relative(SRC, file).replace(/\\/g, '/');
  const out = [];
  const unresolvedRoles = [];

  for (let i = 0; i < lines.length; i++) {
    const cm = /@Controller\(\s*(?:'([^']*)'|"([^"]*)")\s*\)/.exec(lines[i]);
    if (!cm) continue;
    const base = cm[1] ?? cm[2] ?? '';

    let classLine = -1;
    for (let j = i + 1; j < Math.min(i + 40, lines.length); j++) {
      if (/export\s+class\s+(\w+)/.test(lines[j])) {
        classLine = j;
        break;
      }
      if (/\S/.test(lines[j]) && !/^\s*@/.test(lines[j]) && !/^\s*(\*|\/\*|\/\/)/.test(lines[j]))
        break;
    }
    if (classLine < 0) continue;
    const className = /export\s+class\s+(\w+)/.exec(lines[classLine])[1];

    let classRoles = null;
    for (let j = i; j < classLine; j++) {
      const rm = /@Roles\(([^)]*)\)/.exec(lines[j]);
      if (rm) {
        const r = resolveRoles(rm[1], roleConsts);
        classRoles = r.roles;
        for (const u of r.unresolved) unresolvedRoles.push(`${rel}:${j + 1} ${u}`);
      }
    }

    let endLine = lines.length;
    for (let j = classLine + 1; j < lines.length; j++) {
      if (/@Controller\(/.test(lines[j])) {
        endLine = j;
        break;
      }
    }

    for (let j = classLine + 1; j < endLine; j++) {
      const dm = /@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)?/.exec(lines[j]);
      if (!dm) continue;
      const method = dm[1].toUpperCase();
      const sub = dm[2] ?? dm[3] ?? '';
      const fullPath = ('/' + base + (sub ? '/' + sub : '')).replace(/\/+/g, '/');

      let methodRoles = null;
      for (let k = j - 1; k > classLine; k--) {
        if (/@(Get|Post|Put|Patch|Delete)\(/.test(lines[k])) break;
        const rm = /@Roles\(([^)]*)\)/.exec(lines[k]);
        if (rm) {
          const r = resolveRoles(rm[1], roleConsts);
          methodRoles = r.roles;
          for (const u of r.unresolved) unresolvedRoles.push(`${rel}:${k + 1} ${u}`);
          break;
        }
      }
      if (!methodRoles) {
        for (let k = j + 1; k < Math.min(j + 8, endLine); k++) {
          const rm = /@Roles\(([^)]*)\)/.exec(lines[k]);
          if (rm) {
            const r = resolveRoles(rm[1], roleConsts);
            methodRoles = r.roles;
            for (const u of r.unresolved) unresolvedRoles.push(`${rel}:${k + 1} ${u}`);
            break;
          }
          if (/^\s*(?:public\s+|private\s+)?(?:async\s+)?[a-zA-Z_]\w*\s*\(/.test(lines[k])) break;
        }
      }

      // @ApiOperation 的 summary（可能跨行）+ 方法签名起点
      let label = '';
      let sigStart = -1;
      for (let k = j + 1; k < Math.min(j + 40, endLine); k++) {
        const t = lines[k].trim();
        if (!label) {
          const sm = /summary:\s*'([^']*)'/.exec(lines[k]);
          if (sm) label = sm[1].trim();
        }
        if (t.startsWith('@')) {
          if (/^@(Get|Post|Put|Patch|Delete)\(/.test(t)) break;
          continue;
        }
        if (!t) continue;
        if (/^(?:public\s+|private\s+|protected\s+)?(?:async\s+)?[a-zA-Z_]\w*\s*\(/.test(t)) {
          sigStart = k;
          break;
        }
        // 其余都是装饰器内部续行（description: 换行、字符串拼接、}) 收尾），继续往下找
      }
      if (sigStart < 0) sigStart = j;

      let sig = '';
      let depth = 0;
      for (let k = sigStart; k < Math.min(sigStart + 20, endLine); k++) {
        sig += lines[k] + '\n';
        depth += countParens(lines[k]);
        if (depth <= 0 && /[;{]/.test(lines[k])) break;
        if (k > sigStart && depth <= 0) break;
      }

      let methodName = '';
      const mn = /^(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([a-zA-Z_]\w*)\s*\(/m.exec(sig);
      if (mn) methodName = mn[1];

      const pathParams = [...sig.matchAll(/@Param\(\s*'(\w+)'\s*\)/g)].map((m) => m[1]);
      const bodyType = /@Body\(\s*\)\s*\w+\s*:\s*(\w+)/.exec(sig);
      const queryType = /@Query\(\s*\)\s*\w+\s*:\s*(\w+)/.exec(sig);
      const inlineBody = /@Body\(\s*\)\s*\w+\s*:\s*\{/.test(sig);
      const inlineQuery = /@Query\(\s*\)\s*\w+\s*:\s*\{/.test(sig);

      const params = [];
      for (const p of pathParams)
        params.push({ name: p, required: true, type: 'string', in: 'path' });
      if (bodyType) {
        const fields = dtoIndex.get(bodyType[1]);
        if (fields) for (const f of fields) params.push({ ...f, in: 'body' });
        else
          params.push({
            name: '*',
            required: true,
            type: 'object',
            in: 'body',
            hint: `入参见 ${bodyType[1]}`,
          });
      } else if (inlineBody) {
        params.push({ name: '*', required: true, type: 'object', in: 'body', hint: '内联入参对象' });
      }
      if (queryType) {
        const fields = dtoIndex.get(queryType[1]);
        if (fields) for (const f of fields) params.push({ ...f, in: 'query' });
      } else if (inlineQuery) {
        params.push({
          name: '*',
          required: false,
          type: 'object',
          in: 'query',
          hint: '内联查询参数',
        });
      }

      out.push({
        method,
        path: fullPath,
        label: label || methodName,
        roles: methodRoles ?? classRoles ?? null,
        params,
        file: rel,
        line: j + 1,
        controller: className,
        hasBody: Boolean(bodyType || inlineBody),
      });
    }
  }
  return { ops: out, unresolvedRoles };
}

/** 独立探针：另一种算法只数端点个数，用于互证（与主解析器实现不同） */
function independentCount() {
  let n = 0;
  for (const f of walkControllers(SRC)) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    let base = null;
    for (const l of lines) {
      const cm = /@Controller\(\s*'([^']*)'\s*\)/.exec(l);
      if (cm) base = cm[1];
      if (base && /^admin/.test(base) && /@(Get|Post|Put|Patch|Delete)\(/.test(l)) n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- 解析
const dtoIndex = buildDtoIndex();
const roleConsts = buildRoleConsts();
const allOps = [];
const allUnresolvedRoles = [];
for (const f of walkControllers(SRC)) {
  const r = parseController(f, dtoIndex, roleConsts);
  allOps.push(...r.ops);
  allUnresolvedRoles.push(...r.unresolvedRoles);
}
const adminOps = allOps.filter((o) => /^\/admin\//.test(o.path));

// ---------------------------------------------------------------- 自证
const problems = [];
const expectCount = independentCount();
if (adminOps.length !== expectCount)
  problems.push(`端点总数不一致：主解析 ${adminOps.length}，独立探针 ${expectCount}`);
if (adminOps.length === 0) problems.push('解析到 0 个端点 —— 判据恒真，等于没检查');
if (adminOps.filter((o) => !o.file || !o.line).length) problems.push('有端点定位不到文件行号');

if (allUnresolvedRoles.length)
  problems.push(
    `有 ${allUnresolvedRoles.length} 处角色常量未展开（会让权限判定永远不匹配）：` +
      allUnresolvedRoles.slice(0, 5).join(' / '),
  );

const sample = adminOps.find((o) => o.method === 'POST' && o.path === '/admin/dishes');
if (!sample) problems.push('样本 POST /admin/dishes 未解析到');
else {
  const req = sample.params.filter((p) => p.required && p.in === 'body').map((p) => p.name);
  for (const must of ['supplierId', 'name', 'category', 'costPriceFen'])
    if (!req.includes(must)) problems.push(`样本缺必填字段 ${must}（实得：${req.join(',') || '空'}）`);
  if (req.includes('description') && !req.includes('name'))
    problems.push('样本把装饰器续行误判成了字段（description 出现在必填里）');
}

const roleDist = {};
for (const o of adminOps) {
  const k = (o.roles || []).join(',') || '(空)';
  roleDist[k] = (roleDist[k] || 0) + 1;
}
console.error(
  '[自证] 角色分布：' +
    Object.entries(roleDist)
      .map(([k, v]) => `${v}×${k}`)
      .join('；'),
);

const noRoles = adminOps.filter((o) => !o.roles || o.roles.length === 0);
const bodyOps = adminOps.filter((o) => o.hasBody);
const wildcardBody = adminOps.filter(
  (o) => o.hasBody && o.params.some((p) => p.in === 'body' && p.name === '*'),
);
console.error(
  `[自证] 端点 ${adminOps.length}（独立探针 ${expectCount}）；无角色 ${noRoles.length}；` +
    `DTO 索引 ${dtoIndex.size} 类；带 body ${bodyOps.length}（其中入参未解析 ${wildcardBody.length}）`,
);

if (problems.length) {
  console.error('\n[自证失败]');
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}

if (DEBUG) {
  const s = adminOps.find((o) => o.method === 'POST' && o.path === '/admin/dishes');
  console.error('DEBUG sample=' + JSON.stringify(s).slice(0, 600));
}

// ---------------------------------------------------------------- 组装数据
const codeOf = (o) =>
  (o.method + '_' + o.path.replace(/^\/+/, '').replace(/[:/]+/g, '_').replace(/_+$/, ''))
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');

const seen = new Map();
for (const o of adminOps) {
  const c = codeOf(o);
  if (seen.has(c)) problems.push(`opCode 冲突：${c} → ${seen.get(c)} 与 ${o.path}`);
  seen.set(c, o.path);
}
if (problems.length) {
  console.error('\n[opCode 冲突]');
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}

const data = {};
for (const o of adminOps.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method))) {
  data[codeOf(o)] = {
    method: o.method,
    path: o.path,
    label: o.label || o.path,
    roles: o.roles || [],
    source: o.file + ':' + o.line,
    params: o.params.map((p) => {
      const item = { name: p.name, required: p.required, type: p.type, in: p.in };
      if (p.hint) item.hint = p.hint;
      return item;
    }),
  };
}

const sq = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
/**
 * 数据用 **base64** 内嵌，而不是 JSON 字符串字面量。
 *
 * 踩过的坑：JSON 字面量里含 `\"` 与单引号，prettier 会按内容决定用单引号还是双引号
 * 并改写转义（含单引号时保持双引号、否则改单引号）⇒ 校验侧的正则无法稳定匹配，
 * 表现为「目录已漂移 / 无法解析」而实际内容没变。
 * base64 只含 [A-Za-z0-9+/=]，prettier 无从改动一个字，生成/格式化/校验三者恒等。
 */
const b64 = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');

const banner = [
  '/**',
  ' * ⚠️ 自动生成，请勿手工编辑。',
  ' * 生成器：scripts/gen-wecom-catalog.mjs',
  ' * 校验：node scripts/gen-wecom-catalog.mjs --check（门禁 wecom:catalog）',
  ' *',
  ` * 覆盖 api-server 全部 /admin 端点（当前 ${adminOps.length} 个）。`,
  ' * roles 为源码 @Roles 真值（常量已展开）；空数组表示源码未标注 —— 执行前按 tier',
  ' * 兜底判定，绝不默认放行。source 为「文件:行号」，改端点后重跑即可核对漂移。',
  ' *',
  ' * 数据以 base64 内嵌：JSON 字面量会被 prettier 按内容改引号与转义，',
  ' * 导致门禁在「内容没变」时判漂移（实测踩过）；base64 无可改动之处。',
  ' */',
  "import type { CatalogEntry } from './op-catalog.types';",
  '',
  `export const GENERATED_AT = ${sq(new Date().toISOString())};`,
  `export const ADMIN_ENDPOINT_COUNT = ${adminOps.length};`,
  '',
  '/** 端点数据（base64(JSON)，见文件头说明） */',
  'const RAW = JSON.parse(',
  `  Buffer.from('${b64}', 'base64').toString('utf8'),`,
  ') as Record<string, CatalogEntry>;',
  '',
  'export const ADMIN_CATALOG: Record<string, CatalogEntry> = RAW;',
  '',
].join('\n');

/**
 * 从产物里取回数据（base64 → JSON → 对象）
 * ⚠️ 正则要容忍 prettier 加的**尾逗号**与换行：它会把 `Buffer.from('…', 'base64')`
 *    折成多行并在末参后加逗号，写成 `\s*\)` 会 MISS（实测踩过一次，报「无法解析」）。
 */
function extractData(src) {
  const m = /Buffer\.from\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*,\s*['"]base64['"]\s*,?\s*\)/.exec(src);
  if (!m) return null;
  try {
    return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 校验 / 写盘
if (CHECK_ONLY) {
  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const prevData = extractData(prev);
  if (!prevData) {
    console.error('[无法解析] 产物里找不到内嵌数据（可能被手工改坏）；请重跑生成器');
    process.exit(1);
  }
  // 常量必须与数据条数一致：只改常量不改数据时，下面的深比较是过的，
  // 而「对外宣称 131、实际 130」会让 `modules()` 的合计对不上却没人发现。
  const cnt = /export const ADMIN_ENDPOINT_COUNT = (\d+);/.exec(prev);
  const realCount = Object.keys(prevData).length;
  if (!cnt || Number(cnt[1]) !== realCount) {
    console.error(
      `[常量不一致] ADMIN_ENDPOINT_COUNT=${cnt ? cnt[1] : '缺失'}，数据实际 ${realCount} 条`,
    );
    process.exit(1);
  }
  const a = JSON.stringify(prevData);
  const b = JSON.stringify(data);
  if (a !== b) {
    const codes = new Set([...Object.keys(prevData), ...Object.keys(data)]);
    const diff = [];
    for (const c of codes) {
      if (JSON.stringify(prevData[c]) !== JSON.stringify(data[c])) {
        diff.push(c + (prevData[c] ? (data[c] ? '' : '（源码已无）') : '（源码新增）'));
      }
    }
    console.error(`[目录已漂移] ${diff.length} 处不一致：${diff.slice(0, 8).join(' / ')}`);
    if (diff.length > 8) console.error(`  …… 另有 ${diff.length - 8} 处`);
    console.error('请重跑 node scripts/gen-wecom-catalog.mjs');
    process.exit(1);
  }
  console.error('[目录一致] ' + adminOps.length + ' 个端点');
  process.exit(0);
}

fs.writeFileSync(OUT, banner);
console.error(`[已生成] ${path.relative(ROOT, OUT)} —— ${adminOps.length} 个端点`);

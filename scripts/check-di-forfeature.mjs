#!/usr/bin/env node
/**
 * DI 仓储对账：`@InjectRepository(X)` 是否都在「本模块 + CommonModule」的 forFeature 里登记。
 *
 * 由来：2026-10-27 首次部署 N1/W1 落码时，`OrderAvailabilityService` 新增了
 * `@InjectRepository(SalesPause)`，而 `CommonModule.forFeature` 只登记了「楼/楼群/分配」
 * 三张表 ⇒ **tsc 与单测全绿，真实启动 Nest 抛 can't resolve dependencies**，
 * 生产 api 容器重启循环、线上 502。这类缺陷只能靠「启动」或「静态对账」发现。
 *
 * 用法：node scripts/check-di-forfeature.mjs
 * 退出码：0 = 无缺失；1 = 有缺失（或有文件读不了）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), 'apps/api-server/src');
const SRC_ROOT = 'apps/api-server/src';

/** 收集目录下所有 .ts（排除 spec/e2e） */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

/** 去注释：注释里出现的示例代码（如文档中的 `@InjectRepository(X)`）不算注入点 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** 从 forFeature([...]) 里抽出实体名 —— 单行与多行两种写法都要认 */
function entitiesOfForFeature(src) {
  const set = new Set();
  const clean = stripComments(src);
  for (const m of clean.matchAll(/TypeOrmModule\.forFeature\(\s*\[([\s\S]*?)\]\s*\)/g)) {
    for (const tok of m[1].split(',')) {
      const id = tok.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
      if (/^[A-Z][A-Za-z0-9_]*$/.test(id)) set.add(id);
    }
  }
  return set;
}

/** 模块目录 → 该目录（含同目录所有 module）登记的实体 */
const moduleEntities = new Map(); // dir -> Set
const allFiles = walk(ROOT);
for (const f of allFiles) {
  if (!f.endsWith('.module.ts')) continue;
  const dir = path.dirname(f);
  const set = moduleEntities.get(dir) ?? new Set();
  for (const e of entitiesOfForFeature(fs.readFileSync(f, 'utf8'))) set.add(e);
  moduleEntities.set(dir, set);
}

/** @Global() 的 CommonModule 视为全局可见 */
const globalEntities = new Set();
for (const [dir, set] of moduleEntities) {
  if (!dir.endsWith(`${path.sep}common`)) continue;
  const modFile = path.join(dir, 'common.module.ts');
  if (fs.existsSync(modFile) && /@Global\(\)/.test(fs.readFileSync(modFile, 'utf8'))) {
    for (const e of set) globalEntities.add(e);
  }
}

/** 文件所属模块：同目录优先，逐级向上直到 src */
function ownersOf(file) {
  const out = [];
  let dir = path.dirname(file);
  const rel = (p) => path.relative(process.cwd(), p).replace(/\\/g, '/');
  while (dir.startsWith(ROOT)) {
    if (moduleEntities.has(dir)) out.push(dir);
    dir = path.dirname(dir);
    if (rel(dir) === SRC_ROOT) break;
  }
  return out;
}

const problems = [];
let checked = 0;
for (const f of allFiles) {
  const src = stripComments(fs.readFileSync(f, 'utf8'));
  const repos = [...src.matchAll(/@InjectRepository\(\s*([A-Za-z0-9_]+)\s*\)/g)].map((m) => m[1]);
  if (!repos.length) continue;
  const owners = ownersOf(f);
  const owned = new Set();
  for (const d of owners) for (const e of moduleEntities.get(d) ?? []) owned.add(e);
  for (const r of repos) {
    checked++;
    if (owned.has(r) || globalEntities.has(r)) continue;
    problems.push({
      file: path.relative(process.cwd(), f).replace(/\\/g, '/'),
      entity: r,
      owners: owners.map((d) => path.relative(process.cwd(), d).replace(/\\/g, '/')),
    });
  }
}

console.log(`[DI 对账] 全局(CommonModule)登记实体 ${globalEntities.size} 个；模块目录 ${moduleEntities.size} 个`);
console.log(`[DI 对账] 校验 @InjectRepository 注入点 ${checked} 处`);
if (!problems.length) {
  console.log('[DI 对账] OK —— 未发现「注入了但没登记」的仓储');
  process.exit(0);
}
console.log(`[DI 对账] FAIL —— ${problems.length} 处缺失：`);
for (const p of problems) {
  console.log(`  - ${p.file}\n      @InjectRepository(${p.entity})  所属模块: ${p.owners.join(' , ') || '(未找到模块)'}`);
}
process.exit(1);

#!/usr/bin/env node
/**
 * 把工作区根目录下的权威文档同步进 docs/（仓库内唯一事实来源）。
 *
 * 用法：node scripts/sync-docs.mjs        （或 pnpm docs:sync）
 *
 * 规则：
 *  1. 只同步文件名以 `ABox一盒` 开头、扩展名为 .md / .html 的文件；
 *  2. **同名同扩展名的多版本只保留最高版本**——否则 docs/ 里会同时躺着 v1.0 与 v2.1，
 *     专家团无从判断哪份有效（这正是「废弃文档混放」隐患的根治手段）；
 *     被淘汰的文件会打印出来，不会静默丢弃。
 *     （扩展名不同视为两份产物，如 xxxv1.3.html 与 xxxv1.3.md 都保留。）
 *
 * 版本比较按数值段解析（v1.10 > v1.9），非字典序。
 * 无法解析出版本号的文件一律保留。
 */
import { readdirSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const docsDir = join(repoRoot, 'docs');
const sourceDir = join(repoRoot, '..');

if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });

/** 解析 `ABox一盒XXXv1.2.3.md` → { base: 'ABox一盒XXX', ext: '.md', ver: [1,2,3] } */
function parseVersion(name) {
  const m = /^(.*?)v(\d+(?:\.\d+)*)\.(md|html)$/i.exec(name);
  if (!m) return null;
  return {
    base: m[1],
    ext: `.${m[3].toLowerCase()}`,
    ver: m[2].split('.').map((n) => Number(n)),
  };
}

function cmpVer(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

const all = readdirSync(sourceDir).filter(
  (f) => f.startsWith('ABox一盒') && (f.endsWith('.md') || f.endsWith('.html')),
);

// 分组：同「base + 扩展名」视为同一份文档的不同版本
// （v1.3.html 与 v1.3.md 是两份不同用途的产物，必须都保留，不能互相淘汰）
const groups = new Map();
for (const f of all) {
  const p = parseVersion(f);
  const key = p ? `${p.base}${p.ext}` : `__single__:${f}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({ file: f, ver: p ? p.ver : null });
}

const keep = [];
const dropped = [];
for (const [, items] of groups) {
  if (items.length === 1) {
    keep.push(items[0].file);
    continue;
  }
  let best = 0;
  items.forEach((it, i) => {
    if (it.ver && (!items[best].ver || cmpVer(it.ver, items[best].ver) > 0)) best = i;
  });
  items.forEach((it, i) => (i === best ? keep.push(it.file) : dropped.push(it.file)));
}

keep.sort();
dropped.sort();

for (const f of keep) {
  copyFileSync(join(sourceDir, f), join(docsDir, f));
  console.log('  synced :', f);
}
for (const f of dropped) {
  console.log('  skipped:', f, '(存在更高版本)');
}
console.log(`完成：同步 ${keep.length} 份文档到 docs/，跳过 ${dropped.length} 份旧版本。`);

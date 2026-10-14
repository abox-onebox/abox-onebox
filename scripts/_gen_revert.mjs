import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const fwd = resolve(dirname(fileURLToPath(import.meta.url)), '_neutralize_display_copy.mjs');
const lines = readFileSync(fwd, 'utf8').split('\n');

// anchor on the object's open marker and the first column-0 `};` after it
const openIdx = lines.findIndex((l) => l.startsWith('const REPLACEMENTS = {'));
let closeIdx = -1;
for (let i = openIdx + 1; i < lines.length; i++) {
  if (lines[i] === '};') { closeIdx = i; break; }
}
if (openIdx < 0 || closeIdx < 0) {
  console.error('无法定位 REPLACEMENTS 对象边界');
  process.exit(1);
}
const objText = lines.slice(openIdx, closeIdx + 1).join('\n');
const REPLACEMENTS = eval('(' + objText.replace('const REPLACEMENTS =', '').replace(/;\s*$/, '') + ')');

// swap from/to
const REV = {};
for (const [k, items] of Object.entries(REPLACEMENTS)) {
  REV[k] = items.map(([ln, from, to]) => [ln, to, from]);
}
const total = Object.values(REV).reduce((a, b) => a + b.length, 0);

const runner = `#!/usr/env node
/**
 * 回退脚本（餐饮化）：由 _neutralize_display_copy.mjs 的 from/to 对调生成，逆向版本。
 * 仅当需要从「通用中性文案」回退到「餐饮文案」时运行。运行即回退，可重复执行（幂等）。
 * 机制与正向脚本一致：按「文件 + 行号 + 精确旧串」定位，命中即替换；已含目标串则跳过；都不含则报错退出。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPLACEMENTS = ${JSON.stringify(REV, null, 2)};
let applied = 0, skipped = 0, failed = 0;
const failures = [];
for (const [rel, items] of Object.entries(REPLACEMENTS)) {
  const abs = resolve(ROOT, rel);
  if (!existsSync(abs)) { failures.push('文件不存在：' + rel); failed++; continue; }
  const lines = readFileSync(abs, 'utf8').split('\\n');
  let fc = 0;
  for (const [ln, from, to] of items) {
    const idx = ln - 1;
    if (idx < 0 || idx >= lines.length) { failures.push(rel + ':' + ln + ' 行号越界'); failed++; continue; }
    if (lines[idx].includes(from)) { lines[idx] = lines[idx].replace(from, to); fc++; }
    else if (lines[idx].includes(to)) { skipped++; }
    else { failures.push(rel + ':' + ln + ' 未命中旧串：' + from.slice(0, 40)); failed++; }
  }
  if (fc) { writeFileSync(abs, lines.join('\\n'), 'utf8'); applied += fc; console.log('✔ ' + rel + ' · ' + fc + ' 处'); }
}
console.log('\\n=== 回退（餐饮化）替换：本次 ' + applied + ' 处生效，已存在 ' + skipped + ' 处跳过，' + failed + ' 处失败 ===');
if (failures.length) { for (const f of failures) console.log('  ✘ ' + f); process.exit(1); }
process.exit(0);
`;

const out = resolve(dirname(fileURLToPath(import.meta.url)), '_neutralize_display_copy.revert.mjs');
writeFileSync(out, runner, 'utf8');
console.log('reverse script written ->', out);
console.log('total reverse entries:', total, '| files:', Object.keys(REV).length);

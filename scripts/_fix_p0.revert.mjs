#!/usr/bin/env node
/**
 * P0 残余修复回退脚本（幂等 · 仅改服务端/校验提示串）
 *
 * 与 _fix_p0.mjs 对应，from/to 对调；先跑本脚本、再跑 _neutralize_display_copy.revert.mjs
 * 即可完整回退到去餐饮化之前的口径。机制同 _fix_p0.mjs：整文件 join→split(from) 计数，
 * cnt===1 才替换；cnt===0 且含 to ⇒ 跳过；否则报错退出。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EDITS = [
  ['apps/admin-web/src/views/meal/edit.vue',
    `「本日精选」在本页 = **四个必选档位（主件/辅品/素品/附品）各选一道**`,
    `「本日精选」在本页 = **四个菜位（主荤/半荤/素菜/汤）各选一道**`],

  ['packages/shared-utils/src/biz.ts',
    `rule: '本日精选：需恰好包含「主件 / 辅品 / 素品 / 附品」四个档位各一道（随附米饭由集散中心统一供，不建商品项）'`,
    `rule: '一饭四菜：需恰好包含「主荤 / 半荤 / 素菜 / 汤」四个档位各一道（主食米饭由集散中心统一供，不建菜品项）'`],

  ['apps/api-server/src/modules/meal/meal-admin.controller.ts',
    `菜品项须满足组合构成规则`,
    `菜品项须满足「一饭四菜」`],
];

let applied = 0, skipped = 0, failed = 0;
const failures = [];

for (const [rel, from, to] of EDITS) {
  const abs = resolve(ROOT, rel);
  if (!existsSync(abs)) { failures.push(`文件不存在：${rel}`); failed++; continue; }
  const lines = readFileSync(abs, 'utf8').split('\n');
  const joined = lines.join('\n');
  const cnt = joined.split(from).length - 1;
  if (cnt === 0) {
    if (joined.includes(to)) { skipped++; }
    else { failures.push(`${rel}：旧串未命中，且新串也不在（需人工核对）`); failed++; }
  } else if (cnt > 1) {
    failures.push(`${rel}：旧串命中 ${cnt} 次（非唯一，需人工核对）`); failed++;
  } else {
    const out = joined.replace(from, to);
    writeFileSync(abs, out, 'utf8');
    applied++;
    console.log(`✔ ${rel} · 1 处`);
  }
}

console.log(`\n=== P0 残余回退：本次 ${applied} 处生效，${skipped} 处已存在跳过，${failed} 处失败 ===`);
if (failures.length) { for (const f of failures) console.log('  ✘ ' + f); process.exit(1); }
process.exit(0);

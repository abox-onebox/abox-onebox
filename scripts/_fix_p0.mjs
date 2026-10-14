#!/usr/bin/env node
/**
 * P0 阅读障碍二次修复 · 残余条目（幂等 · 仅改服务端/校验提示串）
 *
 * 历史：最初这脚本含 22 条修正（错词「品位→档位」、主食「主件→随附」、
 *   半荤/素菜「配品→辅品/素品」、组合构成校验提示等）。“展示层”那 19 条
 *   与主脚本 _neutralize_display_copy.mjs 改的是同一批字节的中间态，
 *   单独对调 from/to 无法干净回退，已在 2026-10 合并进主脚本
 *   （主脚本每条 to 直接等于最终磁盘态）。本脚本现仅保留 3 条**无法并入主脚本**的修正：
 *     · edit.vue 组合编辑页：档位口径从「菜位/主荤…」收敛为「必选档位/主件…」
 *     · biz.ts SET_MEAL_COMPOSITION.rule：组合构成校验提示（运营/前端可见）
 *     · api-server meal-admin.controller.ts：运营端提交校验失败提示
 *
 * 机制：整文件 join→split(from) 计数；cnt===1 才替换；
 *   cnt===0 且含 to ⇒ 跳过（幂等）；否则报错退出（绝不静默误改）。
 *
 * 回退：对应 _fix_p0.revert.mjs（from/to 对调，同样幂等）。
 * 完整回退顺序：先跑 _fix_p0.revert.mjs，再跑 _neutralize_display_copy.revert.mjs。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EDITS = [
  // ---- edit.vue（组合编辑页：档位口径从「菜位/主荤…」收敛为「必选档位/主件…」）----
  ['apps/admin-web/src/views/meal/edit.vue',
    `「本日精选」在本页 = **四个菜位（主荤/半荤/素菜/汤）各选一道**`,
    `「本日精选」在本页 = **四个必选档位（主件/辅品/素品/附品）各选一道**`],

  // ---- biz.ts（组合构成校验提示，运营/前端均可见）----
  ['packages/shared-utils/src/biz.ts',
    `rule: '一饭四菜：需恰好包含「主荤 / 半荤 / 素菜 / 汤」四个档位各一道（主食米饭由集散中心统一供，不建菜品项）'`,
    `rule: '本日精选：需恰好包含「主件 / 辅品 / 素品 / 附品」四个档位各一道（随附米饭由集散中心统一供，不建商品项）'`],

  // ---- api-server（运营端提交校验失败提示）----
  ['apps/api-server/src/modules/meal/meal-admin.controller.ts',
    `菜品项须满足「一饭四菜」`,
    `菜品项须满足组合构成规则`],
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

console.log(`\n=== P0 残余修复：本次 ${applied} 处生效，${skipped} 处已存在跳过，${failed} 处失败 ===`);
if (failures.length) { for (const f of failures) console.log('  ✘ ' + f); process.exit(1); }
process.exit(0);

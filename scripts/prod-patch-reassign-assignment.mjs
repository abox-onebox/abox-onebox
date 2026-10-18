#!/usr/bin/env node
/**
 * prod-patch-reassign-assignment.mjs —— 生产「改派某日出餐日各楼群套餐」安全脚本
 * ------------------------------------------------------------------
 * 用途：把指定出餐日(target-date) 下各楼群(building_group_id) 的套餐改派为新的
 *       set_meal_id（用于「不同楼显示不同套餐」的演示/验证，尤其是去餐化后混入零食类）。
 *
 * 安全红线：
 *   ✅ 只 UPDATE ab_meal_assignment 的 set_meal_id 一列（按 meal_date + building_group_id 精确定位）。
 *   ✅ 绝不 DELETE / TRUNCATE / 改动其他列（status / cutoff_at / distribution_center_id 保持不动）。
 *   ✅ 默认 dry-run：打印每栋「当前套餐 → 新套餐(名称/类型)」+ 订单占用告警，不写库。
 *   ✅ 写后回查全部行自检。
 *
 * 注意：已下单用户的历史订单仍指向旧 set_meal_id（订单自存快照），本脚本不改订单；
 *       若某楼已有订单，dry-run 会标红告警，由人判断是否可接受。
 */

import { createConnection } from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function printHelp() {
  console.log(`
prod-patch-reassign-assignment.mjs —— 生产改派套餐安全脚本

用法:
  node scripts/prod-patch-reassign-assignment.mjs [选项]

选项:
  --target-date=YYYY-MM-DD   要改派出餐日（默认 2026-10-19）
  --apply                    真正写入；缺省为 dry-run
  --env-file=PATH            从文件加载 DB_* 环境变量
  -h, --help                 显示本帮助

示例:
  node scripts/prod-patch-reassign-assignment.mjs
  node scripts/prod-patch-reassign-assignment.mjs --apply
`);
}

function parseArgs(argv) {
  const args = { targetDate: '2026-10-19', apply: false, envFile: null, help: false };
  for (const a of argv) {
    if (a === '--apply') args.apply = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a.startsWith('--target-date=')) args.targetDate = a.slice('--target-date='.length);
    else if (a.startsWith('--env-file=')) args.envFile = a.slice('--env-file='.length);
    else console.warn(`[警告] 忽略未知参数: ${a}`);
  }
  return args;
}

function dateLike(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// ⭐ 改派计划：楼群 → 新套餐id。（名称/类型由脚本从库里实时取，不写死避免错位）
const PLAN = [
  { bg: 1, set: 1 }, // 国贸三期组 → 红烧肉套餐
  { bg: 2, set: 2 }, // 建外SOHO组 → 东坡肉套餐
  { bg: 3, set: 3 }, // 银泰中心组 → 宫保鸡丁套餐
  { bg: 4, set: 9 }, // 华贸组 → 零食能量包 (fmcg)
  { bg: 5, set: 8 }, // 远洋光华组 → 泡面宵夜包 (fmcg)
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (args.envFile) {
    const txt = readFileSync(resolve(__dirname, args.envFile), 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  if (!dateLike(args.targetDate)) {
    console.error(`[错误] --target-date 格式应为 YYYY-MM-DD，收到: ${args.targetDate}`);
    process.exit(2);
  }

  const cfg = {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_DATABASE ?? 'abox_onebox',
    connectTimeout: 10000,
  };

  console.log('=== 生产改派套餐脚本（ABox 一盒）===');
  console.log(`出餐日 target-date : ${args.targetDate}`);
  console.log(`执行模式          : ${args.apply ? 'APPLY（真正写入）' : 'DRY-RUN（只打印，不写库）'}`);
  console.log(`数据库连接        : ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);

  const conn = await createConnection(cfg);
  try {
    // 取新套餐的名称/类型 + 明细数
    const [sets] = await conn.query(
      `SELECT id, name, kind, status FROM ab_set_meal WHERE id IN (${PLAN.map((p) => p.set).join(',')})`,
    );
    const setMap = new Map(sets.map((s) => [Number(s.id), s]));
    for (const p of PLAN) {
      if (!setMap.has(p.set)) throw new Error(`计划中的套餐 id=${p.set} 在 ab_set_meal 不存在`);
    }

    console.log('\n--- 改派计划（仅 UPDATE set_meal_id）---');
    console.log('楼群ID  当前套餐→新套餐(名称/类型)              订单占用告警');
    for (const p of PLAN) {
      const ns = setMap.get(p.set);
      const [cur] = await conn.query(
        `SELECT set_meal_id, status FROM ab_meal_assignment WHERE meal_date = ? AND building_group_id = ?`,
        [args.targetDate, p.bg],
      );
      const curSet = cur[0]?.set_meal_id ?? '(无行)';
      const [ord] = await conn.query(
        `SELECT COUNT(*) AS n FROM ab_order WHERE meal_date = ? AND building_group_id = ?`,
        [args.targetDate, p.bg],
      );
      const ordN = Number(ord[0]?.n ?? 0);
      const warn = ordN > 0 ? `⚠️ 已有 ${ordN} 笔订单(历史快照不变)` : '无订单';
      console.log(
        `${String(p.bg).padEnd(7)} ${String(curSet).padEnd(8)}→ ${String(p.set).padEnd(3)} ${ns.name}(${ns.kind})`.padEnd(48) +
          ` ${warn}`,
      );
    }

    // 零食类明细存在性自检
    console.log('\n--- 零食类套餐明细自检 ---');
    for (const p of PLAN.filter((x) => setMap.get(x.set).kind === 'fmcg')) {
      const [it] = await conn.query(
        `SELECT COUNT(*) AS n FROM ab_set_meal_item WHERE set_meal_id = ?`,
        [p.set],
      );
      const n = Number(it[0]?.n ?? 0);
      console.log(`  套餐 ${p.set} (${setMap.get(p.set).name}) 明细数=${n} ${n > 0 ? 'OK' : '⚠️ 无明细，首页该楼将不显示菜品'}`);
    }

    if (!args.apply) {
      console.log('\n[DRY-RUN] 未写入任何数据。确认无误后加 --apply 执行。');
      return;
    }

    // 真正改派
    let changed = 0;
    for (const p of PLAN) {
      const [res] = await conn.query(
        `UPDATE ab_meal_assignment SET set_meal_id = ? WHERE meal_date = ? AND building_group_id = ?`,
        [p.set, args.targetDate, p.bg],
      );
      if (Number(res.affectedRows) > 0) changed++;
    }
    console.log(`\n[APPLY] 已改派 ${changed} 栋楼。`);

    // 自检
    const [after] = await conn.query(
      `SELECT a.building_group_id AS bg, a.set_meal_id AS set_id, s.name, s.kind, a.status
         FROM ab_meal_assignment a JOIN ab_set_meal s ON s.id = a.set_meal_id
        WHERE a.meal_date = ? ORDER BY a.building_group_id`,
      [args.targetDate],
    );
    console.log('\n[自检] target-date 现各楼套餐：');
    for (const r of after) {
      console.log(`  楼群 ${r.bg} → 套餐${r.set_id} ${r.name}(${r.kind}) status=${r.status}`);
    }
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(`\n[失败] ${e.message}`);
  process.exit(1);
});

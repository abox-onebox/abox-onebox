#!/usr/bin/env node
/**
 * prod-check-assignment.mjs —— 生产「明日开团」只读检查脚本
 * ------------------------------------------------------------------
 * 用途：查指定出餐日（默认 = 明天，按 +08:00 计算）的楼群套餐分配，
 *       回答一个问题——「明天用户能下单吗？」。
 *       0 行 = 未开团，须跑 prod-patch-insert-assignment.mjs 补团（见输出提示）。
 *
 * 安全红线（本脚本为只读，违反任意一条即缺陷）：
 *   ✅ 只 SELECT，绝不 INSERT / UPDATE / DELETE / TRUNCATE / DROP。
 *   ✅ 不改任何数据、不建临时表、不加锁。
 *
 * 为什么默认查「明天」：业务只能订「明日」（isOrderable 上界算出来的），
 *   而系统无自动造团能力 —— 全靠人建/复制 + 14:00 跑批转 active。
 *   跑批不凭空造团 ⇒ 明日 0 行 = 今晚 24:00 截单前必须补。
 *
 * ⚠️⚠️ 时区铁律（2026-10-20 实测踩坑）：
 *   mysql2 把 DATE 列解析成「本地午夜」的 JS Date；在 UTC+8 环境下
 *   `toISOString().slice(0,10)` 会把日期**系统性提前一天**
 *   （MAX(meal_date) 返回 `2026-10-18T16:00:00Z` 其实是 10-19 本地）。
 *   ⇒ 本探针一律 `dateStrings: true`（拿原始字符串），
 *     「明天」也按 +08:00 显式计算，不依赖容器 TZ。
 *
 * 运行位置（推荐）：在 api-server 容器内执行（那里既有 mysql2，
 *   又能解析 compose 的 DB_HOST）。宿主机直连可用 --env-file 指向含 DB_* 的文件。
 *
 *   docker exec abox-api-prod node /app/scripts/prod-check-assignment.mjs
 *   docker exec abox-api-prod node /app/scripts/prod-check-assignment.mjs --target-date=2026-10-22
 *
 * 退出码：0 = 明日在团（有 active 行）；1 = 明日无任何分配（需补团）；
 *         2 = 有行但无 active（pending 未上架，需上架或等 14:00 跑批）。
 */

import { createConnection } from 'mysql2/promise';
import { readFileSync } from 'node:fs';

function printHelp() {
  console.log(`
prod-check-assignment.mjs —— 生产「明日开团」只读检查（只 SELECT，绝不写库）

用法:
  node scripts/prod-check-assignment.mjs [选项]

选项:
  --target-date=YYYY-MM-DD   要查的出餐日（缺省 = 明天，按 +08:00 计算）
  --env-file=PATH            从文件加载 DB_* 环境变量（不覆盖已存在的环境变量）
  -h, --help                 显示本帮助

示例:
  docker exec abox-api-prod node /app/scripts/prod-check-assignment.mjs
`);
}

function parseArgs(argv) {
  const args = { targetDate: null, envFile: null, help: false };
  for (const a of argv) {
    if (a === '-h' || a === '--help') args.help = true;
    else if (a.startsWith('--target-date=')) args.targetDate = a.slice('--target-date='.length);
    else if (a.startsWith('--env-file=')) args.envFile = a.slice('--env-file='.length);
    else {
      console.error(`未知参数: ${a}（-h 查看帮助）`);
      process.exit(64);
    }
  }
  return args;
}

/** 按 +08:00 取「明天」的 YYYY-MM-DD（不依赖容器 TZ） */
function tomorrowInPlus8(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 3600 * 1000); // 平移到 +08:00 的“墙上时间”
  shifted.setUTCDate(shifted.getUTCDate() + 1);
  return shifted.toISOString().slice(0, 10);
}

function loadEnvFile(path) {
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue; // 不覆盖已存在的环境变量
    let val = m[2];
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    process.env[key] = val;
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
if (args.envFile) loadEnvFile(args.envFile);

const targetDate = args.targetDate || tomorrowInPlus8();
if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
  console.error(`target-date 格式不对: ${targetDate}（应为 YYYY-MM-DD）`);
  process.exit(64);
}

const cfg = {
  host: process.env.DB_HOST || 'db',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USERNAME || process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_DATABASE || process.env.DB_NAME || 'abox_onebox',
  dateStrings: true, // ⚠️ 铁律：见文件头「时区铁律」
};

const conn = await createConnection(cfg);
try {
  const [rows] = await conn.query(
    `SELECT a.building_group_id AS gid, bg.name AS gname, m.name AS mname, a.status
       FROM ab_meal_assignment a
       LEFT JOIN ab_building_group bg ON bg.id = a.building_group_id
       LEFT JOIN ab_set_meal m ON m.id = a.set_meal_id
      WHERE a.meal_date = ?
      ORDER BY a.building_group_id`,
    [targetDate],
  );

  const active = rows.filter((r) => r.status === 'active').length;
  const pending = rows.filter((r) => r.status === 'pending').length;
  const other = rows.length - active - pending;

  console.log(`=== 明日开团检查（只读）===`);
  console.log(
    `出餐日                : ${targetDate}${args.targetDate ? '' : '（= 明天，+08:00）'}`,
  );
  console.log(
    `分配行数              : ${rows.length}（active ${active} / pending ${pending}${other ? ` / 其他 ${other}` : ''}`,
  );

  if (rows.length > 0) {
    for (const r of rows) {
      console.log(
        `  ${String(r.gid).padStart(2)} ${String(r.gname).padEnd(12)} 《${r.mname ?? '?'}》 [${r.status}]`,
      );
    }
  }

  if (rows.length === 0) {
    console.log(`\n结论：❌ ${targetDate} 未开团 —— 用户现在无法为这天下单（截单当晚 24:00）。`);
    console.log(`补救（生产写，须用户当轮批准后执行）：`);
    console.log(
      `  docker exec abox-api-prod node /app/scripts/prod-patch-insert-assignment.mjs \\`,
    );
    console.log(`    --target-date=${targetDate} --apply --publish`);
    process.exit(1);
  }
  if (active === 0) {
    console.log(`\n结论：⚠️ ${targetDate} 有分配但无一 active —— 用户仍无法下单。`);
    console.log(`处理：后台「套餐编排」上架，或等 14:00 跑批转 active。`);
    process.exit(2);
  }
  console.log(
    `\n结论：✅ ${targetDate} 已开团（${active} 个楼群 active），用户可下单至 ${targetDate} 00:00(+08:00) 截单。`,
  );
  process.exit(0);
} finally {
  await conn.end();
}

#!/usr/bin/env node
/**
 * prod-patch-insert-assignment.mjs —— 生产「补团」安全脚本
 * ------------------------------------------------------------------
 * 用途：给指定出餐日（target-date）补插 ab_meal_assignment 的 pending 行，
 *       字段直接复用「参照日期」(ref-date) 的 (楼群, 套餐, 集散中心) 映射。
 *       对「预定模式漏排导致首页未开团」这类问题做精准补救。
 *
 * 安全红线（违反任意一条即拒绝写入）：
 *   ✅ 只 INSERT，绝不 DELETE / UPDATE / TRUNCATE / DROP。
 *   ✅ 只动 target-date 这一天，绝不碰其他日期。
 *   ✅ 唯一键 (meal_date, building_group_id) 已存在的行 → 自动跳过，绝不覆盖。
 *   ✅ 默认干跑（dry-run），必须显式 --apply 才真正落库。
 *   ✅ 落库后回查并打印 target-date 行数，自检可见。
 *
 * 参照日期（ref-date）：
 *   默认 = 表里「离 target 最近、且不是 target 自身」的那个 meal_date
 *   （即运营最近一次编排的模样，最能反映当前生效的套餐/楼群配置）。
 *   可用 --ref-date=YYYY-MM-DD 强制指定（例如上周同星期几）。
 *
 * 运行位置（推荐）：在 api-server 容器内执行，
 *   因为那里既有 mysql2，又能解析 docker-compose 的 DB_HOST（如 db / 127.0.0.1）。
 *
 *   推荐命令（在服务器上）：
 *     docker compose -f /opt/abox-onebox/docker-compose.yml exec api-server \
 *       node /opt/abox-onebox/scripts/prod-patch-insert-assignment.mjs --apply
 *
 *   若 DB 不在容器网络内、需在宿主机直连，可用 --env-file 指向含 DB_* 的文件：
 *     node scripts/prod-patch-insert-assignment.mjs --apply \
 *       --env-file /opt/abox-onebox/apps/api-server/.env
 *
 * 重要：本脚本只负责「建分配(pending)」。新建完后仍需在后台「套餐编排」上架，
 *   或等次日 14:00 跑批接管（若当天跑批尚未对该日期执行，可手动补跑）。
 */

import { createConnection } from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function printHelp() {
  console.log(`
prod-patch-insert-assignment.mjs —— 生产补团安全脚本

用法:
  node scripts/prod-patch-insert-assignment.mjs [选项]

选项:
  --target-date=YYYY-MM-DD   要补的出餐日（默认 2026-10-19）
  --ref-date=YYYY-MM-DD      参照日期；缺省=表里离 target 最近的有效日期
  --env-file=PATH            从文件加载 DB_* 环境变量（不覆盖已存在的环境变量）
  --include-cancelled        参照日期里连 cancelled 的楼群也照抄（默认跳过 cancelled）
  --apply                    真正写入；缺省为 dry-run（只打印计划，不写库）
  --publish                  写入后顺带把 target 当天 pending→active 上架（与后台「上架」同语义；
                              仅翻转 pending→active、幂等；已过该日截单则自动跳过并告警）
  -h, --help                 显示本帮助

示例:
  # 先看会插什么（默认 dry-run）
  docker compose exec api-server node /opt/abox-onebox/scripts/prod-patch-insert-assignment.mjs

  # 确认无误后真正补 2026-10-19
  docker compose exec api-server node /opt/abox-onebox/scripts/prod-patch-insert-assignment.mjs --apply
`);
}

function parseArgs(argv) {
  const args = {
    apply: false,
    publish: false,
    targetDate: '2026-10-19',
    refDate: null,
    envFile: null,
    excludeCancelled: true,
    help: false,
  };
  for (const a of argv) {
    if (a === '--apply') args.apply = true;
    else if (a === '--publish') args.publish = true;
    else if (a === '--include-cancelled') args.excludeCancelled = false;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a.startsWith('--target-date=')) args.targetDate = a.slice('--target-date='.length);
    else if (a.startsWith('--ref-date=')) args.refDate = a.slice('--ref-date='.length);
    else if (a.startsWith('--env-file=')) args.envFile = a.slice('--env-file='.length);
    else {
      console.warn(`[警告] 忽略未知参数: ${a}`);
    }
  }
  return args;
}

/** 极简 .env 解析（无外部依赖），仅填充尚未存在的变量 */
function loadEnvFile(p) {
  let txt;
  try {
    txt = readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error(`无法读取 --env-file=${p}：${e.message}`);
  }
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function dateLike(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** 把任意 Date / 字符串规整成 MySQL DATE 列接受的字面量 YYYY-MM-DD */
function toYMD(v) {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.envFile) loadEnvFile(resolve(__dirname, args.envFile));

  if (!dateLike(args.targetDate)) {
    console.error(`[错误] --target-date 格式应为 YYYY-MM-DD，收到: ${args.targetDate}`);
    process.exit(2);
  }
  if (args.refDate && !dateLike(args.refDate)) {
    console.error(`[错误] --ref-date 格式应为 YYYY-MM-DD，收到: ${args.refDate}`);
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

  console.log('=== 生产补团脚本（ABox 一盒）===');
  console.log(`目标日期 target-date : ${args.targetDate}`);
  console.log(`参照日期 ref-date    : ${args.refDate ?? '(自动=最近的有效日期)'}`);
  console.log(`跳过 cancelled 源行  : ${args.excludeCancelled ? '是' : '否'}`);
  console.log(`执行模式            : ${args.apply ? 'APPLY（真正写入）' : 'DRY-RUN（只打印，不写库）'}`);
  console.log(`写入后上架          : ${args.publish ? '是（pending→active，含截单护栏）' : '否（仅建 pending，需另行上架）'}`);
  console.log(`数据库连接          : ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);

  const conn = await createConnection(cfg);
  try {
    // 1) 目标日期现有行
    const [targetRows] = await conn.query(
      `SELECT id, building_group_id, set_meal_id, distribution_center_id, status
         FROM ab_meal_assignment WHERE meal_date = ? ORDER BY building_group_id`,
      [args.targetDate],
    );

    // 2) 选定参照日期
    let refDate = args.refDate;
    if (!refDate) {
      const [rows] = await conn.query(
        `SELECT meal_date FROM ab_meal_assignment
           WHERE meal_date <> ? GROUP BY meal_date ORDER BY meal_date DESC LIMIT 1`,
        [args.targetDate],
      );
      if (!rows.length) {
        throw new Error('ab_meal_assignment 为空或只有 target 当天，无法确定参照日期。请用 --ref-date 指定一个存在的日期。');
      }
      refDate = toYMD(rows[0].meal_date);
    }
    console.log(`\n采用参照日期        : ${refDate}`);

    // 3) 参照日期的源行
    let srcSql = `SELECT building_group_id, set_meal_id, distribution_center_id, status
                    FROM ab_meal_assignment WHERE meal_date = ?`;
    const params = [refDate];
    if (args.excludeCancelled) {
      srcSql += ' AND status <> ?';
      params.push('cancelled');
    }
    srcSql += ' ORDER BY building_group_id';
    const [srcRows] = await conn.query(srcSql, params);
    if (!srcRows.length) {
      throw new Error(`参照日期 ${refDate} 没有可用（非取消）的分配行，无法生成计划。请换一个 --ref-date。`);
    }

    // 4) 计算计划（已存在则跳过，绝不覆盖）
    const taken = new Set(targetRows.map((r) => Number(r.building_group_id)));
    const plan = srcRows.map((s) => {
      const gid = Number(s.building_group_id);
      const exists = taken.has(gid);
      return {
        buildingGroupId: gid,
        setMealId: Number(s.set_meal_id),
        distributionCenterId: s.distribution_center_id == null ? null : Number(s.distribution_center_id),
        action: exists ? 'SKIP(已存在)' : 'INSERT',
      };
    });

    // 5) 打印计划
    console.log('\n--- 计划（仅 INSERT，绝不 DELETE/UPDATE）---');
    console.log('动作       楼群ID    套餐ID    集散中心ID');
    for (const p of plan) {
      console.log(
        `${p.action.padEnd(12)} ${String(p.buildingGroupId).padEnd(9)} ${String(p.setMealId).padEnd(9)} ${p.distributionCenterId ?? 'NULL'}`,
      );
    }
    const insertCount = plan.filter((p) => p.action === 'INSERT').length;
    const skipCount = plan.length - insertCount;
    console.log(`\n合计 ${plan.length} 个楼群：将插入 ${insertCount}，跳过 ${skipCount}（已存在/重复）。`);

    // 6) dry-run 退出
    if (!args.apply) {
      console.log(
        args.publish
          ? '\n[DRY-RUN] 未写入任何数据。确认无误后加 --apply 执行（将同时插入并上架）。'
          : '\n[DRY-RUN] 未写入任何数据。确认无误后加 --apply 执行。',
      );
      return;
    }

    // 7) 真正写入
    let inserted = 0;
    for (const p of plan) {
      if (p.action !== 'INSERT') continue;
      try {
        await conn.query(
          `INSERT INTO ab_meal_assignment
             (meal_date, building_group_id, set_meal_id, distribution_center_id, status, sold_count, version)
           VALUES (?, ?, ?, ?, 'pending', 0, 0)`,
          [args.targetDate, p.buildingGroupId, p.setMealId, p.distributionCenterId],
        );
        inserted++;
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
          console.warn(`  [跳过] ${args.targetDate}#${p.buildingGroupId} 并发已存在，忽略。`);
        } else {
          throw e;
        }
      }
    }

    // 7b) 可选：上架（pending -> active），与后台「上架」同一语义
    if (args.publish) {
      // 截单时刻 = 出餐日 00:00 (+08:00)，与 cutoffAtOf(date) 一致；过期上架用户也下不了单
      const cutoff = new Date(`${args.targetDate}T00:00:00+08:00`);
      const now = new Date();
      if (now >= cutoff) {
        console.log(
          `\n[PUBLISH] 跳过：现在 ${now.toISOString()} 已过 ${args.targetDate} 截单时刻 ${cutoff.toISOString()}，`,
          '即便上架用户也无法下单。请核实出餐日是否正确。',
        );
      } else {
        const [res] = await conn.query(
          `UPDATE ab_meal_assignment
             SET status = 'active', publish_at = NOW(3), cutoff_at = ?
           WHERE meal_date = ? AND status = 'pending'`,
          [`${args.targetDate} 00:00:00`, args.targetDate],
        );
        const affected = Number(res.affectedRows);
        console.log(
          `\n[PUBLISH] 已上架 ${affected} 个楼群（pending→active）；截单时刻 ${args.targetDate} 00:00:00（+08:00）。`,
        );
        console.log('   用户现可在截单前下单；14:00 跑批不再对该日生效，已是终态。');
      }
    }

    // 8) 自检
    const [after] = await conn.query(
      'SELECT COUNT(*) AS n FROM ab_meal_assignment WHERE meal_date = ?',
      [args.targetDate],
    );
    console.log(`\n[APPLY] 本次新插入 ${inserted} 行；target-date 现共 ${Number(after[0].n)} 行（含此前已存在的）。`);
    console.log('下一步：新建行为 pending，请在后台「套餐编排」上架，或等 14:00 跑批 / 手动补跑 meal-publish。');
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(`\n[失败] ${e.message}`);
  process.exit(1);
});

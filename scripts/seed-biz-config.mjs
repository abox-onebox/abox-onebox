#!/usr/bin/env node
/**
 * `ab_config` 定稿值建库脚本（**幂等 · 默认 dry-run**）
 *
 * ── 它解决什么 ──────────────────────────────────────────────────────────────
 * 业务配置类决策过去只写在文档里（且在工作区根、仓库之外），换机器 / 重建库就会
 * 全部回到代码缺省值，**且不报错**。本脚本把定稿值变成可执行的建库动作，
 * 与 `check-biz-config-parity.mjs`（对账）共用 `lib/biz-config-baseline.mjs` 一份真源。
 *
 * ── 幂等策略：**缺省插、已存在则跳过**（不是 UPSERT 覆盖）──────────────────────
 * 为什么不是 `ON DUPLICATE KEY UPDATE`：
 *   运营在后天手工调过的值（例如把日限额临时放宽）**不能被一次建库冲掉** ——
 *   那种覆盖是静默的：库里值变了、没人改过配置页、日志里也没有痕迹。
 *   ⇒ 本脚本只补「**缺失**」的键；已存在的键**一律不动**，差异交给对账门禁去报警
 *     （`check-biz-config-parity.mjs`），由人来决定改不改。
 *   确有需要覆盖时用 `--force`（会打印被覆盖的旧值，留痕）。
 *
 * ── 安全默认 ────────────────────────────────────────────────────────────────
 * **不带 `--apply` 就是 dry-run**（只打印「将要写什么 / 现网是什么 / 差异」，不写库）。
 * 这条是刻意反过来的：建库脚本一旦默认写库，误敲回车就会改生产数据。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   node scripts/seed-biz-config.mjs                       # dry-run（连库读现网）
 *   node scripts/seed-biz-config.mjs --apply               # 只补缺失键
 *   node scripts/seed-biz-config.mjs --force               # 已存在但值不同 → 覆盖
 *   node scripts/seed-biz-config.mjs --emit-sql            # 只打印 SQL，不连库
 *   node scripts/seed-biz-config.mjs --rows ./rows.json    # 离线：用导出的现网行做 dry-run
 *
 * 连库参数（缺省与 api-server 一致）：DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_DATABASE
 *
 * 退出码：0 无需变更或已写入 · 1 有偏差但没写（dry-run 且有缺失/漂移）· 2 用法错误
 */
import { readFileSync } from 'node:fs';

import {
  BIZ_CONFIG_BASELINE,
  POLICY,
  diffBizConfig,
} from './lib/biz-config-baseline.mjs';

const TABLE = 'ab_config';

function parseArgs(argv) {
  const a = {
    apply: false,
    force: false,
    emitSql: false,
    rows: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === '--apply') a.apply = true;
    else if (v === '--force') a.force = true;
    else if (v === '--emit-sql') a.emitSql = true;
    else if (v === '--rows') a.rows = argv[++i];
    else if (v === '-h' || v === '--help') a.help = true;
    else {
      console.error(`未知参数：${v}`);
      process.exit(2);
    }
  }
  return a;
}

function loadRowsFromFile(path) {
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.startsWith('[') || raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : (parsed.rows ?? parsed.data ?? []);
    return arr.map((r) => ({
      configKey: r.configKey ?? r.config_key ?? r.key,
      configValue: r.configValue ?? r.config_value ?? r.value,
    }));
  }
  // TSV：`configKey<TAB>configValue`（`SELECT config_key, config_value` 的导出形态）
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const [k, ...rest] = l.split('\t');
      return { configKey: k?.trim(), configValue: rest.join('\t').trim() };
    });
}

async function loadRowsFromDb() {
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_DATABASE ?? 'abox_onebox',
  });
  try {
    const [rows] = await conn.query(
      `SELECT config_key AS configKey, config_value AS configValue FROM ${TABLE}`,
    );
    return rows;
  } finally {
    await conn.end();
  }
}

/** 生成「只补缺失」的 SQL：`INSERT ... SELECT ... WHERE NOT EXISTS` */
function insertIfMissingSql(spec) {
  const k = spec.key.replace(/'/g, "''");
  const v = spec.value.replace(/'/g, "''");
  const d = (spec.note ?? '').replace(/'/g, "''");
  return (
    `INSERT INTO ${TABLE} (config_key, config_value, description) ` +
    `SELECT '${k}', '${v}', '${d}' FROM DUAL ` +
    `WHERE NOT EXISTS (SELECT 1 FROM ${TABLE} WHERE config_key = '${k}');`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      '用法：node scripts/seed-biz-config.mjs [--apply] [--force] [--emit-sql] [--rows <file>]',
    );
    return 0;
  }

  if (args.emitSql) {
    console.log('-- ab_config 定稿值 · 只补缺失（幂等）--');
    for (const spec of BIZ_CONFIG_BASELINE) {
      if (spec.policy !== POLICY.SEED) {
        console.log(
          `-- ${spec.key}：policy=${spec.policy}（拍板不写库）→ 不生成 INSERT`,
        );
        continue;
      }
      console.log(insertIfMissingSql(spec));
    }
    return 0;
  }

  const rows = args.rows ? loadRowsFromFile(args.rows) : await loadRowsFromDb();
  const diff = diffBizConfig(BIZ_CONFIG_BASELINE, rows);
  const actual = new Map(rows.map((r) => [r.configKey, r.configValue]));

  console.log('── 定稿值 vs 现网 ──');
  for (const spec of BIZ_CONFIG_BASELINE) {
    const cur = actual.has(spec.key) ? String(actual.get(spec.key)) : '（缺失）';
    const flag = actual.has(spec.key)
      ? String(Number(spec.value)) === String(Number(cur))
        ? 'OK'
        : 'DRIFT'
      : spec.policy === POLICY.SEED
        ? 'MISSING(应补)'
        : 'MISSING(预期·不写库)';
    console.log(
      `  ${flag.padEnd(20)} ${spec.key.padEnd(34)} 定稿=${spec.value.padEnd(9)} 现网=${cur}`,
    );
  }
  console.log(`  对齐 ${diff.aligned.length} · 漂移 ${diff.drifting.length} · 缺失 ${diff.missing.length}`);

  const toInsert = diff.missing.filter((m) => m.policy === POLICY.SEED);
  const toOverwrite = args.force ? diff.drifting : [];

  if (!args.apply) {
    console.log('\n[dry-run] 未写库。将要执行：');
    console.log(`  INSERT 缺失键 ${toInsert.length} 个${toInsert.length ? '：' + toInsert.map((m) => m.key).join(', ') : ''}`);
    console.log(`  UPDATE 漂移键 ${toOverwrite.length} 个${toOverwrite.length ? '：' + toOverwrite.map((d) => `${d.key}(${d.actual}→${d.expected})`).join(', ') : '（需 --force 才会写）'}`);
    console.log('  ⇒ 确认后加 --apply（覆盖再加 --force）');
    return toInsert.length || diff.drifting.length ? 1 : 0;
  }

  if (!toInsert.length && !toOverwrite.length) {
    console.log('\n无需变更。');
    return 0;
  }

  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_DATABASE ?? 'abox_onebox',
  });
  try {
    for (const m of toInsert) {
      const spec = BIZ_CONFIG_BASELINE.find((s) => s.key === m.key);
      await conn.query(insertIfMissingSql(spec));
      console.log(`  INSERT ${m.key} = ${spec.value}`);
    }
    for (const d of toOverwrite) {
      const [res] = await conn.query(
        `UPDATE ${TABLE} SET config_value = ? WHERE config_key = ?`,
        [d.expected, d.key],
      );
      console.log(`  UPDATE ${d.key}: ${d.actual} → ${d.expected}（affected=${res.affectedRows}）`);
    }
  } finally {
    await conn.end();
  }
  console.log('\n⚠️ 写完请确认 `BizConfigService` 已 invalidate（60s 进程内缓存），否则业务仍按旧值跑。');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.message ?? e);
    process.exit(2);
  });

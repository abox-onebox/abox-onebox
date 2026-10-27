#!/usr/bin/env node
/**
 * `ab_config` 定稿值 ↔ 现网 对账门禁（**只报警，不改库**）
 *
 * ── 它守什么 ────────────────────────────────────────────────────────────────
 * 「决策写在了文档里、没人执行」这一类失效**不报错**：代码照跑、健康检查照绿，
 * 直到某天以「提现无日限额」这种形式复发（2026-10-27 就是这样）。
 * 本门禁把定稿值（`lib/biz-config-baseline.mjs`，与建库脚本**同一份**）与现网
 * `ab_config` 做逐键比对，有偏差就**红**。
 *
 * ── 为什么「缺失」未必是偏差 ────────────────────────────────────────────────
 * 2026-10-27 拍板（`docs/decisions/OPEN-DECISIONS.md:13`）明确：阈值 / 超时 / 供价 /
 * 提现两条**都不写库**，让代码 fallback 生效。所以：
 *   · `policy=seed` 的键缺失 ⇒ **偏差**（应当补）；
 *   · `policy=fallback-only` 的键缺失 ⇒ **预期**，不算偏差；但**存在且值不同** ⇒ 偏差。
 * ⇒ 「缺键」与「值不同」分开判（与 `config-value.ts` 同一条纪律）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   node scripts/check-biz-config-parity.mjs                    # 连库对账
 *   node scripts/check-biz-config-parity.mjs --rows ./rows.json # 离线对账（CI 友好）
 *   node scripts/check-biz-config-parity.mjs --selftest         # 判据自证（必报/必不报）
 *
 * 退出码：0 无偏差 · 1 有偏差 · 2 自证失败或用法错误
 * ⛔ 刻意**不提供**「一键对齐」：与对账页同一条纪律（对账的作用是暴露差异，不是抹掉）。
 */
import { readFileSync } from 'node:fs';

import {
  BIZ_CONFIG_BASELINE,
  POLICY,
  diffBizConfig,
  hasViolation,
} from './lib/biz-config-baseline.mjs';

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
      'SELECT config_key AS configKey, config_value AS configValue FROM ab_config',
    );
    return rows;
  } finally {
    await conn.end();
  }
}

/** 打印并返回退出码（**纯展示，判据在上面**） */
function report(diff) {
  console.log('── ab_config 定稿值对账 ──');
  for (const a of diff.aligned) {
    console.log(`  ✔ 对齐        ${a.key.padEnd(34)} = ${a.value}`);
  }
  for (const m of diff.missing) {
    if (m.violation) {
      console.log(`  ✘ 缺失(应补)  ${m.key.padEnd(34)} 定稿=${m.expected}`);
      console.log(`      出处：${m.source}`);
    } else {
      console.log(`  ○ 缺失(预期)  ${m.key.padEnd(34)} policy=${m.policy}（拍板不写库，靠 fallback）`);
    }
  }
  for (const d of diff.drifting) {
    console.log(`  ✘ 漂移        ${d.key.padEnd(34)} 定稿=${d.expected} 现网=${d.actual}`);
    console.log(`      出处：${d.source}`);
  }
  const bad = hasViolation(diff);
  console.log(
    `\n汇总：对齐 ${diff.aligned.length} · 偏差 ${diff.drifting.length + diff.missing.filter((m) => m.violation).length}`,
  );
  return bad ? 1 : 0;
}

/**
 * 自证（必做：恒绿或恒红的检查等于没有检查）
 *
 * 四组，两组「必报」两组「必不报」，全部用**真判定**跑，不复制判据。
 */
function selftest() {
  const seedKeys = BIZ_CONFIG_BASELINE.filter((s) => s.policy === POLICY.SEED);
  const fbKeys = BIZ_CONFIG_BASELINE.filter((s) => s.policy === POLICY.FALLBACK_ONLY);

  const cases = [
    {
      name: '【必不报】seed 键齐全且值对 · fallback-only 键缺失 → 绿',
      rows: seedKeys.map((s) => ({ configKey: s.key, configValue: s.value })),
      expect: 0,
    },
    {
      name: '【必不报】值格式不同但数值等价（2000 vs 2000.00）→ 绿（不许误报）',
      rows: BIZ_CONFIG_BASELINE.map((s) => ({
        configKey: s.key,
        configValue: s.value === '2000.00' ? '2000' : s.value,
      })),
      expect: 0,
    },
    {
      name: '【必报】seed 键缺失 → 红',
      rows: [],
      expect: 1,
    },
    {
      name: '【必报】seed 键值漂移（min_withdraw=10.00，D3 未落地）→ 红',
      rows: BIZ_CONFIG_BASELINE.map((s) => ({
        configKey: s.key,
        configValue: s.key === 'commission.min_withdraw' ? '10.00' : s.value,
      })),
      expect: 1,
    },
    {
      name: '【必报】fallback-only 键存在但值不同 → 红（存在就必须对）',
      rows: [
        ...seedKeys.map((s) => ({ configKey: s.key, configValue: s.value })),
        ...fbKeys.map((s) => ({ configKey: s.key, configValue: '999' })),
      ],
      expect: 1,
    },
  ];

  let ok = true;
  for (const c of cases) {
    const code = report(diffBizConfig(BIZ_CONFIG_BASELINE, c.rows));
    const pass = code === c.expect;
    if (!pass) ok = false;
    console.log(`  ${pass ? '✔' : '✘'} ${c.name}  › 期望=${c.expect} 实得=${code}`);
  }
  console.log(ok ? '\n自证通过' : '\n自证失败（检查器自身坏掉，不静默放行）');
  return ok ? 0 : 2;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest') || argv.includes('-h') || argv.includes('--help')) {
    return selftest();
  }
  const i = argv.indexOf('--rows');
  const rows = i >= 0 ? loadRowsFromFile(argv[i + 1]) : await loadRowsFromDb();
  return report(diffBizConfig(BIZ_CONFIG_BASELINE, rows));
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.message ?? e);
    process.exit(2);
  });

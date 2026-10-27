import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * `ab_config` 定稿值对账 / 建库脚本（2026-10-27 追加）
 *
 * ⚠️ **为什么这里是「起脚本」而不是「复刻判据」**：
 *    判据只有 `scripts/lib/biz-config-baseline.mjs` 一份（`diffBizConfig` / `hasViolation`，
 *    零 IO 纯函数）。`jest` 的 `moduleFileExtensions` 是 `["js","json","ts"]`、**不含 `mjs`**，
 *    `test/unit` 无法直接 import 它。若为了「有单测」在这里**重写一遍判据**，就立刻变成
 *    「判据两份」—— 正是本项目一直在治的病。故改为：
 *      · 判据自带 `--selftest`（`check-biz-config-parity.mjs` 内，含必报/必不报五组）；
 *      · 这里只测**脚本契约**：喂不同的人造行，断言退出码与输出。
 *    ⇒ 判据仍然只有一份，测试覆盖的是「门禁会不会真的红」。
 *
 * ## 它要钉死的两件事
 *   1. **必报**：定稿与现网不一致（漂移 / seed 键缺失）⇒ 退出码 1（机器先发现，不靠人记）。
 *   2. **必不报**：拍板「不写库」的键缺失，或值格式不同但数值等价 ⇒ 退出码 0
 *      （误报多了没人看，等于没有门禁）。
 */
// __dirname = <repo>/apps/api-server/test/unit ⇒ 四级向上才是仓库根
const REPO = resolve(__dirname, '../../../..');
const PARITY = join(REPO, 'scripts', 'check-biz-config-parity.mjs');
const SEED = join(REPO, 'scripts', 'seed-biz-config.mjs');

const DIR = mkdtempSync(join(tmpdir(), 'abox-bizcfg-'));

function rowsFile(name: string, rows: Array<{ configKey: string; configValue: string }>): string {
  const p = join(DIR, name);
  writeFileSync(p, JSON.stringify(rows), 'utf8');
  return p;
}

function run(script: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 2, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** 与 `lib/biz-config-baseline.mjs` 对齐的一套「定稿已落地」的现网行 */
const ALIGNED = [
  { configKey: 'commission.min_withdraw', configValue: '0.00' },
  { configKey: 'commission.withdraw_daily_limit', configValue: '2000.00' },
  { configKey: 'commission.withdraw_daily_count', configValue: '1' },
  { configKey: 'building.suspend_force_max_count', configValue: '20' },
  { configKey: 'order.pay_timeout_minutes', configValue: '30' },
  { configKey: 'settlement.supplier_total_default', configValue: '14.0' },
];

describe('ab_config 定稿值对账门禁', () => {
  it('判据自证（脚本内五组必报/必不报）必须全绿', () => {
    const r = run(PARITY, ['--selftest']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('自证通过');
  });

  it('【必不报】定稿已落地 → 退出码 0', () => {
    expect(run(PARITY, ['--rows', rowsFile('aligned.json', ALIGNED)]).code).toBe(0);
  });

  it('【必不报】数值等价但写法不同（2000 vs 2000.00）→ 不误报', () => {
    const rows = ALIGNED.map((r) =>
      r.configKey === 'commission.withdraw_daily_limit' ? { ...r, configValue: '2000' } : r,
    );
    expect(run(PARITY, ['--rows', rowsFile('fmt.json', rows)]).code).toBe(0);
  });

  it('【必不报】拍板「不写库」的键缺失 → 不算偏差', () => {
    const rows = [{ configKey: 'commission.min_withdraw', configValue: '0.00' }];
    expect(run(PARITY, ['--rows', rowsFile('fallback.json', rows)]).code).toBe(0);
  });

  it('【必报】seed 键缺失 → 红（决策写了没落地的典型形态）', () => {
    const r = run(PARITY, ['--rows', rowsFile('empty.json', [])]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('commission.min_withdraw');
  });

  it('【必报】值漂移（现网 10.00 / 定稿 0 —— D3 至今未落地）→ 红并打印出处', () => {
    const rows = ALIGNED.map((r) =>
      r.configKey === 'commission.min_withdraw' ? { ...r, configValue: '10.00' } : r,
    );
    const r = run(PARITY, ['--rows', rowsFile('drift.json', rows)]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('漂移');
    expect(r.out).toContain('commission.min_withdraw');
  });
});

describe('ab_config 定稿值建库脚本（幂等 · 默认 dry-run）', () => {
  it('不带 --apply 一律不写库，只打印将要做什么', () => {
    const r = run(SEED, ['--rows', rowsFile('empty.json', [])]);
    expect(r.out).toContain('[dry-run] 未写库');
    // ⭐ 缺失的 seed 键会被列出，但**没有**任何写库动作（本次不连库，写了也无从写）
    expect(r.out).toContain('INSERT 缺失键 1 个');
  });

  it('--emit-sql 产出的 SQL 是「只补缺失」形态，不含覆盖式 UPSERT', () => {
    const r = run(SEED, ['--emit-sql']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('WHERE NOT EXISTS');
    // 运营手工调过的值不能被建库冲掉 ⇒ 禁止 ON DUPLICATE KEY UPDATE
    expect(r.out).not.toContain('ON DUPLICATE KEY UPDATE');
  });

  it('--emit-sql 不为「拍板不写库」的键生成 INSERT', () => {
    const r = run(SEED, ['--emit-sql']);
    expect(r.out).toContain('building.suspend_force_max_count：policy=fallback-only');
    expect(r.out).not.toMatch(/INSERT INTO ab_config[^\n]*building\.suspend_force_max_count/);
  });
});

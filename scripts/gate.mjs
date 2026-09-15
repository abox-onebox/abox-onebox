#!/usr/bin/env node
/**
 * ABox 门禁执行器（**免 pnpm**）
 *
 * 背景：本机沙箱内 `pnpm` 不可用（corepack shim 路径被错误拼接为 `C:\c\Users\...`
 * → `pnpm -v` 无输出且退出码为空），故不能用 `pnpm -r <script>` 逐条复刻 CI。
 *
 * 做法：直接用 managed node，把「包内 node_modules/.bin + node 所在目录」前置进 PATH，
 *       以 shell 方式执行各包 `package.json` 里声明的同一条命令，逐条复刻 CI。
 *
 * 用法：
 *   node scripts/gate.mjs list            # 列出全部门禁
 *   node scripts/gate.mjs shared          # 仅重建共享包 dist（其它门禁的前置）
 *   node scripts/gate.mjs lint typecheck jest format
 *   node scripts/gate.mjs all
 *   node scripts/gate.mjs all --stop      # 首个失败即停（默认跑完再汇总）
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_DIR = dirname(process.execPath);
const IS_WIN = process.platform === 'win32';
const PATH_SEP = IS_WIN ? ';' : ':';

/** 各门禁：cwd 相对仓库根；cmd 与 package.json script 保持一致 */
const GATES = {
  'shared:types': { cwd: 'packages/shared-types', cmd: 'tsc -p tsconfig.build.json', group: 'shared' },
  'shared:utils': { cwd: 'packages/shared-utils', cmd: 'tsc -p tsconfig.build.json', group: 'shared' },
  lint: { cwd: '.', cmd: 'eslint . --ext .ts,.vue --max-warnings 0' },
  format: { cwd: '.', cmd: 'prettier --check "**/*.{ts,vue,json,md,scss}"' },
  'format:write': { cwd: '.', cmd: 'prettier --write "**/*.{ts,vue,json,md,scss}"' },
  'typecheck:api': { cwd: 'apps/api-server', cmd: 'tsc --noEmit' },
  'typecheck:admin': { cwd: 'apps/admin-web', cmd: 'vue-tsc --noEmit' },
  'typecheck:mp': { cwd: 'apps/miniprogram', cmd: 'vue-tsc --noEmit -p tsconfig.json' },
  jest: { cwd: 'apps/api-server', cmd: 'jest --passWithNoTests' },
  'build:api': { cwd: 'apps/api-server', cmd: 'nest build' },
  'build:admin': { cwd: 'apps/admin-web', cmd: 'vite build' },
  'build:mp': { cwd: 'apps/miniprogram', cmd: 'uni build -p mp-weixin' },
  seed: {
    cwd: 'apps/api-server',
    cmd: 'ts-node -r tsconfig-paths/register src/database/seeds/seed.ts',
  },
};

/** 组合门禁别名 */
const ALIASES = {
  shared: ['shared:types', 'shared:utils'],
  typecheck: ['typecheck:api', 'typecheck:admin', 'typecheck:mp'],
  build: ['build:api', 'build:admin', 'build:mp'],
  all: [
    'shared',
    'lint',
    'format',
    'typecheck',
    'jest',
    'build:api',
    'build:admin',
    'build:mp',
  ],
};

function expand(names) {
  const out = [];
  for (const n of names) {
    const list = ALIASES[n] ?? [n];
    for (const item of list) {
      const real = ALIASES[item] ? expand([item]) : [item];
      for (const r of real) if (!out.includes(r)) out.push(r);
    }
  }
  return out;
}

function run(name) {
  const gate = GATES[name];
  if (!gate) return { name, ok: false, code: -1, ms: 0, err: '未定义的门禁' };

  const cwd = resolve(ROOT, gate.cwd);
  const env = {
    ...process.env,
    PATH: [join(cwd, 'node_modules', '.bin'), join(ROOT, 'node_modules', '.bin'), NODE_DIR, process.env.PATH].join(
      PATH_SEP,
    ),
    NODE_PATH: join(dirname(NODE_DIR), 'workspace', 'node_modules'),
    CI: 'true',
  };

  const started = Date.now();
  const r = spawnSync(gate.cmd, {
    cwd,
    shell: true,
    stdio: 'pipe',
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const ms = Date.now() - started;

  const stdout = (r.stdout ?? '').trim();
  const stderr = (r.stderr ?? '').trim();
  const ok = r.status === 0;

  if (!ok) {
    const tail = [stdout, stderr].filter(Boolean).join('\n').split('\n').slice(-40).join('\n');
    console.log(`\n─── ${name} ✘ exit=${r.status} (${ms}ms) ───`);
    console.log(tail);
  }
  return { name, ok, code: r.status ?? -1, ms, out: ok ? stdout : '' };
}

const argv = process.argv.slice(2).filter((a) => a !== '--stop');
const stopOnError = process.argv.includes('--stop');

if (argv.length === 0 || argv[0] === 'list') {
  console.log('可用门禁：');
  for (const [k, v] of Object.entries(GATES)) console.log(`  ${k.padEnd(16)} [${v.group ?? '-'}] ${v.cwd} › ${v.cmd}`);
  console.log('\n别名：shared / typecheck / build / all');
  process.exit(0);
}

const queue = expand(argv);
console.log(`门禁执行：${queue.join(' → ')}\n`);

const results = [];
for (const name of queue) {
  process.stdout.write(`… ${name}`);
  const r = run(name);
  console.log(`\r${r.ok ? '✔' : '✘'} ${name}  (${r.ms}ms)`.padEnd(48));
  results.push(r);
  if (!r.ok && stopOnError) break;
}

const failed = results.filter((r) => !r.ok);
console.log('\n──────── 汇总 ────────');
for (const r of results) console.log(`${r.ok ? '✔' : '✘'} ${r.name.padEnd(16)} ${r.ms}ms`);
console.log(`\n通过 ${results.length - failed.length}/${results.length}${failed.length ? ` · 失败：${failed.map((f) => f.name).join(', ')}` : ' · 全绿 ✅'}`);
process.exit(failed.length ? 1 : 0);

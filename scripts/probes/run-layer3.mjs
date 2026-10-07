/**
 * 第三层一键：真发请求实测（三个探针串跑）
 *
 * 为什么要有这个文件：三个探针各自独立起停实例会互相抢 3101 端口，
 * 手工逐个跑很容易漏掉 seed 或忘记关上一个服务。这里统一：
 *
 *   ① `deep-test.mjs`（A 资质墙 / B 多单 · 28 项）—— 它自己不起服务，要外部喂一个，
 *      所以放在「起完实例之后」跑；
 *   ② `deep-cancel.mjs`（C 取消理由 · 22 项）—— 自带 seed + 起停；
 *   ③ `deep-round2.mjs`（D 边界 / E 闭环 / F 多单 / G 资质墙 · 32 项）—— 自带 seed + 起停。
 *
 * ⚠️ 起任何子进程都必须挂 pipefix 垫片：本机 `stdio:'pipe'` 一律 EBUSY（记忆 C5/C19）。
 *
 * 用法：node scripts/probes/run-layer3.mjs
 */
// ── 收编注入（2026-10-07）：以下路径**相对本文件推导**，换机器无需改一行 ──────────
import { fileURLToPath as __aboxFup } from 'node:url';
const __aboxU = (p) => __aboxFup(new URL(p, import.meta.url)).replace(/[\/]+$/, '');

import { spawnSync } from 'node:child_process';

const ROOT = __aboxU('../..');
const WS = __aboxU('../../../');
const NODE = process.execPath;
const PF = process.env.ABOX_PIPEFIX ?? ''; // 本机专用 child_process 垫片（**不在仓库内**，它自述「勿入仓库」）；设 `ABOX_PIPEFIX=<路径>` 才启用

const { BASE, startApiServer, waitHealthy, stopApiServer } = await import(
  `file:///${ROOT}/scripts/lib/e2e-server.mjs`
);

function run(file, label) {
  const r = spawnSync(NODE, [file], {
    cwd: WS,
    encoding: 'utf8',
    env: { ...process.env, PIPEFIX_QUIET: '1', NODE_OPTIONS: PF ? `--require ${PF}` : (process.env.NODE_OPTIONS ?? '') },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/合计：通过\s*(\d+)\s*·\s*失败\s*(\d+)/);
  const failLine = out.split('\n').find((l) => l.includes('失败项：')) ?? '';
  console.log(`\n===== ${label} =====`);
  console.log(out.trim().split('\n').slice(-40).join('\n'));
  return {
    label,
    exit: r.status,
    pass: m ? Number(m[1]) : NaN,
    fail: m ? Number(m[2]) : NaN,
    fails: failLine.replace('失败项：', '').trim(),
  };
}

console.log('① deep-test（需要外部实例，先 seed + 起服务）');
const seed = spawnSync(NODE, ['scripts/gate.mjs', 'seed'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, PIPEFIX_QUIET: '1', NODE_OPTIONS: PF ? `--require ${PF}` : (process.env.NODE_OPTIONS ?? '') },
});
if (seed.status !== 0) {
  console.error('seed 失败 exit=' + seed.status, ((seed.stdout || '') + (seed.stderr || '')).slice(0, 600));
  process.exit(2);
}

const child = startApiServer();
const healthy = await waitHealthy(BASE, { child, timeoutMs: 120000 });
if (!healthy) {
  console.error('服务未就绪');
  process.exit(2);
}

const r1 = spawnSync(NODE, ['scripts/probes/deep-test.mjs', BASE], {
  cwd: WS,
  encoding: 'utf8',
  env: { ...process.env, PIPEFIX_QUIET: '1', NODE_OPTIONS: PF ? `--require ${PF}` : (process.env.NODE_OPTIONS ?? '') },
});
const out1 = (r1.stdout || '') + (r1.stderr || '');
const m1 = out1.match(/合计：通过\s*(\d+)\s*·\s*失败\s*(\d+)/);
console.log('\n===== deep-test =====');
console.log(out1.trim().split('\n').slice(-35).join('\n'));
await stopApiServer(child);

const results = [
  {
    label: 'deep-test',
    exit: r1.status,
    pass: m1 ? Number(m1[1]) : NaN,
    fail: m1 ? Number(m1[2]) : NaN,
    fails: (out1.split('\n').find((l) => l.includes('失败项：')) ?? '').replace('失败项：', '').trim(),
  },
  run('scripts/probes/deep-cancel.mjs', 'deep-cancel'),
  run('scripts/probes/deep-round2.mjs', 'deep-round2'),
];

console.log('\n========== 第三层汇总 ==========');
let okAll = true;
for (const r of results) {
  const flag = r.exit === 0 ? '绿' : '红';
  console.log(`${flag}  ${r.label.padEnd(14)} 通过 ${r.pass} · 失败 ${r.fail}`);
  if (r.fails) console.log(`      失败项：${r.fails}`);
  if (r.exit !== 0) okAll = false;
}
process.exit(okAll ? 0 : 1);

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
 * ⚠️ 起任何子进程都**不能**碰管道：本机 `stdio:'pipe'` 一律 EBUSY（记忆 C5/C19）。
 *    本文件统一走 `scripts/lib/spawn-capture.mjs`（临时文件重定向，仓库内、跨机器可用）。
 *    ⛔ 旧的外部 `pipefix` 垫片已退役，**不**要再挂（挂了反而启动失败）。
 *
 * 用法：node scripts/probes/run-layer3.mjs
 */
// ── 收编注入（2026-10-07）：以下路径**相对本文件推导**，换机器无需改一行 ──────────
import { fileURLToPath as __aboxFup } from 'node:url';
const __aboxU = (p) => __aboxFup(new URL(p, import.meta.url)).replace(/[\/]+$/, '');

// ⚠️ 本机（Windows · 机器级）无法为子进程创建匿名管道 ⇒ 裸 `spawnSync`（省略 `stdio`
//    时默认就是 `'pipe'`）恒 `status=null` + EBUSY，连 `node -v` 都起不来。
//    ⛔ 故此处**不**用 `node:child_process` 的 `spawnSync`，也不再挂任何外部垫片
//    （旧 `ABOX_PIPEFIX` 挂载口已于 2026-10-09 随垫片退役一并删除）。
//    与 `gate.mjs` / `prod-mock-gate.mjs` 同源，统一走仓库内的临时文件重定向。
import { spawnCapture } from '../lib/spawn-capture.mjs';

const ROOT = __aboxU('../..');
const NODE = process.execPath;
// ⚠️ 传给子进程的脚本路径（`scripts/probes/…`）是**仓库根**相对的 ⇒ 子进程的 `cwd`
//    必须是 `ROOT`。这里旧代码另算了一个 `WS = __aboxU('../../../')`（**多退一层**，
//    落到仓库根的父目录 `…/ABox小程序`），子进程恒定 `Cannot find module`。
//    该缺陷此前被 `exit=null`（子进程根本没起来）完全遮住，本次修完 spawn 才暴露。

const { BASE, startApiServer, waitHealthy, stopApiServer } = await import(
  `file:///${ROOT}/scripts/lib/e2e-server.mjs`
);

function run(file, label) {
  // `spawnCapture` 返回 `{ status, error, stdout, stderr }`，stdout/stderr 已是字符串；
  // 子进程起不来时 `error` 会被摊到 stderr 上，`status=null` 与「真失败」可辨。
  const r = spawnCapture(NODE, [file], { cwd: ROOT });
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
const seed = spawnCapture(NODE, ['scripts/gate.mjs', 'seed'], { cwd: ROOT });
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

const r1 = spawnCapture(NODE, ['scripts/probes/deep-test.mjs', BASE], { cwd: ROOT });
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

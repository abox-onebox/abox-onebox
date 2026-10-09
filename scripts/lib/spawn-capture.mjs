/**
 * 同步拉起子进程并**拿回**它的 stdout / stderr —— 本机唯一可靠的同步捕获方式
 *
 * ── 为什么**不能**用 `stdio: 'pipe'` ────────────────────────────────────────
 * 本机（Windows · **机器级**限制，关掉沙箱同样复现 ⇒ 与 WorkBuddy 沙箱无关）
 * **无法为子进程创建匿名管道**。`spawnSync` 只要走 `pipe` 一律返回
 * `status=null` + `error.code=EBUSY` —— 连 `node -v` 都起不来。2026-10-09 实测：
 *
 *     spawnSync(node, ['-e', ...])                    → status=null  error=EBUSY
 *     spawnSync('node -e ...', { shell: true })       → status=null  error=EBUSY
 *     execFileSync('git', [...])                      → EBUSY
 *     spawnSync(node, [...], { stdio: 'ignore' })     → status=0
 *     spawnSync(cmd, { shell: true, stdio: [ign,fd,fd] }) → status=0
 *     异步 spawn(cmd, { stdio: ['ignore','pipe','pipe'] }) → 正常（不受影响）
 *
 * ⚠️ **省略 `stdio` 时默认就是 `'pipe'`** —— 不写 `stdio` 一样中招（这一条曾让
 *    `gate:parity` 长期「垫片已装载、自证全绿、却仍报退出码 null」）。
 *
 * 落在门禁上的症状：**全部门禁 `exit=null`、耗时 1ms、无输出**
 * ⇒ 「环境故障伪装成测试失败」（与恒红 / 恒绿并列的第四种假象）。
 *
 * ── 做法：临时文件重定向 + 退出后回读 ────────────────────────────────────────
 * `openSync` 拿描述符 → `stdio: ['ignore', fdOut, fdErr]` → `spawnSync`
 * → `closeSync` → `readFileSync` → `unlinkSync`。
 * 行为对齐 `pipe`（stdout / stderr 分别成流、互不串味），但**不依赖任何外部垫片**，
 * 换台机器（有管道的环境）照样跑，故**可以进仓库**。
 *
 * ⛔ 不许写成 `stdio: ['pipe','pipe','pipe']` + 事后读文件 —— 那仍要碰管道，
 *    等于换一种方式把 EBUSY 请回来。
 *
 * ── 历史 ────────────────────────────────────────────────────────────────────
 * 2026-09-25 起靠**外部**垫片 `_tmp/gatepipe/pipefix.cjs`
 * （`NODE_OPTIONS=--require <abs>` 预载，把 pipe 透明改写成临时文件）。
 * 它有两个硬伤：① 位于仓库**外**、不在版本控制里 ⇒ 换机器 / 清临时目录就没了；
 * ② 必须 `export NODE_OPTIONS` 才能**继承到孙进程**，漏一次就全盘 `exit=null`
 * （踩过两次）。2026-10-09（κ 批次）把重定向**做进调用点**，垫片即可退役。
 *
 * ⭐ 子进程**根本没起来**时把 `error` 摊到 stderr 上 —— 否则只剩「无输出」，
 *    又把「环境故障」伪装成「对账失败」（同一次踩的坑，不再复现）。
 *
 * @param {string} cmd  命令（配合 `opts.shell` 可含 shell 语法）
 * @param {string[]} [args] 参数数组；不传即 `[]`
 * @param {object} [opts] 透传给 `spawnSync`（`cwd` / `env` / `shell` / `timeout` …）
 * @returns {{status: number|null, error: Error|undefined, stdout: string, stderr: string}}
 */
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function spawnCapture(cmd, args = [], opts = {}) {
  const tag = `abox-cap-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const outFile = join(tmpdir(), `${tag}.out.log`);
  const errFile = join(tmpdir(), `${tag}.err.log`);
  // ⚠️ 用 `openSync` 拿**描述符**，交给 `stdio` 的第 2 / 3 位 —— 子进程直接写到文件，
  //    全程不经过任何管道（fd0 用 'ignore'：本机连 stdin 管道也建不了，且门禁不需要喂 stdin）。
  const fdOut = openSync(outFile, 'w');
  const fdErr = openSync(errFile, 'w');
  let r;
  try {
    r = spawnSync(cmd, args, { ...opts, stdio: ['ignore', fdOut, fdErr] });
  } finally {
    closeSync(fdOut);
    closeSync(fdErr);
  }

  const read = (f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  const stdout = read(outFile);
  let stderr = read(errFile);
  for (const f of [outFile, errFile]) {
    try {
      unlinkSync(f);
    } catch {
      /* 临时目录残留由系统兜底，不影响门禁结论 */
    }
  }
  if (r.error) stderr = `${stderr}[spawn] 子进程未能启动：${r.error.code ?? ''} ${r.error.message}\n`;
  return { status: r.status, error: r.error, stdout, stderr };
}

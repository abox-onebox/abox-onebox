/**
 * ABox E2E 公共测试托管（**免 pnpm**，真实起服务）
 *
 * 由 e2e-m1.mjs / e2e-m2.mjs 共用，集中解决三个在 Windows 上反复踩到的坑：
 *
 * 1. **端口隔离**：每个 e2e 脚本用独立端口（`E2E_PORT` 可覆盖），避免 `gate.mjs verify`
 *    串跑时「上一个脚本的服务还占着 3000，下一个脚本的健康检查却轮询到了它」——
 *    那会让你对着一个**别人的服务**跑断言，问题现场极难辨认。
 * 2. **进程树回收**：`spawn(cmd, { shell: true })` 在 Windows 上只起一层 `cmd.exe`，
 *    `child.kill('SIGKILL')` 只杀 cmd.exe，**真正的 ts-node/node 会变成孤儿继续占端口**。
 *    这里统一用 `taskkill /PID <pid> /T /F`（POSIX 用进程组 `kill(-pid)`）连根拔。
 * 3. **失败可诊断**：起服务前先探测端口是否已被占用；健康检查期间监听子进程 `exit`，
 *    进程早退立刻抛错（而不是干等 90s 超时）。
 *
 * 用法：
 *   import { PORT, BASE, installCleanupHooks, startApiServer, waitHealthy, stopApiServer } from './lib/e2e-server.mjs';
 */
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const ROOT = resolve(HERE, '..', '..');
export const API_DIR = join(ROOT, 'apps', 'api-server');
export const DB_PATH = join(ROOT, 'data', 'abox-dev.sqlite');
export const NODE_DIR = dirname(process.execPath);
export const PATH_SEP = process.platform === 'win32' ? ';' : ':';
export const IS_WIN = process.platform === 'win32';

/** 单独跑时默认端口（避开 `.env` 的 3000，防止与开发者手动起的服务互撞） */
export const DEFAULT_PORT = 3101;

/** 本脚本使用的端口：`E2E_PORT=3110 node scripts/e2e-m2.mjs` 可覆盖 */
export const PORT = Number(process.env.E2E_PORT ?? DEFAULT_PORT);
export const BASE = `http://localhost:${PORT}/api/v1`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 端口探测 / 预检
// ---------------------------------------------------------------------------

/** 能否与目标端口建立 TCP 连接（true = 已有进程在监听） */
export function probePort(port, timeoutMs = 800) {
  return new Promise((resolveProbe) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    const done = (v) => {
      sock.removeAllListeners();
      sock.destroy();
      resolveProbe(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** 起服务前预检：端口被占直接抛错，给出可操作指引 */
export async function assertPortFree(port = PORT) {
  if (!(await probePort(port))) return;
  throw new Error(
    `端口 ${port} 已被占用：极可能是上一次 e2e 残留的 API 服务（孤儿进程）。\n` +
      `  · Windows 定位：netstat -ano | findstr :${port}\n` +
      `  · Windows 清理：taskkill /F /T /PID <pid>\n` +
      `  · 或换端口跑：E2E_PORT=${port + 1} node <script>`,
  );
}

// ---------------------------------------------------------------------------
// 起服务 / 回收
// ---------------------------------------------------------------------------

/** 已启动的服务进程（供退出钩子统一回收） */
const running = new Set();

/**
 * 构造子进程环境。`extra` 用于**单次覆盖**（见下 `startApiServer`）。
 *
 * ⭐ `ABOX_RATE_LIMIT: 'off'` —— e2e 主线**默认关闭限流**，理由是实测数字：
 *    一轮 `e2e-m3` 会打 **54 次** `POST /auth/admin-login`（`finance`/`sanweiwu` 等
 *    同一账号各被复用近 10 次），而生产阈值是 **IP 10/分 · 账号 5/分**（按「一栋办公楼
 *    共用 NAT 出口」定的，见 `rate-limit.middleware.ts`）。不关的话套件会被**自己的防护**
 *    打成 429 而红 —— 那不是被测行为出错，是把安全机制变成了不稳定因素。
 *
 * ⚠️ 关掉它**不等于**限流没被验证：`e2e-m3.mjs` §33 会**另起一台开启限流的实例**
 *    （`startApiServer(PORT, { ABOX_RATE_LIMIT: 'on' })`）走真实 HTTP 断言 429/10005。
 *    两者是**故意分开**的：主线测业务，§33 测防护本身。
 * ⚠️ 服务端对 `NODE_ENV=production` 硬忽略此开关，故这里传 off 不会削弱生产。
 *
 * 覆盖优先级（低 → 高）：**本文件的默认 `off`** < `process.env.ABOX_RATE_LIMIT`
 * < `extra.ABOX_RATE_LIMIT`。中间那一层不是冗余 —— 调用方（如 `local-test.mjs`）
 * 的既有习惯是「先设 `process.env` 再起服务」，若把默认值写成不可覆盖的常量，
 * 那种写法会**静默失效**（正是本批反复在收的那类假绿）。
 */
function buildEnv(port, extra = {}) {
  return {
    ...process.env,
    // dotenv 不覆盖既有环境变量 → 这里的值优先于 apps/api-server/.env 的 APP_PORT
    APP_PORT: String(port),
    ABOX_RATE_LIMIT: process.env.ABOX_RATE_LIMIT ?? 'off',
    ...extra,
    PATH: [
      join(API_DIR, 'node_modules', '.bin'),
      join(ROOT, 'node_modules', '.bin'),
      NODE_DIR,
      process.env.PATH,
    ].join(PATH_SEP),
    NODE_PATH: join(dirname(NODE_DIR), 'workspace', 'node_modules'),
  };
}

/**
 * 起 API 服务。
 * @param port  监听端口
 * @param extra 额外环境变量（可覆盖默认值，如 `{ ABOX_RATE_LIMIT: 'on' }`）
 */
export function startApiServer(port = PORT, extra = {}) {
  const child = spawn('ts-node -r tsconfig-paths/register src/main.ts', {
    cwd: API_DIR,
    shell: true,
    env: buildEnv(port, extra),
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX 下建独立进程组，便于整组回收；Windows 不支持进程组语义，靠 taskkill /T
    detached: !IS_WIN,
  });
  child.stdout.on('data', (b) => {
    const s = b.toString();
    if (/error|Error|✖|异常/.test(s)) process.stderr.write(`[api] ${s}`);
  });
  child.stderr.on('data', (b) => {
    const s = b.toString();
    // 忽略 nest 的 source-map 噪音
    if (!/source-map|at /.test(s)) process.stderr.write(`[api:err] ${s}`);
  });
  running.add(child);
  child.once('exit', () => running.delete(child));
  return child;
}

/** 连根拔：Windows 用 taskkill /T 覆盖 cmd.exe → ts-node → node 整棵树 */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;
  try {
    if (IS_WIN) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 10_000,
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  } catch {
    /* 回收尽力而为，不改变测试结论 */
  }
}

/** 停服务并**确认端口已释放**，保证串跑的下一个脚本一定能 bind */
export async function stopApiServer(child, port = PORT) {
  killTree(child);
  for (let i = 0; i < 40; i++) {
    if (!(await probePort(port, 300))) return true;
    await sleep(250);
  }
  return false;
}

/**
 * 进程退出兜底回收：即便 main() 中途抛错（断言异常 / 网络错误），
 * 也不会把孤儿服务留在端口上。
 */
export function installCleanupHooks() {
  const bye = () => {
    for (const c of [...running]) killTree(c);
    running.clear();
  };
  process.on('exit', bye);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      bye();
      process.exit(130);
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * 生成 HTTP 调用器（统一响应结构：`{ code, message, data, requestId, timestamp }`）
 * @param base 如 http://localhost:3101/api/v1
 */
export function makeCall(base) {
  return async function call(method, path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ['X-Client']: 'e2e' };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.idem) headers['Idempotency-Key'] = opts.idem;

    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* 非 JSON（网关错误页） */
    }
    return { status: res.status, body: json };
  };
}

// ---------------------------------------------------------------------------
// 健康检查
// ---------------------------------------------------------------------------

/**
 * 轮询健康检查。
 * @param base  如 http://localhost:3101/api/v1
 * @param opts  { child, timeoutMs } —— 传 child 可检测「进程早退」并立刻失败
 */
export async function waitHealthy(base, opts = {}) {
  const { child = null, timeoutMs = 90_000 } = opts;
  const call = makeCall(base);
  let exited = null;
  if (child) child.once('exit', (code, signal) => (exited = { code, signal }));

  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (exited) {
      throw new Error(
        `API 服务进程提前退出（code=${exited.code} signal=${exited.signal}）——` +
          `常见原因：端口被占用 / 编译报错，见上方 [api:err] 输出。`,
      );
    }
    try {
      const r = await call('GET', '/health');
      if (r.status === 200 && r.body?.code === 0) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(600);
  }
  return false;
}

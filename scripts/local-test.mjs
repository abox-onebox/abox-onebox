#!/usr/bin/env node
/**
 * ABox 一盒 · 本地内部测试一键启动器（**免 pnpm / 免 Docker / 免云资源**）
 *
 * 目的：在云服务器与账号资源到位**之前**，把「真人可上手试」的环境拉起来 ——
 *   后端跑**真实业务代码 + 真实数据库**（sqlite），前端跑**真实页面**，
 *   手机连同一 WiFi 扫码即用。这样内部测试不必等部署。
 *
 * 用法：
 *   node scripts/local-test.mjs                 # 起 API + 用户端(H5) + 运营后台
 *   node scripts/local-test.mjs --seed          # 起之前先重置种子数据（干净一套）
 *   node scripts/local-test.mjs --only=api      # 只起后端
 *   node scripts/local-test.mjs --only=api,h5   # 起后端 + 用户端
 *   node scripts/local-test.mjs --clock=off     # 关掉时钟注入（按真实北京时间跑）
 *   node scripts/local-test.mjs --api-port=3100 --h5-port=5181 --admin-port=5175
 *   node scripts/local-test.mjs --build         # 先重建用户端(H5)与后台，再起服务
 *                                               #（改完代码用这个；不重建则用上次产物）
 *   node scripts/local-test.mjs --smoke         # 起完自动跑端到端自检（会**真下一单**）
 *                                               # 走「H5 端口 → 同源代理 → API」真实链路
 *
 * ── 关于「同源」────────────────────────────────────────────────────────────
 * 用户端 H5 **必须以相对路径构建**（`VITE_API_BASE_URL=/api/v1`）：页面与接口都由本
 * 服务器同端口提供，于是**不依赖任何固定 IP**（换网、换 WiFi 都不用重建）、也不会踩
 * 跨域。写成 `http://192.168.x.x:3000/...` 看似直观，但换个网络环境就全部请求失败。
 *
 * ── 两个必须知道的约定 ────────────────────────────────────────────────────
 * ① **时钟注入**：`isOrderable(T)` = `[T-1 14:00, T-1 23:00)` —— 窗口之外，
 *    「明天」这一整天都下不了单。内部测试不可能挑时间做，故默认把**北京小时**
 *    平移到 20:00（`ABOX_SHIFT_TO_HOUR=20`，日历日不变、时间 1:1 前进），
 *    于是**任何时刻**都能走完整下单→支付→截单链路。`time.ts` 在
 *    `NODE_ENV=production` 时忽略该变量，不会渗进生产。
 * ② **Mock 通道**：`PROVIDER_MODE=mock` 下，微信登录用 `code=dev:<标识>`（不需要
 *    真实 AppID），支付自动回调成功（默认延迟 800ms）。这样「登录→下单→支付」
 *    能完整走通，但**不产生真实资金流**。
 *
 * ⚠️ 端口只从**本文件**的参数取，不读 `lib/e2e-server.mjs` 导出的 `PORT`/`BASE`
 *    —— 那两个常量在模块加载时按 `E2E_PORT` 求值，混用会得到「服务起在 A 端口、
 *    健康检查却探 B 端口」的假故障（真踩过，见 ref《缺陷与陷阱》）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killTree, probePort, startApiServer, waitHealthy } from './lib/e2e-server.mjs';
import { startStaticApp } from './lib/local-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const IS_WIN = process.platform === 'win32';

/**
 * 用户端 H5 的产物目录
 *
 * ⚠️ **刻意不放在 `dist/` 下**：`dist/` 归 `gate.mjs build:mp` 所有（构建前把整个
 * outDir 改名挪走），放进去的话**每次跑门禁都会把 H5 产物清掉** —— 表现是
 * 「昨天手机上还能开，今天说缺产物」。故用 `UNI_OUTPUT_DIR` 引到 `dist-h5/`，
 * 与微信小程序产物各占一处、互不干扰。
 */
const H5_DIST = join(ROOT, 'apps', 'miniprogram', 'dist-h5');
const ADMIN_DIST = join(ROOT, 'apps', 'admin-web', 'dist');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};

const apiPort = Number(opt('api-port', 3000));
const h5Port = Number(opt('h5-port', 5180));
const adminPort = Number(opt('admin-port', 5173));
const only = String(opt('only', 'api,h5,admin'))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const clock = String(opt('clock', '20'));
const noQr = Boolean(opt('no-qr', false));
const doBuild = Boolean(opt('build', false));
const want = (k) => only.includes(k);

if ([apiPort, h5Port, adminPort].some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
  console.error('端口必须是 1–65535 的整数。');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const LAN_IP = (() => {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
})();

const say = (s = '') => console.log(s);
const line = () => say('─'.repeat(68));

/** 终端二维码（`qrcode-terminal` 已在根 node_modules，无需安装）
 *
 *  ⚠️ 传了回调它就**只回传字符串、不自己打印** —— 必须由我们 `console.log`，
 *  否则屏幕上什么都不出现，还会误以为「库没装好」。 */
async function printQr(text) {
  if (noQr) return;
  try {
    const { default: qrcode } = await import('qrcode-terminal');
    await new Promise((done) =>
      qrcode.generate(text, { small: true }, (qr) => {
        say(qr);
        done();
      }),
    );
  } catch {
    /* 装不上就只是不显示二维码，不影响服务 */
  }
}

const cleanup = [];
let apiChild = null;

async function shutdown(code = 0) {
  for (const fn of cleanup.reverse()) {
    try {
      await fn();
    } catch {
      /* 回收尽力而为 */
    }
  }
  if (apiChild) killTree(apiChild);
  process.exit(code);
}
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(130));

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  say();
  say('ABox 一盒 · 本地内部测试环境');
  line();
  say(`  驱动：db=sqlite · queue=memory · storage=local · provider=mock`);
  say(
    clock === 'off'
      ? '  时钟：按**真实**北京时间跑（下单窗口 = T-1 14:00–23:00，窗口外下不了单）'
      : `  时钟：北京小时 → ${clock}:00（下单窗口**恒定开放** · 日历日不变）`,
  );
  line();

  // ① 种子（可选）
  if (opt('seed', false)) {
    say('▸ 重置种子数据（约 10 秒）…');
    const r = spawnSync(NODE, [join(ROOT, 'scripts', 'gate.mjs'), 'seed'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env },
    });
    if (r.status !== 0) {
      console.error('✖ 种子导入失败，已中止。');
      return shutdown(1);
    }
  }

  // ①.5 重建前端产物（可选）
  if (doBuild) {
    if (want('h5')) {
      say('▸ 重建用户端 H5（约 25 秒）…');
      const r = spawnSync(
        join(ROOT, 'node_modules', '.bin', IS_WIN ? 'uni.cmd' : 'uni'),
        ['build', '-p', 'h5', '--mode', 'development'],
        {
          cwd: join(ROOT, 'apps', 'miniprogram'),
          stdio: 'inherit',
          shell: IS_WIN,
          // `--mode development` 决定 `demoMode=true`（否则端上会去调 `uni.login`，
          // H5 里没有这个能力 → 登录卡死）；`UNI_OUTPUT_DIR` 见 H5_DIST 处说明。
          env: { ...process.env, VITE_API_BASE_URL: '/api/v1', UNI_OUTPUT_DIR: 'dist-h5' },
        },
      );
      if (r.status !== 0) {
        console.error('✖ 用户端构建失败，已中止。');
        return shutdown(1);
      }
    }
    if (want('admin')) {
      say('▸ 重建运营后台…');
      const r = spawnSync(NODE, [join(ROOT, 'scripts', 'gate.mjs'), 'build:admin'], {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env },
      });
      if (r.status !== 0) {
        console.error('✖ 运营后台构建失败，已中止。');
        return shutdown(1);
      }
    }
  }

  // ② 后端
  if (want('api')) {
    if (await probePort(apiPort)) {
      say(`▸ 后端：${apiPort} 端口已有服务在跑 —— **直接复用**（未重启）`);
    } else {
      say(`▸ 后端：启动中（ts-node 编译首次约 15–30 秒）…`);
      if (clock !== 'off') process.env.ABOX_SHIFT_TO_HOUR = clock;
      process.env.QUEUE_DRIVER = 'memory';
      process.env.QUEUE_BACKOFF_BASE_MS = '20';
      apiChild = startApiServer(apiPort);
      const base = `http://127.0.0.1:${apiPort}/api/v1`;
      if (!(await waitHealthy(base, { child: apiChild, timeoutMs: 120_000 }))) {
        console.error(`✖ 后端 120 秒内未通过健康检查（${base}/health）。`);
        return shutdown(1);
      }
      say(`  ✔ 后端就绪：${base}/health`);
    }
  }

  // ③ 用户端（小程序 H5 版）
  if (want('h5')) {
    if (!existsSync(join(H5_DIST, 'index.html'))) {
      say('▸ 用户端：**缺构建产物**，跳过。加上 `--build` 重跑即可（或手动执行）：');
      say('    cd apps/miniprogram');
      say(
        '    VITE_API_BASE_URL=/api/v1 UNI_OUTPUT_DIR=dist-h5 ../../node_modules/.bin/uni build -p h5 --mode development',
      );
    } else {
      const app = await startStaticApp({
        root: H5_DIST,
        port: h5Port,
        proxyTarget: `http://127.0.0.1:${apiPort}`,
        spa: false, // 用户端是 hash 路由，不需要 history 回退
        label: 'h5',
      });
      cleanup.push(app.close);
      say(`  ✔ 用户端就绪：http://${LAN_IP}:${h5Port}/`);
    }
  }

  // ④ 运营后台
  if (want('admin')) {
    if (!existsSync(join(ADMIN_DIST, 'index.html'))) {
      say('▸ 运营后台：**缺构建产物**，跳过。先执行 `node scripts/gate.mjs build:admin`。');
    } else {
      const app = await startStaticApp({
        root: ADMIN_DIST,
        port: adminPort,
        proxyTarget: `http://127.0.0.1:${apiPort}`,
        spa: true, // 后台是 history 路由
        label: 'admin',
      });
      cleanup.push(app.close);
      say(`  ✔ 运营后台就绪：http://${LAN_IP}:${adminPort}/`);
    }
  }

  // ⑤ 端到端自检（可选）
  if (opt('smoke', false)) {
    say('▸ 端到端自检（走手机那条路：页面 → 同源代理 → 后端）…');
    const { smoke } = await import('./lib/local-smoke.mjs');
    await smoke({
      h5Url: `http://127.0.0.1:${h5Port}`,
      adminUrl: `http://127.0.0.1:${adminPort}`,
      apiPort,
      log: (s) => say(s),
    });
  }

  // ⑥ 访问面板
  say();
  line();
  if (want('h5')) {
    say('  📱 手机扫码即用（**需与电脑同一 WiFi**）—— 用户端 / 团长端');
    say(`     http://${LAN_IP}:${h5Port}/`);
    await printQr(`http://${LAN_IP}:${h5Port}/`);
  }
  if (want('admin')) {
    say(`  🖥  运营后台（电脑浏览器）  http://${LAN_IP}:${adminPort}/`);
  }
  if (want('api')) {
    say(`  🔌 接口健康检查  http://${LAN_IP}:${apiPort}/api/v1/health`);
    say(`     接口文档      http://${LAN_IP}:${apiPort}/docs`);
  }
  line();
  say('  测试身份（Mock 通道，**不需要真实微信**）—— 登录时在端上填 / 代码里传 code');
  say('    dev:1001  李明 · 首席团长  12%   ← 标杆账号（自检**不会**占用）');
  say('    dev:1002  王芳 · 金牌团长  10%   dev:1003  张磊 · 正式团长  9%');
  say('    dev:1004  赵静 · 正式团长   9%   dev:1005  陈强 · 见习团长  8%');
  say('    dev:newbie / 任意新 code → **拿不到团**（未绑楼栋，/home/daily 回 10004，属预期）');
  say('  运营后台账号');
  say('    admin / admin123（超管）  finance / finance123  sanweiwu / supplier123');
  line();
  say('  ⚠️ 手机打不开？九成是 Windows 防火墙拦了 node.exe：');
  say('     控制面板 → Windows Defender 防火墙 → 允许应用通过防火墙 → 勾上 node.exe');
  say('  ⚠️ 支付走 Mock：**会自动回调成功**，但**不产生真实资金流**。');
  line();
  say('  按 Ctrl+C 退出（本次启动的服务一并停止）');
  say();
}

main().catch(async (e) => {
  console.error('✖ 启动失败：', e?.message ?? e);
  await shutdown(1);
});

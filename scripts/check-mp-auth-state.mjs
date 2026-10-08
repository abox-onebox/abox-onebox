#!/usr/bin/env node
/**
 * 小程序「登录态裁决权」门禁 —— P1-16 的回归保护
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * `api/request.ts` 对 `10002 / 401 / 20014` 是按**单次请求**裁决 session 的：
 * 只要有一次响应是这些码，就无条件 `clearAuthStorage()`。
 * 而 P6 订单列表是「主请求（走 useRequest，能重登重试）+ 4 个旁路计数（裸调）」**并发**，
 * token 恰好过期时 —— 主请求正在重登重试，4 个旁路拿着**同一个旧 token** 回来也是 10002
 * ⇒ 把重登刚写进去的**新 token 又删掉**，用户被自己看不见的副请求踢下线（P1-16）。
 *
 * 修法是在请求层加显式开关 `keepAuthState`，让旁路请求**只失败、不出手裁决 session**。
 * 但这类修复有一个天然的脆弱面：**它没有任何运行时症状可被观察**（计数失败本来就是静默的），
 * 开关被删掉、或者旁路改回裸调，全仓 typecheck / lint / e2e 都会全绿。
 * 本门禁就是把「谁有权裁决登录态」从**注释里的约定**变成**可跑的断言**。
 *
 * ── 三条不变量（对**当前源码**断言，不用冻结副本）──────────────────────────
 *   ① **主路径必须仍然会清态**（防过度修复）
 *      一次「真拒」——请求携带的就是当时最新 token，被服务端判 10002 ⇒ 恰好清态 1 次。
 *      少清一次 = 有人把 session 裁决权收得太死，用户会卡在半登录状态。
 *   ② **旁路不得踩踏新 token**（P1-16 本体）
 *      4 个计数请求携带旧 token、且在新 token 写入**之后**才回来 ⇒ 清态 **0** 次。
 *   ③ **正常路径行为不变**（防功能回归）
 *      5 次请求 / 0 次登录 / token 不动 / 不弹错 / 四档各自拿到自己那一档的 total。
 *
 * ── 两个必须避开的判据坑（都实测踩过）──────────────────────────────────────
 *   · **不比对「最终 token 是否为空」**：主路径那次清态本来就是合法的，
 *     「改前也是空、改后也是空」会让这条判据变成一个恒绿的空壳。
 *     真正的判据是区分**陈旧裁决**与**合法清态**：
 *       陈旧 = 请求携带的 token ≠ 该响应到达时本进程**已写过的最新 token**。
 *   · **不与上一个失败Timing比值/不比「响应到达时的存储现值」**：第一个旁路清完之后现值是空，
 *     后三个会被误读成「合法」。必须比「写到过的最新 token」，才能把 4 次伤害一视同仁数出来。
 *   · **样本为 0 必须算未达标**：危险条件根本没构造出来（时序写错 / 页面改了 orchestration）
 *     时①②③ 都会是「0 违规」，与「全部达标」同形。 ---- 见下方 `noSample` 处置
 *     （与 `check-icon-lock.mjs` 的「样本为 0」同一口径）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   node scripts/check-mp-auth-state.mjs              # 跑全部场景（leak + ok）—— 门禁唯一走法
 *
 * ⛔ 刻意**不提供**「只跑单个场景」的开关：单场景会拿到「不完整却全绿」的结论且无人拦截。
 *
 * 退出码：0 = 全部通过；1 = 有不达标项（含样本为 0）；2 = 依赖缺失 / 打包失败
 */
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, '..');
const SRC = join(REPO, 'apps/miniprogram/src');
const PAGE = join(SRC, 'pages/order-list/order-list.vue');

const require_ = createRequire(pathToFileURL(join(REPO, 'package.json')).href);

// ── 依赖：esbuild + @vue/compiler-sfc（都在仓根 node_modules）────────────────
let build;
let parse;
let compileScript;
try {
  ({ build } = require_('esbuild'));
  ({ parse, compileScript } = require_('@vue/compiler-sfc'));
} catch (e) {
  console.error(`❌ 依赖缺失，无法执行判据：${e.message}`);
  console.error('   需要 esbuild 与 @vue/compiler-sfc（仓根 node_modules）');
  process.exit(2);
}

// ── 常量 ─────────────────────────────────────────────────────────────────────
const TOKEN_OLD = 'T1-expired';
const TOKEN_NEW = 'T2-fresh';
/** 四档各自的 total —— 取四个**互不相同**的值，才能证明「各拿自己那一档」而不是都拿到同一个兜底值 */
const TOTALS = { '': 12, paid: 3, completed: 7, cancelled: 2 };
const TAB_VALUES = ['', 'paid', 'completed', 'cancelled'];

/**
 * 时序（leak 场景的关键）：主列表 50ms 就回 10002 ⇒ 触发重登（150ms）⇒ T2 在 ~205ms 写入；
 * 4 个计数**刻意 300ms** 才回 ⇒ 落在「新 token 已写入之后」。
 * 余量约 95ms：即便多跳一两个事件循环也不会错序，但若机器极端卡顿则需复查本注释。
 */
const TIMING = { listBad: 50, login: 150, countBad: 300, okAll: 40 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (s) => console.log(s);

// ── 假 transport ─────────────────────────────────────────────────────────────
/**
 * 每个场景建**一个全新**的 sink（事件流水 / 假 storage / toast），避免样本间串扰 ——
 * 这一点踩过坑：早版本在单进程里连跑多个样本，泄漏的定时器会污染后一个样本的计数。
 */
function createSink() {
  return { events: [], storage: Object.create(null), toasts: [], requests: [], pending: [] };
}

const statusOf = (url) => {
  const m = /[?&]status=([^&]*)/.exec(String(url));
  return m ? decodeURIComponent(m[1]) : '';
};
const isList = (url) => String(url).includes('pageSize=20');

function labelOf(url) {
  const u = String(url);
  if (u.includes('/auth/login')) return 'LOGIN';
  const s = statusOf(u);
  return isList(u) ? 'LIST' : `CNT(${s || 'all'})`;
}

function createTransport(sink, cfg) {
  const log = (e) => sink.events.push({ t: Date.now() - cfg.t0, ...e });

  return {
    getStorageSync: (k) => (k in sink.storage ? sink.storage[k] : ''),
    setStorageSync: (k, v) => {
      sink.storage[k] = v;
      if (k === 'abox_token')
        log({ kind: 'TOK', op: '写入', label: '', code: '', tok: '', v: String(v) });
    },
    removeStorageSync: (k) => {
      delete sink.storage[k];
      if (k === 'abox_token') log({ kind: 'TOK', op: '删除', label: '', code: '', tok: '', v: '' });
    },
    showLoading: () => {},
    hideLoading: () => {},
    showToast: (o) => sink.toasts.push(o),
    request(opts) {
      const url = String(opts.url);
      const carried = String(
        (opts.header && (opts.header.Authorization || opts.header.authorization)) || '',
      ).replace('Bearer ', '');
      sink.requests.push({ url, tok: carried });
      log({ kind: 'REQ', op: '', label: labelOf(url), code: '', tok: carried, v: '' });

      const finish = (statusCode, body) => {
        log({
          kind: 'RES',
          op: '',
          label: labelOf(url),
          code: body && typeof body === 'object' ? body.code : '?',
          tok: carried,
          v: '',
        });
        opts.success({ statusCode, data: body });
      };

      if (url.includes('/auth/login')) {
        return setTimeout(
          () =>
            finish(200, {
              code: 0,
              data: {
                token: TOKEN_NEW,
                isNewUser: false,
                isLeader: false,
                leader: null,
                user: {
                  id: 1,
                  nickname: 'gate',
                  avatarUrl: null,
                  phone: null,
                  buildingId: 1,
                  teamLeaderId: null,
                },
              },
            }),
          cfg.loginDelay,
        );
      }

      // 只有 cfg.validToken 才是服务端认的 token；其余一律 10002
      if (carried === cfg.validToken) {
        return setTimeout(
          () =>
            finish(200, {
              code: 0,
              data: {
                list: [],
                page: 1,
                pageSize: isList(url) ? 20 : 1,
                total: TOTALS[statusOf(url)] ?? TOTALS[''],
                hasMore: false,
              },
            }),
          cfg.okDelay(url),
        );
      }

      // ⚠️ 时序**不靠定时器赌**：leak 场景的旁路响应先**扣住**，等「重登写入新 token」
      //    这一**事件**放闸（`holdStale`）。原写法用 `countBad: 300ms` 去猜「晚于重登」——
      //    忙机上事件循环一漂（>150ms 的余量）⇒ 危险条件根本没构造出来 ⇒ **假红**。
      //    改成事件驱动后，「旁路晚于新 token 写入」与机器快慢无关。
      if (cfg.holdStale && !isList(url)) {
        sink.pending.push(() =>
          finish(200, { code: 10002, message: '未登录或登录已过期', data: null }),
        );
        return;
      }

      return setTimeout(
        () => finish(200, { code: 10002, message: '未登录或登录已过期', data: null }),
        cfg.badDelay(url),
      );
    },
  };
}

// ── 判据：区分「陈旧裁决」与「合法清态」───────────────────────────────────────
function classify(sink) {
  const delTimes = sink.events.filter((e) => e.kind === 'TOK' && e.op === '删除').map((e) => e.t);
  const clearedAt = (t) => delTimes.some((d) => Math.abs(d - t) <= 1);
  const writes = sink.events.filter((e) => e.kind === 'TOK' && e.op === '写入');
  // ⚠️ 比的是「写到过的最新 token」，不是「响应到达时的存储现值」—— 见文件头两个坑
  const latestAt = (t) => {
    const prior = writes.filter((w) => w.t <= t);
    return prior.length ? prior[prior.length - 1].v : '';
  };
  const hits = sink.events.filter((e) => e.kind === 'RES' && e.code === 10002);
  const isStale = (e) => {
    const latest = latestAt(e.t);
    return Boolean(e.tok && latest && e.tok !== latest);
  };
  return {
    stale: hits.filter((e) => isStale(e) && clearedAt(e.t)),
    legit: hits.filter((e) => !isStale(e) && clearedAt(e.t)),
    /** 「危险条件」实录：携带旧 token 的响应，且当时已经换发过新 token */
    dangerous: hits.filter((e) => isStale(e)),
    countHits: hits.filter((e) => e.label.startsWith('CNT')),
  };
}

// ── 打包：真页面 SFC + 真请求层 + 真 store ───────────────────────────────────
/**
 * entry 用 esbuild 的 stdin（不必在仓里留 harness 文件）；
 * 只有 `@dcloudio/uni-app` 是替身（Node 里没有小程序运行时），
 * 请求层 / useRequest / ensureLogin / pinia store / storage **全是真源码**。
 */
const HARNESS = `
import { createPinia, setActivePinia } from 'pinia';
import { useUserStore } from '@/stores/user';
import { getToken } from '@/utils/storage';
import { __hooks } from '@dcloudio/uni-app';
import Page from 'virtual:page';

export function mountPage(initialToken) {
  setActivePinia(createPinia());
  if (initialToken) {
    useUserStore().setLogin(initialToken, {
      id: 1, nickname: 'gate', avatarUrl: null, phone: null, buildingId: 1, teamLeaderId: null,
    });
  }
  const comp = Page.default ?? Page;
  const setup = comp.setup;
  if (typeof setup !== 'function') throw new Error('页面编译产物里没有 setup()，判据前提不成立');
  return setup({}, { expose: () => {}, emit: () => {} });
}

export function fireOnShow() { for (const fn of __hooks.onShow) fn(); }
export function currentToken() { return getToken(); }
`;

/**
 * 变异覆盖表：**键 = 真文件的绝对路径**（不是 import 写法）
 *
 * ⚠️ 为什么必须按路径判、不能按写法判（实测踩过）：`api/order.ts` 用相对路径 `'./request'`、
 *    而 `composables/use-request.ts` 用别名 `'@/api/request'` —— 只覆盖后者会让 bundle 里
 *    出现**两份 request.ts** ⇒ `ApiError` 变成两个类 ⇒ `useRequest` 的 `e instanceof ApiError`
 *    **恒假** ⇒ 重登压根不触发 ⇒ 样本静默造不出来（只报「没观察到重登」，极难定位）。
 */
let OVERRIDE = {};
/** 换掉被测页面（变异体）；null = 用真源码 */
let PAGE_OVERRIDE = null;

let bundlePath = null;

async function ensureBundle(opts = {}) {
  OVERRIDE = opts.override ?? {};
  PAGE_OVERRIDE = opts.page ?? null;

  const dir = mkdtempSync(join(tmpdir(), 'abox-mp-auth-'));
  bundlePath = join(dir, 'bundle.mjs');

  const { errors } = await build({
    absWorkingDir: REPO,
    stdin: { contents: HARNESS, resolveDir: REPO, sourcefile: 'harness.ts', loader: 'ts' },
    outfile: bundlePath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    nodePaths: [join(REPO, 'node_modules')],
    external: [],
    logLevel: 'warning',
    define: {
      'import.meta.env.MODE': '"development"',
      'import.meta.env.VITE_API_BASE_URL': '"http://127.0.0.1:3999/api/v1"',
      'import.meta.env.VITE_WX_MINI_APPID': '""',
      'import.meta.env.VITE_WX_DEV_LOGIN_CODE': '"dev:1001"',
    },
    plugins: [
      {
        name: 'sfc',
        setup(b) {
          b.onResolve({ filter: /\.vue$/ }, (args) => ({
            path: resolve(args.resolveDir, args.path),
            namespace: 'sfc',
          }));
          b.onResolve({ filter: /^virtual:page$/ }, () => ({
            path: PAGE_OVERRIDE ?? PAGE,
            namespace: 'sfc',
          }));
          b.onResolve({ filter: /^@dcloudio\/uni-app$/ }, () => ({
            path: 'stub-uniapp',
            namespace: 'stub',
          }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: `
export const __hooks = { onShow: [] };
export function onShow(fn) { __hooks.onShow.push(fn); }
export function onLoad() {}
export function onHide() {}
export function onUnload() {}
export function onReady() {}
export function onPullDownRefresh() {}
export function onReachBottom() {}
`,
            loader: 'js',
            resolveDir: REPO,
          }));
          b.onLoad({ filter: /.*/, namespace: 'sfc' }, (args) => {
            const source = readFileSync(args.path, 'utf8');
            const { descriptor } = parse(source, { filename: args.path });
            const compiled = compileScript(descriptor, { id: 'gate', isProd: false });
            return { contents: compiled.content, loader: 'ts', resolveDir: REPO };
          });
        },
      },
      {
        name: 'alias',
        setup(b) {
          const EXTS = ['', '.ts', '.tsx', '.js', '.mjs', '.vue', '/index.ts', '/index.js'];
          /** 先解析成真文件，再查覆盖表 ⇒ 写法不同也只认同一份文件 */
          const resolveFile = (base) => {
            for (const ext of EXTS) {
              const p = base + ext;
              if (existsSync(p) && statSync(p).isFile()) return p;
            }
            return null;
          };
          const mapped = (file) => {
            const m = OVERRIDE[file];
            return m === undefined
              ? { path: file, namespace: file.endsWith('.vue') ? 'sfc' : undefined }
              : { path: m, namespace: m.endsWith('.vue') ? 'sfc' : undefined };
          };

          b.onResolve({ filter: /^@\// }, (args) => {
            const abs = resolve(SRC, args.path.slice(2));
            const file = resolveFile(abs);
            if (!file) return { errors: [{ text: `别名未命中：${args.path} → ${abs}` }] };
            return mapped(file);
          });

          // ⭐ 相对路径同样要过覆盖表：见 `OVERRIDE` 头注的那次踩坑（`order.ts` 的 `'./request'`）
          b.onResolve({ filter: /^\.{1,2}\// }, (args) => {
            const file = resolveFile(resolve(args.resolveDir, args.path));
            if (!file || OVERRIDE[file] === undefined) return undefined;
            return mapped(file);
          });
        },
      },
    ],
  });

  if (errors && errors.length) {
    throw new Error(`打包失败：${errors.map((e) => e.text).join(' / ')}`);
  }
  return bundlePath;
}

// ── 场景 ─────────────────────────────────────────────────────────────────────
/** 轮询等一个**条件**成立（不是等时间）—— 超时返回 false，由调用方判「样本没造出来」 */
async function waitUntil(fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
}

async function runLeak(cfg, bundleOverride) {
  const sink = createSink();
  globalThis.uni = createTransport(sink, cfg);

  const mod = await freshImport('leak', bundleOverride);
  mod.mountPage(TOKEN_OLD);
  mod.fireOnShow();

  if (cfg.holdStale) {
    // 「重登已写入新 token」是**事件**，不是时间 —— 等到它才放闸；
    //    等不到 ⇒ 判据前提不成立（不许拿「0 违规」当通过，也不许当失败，直接判样本没造出来）
    const sawNewToken = await waitUntil(
      () => sink.events.some((e) => e.kind === 'TOK' && e.op === '写入' && e.v === TOKEN_NEW),
      8000,
    );
    if (!sawNewToken) throw new Error('leak 样本没造出来：始终没有观察到「重登写入新 token」');
    for (const release of sink.pending.splice(0)) release();
    await sleep(400);
  } else {
    await sleep(1500);
  }

  const c = classify(sink);
  const binds = c;
  const loginCount = sink.events.filter((e) => e.kind === 'REQ' && e.label === 'LOGIN').length;
  const finalToken = mod.currentToken();

  const bad = [];
  if (binds.stale.length !== 0) {
    bad.push(
      `② 旁路踩踏新 token：${binds.stale.length} 次（必须 0）` +
        binds.stale.map((e) => `  ${e.t}ms ${e.label} 携带=${e.tok}`).join(''),
    );
  }
  if (binds.legit.length !== 1) {
    bad.push(
      `① 主路径清态次数=${binds.legit.length}（必须恰好 1 —— 少了=过度修复，多了=主路径自己在乱清）`,
    );
  }
  if (finalToken !== TOKEN_NEW) {
    bad.push(`① 最终 token="${finalToken}"（应为重登写入的 ${TOKEN_NEW}）`);
  }

  // 样本下限：危险条件必须**真的构造出来**了，否则上面的「0 违规」毫无意义
  const noSample = [];
  if (loginCount < 1) noSample.push('未触发重登（loginCount=0）');
  if (binds.legit.length < 1) noSample.push('主路径真拒 0 次');
  if (binds.dangerous.length < 4) {
    noSample.push(
      `危险条件只出现 ${binds.dangerous.length} 次（需 ≥4：4 个旁路都携带旧 token 且晚于新 token 写入）`,
    );
  }

  return {
    scenario: 'leak',
    desc: 'token 恰好过期：主路径重登重试中，4 个旁路计数拿旧 token 晚一步回来',
    bad,
    noSample,
    sink,
    // ⚠️ 数值一并回传：必报（变异）场景要靠它们判断「判据有没有牙齿」
    staleN: binds.stale.length,
    legitN: binds.legit.length,
    dangerousN: binds.dangerous.length,
    samples: {
      请求数: sink.requests.length,
      登录: loginCount,
      陈旧裁决: `${binds.dangerous.length} 次（其中出手清态 ${binds.stale.length} 次）`,
      合法清态: `${binds.legit.length} 次`,
      最终token: finalToken,
    },
  };
}

async function runOk(cfg, bundleOverride) {
  const sink = createSink();
  globalThis.uni = createTransport(sink, cfg);

  const mod = await freshImport('ok', bundleOverride);
  const bindings = mod.mountPage(TOKEN_OLD);
  mod.fireOnShow();
  await sleep(1200);

  const loginCount = sink.events.filter((e) => e.kind === 'REQ' && e.label === 'LOGIN').length;
  const finalToken = mod.currentToken();
  const counts = TAB_VALUES.map((v) => [v, bindings.countOf(v)]);

  const bad = [];
  if (sink.requests.length !== 5)
    bad.push(`③ 请求数=${sink.requests.length}（应为 5：1 列表 + 4 计数）`);
  if (loginCount !== 0) bad.push(`③ 触发了 ${loginCount} 次重登（正常路径应为 0）`);
  if (finalToken !== TOKEN_OLD) bad.push(`③ 登录态被改动：${finalToken}`);
  if (sink.toasts.length !== 0)
    bad.push(`③ 弹了 ${sink.toasts.length} 次 toast（计数失败应当静默）`);
  const wrong = counts.filter(([v, n]) => n !== TOTALS[v]);
  if (wrong.length) {
    bad.push(
      `③ 计数取错：${wrong.map(([v, n]) => `${v || 'ALL'}=${String(n)}(应 ${TOTALS[v]})`).join(' ')}`,
    );
  }

  const noSample = [];
  const cntRes = sink.events.filter((e) => e.kind === 'RES' && e.label.startsWith('CNT')).length;
  if (cntRes < 4) noSample.push(`旁路计数只回来 ${cntRes} 条（需 ≥4）`);
  if (sink.requests.length < 5) noSample.push('主+旁路共 <5 次请求，③ 的分母不足');

  return {
    scenario: 'ok',
    desc: '正常 200：四档计数必须照常拿到各自的 total，登录态不动、不弹错',
    bad,
    noSample,
    samples: {
      请求数: sink.requests.length,
      登录: loginCount,
      toast: sink.toasts.length,
      四档计数: counts.map(([v, n]) => `${v || 'ALL'}=${String(n)}`).join(' '),
      最终token: finalToken,
    },
  };
}

/** 事件流水（失败诊断用）：按时间排好，能直接读出因果链 */
function timelineOf(sink) {
  return sink.events
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((e) =>
      e.kind === 'TOK'
        ? `${e.t}ms TOKEN ${e.op}${e.op === '写入' ? ` ${e.v}` : ''}`
        : `${e.t}ms ${e.kind === 'REQ' ? '→发出' : '←响应'} ${e.label}${e.kind === 'RES' ? ` code=${e.code}` : ''}${e.tok ? ` 携带=${e.tok}` : ''}`,
    );
}

/** cache-busting 重新 import ⇒ 每个场景拿到**全新模块图**（尤其 utils/auth 的 pending 去重变量） */
let importNonce = 0;
async function freshImport(tag, bundleOverride) {
  const p = bundleOverride ?? bundlePath;
  return import(`${pathToFileURL(p).href}?sc=${tag}&n=${importNonce++}`);
}

// ── 必报（变异）样本：证明判据**有牙齿** ─────────────────────────────────────
//    只断言「当前源码是对的」是**不够的** —— 判据自身失效时它照样绿（恒绿陷阱）。
//    故人为造两个「修复前」形态，二者都**必须被报出踩踏**；报不出即判据不可用。
//
// ⚠️ 变异替身里带 `globalThis.__MUT_*` 运行时哨兵：光「替换成功」不算数，必须证明
//    **变异后的那份代码真的进了 bundle 并执行了**。踩过的坑：页面注释里也写着
//    `keepAuthState: true`（order-list.vue:143），只匹配裸字面量会把变异打进**注释**
//    ⇒ 变异体永不执行 ⇒ 「必报样本通过」是假的。
const MUT_PAGE = {
  from: '{ keepAuthState: true },',
  to: '{ keepAuthState: (globalThis.__MUT_PAGE = true, false) },',
};
const MUT_REQ = { from: '!keepAuthState &&', to: '((globalThis.__MUT_REQ = true), true) &&' };
const REQUEST_TS = join(SRC, 'api', 'request.ts');

/** 写变异体；**没命中就抛**（变异失效 ≡ 自证失效，不许静默放行） */
function writeMutant(srcAbs, needle, outAbs) {
  const text = readFileSync(srcAbs, 'utf8');
  const n = text.split(needle.from).length - 1;
  if (n === 0) {
    throw new Error(
      `变异失效：${srcAbs} 里找不到 \`${needle.from}\` —— 源码形态已变，必须同步更新变异针，而不是放行`,
    );
  }
  writeFileSync(outAbs, text.split(needle.from).join(needle.to));
  return n;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(PAGE)) {
    console.error(`❌ 找不到被测页面：${PAGE}`);
    return 2;
  }

  const t0 = Date.now();
  const baseCfg = { t0, loginDelay: TIMING.login };
  const leakCfg = {
    ...baseCfg,
    validToken: TOKEN_NEW,
    okDelay: () => TIMING.okAll,
    badDelay: (url) => (isList(url) ? TIMING.listBad : TIMING.countBad),
    holdStale: true,
  };

  const want = ['leak', 'ok']; // 固定全跑；无单场景开关（见文件头）
  const results = [];
  const mutants = [];
  const tmpDirs = [];

  let realBundle = null;
  try {
    realBundle = await ensureBundle();
    tmpDirs.push(dirname(realBundle));
  } catch (e) {
    console.error(`❌ ${e.message}`);
    return 2;
  }

  try {
    if (want.includes('leak')) results.push(await runLeak(leakCfg, realBundle));
    if (want.includes('ok')) {
      results.push(
        await runOk(
          {
            ...baseCfg,
            validToken: TOKEN_OLD,
            okDelay: () => TIMING.okAll,
            badDelay: () => TIMING.okAll,
          },
          realBundle,
        ),
      );
    }

    // ⚠️ 必报（变异）样本**只在真源码本身达标时才需要**：真源码已经在踩踏 ⇒ 结论明确，
    //    此时再造变异体必然失败（开关已不在源码里 ⇒ 变异针找不到），反而会盖掉真正的结论。
    const realLeak = results.find((r) => r.scenario === 'leak');
    const realClean = !realLeak || (realLeak.bad.length === 0 && realLeak.noSample.length === 0);
    if (!realClean) {
      line('');
      line('（真源码已不达标 ⇒ 跳过必报变异样本：结论已经明确，判据显然有牙齿）');
    }

    if (realClean) {
      // 必报 A：页面侧开关关闭（≡ 修复前：旁路照样裸调）
      const mutDir = mkdtempSync(join(tmpdir(), 'abox-mp-mut-'));
      tmpDirs.push(mutDir);
      const nPage = writeMutant(PAGE, MUT_PAGE, join(mutDir, 'page-mutant.vue'));
      globalThis.__MUT_PAGE = false;
      const bundleA = await ensureBundle({ page: join(mutDir, 'page-mutant.vue') });
      tmpDirs.push(dirname(bundleA));
      mutants.push({
        name: `必报 A · 页面侧 \`keepAuthState\` 关闭（${nPage} 处）`,
        r: await runLeak(leakCfg, bundleA),
        sentinel: () => globalThis.__MUT_PAGE === true,
      });

      // 必报 B：请求层守卫摘除（≡ 无条件清态）
      const nReq = writeMutant(REQUEST_TS, MUT_REQ, join(mutDir, 'request-mutant.ts'));
      globalThis.__MUT_REQ = false;
      const bundleB = await ensureBundle({
        override: { [REQUEST_TS]: join(mutDir, 'request-mutant.ts') },
      });
      tmpDirs.push(dirname(bundleB));
      mutants.push({
        name: `必报 B · 请求层守卫摘除（${nReq} 处）`,
        r: await runLeak(leakCfg, bundleB),
        sentinel: () => globalThis.__MUT_REQ === true,
      });
    }
  } catch (e) {
    console.error(`❌ 场景执行失败（判据未真正跑完）：${e.message}`);
    return 1;
  } finally {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响判据，忽略 */
      }
    }
  }

  let bad_ = 0;
  for (const r of results) {
    line('');
    line(`═══ scenario=${r.scenario} ═══`);
    line(`  ${r.desc}`);
    for (const [k, v] of Object.entries(r.samples)) line(`    ${k}: ${v}`);
    if (r.bad.length) {
      bad_ += r.bad.length;
      for (const b of r.bad) line(`    ❌ ${b}`);
      // 失败时把事件流水全量打出：定位只看结论是没法复现的
      line('    事件流水（→发出 / ←响应[携带token] / TOKEN 读写）：');
      for (const e of timelineOf(r.sink)) line(`      ${e}`);
    } else {
      line('    ✅ 三条不变量全部满足');
    }
    if (r.noSample.length) {
      bad_ += r.noSample.length;
      line('');
      line(`    ❌ instrumentation broken：样本为 0，判据并未真正执行：${r.noSample.join(' / ')}`);
      line('       —— 这种情况一律按未达标处理，不许给 pass');
    }
  }

  // 必报（变异）样本：**必须被报出踩踏**，报不出 = 判据没有牙齿 = 检查器不可用
  for (const m of mutants) {
    line('');
    line(`═══ ${m.name} ═══`);
    line(`  踩踏式清态: ${m.r.staleN} 次（必须 ≥1 —— 报不出说明判据抓不到回归）`);
    if (m.r.staleN < 1) {
      bad_ += 1;
      line('    ❌ 必报样本**没有**被报出 —— 判据已失效（不许记通过）');
      line('    事件流水（→发出 / ←响应[携带token] / TOKEN 读写）：');
      for (const e of timelineOf(m.r.sink)) line(`      ${e}`);
    } else {
      line('    ✅ 判据有牙齿（回归会被抓住）');
    }
    // ⭐ 哨兵：变异体必须**真的被执行**（防「变异打进注释 / 打进没被采纳的那份模块」）
    if (!m.sentinel()) {
      bad_ += 1;
      line('    ❌ 变异体从未被执行（哨兵未触发）—— 上面的「必报通过」不作数');
    }
  }

  line('');
  line(`${bad_ === 0 ? '✅ 全部通过' : `❌ 共 ${bad_} 项未达标`}`);
  return bad_ === 0 ? 0 : 1;
}

process.exit(await main());

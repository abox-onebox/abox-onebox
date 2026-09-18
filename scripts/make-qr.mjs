#!/usr/bin/env node
/**
 * ABox 一盒 · 人工测试入口卡生成器（二维码 + 后台链接）
 *
 * 目的：把「本机局域网 IP 是多少、用户端在哪个端口、后台怎么进、用哪个账号」
 * 这几件每次开测都要口头交代一遍的事，固化成一页**可打印、可转发**的卡片。
 *
 * 用法：
 *   node scripts/make-qr.mjs                     # 自动探测本机 IP，按默认端口生成
 *   node scripts/make-qr.mjs --ip=192.168.1.7    # 手动指定 IP（自动探测挑错网卡时用）
 *   node scripts/make-qr.mjs --h5-port=5181 --admin-port=5175 --api-port=3100
 *   node scripts/make-qr.mjs --out=D:/tmp/入口卡.html
 *   node scripts/make-qr.mjs --no-png            # 只出 HTML，不出 PNG
 *   node scripts/make-qr.mjs --no-verify         # 跳过「反解校验」（默认会做，见 verifyPng）
 *
 * 生成完会**把 PNG 再解码回来核对一遍**：确认码里编的确实是对应 URL。
 * 二维码编错了肉眼看不出来，靠这一步兜住「端口/IP 拼错」这类静默错误。
 *
 * 产出（默认落到**工作区根**，即仓库的上一级，与《内部测试操作清单》同处）：
 *   _ABox一盒人工测试入口卡v1.0.html        —— 主交付物（二维码是内联 SVG，**离线也显示**）
 *   _ABox一盒人工测试入口卡v1.0_二维码/     —— 每张二维码的 PNG（转发到群里用）
 *
 * ⚠️ 文件名**刻意带 `_` 前缀**：这张卡是「某一时刻该网络下」的快照、**内容易变**，
 *    故不进《开发基线冻结清单》（否则重生成一次就飘红一次）。详见 CARD_NAME 处说明。
 *
 * ⚠️ **IP 是会变的**（换 WiFi、换网线、路由器重新分配都会变）。这张卡是「某一时刻
 *    该网络下」的快照，不是长期文档 —— 换网络后**重新跑一次本脚本**即可，
 *    不要手改 HTML 里的地址（SVG 里的二维码改不动，会变成"文字和码不一致"）。
 *
 * ⚠️ 端口默认值**必须与 `scripts/local-test.mjs` 保持一致**（h5=5180 / admin=5173 /
 *    api=3000）。那张卡上的地址能不能打开，完全取决于环境是不是按同一组端口起的；
 *    两边漂移就会出现「卡上的码扫不开」而没人知道为什么。
 *
 * ⚠️ 这里的 5180 / 5173 是**页面**端口。页面把 `/api` 反代到 127.0.0.1:3000（同源），
 *    所以**手机不需要直连 3000**，二维码也就**只编页面地址**。把 `http://ip:3000/...`
 *    编进码给手机扫，换网络必挂 —— 这是刻意避免的写法。
 */

import { networkInterfaces } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ESM 不认 NODE_PATH —— 从仓库根解析依赖（`qrcode` 已在根 node_modules）
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const QRCode = require('qrcode');

/** 工作区根 = 仓库的上一级。交付物（操作清单、入口卡）都落这里，不进 git。 */
const WS = resolve(ROOT, '..');

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
const wantPng = !opt('no-png', false);
/** 是否对生成的 PNG 做**反解校验**（默认开；见 verifyPng() 说明） */
const wantVerify = !opt('no-verify', false);

for (const [k, p] of [
  ['api-port', apiPort],
  ['h5-port', h5Port],
  ['admin-port', adminPort],
]) {
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    console.error(`✖ --${k}=${p} 不是合法端口（1–65535）。`);
    process.exit(2);
  }
}

/**
 * 局域网 IP：取第一块**非 loopback** 的 IPv4。
 *
 * 与 `local-test.mjs` 同一套逻辑 —— 那台机器上「手机能连的地址」和「卡上印的地址」
 * 必须是同一个，否则测试人照着卡扫、扫出来是 127.0.0.1，报「码是坏的」。
 */
const LAN_IP = (() => {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
})();
const IP = String(opt('ip', LAN_IP));
const NO_LAN = IP === '127.0.0.1';

/**
 * 交付物**刻意用 `_` 前缀**：这张卡每次换网络重新生成，内容是**易变的**
 * （内嵌 IP + 生成时刻），不能进《开发基线冻结清单》——
 * 一进冻结清单，重生成一次哈希就失真一次，清单会常年飘红，
 * 最后所有人都不看它（**「恒红的检查等于没有检查」**）。
 *
 * `_` 前缀是仓库里既有的「生成物 / 不进冻结集」标记（同 `_mf_report.txt`、
 * `_stale-build/`）：`baseline_manifest.py` 的 `scan()` 与
 * `verify-manifest.mjs` 的覆盖性检查**都显式跳过 `_` 开头的名字**，
 * 两边口径一致，不留「待归类」噪声。
 */
const CARD_NAME = '_ABox一盒人工测试入口卡v1.0.html';
const OUT_HTML = String(opt('out', join(WS, CARD_NAME)));
const PNG_DIR = join(dirname(OUT_HTML), '_ABox一盒人工测试入口卡v1.0_二维码');

// ---------------------------------------------------------------------------
// 入口清单（**只编页面地址**，不编 API 直连地址 —— 理由见文件头）
// ---------------------------------------------------------------------------

const base = (p) => `http://${IP}:${p}/`;

const ENTRIES = [
  {
    key: 'h5',
    file: 'h5-user.png',
    label: '用户端 / 团长端',
    url: base(h5Port),
    device: '手机',
    size: 268,
    // 「4 角色 · 3 载体」里的用户与团长**共用同一个小程序身份**（isLeader 切换）
    desc: '扫码进手机端。登录框填分给自己的身份（见下方 dev:100x），<b>不需要真实微信</b>。',
  },
  {
    key: 'admin',
    file: 'admin-console.png',
    label: '运营后台 · 供应商后台',
    url: base(adminPort),
    device: '电脑',
    size: 190,
    desc: '运营与供应商<b>同一个网址</b>，靠账号分角色。用电脑浏览器打开（也可扫码复制到电脑）。',
  },
  {
    key: 'docs',
    file: 'api-docs.png',
    label: '接口文档（工程）',
    url: `http://${IP}:${apiPort}/docs`,
    device: '电脑',
    size: 150,
    desc: '只在排查「接口到底收什么、回什么」时用，测试人一般不需要。',
  },
  {
    key: 'health',
    file: 'api-health.png',
    label: '接口健康检查（工程）',
    url: `http://${IP}:${apiPort}/api/v1/health`,
    device: '电脑',
    size: 150,
    desc: '页面打不开时<b>先开这个</b>：能返回内容 = 后端活着，问题在页面；也打不开 = 环境没起。',
  },
];

// ---------------------------------------------------------------------------
// 生成二维码
// ---------------------------------------------------------------------------

/** 内联 SVG 二维码：**不引外部资源**，断网、离线打开、打印都照样显示 */
async function svgOf(text, px) {
  const svg = await QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'Q', // 对着屏幕扫、有反光，容错用 Q 而不是默认 M
    margin: 2,
    width: px,
  });
  assertSvgWellFormed(svg);
  return svg;
}

/**
 * 结构自检：确认二维码 SVG 的开标签**没有重复属性**
 *
 * ⚠️ 这条是因为**真踩过**才加的：`qrcode` 自己就会输出 `width`/`height`，
 * 我原先又 `.replace('<svg ', ...)` 补了一对 → 变成
 * `<svg width="268" height="268" xmlns=… width="268" height="268" viewBox=…>`。
 * 浏览器取第一个、**照样画得出来**，所以肉眼与「能扫」都发现不了，
 * 只是文档结构不合法（校验器会报 duplicate attribute）。
 * ⭐ 判据：**「渲染正常」不等于「结构正确」** —— 能省一次「为什么校验器说我的 HTML 有问题」。
 */
function assertSvgWellFormed(svg) {
  const head = svg.slice(0, svg.indexOf('>') + 1);
  if (!head.startsWith('<svg ') || !head.includes('viewBox=')) {
    console.error(`  ✖ 二维码 SVG 结构异常（缺 viewBox 或不是 svg 开标签）：${head.slice(0, 90)}`);
    process.exit(1);
  }
  const names = [...head.matchAll(/([a-zA-Z-]+)=/g)].map((m) => m[1]);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) {
    console.error(`  ✖ 二维码 SVG 开标签有重复属性：${[...new Set(dup)].join(', ')}`);
    console.error(`      ${head.slice(0, 140)}`);
    process.exit(1);
  }
}

/**
 * 反解校验：把刚生成的 PNG **再解码回来**，确认码里编的确实是目标 URL。
 *
 * 为什么值得做：二维码是**画给人扫的**，编错了肉眼完全看不出来 —— 形状都「像二维码」。
 * 一旦生成时把端口写反（比如 h5 与 admin 对调），拿到的是一个**看起来完全正常的坏码**，
 * 而且要到「测试人扫了打不开」才暴露，排查时还会先怀疑网络。
 * **编一遍、解一遍是两条独立代码路径**，能真正兜住这类错误；光「相信库」兜不住。
 *
 * 依赖 `jimp` + `qrcode-reader`（根 node_modules 已有）。装不上就**跳过并明说跳过了** ——
 * 绝不能让「没校验」看起来像「校验通过」。
 */
async function verifyPng(entries) {
  let Jimp;
  let QrCode;
  try {
    Jimp = require('jimp');
    const mod = require('qrcode-reader');
    QrCode = mod.default ?? mod;
  } catch {
    console.log('  ⚠ 反解校验：缺 jimp / qrcode-reader，**已跳过**（不代表校验通过）');
    return;
  }

  for (const e of entries) {
    const img = await Jimp.read(join(PNG_DIR, e.file));
    const got = await new Promise((res, rej) => {
      const qr = new QrCode();
      qr.callback = (err, v) => (err ? rej(err) : res(v.result));
      qr.decode(img.bitmap);
    });
    if (got !== e.url) {
      console.error(`  ✖ 反解不符：${e.file}`);
      console.error(`      应为 ${e.url}`);
      console.error(`      实得 ${got}`);
      process.exit(1);
    }
    console.log(`  ✔ 反解通过 ${e.file.padEnd(18)} → ${got}`);
  }
}

async function main() {
  console.log();
  console.log('ABox 一盒 · 生成人工测试入口卡');
  console.log('─'.repeat(68));
  console.log(`  本机局域网 IP：${IP}${NO_LAN ? '   ⚠️ 未探测到局域网 IP！' : ''}`);
  console.log(`  端口：用户端 ${h5Port} · 后台 ${adminPort} · 接口 ${apiPort}`);
  console.log('─'.repeat(68));

  for (const e of ENTRIES) {
    e.svg = await svgOf(e.url, e.size);
    console.log(`  ✔ ${e.label.padEnd(18)} ${e.url}`);
  }

  if (wantPng) {
    mkdirSync(PNG_DIR, { recursive: true });
    for (const e of ENTRIES) {
      // PNG 给「转发到微信群」用：留足留白，别人在手机上放大也能扫
      await QRCode.toFile(join(PNG_DIR, e.file), e.url, {
        width: 720,
        margin: 3,
        errorCorrectionLevel: 'Q',
      });
    }
    console.log(`  ✔ PNG 已写入 ${PNG_DIR}`);
    if (wantVerify) await verifyPng(ENTRIES);
  } else if (wantVerify) {
    console.log('  ⚠ 反解校验需要 PNG 文件，本轮带了 --no-png，**校验已跳过**（不代表通过）');
  }

  writeFileSync(OUT_HTML, render(), 'utf8');
  console.log(`  ✔ 入口卡已写入 ${OUT_HTML}`);
  console.log('─'.repeat(68));
  if (NO_LAN) {
    console.log('  ⚠️ 没探测到局域网 IP，卡上的地址是 127.0.0.1 —— 手机扫了打不开。');
    console.log('     先连上 WiFi/网线，或用 --ip=192.168.x.x 显式指定后重跑。');
  } else {
    console.log(`  ⚠️ 手机上打不开？先确认：① 手机与电脑在**同一个 WiFi**`);
    console.log('     ② Windows 防火墙放行了 node.exe（控制面板 → 允许应用通过防火墙）');
    console.log('     ③ 本卡生成时的 IP 与当前一致（换过网络就要重跑本脚本）');
  }
  console.log();
}

// ---------------------------------------------------------------------------
// 渲染 HTML（沿用项目米色 #F6F0E5 / 暖棕 #6E5435 / 楷体设计系统）
// ---------------------------------------------------------------------------

function render() {
  const stamp = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const big = ENTRIES.filter((e) => e.key === 'h5' || e.key === 'admin');
  const small = ENTRIES.filter((e) => e.key === 'docs' || e.key === 'health');

  const bigCards = big
    .map(
      (e) => `
    <div class="entry">
      <div class="entry-head">
        <span class="entry-name">${e.label}</span>
        <span class="badge">${e.device}</span>
      </div>
      <div class="qr">${e.svg}</div>
      <div class="url">${e.url}</div>
      <p class="desc">${e.desc}</p>
    </div>`,
    )
    .join('');

  const smallRows = small
    .map(
      (e) => `
        <tr>
          <td class="qr-cell">${e.svg}</td>
          <td>
            <b>${e.label}</b><br>
            <span class="url small">${e.url}</span>
            <p class="desc">${e.desc}</p>
          </td>
        </tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ABox 一盒 · 人工测试入口卡 v1.0</title>
<style>
  :root {
    --bg-cream: #F6F0E5;
    --bg-cream-light: #FBF7EF;
    --bg-cream-dark: #EDE3D0;
    --text-brown: #6E5435;
    --text-brown-light: #A08A6A;
    --accent-gold: #C9A876;
    --accent-gold-dark: #9A7B4F;
    --border-brown: #E6D9C0;
    --hero-a: #6E5435;
    --hero-b: #9A7B4F;
    --ok: #5B7C3A;
    --warn-bg: #FBF3E6;
    --warn-border: #E3C79A;
    --warn-accent: #B8862F;
    --warn-text: #8A6318;
    --font-kai: "KaiTi", "STKaiti", "楷体", "Kaiti SC", serif;
    --mono: "Consolas", "Menlo", "Courier New", monospace;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--font-kai);
    background: var(--bg-cream);
    color: var(--text-brown);
    line-height: 1.7;
    font-size: 14px;
    padding: 0 0 40px;
  }
  .sheet { max-width: 820px; margin: 0 auto; background: #fff; box-shadow: 0 2px 18px rgba(110,84,53,.10); }
  .wrap { padding: 0 30px 26px; }

  .hero { background: linear-gradient(135deg, var(--hero-a) 0%, var(--hero-b) 100%); color: var(--bg-cream); padding: 26px 30px 20px; }
  .hero .brand { font-size: 12px; letter-spacing: 4px; opacity: .82; }
  .hero h1 { font-size: 25px; letter-spacing: 2px; font-weight: bold; margin-top: 6px; }
  .hero .sub { font-size: 12.5px; opacity: .9; margin-top: 8px; }
  .hero .meta { margin-top: 14px; display: flex; gap: 26px; flex-wrap: wrap; font-size: 12px; opacity: .92; }
  .hero .meta b { font-family: var(--mono); font-weight: normal; letter-spacing: .4px; }

  h2 { font-size: 15px; letter-spacing: 1.5px; margin: 24px 0 12px; padding-left: 10px; border-left: 3px solid var(--accent-gold); }
  .note { font-size: 12.5px; color: var(--text-brown-light); margin-top: 8px; }

  /* ── 大码区（手机扫） ── */
  .entries { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .entry { border: 1px solid var(--border-brown); border-radius: 10px; background: var(--bg-cream-light); padding: 16px 16px 14px; text-align: center; }
  .entry-head { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 12px; }
  .entry-name { font-size: 15px; font-weight: bold; letter-spacing: .5px; }
  .badge { font-size: 11px; background: var(--text-brown); color: var(--bg-cream); border-radius: 20px; padding: 1px 9px; letter-spacing: .5px; }
  .qr { display: flex; justify-content: center; align-items: center; background: #fff; border: 1px solid var(--border-brown); border-radius: 8px; padding: 8px; }
  .qr svg { display: block; }
  .url { font-family: var(--mono); font-size: 13px; color: var(--accent-gold-dark); font-weight: bold; margin-top: 11px; word-break: break-all; }
  .url.small { font-size: 12px; font-weight: normal; }
  .desc { font-size: 12px; color: var(--text-brown-light); margin-top: 7px; text-align: left; line-height: 1.62; }

  /* ── 小码区（工程入口） ── */
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { border: 1px solid var(--border-brown); padding: 8px 10px; text-align: left; vertical-align: middle; }
  th { background: var(--bg-cream-dark); font-weight: bold; letter-spacing: .5px; }
  td.qr-cell { width: 168px; text-align: center; background: #fff; padding: 6px; }
  td.qr-cell svg { display: block; margin: 0 auto; }

  /* ── 身份表 ── */
  table.ids td, table.ids th { text-align: left; }
  table.ids td.code { font-family: var(--mono); color: var(--accent-gold-dark); font-weight: bold; white-space: nowrap; width: 108px; }
  table.ids td.pw { font-family: var(--mono); color: var(--accent-gold-dark); white-space: nowrap; width: 210px; }

  .steps { counter-reset: s; list-style: none; font-size: 13px; }
  .steps li { counter-increment: s; position: relative; padding-left: 26px; margin-bottom: 8px; }
  .steps li::before { content: counter(s); position: absolute; left: 0; top: 3px; width: 18px; height: 18px; line-height: 18px; text-align: center; background: var(--accent-gold); color: #fff; border-radius: 50%; font-size: 11px; }
  .cmd { display: block; margin-top: 6px; font-family: var(--mono); font-size: 11.5px; color: var(--accent-gold-dark); background: rgba(201,168,118,.14); padding: 6px 9px; border-radius: 4px; line-height: 1.65; word-break: break-all; }

  .warn { background: var(--warn-bg); border: 1px solid var(--warn-border); border-left: 3px solid var(--warn-accent); border-radius: 6px; padding: 11px 14px; font-size: 12.5px; margin-top: 12px; }
  .warn .t { font-weight: bold; color: var(--warn-text); letter-spacing: .5px; }
  .warn ul { margin: 6px 0 0 16px; }
  .warn li { margin-bottom: 4px; }
  .tip { background: #F1F5E9; border: 1px solid #CFDCBB; border-left: 3px solid var(--ok); border-radius: 6px; padding: 11px 14px; font-size: 12.5px; margin-top: 12px; }
  .tip .t { font-weight: bold; color: var(--ok); letter-spacing: .5px; }
  .tip ul { margin: 6px 0 0 16px; }
  .tip li { margin-bottom: 4px; }

  .foot { margin-top: 24px; padding-top: 12px; border-top: 1px dashed var(--border-brown); font-size: 11.5px; color: var(--text-brown-light); display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }

  /* ── 打印：A4 单页优先，二维码块不许被切开 ── */
  @page { size: A4; margin: 12mm; }
  @media print {
    body { background: #fff; font-size: 12px; }
    .sheet { box-shadow: none; max-width: none; }
    .hero { padding: 18px 22px 14px; }
    .hero h1 { font-size: 21px; }
    .wrap { padding: 0 22px 16px; }
    .entry, table, tr, .warn, .tip { page-break-inside: avoid; break-inside: avoid; }
    h2 { page-break-after: avoid; break-after: avoid; }
    .foot { display: none; }
  }
</style>
</head>
<body>
<div class="sheet">

  <div class="hero">
    <div class="brand">A B O X · 一 盒</div>
    <h1>人工测试入口卡</h1>
    <div class="sub">手机扫码测用户端·团长端；电脑开运营后台·供应商后台。配套《内部测试操作清单 v1.0》使用。</div>
    <div class="meta">
      <span>环境地址（本机 IP）：<b>${IP}</b></span>
      <span>生成时间：<b>${stamp}</b></span>
      <span>端口：<b>${h5Port}</b> 用户端 · <b>${adminPort}</b> 后台 · <b>${apiPort}</b> 接口</span>
    </div>
  </div>

  <div class="wrap">

    ${
      NO_LAN
        ? `<div class="warn">
      <div class="t">⚠️ 没探测到局域网 IP，本卡当前不可用于手机扫描</div>
      <ul>
        <li>本机只找到 <b>127.0.0.1</b>（回环地址）。<b>手机连不到回环地址</b>，扫了只会「无法打开网页」。</li>
        <li>先接上 WiFi 或网线，再重新生成：<span class="cmd">node scripts/make-qr.mjs</span></li>
        <li>确有多张网卡、探测挑错了：<span class="cmd">node scripts/make-qr.mjs --ip=192.168.x.x</span></li>
      </ul>
    </div>`
        : ''
    }

    <h2>一、手机扫码即用（需与电脑同一个 WiFi）</h2>
    <div class="entries">${bigCards}</div>
    <div class="tip">
      <div class="t">用户端与团长端是同一个入口</div>
      <ul>
        <li>同一个小程序身份，登录后按身份显示团长视图 —— <b>不需要装微信、不需要真实微信登录</b>。</li>
        <li><b>一人一个身份</b>：同一身份在同一天只能下一单（设计如此）。两人共用 <b>dev:1001</b>，第二个人必被拦，然后被误记成 bug。</li>
      </ul>
    </div>

    <h2>二、工程入口（页面打不开时先看这里）</h2>
    <table>
      <tr><th style="width:168px">二维码</th><th>地址与用途</th></tr>${smallRows}
    </table>

    <h2>三、测试账号</h2>
    <table class="ids">
      <tr><th>入口</th><th>账号 / 身份</th><th>说明</th></tr>
      <tr>
        <td>用户端<br>团长端</td>
        <td class="code">dev:1001</td>
        <td>李明 · 首席团长 12% —— <b>标杆账号</b>，建议留给最细的那个测试人</td>
      </tr>
      <tr>
        <td>用户端<br>团长端</td>
        <td class="code">dev:1002<br>dev:1003<br>dev:1004<br>dev:1005</td>
        <td>王芳 · 金牌 10%　张磊 · 正式 9%<br>赵静 · 正式 9%　陈强 · 见习 8%<br>多人同时测就按这个顺序一人领一个</td>
      </tr>
      <tr>
        <td>用户端</td>
        <td class="code">dev:newbie</td>
        <td>任意没见过的 code 都算新用户：<b>拿不到团是设计</b>（未绑楼栋），不是故障</td>
      </tr>
      <tr>
        <td>运营后台</td>
        <td class="pw">admin / admin123</td>
        <td>超级管理员，全部菜单可见</td>
      </tr>
      <tr>
        <td>运营后台</td>
        <td class="pw">finance / finance123</td>
        <td>财务角色 —— 用来对照「菜单有没有按角色收窄」</td>
      </tr>
      <tr>
        <td>供应商后台</td>
        <td class="pw">sanweiwu / supplier123</td>
        <td>三味屋 · 供应商。<b>与运营同一个网址</b>，靠这个账号切成供应商视图</td>
      </tr>
    </table>

    <h2>四、开测前：把环境起起来</h2>
    <ol class="steps">
      <li>在项目目录执行（<b>这一步会重置成一整套干净的演示数据</b>）：
        <span class="cmd">node scripts/local-test.mjs --seed --build</span>
      </li>
      <li>等终端打印出地址、二维码与账号，<b>保持这个窗口开着别关</b>（关掉＝服务停止）。</li>
      <li>手机连上<b>与电脑同一个 WiFi</b>，扫上面的码；电脑浏览器打开后台地址。</li>
      <li>先自查一遍：把 <b>接口健康检查</b>那个地址在电脑上打开，有内容返回就说明后端活着。</li>
      <li>收工：在这个窗口按 <b>Ctrl+C</b>，本次启动的服务会一并停止。</li>
    </ol>

    <div class="tip">
      <div class="t">库里预置了 34 单模拟数据，这是<b>故意的</b></div>
      <ul>
        <li>覆盖订单 11 种状态、退款四态、提现五态、配送四态，<b>含「今天」</b> —— 所以后台各页打开就有内容，不是空表。</li>
        <li>这些单属于<b>另一批演示专用账号</b>（昵称以「演示·」开头）。你在用户端「我的订单」里<b>看不到</b>，<b>这是正常的</b>，后台各页能看到。</li>
        <li>模拟订单全落在<b>今天及更早</b>，<b>没有占用「明日」</b> —— 所以你自己下单不会被挡。</li>
      </ul>
    </div>

    <h2>五、打不开 / 扫不开 怎么排</h2>
    <div class="warn">
      <div class="t">按顺序排除，别急着记缺陷</div>
      <ul>
        <li><b>手机提示「无法打开网页」</b>：九成是 <b>Windows 防火墙拦了 node.exe</b> —— 控制面板 → Windows Defender 防火墙 → 允许应用通过防火墙 → 勾上 node.exe（专用网络）。</li>
        <li><b>电脑上能开、手机不能</b>：多半是<b>手机没连同一个 WiFi</b>，或连的是 5G 访客网络（与电脑不同网段）。</li>
        <li><b>昨天能开、今天不能</b>：<b>本机 IP 变了</b>。重新跑一次生成脚本，卡上的地址与二维码会一起刷新。</li>
        <li><b>后台登录提示「请求过于频繁」</b>：同账号 1 分钟内<b>失败</b>登录 5 次触发限流（与生产一致）。等 1 分钟自动恢复 —— <b>属预期行为</b>。</li>
        <li><b>页面全白 / 转圈</b>：先开「接口健康检查」。它通 → 问题在页面或数据；它也不通 → 环境没起来，重跑第四节的命令。</li>
        <li><b>支付</b>走 Mock 通道：<b>会自动回调成功</b>，但<b>不产生真实资金流</b>。</li>
      </ul>
    </div>

    <div class="foot">
      <span>本卡由 <b>node scripts/make-qr.mjs</b> 生成 —— 换网络后重跑一次即可，请勿手改地址</span>
      <span>ABox 一盒 · 北京巡礼之年科技有限公司</span>
    </div>

  </div>
</div>
</body>
</html>
`;
}

main().catch((e) => {
  console.error('✖ 生成失败：', e?.message ?? e);
  process.exit(1);
});

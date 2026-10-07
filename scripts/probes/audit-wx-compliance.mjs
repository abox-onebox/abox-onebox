/**
 * 微信小程序合规审计探针（2026-10-04）
 *
 * 起因：昨天判定「小程序内跳转美团/京东/淘宝」撞《运营规范》5.10 互推（处理=下架），
 *      并已把小程序端的跳转按钮与复制口令删掉。但**删前端 ≠ 服务端不再下发** ——
 *      只要接口还在返回链接、还在生成引导文案，审核员抓一次包就全看见了。
 *
 * 所以这一轮**只信实测响应**，不信代码注释：
 *   H1 溯源页（/traceability/today，**免登录**）的出参里还有没有第三方平台痕迹
 *   H2 资质墙（/traceability/suppliers）干不干净
 *   H3 客服页（/support/contact）有没有外部域名资源（小程序 image 需 downloadFile 白名单）
 *
 * 判据一律从真实响应取值再断言。
 *
 * 用法：node scripts/probes/audit-wx-compliance.mjs
 */
// ── 收编注入（2026-10-07）：以下路径**相对本文件推导**，换机器无需改一行 ──────────
import { fileURLToPath as __aboxFup } from 'node:url';
const __aboxU = (p) => __aboxFup(new URL(p, import.meta.url)).replace(/[\/]+$/, '');

import { spawnSync } from 'node:child_process';

const ROOT = __aboxU('../..');
const NODE = process.execPath;
const PF = process.env.ABOX_PIPEFIX ?? ''; // 本机专用 child_process 垫片（**不在仓库内**，它自述「勿入仓库」）；设 `ABOX_PIPEFIX=<路径>` 才启用

const { BASE, startApiServer, waitHealthy, stopApiServer } = await import(
  `file:///${ROOT}/scripts/lib/e2e-server.mjs`
);

let pass = 0;
let fail = 0;
const fails = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ' :: ' + detail : ''}`);
  } else {
    fail++;
    fails.push(name);
    console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

function tomorrowBj() {
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  return new Date(bj.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 第三方平台痕迹：命中即 5.10 互推（处理=下架） */
const PLATFORM_MARKS = ['美团', '京东', '淘宝', '拼多多', '饿了么', 'meituan', 'taobao', 'jd'];
/** 引导去站外的动词：即使没点名平台，"点进店铺""点他们的外卖"同样是互推 */
const OUTBOUND_HINTS = ['外卖', '点他们的', '下方店铺', '跳转'];

function hits(text, marks) {
  return marks.filter((m) => text.includes(m));
}

async function main() {
  console.log('重置种子…');
  const seed = spawnSync(NODE, ['scripts/gate.mjs', 'seed'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PIPEFIX_QUIET: '1', NODE_OPTIONS: PF ? `--require ${PF}` : (process.env.NODE_OPTIONS ?? '') },
  });
  if (seed.status !== 0) {
    console.error('seed 失败 exit=' + seed.status);
    process.exit(2);
  }

  console.log('起服务…');
  const child = startApiServer();
  const healthy = await waitHealthy(BASE, { child, timeoutMs: 120000 });
  if (!healthy) {
    console.error('服务未就绪');
    process.exit(2);
  }
  console.log(`服务就绪 ${BASE}\n`);

  const mealDate = tomorrowBj();
  const login = await call('POST', '/auth/login', { body: { code: 'dev:1' } });
  const token = login.body?.data?.token;
  ok('H0 登录取 token', !!token, token ? 'ok' : JSON.stringify(login.body).slice(0, 160));
  if (token) await call('PUT', '/me/building', { token, body: { buildingId: 1 } });

  // -------------------------------------------------------------------------
  // H1 · 溯源页 —— 免登录，审核员最容易抓到的一处
  // -------------------------------------------------------------------------
  console.log('\n[H1] /traceability/today（免登录 · U5 溯源页）');
  const today = await call('GET', `/traceability/today?buildingId=1&mealDate=${mealDate}`);
  const td = today.body?.data;
  console.log(`        code=${today.body?.code} dishes=${td?.dishes?.length ?? 0}`);
  const todayDump = JSON.stringify(td ?? {});

  const note = String(td?.traceNote ?? '');
  console.log(`        traceNote 原文：${note || '（空）'}`);

  const notePlatform = hits(note, PLATFORM_MARKS);
  ok(
    'H1-1 溯源页文案不点名任何第三方平台',
    notePlatform.length === 0,
    notePlatform.length ? `命中：${notePlatform.join(',')}` : '干净',
  );

  const noteOutbound = hits(note, OUTBOUND_HINTS);
  ok(
    'H1-2 溯源页文案不含「点进店铺 / 点他们外卖」这类站外引导',
    noteOutbound.length === 0,
    noteOutbound.length ? `命中：${noteOutbound.join(',')}` : '干净',
  );

  const dumpPlatform = hits(todayDump, PLATFORM_MARKS);
  ok(
    'H1-3 整个响应不出现第三方平台名（含 URL 里的域名）',
    dumpPlatform.length === 0,
    dumpPlatform.length ? `命中：${dumpPlatform.join(',')}` : '干净',
  );

  const hasTakeoutKey = todayDump.includes('takeoutLinks');
  ok('H1-4 响应不下发 takeoutLinks 字段', !hasTakeoutKey, hasTakeoutKey ? '仍在下发' : '已移除');

  const urls = (td?.dishes ?? []).flatMap((d) =>
    (d?.supplier?.takeoutLinks ?? []).map((l) => l?.url).filter(Boolean),
  );
  ok(
    'H1-5 响应不含任何第三方平台 URL',
    urls.length === 0,
    urls.length ? `共 ${urls.length} 条，例：${String(urls[0]).slice(0, 60)}` : '无',
  );

  // -------------------------------------------------------------------------
  // H2 · 资质墙（昨天新做的替代品，必须确认它自己干净）
  // -------------------------------------------------------------------------
  console.log('\n[H2] /traceability/suppliers（免登录 · 资质墙）');
  const list = await call('GET', '/traceability/suppliers');
  const listDump = JSON.stringify(list.body?.data ?? {});
  const lp = hits(listDump, PLATFORM_MARKS);
  ok(
    'H2-1 资质墙列表不含第三方平台名',
    lp.length === 0,
    lp.length ? `命中：${lp.join(',')}` : `serving=${list.body?.data?.serving?.length ?? 0}`,
  );
  ok(
    'H2-2 资质墙列表不含 takeoutLinks',
    !listDump.includes('takeoutLinks'),
    listDump.includes('takeoutLinks') ? '仍在下发' : '已移除',
  );

  const sid = list.body?.data?.serving?.[0]?.id ?? list.body?.data?.inactive?.[0]?.id;
  if (sid != null) {
    const one = await call('GET', `/traceability/suppliers/${sid}`);
    const dd = JSON.stringify(one.body?.data ?? {});
    const dp = hits(dd, PLATFORM_MARKS);
    ok('H2-3 资质墙详情不含第三方平台名', dp.length === 0, dp.length ? `命中：${dp.join(',')}` : '干净');
    ok(
      'H2-4 资质墙详情不含内部字段（联系人 / 银行 / 商户号 / 分账比例）',
      !['contactPhone', 'bankAccount', 'wxSubMchId', 'shareRate', 'auditRemark'].some((k) => dd.includes(k)),
      '干净',
    );
  } else {
    console.log('        （无供应商样本，H2-3/H2-4 跳过）');
  }

  // -------------------------------------------------------------------------
  // H3 · 客服页 —— 小程序 image 加载外部图需 downloadFile 白名单
  // -------------------------------------------------------------------------
  console.log('\n[H3] /me/support（客服页 · 真实路径，非 /support/contact）');
  const ct = await call('GET', '/me/support', { token });
  const cd = ct.body?.data ?? {};
  const qr = String(cd?.wechatQrcodeUrl ?? '');
  console.log(`        wechatId=${String(cd?.wechatId ?? '').slice(0, 24)} qr=${qr || '（无）'}`);
  ok(
    'H3-1 客服页可达',
    ct.body?.code === 0,
    `code=${ct.body?.code}`,
  );
  const isRemote = qr.startsWith('http://') || qr.startsWith('https://');
  ok(
    'H3-2 客服二维码不是外部域名（否则小程序 image 加载不出，须配 downloadFile 白名单）',
    !isRemote,
    isRemote ? `外部地址：${qr.slice(0, 60)}` : qr ? '相对/本地资源' : '未配置二维码',
  );

  // -------------------------------------------------------------------------
  // H4 · 首页：用户端最高频页面，同样不能有站外引导
  // -------------------------------------------------------------------------
  console.log('\n[H4] /home/daily（首页）');
  const home = await call('GET', '/home/daily', { token });
  const hd = JSON.stringify(home.body?.data ?? {});
  const hp = hits(hd, PLATFORM_MARKS);
  ok('H4-1 首页响应不含第三方平台名', hp.length === 0, hp.length ? `命中：${hp.join(',')}` : '干净');

  // -------------------------------------------------------------------------
  // H5 · 分享物料与订阅消息 —— 两个最容易踩「诱导」红线的地方
  // -------------------------------------------------------------------------
  console.log('\n[H5] 分享物料 / 订阅消息');
  // ⚠️ 必须先有团长身份：dev:1 默认不是团长，`/leader/share` 会返回空物料 ——
  //    那时「不含收益诱导」是**零样本的假绿**（等于没测）。先申请上岗再取。
  const apply = await call('POST', '/leader/apply', {
    token,
    body: {
      buildingId: 1,
      phone: '13900000001',
      realName: '合规审计 · 测试团长',
      floor: '12F',
      agreementVersion: 'v1.0',
    },
  });
  console.log(`        apply code=${apply.body?.code} ${apply.body?.message ?? ''}`);
  const shr = await call('GET', '/leader/share', { token });
  const sm = shr.body?.data ?? {};
  const shrText = `${sm.title ?? ''}${sm.desc ?? ''}`;
  ok(
    'H5-0 分享物料取得真实样本（不是零样本假绿）',
    !!sm.title && !!sm.desc,
    sm.title ? `title 有值` : `空样本：${JSON.stringify(shr.body).slice(0, 120)}`,
  );
  console.log(`        title=${String(sm.title ?? '').slice(0, 40)}`);
  console.log(`        desc =${String(sm.desc ?? '').slice(0, 60)}`);
  // 收益诱导表述（提审红线）：分享物料里出现「赚/佣金/返利/零花钱」即视为诱导分享
  const gainMarks = ['赚钱', '赚', '零花钱', '佣金', '返利', '收益', '躺赚'];
  const gm = hits(shrText, gainMarks);
  ok(
    'H5-1 分享文案不含收益诱导表述',
    gm.length === 0,
    gm.length ? `命中：${gm.join(',')}` : '干净',
  );

  const sub = await call('GET', '/me/subscribe/templates', { token });
  const tmpl = sub.body?.data ?? {};
  const tArr = Array.isArray(tmpl) ? tmpl : tmpl?.templates ?? [];
  console.log(`        订阅模板数=${tArr.length}`);
  ok(
    'H5-2 订阅消息模板数量在合理范围（一次性 ≤3 条，多了属滥用）',
    tArr.length <= 3,
    `${tArr.length} 条`,
  );

  console.log(`\n合计：通过 ${pass} · 失败 ${fail}`);
  if (fails.length) console.log(`失败项：${fails.join(' | ')}`);

  await stopApiServer(child);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('探针异常：', e);
  process.exit(2);
});

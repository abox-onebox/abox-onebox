/**
 * 第四支深度探针：U17 在线客服三档（`csMode`）的服务端契约
 *
 * 为什么单独一支：这次改的是「端上主按钮的行为开关」，而微信客服**在本机没法真唤起**
 * （需要真实小程序环境 + 企微开通）。能在本机证死的只有**服务端契约**这一半：
 * 模式值、两个参数的下发时机、脏值兜底。端上那半只能真机验，不能假装验过了。
 *
 * ⭐⭐ 本探针的核心判据是 **「配一半」**：`cs_corpid` / `cs_url` 填了但 `cs_mode` 没切时，
 * 服务端**必须仍然下发 null**。这一条要是破了，运营会配出一个「看起来齐全、点了没反应」
 * 的按钮 —— 而这类缺陷**本机接口测试看不出来**（响应 200、字段有值），只有真机点才暴露。
 *
 * 用法：node scripts/probes/deep-kf.mjs
 */
// ── 收编注入（2026-10-07）：以下路径**相对本文件推导**，换机器无需改一行 ──────────
import { fileURLToPath as __aboxFup } from 'node:url';
const __aboxU = (p) => __aboxFup(new URL(p, import.meta.url)).replace(/[\/]+$/, '');

import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const ROOT = __aboxU('../..');
const NODE = process.execPath;
const PF = process.env.ABOX_PIPEFIX ?? ''; // 本机专用 child_process 垫片（**不在仓库内**，它自述「勿入仓库」）；设 `ABOX_PIPEFIX=<路径>` 才启用

const { BASE, DB_PATH, startApiServer, waitHealthy, stopApiServer } = await import(
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
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

/** 带重试的写：sqlite 只支持单写者，撞锁是瞬时的 */
function writeDb(sql, params, tries = 8) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    let db = null;
    try {
      db = new DatabaseSync(DB_PATH);
      db.exec('PRAGMA busy_timeout = 8000');
      const r = db.prepare(sql).run(...params);
      db.close();
      return r;
    } catch (e) {
      lastErr = e;
      if (db) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
      const spin = new Date(Date.now() + 120);
      while (Date.now() < spin.getTime()) {
        /* 退避 */
      }
    }
  }
  throw lastErr ?? new Error('writeDb 失败');
}

/** 经后台接口改配置（会同步 invalidate，不必重启服务） */
async function putConfigs(adminToken, items) {
  return call('PUT', '/admin/system/configs', { token: adminToken, body: { items } });
}

async function main() {
  console.log('重置种子…');
  const seed = spawnSync(NODE, ['scripts/gate.mjs', 'seed'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PIPEFIX_QUIET: '1', NODE_OPTIONS: PF ? `--require ${PF}` : (process.env.NODE_OPTIONS ?? '') },
  });
  if (seed.status !== 0) {
    console.error(
      'seed 失败 exit=' + seed.status,
      ((seed.stdout || '') + (seed.stderr || '')).slice(0, 600),
    );
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

  const login = await call('POST', '/auth/login', { body: { code: 'dev:1' } });
  const token = login.body?.data?.token;
  ok('K0 登录取 token', !!token, `code=${login.body?.code}`);
  if (!token) {
    await stopApiServer(child);
    process.exit(2);
  }

  const adm = await call('POST', '/auth/admin-login', {
    body: { username: 'admin', password: 'admin123' },
  });
  const adminToken = adm.body?.data?.token;
  ok('K0b 后台登录取 token', !!adminToken, `code=${adm.body?.code}`);
  if (!adminToken) {
    await stopApiServer(child);
    process.exit(2);
  }

  // ---------------------------------------------------------------- ① 缺省态
  console.log('\n[①] 缺省（`service.cs_mode` 种子值 = none）');
  const s0 = await call('GET', '/me/support', { token });
  const d0 = s0.body?.data ?? {};
  ok('K1 缺省 csMode=none', d0.csMode === 'none', `csMode=${d0.csMode}`);
  ok(
    'K2 缺省两参数一律 null（端上不得看到半成品配置）',
    d0.csCorpId === null && d0.csUrl === null,
    `corpId=${d0.csCorpId} url=${d0.csUrl}`,
  );
  ok(
    'K3 原有五字段未被破坏（wechatId/hours/tips 仍在）',
    !!d0.wechatId && !!d0.hours && !!d0.tips,
    `wechatId=${d0.wechatId} hours=${String(d0.hours).slice(0, 12)}`,
  );

  // ---------------------------------------------------------------- ② 配一半
  console.log('\n[②] 配一半：只填企业 ID 与链接，模式**不切**');
  const half = await putConfigs(adminToken, [
    { key: 'service.cs_corpid', value: 'ww_half_configured' },
    { key: 'service.cs_url', value: 'https://work.weixin.qq.com/kfid/half' },
  ]);
  ok('K4 后台写入成功（确认真写进去了，否则后面是零样本假绿）', half.body?.code === 0, `code=${half.body?.code}`);
  const s1 = await call('GET', '/me/support', { token });
  const d1 = s1.body?.data ?? {};
  ok('K5 模式仍为 none', d1.csMode === 'none', `csMode=${d1.csMode}`);
  ok(
    'K6 ⭐⭐ 配了一半 → 两参数**仍然 null**（这是本探针的核心判据）',
    d1.csCorpId === null && d1.csUrl === null,
    `corpId=${d1.csCorpId} url=${d1.csUrl}`,
  );

  // ---------------------------------------------------------------- ③ 完整切换
  console.log('\n[③] 完整切换：mode=wechat_kf + 两参数齐全');
  const full = await putConfigs(adminToken, [
    { key: 'service.cs_mode', value: 'wechat_kf' },
    { key: 'service.cs_corpid', value: 'ww1234567890abcdef' },
    { key: 'service.cs_url', value: 'https://work.weixin.qq.com/kfid/kfabc' },
  ]);
  ok('K7 三键整批写入成功（原子）', full.body?.code === 0, `code=${full.body?.code} changed=${full.body?.data?.changed?.length}`);
  const s2 = await call('GET', '/me/support', { token });
  const d2 = s2.body?.data ?? {};
  ok('K8 csMode=wechat_kf', d2.csMode === 'wechat_kf', `csMode=${d2.csMode}`);
  ok(
    'K9 两参数被下发（端上据此唤起会话）',
    d2.csCorpId === 'ww1234567890abcdef' && !!d2.csUrl,
    `corpId=${d2.csCorpId} url=${String(d2.csUrl).slice(0, 40)}`,
  );
  ok(
    'K10 切档后兜底通道仍在（wechatId 不消失 —— 唤起失败要用）',
    !!d2.wechatId,
    `wechatId=${d2.wechatId}`,
  );

  // ---------------------------------------------------------------- ④ 空参切档
  console.log('\n[④] 切了档但两参数留空（运营漏填）');
  await putConfigs(adminToken, [
    { key: 'service.cs_corpid', value: '' },
    { key: 'service.cs_url', value: '' },
  ]);
  const s3 = await call('GET', '/me/support', { token });
  const d3 = s3.body?.data ?? {};
  ok('K11 模式仍是 wechat_kf（如实反映运营改了模式）', d3.csMode === 'wechat_kf', `csMode=${d3.csMode}`);
  ok(
    'K12 两参数回 null → 端上 `canOpenKf` 判假 → 走降级而不是点空',
    d3.csCorpId === null && d3.csUrl === null,
    `corpId=${d3.csCorpId} url=${d3.csUrl}`,
  );

  // ---------------------------------------------------------------- ④b contact 档
  console.log('\n[④b] `contact` 档（过渡档）：企微两参数**同样必须**为 null');
  const cMode = await putConfigs(adminToken, [
    { key: 'service.cs_mode', value: 'contact' },
    { key: 'service.cs_corpid', value: 'ww_contact_mode' },
    { key: 'service.cs_url', value: 'https://work.weixin.qq.com/kfid/contact' },
  ]);
  ok('K26 `contact` 是合法枚举值（过渡档要能切过去）', cMode.body?.code === 0, `code=${cMode.body?.code}`);
  const s3b = await call('GET', '/me/support', { token });
  const d3b = s3b.body?.data ?? {};
  ok('K27 csMode 如实下发 contact', d3b.csMode === 'contact', `csMode=${d3b.csMode}`);
  ok(
    'K28 ⭐ contact 档下企微两参数仍 null（该档走原生按钮，端上不该拿到企微参数）',
    d3b.csCorpId === null && d3b.csUrl === null,
    `corpId=${d3b.csCorpId} url=${d3b.csUrl}`,
  );

  // ---------------------------------------------------------------- ⑤ 脏值兜底
  console.log('\n[⑤] 库里出现非三档脏值（手改库 / 导入）');
  writeDb("UPDATE ab_config SET config_value = ? WHERE config_key = ?", ['WECHAT_KF', 'service.cs_mode']);
  // 触发缓存失效：借一次无关键的合法写入（invalidate 在更新流程里同步执行）
  await putConfigs(adminToken, [{ key: 'service.hours', value: '工作日 9:00 – 18:00' }]);
  const s4 = await call('GET', '/me/support', { token });
  const d4 = s4.body?.data ?? {};
  ok(
    'K13 ⭐ 脏值（大写 WECHAT_KF）→ 回落 none，不把陌生值透给端上',
    d4.csMode === 'none',
    `csMode=${d4.csMode}`,
  );
  ok('K14 回落时两参数仍为 null', d4.csCorpId === null && d4.csUrl === null, `corpId=${d4.csCorpId}`);

  writeDb("UPDATE ab_config SET config_value = ? WHERE config_key = ?", ['garbage', 'service.cs_mode']);
  await putConfigs(adminToken, [{ key: 'service.hours', value: '工作日 9:00 – 18:00' }]);
  const s5 = await call('GET', '/me/support', { token });
  ok(
    'K15 任意垃圾值 → 同样回落 none',
    s5.body?.data?.csMode === 'none',
    `csMode=${s5.body?.data?.csMode}`,
  );

  // ---------------------------------------------------------------- ⑥ 写侧校验
  console.log('\n[⑥] 写侧：非法枚举值应被拒（不能靠读侧兜底兜一切）');
  const bad = await putConfigs(adminToken, [{ key: 'service.cs_mode', value: 'wechat_kf_placeholder' }]);
  ok(
    'K16 非法枚举值被拒（不是静默写入）',
    bad.body?.code !== 0,
    `code=${bad.body?.code} msg=${String(bad.body?.message ?? '').slice(0, 60)}`,
  );

  // ---------------------------------------------------------------- ⑦ 配置清单可见性
  console.log('\n[⑦] D57 配置清单里三键可见且已接线');
  const list = await call('GET', '/admin/system/configs', { token: adminToken });
  const flat = JSON.stringify(list.body?.data ?? {});
  const keys = ['service.cs_mode', 'service.cs_corpid', 'service.cs_url'];
  for (const k of keys) {
    ok(`K17-${k} 在配置清单内`, flat.includes(k), flat.includes(k) ? 'ok' : '缺失');
  }

  // ---------------------------------------------------------------- ⑧ 鉴权
  console.log('\n[⑧] 鉴权');
  const noAuth = await call('GET', '/me/support');
  ok('K18 未登录访问 → 401（客服配置不对外）', noAuth.status === 401, `status=${noAuth.status}`);

  // ---------------------------------------------------------------- ⑨ 端上契约（静态 · 防回归）
  /**
   * 为什么本机静态也要查：微信客服**在本机唤不起来**（要真机 + 企微开通），
   * 所以「参数写错层级」这类缺陷**门禁全绿也照样上线** —— 2026-10-04 复查时
   * 实测抓到过一次（`url` 被传在顶层，官方要求放进 `extInfo`，真机必然
   * `fail invalid param: url`，端上只能退回复制微信号）。
   * 静态查不到运行时，但能钉死「改坏了就报警」。
   */
  console.log('\n[⑨] 端上唤起参数形状（静态断言 · 附自证）');
  const { readFileSync } = await import('node:fs');
  const MP = `${ROOT}/apps/miniprogram/src`;
  const comp = readFileSync(`${MP}/composables/use-customer-service.ts`, 'utf8');
  const page = readFileSync(`${MP}/pages/support/contact.vue`, 'utf8');

  /** 抽取 `api({ ... })` 调用块，判断 url 是不是放在 extInfo 里 */
  function kfCallShape(text) {
    const m = text.match(/api\(\{([\s\S]*?)\}\);/);
    const block = m ? m[1] : '';
    const hasExtInfo = /extInfo\s*:\s*\{\s*url\s*:/.test(block);
    const stripped = block.replace(/extInfo\s*:\s*\{\s*url\s*:[^}]*\}/, '');
    const hasTopLevelUrl = /(^|[\s,{])\s*url\s*:/.test(stripped);
    return {
      block,
      hasExtInfo,
      hasTopLevelUrl,
      detail: `block=${block.replace(/\s+/g, ' ').trim().slice(0, 80)}`,
    };
  }

  // 自证：判据本身必须能报出来（否则是恒绿）
  const badSample = `api({\n  corpId: params.corpId,\n  url: params.url,\n  success: () => {},\n});`;
  const goodSample = `api({\n  corpId: params.corpId,\n  extInfo: { url: params.url },\n  success: () => {},\n});`;
  const sb = kfCallShape(badSample);
  const sg = kfCallShape(goodSample);
  ok(
    'K19-自证 缺 extInfo 的样本**必报**（判据不是恒绿）',
    sb.hasExtInfo === false && sb.hasTopLevelUrl === true,
    `extInfo=${sb.hasExtInfo} topUrl=${sb.hasTopLevelUrl}`,
  );
  ok(
    'K19b-自证 正确样本**必不报**（判据不是恒红）',
    sg.hasExtInfo === true && sg.hasTopLevelUrl === false,
    `extInfo=${sg.hasExtInfo} topUrl=${sg.hasTopLevelUrl}`,
  );

  const sc = kfCallShape(comp);
  ok(
    'K20 ⭐ 端上唤起入参带 `extInfo: { url }`（官方唯一示例写法）',
    sc.hasExtInfo,
    sc.detail,
  );
  ok('K21 端上不再有顶层 `url` 参数（防回归）', !sc.hasTopLevelUrl, sc.detail);
  ok(
    'K22 卡片路径保留 `.html` 后缀（社区多年实证：不带会「页面不存在」）',
    /KF_PATH_SUFFIX\s*=\s*'\.html'/.test(comp),
    String((comp.match(/KF_PATH_SUFFIX\s*=\s*'[^']*'/) || ['?'])[0]),
  );
  ok(
    'K23 端上 `canOpenKf` 要求 corpId + url 双全（官方 url 必填，缺一即降级）',
    /csCorpId[\s\S]{0,80}csUrl/.test(page),
    String((page.match(/const canOpenKf[\s\S]{0,160}?\);/) || ['?'])[0]).replace(/\s+/g, ' ').slice(0, 120),
  );
  ok(
    'K24 `contact` 档渲染真实按钮 `open-type="contact"`（该能力 JS 调不起来）',
    page.includes('open-type="contact"'),
    page.includes('open-type="contact"') ? 'ok' : '缺失',
  );
  /**
   * ⭐ 只数**代码区**：`page` 全文里 `openCustomerServiceChat` 还出现在 import 与注释里，
   *    直接全文计数会虚报（2026-10-04 首跑就这样假红过一次）。
   */
  const codeOnly = page
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
  const callCount = (codeOnly.match(/openCustomerServiceChat\s*\(/g) || []).length;
  const inTap = /function onPrimaryTap[\s\S]*?openCustomerServiceChat\s*\(/.test(codeOnly);
  // 自证：判据要能区分「点击回调内调用」与「onShow 里自动调用」
  const tapSample = 'async function onPrimaryTap(){ await openCustomerServiceChat({}); }';
  const autoSample = 'onShow(() => { void openCustomerServiceChat({}); });';
  ok(
    'K25-自证 点击回调样本必过 / 自动调用样本必不过',
    /function onPrimaryTap[\s\S]*?openCustomerServiceChat\s*\(/.test(tapSample) &&
      !/function onPrimaryTap[\s\S]*?openCustomerServiceChat\s*\(/.test(autoSample),
    'ok',
  );
  ok(
    'K26 唤起只在点击回调里发生（官方：仅在点击行为时调用）',
    inTap && callCount === 1,
    `代码区调用 ${callCount} 处 · 在 onPrimaryTap 内=${inTap}`,
  );

  await stopApiServer(child);

  console.log(`\n合计：通过 ${pass} · 失败 ${fail}`);
  if (fails.length) console.log('失败项：' + fails.join(' / '));
  process.exit(fail === 0 ? 0 : 1);
}

await main();

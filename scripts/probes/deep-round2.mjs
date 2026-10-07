/**
 * 深度测试 · 第二轮（2026-10-04 本批新功能的**边界与闭环**）
 *
 * 为什么还要再来一轮：第一轮（deep-test / deep-cancel）证明的是「主干能跑通」——
 * 取消理由能落库、一人能下两单、资质墙能出列表。但下面这些是第一轮**没覆盖**、
 * 而恰恰最容易在生产里出问题的地方：
 *
 *   D 取消的边界：已支付单怎么退、重复取消会不会把第一次的理由冲掉、
 *                 超长说明会不会把 MySQL 写崩、别人能不能取消我的单
 *   E 数据闭环：  取消理由采集起来是给「数据分析」用的 —— 后台列表/详情/导出
 *                 三处都拿不到的话，功能等于只做了一半
 *   F 多单边界：  份数有没有上限、取消其中一单会不会把另一单的统计带错
 *   G 资质墙：    接口是**免登录**的 —— 一旦把内部字段带出去就是公开泄漏
 *
 * 判据一律「从真实响应 / 真实 DB 取值再断言」，不写「应该没问题」。
 *
 * 用法：node scripts/probes/deep-round2.mjs
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

async function call(method, path, { token, idem, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idem) headers['Idempotency-Key'] = idem;
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

function tomorrowBj() {
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  return new Date(bj.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 直查 sqlite：接口出参看不到取消字段，只看响应永远发现不了「写了没」 */
function readOrder(orderNo) {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 8000');
  const row = db
    .prepare(
      'SELECT status, cancel_reason, cancel_note, cancel_source FROM ab_order WHERE order_no = ?',
    )
    .get(orderNo);
  db.close();
  return row ?? null;
}

/** 带重试的写：sqlite 只支持单写者，撞锁是瞬时的（busy → 退避重试） */
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
          /* 已经关了 */
        }
      }
      const until = Date.now() + 120 * (i + 1);
      while (Date.now() < until) {
        /* 忙等：本函数是同步的 */
      }
    }
  }
  throw new Error(`writeDb 重试 ${tries} 次仍失败：${lastErr?.message}`);
}

let seq = 0;
async function placeOrder(token, mealDate, quantity = 1) {
  seq++;
  const r = await call('POST', '/orders', {
    token,
    idem: `dt-r2-order-${Date.now()}-${seq}`,
    body: { mealDate, quantity },
  });
  return r.body?.data?.orderNo ?? null;
}

// ---------------------------------------------------------------------------
// D · 取消的边界
// ---------------------------------------------------------------------------
async function groupD(token, mealDate) {
  console.log('[D] 取消的边界（第一轮只测了未支付单 + happy path）');

  // D1 · 已支付单自助取消要走「退余额 + 建退款单」，与第一轮的 pending_pay 不是同一条分支
  const o1 = await placeOrder(token, mealDate);
  await call('POST', '/pay/mock/paid', { body: { orderNo: o1 } });
  const c1 = await call('POST', `/orders/${o1}/cancel`, {
    token,
    idem: `dt-r2-d1-${Date.now()}`,
    body: { reason: 'price' },
  });
  ok('D1 已支付单自助取消 → 成功', c1.body?.code === 0, `code=${c1.body?.code}`);
  const r1 = readOrder(o1);
  ok(
    'D1b 已支付分支同样落来源（source=user / reason=price）',
    r1?.cancel_source === 'user' && r1?.cancel_reason === 'price' && r1?.status === 'cancelled',
    `source=${r1?.cancel_source} reason=${r1?.cancel_reason} status=${r1?.status}`,
  );

  // D2 · 同一幂等键重放：应回吐首次结果，绝不重做一次退款
  const key = `dt-r2-d2-${Date.now()}`;
  const o2 = await placeOrder(token, mealDate);
  await call('POST', '/pay/mock/paid', { body: { orderNo: o2 } });
  const first = await call('POST', `/orders/${o2}/cancel`, {
    token,
    idem: key,
    body: { reason: 'not_in_office' },
  });
  const again = await call('POST', `/orders/${o2}/cancel`, {
    token,
    idem: key,
    body: { reason: 'ate_elsewhere' },
  });
  ok(
    'D2 同键重放 → 10006 且回吐首次结果',
    again.body?.code === 10006 && first.body?.code === 0,
    `first=${first.body?.code} again=${again.body?.code}`,
  );
  const r2 = readOrder(o2);
  ok(
    'D2b 重放没有把理由改成第二次的值',
    r2?.cancel_reason === 'not_in_office',
    `reason=${r2?.cancel_reason}`,
  );

  // D3 · 换一个幂等键重复取消：第一次已把状态改成 cancelled，第二次必须被拒
  const o3 = await placeOrder(token, mealDate);
  await call('POST', `/orders/${o3}/cancel`, {
    token,
    idem: `dt-r2-d3a-${Date.now()}`,
    body: { reason: 'duplicate', note: '第一轮的值' },
  });
  const dup = await call('POST', `/orders/${o3}/cancel`, {
    token,
    idem: `dt-r2-d3b-${Date.now()}`,
    body: { reason: 'other', note: '第二轮想覆盖它' },
  });
  ok(
    'D3 换键重复取消 → 被拒绝（非 500、非成功）',
    dup.status < 500 && dup.body?.code !== 0,
    `status=${dup.status} code=${dup.body?.code}`,
  );
  const r3 = readOrder(o3);
  ok(
    'D3b 首次落库的理由没被第二次冲掉',
    r3?.cancel_reason === 'duplicate' && r3?.cancel_note === null,
    `reason=${r3?.cancel_reason} note=${r3?.cancel_note}`,
  );

  // D4 · 超长说明：`cancel_note` 列是 VARCHAR(128)，DTO 限 100 —— 超了必须被拦，不能写崩 DB
  const o4 = await placeOrder(token, mealDate);
  const c4 = await call('POST', `/orders/${o4}/cancel`, {
    token,
    idem: `dt-r2-d4-${Date.now()}`,
    body: { reason: 'other', note: '长'.repeat(101) },
  });
  ok(
    'D4 说明超 100 字 → 参数校验拦住（10001）',
    c4.body?.code === 10001,
    `status=${c4.status} code=${c4.body?.code}`,
  );
  const r4 = readOrder(o4);
  ok(
    'D4b 被拦的请求没有产生取消痕迹',
    r4?.status === 'pending_pay' && r4?.cancel_source === null,
    `status=${r4?.status} source=${r4?.cancel_source}`,
  );

  // D5 · 边界值 100 字应放行（校验写错一位就会把合法输入也拦掉）
  const o5 = await placeOrder(token, mealDate);
  const c5 = await call('POST', `/orders/${o5}/cancel`, {
    token,
    idem: `dt-r2-d5-${Date.now()}`,
    body: { reason: 'other', note: '短'.repeat(100) },
  });
  ok('D5 说明恰好 100 字 → 放行', c5.body?.code === 0, `code=${c5.body?.code}`);
  const r5 = readOrder(o5);
  ok('D5b 100 字原文落库未截断', String(r5?.cancel_note ?? '').length === 100, `len=${String(r5?.cancel_note ?? '').length}`);

  // D6 · 越权：另一个用户来取消我的订单
  const other = await call('POST', '/auth/login', { body: { code: 'dev:2' } });
  const otherToken = other.body?.data?.token;
  const o6 = await placeOrder(token, mealDate);
  const x = await call('POST', `/orders/${o6}/cancel`, {
    token: otherToken,
    idem: `dt-r2-d6-${Date.now()}`,
    body: { reason: 'dish_dislike' },
  });
  ok(
    'D6 他人取消我的订单 → 被拒绝',
    x.status < 500 && x.body?.code !== 0,
    `status=${x.status} code=${x.body?.code}`,
  );
  const r6 = readOrder(o6);
  ok(
    'D6b 我的订单没被别人取消掉（状态与取消字段均未变）',
    r6?.status === 'pending_pay' && r6?.cancel_source === null,
    `status=${r6?.status} source=${r6?.cancel_source}`,
  );
}

// ---------------------------------------------------------------------------
// E · 数据分析闭环（同事提这个需求是为了分析的，看完再看别的组）
// ---------------------------------------------------------------------------
async function groupE(adminToken, orderNo, mealDate) {
  console.log('\n[E] 数据分析闭环：后台能不能看到 / 导出取消理由');

  const detail = await call('GET', `/admin/orders/${orderNo}`, { token: adminToken });
  ok('E1 后台订单详情 200', detail.body?.code === 0, `code=${detail.body?.code}`);
  const d = detail.body?.data?.order ?? {};
  const dKeys = Object.keys(d);
  ok(
    'E2 详情行含 cancelReason / cancelSource（运营能看到取消理由）',
    dKeys.includes('cancelReason') && dKeys.includes('cancelSource'),
    `keys=${dKeys.filter((k) => k.toLowerCase().includes('cancel')).join(',') || '（无 cancel 相关键）'}`,
  );

  const list = await call('GET', `/admin/orders?page=1&pageSize=5&mealDate=${mealDate}`, {
    token: adminToken,
  });
  ok('E3 后台订单列表 200', list.body?.code === 0, `code=${list.body?.code}`);
  const row0 = list.body?.data?.list?.[0] ?? {};
  const lKeys = Object.keys(row0);
  ok(
    'E4 列表行含 cancelReason / cancelSource',
    lKeys.includes('cancelReason') && lKeys.includes('cancelSource'),
    `keys=${lKeys.filter((k) => k.toLowerCase().includes('cancel')).join(',') || '（无 cancel 相关键）'}`,
  );

  const exp = await call('GET', `/admin/orders/export?mealDate=${mealDate}`, {
    token: adminToken,
  });
  ok('E5 导出 200', exp.body?.code === 0, `code=${exp.body?.code}`);
  const headers = exp.body?.data?.headers ?? [];
  const hit = headers.filter((h) => String(h).includes('取消'));
  ok(
    'E6 导出表头含取消来源 / 取消理由（导不出就等于没采集）',
    hit.length >= 2,
    `表头 ${headers.length} 列：${headers.join('/')}`,
  );
}

// ---------------------------------------------------------------------------
// F · 一人一日多单的边界
// ---------------------------------------------------------------------------
async function groupF(token, mealDate) {
  console.log('\n[F] 多单边界（第一轮只验证「能下第二单」）');

  // F1 · 单笔巨大份数：不该 500，也不该算出错误的金额
  const big = await call('POST', '/orders', {
    token,
    idem: `dt-r2-f1-${Date.now()}`,
    body: { mealDate, quantity: 999 },
  });
  ok('F1 单笔 999 份不崩（非 500）', big.status < 500, `status=${big.status} code=${big.body?.code}`);
  if (big.body?.code === 0) {
    const d = big.body?.data;
    const fen = d?.payAmountFen ?? d?.totalAmountFen;
    ok(
      'F1b 金额与份数自洽（1 份 25.80 → 999 份 25774.20）',
      Number(fen) === 2577420,
      `fen=${fen} quantity=${d?.quantity}`,
    );
    await call('POST', `/orders/${d?.orderNo}/cancel`, {
      token,
      idem: `dt-r2-f1c-${Date.now()}`,
    });
    console.log('        （999 份被接受，已取消清理）');
  } else {
    console.log(`        999 份被拒绝：code=${big.body?.code} msg=${String(big.body?.message).slice(0, 40)}`);
  }

  // F2 · 部分取消：统计要跟着减，不能整批归零（那会让用户以为全天没单）
  //
  // ⚠️ 断言必须用「进场基线 + 增量」，不能写死数字：本探针 D 组有意留了两张
  //    未取消的 pending 单（D4b 被拦下的、D6b 别人取消不了的），直接写 count=2
  //    会因**夹具污染**而假红。这是探针没隔离，不是产品算错。
  const baseRes = await call('GET', '/home/daily', { token });
  const baseCount = Number(baseRes.body?.data?.existingOrderCount ?? 0);
  const baseQty = Number(baseRes.body?.data?.existingQuantity ?? 0);
  console.log(`        进场基线：count=${baseCount} quantity=${baseQty}`);

  const a = await placeOrder(token, mealDate, 1);
  await placeOrder(token, mealDate, 2);
  const before = await call('GET', '/home/daily', { token });
  const bCount = Number(before.body?.data?.existingOrderCount ?? -1);
  const bQty = Number(before.body?.data?.existingQuantity ?? -1);
  ok(
    'F2 下两单后 count 增 2、份数增 3（与基线对齐）',
    bCount === baseCount + 2 && bQty === baseQty + 3,
    `count ${baseCount}→${bCount}，份数 ${baseQty}→${bQty}`,
  );
  await call('POST', `/orders/${a}/cancel`, {
    token,
    idem: `dt-r2-f2-${Date.now()}`,
    body: { reason: 'duplicate' },
  });
  const after = await call('GET', '/home/daily', { token });
  const ad = after.body?.data;
  ok(
    'F3 取消其中一单 → 只扣掉那一单的量（不是整批归零）',
    Number(ad?.existingOrderCount) === baseCount + 1 && Number(ad?.existingQuantity) === baseQty + 2,
    `count=${ad?.existingOrderCount}（期望 ${baseCount + 1}） qty=${ad?.existingQuantity}（期望 ${baseQty + 2}）`,
  );
  ok('F4 仍有订单时照样能继续下单', ad?.canOrder === true, `canOrder=${ad?.canOrder}`);

  // F5 · 剩余那一单不受牵连：状态与取消字段都干净
  const cleanup = await call('GET', '/orders?page=1&pageSize=20', { token });
  const alive = (cleanup.body?.data?.list ?? []).filter((o) => o.status === 'pending_pay');
  ok('F5 剩余订单仍为待支付且无取消痕迹', alive.length >= 1 && alive.every((o) => !o.cancelReason), `剩余 ${alive.length} 单`);
}

// ---------------------------------------------------------------------------
// G · 资质墙（免登录接口，泄漏成本最高）
//
// ⚠️ 为什么必须**自造样本**：种子里 4 家供应商全是「已核验 + 未过期」
//    （seed.ts 的注释说得很清楚，出餐链路要求 canServe=true），于是
//    `inactive` 数组在演示环境里**恒为空**。空数组上做 `every()` 判定恒绿
//    ⇒ 第一轮那条 A14 实际上是「没有检查」。这里临时把一家改过期，
//    把这条路径真正跑一遍，测完复原。
// ---------------------------------------------------------------------------
async function groupG() {
  console.log('\n[G] 资质墙：免登录接口的越权 / 信息面 / 与出餐判据同源');

  const before = await call('GET', '/traceability/suppliers');
  const data0 = before.body?.data;
  const serving0 = data0?.serving ?? [];
  const inactive0 = data0?.inactive ?? [];
  console.log(`        初始：在供 ${serving0.length} 家 · 暂未供应 ${inactive0.length} 家`);
  ok('G0 初始有在供样本', serving0.length > 0, `serving=${serving0.length}`);

  const INTERNAL = [
    'contactPhone',
    'contactName',
    'bankAccount',
    'bankName',
    'wxSubMchId',
    'auditRemark',
    'shareRate',
  ];

  // G1 · 自造一个「证照昨天到期」的样本 —— 分组必须即时跟着判据走
  const t = serving0[0];
  const origExpire = t?.licenseExpireAt ?? '2027-12-31';
  const yesterday = new Date(Date.now() + 8 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
  writeDb('UPDATE ab_supplier SET license_expire_at = ? WHERE id = ?', [yesterday, t.id]);

  const after = await call('GET', '/traceability/suppliers');
  const data1 = after.body?.data;
  const s1 = data1?.serving ?? [];
  const i1 = data1?.inactive ?? [];
  const moved = i1.find((x) => x.id === t.id);
  ok(
    'G1 证照过期 → 立刻从「在供」移到「暂未供应」（分组不是写死的）',
    s1.every((x) => x.id !== t.id) && !!moved,
    `${t.name}：serving 里 ${s1.some((x) => x.id === t.id) ? '仍在（判据漂移）' : '已移出'}，inactive 里 ${moved ? '已出现' : '没有'}`,
  );
  ok(
    'G2 移过去的这条不带证照与有效期（过期证照摆上墙比不摆更糟）',
    moved?.qualifications?.length === 0 && moved?.licenseExpireAt === null && moved?.serving === false,
    `qualifications=${moved?.qualifications?.length} expireAt=${moved?.licenseExpireAt}`,
  );

  // G3 · 该样本的详情页：可达、给解释、不带内部字段
  const one = await call('GET', `/traceability/suppliers/${t.id}`);
  const d = one.body?.data;
  ok(
    'G3 暂未供应供应商详情可达且给说明（不是空白页）',
    one.body?.code === 0 && Array.isArray(d?.entries) && d.entries.length === 0 && !!d?.note,
    `code=${one.body?.code} entries=${d?.entries?.length} note=${String(d?.note).slice(0, 24)}`,
  );
  const dump = JSON.stringify({ list: data1, detail: d });
  const leak = INTERNAL.filter((k) => dump.includes(k));
  ok('G4 免登录响应不带联系人 / 银行 / 商户号 / 分账比例', leak.length === 0, `命中：${leak.join(',') || '无'}`);

  // G5 · 复原后必须回到「在供」—— 否则说明列表吃的是缓存，出餐侧也会跟着错
  writeDb('UPDATE ab_supplier SET license_expire_at = ? WHERE id = ?', [origExpire, t.id]);
  const back = await call('GET', '/traceability/suppliers');
  ok(
    'G5 复原后回到在供（即时判定，无缓存残留）',
    (back.body?.data?.serving ?? []).some((x) => x.id === t.id),
    `serving=${(back.body?.data?.serving ?? []).length} 家`,
  );

  // G6 · 负数 id 这类畸形入参：必须走业务错误，不能 500
  const neg = await call('GET', '/traceability/suppliers/-1');
  ok(
    'G6 负数 id → 业务错误（非 500）',
    neg.status < 500 && neg.body?.code != null && neg.body?.code !== 0,
    `status=${neg.status} code=${neg.body?.code}`,
  );
}

async function main() {
  console.log('重置种子…');
  const seed = spawnSync(NODE, ['scripts/gate.mjs', 'seed'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PIPEFIX_QUIET: '1', NODE_OPTIONS: PF ? `--require ${PF}` : (process.env.NODE_OPTIONS ?? '') },
  });
  if (seed.status !== 0) {
    console.error('seed 失败 exit=' + seed.status, ((seed.stdout || '') + (seed.stderr || '')).slice(0, 600));
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
  ok('C0 登录取 token', !!token, token ? 'ok' : JSON.stringify(login.body).slice(0, 160));
  if (!token) {
    await stopApiServer(child);
    process.exit(2);
  }
  await call('PUT', '/me/building', { token, body: { buildingId: 1 } });

  const adm = await call('POST', '/auth/admin-login', {
    body: { username: 'admin', password: 'admin123' },
  });
  const adminToken = adm.body?.data?.token;
  ok('C0b 后台登录取 token', !!adminToken, `code=${adm.body?.code}`);

  await groupD(token, mealDate);

  // E 组要有一张「已取消且带理由」的订单当样本
  const sample = await placeOrder(token, mealDate);
  await call('POST', `/orders/${sample}/cancel`, {
    token,
    idem: `dt-r2-sample-${Date.now()}`,
    body: { reason: 'ate_elsewhere' },
  });
  await groupE(adminToken, sample, mealDate);

  await groupF(token, mealDate);
  await groupG();

  console.log(`\n合计：通过 ${pass} · 失败 ${fail}`);
  if (fail) console.log('失败项：' + fails.join(' | '));

  await stopApiServer(child);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error('探针自身异常：', e.message);
  process.exit(2);
});

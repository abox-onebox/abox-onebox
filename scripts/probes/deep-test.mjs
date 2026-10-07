/**
 * 深度测试第三层：真发请求实测
 *
 * 覆盖 2026-10-03 两批改动（资质墙 · 一人一日多单）里静态门禁测不到的部分。
 * 判据全部为「从真实响应里取值再断言」，不写「应该没问题」。
 *
 * 用法：node scripts/probes/deep-test.mjs [apiBase]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3000/api/v1';

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
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

/** 北京时间「明日」——下单窗口只有明日 */
function tomorrowBj() {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const t = new Date(bj.getTime() + 24 * 3600 * 1000);
  return t.toISOString().slice(0, 10);
}

async function main() {
  const mealDate = tomorrowBj();
  console.log(`API=${BASE}`);
  console.log(`出餐日=${mealDate}\n`);

  // ---------------------------------------------------------------- A 资质墙
  console.log('[A] 供应商资质墙（新增端点 · 免登录）');

  const list = await call('GET', '/traceability/suppliers');
  ok('A1 列表 200', list.status === 200, `status=${list.status}`);
  const listData = list.body?.data;
  const serving = listData?.serving;
  const inactive = listData?.inactive;
  ok('A2 返回 serving 数组（正在供应）', Array.isArray(serving), `len=${serving?.length}`);
  ok('A3 返回 inactive 数组（暂未供应）', Array.isArray(inactive), `len=${inactive?.length}`);
  ok('A4 列表带 note 说明', typeof listData?.note === 'string' && listData.note.length > 0, String(listData?.note).slice(0, 40));

  // 上架判据：出现在 serving 里的必须「合作中 ∧ 资质通过 ∧ 证照未过期」
  const todayBjStr = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

  if (Array.isArray(serving)) {
    console.log(`        在供 ${serving.length} 家：${serving.map((s) => s.name).join(' / ')}`);
    ok('A5 在供项 serving 标志全为 true', serving.every((s) => s.serving === true), `越界 ${serving.filter((s) => s.serving !== true).length} 家`);
    const expired = serving.filter((s) => s.licenseExpireAt && s.licenseExpireAt < todayBjStr);
    ok('A6 在供项无已过期证照', expired.length === 0, `过期 ${expired.length} 家`);
    const emptyQ = serving.filter((s) => !Array.isArray(s.qualifications) || s.qualifications.length === 0);
    ok('A7 在供项均至少登记 1 项证照', emptyQ.length === 0, `无证照 ${emptyQ.length} 家`);

    const fid = serving[0]?.id;
    ok('A8 首项有 id', fid != null, `id=${fid}`);
    if (fid != null) {
      const one = await call('GET', `/traceability/suppliers/${fid}`);
      ok('A9 详情 200', one.status === 200 && one.body?.code === 0, `status=${one.status} code=${one.body?.code}`);
      const d = one.body?.data;
      ok('A10 详情含证照数组 entries', Array.isArray(d?.entries), `len=${d?.entries?.length}`);
      if (Array.isArray(d?.entries)) {
        console.log(`        证照 ${d.entries.length} 条：${d.entries.map((q) => q.label).join(' / ')}`);
        ok('A11 每条证照有编号与有效期', d.entries.every((q) => q.code && q.expireAt), `缺失 ${d.entries.filter((q) => !q.code || !q.expireAt).length} 条`);
        const badExpire = d.entries.filter((q) => q.expireAt && q.expireAt < todayBjStr);
        ok('A12 详情内无已过期证照', badExpire.length === 0, `过期 ${badExpire.length} 条`);
      }
      ok('A13 详情含菜品清单 dishes', Array.isArray(d?.dishes), `len=${d?.dishes?.length}`);
    }
  }

  if (Array.isArray(inactive)) {
    console.log(`        暂未供应 ${inactive.length} 家：${inactive.map((s) => s.name).join(' / ')}`);
    ok('A14 暂未供应项 serving 全为 false', inactive.every((s) => s.serving === false), `越界 ${inactive.filter((s) => s.serving !== false).length} 家`);
  }

  // 边界：不存在的 id 与非数字 id —— 这两种最容易 500
  const missing = await call('GET', '/traceability/suppliers/999999');
  ok(
    'A15 不存在 id → 10004（非 500）',
    missing.body?.code === 10004,
    `status=${missing.status} code=${missing.body?.code}`,
  );
  const nan = await call('GET', '/traceability/suppliers/abc');
  ok(
    'A16 非数字 id → 10001（非 500）',
    nan.body?.code === 10001,
    `status=${nan.status} code=${nan.body?.code}`,
  );

  // ------------------------------------------------------------ B 一人一日多单
  console.log('\n[B] 一人一日可多单（本次放开的核心）');

  const login = await call('POST', '/auth/login', { body: { code: 'dev:1' } });
  const token = login.body?.data?.token;
  ok('B1 登录取 token', !!token, token ? 'ok' : `body=${JSON.stringify(login.body).slice(0, 160)}`);
  if (!token) {
    console.log('\n无法继续，token 缺失');
    return;
  }

  await call('PUT', '/me/building', { token, body: { buildingId: 1 } });

  const day0 = await call('GET', '/home/daily', { token });
  const d0 = day0.body?.data;
  ok('B2 首页可读', !!d0, `canOrder=${d0?.canOrder}`);
  console.log(`        初始：existingOrderCount=${d0?.existingOrderCount} existingQuantity=${d0?.existingQuantity}`);

  const k1 = 'dt-1-' + Date.now();
  const o1 = await call('POST', '/orders', {
    token,
    idem: k1,
    body: { mealDate, quantity: 1 },
  });
  const no1 = o1.body?.data?.orderNo;
  ok('B3 第 1 单建单成功', !!no1, `code=${o1.body?.code} no=${no1}`);

  const day1 = await call('GET', '/home/daily', { token });
  const d1 = day1.body?.data;
  ok('B4 第 1 单后 count=1', d1?.existingOrderCount === 1, `count=${d1?.existingOrderCount}`);
  ok('B5 第 1 单后 quantity=1', d1?.existingQuantity === 1, `qty=${d1?.existingQuantity}`);

  const k2 = 'dt-2-' + Date.now();
  const o2 = await call('POST', '/orders', {
    token,
    idem: k2,
    body: { mealDate, quantity: 2 },
  });
  const no2 = o2.body?.data?.orderNo;
  ok('B6 同日第 2 单建单成功（原 30004 已放开）', !!no2, `code=${o2.body?.code} no=${no2}`);

  const day2 = await call('GET', '/home/daily', { token });
  const d2 = day2.body?.data;
  ok('B7 第 2 单后 count=2', d2?.existingOrderCount === 2, `count=${d2?.existingOrderCount}`);
  ok('B8 第 2 单后 quantity=3（1+2）', d2?.existingQuantity === 3, `qty=${d2?.existingQuantity}`);
  ok('B9 已有订单时 canOrder 仍为 true', d2?.canOrder === true, `canOrder=${d2?.canOrder}`);

  // 幂等必须还在：同键回放要回吐原单，不能造第三单
  const replay = await call('POST', '/orders', {
    token,
    idem: k2,
    body: { mealDate, quantity: 2 },
  });
  const replayNo = replay.body?.data?.orderNo;
  ok(
    'B10 同键回放 → 10006 且回吐原单（幂等未丢）',
    replay.body?.code === 10006 && replayNo === no2,
    `code=${replay.body?.code} no=${replayNo}`,
  );

  const day3 = await call('GET', '/home/daily', { token });
  ok(
    'B11 回放未新增订单（仍 2 单）',
    day3.body?.data?.existingOrderCount === 2,
    `count=${day3.body?.data?.existingOrderCount}`,
  );

  // 清理：取消这两单，避免污染后续夹具
  for (const no of [no1, no2]) {
    if (no) {
      await call('POST', `/orders/${no}/cancel`, {
        token,
        idem: 'dt-cancel-' + no,
      });
    }
  }
  const day4 = await call('GET', '/home/daily', { token });
  ok(
    'B12 取消后归零（清理成功）',
    day4.body?.data?.existingOrderCount === 0,
    `count=${day4.body?.data?.existingOrderCount}`,
  );

  console.log(`\n合计：通过 ${pass} · 失败 ${fail}`);
  if (fail) {
    console.log('失败项：' + fails.join(' | '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('探针自身异常：', e.message);
  process.exit(2);
});

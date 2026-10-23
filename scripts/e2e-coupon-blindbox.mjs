#!/usr/bin/env node
/**
 * ABox 新功能端到端验收：代金券 + X 盲盒（**免 pnpm**，真实起服务 + 真实 HTTP）
 *
 * ⚠️ 背景：既有 `gate.mjs verify` 的 m1/m2/m3 **完全不触碰**本次新增的代金券 / X 盲盒
 *    路径（grep 验证：m1/m2/m3 中无任何 coupon / blindBox 引用）。故新增本套件，把
 *    新增功能的「逻辑 + 功能实现」真正跑一遍，避免「全绿」掩盖未测盲区。
 *
 * 覆盖点：
 *   代金券：
 *     · 后台手动发券（/admin/coupon/grant）
 *     · 我的券（/coupon/my）—— 含可用判据
 *     · 下单可用券（/coupon/my-available?totalFen=）—— 含门槛判定与实抵扣额
 *     · 下单核销：discount_amount / pay_amount 正确扣减
 *     · 取消订单 → 券还原（releaseForOrder，幂等；库内 status=unused & order_no=null）
 *     · 门槛不满足 → 下单返回 40021（COUPON_THRESHOLD_NOT_MET）
 *   X 盲盒：
 *     · 下单时从内容池抽一张，落 blind_box_name
 *     · 订单详情返回的盲盒名为内容池成员
 *     · 未送达前不揭晓（reveal 由端上按 DELIVERED/COMPLETED 判定；此处校验状态非已送达）
 *
 * 用法：
 *   node scripts/e2e-coupon-blindbox.mjs
 *   ⚠️ 前置：先跑一次 `node scripts/gate.mjs seed`（干净 sqlite + 相对运行日的分配）
 *   ⚠️ 下单窗口：经门禁跑会注入 ABOX_SHIFT_TO_HOUR；单独跑需自带：
 *       ABOX_SHIFT_TO_HOUR=20 node scripts/e2e-coupon-blindbox.mjs
 *
 * 端口：默认 3104（E2E_PORT 可覆盖）—— 与 m1/m2/m3 分开，避免 verify 串跑抢端口。
 */
import { existsSync } from 'node:fs';

import {
  BASE,
  DB_PATH,
  PORT,
  assertPortFree,
  installCleanupHooks,
  makeCall,
  openFixtureDb,
  sleep,
  startApiServer,
  stopApiServer,
  waitHealthy,
} from './lib/e2e-server.mjs';

const results = [];
const log = (s) => process.stdout.write(`${s}\n`);

function ok(name, detail = '') {
  results.push({ name, pass: true });
  log(`✔ ${name}${detail ? `  › ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ name, pass: false });
  log(`✘ ${name}${detail ? `  › ${detail}` : ''}`);
}
function assert(cond, name, detail = '') {
  if (cond) ok(name, detail);
  else fail(name, detail);
  return cond;
}

/**
 * 轮询 sqlite 直到某行满足 pred（mock 支付回调是异步的，下单后不能立刻读到 paid）。
 * 复用 openFixtureDb + sleep，自带 busy/锁容错。
 */
async function waitDbStatus(sql, params, pred, timeoutMs = 4000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    let db;
    try {
      db = openFixtureDb();
      const row = db.prepare(sql).get(...params);
      last = row;
      if (row && pred(row)) return row;
    } catch {
      // 轮询期间偶发 busy/锁，忽略后重试
    } finally {
      if (db) db.close();
    }
    await sleep(150);
  }
  return last;
}

const DEFAULT_BLIND_BOX_POOL = ['小粗粮', '小水果', '小凉菜', '小糕点', '鸡蛋糕'];

/**
 * 下单窗口前置判定（与 e2e-m1 同源）：不在 [14:00, 23:00) → 任何出餐日都下不了单。
 */
function assertOrderWindow() {
  const injected = Number(process.env.ABOX_SHIFT_TO_HOUR);
  const h =
    Number.isInteger(injected) && injected >= 0 && injected <= 23
      ? injected
      : new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
  if (h >= 14 && h < 23) return true;
  log(
    `\n✘ 前置失败：当前不在下单窗口（北京时间 ${String(h).padStart(2, '0')}:xx ∉ [14:00, 23:00)）\n` +
      `  单独跑请加 ABOX_SHIFT_TO_HOUR=20，或经门禁跑（已自动注入时钟）。\n`,
  );
  return false;
}

async function run() {
  log(`\n=== ABox 代金券 + X 盲盒 端到端验收 ===\n数据库：${DB_PATH}\n`);

  if (!assertOrderWindow()) return 1;

  installCleanupHooks();
  await assertPortFree(PORT);
  const server = startApiServer(PORT);
  const healthy = await waitHealthy(BASE, { child: server });
  if (!healthy) {
    fail('服务启动', '健康检查超时（90s）');
    await stopApiServer(server, PORT);
    return 1;
  }
  ok('服务启动', `${BASE}/health`);

  const call = makeCall(BASE);
  let code = 0;

  try {
    // ---------- 用户登录（seeded dev 账号） ----------
    const ul = await call('POST', '/auth/login', { body: { code: 'dev:1001' } });
    const userToken = ul.body?.data?.token;
    const userId = ul.body?.data?.user?.id;
    assert(ul.body?.code === 0 && !!userToken && !!userId, '用户登录(dev:1001)', `userId=${userId}`);

    // ---------- 后台登录 ----------
    const al = await call('POST', '/auth/admin-login', {
      body: { username: 'admin', password: 'admin123' },
    });
    const adminToken = al.body?.data?.token;
    assert(
      al.body?.code === 0 && !!adminToken,
      '后台登录(admin/admin123)',
      `role=${al.body?.data?.account?.role}`,
    );

    // ---------- 首页日报 → mealDate + 单价 ----------
    const daily = (await call('GET', '/home/daily', { token: userToken })).body?.data;
    const mealDate = daily?.mealDate;
    const priceFen = daily?.priceFen ?? 2580;
    const qty = 1;
    const totalFen = priceFen * qty;
    assert(!!mealDate && totalFen > 0, '首页日报(mealDate/priceFen)', `mealDate=${mealDate} totalFen=${totalFen}`);

    // ---------- ① 后台手动发券（无门槛 5 元券） ----------
    const g = await call('POST', '/admin/coupon/grant', {
      token: adminToken,
      body: {
        userId,
        faceValueFen: 500,
        thresholdFen: 0,
        validityType: 'days',
        validDays: 30,
        obtainedFrom: 'manual',
        name: 'E2E测试券-无门槛',
      },
    });
    const grantedCode = g.body?.data?.code;
    assert(g.body?.code === 0 && !!grantedCode, '后台发券(无门槛5元)', `code=${grantedCode}`);

    // ---------- ② 我的券：含这张，且可用 ----------
    const my = (await call('GET', '/coupon/my', { token: userToken })).body?.data ?? [];
    const myCoupon = my.find((c) => c.code === grantedCode);
    assert(
      !!myCoupon && myCoupon.status === 'unused' && myCoupon.available === true,
      '我的券·可用',
      `status=${myCoupon?.status} available=${myCoupon?.available}`,
    );

    // ---------- ③ 下单可用券：门槛满足 → applicable + 实抵扣额 ----------
    const avail =
      (await call('GET', `/coupon/my-available?totalFen=${totalFen}`, { token: userToken })).body?.data ?? [];
    const availCoupon = avail.find((c) => c.code === grantedCode);
    assert(
      !!availCoupon && availCoupon.applicable === true && availCoupon.discountFen === 500,
      '下单可用券·门槛满足',
      `applicable=${availCoupon?.applicable} discountFen=${availCoupon?.discountFen}`,
    );

    // ---------- ④ 下单核销：discount_amount / pay_amount 正确 ----------
    const idem1 = `e2e-coupon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const created = await call('POST', '/orders', {
      token: userToken,
      idem: idem1,
      body: { mealDate, quantity: qty, couponCode: grantedCode },
    });
    const ord = created.body?.data;
    assert(created.body?.code === 0 && !!ord?.orderNo, '下单(用券)', `orderNo=${ord?.orderNo}`);
    assert(ord?.discountAmountFen === 500, '用券后 discountAmountFen=500', `=${ord?.discountAmountFen}`);
    assert(
      ord?.payAmountFen === totalFen - 500,
      '用券后 payAmountFen=总额-500',
      `${totalFen}-500=${ord?.payAmountFen}`,
    );

    // ---------- ⑤ X 盲盒：订单详情 blind_box_name 落在内容池 ----------
    const detail = (await call('GET', `/orders/${ord.orderNo}`, { token: userToken })).body?.data;
    const bb = detail?.blindBoxName;
    assert(!!bb && DEFAULT_BLIND_BOX_POOL.includes(bb), 'X盲盒·落库且为内容池成员', `blindBoxName=${bb}`);
    const notRevealed = detail?.status !== 'DELIVERED' && detail?.status !== 'COMPLETED';
    assert(
      notRevealed,
      'X盲盒·未送达不揭晓(状态非已送达/已完成)',
      `status=${detail?.status}`,
    );

    // ---------- ⑥ 取消订单 → 券还原（幂等） ----------
    const cancel = await call('POST', `/orders/${ord.orderNo}/cancel`, {
      token: userToken,
      body: { reason: 'other', note: 'e2e-coupon' },
    });
    assert(cancel.body?.code === 0, '取消订单(用券单)', `code=${cancel.body?.code}`);

    let released = false;
    try {
      const db = openFixtureDb();
      const row = db.prepare('SELECT status, order_no FROM ab_user_coupon WHERE code = ?').get(grantedCode);
      released = !!row && row.status === 'unused' && row.order_no === null;
      db.close();
    } catch (e) {
      log(`⚠ 查库失败：${e?.message ?? e}`);
    }
    assert(released, '退券生效(库内 status=unused & order_no=null)', `released=${released}`);

    const my2 = (await call('GET', '/coupon/my', { token: userToken })).body?.data ?? [];
    const myCoupon2 = my2.find((c) => c.code === grantedCode);
    assert(
      myCoupon2?.status === 'unused' && myCoupon2?.available === true,
      '退券后我的券恢复可用',
      `status=${myCoupon2?.status}`,
    );

    // ---------- ⑦ 门槛不满足 → 下单返回 40021 ----------
    const g2 = await call('POST', '/admin/coupon/grant', {
      token: adminToken,
      body: {
        userId,
        faceValueFen:500,
        thresholdFen: 99900,
        validityType: 'days',
        validDays: 30,
        obtainedFrom: 'manual',
        name: 'E2E测试券-高门槛',
      },
    });
    const code2 = g2.body?.data?.code;
    assert(g2.body?.code === 0 && !!code2, '后台发券(高门槛¥999)', `code=${code2}`);
    const idem2 = `e2e-coupon-th-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const bad = await call('POST', '/orders', {
      token: userToken,
      idem: idem2,
      body: { mealDate, quantity: qty, couponCode: code2 },
    });
    assert(
      bad.body?.code === 40021,
      '高门槛券下单→40021(COUPON_THRESHOLD_NOT_MET)',
      `code=${bad.body?.code} msg=${bad.body?.message}`,
    );

    // ---------- ⑧ 退款退券：下单用券 → mock支付 → 团长代退 → 后台审批 → 券还原 ----------
    // ⚠️ 用独立用户 dev:1003（张磊·楼5，属团长1所辖）下单，避免与主流程 dev:1001 状态互相干扰。
    //    团长代退端点 `refund-apply` 走 LeaderGuard，须由归属团长(李明 dev:1001)发起。
    const u3 = await call('POST', '/auth/login', { body: { code: 'dev:1003' } });
    const user3Token = u3.body?.data?.token;
    const uid3 = u3.body?.data?.user?.id;
    assert(u3.body?.code === 0 && !!user3Token && !!uid3, '退款退券·登录(dev:1003)', `uid=${uid3}`);

    const g3 = await call('POST', '/admin/coupon/grant', {
      token: adminToken,
      body: {
        userId: uid3,
        faceValueFen: 500,
        thresholdFen: 0,
        validityType: 'days',
        validDays: 30,
        obtainedFrom: 'manual',
        name: 'E2E退款退券测试券',
      },
    });
    const code3 = g3.body?.data?.code;
    assert(g3.body?.code === 0 && !!code3, '退款退券·发券(无门槛5元)', `code=${code3}`);

    const idem3 = `e2e-refund-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const o3 = await call('POST', '/orders', {
      token: user3Token,
      idem: idem3,
      body: { mealDate, quantity: 1, couponCode: code3 },
    });
    const no3 = o3.body?.data?.orderNo;
    assert(
      o3.body?.code === 0 && !!no3 && o3.body?.data?.discountAmountFen === 500,
      '退款退券·用券下单',
      `orderNo=${no3} discount=${o3.body?.data?.discountAmountFen}`,
    );

    // mock 支付（免 token；回调异步，轮询等 paid）
    const paid3 = await call('POST', '/pay/mock/paid', { body: { orderNo: no3 } });
    const paidRow3 = await waitDbStatus(
      'SELECT status FROM ab_order WHERE order_no = ?',
      [no3],
      (r) => r.status === 'paid',
    );
    assert(
      paid3.body?.code === 0 && paidRow3?.status === 'paid',
      '退款退券·mock支付到账(paid)',
      `status=${paidRow3?.status}`,
    );

    // 团长(李明 dev:1001)代退申请
    const ap3 = await call('POST', `/orders/${no3}/refund-apply`, {
      token: userToken,
      body: { reasonType: 'quality', reason: 'e2e·退款退券' },
    });
    const rf3 = (() => {
      let db;
      try {
        db = openFixtureDb();
        return db
          .prepare('SELECT id, status FROM ab_refund WHERE order_no = ? ORDER BY id DESC LIMIT 1')
          .get(no3);
      } finally {
        if (db) db.close();
      }
    })();
    assert(
      ap3.body?.code === 0 && rf3?.status === 'applying',
      '退款退券·团长代退申请(applying)',
      `status=${rf3?.status}`,
    );

    // 后台审批通过 → settleRefundDb → releaseForOrder（退券）
    const appr3 = await call('POST', `/admin/finance/refunds/${rf3.id}/approve`, {
      token: adminToken,
      body: { remark: 'e2e·退款退券' },
    });
    assert(appr3.body?.code === 0, '退款退券·后台审批通过', `code=${appr3.body?.code}`);

    // 券还原：库内 status=unused & order_no=null
    let released3 = false;
    try {
      const db = openFixtureDb();
      const row = db.prepare('SELECT status, order_no FROM ab_user_coupon WHERE code = ?').get(code3);
      released3 = !!row && row.status === 'unused' && row.order_no === null;
      db.close();
    } catch (e) {
      log(`⚠ 查库失败：${e?.message ?? e}`);
    }
    assert(released3, '退款退券·退券生效(库内 status=unused & order_no=null)', `released=${released3}`);
  } catch (e) {
    fail('套件异常', e?.message ?? String(e));
    console.error(e);
    code = 1;
  } finally {
    await stopApiServer(server, PORT);
  }

  code = results.every((r) => r.pass) ? 0 : 1;
  return code;
}

async function main() {
  let code = 1;
  try {
    code = await run();
  } catch (e) {
    fail('套件异常', e?.message ?? String(e));
    console.error(e);
    code = 1;
  }
  const pass = results.filter((r) => r.pass).length;
  const total = results.length;
  log(`\n──────── 汇总 ────────\n通过 ${pass}/${total} · ${pass === total ? '全绿 ✅' : '有失败 ❌'}`);
  process.exit(code);
}
main();

#!/usr/bin/env node
/**
 * A2Box 端到端验收：非团长可推荐 + 新返佣规则（**免 pnpm**，真实起服务 + 真实 HTTP）
 *
 * ⚠️ 背景：既有 e2e（m1/m2/m3/coupon-blindbox）**完全不触碰**本次新增的
 *    「非团长推荐（USR 码）/ 新返佣规则」路径。本套件把这块新增逻辑真正跑一遍。
 *
 * 覆盖点（产品裁定 2026-10-23）：
 *   ① 非团长 A 生成 USR 推荐码（GET /me/referral → `USR<idA>`）；
 *   ② B 经 `referralCode=USR<idA>` 申请成为团长 → `ab_leader_invite.inviter_user_id = idA`
 *       落库，A 的推荐列表出现 B；
 *   ③ 团长 LDR 码对照：C 经 `referralCode=LDR<leaderId>` 申请 → `inviter_leader_id` 落库、
 *       `inviter_user_id` 为 null；
 *   ④ **返佣规则三分支**（B/C/D 转正触发 `markFormal`）：
 *        · 非团长推荐（inviter_user_id 命中）→ 推荐人 A 得 5 元代金券（obtained_from=referral）；
 *        · 团长推荐且非首席（inviter_leader_id 命中、邀请人非 CHIEF）→ **不返券**，只计晋级；
 *        · 团长推荐且已为首席 CHIEF（邀请人 = CHIEF）→ 推荐人得 5 元代金券。
 *      为触发「转正」，本套件用受控方式把待测团长推到 FORMAL：
 *        插 1 行 `ab_commission`（team_leader_id=待测、quantity=31 当月、status=settled）
 *        + 把该团长 `invited_formal_count` 置 1 → `POST /leader/level/audit` 触发晋级 →
 *        `markFormal` 在晋级途中回写邀请人并发券。
 *
 * 用法：
 *   node scripts/e2e-referral.mjs
 *   ⚠️ 前置：先跑一次 `node scripts/gate.mjs seed`（干净 sqlite + 相对运行日的分配）
 *   ⚠️ 下单窗口：本套件不触碰下单，但仍受 `assertPortFree` / 健康检查约束；
 *      单独跑可带 `ABOX_SHIFT_TO_HOUR=20`。
 *
 * 端口：默认 3105（E2E_PORT 可覆盖）—— 与 m1/m2/m3/coupon-blindbox 分开，避免串跑抢端口。
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

/** 轮询 sqlite 直到某行满足 pred（发券是 best-effort，异步落库，不能立刻读到） */
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

/** 受控把某团长推到 FORMAL：插 1 行当月 commission（quantity=31）+ invited_formal_count=1 */
function seedFormalInputs(leaderId, userId) {
  const db = openFixtureDb();
  try {
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    // 清掉该团长既有 commission（保证 quantity 口径干净）
    db.prepare('DELETE FROM ab_commission WHERE team_leader_id = ?').run(leaderId);
    db.prepare(
      `INSERT INTO ab_commission
         (order_id, order_no, team_leader_id, leader_level, rate, base_amount, quantity, amount, type, status, meal_date)
       VALUES (?, ?, ?, 'trainee', '0.0800', '2580.00', 31, '206.40', 'normal', 'settled', ?)`,
    ).run(90000000 + Number(leaderId), `e2e-ref-${leaderId}`, leaderId, today);
    db.prepare('UPDATE ab_team_leader SET invited_formal_count = 1 WHERE id = ?').run(leaderId);
    return true;
  } finally {
    db.close();
  }
}

/** 查某人是否持有某来源的代金券（obtained_from + face_value_fen） */
function hasReferralCoupon(userId, faceValueFen = 500) {
  const db = openFixtureDb();
  try {
    const row = db
      .prepare(
        "SELECT id, face_value, obtained_from FROM ab_user_coupon WHERE user_id = ? AND obtained_from = 'referral' ORDER BY id DESC LIMIT 1",
      )
      .get(userId);
    if (!row) return null;
    // face_value 经 bigintTransformer 落库为整数分（同 ab_coupon.face_value）；此处按数值比
    const fv = Number(row.face_value ?? row.face_value_fen ?? 0);
    return { id: row.id, faceValue: fv, obtainedFrom: row.obtained_from };
  } finally {
    db.close();
  }
}

async function run() {
  if (!existsSync(DB_PATH)) {
    log(`\n✘ 前置失败：未找到 sqlite 夹具（${DB_PATH}）\n  请先跑：node scripts/gate.mjs seed\n`);
    return 1;
  }

  log(`\n=== ABox 非团长推荐 + 新返佣规则 端到端验收 ===\n数据库：${DB_PATH}\n`);

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

  // 用于「非团长推荐人」的纯净账号（种子 1001–1005 全是团长，必须用全新 dev 账号）
  const A_DEV = 'dev:2001';
  const B_DEV = 'dev:2002';
  const C_DEV = 'dev:2003';
  const B2_DEV = 'dev:2004';
  const B3_DEV = 'dev:2005';

  try {
    // ---------- ① 非团长 A 登录 + 取 USR 推荐码 ----------
    const al = await call('POST', '/auth/login', { body: { code: A_DEV } });
    const aToken = al.body?.data?.token;
    const aId = al.body?.data?.user?.id;
    const aIsLeader = al.body?.data?.isLeader;
    assert(
      al.body?.code === 0 && !!aToken && !!aId && !aIsLeader,
      '非团长 A 登录(dev:2001，非团长)',
      `userId=${aId} isLeader=${aIsLeader}`,
    );

    const refA = (await call('GET', '/me/referral', { token: aToken })).body?.data;
    const aCode = refA?.referralCode;
    assert(
      refA?.code === 0 || refA?.code === undefined ? !!aCode && /^USR\d+$/i.test(aCode) : false,
      'A 的推荐码为 USR 形态',
      `referralCode=${aCode}`,
    );
    // 兜底：直接用确定性规则构造，避免端点字段名差异导致误判
    const aCodeExpected = `USR${String(aId).padStart(4, '0')}`;
    assert(
      !aCode || aCode.toUpperCase() === aCodeExpected.toUpperCase(),
      'USR 码与确定性规则一致',
      `期望=${aCodeExpected} 实得=${aCode}`,
    );

    // ---------- ② B 经 USR<idA> 申请成为团长 ----------
    const bl = await call('POST', '/auth/login', { body: { code: B_DEV } });
    const bToken = bl.body?.data?.token;
    const bId = bl.body?.data?.user?.id;
    assert(bl.body?.code === 0 && !!bToken && !!bId, 'B 登录(dev:2002)', `userId=${bId}`);

    // B 需先绑定办公楼（U-B2），否则 apply 会因无 building 被拒
    const bMe0 = (await call('GET', '/auth/me', { token: bToken })).body?.data;
    if (!bMe0?.buildingId) {
      const bind = await call('PUT', '/me/building', {
        token: bToken,
        body: { buildingId: 1 },
      });
      assert(bind.body?.code === 0, 'B 自助绑定办公楼(buildingId=1)', `code=${bind.body?.code}`);
    }

    const bApply = await call('POST', '/leader/apply', {
      token: bToken,
      body: {
        buildingId: 1,
        phone: '13800000002',
        realName: 'B测试',
        agreementVersion: 'v1.0',
        referralCode: aCodeExpected,
      },
    });
    const bLeaderId = bApply.body?.data?.leader?.id;
    assert(
      bApply.body?.code === 0 && !!bLeaderId,
      'B 经 USR<idA> 申请成为团长',
      `leaderId=${bLeaderId} code=${bApply.body?.code}`,
    );

    // 断言：ab_leader_invite 落 inviter_user_id = idA，inviter_leader_id 为 null
    let bInvite = null;
    try {
      const db = openFixtureDb();
      bInvite = db
        .prepare('SELECT id, invitee_user_id, inviter_user_id, inviter_leader_id FROM ab_leader_invite WHERE invitee_user_id = ?')
        .get(bId);
      db.close();
    } catch (e) {
      log(`⚠ 查库失败：${e?.message ?? e}`);
    }
    assert(
      !!bInvite && Number(bInvite.inviter_user_id) === Number(aId) && !bInvite.inviter_leader_id,
      'USR 推荐落库(inviter_user_id=A, inviter_leader_id=null)',
      `inviter_user_id=${bInvite?.inviter_user_id} inviter_leader_id=${bInvite?.inviter_leader_id}`,
    );

    // A 的推荐列表应出现 B
    const refA2 = (await call('GET', '/me/referral', { token: aToken })).body?.data;
    const aList = refA2?.list?.list ?? [];
    const aTotal = refA2?.list?.summary?.totalCount ?? 0;
    assert(
      aTotal >= 1 && aList.some((r) => Number(r.id) === Number(bInvite?.id)),
      'A 的推荐列表出现 B',
      `totalCount=${aTotal}`,
    );

    // ---------- ③ 团长 LDR 码对照：C 经 LDR<leaderId=1 申请 ----------
    const cl = await call('POST', '/auth/login', { body: { code: C_DEV } });
    const cToken = cl.body?.data?.token;
    const cId = cl.body?.data?.user?.id;
    assert(cl.body?.code === 0 && !!cToken && !!cId, 'C 登录(dev:2003)', `userId=${cId}`);
    const cBind = await call('PUT', '/me/building', { token: cToken, body: { buildingId: 2 } });
    assert(cBind.body?.code === 0, 'C 自助绑定办公楼(buildingId=2)', `code=${cBind.body?.code}`);
    const cApply = await call('POST', '/leader/apply', {
      token: cToken,
      body: {
        buildingId: 2,
        phone: '13800000003',
        realName: 'C测试',
        agreementVersion: 'v1.0',
        referralCode: 'LDR0001',
      },
    });
    const cLeaderId = cApply.body?.data?.leader?.id;
    assert(cApply.body?.code === 0 && !!cLeaderId, 'C 经 LDR<1> 申请成为团长', `leaderId=${cLeaderId}`);
    let cInvite = null;
    try {
      const db = openFixtureDb();
      cInvite = db
        .prepare('SELECT id, invitee_user_id, inviter_user_id, inviter_leader_id FROM ab_leader_invite WHERE invitee_user_id = ?')
        .get(cId);
      db.close();
    } catch (e) {
      log(`⚠ 查库失败：${e?.message ?? e}`);
    }
    assert(
      !!cInvite && Number(cInvite.inviter_leader_id) === 1 && !cInvite.inviter_user_id,
      'LDR 推荐落库(inviter_leader_id=1, inviter_user_id=null)',
      `inviter_leader_id=${cInvite?.inviter_leader_id} inviter_user_id=${cInvite?.inviter_user_id}`,
    );

    // ---------- ④ 返佣规则分支一：非团长 A 推荐 B 转正 → A 得券 ----------
    seedFormalInputs(bLeaderId, bId);
    const auditB = await call('POST', '/leader/level/audit', { token: bToken });
    const bAfter = auditB.body?.data?.after;
    const bPromoted = auditB.body?.data?.promoted;
    assert(
      auditB.body?.code === 0 && bPromoted === true && bAfter === 'formal',
      'B 晋级审计→formal',
      `after=${bAfter} promoted=${bPromoted}`,
    );
    const aCoupon = await waitDbStatus(
      "SELECT id FROM ab_user_coupon WHERE user_id = ? AND obtained_from = 'referral'",
      [aId],
      (r) => !!r,
    );
    assert(!!aCoupon, '分支一·非团长推荐转正→推荐人 A 得 referral 券', `couponId=${aCoupon?.id}`);

    // ---------- ④ 返佣规则分支二：团长(非首席)推荐 C 转正 → 不返券 ----------
    // 王芳(1002) 为正式团长（非首席），其 LDR 码 = LDR0002。让 B2 经 LDR<2> 申请并转正。
    const b2l = await call('POST', '/auth/login', { body: { code: B2_DEV } });
    const b2Token = b2l.body?.data?.token;
    const b2Id = b2l.body?.data?.user?.id;
    assert(b2l.body?.code === 0 && !!b2Token && !!b2Id, 'B2 登录(dev:2004)', `userId=${b2Id}`);
    await call('PUT', '/me/building', { token: b2Token, body: { buildingId: 5 } });
    const b2Apply = await call('POST', '/leader/apply', {
      token: b2Token,
      body: {
        buildingId: 5,
        phone: '13800000004',
        realName: 'B2测试',
        agreementVersion: 'v1.0',
        referralCode: 'LDR0002',
      },
    });
    const b2LeaderId = b2Apply.body?.data?.leader?.id;
    assert(b2Apply.body?.code === 0 && !!b2LeaderId, 'B2 经 LDR<2> 申请成为团长', `leaderId=${b2LeaderId}`);

    // 先记录王芳(1002) 转正前的 referral 券数量
    const wfBefore = (() => {
      const db = openFixtureDb();
      try {
        return db
          .prepare("SELECT COUNT(*) AS n FROM ab_user_coupon WHERE user_id = 1002 AND obtained_from = 'referral'")
          .get().n;
      } finally {
        db.close();
      }
    })();
    seedFormalInputs(b2LeaderId, b2Id);
    const auditB2 = await call('POST', '/leader/level/audit', { token: b2Token });
    assert(
      auditB2.body?.code === 0 && auditB2.body?.data?.promoted === true && auditB2.body?.data?.after === 'formal',
      'B2 晋级审计→formal',
      `after=${auditB2.body?.data?.after}`,
    );
    const wfAfter = (() => {
      const db = openFixtureDb();
      try {
        return db
          .prepare("SELECT COUNT(*) AS n FROM ab_user_coupon WHERE user_id = 1002 AND obtained_from = 'referral'")
          .get().n;
      } finally {
        db.close();
      }
    })();
    assert(
      wfAfter === wfBefore,
      '分支二·团长(非首席)推荐转正→不返券',
      `王芳referral券 ${wfBefore}→${wfAfter}`,
    );

    // ---------- ④ 返佣规则分支三：团长(首席)推荐 B3 转正 → 返券 ----------
    // 李明(1001) 为首席团长，LDR 码 = LDR0001。让 B3 经 LDR<1> 申请并转正。
    const b3l = await call('POST', '/auth/login', { body: { code: B3_DEV } });
    const b3Token = b3l.body?.data?.token;
    const b3Id = b3l.body?.data?.user?.id;
    assert(b3l.body?.code === 0 && !!b3Token && !!b3Id, 'B3 登录(dev:2005)', `userId=${b3Id}`);
    await call('PUT', '/me/building', { token: b3Token, body: { buildingId: 4 } });
    const b3Apply = await call('POST', '/leader/apply', {
      token: b3Token,
      body: {
        buildingId: 4,
        phone: '13800000005',
        realName: 'B3测试',
        agreementVersion: 'v1.0',
        referralCode: 'LDR0001',
      },
    });
    const b3LeaderId = b3Apply.body?.data?.leader?.id;
    assert(b3Apply.body?.code === 0 && !!b3LeaderId, 'B3 经 LDR<1> 申请成为团长', `leaderId=${b3LeaderId}`);

    const lmBefore = (() => {
      const db = openFixtureDb();
      try {
        return db
          .prepare("SELECT COUNT(*) AS n FROM ab_user_coupon WHERE user_id = 1001 AND obtained_from = 'referral'")
          .get().n;
      } finally {
        db.close();
      }
    })();
    seedFormalInputs(b3LeaderId, b3Id);
    const auditB3 = await call('POST', '/leader/level/audit', { token: b3Token });
    assert(
      auditB3.body?.code === 0 && auditB3.body?.data?.promoted === true && auditB3.body?.data?.after === 'formal',
      'B3 晋级审计→formal',
      `after=${auditB3.body?.data?.after}`,
    );
    const lmAfter = await waitDbStatus(
      "SELECT COUNT(*) AS n FROM ab_user_coupon WHERE user_id = 1001 AND obtained_from = 'referral'",
      [],
      (r) => Number(r.n) > lmBefore,
      4000,
    );
    assert(
      Number(lmAfter?.n ?? 0) > lmBefore,
      '分支三·团长(首席)推荐转正→返券给首席',
      `李明referral券 ${lmBefore}→${lmAfter?.n}`,
    );
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

#!/usr/bin/env node
/**
 * ABox M2 端到端验收（**免 pnpm**，真实起服务 + 真实 HTTP）
 *
 * 覆盖《开发里程碑计划 v1.0》M2 验收标准 ①：
 *   「用户在『我的』可申请团长，**勾选协议后立即生效**，tabBar 出现团长入口（无审核流程）」
 *
 * 另覆盖 M2 任务 2.1 / 2.2 的边界与回归：
 *   · 未勾选协议（缺 agreementVersion）→ 10001
 *   · 非团长访问 /leader/* → 10003
 *   · 重复申请 → 20007 · 手机号被他人占用 → 20004
 *   · 办公楼不存在 / 未开通 → 10004
 *   · `floor` 落库（2026-09-15 裁定「方案 A：补回 ab_team_leader.floor」的回归）
 *   · `ab_leader_invite` 自荐记录落库（C3 / channel=self）
 *   · **等级口径回归**：种子 `formal` 团长取 levelLabel 必须得「正式」
 *     —— shared-types 曾把正式写成 `regular`，导致 LEADER_LEVEL_META 查表 miss
 *
 * 用法：node scripts/e2e-m2.mjs
 * ⚠️ 前置：先跑一次 `node scripts/gate.mjs seed`（干净数据库）
 *
 * 端口：默认 3101（`E2E_PORT` 可覆盖）。与 e2e-m1 同默认值不会互撞——`gate.mjs verify`
 *       串跑时，前一个脚本回收进程树后会**确认端口释放**才返回；详见 scripts/lib/e2e-server.mjs
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  BASE,
  DB_PATH,
  PORT,
  assertPortFree,
  installCleanupHooks,
  makeCall,
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

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const call = makeCall(BASE);

/** 登录并返回 { token, userId, isLeader } */
async function login(code) {
  const r = await call('POST', '/auth/login', { body: { code } });
  return {
    token: r.body?.data?.token,
    userId: r.body?.data?.user?.id,
    isLeader: r.body?.data?.isLeader,
    raw: r.body,
  };
}

function readDb(sql, params = []) {
  if (!existsSync(DB_PATH)) return null;
  const db = new DatabaseSync(DB_PATH);
  try {
    return db.prepare(sql).get(...params) ?? null;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  log(`\n=== ABox M2 端到端验收 ===\n数据库：${DB_PATH}\n`);

  installCleanupHooks();
  await assertPortFree(PORT);
  const server = startApiServer(PORT);
  const healthy = await waitHealthy(BASE, { child: server });
  if (!healthy) {
    fail('服务启动', `健康检查超时（90s）· ${BASE}/health`);
    await stopApiServer(server, PORT);
    return;
  }
  ok('服务启动', `${BASE}/health`);

  // ==========================================================================
  // 0. 等级口径回归（2026-09-15 修复：formal 曾被写成 regular）
  // ==========================================================================
  const zhang = await login('dev:1003'); // 张磊 · 种子 level='formal'
  const zhangProfile = await call('GET', '/leader/profile', { token: zhang.token });
  assert(
    zhangProfile.body?.code === 0 && zhangProfile.body?.data?.levelLabel === '正式',
    '回归 · formal 团长 levelLabel 恰为「正式」（LEADER_LEVEL_META 查表命中）',
    `level=${zhangProfile.body?.data?.level} label=${zhangProfile.body?.data?.levelLabel}`,
  );
  assert(
    zhangProfile.body?.data?.floor === '6F',
    '回归 · 种子团长 floor 已落库并可读（裁定② 方案 A）',
    `floor=${zhangProfile.body?.data?.floor}`,
  );

  const li = await login('dev:1001'); // 李明 · chief
  const liProfile = await call('GET', '/leader/profile', { token: li.token });
  assert(
    liProfile.body?.data?.levelLabel === '首席',
    '回归 · chief 团长 levelLabel 恰为「首席」',
    `level=${liProfile.body?.data?.level} label=${liProfile.body?.data?.levelLabel}`,
  );
  assert(
    liProfile.body?.data?.buildingName === '国贸三期 A 座',
    'L14 团长资料含办公楼名（跨表读取）',
    `building=${liProfile.body?.data?.buildingName} floor=${liProfile.body?.data?.floor}`,
  );

  // ==========================================================================
  // 1. M2-① 申请成为团长：勾选协议后**立即生效**
  // ==========================================================================
  const applicant = await login('dev:9101');
  assert(
    applicant.raw?.data?.isNewUser === true && applicant.isLeader === false,
    'M2-① 前置 · 全新用户登录时 isLeader=false',
    `userId=${applicant.userId} isNewUser=${applicant.raw?.data?.isNewUser} isLeader=${applicant.isLeader}`,
  );

  const beforeApply = await call('GET', '/leader/profile', { token: applicant.token });
  assert(
    beforeApply.body?.code === 10003 && beforeApply.status === 403,
    'M2-② 非团长访问 /leader/profile 返回 10003（HTTP 403，端上可做拦截分支）',
    `code=${beforeApply.body?.code} http=${beforeApply.status}`,
  );

  const noAgree = await call('POST', '/leader/apply', {
    token: applicant.token,
    body: { buildingId: 1, phone: '13700000101', realName: 'e2e · 待生效', floor: '9F' },
  });
  assert(
    noAgree.body?.code === 10001,
    'M2-① 未勾选协议（缺 agreementVersion）→ 10001，不入库',
    `code=${noAgree.body?.code} msg=${noAgree.body?.message}`,
  );

  const applied = await call('POST', '/leader/apply', {
    token: applicant.token,
    body: {
      buildingId: 1,
      phone: '13700000101',
      realName: 'e2e 公司 · 测试团长',
      floor: '9F',
      agreementVersion: 'v1.0',
    },
  });
  const leader = applied.body?.data?.leader;
  assert(
    applied.body?.code === 0 && applied.body?.data?.isLeader === true,
    'M2-① 勾选协议后提交即生效，接口直接返回 isLeader=true（C3 无审核）',
    `code=${applied.body?.code}`,
  );
  assert(
    leader?.level === 'trainee' && leader?.commissionRate === '0.0800',
    'C2 新团长默认见习 8%',
    `level=${leader?.level} rate=${leader?.commissionRate}`,
  );
  assert(
    leader?.floor === '9F' && leader?.buildingName === '国贸三期 A 座',
    '裁定② floor 与办公楼随申请落库并回显',
    `floor=${leader?.floor} building=${leader?.buildingName}`,
  );
  assert(
    leader?.agreeVersion === 'v1.0' && !!leader?.agreedAt,
    'C3 协议签署留痕（agreedAt + agreeVersion）',
    `version=${leader?.agreeVersion} at=${leader?.agreedAt}`,
  );

  // 身份立即生效：同一 token 再访问 /auth/me 与 /leader/profile
  const meAfter = await call('GET', '/auth/me', { token: applicant.token });
  assert(
    meAfter.body?.code === 0 && meAfter.body?.data?.isLeader === true,
    'M2-① 身份立即生效：/auth/me 的 isLeader=true（端上据此渲染 5 项 tabBar）',
    `isLeader=${meAfter.body?.data?.isLeader} leaderId=${meAfter.body?.data?.leader?.id}`,
  );

  const profileAfter = await call('GET', '/leader/profile', { token: applicant.token });
  assert(
    profileAfter.body?.code === 0 && profileAfter.body?.data?.floor === '9F',
    'M2-① 同 token 立刻可访问 /leader/profile（无需重新登录）',
    `floor=${profileAfter.body?.data?.floor}`,
  );

  const newUserId = applicant.userId;
  const userRow = readDb('SELECT building_id, team_leader_id FROM ab_user WHERE id = ?', [newUserId]);
  assert(
    Number(userRow?.building_id) === 1,
    'L10 申请团长后用户归属所服务办公楼（ab_user.building_id 同步）',
    `buildingId=${userRow?.building_id}`,
  );
  assert(
    userRow?.team_leader_id === null,
    'L10 自荐申请无邀请人 → ab_user.team_leader_id 保持 NULL',
    `teamLeaderId=${userRow?.team_leader_id}`,
  );

  const inviteRow = readDb(
    'SELECT inviter_leader_id, channel, invitee_leader_id, is_formal FROM ab_leader_invite WHERE invitee_user_id = ?',
    [newUserId],
  );
  assert(
    inviteRow?.channel === 'self' && inviteRow?.inviter_leader_id === null && !!inviteRow?.invitee_leader_id,
    'C3 推荐关系落库：channel=self / inviter=NULL / invitee_leader_id 已回填',
    `channel=${inviteRow?.channel} invitee=${inviteRow?.invitee_leader_id}`,
  );

  const leaderRow = readDb('SELECT floor, level, status FROM ab_team_leader WHERE user_id = ?', [
    newUserId,
  ]);
  assert(
    leaderRow?.floor === '9F' && leaderRow?.level === 'trainee' && Number(leaderRow?.status) === 1,
    '裁定① 团长在职判据 = status 1（tinyint），非字符串 active',
    `floor=${leaderRow?.floor} level=${leaderRow?.level} status=${leaderRow?.status}`,
  );

  // ==========================================================================
  // 2. 冲突与边界
  // ==========================================================================
  const again = await call('POST', '/leader/apply', {
    token: applicant.token,
    body: {
      buildingId: 1,
      phone: '13700000101',
      realName: 'e2e 公司 · 测试团长',
      floor: '9F',
      agreementVersion: 'v1.0',
    },
  });
  assert(again.body?.code === 20007, '重复申请返回 20007（你已是团长）', `code=${again.body?.code}`);

  const other = await login('dev:9102');
  const taken = await call('POST', '/leader/apply', {
    token: other.token,
    body: {
      buildingId: 2,
      phone: '13700000101', // 与上一位相同
      realName: 'e2e · 抢号者',
      floor: '3F',
      agreementVersion: 'v1.0',
    },
  });
  assert(
    taken.body?.code === 20004,
    '手机号已被其他团长占用 → 20004',
    `code=${taken.body?.code} msg=${taken.body?.message}`,
  );

  const badBuilding = await call('POST', '/leader/apply', {
    token: other.token,
    body: {
      buildingId: 999,
      phone: '13700000102',
      realName: 'e2e · 楼不存在',
      agreementVersion: 'v1.0',
    },
  });
  assert(
    badBuilding.body?.code === 10004,
    '办公楼不存在 → 10004',
    `code=${badBuilding.body?.code} msg=${badBuilding.body?.message}`,
  );

  const closedBuilding = await call('POST', '/leader/apply', {
    token: other.token,
    body: {
      buildingId: 3, // 国贸三期 C 座 · 种子「待开通」
      phone: '13700000103',
      realName: 'e2e · 未开通楼',
      agreementVersion: 'v1.0',
    },
  });
  assert(
    closedBuilding.body?.code === 10004,
    '办公楼未开通（status≠1）→ 10004 拒绝申请',
    `code=${closedBuilding.body?.code} msg=${closedBuilding.body?.message}`,
  );

  const badFloor = await call('POST', '/leader/apply', {
    token: other.token,
    body: {
      buildingId: 2,
      phone: 'not-a-phone',
      realName: 'e2e · 手机号非法',
      agreementVersion: 'v1.0',
    },
  });
  assert(badFloor.body?.code === 10001, '手机号格式非法 → 10001（DTO 白名单）', `code=${badFloor.body?.code}`);

  // ==========================================================================
  // 3. L16 等级规则 / L18 补签 / L15 改资料
  // ==========================================================================
  const rules = await call('GET', '/leader/level-rules', { token: applicant.token });
  const r = rules.body?.data;
  assert(
    rules.body?.code === 0 && r?.levels?.length === 4,
    'L16 返回 4 级佣金规则',
    `levels=${r?.levels?.length}`,
  );
  assert(
    r?.levels?.[0]?.key === 'trainee' && r?.levels?.[1]?.key === 'formal' && r?.levels?.[1]?.rate === 0.09,
    'L16 等级 key 与 DB / 契约一致（formal 9%），非 regular',
    `keys=${r?.levels?.map((x) => x.key).join(',')}`,
  );
  assert(
    r?.mine?.level === 'trainee' && r?.mine?.nextLevel === 'formal',
    'L16 mine 判见习、下一级正式',
    `level=${r?.mine?.level} next=${r?.mine?.nextLevel} progress=${r?.mine?.progress}`,
  );
  assert(!!r?.expireRule, 'L16 含见习 30 天失效规则文案', r?.expireRule);

  const sign = await call('POST', '/leader/agreement', {
    token: applicant.token,
    body: { agreementVersion: 'v1.1' },
  });
  assert(
    sign.body?.code === 0 && sign.body?.data?.agreeVersion === 'v1.1',
    'L18 协议补签 / 版本升级重签生效',
    `version=${sign.body?.data?.agreeVersion}`,
  );

  const updated = await call('PUT', '/leader/profile', {
    token: applicant.token,
    body: { floor: '10F' },
  });
  assert(
    updated.body?.code === 0 && updated.body?.data?.floor === '10F',
    'L15 修改楼层生效',
    `floor=${updated.body?.data?.floor}`,
  );

  const tryBuilding = await call('PUT', '/leader/profile', {
    token: applicant.token,
    body: { buildingId: 5 },
  });
  assert(
    tryBuilding.body?.code === 10001,
    'L15 办公楼变更本期不开放（DTO 白名单拒绝 buildingId → 10001）',
    `code=${tryBuilding.body?.code}`,
  );

  // ==========================================================================
  // 汇总
  // ==========================================================================
  // 连根回收（Windows 下 shell:true 只起一层 cmd.exe，必须 taskkill /T 才能收掉 ts-node）
  await stopApiServer(server, PORT);

  const failed = results.filter((x) => !x.pass);
  log('\n──────── 汇总 ────────');
  log(
    `通过 ${results.length - failed.length}/${results.length}` +
      (failed.length ? ` · 失败：${failed.map((f) => f.name).join(' | ')}` : ' · 全绿 ✅'),
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  log(`\n✘ E2E 异常：${e?.stack ?? e}`);
  process.exit(1);
});

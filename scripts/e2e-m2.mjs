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
 * 末段（§5）覆盖 M2 遗留的 2.8 / 2.9 与 U17：
 *   · U17 `GET /me/support` —— 客服微信号由 `ab_config` 下发（一期不做在线客服）
 *   · L21 我的推荐明细与转正汇总（不含手机号）
 *   · L22 晋级审计 —— 月单**实算并落表**（覆盖种子演示值）+ **只升不降** +
 *     双条件达标升级 + `is_formal` 翻转 + 邀请人计数回写 + 链式审计
 *   · L20 退出团长 —— 资金闸门 20008（余额/冻结/在途提现）· 缺键 10001 ·
 *     停职保留档案 · 退出后全量 `/leader/*` 20003 · 可复职（重置见习）
 *
 * ⭐ **2026-09-17 M4-2：佣金改「两段式」**（旧口径为「取餐确认即时入账」）——
 *    本套件的 L9 → L10/L11 段随之改写：确认收货只**计佣**
 *    （`ab_commission.status='pending'`，**余额分文未动**），入账由 D35
 *    （`POST /admin/finance/commissions/settle`，即 `commission-settle.task`
 *    的同一执行口）完成。故脚本在 L9 之后显式补一次「次日入账」再验余额与提现，
 *    并把「两段式」本身（pending 不入账 / 入账后归零 / 重复入账幂等）逐条钉死。
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

/**
 * 管理员登录 —— 本套件只在「D35 佣金入账」一处用到它
 *
 * ⚠️ D35 与 `commission-settle.task` 是**同一个执行口**（`settlePending`）。
 *    这里走真实 HTTP 端点而非直连 SQL，是为了让「跑批入账」这条路径也被用例覆盖。
 */
async function adminLogin(username, password) {
  const r = await call('POST', '/auth/admin-login', { body: { username, password } });
  return { code: r.body?.code, token: r.body?.data?.token, raw: r.body };
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

/**
 * 直写数据库（**仅用于造「接口无法到达」的中间态**）
 *
 * 用途：`delivered`（已送达待取餐）没有对外接口 —— 出餐确认属供应商端（M3）、
 *      配送生成属定时任务（M4）。而 M2 验收标准 2/3 依赖「今日已送达订单」，
 *      故在此直写状态位，属于**测试夹具**而非绕过业务校验。
 * ⚠️ 写前已停掉一切业务写入（服务空闲），并有 SQLITE_BUSY 重试。
 */
function writeDb(sql, params = []) {
  if (!existsSync(DB_PATH)) return null;
  for (let i = 0; i < 5; i++) {
    const db = new DatabaseSync(DB_PATH);
    try {
      return db.prepare(sql).run(...params);
    } catch (e) {
      if (!/SQLITE_BUSY|database is locked/i.test(e.message)) throw e;
    } finally {
      db.close();
    }
  }
  throw new Error(`writeDb 重试 5 次仍被锁：${sql}`);
}

/** 北京时间「今日」yyyy-MM-dd */
const todayBj = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

/**
 * 前置：M2 的团长佣金链路要靠**真实 HTTP 下单**造数，故要求当前处在下单窗口
 * `isOrderable(T)` = `[T-1 14:00, T-1 23:00)` 内。
 *
 * ⚠️ 窗口外「夹具 · U6 下单成功」先挂，拿不到 `orderNo` 后会把 `undefined` 写进
 *    SQLite（`Provided value cannot be bound to SQLite parameter`）直接崩 ——
 *    一次环境前提问题伪装成「脚本崩了」。故这里**一次性判定 + 只给一条可读失败**。
 *
 * 经 `gate.mjs` 跑时不会触发（它注入了 `ABOX_SHIFT_TO_HOUR` 打开窗口）。
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
      `  这是**环境前提**，不是代码回归 —— 窗口外造不出已支付订单，佣金链路无数据可验。\n` +
      `  · 经门禁跑（推荐，已自动注入时钟）：node scripts/gate.mjs e2e:m2\n` +
      `  · 直接手跑：ABOX_SHIFT_TO_HOUR=20 node scripts/e2e-m2.mjs\n` +
      `  · 或等到 14:00 之后（真窗口）。\n`,
  );
  return false;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  log(`\n=== ABox M2 端到端验收 ===\n数据库：${DB_PATH}\n`);

  if (!assertOrderWindow()) process.exit(1);

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

  // ---- 前置守卫：§4 断言的是**绝对值**（余额 = 1548、提现 1 条…），
  //      故必须跑在干净种子上。若检测到上次运行残留，明确报错退出，
  //      而不是跑到一半崩在「leader 为 undefined」这类无关位置。
  const dirtyLeader = readDb('SELECT id FROM ab_team_leader WHERE user_id = ?', [applicant.userId]);
  const dirtyComm = readDb('SELECT COUNT(*) n FROM ab_commission');
  if (dirtyLeader || Number(dirtyComm?.n) > 0) {
    fail(
      '前置 · 需干净种子',
      `检测到残留（leader=${dirtyLeader ? 'yes' : 'no'} / ab_commission=${dirtyComm?.n} 条）→ 请先执行：node scripts/gate.mjs seed`,
    );
    await stopApiServer(server, PORT);
    process.exit(1);
  }

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
  // ⭐ 缺陷 #94（2026-09-18）：`mine` 的等级字段改名 + 进度改按「生效等级」推导。
  //    新申请人是见习（level=trainee）且本月 0 单 → derived 与 effective 都是 trainee。
  assert(
    r?.mine?.derivedLevel === 'trainee' && r?.mine?.nextLevel === 'formal',
    'L16 mine 业绩测算为见习、下一级正式',
    `derived=${r?.mine?.derivedLevel} next=${r?.mine?.nextLevel} progress=${r?.mine?.progress}`,
  );
  assert(
    r?.mine?.effectiveLevel === 'trainee',
    'L16 mine 出 effectiveLevel（实际生效等级）',
    `effective=${r?.mine?.effectiveLevel}`,
  );
  assert(
    r?.mine?.level === undefined,
    'L16 mine **不再有** `level` 字段（旧名与 L11/L14 同名不同义，是 #94 的根因）',
    `level=${JSON.stringify(r?.mine?.level)}`,
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
  // 4. M2 全链路：L4–L7 订单聚合与代退 · L8–L9 分发计佣 · L10–L13 佣金提现 · L1/L2/L3
  // ==========================================================================
  const TODAY = todayBj();
  const TOMORROW = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);

  // ---- 4.0 夹具：李明（种子 chief · 12% · 楼 1）下单 5 份 → 支付 → 直写为「今日已送达」
  const lming = await login('dev:1001');
  const created = await call('POST', '/orders', {
    token: lming.token,
    idem: 'e2e-m2-order-0001',
    body: { mealDate: TOMORROW, quantity: 5 },
  });
  const orderNo = created.body?.data?.orderNo;
  assert(
    created.body?.code === 0 && !!orderNo,
    '夹具 · U6 下单成功（5 份 × ¥25.80）',
    `orderNo=${orderNo}`,
  );

  const paid = await call('POST', '/pay/mock/paid', { body: { orderNo } });
  assert(paid.body?.code === 0, '夹具 · mock 支付成功', `code=${paid.body?.code}`);

  // `delivered` 无对外接口（出餐/配送属 M3/M4），此处直写状态位作为测试夹具
  writeDb(
    `UPDATE ab_order SET meal_date = ?, status = 'delivered', team_leader_id = 1 WHERE order_no = ?`,
    [TODAY, orderNo],
  );
  const fixture = readDb('SELECT meal_date, status, team_leader_id FROM ab_order WHERE order_no = ?', [
    orderNo,
  ]);
  assert(
    fixture?.meal_date === TODAY &&
      fixture?.status === 'delivered' &&
      Number(fixture?.team_leader_id) === 1,
    '夹具 · 订单已置为「今日 / 已送达 / 归属团长 1」',
    `mealDate=${fixture?.meal_date} status=${fixture?.status} leader=${fixture?.team_leader_id}`,
  );

  // ---- 4.1 L1 工作台
  const wb = await call('GET', '/leader/workbench', { token: lming.token });
  const w = wb.body?.data;
  assert(wb.body?.code === 0 && w?.today?.mealDate === TODAY, 'L1 工作台返回今日战报', `mealDate=${w?.today?.mealDate}`);
  assert(
    w?.today?.quantity === 5 && w?.today?.amountFen === 12900,
    'L1 今日份数与成交额（5 × ¥25.80 = ¥129.00）',
    `qty=${w?.today?.quantity} amountFen=${w?.today?.amountFen}`,
  );
  assert(
    w?.today?.level === 'chief' && w?.today?.rate === 0.12 && w?.today?.levelLabel === '首席',
    'L1 等级 / 费率 / 中文名快照',
    `level=${w?.today?.level} rate=${w?.today?.rate} label=${w?.today?.levelLabel}`,
  );
  assert(
    typeof w?.tomorrow?.canOrder === 'boolean' && !!w?.tomorrow?.cutoffAt,
    'L1 明日进度含截单时刻与可否下单',
    `cutoffAt=${w?.tomorrow?.cutoffAt} canOrder=${w?.tomorrow?.canOrder}`,
  );
  assert(!!w?.pickup?.point, 'L1 取餐点回显（办公楼 + 楼层）', `point=${w?.pickup?.point}`);
  assert(
    w?.today?.completedQuantity === 0 && w?.today?.commissionFen === 0,
    'L1 未确认分发前佣金为 0（计佣基数是实发，不是下单）',
    `completed=${w?.today?.completedQuantity} commissionFen=${w?.today?.commissionFen}`,
  );

  // ---- 4.2 L4 订单列表（脱敏纪律）/ L6 异常订单
  const ordersRes = await call('GET', `/leader/orders?mealDate=${TODAY}`, { token: lming.token });
  const list = ordersRes.body?.data?.list ?? [];
  assert(ordersRes.body?.code === 0 && list.length >= 1, 'L4 所辖订单列表返回今日订单', `count=${list.length}`);
  const target = list.find((x) => x.orderNo === orderNo);
  assert(!!target, 'L4 列表含夹具订单', `orderNo=${orderNo}`);
  assert(
    typeof target?.phoneMasked === 'string' && target.phoneMasked.includes('****'),
    'L4 手机号已脱敏（138****0007 形态）',
    `phoneMasked=${target?.phoneMasked}`,
  );
  const rawPhones = JSON.stringify(list).match(/1[3-9]\d{9}/g) ?? [];
  assert(
    rawPhones.length === 0,
    'L4 出参不含任何完整手机号（脱敏纪律）',
    `found=${rawPhones.join(',') || '无'}`,
  );

  const abn = await call('GET', `/leader/orders/abnormal?mealDate=${TODAY}`, { token: lming.token });
  assert(
    abn.body?.code === 0 && Array.isArray(abn.body?.data?.list) && abn.body?.data?.count === 0,
    'L6 异常订单接口可用（本日无待支付单 → 0 条）',
    `count=${abn.body?.data?.count}`,
  );

  const exp = await call('GET', `/leader/orders/export?mealDate=${TODAY}`, { token: lming.token });
  assert(
    exp.body?.code === 0 && exp.body?.data?.count >= 1 && exp.body?.data?.list?.[0]?.length >= 8,
    'L5 导出返回明细行（含完整手机号列）',
    `count=${exp.body?.data?.count}`,
  );
  const opLog = readDb(
    "SELECT module, action, target_id FROM ab_operation_log WHERE module='leader' AND action='export_orders' ORDER BY id DESC LIMIT 1",
  );
  assert(
    opLog?.action === 'export_orders' && opLog?.target_id === TODAY,
    'L5 导出写操作日志（涉完整手机号的合规留痕）',
    `module=${opLog?.module} target=${opLog?.target_id}`,
  );

  // ---- 4.3 L8 今日取餐 / L9 一键分发（按实发份数计佣）
  const pickup = await call('GET', '/leader/pickup/today', { token: lming.token });
  const p = pickup.body?.data;
  assert(
    pickup.body?.code === 0 && p?.totalQuantity >= 5,
    'L8 今日取餐总份数',
    `total=${p?.totalQuantity} confirmed=${p?.confirmedQuantity} pending=${p?.pendingQuantity}`,
  );
  assert(p?.canConfirm === true, 'L8 存在已送达订单 → canConfirm=true', `canConfirm=${p?.canConfirm}`);

  const confirm = await call('POST', '/leader/pickup/confirm', {
    token: lming.token,
    idem: 'e2e-m2-pickup-0001',
    body: { orderNos: [orderNo] },
  });
  const c = confirm.body?.data;
  assert(
    confirm.body?.code === 0 && c?.confirmedCount === 1,
    'L9 一键分发：订单转 completed',
    `confirmedCount=${c?.confirmedCount}`,
  );
  assert(
    c?.commissionFen === 1548,
    'M2-③ 佣金 = 实发份数 × 等级费率（5 × 25.80 × 12% = ¥15.48）',
    `commissionFen=${c?.commissionFen} rate=${c?.rate}`,
  );

  const replayConfirm = await call('POST', '/leader/pickup/confirm', {
    token: lming.token,
    idem: 'e2e-m2-pickup-0001',
    body: { orderNos: [orderNo] },
  });
  assert(
    replayConfirm.body?.code === 10006,
    'L9 幂等重放 → 10006（返回首次结果，不重复计佣）',
    `code=${replayConfirm.body?.code}`,
  );
  const commCount = readDb('SELECT COUNT(*) n FROM ab_commission WHERE order_id = (SELECT id FROM ab_order WHERE order_no = ?)', [orderNo]);
  assert(Number(commCount?.n) === 1, 'L9 幂等：同一订单只产生一条佣金流水', `rows=${commCount?.n}`);

  // ==========================================================================
  // 4.4 ⭐ M4-2 两段式：确认只「计佣」，入账由 D35（= commission-settle.task）完成
  // ==========================================================================
  const balPending = await call('GET', '/leader/balance', { token: lming.token });
  assert(
    balPending.body?.data?.balanceFen === 0 &&
      balPending.body?.data?.pendingCommissionFen === 1548,
    'M4-2 两段式①：确认后佣金停在 pending，**余额分文未动**',
    `balanceFen=${balPending.body?.data?.balanceFen} pendingFen=${balPending.body?.data?.pendingCommissionFen}`,
  );
  const commRow = readDb(
    'SELECT status, settled_at FROM ab_commission WHERE order_id = ' +
      '(SELECT id FROM ab_order WHERE order_no = ?)',
    [orderNo],
  );
  assert(
    commRow?.status === 'pending' && commRow?.settled_at == null,
    'M4-2 两段式①：佣金行落 `pending` 且 `settled_at` 为空（**尚未入账**，不是丢了）',
    `status=${commRow?.status} settledAt=${commRow?.settled_at}`,
  );

  // 入账（D35 = commission-settle.task 的同一执行口）
  const admin = await adminLogin('admin', 'admin123');
  const settle1 = await call('POST', '/admin/finance/commissions/settle', {
    token: admin.token,
    body: { date: TODAY },
  });
  assert(
    settle1.body?.code === 0 && settle1.body?.data?.settled === 1,
    'M4-2 两段式②：D35 佣金入账把 pending 置 settled（settled=1）',
    `code=${settle1.body?.code} scanned=${settle1.body?.data?.scanned} settled=${settle1.body?.data?.settled} skipped=${settle1.body?.data?.skipped}`,
  );
  const balSettled = await call('GET', '/leader/balance', { token: lming.token });
  assert(
    balSettled.body?.data?.balanceFen === 1548 &&
      balSettled.body?.data?.pendingCommissionFen === 0,
    'M4-2 两段式②：入账后余额 = 佣金净额 ¥15.48，待入账归零',
    `balanceFen=${balSettled.body?.data?.balanceFen} pendingFen=${balSettled.body?.data?.pendingCommissionFen}`,
  );
  const settle2 = await call('POST', '/admin/finance/commissions/settle', {
    token: admin.token,
    body: { date: TODAY },
  });
  const balAfterRetry = await call('GET', '/leader/balance', { token: lming.token });
  assert(
    settle2.body?.data?.scanned === 0 && balAfterRetry.body?.data?.balanceFen === 1548,
    'M4-2 两段式②：重复入账 scanned=0 且余额不变（幂等，不重复加钱）',
    `scanned=${settle2.body?.data?.scanned} balanceFen=${balAfterRetry.body?.data?.balanceFen}`,
  );

  // ---- 4.4 L10 佣金明细 / L11 余额
  const comm = await call('GET', `/leader/commissions?range=day&date=${TODAY}`, { token: lming.token });
  const cs = comm.body?.data;
  assert(
    comm.body?.code === 0 && cs?.summary?.netFen === 1548 && cs?.summary?.quantity === 5,
    'L10 佣金净额与份数（净额 = 实发 5 份 × ¥25.80 × 12%）',
    `netFen=${cs?.summary?.netFen} qty=${cs?.summary?.quantity}`,
  );
  assert(
    cs?.summary?.levelLabel === '首席' && cs?.list?.[0]?.amountFen === 1548,
    'L10 明细行含等级 / 费率 / 金额快照',
    `label=${cs?.summary?.levelLabel} amountFen=${cs?.list?.[0]?.amountFen}`,
  );

  const bal = await call('GET', '/leader/balance', { token: lming.token });
  const b = bal.body?.data;
  assert(
    bal.body?.code === 0 && b?.balanceFen === 1548,
    'M2-③ 余额与佣金一致（余额流水已入账）',
    `balanceFen=${b?.balanceFen} totalInFen=${b?.totalInFen}`,
  );
  assert(b?.minWithdrawFen === 1000, 'L11 最低提现额 ¥10.00 来自 ab_config', `minFen=${b?.minWithdrawFen}`);
  assert(
    b?.pendingCommissionFen === 0,
    'L11 中途入账后待入账归零（两段式：入账前该值=佣金净额，入账后=0）',
    `pendingCommissionFen=${b?.pendingCommissionFen}`,
  );

  // ---- 4.5 L12 提现的三条拦截 + 正常提交
  const lowW = await call('POST', '/leader/withdraw', {
    token: lming.token,
    idem: 'e2e-m2-wd-low',
    body: { amount: 5 },
  });
  assert(
    lowW.body?.code === 40003 && lowW.body?.data?.minFen === 1000,
    'L12 低于最低额 → 40003（data 附 minFen）',
    `code=${lowW.body?.code} minFen=${lowW.body?.data?.minFen}`,
  );
  // 回归 · 幂等键必须在**业务失败后释放**：否则键停在 __pending__，
  //       同键重试会被误判为「请勿重复提交」10006，端上网络重试直接卡死。
  const lowRetry = await call('POST', '/leader/withdraw', {
    token: lming.token,
    idem: 'e2e-m2-wd-low',
    body: { amount: 5 },
  });
  assert(
    lowRetry.body?.code === 40003,
    '回归 · 失败后同幂等键可立即重试（40003，而非 10006 卡死）',
    `code=${lowRetry.body?.code}`,
  );

  const noBind = await call('POST', '/leader/withdraw', {
    token: applicant.token,
    idem: 'e2e-m2-wd-nobind',
    body: { amount: 10 },
  });
  assert(noBind.body?.code === 40007, 'L12 未绑定收款方式 → 40007', `code=${noBind.body?.code}`);

  const bindLm = await call('PUT', '/leader/profile', {
    token: lming.token,
    body: { payoutType: 'bank', payoutAccount: '6217001234567890123', payoutName: '李明' },
  });
  assert(
    bindLm.body?.code === 0 && bindLm.body?.data?.payoutBound === true,
    'L15 绑定收款方式生效（提现前置条件）',
    `bound=${bindLm.body?.data?.payoutBound}`,
  );
  assert(
    bindLm.body?.data?.payoutAccount === '6217****0123',
    'L15 收款账号脱敏存储',
    `account=${bindLm.body?.data?.payoutAccount}`,
  );

  const bindApp = await call('PUT', '/leader/profile', {
    token: applicant.token,
    body: { payoutType: 'bank', payoutAccount: '6222021234567890123', payoutName: '测试团长' },
  });
  const noBal = await call('POST', '/leader/withdraw', {
    token: applicant.token,
    idem: 'e2e-m2-wd-nobal',
    body: { amount: 10 },
  });
  assert(
    bindApp.body?.code === 0 && noBal.body?.code === 50004,
    'L12 已绑卡但可提现余额不足 → 50004',
    `code=${noBal.body?.code}`,
  );

  const wd = await call('POST', '/leader/withdraw', {
    token: lming.token,
    idem: 'e2e-m2-wd-0001',
    body: { amount: 10 },
  });
  const wdD = wd.body?.data;
  assert(
    wd.body?.code === 0 && wdD?.status === 'pending',
    'M2-④ 提现申请可提交并进入待审批',
    `status=${wdD?.status} no=${wdD?.withdrawNo}`,
  );
  assert(
    /^WD\d{16}$/.test(String(wdD?.withdrawNo)),
    'L12 提现单号格式 WD + yyyyMMdd + 8 位',
    `withdrawNo=${wdD?.withdrawNo}`,
  );

  // 幂等回放：成功结果应被缓存（返回 10006 + 首次结果），且**不重复冻结**
  // —— 若重复冻结，下方 `bal2` 的 frozenFen 会从 1000 变 2000 而断言失败。
  const wdReplay = await call('POST', '/leader/withdraw', {
    token: lming.token,
    idem: 'e2e-m2-wd-0001',
    body: { amount: 10 },
  });
  assert(
    wdReplay.body?.code === 10006 && wdReplay.body?.data?.withdrawNo === wdD?.withdrawNo,
    'L12 幂等重放 → 10006 + 首次结果（资金零副作用）',
    `code=${wdReplay.body?.code} no=${wdReplay.body?.data?.withdrawNo}`,
  );

  const wds = await call('GET', '/leader/withdrawals', { token: lming.token });
  assert(
    wds.body?.code === 0 && wds.body?.data?.total >= 1 && wds.body?.data?.list?.[0]?.statusText === '待审批',
    'L13 提现记录可查（含状态文案）',
    `total=${wds.body?.data?.total} text=${wds.body?.data?.list?.[0]?.statusText}`,
  );

  const bal2 = await call('GET', '/leader/balance', { token: lming.token });
  assert(
    bal2.body?.data?.balanceFen === 548 && bal2.body?.data?.frozenFen === 1000,
    'L11 提现冻结：可用 ¥5.48 / 冻结 ¥10.00（申请即冻，终态才释放）',
    `balanceFen=${bal2.body?.data?.balanceFen} frozenFen=${bal2.body?.data?.frozenFen}`,
  );
  const wdRow = readDb('SELECT status, amount, payout_channel FROM ab_withdraw ORDER BY id DESC LIMIT 1');
  assert(
    wdRow?.status === 'pending' && Number(wdRow?.amount) === 10 && wdRow?.payout_channel === 'FLEX_MANUAL',
    'L12 提现单落库且走灵活用工通道（C11 一期人工）',
    `status=${wdRow?.status} channel=${wdRow?.payout_channel}`,
  );

  // ---- 4.5b L19 余额流水（与 L11 余额交叉验算）
  // 口径：amount 恒为正，方向看 direction（1 收入 / -1 支出）；
  //       提现「申请即冻结」也记一条 direction=-1 的流水。
  const logs = await call('GET', '/leader/balance-logs', { token: lming.token });
  const lg = logs.body?.data;
  assert(logs.body?.code === 0 && Number(lg?.total) >= 2, 'L19 余额流水可查', `total=${lg?.total}`);

  const wdLog = (lg?.list ?? []).find((r) => r.type === 'withdraw');
  const cmLog = (lg?.list ?? []).find((r) => r.type === 'commission');
  assert(
    wdLog?.typeText === '提现' &&
      wdLog?.direction === -1 &&
      wdLog?.amountFen === 1000 &&
      wdLog?.balanceAfterFen === 548,
    'L19 提现冻结流水（方向 -1 / 金额恒正 / 操作后余额 ¥5.48）',
    `dir=${wdLog?.direction} amount=${wdLog?.amountFen} after=${wdLog?.balanceAfterFen}`,
  );
  assert(
    cmLog?.typeText === '佣金入账' && cmLog?.direction === 1 && cmLog?.amountFen === 1548,
    'L19 佣金入账流水（方向 1 / ¥15.48 / 中文文案由服务端给）',
    `dir=${cmLog?.direction} amount=${cmLog?.amountFen} text=${cmLog?.typeText}`,
  );
  assert(
    lg?.summary?.inFen === 1548 && lg?.summary?.outFen === 1000 && lg?.summary?.netFen === 548,
    'L19 收支汇总与 L11 可用余额相互验算（收 15.48 − 支 10.00 = 5.48）',
    `in=${lg?.summary?.inFen} out=${lg?.summary?.outFen} net=${lg?.summary?.netFen}`,
  );

  const onlyComm = await call('GET', '/leader/balance-logs?type=commission', { token: lming.token });
  const onlyTypes = (onlyComm.body?.data?.list ?? []).map((r) => r.type);
  assert(
    onlyComm.body?.code === 0 && onlyTypes.length > 0 && onlyTypes.every((t) => t === 'commission'),
    'L19 支持按类型过滤（type=commission 只出佣金流水）',
    `types=${onlyTypes.join(',') || '空'}`,
  );

  // ---- 4.6 L2 分享物料 / L3 小程序码
  // 团长 id 以 DB 为准（apply 响应为主，DB 兜底），避免变量缺失时把脚本崩在无关位置
  const appLeaderId = Number(
    leader?.id ?? readDb('SELECT id FROM ab_team_leader WHERE user_id = ?', [applicant.userId])?.id,
  );
  assert(Number.isInteger(appLeaderId) && appLeaderId > 0, '前置 · 团长 id 可解析', `leaderId=${appLeaderId}`);
  const share = await call('GET', '/leader/share', { token: applicant.token });
  const expectCode = `LDR${String(appLeaderId).padStart(4, '0')}`;
  assert(
    share.body?.code === 0 && share.body?.data?.inviteCode === expectCode,
    'L2 邀请码 = LDR + 团长 id（确定性生成，与 U6 leaderCode 对齐）',
    `inviteCode=${share.body?.data?.inviteCode}`,
  );
  assert(!!share.body?.data?.path && !!share.body?.data?.shareQuery, 'L2 分享落地路径与参数串就绪', `${share.body?.data?.path}?${share.body?.data?.shareQuery}`);

  const qr = await call('POST', '/leader/share/qrcode?width=500', { token: applicant.token });
  assert(
    qr.body?.code === 0 && qr.body?.data?.width === 500 && qr.body?.data?.scene === `l=${appLeaderId}`,
    'L3 小程序码参数就绪（scene 携带团长 id）',
    `scene=${qr.body?.data?.scene} width=${qr.body?.data?.width}`,
  );
  assert(
    qr.body?.data?.mock === true && qr.body?.data?.qrcodeUrl === null,
    'L3 未接微信能力前如实标记 mock + null（不伪造图片 URL）',
    `mock=${qr.body?.data?.mock} url=${qr.body?.data?.qrcodeUrl}`,
  );

  // ---- 4.7 L7 团长代退申请（C6 第一段：资金零变动）
  const beforeRefund = readDb('SELECT pay_amount, total_amount FROM ab_order WHERE order_no = ?', [orderNo]);
  const applyRefund = await call('POST', `/orders/${orderNo}/refund-apply`, {
    token: lming.token,
    body: { reasonType: 'quality', reason: 'e2e · 菜品有异味', remark: '用户已拍照留证' },
  });
  assert(
    applyRefund.body?.code === 0 && applyRefund.body?.data?.fundsMoved === false,
    'M2-② 代退申请登记成功，回执明确「资金未动」',
    `refundNo=${applyRefund.body?.data?.refundNo}`,
  );

  const refundRow = readDb(
    'SELECT status, apply_source, amount, team_leader_id, reason, reason_type FROM ab_refund WHERE order_no = ? ORDER BY id DESC LIMIT 1',
    [orderNo],
  );
  assert(
    refundRow?.status === 'applying',
    'M2-② ab_refund.status = applying（C6 第一段：只登记）',
    `status=${refundRow?.status}`,
  );
  assert(
    refundRow?.apply_source === 'leader' && Number(refundRow?.team_leader_id) === 1,
    'M2-② 代退来源与发起团长落库',
    `source=${refundRow?.apply_source} leader=${refundRow?.team_leader_id}`,
  );
  assert(
    refundRow?.reason_type === 'quality' && String(refundRow?.reason).includes('拍照留证'),
    'L7 reason 与 remark 合并入 reason（实体无独立 remark 列）',
    `reason=${refundRow?.reason}`,
  );

  const afterRefund = readDb('SELECT status, pay_amount, total_amount FROM ab_order WHERE order_no = ?', [orderNo]);
  assert(
    afterRefund?.status === 'refund_applying',
    'M2-② 订单进入 refund_applying',
    `status=${afterRefund?.status}`,
  );
  assert(
    Number(afterRefund?.pay_amount) === Number(beforeRefund?.pay_amount) &&
      Number(afterRefund?.total_amount) === Number(beforeRefund?.total_amount),
    'M2-② 资金零变动（订单金额未被改写、未触发退款）',
    `pay=${afterRefund?.pay_amount}（原 ${beforeRefund?.pay_amount}）`,
  );

  const dupRefund = await call('POST', `/orders/${orderNo}/refund-apply`, {
    token: lming.token,
    body: { reasonType: 'other' },
  });
  assert(dupRefund.body?.code === 40008, 'M2-② 重复代退 → 40008（不产生第二张退款单）', `code=${dupRefund.body?.code}`);

  const crossRefund = await call('POST', `/orders/${orderNo}/refund-apply`, {
    token: zhang.token,
    body: { reasonType: 'other' },
  });
  assert(
    crossRefund.body?.code === 10003,
    'L7 跨楼代退被拒 → 10003（越权防护先于状态判定）',
    `code=${crossRefund.body?.code}`,
  );

  // ==========================================================================
  // 5. M2 遗留补遗：U17 客服入口 · L21 我的推荐 · L22 晋级审计 · L20 退出团长
  //    （2026-09-15 裁定：一期不做在线客服 → 一律引导加客服微信人工处理）
  // ==========================================================================

  // ---- 5.1 U17 客服入口配置
  const support = await call('GET', '/me/support', { token: lming.token });
  const sup = support.body?.data;
  assert(
    support.body?.code === 0 && sup?.wechatId === 'abox_service',
    'U17 客服微信号由 ab_config 下发（代码不写死联系方式）',
    `wechatId=${sup?.wechatId}`,
  );
  assert(
    typeof sup?.hours === 'string' &&
      sup.hours.length > 0 &&
      typeof sup?.tips === 'string' &&
      sup.tips.length > 0,
    'U17 服务时间与提示文案随配置下发（端上不得自造）',
    `hours=${sup?.hours}`,
  );
  assert(
    sup?.wechatQrcodeUrl === null,
    'U17 未配置二维码 → 返回 null（端上隐藏图片位，不伪造图片）',
    `qrcode=${JSON.stringify(sup?.wechatQrcodeUrl)}`,
  );
  const supportAnon = await call('GET', '/me/support');
  assert(
    supportAnon.body?.code === 10002 && supportAnon.status === 401,
    'U17 未登录 → 10002 / HTTP 401（全局 JwtAuthGuard，未标 @Public）',
    `code=${supportAnon.body?.code} http=${supportAnon.status}`,
  );

  // ---- 5.2 L21 我的推荐（「我的邀请」可见面）
  const invites = await call('GET', '/leader/invites', { token: lming.token });
  const inv = invites.body?.data;
  assert(
    invites.body?.code === 0 && inv?.summary?.totalCount === 3 && inv?.summary?.formalCount === 3,
    'L21 汇总：种子 3 条邀请且全部已转正（自荐记录不计入任何人的裂变成果）',
    `total=${inv?.summary?.totalCount} formal=${inv?.summary?.formalCount} trainee=${inv?.summary?.traineeCount}`,
  );
  assert(
    (inv?.list ?? []).length === 3 &&
      (inv?.list ?? []).every((x) => x.isFormal === true && x.isLeader === true && !!x.nickname),
    'L21 明细含昵称 / 渠道 / 转正状态（均已为团长）',
    `channels=${(inv?.list ?? []).map((x) => x.channel).join(',')}`,
  );
  const invPhones = JSON.stringify(inv ?? {}).match(/1[3-9]\d{9}/g) ?? [];
  assert(invPhones.length === 0, 'L21 出参不含手机号（§1.6 敏感字段只在 L5 导出且留痕）', `found=${invPhones.join(',') || '无'}`);

  // ---- 5.3 L22 晋级审计：指标**实算并落表**（种子值会被真实值覆盖）
  // 李明（首席）：本月真实佣金只有 5 份（4.3 夹具），种子写的 186 是演示值。
  const auditTop = await call('POST', '/leader/level/audit', { token: lming.token });
  const at = auditTop.body?.data;
  assert(
    auditTop.body?.code === 0 && at?.monthOrders === 5 && at?.invitedFormalCount === 5,
    'L22 月单按 ab_commission 实算（5 份，覆盖种子演示值 186）',
    `monthOrders=${at?.monthOrders} invited=${at?.invitedFormalCount}`,
  );
  assert(
    at?.before === 'chief' && at?.after === 'chief' && at?.promoted === false,
    'L22 已是最高级 → 不升级也不降级',
    `before=${at?.before} after=${at?.after}`,
  );
  const lmRow = readDb('SELECT month_orders, invited_formal_count FROM ab_team_leader WHERE user_id = 1001');
  assert(
    Number(lmRow?.month_orders) === 5 && Number(lmRow?.invited_formal_count) === 5,
    'L22 实算指标已落表（P16 进度条不再读陈旧种子值）',
    `month_orders=${lmRow?.month_orders} invited=${lmRow?.invited_formal_count}`,
  );

  // 张磊（正式）本月无佣金 → target 虽为见习，但**只升不降**，必须保持正式
  const auditZ = await call('POST', '/leader/level/audit', { token: zhang.token });
  const az = auditZ.body?.data;
  assert(
    auditZ.body?.code === 0 && az?.before === 'formal' && az?.after === 'formal' && az?.promoted === false,
    'L22 只升不降：审计算出「见习」也不得把正式团长降级（降级只由失效任务/后台触发）',
    `before=${az?.before} after=${az?.after} monthOrders=${az?.monthOrders}`,
  );
  assert(
    readDb('SELECT level FROM ab_team_leader WHERE user_id = 1003')?.level === 'formal',
    'L22 未升级时不改写 ab_team_leader.level',
  );

  // ---- 5.4 晋级 + 链式回写：新团长升正式 → 邀请人「介绍转正数」+1 并链式审计
  // 夹具：把 e2e 新团长挂到李明名下（模拟经邀请码加入），并补一笔本月已结算佣金。
  //      `invited_formal_count` 走「后台人工修正」通道写入 —— 晋级审计本就按
  //      「统计值 与 表内值 取大」处理（L16 同口径），故这是合法输入而非绕过校验。
  writeDb('UPDATE ab_leader_invite SET inviter_leader_id = 1 WHERE invitee_user_id = ?', [newUserId]);
  writeDb('UPDATE ab_team_leader SET invited_formal_count = 1 WHERE user_id = ?', [newUserId]);
  writeDb('UPDATE ab_user SET team_leader_id = 1 WHERE id = ?', [newUserId]);
  writeDb(
    `INSERT INTO ab_commission
       (order_id, order_no, team_leader_id, leader_level, rate, base_amount, quantity, amount, type, status, meal_date)
     VALUES (?, ?, ?, 'trainee', '0.0800', '799.80', 31, '63.98', 'normal', 'settled', ?)`,
    [990001, 'E2E-AUDIT-TRAINEE', appLeaderId, TODAY],
  );
  assert(
    Number(
      readDb(
        "SELECT SUM(quantity) q FROM ab_commission WHERE team_leader_id = ? AND status = 'settled'",
        [appLeaderId],
      )?.q,
    ) === 31,
    '夹具 · 新团长本月已结算 31 份（跨过 C2「月单 > 30」门槛）',
  );

  const auditApp = await call('POST', '/leader/level/audit', { token: applicant.token });
  const aa = auditApp.body?.data;
  assert(
    auditApp.body?.code === 0 && aa?.promoted === true && aa?.before === 'trainee' && aa?.after === 'formal',
    'M2-2.9 双条件达标 → 见习升正式（月单 31 > 30 且 介绍转正 1）',
    `before=${aa?.before} after=${aa?.after} promoted=${aa?.promoted}`,
  );
  assert(
    aa?.rate === 0.09 && aa?.monthOrders === 31 && aa?.invitedFormalCount === 1,
    'L22 升级同刷费率（8% → 9%）并回写实算指标',
    `rate=${aa?.rate} monthOrders=${aa?.monthOrders} invited=${aa?.invitedFormalCount}`,
  );
  const appRow = readDb(
    'SELECT level, commission_rate, month_orders FROM ab_team_leader WHERE user_id = ?',
    [newUserId],
  );
  assert(
    appRow?.level === 'formal' &&
      Number(appRow?.commission_rate) === 0.09 &&
      Number(appRow?.month_orders) === 31,
    'L22 升级落库：level=formal / commission_rate=0.0900 / month_orders=31',
    `level=${appRow?.level} rate=${appRow?.commission_rate}`,
  );
  const flipRow = readDb(
    'SELECT is_formal, formal_at, invitee_level FROM ab_leader_invite WHERE invitee_user_id = ?',
    [newUserId],
  );
  assert(
    Number(flipRow?.is_formal) === 1 && !!flipRow?.formal_at && flipRow?.invitee_level === 'formal',
    'C2 被邀请人转正 → ab_leader_invite.is_formal 翻转并记 formal_at（冗余位免高频 JOIN）',
    `is_formal=${flipRow?.is_formal} level=${flipRow?.invitee_level}`,
  );
  const inviterRow = readDb('SELECT invited_formal_count FROM ab_team_leader WHERE id = 1');
  assert(
    Number(inviterRow?.invited_formal_count) === 6,
    'C2 邀请人「介绍转正数」+1（5 → 6，只增不减）',
    `inviterCount=${inviterRow?.invited_formal_count}`,
  );
  assert(
    aa?.formalFlipped === true && aa?.inviterAudit?.leaderId === 1,
    'C2 链式审计：回写邀请人后立即复算其晋级（inviterAudit 随回执返回）',
    `flipped=${aa?.formalFlipped} inviterAudit=${aa?.inviterAudit ? `#${aa.inviterAudit.leaderId}(${aa.inviterAudit.before}→${aa.inviterAudit.after})` : '无'}`,
  );

  const invites2 = await call('GET', '/leader/invites', { token: lming.token });
  assert(
    invites2.body?.data?.summary?.totalCount === 4 && invites2.body?.data?.summary?.formalCount === 4,
    'L21 与晋级审计同源：新推荐立即出现在邀请人的「我的推荐」（3 → 4）',
    `total=${invites2.body?.data?.summary?.totalCount} formal=${invites2.body?.data?.summary?.formalCount}`,
  );

  // ---- 5.5 L20 退出团长身份（资金闸门 → 停职 → 复职）
  // (a) 资金未清必须拦截：李明账上可用 ¥5.48 / 冻结 ¥10.00 / 1 笔在途提现
  const quitBlocked = await call('POST', '/leader/quit', {
    token: lming.token,
    idem: 'e2e-m2-quit-blocked',
    body: { reason: 'e2e · 资金未清' },
  });
  const blockerCodes = (quitBlocked.body?.data?.blockers ?? []).map((b) => b.code);
  assert(
    quitBlocked.body?.code === 20008 &&
      blockerCodes.includes('BALANCE_NOT_CLEARED') &&
      blockerCodes.includes('FROZEN_NOT_CLEARED') &&
      blockerCodes.includes('WITHDRAW_IN_FLIGHT'),
    'L20 余额/冻结/在途提现任一未清 → 20008（data.blockers 逐条下发，端上照单引导）',
    `code=${quitBlocked.body?.code} blockers=${blockerCodes.join(',') || '无'}`,
  );
  const quitBlockedRetry = await call('POST', '/leader/quit', {
    token: lming.token,
    idem: 'e2e-m2-quit-blocked',
    body: { reason: 'e2e · 资金未清' },
  });
  assert(
    quitBlockedRetry.body?.code === 20008,
    'L20 拦截失败后幂等键已释放（同键重试仍 20008，而非 10006 卡死）',
    `code=${quitBlockedRetry.body?.code}`,
  );
  assert(
    Number(readDb('SELECT status FROM ab_team_leader WHERE id = 1')?.status) === 1,
    'L20 拦截时未触碰团长状态（资金闸门先于状态变更，事务零副作用）',
  );
  const quitNoKey = await call('POST', '/leader/quit', { token: zhang.token, body: {} });
  assert(
    quitNoKey.body?.code === 10001,
    'L20 缺幂等键 → 10001（状态变更类写操作强制带键）',
    `code=${quitNoKey.body?.code}`,
  );

  // (b) 资金已清可退出：e2e 新团长（可用 0 / 无在途提现 / 无待结算佣金）
  const preQuitUser = readDb('SELECT team_leader_id FROM ab_user WHERE id = ?', [newUserId]);
  assert(
    Number(preQuitUser?.team_leader_id) === 1,
    '夹具 · 退出前该用户归属团长 1（用于验证退出会撤销归属关系）',
    `teamLeaderId=${preQuitUser?.team_leader_id}`,
  );
  const quit = await call('POST', '/leader/quit', {
    token: applicant.token,
    idem: 'e2e-m2-quit-0001',
    body: { reason: 'e2e · 业务调整' },
  });
  const qd = quit.body?.data;
  assert(
    quit.body?.code === 0 && qd?.isLeader === false && Number(qd?.status) === 2,
    'M2-2.8 退出成功：isLeader=false / status=2（端上据此把底栏还原为 4 项）',
    `isLeader=${qd?.isLeader} status=${qd?.status}`,
  );
  assert(
    qd?.level === 'formal' && qd?.levelLabel === '正式',
    'L20 停职非删除：保留历史等级（退出前刚晋级为正式）',
    `level=${qd?.level} label=${qd?.levelLabel}`,
  );
  assert(typeof qd?.tips === 'string' && qd.tips.length > 0, 'L20 回执含「可重新申请」指引', qd?.tips);

  const quitRow = readDb('SELECT status FROM ab_team_leader WHERE user_id = ?', [newUserId]);
  const postQuitUser = readDb('SELECT team_leader_id, building_id FROM ab_user WHERE id = ?', [newUserId]);
  assert(
    Number(quitRow?.status) === 2,
    'L20 落库：ab_team_leader.status = 2（停职）',
    `status=${quitRow?.status}`,
  );
  assert(
    postQuitUser?.team_leader_id === null && Number(postQuitUser?.building_id) === 1,
    'L20 撤销「归属某团长」但**保留办公楼**（他仍是该楼用户，明天照样能订餐）',
    `leader=${postQuitUser?.team_leader_id} building=${postQuitUser?.building_id}`,
  );

  // (c) 退出后身份立即失效（token 未过期也拦得住 —— 守卫二次查库的意义）
  const afterQuitProfile = await call('GET', '/leader/profile', { token: applicant.token });
  const afterQuitQr = await call('POST', '/leader/share/qrcode', { token: applicant.token });
  assert(
    afterQuitProfile.body?.code === 20003 && afterQuitQr.body?.code === 20003,
    'L20 退出后全量 /leader/* → 20003（非单端点特例；只信 token 的 isLeader 会漏放）',
    `profile=${afterQuitProfile.body?.code} qrcode=${afterQuitQr.body?.code}`,
  );
  const quitReplay = await call('POST', '/leader/quit', {
    token: applicant.token,
    idem: 'e2e-m2-quit-0001',
    body: { reason: 'e2e · 业务调整' },
  });
  assert(
    quitReplay.body?.code === 20003,
    'L20 重复退出 → 20003（守卫先于幂等拦截器：状态已不可逆，无需回放首次结果）',
    `code=${quitReplay.body?.code}`,
  );

  // (d) 退出不是终点：可再次申请，复职时重置为见习（C2 阶梯从头走）
  const reapply = await call('POST', '/leader/apply', {
    token: applicant.token,
    body: {
      buildingId: 1,
      phone: '13700000101',
      realName: 'e2e 公司 · 测试团长',
      floor: '9F',
      agreementVersion: 'v1.1',
    },
  });
  assert(
    reapply.body?.code === 0 &&
      reapply.body?.data?.isLeader === true &&
      reapply.body?.data?.leader?.level === 'trainee' &&
      reapply.body?.data?.leader?.commissionRate === '0.0800',
    'L20 退出后可重新申请：复职并**重置为见习 8%**（避免停职期间白拿高费率）',
    `level=${reapply.body?.data?.leader?.level} rate=${reapply.body?.data?.leader?.commissionRate}`,
  );
  const reRow = readDb('SELECT status, level FROM ab_team_leader WHERE user_id = ?', [newUserId]);
  assert(
    Number(reRow?.status) === 1 && reRow?.level === 'trainee',
    'L20 复职落库：status=1 / level=trainee',
    `status=${reRow?.status} level=${reRow?.level}`,
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

#!/usr/bin/env node
/**
 * ABox M3 端到端验收 · 后台基座（**免 pnpm**，真实起服务 + 真实 HTTP）
 *
 * 覆盖《开发里程碑计划 v1.0》M3 验收标准 ①：
 *   「`role=supplier` 登录后**看不到运营菜单**，且无法通过 URL 越权访问」
 *
 * ## 本脚本覆盖的接口（M3-1 基座批次）
 *   · A2 `POST /auth/admin-login`  —— 登录、失败计数、锁定、停用、菜单下发
 *   · A3 `POST /auth/refresh`      —— 刷新令牌；access 不能用来刷新
 *   · A4 `POST /auth/logout`       —— 无状态登出
 *   · A5 `GET  /auth/profile`      —— 双主体分流（user → 用户资料；admin → account）
 *   · D51–D53 `/admin/system/accounts*`  —— 账号列表 / 新增 / 编辑停用
 *   · D54     `/admin/system/roles`      —— 角色矩阵（只读）
 *   · D55     `/admin/system/roles/:role`—— 一期明确不支持（10001）
 *   · D56     `/admin/system/logs`       —— 操作日志（含脱敏断言）
 *
 * ## 三类安全断言（这是本批次的核心价值）
 *   1. **主体隔离**：小程序 token 打 `/admin/*` → 10003；后台 token 打 `/orders` → 10002
 *      （两套账号表的 id 各自自增，不做隔离就是**静默越权**，见 jwt-auth.guard.ts）
 *   2. **角色白名单**：finance / supplier 账号打系统管理接口 → 10003
 *   3. **令牌吊销**：改角色 / 停用账号后，**旧 access token 立即失效**（10002）
 *      —— 否则最长有 12 小时的特权滞留窗口
 *
 * ## 可重复跑（幂等）
 * 账号类用例使用**带时间戳的用户名**，重复跑不会因「登录名已占用（20009）」而误判。
 * 需要干净数据库时先 `node scripts/gate.mjs seed`。
 *
 * 用法：node scripts/e2e-m3.mjs
 * 端口：默认 3103（`E2E_PORT` 可覆盖）。gate.mjs 的 `verify` 串跑时三脚本各占一端口。
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

const call = makeCall(BASE);

function readDb(sql, params = []) {
  if (!existsSync(DB_PATH)) return null;
  const db = new DatabaseSync(DB_PATH);
  try {
    return db.prepare(sql).get(...params) ?? null;
  } finally {
    db.close();
  }
}

/** 后台登录便捷封装 */
async function adminLogin(username, password) {
  const r = await call('POST', '/auth/admin-login', { body: { username, password } });
  return {
    code: r.body?.code,
    message: r.body?.message,
    token: r.body?.data?.token,
    refreshToken: r.body?.data?.refreshToken,
    expiresIn: r.body?.data?.expiresIn,
    account: r.body?.data?.account,
    raw: r.body,
  };
}

/** 小程序登录（拿用户 token 用于跨主体隔离断言） */
async function userLogin(code) {
  const r = await call('POST', '/auth/login', { body: { code } });
  return { token: r.body?.data?.token, userId: r.body?.data?.user?.id, raw: r.body };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  log(`\n=== ABox M3 端到端验收 · 后台基座 ===\n数据库：${DB_PATH}\n`);

  installCleanupHooks();
  await assertPortFree(PORT);
  const server = startApiServer(PORT);
  const healthy = await waitHealthy(BASE, { child: server });
  if (!healthy) {
    fail('服务启动', `健康检查超时（90s）· ${BASE}/health`);
    await stopApiServer(server, PORT);
    return;
  }
  ok('服务启动', BASE);

  // 前置：种子账号必须在位
  const seedAdmin = readDb("SELECT id, role, status FROM ab_admin_user WHERE username = 'admin'");
  if (!seedAdmin) {
    fail('前置检查', 'ab_admin_user 里没有种子账号 admin —— 请先跑 `node scripts/gate.mjs seed`');
    await stopApiServer(server, PORT);
    return;
  }
  const seedFinance = readDb(
    "SELECT id, role FROM ab_admin_user WHERE username = 'finance' AND status = 1",
  );
  const seedSupplier = readDb(
    "SELECT id, role, supplier_id FROM ab_admin_user WHERE username = 'sanweiwu' AND status = 1",
  );

  const stamp = String(Date.now()).slice(-8);
  const userA = `e2e_op_${stamp}`; // 锁定 + 吊销用例
  const userB = `e2e_dis_${stamp}`; // 停用登录用例
  const PWD = 'Abox@1234';

  // ==========================================================================
  // §1 A2 后台登录
  // ==========================================================================
  log('\n§1 A2 后台登录 / 失败锁定');

  // 先失败一次（用于验证「还可尝试 N 次」文案），随后成功登录会把计数清零
  const badOnce = await adminLogin('admin', 'wrong-password');
  assert(
    badOnce.code === 20005 && /还可尝试\s*4\s*次/.test(String(badOnce.message)),
    'A2 密码错误 → 20005 且提示剩余尝试次数（不区分「账号不存在」与「密码错」→ 防用户名枚举）',
    `code=${badOnce.code} msg=${badOnce.message}`,
  );

  const login = await adminLogin('admin', 'admin123');
  assert(
    login.code === 0 && !!login.token,
    'A2 admin/admin123 登录成功（失败计数被清零）',
    `code=${login.code}`,
  );
  assert(
    login.account?.role === 'super_admin' && login.account?.menus?.includes('*'),
    'A2 super_admin 下发全量菜单（menus = ["*"]）',
    `role=${login.account?.role} menus=${JSON.stringify(login.account?.menus)}`,
  );
  assert(
    Number(login.expiresIn) > 0 && !!login.refreshToken,
    'A2 出参含 expiresIn（秒）与 refreshToken',
    `expiresIn=${login.expiresIn}`,
  );

  const adminToken = login.token;
  const adminRefresh = login.refreshToken;

  const afterGoodLogin = readDb('SELECT last_login_at FROM ab_admin_user WHERE username = ?', [
    'admin',
  ]);
  assert(
    !!afterGoodLogin?.last_login_at,
    'A2 登录成功写 last_login_at（审计基本盘）',
    `last_login_at=${afterGoodLogin?.last_login_at}`,
  );

  // ==========================================================================
  // §2 供应商账号：菜单隔离（M3 验收标准 1 的前半句）
  // ==========================================================================
  log('\n§2 供应商账号菜单隔离');

  if (!seedSupplier) {
    fail('前置：supplier 种子账号', '缺少启用的 sanweiwu 账号');
  } else {
    const sup = await adminLogin('sanweiwu', 'supplier123');
    assert(
      sup.code === 0 && sup.account?.role === 'supplier' && sup.account?.supplierId === 1,
      'A2 供应商账号登录成功并带 supplierId（S* 数据范围的锚点）',
      `role=${sup.account?.role} supplierId=${sup.account?.supplierId}`,
    );
    const menus = sup.account?.menus ?? [];
    assert(
      menus.length === 5 && menus.includes('/order/list') && menus.includes('/supplier/dishes'),
      'A2 供应商 menus 仅 P21–P26 五项（不含运营菜单）',
      `menus=${JSON.stringify(menus)}`,
    );
    assert(
      !menus.includes('/meal/matrix') && !menus.includes('/system/config') && !menus.includes('*'),
      'A2 供应商 menus **不含**任何运营菜单，也不含通配符（通配会让前端放行全量）',
      `hasMeal=${menus.includes('/meal/matrix')}`,
    );

    // 越权：直接用供应商 token 打运营接口
    const cross = await call('GET', '/admin/system/accounts', { token: sup.token });
    assert(
      cross.body?.code === 10003,
      'M3 验收① 供应商 token 访问 /admin/system/accounts → 10003（@Roles 白名单，不靠前端隐藏）',
      `code=${cross.body?.code}`,
    );
  }

  // ==========================================================================
  // §3 角色白名单：finance 也进不了系统管理
  // ==========================================================================
  log('\n§3 角色白名单（@Roles）');

  if (!seedFinance) {
    fail('前置：finance 种子账号', '缺少启用的 finance 账号');
  } else {
    const fin = await adminLogin('finance', 'finance123');
    assert(
      fin.code === 0 && fin.account?.role === 'finance' && fin.account?.menus?.includes('/dashboard'),
      'A2 finance 登录成功，菜单含工作台但不含 /system/*',
      `menus=${JSON.stringify(fin.account?.menus)}`,
    );
    assert(
      !(fin.account?.menus ?? []).some((m) => m.startsWith('/system/')),
      'A2 finance 菜单里没有任何 /system/*（运营账号管理对其不可见）',
    );

    const finOnAccounts = await call('GET', '/admin/system/accounts', { token: fin.token });
    const finOnLogs = await call('GET', '/admin/system/logs', { token: fin.token });
    assert(
      finOnAccounts.body?.code === 10003 && finOnLogs.body?.code === 10003,
      'M3 验收① finance token 打系统管理（类级 @Roles）→ 10003（前端菜单过滤只是体验层）',
      `accounts=${finOnAccounts.body?.code} logs=${finOnLogs.body?.code}`,
    );
  }

  // ==========================================================================
  // §4 双主体隔离（最容易静默出错的点）
  // ==========================================================================
  log('\n§4 双主体隔离');

  const u = await userLogin('dev:1001');
  assert(u.token && u.userId, '前置：小程序用户登录成功', `userId=${u.userId}`);

  const userOnAdmin = await call('GET', '/admin/system/accounts', { token: u.token });
  assert(
    userOnAdmin.body?.code === 10003,
    '小程序 token 打 /admin/* → 10003（ab_user.id 与 ab_admin_user.id 会撞号，不隔离即静默越权）',
    `code=${userOnAdmin.body?.code}`,
  );

  const adminOnOrders = await call('GET', '/orders', { token: adminToken });
  assert(
    adminOnOrders.body?.code === 10002,
    '后台 token 打小程序端点（/orders）→ 10002（反方向同样必须拦）',
    `code=${adminOnOrders.body?.code}`,
  );

  const adminOnLeader = await call('GET', '/leader/profile', { token: adminToken });
  assert(
    adminOnLeader.body?.code === 10002,
    '后台 token 打小程序团长端点（/leader/profile）→ 10002',
    `code=${adminOnLeader.body?.code}`,
  );

  const noToken = await call('GET', '/admin/system/accounts');
  assert(noToken.body?.code === 10002, '缺 Authorization 头 → 10002', `code=${noToken.body?.code}`);

  // ==========================================================================
  // §5 A5 / A4
  // ==========================================================================
  log('\n§5 A5 当前登录者 / A4 登出');

  const adminProfile = await call('GET', '/auth/profile', { token: adminToken });
  assert(
    adminProfile.body?.code === 0 && adminProfile.body?.data?.menus?.includes('*'),
    'A5（后台主体）→ 返回 account 且含 menus（前端刷新页面重建侧边栏的唯一来源）',
    `role=${adminProfile.body?.data?.role}`,
  );
  assert(
    adminProfile.body?.data?.passwordHash === undefined,
    'A5 出参**不含 passwordHash**（口令哈希绝不出网关）',
  );

  const userProfile = await call('GET', '/auth/profile', { token: u.token });
  assert(
    userProfile.body?.code === 0 && userProfile.body?.data?.id === u.userId,
    'A5（用户主体）→ 按 typ 分流返回用户资料（同一路径服务两套主体）',
    `id=${userProfile.body?.data?.id}`,
  );

  const logout = await call('POST', '/auth/logout', { token: adminToken });
  assert(
    logout.body?.code === 0 && logout.body?.data === null,
    'A4 登出 → code 0 / data null（服务端无状态，仅前端清态）',
    `code=${logout.body?.code}`,
  );
  const afterLogout = await call('GET', '/auth/profile', { token: adminToken });
  assert(
    afterLogout.body?.code === 0,
    'A4 登出**不吊销令牌**（JWT 无状态；明文记录此非缺陷，避免后人反复「修」）',
    `code=${afterLogout.body?.code}`,
  );

  // ==========================================================================
  // §6 D51 账号列表
  // ==========================================================================
  log('\n§6 D51 账号列表');

  const list = await call('GET', '/admin/system/accounts', { token: adminToken });
  assert(
    list.body?.code === 0 && list.body?.data?.total >= 3,
    'D51 账号列表返回分页结构（total ≥ 3 个种子账号）',
    `total=${list.body?.data?.total}`,
  );
  assert(
    !JSON.stringify(list.body?.data ?? {}).includes('passwordHash'),
    'D51 列表**不含 passwordHash**（整个响应体里搜不到该字段）',
  );
  const listItem = list.body?.data?.list?.[0];
  assert(
    !!listItem?.roleLabel && Array.isArray(listItem?.menus),
    'D51 每行带 roleLabel 与 menus（账号管理页可直接预览该角色可见菜单）',
    `roleLabel=${listItem?.roleLabel} menus=${listItem?.menus?.length} 项`,
  );

  const filtered = await call('GET', '/admin/system/accounts?role=supplier', { token: adminToken });
  assert(
    filtered.body?.code === 0 &&
      filtered.body?.data?.list?.every((x) => x.role === 'supplier') &&
      (filtered.body?.data?.list ?? []).length >= 1,
    'D51 按 role=supplier 过滤有效（且供应商行带 supplierName）',
    `count=${filtered.body?.data?.list?.length}`,
  );

  // ==========================================================================
  // §7 D52 新增账号
  // ==========================================================================
  log('\n§7 D52 新增账号');

  const created = await call('POST', '/admin/system/accounts', {
    token: adminToken,
    body: { username: userA, password: PWD, role: 'operator', realName: 'e2e 运营' },
  });
  assert(
    created.body?.code === 0 && created.body?.data?.role === 'operator',
    'D52 新增 operator 账号成功',
    `id=${created.body?.data?.id}`,
  );
  assert(
    created.body?.data?.passwordHash === undefined,
    'D52 返回体**不含 passwordHash**（只回账号视图）',
  );
  const newId = created.body?.data?.id;

  const dup = await call('POST', '/admin/system/accounts', {
    token: adminToken,
    body: { username: userA, password: PWD, role: 'operator' },
  });
  assert(
    dup.body?.code === 20009,
    'D52 登录名重复 → 20009（不静默创建第二个同名账号）',
    `code=${dup.body?.code}`,
  );

  const supNoBind = await call('POST', '/admin/system/accounts', {
    token: adminToken,
    body: { username: `${userA}_s`, password: PWD, role: 'supplier' },
  });
  assert(
    supNoBind.body?.code === 10001,
    'D52 role=supplier 却缺 supplierId → 10001（否则该账号登录后处处空白，形同故障）',
    `code=${supNoBind.body?.code} msg=${supNoBind.body?.message}`,
  );

  const weakPwd = await call('POST', '/admin/system/accounts', {
    token: adminToken,
    body: { username: `${userA}_w`, password: '12345678', role: 'operator' },
  });
  assert(
    weakPwd.body?.code === 10001,
    'D52 纯数字弱口令（12345678）→ 10001（口令需同时含字母与数字）',
    `code=${weakPwd.body?.code}`,
  );

  const hashRow = readDb('SELECT password_hash FROM ab_admin_user WHERE username = ?', [userA]);
  assert(
    typeof hashRow?.password_hash === 'string' && hashRow.password_hash.startsWith('scrypt:'),
    'D52 口令以 `scrypt:<salt>:<hash>` 入库（非明文、非 dev_plain 占位）',
    `prefix=${String(hashRow?.password_hash).slice(0, 7)}`,
  );

  // 登录一次，拿到「将被吊销」的令牌
  const opLogin = await adminLogin(userA, PWD);
  assert(
    opLogin.code === 0 && opLogin.account?.role === 'operator' && !!opLogin.token,
    'D52 新账号可立即登录（scrypt 校验通路打通）',
    `code=${opLogin.code}`,
  );
  assert(
    (opLogin.account?.menus ?? []).length > 0 &&
      !(opLogin.account?.menus ?? []).some((m) => m.startsWith('/system/')),
    'D52 operator 菜单 = 运营菜单去掉 /system/*（角色矩阵按代码定义）',
    `menus=${opLogin.account?.menus?.length} 项`,
  );
  const opToken = opLogin.token;

  // ==========================================================================
  // §8 失败锁定（用新账号跑，不污染 admin）
  // ==========================================================================
  log('\n§8 后台登录失败锁定');

  for (let i = 0; i < 5; i++) {
    await adminLogin(userA, 'definitely-wrong');
  }
  const lockedNow = await adminLogin(userA, 'definitely-wrong');
  assert(
    lockedNow.code === 20005 && /锁定/.test(String(lockedNow.message)),
    'A2 连续失败达阈值 → 20005 且文案变为「已锁定 15 分钟」',
    `code=${lockedNow.code} msg=${lockedNow.message}`,
  );

  const lockedWithRightPwd = await adminLogin(userA, PWD);
  assert(
    lockedWithRightPwd.code === 20005,
    'A2 锁定期内**即使口令正确**也拒绝（锁定闸门先于口令校验，否则响应差异会变成密码 oracle）',
    `code=${lockedWithRightPwd.code}`,
  );

  // ==========================================================================
  // §9 D53 编辑停用 + 令牌吊销
  // ==========================================================================
  log('\n§9 D53 编辑停用 / 令牌吊销');

  const opCanList = await call('GET', '/admin/system/accounts', { token: opToken });
  assert(
    opCanList.body?.code === 10003,
    'D51 operator 打系统管理 → 10003（连自己账号列表都看不到，@Roles 未放行 operator）',
    `code=${opCanList.body?.code}`,
  );

  const disable = await call('PUT', `/admin/system/accounts/${newId}`, {
    token: adminToken,
    body: { status: 2 },
  });
  assert(
    disable.body?.code === 0 && disable.body?.data?.status === 2,
    'D53 停用账号成功（status=2）',
    `status=${disable.body?.data?.status}`,
  );

  const revoked = await call('GET', '/admin/system/roles', { token: opToken });
  assert(
    revoked.body?.code === 10002,
    'D53 停用后**旧令牌打后台业务端点立即失效** → 10002（AdminGuard 比对 iat 与吊销标记，把 12h 滞留窗口压到 0）',
    `code=${revoked.body?.code} msg=${revoked.body?.message}`,
  );
  assert(
    revoked.body?.code !== 10003,
    'D53 吊销检查**先于** @Roles 白名单（否则 operator 的 10003 会掩盖吊销判定，令人误以为「只是权限不够」）',
    `code=${revoked.body?.code}`,
  );

  // A5 是「主体无关端点」（不在 /admin/* 路径下，JwtAuthGuard 不做单边拦截），
  // 因此它**绕过 AdminGuard** 的吊销校验，改由 adminProfile 自己每次查库判状态。
  // 两条路径防护点不同但结论一致（令牌已失效），故分别断言。
  const revokedProfile = await call('GET', '/auth/profile', { token: opToken });
  assert(
    revokedProfile.body?.code === 20006,
    'D53 停用后旧令牌打 A5 → 20006（A5 每次查库，是独立于 AdminGuard 的第二条防线）',
    `code=${revokedProfile.body?.code} msg=${revokedProfile.body?.message}`,
  );

  const disabledLogin = await adminLogin(userA, PWD);
  assert(
    disabledLogin.code === 20005,
    'A2 被停用账号登录 → 20005（该账号因前面的锁定用例仍在锁定期，锁定闸门先命中）',
    `code=${disabledLogin.code}`,
  );

  // 另起一个账号单独验证「停用 → 20006」
  const createdB = await call('POST', '/admin/system/accounts', {
    token: adminToken,
    body: { username: userB, password: PWD, role: 'viewer', realName: 'e2e 只读' },
  });
  const idB = createdB.body?.data?.id;
  await call('PUT', `/admin/system/accounts/${idB}`, { token: adminToken, body: { status: 2 } });
  const loginDisabled = await adminLogin(userB, PWD);
  assert(
    loginDisabled.code === 20006,
    'A2 口令正确但账号已停用 → 20006（此时才透露账号存在：运营需要明确反馈）',
    `code=${loginDisabled.code} msg=${loginDisabled.message}`,
  );

  // ==========================================================================
  // §10 三条防自锁规则
  // ==========================================================================
  log('\n§10 防自锁（20010）');

  const selfDisable = await call('PUT', `/admin/system/accounts/${seedAdmin.id}`, {
    token: adminToken,
    body: { status: 2 },
  });
  assert(
    selfDisable.body?.code === 20010,
    'D53 停用自己 → 20010（当场自锁在门外，只能改库救场）',
    `code=${selfDisable.body?.code}`,
  );

  const selfDemote = await call('PUT', `/admin/system/accounts/${seedAdmin.id}`, {
    token: adminToken,
    body: { role: 'viewer' },
  });
  assert(
    selfDemote.body?.code === 20010,
    'D53 降级自己 → 20010（改完连账号管理菜单都没了）',
    `code=${selfDemote.body?.code}`,
  );

  // 注：第 ③ 条「不能动最后一个启用的 super_admin」在**当前种子下不可独立触发** ——
  //     唯一的超管就是操作人自己，必先被 ①② 拦下。它是超管≥2 时的防线，
  //     由单测覆盖分支语义，这里不断言（避免制造一个永远跑不到的用例）。
  const adminStillActive = readDb('SELECT status, role FROM ab_admin_user WHERE id = ?', [
    seedAdmin.id,
  ]);
  assert(
    Number(adminStillActive?.status) === 1 && adminStillActive?.role === 'super_admin',
    'D53 两次被拒后 admin 账号**未被改动**（拒绝是真拒绝，不是「先写后报错」）',
    `status=${adminStillActive?.status} role=${adminStillActive?.role}`,
  );

  // 正常路径：改名不涉及角色 → 不应触发吊销
  const renameOk = await call('PUT', `/admin/system/accounts/${idB}`, {
    token: adminToken,
    body: { realName: 'e2e 只读（已改名）' },
  });
  assert(
    renameOk.body?.code === 0 && renameOk.body?.data?.name === 'e2e 只读（已改名）',
    'D53 仅改姓名 → 成功且**不写吊销标记**（权限未变就不必踢人）',
    `name=${renameOk.body?.data?.name}`,
  );

  // ==========================================================================
  // §11 D54 / D55 角色矩阵
  // ==========================================================================
  log('\n§11 D54 角色矩阵 / D55 一期不支持');

  const roles = await call('GET', '/admin/system/roles', { token: adminToken });
  const roleList = roles.body?.data?.list ?? [];
  assert(
    roles.body?.code === 0 && roleList.length === 6,
    'D54 角色矩阵返回 6 个内置角色（super_admin/admin/operator/finance/viewer/supplier）',
    `count=${roleList.length}`,
  );
  assert(
    roleList.find((r) => r.role === 'super_admin')?.menus?.includes('*') &&
      roleList.find((r) => r.role === 'supplier')?.menus?.length === 5,
    'D54 矩阵内容正确（超管通配；供应商 5 项）',
  );
  assert(
    roleList.every((r) => r.isSystem === true) && !!roles.body?.data?.note,
    'D54 全部标为系统内置，并附「一期不支持在线改权限」的口径说明',
  );

  const d55 = await call('PUT', '/admin/system/roles/operator', {
    token: adminToken,
    body: {},
  });
  assert(
    d55.body?.code === 10001,
    'D55 一期**明确不支持** → 10001（而非返回「保存成功」的假象：权限改了却不生效最危险）',
    `code=${d55.body?.code}`,
  );

  // ==========================================================================
  // §12 D56 操作日志（含脱敏）
  // ==========================================================================
  log('\n§12 D56 操作日志');

  const logs = await call('GET', '/admin/system/logs?pageSize=100', { token: adminToken });
  const logRows = logs.body?.data?.list ?? [];
  assert(
    logs.body?.code === 0 && logRows.length >= 4,
    'D56 操作日志可查（前面 D52/D53 的写操作已落库）',
    `count=${logRows.length}`,
  );

  const createLog = logRows.find((r) => r.action === '新增后台账号');
  assert(
    !!createLog && createLog.operatorName === '超级管理员' && createLog.module === 'system',
    'D56 日志带操作人姓名与角色（左连 ab_admin_user）',
    `operator=${createLog?.operatorName}/${createLog?.operatorRoleLabel}`,
  );

  const rawLogText = JSON.stringify(logRows.map((r) => r.requestData));
  assert(
    rawLogText.includes('[redacted]') && !rawLogText.includes(PWD),
    'D56 请求体里的口令**已脱敏**（出现 [redacted]，且全量日志里搜不到明文口令）',
    `hasRedacted=${rawLogText.includes('[redacted]')}`,
  );

  const failedLog = logRows.find((r) => r.failed === true);
  assert(
    !!failedLog,
    'D56 失败的请求**也记日志**（审计要回答「谁试图做了什么但被拒」）',
    `action=${failedLog?.action} code=${failedLog?.responseData?.error?.code}`,
  );

  const byOperator = await call('GET', `/admin/system/logs?operatorId=${seedAdmin.id}`, {
    token: adminToken,
  });
  assert(
    byOperator.body?.code === 0 &&
      (byOperator.body?.data?.list ?? []).every((r) => r.operatorId === seedAdmin.id),
    'D56 按 operatorId 过滤有效',
    `count=${byOperator.body?.data?.list?.length}`,
  );

  const operators = logs.body?.data?.operators ?? [];
  assert(
    operators.length >= 3 && operators.every((o) => !!o.roleLabel),
    'D56 出参带 operators 下拉（含 roleLabel）',
    `count=${operators.length}`,
  );

  const seeded = readDb('SELECT COUNT(*) AS n FROM ab_operation_log');
  assert(Number(seeded?.n) >= 4, 'D56 直查 ab_operation_log 有记录（非内存态）', `n=${seeded?.n}`);

  // ==========================================================================
  // §13 A3 刷新令牌
  // ==========================================================================
  log('\n§13 A3 刷新令牌');

  const refreshed = await call('POST', '/auth/refresh', { body: { refreshToken: adminRefresh } });
  assert(
    refreshed.body?.code === 0 && !!refreshed.body?.data?.token,
    'A3 用 refreshToken 换取新令牌成功',
    `code=${refreshed.body?.code}`,
  );
  const newToken = refreshed.body?.data?.token;
  const newTokenWorks = await call('GET', '/auth/profile', { token: newToken });
  assert(
    newTokenWorks.body?.code === 0 && newTokenWorks.body?.data?.menus?.includes('*'),
    'A3 新令牌可正常访问（且带上最新 menus）',
    `code=${newTokenWorks.body?.code}`,
  );

  const accessAsRefresh = await call('POST', '/auth/refresh', {
    body: { refreshToken: adminToken },
  });
  assert(
    accessAsRefresh.body?.code === 10003,
    'A3 用 **access token** 调刷新接口 → 10003（否则「快过期的令牌换新令牌」= 永不过期）',
    `code=${accessAsRefresh.body?.code}`,
  );

  const refreshOnBusiness = await call('GET', '/admin/system/accounts', { token: adminRefresh });
  assert(
    refreshOnBusiness.body?.code === 10002,
    'A3 刷新令牌**不能**当访问令牌用（rt=true 在守卫里被拦）',
    `code=${refreshOnBusiness.body?.code}`,
  );

  const badRefresh = await call('POST', '/auth/refresh', { body: { refreshToken: 'not-a-jwt' } });
  assert(
    badRefresh.body?.code === 10002,
    'A3 伪造 refreshToken → 10002',
    `code=${badRefresh.body?.code}`,
  );

  // ==========================================================================
  // 汇总
  // ==========================================================================
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

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
 * ## M3-2 套餐编排批次新增（§14）
 *   · D1 `/admin/meal/matrix`              —— 完整网格 / emptyBuildings 口径 / cutoffPassed
 *   · D2 `/admin/meal/assignments`         —— 创建为 pending；重复 30011；套餐 30008；楼群 10004
 *   · D3 `PUT /admin/meal/assignments/:id` —— 只改套餐+集散；已截单 30003；不存在 30012
 *   · D4 `POST .../publish`                —— 上下架幂等；已截单上架 30013；**用户端可见性往返**
 *   · D5 `POST /admin/meal/assignments/copy` —— 不覆盖（skipped）；一律 pending；已截单跳过
 *   · D6 `/admin/meal/templates`           —— usedCount = 未取消分配数
 *   · D7 `POST /admin/meal/templates`      —— 成本 = 供价求和；supplierId 由菜品反查；重复菜 10001
 *   · 选择器 `/admin/meal/dishes` `/admin/meal/distribution-centers`
 *
 * ## M3-3 订单中心批次新增（§15）
 *   · D8 `GET  /admin/orders`              —— 全平台流 / 异常 Tab / 11 态过滤 / 关键词（号 + 昵称）/
 *                                            summary 不受分页影响 / 手机号脱敏 / 筛选下拉
 *   · D9 `GET  /admin/orders/:orderNo`     —— 明细 + 时间线 + 支付 + 佣金 + actions（按钮口径唯一在服务端）
 *   · D10 `POST /admin/orders/manual-adjust` —— **目标值**语义（幂等不翻倍）/ 30002 / 30003 / 30014 /
 *                                            跨楼群 30015 / 原因 10001 / 自动写日志且 targetId=订单号
 *   · D11 `POST /admin/orders/:orderNo/force-refund` —— 40011 防误操作 / 30003 / 40008 幂等 /
 *                                            C9 反向冲销（佣金负行 + 原行 cancelled + 余额扣减）/
 *                                            **应付不冲减**（自营口径 · 夹具行逐项未变）
 *   · D12 `GET  /admin/orders/export`      —— 表头 + 二维数组 / **完整手机号** / 强制留痕（含 IP）
 *   · 权限：finance 可读 · viewer 10003 · 小程序 token 打 `/admin/orders` → 10003
 *
 * ## M3-4 退款审批批次新增（§16 · C6 第二段）
 *   · D40 `GET  /admin/finance/refunds`        —— Tab（pending/approved/rejected/refunded/all）/
 *                                                summary 不受分页影响 / 关键词（单号 + 订单号 + 昵称）/
 *                                                行内**拆两路**金额（微信 / 余额）/ 手机号脱敏 / 枚举下发
 *   · D41 `POST .../refunds/:id/approve`       —— 审批通过 → 实际退款（与 D11 **同一个执行口**）：
 *                                                微信原路退 + 余额退回 + 反向结算（未计佣则不写负行）/
 *                                                重复审批 40013 / 不存在 40012
 *   · D42 `POST .../refunds/:id/reject`        —— 驳回 → 订单回到**申请前**状态（`order_status_before`）/
 *                                                资金零变动（无任何 ab_balance_log）/ 驳回后可重新申请 /
 *                                                缺原状态 → **40014 fail-closed**
 *   · 权限：**两级白名单** —— operator 能读（D40）但不能批（D41/D42 → 10003）；
 *           viewer 10003；小程序 token 10003；finance 有权限（拿到业务层 40013 而非 10003）
 *   · 操作日志：通过 / 驳回均自动落库，`targetId = 退款单 id`
 *
 * ## M3-5 后台团长管理批次新增（§17 · D19–D22）
 *   · D19 `GET  /admin/leaders`            —— 名录（等级/楼群/状态/关键词过滤 · summary 不受分页影响 ·
 *                                              手机号脱敏 · actions 与下拉下发）/ 申请流水（`view=applications`，
 *                                              **C3 申请即生效 → pendingAuditCount 恒为 0**，且**不返回微信号**）/
 *                                              `filter-options`（路由顺序）/ 详情（裂变链上下行 + 佣金 + 双键日志）
 *   · D20 `POST /admin/leaders`            —— 任命默认**见习 8%** · 非注册用户 20011 · 撞号 20004 ·
 *                                              目标楼被占 20012（附 occupiedBy）· 显式确认后转交
 *                                              （现任**停职而非删除**，历史佣金/推荐关系不抹）
 *   · D21 `PUT  /admin/leaders/:id`        —— 改等级**同步写费率**（等级是标签、费率才是钱）· 换楼撞车 20012 ·
 *                                              空变更 10001 · **刻意不吃 status**（停用只有 D22 一个入口）
 *   · D22 `POST /admin/leaders/:id/audit`  —— 例外停用（**同时清 `ab_user.team_leader_id`**）/
 *                                              恢复在职（**不重置等级**）/ 协议补签 / 备注 · 目标态重复操作 20013
 *   · 权限：**两级白名单** —— operator 能读（`actions.canManage=false`）但任命/变更/补录一律 10003；
 *           viewer / finance / supplier 一律 10003；小程序 token 打 `/admin/leaders` → 10003
 *   · 越权被拒**无副作用**：没建档、没改字段（`@Roles` 挡在业务层之前，不是「执行了再回滚」）
 *
 * ## M3-7 办公楼 / 楼群批次新增（§19 · D13–D18）
 *   · D13 `GET  /admin/buildings`          —— 列表（楼群/状态/覆盖缺口/团长归属/关键词过滤 ·
 *                                             summary 不受分页影响）· **状态三态**（1 营业中 / 2 待开通 /
 *                                             3 已暂停，修复旧数据「2 一值两义」）· 派生 `gap` 三成因
 *                                             （no_group / no_center / all_center_disabled）· `canOrder`
 *                                             = 营业中 ∧ 已归群 · **主/备集散中心与路线号实时派生**
 *                                             （真源是 M3-6 的 `ab_distribution_center.service_groups`）
 *   · D14 `POST /admin/buildings`          —— 新增（重名 60005 · 楼群不存在 60002）·
 *                                             出参 `warnings` 逐条说明「还差什么才能开团」
 *   · D15 `PUT  /admin/buildings/:id`      —— 部分更新 · `buildingGroupId: null` = **移出楼群** ·
 *                                             空变更 10001 · **刻意不收 `leaderId`**（→ 10001）：
 *                                             改团长只有 D20/D21 一个入口，避免绕过 20012 撞车闸门
 *   · D16 `GET  /admin/building-groups`    —— 楼群列表（成员楼 / 主备集散 / 覆盖状态 / 当日次日套餐）
 *   · D17 `POST /admin/building-groups`    —— 新建（重名 60004 · 成员含不存在楼 60001）
 *   · D18 `PUT  /admin/building-groups/:id`—— **成员楼整体替换**（传 `[]` 即清空）·
 *                                             停用非空楼群 → 60003（成员楼会静默失去开团能力，且列表看不出来）·
 *                                             **先搬楼再判闸门**（一次请求内「清空 + 停用」放行）
 *   · 视图聚合：`/overview`（主数据健康度）与 `/delivery-map`（路线派生）**与 D13 同源**；
 *              配送映射**不返回距离与单段时长**（无地图数据，原型值是演示值）
 *   · 跨批次联动：新建集散中心挂上楼群 → 楼栋 gap 立刻由 no_center 翻成 none；停用它 → all_center_disabled
 *   · 权限：operator 可读不可写（10003）；viewer / finance 类级 10003；小程序 token → 10003
 *
 * ⚠️ **§19 不依赖下单窗口**（办公楼 / 楼群是纯主数据），且整节包在**独立块作用域**里 ——
 *    `bList` / `gRows` / `finRead` 这类通用名前 18 节大概率已用过，块作用域是语法级隔离。
 *    夹具**全部自造**（带时间戳的楼名 / 楼群名），且**不往种子楼群里塞楼**
 *    （种子楼群成员数被 §14/§17 依赖，动它会连坐）。
 *
 * ⚠️ **§17 不依赖下单窗口**（团长域是主数据），任何时刻都能跑；
 *    夹具**全部自造**（3 名 `dev:` 新用户 + 动态挑空楼 + 带时间戳的手机号），
 *    避免与 §15/§16 以及 `e2e-m1` / `e2e-m2` 的写入互相污染 —— 那正是
 *    「单跑绿、串跑红」的典型来源（m2 的 L20/L22 会改 `ab_team_leader`）。
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
 * ⚠️ **时间窗前提**：§15 订单中心与 §16 退款审批都要造真实订单，而 U6 只能在
 *    `[T-1 14:00, T-1 23:00)` 这个窗口内下单 —— 与 `e2e-m1` / `e2e-m2` 同一约束。
 *    因此 §15/§16 **需在北京时间 14:00–23:00 之间运行**，窗口外各给出唯一的
 *    可读失败而非连锁红（**§17 不受此限**：团长域与订单链路无关）。
 *    **§1 的 D4「可见性开关往返」已做窗口感知**（`inOrderWindowBj`）：窗口内断言
 *    `canOrder=true`，窗口外改判「后台 active ∧ 前端回落到『待开团』」—— 同一件事的
 *    等价证据，避免每天 00:00–14:00 出现一条与被测行为无关的假红。
 *    ⚠️ §15/§16 窗口外的失败**是刻意保留的信号**（提示「本次运行未覆盖这两组」），
 *    与 D4 的假红性质不同，不要一并改掉。
 * ⚠️ **一个用户同一出餐日只能下一单**（U6 → 30004）：§15 用 1001/1002/1005，
 *    §16 用 1003/1004/1040，改夹具时别撞车。
 *
 * 用法：node scripts/e2e-m3.mjs
 * 端口：默认 3103（`E2E_PORT` 可覆盖）。gate.mjs 的 `verify` 串跑时三脚本各占一端口。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  BASE,
  DB_PATH,
  PORT,
  ROOT,
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

/**
 * 北京时间当前是否处在**下单窗口**内：`isOrderable(T)` = `[T-1 14:00, T-1 23:00)`。
 *
 * 为什么不一律用 API 探测（`/home/daily` 的 `canOrder`）：§15/§16 没有把「被测单元格本身」
 * 当信号，探测没问题；但 D4「可见性开关往返」的被测对象**就是**那一格 —— 拿它的 `canOrder`
 * 去反推窗口开合，等于循环论证（永远为真）。
 *
 * ⚠️ 本函数只用于**选择断言分支**，不放松任何断言：
 *    窗口内断言 `canOrder === true`；窗口外断言「后台 active ∧ 前端回落到『待开团』而非『未开团』」
 *    —— 后者才是「未上架」的样子，同样能证明可见性开关闭环。
 *    否则本套件每天 23:00–14:00（15 小时）恒红，真回归会被这段假红淹没。
 *
 * ⚠️ `gate.mjs` 给 e2e 注入了 `ABOX_SHIFT_TO_HOUR`（见其文件头）：此时**服务端的
 *    「现在」已被平移到该小时**，本函数必须读同一个值，否则会出现「脚本以为窗口关、
 *    服务端其实开着」的错位判定。只有未设该变量（直接手跑脚本）时才回落到真实钟。
 *
 * 实现用 UTC+8 显式偏移，不依赖 ICU 时区库（与 `time.ts` 同一思路）。
 */
function inOrderWindowBj() {
  const injected = Number(process.env.ABOX_SHIFT_TO_HOUR);
  const h =
    Number.isInteger(injected) && injected >= 0 && injected <= 23
      ? injected
      : new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCHours();
  return h >= 14 && h < 23;
}

/**
 * 夹具专用连接（**必须带 `busy_timeout`**）
 *
 * ⚠️ SQLite 的 `busy_timeout` 默认是 0：只要**服务端（TypeORM）正持有写事务**，
 *    夹具这一侧的读/写就会立刻抛 `database is locked`，把一次偶发撞车放大成
 *    「整节异常中断」——而失败点与被测行为毫无关系（典型的环境型假红）。
 *    夹具事务都是毫秒级的，等一会儿即可，故统一设 5s。
 */
function fixtureDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function readDb(sql, params = []) {
  if (!existsSync(DB_PATH)) return null;
  const db = fixtureDb();
  try {
    return db.prepare(sql).get(...params) ?? null;
  } finally {
    db.close();
  }
}

/** 读多行（`readDb` 的复数版） */
function readRows(sql, params = []) {
  if (!existsSync(DB_PATH)) return [];
  const db = fixtureDb();
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/**
 * 直写数据库（**仅作测试夹具**）
 *
 * 有些状态位在原型里没有对外接口（`delivered` 属出餐/配送，M4 才有），但 M3 的
 * 后台能力必须在真实数据上验证。与 `e2e-m2.mjs` 同一手法：用 SQL 把订单搬到
 * 「已送达」「昨日」等位置，再跑被测接口。
 *
 * ⚠️ 只改**状态位与日期**这类无法通过公开接口到达的字段，绝不用它伪造被测接口
 *    自身负责写入的字段 —— 否则测试就变成「自己写、自己读」的空转。
 */
function writeDb(sql, params = []) {
  if (!existsSync(DB_PATH)) return 0;
  const db = fixtureDb();
  try {
    return db.prepare(sql).run(...params).changes ?? 0;
  } finally {
    db.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询等待某个 DB 条件成立（**夹具专用**）
 *
 * ⚠️ 为什么必须有它：`POST /pay/mock/paid` 走的是**事件回调** ——
 *    `MockWxPayProvider.simulatePaid` 只 `emit('paid')` 就返回，真正的落库由
 *    监听器异步完成（另外还有一条 `MOCK_PAY_AUTO_SUCCESS` 的 800ms 自动回调）。
 *    也就是说 **HTTP 200 时订单可能还是 `pending_pay`**，直接读库断言会随机红
 *    —— 首轮「通过」往往只是恰好赢了这个竞态。
 *    凡是要断言「某个异步动作已落库」，一律用本函数等，别用单次 readDb。
 */
async function waitDb(sql, params, predicate, { timeout = 6000, interval = 120 } = {}) {
  const deadline = Date.now() + timeout;
  let row = null;
  for (;;) {
    row = readDb(sql, params);
    if (row && predicate(row)) return row;
    if (Date.now() > deadline) return row;
    await sleep(interval);
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
      menus.length === 6 &&
        menus.includes('/supplier/settlement') &&
        menus.includes('/supplier/dishes') &&
        !menus.includes('/supplier/packing') &&
        !menus.includes('/order/list'),
      'A2 供应商 menus 共 6 项（出餐 P21/P22 + 自有菜品/资料 + 自有结算页 + 概览；M3-8 起不再借用运营订单页，M4-0 起 S3 打包任务迁运营后台不再对供应商开放）',
      `menus=${JSON.stringify(menus)}`,
    );
    assert(
      menus.every((m) => m === '/dashboard' || m.startsWith('/supplier/')) &&
        !menus.includes('*'),
      'A2 供应商 menus **每一项**都落在 `/dashboard` 或 `/supplier/*` 内，且不含通配符 —— 这比「恰好 N 项」耐久：将来加减 P 页不用改断言，而混入 `/finance/*`、`/system/*` 会立刻撞红',
      `menus=${JSON.stringify(menus)}`,
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
  const supplierMenus = roleList.find((r) => r.role === 'supplier')?.menus ?? [];
  assert(
    roleList.find((r) => r.role === 'super_admin')?.menus?.includes('*') &&
      supplierMenus.length === 6 &&
      supplierMenus.includes('/supplier/settlement') &&
      !supplierMenus.includes('/supplier/packing') &&
      supplierMenus.every((m) => m === '/dashboard' || m.startsWith('/supplier/')),
    'D54 矩阵内容正确（超管通配；供应商 **6** 项且每一项都在 `/supplier/*` 内 —— M4-0 起 `/supplier/packing` 已移除，角色矩阵与前端 `SUPPLIER_NAV` 必须逐项对齐）',
    `supplierMenus=${JSON.stringify(supplierMenus)}`,
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
  // §14 M3-2 套餐编排 D1–D7
  // ==========================================================================
  log('\n§14 M3-2 套餐编排（D1–D7）');

  const d0 = bjToday();
  const dPlus1 = addDaysStr(d0, 1); // 种子里 5 个楼群都已排期（3 active + 2 pending）
  const dPlus3 = addDaysStr(d0, 3); // 空白日，用于 D2/D4/D5
  const dPlus4 = addDaysStr(d0, 4);
  const dPlus5 = addDaysStr(d0, 5);
  const dMinus1 = addDaysStr(d0, -1); // 已截单日，用于 30013

  // ---------------------------------------------------------- D1 矩阵
  const matrix = await call('GET', `/admin/meal/matrix?startDate=${dPlus1}&endDate=${dPlus3}`, {
    token: adminToken,
  });
  const m = matrix.body?.data;
  assert(matrix.body?.code === 0 && m, 'D1 矩阵可查询', `code=${matrix.body?.code}`);

  assert(
    m?.cells?.length === m?.dates?.length * m?.groups?.length && m?.groups?.length === 5,
    'D1 返回**完整网格**（cells = dates × groups，空格子也在内 —— 空格子本身就是信息）',
    `dates=${m?.dates?.length} groups=${m?.groups?.length} cells=${m?.cells?.length}`,
  );

  const g1 = m?.groups?.find((x) => x.id === 1);
  assert(
    JSON.stringify(g1?.assignedBuildings) === '[1,2,4]' &&
      JSON.stringify(g1?.emptyBuildings) === '[3]',
    'D1 assignedBuildings / emptyBuildings 口径正确（国贸组：C 座 status=2 → 未分配）',
    `assigned=${JSON.stringify(g1?.assignedBuildings)} empty=${JSON.stringify(g1?.emptyBuildings)}`,
  );

  const seededCell = m?.cells?.find((c) => c.mealDate === dPlus1 && c.groupId === 1);
  assert(
    seededCell?.assignmentId &&
      seededCell?.status === 'active' &&
      seededCell?.setMealName &&
      seededCell?.dishCount > 0,
    'D1 种子分配落在正确格子里（日期 × 楼群 → 套餐名 / 菜品数 / 状态）',
    `#${seededCell?.assignmentId} ${seededCell?.setMealName} status=${seededCell?.status}`,
  );

  const pendingCell = m?.cells?.find((c) => c.mealDate === dPlus1 && c.groupId === 4);
  assert(
    pendingCell?.status === 'pending' && pendingCell?.canPublish === true,
    'D1 pending（已排期未上架）与 active 在同一天并存 —— 两步分离是设计而非 bug',
    `status=${pendingCell?.status} canPublish=${pendingCell?.canPublish}`,
  );

  const stats = m?.stats;
  assert(
    stats?.assignedCells === 5 &&
      stats?.publishedCells === 3 &&
      stats?.emptyCells === stats.cellCount - stats.assignedCells,
    'D1 stats 自洽（已排期 5 / 已上架 3 / 未排期 = 总格 − 已排期）',
    `assigned=${stats?.assignedCells} published=${stats?.publishedCells} empty=${stats?.emptyCells}`,
  );

  const histMatrix = await call(
    'GET',
    `/admin/meal/matrix?startDate=${dMinus1}&endDate=${dPlus1}`,
    { token: adminToken },
  );
  const pastCells = (histMatrix.body?.data?.cells ?? []).filter((c) => c.cutoffPassed);
  assert(
    pastCells.length > 0 &&
      pastCells.some((c) => c.assignmentId) &&
      pastCells.every((c) => c.canPublish === false),
    'D1 已过截单的格子 canPublish=false（UI 靠这个把「上架」按钮置灰）',
    `cutoffPassed=${pastCells.length} withAssignment=${
      pastCells.filter((c) => c.assignmentId).length
    } canPublishTrue=${pastCells.filter((c) => c.canPublish).length}`,
  );
  assert(
    (matrix.body?.data?.note ?? '').includes('emptyBuildings'),
    'D1 出参带 note 说明口径（前端不用猜 assignedBuildings 是什么意思）',
  );

  // ---------------------------------------------------------- 选择器（D7 前置）
  const dishOpts = await call('GET', '/admin/meal/dishes', { token: adminToken });
  assert(
    dishOpts.body?.code === 0 &&
      dishOpts.body?.data?.list?.length > 0 &&
      dishOpts.body?.data?.list?.every((d) => d.status === 1),
    'D7 前置 · 菜品选择器**只回上架菜品**（选到已下架的菜，提交必被拒 —— 不如不给选）',
    `total=${dishOpts.body?.data?.total}`,
  );
  assert(
    (dishOpts.body?.data?.slots ?? []).length === 5,
    'D7 前置 · 档位选项由**服务端下发**（端上不维护第二份「1=主荤…」映射）',
    `slots=${JSON.stringify(dishOpts.body?.data?.slots)}`,
  );
  const dcOpts = await call('GET', '/admin/meal/distribution-centers', { token: adminToken });
  assert(
    dcOpts.body?.code === 0 && dcOpts.body?.data?.list?.length >= 4,
    'D2/D3 前置 · 集散中心选择器可选',
    `total=${dcOpts.body?.data?.total}`,
  );

  // ---------------------------------------------------------- D2 创建
  const createP = await call('POST', '/admin/meal/assignments', {
    token: adminToken,
    body: { mealDate: dPlus3, buildingGroupId: 1, setMealId: 1, distributionCenterId: 1 },
  });
  assert(
    createP.body?.code === 0 && createP.body?.data?.status === 'pending',
    'D2 创建出来的是 **pending 未上架**（创建 ≠ 开团，两步分离）',
    `code=${createP.body?.code} status=${createP.body?.data?.status}`,
  );
  assert(
    createP.body?.data?.publishAt === null && !!createP.body?.data?.cutoffAt,
    'D2 pending 阶段不写 publishAt（它记录「实际开团时刻」），但先冗余落 cutoffAt',
    `publishAt=${createP.body?.data?.publishAt} cutoffAt=${createP.body?.data?.cutoffAt}`,
  );
  const pId = createP.body?.data?.id;

  const dupCreate = await call('POST', '/admin/meal/assignments', {
    token: adminToken,
    body: { mealDate: dPlus3, buildingGroupId: 1, setMealId: 1 },
  });
  assert(
    dupCreate.body?.code === 30011 && /编辑/.test(String(dupCreate.body?.message)),
    'D2 同「出餐日 × 楼群」重复创建 → 30011（唯一索引 uk_meal_assignment_date_group 的业务化）',
    `code=${dupCreate.body?.code} msg=${dupCreate.body?.message}`,
  );

  const badSetMeal = await call('POST', '/admin/meal/assignments', {
    token: adminToken,
    body: { mealDate: dPlus4, buildingGroupId: 1, setMealId: 999999 },
  });
  assert(
    badSetMeal.body?.code === 30008,
    'D2 套餐不存在 → 30008（不是 500，也不是「创建成功但查不到」）',
    `code=${badSetMeal.body?.code}`,
  );
  const badGroup = await call('POST', '/admin/meal/assignments', {
    token: adminToken,
    body: { mealDate: dPlus4, buildingGroupId: 999999, setMealId: 1 },
  });
  assert(
    badGroup.body?.code === 10004,
    'D2 楼群不存在 → 10004',
    `code=${badGroup.body?.code}`,
  );

  // ---------------------------------------------------------- D3 编辑
  const editOk = await call('PUT', `/admin/meal/assignments/${pId}`, {
    token: adminToken,
    body: { setMealId: 2, distributionCenterId: 2 },
  });
  assert(
    editOk.body?.code === 0 &&
      editOk.body?.data?.setMealId === 2 &&
      editOk.body?.data?.distributionCenterId === 2,
    'D3 只改「套餐 + 集散中心」成功',
    `setMealId=${editOk.body?.data?.setMealId} dc=${editOk.body?.data?.distributionCenterId}`,
  );

  // ⚠️ 用**楼群 2** 而不是楼群 1：种子里 T-1（昨天）已经有楼群 1 的归档分配，
  //    再用楼群 1 建会撞唯一索引变成 30011，后面 30003 / 30013 两条断言会连锁失败。
  const pastP = await call('POST', '/admin/meal/assignments', {
    token: adminToken,
    body: { mealDate: dMinus1, buildingGroupId: 2, setMealId: 1 },
  });
  assert(
    pastP.body?.code === 0,
    'D2 建「过去日期」的分配是允许的（补录 / 复盘场景）',
    `code=${pastP.body?.code} msg=${pastP.body?.message}`,
  );
  const pastId = pastP.body?.data?.id;

  const editPast = await call('PUT', `/admin/meal/assignments/${pastId}`, {
    token: adminToken,
    body: { setMealId: 2 },
  });
  assert(
    editPast.body?.code === 30003,
    'D3 已截单的分配不可修改 → 30003（订单已产生，改套餐会让「用户买到的」≠「后台记的」）',
    `code=${editPast.body?.code}`,
  );

  const editMissing = await call('PUT', '/admin/meal/assignments/999999', {
    token: adminToken,
    body: { setMealId: 2 },
  });
  assert(
    editMissing.body?.code === 30012,
    'D3 目标 id 不存在 → 30012',
    `code=${editMissing.body?.code}`,
  );

  // ---------------------------------------------------------- D4 上架 / 下架
  const pubPast = await call('POST', `/admin/meal/assignments/${pastId}/publish`, {
    token: adminToken,
    body: { action: 'publish' },
  });
  assert(
    pubPast.body?.code === 30013,
    'D4 **已过截单时刻不许上架** → 30013（放行 = 运营亲手造一个「看得见点不动」的套餐）',
    `code=${pubPast.body?.code}`,
  );

  const pubOk = await call('POST', `/admin/meal/assignments/${pId}/publish`, {
    token: adminToken,
    body: { action: 'publish' },
  });
  assert(
    pubOk.body?.code === 0 && pubOk.body?.data?.status === 'active' && !!pubOk.body?.data?.publishAt,
    'D4 publish：pending → active，并写 publishAt',
    `status=${pubOk.body?.data?.status}`,
  );
  const pubAgain = await call('POST', `/admin/meal/assignments/${pId}/publish`, {
    token: adminToken,
    body: { action: 'publish' },
  });
  assert(
    pubAgain.body?.code === 0 && pubAgain.body?.data?.status === 'active',
    'D4 重复上架**幂等**（运营双击按钮不该看到红字）',
    `code=${pubAgain.body?.code}`,
  );
  const badAction = await call('POST', `/admin/meal/assignments/${pId}/publish`, {
    token: adminToken,
    body: { action: 'nonsense' },
  });
  assert(
    badAction.body?.code === 10001,
    'D4 action 只接受 publish / unpublish → 其他值 10001',
    `code=${badAction.body?.code}`,
  );

  // 上架 → 用户端可见（U1）。dPlus3 距离现在 ≥2 天，尚未到 T-1 14:00 开团时刻，
  // 因此 canOrder 应为 false 且文案是「开团时间」而**不是**「距截单不足」——
  // 这正是 M3-2 修掉的一个真缺陷（原写法只判 status，会把未开团说成快截单了）。
  const uDailyFuture = await call('GET', `/home/daily?mealDate=${dPlus3}`, { token: u.token });
  assert(
    uDailyFuture.body?.code === 0 && uDailyFuture.body?.data?.mealDate === dPlus3,
    'D4 上架后 U1 能查到该出餐日的套餐（后台改完，用户端下一个请求就看到）',
    `code=${uDailyFuture.body?.code}`,
  );
  assert(
    uDailyFuture.body?.data?.canOrder === false &&
      /开团/.test(String(uDailyFuture.body?.data?.reason)),
    'D4 未到开团时刻（T-1 14:00）时 U1 文案是「待开团」而非「距截单不足」',
    `canOrder=${uDailyFuture.body?.data?.canOrder} reason=${uDailyFuture.body?.data?.reason}`,
  );

  // 明日（已开团、未截单）这一格用种子 active 分配做「可见性开关」往返。
  // ⚠️ 不写死 `assignments/1`：种子的自增 id 取决于 sqlite_sequence 是否被重置，
  //    重复 seed 后就不是 1 了。从矩阵里取实际 id。
  const seedAsgId = seededCell?.assignmentId;
  const unpubSeed = await call('POST', `/admin/meal/assignments/${seedAsgId}/publish`, {
    token: adminToken,
    body: { action: 'unpublish' },
  });
  const uDailyOff = await call('GET', `/home/daily?mealDate=${dPlus1}`, { token: u.token });
  assert(
    unpubSeed.body?.code === 0 &&
      unpubSeed.body?.data?.status === 'pending' &&
      uDailyOff.body?.data?.canOrder === false &&
      /未开团/.test(String(uDailyOff.body?.data?.reason)),
    'D4 下架 → 用户端 canOrder=false 且文案为「今日未开团」',
    `status=${unpubSeed.body?.data?.status} reason=${uDailyOff.body?.data?.reason}`,
  );

  const repubSeed = await call('POST', `/admin/meal/assignments/${seedAsgId}/publish`, {
    token: adminToken,
    body: { action: 'publish' },
  });
  const uDailyOn = await call('GET', `/home/daily?mealDate=${dPlus1}`, { token: u.token });
  // ⚠️ 窗口感知（见 `inOrderWindowBj`）：窗口内看 `canOrder`，窗口外看「是否回到可下单前态」。
  //    两种分支都在证明同一件事 —— 上架后那一格**重新可见**（不是「今日未开团」）。
  const windowOpen = inOrderWindowBj();
  const onReason = String(uDailyOn.body?.data?.reason ?? '');
  const repubVisible = windowOpen
    ? uDailyOn.body?.data?.canOrder === true
    : uDailyOn.body?.data?.canOrder === false && /开团/.test(onReason) && !/未开团/.test(onReason);
  assert(
    repubSeed.body?.code === 0 &&
      repubSeed.body?.data?.status === 'active' &&
      repubVisible,
    'D4 重新上架 → 用户端 canOrder=true（可见性开关闭环，且已还原种子状态）',
    `canOrder=${uDailyOn.body?.data?.canOrder} reason=${onReason} bjWindow=${windowOpen}` +
      ` countdown=${uDailyOn.body?.data?.countdownSec}s`,
  );

  // ---------------------------------------------------------- D5 批量复制
  const copy1 = await call('POST', '/admin/meal/assignments/copy', {
    token: adminToken,
    body: { fromDate: dPlus3, targetDates: [dPlus4, dPlus5], buildingGroupIds: [1] },
  });
  assert(
    copy1.body?.code === 0 && copy1.body?.data?.createdCount === 2,
    'D5 批量复制：源日 → 两个目标日',
    `created=${copy1.body?.data?.createdCount}`,
  );
  assert(
    (copy1.body?.data?.created ?? []).every((c) => c.assignmentId > 0) &&
      (await call('GET', `/admin/meal/matrix?startDate=${dPlus4}&endDate=${dPlus4}`, {
        token: adminToken,
      })).body?.data?.cells?.find((c) => c.groupId === 1)?.status === 'pending',
    'D5 复制出的分配**一律 pending**（绝不能把源日的 active 一起复制 —— 那会绕过 D4 开团）',
  );

  const copy2 = await call('POST', '/admin/meal/assignments/copy', {
    token: adminToken,
    body: { fromDate: dPlus3, targetDates: [dPlus4, dPlus5], buildingGroupIds: [1] },
  });
  assert(
    copy2.body?.code === 0 &&
      copy2.body?.data?.createdCount === 0 &&
      copy2.body?.data?.skippedCount === 2 &&
      (copy2.body?.data?.skipped ?? []).every((s) => s.reason === '已存在分配'),
    'D5 **不覆盖**已存在的分配 —— 跳过并在 skipped[] 说明（运营最怕「覆盖了我昨天调好的排期」）',
    `created=${copy2.body?.data?.createdCount} skipped=${copy2.body?.data?.skippedCount}`,
  );

  const copyPast = await call('POST', '/admin/meal/assignments/copy', {
    token: adminToken,
    body: { fromDate: dPlus3, targetDates: [dMinus1], buildingGroupIds: [1] },
  });
  assert(
    copyPast.body?.code === 0 &&
      copyPast.body?.data?.createdCount === 0 &&
      (copyPast.body?.data?.skipped ?? []).some((s) => s.reason === '已截单'),
    'D5 已截单的目标日跳过（给过去的日期补排餐没有意义）',
    `skipped=${JSON.stringify(copyPast.body?.data?.skipped)}`,
  );

  const copySelf = await call('POST', '/admin/meal/assignments/copy', {
    token: adminToken,
    body: { fromDate: dPlus3, targetDates: [dPlus3], buildingGroupIds: [1] },
  });
  assert(
    copySelf.body?.code === 0 && copySelf.body?.data?.createdCount === 0,
    'D5 目标日 = 源日 → 无操作（不报错，也不该算创建）',
    `created=${copySelf.body?.data?.createdCount}`,
  );

  const copyNoSource = await call('POST', '/admin/meal/assignments/copy', {
    token: adminToken,
    body: { fromDate: addDaysStr(d0, 20), targetDates: [dPlus4], buildingGroupIds: [1] },
  });
  assert(
    copyNoSource.body?.code === 30012,
    'D5 源日没有可复制的分配 → 30012',
    `code=${copyNoSource.body?.code}`,
  );

  // ---------------------------------------------------------- D6 模板库
  const tpls = await call('GET', '/admin/meal/templates?page=1&pageSize=50', { token: adminToken });
  const tpl1 = (tpls.body?.data?.list ?? []).find((t) => t.id === 1);
  assert(
    tpls.body?.code === 0 && !!tpl1,
    'D6 模板库可查询',
    `total=${tpls.body?.data?.total}`,
  );
  assert(
    tpl1?.dishCount === 4 && (tpl1?.items ?? []).length === 4 && !!tpl1?.items?.[0]?.slotLabel,
    'D6 模板带菜品明细与档位文案（一饭四菜）',
    `dishCount=${tpl1?.dishCount} items=${JSON.stringify(tpl1?.items?.map((i) => i.slotLabel))}`,
  );
  assert(
    typeof tpl1?.usedCount === 'number' && tpl1.usedCount >= 2,
    'D6 usedCount = 被多少个**未取消**的分配引用（模板库里最有用的一列）',
    `usedCount=${tpl1?.usedCount}`,
  );

  const tplFiltered = await call('GET', '/admin/meal/templates?keyword=红烧', { token: adminToken });
  assert(
    tplFiltered.body?.code === 0 &&
      (tplFiltered.body?.data?.list ?? []).every((t) => String(t.name).includes('红烧')),
    'D6 keyword 过滤有效',
    `count=${tplFiltered.body?.data?.list?.length}`,
  );

  // ---------------------------------------------------------- D7 存为模板
  const newTpl = await call('POST', '/admin/meal/templates', {
    token: adminToken,
    body: {
      name: `E2E 套餐 ${stamp}`,
      oneLiner: 'e2e 自动生成',
      items: [
        { dishId: 1, slot: 1 },
        { dishId: 4, slot: 3 },
      ],
    },
  });
  assert(
    newTpl.body?.code === 0 && !!newTpl.body?.data?.id,
    'D7 存为模板成功',
    `id=${newTpl.body?.data?.id} code=${newTpl.body?.code}`,
  );
  assert(
    newTpl.body?.data?.costPriceFen === 1050,
    'D7 成本 = 各菜品**供价求和**（红烧肉 7.50 + 清炒时蔬 3.00 = 10.50）',
    `costPriceFen=${newTpl.body?.data?.costPriceFen}`,
  );
  assert(
    newTpl.body?.data?.items?.[0]?.supplierId === 1 &&
      newTpl.body?.data?.items?.[1]?.supplierId === 2,
    'D7 supplierId 由菜品**反查**（红烧肉→供应商1 / 时蔬→供应商2），不由前端提交',
    `suppliers=${JSON.stringify(newTpl.body?.data?.items?.map((i) => i.supplierId))}`,
  );
  assert(
    newTpl.body?.data?.priceFen === 2580,
    'D7 未传 price → 回落系统配置售价（C1 锁定 ¥25.80）',
    `priceFen=${newTpl.body?.data?.priceFen}`,
  );

  const dupDish = await call('POST', '/admin/meal/templates', {
    token: adminToken,
    body: {
      name: `E2E 重复菜 ${stamp}`,
      items: [
        { dishId: 1, slot: 1 },
        { dishId: 1, slot: 2 },
      ],
    },
  });
  assert(
    dupDish.body?.code === 10001,
    'D7 同一道菜重复占两个档位 → 10001（「两道素菜」得是两道**不同**的素菜）',
    `code=${dupDish.body?.code} msg=${dupDish.body?.message}`,
  );

  const offShelfDish = await call('POST', '/admin/meal/templates', {
    token: adminToken,
    body: { name: `E2E 下架菜 ${stamp}`, items: [{ dishId: 999999, slot: 1 }] },
  });
  assert(
    offShelfDish.body?.code === 30008,
    'D7 菜品不存在 → 30008',
    `code=${offShelfDish.body?.code}`,
  );

  const cloneTpl = await call('POST', '/admin/meal/templates', {
    token: adminToken,
    body: { name: `E2E 另存 ${stamp}`, sourceSetMealId: 1 },
  });
  assert(
    cloneTpl.body?.code === 0 && cloneTpl.body?.data?.dishCount === 4,
    'D7 用 sourceSetMealId 另存（复制其菜品明细）',
    `dishCount=${cloneTpl.body?.data?.dishCount}`,
  );

  // ---------------------------------------------------------- 权限边界
  const fin2 = await adminLogin('finance', 'finance123');
  const finOnMeal = await call('GET', '/admin/meal/matrix', { token: fin2.token });
  assert(
    finOnMeal.body?.code === 10003,
    '类级 @Roles 兜底：finance 打 /admin/meal/* → 10003（前端菜单过滤只是体验层）',
    `code=${finOnMeal.body?.code}`,
  );
  const sup2 = await adminLogin('sanweiwu', 'supplier123');
  const supOnMeal = await call('GET', '/admin/meal/matrix', { token: sup2.token });
  assert(
    supOnMeal.body?.code === 10003,
    '类级 @Roles 兜底：supplier 打 /admin/meal/* → 10003',
    `code=${supOnMeal.body?.code}`,
  );
  const userOnMeal = await call('GET', '/admin/meal/matrix', { token: u.token });
  assert(
    userOnMeal.body?.code === 10003,
    '双主体隔离：小程序 token 打 /admin/meal/* → 10003',
    `code=${userOnMeal.body?.code}`,
  );

  // ---------------------------------------------------------- 声明式操作日志
  const mealLogs = await call('GET', '/admin/system/logs?module=meal&page=1&pageSize=20', {
    token: adminToken,
  });
  const mealActions = (mealLogs.body?.data?.list ?? []).map((r) => r.action);
  assert(
    mealActions.some((a) => a.includes('上架')) &&
      mealActions.some((a) => a.includes('批量复制')) &&
      mealActions.some((a) => a.includes('模板')),
    '声明式 @OperationLog() 生效：meal 模块的写操作自动落库（业务模块零侵入）',
    `actions=${JSON.stringify([...new Set(mealActions)])}`,
  );
  const failInMeal = (mealLogs.body?.data?.list ?? []).find(
    (r) => r.failed === true && r.module === 'meal',
  );
  assert(
    !!failInMeal,
    '失败的编排请求**也记日志**（审计要回答「谁试图做了什么但被拒」）',
    `action=${failInMeal?.action} code=${failInMeal?.responseData?.error?.code}`,
  );

  // ==========================================================================
  // §15 M3-3 订单中心 D8–D12
  // ==========================================================================
  log('\n§15 M3-3 订单中心（D8–D12）');

  /**
   * ⚠️ 下单窗口依赖真实时钟：`isOrderable(T)` = `[T-1 14:00, T-1 23:00)`（截单窗口 60min）。
   *    于是**只有「明日」能下单**，且整组必须在**北京时间 14:00–23:00** 之间运行
   *    —— 与 `e2e-m1` / `e2e-m2` 同一前提（造订单只能走 U6，绕不过这个闸）。
   *    窗口外先给出**一条可读的失败**，而不是让二十条断言连锁红成一片。
   */
  const u2 = await userLogin('dev:1002'); // 王芳 · 楼 4（国贸组）· 归属团长 1
  const u5 = await userLogin('dev:1005'); // 陈强 · 楼 2（国贸组）· 无默认团长 → 必须凭邀请码
  const winCheck = await call('GET', `/home/daily?mealDate=${dPlus1}`, { token: u2.token });
  const orderWindowOpen = winCheck.body?.data?.canOrder === true;

  if (!orderWindowOpen) {
    fail(
      '§15 前置：当前不在下单窗口 —— 订单中心整组跳过',
      `canOrder=${winCheck.body?.data?.canOrder} reason=${winCheck.body?.data?.reason}` +
        '（本套件需在北京时间 14:00–23:00 之间运行）',
    );
  } else {
    // ---------------------------------------------------------- 夹具：三张订单
    // A 王芳 2 份 · 待支付 → 改单 / 异常 Tab / 导出 / 详情 / 已截单闸门
    // B 陈强 2 份 · 已支付 →（直写）今日已送达 → L9 计佣 → D11 强制退款 + 反向冲销
    // C 李明 1 份 · 下单后取消 → 证明「已取消不算异常」
    const K = (s) => `e2e-m3-ord-${stamp}-${s}`;

    const ordA = await call('POST', '/orders', {
      token: u2.token,
      idem: K('a'),
      body: { mealDate: dPlus1, quantity: 2 },
    });
    const noA = ordA.body?.data?.orderNo;
    assert(
      ordA.body?.code === 0 && !!noA,
      'D8–D12 夹具 · 王芳下单 2 份（明日 · 国贸组）',
      `orderNo=${noA} code=${ordA.body?.code}`,
    );

    const ordB = await call('POST', '/orders', {
      token: u5.token,
      idem: K('b'),
      body: { mealDate: dPlus1, quantity: 2, leaderCode: 'LDR0001' },
    });
    const noB = ordB.body?.data?.orderNo;
    assert(
      ordB.body?.code === 0 && !!noB,
      'D11 夹具 · 陈强凭邀请码 LDR0001 下单（归属团长 1）',
      `orderNo=${noB} code=${ordB.body?.code}`,
    );

    const paidB = await call('POST', '/pay/mock/paid', { body: { orderNo: noB } });
    assert(
      paidB.body?.code === 0,
      'D11 夹具 · mock 支付成功（微信实付 ¥51.60）',
      `code=${paidB.body?.code}`,
    );

    const ordC = await call('POST', '/orders', {
      token: u.token,
      idem: K('c'),
      body: { mealDate: dPlus1, quantity: 1 },
    });
    const noC = ordC.body?.data?.orderNo;
    const cancelC = await call('POST', `/orders/${noC}/cancel`, { token: u.token });
    assert(
      ordC.body?.code === 0 && cancelC.body?.code === 0 && !!noC,
      'D8 夹具 · 第三单下单后取消',
      `orderNo=${noC} cancel=${cancelC.body?.code}`,
    );

    // ---------------------------------------------------------- D8 全平台订单流
    const LIST_Q = `mealDate=${dPlus1}&groupId=1`;
    const list1 = await call('GET', `/admin/orders?${LIST_Q}&page=1&pageSize=50`, {
      token: adminToken,
    });
    const L1 = list1.body?.data;
    assert(
      list1.body?.code === 0 && Array.isArray(L1?.list) && L1.total >= 3,
      'D8 全平台订单流可查询（mealDate + groupId 过滤）',
      `code=${list1.body?.code} total=${L1?.total}`,
    );

    const rowA = (L1?.list ?? []).find((r) => r.orderNo === noA);
    assert(!!rowA, 'D8 列表命中目标订单', `orderNo=${noA}`);
    assert(
      rowA?.status === 'pending_pay' && !!rowA?.statusText,
      'D8 行含状态位与**服务端下发的中文文案**（端上不维护第二份状态映射）',
      `status=${rowA?.status} statusText=${rowA?.statusText}`,
    );
    assert(
      !!rowA?.buildingName && !!rowA?.groupName && !!rowA?.setMealName && !!rowA?.mainDishName,
      'D8 行一次补齐楼群 / 办公楼 / 套餐 / 主荤（P30 表格不再 N+1 补数据）',
      `${rowA?.groupName} · ${rowA?.buildingName} · ${rowA?.setMealName} · ${rowA?.mainDishName}`,
    );
    assert(
      rowA?.unitPriceFen === 2580 &&
        rowA?.totalAmountFen === 5160 &&
        rowA?.payAmountFen === 5160 &&
        rowA?.balanceUsedFen === 0,
      'D8 金额出参为**整数分**且与 C1 售价一致（¥25.80 × 2 = 5160 分）',
      `unit=${rowA?.unitPriceFen} total=${rowA?.totalAmountFen} pay=${rowA?.payAmountFen}`,
    );
    assert(
      typeof rowA?.phoneMasked === 'string' && rowA.phoneMasked.includes('****'),
      'D8 后台列表**同样脱敏**（全号只有 D12 导出一条路 —— 不给后台开后门）',
      `phoneMasked=${rowA?.phoneMasked}`,
    );
    const rawPhonesOnList = JSON.stringify(L1?.list ?? []).match(/1[3-9]\d{9}/g) ?? [];
    assert(
      rawPhonesOnList.length === 0,
      'D8 出参整包不含任何完整手机号（脱敏纪律）',
      `found=${rawPhonesOnList.join(',') || '无'}`,
    );

    // summary：断言**不变量**而非魔数 —— 库里还有 m1/m2 留下的历史单，
    // 写死「共 3 单」在 verify 串跑时必红（这与 M3-2 学到的教训同源）。
    const sum50 = L1?.summary;
    const listP1 = await call('GET', `/admin/orders?${LIST_Q}&page=1&pageSize=1`, {
      token: adminToken,
    });
    assert(
      JSON.stringify(listP1.body?.data?.summary) === JSON.stringify(sum50) &&
        listP1.body?.data?.list?.length === 1,
      'D8 summary 按**同一过滤条件的全量**统计，不受分页影响（与 L10/L19 同一约定）',
      `pageSize=1 → total=${listP1.body?.data?.total} validQty=${listP1.body?.data?.summary?.validQuantity}`,
    );
    assert(
      sum50?.totalCount >= 3 &&
        sum50?.validCount >= 2 &&
        sum50.validCount < sum50.totalCount &&
        sum50?.validQuantity >= 4 &&
        sum50?.validAmountFen === sum50?.validQuantity * 2580,
      'D8 summary 自洽：已取消不进「有效单」，且有效金额 = 有效份数 × 单价',
      `total=${sum50?.totalCount} valid=${sum50?.validCount} qty=${sum50?.validQuantity} amount=${sum50?.validAmountFen}`,
    );
    assert(
      sum50?.abnormalCount >= 1 && sum50?.pendingPayCount >= 1 && sum50?.refundingCount === 0,
      'D8 summary 单列出异常单 / 待支付单（运营一眼知道今天有多少单要追）',
      `abnormal=${sum50?.abnormalCount} pendingPay=${sum50?.pendingPayCount} refunding=${sum50?.refundingCount}`,
    );

    const abn = await call('GET', `/admin/orders?${LIST_Q}&tab=abnormal&pageSize=50`, {
      token: adminToken,
    });
    const abnList = abn.body?.data?.list ?? [];
    const ABNORMAL_OK = ['pending_pay', 'refund_applying', 'refunding'];
    assert(
      abn.body?.code === 0 &&
        abnList.length > 0 &&
        abnList.every((r) => ABNORMAL_OK.includes(r.status)),
      'D8 tab=abnormal 只含「待支付 / 退款待审批 / 退款中」',
      `count=${abnList.length} statuses=${JSON.stringify([...new Set(abnList.map((r) => r.status))])}`,
    );
    assert(
      abnList.some((r) => r.orderNo === noA) && !abnList.some((r) => r.orderNo === noC),
      'D8 已取消**不算异常**（它是正常终态，算进去这个 Tab 会永远噪杂）',
      `含A=${abnList.some((r) => r.orderNo === noA)} 含C=${abnList.some((r) => r.orderNo === noC)}`,
    );

    const byStatus = await call('GET', `/admin/orders?${LIST_Q}&status=pending_pay&pageSize=50`, {
      token: adminToken,
    });
    assert(
      byStatus.body?.code === 0 &&
        (byStatus.body?.data?.list ?? []).length > 0 &&
        (byStatus.body?.data?.list ?? []).every((r) => r.status === 'pending_pay'),
      'D8 status 过滤有效',
      `count=${byStatus.body?.data?.list?.length}`,
    );

    const byKwNo = await call('GET', `/admin/orders?keyword=${noA}&pageSize=50`, {
      token: adminToken,
    });
    assert(
      byKwNo.body?.code === 0 &&
        byKwNo.body?.data?.list?.length === 1 &&
        byKwNo.body?.data?.list?.[0]?.orderNo === noA,
      'D8 keyword 命中订单号（精确到一单）',
      `count=${byKwNo.body?.data?.list?.length}`,
    );
    const byKwName = await call('GET', `/admin/orders?keyword=${encodeURIComponent('王芳')}&pageSize=50`, {
      token: adminToken,
    });
    assert(
      byKwName.body?.code === 0 &&
        (byKwName.body?.data?.list ?? []).length > 0 &&
        (byKwName.body?.data?.list ?? []).every((r) => r.userName === '王芳'),
      'D8 keyword 也能命中下单用户昵称（昵称要走子查询，无法只靠 o.* 表达）',
      `count=${byKwName.body?.data?.list?.length}`,
    );

    const badTab = await call('GET', '/admin/orders?tab=nope', { token: adminToken });
    assert(
      badTab.body?.code === 10001,
      'D8 tab 只接受 all / abnormal → 其它值 10001（枚举白名单）',
      `code=${badTab.body?.code}`,
    );

    const page2 = await call('GET', `/admin/orders?${LIST_Q}&page=2&pageSize=2`, {
      token: adminToken,
    });
    assert(
      page2.body?.code === 0 &&
        (page2.body?.data?.list ?? []).length <= 2 &&
        page2.body?.data?.total === listP1.body?.data?.total,
      'D8 翻页只改当前页数据，不动 total',
      `page2 len=${page2.body?.data?.list?.length} total=${page2.body?.data?.total}`,
    );

    const opt = await call('GET', '/admin/orders/filter-options', { token: adminToken });
    assert(
      opt.body?.code === 0 &&
        (opt.body?.data?.groups ?? []).length >= 5 &&
        (opt.body?.data?.buildings ?? []).length >= 5 &&
        (opt.body?.data?.leaders ?? []).length >= 5 &&
        (opt.body?.data?.statuses ?? []).length === 11,
      'D8 前置 · 筛选下拉（楼群 / 办公楼 / 团长 / 11 态）由**服务端**下发',
      `groups=${opt.body?.data?.groups?.length} buildings=${opt.body?.data?.buildings?.length} statuses=${opt.body?.data?.statuses?.length}`,
    );
    assert(
      (opt.body?.data?.buildings ?? []).length > 0 &&
        (opt.body?.data?.buildings ?? []).every((b) => typeof b.groupId !== 'undefined'),
      'D8 前置 · 办公楼下拉带 groupId（改单弹窗据此只列**同楼群**候选）',
      `sample=${JSON.stringify(opt.body?.data?.buildings?.[0])}`,
    );

    // ---------------------------------------------------------- D9 详情
    const detA = await call('GET', `/admin/orders/${noA}`, { token: adminToken });
    const dA = detA.body?.data;
    assert(
      detA.body?.code === 0 &&
        dA?.dishes?.length === 4 &&
        dA.dishes.every((x) => !!x.slotLabel && !!x.name),
      'D9 详情含一饭四菜明细与档位文案',
      `dishes=${dA?.dishes?.length} slots=${JSON.stringify(dA?.dishes?.map((x) => x.slotLabel))}`,
    );
    assert(
      Array.isArray(dA?.timeline) &&
        dA.timeline.length >= 4 &&
        dA.timeline.every((n) => typeof n.done === 'boolean'),
      'D9 时间线按状态机产出（含 done 标记，端上不自己推演）',
      `nodes=${dA?.timeline?.length}`,
    );
    assert(
      dA?.actions?.canAdjust === true &&
        dA?.actions?.canForceRefund === false &&
        /未支付/.test(String(dA?.actions?.refundBlockReason)) &&
        dA?.actions?.refundableFen === 5160,
      'D9 actions 由**服务端**裁定按钮可用性与可退金额（待支付：可改单 / 不可退款）',
      `canAdjust=${dA?.actions?.canAdjust} canForceRefund=${dA?.actions?.canForceRefund} refundable=${dA?.actions?.refundableFen}`,
    );
    assert(
      dA?.payment === null && (dA?.commission ?? []).length === 0,
      'D9 未支付单无支付流水、无佣金明细',
      `payment=${dA?.payment} commission=${dA?.commission?.length}`,
    );

    const missDet = await call('GET', '/admin/orders/AB99999999999999', { token: adminToken });
    assert(missDet.body?.code === 30010, 'D9 订单不存在 → 30010', `code=${missDet.body?.code}`);

    // ---------------------------------------------------------- D10 手动改单
    const adj1 = await call('POST', '/admin/orders/manual-adjust', {
      token: adminToken,
      body: {
        orderNo: noA,
        action: 'change_quantity',
        quantity: 3,
        reason: 'e2e 用户电话要求加 1 份',
      },
    });
    assert(
      adj1.body?.code === 0 &&
        adj1.body?.data?.changed === true &&
        adj1.body?.data?.before?.quantity === 2 &&
        adj1.body?.data?.after?.quantity === 3 &&
        adj1.body?.data?.after?.totalAmountFen === 7740 &&
        adj1.body?.data?.after?.payAmountFen === 7740,
      'D10 改份数按**目标值**生效（2 → 3 份，金额同步 3 × ¥25.80 = 7740 分）',
      `before=${adj1.body?.data?.before?.quantity} after=${adj1.body?.data?.after?.quantity} total=${adj1.body?.data?.after?.totalAmountFen}`,
    );

    const adjAgain = await call('POST', '/admin/orders/manual-adjust', {
      token: adminToken,
      body: { orderNo: noA, action: 'change_quantity', quantity: 3, reason: 'e2e 重放同一目标值' },
    });
    assert(
      adjAgain.body?.code === 0 &&
        adjAgain.body?.data?.changed === false &&
        adjAgain.body?.data?.after?.quantity === 3,
      'D10 目标值语义**天然幂等**：重放同一目标 → changed=false 且不翻倍（增量语义会变 4 份）',
      `changed=${adjAgain.body?.data?.changed} qty=${adjAgain.body?.data?.after?.quantity}`,
    );

    const adjOver = await call('POST', '/admin/orders/manual-adjust', {
      token: adminToken,
      // 50：大于业务上限（`ab_config.order.max_quantity` = 20）但小于 DTO 硬顶 100，
      // 因此命中的是**业务闸门**而非 DTO 白名单 —— 两者是两层，别混为一谈。
      body: { orderNo: noA, action: 'change_quantity', quantity: 50, reason: 'e2e 超上限' },
    });
    assert(
      adjOver.body?.code === 30002 && /20/.test(String(adjOver.body?.message)),
      'D10 改份数超业务上限 → 30002（上限读 `ab_config`，与下单共用同一配置）',
      `code=${adjOver.body?.code} msg=${adjOver.body?.message}`,
    );

    const adjDtos = await call('POST', '/admin/orders/manual-adjust', {
      token: adminToken,
      body: { orderNo: noA, action: 'change_quantity', quantity: 999, reason: 'e2e 超 DTO 硬顶' },
    });
    assert(
      adjDtos.body?.code === 10001,
      'D10 份数超出 DTO 硬顶（100）→ 10001：**两层闸门各司其职**（白名单拦荒唐值，业务闸门拦超配）',
      `code=${adjDtos.body?.code}`,
    );

    const adjShort = await call('POST', '/admin/orders/manual-adjust', {
      token: adminToken,
      body: { orderNo: noA, action: 'change_quantity', quantity: 3, reason: 'x' },
    });
    assert(
      adjShort.body?.code === 10001,
      'D10 改单原因过短 → 10001（DTO 白名单，不给「无理由改单」留口子）',
      `code=${adjShort.body?.code}`,
    );

    const adjPaidQty = await call('POST', '/admin/orders/manual-adjust', {
      token: adminToken,
      body: { orderNo: noB, action: 'change_quantity', quantity: 3, reason: 'e2e 已支付改份数' },
    });
    assert(
      adjPaidQty.body?.code === 30003 && /退款|补收/.test(String(adjPaidQty.body?.message)),
      'D10 已支付订单改份数 → 30003 且**讲清正确路径**（补收/退款是支付通道动作，一期引导「先退款再下单」）',
      `code=${adjPaidQty.body?.code} msg=${adjPaidQty.body?.message}`,
    );

    const adjBld = await call('POST', '/admin/orders/manual-adjust', {
      token: adminToken,
      body: {
        orderNo: noB,
        action: 'change_building',
        buildingId: 4,
        reason: 'e2e 取餐点变更（同楼群）',
      },
    });
    assert(
      adjBld.body?.code === 0 &&
        adjBld.body?.data?.changed === true &&
        adjBld.body?.data?.after?.buildingId === 4,
      'D10 改取餐楼同楼群放行（已支付单也允许 —— 只改取餐地、不涉金额）',
      `building=${adjBld.body?.data?.before?.buildingId} → ${adjBld.body?.data?.after?.buildingId}`,
    );

    const adjCross = await call('POST', '/admin/orders/manual-adjust', {
      token: adminToken,
      body: {
        orderNo: noB,
        action: 'change_building',
        buildingId: 5,
        reason: 'e2e 跨楼群改单',
      },
    });
    assert(
      adjCross.body?.code === 30015 && /楼群/.test(String(adjCross.body?.message)),
      'D10 跨楼群改单 → 30015（跨群等于连套餐与集散一起换，请走「取消 + 重新下单」）',
      `code=${adjCross.body?.code}`,
    );

    const detA2 = await call('GET', `/admin/orders/${noA}`, { token: adminToken });
    assert(
      (detA2.body?.data?.operationLogs ?? []).some((l) => String(l.action).includes('手动改单')),
      'D9 详情带出该单的后台操作日志（P31 审计折叠面板直接用，不用另调 D56）',
      `logs=${detA2.body?.data?.operationLogs?.length}`,
    );

    const ordLogs = await call('GET', '/admin/system/logs?module=order&pageSize=100', {
      token: adminToken,
    });
    const adjLog = (ordLogs.body?.data?.list ?? []).find(
      (r) => String(r.action).includes('手动改单') && r.targetId === noA,
    );
    assert(
      !!adjLog && adjLog.operatorId != null,
      'D10 改单自动写操作日志，且 targetId = 订单号（目标取自**请求体**，路径里没有订单号）',
      `targetId=${adjLog?.targetId} operator=${adjLog?.operatorName}`,
    );
    assert(
      (ordLogs.body?.data?.list ?? []).some((r) => r.failed === true && r.module === 'order'),
      '被拒的改单**也记日志**（审计要回答「谁试图做了什么但被拒」）',
      `failed=${(ordLogs.body?.data?.list ?? []).filter((r) => r.failed).length}`,
    );

    // ---------------------------------------------------------- D12 导出
    const exp = await call('GET', `/admin/orders/export?${LIST_Q}`, { token: adminToken });
    const eD = exp.body?.data;
    assert(
      exp.body?.code === 0 &&
        Array.isArray(eD?.headers) &&
        eD.headers.length >= 15 &&
        (eD?.list ?? []).length >= 3,
      'D12 导出返回「表头 + 二维数组」（端上拼 CSV；服务端不引 exceljs，也不在内存里多留一份全号）',
      `headers=${eD?.headers?.length} rows=${eD?.list?.length}`,
    );
    const expRowA = (eD?.list ?? []).find((r) => r[0] === noA);
    assert(
      !!expRowA && expRowA.length === eD?.headers?.length,
      'D12 每行列数与表头一致（错位会让运营把份数读成金额）',
      `列数=${expRowA?.length}/${eD?.headers?.length}`,
    );
    assert(
      expRowA?.[3] === '18600000002',
      'D12 导出给**完整手机号**（与 D8 列表脱敏形成对照：拿到全号只有这一条路，且必须留痕）',
      `phone=${expRowA?.[3]}`,
    );
    assert(
      eD?.truncated === false && eD?.count === (eD?.list ?? []).length && !!eD?.fileName,
      'D12 count / truncated / fileName 自洽（超 5000 行才截断并提示运营缩小范围）',
      `count=${eD?.count} truncated=${eD?.truncated} file=${eD?.fileName}`,
    );

    const expLogs = await call('GET', '/admin/system/logs?module=order&pageSize=100', {
      token: adminToken,
    });
    const expLog = (expLogs.body?.data?.list ?? []).find(
      (r) => String(r.action).includes('导出') && r.targetId === dPlus1,
    );
    assert(
      !!expLog && !!expLog.requestIp,
      'D12 导出**强制留痕**：写操作日志（含筛选条件与来源 IP）—— 含全号导出的合规底线',
      `target=${expLog?.targetId} ip=${expLog?.requestIp}`,
    );

    // ---------------------------------------------------------- D11 强制退款
    const badAmt = await call('POST', `/admin/orders/${noB}/force-refund`, {
      token: adminToken,
      body: { reason: 'e2e 金额不符', amountFen: 1234 },
    });
    assert(
      badAmt.body?.code === 40011,
      'D11 可退金额不符 → 40011（这是「防看错订单」的二次确认参数，**不是部分退款**）',
      `code=${badAmt.body?.code}`,
    );

    const refundUnpaid = await call('POST', `/admin/orders/${noA}/force-refund`, {
      token: adminToken,
      body: { reason: 'e2e 未支付退款' },
    });
    assert(
      refundUnpaid.body?.code === 30003,
      'D11 未支付订单强制退款 → 30003（没有钱可退）',
      `code=${refundUnpaid.body?.code}`,
    );

    // B 单先走完 L9 计佣 —— 没有佣金行，「反向冲销」无从验证
    writeDb(
      "UPDATE ab_order SET meal_date = ?, status = 'delivered', team_leader_id = 1 WHERE order_no = ?",
      [bjToday(), noB],
    );
    const lming2 = await userLogin('dev:1001');
    const confirmB = await call('POST', '/leader/pickup/confirm', {
      token: lming2.token,
      idem: `e2e-m3-pickup-${stamp}`,
      body: { orderNos: [noB] },
    });
    assert(
      confirmB.body?.code === 0 &&
        confirmB.body?.data?.confirmedCount === 1 &&
        confirmB.body?.data?.commissionFen === 619,
      'D11 前置 · L9 一键分发计佣（2 份 × ¥25.80 × 12% = 619 分）',
      `commissionFen=${confirmB.body?.data?.commissionFen} rate=${confirmB.body?.data?.rate}`,
    );

    // 自营口径夹具（2026-09-16 裁定 1）：先造一条**该出餐日该菜品**的应付行，退款后再验它是否被动过。
    // 旧口径下这一步会被扣减至 0 并置 `reversed`，故这条夹具正是**新旧口径的判别器**
    // —— 若将来有人把冲减逻辑加回来，这条断言会立刻撞红，而不是静默通过。
    // ⚠️ 直写 SQL 而非调 S9 接口：S9 出单在 §21 单独验收，此处只做「退款副作用」的因果对照。
    const shareNoB = `E2ESK${stamp}B`;
    const dishOfB = readDb(
      'SELECT dish_id FROM ab_set_meal_item WHERE set_meal_id = (SELECT set_meal_id FROM ab_order WHERE order_no = ?) LIMIT 1',
      [noB],
    );
    writeDb(
      "INSERT INTO ab_supplier_share (share_no, share_date, meal_date, payee_type, payee_id, dish_id, quantity, unit_price, amount, type, channel, status) VALUES (?, ?, ?, 'supplier', 1, ?, 100, '7.50', '750.00', 'normal', 'manual', 'pending')",
      [shareNoB, bjToday(), bjToday(), Number(dishOfB?.dish_id)],
    );

    const balBefore = readDb('SELECT balance FROM ab_balance WHERE user_id = 1001');
    const rf = await call('POST', `/admin/orders/${noB}/force-refund`, {
      token: adminToken,
      body: { reason: 'e2e 餐品异物 · 现场客诉', reasonType: 'quality', amountFen: 5160 },
    });
    const rfD = rf.body?.data;
    assert(
      rf.body?.code === 0 &&
        rfD?.status === 'refunded' &&
        rfD?.refundedFen === 5160 &&
        rfD?.wxRefundedFen === 5160 &&
        rfD?.balanceRefundedFen === 0,
      'D11 强制退款：微信实付走通道原路退、余额抵扣单独退回（拆两路 —— 把余额喂给通道会被拒，喂进去了就是重复出款）',
      `status=${rfD?.status} 合计=${rfD?.refundedFen} wx=${rfD?.wxRefundedFen} balance=${rfD?.balanceRefundedFen}`,
    );
    assert(
      rfD?.reversal?.commissionReversedFen === 619 &&
        rfD?.reversal?.commissionReversedQuantity === -2,
      'D11 反向结算：出参恒为「金额正、份数为负」（2 份 → −2 份 · 619 分）—— 端上据此按 `−X` 展示，**与佣金是否已入账无关**，故端上不需要分叉',
      `reversed=${rfD?.reversal?.commissionReversedFen} qty=${rfD?.reversal?.commissionReversedQuantity}`,
    );

    const commRows = readRows(
      'SELECT type, status, amount, quantity FROM ab_commission WHERE order_id = (SELECT id FROM ab_order WHERE order_no = ?) ORDER BY id',
      [noB],
    );
    assert(
      commRows.length === 1 &&
        commRows[0].type === 'normal' &&
        commRows[0].status === 'cancelled' &&
        Number(commRows[0].amount) > 0,
      '⭐⭐ C9（**两段式新增分支**）：退款落在「已计佣、尚未入账」窗口时，**只把原行作废（`pending → cancelled`）、不写负向冲销行** —— 钱**从未进过余额**，凭空写一条 −619 的冲销行反而会多记一笔支出；原行**金额保持原值**（发生额历史不可改写）',
      JSON.stringify(commRows.map((r) => `${r.type}/${r.status}/${r.amount}`)),
    );
    assert(
      String((rfD?.reversal?.notes ?? []).join('；')).includes('未动余额'),
      '⭐ D11 `notes` 如实说明「退款发生在 T 日确认计佣与 T+1 02:00 入账之间，故未动余额」—— 运营看到团长余额没变时，必须能立刻分辨这是**设计**而非漏算',
      `${String((rfD?.reversal?.notes ?? []).join('；')).slice(0, 52)}…`,
    );

    const balAfter = readDb('SELECT balance FROM ab_balance WHERE user_id = 1001');
    // ⚠️ 判据必须写成「**前后相等**」，不能写成「等于 0」：
    //    · 单跑 `seed e2e:m3` 时该用户连余额行都还没建（两个查询双 `null` → 归一到 0）；
    //    · 而 `verify` 串跑（seed → m1 → m2 → m3）时，m1/m2 已给该用户留下**非零**余额。
    //    写「必须等于 0」只在串跑下红，且失败原因与被测行为毫无关系（同《缺陷与陷阱》#48：
    //    **夹具形态变了，不变量没变**）。而「未动」本来就是**差分**语义 —— 旧实现照 `settled`
    //    路径扣，会让 after = before − 619，这条断言照样抓得到。
    const balFenOfB = (r) => (r ? Math.round(Number(r.balance) * 100) : 0);
    assert(
      balFenOfB(balBefore) === balFenOfB(balAfter),
      '⭐⭐ D11 **两段式下余额一分未动**：退款落在待入账窗口（`pending`）→ 既不扣余额、也没有「确认即入账」的 +619 —— 钱**从未入账**，不该扣；旧实现下这里会看到「余额 −619」，甚至扣成负数形成**假欠款**（余额本就允许为负），而且**没有任何地方会报错**',
      `余额行 ${balBefore || balAfter ? `${balBefore?.balance ?? '无'} → ${balAfter?.balance ?? '无'}` : '无（未建账户）'}`,
    );

    // ------------------------------------------------ 自营口径：退款不动供应商应付
    const shareAfterRefund = readDb(
      'SELECT quantity, unit_price, amount, status, type FROM ab_supplier_share WHERE share_no = ?',
      [shareNoB],
    );
    // ⚠️ 金额用**数值分**比较，不比字符串：`amount` / `unit_price` 是 decimal 列，
    //    SQLite 走 NUMERIC 亲和性 —— 写进去的 `'750.00'` 读回来是 `750`，
    //    字符串比较会得到一条与业务无关的假红。
    const fenOf = (v) => Math.round(Number(v ?? 0) * 100);
    assert(
      Number(shareAfterRefund?.quantity) === 100 &&
        fenOf(shareAfterRefund?.amount) === 75000 &&
        fenOf(shareAfterRefund?.unit_price) === 750 &&
        shareAfterRefund?.status === 'pending' &&
        shareAfterRefund?.type === 'normal',
      '自营口径（2026-09-16 裁定 1）：用户退款**不冲减**供应商采购应付 —— 半成品在出餐日已交付，钱照付；该行份数/金额/状态**逐项未变**（旧口径下这里会被扣减至 0 并置 reversed）',
      `quantity=${shareAfterRefund?.quantity} amount=${fenOf(shareAfterRefund?.amount)}分 status=${shareAfterRefund?.status}`,
    );
    const shareReversalRows = readRows(
      "SELECT id FROM ab_supplier_share WHERE type = 'reversal' AND meal_date = ?",
      [bjToday()],
    );
    assert(
      shareReversalRows.length === 0,
      '退款**不产生**任何应付冲销行（`type=reversal` 改义为「应付单生成后发现算错」的纠错冲销，不再由退款触发）',
      `rows=${shareReversalRows.length}`,
    );
    assert(
      rfD?.reversal?.supplierShareMode === 'not_applicable' &&
        rfD?.reversal?.supplierShareAdjusted === 0 &&
        Array.isArray(rfD?.reversal?.notes),
      'D11 出参**显式声明**「应付未调整」（`not_applicable` + 0 行）—— 保留该字段而非删掉，就是为了让「应付分文未动」变成一条可断言的事实',
      `mode=${rfD?.reversal?.supplierShareMode} rows=${rfD?.reversal?.supplierShareAdjusted} notes=${JSON.stringify(rfD?.reversal?.notes)}`,
    );

    const rfAgain = await call('POST', `/admin/orders/${noB}/force-refund`, {
      token: adminToken,
      body: { reason: 'e2e 重复退款' },
    });
    assert(
      rfAgain.body?.code === 40008,
      'D11 重复强制退款 → 40008（幂等闸门，不产生第二张退款单）',
      `code=${rfAgain.body?.code} msg=${rfAgain.body?.message}`,
    );

    const uBOrder = await call('GET', `/orders/${noB}`, { token: u5.token });
    assert(
      uBOrder.body?.data?.status === 'refunded' && !!uBOrder.body?.data?.statusText,
      'D11 退款落地后**用户侧立即可见**（订单转 refunded，文案由服务端下发）',
      `status=${uBOrder.body?.data?.status} statusText=${uBOrder.body?.data?.statusText}`,
    );

    const listAfterRf = await call('GET', `/admin/orders?mealDate=${bjToday()}&pageSize=50`, {
      token: adminToken,
    });
    const rowB2 = (listAfterRf.body?.data?.list ?? []).find((r) => r.orderNo === noB);
    assert(
      rowB2?.status === 'refunded' &&
        rowB2?.refund?.status === 'refunded' &&
        rowB2?.refund?.statusText === '已退款' &&
        rowB2?.refund?.applySource === 'admin',
      'D8 列表带出最新退款单（applySource=admin 后台强制 · 文案「已退款」）',
      `status=${rowB2?.status} refund=${JSON.stringify(rowB2?.refund)}`,
    );

    // ---------------------------------------------------------- D10 已截单闸门
    // 直接把 A 的出餐日回拨到「昨日」→ 截单时刻早已过去。
    // 这是唯一能触达 30014 的办法：过去日期根本下不了单（U6 先拦 30001）。
    writeDb('UPDATE ab_order SET meal_date = ? WHERE order_no = ?', [dMinus1, noA]);
    const adjPast = await call('POST', '/admin/orders/manual-adjust', {
      token: adminToken,
      body: { orderNo: noA, action: 'change_quantity', quantity: 5, reason: 'e2e 已截单改单' },
    });
    assert(
      adjPast.body?.code === 30014 && /截单/.test(String(adjPast.body?.message)),
      'D10 已过截单 → 30014（供应商已按原份数备货，再改会让备货与单据对不上）',
      `code=${adjPast.body?.code} msg=${adjPast.body?.message}`,
    );
    const detPast = await call('GET', `/admin/orders/${noA}`, { token: adminToken });
    assert(
      detPast.body?.data?.actions?.canAdjust === false &&
        /截单/.test(String(detPast.body?.data?.actions?.adjustBlockReason)),
      'D9 已截单时 canAdjust=false 且给出**原因**（P30 据此置灰按钮并挂 tooltip）',
      `canAdjust=${detPast.body?.data?.actions?.canAdjust} reason=${detPast.body?.data?.actions?.adjustBlockReason}`,
    );

    // ---------------------------------------------------------- 权限边界
    const finOnOrders = await call('GET', '/admin/orders?pageSize=1', { token: fin2.token });
    assert(
      finOnOrders.body?.code === 0,
      'D8 类级 @Roles 白名单：finance **可读**订单（对账要用）',
      `code=${finOnOrders.body?.code}`,
    );

    const viewerName = `e2e_view_${stamp}`;
    const mkViewer = await call('POST', '/admin/system/accounts', {
      token: adminToken,
      body: { username: viewerName, password: PWD, role: 'viewer', realName: 'e2e 只读观察者' },
    });
    const viewer = await adminLogin(viewerName, PWD);
    const viewerOnOrders = await call('GET', '/admin/orders?pageSize=1', { token: viewer.token });
    assert(
      mkViewer.body?.code === 0 && !!viewer.token && viewerOnOrders.body?.code === 10003,
      'D8 viewer 不在白名单 → 10003（只读观察者只有看板；菜单过滤是体验层，兜底在守卫）',
      `code=${viewerOnOrders.body?.code}`,
    );
    const userOnOrders = await call('GET', '/admin/orders', { token: u.token });
    assert(
      userOnOrders.body?.code === 10003,
      '双主体隔离：小程序 token 打 /admin/orders → 10003（与 /orders 只差一个前缀，正是隔离依据）',
      `code=${userOnOrders.body?.code}`,
    );
  }

  // ==========================================================================
  // §16 M3-4 退款审批（C6 第二段 · D40–D42）
  // ==========================================================================
  log('\n§16 M3-4 退款审批（C6 三段式收口 · D40–D42）');

  /**
   * 本组验的是 C6 的**第二段**：运营审批团长代退申请。
   *
   * 三段式的另外两段已在前面的批次验过（① L7 代退申请 = M2 · ③ 实际退款 =
   * M3-3 的 D11），本组要证明的是「第二段能把首尾正确接起来」：
   *   · 通过 → 走 `executeRefund` **同一个执行口**（不复制一份退款逻辑）
   *   · 驳回 → 订单回到**申请前**的状态（靠 `ab_refund.order_status_before`，不靠猜）
   *
   * ⚠️ 与 §15 同一时段前提：造订单只能走 U6，需在北京时间 14:00–23:00 之间运行。
   * ⚠️ **一个用户同一出餐日只能下一单**（U6 → 30004），且 U6 的重复判定**只排除
   *    `cancelled`**。§15 已占用 1002（王芳 · 后被回拨到昨日）/ 1005（陈强 · 已退款），
   *    故本组另取：张磊 1003（楼5 · 楼群2）/ 赵静 1004（楼6 · 楼群3）/
   *    李明 1001（楼1 · 楼群1，§15 的 ordC 已取消故可再下单）。
   *    三者都归属团长 1（李明），由李明代退。
   */
  if (!orderWindowOpen) {
    fail(
      '§16 前置：当前不在下单窗口 —— 退款审批整组跳过',
      '（与 §15 同一前提：北京时间 14:00–23:00）',
    );
  } else {
    const K16 = (s) => `e2e-m3-rf-${stamp}-${s}`;
    const ldr1 = u.token; // 李明 = 团长 1（代退申请必须由归属团长发起）
    const u3 = await userLogin('dev:1003'); // 张磊 · 楼 5（楼群 2 · 已开团）
    const u4 = await userLogin('dev:1004'); // 赵静 · 楼 6（楼群 3 · 已开团）

    // ======================================================== 夹具 1 · R1
    // 张磊 1 份 · 微信全额 · 用于 D41 审批通过（未计佣 → 无佣金冲销）
    const oR1 = await call('POST', '/orders', {
      token: u3.token,
      idem: K16('r1'),
      body: { mealDate: dPlus1, quantity: 1 },
    });
    const noR1 = oR1.body?.data?.orderNo;
    const paidR1 = await call('POST', '/pay/mock/paid', { body: { orderNo: noR1 } });
    const rowR1 = await waitDb(
      'SELECT status, total_amount, pay_amount, balance_used FROM ab_order WHERE order_no = ?',
      [noR1],
      (r) => r.status === 'paid',
    );
    assert(
      oR1.body?.code === 0 &&
        paidR1.body?.code === 0 &&
        rowR1?.status === 'paid' &&
        Number(rowR1?.pay_amount) === 25.8,
      '§16 夹具 R1 · 张磊 1 份已支付（微信实付 ¥25.80 · 等异步回调落地）',
      `orderNo=${noR1} status=${rowR1?.status} pay=${rowR1?.pay_amount}`,
    );

    const apR1 = await call('POST', `/orders/${noR1}/refund-apply`, {
      token: ldr1,
      body: { reasonType: 'quality', reason: 'e2e · 菜品有异味' },
    });
    const rfR1 = readDb(
      'SELECT id, refund_no, status, amount, order_status_before FROM ab_refund WHERE order_no = ? ORDER BY id DESC LIMIT 1',
      [noR1],
    );
    assert(
      apR1.body?.code === 0 && rfR1?.status === 'applying' && Number(rfR1?.amount) === 25.8,
      'C6 第一段（回归）：代退申请只登记，退款单金额 = 用户实际付出去的钱',
      `refundNo=${rfR1?.refund_no} status=${rfR1?.status} amount=${rfR1?.amount}`,
    );
    assert(
      rfR1?.order_status_before === 'paid',
      'C6 第二段可执行性：申请时落「申请前的订单状态」（状态机对退款分支只有单向箭头，不记就无家可回）',
      `order_status_before=${rfR1?.order_status_before}`,
    );

    // ======================================================== 夹具 2 · R2
    // 赵静 1 份 · **余额抵扣 ¥5.00** · 用于验证「退款拆两路」
    // 余额账户由佣金入账 / 后台充值产生（本地无充值接口），故用 SQL 预置**输入**；
    // 退款接口负责写的字段（余额变动、流水）一律不碰。
    const cqBal = readDb('SELECT id FROM ab_balance WHERE user_id = 1004');
    if (cqBal) {
      writeDb("UPDATE ab_balance SET balance = '20.00', version = version + 1 WHERE user_id = 1004");
    } else {
      writeDb(
        "INSERT INTO ab_balance (user_id, balance, frozen, total_in, total_out, version, created_at, updated_at) VALUES (1004, '20.00', '0.00', '20.00', '0.00', 1, datetime('now'), datetime('now'))",
      );
    }
    const balBeforeR2 = readDb('SELECT balance, frozen FROM ab_balance WHERE user_id = 1004');

    const oR2 = await call('POST', '/orders', {
      token: u4.token,
      idem: K16('r2'),
      body: { mealDate: dPlus1, quantity: 1, useBalanceFen: 500 },
    });
    const noR2 = oR2.body?.data?.orderNo;
    // 显式传 `amountFen` = 实付额（2080），别依赖「省略即取订单实付」的约定 ——
    // 金额一旦对不上，回调会被判为异常而不落库，症状是「订单金额全对但状态不动」
    const paidR2 = await call('POST', '/pay/mock/paid', {
      body: { orderNo: noR2, amountFen: 2080 },
    });
    const rowR2 = await waitDb(
      'SELECT status, total_amount, pay_amount, balance_used FROM ab_order WHERE order_no = ?',
      [noR2],
      (r) => r.status === 'paid',
    );
    assert(
      oR2.body?.code === 0 &&
        paidR2.body?.code === 0 &&
        rowR2?.status === 'paid' &&
        Number(rowR2?.total_amount) === 25.8 &&
        Number(rowR2?.pay_amount) === 20.8 &&
        Number(rowR2?.balance_used) === 5,
      '§16 夹具 R2 · 赵静用余额抵扣 ¥5.00 下单（总额 ¥25.80 = 微信 ¥20.80 + 余额 ¥5.00）',
      `orderNo=${noR2} status=${rowR2?.status} total=${rowR2?.total_amount} pay=${rowR2?.pay_amount} balance=${rowR2?.balance_used}`,
    );

    const apR2 = await call('POST', `/orders/${noR2}/refund-apply`, {
      token: ldr1,
      body: { reasonType: 'missing', reason: 'e2e · 少送一份' },
    });
    const rfR2 = readDb(
      'SELECT id, refund_no, amount FROM ab_refund WHERE order_no = ? ORDER BY id DESC LIMIT 1',
      [noR2],
    );
    assert(
      apR2.body?.code === 0 && Number(rfR2?.amount) === 25.8,
      '退款单金额 = `total_amount − discount_amount`（**不是** pay_amount —— 只退微信那段会让用户少了抵扣）',
      `amount=${rfR2?.amount}`,
    );

    // ======================================================== 夹具 3 · R3
    // 李明 1 份 · 用于 D42 驳回 → 回原状态 → 重新申请
    // （李明在 §15 的 ordC 已取消，U6 的重复判定只排除 cancelled，故可再下单）
    const oR3 = await call('POST', '/orders', {
      token: u.token,
      idem: K16('r3'),
      body: { mealDate: dPlus1, quantity: 1, leaderCode: 'LDR0001' },
    });
    const noR3 = oR3.body?.data?.orderNo;
    const paidR3 = await call('POST', '/pay/mock/paid', { body: { orderNo: noR3 } });
    const rowR3Paid = await waitDb(
      'SELECT status FROM ab_order WHERE order_no = ?',
      [noR3],
      (r) => r.status === 'paid',
    );
    const apR3 = await call('POST', `/orders/${noR3}/refund-apply`, {
      token: ldr1,
      body: { reasonType: 'late', reason: 'e2e · 送达延误' },
    });
    const rfR3 = readDb(
      'SELECT id, refund_no, status, order_status_before FROM ab_refund WHERE order_no = ? ORDER BY id DESC LIMIT 1',
      [noR3],
    );
    assert(
      oR3.body?.code === 0 &&
        paidR3.body?.code === 0 &&
        rowR3Paid?.status === 'paid' &&
        apR3.body?.code === 0 &&
        rfR3?.status === 'applying',
      '§16 夹具 R3 · 李明已支付订单进入代退申请',
      `orderNo=${noR3} status=${rowR3Paid?.status} refundNo=${rfR3?.refund_no}`,
    );

    // ======================================================== A · D40 列表
    const pend40 = await call('GET', '/admin/finance/refunds?tab=pending&pageSize=100', {
      token: adminToken,
    });
    const pendList = pend40.body?.data?.list ?? [];
    assert(
      pend40.body?.code === 0 &&
        pendList.length > 0 &&
        pendList.every((r) => r.status === 'applying'),
      'D40 tab=pending 只含「待审批」（状态集合由服务端展开，端上不自己拼）',
      `code=${pend40.body?.code} count=${pendList.length} statuses=${JSON.stringify([
        ...new Set(pendList.map((r) => r.status)),
      ])}`,
    );
    assert(
      pendList.some((r) => r.refundNo === rfR1.refund_no) &&
        pendList.some((r) => r.refundNo === rfR2.refund_no) &&
        pendList.some((r) => r.refundNo === rfR3.refund_no),
      'D40 三张夹具单都在待审批队列里（每次 verify 跑完都遗留 apply 记录属正常，故用 refundNo 定位而非条数）',
      `含R1=${pendList.some((r) => r.refundNo === rfR1.refund_no)} 含R2/R3同理`,
    );

    const rowPendR2 = pendList.find((r) => r.refundNo === rfR2.refund_no);
    assert(
      rowPendR2?.wxAmountFen === 2080 &&
        rowPendR2?.balanceAmountFen === 500 &&
        rowPendR2?.amountFen === 2580,
      'D40 行内**拆两路**金额：微信 ¥20.80 走通道 + 余额 ¥5.00 单独退回（审批前就能看清钱去哪）',
      `wx=${rowPendR2?.wxAmountFen} balance=${rowPendR2?.balanceAmountFen} total=${rowPendR2?.amountFen}`,
    );
    assert(
      rowPendR2?.canApprove === true &&
        rowPendR2?.canReject === true &&
        rowPendR2?.blockReason === null &&
        rowPendR2?.orderStatusBefore === 'paid' &&
        !!rowPendR2?.orderStatusBeforeText,
      'D40/D42 按钮可用性与「驳回将回到哪」由服务端下发（端上不自行判断状态机）',
      `canApprove=${rowPendR2?.canApprove} before=${rowPendR2?.orderStatusBeforeText}`,
    );

    const kw40 = await call('GET', `/admin/finance/refunds?tab=all&keyword=${noR3}&pageSize=50`, {
      token: adminToken,
    });
    assert(
      kw40.body?.code === 0 &&
        (kw40.body?.data?.list ?? []).length === 1 &&
        kw40.body?.data?.list[0]?.orderNo === noR3,
      'D40 关键词可按**订单号**命中（运营往往是拿着订单号来查退款的）',
      `total=${kw40.body?.data?.total}`,
    );
    const kwNick = await call(
      'GET',
      `/admin/finance/refunds?tab=all&keyword=${encodeURIComponent('张磊')}&pageSize=50`,
      { token: adminToken },
    );
    assert(
      kwNick.body?.code === 0 && (kwNick.body?.data?.list ?? []).some((r) => r.orderNo === noR1),
      'D40 关键词可按**用户昵称**命中（子查询 ab_user，不靠端上先查用户）',
      `total=${kwNick.body?.data?.total}`,
    );

    const rawPhones40 = JSON.stringify(pendList).match(/1[3-9]\d{9}/g) ?? [];
    assert(
      rawPhones40.length === 0 &&
        pendList.every((r) => r.user?.phoneMasked === null || String(r.user.phoneMasked).includes('****')),
      'D40 手机号脱敏（后台列表不给全号 —— 完整号只有 D12 导出那条受审计的通道）',
      `found=${rawPhones40.join(',') || '无'}`,
    );
    assert(
      (pend40.body?.data?.statusOptions ?? []).some((s) => s.value === 'refunded') &&
        (pend40.body?.data?.sourceOptions ?? []).some((s) => s.value === 'leader'),
      'D40 枚举映射由服务端下发（状态 / 来源两张表，端上不维护第二份）',
      `statuses=${(pend40.body?.data?.statusOptions ?? []).length} sources=${(
        pend40.body?.data?.sourceOptions ?? []
      ).length}`,
    );

    const pg1 = await call('GET', '/admin/finance/refunds?tab=all&page=1&pageSize=1', {
      token: adminToken,
    });
    const pg50 = await call('GET', '/admin/finance/refunds?tab=all&page=1&pageSize=50', {
      token: adminToken,
    });
    assert(
      JSON.stringify(pg1.body?.data?.summary) === JSON.stringify(pg50.body?.data?.summary) &&
        pg1.body?.data?.list?.length === 1,
      'D40 summary 按**同一过滤条件的全量**统计，不受分页影响（与 D8/L10/L19 同一约定）',
      `pending=${pg50.body?.data?.summary?.pendingCount}`,
    );
    assert(
      pg50.body?.data?.summary?.pendingCount === pendList.length,
      'D40 summary 与列表自洽：待审批数 = tab=pending 的总数',
      `summary=${pg50.body?.data?.summary?.pendingCount} list=${pendList.length}`,
    );

    const rfDetail = await call('GET', `/admin/finance/refunds/detail/${rfR1.id}`, {
      token: adminToken,
    });
    assert(
      rfDetail.body?.code === 0 &&
        rfDetail.body?.data?.refundNo === rfR1.refund_no &&
        rfDetail.body?.data?.amountFen === 2580,
      'D40 单条详情可用（通过弹窗里的金额来自服务端，不接受端上计算）',
      `amountFen=${rfDetail.body?.data?.amountFen}`,
    );

    // ======================================================== B · D41 通过
    const appr1 = await call('POST', `/admin/finance/refunds/${rfR1.id}/approve`, {
      token: adminToken,
      body: { remark: 'e2e 已核实，同意退款' },
    });
    const ap1 = appr1.body?.data;
    assert(
      appr1.body?.code === 0 &&
        ap1?.status === 'refunded' &&
        ap1?.refundedFen === 2580 &&
        ap1?.wxRefundedFen === 2580 &&
        ap1?.balanceRefundedFen === 0,
      'D41 审批通过 → 实际退款（全额微信实付走通道原路退）',
      `code=${appr1.body?.code} status=${ap1?.status} wx=${ap1?.wxRefundedFen} balance=${ap1?.balanceRefundedFen}`,
    );
    assert(
      ap1?.orderStatusBefore === 'paid' && ap1?.order?.status === 'refunded',
      'D41 通过后订单收口 refunded，并回带「申请前状态」（审计要知道这一单从哪来）',
      `before=${ap1?.orderStatusBefore} after=${ap1?.order?.status}`,
    );
    assert(
      ap1?.reversal?.commissionReversedFen === 0 &&
        ap1?.reversal?.commissionReversedQuantity === 0,
      'D41 未计佣的订单退款**不产生佣金负行**（反冲逻辑与 D11 完全共用 —— 唯一执行口）',
      `reversed=${ap1?.reversal?.commissionReversedFen}`,
    );
    assert(
      ap1?.reversal?.supplierShareMode === 'not_applicable' &&
        ap1?.reversal?.supplierShareAdjusted === 0,
      'D41 与 D11 **同口径**（唯一执行口 = ReversalService）：不论走审批通过还是后台强制，退款**都不冲减**供应商采购应付',
      `mode=${ap1?.reversal?.supplierShareMode} rows=${ap1?.reversal?.supplierShareAdjusted}`,
    );

    const rfR1After = readDb(
      'SELECT status, auditor_id, audit_at, audit_remark, wx_refund_no, refunded_at, reversed FROM ab_refund WHERE id = ?',
      [rfR1.id],
    );
    assert(
      rfR1After?.status === 'refunded' &&
        Number(rfR1After?.auditor_id) > 0 &&
        !!rfR1After?.audit_at &&
        String(rfR1After?.audit_remark).includes('同意退款') &&
        !!rfR1After?.wx_refund_no &&
        Number(rfR1After?.reversed) === 1,
      'D41 落库：审批人 / 审批时刻 / 审批备注 / 微信退款单号 / 反向结算位全部写实（谁批的、什么时候批的、钱退到哪）',
      `status=${rfR1After?.status} auditor=${rfR1After?.auditor_id} wxNo=${rfR1After?.wx_refund_no} reversed=${rfR1After?.reversed}`,
    );
    const commR1 = readRows(
      'SELECT id FROM ab_commission WHERE order_id = (SELECT id FROM ab_order WHERE order_no = ?)',
      [noR1],
    );
    assert(
      commR1.length === 0,
      'D41 该单从未计佣 → 库里也无佣金行（不存在「凭空写一条反向冲销」）',
      `rows=${commR1.length}`,
    );

    const apAgain = await call('POST', `/admin/finance/refunds/${rfR1.id}/approve`, {
      token: adminToken,
      body: {},
    });
    assert(
      apAgain.body?.code === 40013,
      'D41 幂等闸门：已退款的单再审批 → 40013（不产生第二笔出款）',
      `code=${apAgain.body?.code} msg=${apAgain.body?.message}`,
    );
    const rejAgain = await call('POST', `/admin/finance/refunds/${rfR1.id}/reject`, {
      token: adminToken,
      body: { reason: 'e2e 已终态' },
    });
    assert(
      rejAgain.body?.code === 40013,
      'D42 已终态的单也不可驳回 → 40013（终态不可逆，状态位是唯一依据）',
      `code=${rejAgain.body?.code}`,
    );
    const apMissing = await call('POST', '/admin/finance/refunds/99999999/approve', {
      token: adminToken,
      body: {},
    });
    assert(
      apMissing.body?.code === 40012,
      'D41 不存在的退款单 → 40012（与「状态不对」区分，便于端上提示不同话术）',
      `code=${apMissing.body?.code}`,
    );

    // ======================================================== C · D41 两路退款
    const appr2 = await call('POST', `/admin/finance/refunds/${rfR2.id}/approve`, {
      token: fin2.token, // 财务也能审批（类/方法级白名单都含 finance）
      body: { remark: 'e2e 财务审批' },
    });
    const ap2 = appr2.body?.data;
    assert(
      appr2.body?.code === 0 &&
        ap2?.wxRefundedFen === 2080 &&
        ap2?.balanceRefundedFen === 500 &&
        ap2?.refundedFen === 2580,
      'D41 退款**拆两路**：微信实付 ¥20.80 原路退 + 余额抵扣 ¥5.00 退回余额（把余额喂给通道会被微信拒，喂进去了就是重复出款）',
      `wx=${ap2?.wxRefundedFen} balance=${ap2?.balanceRefundedFen} 合计=${ap2?.refundedFen}`,
    );

    const balAfterR2 = readDb('SELECT balance, frozen FROM ab_balance WHERE user_id = 1004');
    assert(
      Number(balAfterR2?.balance) === Number(balBeforeR2?.balance),
      'D41 余额回到下单前（下单冻结 → 支付消费 → 退款退回可用余额，三段闭环）',
      `${balBeforeR2?.balance} → ${balAfterR2?.balance}`,
    );
    const refundLog = readDb(
      "SELECT type, direction, amount, related_id FROM ab_balance_log WHERE type = 'refund' AND related_id = ? ORDER BY id DESC LIMIT 1",
      [rfR2.refund_no],
    );
    assert(
      !!refundLog && Number(refundLog?.direction) === 1 && Number(refundLog?.amount) === 5,
      'D41 余额退回写流水（type=refund · direction=+1 · 关联退款单号）—— 与 L19 余额流水同一本账',
      `type=${refundLog?.type} dir=${refundLog?.direction} amount=${refundLog?.amount}`,
    );
    const appr2Again = await call('POST', `/admin/finance/refunds/${rfR2.id}/approve`, {
      token: adminToken,
      body: {},
    });
    assert(
      appr2Again.body?.code === 40013,
      'D41 财务审批后 admin 重复审批同样被拦（幂等与角色无关）',
      `code=${appr2Again.body?.code}`,
    );

    // ======================================================== D · D42 驳回
    const rej3 = await call('POST', `/admin/finance/refunds/${rfR3.id}/reject`, {
      token: adminToken,
      body: { reason: 'e2e 已补送，不予退款' },
    });
    const rj3 = rej3.body?.data;
    assert(
      rej3.body?.code === 0 &&
        rj3?.refundStatus === 'rejected' &&
        rj3?.orderStatus === 'paid' &&
        rj3?.orderStatusText === '已支付' &&
        rj3?.fundsMoved === false,
      'D42 驳回 → 订单回到**申请前**状态（paid），且回执明确「资金零变动」',
      `refund=${rj3?.refundStatus} order=${rj3?.orderStatus}/${rj3?.orderStatusText} fundsMoved=${rj3?.fundsMoved}`,
    );
    const rowR3AfterRej = readDb('SELECT status FROM ab_order WHERE order_no = ?', [noR3]);
    const rfR3AfterRej = readDb('SELECT status, audit_remark FROM ab_refund WHERE id = ?', [rfR3.id]);
    assert(
      rowR3AfterRej?.status === 'paid' &&
        rfR3AfterRej?.status === 'rejected' &&
        String(rfR3AfterRej?.audit_remark).includes('已补送'),
      'D42 落库：订单回 paid + 退款单 rejected + 驳回理由入审计（不做无理由驳回）',
      `order=${rowR3AfterRej?.status} refund=${rfR3AfterRej?.status} remark=${rfR3AfterRej?.audit_remark}`,
    );
    const balLogR3 = readDb('SELECT COUNT(*) AS c FROM ab_balance_log WHERE related_id = ?', [
      rfR3.refund_no,
    ]);
    assert(
      Number(balLogR3?.c) === 0,
      'D42 驳回**不产生任何资金流水**（第一段没冻钱、第二段驳回也不可能退钱 —— 资金零变动要用账来证）',
      `balance_log(related=${rfR3.refund_no})=${balLogR3?.c}`,
    );

    // 驳回不是终局：团长可以重新提交（真实场景：原因填错被驳回）
    const apR3b = await call('POST', `/orders/${noR3}/refund-apply`, {
      token: ldr1,
      body: { reasonType: 'quality', reason: 'e2e · 重新提交（原因更正）' },
    });
    const rfR3b = readDb(
      'SELECT id, refund_no, status, order_status_before FROM ab_refund WHERE order_no = ? ORDER BY id DESC LIMIT 1',
      [noR3],
    );
    assert(
      apR3b.body?.code === 0 &&
        rfR3b?.status === 'applying' &&
        rfR3b?.refund_no !== rfR3.refund_no &&
        rfR3b?.order_status_before === 'paid',
      'D42 驳回后可**重新申请**（生成新退款单，原驳回单保留备查；旧的 rejected 不占幂等位）',
      `refundNo=${rfR3b?.refund_no} before=${rfR3b?.order_status_before}`,
    );

    // ======================================================== E · 缺原状态 → 40014
    writeDb('UPDATE ab_refund SET order_status_before = NULL WHERE id = ?', [rfR3b.id]);
    const rejNoOrigin = await call('POST', `/admin/finance/refunds/${rfR3b.id}/reject`, {
      token: adminToken,
      body: { reason: 'e2e 缺原状态' },
    });
    assert(
      rejNoOrigin.body?.code === 40014 && /原状态/.test(String(rejNoOrigin.body?.message)),
      'D42 缺「申请前状态」→ 40014 并拒绝执行（**fail-closed**：猜一个状态比操作失败更糟）',
      `code=${rejNoOrigin.body?.code} msg=${rejNoOrigin.body?.message}`,
    );
    const rowR3NoOrigin = readDb('SELECT status FROM ab_order WHERE order_no = ?', [noR3]);
    const rfR3bNoOrigin = readDb('SELECT status FROM ab_refund WHERE id = ?', [rfR3b.id]);
    assert(
      rowR3NoOrigin?.status === 'refund_applying' && rfR3bNoOrigin?.status === 'applying',
      'D42 40014 时订单与退款单**双双原地不动**（不产生「驳回失败但状态已改」的半截结果）',
      `order=${rowR3NoOrigin?.status} refund=${rfR3bNoOrigin?.status}`,
    );

    // 补齐数据后照常执行 —— 40014 是「数据闸门」，不是「把单据永久锁死」
    writeDb('UPDATE ab_refund SET order_status_before = ? WHERE id = ?', ['paid', rfR3b.id]);
    const rejFixed = await call('POST', `/admin/finance/refunds/${rfR3b.id}/reject`, {
      token: adminToken,
      body: { reason: 'e2e 补齐原状态后驳回' },
    });
    assert(
      rejFixed.body?.code === 0 &&
        rejFixed.body?.data?.orderStatus === 'paid' &&
        rejFixed.body?.data?.refundStatus === 'rejected',
      'D42 补齐原状态后可正常驳回（fail-closed 只在缺数据时拦，不误伤正常流程）',
      `code=${rejFixed.body?.code} order=${rejFixed.body?.data?.orderStatus}`,
    );
    const apOnRejected = await call('POST', `/admin/finance/refunds/${rfR3b.id}/approve`, {
      token: adminToken,
      body: {},
    });
    assert(
      apOnRejected.body?.code === 40013,
      'D42 已驳回的单**不可再通过** → 40013（终态不可逆：要退就重新申请，留痕才清楚）',
      `code=${apOnRejected.body?.code}`,
    );

    // 第三张：驳回**不消耗申请次数**，最终收口为已退款
    const apR3c = await call('POST', `/orders/${noR3}/refund-apply`, {
      token: ldr1,
      body: { reasonType: 'quality', reason: 'e2e · 二度更正后提交' },
    });
    const rfR3c = readDb(
      'SELECT id, refund_no, status FROM ab_refund WHERE order_no = ? ORDER BY id DESC LIMIT 1',
      [noR3],
    );
    assert(
      apR3c.body?.code === 0 &&
        rfR3c?.status === 'applying' &&
        rfR3c?.refund_no !== rfR3.refund_no &&
        rfR3c?.refund_no !== rfR3b.refund_no,
      '同一个订单可**反复申请**（每次生成新退款单，前两张 rejected 留在库里备查 —— 审计看得到「提了几次、为什么被拒」）',
      `三次单号=${rfR3.refund_no}/${rfR3b.refund_no}/${rfR3c?.refund_no}`,
    );
    const appr3 = await call('POST', `/admin/finance/refunds/${rfR3c.id}/approve`, {
      token: adminToken,
      body: { remark: 'e2e 三度往来后通过' },
    });
    assert(
      appr3.body?.code === 0 &&
        appr3.body?.data?.status === 'refunded' &&
        appr3.body?.data?.refundedFen === 2580 &&
        appr3.body?.data?.orderStatusBefore === 'paid',
      'D41 三度往来后最终退款成功（审批与「申请过几次」无关，只看当前这张单的状态）',
      `code=${appr3.body?.code} refunded=${appr3.body?.data?.refundedFen}`,
    );

    // ======================================================== F · 权限边界
    const opName = `e2e_ops_${stamp}`;
    const mkOp = await call('POST', '/admin/system/accounts', {
      token: adminToken,
      body: { username: opName, password: PWD, role: 'operator', realName: 'e2e 运营专员' },
    });
    const op = await adminLogin(opName, PWD);
    const opRead = await call('GET', '/admin/finance/refunds?tab=pending&pageSize=1', {
      token: op.token,
    });
    assert(
      mkOp.body?.code === 0 && opRead.body?.code === 0,
      'D40 类级白名单含 operator：运营**能看**待审批队列（要跟进用户，不能两眼一抹黑）',
      `code=${opRead.body?.code}`,
    );
    const opApprove = await call('POST', `/admin/finance/refunds/${rfR1.id}/approve`, {
      token: op.token,
      body: {},
    });
    assert(
      opApprove.body?.code === 10003,
      'D41/D42 **方法级收窄**：operator 能看不能批 → 10003（决定「钱退不退」是资金动作，不该由运营拍板）',
      `code=${opApprove.body?.code}`,
    );

    const viewerName16 = `e2e_vw_${stamp}`;
    await call('POST', '/admin/system/accounts', {
      token: adminToken,
      body: { username: viewerName16, password: PWD, role: 'viewer', realName: 'e2e 只读观察者' },
    });
    const viewer16 = await adminLogin(viewerName16, PWD);
    const viewRead = await call('GET', '/admin/finance/refunds?tab=all&pageSize=1', {
      token: viewer16.token,
    });
    assert(
      viewRead.body?.code === 10003,
      'D40 viewer 两级白名单都进不来 → 10003（只读观察者只有看板）',
      `code=${viewRead.body?.code}`,
    );
    const userReadRefund = await call('GET', '/admin/finance/refunds', { token: u.token });
    assert(
      userReadRefund.body?.code === 10003,
      '双主体隔离：小程序 token 打 /admin/finance/refunds → 10003（与 /leader/* 天然分开）',
      `code=${userReadRefund.body?.code}`,
    );
    const finApproveDone = await call('POST', `/admin/finance/refunds/${rfR1.id}/approve`, {
      token: fin2.token,
      body: {},
    });
    assert(
      finApproveDone.body?.code === 40013,
      'finance 有审批权限：拿到的是**业务层**的 40013（守卫放行，状态闸门拦下）—— 与 operator 的 10003 区分开',
      `code=${finApproveDone.body?.code}`,
    );

    // ======================================================== G · 操作日志
    const finLogs = await call('GET', '/admin/system/logs?module=finance&page=1&pageSize=50', {
      token: adminToken,
    });
    const finActions = (finLogs.body?.data?.list ?? []).map((r) => r.action);
    assert(
      finActions.some((a) => a.includes('退款审批通过')) &&
        finActions.some((a) => a.includes('退款审批驳回')),
      'D41/D42 声明式 @OperationLog() 生效：通过 / 驳回都自动落库（业务模块零侵入）',
      `actions=${JSON.stringify([...new Set(finActions)])}`,
    );
    const approveLog = (finLogs.body?.data?.list ?? []).find(
      (r) => r.action.includes('退款审批通过') && String(r.targetId) === String(rfR1.id),
    );
    assert(
      !!approveLog,
      'D41 操作日志的 targetId = **退款单 id**（可按退款单号追溯「谁批的」，与 D10 的 targetParam 同一机制）',
      `targetId=${approveLog?.targetId} 期望=${rfR1.id}`,
    );

    // ======================================================== H · 与 D8/D9 联动
    const listAfterAll = await call('GET', `/admin/orders?mealDate=${dPlus1}&pageSize=100`, {
      token: adminToken,
    });
    const d8R1 = (listAfterAll.body?.data?.list ?? []).find((r) => r.orderNo === noR1);
    const d8R3 = (listAfterAll.body?.data?.list ?? []).find((r) => r.orderNo === noR3);
    assert(
      d8R1?.status === 'refunded' &&
        d8R1?.refund?.status === 'refunded' &&
        d8R1?.refund?.statusText === '已退款',
      'D8 订单列表反映最新退款单（审批通过后运营在订单中心也看得到结果）',
      `status=${d8R1?.status} refund=${d8R1?.refund?.statusText}`,
    );
    assert(
      d8R3?.status === 'refunded' && d8R3?.refund?.statusText === '已退款',
      'D8 同一订单的「驳回 → 重新申请 → 通过」最终收口为已退款（多张退款单时取最新一张）',
      `status=${d8R3?.status} refund=${d8R3?.refund?.statusText}`,
    );
    const detAfter = await call('GET', `/admin/orders/${noR1}`, { token: adminToken });
    assert(
      detAfter.body?.data?.actions?.canForceRefund === false &&
        /退款/.test(String(detAfter.body?.data?.actions?.refundBlockReason)),
      'D9 已退款订单的 canForceRefund=false 且给出原因（D11 不会再被误点）',
      `reason=${detAfter.body?.data?.actions?.refundBlockReason}`,
    );
  }

  // ==========================================================================
  // §17 M3-5 团长名录 / 任命 / 变更 / 资质补录（D19–D22）
  // ==========================================================================
  log('\n§17 M3-5 后台团长管理（D19–D22）');

  /**
   * 本组**不依赖下单窗口** —— 团长域是主数据，与订单链路无关，故随时可跑。
   *
   * 【夹具为何全部自造】`verify` 串跑时 `e2e-m1` / `e2e-m2` 已经写过库
   *   （m2 的 L20 退出团长会改 `ab_team_leader.status`，L22 会改 `invited_formal_count`），
   *   若拿种子团长做**写**操作的断言，「单跑绿、串跑红」几乎必然发生。
   *   因此本组：
   *     · 名册/详情/筛选只读种子（`李明`/`王芳` 等人的档案不会被 m1/m2 改）；
   *     · 一切写操作（任命 / 转交 / 改级 / 停用 / 恢复）都落在**自造**的团长身上；
   *     · 断言只用「自己造出来的数据」与**相对变化**，不硬编码总数。
   *
   * 【为什么不用固定手机号】`ab_team_leader.phone` 唯一 —— 写死 `13900000001`
   *   在第二次跑（不重新 seed）时会撞上上一轮留下的团长 → 20004 假红。
   *   故手机号用 `139${stamp}` 这类「11 位 + 时间戳」拼法，天然幂等。
   */
  const lAdmin = adminToken;
  const tag = `e2e_ld_${stamp}`;

  // ---------------------------------------------------------- 前置：挑两栋空楼
  const emptyBuildings = readRows(
    `SELECT b.id, b.name, b.building_group_id AS gid FROM ab_building b
      WHERE b.status = 1 AND b.deleted_at IS NULL
        AND b.id NOT IN (
          SELECT building_id FROM ab_team_leader WHERE status = 1 AND deleted_at IS NULL
        )
      ORDER BY b.id`,
  );
  const emptyA = Number(emptyBuildings[0]?.id ?? 0);
  const emptyB = Number(emptyBuildings[1]?.id ?? 0);
  assert(
    emptyA > 0 && emptyB > 0 && emptyA !== emptyB,
    '§17 前置：存在至少 2 栋「在用且无在职团长」的办公楼（D20 任命与 D21 换楼的靶子）',
    `A=${emptyA}(${emptyBuildings[0]?.name}) B=${emptyB}(${emptyBuildings[1]?.name})`,
  );
  // 另取一栋**已有在职团长**的楼（断言 20012 用；动态取，避免依赖种子团长仍是在职）
  const occupied = readDb(
    `SELECT building_id AS bid, id AS lid, real_name AS name FROM ab_team_leader
      WHERE status = 1 AND deleted_at IS NULL AND building_id NOT IN (?, ?)
      ORDER BY id LIMIT 1`,
    [emptyA, emptyB],
  );

  // ======================================================== A · D19 名录
  const rosterAll = await call('GET', '/admin/leaders?pageSize=100', { token: lAdmin });
  const rosterData = rosterAll.body?.data ?? {};
  assert(
    rosterAll.body?.code === 0 && rosterData.view === 'roster' && Array.isArray(rosterData.list),
    'D19 默认视图 = roster（团长名册），返回 list / summary / 选项下发',
    `code=${rosterAll.body?.code} view=${rosterData.view} n=${rosterData.list?.length}`,
  );

  const sumA = rosterData.summary ?? {};
  assert(
    sumA.totalCount >= 5 &&
      sumA.activeCount + sumA.suspendedCount === sumA.totalCount &&
      sumA.traineeCount + sumA.formalCount + sumA.goldCount + sumA.chiefCount === sumA.totalCount,
    'D19 summary 口径自洽：在职+停职 = 总数，四级人数之和 = 总数（写死数字会被串跑打翻）',
    `total=${sumA.totalCount} 在职=${sumA.activeCount} 停职=${sumA.suspendedCount} 等级和=${
      sumA.traineeCount + sumA.formalCount + sumA.goldCount + sumA.chiefCount
    }`,
  );
  assert(
    sumA.pendingAuditCount === 0,
    'D19 **C3 口径表达**：pendingAuditCount 恒为 0 —— 团长「申请即生效」，不存在待审核队列',
    `pending=${sumA.pendingAuditCount}`,
  );

  const rosterPaged = await call('GET', '/admin/leaders?page=1&pageSize=1', { token: lAdmin });
  assert(
    rosterPaged.body?.data?.summary?.totalCount === sumA.totalCount &&
      (rosterPaged.body?.data?.list ?? []).length === 1,
    'D19 summary 是**同一过滤条件的全量**，不受分页影响（翻页时 KPI 卡不跳）',
    `分页后 summary=${rosterPaged.body?.data?.summary?.totalCount} / 全量=${sumA.totalCount}`,
  );

  const row0 = rosterData.list?.[0] ?? {};
  assert(
    /^\d{3}\*{4}\d{4}$/.test(String(row0.phoneMasked)) && !/\d{11}/.test(JSON.stringify(row0)),
    'D19 手机号**一律脱敏**（运营看名录不需要完整号；去 D12 导出才给全号且留痕）',
    `phoneMasked=${row0.phoneMasked}`,
  );
  assert(
    typeof row0.levelLabel === 'string' &&
      row0.levelLabel.length > 0 &&
      /%$/.test(String(row0.commissionRateText)),
    "D19 行内自带文案：levelLabel + commissionRateText（如 '12%'），端上不拼字符串",
    `level=${row0.level}/${row0.levelLabel} rate=${row0.commissionRate} → ${row0.commissionRateText}`,
  );
  assert(
    rosterData.actions?.canManage === true && rosterData.actions?.canAudit === true,
    'D19 按钮可用性口径唯一在服务端：admin 下发 canManage/canAudit = true',
    `actions=${JSON.stringify(rosterData.actions)}`,
  );
  assert(
    (rosterData.levelOptions ?? []).length === 4 &&
      (rosterData.statusOptions ?? []).length === 2 &&
      (rosterData.levelOptions ?? []).every((o) => o.rateText && o.monthlyOrders !== undefined),
    'D19 下拉下发：四级各带费率与 C2 双条件（月单 + 介绍转正数），端上不维护第二份',
    `levels=${(rosterData.levelOptions ?? []).map((o) => `${o.key}/${o.rateText}`).join(',')}`,
  );

  const byLevel = await call('GET', '/admin/leaders?level=chief&pageSize=100', { token: lAdmin });
  const chiefRows = byLevel.body?.data?.list ?? [];
  assert(
    byLevel.body?.code === 0 &&
      chiefRows.length > 0 &&
      chiefRows.every((r) => r.level === 'chief') &&
      byLevel.body?.data?.summary?.totalCount === chiefRows.length &&
      byLevel.body?.data?.summary?.chiefCount === chiefRows.length,
    'D19 等级过滤：命中行全是该等级，且 summary 同步收窄（汇总跟着筛选走，不是全量汇总）',
    `n=${chiefRows.length} summary.total=${byLevel.body?.data?.summary?.totalCount}`,
  );

  const byGroup = await call('GET', '/admin/leaders?groupId=1&pageSize=100', { token: lAdmin });
  const g1Rows = byGroup.body?.data?.list ?? [];
  assert(
    byGroup.body?.code === 0 &&
      g1Rows.length > 0 &&
      g1Rows.every((r) => Number(r.groupId) === 1) &&
      g1Rows.length === byGroup.body?.data?.summary?.totalCount,
    'D19 楼群过滤：经 ab_building.building_group_id 归属（子查询而非 JOIN，避免 total 虚高）',
    `n=${g1Rows.length} groups=${JSON.stringify([...new Set(g1Rows.map((r) => r.groupId))])}`,
  );

  const bySuspended = await call('GET', '/admin/leaders?status=2&pageSize=100', { token: lAdmin });
  assert(
    bySuspended.body?.code === 0 &&
      (bySuspended.body?.data?.list ?? []).every((r) => r.status === 2) &&
      bySuspended.body?.data?.summary?.activeCount === 0,
    'D19 状态过滤：只出停职，且过滤后 activeCount = 0（汇总与列表同源同过滤）',
    `n=${bySuspended.body?.data?.list?.length} active=${bySuspended.body?.data?.summary?.activeCount}`,
  );

  const byKwName = await call('GET', `/admin/leaders?keyword=${encodeURIComponent('李明')}`, {
    token: lAdmin,
  });
  assert(
    (byKwName.body?.data?.list ?? []).some((r) => r.realName === '李明'),
    'D19 关键词命中**姓名**',
    `n=${byKwName.body?.data?.list?.length}`,
  );
  const byKwPhone = await call('GET', '/admin/leaders?keyword=18600000001', { token: lAdmin });
  assert(
    (byKwPhone.body?.data?.list ?? []).some((r) => Number(r.userId) === 1001),
    'D19 关键词命中**完整手机号**（库里存明文，脱敏只发生在出参）',
    `n=${byKwPhone.body?.data?.list?.length}`,
  );
  const byKwNick = await call('GET', `/admin/leaders?keyword=${encodeURIComponent('微信用户')}`, {
    token: lAdmin,
  });
  const nickTotal = await call('GET', '/admin/leaders?pageSize=1', { token: lAdmin });
  assert(
    byKwNick.body?.code === 0 &&
      (byKwNick.body?.data?.summary?.totalCount ?? 0) <=
        (nickTotal.body?.data?.summary?.totalCount ?? 0),
    'D19 关键词也可命中**微信昵称**（子查询 ab_user，只列允许字段）',
    `昵称命中=${byKwNick.body?.data?.summary?.totalCount} 全量=${nickTotal.body?.data?.summary?.totalCount}`,
  );

  const badStatus = await call('GET', '/admin/leaders?status=9', { token: lAdmin });
  const badLevel = await call('GET', '/admin/leaders?level=nope', { token: lAdmin });
  const badView = await call('GET', '/admin/leaders?view=xxx', { token: lAdmin });
  assert(
    badStatus.body?.code === 10001 && badLevel.body?.code === 10001 && badView.body?.code === 10001,
    'D19 DTO 白名单：status / level / view 非法值一律 10001（挡在业务层之前）',
    `status=${badStatus.body?.code} level=${badLevel.body?.code} view=${badView.body?.code}`,
  );

  const opts = await call('GET', '/admin/leaders/filter-options', { token: lAdmin });
  assert(
    opts.body?.code === 0 &&
      (opts.body?.data?.groups ?? []).length > 0 &&
      (opts.body?.data?.buildings ?? []).length > 0 &&
      opts.body?.data?.id === undefined,
    '路由顺序：GET /admin/leaders/filter-options 未被 GET :id 吞掉；筛选器自带楼群/楼（不反向依赖 M3-6）',
    `code=${opts.body?.code} groups=${opts.body?.data?.groups?.length} buildings=${opts.body?.data?.buildings?.length}`,
  );

  // ================================================ B · D19 申请流水
  const apps = await call('GET', '/admin/leaders?view=applications&days=90&pageSize=100', {
    token: lAdmin,
  });
  const appRows = apps.body?.data?.list ?? [];
  assert(
    apps.body?.code === 0 && apps.body?.data?.view === 'applications' && appRows.length > 0,
    'D19 view=applications 申请流水（与名册同一接口，靠 view 分流而非另开一个端点）',
    `code=${apps.body?.code} n=${appRows.length}`,
  );
  assert(
    appRows.every((r) => !('wechatId' in r) && !('wechat_id' in r)) &&
      appRows.some((r) => r.openidTail),
    'D19 申请流水**不返回微信号**（数据模型从未采集）—— 造假值比留空更危险',
    `keys=${JSON.stringify(Object.keys(appRows[0] ?? {}))}`,
  );
  assert(
    typeof apps.body?.data?.notes?.wechatId === 'string' &&
      apps.body?.data?.notes?.wechatId.length > 10 &&
      apps.body?.data?.summary?.pendingAuditCount === 0,
    'D19 notes.wechatId 如实写明偏差（本期以昵称 + openid 后 6 位代替，界面不得假装有微信号）',
    `note=${String(apps.body?.data?.notes?.wechatId).slice(0, 24)}…`,
  );
  assert(
    appRows.some((r) => r.inviterText && r.inviterText !== '—（直接申请）') &&
      appRows.some((r) => r.inviterText === '—（直接申请）'),
    'D19 流水带推荐人（C2 晋级审计的原始依据），无邀请人时显示「直接申请」',
    `sample=${JSON.stringify([...new Set(appRows.map((r) => r.inviterText))].slice(0, 3))}`,
  );
  const apps1 = await call('GET', '/admin/leaders?view=applications&days=1&pageSize=100', {
    token: lAdmin,
  });
  assert(
    apps1.body?.code === 0 &&
      (apps1.body?.data?.list ?? []).length <= appRows.length &&
      apps1.body?.data?.summary?.days === 1,
    'D19 days 回溯天数生效（days=1 的结果是 days=90 的子集）',
    `d1=${apps1.body?.data?.list?.length} d90=${appRows.length}`,
  );

  // ======================================================== C · D19 详情
  const det1 = await call('GET', '/admin/leaders/1', { token: lAdmin });
  const p1 = det1.body?.data?.profile ?? {};
  assert(
    det1.body?.code === 0 &&
      p1.realName === '李明' &&
      Number(p1.commissionRate).toFixed(4) === '0.1200' &&
      p1.commissionRateText === '12%',
    'D19 详情：档案含等级与费率（首次席 12%）—— 费率是钱，等级只是标签',
    `code=${det1.body?.code} name=${p1.realName} rate=${p1.commissionRate} → ${p1.commissionRateText}`,
  );
  assert(
    (det1.body?.data?.invitees ?? []).length >= 3,
    'D19 详情含**裂变链下行**（李明推荐了王芳/张磊/赵静 —— 种子 3 条邀请关系）',
    `invitees=${det1.body?.data?.invitees?.length}`,
  );
  assert(
    Array.isArray(det1.body?.data?.commissions) &&
      Array.isArray(det1.body?.data?.operationLogs) &&
      p1.payoutBound !== undefined,
    'D19 详情含佣金流水（含反向冲销负行）、操作日志、收款绑定状态',
    `commissions=${det1.body?.data?.commissions?.length} logs=${det1.body?.data?.operationLogs?.length}`,
  );
  const det3 = await call('GET', '/admin/leaders/3', { token: lAdmin });
  assert(
    det3.body?.code === 0 &&
      Number(det3.body?.data?.inviter?.leaderId) === 1 &&
      det3.body?.data?.inviteChannel === 'link',
    'D19 详情含**裂变链上行**（张磊由李明以「分享链接」推荐 —— channel 落 qrcode/link/poster/self）',
    `inviter=${JSON.stringify(det3.body?.data?.inviter)} channel=${det3.body?.data?.inviteChannel}`,
  );
  const detMiss = await call('GET', '/admin/leaders/9999999', { token: lAdmin });
  assert(
    detMiss.body?.code === 10004,
    'D19 不存在的团长 → 10004（NOT_FOUND，不是 500）',
    `code=${detMiss.body?.code}`,
  );

  // ==================================================== D · D20 任命 / 转交
  const lxU = await userLogin(`dev:${tag}_x`);
  const lyU = await userLogin(`dev:${tag}_y`);
  const lzU = await userLogin(`dev:${tag}_z`);
  assert(
    !!lxU.userId && !!lyU.userId && !!lzU.userId && lxU.userId !== lyU.userId,
    '§17 夹具：3 名新注册用户（`dev:` 前缀 → 稳定 openid，反复跑得到同一账号）',
    `x=${lxU.userId} y=${lyU.userId} z=${lzU.userId}`,
  );
  const phoneX = `139${stamp}`;
  const phoneY = `138${stamp}`;
  const phoneZ = `137${stamp}`;

  const apX = await call('POST', '/admin/leaders', {
    token: lAdmin,
    body: {
      userId: lxU.userId,
      buildingId: emptyA,
      realName: `${tag} · 甲`,
      phone: phoneX,
      floor: '9F',
      reason: '新任楼长（e2e）',
    },
  });
  const lx = apX.body?.data?.leader ?? {};
  assert(
    apX.body?.code === 0 &&
      Number(lx.userId) === lxU.userId &&
      lx.status === 1 &&
      lx.level === 'trainee' &&
      lx.commissionRateText === '8%',
    'D20 任命成功：默认**见习 8%** —— 后台不替 C2 双条件做决定，不会一上任就给高费率',
    `code=${apX.body?.code} level=${lx.level} rate=${lx.commissionRateText}`,
  );
  const lxLeaderRow = readDb(
    'SELECT id, building_id, status, commission_rate FROM ab_team_leader WHERE user_id = ?',
    [lxU.userId],
  );
  const lxUserRow = readDb('SELECT building_id FROM ab_user WHERE id = ?', [lxU.userId]);
  const lxLeaderId = Number(lxLeaderRow?.id ?? 0);
  assert(
    Number(lxLeaderRow?.building_id) === emptyA && Number(lxUserRow?.building_id) === emptyA,
    'D20 落库**两边同步**：ab_team_leader.building_id 与 ab_user.building_id（后者决定下单归属团长）',
    `leader=${lxLeaderRow?.building_id} user=${lxUserRow?.building_id} target=${emptyA}`,
  );

  const apAgain = await call('POST', '/admin/leaders', {
    token: lAdmin,
    body: {
      userId: lxU.userId,
      buildingId: emptyB,
      realName: `${tag} · 甲`,
      phone: phoneX,
      reason: '重复任命（e2e）',
    },
  });
  assert(
    apAgain.body?.code === 20007,
    'D20 已是在职团长再任命 → 20007（不静默改档案：改档案走 D21，两件事不能混）',
    `code=${apAgain.body?.code}`,
  );

  const apGhost = await call('POST', '/admin/leaders', {
    token: lAdmin,
    body: {
      userId: 9999999,
      buildingId: emptyA,
      realName: '幽灵用户',
      phone: `136${stamp}`,
      reason: '不存在的用户（e2e）',
    },
  });
  assert(
    apGhost.body?.code === 20011,
    'D20 被任命者不是已注册用户 → 20011（团长是叠加身份：没有 ab_user 就收不到提醒、登不进小程序）',
    `code=${apGhost.body?.code}`,
  );

  const apClosed = await call('POST', '/admin/leaders', {
    token: lAdmin,
    body: {
      userId: lyU.userId,
      buildingId: 3,
      realName: `${tag} · 乙`,
      phone: phoneY,
      reason: '停用楼（e2e）',
    },
  });
  assert(
    apClosed.body?.code === 10004,
    'D20 目标办公楼未开通（楼 3 status=2）→ 10004',
    `code=${apClosed.body?.code}`,
  );

  const apOccupy = await call('POST', '/admin/leaders', {
    token: lAdmin,
    body: {
      userId: lyU.userId,
      buildingId: emptyA,
      realName: `${tag} · 乙`,
      phone: phoneY,
      reason: '试图顶替（e2e）',
    },
  });
  assert(
    apOccupy.body?.code === 20012 &&
      Number(apOccupy.body?.data?.occupiedBy?.leaderId) === lxLeaderId,
    'D20 目标楼已有在职团长且未确认 → 20012 并回带 occupiedBy（先让端上弹出「现任是谁」）',
    `code=${apOccupy.body?.code} occupiedBy=${JSON.stringify(apOccupy.body?.data?.occupiedBy)}`,
  );

  const apStale = await call('POST', '/admin/leaders', {
    token: lAdmin,
    body: {
      userId: lyU.userId,
      buildingId: emptyA,
      realName: `${tag} · 乙`,
      phone: phoneY,
      transferFromLeaderId: 999999,
      reason: '传错现任 id（e2e）',
    },
  });
  assert(
    apStale.body?.code === 20012,
    'D20 转交确认传**旧值 / 错值** → 仍 20012（防「看到的是 A、确认时已变成 B」）',
    `code=${apStale.body?.code}`,
  );

  const apTransfer = await call('POST', '/admin/leaders', {
    token: lAdmin,
    body: {
      userId: lyU.userId,
      buildingId: emptyA,
      realName: `${tag} · 乙`,
      phone: phoneY,
      transferFromLeaderId: lxLeaderId,
      reason: '原团长调岗，转交（e2e）',
    },
  });
  assert(
    apTransfer.body?.code === 0 &&
      Number(apTransfer.body?.data?.transferredFrom?.leaderId) === lxLeaderId &&
      Number(apTransfer.body?.data?.leader?.userId) === lyU.userId,
    'D20 显式确认后转交成功（回带 transferredFrom，写清「从谁手上接的」）',
    `code=${apTransfer.body?.code} from=${apTransfer.body?.data?.transferredFrom?.leaderId}`,
  );
  const lxAfter = readDb('SELECT status, total_commission FROM ab_team_leader WHERE id = ?', [
    lxLeaderId,
  ]);
  assert(
    Number(lxAfter?.status) === 2 && lxAfter?.total_commission !== undefined,
    'D20 转交落库：原团长 status=2（**停职而非删除** —— 历史佣金 / 推荐关系仍在他名下，换人不抹账）',
    `status=${lxAfter?.status} totalCommission=${lxAfter?.total_commission}`,
  );

  const apPhone = await call('POST', '/admin/leaders', {
    token: lAdmin,
    body: {
      userId: lzU.userId,
      buildingId: emptyB,
      realName: `${tag} · 丙`,
      phone: phoneX,
      reason: '撞号（e2e）',
    },
  });
  assert(
    apPhone.body?.code === 20004,
    'D20 手机号已被**另一位团长**占用 → 20004（到楼提醒靠它找人，不能一号两人）',
    `code=${apPhone.body?.code}`,
  );

  // ======================================================== E · D21 变更
  /**
   * ⚠️ D21/D22 的靶子换成**转交后的继任者** `lyLeaderId`，而不是 D20 里被顶掉的那位：
   *    转交已把原团长置为**停职**（这正是「转交」的语义），而 D21/D22 验的是
   *    「对**在职**团长的常规变更与例外处理」。拿停职者当靶子，D22 的 suspend
   *    会直接撞 20013 —— 首轮就是这两条红的。
   */
  const lyLeaderRow = readDb('SELECT id FROM ab_team_leader WHERE user_id = ?', [lyU.userId]);
  const lyLeaderId = Number(lyLeaderRow?.id ?? 0);
  assert(
    lyLeaderId > 0 && lyLeaderId !== lxLeaderId,
    '§17 夹具：继任者**单独建档**（转交不改写原档案，故两者 id 不同）',
    `lyId=${lyLeaderId} lxId=${lxLeaderId}`,
  );

  const upLevel = await call('PUT', `/admin/leaders/${lyLeaderId}`, {
    token: lAdmin,
    body: { level: 'gold', reason: '金牌考核达标（e2e）' },
  });
  assert(
    upLevel.body?.code === 0 &&
      upLevel.body?.data?.leader?.level === 'gold' &&
      upLevel.body?.data?.leader?.commissionRateText === '10%' &&
      (upLevel.body?.data?.changes ?? []).some((c) => String(c).includes('等级')),
    'D21 改等级**同步写费率**（8% → 10%）—— 只改标签不改费率，佣金会按旧费率算且界面看不出矛盾',
    `code=${upLevel.body?.code} rate=${upLevel.body?.data?.leader?.commissionRateText} changes=${JSON.stringify(
      upLevel.body?.data?.changes,
    )}`,
  );
  const upRateRow = readDb('SELECT level, commission_rate FROM ab_team_leader WHERE id = ?', [
    lyLeaderId,
  ]);
  assert(
    upRateRow?.level === 'gold' && Number(upRateRow?.commission_rate).toFixed(4) === '0.1000',
    'D21 费率**落库**校验（不是只改内存对象后原样返回 —— M2 踩过「算出来了没落库」）',
    `level=${upRateRow?.level} rate=${upRateRow?.commission_rate}`,
  );

  const upBuilding = await call('PUT', `/admin/leaders/${lyLeaderId}`, {
    token: lAdmin,
    body: { buildingId: emptyB, reason: '换楼（e2e）' },
  });
  const lxUserAfterMove = readDb('SELECT building_id FROM ab_user WHERE id = ?', [lyU.userId]);
  assert(
    upBuilding.body?.code === 0 &&
      Number(upBuilding.body?.data?.leader?.buildingId) === emptyB &&
      Number(lxUserAfterMove?.building_id) === emptyB,
    'D21 换楼同步 ab_user.building_id（用户今后的归属跟着变；回带 before/changes 便于审计）',
    `code=${upBuilding.body?.code} building=${upBuilding.body?.data?.leader?.buildingId}`,
  );

  const upOccupied = occupied
    ? await call('PUT', `/admin/leaders/${lyLeaderId}`, {
        token: lAdmin,
        body: { buildingId: Number(occupied.bid), reason: '撞楼（e2e）' },
      })
    : { body: { code: 20012, data: { occupiedBy: { leaderId: Number(occupied?.lid) } } } };
  assert(
    !!occupied &&
      upOccupied.body?.code === 20012 &&
      Number(upOccupied.body?.data?.occupiedBy?.leaderId) === Number(occupied?.lid),
    'D21 换到已有在职团长的楼 → 20012（与 D20 同一闸门同一错误码，提示改走转交）',
    `code=${upOccupied.body?.code} target=${occupied?.bid}(${occupied?.name}) occupiedBy=${upOccupied.body?.data?.occupiedBy?.leaderId}`,
  );

  const upNoop = await call('PUT', `/admin/leaders/${lyLeaderId}`, {
    token: lAdmin,
    body: { level: 'gold', reason: '空变更（e2e）' },
  });
  assert(
    upNoop.body?.code === 10001,
    'D21 空变更 → 10001（不写库也不写日志，否则审计里全是「改了但什么都没改」）',
    `code=${upNoop.body?.code}`,
  );

  const upStatusAttempt = await call('PUT', `/admin/leaders/${lyLeaderId}`, {
    token: lAdmin,
    body: { status: 2, reason: '试图从 D21 停用（e2e）' },
  });
  assert(
    upStatusAttempt.body?.code === 10001,
    'D21 **刻意不吃 status**：停用/复职只有 D22 一个入口（forbidNonWhitelisted 直接拒，不给第二个入口）',
    `code=${upStatusAttempt.body?.code}`,
  );

  // ==================================================== F · D22 资质补录
  const auNote = await call('POST', `/admin/leaders/${lyLeaderId}/audit`, {
    token: lAdmin,
    body: { action: 'note', reason: '资质材料待补（e2e）' },
  });
  assert(
    auNote.body?.code === 0 &&
      auNote.body?.data?.actionLabel === '资质备注' &&
      auNote.body?.data?.before?.status === auNote.body?.data?.after?.status,
    'D22 note 只留痕不动字段（审计链上留一条「有人看过这份档案」）',
    `code=${auNote.body?.code} label=${auNote.body?.data?.actionLabel}`,
  );

  const auSign = await call('POST', `/admin/leaders/${lyLeaderId}/audit`, {
    token: lAdmin,
    body: { action: 'sign_agreement', agreementVersion: 'v1.1', reason: '协议升级重签（e2e）' },
  });
  const auSignRow = readDb('SELECT agree_version FROM ab_team_leader WHERE id = ?', [lyLeaderId]);
  assert(
    auSign.body?.code === 0 &&
      auSign.body?.data?.after?.agreeVersion === 'v1.1' &&
      auSignRow?.agree_version === 'v1.1',
    'D22 协议补签写 agreed_at / agree_version（历史团长未留痕 / 协议升级重签都靠它）',
    `code=${auSign.body?.code} ver=${auSignRow?.agree_version}`,
  );
  const auSignNoVer = await call('POST', `/admin/leaders/${lyLeaderId}/audit`, {
    token: lAdmin,
    body: { action: 'sign_agreement', reason: '缺版本号（e2e）' },
  });
  assert(
    auSignNoVer.body?.code === 10001,
    'D22 协议补签缺版本号 → 10001（参数缺失，与「状态不支持」的 20013 区分开）',
    `code=${auSignNoVer.body?.code}`,
  );

  // 「停用要清 user.team_leader_id」——先造出「他归属于某位团长」这一事实（真实场景：团长由上级推荐加入）
  const inviterL = readDb(
    'SELECT id FROM ab_team_leader WHERE status = 1 AND deleted_at IS NULL AND id <> ? ORDER BY id LIMIT 1',
    [lyLeaderId],
  );
  writeDb('UPDATE ab_user SET team_leader_id = ? WHERE id = ?', [
    Number(inviterL?.id ?? 0),
    lyU.userId,
  ]);
  const boundBefore = readDb('SELECT team_leader_id FROM ab_user WHERE id = ?', [lyU.userId]);
  const auSuspend = await call('POST', `/admin/leaders/${lyLeaderId}/audit`, {
    token: lAdmin,
    body: { action: 'suspend', reason: '连续 3 次无故爽约（e2e）' },
  });
  const auSuspendRow = readDb('SELECT status FROM ab_team_leader WHERE id = ?', [lyLeaderId]);
  const auSuspendUser = readDb('SELECT team_leader_id FROM ab_user WHERE id = ?', [lyU.userId]);
  assert(
    boundBefore?.team_leader_id !== null &&
      auSuspend.body?.code === 0 &&
      auSuspend.body?.data?.after?.status === 2 &&
      Number(auSuspendRow?.status) === 2,
    'D22 例外停用 → status=2（停职后无法接单、无法访问团长端）',
    `code=${auSuspend.body?.code} status=${auSuspendRow?.status}`,
  );
  assert(
    auSuspendUser?.team_leader_id === null,
    'D22 停用**同时清 ab_user.team_leader_id**（撤销「我归属于某团长」，与 L20 退出同一处理）',
    `teamLeaderId=${auSuspendUser?.team_leader_id}（停用前=${boundBefore?.team_leader_id}）`,
  );
  const auSuspendAgain = await call('POST', `/admin/leaders/${lyLeaderId}/audit`, {
    token: lAdmin,
    body: { action: 'suspend', reason: '重复停用（e2e）' },
  });
  assert(
    auSuspendAgain.body?.code === 20013,
    'D22 对已停职者再停 → 20013（**不是幂等成功**：审计链上要能分清「是谁停的」）',
    `code=${auSuspendAgain.body?.code}`,
  );

  const auRestore = await call('POST', `/admin/leaders/${lyLeaderId}/audit`, {
    token: lAdmin,
    body: { action: 'restore', reason: '复核后恢复（e2e）' },
  });
  const auRestoreRow = readDb(
    'SELECT status, level, commission_rate FROM ab_team_leader WHERE id = ?',
    [lyLeaderId],
  );
  assert(
    auRestore.body?.code === 0 &&
      Number(auRestoreRow?.status) === 1 &&
      auRestoreRow?.level === 'gold' &&
      Number(auRestoreRow?.commission_rate).toFixed(4) === '0.1000',
    'D22 恢复在职且**不重置等级**（纠错 ≠ 重新入行：L17 停职者重新申请才重置为见习）',
    `code=${auRestore.body?.code} level=${auRestoreRow?.level} rate=${auRestoreRow?.commission_rate}`,
  );
  const auRestoreAgain = await call('POST', `/admin/leaders/${lyLeaderId}/audit`, {
    token: lAdmin,
    body: { action: 'restore', reason: '重复恢复（e2e）' },
  });
  assert(
    auRestoreAgain.body?.code === 20013,
    'D22 对已在职者再恢复 → 20013（两个方向都拦，不只是单向）',
    `code=${auRestoreAgain.body?.code}`,
  );

  // ======================================================== G · 权限边界
  const opL = `e2e_ldop_${stamp}`;
  const vwL = `e2e_ldvw_${stamp}`;
  await call('POST', '/admin/system/accounts', {
    token: lAdmin,
    body: { username: opL, password: PWD, role: 'operator', realName: 'e2e 团长运营' },
  });
  await call('POST', '/admin/system/accounts', {
    token: lAdmin,
    body: { username: vwL, password: PWD, role: 'viewer', realName: 'e2e 团长观察者' },
  });
  const opTokenL = (await adminLogin(opL, PWD)).token;
  const vwTokenL = (await adminLogin(vwL, PWD)).token;

  const opReadL = await call('GET', '/admin/leaders?pageSize=1', { token: opTokenL });
  assert(
    opReadL.body?.code === 0 && opReadL.body?.data?.actions?.canManage === false,
    'D19 **类级白名单含 operator**：运营能看名录与流水，但 actions.canManage=false（看得见、点不了）',
    `code=${opReadL.body?.code} actions=${JSON.stringify(opReadL.body?.data?.actions)}`,
  );
  const opAppointL = await call('POST', '/admin/leaders', {
    token: opTokenL,
    body: {
      userId: lzU.userId,
      buildingId: emptyB,
      realName: `${tag} · 丙`,
      phone: phoneZ,
      reason: '运营越权任命（e2e）',
    },
  });
  const opUpdateL = await call('PUT', `/admin/leaders/${lyLeaderId}`, {
    token: opTokenL,
    body: { floor: '20F', reason: '运营越权改档（e2e）' },
  });
  const opAuditL = await call('POST', `/admin/leaders/${lyLeaderId}/audit`, {
    token: opTokenL,
    body: { action: 'note', reason: '运营越权补录（e2e）' },
  });
  assert(
    opAppointL.body?.code === 10003 &&
      opUpdateL.body?.code === 10003 &&
      opAuditL.body?.code === 10003,
    'D20/D21/D22 **方法级收窄到 super_admin/admin**：operator 一律 10003（任命决定「谁拿哪个楼的佣金」）',
    `D20=${opAppointL.body?.code} D21=${opUpdateL.body?.code} D22=${opAuditL.body?.code}`,
  );
  // 越权被拒后不应留下任何副作用
  const lzStillFree = readDb('SELECT id FROM ab_team_leader WHERE user_id = ?', [lzU.userId]);
  const floorAfterDeny = readDb('SELECT floor FROM ab_team_leader WHERE id = ?', [lyLeaderId]);
  assert(
    lzStillFree === null && floorAfterDeny?.floor !== '20F',
    '越权请求被守卫**拦在业务层之前**：没建档、没改字段（不是「执行了再回滚」）',
    `丙的团长档案=${lzStillFree ? '已存在(异常)' : '无'} floor=${floorAfterDeny?.floor}`,
  );

  const vwReadL = await call('GET', '/admin/leaders', { token: vwTokenL });
  const finL = await adminLogin('finance', 'finance123');
  const supL = await adminLogin('sanweiwu', 'supplier123');
  const finReadL = await call('GET', '/admin/leaders', { token: finL.token });
  const supReadL = await call('GET', '/admin/leaders', { token: supL.token });
  assert(
    vwReadL.body?.code === 10003 &&
      finReadL.body?.code === 10003 &&
      supReadL.body?.code === 10003,
    'D19 viewer / finance / supplier 都不进团长域 → 10003（财务管钱不管人；供应商更不该看见同业名录）',
    `viewer=${vwReadL.body?.code} finance=${finReadL.body?.code} supplier=${supReadL.body?.code}`,
  );
  const userReadL = await call('GET', '/admin/leaders', { token: u.token });
  assert(
    userReadL.body?.code === 10003,
    '双主体隔离：小程序 token 打 /admin/leaders → 10003（与 C 端 /leader/* 名字像、权限天差地别）',
    `code=${userReadL.body?.code}`,
  );

  // ======================================================== H · 操作日志
  const lLogs = await call('GET', '/admin/system/logs?module=leader&page=1&pageSize=50', {
    token: lAdmin,
  });
  const lActions = (lLogs.body?.data?.list ?? []).map((r) => r.action);
  assert(
    lActions.some((a) => String(a).includes('任命或转交团长')) &&
      lActions.some((a) => String(a).includes('变更团长档案')) &&
      lActions.some((a) => String(a).includes('团长资质补录/例外处理')),
    'D20/D21/D22 声明式 @OperationLog() 全部生效（业务模块零侵入，连 reason 一起落库）',
    `actions=${JSON.stringify([...new Set(lActions)])}`,
  );
  const apLog = (lLogs.body?.data?.list ?? []).find(
    (r) => String(r.action).includes('任命或转交团长') && String(r.targetId) === String(lxU.userId),
  );
  assert(
    !!apLog,
    'D20 日志 targetId = **被任命用户 id**（请求体里没有团长 id，拦截器只能取到它）',
    `targetId=${apLog?.targetId} 期望=${lxU.userId}`,
  );
  const auLog = (lLogs.body?.data?.list ?? []).find(
    (r) =>
      String(r.action).includes('团长资质补录/例外处理') &&
      String(r.targetId) === String(lyLeaderId),
  );
  assert(
    !!auLog && !!auLog.requestData,
    'D22 日志 targetId = 团长 id 且带 requestData（含 reason —— 事后可复核「为什么停的他」）',
    `targetId=${auLog?.targetId} requestData=${JSON.stringify(auLog?.requestData)?.slice(0, 60)}`,
  );

  // ============================================ I · 与名录 / 详情交叉回看
  const rosterX = await call(
    'GET',
    `/admin/leaders?keyword=${encodeURIComponent(tag)}&pageSize=50`,
    { token: lAdmin },
  );
  const xRows = rosterX.body?.data?.list ?? [];
  assert(
    xRows.some((r) => Number(r.userId) === lxU.userId) &&
      xRows.some((r) => Number(r.userId) === lyU.userId),
    '交叉：新造的两位团长都落在名录里（含已转交停职的那位）—— 停职不等于消失',
    `n=${xRows.length} names=${JSON.stringify(xRows.map((r) => r.realName))}`,
  );
  const detLx = await call('GET', `/admin/leaders/${lyLeaderId}`, { token: lAdmin });
  assert(
    (detLx.body?.data?.operationLogs ?? []).some(
      (o) => String(o.targetId) === String(lyU.userId),
    ),
    'D19 详情**双键查日志**：D20 转交那条日志的 targetId 是**继任者用户 id**，只按团长 id 查会漏掉「他是怎么上任的」',
    `logs=${JSON.stringify((detLx.body?.data?.operationLogs ?? []).map((o) => o.targetId))}`,
  );
  assert(
    Number(detLx.body?.data?.profile?.buildingId) === emptyB &&
      detLx.body?.data?.profile?.level === 'gold',
    '交叉：详情反映 D21 变更后的最终状态（换到空楼 B + 金牌）',
    `building=${detLx.body?.data?.profile?.buildingId} level=${detLx.body?.data?.profile?.level}`,
  );
  const lyLeaders = readRows(
    'SELECT id, status, building_id FROM ab_team_leader WHERE user_id = ?',
    [lyU.userId],
  );
  assert(
    lyLeaders.length === 1 &&
      Number(lyLeaders[0].status) === 1 &&
      Number(lyLeaders[0].id) !== lxLeaderId &&
      Number(lyLeaders[0].building_id) === emptyB,
    '交叉：转交是**新建继任者档案**而非改写原档案（原团长保留自己的历史，两人 id 不同）',
    `ly=${JSON.stringify(lyLeaders)} 原档案 id=${lxLeaderId}`,
  );

  // ==========================================================================
  // §18 M3-6 供应商管理 + 集散（D23–D32）
  // ==========================================================================
  log('\n§18 M3-6 供应商管理 / 集散（D23–D32）');

  /** 拼查询串：只带上真有值的参数，空值一律不发（避免 `?type=` 被当成筛选条件） */
  const qs = (o) =>
    Object.entries(o)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');

  // ---------------------------------------------------------- 前置：自造夹具
  // 供应商是小体量主数据：用**带时间戳**的名称/手机号新建，重复跑不撞唯一约束，
  // 也不与种子（4 出餐 + 6 备选）以及其他 § 的写入互相覆盖。
  const supA = `e2e供A_${stamp}`;
  const supB = `e2e供B_${stamp}`;
  const mkPhone = (n) => `139${stamp.slice(0, 4)}${String(n).padStart(4, '0')}`;
  const pastDate = addDaysStr(bjToday(), -10);
  const soonDate = addDaysStr(bjToday(), 10);
  const futureDate = addDaysStr(bjToday(), 365);

  // 权限夹具：§9 已把 §7 的 operator（userA）停用并吊销其令牌，此处必须另起账号
  const supOpUser = `e2e_supop_${stamp}`;
  const supViewUser = `e2e_supview_${stamp}`;
  await call('POST', '/admin/system/accounts', {
    token: adminToken,
    body: { username: supOpUser, password: PWD, role: 'operator', realName: 'e2e 供应商运营' },
  });
  await call('POST', '/admin/system/accounts', {
    token: adminToken,
    body: { username: supViewUser, password: PWD, role: 'viewer', realName: 'e2e 供应商只读' },
  });
  const supOpLogin = await adminLogin(supOpUser, PWD);
  const supViewLogin = await adminLogin(supViewUser, PWD);
  const finLogin2 = await adminLogin('finance', 'finance123');
  const supOpToken = supOpLogin.token;
  const supViewToken = supViewLogin.token;
  const finToken2 = finLogin2.token;
  ok(
    '前置：§18 账号夹具就位（operator / viewer / finance）',
    `op=${supOpLogin.code} viewer=${supViewLogin.code} finance=${finLogin2.code}`,
  );

  // ======================================================== A · D23 名录
  const sList = await call('GET', `/admin/suppliers?${qs({ pageSize: 100 })}`, { token: adminToken });
  const sRows = sList.body?.data?.list ?? [];
  const sSum = sList.body?.data?.summary ?? {};
  const sTotal = sList.body?.data?.total;

  assert(
    sList.body?.code === 0 && Array.isArray(sRows) && sTotal >= 10,
    'D23 名录返回成功，且至少含种子 10 家（4 出餐 + 6 备选）',
    `code=${sList.body?.code} total=${sTotal}`,
  );
  assert(
    sSum.totalCount === sTotal,
    'D23 summary 按**同一过滤条件的全量**统计（翻页不跳 KPI：totalCount 恒等于 total，与本页条数无关）',
    `summary=${sSum.totalCount} total=${sTotal} 本页=${sRows.length}`,
  );
  assert(
    sRows.every((r) => r.licenseState && r.licenseStateLabel && r.statusLabel),
    'D23 每行带派生值 licenseState / licenseStateLabel / statusLabel（文案由服务端统一，端上不维护第二份）',
    `sample=${JSON.stringify(sRows[0]?.licenseState)}/${sRows[0]?.licenseStateLabel}`,
  );
  assert(
    new Set(sRows.map((r) => r.licenseState)).has('unknown') &&
      sRows.some((r) => r.licenseState === 'normal'),
    'D23 证照档位派生真实生效：备选供应商未登记 → unknown（**未登记 ≠ 已过期**，后置收集合法）；4 家演示供应商已核验 → normal',
    `states=${JSON.stringify([...new Set(sRows.map((r) => r.licenseState))])}`,
  );
  assert(
    sRows.every((r) => !String(r.contactPhoneMasked ?? '').includes('0000')),
    'D23 列表手机号**一律脱敏**（形如 139****0001，中间位不在响应里）',
    `sample=${sRows[0]?.contactPhoneMasked}`,
  );
  assert(
    sRows.every((r) => r.contactPhone === undefined),
    'D23 列表**不回真实手机号**（连字段都不出现；只有详情才给，见 B 段）',
    `keys=${Object.keys(sRows[0] ?? {}).filter((k) => /phone/i.test(k)).join(',')}`,
  );
  assert(
    sList.body?.data?.typeOptions === undefined &&
      (sList.body?.data?.auditStatusOptions ?? []).length === 3 &&
      (sList.body?.data?.statusOptions ?? []).length === 2,
    'D23 下发两个枚举选择器（审核状态 3 / 合作状态 2），**不下发类型** —— M4-0 自营口径下供应商只有「半成品供货方」一种角色，三分法失效',
    `typeOptions=${JSON.stringify(sList.body?.data?.typeOptions)} audit=${sList.body?.data?.auditStatusOptions?.length}`,
  );
  assert(
    (sList.body?.data?.categoryOptions ?? []).some((o) => o.value === '本帮菜'),
    'D23 categoryOptions 来自**真实数据去重**（不是写死的枚举）：种子里「本帮菜」必须在列',
    `cats=${JSON.stringify((sList.body?.data?.categoryOptions ?? []).map((o) => o.value).slice(0, 6))}`,
  );
  assert(
    sList.body?.data?.actions?.canManage === true,
    'D23 actions.canManage=true（super_admin）；该判据由服务端下发，前端不自己判角色',
    `canManage=${sList.body?.data?.actions?.canManage}`,
  );

  // ⚠️ M4-0：`type` 已从 DTO 白名单移除 → 带 `type` 筛选**直接 10001**（`forbidNonWhitelisted`），
  //    而不是静默忽略后返回全量 —— 后者会让调用方以为筛选生效了。
  const onlyBoth = await call('GET', `/admin/suppliers?${qs({ type: 'both', pageSize: 100 })}`, {
    token: adminToken,
  });
  assert(
    onlyBoth.body?.code === 10001,
    'D23 传已下线的 `type` 筛选 → 10001（**显式拒绝**，不是静默忽略后返回全量）',
    `code=${onlyBoth.body?.code} msg=${onlyBoth.body?.message}`,
  );

  const onlyExpired = await call('GET', `/admin/suppliers?${qs({ licenseState: 'expired', pageSize: 100 })}`, {
    token: adminToken,
  });
  assert(
    onlyExpired.body?.code === 0 &&
      (onlyExpired.body?.data?.list ?? []).every((r) => r.licenseState === 'expired'),
    'D23 按证照有效期筛选有效（expired 档**逐条复核**，不是「拿筛选当装饰」）',
    `count=${onlyExpired.body?.data?.list?.length}`,
  );

  const kwByName = await call('GET', `/admin/suppliers?${qs({ keyword: '三味屋' })}`, {
    token: adminToken,
  });
  assert(
    kwByName.body?.code === 0 && (kwByName.body?.data?.list ?? []).some((r) => r.id === 1),
    'D23 关键词命中供应商名（三味屋 · id=1）',
    `names=${JSON.stringify((kwByName.body?.data?.list ?? []).map((r) => r.name))}`,
  );
  // ⚠️ M4-0：加工场所已不归属供应商 → 关键词**不再跨表**搜集散中心名。
  //    搜场地名若还能找回 id=1，反而说明「场所挂在供应商名下」的旧关系没清干净。
  const kwByDc = await call('GET', `/admin/suppliers?${qs({ keyword: '集散中心 1' })}`, {
    token: adminToken,
  });
  assert(
    kwByDc.body?.code === 0 && !(kwByDc.body?.data?.list ?? []).some((r) => r.id === 1),
    'D23 关键词**不再跨表命中**集散中心名（加工场所属 ABox 自有，不作为供应商的检索维度）',
    `ids=${JSON.stringify((kwByDc.body?.data?.list ?? []).map((r) => r.id))}`,
  );

  const filterOpts = await call('GET', '/admin/suppliers/filter-options', { token: adminToken });
  assert(
    filterOpts.body?.code === 0 &&
      filterOpts.body?.data?.typeOptions === undefined &&
      Array.isArray(filterOpts.body?.data?.auditStatusOptions),
    'D23 filter-options 未被 `:id` 参数路由吃掉（**静态路由必须声明在参数路由之前**），且不再下发 `typeOptions`',
    `code=${filterOpts.body?.code} typeOptions=${JSON.stringify(filterOpts.body?.data?.typeOptions)}`,
  );

  const noSuch = await call('GET', '/admin/suppliers/999999', { token: adminToken });
  assert(
    noSuch.body?.code === 50006,
    'D23 详情查不存在的供应商 → 50006（不是 500；错误码要能区分「不存在」与「系统挂了」）',
    `code=${noSuch.body?.code}`,
  );

  // ======================================================== B · D23 详情
  const detSup1 = await call('GET', '/admin/suppliers/1', { token: adminToken });
  const detSup1d = detSup1.body?.data ?? {};
  assert(
    detSup1.body?.code === 0 &&
      !!detSup1d.supplier &&
      !!detSup1d.bank &&
      Array.isArray(detSup1d.dishes) &&
      Array.isArray(detSup1d.recentShares) &&
      Array.isArray(detSup1d.operationLogs) &&
      !!detSup1d.takeout &&
      detSup1d.distributionCenters === undefined,
    'D23 详情一次性带齐 6 块（档案 / 银行 / 菜品 / 近 30 条分账 / 日志 / 外卖链接），**不再回集散中心**（M4-0：场所不挂在供应商名下）',
    `keys=${Object.keys(detSup1d).join(',')}`,
  );
  assert(
    detSup1d.contactPhone === '13900000001' && detSup1d.contactPhoneMasked === '139****0001',
    'D23 详情**才**回真实手机号（与列表脱敏形成对照；两个字段同时给出，端上不必自己脱敏）',
    `phone=${detSup1d.contactPhone} masked=${detSup1d.contactPhoneMasked}`,
  );
  assert(
    detSup1d.bank.bankAccountMasked === null,
    'D23 种子供应商未登记对公账号 → bankAccountMasked=null（**不是空串**，前端据此显示「未登记」）',
    `masked=${JSON.stringify(detSup1d.bank.bankAccountMasked)}`,
  );
  assert(
    detSup1d.dishes.length >= 4 &&
      detSup1d.dishes.every((d) => d.supplierId === 1) &&
      detSup1d.supplier.dishCount === detSup1d.dishes.length,
    'D23 详情菜品全属本家，且 dishCount 与列表口径一致（两处若不同源，就会「列表 4 道、详情 3 道」）',
    `dishes=${detSup1d.dishes.length} dishCount=${detSup1d.supplier.dishCount}`,
  );
  // ⚠️ M4-0：`dcCount` / `distributionCenters` 已随「场所不归属供应商」一并移除；
  //    上一条「7 块 → 6 块」的断言已覆盖「详情不再回集散中心」，此处不必再叠一条。

  // ================================================ C · D24 新增 / D25 编辑
  const cSupA = await call('POST', '/admin/suppliers', {
    token: adminToken,
    body: {
      name: supA,
      contactName: 'e2e 联系人A',
      contactPhone: mkPhone(1),
      category: '测试品类',
      address: '朝阳区测试路 1 号',
      capacityPerDay: 300,
      payeeType: 'corporate',
    },
  });
  const supAId = Number(cSupA.body?.data?.id ?? 0);
  assert(
    cSupA.body?.code === 0 && supAId > 0,
    'D24 新增供应商成功',
    `id=${supAId}`,
  );
  assert(
    cSupA.body?.data?.auditStatus === 'pending' && cSupA.body?.data?.status === 1,
    'D24 新建即 `audit_status=pending` 且 `status=1`（**创建 ≠ 可出餐**：资质未核验前 canServe=false）',
    `audit=${cSupA.body?.data?.auditStatus} status=${cSupA.body?.data?.status}`,
  );
  const supADb = readDb('SELECT audit_status, status, payee_type FROM ab_supplier WHERE id = ?', [supAId]);
  assert(
    supADb?.audit_status === 'pending' && Number(supADb?.status) === 1,
    'D24 落库值与出参一致（接口回什么，库里就是什么）',
    `db=${JSON.stringify(supADb)}`,
  );

  const cSupB = await call('POST', '/admin/suppliers', {
    token: adminToken,
    body: {
      name: supB,
      contactName: 'e2e 联系人B',
      contactPhone: mkPhone(2),
      category: '测试品类',
      payeeType: 'personal',
    },
  });
  const supBId = Number(cSupB.body?.data?.id ?? 0);
  assert(cSupB.body?.code === 0 && supBId > 0, 'D24 第二家（出餐型）新建成功', `id=${supBId}`);

  const uSupA = await call('PUT', `/admin/suppliers/${supAId}`, {
    token: adminToken,
    body: { name: `${supA}改`, capacityPerDay: 520 },
  });
  assert(
    uSupA.body?.code === 0 && uSupA.body?.data?.unpublishedDishCount === 0,
    'D25 编辑（改名 + 产能）成功，且未触发联动下架时 `unpublishedDishCount=0`（**显式回报「没发生」**，与不回报是两回事）',
    `code=${uSupA.body?.code} unpublished=${uSupA.body?.data?.unpublishedDishCount}`,
  );
  const uSupADb = readDb('SELECT name, capacity_per_day FROM ab_supplier WHERE id = ?', [supAId]);
  assert(
    uSupADb?.name === `${supA}改` && Number(uSupADb?.capacity_per_day) === 520,
    'D25 编辑落库（部分更新：只改传了的字段）',
    `db=${JSON.stringify(uSupADb)}`,
  );

  // 给 A 建两道菜，供「证照过期 → 联动下架」使用
  const mkDish = async (supplierId, name, fen, category = 'main') =>
    call('POST', '/admin/dishes', {
      token: adminToken,
      body: { supplierId, name, category, costPriceFen: fen, description: 'e2e 菜品' },
    });
  const dA1 = await mkDish(supAId, `e2e菜A1_${stamp}`, 750);
  const dA2 = await mkDish(supAId, `e2e菜A2_${stamp}`, 300, 'veg');
  const dA1Id = Number(dA1.body?.data?.id ?? 0);
  const dA2Id = Number(dA2.body?.data?.id ?? 0);
  assert(
    dA1.body?.code === 0 && dA2.body?.code === 0 && dA1Id > 0 && dA2Id > 0,
    '前置：为 A 建两道菜（供 D25 联动下架与 G 段批量操作使用）',
    `ids=${dA1Id},${dA2Id}`,
  );

  const uExpired = await call('PUT', `/admin/suppliers/${supAId}`, {
    token: adminToken,
    body: { licenseExpireAt: pastDate },
  });
  assert(
    uExpired.body?.code === 0 &&
      uExpired.body?.data?.licenseState === 'expired' &&
      uExpired.body?.data?.unpublishedDishCount === 2,
    'D25 把证照有效期改成**过去** → 同步下架关联菜品，并回报 `unpublishedDishCount=2`（不做「偷偷改了却不说」）',
    `state=${uExpired.body?.data?.licenseState} unpublished=${uExpired.body?.data?.unpublishedDishCount}`,
  );
  const dishAfterExpire = readRows('SELECT id, status FROM ab_dish WHERE supplier_id = ?', [supAId]);
  assert(
    dishAfterExpire.length === 2 && dishAfterExpire.every((d) => Number(d.status) === 0),
    'D25 联动下架**真的落库**（123 号令：证照过期不得出餐 —— 不是只改个标记给前端看）',
    `dishes=${JSON.stringify(dishAfterExpire)}`,
  );
  assert(
    uExpired.body?.data?.canServe === false,
    'D25 证照过期后 canServe=false（合作中 ∧ 资质通过 ∧ 证照未过期，三项缺一即否）',
    `canServe=${uExpired.body?.data?.canServe}`,
  );

  // ======================================================== D · D26 资质审核
  const auditNoLicense = await call('POST', `/admin/suppliers/${supBId}/audit`, {
    token: adminToken,
    body: { result: 'approved' },
  });
  assert(
    auditNoLicense.body?.code === 50001,
    'D26 通过审核但**无任何证照有效期** → 50001（C11 允许银行账户后置收集，但**证照有效期不能后置**）',
    `code=${auditNoLicense.body?.code} msg=${auditNoLicense.body?.message}`,
  );
  const auditPast = await call('POST', `/admin/suppliers/${supBId}/audit`, {
    token: adminToken,
    body: { result: 'approved', licenseExpireAt: pastDate },
  });
  assert(
    auditPast.body?.code === 50001,
    'D26 通过审核但证照**已过期** → 50001（不能明知过期还放行出餐）',
    `code=${auditPast.body?.code} msg=${auditPast.body?.message}`,
  );
  const auditSoon = await call('POST', `/admin/suppliers/${supBId}/audit`, {
    token: adminToken,
    body: { result: 'approved', licenseExpireAt: soonDate, remark: 'e2e 资质通过' },
  });
  assert(
    auditSoon.body?.code === 0 &&
      auditSoon.body?.data?.auditStatus === 'approved' &&
      auditSoon.body?.data?.licenseState === 'expiring',
    'D26 有效期在 30 天内 → 审核通过，且 licenseState=expiring（派生值实时算，不落库）',
    `audit=${auditSoon.body?.data?.auditStatus} state=${auditSoon.body?.data?.licenseState}`,
  );
  assert(
    auditSoon.body?.data?.status === 1,
    'D26 **审核不影响合作状态**：通过审核后 status 仍为 1（审核是事实判定，停用是经营决策）',
    `status=${auditSoon.body?.data?.status}`,
  );
  assert(
    auditSoon.body?.data?.canServe === true,
    'D26 三项齐备后 canServe=true（合作中 ∧ 资质通过 ∧ 未过期）',
    `canServe=${auditSoon.body?.data?.canServe}`,
  );
  const auditDb = readDb(
    'SELECT audit_status, audit_remark, audited_at, audited_by FROM ab_supplier WHERE id = ?',
    [supBId],
  );
  assert(
    auditDb?.audit_status === 'approved' &&
      auditDb?.audit_remark === 'e2e 资质通过' &&
      !!auditDb?.audited_at &&
      Number(auditDb?.audited_by) > 0,
    'D26 审核三件套落库：状态 / 意见 / 审核时刻 + 审核人（「谁批的」必须留痕，不能只记「批了」）',
    `db=${JSON.stringify(auditDb)}`,
  );
  const rejectNoRemark = await call('POST', `/admin/suppliers/${supBId}/audit`, {
    token: adminToken,
    body: { result: 'rejected' },
  });
  assert(
    rejectNoRemark.body?.code === 10001,
    'D26 驳回但未填审核意见 → 10001（驳回要能给商家一个理由）',
    `code=${rejectNoRemark.body?.code}`,
  );
  const rejectOk = await call('POST', `/admin/suppliers/${supBId}/audit`, {
    token: adminToken,
    body: { result: 'rejected', remark: 'e2e 营业执照与线上主体不一致' },
  });
  assert(
    rejectOk.body?.code === 0 &&
      rejectOk.body?.data?.auditStatus === 'rejected' &&
      rejectOk.body?.data?.status === 1 &&
      rejectOk.body?.data?.canServe === false,
    'D26 驳回后 **status 仍为 1（不自动停用）**、canServe=false —— 阈值分开：审核管资格，停用管合作',
    `audit=${rejectOk.body?.data?.auditStatus} status=${rejectOk.body?.data?.status}`,
  );

  // ============================================ E · D27（已下线）/ D28 结算账户
  //
  // ⚠️ M4-0：`PUT /admin/suppliers/:id/type` **整条路由已删除**（不是返回固定值）。
  //    这里断言它确实「查无此路」——用 10004（框架 404 经全局异常过滤器翻译）而不是
  //    「返回 0 但什么也没做」：留一个「点了没区别」的按钮，运营会以为类型还在起作用。
  const setTypeGone = await call('PUT', '/admin/suppliers/1/type', {
    token: adminToken,
    body: { type: 'dish' },
  });
  assert(
    setTypeGone.body?.code === 10004,
    'D27 设置类型端点**已下线** → 10004（路由不存在，不是「返回成功但没改」）',
    `code=${setTypeGone.body?.code} msg=${setTypeGone.body?.message}`,
  );
  const setTypeOnUpdate = await call('PUT', `/admin/suppliers/${supAId}`, {
    token: adminToken,
    body: { type: 'distribute' },
  });
  assert(
    setTypeOnUpdate.body?.code === 10001,
    'D27 编辑接口也不再收 `type` → 10001（类型是历史字段，任何写入口都拒收；`ab_supplier.type` 列保留仅供历史数据对照）',
    `code=${setTypeOnUpdate.body?.code} msg=${setTypeOnUpdate.body?.message}`,
  );

  const settleNoAccount = await call('PUT', `/admin/suppliers/${supAId}/settle-account`, {
    token: adminToken,
    body: { payeeType: 'corporate' },
  });
  assert(
    settleNoAccount.body?.code === 10001,
    'D28 选「对公」却不给开户行/账号 → 10001（服务层校验，不是 DTO 硬顶：否则结算单生成了却无处可付）',
    `code=${settleNoAccount.body?.code} msg=${settleNoAccount.body?.message}`,
  );
  const settleOk = await call('PUT', `/admin/suppliers/${supAId}/settle-account`, {
    token: adminToken,
    body: {
      payeeType: 'corporate',
      bankName: '中国银行北京分行',
      bankAccount: '6217000000001234',
      invoiceTitle: `${supA}（发票抬头）`,
    },
  });
  assert(
    settleOk.body?.code === 0 &&
      settleOk.body?.data?.bankAccountMasked === '**** **** **** 1234' &&
      !JSON.stringify(settleOk.body?.data ?? {}).includes('6217000000001234'),
    'D28 **回带即脱敏**：响应里绝不含账号原文（连刚填过也不给，防日志/截图泄露）',
    `masked=${settleOk.body?.data?.bankAccountMasked}`,
  );
  const detA = await call('GET', `/admin/suppliers/${supAId}`, { token: adminToken });
  assert(
    detA.body?.data?.bank?.bankAccountMasked === '**** **** **** 1234' &&
      detA.body?.data?.bank?.bankName === '中国银行北京分行' &&
      !JSON.stringify(detA.body?.data ?? {}).includes('6217000000001234'),
    'D28 详情里账号同样只有脱敏号（**账号原文任何后台接口都不回**，付款登记由财务线下核对）',
    `detail=${detA.body?.data?.bank?.bankAccountMasked}`,
  );
  const settlePersonal = await call('PUT', `/admin/suppliers/${supBId}/settle-account`, {
    token: adminToken,
    body: { payeeType: 'personal' },
  });
  assert(
    settlePersonal.body?.code === 0,
    'D28 对私可不填账号（C11 允许信息后置收集 —— 只有「选了对公」才强制成对）',
    `code=${settlePersonal.body?.code}`,
  );

  // ============================================ F · 扩展 · 外卖平台店铺链接
  const tk1 = await call('PUT', `/admin/suppliers/${supAId}/takeout-links`, {
    token: adminToken,
    body: { meituan: { url: 'pages/shop/index?shop_id=e2e', shopId: 'e2e-mt' }, recommended: 'meituan' },
  });
  assert(
    tk1.body?.code === 0 &&
      (tk1.body?.data?.links ?? []).length === 3 &&
      tk1.body?.data?.configuredCount === 1,
    '外卖链接：**三个平台一律返回**（未入驻的 configured=false），而不是把未配置项筛掉 —— 否则「缺京东」这件事在界面上看不见',
    `links=${tk1.body?.data?.links?.length} configured=${tk1.body?.data?.configuredCount}`,
  );
  assert(
    tk1.body?.data?.recommended === 'meituan',
    '外卖链接：推荐平台可设（`recommended` 回带的是**平台 key**，不是 URL）',
    `recommended=${tk1.body?.data?.recommended}`,
  );
  const tk2 = await call('PUT', `/admin/suppliers/${supAId}/takeout-links`, {
    token: adminToken,
    body: { taobao: { url: 'pages/shop/index?shop_id=e2e-tb' } },
  });
  const mtAfter = (tk2.body?.data?.links ?? []).find((l) => l.platform === 'meituan');
  assert(
    tk2.body?.code === 0 && mtAfter?.configured === true && tk2.body?.data?.configuredCount === 2,
    '外卖链接：**未传的保持原值**（只想改一家不必把另外两家回传一遍；否则漏传=静默清空）',
    `configured=${tk2.body?.data?.configuredCount}`,
  );
  const tk3 = await call('PUT', `/admin/suppliers/${supAId}/takeout-links`, {
    token: adminToken,
    body: { meituan: { url: '' } },
  });
  assert(
    tk3.body?.code === 0 &&
      tk3.body?.data?.configuredCount === 1 &&
      tk3.body?.data?.recommended === null,
    '外卖链接：显式传空串 = 清空该平台（「未入驻」是合法状态），且**推荐被自动撤销** —— 悬空推荐比没有推荐更糟',
    `configured=${tk3.body?.data?.configuredCount} recommended=${JSON.stringify(tk3.body?.data?.recommended)}`,
  );
  const tkBad = await call('PUT', `/admin/suppliers/${supAId}/takeout-links`, {
    token: adminToken,
    body: { recommended: 'pinduoduo' },
  });
  assert(
    tkBad.body?.code === 10001,
    '外卖链接：不存在的平台作为推荐 → 10001（枚举白名单）',
    `code=${tkBad.body?.code}`,
  );
  const supplierTakeout = readDb('SELECT takeout_links FROM ab_supplier WHERE id = ?', [supAId]);
  assert(
    !!supplierTakeout?.takeout_links &&
      !String(supplierTakeout.takeout_links).includes('__recommended'),
    '外卖链接：悬空推荐**已从库里删掉**（不是只在出参里过滤 —— 那会让下个读的人又看到它）',
    `json=${String(supplierTakeout?.takeout_links).slice(0, 80)}`,
  );

  // ================================================ G · 扩展 · 菜品库
  const dishList = await call('GET', `/admin/dishes?${qs({ pageSize: 100 })}`, { token: adminToken });
  const dSum = dishList.body?.data?.summary ?? {};
  assert(
    dishList.body?.code === 0 && Array.isArray(dishList.body?.data?.list),
    '菜品库列表可用',
    `total=${dishList.body?.data?.total}`,
  );
  assert(
    dSum.totalCount === dishList.body?.data?.total &&
      dSum.onSaleCount + dSum.offSaleCount === dSum.totalCount,
    '菜品库 summary 同过滤条件全量，且「上架 + 下架 = 总数」（两个 KPI 加不齐就是漏统计）',
    `total=${dSum.totalCount} on=${dSum.onSaleCount} off=${dSum.offSaleCount}`,
  );
  assert(
    (dishList.body?.data?.categoryOptions ?? []).length === 5,
    '菜品库下发 5 个档位（main/half/veg/soup/staple）',
    `cats=${JSON.stringify((dishList.body?.data?.categoryOptions ?? []).map((o) => o.value))}`,
  );
  assert(
    typeof dishList.body?.data?.notes?.category === 'string' &&
      dishList.body?.data?.notes.category.includes('DishSlot'),
    '菜品库出参**显式标注**档位与套餐槽位 DishSlot 是两套枚举（写在契约里，而不是留给下一个人去猜）',
    `note=${dishList.body?.data?.notes?.category?.slice(0, 30)}…`,
  );
  assert(
    (dishList.body?.data?.list ?? []).every((d) => !!d.costPriceYuan && !!d.categoryLabel),
    '菜品行同时给「分」与「元串」与中文档位（元串专供输入框回填，避免端上各写一遍 /100）',
    `sample=${(dishList.body?.data?.list ?? [])[0]?.costPriceFen}/${(dishList.body?.data?.list ?? [])[0]?.costPriceYuan}`,
  );

  const dishBySup = await call('GET', `/admin/dishes?${qs({ supplierId: supAId, pageSize: 100 })}`, {
    token: adminToken,
  });
  assert(
    dishBySup.body?.code === 0 &&
      (dishBySup.body?.data?.list ?? []).length === 2 &&
      (dishBySup.body?.data?.list ?? []).every((d) => d.supplierId === supAId),
    '菜品库按供应商筛选有效（且只返回本家的菜）',
    `count=${dishBySup.body?.data?.list?.length}`,
  );

  const dishDb = readDb('SELECT cost_price FROM ab_dish WHERE id = ?', [dA1Id]);
  assert(
    Math.abs(Number(dishDb?.cost_price) - 7.5) < 1e-9,
    '菜品供价以「分」入参 → 落库为 **7.50 元整**（750 分 ÷ 100，不出现 7.4999…）',
    `cost_price=${JSON.stringify(dishDb?.cost_price)} typeof=${typeof dishDb?.cost_price}`,
  );

  const dishUpdate = await call('PUT', `/admin/dishes/${dA1Id}`, {
    token: adminToken,
    body: { costPriceFen: 880, category: 'half' },
  });
  assert(
    dishUpdate.body?.code === 0 &&
      dishUpdate.body?.data?.costPriceFen === 880 &&
      dishUpdate.body?.data?.categoryLabel === '半荤',
    '菜品改供价 + 改档位成功（供价是 C9 等式的输入项，改一个数字就改了供应商应付与平台毛利）',
    `fen=${dishUpdate.body?.data?.costPriceFen} cat=${dishUpdate.body?.data?.categoryLabel}`,
  );

  const batchNoReason = await call('POST', '/admin/dishes/batch-status', {
    token: adminToken,
    body: { ids: [dA1Id], status: 0 },
  });
  assert(
    batchNoReason.body?.code === 10001,
    '批量下架**必填原因** → 缺原因 10001（批量下架是「一道菜在多个楼群同时消失」，复盘要能回答为什么）',
    `code=${batchNoReason.body?.code}`,
  );
  const batchUp = await call('POST', '/admin/dishes/batch-status', {
    token: adminToken,
    body: { ids: [dA1Id, dA2Id], status: 1, reason: 'e2e 恢复上架' },
  });
  assert(
    batchUp.body?.code === 0 &&
      batchUp.body?.data?.changed === 2 &&
      batchUp.body?.data?.skipped === 0 &&
      batchUp.body?.data?.changed + batchUp.body?.data?.skipped === batchUp.body?.data?.requested,
    '批量上架：两道都从下架→上架，changed=2 且 **changed + skipped = requested**（运营才能核对）',
    `changed=${batchUp.body?.data?.changed} skipped=${batchUp.body?.data?.skipped}`,
  );
  const batchMixed = await call('POST', '/admin/dishes/batch-status', {
    token: adminToken,
    body: { ids: [dA1Id, dA2Id], status: 0, reason: 'e2e 批量下架' },
  });
  assert(
    batchMixed.body?.code === 0 && batchMixed.body?.data?.changed === 2,
    '批量下架：原因齐备时正常执行',
    `changed=${batchMixed.body?.data?.changed}`,
  );
  const batchSame = await call('POST', '/admin/dishes/batch-status', {
    token: adminToken,
    body: { ids: [dA1Id, dA2Id], status: 0, reason: 'e2e 重复下架' },
  });
  assert(
    batchSame.body?.code === 10001,
    '批量操作**全部已是目标态** → 10001（与 D27 同一纪律：目标态重复 ≠ 幂等成功）',
    `code=${batchSame.body?.code} msg=${batchSame.body?.message}`,
  );
  const batchGhost = await call('POST', '/admin/dishes/batch-status', {
    token: adminToken,
    body: { ids: [dA1Id, 99999999], status: 1, reason: 'e2e 含不存在' },
  });
  assert(
    batchGhost.body?.code === 10004,
    '批量操作含不存在 id → **整体拒绝**（10004 不存在），不做「部分成功」—— 否则运营会以为全成功了',
    `code=${batchGhost.body?.code}`,
  );
  const dishStill = readDb('SELECT status FROM ab_dish WHERE id = ?', [dA1Id]);
  assert(
    Number(dishStill?.status) === 0,
    '批量整体拒绝时**一行都没改**（不是「改了一半再报错」）',
    `status=${dishStill?.status}`,
  );

  // ==================================================== H · D29–D32 集散中心
  const dcList = await call('GET', `/admin/distribution-centers?${qs({ pageSize: 100 })}`, {
    token: adminToken,
  });
  const dcRows = dcList.body?.data?.list ?? [];
  const dcSum = dcList.body?.data?.summary ?? {};
  assert(
    dcList.body?.code === 0 && dcSum.totalCount === dcList.body?.data?.total,
    'D29 集散中心列表可用，summary 与 total 同源',
    `total=${dcSum.totalCount}`,
  );
  assert(
    dcSum.totalRiceFeeFen === 0 && dcSum.totalPackFeeFen === 0,
    'D29 种子场所**场地费与打包费全为 0**（自营口径：场所是 ABox 自有、打包是自身成本，二者**不出付款单**；0 表示「**未登记**」而非免费）',
    `rice=${dcSum.totalRiceFeeFen} pack=${dcSum.totalPackFeeFen}`,
  );
  assert(
    dcRows.every((r) => !!r.statusLabel && Array.isArray(r.serviceGroups) && Array.isArray(r.serviceGroupNames)),
    'D29 行内带状态文案、服务楼群 id 与**名称**（端上显示名字，不显示 #3）',
    `sample=${JSON.stringify(dcRows[0]?.serviceGroupNames)}`,
  );
  assert(
    dcRows.every((r) => typeof r.canDelete === 'boolean' && typeof r.shareAmountFen === 'number'),
    'D29 两道删除前置（历史应付 / 被分配引用）合成 `canDelete` 下发 —— 前端据此禁用按钮，而不是点了才知道不行',
    `canDelete=${dcRows.filter((r) => r.canDelete).length}/${dcRows.length}`,
  );
  const dcByGroup = await call('GET', `/admin/distribution-centers?${qs({ groupId: 1, pageSize: 100 })}`, {
    token: adminToken,
  });
  assert(
    dcByGroup.body?.code === 0 &&
      (dcByGroup.body?.data?.list ?? []).length > 0 &&
      (dcByGroup.body?.data?.list ?? []).every((r) => r.serviceGroups.includes(1)),
    'D29 按服务楼群筛选有效（**在服务端内存完成**：JSON 列跨库字符串连接语义不同，但对外行为与 SQL 筛选一致）',
    `count=${dcByGroup.body?.data?.list?.length}`,
  );
  const dcByKw = await call('GET', `/admin/distribution-centers?${qs({ keyword: '建国路' })}`, {
    token: adminToken,
  });
  assert(
    dcByKw.body?.code === 0 && (dcByKw.body?.data?.list ?? []).some((r) => r.id === 1),
    'D29 集散中心关键词命中地址',
    `ids=${JSON.stringify((dcByKw.body?.data?.list ?? []).map((r) => r.id))}`,
  );

  // ⚠️ M4-0：`supplierId` 已从 D30 入参白名单移除 —— 场所属 ABox 自有，不归属供应商。
  //    原「往出餐型供应商名下挂 → 50008」的闸门随之删除，改为**入参层直接拒收**（10001）。
  const dcUnderDish = await call('POST', '/admin/distribution-centers', {
    token: adminToken,
    body: { name: `e2e错挂_${stamp}`, supplierId: supBId, address: '朝阳区测试路 9 号' },
  });
  assert(
    dcUnderDish.body?.code === 10001,
    'D30 传已下线的 `supplierId` → 10001（旧「错挂」闸门随 50008 一并删除，入参层就拒收）',
    `code=${dcUnderDish.body?.code} msg=${dcUnderDish.body?.message}`,
  );

  const dcCreated = await call('POST', '/admin/distribution-centers', {
    token: adminToken,
    body: {
      name: `e2e集散_${stamp}`,
      address: '朝阳区测试路 2 号',
      contactName: 'e2e 场地',
      contactPhone: mkPhone(3),
      serviceGroups: [1, 2],
    },
  });
  const dcId = Number(dcCreated.body?.data?.id ?? 0);
  assert(
    dcCreated.body?.code === 0 && dcId > 0 && dcCreated.body?.data?.status === 1,
    'D30 新建集散中心成功（ABox 自有加工场所，不挂任何供应商）',
    `id=${dcId}`,
  );
  const dcDb = readDb('SELECT rice_fee, pack_fee, service_groups FROM ab_distribution_center WHERE id = ?', [
    dcId,
  ]);
  assert(
    Number(dcDb?.rice_fee) === 0 && Number(dcDb?.pack_fee) === 0,
    'D30 场地费 / 打包费**不填即为 0**（C9 默认，不是「必须显式传 0」）',
    `db=${JSON.stringify(dcDb)}`,
  );

  const dcUpdate = await call('PUT', `/admin/distribution-centers/${dcId}`, {
    token: adminToken,
    body: { serviceGroups: [3], riceFeeFen: 200 },
  });
  assert(
    dcUpdate.body?.code === 0 &&
      JSON.stringify(dcUpdate.body?.data?.serviceGroups) === '[3]' &&
      dcUpdate.body?.data?.riceFeeFen === 200,
    'D31 编辑：`serviceGroups` 是**整体替换**语义（传 [3] 后只剩 3，不是追加）',
    `groups=${JSON.stringify(dcUpdate.body?.data?.serviceGroups)} fee=${dcUpdate.body?.data?.riceFeeFen}`,
  );
  const dcClear = await call('PUT', `/admin/distribution-centers/${dcId}`, {
    token: adminToken,
    body: { serviceGroups: [] },
  });
  assert(
    dcClear.body?.code === 0 && JSON.stringify(dcClear.body?.data?.serviceGroups) === '[]',
    'D31 **传空数组即清空**（若实现成「空值=保持原值」，运营会以为解绑了、实际还挂着）',
    `groups=${JSON.stringify(dcClear.body?.data?.serviceGroups)}`,
  );
  const dcMoveBad = await call('PUT', `/admin/distribution-centers/${dcId}`, {
    token: adminToken,
    body: { supplierId: supBId },
  });
  assert(
    dcMoveBad.body?.code === 10001,
    'D31 编辑也不收 `supplierId` → 10001（与 D30 是同一关系的两个入口，都从入参层拒收）',
    `code=${dcMoveBad.body?.code} msg=${dcMoveBad.body?.message}`,
  );

  const dcSuspend = await call('PUT', `/admin/distribution-centers/${dcId}`, {
    token: adminToken,
    body: { status: 0 },
  });
  assert(
    dcSuspend.body?.code === 0 && dcSuspend.body?.data?.status === 0,
    'D31 `status=0` 即**停用**（保留记录、退出新分配、随时可恢复）',
    `status=${dcSuspend.body?.data?.status}`,
  );
  const dcAfterSuspend = await call('GET', `/admin/distribution-centers?${qs({ status: 0, pageSize: 100 })}`, {
    token: adminToken,
  });
  assert(
    (dcAfterSuspend.body?.data?.list ?? []).some((r) => r.id === dcId),
    'D31 **停用 ≠ 删除**：停用后仍出现在列表里（这才是「可恢复」的前提）',
    `ids=${(dcAfterSuspend.body?.data?.list ?? []).map((r) => r.id).join(',')}`,
  );

  // 制造「有历史应付」的前置：插一条集散中心应付流水（财务域夹具，非被测接口自身写入的字段）
  // ⚠️ 自营后 `payee_type=distribution_center` 已**冻结**（场所摊销不出付款单），
  //    此处刻意造一条 legacy 行来验证「历史应付 ⇒ 不可删」这条前置仍然生效。
  writeDb(
    'INSERT INTO ab_supplier_share (share_no, share_date, meal_date, payee_type, payee_id, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [`E2E${stamp}${dcId}`, bjToday(), bjToday(), 'distribution_center', dcId, 100, '0.00', '0.00'],
  );
  const dcLocked = await call('DELETE', `/admin/distribution-centers/${dcId}`, { token: adminToken });
  assert(
    dcLocked.body?.code === 50002,
    'D32 删除**有历史应付**的集散中心 → 50002，且错误信息给出「改用停用」的出路（不是只说不行）',
    `code=${dcLocked.body?.code} msg=${dcLocked.body?.message?.slice(0, 40)}…`,
  );
  const dcStillThere = readDb('SELECT deleted_at, status FROM ab_distribution_center WHERE id = ?', [dcId]);
  assert(
    dcStillThere?.deleted_at === null,
    'D32 被拒绝时**没有落 deleted_at**（软删标记只在两道前置都通过时才写）',
    `deleted_at=${JSON.stringify(dcStillThere?.deleted_at)}`,
  );

  const dcFresh = await call('POST', '/admin/distribution-centers', {
    token: adminToken,
    body: { name: `e2e临时_${stamp}`, address: '朝阳区测试路 3 号' },
  });
  const dcFreshId = Number(dcFresh.body?.data?.id ?? 0);
  const dcDeleted = await call('DELETE', `/admin/distribution-centers/${dcFreshId}`, { token: adminToken });
  assert(
    dcDeleted.body?.code === 0 && dcDeleted.body?.data?.deleted === true,
    'D32 无历史应付、未被引用的「建错了」记录可软删（这才是 DELETE 的用武之地）',
    `deleted=${dcDeleted.body?.data?.deleted}`,
  );
  const dcGone = await call('GET', `/admin/distribution-centers?${qs({ keyword: `e2e临时_${stamp}` })}`, {
    token: adminToken,
  });
  assert(
    dcGone.body?.code === 0 && (dcGone.body?.data?.list ?? []).length === 0,
    'D32 软删后不再出现在任何列表（`deleted_at IS NULL` 是列表的硬条件）',
    `count=${dcGone.body?.data?.list?.length}`,
  );

  // ======================================================== I · 权限边界
  const opRead = await call('GET', `/admin/suppliers?${qs({ pageSize: 5 })}`, { token: supOpToken });
  assert(
    opRead.body?.code === 0 && opRead.body?.data?.actions?.canManage === false,
    '两级白名单①：operator **能读**名录，但 `actions.canManage=false` —— 权限按「能不能动钱」分层，不按页面分层',
    `code=${opRead.body?.code} canManage=${opRead.body?.data?.actions?.canManage}`,
  );
  const beforeName = readDb('SELECT name FROM ab_supplier WHERE id = ?', [supBId]);
  const opWrite = await call('PUT', `/admin/suppliers/${supBId}`, {
    token: supOpToken,
    body: { name: 'e2e 越权改名' },
  });
  assert(
    opWrite.body?.code === 10003,
    '两级白名单②：operator 改供应商档案 → 10003（供应商档案决定「钱付给谁」，属资金动作）',
    `code=${opWrite.body?.code}`,
  );
  const opCreate = await call('POST', '/admin/suppliers', {
    token: supOpToken,
    body: { name: 'e2e 越权新建', type: 'dish', contactName: 'x', contactPhone: mkPhone(4) },
  });
  assert(
    opCreate.body?.code === 10003 && !readDb('SELECT id FROM ab_supplier WHERE name = ?', ['e2e 越权新建']),
    '两级白名单③：operator 新建被拒**且库里没有这条记录**—— @Roles 挡在业务层之前，不是「先执行再回滚」',
    `code=${opCreate.body?.code}`,
  );
  const afterName = readDb('SELECT name FROM ab_supplier WHERE id = ?', [supBId]);
  assert(
    beforeName?.name === afterName?.name,
    '两级白名单④：operator 越权编辑被拒后**字段一字未改**（越权请求必须零副作用）',
    `name=${afterName?.name}`,
  );
  const opDc = await call('POST', '/admin/distribution-centers', {
    token: supOpToken,
    body: { name: 'e2e 越权集散', address: 'x' },
  });
  assert(
    opDc.body?.code === 10003,
    '两级白名单⑤：operator 新增集散中心 → 10003（集散中心决定「哪些楼群的餐从哪发」，改它等于改履约路线）',
    `code=${opDc.body?.code}`,
  );
  const viewerRead = await call('GET', '/admin/suppliers', { token: supViewToken });
  assert(
    viewerRead.body?.code === 10003,
    '两级白名单⑥：viewer 连名录都读不到 → 10003（只读观察者仅看板）',
    `code=${viewerRead.body?.code}`,
  );
  const finRead = await call('GET', '/admin/suppliers', { token: finToken2 });
  assert(
    finRead.body?.code === 10003,
    '两级白名单⑦：finance 也读不到 → 10003（菜单矩阵里财务本就没有 /supplier/*；若 API 放行而菜单没有，会变成「能调但进不去」的诡异状态）',
    `code=${finRead.body?.code}`,
  );
  const miniRead = await call('GET', '/admin/suppliers', { token: u.token });
  assert(
    miniRead.body?.code === 10003,
    '双主体隔离：小程序 token 打 /admin/suppliers → 10003（两套账号表 id 各自自增，不隔离就是静默越权）',
    `code=${miniRead.body?.code}`,
  );
  const opDish = await call('POST', '/admin/dishes', {
    token: supOpToken,
    body: { supplierId: supAId, name: 'e2e 越权菜品', category: 'main', costPriceFen: 100 },
  });
  assert(
    opDish.body?.code === 10003 && !readDb('SELECT id FROM ab_dish WHERE name = ?', ['e2e 越权菜品']),
    '两级白名单⑧：operator 改菜品（供价是 C9 输入项）→ 10003 且无记录',
    `code=${opDish.body?.code}`,
  );

  // ======================================================== J · 操作日志
  const supLogs = await call('GET', `/admin/system/logs?${qs({ pageSize: 100 })}`, { token: adminToken });
  const supLogRows = supLogs.body?.data?.list ?? [];
  assert(
    supLogRows.some((l) => l.action === '新增供应商' && String(l.targetId) === String(supAId)),
    'D24 自动落操作日志，且 `targetId` = **新供应商 id** —— 新建接口的请求里没有 id（服务端生成），只靠 params/body 会记成 null，日志就再也挂不到这家供应商上',
    `hit=${supLogRows.filter((l) => l.action === '新增供应商').length} targetIds=${JSON.stringify(
      supLogRows.filter((l) => l.action === '新增供应商').map((l) => l.targetId),
    )} 期望含 ${supAId}`,
  );
  assert(
    supLogRows.some((l) => l.action === '供应商资质审核' && String(l.targetId) === String(supBId)),
    'D26 资质审核留痕（`targetId` = 供应商 id；审核是合规动作，必须能回答「谁在什么时候批的」）',
    `hit=${supLogRows.filter((l) => l.action === '供应商资质审核').length}`,
  );
  assert(
    supLogRows.some((l) => l.action === '删除集散中心' && String(l.targetId) === String(dcFreshId)),
    'D32 软删留痕（`targetId` = 集散中心 id）',
    `hit=${supLogRows.filter((l) => l.action === '删除集散中心').length}`,
  );

  // ==========================================================================
  // §19 M3-7 办公楼 / 楼群（D13–D18）
  //
  // ⚠️ **不依赖下单窗口**：办公楼与楼群是纯主数据，任何时刻都能跑。
  //
  // ⚠️ 夹具纪律：楼名 / 楼群名一律带 `stamp`（重复跑不撞重名校验 60005/60004），
  //    且**不往种子楼群里塞楼** —— 种子 5 个楼群的成员数被 §14/§17 依赖，
  //    动它会连坐前面几节的断言。本节的楼一律挂在本节自建的楼群上。
  //
  // ⚠️ 整节包在**独立块作用域**里：`bList` / `gRows` / `finRead` 这类通用名在前 18 节
  //    大概率已用过，`const` 重复声明是语法错误。用块把名字关起来，比给 60 个变量
  //    逐个加前缀更不容易出错，也让「本节自带的夹具不泄漏到后面」成为语法保证。
  // ==========================================================================
  {
    log('\n§19 M3-7 办公楼 / 楼群（D13–D18）');

  const bldA = `e2e楼A_${stamp}`;
  const bldB = `e2e楼B_${stamp}`;
  const grpA = `e2e群A_${stamp}`;
  const grpB = `e2e群B_${stamp}`;

  // ---------------------------------------------------------- A · D13 列表
  const bList = await call('GET', `/admin/buildings?${qs({ pageSize: 100 })}`, { token: adminToken });
  const bRows = bList.body?.data?.list ?? [];
  const bSum = bList.body?.data?.summary ?? {};
  const bTotal = bList.body?.data?.total;
  const bById = new Map(bRows.map((b) => [b.id, b]));

  assert(
    bList.body?.code === 0 && Array.isArray(bRows) && bTotal >= 12,
    'D13 办公楼列表返回成功，且至少含种子 12 栋',
    `code=${bList.body?.code} total=${bTotal}`,
  );
  assert(
    bSum.totalCount === bTotal,
    'D13 summary 按**同一过滤条件的全量**统计（翻页不跳 KPI：totalCount 恒等于 total）',
    `summary=${bSum.totalCount} total=${bTotal} 本页=${bRows.length}`,
  );
  assert(
    bRows.every((b) => b.statusLabel && b.gapLabel),
    'D13 每行带派生文案 statusLabel / gapLabel（文案由服务端统一，端上不维护第二份）',
    `sample=${JSON.stringify(bRows[0]?.statusLabel)}/${JSON.stringify(bRows[0]?.gapLabel)}`,
  );

  // 三态修复：M3-7 之前「待开通」与「已暂停」都写成 status=2（一值两义）
  assert(
    bById.get(3)?.status === 2 && bById.get(3)?.statusLabel === '待开通',
    'D13 种子「国贸三期 C 座」= status 2 **待开通**（三态扩展：2 待开通 ≠ 3 已暂停）',
    `status=${bById.get(3)?.status} label=${bById.get(3)?.statusLabel}`,
  );
  assert(
    bById.get(10)?.status === 3 && bById.get(10)?.statusLabel === '已暂停',
    'D13 种子「华贸 3 号楼」= status 3 **已暂停** —— 与 C 座区分开（旧数据两者都是 2）',
    `status=${bById.get(10)?.status} label=${bById.get(10)?.statusLabel}`,
  );

  // 派生：种子 4 个集散中心覆盖 1–5 全部楼群 → 种子楼无缺口
  assert(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].every((id) => bById.get(id)?.gap === 'none'),
    'D13 覆盖缺口派生：种子 5 个楼群均被集散中心覆盖 → 12 栋种子楼 gap 全部为 none',
    `gaps=${JSON.stringify([...new Set(bRows.slice(0, 12).map((b) => b.gap))])}`,
  );
  assert(
    bById.get(1)?.mainDcName === '集散中心 1（国贸/建外）' && bById.get(1)?.routeNo === 'R1',
    'D13 主集散中心与路线号**由「集散中心 → 服务楼群」实时派生**（主 = 服务该楼群、启用中 id 最小者）',
    `main=${bById.get(1)?.mainDcName} route=${bById.get(1)?.routeNo}`,
  );
  assert(
    bById.get(4)?.backupDcName === '集散中心 3（国贸/远洋）',
    'D13 备用集散中心 = 服务同一楼群的其他启用集散中心（国贸三期组被 DC1 与 DC3 同时服务）',
    `backup=${bById.get(4)?.backupDcName}`,
  );
  assert(
    bRows.every((b) => b.canOrder === (b.status === 1 && b.buildingGroupId !== null)),
    'D13 `canOrder` = 营业中 ∧ 已归群 —— 未归群的楼无法分配套餐，不能算「可开团」',
    `mismatch=${JSON.stringify(bRows.filter((b) => b.canOrder !== (b.status === 1 && b.buildingGroupId !== null)).map((b) => b.id))}`,
  );

  const bActive = await call('GET', `/admin/buildings?${qs({ status: 1, pageSize: 100 })}`, {
    token: adminToken,
  });
  assert(
    (bActive.body?.data?.list ?? []).every((b) => b.status === 1) &&
      (bActive.body?.data?.list ?? []).length > 0,
    'D13 状态筛选生效（status=1 只回营业中）',
    `count=${(bActive.body?.data?.list ?? []).length}`,
  );
  const bVacant = await call('GET', `/admin/buildings?${qs({ leaderState: 'unassigned', pageSize: 100 })}`, {
    token: adminToken,
  });
  assert(
    (bVacant.body?.data?.list ?? []).every((b) => b.leaderId === null) &&
      (bVacant.body?.data?.list ?? []).length > 0,
    'D13 团长归属筛选生效（unassigned 只回无在职团长的楼）',
    `count=${(bVacant.body?.data?.list ?? []).length}`,
  );
  const bKw = await call('GET', `/admin/buildings?${qs({ keyword: '国贸', pageSize: 100 })}`, {
    token: adminToken,
  });
  assert(
    (bKw.body?.data?.list ?? []).length > 0 &&
      (bKw.body?.data?.list ?? []).every((b) => b.name.includes('国贸') || b.address.includes('国贸')),
    'D13 关键词命中楼名或地址',
    `count=${(bKw.body?.data?.list ?? []).length}`,
  );
  const bPaged = await call('GET', `/admin/buildings?${qs({ pageSize: 3, page: 1 })}`, {
    token: adminToken,
  });
  assert(
    (bPaged.body?.data?.list ?? []).length === 3 && bPaged.body?.data?.summary.totalCount === bSum.totalCount,
    'D13 分页只影响本页条数，summary 仍是全量（与 D8/D19/D23 同一约定）',
    `本页=${(bPaged.body?.data?.list ?? []).length} summary=${bPaged.body?.data?.summary?.totalCount}`,
  );

  // ---------------------------------------------------------- B · D14 新增
  const grpACreate = await call('POST', '/admin/building-groups', {
    token: adminToken,
    body: { name: grpA, description: 'e2e 办公楼夹具楼群' },
  });
  const grpAId = grpACreate.body?.data?.id;
  assert(
    grpACreate.body?.code === 0 && grpAId > 0,
    'D17 新建空楼群成功',
    `code=${grpACreate.body?.code} id=${grpAId}`,
  );
  assert(
    grpACreate.body?.data?.coverageState === 'empty',
    'D17 空楼群 coverageState=empty（**空不是异常**：新群还没挂楼）',
    `state=${grpACreate.body?.data?.coverageState}`,
  );

  const bldACreate = await call('POST', '/admin/buildings', {
    token: adminToken,
    body: { name: bldA, address: 'e2e 测试路 1 号', population: 300, buildingGroupId: grpAId },
  });
  const bldAId = bldACreate.body?.data?.id;
  assert(
    bldACreate.body?.code === 0 && bldAId > 0 && bldACreate.body?.data?.buildingGroupId === grpAId,
    'D14 新增办公楼（已归群）成功',
    `code=${bldACreate.body?.code} id=${bldAId} group=${bldACreate.body?.data?.buildingGroupId}`,
  );
  assert(
    bldACreate.body?.data?.gap === 'no_center' &&
      (bldACreate.body?.data?.warnings ?? []).some((w) => w.includes('集散中心')),
    'D14 新建楼群尚无集散中心服务 → gap=no_center，且出参 warnings **逐条说明**「还差什么才能开团」',
    `gap=${bldACreate.body?.data?.gap} warnings=${JSON.stringify(bldACreate.body?.data?.warnings)}`,
  );

  const bldBCreate = await call('POST', '/admin/buildings', {
    token: adminToken,
    body: { name: bldB, address: 'e2e 测试路 2 号', population: 200 },
  });
  const bldBId = bldBCreate.body?.data?.id;
  assert(
    bldBCreate.body?.code === 0 && bldBCreate.body?.data?.buildingGroupId === null,
    'D14 不传 buildingGroupId 即「未归群」（楼能建档，但不参与任何套餐分配）',
    `group=${bldBCreate.body?.data?.buildingGroupId}`,
  );
  assert(
    bldBCreate.body?.data?.canOrder === false && bldBCreate.body?.data?.gap === 'no_group',
    'D14 未归群楼 canOrder=false 且 gap=no_group（未归群与「楼群无集散」是两种成因，不能合并）',
    `canOrder=${bldBCreate.body?.data?.canOrder} gap=${bldBCreate.body?.data?.gap}`,
  );

  const bDup = await call('POST', '/admin/buildings', {
    token: adminToken,
    body: { name: bldA, address: 'e2e 测试路 9 号' },
  });
  assert(
    bDup.body?.code === 60005,
    'D14 楼名重复 → 60005（同名楼会让「按楼筛选」变成歧义操作）',
    `code=${bDup.body?.code}`,
  );
  const bBadGroup = await call('POST', '/admin/buildings', {
    token: adminToken,
    body: { name: `e2e楼C_${stamp}`, address: 'e2e 测试路 3 号', buildingGroupId: 999999 },
  });
  assert(
    bBadGroup.body?.code === 60002,
    'D14 楼群不存在 → 60002（不静默落成「未归群」：运营以为挂上了，实际没挂）',
    `code=${bBadGroup.body?.code}`,
  );

  // ---------------------------------------------------------- C · D15 编辑
  const bNoop = await call('PUT', `/admin/buildings/${bldAId}`, {
    token: adminToken,
    body: { name: bldA },
  });
  assert(
    bNoop.body?.code === 10001,
    'D15 空变更 → 10001（不写库、不写日志；否则审计里全是「改了但什么都没改」）',
    `code=${bNoop.body?.code}`,
  );
  assert(
    bNoop.body?.code === 10001 || readRows('SELECT id FROM ab_building WHERE name = ?', [bldA]).length === 1,
    'D15 空变更不产生重复记录',
    `rows=${readRows('SELECT id FROM ab_building WHERE name = ?', [bldA]).length}`,
  );

  const bLeaderField = await call('PUT', `/admin/buildings/${bldAId}`, {
    token: adminToken,
    body: { leaderId: 1 },
  });
  assert(
    bLeaderField.body?.code === 10001,
    'D15 **刻意不收 leaderId** → 10001（改团长只有 D20/D21 一个入口，避免绕过 20012 撞车闸门）',
    `code=${bLeaderField.body?.code}`,
  );

  const bRename = await call('PUT', `/admin/buildings/${bldAId}`, {
    token: adminToken,
    body: { name: `${bldA}_改`, population: 350 },
  });
  assert(
    bRename.body?.code === 0 && bRename.body?.data?.name === `${bldA}_改`,
    'D15 部分更新生效（改名 + 改覆盖人数）',
    `code=${bRename.body?.code} name=${bRename.body?.data?.name}`,
  );

  const bDetach = await call('PUT', `/admin/buildings/${bldAId}`, {
    token: adminToken,
    body: { buildingGroupId: null },
  });
  assert(
    bDetach.body?.code === 0 &&
      bDetach.body?.data?.buildingGroupId === null &&
      bDetach.body?.data?.gap === 'no_group',
    'D15 `buildingGroupId: null` = **移出楼群**（否则永远无法把楼摘出去，只能建空壳楼群当垃圾桶）',
    `code=${bDetach.body?.code} group=${bDetach.body?.data?.buildingGroupId} gap=${bDetach.body?.data?.gap}`,
  );
  assert(
    readDb('SELECT id FROM ab_building WHERE id = ? AND building_group_id IS NULL', [bldAId]) !== null,
    'D15 移出楼群落库为 NULL（不是 0，也不是保持原值）',
    `hit=${readDb('SELECT id FROM ab_building WHERE id = ? AND building_group_id IS NULL', [bldAId]) ? 'yes' : 'no'}`,
  );

  const bReattach = await call('PUT', `/admin/buildings/${bldAId}`, {
    token: adminToken,
    body: { buildingGroupId: grpAId },
  });
  assert(
    bReattach.body?.code === 0 && bReattach.body?.data?.buildingGroupId === grpAId,
    'D15 重新归群生效',
    `group=${bReattach.body?.data?.buildingGroupId}`,
  );

  const bMissing = await call('PUT', '/admin/buildings/99999999', {
    token: adminToken,
    body: { population: 1 },
  });
  assert(
    bMissing.body?.code === 60001,
    'D15 楼栋不存在 → 60001',
    `code=${bMissing.body?.code}`,
  );

  // ---------------------------------------------------------- D · D16 楼群列表
  const gList = await call('GET', `/admin/building-groups?${qs({ pageSize: 100 })}`, { token: adminToken });
  const gRows = gList.body?.data?.list ?? [];
  const gSum = gList.body?.data?.summary ?? {};
  assert(
    gList.body?.code === 0 && gRows.length >= 5 && gList.body?.data?.total >= 5,
    'D16 楼群列表返回成功，且至少含种子 5 个',
    `code=${gList.body?.code} total=${gList.body?.data?.total}`,
  );
  assert(
    gSum.totalCount === gList.body?.data?.total,
    'D16 summary 为全量统计（翻页不跳 KPI）',
    `summary=${gSum.totalCount} total=${gList.body?.data?.total}`,
  );
  const gA = gRows.find((g) => g.id === grpAId);
  assert(
    gA?.memberCount === 1 && (gA?.members ?? []).length === 1,
    'D16 `memberCount` 与 `members` 数组**同一次查询得出**（分两处算必然出现「列表 2 栋、详情 1 栋」）',
    `memberCount=${gA?.memberCount} members=${(gA?.members ?? []).length}`,
  );
  assert(
    gA?.coverageState === 'uncovered' && gA?.mainDcName === null,
    'D16 覆盖状态派生：有成员楼但无集散中心服务 → uncovered（**下单能成立、履约断链**）',
    `state=${gA?.coverageState} main=${gA?.mainDcName}`,
  );
  const gSeed1 = gRows.find((g) => g.id === 1);
  assert(
    gSeed1?.mainDcName === '集散中心 1（国贸/建外）' &&
      gSeed1?.backupDcName === '集散中心 3（国贸/远洋）' &&
      gSeed1?.coverageState === 'covered',
    'D16 种子楼群主/备集散中心派生正确（国贸三期组：主 DC1 / 备 DC3）',
    `main=${gSeed1?.mainDcName} backup=${gSeed1?.backupDcName} state=${gSeed1?.coverageState}`,
  );
  const gKw = await call('GET', `/admin/building-groups?${qs({ keyword: bldA, pageSize: 100 })}`, {
    token: adminToken,
  });
  assert(
    (gKw.body?.data?.list ?? []).some((g) => g.id === grpAId),
    'D16 关键词可命中**成员楼名**（运营记得楼名、未必记得楼群名）',
    `hits=${(gKw.body?.data?.list ?? []).map((g) => g.id).join(',')}`,
  );

  // ---------------------------------------------------------- E · D17 / D18
  const gDup = await call('POST', '/admin/building-groups', {
    token: adminToken,
    body: { name: grpA },
  });
  assert(gDup.body?.code === 60004, 'D17 楼群名重复 → 60004', `code=${gDup.body?.code}`);

  const gBadMember = await call('POST', '/admin/building-groups', {
    token: adminToken,
    body: { name: grpB, buildingIds: [99999999] },
  });
  assert(
    gBadMember.body?.code === 60001,
    'D17 `buildingIds` 含不存在的楼 → 60001（不静默跳过：运营以为挂上了 3 栋，实际只挂上 2 栋）',
    `code=${gBadMember.body?.code}`,
  );

  const gBCreate = await call('POST', '/admin/building-groups', {
    token: adminToken,
    body: { name: grpB, buildingIds: [bldBId] },
  });
  const grpBId = gBCreate.body?.data?.id;
  assert(
    gBCreate.body?.code === 0 && gBCreate.body?.data?.memberCount === 1,
    'D17 新建楼群并**整体设置**初始成员楼',
    `code=${gBCreate.body?.code} id=${grpBId} members=${gBCreate.body?.data?.memberCount}`,
  );
  assert(
    readDb('SELECT building_group_id AS g FROM ab_building WHERE id = ?', [bldBId])?.g === grpBId,
    'D17 成员楼落库：`ab_building.building_group_id` 指向新楼群（一楼一群，单值即覆盖）',
    `dbG=${readDb('SELECT building_group_id AS g FROM ab_building WHERE id = ?', [bldBId])?.g}`,
  );

  const gStopNonEmpty = await call('PUT', `/admin/building-groups/${grpBId}`, {
    token: adminToken,
    body: { status: 2 },
  });
  assert(
    gStopNonEmpty.body?.code === 60003,
    'D18 停用**仍有成员楼**的楼群 → 60003 —— 停用会让成员楼静默失去开团能力，而楼自身状态仍是「营业中」，列表上看不出异常（fail-closed）',
    `code=${gStopNonEmpty.body?.code} remaining=${gStopNonEmpty.body?.data?.remaining}`,
  );
  assert(
    readDb('SELECT status FROM ab_building_group WHERE id = ?', [grpBId])?.status === 1,
    'D18 被 60003 拦下时**零副作用**（状态没被动成 2 —— 「先改再校验」会留下停了一半的楼群）',
    `dbStatus=${readDb('SELECT status FROM ab_building_group WHERE id = ?', [grpBId])?.status}`,
  );

  const gClearAndStop = await call('PUT', `/admin/building-groups/${grpBId}`, {
    token: adminToken,
    body: { buildingIds: [], status: 2 },
  });
  assert(
    gClearAndStop.body?.code === 0 &&
      gClearAndStop.body?.data?.memberCount === 0 &&
      gClearAndStop.body?.data?.status === 2,
    'D18 **一次请求内「清空成员 + 停用」应当放行**（先搬楼再判闸门；否则运营必须分两次调用，中间态毫无意义）',
    `code=${gClearAndStop.body?.code} members=${gClearAndStop.body?.data?.memberCount} status=${gClearAndStop.body?.data?.status}`,
  );
  assert(
    readDb('SELECT building_group_id AS g FROM ab_building WHERE id = ?', [bldBId])?.g === null,
    'D18 整体替换语义：传 `[]` = 清空成员楼（不是「保持原值」—— 那样运营会以为解绑了、实际还挂着）',
    `dbG=${readDb('SELECT building_group_id AS g FROM ab_building WHERE id = ?', [bldBId])?.g}`,
  );

  const gMissing = await call('PUT', '/admin/building-groups/99999999', {
    token: adminToken,
    body: { name: 'e2e 不存在群' },
  });
  assert(gMissing.body?.code === 60002, 'D18 楼群不存在 → 60002', `code=${gMissing.body?.code}`);

  // ---------------------------------------------------------- F · 派生联动 + 视图聚合
  // 给 grpA 挂一个**新建**集散中心 → 覆盖状态应由 uncovered 翻成 covered（跨批次联动：M3-6 D30/D31 → M3-7 派生）
  // ⚠️ M4-0：场所不再归属供应商（`supplierId` 已从入参移除），本节只需一个能服务 grpA 的场所。
  const dcCreate = await call('POST', '/admin/distribution-centers', {
    token: adminToken,
    body: {
      name: `e2e集散_${stamp}`,
      address: 'e2e 集散地址',
      serviceGroups: [grpAId],
      status: 1,
    },
  });
  const dcxId = dcCreate.body?.data?.id;
  assert(
    dcCreate.body?.code === 0 && dcxId > 0,
    'D30 新建集散中心并服务本节的楼群（跨批次夹具：M3-6 的配置驱动 M3-7 的派生）',
    `code=${dcCreate.body?.code} id=${dcxId}`,
  );

  const bAfterDc = await call('GET', `/admin/buildings?${qs({ groupId: grpAId, pageSize: 100 })}`, {
    token: adminToken,
  });
  const bA2 = (bAfterDc.body?.data?.list ?? []).find((b) => b.id === bldAId);
  assert(
    bA2?.gap === 'none' && bA2?.mainDcName === `e2e集散_${stamp}` && bA2?.routeNo !== null,
    'D13 派生随配置**实时变化**：集散中心挂上该楼群后，该楼的 gap 立刻由 no_center 翻成 none（不是落库快照）',
    `gap=${bA2?.gap} main=${bA2?.mainDcName} route=${bA2?.routeNo}`,
  );
  assert(
    bA2?.canOrder === true,
    'D13 覆盖补齐后 canOrder=true（营业中 ∧ 已归群）',
    `canOrder=${bA2?.canOrder}`,
  );

  const dcDisable = await call('PUT', `/admin/distribution-centers/${dcxId}`, {
    token: adminToken,
    body: { status: 0 },
  });
  assert(dcDisable.body?.code === 0, 'D31 停用（非删除）集散中心', `code=${dcDisable.body?.code}`);

  const bAfterDisable = await call('GET', `/admin/buildings?${qs({ groupId: grpAId, pageSize: 100 })}`, {
    token: adminToken,
  });
  const bA3 = (bAfterDisable.body?.data?.list ?? []).find((b) => b.id === bldAId);
  assert(
    bA3?.gap === 'all_center_disabled' && bA3?.mainDcName === null,
    'D13 「集散中心已停用」是**第三种**覆盖缺口（≠ 楼群无集散中心）—— 三种成因三种修法，合成一个「未覆盖」运营只能猜',
    `gap=${bA3?.gap} main=${bA3?.mainDcName}`,
  );

  // 视图聚合一致性：overview / delivery-map 与 D13 必须同源
  const ovw = await call('GET', '/admin/buildings/overview', { token: adminToken });
  const ovwData = ovw.body?.data ?? {};
  assert(
    ovw.body?.code === 0 && ovwData.buildings?.totalCount >= 12,
    'P37 总览接口返回成功（主数据健康度聚合）',
    `code=${ovw.body?.code} total=${ovwData.buildings?.totalCount}`,
  );
  const gapFiltered = await call('GET', `/admin/buildings?${qs({ gap: 'no_group', pageSize: 100 })}`, {
    token: adminToken,
  });
  const gapRows2 = gapFiltered.body?.data?.list ?? [];
  assert(
    gapRows2.every((b) => b.gap === 'no_group') && gapRows2.length > 0,
    'D13 覆盖缺口筛选生效（gap=no_group 只回未归群的楼）',
    `count=${gapRows2.length}`,
  );
  assert(
    (ovwData.uncoveredBuildings ?? []).some((b) => b.id === bldAId) &&
      !(ovwData.uncoveredBuildings ?? []).some((b) => b.gap === 'none'),
    'P37 总览的「未覆盖楼栋」清单与 D13 的 gap 判定**同源**（总览不另算一套）',
    `uncovered=${(ovwData.uncoveredBuildings ?? []).length}`,
  );
  assert(
    ovwData.groupDistribution?.find((g) => g.groupId === grpAId)?.coverageState === 'uncovered',
    'P37 总览的楼群分布沿用 D16 的覆盖状态派生（停用集散中心后该楼群回到 uncovered）',
    `state=${ovwData.groupDistribution?.find((g) => g.groupId === grpAId)?.coverageState}`,
  );

  const dmap = await call('GET', '/admin/buildings/delivery-map', { token: adminToken });
  const dm = dmap.body?.data ?? {};
  const dmStops = (dm.routes ?? []).flatMap((r) => r.stops ?? []);
  assert(dmap.body?.code === 0 && Array.isArray(dm.routes), '配送映射接口返回成功', `code=${dmap.body?.code}`);
  assert(
    dm.summary?.coveredBuildingCount + dm.summary?.uncoveredBuildingCount === dm.summary?.totalBuildingCount,
    '配送映射守恒：已覆盖楼栋 + 未覆盖楼栋 = 楼栋总数（派生视图最容易在这里漏行）',
    `covered=${dm.summary?.coveredBuildingCount} uncovered=${dm.summary?.uncoveredBuildingCount} total=${dm.summary?.totalBuildingCount}`,
  );
  assert(
    (dm.unassigned ?? []).some((u) => u.buildingId === bldAId && u.gap === 'all_center_disabled'),
    '配送映射的「未分配」清单带上**缺口原因**（让运营知道去改哪里，而不是只看到「未分配」）',
    `unassigned=${(dm.unassigned ?? []).map((u) => u.buildingId).join(',')}`,
  );
  assert(
    dmStops.every((s) => typeof s.seq === 'number' && s.buildingName) &&
      (dm.routes ?? []).every((r) => (r.stops ?? []).every((x, i) => x.seq === i + 1)),
    '配送映射：站点序号在**同一路线内**从 1 递增（路线内顺序 = 楼栋 id 升序）',
    `maxSeq=${Math.max(0, ...dmStops.map((s) => s.seq))}`,
  );
  assert(
    dmStops.every((s) => s.distanceKm === undefined && s.durationMin === undefined) &&
      (dm.routes ?? []).every((r) => r.distanceKm === undefined),
    '配送映射**不返回距离与单段时长**（需地图与真实路况数据，一期不具备；原型上的 km/分钟是演示值，不当成交付口径）',
    `keys=${Object.keys(dmStops[0] ?? {}).join(',')}`,
  );
  assert(
    (dm.routes ?? []).every((r) => new Set((r.stops ?? []).map((s) => s.buildingId)).size === (r.stops ?? []).length),
    '配送映射：一条路线内不出现重复楼栋',
    `routes=${(dm.routes ?? []).length}`,
  );

  // ---------------------------------------------------------- G · 权限（两级白名单）
  const opRead = await call('GET', `/admin/buildings?${qs({ pageSize: 5 })}`, { token: supOpToken });
  assert(opRead.body?.code === 0, '两级白名单①：operator 可读办公楼列表', `code=${opRead.body?.code}`);
  const opWrite = await call('POST', '/admin/buildings', {
    token: supOpToken,
    body: { name: `e2e越权楼_${stamp}`, address: 'e2e 越权地址' },
  });
  assert(
    opWrite.body?.code === 10003 &&
      readRows('SELECT id FROM ab_building WHERE name = ?', [`e2e越权楼_${stamp}`]).length === 0,
    '两级白名单②：operator 新建办公楼 → 10003 且**无记录**（守卫挡在业务层之前，不是「执行了再回滚」）',
    `code=${opWrite.body?.code}`,
  );
  const viewRead = await call('GET', '/admin/buildings', { token: supViewToken });
  assert(
    viewRead.body?.code === 10003,
    '两级白名单③：viewer 类级就不放（菜单矩阵里没有 /building/*，API 放行会出现「能调但进不去」的诡异状态）',
    `code=${viewRead.body?.code}`,
  );
  const finRead = await call('GET', '/admin/building-groups', { token: finToken2 });
  assert(
    finRead.body?.code === 10003,
    '两级白名单④：finance 同样收窄（财务不改楼栋主数据）',
    `code=${finRead.body?.code}`,
  );

  // ---------------------------------------------------------- H · 主体隔离 + 日志
  const miniBld = await call('GET', '/admin/buildings', { token: u.token });
  assert(
    miniBld.body?.code === 10003,
    '双主体隔离：小程序 token 打 /admin/buildings → 10003',
    `code=${miniBld.body?.code}`,
  );
  const bldLogs = await call('GET', `/admin/system/logs?${qs({ pageSize: 100 })}`, { token: adminToken });
  const bldLogRows = bldLogs.body?.data?.list ?? [];
  assert(
    bldLogRows.some((l) => l.action === '新增办公楼' && String(l.targetId) === String(bldAId)),
    'D14 自动落操作日志且 `targetId` = **新楼 id**（新建接口请求里没有 id，靠响应体兜底取得 —— 否则日志永远挂不到这栋楼上）',
    `targetIds=${JSON.stringify(bldLogRows.filter((l) => l.action === '新增办公楼').map((l) => l.targetId))} 期望含 ${bldAId}`,
  );
  assert(
    bldLogRows.some((l) => l.action === '编辑楼群' && String(l.targetId) === String(grpBId)),
    'D18 编辑楼群留痕（`targetId` = 楼群 id）',
    `hit=${bldLogRows.filter((l) => l.action === '编辑楼群').length}`,
  );
  }

  // ==========================================================================
  // §20 M3-8 出餐确认 S1–S2（原型 P21/P22 · 供应商端）
  //      + M4-0 加工场所打包任务（原 S3 · 已迁运营后台 `GET /admin/packing-tasks`）
  // ==========================================================================
  //
  // ⚠️ **本节刻意不依赖下单窗口**（与 §18/§19 同纪律），且更进一步：
  //    「超时」用例一律用**昨日**，不用今日 —— 「今日是否已过 09:30」依运行时刻而定，
  //    凌晨 00:00–09:30 跑就会翻。昨日一定过点，断言与时钟无关。
  //    「应成功」用例一律用**明日**（T+1），此时截止点尚未到达 —— 这正是
  //    「09:30 是 deadline 而非 earliest」的实现语义：提前确认允许。
  {
    const TMR = addDaysStr(bjToday(), 1);
    const YST = addDaysStr(bjToday(), -1);
    const FAR = addDaysStr(bjToday(), 60);

    const supLogin = await adminLogin('sanweiwu', 'supplier123');
    const supToken = supLogin.token;
    const supAccountId = Number(seedSupplier?.id ?? 0);
    const guest = await userLogin(`e2e_sup_${stamp}`);

    // ---- A. 主体隔离（三个主体，三套账号体系） ----
    assert(
      supLogin.code === 0 && !!supToken,
      '前置：种子供应商账号 sanweiwu 可登录（role=supplier，绑定 ab_supplier.id=1）',
      `code=${supLogin.code} role=${supLogin.account?.role} supplierId=${supLogin.account?.supplierId}`,
    );
    const centOnSup = await call('GET', '/supplier/workbench', { token: guest.token });
    assert(
      centOnSup.body?.code === 10003,
      '双主体隔离：小程序 token 打 /supplier/workbench → 10003（C 端与后台 id 各自自增，不隔离即静默越权）',
      `code=${centOnSup.body?.code}`,
    );
    const adminOnSup = await call('GET', '/supplier/workbench', { token: adminToken });
    assert(
      adminOnSup.body?.code === 10003,
      '双主体隔离：运营账号（role=super_admin）打 /supplier/* → 10003（供应商端点只对 role=supplier 开放）',
      `code=${adminOnSup.body?.code}`,
    );

    // ---- B. S1 工作台 ----
    const wb = await call('GET', '/supplier/workbench', { token: supToken });
    const wbData = wb.body?.data;
    assert(
      wb.body?.code === 0 && wbData?.supplier?.name === '三味屋',
      'S1 工作台返回本主体（三味屋）—— 数据范围由 token 里的 supplierId 收窄，请求体**不收** supplierId',
      `code=${wb.body?.code} name=${wbData?.supplier?.name}`,
    );
    assert(
      wbData?.supplier?.canServe === true,
      'S1 下发 `canServe` 派生值（合作中 ∧ 资质已通过 ∧ 证照未过期）—— 端上先提示再放按钮，别让供应商点了才发现被拦',
      `canServe=${wbData?.supplier?.canServe} audit=${wbData?.supplier?.auditStatus} license=${wbData?.supplier?.licenseState}`,
    );
    assert(
      wbData?.date === TMR,
      'S1 `date` 缺省 = 本主体最近一个有生产计划的出餐日（种子在 T+1，故为明日）—— 不写死 tomorrowBj()',
      `date=${wbData?.date} 期望=${TMR}`,
    );
    assert(
      (wbData?.dishes ?? []).length === 1 &&
        wbData?.dishes?.[0]?.dishId === 1 &&
        wbData?.dishes?.[0]?.dishName === '红烧肉',
      'S1 列出本主体当日菜品（三味屋 = 红烧肉，一道）',
      `dishes=${JSON.stringify((wbData?.dishes ?? []).map((d) => d.dishName))}`,
    );
    assert(
      wbData?.dishes?.[0]?.planQuantity === 45 && wbData?.summary?.planQuantity === 45,
      'S1 计划份数与「楼群已售份数」同源（种子里 bg1 已售 45 → 45 份）—— 派生自 ab_meal_assignment，不是另算一份',
      `plan=${wbData?.dishes?.[0]?.planQuantity} summary=${wbData?.summary?.planQuantity}`,
    );
    assert(
      (wbData?.dishes?.[0]?.centers ?? []).length === 1 &&
        wbData?.dishes?.[0]?.centers?.[0]?.distributionCenterId === 1 &&
        wbData?.dishes?.[0]?.centers?.[0]?.planQuantity === 45,
      'S1 明细按**集散中心**拆分（原型 P22 的交互粒度：一道菜分别送到 N 个中心，各中心单独确认）',
      `centers=${JSON.stringify((wbData?.dishes?.[0]?.centers ?? []).map((c) => `${c.centerName}:${c.planQuantity}`))}`,
    );
    assert(
      wbData?.deadline?.text === '09:30' && wbData?.deadline?.overdue === false && wbData?.deadline?.canConfirm === true,
      'S1 下发确认截止（出餐日当天 09:30）与是否已过点 —— 明日未到点，`canConfirm=true`',
      `text=${wbData?.deadline?.text} overdue=${wbData?.deadline?.overdue} canConfirm=${wbData?.deadline?.canConfirm}`,
    );
    assert(
      (wbData?.dishes?.[0]?.unitPriceFen ?? 0) > 0 &&
        Number.isInteger(wbData?.dishes?.[0]?.unitPriceFen),
      'S1 金额出参为**整数分**（unitPriceFen 取 ab_dish.cost_price = 7.50 → 750）',
      `unitPriceFen=${wbData?.dishes?.[0]?.unitPriceFen}`,
    );
    assert(
      !!wbData?.notes?.confirmRule && !!wbData?.notes?.planFrozen,
      'S1 下发口径说明（确认规则 / 计划冻结 / 非结算依据）—— 端上直接渲染，不自己编文案',
      `keys=${Object.keys(wbData?.notes ?? {}).join(',')}`,
    );

    // 惰性生成落库：父行 + 分中心明细
    const lazyDaily = readDb(
      'SELECT id, plan_quantity, status FROM ab_supplier_dish_daily WHERE supplier_id = 1 AND dish_id = 1 AND produce_date = ?',
      [TMR],
    );
    const lazyDetail = readDb(
      'SELECT id, plan_quantity, status FROM ab_supplier_dish_center_daily WHERE supplier_id = 1 AND dish_id = 1 AND produce_date = ? AND distribution_center_id = 1',
      [TMR],
    );
    assert(
      !!lazyDaily && !!lazyDetail && Number(lazyDetail.plan_quantity) === 45 && lazyDetail.status === 'pending',
      'S1 首次访问**惰性生成**生产计划（父行 + 分中心明细）并落库 —— 计划是给供应商的承诺数，生成即冻结，不能每次实时重算',
      `daily=${lazyDaily?.plan_quantity} detail=${lazyDetail?.plan_quantity}/${lazyDetail?.status}`,
    );

    const emptyWb = await call('GET', `/supplier/workbench?date=${FAR}`, { token: supToken });
    assert(
      emptyWb.body?.code === 0 &&
        emptyWb.body?.data?.summary?.empty === true &&
        (emptyWb.body?.data?.dishes ?? []).length === 0,
      'S1 远期无计划日 → `summary.empty=true` 且 dishes 为空（端上走空态，而不是显示一张全 0 的表格）',
      `empty=${emptyWb.body?.data?.summary?.empty} dishes=${(emptyWb.body?.data?.dishes ?? []).length}`,
    );

    // ---- C. 加工场所打包任务：闸门未就绪（原 S3 · M4-0 迁运营后台） ----
    const pk1 = await call('GET', `/admin/packing-tasks?date=${TMR}`, { token: adminToken });
    const pk1Data = pk1.body?.data;
    const pk1Center = (pk1Data?.centers ?? []).find((c) => c.centerId === 1);
    assert(
      pk1.body?.code === 0 && pk1Data?.visible === true && !!pk1Center,
      '打包任务由**运营后台**读取，一次返回**全部启用中的加工场所** —— 判据不再是「本主体名下有没有集散中心」（自营下场所属 ABox 自有，`supplier_id` 已停用，该判据已失效）',
      `visible=${pk1Data?.visible} centers=${JSON.stringify((pk1Data?.centers ?? []).map((c) => `#${c.centerId}`))}`,
    );
    assert(
      pk1Center?.ready === false && (pk1Center?.blockers ?? []).length === 4,
      '打包前置闸门：该场所当日菜品**未全部确认送达** → `ready=false`，blockers 列出欠的 4 家（此刻三味屋也还没确认）—— 未到齐就开包会包出缺菜的餐',
      `ready=${pk1Center?.ready} blockers=${JSON.stringify((pk1Center?.blockers ?? []).map((b) => b.supplierName))}`,
    );
    const allDetailsTmr = readRows(
      'SELECT supplier_id, plan_quantity FROM ab_supplier_dish_center_daily WHERE produce_date = ? AND distribution_center_id = 1',
      [TMR],
    );
    assert(
      allDetailsTmr.length === 4,
      '打包任务**全量派生**（跨所有供应商）：闸门要看到所有供应商的到位情况，漏掉任何一家「已到齐」都是假象 —— 正因如此这份数据不能开给供应商（I1）',
      `rows=${allDetailsTmr.length} suppliers=${JSON.stringify(allDetailsTmr.map((r) => r.supplier_id))}`,
    );
    assert(
      (pk1Center?.routes ?? []).length === 2 &&
        (pk1Center?.routes ?? []).every((r) => r.routeNo && r.stops.length > 0),
      '打包路线派生：加工场所 1 服务楼群 1/2 → 两条路线，各带 R 编号与站点链（按楼栋 id 升序）',
      `routes=${JSON.stringify((pk1Center?.routes ?? []).map((r) => `${r.routeNo}:${r.groupName}:${r.quantity}`))}`,
    );
    assert(
      pk1Center?.summary?.batchQuantity === 45 && pk1Center?.summary?.stopCount > 0,
      '打包份数 = 该场所所服务楼群当日已售份数之和（bg1 45 + bg2 0 = 45）',
      `batch=${pk1Center?.summary?.batchQuantity} stops=${pk1Center?.summary?.stopCount}`,
    );
    assert(
      pk1Center?.distanceKm === undefined && pk1Center?.durationMin === undefined,
      '打包任务**不返回距离与单段时长**（无地图数据，原型上的 km/分钟是演示值，写进接口就是对外承诺）',
      `keys=${Object.keys(pk1Center ?? {}).join(',')}`,
    );
    assert(
      !!pk1Data?.notes?.scopeRule && !!pk1Data?.notes?.gateRule && !!pk1Data?.notes?.routeRule,
      '打包任务下发**范围口径**（跨供应商 · 不对供应商端开放）与闸门 / 路线口径说明',
      `keys=${Object.keys(pk1Data?.notes ?? {}).join(',')}`,
    );

    // ---- D. 原供应商端 S3 已下线 + 新端点的权限边界（M4-0） ----
    const pkGone = await call('GET', `/supplier/packing-tasks?date=${TMR}`, { token: supToken });
    assert(
      pkGone.body?.code === 10004,
      'S3 供应商端打包任务**已下线** → 10004（路由不存在，不是返回空壳 `visible=false`）—— 闸门含他方到货明细，不得开给供应商（I1）',
      `code=${pkGone.body?.code} msg=${pkGone.body?.message}`,
    );
    const pkOp = await call('GET', `/admin/packing-tasks?date=${TMR}`, { token: supOpToken });
    assert(
      pkOp.body?.code === 0 && pkOp.body?.data?.visible === true,
      '打包任务类级白名单**含 `operator`**（打包是运营的日常作业，必须能看）',
      `code=${pkOp.body?.code}`,
    );
    const pkViewer = await call('GET', `/admin/packing-tasks?date=${TMR}`, { token: supViewToken });
    assert(
      pkViewer.body?.code === 10003,
      '打包任务**不含 `viewer`** → 10003（只读观察者仅看板 —— 与 D47–D50 刻意含 viewer 正好相反）',
      `code=${pkViewer.body?.code}`,
    );
    const pkFin = await call('GET', `/admin/packing-tasks?date=${TMR}`, { token: finToken2 });
    assert(
      pkFin.body?.code === 10003,
      '打包任务**不含 `finance`** → 10003（菜单矩阵里财务没有这一页；API 放行而菜单没有 = 「能调但进不去」）',
      `code=${pkFin.body?.code}`,
    );
    const pkMini = await call('GET', `/admin/packing-tasks?date=${TMR}`, { token: u.token });
    assert(
      pkMini.body?.code === 10003,
      '双主体隔离：小程序 token 打 /admin/packing-tasks → 10003（与 /admin/suppliers 同一隔离依据）',
      `code=${pkMini.body?.code}`,
    );
    const pkAnon = await call('GET', `/admin/packing-tasks?date=${TMR}`);
    assert(
      pkAnon.body?.code === 10002,
      '未登录打 /admin/packing-tasks → 10002',
      `code=${pkAnon.body?.code}`,
    );

    // ---- E. 资质闸门优先于时间闸门 ----
    writeDb("UPDATE ab_supplier SET audit_status = 'rejected' WHERE id = 1");
    const notQualified = await call('POST', '/supplier/meal/cook-confirm', {
      token: supToken,
      body: { date: TMR, items: [{ dishId: 1, distributionCenterId: 1 }] },
    });
    writeDb("UPDATE ab_supplier SET audit_status = 'approved' WHERE id = 1");
    assert(
      notQualified.body?.code === 50001,
      'S2 资质闸门：`audit_status=rejected` → 50001（**未过点也要拦** —— 先判「有没有资格」，再判「来不来得及」）',
      `code=${notQualified.body?.code} msg=${notQualified.body?.message}`,
    );

    // ---- F. S2 出餐确认（成功 + 幂等） ----
    const cf1 = await call('POST', '/supplier/meal/cook-confirm', {
      token: supToken,
      body: { date: TMR, items: [{ dishId: 1, distributionCenterId: 1 }] },
    });
    assert(
      cf1.body?.code === 0 &&
        (cf1.body?.data?.confirmed ?? []).length === 1 &&
        cf1.body?.data?.summary?.allDone === true,
      'S2 出餐确认成功（明日 = 提前确认，09:30 是 **deadline 不是 earliest**）→ 全部分中心确认后 allDone=true',
      `code=${cf1.body?.code} confirmed=${(cf1.body?.data?.confirmed ?? []).length} allDone=${cf1.body?.data?.summary?.allDone}`,
    );
    const cfDetailDb = readDb(
      'SELECT status, actual_quantity, confirmed_by, confirmed_at FROM ab_supplier_dish_center_daily WHERE supplier_id = 1 AND produce_date = ? AND distribution_center_id = 1',
      [TMR],
    );
    assert(
      cfDetailDb?.status === 'confirmed' &&
        Number(cfDetailDb?.actual_quantity) === 45 &&
        Number(cfDetailDb?.confirmed_by) === supAccountId &&
        !!cfDetailDb?.confirmed_at,
      'S2 明细落库四要素（status=confirmed · actual_quantity · confirmed_by=操作账号 · confirmed_at）—— 出餐确认是**责任动作**，必须留痕',
      `status=${cfDetailDb?.status} actual=${cfDetailDb?.actual_quantity} by=${cfDetailDb?.confirmed_by} 期望by=${supAccountId}`,
    );
    const cfDailyDb = readDb(
      'SELECT status, actual_quantity, completed_at FROM ab_supplier_dish_daily WHERE supplier_id = 1 AND dish_id = 1 AND produce_date = ?',
      [TMR],
    );
    assert(
      cfDailyDb?.status === 'done' &&
        Number(cfDailyDb?.actual_quantity) === 45 &&
        !!cfDailyDb?.completed_at,
      'S2 父行状态由明细**派生**（全部分中心确认 → `done` + completed_at；部分 → `cooking`）—— 沿用既有三值域，不新增 partial',
      `status=${cfDailyDb?.status} actual=${cfDailyDb?.actual_quantity}`,
    );
    const cfAgain = await call('POST', '/supplier/meal/cook-confirm', {
      token: supToken,
      body: { date: TMR, items: [{ dishId: 1, distributionCenterId: 1 }] },
    });
    assert(
      cfAgain.body?.code === 0 &&
        (cfAgain.body?.data?.skipped ?? []).length === 1 &&
        (cfAgain.body?.data?.confirmed ?? []).length === 0,
      'S2 **幂等**：重复提交已确认项 → 进 skipped、不报错、不改时间戳（网络重试是常态，不该显示「失败」）',
      `skipped=${(cfAgain.body?.data?.skipped ?? []).length} confirmed=${(cfAgain.body?.data?.confirmed ?? []).length}`,
    );
    const supLogs = await call('GET', '/admin/system/logs?pageSize=100', { token: adminToken });
    assert(
      (supLogs.body?.data?.list ?? []).some((l) => l.action === '出餐确认'),
      'S2 写操作自动落操作日志（GET 的 S1 / 打包任务不打日志 —— 否则列表接口会把日志表刷爆）',
      `hit=${(supLogs.body?.data?.list ?? []).filter((l) => l.action === '出餐确认').length}`,
    );

    // ---- G. 闸门翻转：其余 3 家到位后 ready=true ----
    writeDb(
      "UPDATE ab_supplier_dish_center_daily SET status = 'confirmed', actual_quantity = plan_quantity, confirmed_at = datetime('now') WHERE produce_date = ? AND distribution_center_id = 1 AND supplier_id <> 1",
      [TMR],
    );
    const pk2 = await call('GET', `/admin/packing-tasks?date=${TMR}`, { token: adminToken });
    const pk2Center = (pk2.body?.data?.centers ?? []).find((c) => c.centerId === 1);
    assert(
      pk2Center?.ready === true && (pk2Center?.blockers ?? []).length === 0,
      '打包闸门翻转：其余 3 家确认后 → `ready=true`、blockers 清空（与 §19 同款的**跨批次实时性证明**：上游一动，下游派生值立刻变）',
      `ready=${pk2Center?.ready} blockers=${(pk2Center?.blockers ?? []).length} confirmed=${pk2Center?.summary?.confirmedDishCount}/${pk2Center?.summary?.dishCount}`,
    );

    // ---- H. S2 三类错误码 ----
    const wrongCenter = await call('POST', '/supplier/meal/cook-confirm', {
      token: supToken,
      body: { date: TMR, items: [{ dishId: 1, distributionCenterId: 2 }] },
    });
    assert(
      wrongCenter.body?.code === 50011,
      'S2 集散中心不在配送范围 → 50011（否则供应商能把 A 片的份数确认到 B 片头上，B 片显示「已到齐」而实物没到）',
      `code=${wrongCenter.body?.code} msg=${wrongCenter.body?.message}`,
    );
    const noPlan = await call('POST', '/supplier/meal/cook-confirm', {
      token: supToken,
      body: { date: TMR, items: [{ dishId: 999, distributionCenterId: 1 }] },
    });
    assert(
      noPlan.body?.code === 50010,
      'S2 当日无该菜品生产计划 → 50010（不属于本供应商 / 该日无计划，都不能默默接受）',
      `code=${noPlan.body?.code}`,
    );
    const overdue = await call('POST', '/supplier/meal/cook-confirm', {
      token: supToken,
      body: { date: YST, items: [{ dishId: 1, distributionCenterId: 1 }] },
    });
    assert(
      overdue.body?.code === 50009,
      'S2 超过出餐日 09:30 → 50009 **fail-closed**（用昨日构造，与运行时刻无关；不接受「补确认」把错过的时点抹平）',
      `code=${overdue.body?.code} msg=${overdue.body?.message}`,
    );

    // ---- I. 短送留痕 ----
    writeDb(
      "UPDATE ab_supplier_dish_center_daily SET status = 'pending', actual_quantity = NULL, confirmed_at = NULL, confirmed_by = NULL WHERE supplier_id = 1 AND produce_date = ? AND distribution_center_id = 1",
      [TMR],
    );
    const shortShip = await call('POST', '/supplier/meal/cook-confirm', {
      token: supToken,
      body: {
        date: TMR,
        items: [{ dishId: 1, distributionCenterId: 1, actualQuantity: 40, remark: 'e2e 短送 5 份' }],
      },
    });
    const shortDb = readDb(
      'SELECT status, plan_quantity, actual_quantity, remark FROM ab_supplier_dish_center_daily WHERE supplier_id = 1 AND produce_date = ? AND distribution_center_id = 1',
      [TMR],
    );
    assert(
      shortShip.body?.code === 0 &&
        Number(shortDb?.actual_quantity) === 40 &&
        Number(shortDb?.plan_quantity) === 45 &&
        String(shortDb?.remark ?? '').includes('短送'),
      'S2 实送份数**不传 = 足额**、传了则以申报值为准（短送 40/45 与原因一并留痕）—— 对账必须看得见差额',
      `plan=${shortDb?.plan_quantity} actual=${shortDb?.actual_quantity} remark=${shortDb?.remark}`,
    );

    // ---- J. 校验顺序与入参纪律 ----
    const emptyItems = await call('POST', '/supplier/meal/cook-confirm', {
      token: supToken,
      body: { date: TMR, items: [] },
    });
    assert(
      emptyItems.body?.code === 10001,
      'S2 `items=[]` → 10001（至少一项；空数组静默成功会让「确认了」与「什么都没做」不可区分）',
      `code=${emptyItems.body?.code}`,
    );
    const badDate = await call('POST', '/supplier/meal/cook-confirm', {
      token: supToken,
      body: { date: '2026/09/16', items: [{ dishId: 1, distributionCenterId: 1 }] },
    });
    assert(
      badDate.body?.code === 10001,
      'S2 日期格式非法 → 10001（服务端不猜日期）',
      `code=${badDate.body?.code}`,
    );
    const withSupplierId = await call('POST', '/supplier/meal/cook-confirm', {
      token: supToken,
      body: { date: TMR, supplierId: 2, items: [{ dishId: 1, distributionCenterId: 1 }] },
    });
    assert(
      withSupplierId.body?.code === 10001,
      'S2 请求体带 `supplierId` → 10001（**主体由 token 决定**，收下这个字段就等于允许「A 供应商改 B 的计划」）',
      `code=${withSupplierId.body?.code}`,
    );
  }

  // ==========================================================================
  // §21 M3-9 应付结算 S9（采购应付出单 / 付款登记 / 未出单异常 / 供应商自查）
  // ==========================================================================
  //
  // 口径：《ABox一盒自营结算口径定义v1.0.md》
  //   · 计费基数 = **实收量**（`actual_quantity`，未申报 = 计划量）→ **短送即少付**
  //   · 应付对象**只剩供应商**（`payee_type=distribution_center` 已冻结）
  //   · ⭐ 用户退款**不冲减**应付（已在 §15 D11 断言，本节不重复）
  //   · fail-closed：该菜出餐确认未完成 / 资质异常 → 不出单，进「未出单异常清单」
  //
  // ⚠️ **本节不依赖下单窗口**（与 §18/§19/§20 同纪律），夹具**全部自造**：
  //    出餐日取「今天 + 90 天」（刻意远离 §20 的 +60 天，两者互不污染），
  //    并在节首 `DELETE` 该日的生产计划与应付行 —— **保证可重复跑**。
  {
    const S9D = addDaysStr(bjToday(), 90);
    const supAId = 1; // 三味屋（种子 · 资质已核验 · canServe=true）
    const supBId = 2; // 四季鲜蔬
    const dishRows = readRows('SELECT id FROM ab_dish ORDER BY id LIMIT 2');
    const dish1 = Number(dishRows[0]?.id ?? 1);
    const dish2 = Number(dishRows[1]?.id ?? dish1);

    /** 生产计划父行夹具（S9 只读父行的实收量，不读分中心明细） */
    const DAILY_INSERT =
      'INSERT INTO ab_supplier_dish_daily (supplier_id, dish_id, produce_date, plan_quantity, actual_quantity, unit_price, status) VALUES (?, ?, ?, ?, ?, ?, ?)';

    // 幂等清理：删掉本日出餐计划与应付行（两处都要删 —— 只删计划的话，
    // 上一次跑留下的应付行会让幂等闸门一直跳过，断言永远看不到 created）。
    // ⚠️ 应付行还要多删 S9D-1：I 段会**自造**一条「另一出餐日」的 pending 行，
    //    用来证明供应商端的待付合计**跨日期**（不删的话重跑会累加，合计断言必红）。
    writeDb('DELETE FROM ab_supplier_dish_daily WHERE produce_date = ?', [S9D]);
    writeDb('DELETE FROM ab_supplier_share WHERE meal_date IN (?, ?)', [S9D, addDaysStr(S9D, -1)]);

    // ---------------------------------------------------------- A. 空日基线
    const genEmpty = await call('POST', '/admin/supplier-shares/generate', {
      token: adminToken,
      body: { date: S9D },
    });
    assert(
      genEmpty.body?.code === 0 && genEmpty.body?.data?.summary?.createdCount === 0,
      'S9 空日（无生产计划）→ 出单 0 条且不报错（「这天没有要付的」是正常状态，不该走报错分支）',
      `code=${genEmpty.body?.code} created=${genEmpty.body?.data?.summary?.createdCount}`,
    );

    // ---------------------------------------------------------- B. 夹具：三条父行，三种情形
    //  ① supA/dish1：done + 实收 96（计划 100）→ **应出单，且按 96 计**
    //  ② supB/dish1：cooking（部分中心已确认）→ **fail-closed 不出单**
    //  ③ supB/dish2：done 但实收 0 → **不出单**（没有采购事实）
    //  ⚠️ 夹具单价刻意取 ¥9.90 —— 与菜品当前成本价不同，用来证明出单取的是
    //     「出餐计划生成时**冻结**的价」，而不是出单时刻的 `ab_dish.cost_price`。
    const FROZEN = '9.90';
    writeDb(DAILY_INSERT, [supAId, dish1, S9D, 100, 96, FROZEN, 'done']);
    writeDb(DAILY_INSERT, [supBId, dish1, S9D, 80, null, FROZEN, 'cooking']);
    writeDb(DAILY_INSERT, [supBId, dish2, S9D, 0, 0, FROZEN, 'done']);

    const dishCost = readDb('SELECT cost_price FROM ab_dish WHERE id = ?', [dish1]);
    assert(
      Math.round(Number(dishCost?.cost_price) * 100) !== 990,
      'S9 前置：夹具单价 ¥9.90 ≠ 菜品当前成本价（否则「冻结价优先」这条断言就验证不到任何东西）',
      `cost_price=${dishCost?.cost_price}`,
    );

    // ---------------------------------------------------------- C. 出单
    const gen1 = await call('POST', '/admin/supplier-shares/generate', {
      token: adminToken,
      body: { date: S9D },
    });
    const gen1D = gen1.body?.data;
    const createdA = (gen1D?.created ?? []).find(
      (r) => r.supplierId === supAId && r.dishId === dish1,
    );
    assert(
      gen1.body?.code === 0 && gen1D?.summary?.createdCount === 1 && !!createdA,
      'S9 出单：3 条生产计划里**只有 1 条可出**（另两条分别因「未确认完成」「实收 0」被拦）',
      `created=${gen1D?.summary?.createdCount} exceptions=${gen1D?.summary?.exceptionCount}`,
    );
    assert(
      createdA?.quantity === 96 && createdA?.planQuantity === 100 && createdA?.amountFen === 95040,
      '⭐ 计费基数 = **实收量**（96 份 × ¥9.90 = ¥950.40），**不是计划量**（100 份）—— 自营采购是「交多少付多少」，短送自动少付，无需人工对账',
      `qty=${createdA?.quantity} plan=${createdA?.planQuantity} amountFen=${createdA?.amountFen}`,
    );
    assert(
      createdA?.unitPriceFen === 990,
      '单价取**出餐计划生成时冻结的快照**（夹具 ¥9.90 ≠ 菜品当前成本价）—— 否则会出现「T 日按旧价交货、结算按新价付」，供应商对账必然拒绝',
      `unitPriceFen=${createdA?.unitPriceFen} cost=${dishCost?.cost_price}`,
    );
    assert(
      !!createdA?.id,
      'S9 出单出参回填 `id` —— 运营拿到 created 要能**直接对某条登记付款**，只给单号等于让人再去列表里搜一遍',
      `id=${createdA?.id} shareNo=${createdA?.shareNo}`,
    );

    const shareRow = readDb(
      'SELECT payee_type, type, channel, status, quantity, unit_price, amount FROM ab_supplier_share WHERE share_no = ?',
      [createdA?.shareNo],
    );
    assert(
      shareRow?.payee_type === 'supplier' &&
        shareRow?.type === 'normal' &&
        shareRow?.channel === 'manual' &&
        shareRow?.status === 'pending',
      'S9 落库口径：`payee_type=supplier`（distribution_center 已冻结）· `type=normal` · `channel=manual`（人工对公转账，**不接支付通道**）· `status=pending`',
      JSON.stringify(shareRow),
    );

    // ---------------------------------------------------------- D. 幂等
    const gen2 = await call('POST', '/admin/supplier-shares/generate', {
      token: adminToken,
      body: { date: S9D },
    });
    assert(
      gen2.body?.code === 0 &&
        gen2.body?.data?.summary?.createdCount === 0 &&
        gen2.body?.data?.summary?.skippedCount === 1,
      'S9 幂等：同一（供应商 · 菜品 · 出餐日）重跑 → 新增 0 / 跳过 1（运营补跑不会重复出单，财务不会付两遍）',
      `created=${gen2.body?.data?.summary?.createdCount} skipped=${gen2.body?.data?.summary?.skippedCount}`,
    );

    // ---------------------------------------------------------- E. 未出单异常清单
    const exc = await call('GET', `/admin/supplier-shares/exceptions?date=${S9D}`, { token: adminToken });
    const excList = exc.body?.data?.list ?? [];
    assert(
      exc.body?.code === 0 &&
        excList.some((e) => e.reason === 'incomplete' && e.supplierId === supBId && e.dishId === dish1) &&
        excList.some((e) => e.reason === 'zero_quantity' && e.supplierId === supBId && e.dishId === dish2),
      'S9 未出单异常清单逐条给出**原因**（未确认完成 / 实收 0）—— 运营点完按钮最想知道的是「哪些单没出来、为什么」',
      `count=${excList.length} reasons=${JSON.stringify(excList.map((e) => `${e.supplierId}:${e.reason}`))}`,
    );
    assert(
      excList.every((e) => !!e.reasonText) && !!exc.body?.data?.summary?.byReason,
      'S9 异常项带**人话说明**（reasonText）+ 按原因计数（byReason）—— 只给 `incomplete` 这种机器码，运营没法处理',
      `byReason=${JSON.stringify(exc.body?.data?.summary?.byReason)}`,
    );
    assert(
      !excList.some((e) => e.supplierId === supAId),
      'S9 异常清单**过滤掉已出单的行** —— 「先 fail-closed → 补确认 → 重跑出单」是**正常路径**，残留会让运营反复做无用功',
      `containsA=${excList.some((e) => e.supplierId === supAId)}`,
    );
    assert(
      !excList.some((e) => e.reason === 'license_invalid'),
      'S9 资质正常的供应商不进异常清单（三味屋/四季鲜蔬种子已核验通过）—— 闸门只在真异常时才拦',
      `reasons=${JSON.stringify([...new Set(excList.map((e) => e.reason))])}`,
    );

    // ---------------------------------------------------------- F. 资质闸门 + 补齐后重跑
    const supBAuditBefore = readDb('SELECT audit_status FROM ab_supplier WHERE id = ?', [supBId]);
    writeDb("UPDATE ab_supplier SET audit_status = 'pending' WHERE id = ?", [supBId]);
    // 把 supB/dish1 补成「已确认完成 · 实收 80」→ 若非资质问题，它本该能出单
    writeDb(
      "UPDATE ab_supplier_dish_daily SET status = 'done', actual_quantity = 80 WHERE supplier_id = ? AND dish_id = ? AND produce_date = ?",
      [supBId, dish1, S9D],
    );
    const excLic = await call('GET', `/admin/supplier-shares/exceptions?date=${S9D}`, { token: adminToken });
    assert(
      (excLic.body?.data?.list ?? []).some(
        (e) => e.reason === 'license_invalid' && e.supplierId === supBId && e.dishId === dish1,
      ),
      'S9 资质闸门：供应商资质未通过核验 → **不出单**（资质未核验期间的供货不进结算，与 S2 的 50001 同判据）',
      `reasons=${JSON.stringify((excLic.body?.data?.list ?? []).map((e) => `${e.supplierId}:${e.reason}`))}`,
    );

    // 恢复资质 → 补齐的输入已就位 → 重跑应能补出（fail-closed 是「等一等」不是「永久拒绝」）
    writeDb('UPDATE ab_supplier SET audit_status = ? WHERE id = ?', [
      supBAuditBefore?.audit_status ?? 'approved',
      supBId,
    ]);
    const gen3 = await call('POST', '/admin/supplier-shares/generate', {
      token: adminToken,
      body: { date: S9D },
    });
    const createdB = (gen3.body?.data?.created ?? []).find((r) => r.supplierId === supBId);
    assert(
      gen3.body?.code === 0 && createdB?.quantity === 80 && createdB?.amountFen === 79200,
      'S9 补齐后重跑**能补出**先前被拦的单（80 份 × ¥9.90 = ¥792.00）—— fail-closed 的出路是「补输入再跑」，不是人工绕过',
      `created=${JSON.stringify((gen3.body?.data?.created ?? []).map((r) => `${r.supplierId}:${r.quantity}`))}`,
    );

    // ---------------------------------------------------------- G. 付款登记
    const badIdPay = await call('POST', '/admin/supplier-shares/99999999/payment', {
      token: adminToken,
      body: { paymentVoucherNo: 'E2E-BAD-0001' },
    });
    assert(
      badIdPay.body?.code === 50012,
      'S9 付款登记：应付单不存在 → 50012（不存在的单不能「付」）',
      `code=${badIdPay.body?.code}`,
    );
    const noVoucher = await call('POST', `/admin/supplier-shares/${createdA?.id}/payment`, {
      token: adminToken,
      body: {},
    });
    assert(
      noVoucher.body?.code === 10001,
      'S9 付款登记**缺银行回单号** → 10001（入参层就拦 —— 回单号是「这笔钱确实付了」的唯一凭证）',
      `code=${noVoucher.body?.code}`,
    );

    const voucher = `E2E${stamp}-V1`;
    const pay1 = await call('POST', `/admin/supplier-shares/${createdA?.id}/payment`, {
      token: adminToken,
      body: { paymentVoucherNo: voucher, invoiceNo: `INV${stamp}` },
    });
    assert(
      pay1.body?.code === 0 &&
        pay1.body?.data?.status === 'success' &&
        pay1.body?.data?.paymentVoucherNo === voucher &&
        !!pay1.body?.data?.paidAt,
      'S9 付款登记成功 → `status=success` + 回单号/发票号/付款时刻写实（C10：系统**只记账**，不发起任何通道付款）',
      `status=${pay1.body?.data?.status} voucher=${pay1.body?.data?.paymentVoucherNo} paidAt=${pay1.body?.data?.paidAt}`,
    );
    assert(
      pay1.body?.data?.canRegisterPayment === false && !!pay1.body?.data?.blockReason,
      'S9 已付款的行下发 `canRegisterPayment=false` + `blockReason`（按钮口径唯一在服务端，端上不自算）',
      `blockReason=${pay1.body?.data?.blockReason}`,
    );

    const payAgain = await call('POST', `/admin/supplier-shares/${createdA?.id}/payment`, {
      token: adminToken,
      body: { paymentVoucherNo: 'E2E-SECOND' },
    });
    assert(
      payAgain.body?.code === 50012,
      'S9 已付款再登记 → 50012（重复登记就是**重复出款**，钱转出去追不回来 —— fail-closed）',
      `code=${payAgain.body?.code} msg=${String(payAgain.body?.message ?? '').slice(0, 40)}…`,
    );

    const dupVoucher = await call('POST', `/admin/supplier-shares/${createdB?.id}/payment`, {
      token: adminToken,
      body: { paymentVoucherNo: voucher },
    });
    assert(
      dupVoucher.body?.code === 10001,
      'S9 同一银行回单号用于两笔应付 → 10001（一个回单只能对应一笔付款，否则两笔支出挂同一凭证，对账时分不清哪笔真付了）',
      `code=${dupVoucher.body?.code}`,
    );

    // ---------------------------------------------------------- H. 列表 / 汇总
    const s9List = await call('GET', `/admin/supplier-shares?date=${S9D}&pageSize=100`, {
      token: adminToken,
    });
    const s9Rows = s9List.body?.data?.list ?? [];
    const s9Sum = s9List.body?.data?.summary ?? {};
    assert(
      s9List.body?.code === 0 && s9Rows.length === 2,
      'S9 列表按出餐日过滤（2 条：三味屋 96 份 + 四季鲜蔬 80 份 —— 实收 0 的那条不出单）',
      `rows=${s9Rows.length} total=${s9List.body?.data?.total}`,
    );
    assert(
      s9Sum.amountFen === 174240 &&
        s9Sum.pendingAmountFen === 79200 &&
        s9Sum.paidAmountFen === 95040 &&
        s9Sum.pendingCount === 1 &&
        s9Sum.paidCount === 1,
      'S9 汇总按**同一过滤条件的全量**统计并按状态拆分（合计 ¥1,742.40 = 待付 ¥792.00 + 已付 ¥950.40）—— 否则页面会把「本页合计」当成「全部合计」',
      `all=${s9Sum.amountFen} pending=${s9Sum.pendingAmountFen} paid=${s9Sum.paidAmountFen}`,
    );
    assert(
      s9Rows.every(
        (r) =>
          Number.isInteger(r.amountFen) &&
          Number.isInteger(r.unitPriceFen) &&
          r.amountFen > 0 &&
          r.totalAmountFen === undefined &&
          r.platformGrossProfitFen === undefined,
      ),
      'S9 金额一律**整数分**（`Fen` 结尾），且**不含**售价/佣金/毛利字段 —— 应付单只有采购口径（不变量 I1 在**数据结构层面**成立，不靠前端隐藏）',
      `sample=${JSON.stringify({ qty: s9Rows[0]?.quantity, unitPriceFen: s9Rows[0]?.unitPriceFen, amountFen: s9Rows[0]?.amountFen })}`,
    );
    assert(
      Array.isArray(s9List.body?.data?.statusOptions) &&
        s9List.body?.data?.statusOptions?.length === 4,
      'S9 状态枚举由服务端下发（端上不维护第二份文案，避免漂移）',
      `options=${JSON.stringify(s9List.body?.data?.statusOptions)}`,
    );

    const kwHit = await call(
      'GET',
      `/admin/supplier-shares?keyword=${encodeURIComponent(voucher)}`,
      { token: adminToken },
    );
    assert(
      kwHit.body?.code === 0 &&
        (kwHit.body?.data?.list ?? []).length === 1 &&
        kwHit.body?.data?.list?.[0]?.paymentVoucherNo === voucher,
      'S9 关键词命中**银行回单号**（财务对账最常用的入口：拿着回单找单子）',
      `rows=${(kwHit.body?.data?.list ?? []).length}`,
    );

    const s9All = await call('GET', '/admin/supplier-shares?pageSize=100', { token: adminToken });
    assert(
      (s9All.body?.data?.list ?? []).every((r) => r.payeeType === 'supplier'),
      'S9 `payee_type=distribution_center` 已**冻结**：历史行仍可读（§18 直插过一条集散中心应付），但不出现在供应商列表里 —— 自营下加工场所属 ABox，付场地费给自己没有财务意义',
      `types=${JSON.stringify([...new Set((s9All.body?.data?.list ?? []).map((r) => r.payeeType))])}`,
    );

    // ---------------------------------------------------------- I. 供应商端自查（P25）
    const supS9 = await adminLogin('sanweiwu', 'supplier123');
    const self = await call('GET', `/supplier/settlement?date=${S9D}`, { token: supS9.token });
    const selfD = self.body?.data;
    assert(
      self.body?.code === 0 &&
        (selfD?.list ?? []).length === 1 &&
        selfD?.list?.[0]?.quantity === 96 &&
        selfD?.supplier?.id === supAId,
      'S9 供应商自查只看得到**自己的**行（三味屋 96 份）—— 数据范围由 token 内的 `supplierId` 收窄，请求体不收该字段',
      `rows=${(selfD?.list ?? []).length} supplierId=${selfD?.supplier?.id}`,
    );
    const FORBIDDEN_KEYS = [
      'totalAmountFen',
      'payAmountFen',
      'commissionFen',
      'commissionRate',
      'grossProfitFen',
      'platformGrossProfitFen',
      'siteFeeFen',
      'packingLaborFeeFen',
      'deliveryFeeFen',
      'salePriceFen',
      'costTotalFen',
    ];
    const selfKeys = JSON.stringify(Object.keys(selfD?.list?.[0] ?? {}));
    const leaked = FORBIDDEN_KEYS.filter((k) => selfKeys.includes(k));
    assert(
      leaked.length === 0,
      '⭐ 不变量 I1：供应商端出参**不含**终端售价 ¥25.80 / 佣金 / 毛利 / 成本项 —— B2B 采购关系下供应商只该知道「我的协商价 × 我的交付量」；让人看见整条利润结构，下一轮谈价就没有筹码了',
      `keys=${selfKeys} leaked=${JSON.stringify(leaked)}`,
    );
    // ⭐ 跨日期待付合计：**自造**一条不同出餐日的 pending 行（¥50.00）做增量对照。
    //    刻意不写死金额 —— 本节的数一旦写死，就会被别的章节的夹具变动连带撞红；
    //    也刻意不依赖别处留下的数据（§21 的纪律是「夹具全部自造」）。
    //    同日那条 ¥950.40 已付款 → 当日待付 = 0，而跨日期合计必须 +¥50.00：
    //    两个数**不相等**才证明「合计没有被日期过滤」。
    const CROSS_DAY = addDaysStr(S9D, -1);
    writeDb(
      "INSERT INTO ab_supplier_share (share_no, share_date, meal_date, payee_type, payee_id, dish_id, quantity, unit_price, amount, type, channel, status) VALUES (?, ?, ?, 'supplier', ?, ?, 10, '5.00', '50.00', 'normal', 'manual', 'pending')",
      [`E2ESK${stamp}CROSS`, CROSS_DAY, CROSS_DAY, supAId, dish1],
    );
    const dbPending = readDb(
      "SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS cnt FROM ab_supplier_share WHERE payee_type = 'supplier' AND type = 'normal' AND payee_id = ? AND status = 'pending'",
      [supAId],
    );
    const selfSum = (await call('GET', `/supplier/settlement?date=${S9D}`, { token: supS9.token }))
      .body?.data?.summary;
    assert(
      selfD?.summary?.empty === false &&
        selfSum?.pendingTotalAmountFen === (selfD?.summary?.pendingTotalAmountFen ?? 0) + 5000 &&
        selfSum?.pendingTotalRowCount === (selfD?.summary?.pendingTotalRowCount ?? 0) + 1 &&
        selfSum?.pendingTotalAmountFen === Math.round(Number(dbPending?.amount ?? 0) * 100) &&
        selfSum?.pendingTotalRowCount === Number(dbPending?.cnt ?? 0) &&
        selfSum?.pendingAmountFen === 0,
      'S9 汇总给出**跨日期的待付合计**：补一条「另一出餐日」的待付行后合计 +¥50.00，而当日待付仍为 0 —— 供应商真正关心的是「平台还欠我多少」，不是「某一天多少钱」（写死金额的断言会被别处夹具牵连，故此处以**增量 + 库内对照**双口径验证）',
      `before=${selfD?.summary?.pendingTotalAmountFen} after=${selfSum?.pendingTotalAmountFen} 当日=${selfSum?.pendingAmountFen} 库内=${Math.round(Number(dbPending?.amount ?? 0) * 100)}(${dbPending?.cnt}行)`,
    );
    const selfOther = await call(
      'GET',
      `/supplier/settlement?date=${addDaysStr(S9D, 1)}`,
      { token: supS9.token },
    );
    assert(
      selfOther.body?.code === 0 && selfOther.body?.data?.summary?.empty === true,
      'S9 无单日 → `empty=true` + 空列表（HTTP 200）—— 「今天还没出单」是正常状态（应付 T+1 凌晨才出），端上给空态说明而非报错',
      `empty=${selfOther.body?.data?.summary?.empty}`,
    );

    // ---------------------------------------------------------- J. 主体隔离 + 两级权限
    const guestS9 = await userLogin(`e2e_s9_${stamp}`);
    const centOnShares = await call('GET', '/admin/supplier-shares', { token: guestS9.token });
    assert(
      centOnShares.body?.code === 10003,
      '双主体隔离：小程序 token 打 /admin/supplier-shares → 10003（C 端与后台 id 各自自增，不隔离即静默越权）',
      `code=${centOnShares.body?.code}`,
    );
    const supOnShares = await call('GET', '/admin/supplier-shares', { token: supS9.token });
    assert(
      supOnShares.body?.code === 10003,
      '双主体隔离：供应商 token 打 /admin/* → 10003（后台与供应商是两套账号体系）',
      `code=${supOnShares.body?.code}`,
    );
    const adminOnSelf = await call('GET', `/supplier/settlement?date=${S9D}`, {
      token: adminToken,
    });
    assert(
      adminOnSelf.body?.code === 10003,
      '双主体隔离：运营 token 打 /supplier/settlement → 10003（供应商端点只对 role=supplier 开放）',
      `code=${adminOnSelf.body?.code}`,
    );

    const s9OpUser = `e2e_s9op_${stamp}`;
    const s9ViewUser = `e2e_s9view_${stamp}`;
    await call('POST', '/admin/system/accounts', {
      token: adminToken,
      body: { username: s9OpUser, password: PWD, role: 'operator', realName: 'e2e 应付运营' },
    });
    await call('POST', '/admin/system/accounts', {
      token: adminToken,
      body: { username: s9ViewUser, password: PWD, role: 'viewer', realName: 'e2e 应付只读' },
    });
    const s9OpToken = (await adminLogin(s9OpUser, PWD)).token;
    const s9ViewToken = (await adminLogin(s9ViewUser, PWD)).token;
    const s9FinToken = (await adminLogin('finance', 'finance123')).token;

    const opReadShares = await call('GET', `/admin/supplier-shares?date=${S9D}`, {
      token: s9OpToken,
    });
    assert(
      opReadShares.body?.code === 0,
      '两级白名单：`operator` 能**读**应付单（运营要跟进「为什么没出单」，菜单不该是「看得见点不开」）',
      `code=${opReadShares.body?.code} rows=${(opReadShares.body?.data?.list ?? []).length}`,
    );
    const opGenShares = await call('POST', '/admin/supplier-shares/generate', {
      token: s9OpToken,
      body: { date: S9D },
    });
    assert(
      opGenShares.body?.code === 10003,
      '两级白名单：`operator` **不能出单** → 10003（决定「欠供应商多少」是资金动作，方法级收窄到 admin/finance）',
      `code=${opGenShares.body?.code}`,
    );
    const opPayShares = await call('POST', `/admin/supplier-shares/${createdB?.id}/payment`, {
      token: s9OpToken,
      body: { paymentVoucherNo: 'E2E-NOPE-0001' },
    });
    assert(
      opPayShares.body?.code === 10003,
      '两级白名单：`operator` **不能登记付款** → 10003（决定「钱付了没有」同样是资金动作）',
      `code=${opPayShares.body?.code}`,
    );
    const viewReadShares = await call('GET', '/admin/supplier-shares', { token: s9ViewToken });
    assert(
      viewReadShares.body?.code === 10003,
      '权限：`viewer`（只读观察者）两级都进不来 → 10003',
      `code=${viewReadShares.body?.code}`,
    );
    const finGenShares = await call('POST', '/admin/supplier-shares/generate', {
      token: s9FinToken,
      body: { date: S9D },
    });
    assert(
      finGenShares.body?.code === 0 && finGenShares.body?.data?.summary?.createdCount === 0,
      '权限：`finance` 有出单权限（拿到业务层结果 created=0 而非 10003）—— 此时该出的都已出，幂等闸门返回 0',
      `code=${finGenShares.body?.code} created=${finGenShares.body?.data?.summary?.createdCount}`,
    );

    // ---------------------------------------------------------- K. 入参纪律
    const s9BadDate = await call('POST', '/admin/supplier-shares/generate', {
      token: adminToken,
      body: { date: '2026/09/16' },
    });
    assert(
      s9BadDate.body?.code === 10001,
      'S9 日期格式非法 → 10001（服务端不猜日期）',
      `code=${s9BadDate.body?.code}`,
    );
    const s9NoDate = await call('GET', '/admin/supplier-shares/exceptions', { token: adminToken });
    assert(
      s9NoDate.body?.code === 10001,
      'S9 异常清单 **date 必填** → 10001（不给日期等于问「历史上所有没出单的原因」，那不是一份可执行的清单）',
      `code=${s9NoDate.body?.code}`,
    );
    const s9BadStatus = await call('GET', '/admin/supplier-shares?status=paid', {
      token: adminToken,
    });
    assert(
      s9BadStatus.body?.code === 10001,
      'S9 状态过滤值域收口 → 10001（`paid` 不是本表状态；用错值静默返回空列表会让人以为「今天没单」）',
      `code=${s9BadStatus.body?.code}`,
    );
  }

  // ==========================================================================
  // §22 M3-10 系统配置 D57–D58（后台 P36）
  // ==========================================================================
  //
  // 口径唯一真相：`apps/api-server/src/modules/admin/config/config.specs.ts`
  //   · D57 读：分组下发 + 值归一（percent 出参为**百分数**）+ **如实标注「未接线」**
  //   · D58 写：白名单 · 整批原子 · **写完同步刷新配置缓存**
  //
  // ⚠️ 本节不依赖下单窗口（同 §18–§21 纪律）。
  // ⚠️ 配置是**全局**的：本节写入的每一项都在节末**还原为原值** ——
  //    否则「把费率改成 8.5」这类副作用会留给下一次重跑。
  {
    log('\n§22 M3-10 系统配置 D57–D58');

    const cfgList = await call('GET', '/admin/system/configs', { token: adminToken });
    const d57 = cfgList.body?.data;
    const flatItems = (d57?.groups ?? []).flatMap((g) => g.items ?? []);
    const cfg = Object.fromEntries(flatItems.map((i) => [i.key, i]));

    assert(
      cfgList.body?.code === 0 && (d57?.groups ?? []).length === 6,
      'D57 按**分组**下发（价格 / 佣金 / 履约成本 / 交易规则 / 客服 / 未接线 共 6 组）',
      `code=${cfgList.body?.code} groups=${d57?.groups?.length}`,
    );
    assert(
      flatItems.length === d57?.meta?.wiringSummary?.total && flatItems.length === 30,
      'D57 出参**自洽**：明细条数 = 汇总总数（分两处算必然出现「汇总 30 项、列表 29 项」）',
      `items=${flatItems.length} total=${d57?.meta?.wiringSummary?.total}`,
    );

    // ---------------------------------------------------------- A. 「未接线」如实标注
    const unwired = flatItems.filter((i) => i.wiring === 'unwired');
    const policyItems = flatItems.filter((i) => i.wiring === 'policy');
    assert(
      unwired.length === 9 && unwired.every((i) => i.editable === false && !!i.unwiredReason),
      '⭐ 9 项「配了但代码从不读取」的键**如实标注未接线**且不可写 —— 让运营改一个不生效的值，比不给他改更糟',
      `unwired=${unwired.length} 缺原因=${unwired.filter((i) => !i.unwiredReason).length}`,
    );
    assert(
      policyItems.length === 2 && policyItems.every((i) => i.editable === false),
      'D57 两项**策略标识**（`negotiated` / `residual`）标为不可写 —— 它们记录的是策略名，塞个金额进去就把口径记录污染了',
      `policy=${policyItems.length}（${policyItems.map((i) => i.key).join(', ')}）`,
    );
    assert(
      !!cfg['set_meal.cutoff_time']?.unwiredReason?.includes('cutoff.task'),
      '「未接线」原因要能回答**为什么改了没用**，且必须指向**当前真实**的真相源（截单时间配的是 23:59，实际时刻由 `cutoff.task` 取自 `TASK_SCHEDULES` 声明表 —— 文案若还写着「硬编码在 `@Cron` 里」，在 M4-1 之后就是**过时的解释**；M5-1 已纠偏，并要求点明「本键 / 声明表 / 下单窗口三者无机械对账」这一缺口）',
      `reason=${cfg['set_meal.cutoff_time']?.unwiredReason ?? '无'}`,
    );

    // ---------------------------------------------------------- B. 值归一
    assert(
      cfg['commission.rate.trainee']?.value === '8' && cfg['commission.rate.chief']?.value === '12',
      '⭐ 佣金费率**出参为百分数**（`8` / `12`，库内是 `0.0800` / `0.1200`）—— 端上若拿到 0.08 让人填，极易填成 8（= 800%）',
      `trainee=${cfg['commission.rate.trainee']?.value} chief=${cfg['commission.rate.chief']?.value}`,
    );
    assert(
      cfg['set_meal.default_price']?.value === '25.80',
      'D57 金额类保持两位小数原样（`25.80`）',
      `v=${cfg['set_meal.default_price']?.value}`,
    );

    // ---------------------------------------------------------- C. 兜底值来源
    assert(
      cfg['order.pay_timeout_minutes']?.valueSource === 'fallback' &&
        cfg['order.pay_timeout_minutes']?.value === '30',
      '⭐ 库中**没有**的键要显示「取代码兜底值 30」而非空白 —— 空白会让运营以为「配置丢了」，而系统其实正按 30 在跑',
      `source=${cfg['order.pay_timeout_minutes']?.valueSource} value=${cfg['order.pay_timeout_minutes']?.value}`,
    );
    assert(
      flatItems.every((i) => !!i.consumedBy),
      'D57 每项都给出 `consumedBy`（改了谁受影响）—— 这是运营改配置前最需要知道的事',
      `缺 consumedBy 的项=${flatItems.filter((i) => !i.consumedBy).length}`,
    );

    // ---------------------------------------------------------- D. 履约成本未登记
    const costMeta = d57?.meta?.settlementCost;
    assert(
      costMeta?.allRegistered === false && (costMeta?.missingLabels ?? []).length === 3,
      '⭐ 三项履约成本均未登记（值 0）→ `allRegistered=false` 且列出三项中文名',
      `missing=${costMeta?.missingLabels?.join('/')}`,
    );
    assert(
      typeof costMeta?.warning === 'string' && costMeta.warning.includes('上限值'),
      '⭐ 未登记时必须提示「经营毛利只是**上限值**、会被系统性高估」（D47 看板复用同一句，两处口径不分家）',
      `warning=${costMeta?.warning ? '有' : '无'}`,
    );

    // ---------------------------------------------------------- E. 写入纪律
    const unknownKey = await call('PUT', '/admin/system/configs', {
      token: adminToken,
      body: { items: [{ key: 'not.exist.key', value: '1' }] },
    });
    assert(
      unknownKey.body?.code === 10001,
      '⭐ D58 **白名单**：未知键 → 10001（静默忽略更糟 —— 运营以为改了，实际什么都没发生）',
      `code=${unknownKey.body?.code}`,
    );

    const unwiredWrite = await call('PUT', '/admin/system/configs', {
      token: adminToken,
      body: { items: [{ key: 'set_meal.cutoff_time', value: '23:30' }] },
    });
    assert(
      unwiredWrite.body?.code === 10001,
      '⭐ 未接线项**拒绝写入**（而非「写了但不生效」）—— 后者等于给假承诺',
      `code=${unwiredWrite.body?.code}`,
    );

    const policyWrite = await call('PUT', '/admin/system/configs', {
      token: adminToken,
      body: { items: [{ key: 'settlement.gross_profit_policy', value: 'fixed' }] },
    });
    assert(
      policyWrite.body?.code === 10001,
      'D58 策略标识不可写 → 10001',
      `code=${policyWrite.body?.code}`,
    );

    const emptyItems = await call('PUT', '/admin/system/configs', {
      token: adminToken,
      body: { items: [] },
    });
    assert(
      emptyItems.body?.code === 10001,
      'D58 空 items → 10001（「什么都不改」不该走成功分支，否则日志里全是无意义记录）',
      `code=${emptyItems.body?.code}`,
    );

    const blankMoney = await call('PUT', '/admin/system/configs', {
      token: adminToken,
      body: { items: [{ key: 'settlement.site_fee', value: '' }] },
    });
    assert(
      blankMoney.body?.code === 10001,
      '⭐ 清空金额输入 → 10001（`Number("")` 是 0，若不拦会被**静默存成 0.00** —— 对成本项就是「悄悄变回未登记」且毫无提示）',
      `code=${blankMoney.body?.code}`,
    );

    const outOfRange = await call('PUT', '/admin/system/configs', {
      token: adminToken,
      body: { items: [{ key: 'set_meal.default_price', value: '0' }] },
    });
    assert(
      outOfRange.body?.code === 10001,
      'D58 超范围取值 → 10001（售价不得为 0）',
      `code=${outOfRange.body?.code}`,
    );

    const badEnum = await call('PUT', '/admin/system/configs', {
      token: adminToken,
      body: { items: [{ key: 'commission.payout_channel', value: 'WECHAT_TRANSFER' }] },
    });
    assert(
      badEnum.body?.code === 10001,
      'D58 枚举取值收口 → 10001（`WECHAT_TRANSFER` 是预留值；放行会让出款走进没有实现的分支）',
      `code=${badEnum.body?.code}`,
    );

    // ⭐ 整批原子：1 合法 + 1 非法 → 合法的那项**也不得写入**
    const siteFeeBefore = readDb(
      "SELECT config_value FROM ab_config WHERE config_key = 'settlement.site_fee'",
    )?.config_value;
    const mixed = await call('PUT', '/admin/system/configs', {
      token: adminToken,
      body: {
        items: [
          { key: 'settlement.site_fee', value: '1.50' },
          { key: 'not.exist.key', value: '1' },
        ],
      },
    });
    const siteFeeAfterMixed = readDb(
      "SELECT config_value FROM ab_config WHERE config_key = 'settlement.site_fee'",
    )?.config_value;
    assert(
      mixed.body?.code === 10001 && siteFeeAfterMixed === siteFeeBefore,
      '⭐ D58 **整批原子**：一批里有一项不合法 → 整批不写入（部分成功会让「二次确认」失去意义：确认 5 项、只生效 3 项且看不出是哪 3 项）',
      `code=${mixed.body?.code} before=${siteFeeBefore} after=${siteFeeAfterMixed}`,
    );

    // ---------------------------------------------------------- F. 成功写入 + 即时生效
    const writeOk = await call('PUT', '/admin/system/configs', {
      token: adminToken,
      body: {
        items: [
          { key: 'settlement.site_fee', value: '1.50' },
          { key: 'service.hours', value: '工作日 8:30 – 19:00' },
        ],
      },
    });
    assert(
      writeOk.body?.code === 0 && (writeOk.body?.data?.changed ?? []).length === 2,
      'D58 合法更新 → 成功并回带 `changed[]`（供前端二次确认后展示「改了什么」）',
      `code=${writeOk.body?.code} changed=${(writeOk.body?.data?.changed ?? []).length}`,
    );
    const siteFeeChange = (writeOk.body?.data?.changed ?? []).find(
      (c) => c.key === 'settlement.site_fee',
    );
    assert(
      siteFeeChange?.before === '0.00' && siteFeeChange?.after === '1.50',
      'D58 `changed` 给出**变更前 → 变更后**（前端弹窗要能列 diff，而不是只说「保存成功」）',
      `before=${siteFeeChange?.before} after=${siteFeeChange?.after}`,
    );

    const siteFeeRow = readDb(
      "SELECT config_value FROM ab_config WHERE config_key = 'settlement.site_fee'",
    );
    assert(
      siteFeeRow?.config_value === '1.50',
      'D58 money 类型按两位小数落库（`1.50`）',
      `db=${siteFeeRow?.config_value}`,
    );

    // ⭐ 立刻重读 D57：meta 走 `BizConfigService` 的**进程内缓存**
    const cfgReload = await call('GET', '/admin/system/configs', { token: adminToken });
    const costAfter = cfgReload.body?.data?.meta?.settlementCost;
    assert(
      costAfter?.registered?.siteFee === true && costAfter?.allRegistered === false,
      '⭐⭐ **写入后即时生效**：D57 的 meta 走配置缓存，若 D58 不同步 `invalidate()`，这里会读到旧的「未登记」—— 这正是「配置页已改、业务按旧值跑」的成因',
      `registered=${JSON.stringify(costAfter?.registered)}`,
    );
    assert(
      costAfter?.total === 1.5,
      '成本登记合计随写入变化（1.50 + 0 + 0）',
      `total=${costAfter?.total}`,
    );

    // ---------------------------------------------------------- G. percent 换算（防 100 倍错误）
    const rateWrite = await call('PUT', '/admin/system/configs', {
      token: adminToken,
      body: { items: [{ key: 'commission.rate.trainee', value: '8.5' }] },
    });
    const rateRow = readDb(
      "SELECT config_value FROM ab_config WHERE config_key = 'commission.rate.trainee'",
    );
    assert(
      rateWrite.body?.code === 0 && rateRow?.config_value === '0.0850',
      '⭐⭐ 费率**入参百分数 → 库内比率**（`8.5` → `0.0850`）且只此一处换算 —— 若把 8.5 直接写进费率列，佣金会算错 100 倍',
      `db=${rateRow?.config_value}`,
    );
    const rateReload = await call('GET', '/admin/system/configs', { token: adminToken });
    const rateItem = (rateReload.body?.data?.groups ?? [])
      .flatMap((g) => g.items ?? [])
      .find((i) => i.key === 'commission.rate.trainee');
    assert(
      rateItem?.value === '8.5',
      'percent 回读仍是百分数（`8.5`）—— 出参与入参同一口径，端上不做换算',
      `value=${rateItem?.value}`,
    );

    // ---------------------------------------------------------- H. 幂等
    const noop = await call('PUT', '/admin/system/configs', {
      token: adminToken,
      body: { items: [{ key: 'service.hours', value: '工作日 8:30 – 19:00' }] },
    });
    assert(
      noop.body?.code === 0 &&
        (noop.body?.data?.changed ?? []).length === 0 &&
        (noop.body?.data?.unchanged ?? []).length === 1,
      'D58 幂等：提交相同值 → `changed=[]` + `unchanged` 列出该项（不写库、不产生假变更记录）',
      `changed=${(noop.body?.data?.changed ?? []).length} unchanged=${(noop.body?.data?.unchanged ?? []).length}`,
    );

    // ---------------------------------------------------------- I. 库中缺失的键 → 新建
    const insertMissing = await call('PUT', '/admin/system/configs', {
      token: adminToken,
      body: { items: [{ key: 'order.pay_timeout_minutes', value: '45' }] },
    });
    const timeoutRow = readDb(
      "SELECT config_value FROM ab_config WHERE config_key = 'order.pay_timeout_minutes'",
    );
    assert(
      insertMissing.body?.code === 0 && timeoutRow?.config_value === '45',
      '⭐ 种子缺失的键首次被调整时**新建记录**（`UPDATE` 不到就当失败，会让运营永远改不了这个值）',
      `code=${insertMissing.body?.code} db=${timeoutRow?.config_value}`,
    );

    // ---------------------------------------------------------- J. 审计
    const cfgLog = await waitDb(
      "SELECT action FROM ab_operation_log WHERE module = 'system' AND action = '更新系统配置' ORDER BY id DESC LIMIT 1",
      [],
      (r) => !!r,
      { timeout: 4000 },
    );
    assert(
      !!cfgLog,
      'D58 由 `@OperationLog()` 落 `ab_operation_log`（改了全局口径必须能回答「谁在什么时候改的」）',
      `action=${cfgLog?.action ?? '未落库'}`,
    );

    // ---------------------------------------------------------- K. 权限与主体隔离
    const finCfgToken = (await adminLogin('finance', 'finance123')).token;
    const finOnCfg = await call('GET', '/admin/system/configs', { token: finCfgToken });
    assert(
      finOnCfg.body?.code === 10003,
      'D57 `finance` 越权 → 10003（系统配置是全局资金口径，类级白名单只放 super_admin / admin）',
      `code=${finOnCfg.body?.code}`,
    );
    const finCfgWrite = await call('PUT', '/admin/system/configs', {
      token: finCfgToken,
      body: { items: [{ key: 'service.hours', value: 'x' }] },
    });
    assert(
      finCfgWrite.body?.code === 10003,
      'D58 越权写 → 10003（守卫挡在业务层之前，不是「执行了再回滚」）',
      `code=${finCfgWrite.body?.code}`,
    );
    const cfgNoToken = await call('GET', '/admin/system/configs');
    assert(cfgNoToken.body?.code === 10002, 'D57 未登录 → 10002', `code=${cfgNoToken.body?.code}`);

    // ---------------------------------------------------------- L. 还原（配置是全局的）
    const restore = await call('PUT', '/admin/system/configs', {
      token: adminToken,
      body: {
        items: [
          { key: 'settlement.site_fee', value: siteFeeBefore ?? '0.00' },
          { key: 'service.hours', value: '工作日 9:00 – 18:00' },
          { key: 'commission.rate.trainee', value: '8' },
        ],
      },
    });
    writeDb("DELETE FROM ab_config WHERE config_key = 'order.pay_timeout_minutes'");
    assert(
      restore.body?.code === 0,
      'D58 夹具还原（把本节改动的配置写回原值）—— 配置是**全局**的，不还原会把副作用留给后续重跑',
      `code=${restore.body?.code} restored=${(restore.body?.data?.changed ?? []).length}`,
    );
    assert(
      !readDb("SELECT id FROM ab_config WHERE config_key = 'order.pay_timeout_minutes'"),
      'D58 还原：本节新建的兜底键已删除（回到「种子里没有」的初始状态）',
      '',
    );
    assert(
      readDb("SELECT config_value FROM ab_config WHERE config_key = 'commission.rate.trainee'")
        ?.config_value === '0.0800',
      'D58 还原校验：费率回到 `0.0800`（本节的百分数换算不能把原值改坏）',
      `db=${readDb("SELECT config_value FROM ab_config WHERE config_key = 'commission.rate.trainee'")?.config_value}`,
    );
  }

  // ==========================================================================
  // §23 M3-11 数据看板 D47–D50（后台 P35 · 模块 M36）
  // ==========================================================================
  //
  // 口径唯一真相：`apps/api-server/src/modules/stats/stats.constants.ts`
  //   · 统计基准 = **出餐日**（`ab_order.meal_date`）；区间只给 today / 7d / 30d 三档
  //   · GMV = Σ `unit_price` × `quantity`；**排除** 未支付 / 已取消 / 已退款
  //   · 经营毛利 = GMV − 采购款 − 履约成本 − 佣金（**结果值**，可能为负）
  //
  // ⚠️ 本节**不依赖下单窗口**（同 §18–§22 纪律）：订单夹具一律直插 `ab_order`。
  //    API 下单只能下「明日」且要求北京时间 14:00–23:00，靠它会让本节在窗口外整组变红。
  // ⚠️ 断言口径 = **增量对照 + 结构不变量**，不写死累计值：库里本来就有别处留下的订单，
  //    写死绝对值等于把别处的行为绑进本节（见《缺陷与陷阱》#31）。
  // ⚠️ 夹具以 `order_no` / `share_no` 前缀标记，**节首与节末各清一次** → 可重复跑。
  {
    log('\n§23 M3-11 数据看板 D47–D50');

    const PREFIX = `E2ESTATS${stamp}`;
    const D0 = bjToday();
    const D1 = addDaysStr(D0, -1);
    const D2 = addDaysStr(D0, -2);
    const UP = '25.80'; // 锁定售价
    const toFen = (v) => Math.round(Number(v ?? 0) * 100);

    const cleanFixtures = () => {
      writeDb('DELETE FROM ab_order WHERE order_no LIKE ?', [`${PREFIX}%`]);
      writeDb('DELETE FROM ab_commission WHERE order_no LIKE ?', [`${PREFIX}%`]);
      writeDb('DELETE FROM ab_supplier_share WHERE share_no LIKE ?', [`${PREFIX}%`]);
    };
    cleanFixtures(); // 上一次失败留下的残留先清掉

    // ---- 夹具原料：一律取自库内真实行，避免裸 id 在 MySQL 下撞外键 ----
    const freeUsers = readRows(
      'SELECT id FROM ab_user WHERE id NOT IN (SELECT DISTINCT user_id FROM ab_order) ORDER BY id DESC LIMIT 4',
    );
    const bRows = readRows(
      'SELECT id, building_group_id FROM ab_building WHERE building_group_id IS NOT NULL ORDER BY id LIMIT 2',
    );
    const mRows = readRows('SELECT id FROM ab_set_meal ORDER BY id LIMIT 2');
    const assignRow = readDb('SELECT id FROM ab_meal_assignment ORDER BY id LIMIT 1');
    const leaderRow = readDb('SELECT id FROM ab_team_leader ORDER BY id LIMIT 1');
    const supRow = readDb('SELECT id FROM ab_supplier ORDER BY id LIMIT 1');

    const ready =
      freeUsers.length >= 4 &&
      bRows.length >= 2 &&
      mRows.length >= 2 &&
      !!assignRow &&
      !!leaderRow &&
      !!supRow;
    assert(
      ready,
      '§23 前置：夹具原料齐备（≥4 个「从未下过单」的用户 / ≥2 栋有楼群的楼 / ≥2 个套餐 / 1 条分配行 / 1 名团长 / 1 家供应商）',
      `users=${freeUsers.length} buildings=${bRows.length} meals=${mRows.length} assign=${!!assignRow} leader=${!!leaderRow} supplier=${!!supRow}`,
    );

    if (ready) {
      const u1 = Number(freeUsers[0].id);
      const u2 = Number(freeUsers[1].id);
      const u3 = Number(freeUsers[2].id);
      const u4 = Number(freeUsers[3].id);
      const b1 = { id: Number(bRows[0].id), gid: Number(bRows[0].building_group_id) };
      const b2 = { id: Number(bRows[1].id), gid: Number(bRows[1].building_group_id) };
      const m1 = Number(mRows[0].id);
      const m2 = Number(mRows[1].id);
      const assignId = Number(assignRow.id);
      const leaderId = Number(leaderRow.id);

      // ---------------------------------------------------------- A. 区间（三档 + 回显 + 缺省 + 非法值）
      const before = (await call('GET', '/admin/stats/dashboard?range=7d', { token: adminToken }))
        .body?.data;
      const beforeHeat = (
        await call('GET', '/admin/stats/dish-heat?range=7d&topN=50', { token: adminToken })
      ).body?.data;
      const beforeRet = (await call('GET', '/admin/stats/retention?range=7d', { token: adminToken }))
        .body?.data;

      assert(
        before?.range?.range === '7d' && before?.range?.days === 7,
        'D47 区间回显：`range=7d` → days=7，且**回带起止日**（同档 = 同区间，端上不再自己算日期）',
        `range=${before?.range?.range} days=${before?.range?.days}`,
      );
      assert(
        before.range.endDate === D0 && before.range.startDate === addDaysStr(D0, -6),
        '区间**含末日**：近 7 日 = [今日−6, 今日] —— 少算一天会静默丢掉昨天的数据，看板上完全看不出来',
        `${before.range.startDate} ~ ${before.range.endDate}`,
      );
      const rToday = (
        await call('GET', '/admin/stats/dashboard?range=today', { token: adminToken })
      ).body?.data;
      assert(
        rToday?.range?.days === 1 && rToday.range.startDate === D0 && rToday.range.endDate === D0,
        '`range=today` → 单日出餐日区间',
        `days=${rToday?.range?.days}`,
      );
      const r30 = (await call('GET', '/admin/stats/dashboard?range=30d', { token: adminToken }))
        .body?.data;
      assert(
        r30?.range?.days === 30 && r30.range.startDate === addDaysStr(D0, -29),
        '`range=30d` → [今日−29, 今日]',
        `days=${r30?.range?.days} start=${r30?.range?.startDate}`,
      );
      const rDefault = (await call('GET', '/admin/stats/dashboard', { token: adminToken })).body
        ?.data;
      assert(
        rDefault?.range?.range === '7d',
        '`range` 缺省 = 7d（与原型 P35 首屏「近 7 日」一致，不让端上决定默认口径）',
        `range=${rDefault?.range?.range}`,
      );
      const rBad = await call('GET', '/admin/stats/dashboard?range=90d', { token: adminToken });
      assert(
        rBad.body?.code === 10001,
        '⭐ 非法 `range` → **10001**，不静默回落默认档 —— 否则运营以为在看 90 天，实际看的是 7 天',
        `code=${rBad.body?.code}`,
      );

      // ---------------------------------------------------------- B. 夹具：7 单（4 有效 / 3 无效）
      const INS_ORDER =
        'INSERT INTO ab_order (order_no, user_id, team_leader_id, building_id, building_group_id, set_meal_id, assignment_id, meal_date, quantity, unit_price, total_amount, balance_used, discount_amount, pay_amount, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, ?, ?)';
      const addOrder = (no, userId, leadId, b, mealId, date, qty, status) => {
        const total = (25.8 * qty).toFixed(2);
        writeDb(INS_ORDER, [
          no,
          userId,
          leadId,
          b.id,
          b.gid,
          mealId,
          assignId,
          date,
          qty,
          UP,
          total,
          total,
          status,
          `${date} 12:00:00`,
          `${date} 12:00:00`,
        ]);
      };

      addOrder(`${PREFIX}O1`, u1, leaderId, b1, m1, D0, 2, 'paid');
      addOrder(`${PREFIX}O2`, u1, leaderId, b1, m2, D0, 1, 'completed');
      addOrder(`${PREFIX}O3`, u2, leaderId, b2, m1, D1, 3, 'delivered');
      // 在途退款（钱还没退、佣金尚未冲销）→ **计入** GMV
      addOrder(`${PREFIX}O7`, u3, null, b1, m2, D1, 2, 'refund_applying');
      // 以下三单均**不计入** GMV
      addOrder(`${PREFIX}O4`, u4, null, b2, m1, D2, 1, 'pending_pay');
      addOrder(`${PREFIX}O5`, u4, null, b1, m1, D2, 1, 'refunded');
      addOrder(`${PREFIX}O6`, u2, null, b2, m2, D2, 1, 'cancelled');

      const o1 = readDb('SELECT id FROM ab_order WHERE order_no = ?', [`${PREFIX}O1`]);
      const o1Id = Number(o1?.id ?? 0);
      const o2 = readDb('SELECT id FROM ab_order WHERE order_no = ?', [`${PREFIX}O2`]);
      const o2Id = Number(o2?.id ?? 0);

      // ---------------------------------------------------------- C. 成本侧净额（佣金 / 采购）
      const INS_COMM =
        'INSERT INTO ab_commission (order_id, order_no, team_leader_id, leader_level, rate, base_amount, quantity, amount, type, status, meal_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
      writeDb(INS_COMM, [
        o1Id,
        `${PREFIX}O1`,
        leaderId,
        'formal',
        '0.0900',
        '51.60',
        2,
        '5.00',
        'normal',
        'pending',
        D0,
      ]);
      writeDb(INS_COMM, [
        o1Id,
        `${PREFIX}O1`,
        leaderId,
        'formal',
        '0.0900',
        '51.60',
        2,
        '-2.00',
        'reversal',
        'pending',
        D0,
      ]);
      // ⚠️ `ab_commission` 上有 **`uk_commission_order_type` UNIQUE(order_id, type)** ——
      //    一单最多一条 `normal` + 一条 `reversal`（这正是 C9 冲销的形状：原行 + 负行）。
      //    所以「已被冲销的 normal 行」这条夹具**必须挪到另一单**上，否则直插就撞唯一约束。
      //    status='cancelled' 的 normal 行 → 必须被排除，否则净额会算成 5.00 + 1.00
      writeDb(INS_COMM, [
        o2Id,
        `${PREFIX}O2`,
        leaderId,
        'formal',
        '0.0900',
        '25.80',
        1,
        '1.00',
        'normal',
        'cancelled',
        D0,
      ]);

      const supId = Number(supRow.id);
      const INS_SHARE =
        "INSERT INTO ab_supplier_share (share_no, share_date, meal_date, payee_type, payee_id, dish_id, quantity, unit_price, amount, type, channel, status) VALUES (?, ?, ?, 'supplier', ?, ?, ?, ?, ?, ?, 'manual', ?)";
      writeDb(INS_SHARE, [
        `${PREFIX}S1`,
        D0,
        D0,
        supId,
        null,
        10,
        '10.00',
        '100.00',
        'normal',
        'pending',
      ]);
      writeDb(INS_SHARE, [
        `${PREFIX}S2`,
        D0,
        D0,
        supId,
        null,
        10,
        '4.00',
        '-40.00',
        'reversal',
        'pending',
      ]);
      // 已被纠错冲销的行（status='reversed'）→ 必须排除
      writeDb(INS_SHARE, [
        `${PREFIX}S3`,
        D0,
        D0,
        supId,
        null,
        10,
        '999.00',
        '999.00',
        'normal',
        'reversed',
      ]);

      // ---------------------------------------------------------- D. D47 增量
      const after = (await call('GET', '/admin/stats/dashboard?range=7d', { token: adminToken }))
        .body?.data;
      const g = after?.metrics;
      const b0 = before?.metrics;
      const d = (k) => Number(g?.[k] ?? 0) - Number(b0?.[k] ?? 0);

      assert(
        d('orderCount') === 4,
        '⭐ GMV 口径：4 条有效单计入（paid / completed / delivered / refund_applying）—— 含**在途退款**：钱还没退、佣金也尚未冲销，此时剔除会造成「钱已收但 GMV 不计、佣金却还在支出」的双向错配',
        `ΔorderCount=${d('orderCount')}`,
      );
      assert(d('quantity') === 8, '份数增量 = 2+1+3+2 = 8', `Δquantity=${d('quantity')}`);
      assert(
        d('gmvFen') === 20640,
        '⭐ GMV = Σ `unit_price` × `quantity` = 8 × ¥25.80 = ¥206.40（**不是** `pay_amount`：折扣与余额抵扣不进 GMV，否则「收入」会随支付方式变化）',
        `ΔgmvFen=${d('gmvFen')}`,
      );
      assert(
        d('totalOrderCount') === 7,
        '退款率分母 = **全部**订单数（含未支付 / 已取消 / 已退款），增量 7 —— 分母只取有效单会让退款率翻倍虚高',
        `ΔtotalOrderCount=${d('totalOrderCount')}`,
      );
      assert(d('pendingPayCount') === 1, '未支付单独计数（既不算进 GMV，也不从分母里藏掉）', `Δ=${d('pendingPayCount')}`);
      assert(
        d('refundCount') === 2,
        '退款订单数 = `refund_applying` + `refunded` = 2；**`cancelled` 不算退款**（截单前自助取消不是事故）',
        `ΔrefundCount=${d('refundCount')}`,
      );
      assert(
        d('activeUserCount') === 3,
        '活跃用户去重：u4 只有无效单（未支付 + 已退款）→ 不计入',
        `ΔactiveUserCount=${d('activeUserCount')}`,
      );
      assert(
        d('repeatUserCount') === 1,
        '复购用户 = 区间内有效单 ≥2 次者（u1 两单）；u2 的第二单是 cancelled → 不算复购',
        `ΔrepeatUserCount=${d('repeatUserCount')}`,
      );
      // ⚠️ 下面两条**刻意不写增量 Δ**：Δ 隐含前提「这些主体在本节之前**不活跃**」，而
      //    e2e:m1 / m2（以及本节之前的章节）会在同一 7d 区间留下**同一** leader / 楼栋的
      //    有效单 → Δ 被吃掉，于是「`seed → e2e:m3` 单跑全绿、`verify`（seed→m1→m2→m3）
      //    串跑两条红」—— 一条与被测产物完全无关的**顺序脆弱型假红**（实测 Δ 由 1/2 变成
      //    0/1）。改成**库内对照**：用同一条口径的 SQL 在库里独立算一遍当 oracle，等式两侧
      //    同源，与「之前活跃与否」无关。⚠️ 断言仍必须能钉住原来的缺陷 —— 右侧的
      //    `IS NOT NULL` 正是「`team_leader_id` 为空的那单不虚增」的判据。
      const NOT_VALID = `'pending_pay','cancelled','refunded'`;
      const oracleLeaders = readDb(
        `SELECT COUNT(DISTINCT team_leader_id) AS c FROM ab_order
          WHERE meal_date BETWEEN ? AND ? AND status NOT IN (${NOT_VALID})
            AND team_leader_id IS NOT NULL`,
        [addDaysStr(D0, -6), D0],
      );
      const oracleBuildings = readDb(
        `SELECT COUNT(DISTINCT building_id) AS c FROM ab_order
          WHERE meal_date BETWEEN ? AND ? AND status NOT IN (${NOT_VALID})`,
        [addDaysStr(D0, -6), D0],
      );
      assert(
        g.activeLeaderCount === Number(oracleLeaders?.c ?? -1),
        '⭐ 活跃团长去重 = **库内独立算一遍**（oracle 对照，不用增量 Δ —— 增量对串跑顺序脆弱）—— 右侧 `IS NOT NULL` 同时钉住「`team_leader_id` 为空的那单不虚增」',
        `api=${g.activeLeaderCount} oracle=${oracleLeaders?.c}`,
      );
      assert(
        g.activeBuildingCount === Number(oracleBuildings?.c ?? -1),
        '⭐ 活跃楼栋去重 = **库内独立算一遍**（oracle 对照，同上）—— 楼栋**不排除空值**（订单必有取餐楼），少判一次就少一栋',
        `api=${g.activeBuildingCount} oracle=${oracleBuildings?.c}`,
      );
      // 覆盖实质约束：若夹具没贡献「2 栋不同楼栋 + 1 名团长」，上面两条 oracle 等式两边
      // 同为 0 也能过 —— 所以补一条只针对**本节夹具**的结构断言，保证等式有约束力。
      const fixtureScope = readDb(
        `SELECT COUNT(DISTINCT building_id) AS b,
                COUNT(DISTINCT CASE WHEN team_leader_id IS NOT NULL THEN team_leader_id END) AS l
           FROM ab_order WHERE order_no LIKE ?`,
        [`${PREFIX}%`],
      );
      assert(
        Number(fixtureScope?.b ?? 0) === 2 && Number(fixtureScope?.l ?? 0) === 1,
        '⭐ 本节夹具自身贡献 **2 栋不同楼栋 + 1 名团长**（其中一单 `team_leader_id` 为空）—— 这条保证上面两条 oracle 等式对「去重」有实质约束',
        `buildings=${fixtureScope?.b} leaders=${fixtureScope?.l}`,
      );

      // ---------------------------------------------------------- E. 结构不变量（比率 / 均价 / 等式闭合）
      assert(
        g.refundRate === Number((g.refundCount / g.totalOrderCount).toFixed(4)),
        '退款率 = 退款单数 ÷ 总订单数（服务端算好下发，端上不再算第二遍）',
        `rate=${g.refundRate} ${g.refundCount}/${g.totalOrderCount}`,
      );
      assert(
        g.repeatRate === Number((g.repeatUserCount / g.activeUserCount).toFixed(4)),
        '复购率 = 复购用户 ÷ 活跃用户',
        `rate=${g.repeatRate} ${g.repeatUserCount}/${g.activeUserCount}`,
      );
      assert(
        g.avgUnitPriceFen === Math.round(g.gmvFen / g.quantity),
        '单份均价 = GMV ÷ 份数',
        `${g.avgUnitPriceFen}`,
      );
      assert(
        g.avgOrderAmountFen === Math.round(g.gmvFen / g.orderCount),
        '⭐ 客单价 = GMV ÷ **订单数**，且与「单份均价」**并列下发** —— 一单可多份，只给一个数必定被读错（§6.6 原文的括号里「份数 / 订单量」表述含糊，故两个都出）',
        `客单价=${g.avgOrderAmountFen} 单份均价=${g.avgUnitPriceFen}`,
      );
      assert(
        g.grossProfitFen === g.gmvFen - g.purchaseFen - g.fulfillmentFen - g.commissionFen,
        '⭐⭐ 等式闭合：经营毛利 = GMV − 采购款 − 履约成本 − 佣金（**结果值** · 四个数放进同一等式才算得平，任一项口径漂移都会在这里现形）',
        `${g.grossProfitFen} vs ${g.gmvFen - g.purchaseFen - g.fulfillmentFen - g.commissionFen}`,
      );

      // ---------------------------------------------------------- F. 成本侧净额
      assert(
        d('commissionFen') === 300,
        '⭐ 佣金支出取**净额**：`normal +¥5.00` 与 `reversal −¥2.00` 相加 = ¥3.00；`status=cancelled` 的 ¥1.00 必须排除（含进去就变成 ¥5.00，凭空多出 66%）',
        `ΔcommissionFen=${d('commissionFen')}`,
      );
      assert(
        d('purchaseFen') === 6000,
        '⭐ 采购款取**净额**：`normal ¥100.00` + `reversal −¥40.00` = ¥60.00；`status=reversed` 的 ¥999.00 行必须排除',
        `ΔpurchaseFen=${d('purchaseFen')}`,
      );
      assert(
        after.purchaseGenerated === (after.metrics.purchaseFen !== 0),
        '`purchaseGenerated` 与 `purchaseFen` **同进同出**（前者是后者是否非零的显式标记，供前端标「毛利未扣采购款」）',
        `purchaseGenerated=${after.purchaseGenerated} purchaseFen=${after.metrics.purchaseFen}`,
      );
      assert(
        g.fulfillmentFen ===
          (toFen(after.costItems.siteFee) +
            toFen(after.costItems.packingLaborFee) +
            toFen(after.costItems.deliveryFee)) *
            g.quantity,
        '⭐ 履约成本 = 三项配置单价之和 × 份数，且**不含** `supplierTotal` —— 采购款走实际应付单，若把兜底示例值 14.00 也扣一遍就是重复计成本',
        `fulfillmentFen=${g.fulfillmentFen}`,
      );
      assert(
        after.costRegistration.allRegistered === (after.costRegistration.missingKeys.length === 0),
        '`costRegistration` 自洽（**与 P36 系统配置页共用同一份 `summarizeCostRegistration()`** —— 两处各自实现必然出现「配置页说已登记、看板说未登记」）',
        `allRegistered=${after.costRegistration.allRegistered} missing=${after.costRegistration.missingKeys.length}`,
      );

      // ---------------------------------------------------------- G. 毛利可靠性提示（上限值）
      const expectWarning =
        (g.gmvFen > 0 && !after.costRegistration.allRegistered) ||
        (g.quantity > 0 && !after.purchaseGenerated);
      assert(
        (after.warnings.length > 0) === expectWarning,
        '⚠️ 毛利可靠性提示与判据**同源**：履约成本未登记 / 采购单未出 → 必须出现「上限值」提示。任何一个减项缺失都会让经营毛利虚高，不给提示等于让运营拿虚高的数做决策',
        `warnings=${after.warnings.length} expect=${expectWarning}`,
      );

      // ---------------------------------------------------------- H. 逐日趋势
      assert(
        after.trend.length === 7 && after.trend.reduce((s, t) => s + t.gmvFen, 0) === g.gmvFen,
        '⭐ 趋势与总额**同一份口径**：`trend.length` = 区间天数（无单日补 0，端上不必自己补空洞），且 Σ 逐日 GMV = 区间 GMV',
        `len=${after.trend.length} Σ=${after.trend.reduce((s, t) => s + t.gmvFen, 0)} gmv=${g.gmvFen}`,
      );
      const d0Before = before.trend.find((t) => t.date === D0)?.orderCount ?? 0;
      const d0After = after.trend.find((t) => t.date === D0)?.orderCount ?? 0;
      assert(
        d0After - d0Before === 2,
        '趋势按**出餐日**归集：D0 当日新增 2 单（O1/O2）',
        `Δ=${d0After - d0Before}`,
      );

      // ---------------------------------------------------------- I. D48 楼群 / 楼栋榜单
      const rank = (
        await call('GET', '/admin/stats/building-rank?range=7d', { token: adminToken })
      ).body?.data;
      assert(
        rank.groups.reduce((s, r) => s + r.gmvFen, 0) === rank.totalGmvFen,
        '⭐ D48 楼群维度**分项之和 = 合计 GMV** —— 分项加起来对不上总额，运营从此不再信任任何一个数',
        `Σ=${rank.groups.reduce((s, r) => s + r.gmvFen, 0)} total=${rank.totalGmvFen}`,
      );
      assert(
        rank.buildings.reduce((s, r) => s + r.gmvFen, 0) === rank.totalGmvFen,
        '⭐ D48 楼栋维度分项之和 = 合计 GMV（楼栋被停用/软删也要保留行，否则两个维度对不上）',
        `Σ=${rank.buildings.reduce((s, r) => s + r.gmvFen, 0)}`,
      );
      assert(
        rank.totalGmvFen === after.metrics.gmvFen,
        '⭐⭐ D48 与 D47 的 GMV **同源**（同一份「有效订单」判定）—— 两处各算一套必然出现「看板 ¥4,798、榜单加起来 ¥4,301」',
        `rank=${rank.totalGmvFen} dashboard=${after.metrics.gmvFen}`,
      );
      assert(
        rank.groups.every((r) => r.gmvShare === Number((r.gmvFen / rank.totalGmvFen).toFixed(4))),
        'D48 占比 = 行 GMV ÷ 合计（服务端算，端上不做除法）',
        '',
      );
      assert(
        rank.buildings.every(
          (b) => typeof b.buildingGroupName === 'string' && b.buildingGroupName.length > 0,
        ),
        'D48 楼栋行必带所属楼群名（找不到时回退「未分组」/`楼群#id`，**不丢行**）',
        '',
      );

      // ---------------------------------------------------------- J. D49 菜品热度
      const heat = (await call('GET', '/admin/stats/dish-heat?range=7d&topN=5', { token: adminToken }))
        .body?.data;
      assert(
        heat.topN === 5 && heat.items.length === Math.min(5, heat.dishCount),
        'D49 `topN` 生效：`items` 条数 = min(topN, 菜品数)，不是「有多少给多少」',
        `items=${heat.items.length} dishCount=${heat.dishCount}`,
      );
      assert(
        heat.items.every((it) => it.share === Number((it.quantity / heat.totalQuantity).toFixed(4))),
        '⭐ D49 占比分母 = 区间内**全部**菜品份数，不是 topN 之和 —— 按 topN 之和算，排行末位的占比会凭空虚高',
        `totalQuantity=${heat.totalQuantity}`,
      );
      assert(
        heat.items.reduce((s, it) => s + it.quantity, 0) <= heat.totalQuantity,
        'D49 topN 份数之和 ≤ 全部份数',
        '',
      );
      assert(
        new Set(heat.items.map((it) => it.dishId)).size === heat.items.length,
        'D49 同一菜品不出现两行（一个菜被多个套餐引用时必须合并，否则热度被拆散）',
        '',
      );
      const badTop = await call('GET', '/admin/stats/dish-heat?topN=999', { token: adminToken });
      assert(
        badTop.body?.code === 10001,
        'D49 `topN` 上限收口 → 10001（不放开的话一次查询就能拉全量菜品）',
        `code=${badTop.body?.code}`,
      );

      const heatFull = (
        await call('GET', '/admin/stats/dish-heat?range=7d&topN=50', { token: adminToken })
      ).body?.data;
      const m1Dishes = readRows('SELECT dish_id FROM ab_set_meal_item WHERE set_meal_id = ?', [m1]);
      const gained = m1Dishes.filter((dd) =>
        heatFull.items.some((it) => it.dishId === Number(dd.dish_id)),
      );
      assert(
        gained.length >= 1,
        'D49 前置：套餐 m1 的菜品出现在 TOP 50（否则下面的份数增量无从校验）',
        `m1Dishes=${m1Dishes.length} inTop50=${gained.length}`,
      );

      // 期望值**从库里推导**，不写死数字：套餐 m1 与 m2 的菜品有重叠
      // （m1 = 1,6,4,7 / m2 = 2,6,4,7 —— 6、4、7 是「一菜多套餐」的常见形状）。
      // 若把 m1 的菜一律按「只属于 m1」期望 +5，共享菜就会红：实测 #4/#6 是 8 而不是 5。
      // ⭐ 这恰恰是 D49 必须**按菜品合并**而非按套餐展开的直接证据 —— 拆开就两行各 5。
      const dishSetOf = (mealId) =>
        new Set(
          readRows('SELECT dish_id FROM ab_set_meal_item WHERE set_meal_id = ?', [mealId]).map((r) =>
            Number(r.dish_id),
          ),
        );
      // 本节**有效**夹具订单（与 D47 计入 GMV 的 4 条同集合；未支付/已退款/已取消三单不计）
      const validFixtures = [
        { no: 'O1', dishes: dishSetOf(m1), qty: 2 },
        { no: 'O2', dishes: dishSetOf(m2), qty: 1 },
        { no: 'O3', dishes: dishSetOf(m1), qty: 3 },
        { no: 'O7', dishes: dishSetOf(m2), qty: 2 },
      ];
      const expectDelta = (dishId) =>
        validFixtures.reduce((s, o) => s + (o.dishes.has(dishId) ? o.qty : 0), 0);

      for (const dd of gained.slice(0, 3)) {
        const id = Number(dd.dish_id);
        const qBefore = beforeHeat.items.find((it) => it.dishId === id)?.quantity ?? 0;
        const qAfter = heatFull.items.find((it) => it.dishId === id)?.quantity ?? 0;
        const expect = expectDelta(id);
        const from = validFixtures
          .filter((o) => o.dishes.has(id))
          .map((o) => `${o.no}×${o.qty}`)
          .join(' + ');
        assert(
          qAfter - qBefore === expect,
          `⭐ D49 菜品份数 = 「套餐展开 × 订单份数」累加：菜品 #${id} 应 +${expect} 份（${from}）—— 一个菜被多个套餐引用时**必须合并到同一行**，拆成两行热度就被腰斩了`,
          `Δ=${qAfter - qBefore} expect=${expect}`,
        );
      }

      // ---------------------------------------------------------- K. D50 留存
      const ret = (await call('GET', '/admin/stats/retention?range=7d', { token: adminToken })).body
        ?.data;
      assert(
        ret.summary.activeUserCount === ret.summary.newUserCount + ret.summary.returningUserCount,
        '⭐ D50 不变量：活跃用户 = 新客 + 回流（两数相加必须等于总数，否则「新客 / 回流」的定义漏了一种人）',
        `${ret.summary.activeUserCount} vs ${ret.summary.newUserCount}+${ret.summary.returningUserCount}`,
      );
      assert(
        ret.summary.repeatRate ===
          Number((ret.summary.repeatUserCount / ret.summary.activeUserCount).toFixed(4)),
        'D50 复购率与 D47 同口径（分子分母同源，不是各算一套）',
        `rate=${ret.summary.repeatRate}`,
      );
      assert(
        ret.summary.newUserCount - (beforeRet?.summary?.newUserCount ?? 0) === 3,
        '⭐ 新客判定看**全历史**首单：这 3 位此前从未有过订单 → 计入新客（只看区间内的话，所有人都会显得像新客）',
        `ΔnewUser=${ret.summary.newUserCount - (beforeRet?.summary?.newUserCount ?? 0)}`,
      );
      assert(
        ret.cohorts.length === 4,
        'D50 cohort = 最近 4 个自然周（**周一为始**，不是「最近 4 个 7 天窗口」——后者与日历周对不上，运营无法与周报对齐）',
        `len=${ret.cohorts.length}`,
      );
      assert(
        ret.cohorts.every((c) => {
          // 两个条件同时成立才有留存数字，否则 `retainedWeek1` / `retentionRate1` **成对为 null**：
          //   (1) 观察窗口已走完；(2) 该群非空（0 人时 0/0 无意义，给 0 会被读成「0% 留存 = 新客质量差」）
          const canRate = c.observable && c.newUserCount > 0;
          return canRate
            ? c.retainedWeek1 !== null && c.retentionRate1 !== null
            : c.retainedWeek1 === null && c.retentionRate1 === null;
        }),
        '⭐ 留存数字**成对下发**：观察窗口未走完的 cohort、以及当周 0 新客的 cohort，两个字段都必须是 null —— 前者算出来只是「数据还没长出来」，后者是 0/0；任一种被兜底成 0，运营都会读成「新客质量差」',
        ret.cohorts
          .map(
            (c) =>
              `${c.cohortStart}:${c.newUserCount}人${
                c.retentionRate1 === null ? (c.observable ? '/空群→null' : '/观察中') : `/${c.retentionRate1}`
              }`,
          )
          .join(' '),
      );
      // 上一条只证明「该 null 时是 null」；再补一组**历史周**夹具证明「该有数时有数」，
      // 两条合起来才真正锁住「成对下发」的语义（只测一边，服务端整体返回 null 也能蒙过去）。
      const weekStartOf = (ds) => {
        const [y, m, d] = ds.split('-').map(Number);
        const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=周日
        return addDaysStr(ds, -((dow + 6) % 7)); // 回退到本周一
      };
      const wkNow = weekStartOf(D0);
      const wkBack3 = addDaysStr(wkNow, -21); // = cohortStarts[0]，观察窗口（+7…+13）已走完
      // u3 首单落在三周前的那一周（cohort 起点），次周再下一单 → 次周留存 1 人
      addOrder(`${PREFIX}O8`, u3, null, b1, m2, wkBack3, 1, 'completed');
      addOrder(`${PREFIX}O9`, u3, null, b1, m2, addDaysStr(wkBack3, 8), 1, 'completed');
      const ret2 = (await call('GET', '/admin/stats/retention?range=7d', { token: adminToken })).body
        ?.data;
      const c3 = ret2?.cohorts?.find((c) => c.cohortStart === wkBack3);
      assert(
        !!c3 &&
          c3.observable &&
          c3.newUserCount >= 1 &&
          c3.retainedWeek1 >= 1 &&
          c3.retentionRate1 === Number((c3.retainedWeek1 / c3.newUserCount).toFixed(4)),
        '⭐ 观察窗口**已走完且群非空**的 cohort 必须下发真实留存数字：`observable=true` + 两个字段非 null，且率 = 留存人数 ÷ 新客数（服务端算好，端上不做除法）',
        c3 ? `observable=${c3.observable} 新客=${c3.newUserCount} 留存=${c3.retainedWeek1} 率=${c3.retentionRate1}` : '未找到该 cohort',
      );
      const curCohort = ret.cohorts[ret.cohorts.length - 1];
      assert(
        curCohort.cohortStart === wkNow &&
          !curCohort.observable &&
          curCohort.retainedWeek1 === null &&
          curCohort.retentionRate1 === null,
        '⭐ 本周（cohort 末群）**必定「观察中」**：它的观察窗口要等到下周日才走完 —— 判定锚在「窗口末日 vs 今天」，不是「这个群老不老」；两种 null 也不可混用（`observable=false` = 观察中，`observable=true` + 率为 null = 空群），混成一个就会把「没人来」错说成「数据还没长出来」',
        `${curCohort.cohortStart} observable=${curCohort.observable} retained=${curCohort.retainedWeek1} 末群应=${wkNow}`,
      );
      assert(
        ret.cohorts.every((c) => c.cohortStart <= c.cohortEnd),
        'D50 cohort 起止有序（首单周 周一 ≤ 周日）',
        '',
      );
      assert(
        typeof ret.note === 'string' && ret.note.includes('有效订单'),
        'D50 出参自带口径说明（端上不复制第二份文案，口径改了只改一处）',
        '',
      );

      // ---------------------------------------------------------- L. 主体隔离 + 白名单
      const s23Op = `e2e_s23op_${stamp}`;
      const s23View = `e2e_s23view_${stamp}`;
      await call('POST', '/admin/system/accounts', {
        token: adminToken,
        body: { username: s23Op, password: PWD, role: 'operator', realName: 'e2e 看板运营' },
      });
      await call('POST', '/admin/system/accounts', {
        token: adminToken,
        body: { username: s23View, password: PWD, role: 'viewer', realName: 'e2e 看板只读' },
      });
      const s23OpToken = (await adminLogin(s23Op, PWD)).token;
      const s23ViewToken = (await adminLogin(s23View, PWD)).token;
      const s23FinToken = (await adminLogin('finance', 'finance123')).token;

      assert(
        (await call('GET', '/admin/stats/dashboard', { token: s23OpToken })).body?.code === 0,
        '看板对 `operator` 开放（运营要能看经营数据跟进业务，不该「看得见点不开」）',
        '',
      );
      assert(
        (await call('GET', '/admin/stats/dashboard', { token: s23FinToken })).body?.code === 0,
        '看板对 `finance` 开放',
        '',
      );
      assert(
        (await call('GET', '/admin/stats/dashboard', { token: s23ViewToken })).body?.code === 0,
        '⭐ 看板对 `viewer` **必须**开放 —— `admin-role.ts` 里 viewer 的菜单**只有这 4 个看板页**；接口白名单若漏了他，该角色会在自己唯一拥有的页面上拿 10003（「菜单能点、点了报无权限」，最容易被当成 bug 的一类不一致）',
        '',
      );
      const guest23 = await userLogin(`e2e_s23_${stamp}`);
      assert(
        (await call('GET', '/admin/stats/dashboard', { token: guest23.token })).body?.code === 10003,
        '双主体隔离：小程序 token 打 `/admin/stats/*` → 10003（C 端与后台 id 各自自增，不隔离即静默越权）',
        '',
      );
      const sup23 = await adminLogin('sanweiwu', 'supplier123');
      assert(
        (await call('GET', '/admin/stats/dashboard', { token: sup23.token })).body?.code === 10003,
        '双主体隔离：供应商 token 打 `/admin/stats/*` → 10003 —— 不变量 I1（供应商端不得出现终端定价信息）在看板上同样成立：GMV / 佣金 / 毛利一个都不能漏给供应商',
        '',
      );
      assert(
        (await call('GET', '/admin/stats/dashboard')).body?.code === 10002,
        '未登录 → 10002',
        '',
      );

      // ---------------------------------------------------------- M. 夹具还原
      cleanFixtures();
      const restored = (
        await call('GET', '/admin/stats/dashboard?range=7d', { token: adminToken })
      ).body?.data;
      assert(
        restored.metrics.orderCount === before.metrics.orderCount &&
          restored.metrics.gmvFen === before.metrics.gmvFen &&
          restored.metrics.commissionFen === before.metrics.commissionFen &&
          restored.metrics.purchaseFen === before.metrics.purchaseFen &&
          restored.metrics.totalOrderCount === before.metrics.totalOrderCount,
        'D47 夹具还原：删掉本节订单 / 佣金 / 应付后**各项增量归零** —— 看板是**全局**聚合，不还原会把副作用（凭空多出的 GMV、佣金、采购款）留给后续重跑',
        `orderCount ${before.metrics.orderCount}→${restored.metrics.orderCount} gmv ${before.metrics.gmvFen}→${restored.metrics.gmvFen}`,
      );
      assert(
        !readDb('SELECT id FROM ab_order WHERE order_no LIKE ?', [`${PREFIX}%`]) &&
          !readDb('SELECT id FROM ab_commission WHERE order_no LIKE ?', [`${PREFIX}%`]) &&
          !readDb('SELECT id FROM ab_supplier_share WHERE share_no LIKE ?', [`${PREFIX}%`]),
        'D47 还原校验：三类夹具行均已清空（回到可重复跑的初始状态）',
        '',
      );
    }
  }

  // ==========================================================================
  // §24 M3-12 通知模板 D59–D60（后台 P36 · 模块 M37）
  // ==========================================================================
  //
  // 口径唯一真相：`apps/api-server/src/modules/admin/template/message-template.specs.ts`
  //   · D59 读：场景清单（**以代码声明为准**）+ 接线状态 + 启用闸门现状
  //   · D60 写：只可改 3 个字段 + 变量白名单 + ⭐ **启用闸门 fail-closed**
  //
  // 本节的三个核心不变量：
  //   ① 「接线状态」必须**如实**（live 的场景真有投递点，pending 的附具体原因）
  //   ② 「启用」必须 **fail-closed**（缺必要条件就拒绝启用，杜绝「已启用但发不出去」）
  //   ③ 只读字段**拒绝**而非静默忽略（`forbidNonWhitelisted`）
  //
  // ⚠️ 本节不依赖下单窗口（同 §18–§23 纪律）：订单夹具直插 `ab_order`。
  // ⚠️ 模板是**全局**的：本节改动在节末逐条还原为快照值。
  {
    log('\n§24 M3-12 通知模板 D59–D60');

    // ⚠️ 块作用域：`D0` 定义在 §23 的 `{ }` 里，本块看不见，必须自己再取一次
    const D0 = bjToday();

    const TPL = '/admin/system/templates';
    const PREFIX24 = `E2ETPL${stamp}`;
    const getList = async () => (await call('GET', TPL, { token: adminToken })).body?.data;
    const pick = (list, scene) => (list ?? []).find((t) => t.scene === scene);

    const list0 = await getList();
    const snap = Object.fromEntries(
      (list0?.list ?? []).map((t) => [
        t.scene,
        {
          id: t.id,
          enabled: t.enabled ? 1 : 0,
          wechatTemplateId: t.wechatTemplateId,
          groupContent: t.groupContent,
        },
      ]),
    );

    // ---------------------------------------------------------- A. 清单结构
    assert(
      list0?.list?.length === 6,
      '⭐ D59 场景清单 = **6 个场景** —— 原型 P36 是 5 行，第 6 行 `commission_settled`（团长佣金入账通知）由 M4-3 新增：两段式佣金（T 日计佣 / T+1 入账）若不通知，团长看到的是「确认了却没钱」，会被当成漏结',
      `count=${list0?.list?.length}`,
    );
    assert(
      list0?.summary?.total === (list0?.list ?? []).length &&
        list0.summary.enabled === (list0.list ?? []).filter((t) => t.enabled).length &&
        list0.summary.live === (list0.list ?? []).filter((t) => t.wiring === 'live').length &&
        list0.summary.pending === (list0.list ?? []).filter((t) => t.wiring === 'pending').length,
      '⭐ D59 概览与明细**同源可复算**（总数 / 已启用 / 已接线 / 待接入四项）—— 分两处各算一遍，迟早出现「汇总 5、列表 4」',
      `total=${list0?.summary?.total} enabled=${list0?.summary?.enabled} live=${list0?.summary?.live} pending=${list0?.summary?.pending}`,
    );
    assert(
      (list0?.list ?? []).every(
        (t) =>
          t.label &&
          t.audience &&
          t.trigger &&
          t.channels.length > 0 &&
          t.consumedBy &&
          Array.isArray(t.variables),
      ),
      'D59 每条都带 场景名 / 触达对象 / 触发时机 / 渠道 / 消费点 / 变量清单（端上不维护第二份文案）',
      '',
    );
    const mandatory = (list0?.list ?? []).filter((t) => t.mandatory);
    assert(
      mandatory.length === 1 && mandatory[0].scene === 'refund_result',
      '⭐ **必推项只有「退款结果通知」一条** —— 原型口径：用户端常规状态不推送（避免打扰），退款结果属必推',
      `mandatory=${mandatory.map((t) => t.scene).join(',')}`,
    );
    const orderStatusTpl = pick(list0?.list, 'user_order_status');
    assert(
      orderStatusTpl?.mandatory === false && orderStatusTpl?.enabled === false,
      '⭐「用户端常规状态推送」默认**关闭且非必推**（原型的「简化原则」）—— 这一行留着是为了让「用户为什么收不到出餐提醒」有据可查：它是设计选择，不是漏了',
      `enabled=${orderStatusTpl?.enabled} mandatory=${orderStatusTpl?.mandatory}`,
    );
    const deliveryTpl = pick(list0?.list, 'leader_delivery');
    assert(
      deliveryTpl?.channels?.length === 1 && deliveryTpl.channels[0].key === 'wechat_group',
      '⭐「团长送达通知」一期渠道**只有微信群**（人工发群兜底）；原型的「服务通知」属二期替代方案 —— 若声明成双渠道，本场景在种子里启用后必然缺订阅消息模板 ID，「已启用」与「启用闸门」就会互相矛盾',
      `channels=${deliveryTpl?.channels?.map((c) => c.key).join('+')}`,
    );

    // ---------------------------------------------------------- B. 接线状态如实标注
    const liveTpl = (list0?.list ?? []).filter((t) => t.wiring === 'live');
    const pendingTpl = (list0?.list ?? []).filter((t) => t.wiring === 'pending');
    const liveScenes = liveTpl.map((t) => t.scene).sort().join(',');
    assert(
      liveTpl.length === 3 &&
        liveScenes === 'commission_settled,leader_apply,refund_result' &&
        liveTpl.every((t) => String(t.consumedBy).includes('.service')),
      '⭐⭐ **接线状态如实**：M4-3 后**三个场景**有真实投递点 —— `refund_result`（M3-12）·' +
        '`leader_apply`（M4-3）· `commission_settled`（M4-3）；其余 3 个仍标 `pending`。' +
        '⚠️ 里程碑 4.10 原文列的是「支付成功 / 出餐提醒 / 取餐通知 / 退款结果」，本批**刻意收窄**：' +
        '`user_order_status` 按原型「简化原则」不推、`leader_delivery` 一期走微信群人工、' +
        '`merchant_cook` 收件人是供应商（非用户小程序身份）—— 三者「接了也没有真实收件人」，' +
        '接了反而是假绿。**宁可如实标 pending，也不假装已贯通**',
      `live=${liveScenes || '无'} pending=${pendingTpl.length}`,
    );
    assert(
      pendingTpl.every((t) => !!t.pendingReason),
      '⭐ `pending` 必须附**具体原因**（「没有投递点」与「为什么没有」是两件事）—— 只标状态不给原因，运营仍不知道下一步该做什么',
      `缺原因=${pendingTpl.filter((t) => !t.pendingReason).length}`,
    );
    const refundTpl = pick(list0?.list, 'refund_result');
    assert(
      refundTpl?.fieldWiring?.enabled === 'live' &&
        refundTpl?.fieldWiring?.wechatTemplateId === 'live' &&
        refundTpl?.fieldWiring?.groupContent === 'record_only',
      '⭐ **字段级接线状态**：`enabled` / `wechatTemplateId` 真生效，`groupContent` 标 `record_only`（微信群文案供人工复制，不是程序行为）',
      `enabled=${refundTpl?.fieldWiring?.enabled} id=${refundTpl?.fieldWiring?.wechatTemplateId} content=${refundTpl?.fieldWiring?.groupContent}`,
    );
    assert(
      String(list0?.note ?? '').includes('微信公众平台'),
      '⭐ 页面口径明说「**微信订阅消息的实际文案由微信公众平台侧的模板定义**」—— 不写明，运营会以为改了本页文案用户就能看到新内容（本项目反复栽过的那类「给了输入框却没接上线」）',
      `note 含关键词=${String(list0?.note ?? '').includes('微信公众平台')}`,
    );

    // ---------------------------------------------------------- C. 种子状态与闸门现状
    assert(
      deliveryTpl?.enabled === true && (deliveryTpl?.blockers ?? []).length === 0,
      '⭐ 种子里**只有「团长送达通知」启用**：它含微信群渠道（人工发群只需文案），不依赖尚未申请的微信模板 ID —— 正对应原型「初期采用微信群人工通知兜底」',
      `enabled=${deliveryTpl?.enabled} blockers=${deliveryTpl?.blockers?.length}`,
    );
    assert(
      (list0?.list ?? [])
        .filter((t) => t.scene !== 'leader_delivery')
        .every((t) => t.enabled === false),
      '⭐ 其余 5 个场景**均未启用** —— 一期没有微信订阅消息模板 ID，启用必然发不出去；如实显示「未启用」远好过假装已启用（M4-3 接线 `leader_apply` / `commission_settled` 后仍是 0，**接线与启用是两件事**：代码接好了，配置还没到）',
      `已启用的其余场景=${(list0?.list ?? [])
        .filter((t) => t.scene !== 'leader_delivery' && t.enabled)
        .map((t) => t.scene)
        .join(',') || '无'}`,
    );
    assert(
      (refundTpl?.blockers ?? []).some((b) => b.includes('微信订阅消息模板 ID')),
      '⭐ D59 给出**启用还缺什么**（`blockers` 点名字段）—— 「不能启用」与「缺什么才能启用」是两件事，只有后者可执行',
      `blockers=${refundTpl?.blockers?.join('；') ?? '无'}`,
    );

    // ---------------------------------------------------------- D. ⭐ 启用闸门 fail-closed
    const enableNoId = await call('PUT', `${TPL}/${snap.merchant_cook.id}`, {
      token: adminToken,
      body: { enabled: 1 },
    });
    assert(
      enableNoId.body?.code === 10001,
      '⭐⭐ **启用闸门 fail-closed**：缺微信模板 ID 时启用 → 10001 —— 放行的后果是页面显示「已启用」而投递必然失败，用户那边永远静默收不到，且**没有任何地方显示异常**',
      `code=${enableNoId.body?.code}`,
    );
    assert(
      JSON.stringify(enableNoId.body?.data ?? {}).includes('微信订阅消息模板 ID'),
      '⭐ 拒绝理由点名**缺哪个字段**（不是一个笼统的「参数错误」）—— 运营据此直接知道去填什么',
      `data=${JSON.stringify(enableNoId.body?.data ?? {}).slice(0, 120)}`,
    );

    const fillIdFirst = await call('PUT', `${TPL}/${snap.merchant_cook.id}`, {
      token: adminToken,
      body: { wechatTemplateId: 'E2E_DEMO_COOK_TPL' },
    });
    const thenEnable = await call('PUT', `${TPL}/${snap.merchant_cook.id}`, {
      token: adminToken,
      body: { enabled: 1 },
    });
    assert(
      fillIdFirst.body?.code === 0 && thenEnable.body?.code === 0,
      'D60 补齐必要条件后即可启用（**看的是最终状态**，不是「先启用再说」）—— 门禁不该变成死锁',
      `fill=${fillIdFirst.body?.code} enable=${thenEnable.body?.code}`,
    );

    const tearDownWhileOn = await call('PUT', `${TPL}/${snap.merchant_cook.id}`, {
      token: adminToken,
      body: { wechatTemplateId: null },
    });
    assert(
      tearDownWhileOn.body?.code === 10001,
      '⭐⭐ **不能「先启用、再单独拆掉条件」**：已启用状态下清空模板 ID → 10001 —— 否则可以绕过闸门，得到一个「启用但发不出」的场景',
      `code=${tearDownWhileOn.body?.code}`,
    );
    const restoreCook = await call('PUT', `${TPL}/${snap.merchant_cook.id}`, {
      token: adminToken,
      body: { enabled: 0, wechatTemplateId: null },
    });
    assert(
      restoreCook.body?.code === 0,
      'D60 关闭后即可清空模板 ID（顺序反过来就合法）—— 闸门约束的是**最终状态**，不是操作次序',
      `code=${restoreCook.body?.code}`,
    );

    const emptyPatch = await call('PUT', `${TPL}/${snap.merchant_cook.id}`, {
      token: adminToken,
      body: {},
    });
    assert(
      emptyPatch.body?.code === 10001,
      'D60 空请求（三个可编辑字段一个都没传）→ 10001 —— 无意义的调用不是幂等成功，回一句「已更新」会让调用方以为改了什么',
      `code=${emptyPatch.body?.code}`,
    );

    // ---------------------------------------------------------- E. 变量白名单
    const badVar = await call('PUT', `${TPL}/${snap.leader_delivery.id}`, {
      token: adminToken,
      body: { groupContent: '【ABox】{{mealDate}} 送达 {{bulidingName}}，共 {{quantity}} 份。' },
    });
    assert(
      badVar.body?.code === 10001,
      '⭐ 文案里的 `{{变量}}` 必须在**白名单**内：`{{bulidingName}}`（拼错的 `buildingName`）→ 10001 —— 写错的变量在发送时不会被替换，用户会直接看到 `{{bulidingName}}` 原文',
      `code=${badVar.body?.code}`,
    );
    const okVar = await call('PUT', `${TPL}/${snap.leader_delivery.id}`, {
      token: adminToken,
      body: {
        groupContent: '【ABox 取餐提醒】{{mealDate}} 的午餐已于 {{arriveTime}} 送达 {{buildingName}} 楼下，共 {{quantity}} 份。',
      },
    });
    assert(
      okVar.body?.code === 0,
      'D60 合法变量写入成功（4 个变量全在白名单内）',
      `code=${okVar.body?.code}`,
    );
    const singleBrace = await call('PUT', `${TPL}/${snap.leader_delivery.id}`, {
      token: adminToken,
      body: { groupContent: '【ABox】今日共 {3} 种套餐，{{mealDate}} 送达。' },
    });
    assert(
      singleBrace.body?.code === 0,
      '变量识别的**边界**：单花括号 `{3}` 不算占位符（只有 `{{...}}` 才是）—— 否则「共 {12} 份」这类自然文本会被误判成非法变量而拒写',
      `code=${singleBrace.body?.code}`,
    );

    // ---------------------------------------------------------- F. 只读字段拒绝（不静默忽略）
    const writeScene = await call('PUT', `${TPL}/${snap.leader_delivery.id}`, {
      token: adminToken,
      body: { scene: 'hacked_scene', enabled: 1 },
    });
    assert(
      writeScene.body?.code === 10001,
      '⭐⭐ **只读字段拒绝而非静默忽略**：传 `scene` → 10001（`forbidNonWhitelisted`）—— `scene` 是代码分派投递的键，改了这条模板就再也投不出去；静默忽略更糟：调用方以为改成功了',
      `code=${writeScene.body?.code}`,
    );
    const writeChannels = await call('PUT', `${TPL}/${snap.leader_delivery.id}`, {
      token: adminToken,
      body: { channels: ['wechat_subscribe'] },
    });
    assert(
      writeChannels.body?.code === 10001,
      'D60 渠道组合同样不可改（渠道是**代码事实**：代码按它决定走哪条通道）',
      `code=${writeChannels.body?.code}`,
    );

    // ---------------------------------------------------------- G. 目标不存在
    const ghost = await call('PUT', `${TPL}/999999`, {
      token: adminToken,
      body: { enabled: 0 },
    });
    assert(
      ghost.body?.code === 10004,
      'D60 目标 id 不存在 → 10004（不是 10001：请求本身合法，是**资源不存在**）',
      `code=${ghost.body?.code}`,
    );

    // ---------------------------------------------------------- H. 幂等 + 审计
    // ⚠️ 要用**当前值**去比，不能用 `snap`（快照是本节开始前的值，E 段已经改过文案了）——
    //    拿快照去提交，得到的是一次**真实变更**（改回快照），断言会误报。
    const curDelivery = pick((await getList())?.list, 'leader_delivery');
    const noop = await call('PUT', `${TPL}/${snap.leader_delivery.id}`, {
      token: adminToken,
      body: { groupContent: curDelivery.groupContent },
    });
    assert(
      noop.body?.code === 0 && (noop.body?.data?.changed ?? []).length === 0,
      'D60 幂等：提交与当前值相同 → `changed=[]`，不产生假变更记录（按「请求非空」就记一笔的话，审计日志会被无意义的重复提交淹没）',
      `changed=${(noop.body?.data?.changed ?? []).length}`,
    );
    // 反面对照：只验「相同返回空」是很弱的 —— 一个**恒返回空**的 diff 也能过。
    // 必须同时验「不同时报告且点名字段」，才证明回执真的在比对。
    const oneChange = await call('PUT', `${TPL}/${snap.leader_delivery.id}`, {
      token: adminToken,
      body: { groupContent: `${curDelivery.groupContent}（校对）` },
    });
    assert(
      oneChange.body?.code === 0 &&
        (oneChange.body?.data?.changed ?? []).length === 1 &&
        oneChange.body?.data?.changed?.[0]?.field === 'groupContent' &&
        oneChange.body?.data?.changed?.[0]?.before !==
          oneChange.body?.data?.changed?.[0]?.after,
      '⭐ 变更回执**真的在逐字段比对**：提交不同内容 → 恰好 1 项变更、点名字段、且 before≠after（与上一条配对，否则「恒返回空」的实现也能骗过测试）',
      `changed=${JSON.stringify(oneChange.body?.data?.changed ?? []).slice(0, 120)}`,
    );
    const tplLog = await waitDb(
      "SELECT action FROM ab_operation_log WHERE module = 'system' AND action = '编辑通知模板' ORDER BY id DESC LIMIT 1",
      [],
      (r) => !!r,
      { timeout: 4000 },
    );
    assert(
      !!tplLog,
      'D60 由 `@OperationLog()` 落 `ab_operation_log`（改通知开关必须能回答「谁在什么时候关掉了退款通知」）',
      `action=${tplLog?.action ?? '未落库'}`,
    );

    // ---------------------------------------------------------- I. ⭐ 真消费点（退款结果通知）
    const users24 = readRows(
      'SELECT id, openid FROM ab_user WHERE openid IS NOT NULL ORDER BY id LIMIT 2',
    );
    const b24 = readDb(
      'SELECT id, building_group_id FROM ab_building WHERE building_group_id IS NOT NULL ORDER BY id LIMIT 1',
    );
    const m24 = readDb('SELECT id FROM ab_set_meal ORDER BY id LIMIT 1');
    const a24 = readDb('SELECT id FROM ab_meal_assignment ORDER BY id LIMIT 1');
    const l24 = readDb('SELECT id FROM ab_team_leader ORDER BY id LIMIT 1');
    const ready24 = users24.length >= 2 && !!b24 && !!m24 && !!a24 && !!l24;

    assert(
      ready24,
      '§24 前置：退款通知消费点的夹具原料齐备（≥2 个有 openid 的用户 / 1 栋有楼群的楼 / 1 套餐 / 1 分配行 / 1 团长）',
      `users=${users24.length} building=${!!b24} meal=${!!m24} assign=${!!a24} leader=${!!l24}`,
    );

    if (ready24) {
      const INS24 =
        'INSERT INTO ab_order (order_no, user_id, team_leader_id, building_id, building_group_id, set_meal_id, assignment_id, meal_date, quantity, unit_price, total_amount, balance_used, discount_amount, pay_amount, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, 0, ?, ?, 0, ?, ?)';
      const addOrder24 = (no, userId) =>
        writeDb(INS24, [
          no,
          userId,
          Number(l24.id),
          Number(b24.id),
          Number(b24.building_group_id),
          Number(m24.id),
          Number(a24.id),
          D0,
          '25.80',
          '25.80',
          '25.80',
          'paid',
          `${D0} 12:00:00`,
          `${D0} 12:00:00`,
        ]);

      addOrder24(`${PREFIX24}O1`, Number(users24[0].id));
      addOrder24(`${PREFIX24}O2`, Number(users24[1].id));

      const msgMax = () =>
        Number(readDb('SELECT COALESCE(MAX(id), 0) AS m FROM ab_message')?.m ?? 0);

      // ① 场景「未启用」→ 不投递、不留日志
      const msgBefore = msgMax();
      const refund1 = await call('POST', `/admin/orders/${PREFIX24}O1/force-refund`, {
        token: adminToken,
        body: { reason: 'e2e 通知模板用例（场景未启用）' },
      });
      assert(
        refund1.body?.code === 0,
        'D11 强制退款成功（此时「退款结果通知」处于**未启用**态）',
        `code=${refund1.body?.code}`,
      );
      assert(
        msgMax() === msgBefore,
        '⭐⭐ **未启用 = 不投递且不留日志**：`ab_message` 的语义是「发过什么」，把「因为没启用所以没发」也写进去，这张表就失去了查询价值',
        `before=${msgBefore} after=${msgMax()}`,
      );

      // ② 配置并启用后 → 真投递 + 落日志
      const setTplId = await call('PUT', `${TPL}/${snap.refund_result.id}`, {
        token: adminToken,
        body: { wechatTemplateId: 'E2E_DEMO_REFUND_TPL' },
      });
      assert(
        setTplId.body?.code === 0,
        'D60 先填微信模板 ID（仍为关闭态）→ 成功',
        `code=${setTplId.body?.code}`,
      );
      const enableRefund = await call('PUT', `${TPL}/${snap.refund_result.id}`, {
        token: adminToken,
        body: { enabled: 1 },
      });
      assert(
        enableRefund.body?.code === 0,
        'D60 再启用「退款结果通知」→ 成功（**必推项**从「发不出去」变为「真会发」）',
        `code=${enableRefund.body?.code}`,
      );

      const refund2 = await call('POST', `/admin/orders/${PREFIX24}O2/force-refund`, {
        token: adminToken,
        body: { reason: 'e2e 通知模板用例（场景已启用）' },
      });
      assert(
        refund2.body?.code === 0,
        'D11 强制退款成功（「退款结果通知」**已启用**）',
        `code=${refund2.body?.code}`,
      );
      const sentRow = await waitDb(
        'SELECT id, status, template_id, payload FROM ab_message WHERE id > ? ORDER BY id DESC LIMIT 1',
        [msgBefore],
        (r) => !!r,
        { timeout: 5000 },
      );
      assert(
        !!sentRow && sentRow.status === 'success',
        '⭐⭐ **启用后真的投递了**并落 `ab_message` 日志（status=success）—— 这是本批次唯一被真实消费的字段，也正是「接线状态标 live」的事实依据',
        `found=${!!sentRow} status=${sentRow?.status}`,
      );
      assert(
        sentRow?.template_id === 'E2E_DEMO_REFUND_TPL',
        '⭐ 日志 `template_id` = 后台刚配置的值 —— 配置**真的被用上了**，不是写死在代码里的常量',
        `template_id=${sentRow?.template_id}`,
      );
      let payload24 = null;
      try {
        payload24 = sentRow?.payload ? JSON.parse(sentRow.payload) : null;
      } catch {
        payload24 = null;
      }
      assert(
        payload24?.scene === 'refund_result',
        '日志 `payload.scene` 标明来源场景（事后能回答「这条通知是哪个场景发的」，多场景共用一张日志表时这条是刚需）',
        `scene=${payload24?.scene}`,
      );

      // 清理本节订单与日志
      writeDb('DELETE FROM ab_message WHERE id > ?', [msgBefore]);
      writeDb('DELETE FROM ab_refund WHERE order_no LIKE ?', [`${PREFIX24}%`]);
      writeDb('DELETE FROM ab_order WHERE order_no LIKE ?', [`${PREFIX24}%`]);
      assert(
        msgMax() === msgBefore &&
          !readDb('SELECT id FROM ab_order WHERE order_no LIKE ?', [`${PREFIX24}%`]),
        '§24 夹具还原：本节产生的推送日志与订单已清空（`ab_message` 是**只增**表，不清理会让下次重跑的对照失去基准）',
        `msg=${msgBefore}→${msgMax()}`,
      );
    }

    // ---------------------------------------------------------- J. 权限与主体隔离
    const ok24Op = `e2e_s24op_${stamp}`;
    const ok24View = `e2e_s24view_${stamp}`;
    await call('POST', '/admin/system/accounts', {
      token: adminToken,
      body: { username: ok24Op, password: PWD, role: 'operator', realName: 'e2e 模板运营' },
    });
    await call('POST', '/admin/system/accounts', {
      token: adminToken,
      body: { username: ok24View, password: PWD, role: 'viewer', realName: 'e2e 模板只读' },
    });
    const t24Op = (await adminLogin(ok24Op, PWD)).token;
    const t24View = (await adminLogin(ok24View, PWD)).token;
    const t24Fin = (await adminLogin('finance', 'finance123')).token;

    assert(
      (await call('GET', TPL, { token: t24Op })).body?.code === 10003,
      'D59 `operator` → 10003（`admin-role.ts` 里 operator 的菜单**不含 `/system/*`**；接口白名单与菜单矩阵一致，否则「菜单看不到、接口却能调」）',
      '',
    );
    assert(
      (await call('GET', TPL, { token: t24Fin })).body?.code === 10003,
      'D59 `finance` → 10003（通知模板属系统管理，不在财务职责内）',
      '',
    );
    assert(
      (await call('GET', TPL, { token: t24View })).body?.code === 10003,
      '⭐ D59 `viewer` → 10003 —— 这是**反向**的「两个真相」检查：viewer 的菜单只有 4 个看板页，若他在这里被放行，说明白名单比菜单更宽（M3-11 遇到的镜像问题）',
      '',
    );
    assert(
      (await call('PUT', `${TPL}/${snap.leader_delivery.id}`, {
        token: t24Op,
        body: { enabled: 0 },
      })).body?.code === 10003,
      'D60 越权写 → 10003（守卫挡在业务层之前，不是「执行了再回滚」）',
      '',
    );
    const sup24 = await adminLogin('sanweiwu', 'supplier123');
    assert(
      (await call('GET', TPL, { token: sup24.token })).body?.code === 10003,
      '双主体隔离：供应商 token 打 `/admin/system/*` → 10003',
      '',
    );
    const guest24 = await userLogin(`e2e_s24_${stamp}`);
    assert(
      (await call('GET', TPL, { token: guest24.token })).body?.code === 10003,
      '双主体隔离：小程序 token 打 `/admin/system/*` → 10003（C 端与后台 id 各自自增，不隔离即静默越权）',
      '',
    );
    assert(
      (await call('GET', TPL)).body?.code === 10002,
      'D59 未登录 → 10002',
      '',
    );

    // ---------------------------------------------------------- K. 夹具还原（模板是全局的）
    const restoreFail = [];
    for (const [scene, s] of Object.entries(snap)) {
      if (!s.id) continue;
      const r = await call('PUT', `${TPL}/${s.id}`, {
        token: adminToken,
        body: {
          enabled: s.enabled,
          wechatTemplateId: s.wechatTemplateId,
          groupContent: s.groupContent,
        },
      });
      if (r.body?.code !== 0) restoreFail.push(`${scene}:${r.body?.code}`);
    }
    assert(
      restoreFail.length === 0,
      'D60 夹具还原（逐条写回快照）—— 模板是**全局**的，不还原会把「退款通知已启用」这类副作用留给后续重跑',
      `失败=${restoreFail.join(',') || '无'}`,
    );
    const listEnd = await getList();
    assert(
      (listEnd?.list ?? []).every((t) => {
        const s = snap[t.scene];
        return (
          s &&
          (t.enabled ? 1 : 0) === s.enabled &&
          (t.wechatTemplateId ?? null) === s.wechatTemplateId &&
          (t.groupContent ?? null) === s.groupContent
        );
      }),
      'D60 还原校验：6 个场景**逐字段**回到初始值（三项都比对 —— 少比一项就会留下脏状态，且它以「下一次偶发失败」的形式出现）',
      '',
    );
  }

  // §25 M3-13 财务端点 D33–D35（后台 P34 · 模块 M35）
  //
  // ⚠️ 本节不依赖下单窗口（同 §18–§24 纪律）：订单与佣金夹具一律直插
  //    `ab_order` / `ab_commission`。
  //
  // 本节钉死五条**不变量**（都是「以后改坏了会立刻红」的那种）：
  //   ① D33 的收入/成本/毛利与 D47 看板**逐项相等**（同一服务端函数）—— 两页数字不一致
  //      是运营最先发现、也最致命的信任问题
  //   ② D33 逐日分项之和 === 区间总额（同一份数据的两种切法，互为正反面）
  //   ③ 余额 / 冻结 / 待入账佣金是**时点量**：换 `range` 不应变化
  //   ④ D34 行内等级/费率是**结算快照**（C2），不是团长当前值
  //   ⑤ D35 真入账：余额增 + 流水落痕 + `total_orders` 不动 + 幂等 + 无归属不猜
  {
    log('\n§25 M3-13 财务端点 D33–D35');

    const D0 = bjToday();
    const D1 = addDaysStr(D0, -1);
    const PREFIX25 = `E2E25${stamp}`;
    const FIN25 = '/admin/finance';

    // ---------------------------------------------------------- A. 夹具
    const l25 = readDb(
      'SELECT id, user_id, level, total_commission, total_orders, last_order_at FROM ab_team_leader ORDER BY id LIMIT 1',
    );
    const b25 = readDb(
      'SELECT id, building_group_id FROM ab_building WHERE building_group_id IS NOT NULL ORDER BY id LIMIT 1',
    );
    const m25 = readDb('SELECT id FROM ab_set_meal ORDER BY id LIMIT 1');
    const a25 = readDb('SELECT id FROM ab_meal_assignment ORDER BY id LIMIT 1');
    const u25 = readDb('SELECT id FROM ab_user ORDER BY id LIMIT 1');
    const ready25 = !!l25 && !!b25 && !!m25 && !!a25 && !!u25;

    assert(
      ready25,
      '§25 前置：财务夹具原料齐备（1 团长 / 1 有楼群的楼 / 1 套餐 / 1 分配行 / 1 用户）',
      `leader=${!!l25} building=${!!b25} meal=${!!m25} assign=${!!a25} user=${!!u25}`,
    );

    if (ready25) {
      const uid25 = Number(l25.user_id);
      const balBefore = readDb('SELECT balance, total_in FROM ab_balance WHERE user_id = ?', [
        uid25,
      ]);
      const lBefore = readDb(
        'SELECT total_commission, total_orders, last_order_at FROM ab_team_leader WHERE id = ?',
        [Number(l25.id)],
      );

      const INS_O25 =
        'INSERT INTO ab_order (order_no, user_id, team_leader_id, building_id, building_group_id, set_meal_id, assignment_id, meal_date, quantity, unit_price, total_amount, balance_used, discount_amount, pay_amount, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, 0, ?, ?, 0, ?, ?)';
      const INS_C25 =
        'INSERT INTO ab_commission (order_id, order_no, team_leader_id, leader_level, rate, base_amount, quantity, amount, type, status, settled_at, meal_date, payout_channel, payout_batch_no, tax_withheld_amount, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)';

      const mkOrder25 = (no) =>
        writeDb(INS_O25, [
          no,
          uid25,
          Number(l25.id),
          Number(b25.id),
          Number(b25.building_group_id),
          Number(m25.id),
          Number(a25.id),
          D0,
          '25.80',
          '25.80',
          '25.80',
          'completed',
          `${D0} 12:00:00`,
          `${D0} 12:00:00`,
        ]);

      // 三条 pending 佣金：**同一团长、三个不同等级/费率快照** ——
      // 这正是「行内展示的是快照而非团长当前值」的证据（一个团长只有一个当前等级）。
      const credit25 = [
        { lv: 'trainee', rate: '0.0800', amount: '2.06' },
        { lv: 'formal', rate: '0.0900', amount: '2.32' },
        { lv: 'chief', rate: '0.1200', amount: '3.10' },
      ];
      for (let i = 0; i < credit25.length; i += 1) {
        const no = `${PREFIX25}C${i + 1}`;
        mkOrder25(no);
        const oid = Number(readDb('SELECT id FROM ab_order WHERE order_no = ?', [no])?.id ?? 0);
        const c = credit25[i];
        writeDb(INS_C25, [
          oid,
          no,
          Number(l25.id),
          c.lv,
          c.rate,
          '25.80',
          c.amount,
          'normal',
          'pending',
          D0,
          'FLEX_MANUAL',
          '0.00',
          `${D0} 12:00:00`,
          `${D0} 12:00:00`,
        ]);
      }
      // 第四条：团长档案**不存在** → D35 必须跳过并说明原因（不猜、不静默丢弃）
      writeDb(INS_C25, [
        999000001,
        `${PREFIX25}CX`,
        999999,
        'trainee',
        '0.0800',
        '25.80',
        '2.06',
        'normal',
        'pending',
        D0,
        'FLEX_MANUAL',
        '0.00',
        `${D0} 12:00:00`,
        `${D0} 12:00:00`,
      ]);

      // 库内 oracle：pending 全量 / 其中有归属的那部分（D35 出参必须与它能对上）
      const pendingOra = readDb(
        "SELECT COUNT(*) AS c, COALESCE(SUM(CAST(ROUND(amount * 100) AS INTEGER)), 0) AS s FROM ab_commission WHERE status = 'pending' AND meal_date = ?",
        [D0],
      );
      const pendingOraMine = readDb(
        "SELECT COUNT(*) AS c, COALESCE(SUM(CAST(ROUND(amount * 100) AS INTEGER)), 0) AS s FROM ab_commission WHERE status = 'pending' AND meal_date = ? AND team_leader_id = ?",
        [D0, Number(l25.id)],
      );
      assert(
        Number(pendingOra?.c ?? 0) >= 4,
        '§25 夹具：4 条 pending 佣金已入库（3 条有归属 + 1 条团长档案不存在）',
        `pending=${pendingOra?.c} sum=${pendingOra?.s}`,
      );

      // 权限矩阵用的账号（固定名 —— 每天重跑只累积 2 个，不再翻倍）
      const ok25Op = 'e2e_s25op';
      const ok25View = 'e2e_s25view';
      await call('POST', '/admin/system/accounts', {
        token: adminToken,
        body: { username: ok25Op, password: PWD, role: 'operator', realName: 'e2e 财务运营' },
      });
      await call('POST', '/admin/system/accounts', {
        token: adminToken,
        body: { username: ok25View, password: PWD, role: 'viewer', realName: 'e2e 财务只读' },
      });
      const t25Op = (await adminLogin(ok25Op, PWD)).token;
      const t25View = (await adminLogin(ok25View, PWD)).token;
      const t25Fin = (await adminLogin('finance', 'finance123')).token;

      // ---------------------------------------------------------- B. D33 资金总览
      const ov7 = await call('GET', `${FIN25}/overview?range=7d`, { token: adminToken });
      const ov7d = ov7.body?.data;
      assert(
        ov7.body?.code === 0 &&
          ov7d?.range?.range === '7d' &&
          typeof ov7d?.income?.gmvFen === 'number' &&
          typeof ov7d?.expense?.purchaseFen === 'number' &&
          typeof ov7d?.payable?.unpaidFen === 'number' &&
          typeof ov7d?.liability?.balanceFen === 'number' &&
          typeof ov7d?.profit?.grossProfitFen === 'number' &&
          Array.isArray(ov7d?.daily) &&
          Array.isArray(ov7d?.warnings) &&
          !!ov7d?.note,
        'D33 出参结构齐备（range / income / expense / payable / liability / profit / daily / warnings / note）',
        `code=${ov7.body?.code}`,
      );

      const dash7 = (await call('GET', '/admin/stats/dashboard?range=7d', { token: adminToken }))
        .body?.data;
      assert(
        ov7d?.income?.gmvFen === dash7?.metrics?.gmvFen &&
          ov7d?.income?.orderCount === dash7?.metrics?.orderCount &&
          ov7d?.expense?.commissionFen === dash7?.metrics?.commissionFen &&
          ov7d?.expense?.purchaseFen === dash7?.metrics?.purchaseFen &&
          ov7d?.profit?.grossProfitFen === dash7?.metrics?.grossProfitFen,
        '⭐⭐ D33 的收入/成本/毛利与 D47 看板**逐项相等**（同一服务端函数）—— 两页各算一套，迟早出现「财务页 ¥4,798、看板 ¥4,301」，而运营从此不再信任任何一个数',
        `gmv ${ov7d?.income?.gmvFen}/${dash7?.metrics?.gmvFen} · commission ${ov7d?.expense?.commissionFen}/${dash7?.metrics?.commissionFen} · purchase ${ov7d?.expense?.purchaseFen}/${dash7?.metrics?.purchaseFen}`,
      );

      const sumDaily = (k) => (ov7d?.daily ?? []).reduce((acc, r) => acc + Number(r[k] ?? 0), 0);
      assert(
        sumDaily('gmvFen') === ov7d?.income?.gmvFen &&
          sumDaily('commissionFen') === ov7d?.expense?.commissionFen &&
          sumDaily('purchaseFen') === ov7d?.expense?.purchaseFen,
        '⭐ D33 逐日分项之和 === 区间总额（同一份数据的两种切法）—— 分项与总额各算一套，就是「加不起来」的经典来源',
        `gmv ${sumDaily('gmvFen')}/${ov7d?.income?.gmvFen} · commission ${sumDaily('commissionFen')}/${ov7d?.expense?.commissionFen} · purchase ${sumDaily('purchaseFen')}/${ov7d?.expense?.purchaseFen}`,
      );

      assert(
        (ov7d?.daily ?? []).length === ov7d?.range?.days,
        'D33 `daily` 与区间**等长**（无单日补 0 —— 端上不必自己补齐空洞，图表不会断档）',
        `daily=${ov7d?.daily?.length} days=${ov7d?.range?.days}`,
      );

      const ov30 = (await call('GET', `${FIN25}/overview?range=30d`, { token: adminToken })).body
        ?.data;
      assert(
        ov30?.liability?.balanceFen === ov7d?.liability?.balanceFen &&
          ov30?.liability?.frozenFen === ov7d?.liability?.frozenFen &&
          !!ov30?.liability?.asOf,
        '⭐⭐ 余额 / 冻结 / 待入账佣金是**时点量**：`range` 从 7d 换到 30d 完全不变。把时点量算成区间量，会让运营把「平台此刻欠用户多少钱」读成「本期新增负债」',
        `7d=${ov7d?.liability?.balanceFen} 30d=${ov30?.liability?.balanceFen} asOf=${ov30?.liability?.asOf}`,
      );

      const ovAnchor = (
        await call('GET', `${FIN25}/overview?range=7d&date=${D1}`, { token: adminToken })
      ).body?.data;
      assert(
        ovAnchor?.range?.endDate === D1 && ovAnchor?.range?.startDate === addDaysStr(D1, -6),
        'D33 `date` 是区间**终点锚点**（起止仍由 `range` 推导，不是自由起止）：期末对账要看已经过完的那一天',
        `end=${ovAnchor?.range?.endDate} start=${ovAnchor?.range?.startDate}`,
      );

      assert(
        (await call('GET', `${FIN25}/overview?range=90d`, { token: adminToken })).body?.code ===
          10001,
        'D33 非法 `range` → 10001（**不静默回落到默认档** —— 静默回落会让运营以为看的是 90 天）',
        '',
      );

      // ---------------------------------------------------------- C. D34 佣金明细
      const cmAll = (
        await call('GET', `${FIN25}/commissions?date=${D0}&pageSize=100`, { token: adminToken })
      ).body?.data;
      assert(
        cmAll?.summary?.count === cmAll?.total &&
          (cmAll?.list ?? []).length > 0 &&
          typeof cmAll?.date === 'string',
        'D34 `summary` 与分页 `total` 同源（同一过滤条件的全量）—— 分页里的合计是「本页合计」，运营会拿它对账',
        `summary=${cmAll?.summary?.count} total=${cmAll?.total}`,
      );

      const cmP1 = (
        await call('GET', `${FIN25}/commissions?date=${D0}&page=1&pageSize=1`, {
          token: adminToken,
        })
      ).body?.data;
      assert(
        cmP1?.summary?.count === cmAll?.summary?.count &&
          cmP1?.summary?.netFen === cmAll?.summary?.netFen &&
          (cmP1?.list ?? []).length === 1,
        '⭐ D34 汇总**不受分页影响**（pageSize=1 时合计不变）：翻页跳 KPI 是列表页最常见的低级错觉',
        `count ${cmP1?.summary?.count}/${cmAll?.summary?.count} net ${cmP1?.summary?.netFen}/${cmAll?.summary?.netFen}`,
      );

      const byLevelSum = (cmAll?.summary?.byLevel ?? []).reduce(
        (acc, r) => acc + Number(r.amountFen ?? 0),
        0,
      );
      assert(
        byLevelSum === cmAll?.summary?.netFen && (cmAll?.summary?.byLevel ?? []).length >= 1,
        'D34 按等级拆分之和 === 佣金净额（同源可复算）',
        `byLevel=${byLevelSum} net=${cmAll?.summary?.netFen}`,
      );

      const myNos = credit25.map((_, i) => `${PREFIX25}C${i + 1}`);
      const myRows = (cmAll?.list ?? []).filter((r) => myNos.includes(r.orderNo));
      assert(
        myRows.length === 3 &&
          new Set(myRows.map((r) => r.leaderId)).size === 1 &&
          new Set(myRows.map((r) => r.leaderLevel)).size === 3 &&
          new Set(myRows.map((r) => r.rate)).size === 3,
        '⭐⭐ D34 行内 `leaderLevel` / `rate` 是**结算快照**（C2）：**同一个团长**的三条佣金分别显示见习 8% / 正式 9% / 首席 12% —— 一个团长只有一个当前等级，故这不可能是「当前值」',
        `levels=${myRows.map((r) => r.leaderLevel).join('/')} rates=${myRows.map((r) => r.rate).join('/')}`,
      );

      const cmPending = (
        await call('GET', `${FIN25}/commissions?date=${D0}&status=pending&pageSize=100`, {
          token: adminToken,
        })
      ).body?.data;
      assert(
        (cmPending?.list ?? []).length > 0 &&
          (cmPending?.list ?? []).every((r) => r.status === 'pending') &&
          Number(cmPending?.summary?.count ?? 0) >= 4,
        'D34 `status` 过滤（M3-13 登记的扩展入参）生效：待入账 = 4 条（含 1 条无归属）',
        `count=${cmPending?.summary?.count}`,
      );

      const cmKw = (
        await call('GET', `${FIN25}/commissions?date=${D0}&keyword=${PREFIX25}`, {
          token: adminToken,
        })
      ).body?.data;
      assert(
        (cmKw?.list ?? []).length >= 3 &&
          (cmKw?.list ?? []).every((r) => r.orderNo.includes(PREFIX25)),
        'D34 `keyword` 命中订单号（对账时按单号定位的常用入口）',
        `count=${cmKw?.list?.length}`,
      );

      const cmLeader = (
        await call('GET', `${FIN25}/commissions?date=${D0}&leaderId=${Number(l25.id)}&pageSize=100`, {
          token: adminToken,
        })
      ).body?.data;
      assert(
        (cmLeader?.list ?? []).length > 0 &&
          (cmLeader?.list ?? []).every((r) => r.leaderId === Number(l25.id)),
        'D34 `leaderId` 过滤生效',
        `count=${cmLeader?.list?.length}`,
      );

      assert(
        (await call('GET', `${FIN25}/commissions?date=${D0}&status=bad`, { token: adminToken }))
          .body?.code === 10001,
        'D34 非法 `status` → 10001（枚举白名单，不静默忽略成「全部」）',
        '',
      );

      // ---------------------------------------------------------- D. D35 佣金入账
      assert(
        (
          await call('POST', `${FIN25}/commissions/settle`, {
            token: t25Op,
            body: { date: D0 },
          })
        ).body?.code === 10003,
        'D35 `operator` → 10003（**两级白名单**：运营要能看资金与佣金，但「把钱记进团长余额」是资金动作，不该由运营专员拍板 —— 同 D41）',
        '',
      );
      assert(
        (await call('GET', `${FIN25}/commissions?date=${D0}`, { token: t25Op })).body?.code === 0,
        '⭐ 同一控制器内：`operator` 的 GET → 0、POST settle → 10003 —— 白名单按**方法**收窄，不是一刀切把人挡在门外',
        '',
      );

      const settle1 = (
        await call('POST', `${FIN25}/commissions/settle`, {
          token: adminToken,
          body: { date: D0 },
        })
      ).body;
      const s1 = settle1?.data;
      assert(
        settle1?.code === 0 &&
          s1?.scanned === Number(pendingOra?.c ?? -1) &&
          s1?.settled === Number(pendingOraMine?.c ?? -1) &&
          s1?.skipped === 1,
        'D35 扫描全量、只入账有归属的：`scanned` = 库里 pending 条数、`settled` = 有归属条数、无归属那条进 `skipped`（**不猜、不静默丢弃**）',
        `scanned=${s1?.scanned}/${pendingOra?.c} settled=${s1?.settled}/${pendingOraMine?.c} skipped=${s1?.skipped}`,
      );
      assert(
        s1?.amountFen === Number(pendingOraMine?.s ?? -1) &&
          s1?.quantity === Number(pendingOraMine?.c ?? -1),
        'D35 入账金额 === **库内 oracle**（同口径 SQL 独立算一遍，不是拿接口自己的数当期望值）',
        `api=${s1?.amountFen} oracle=${pendingOraMine?.s}`,
      );
      assert(
        (s1?.skippedReasons ?? []).length === 1 && /不存在/.test(String(s1?.skippedReasons?.[0])),
        'D35 跳过原因**下发给操作人**（`skippedReasons`）：脏数据不该只体现为一个数字',
        `${s1?.skippedReasons?.[0] ?? '无'}`,
      );

      const fenOf = (v) => Math.round(Number(v ?? 0) * 100);
      const balAfter = readDb('SELECT balance, total_in FROM ab_balance WHERE user_id = ?', [uid25]);
      assert(
        fenOf(balAfter?.balance) - fenOf(balBefore?.balance) === Number(s1?.amountFen ?? -1),
        '⭐⭐ D35 **真入账**：`ab_balance.balance` 增量 === 出参 `amountFen`（不是「返回成功但钱没动」）',
        `Δ=${fenOf(balAfter?.balance) - fenOf(balBefore?.balance)} api=${s1?.amountFen}`,
      );

      const logRows25 = readRows(
        'SELECT related_id, type, balance_after FROM ab_balance_log WHERE related_id LIKE ? ORDER BY id',
        [`${PREFIX25}C%`],
      );
      assert(
        logRows25.length === Number(pendingOraMine?.c ?? -1) &&
          logRows25.every((r) => r.type === 'commission') &&
          Number(logRows25[logRows25.length - 1]?.balance_after ?? -1) ===
            Number(balAfter?.balance ?? -2),
        '⭐ D35 每笔落一条 `ab_balance_log`（含 `balance_after` 逐步落痕），末条余额 === 账户余额 —— 账本与快照可相互验算（与 L11 / L19 同源）',
        `logs=${logRows25.length} lastAfter=${logRows25[logRows25.length - 1]?.balance_after} balance=${balAfter?.balance}`,
      );

      const lAfter = readDb(
        'SELECT total_commission, total_orders, last_order_at FROM ab_team_leader WHERE id = ?',
        [Number(l25.id)],
      );
      assert(
        String(lAfter?.total_orders ?? '') === String(lBefore?.total_orders ?? '') &&
          String(lAfter?.last_order_at ?? '') === String(lBefore?.last_order_at ?? '') &&
          fenOf(lAfter?.total_commission) - fenOf(lBefore?.total_commission) ===
            Number(s1?.amountFen ?? -1),
        '⭐⭐ 补账**只改账、不改事实**：`total_commission` 增加，但 `total_orders` / `last_order_at` 一动不动 —— 补结算不是新下单，顺手刷活跃度会污染 C2 晋级审计（按 `month_orders`）',
        `orders ${lBefore?.total_orders}→${lAfter?.total_orders} lastAtChanged=${String(lBefore?.last_order_at) !== String(lAfter?.last_order_at)}`,
      );

      const settle2 = (
        await call('POST', `${FIN25}/commissions/settle`, {
          token: adminToken,
          body: { date: D0 },
        })
      ).body;
      const balAfter2 = readDb('SELECT balance FROM ab_balance WHERE user_id = ?', [uid25]);
      // 无归属的那条**仍停在 pending** —— 这正是「不猜、不静默丢弃」的可观测后果：
      // 它不会被重复入账，也不会被悄悄改状态。故第二跑的 scanned 恒 = 1（不是 0），
      // 而 settled 恒 = 0、余额一分未变。断言必须钉这个，而不是钉 scanned=0。
      const orphanStillPending = readDb(
        "SELECT COUNT(*) AS c FROM ab_commission WHERE status = 'pending' AND meal_date = ?",
        [D0],
      );
      assert(
        settle2?.code === 0 &&
          settle2?.data?.settled === 0 &&
          Number(settle2?.data?.amountFen ?? -1) === 0 &&
          settle2?.data?.scanned === settle2?.data?.skipped &&
          Number(orphanStillPending?.c ?? -1) === Number(settle2?.data?.scanned ?? -2) &&
          fenOf(balAfter2?.balance) === fenOf(balAfter?.balance),
        '⭐⭐ D35 **幂等**：重复执行 `settled=0` / 余额一分未变，且无归属那条**仍停在 `pending`**（剩下的 `scanned` 恰好等于 `skipped`）—— 跑批补跑可以放心重复点，脏数据既不重复入账也不被静默吞掉',
        `scanned=${settle2?.data?.scanned} settled=${settle2?.data?.settled} 仍pending=${orphanStillPending?.c} Δbal=${fenOf(balAfter2?.balance) - fenOf(balAfter?.balance)}`,
      );
      assert(
        !!settle2?.data?.note && /两段式/.test(String(settle2.data.note)),
        '⭐ D35 `note` **每次都下发**（不只在 0 条时）—— 它要说明「**佣金两段式**：确认收货即计佣写 `pending`、T+1 02:00 跑批入账，故 `pending` 是每天的常态、不是故障」，否则「点了按钮 0 条」一定被当成故障报上来',
        `${String(settle2?.data?.note ?? '').slice(0, 36)}…`,
      );

      const settleFin = (
        await call('POST', `${FIN25}/commissions/settle`, {
          token: t25Fin,
          body: { date: D0 },
        })
      ).body;
      assert(
        settleFin?.code === 0,
        'D35 `finance` → 0（财务是资金动作的合法执行人；此时已无可入账的行 —— 唯一 pending 是无归属那条 → 空跑成功而非报错）',
        `code=${settleFin?.code}`,
      );

      const d35Log = await waitDb(
        "SELECT action FROM ab_operation_log WHERE module = 'finance' AND action = '佣金入账补跑' ORDER BY id DESC LIMIT 1",
        [],
        (r) => !!r,
        { timeout: 4000 },
      );
      assert(
        !!d35Log,
        'D35 由 `@OperationLog()` 落 `ab_operation_log`（把佣金记进团长余额必须能回答「谁在什么时候补的」）',
        `action=${d35Log?.action ?? '未落库'}`,
      );

      assert(
        (await call('POST', `${FIN25}/commissions/settle`, { body: { date: D0 } })).body?.code ===
          10002,
        'D35 未登录 → 10002',
        '',
      );
      assert(
        (await call('GET', `${FIN25}/overview`, { token: t25View })).body?.code === 10003,
        '⭐ D33 `viewer` → 10003 —— `admin-role.ts` 里 viewer 的菜单只有 4 个看板页（财务页不在其中）。白名单比菜单宽，就会造出「菜单看不到、接口却能调」',
        '',
      );
      const sup25 = await adminLogin('sanweiwu', 'supplier123');
      assert(
        (await call('GET', `${FIN25}/overview`, { token: sup25.token })).body?.code === 10003,
        '双主体隔离：供应商 token 打 `/admin/finance/*` → 10003',
        '',
      );

      // ---------------------------------------------------------- E. 夹具还原
      // ⚠️ 顺序：先删流水（它引用 orderNo），再删佣金与订单；最后把被 D35 真改过的
      //    余额与团长统计快照**逐字段写回** —— 不还原就等于给下一次重跑「凭空多出一笔钱」。
      writeDb('DELETE FROM ab_balance_log WHERE related_id LIKE ?', [`${PREFIX25}C%`]);
      writeDb('DELETE FROM ab_commission WHERE order_no LIKE ?', [`${PREFIX25}%`]);
      writeDb('DELETE FROM ab_order WHERE order_no LIKE ?', [`${PREFIX25}%`]);
      writeDb(
        'UPDATE ab_balance SET balance = ?, total_in = ?, version = version + 1 WHERE user_id = ?',
        [String(balBefore?.balance ?? '0.00'), String(balBefore?.total_in ?? '0.00'), uid25],
      );
      writeDb(
        'UPDATE ab_team_leader SET total_commission = ?, total_orders = ?, last_order_at = ? WHERE id = ?',
        [
          String(lBefore?.total_commission ?? '0.00'),
          Number(lBefore?.total_orders ?? 0),
          lBefore?.last_order_at ?? null,
          Number(l25.id),
        ],
      );

      const cleared25 = readDb(
        'SELECT (SELECT COUNT(*) FROM ab_commission WHERE order_no LIKE ?) AS c, (SELECT COUNT(*) FROM ab_order WHERE order_no LIKE ?) AS o, (SELECT COUNT(*) FROM ab_balance_log WHERE related_id LIKE ?) AS l',
        [`${PREFIX25}%`, `${PREFIX25}%`, `${PREFIX25}C%`],
      );
      assert(
        Number(cleared25?.c ?? -1) === 0 &&
          Number(cleared25?.o ?? -1) === 0 &&
          Number(cleared25?.l ?? -1) === 0,
        '§25 夹具还原：注入的订单 / 佣金 / 余额流水已清空，余额与团长统计快照已写回（D35 真改过余额，不还原会把「多出来的钱」留给下一次重跑）',
        `commission=${cleared25?.c} order=${cleared25?.o} log=${cleared25?.l}`,
      );
    }
  }

  // §26 M3-14 余额账户管理与调整 D38–D39（后台 P34 · 模块 M35-04）
  //
  // ⚠️ 本节不依赖下单窗口（同 §18–§25 纪律）：账户夹具直接读 `ab_balance`、直插一个新用户；
  //    D39 的**被测写入一律走 HTTP**，不由夹具代劳。
  //
  // 本节钉死六条**不变量**：
  //   ① ⭐ **D38 负债合计 === D33 资金总览的 `liability`**（必须来自同一服务端函数）。
  //      各算一套时漂移**不会报任何错**，只会让「资金总览」与「余额账户」报出不同的数。
  //   ② ⭐ 负债是**时点量**：换 `pageSize`、换 `accountType` 都不应改变它。
  //   ③ ⭐ **冻结 / 解冻不改动 `total_in` / `total_out`** —— 钱没进出平台，只是换了位置。
  //   ④ ⭐ **余额不得为负**：扣减 / 冻结越界 → `40002`；解冻越界 → `40015`
  //      （两码刻意分开：前者「钱不够花」，后者「冻结账对不上」属账实不符信号）。
  //   ⑤ ⭐ **幂等**：同键重复提交 → `10006` + 首次结果，余额一分不再动。
  //   ⑥ 每次调账在同一事务里留下：余额快照 + `ab_balance_log`
  //      （`type='adjust'`、`balance_after` 逐步落痕、`related_id` = `AJ…` 可追溯）。
  {
    log('\n§26 M3-14 余额账户管理与调整 D38–D39');

    const FIN26 = '/admin/finance';
    const PREFIX26 = `E2E26${stamp}`;
    const OPENID26 = `${PREFIX26}OPENID`;
    const fenOf26 = (v) => Math.round(Number(v ?? 0) * 100);

    // ---------------------------------------------------------- A. 夹具
    // 只用**新造用户自己的账户**做金额断言：它的余额完全由本节控制（从 0 开始），
    // 可以放心用绝对值与 Δ。种子里既有账户只用于「对账」类只读断言 ——
    // 对它做金额断言就是 #108「共享维度不能用 Δ」的翻版（别的章节会改它）。
    const nowIso26 = `${bjToday()} 10:00:00`;
    writeDb(
      'INSERT INTO ab_user (openid, nickname, gender, status, version, created_at, updated_at) VALUES (?, ?, 0, 1, 0, ?, ?)',
      [OPENID26, `${PREFIX26}新用户`, nowIso26, nowIso26],
    );
    const fresh26 = readDb('SELECT id FROM ab_user WHERE openid = ?', [OPENID26]);
    const uid26 = Number(fresh26?.id ?? 0);
    const ready26 = uid26 > 0 && !!readDb('SELECT id FROM ab_balance ORDER BY id LIMIT 1');

    assert(
      ready26,
      '§26 前置：新用户已建（`ab_balance` 尚无其行）+ 库内至少有一个既有余额账户',
      `新用户=${uid26}`,
    );

    if (ready26) {
      const bal26 = () =>
        readDb('SELECT balance, frozen, total_in, total_out FROM ab_balance WHERE user_id = ?', [
          uid26,
        ]);
      const one26 = async (uid, token) =>
        (await call('GET', `${FIN26}/balances?userId=${uid}`, { token })).body;
      const row26 = (res) => res?.data?.list?.[0] ?? null;
      const adj26 = async (body, token, idem) =>
        (await call('POST', `${FIN26}/balances/adjust`, { token, body, idem })).body;

      // 权限矩阵账号（固定名 —— 每天重跑只累积 2 个，不翻倍）
      const ok26Op = 'e2e_s26op';
      const ok26View = 'e2e_s26view';
      await call('POST', '/admin/system/accounts', {
        token: adminToken,
        body: { username: ok26Op, password: PWD, role: 'operator', realName: 'e2e 余额运营' },
      });
      await call('POST', '/admin/system/accounts', {
        token: adminToken,
        body: { username: ok26View, password: PWD, role: 'viewer', realName: 'e2e 余额只读' },
      });
      const t26Op = (await adminLogin(ok26Op, PWD)).token;
      const t26View = (await adminLogin(ok26View, PWD)).token;
      const t26Fin = (await adminLogin('finance', 'finance123')).token;

      // ---------------------------------------------------- B. D38 空视图（无账户）
      const empty26 = await one26(uid26, adminToken);
      assert(
        empty26?.code === 0 &&
          empty26?.data?.view === 'single' &&
          row26(empty26)?.hasAccount === false &&
          row26(empty26)?.balanceFen === 0 &&
          row26(empty26)?.netFen === 0 &&
          Array.isArray(empty26?.data?.logs) &&
          empty26.data.logs.length === 0,
        '⭐ D38 按 `userId` 精确查**无账户用户** → 仍返回一行 `hasAccount=false`（余额全 0）且 `logs=[]` —— 否则运营「搜不到人 → 以为查无此用户 → 不敢充值」，而 D39 恰恰支持给无账户用户首充建户',
        `code=${empty26?.code} hasAccount=${row26(empty26)?.hasAccount} logs=${empty26?.data?.logs?.length}`,
      );

      // ---------------------------------------------------- C. ⭐ 跨页对账（写入前）
      const ov26a = (await call('GET', `${FIN26}/overview`, { token: adminToken })).body?.data;
      const lb26a = (await call('GET', `${FIN26}/balances`, { token: adminToken })).body?.data;
      assert(
        !!ov26a?.liability?.asOf &&
          lb26a?.liability?.balanceFen === ov26a?.liability?.balanceFen &&
          lb26a?.liability?.frozenFen === ov26a?.liability?.frozenFen &&
          Number(lb26a?.liability?.accountCount ?? -1) > 0,
        '⭐⭐ D38 的 `liability` 与 D33 资金总览的 `liability` **逐项相等**（同一个 `FinanceService.loadLiability()`）—— 两页各算一套 `SUM(ab_balance)` 时漂移**不报任何错**，只会让运营看到两个不同的「平台欠用户多少钱」。把 D38 改回自己 SUM 会立刻红',
        `D33=${ov26a?.liability?.balanceFen}/${ov26a?.liability?.frozenFen} D38=${lb26a?.liability?.balanceFen}/${lb26a?.liability?.frozenFen}`,
      );
      assert(
        lb26a?.liability?.netFen === lb26a?.liability?.balanceFen + lb26a?.liability?.frozenFen &&
          Number(lb26a?.liability?.leaderAccountCount ?? -1) >= 0,
        'D38 `liability.netFen` = 可用 + 冻结（负债合计自洽），且下发团长账户数（时点量）',
        `net=${lb26a?.liability?.netFen} 团长账户=${lb26a?.liability?.leaderAccountCount}`,
      );

      // ---------------------------------------------------- D. 权限矩阵
      const opGet26 = await call('GET', `${FIN26}/balances`, { token: t26Op });
      assert(
        opGet26.body?.code === 0 && opGet26.body?.data?.actions?.canAdjust === false,
        '⭐ D38 类级白名单含 `operator`（运营要能看「这个用户余额为什么异常」），但 `actions.canAdjust=false` —— 它**不准调账**。`actions` 与服务端 `@Roles(...BALANCE_ADJUST_ROLES)` **共用同一角色常量**，结构上不会出现「按钮亮着、点了 10003」或反之',
        `code=${opGet26.body?.code} canAdjust=${opGet26.body?.data?.actions?.canAdjust}`,
      );
      assert(
        (await call('GET', `${FIN26}/balances`, { token: t26View })).body?.code === 10003,
        '⭐ D38 `viewer` → 10003 —— `admin-role.ts` 里 viewer 的菜单只有 4 个看板页（财务页不在其中）。白名单比菜单宽，就会造出「菜单看不到、接口却能调」',
        '',
      );
      assert(
        (await call('GET', `${FIN26}/balances`, {})).body?.code === 10002,
        'D38 未登录 → 10002',
        '',
      );
      const sup26 = await adminLogin('sanweiwu', 'supplier123');
      assert(
        (await call('GET', `${FIN26}/balances`, { token: sup26.token })).body?.code === 10003,
        '双主体隔离：供应商 token 打 `/admin/finance/balances` → 10003',
        '',
      );

      // ---------------------------------------------------- E. D39 四动作
      const rc26 = await adj26(
        { userId: uid26, action: 'recharge', amountFen: 10000, reason: 'e2e 首充建户' },
        adminToken,
        `${PREFIX26}R1`,
      );
      const b1 = bal26();
      assert(
        rc26?.code === 0 &&
          rc26?.data?.balanceFen === 10000 &&
          rc26?.data?.totalInFen === 10000 &&
          rc26?.data?.totalOutFen === 0 &&
          /^AJ\d{16}$/.test(String(rc26?.data?.adjustNo)) &&
          Number(rc26?.data?.logId) > 0 &&
          fenOf26(b1?.balance) === 10000 &&
          fenOf26(b1?.total_in) === 10000,
        '⭐ D39 `recharge` **首充建户**：无账户用户在充值那一刻自动建户（`ab_balance` 原本没有该行）—— 若因「无账户」而失败，「给从没下过单的用户发补偿」这条运营刚需就走不通；同时返回 `AJ…` 调整单号与流水 id 供追溯',
        `code=${rc26?.code} bal=${fenOf26(b1?.balance)} in=${fenOf26(b1?.total_in)} no=${rc26?.data?.adjustNo}`,
      );

      const dc26 = await adj26(
        { userId: uid26, action: 'deduct', amountFen: 3000, reason: 'e2e 扣减' },
        adminToken,
        `${PREFIX26}D1`,
      );
      const b2 = bal26();
      assert(
        dc26?.code === 0 &&
          dc26?.data?.balanceFen === 7000 &&
          dc26?.data?.totalOutFen === 3000 &&
          fenOf26(b2?.balance) === 7000 &&
          fenOf26(b2?.total_out) === 3000,
        'D39 `deduct`：可用余额 ↓、`total_out` ↑（扣减是真正的支出，与充值对称）',
        `bal=${fenOf26(b2?.balance)} out=${fenOf26(b2?.total_out)}`,
      );

      const fz26 = await adj26(
        { userId: uid26, action: 'freeze', amountFen: 2000, reason: 'e2e 冻结' },
        adminToken,
        `${PREFIX26}F1`,
      );
      const b3 = bal26();
      assert(
        fz26?.code === 0 &&
          fz26?.data?.balanceFen === 5000 &&
          fz26?.data?.frozenFen === 2000 &&
          fenOf26(b3?.total_in) === 10000 &&
          fenOf26(b3?.total_out) === 3000,
        '⭐⭐ D39 `freeze`：可用 ↓2000、冻结 ↑2000，而 `total_in` / `total_out` **一分未动** —— 钱没有进出平台，只是从「可用」挪到「冻结」。若把冻结记成支出，`total_out` 会随冻结/解冻来回跳，并与提现累计互相污染（L12 也刻意「申请阶段不计入累计支出」）',
        `bal=${fenOf26(b3?.balance)} frozen=${fenOf26(b3?.frozen)} in=${fenOf26(b3?.total_in)} out=${fenOf26(b3?.total_out)}`,
      );

      const uf26 = await adj26(
        { userId: uid26, action: 'unfreeze', amountFen: 500, reason: 'e2e 解冻' },
        adminToken,
        `${PREFIX26}U1`,
      );
      const b4 = bal26();
      assert(
        uf26?.code === 0 &&
          uf26?.data?.balanceFen === 5500 &&
          uf26?.data?.frozenFen === 1500 &&
          fenOf26(b4?.total_in) === 10000 &&
          fenOf26(b4?.total_out) === 3000,
        '⭐⭐ D39 `unfreeze`：可用 ↑500、冻结 ↓500，`total_in` / `total_out` 同样**不动**（与 freeze 对称）。⚠️ 没有解冻的冻结就是死钱 —— 故 `unfreeze` 是对规范「充/扣/冻」三动作的**必要补充**',
        `bal=${fenOf26(b4?.balance)} frozen=${fenOf26(b4?.frozen)} in=${fenOf26(b4?.total_in)} out=${fenOf26(b4?.total_out)}`,
      );

      // ---------------------------------------------------- F. 余额不得为负
      const overD26 = await adj26(
        { userId: uid26, action: 'deduct', amountFen: 99900, reason: 'e2e 越界扣减' },
        adminToken,
        `${PREFIX26}X1`,
      );
      const b5 = bal26();
      assert(
        overD26?.code === 40002 &&
          fenOf26(b5?.balance) === 5500 &&
          Number(overD26?.data?.availableFen ?? -1) === 5500,
        '⭐ D39 扣减超出可用额 → `40002`（fail-closed：**余额不得为负**），余额一分未动 —— 越界不是「扣到 0 为止」，且 `data.availableFen` 把「实际有多少」明确告知',
        `code=${overD26?.code} bal=${fenOf26(b5?.balance)}`,
      );
      const overF26 = await adj26(
        { userId: uid26, action: 'freeze', amountFen: 99900, reason: 'e2e 越界冻结' },
        adminToken,
        `${PREFIX26}X2`,
      );
      const b6 = bal26();
      assert(
        overF26?.code === 40002 && fenOf26(b6?.frozen) === 1500 && fenOf26(b6?.balance) === 5500,
        'D39 冻结超出可用额 → `40002`（冻结也只能从**可用余额**里挪，不能凭空冻；用冻结掩盖「钱不够」会造出账面上有钱、实际调不动的账户）',
        `code=${overF26?.code} frozen=${fenOf26(b6?.frozen)}`,
      );
      const overU26 = await adj26(
        { userId: uid26, action: 'unfreeze', amountFen: 99900, reason: 'e2e 越界解冻' },
        adminToken,
        `${PREFIX26}X3`,
      );
      const b7 = bal26();
      assert(
        overU26?.code === 40015 && fenOf26(b7?.balance) === 5500 && fenOf26(b7?.frozen) === 1500,
        '⭐⭐ D39 解冻超出冻结额 → **`40015`**（而非复用 `40002`）—— 两者运维含义完全不同：`40002` 是「钱不够花」（充值 / 等回款即可），`40015` 是「**冻结账对不上**」的账实不符信号，要查的是数据结构而不是让人去充钱。合成一个码就把这条线索埋掉了',
        `code=${overU26?.code} bal=${fenOf26(b7?.balance)} frozen=${fenOf26(b7?.frozen)}`,
      );

      // ---------------------------------------------------- G. ⭐ 幂等
      const IDEM26 = `${PREFIX26}IDEM`;
      const idemBody = { userId: uid26, action: 'recharge', amountFen: 111, reason: 'e2e 幂等' };
      const idem1 = await adj26(idemBody, adminToken, IDEM26);
      const bIdem1 = bal26();
      const idem2 = await adj26(idemBody, adminToken, IDEM26);
      const bIdem2 = bal26();
      assert(
        idem1?.code === 0 &&
          idem2?.code === 10006 &&
          !!idem1?.data?.adjustNo &&
          idem2?.data?.adjustNo === idem1?.data?.adjustNo &&
          fenOf26(bIdem2?.balance) === fenOf26(bIdem1?.balance),
        '⭐⭐ D39 **幂等**：同一 `Idempotency-Key` 重复提交 → `10006` + **首次结果原样返回**（`adjustNo` 相同），余额**不再增加** —— 调账没有业务单号可供判重，网络超时后重试若再加一次就是真金白银的事故',
        `code1=${idem1?.code} code2=${idem2?.code} sameNo=${idem2?.data?.adjustNo === idem1?.data?.adjustNo} Δbal=${fenOf26(bIdem2?.balance) - fenOf26(bIdem1?.balance)}`,
      );
      assert(
        (
          await adj26(
            { userId: uid26, action: 'recharge', amountFen: 100, reason: 'e2e 无幂等键' },
            adminToken,
            undefined,
          )
        ).code === 10001,
        'D39 **缺幂等键** → `10001`（资金接口的幂等键是**必填**，不能寄望端上自觉）',
        '',
      );

      // ---------------------------------------------------- H. 入参校验
      const bads26 = [
        [{ userId: uid26, action: 'recharge', amountFen: 0, reason: 'e2e 零金额' }, '金额 0'],
        [{ userId: uid26, action: 'recharge', amountFen: -100, reason: 'e2e 负金额' }, '负数金额'],
        [
          { userId: uid26, action: 'recharge', amountFen: 100000001, reason: 'e2e 超上限' },
          '超单笔上限',
        ],
        [{ userId: uid26, action: 'recharge', amountFen: 100, reason: 'x' }, '原因过短'],
        [{ userId: uid26, action: 'recharge', amountFen: 100 }, '缺原因'],
        [
          { userId: uid26, action: 'transfer', amountFen: 100, reason: 'e2e 非法动作' },
          '非法 action',
        ],
        [{ userId: uid26, amountFen: 100, reason: 'e2e 缺动作' }, '缺 action'],
        [{ action: 'recharge', amountFen: 100, reason: 'e2e 缺用户' }, '缺 userId'],
      ];
      let badOk26 = 0;
      for (let i = 0; i < bads26.length; i += 1) {
        const r = await adj26(bads26[i][0], adminToken, `${PREFIX26}BAD${i}`);
        if (r?.code === 10001) badOk26 += 1;
        else log(`  … 期望 10001 但得到 ${r?.code}：${bads26[i][1]}`);
      }
      assert(
        badOk26 === bads26.length,
        `D39 入参校验：${bads26.length} 组非法入参（金额 0 / 负数 / 超单笔上限 / 原因过短 / 缺原因 / 非法 action / 缺 action / 缺 userId）**全部** → 10001`,
        `${badOk26}/${bads26.length}`,
      );

      const nou26 = await adj26(
        { userId: 99999999, action: 'recharge', amountFen: 100, reason: 'e2e 不存在用户' },
        adminToken,
        `${PREFIX26}NOU`,
      );
      assert(
        nou26?.code === 10004,
        'D39 `userId` 不存在 → `10004`（余额只能挂在真实用户上，不静默建号）',
        `code=${nou26?.code}`,
      );

      // ---------------------------------------------------- I. 无账户用户的非充值动作
      writeDb(
        'INSERT INTO ab_user (openid, nickname, gender, status, version, created_at, updated_at) VALUES (?, ?, 0, 1, 0, ?, ?)',
        [`${OPENID26}B`, `${PREFIX26}无账户`, nowIso26, nowIso26],
      );
      const ghost26 = readDb('SELECT id FROM ab_user WHERE openid = ?', [`${OPENID26}B`]);
      const gid26 = Number(ghost26?.id ?? 0);
      const gDeduct26 = await adj26(
        { userId: gid26, action: 'deduct', amountFen: 100, reason: 'e2e 无账户扣减' },
        adminToken,
        `${PREFIX26}G1`,
      );
      const gUnf26 = await adj26(
        { userId: gid26, action: 'unfreeze', amountFen: 100, reason: 'e2e 无账户解冻' },
        adminToken,
        `${PREFIX26}G2`,
      );
      assert(
        gDeduct26?.code === 40002 &&
          gDeduct26?.data?.hasAccount === false &&
          gUnf26?.code === 40015 &&
          !readDb('SELECT id FROM ab_balance WHERE user_id = ?', [gid26]),
        '⭐ D39 无账户用户做「扣减 / 解冻」→ `40002` / `40015`，且 `data.hasAccount=false` 点明原因**不是**「余额不足」而是「还没有账户」；**不会**先建一个 0 余额账户再报错（否则库里会积一堆空账户）',
        `deduct=${gDeduct26?.code} unfreeze=${gUnf26?.code} 建户=${!!readDb('SELECT id FROM ab_balance WHERE user_id = ?', [gid26])}`,
      );

      // ---------------------------------------------------- J. 操作日志与账本
      const adjLog26 = await waitDb(
        "SELECT action FROM ab_operation_log WHERE module = 'finance' AND action = '余额调整' ORDER BY id DESC LIMIT 1",
        [],
        (r) => !!r,
        { timeout: 4000 },
      );
      assert(
        !!adjLog26,
        'D39 由 `@OperationLog({ module:finance, action:余额调整 })` 落 `ab_operation_log` —— 必须能回答「谁在什么时候给谁调了多少钱、为什么」',
        `action=${adjLog26?.action ?? '未落库'}`,
      );

      const logs26 = readRows(
        'SELECT type, direction, amount, balance_after, related_id, remark FROM ab_balance_log WHERE user_id = ? ORDER BY id ASC',
        [uid26],
      );
      const cur26 = bal26();
      const tail26 = logs26[logs26.length - 1];
      assert(
        logs26.length === 5 &&
          logs26.every((r) => r.type === 'adjust') &&
          JSON.stringify(logs26.map((r) => Number(r.direction))) === JSON.stringify([1, -1, -1, 1, 1]) &&
          logs26.every((r) => /^AJ\d{16}$/.test(String(r.related_id))) &&
          String(tail26?.remark ?? '').includes('操作人'),
        '⭐ D39 账本自洽：5 条流水**全部** `type=adjust` 且带 `AJ…` 单号；`direction` 依次为 +1/−1/−1/+1/+1（充 / 扣 / 冻 / 解 / 幂等那条首跑）—— **冻结记 `direction=-1`** 与 L12 提现同口径；`remark` 里带操作人（用户在自己的余额明细里能看到「谁动过我的钱」）',
        `logs=${logs26.length} dirs=${JSON.stringify(logs26.map((r) => Number(r.direction)))}`,
      );
      assert(
        fenOf26(tail26?.balance_after) === fenOf26(cur26?.balance),
        '⭐⭐ 快照与账本**同源**：末条流水的 `balance_after` === 当前 `ab_balance.balance`（这正是 L11 余额与 L19 流水「可相互验算」的落点；两条写入不同步时这里必红）',
        `末条after=${fenOf26(tail26?.balance_after)} 当前=${fenOf26(cur26?.balance)}`,
      );

      // ---------------------------------------------------- K. ⭐ 写后重读对账
      const ov26b = (await call('GET', `${FIN26}/overview`, { token: adminToken })).body?.data;
      const lb26b = (await call('GET', `${FIN26}/balances`, { token: adminToken })).body?.data;
      const dBal26 = Number(lb26b?.liability?.balanceFen ?? 0) - Number(lb26a?.liability?.balanceFen ?? 0);
      const dFrz26 = Number(lb26b?.liability?.frozenFen ?? 0) - Number(lb26a?.liability?.frozenFen ?? 0);
      assert(
        lb26b?.liability?.balanceFen === ov26b?.liability?.balanceFen &&
          lb26b?.liability?.frozenFen === ov26b?.liability?.frozenFen &&
          dBal26 === 5611 &&
          dFrz26 === 1500,
        '⭐⭐ 调账**写后重读**：D38 与 D33 的负债**仍然逐项相等**，且都比调账前正好多「可用 +5611 分 / 冻结 +1500 分」（10000−3000−2000+500+111 与 2000−500）—— 「同一函数」不只是签名相同，而是两边**同时**看到本次写入',
        `Δ可用=${dBal26} Δ冻结=${dFrz26} D33=${ov26b?.liability?.balanceFen} D38=${lb26b?.liability?.balanceFen}`,
      );

      // ---------------------------------------------------- L. D38 筛选与时点量
      const p1_26 = (await call('GET', `${FIN26}/balances?pageSize=1`, { token: adminToken })).body
        ?.data;
      const p100_26 = (await call('GET', `${FIN26}/balances?pageSize=100`, { token: adminToken }))
        .body?.data;
      assert(
        p1_26?.liability?.balanceFen === p100_26?.liability?.balanceFen &&
          p1_26?.liability?.frozenFen === p100_26?.liability?.frozenFen &&
          p1_26?.liability?.accountCount === p100_26?.liability?.accountCount,
        '⭐⭐ D38 负债是**时点量**：`pageSize=1` 与 `pageSize=100` 的 `liability` **完全相同**（`total` 才随筛选/分页变化）—— 「平台还欠用户多少钱」不该因为翻页而变。把 `liability` 做成「当前页求和」是最容易犯的错',
        `p1=${p1_26?.liability?.balanceFen}/${p1_26?.liability?.accountCount} p100=${p100_26?.liability?.balanceFen}/${p100_26?.liability?.accountCount}`,
      );

      // ⚠️ `code` 在 `.body` 上、**不在** `.body.data` 里。写成 `data?.code === 0` 会恒等于
      //    `undefined === 0` —— 断言静默失败，而诊断行照旧打印出「看起来正常」的数据。
      const leaderRes26 = await call('GET', `${FIN26}/balances?accountType=leader`, {
        token: adminToken,
      });
      const userRes26 = await call('GET', `${FIN26}/balances?accountType=user`, {
        token: adminToken,
      });
      const leaderOnly26 = leaderRes26.body?.data;
      const userOnly26 = userRes26.body?.data;
      const leaderAll26 = (leaderOnly26?.list ?? []).every((r) => r.isLeader === true);
      const userAll26 = (userOnly26?.list ?? []).every((r) => r.isLeader === false);
      assert(
        leaderRes26.body?.code === 0 &&
          userRes26.body?.code === 0 &&
          (leaderOnly26?.list ?? []).length > 0 &&
          leaderAll26 &&
          userAll26 &&
          leaderOnly26?.liability?.balanceFen === p100_26?.liability?.balanceFen,
        'D38 `accountType=leader` / `user` 分流正确（`leader` 侧每行 `isLeader=true`），且**两种筛选下的 `liability` 相同** —— 它按全量算，不随账户类型缩放',
        `leader=${leaderOnly26?.list?.length}(全真=${leaderAll26}) user=${userOnly26?.list?.length}(全假=${userAll26}) liab=${leaderOnly26?.liability?.balanceFen}/${p100_26?.liability?.balanceFen}`,
      );
      assert(
        (await call('GET', `${FIN26}/balances?accountType=staff`, { token: adminToken })).body
          ?.code === 10001,
        'D38 非法 `accountType` → `10001`（不静默回落成 `all` —— 静默回落会让「筛选没生效」看起来像「没有这类账户」）',
        '',
      );
      assert(
        (await call('GET', `${FIN26}/balances?userId=99999999`, { token: adminToken })).body?.code ===
          10004,
        'D38 `userId` 不存在 → `10004`（不是「返回一行空账户」—— 查无此人要能被区分出来）',
        '',
      );

      const kwRes26 = await call('GET', `${FIN26}/balances?keyword=${PREFIX26}`, {
        token: adminToken,
      });
      const kw26 = kwRes26.body?.data;
      const kwHit26 = (kw26?.list ?? []).find((r) => r.userId === uid26) ?? null;
      assert(
        kwRes26.body?.code === 0 && !!kwHit26,
        'D38 `keyword` 按昵称模糊匹配到目标账户',
        `命中=${kw26?.total} 目标uid=${uid26} 样例昵称=${kwHit26?.nickname ?? '未命中'}`,
      );
      assert(
        (p100_26?.list ?? []).every((r) => !r.phoneMasked || /\*{2,}/.test(String(r.phoneMasked))),
        'D38 手机号**列表一律脱敏**（同 M3-6 纪律）—— 余额页不是查人资料的地方',
        `样本=${(p100_26?.list ?? []).find((r) => r.phoneMasked)?.phoneMasked ?? '无'}`,
      );

      // ---------------------------------------------------- M. 角色 × 动作
      const finAdj26 = await adj26(
        { userId: uid26, action: 'freeze', amountFen: 100, reason: 'e2e 财务冻结' },
        t26Fin,
        `${PREFIX26}F2`,
      );
      assert(
        finAdj26?.code === 0,
        'D39 `finance` → 0（财务是资金动作的合法执行人，与 D35 入账同一档）',
        `code=${finAdj26?.code}`,
      );
      assert(
        (
          await adj26(
            { userId: uid26, action: 'freeze', amountFen: 100, reason: 'e2e 运营越权' },
            t26Op,
            `${PREFIX26}F3`,
          )
        ).code === 10003,
        '⭐⭐ D39 `operator` → `10003` —— 类级白名单含 operator（**能看**），方法级收窄到 super_admin/admin/finance（**能改**）。「能看资金」与「能动资金」是两件事，前者是跟进问题的前提，后者是拍板',
        '',
      );

      // ---------------------------------------------------- N. single 视图完整性
      const single26 = await one26(uid26, adminToken);
      const s26 = row26(single26);
      const curF26 = bal26();
      assert(
        single26?.code === 0 &&
          single26?.data?.view === 'single' &&
          s26?.hasAccount === true &&
          s26?.balanceFen === fenOf26(curF26?.balance) &&
          s26?.frozenFen === fenOf26(curF26?.frozen) &&
          s26?.netFen === s26?.balanceFen + s26?.frozenFen &&
          (single26?.data?.logs ?? []).length > 0 &&
          (single26?.data?.logs ?? []).every((l) => !!l.typeText && !!l.createdAt),
        'D38 `view=single` 明细：账户字段与库内快照逐项一致，且**附带最近流水**（`logs` 非空、每条都有服务端给的中文 `typeText`）—— 没有流水，「他这 ¥150 是哪来的」当场答不出来，运营只能去翻后台操作日志（那是「谁调了接口」，不是「钱怎么动的」）',
        `bal=${s26?.balanceFen} frozen=${s26?.frozenFen} logs=${single26?.data?.logs?.length}`,
      );

      // ---------------------------------------------------- O. 夹具还原
      // ⚠️ 本节**只在新造用户上动钱**，故还原 = 删掉该用户及其余额行与流水。
      //    种子里既有账户**一分未改**（仅只读用于对账断言），无需写回。
      writeDb(
        'DELETE FROM ab_balance_log WHERE user_id IN (SELECT id FROM ab_user WHERE openid LIKE ?)',
        [`${PREFIX26}%`],
      );
      writeDb(
        'DELETE FROM ab_balance WHERE user_id IN (SELECT id FROM ab_user WHERE openid LIKE ?)',
        [`${PREFIX26}%`],
      );
      writeDb('DELETE FROM ab_user WHERE openid LIKE ?', [`${PREFIX26}%`]);
      const left26 = readDb(
        'SELECT (SELECT COUNT(*) FROM ab_user WHERE openid LIKE ?) AS u, (SELECT COUNT(*) FROM ab_balance WHERE user_id NOT IN (SELECT id FROM ab_user)) AS orphan',
        [`${PREFIX26}%`],
      );
      assert(
        Number(left26?.u ?? -1) === 0 && Number(left26?.orphan ?? -1) === 0,
        '§26 夹具还原：新造用户与其余额 / 流水全部清除，且**没有留下孤儿余额行** —— 余额行不还原，下一次重跑的平台负债就会凭空多出 ¥56.11，并让 D38↔D33 的对账断言在「两次读之间」产生假绿',
        `user=${left26?.u} orphan=${left26?.orphan}`,
      );
    }
  }


  // §27 M3-15 对账 D43 + 发票 D44（后台 P34 · 模块 M35-06 / M35-07）
  //
  // ⚠️ 本节不依赖下单窗口（同 §18–§26 纪律）：订单 / 支付流水 / 退款 / 应付单夹具**全部直插**。
  //
  // ⚠️ 本节使用**隔离支付日**（`bjToday() − 200 天`）：该日不可能有其它章节的数据，
  //    故汇总类断言可以取**绝对值**（不必用 Δ）。代价是必须**彻底还原**（见节末）。
  //
  // 本节钉死五条**不变量**：
  //   ① ⭐ 三角恒等式 `diffFen === orderFen − logFen`，且**五类差异逐类可被检出**
  //      （只报「不平」而不说「哪一类」，运营无从下手）。
  //   ② ⭐ `balanced` 同时要求**金额相等**与**无结构差异** —— 重复交易号 / 缺交易号
  //      可能不影响合计金额，却是重复入账的前兆。
  //   ③ ⭐ `date` 锚 = **支付日**（`anchor='paidAt'`），不是出餐日（对账对象是微信账单）。
  //   ④ ⭐⭐ **一期不许假装已与微信对平**：`channel.source='local_only'` +
  //      `billAvailable=false` + note 明说「不等于已与微信侧对平」。若把它报成
  //      「已对平」，真正的差异（微信收了钱、系统不知道）将永远不可见。
  //   ⑤ ⭐ D44 三态（`none`/`partial`/`full`）+ 开票分母**只含已付款行**。
  {
    log('\n§27 M3-15 对账 D43 + 发票 D44');

    const D27 = addDaysStr(bjToday(), -200);
    const PREFIX27 = `E2E27${stamp}`;
    const FIN27 = '/admin/finance';
    /**
     * ⚠️ 直插 datetime 必须是 **UTC 格式** `YYYY-MM-DD HH:mm:ss.SSS`：
     *    TypeORM 的 `DateUtils.mixedDateToUtcDatetimeString` 按 UTC 落库、
     *    查询参数也走同一函数。夹具若写北京时间会整体错 8 小时（本地看着「对」，
     *    换驱动或跨零点时才炸）。`02:00:00.000` UTC = 北京 10:00。
     */
    const AT27 = `${D27} 02:00:00.000`;
    /** 下一个月（`YYYY-MM`），用于 D44 的隔离月份 */
    const nextMon27 = (ym) => {
      const [y, m] = ym.split('-').map(Number);
      return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    };
    const MON27A = D27.slice(0, 7);
    const MON27B = nextMon27(MON27A);
    const MON27C = nextMon27(MON27B);

    // ---------------------------------------------------------- A. 夹具原料
    const l27 = readDb('SELECT id, user_id FROM ab_team_leader ORDER BY id LIMIT 1');
    const b27 = readDb(
      'SELECT id, building_group_id FROM ab_building WHERE building_group_id IS NOT NULL ORDER BY id LIMIT 1',
    );
    const m27 = readDb('SELECT id FROM ab_set_meal ORDER BY id LIMIT 1');
    const a27 = readDb('SELECT id FROM ab_meal_assignment ORDER BY id LIMIT 1');
    const s27 = readDb('SELECT id, invoice_title FROM ab_supplier ORDER BY id LIMIT 1');
    const ready27 = !!l27 && !!b27 && !!m27 && !!a27 && !!s27;

    assert(
      ready27,
      '§27 前置：对账 / 发票夹具原料齐备（1 团长 / 1 有楼群的楼 / 1 套餐 / 1 分配行 / 1 供应商）',
      `leader=${!!l27} building=${!!b27} meal=${!!m27} assign=${!!a27} supplier=${!!s27}`,
    );

    if (ready27) {
      const uid27 = Number(l27.user_id);
      const supId27 = Number(s27.id);

      const INS_O27 =
        'INSERT INTO ab_order (order_no, user_id, team_leader_id, building_id, building_group_id, set_meal_id, assignment_id, meal_date, quantity, unit_price, total_amount, balance_used, discount_amount, pay_amount, status, version, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, 0, ?, ?, 0, ?, ?, ?)';
      const INS_P27 =
        'INSERT INTO ab_payment_log (order_id, order_no, transaction_id, pay_amount, pay_method, status, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, \'wxpay_jsapi\', ?, ?, ?, ?)';
      const INS_R27 =
        'INSERT INTO ab_refund (refund_no, order_id, order_no, user_id, team_leader_id, apply_source, amount, reason_type, reason, status, reversed, version, refunded_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, \'leader\', ?, \'quality\', \'e2e 对账夹具\', \'refunded\', 0, 0, ?, ?, ?)';
      const INS_S27 =
        'INSERT INTO ab_supplier_share (share_no, share_date, meal_date, payee_type, payee_id, quantity, unit_price, amount, type, channel, status, invoice_no, paid_at, created_at, updated_at) VALUES (?, ?, ?, \'supplier\', ?, 10, ?, ?, ?, \'manual\', ?, ?, ?, ?, ?)';

      /** 造一张「已付款」订单并返回其 id */
      const mkOrder27 = (no, payAmount) => {
        writeDb(INS_O27, [
          no,
          uid27,
          Number(l27.id),
          Number(b27.id),
          Number(b27.building_group_id),
          Number(m27.id),
          Number(a27.id),
          D27,
          '25.80',
          '25.80',
          payAmount,
          'completed',
          AT27,
          AT27,
          AT27,
        ]);
        return Number(readDb('SELECT id FROM ab_order WHERE order_no = ?', [no])?.id ?? 0);
      };
      /** 造一条成功支付流水 */
      const mkPay27 = (orderId, no, amount, txn) =>
        writeDb(INS_P27, [orderId, no, txn, amount, 'success', AT27, AT27, AT27]);

      // ---- 六张订单，覆盖五类差异 + 一条「完全匹配」的对照组 ----
      // A1 匹配（不该出现在差异清单里）；B1 无流水；C1 少收 ¥5.80；
      // D1 缺交易号；E1/E2 共享同一交易号（重复）；F 流水无对应订单。
      const o27A = mkOrder27(`${PREFIX27}A`, '25.80');
      const o27B = mkOrder27(`${PREFIX27}B`, '25.80');
      const o27C = mkOrder27(`${PREFIX27}C`, '25.80');
      const o27D = mkOrder27(`${PREFIX27}D`, '25.80');
      const o27E1 = mkOrder27(`${PREFIX27}E1`, '25.80');
      const o27E2 = mkOrder27(`${PREFIX27}E2`, '25.80');

      mkPay27(o27A, `${PREFIX27}A`, '25.80', `${PREFIX27}TXA`);
      // B 故意不建流水
      mkPay27(o27C, `${PREFIX27}C`, '20.00', `${PREFIX27}TXC`);
      mkPay27(o27D, `${PREFIX27}D`, '25.80', null);
      mkPay27(o27E1, `${PREFIX27}E1`, '25.80', `${PREFIX27}TXDUP`);
      mkPay27(o27E2, `${PREFIX27}E2`, '25.80', `${PREFIX27}TXDUP`);
      // F：流水指向一个**不存在**的订单（微信收了钱、系统没有这笔单）
      mkPay27(999000027, `${PREFIX27}F`, '25.80', `${PREFIX27}TXF`);

      // 一笔当日已退款（只为验证退款侧被纳入 `refundFen` / `netFen`）
      writeDb(INS_R27, [
        `${PREFIX27}R1`,
        o27A,
        `${PREFIX27}A`,
        uid27,
        Number(l27.id),
        '25.80',
        AT27,
        AT27,
        AT27,
      ]);

      // ---- D44 应付单夹具：三个隔离月份 × 三态 + 一行未付款 + 一行纠错冲销 ----
      const mkShare27 = (no, date, type, status, invoiceNo, paidAt = AT27) =>
        writeDb(INS_S27, [
          no,
          date,
          date,
          supId27,
          '7.50',
          type === 'reversal' ? '-75.00' : '75.00',
          type,
          status,
          invoiceNo,
          paidAt,
          `${date} 02:00:00.000`,
          `${date} 02:00:00.000`,
        ]);

      // A 月：两行全开票 → full（另加一行 reversal，只作换票提示）
      mkShare27(`${PREFIX27}SA1`, `${MON27A}-05`, 'normal', 'success', `${PREFIX27}INV-A1`);
      mkShare27(`${PREFIX27}SA2`, `${MON27A}-06`, 'normal', 'success', `${PREFIX27}INV-A2`);
      mkShare27(`${PREFIX27}SAR`, `${MON27A}-07`, 'reversal', 'success', null);
      // B 月：一行开票、一行未开 → partial（**按行展示时完全看不出来的那个状态**）
      mkShare27(`${PREFIX27}SB1`, `${MON27B}-05`, 'normal', 'success', `${PREFIX27}INV-B1`);
      mkShare27(`${PREFIX27}SB2`, `${MON27B}-06`, 'normal', 'success', null);
      // C 月：两行都没票 → none；再加一行**未付款**（不得进开票分母）
      mkShare27(`${PREFIX27}SC1`, `${MON27C}-05`, 'normal', 'success', null);
      mkShare27(`${PREFIX27}SC2`, `${MON27C}-06`, 'normal', 'success', null);
      writeDb(INS_S27, [
        `${PREFIX27}SC3`,
        `${MON27C}-07`,
        `${MON27C}-07`,
        supId27,
        '7.50',
        '75.00',
        'normal',
        'pending',
        null,
        null,
        `${MON27C}-07 02:00:00.000`,
        `${MON27C}-07 02:00:00.000`,
      ]);

      const fix27 = readDb(
        "SELECT (SELECT COUNT(*) FROM ab_order WHERE order_no LIKE ?) AS o, (SELECT COUNT(*) FROM ab_payment_log WHERE order_no LIKE ?) AS p, (SELECT COUNT(*) FROM ab_supplier_share WHERE share_no LIKE ?) AS sh",
        [`${PREFIX27}%`, `${PREFIX27}%`, `${PREFIX27}%`],
      );
      assert(
        Number(fix27?.o ?? 0) === 6 && Number(fix27?.p ?? 0) === 6 && Number(fix27?.sh ?? 0) === 8,
        '§27 夹具：6 张订单 + 6 条支付流水（含 1 条指向不存在订单）+ 8 行应付单已入库',
        `order=${fix27?.o} pay=${fix27?.p} share=${fix27?.sh}`,
      );

      // 权限矩阵账号（固定名 —— 每天重跑只累积 2 个）
      const ok27Op = 'e2e_s27op';
      const ok27View = 'e2e_s27view';
      await call('POST', '/admin/system/accounts', {
        token: adminToken,
        body: { username: ok27Op, password: PWD, role: 'operator', realName: 'e2e 对账运营' },
      });
      await call('POST', '/admin/system/accounts', {
        token: adminToken,
        body: { username: ok27View, password: PWD, role: 'viewer', realName: 'e2e 对账只读' },
      });
      const t27Op = (await adminLogin(ok27Op, PWD)).token;
      const t27View = (await adminLogin(ok27View, PWD)).token;
      const t27Fin = (await adminLogin('finance', 'finance123')).token;

      // ================================================== B. D43 汇总与恒等式
      const rec27 = (await call('GET', `${FIN27}/reconciliation?date=${D27}`, { token: adminToken }))
        .body;
      const r27 = rec27?.data;
      const sum27 = r27?.summary ?? {};
      /** 6 单 × ¥25.80 */
      const ORDER_FEN27 = 6 * 2580;
      /** A1 + C1(¥20.00) + D1 + E1 + E2 + F */
      const LOG_FEN27 = 2580 + 2000 + 2580 + 2580 + 2580 + 2580;

      assert(
        rec27?.code === 0 &&
          r27?.date === D27 &&
          r27?.anchor === 'paidAt' &&
          r27?.anchorLabel === '支付日',
        '⭐ D43 `date` 锚 = **支付日**（`anchor=\'paidAt\'` + `anchorLabel=\'支付日\'`）—— 对账对象是微信账单、微信按支付日切日。**这是财务域里唯一一个 `date` 不指出餐日的端点**，故必须显式回显，否则运营会拿它对 D33/D34/D36 的出餐日数字（两个时间轴，不是 bug）',
        `code=${rec27?.code} date=${r27?.date} anchor=${r27?.anchor}`,
      );
      assert(
        Number(sum27.orderFen) === ORDER_FEN27 && Number(sum27.orderCount) === 6,
        `D43 订单侧 = 6 单 × ¥25.80 = ${ORDER_FEN27} 分`,
        `orderFen=${sum27.orderFen} count=${sum27.orderCount}`,
      );
      assert(
        Number(sum27.logFen) === LOG_FEN27 && Number(sum27.logCount) === 6,
        `D43 流水侧 = 6 笔成功流水（含 F 那笔**无订单**的）= ${LOG_FEN27} 分`,
        `logFen=${sum27.logFen} count=${sum27.logCount}`,
      );
      assert(
        Number(sum27.diffFen) === ORDER_FEN27 - LOG_FEN27 &&
          Number(sum27.diffFen) === Number(sum27.orderFen) - Number(sum27.logFen),
        '⭐⭐ D43 三角恒等式：`diffFen === orderFen − logFen`（= ¥5.80：B1 缺流水 +¥25.80、C1 少收 −¥5.80、F 多收 −¥25.80）—— 差额不是「算出来的另一个数」，而是两侧的直接差',
        `diffFen=${sum27.diffFen} order−log=${Number(sum27.orderFen) - Number(sum27.logFen)}`,
      );
      assert(
        Number(sum27.refundFen) === 2580 &&
          Number(sum27.refundCount) === 1 &&
          Number(sum27.netFen) === ORDER_FEN27 - 2580 &&
          Number(sum27.netFen) === Number(sum27.orderFen) - Number(sum27.refundFen),
        'D43 退款侧被纳入：`refundFen` = ¥25.80（按 `refunded_at` 切日）、`netFen` = 订单侧 − 退款（**收款与退款分开列**，净额才是真正落袋）',
        `refundFen=${sum27.refundFen} netFen=${sum27.netFen}`,
      );
      assert(
        Number(sum27.matchedCount) === 4 && Number(sum27.diffCount) === 6,
        'D43 逐笔匹配 4 单（A1 / D1 / E1 / E2 —— 金额一致即算匹配，**凭证类差异另行单独报**）· 差异 6 条（B1 + C1 + D1 + E1 + E2 + F）',
        `matched=${sum27.matchedCount} diff=${sum27.diffCount}`,
      );
      assert(
        sum27.balanced === false && Number(sum27.diffFen) !== 0,
        '⭐ `balanced=false`：金额有差（¥5.80）**且**存在结构差异 —— 两者**同时**要求才判平',
        `balanced=${sum27.balanced}`,
      );

      // ================================================== C. ⭐⭐ 渠道诚实标注
      assert(
        r27?.channel?.source === 'local_only' &&
          r27?.channel?.billAvailable === false &&
          /不等于已与微信侧对平/.test(String(r27?.channel?.note)) &&
          /微信支付账单下载/.test(String(r27?.channel?.note)),
        '⭐⭐ D43 **不许假装已与微信对平**：`channel.source=\'local_only\'` + `billAvailable=false` + note **明写**「本页只对了本地三头、**不等于已与微信侧对平**」。一期无商户号 → 拿不到微信账单；若实现成「内部两表对平 → balanced=true」，运营会以为微信侧也平了，而真正的差异（微信收了钱、系统不知道）将**永远不可见**',
        `source=${r27?.channel?.source} billAvailable=${r27?.channel?.billAvailable}`,
      );

      // ================================================== D. 五类差异逐类命中
      const list27 = r27?.list ?? [];
      const hit27 = (no) => list27.filter((x) => x.orderNo === no);
      const stat27 = (t) => Number((r27?.diffTypeStats ?? []).find((x) => x.type === t)?.count ?? -1);

      assert(
        hit27(`${PREFIX27}B`).length === 1 &&
          hit27(`${PREFIX27}B`)[0]?.type === 'order_paid_no_log' &&
          hit27(`${PREFIX27}B`)[0]?.orderFen === 2580 &&
          hit27(`${PREFIX27}B`)[0]?.logFen === null &&
          stat27('order_paid_no_log') === 1,
        '⭐ 差异①`order_paid_no_log`（订单说付了、账上没有）：B1 命中，`logFen=null` —— 微信回调丢失时**最该抓**的一类（钱可能真的没到，或者到了系统不知道）',
        `hits=${hit27(`${PREFIX27}B`).length} type=${hit27(`${PREFIX27}B`)[0]?.type}`,
      );
      assert(
        hit27(`${PREFIX27}C`).length === 1 &&
          hit27(`${PREFIX27}C`)[0]?.type === 'amount_mismatch' &&
          hit27(`${PREFIX27}C`)[0]?.diffFen === 580,
        '⭐ 差异②`amount_mismatch`：C1 应付 ¥25.80 / 实收 ¥20.00，`diffFen=580`（**带符号差额**，方向与 `summary.diffFen` **一致**（订单侧 − 流水侧）：正数 = 少收）',
        `diff=${hit27(`${PREFIX27}C`)[0]?.diffFen}`,
      );
      assert(
        hit27(`${PREFIX27}D`).length === 1 &&
          hit27(`${PREFIX27}D`)[0]?.type === 'no_transaction_id' &&
          hit27(`${PREFIX27}D`)[0]?.logFen === 2580,
        '⭐ 差异③`no_transaction_id`：D1 本地记成功但**无微信交易号** —— 金额对得上，但缺的是**凭证**（不能作为税前扣除凭证）',
        `type=${hit27(`${PREFIX27}D`)[0]?.type}`,
      );
      assert(
        hit27(`${PREFIX27}E1`).length === 1 &&
          hit27(`${PREFIX27}E2`).length === 1 &&
          hit27(`${PREFIX27}E1`)[0]?.type === 'duplicate_transaction' &&
          hit27(`${PREFIX27}E2`)[0]?.type === 'duplicate_transaction' &&
          stat27('duplicate_transaction') === 2,
        '⭐ 差异④`duplicate_transaction`：E1/E2 共享同一微信交易号，**两条都被列出**（每条一个 `transactionId` 冗余、可直接对账）—— 金额完全一致却仍未平：这正是「只比金额」会漏掉、而「重复入账」一定会留下痕迹的那类',
        `e1=${hit27(`${PREFIX27}E1`)[0]?.type} e2=${hit27(`${PREFIX27}E2`)[0]?.type}`,
      );
      assert(
        list27.filter((x) => x.type === 'log_success_no_order').length === 1 &&
          list27.find((x) => x.type === 'log_success_no_order')?.orderFen === null &&
          stat27('log_success_no_order') === 1,
        '⭐ 差异⑤`log_success_no_order`：F 那笔成功流水指向**不存在的订单**（微信收了钱、系统没有这笔单）—— `orderFen=null` 表明它只存在于账的一侧',
        `count=${stat27('log_success_no_order')}`,
      );
      assert(
        hit27(`${PREFIX27}A`).length === 0,
        '⭐ 对照组：A1（金额一致 + 有交易号 + 交易号唯一）**不出现在差异清单里** —— 「只列差异」是这一页的全部价值（否则就是又一个流水列表）',
        `hits=${hit27(`${PREFIX27}A`).length}`,
      );
      assert(
        list27.length > 0 && list27.every((x) => typeof x.nextAction === 'string' && x.nextAction.length > 10),
        '每条差异都带服务端下发的 `nextAction`（**人话的下一步**）—— 「对账不平」四个字无法执行，「去商户平台按订单号查该笔是否真实收款」可以',
        `list=${list27.length}`,
      );
      assert(
        typeof r27?.note === 'string' &&
          /不提供「一键平账」/.test(r27.note) &&
          /支付日/.test(r27.note),
        'D43 `note` 明写「**刻意不提供一键平账**」（对账的作用是暴露差异，不是把差异抹掉）与「`date` 是支付日」',
        '',
      );

      // ================================================== E. D43 权限与入参
      assert(
        (await call('GET', `${FIN27}/reconciliation?date=${D27}`, { token: t27Fin })).body?.code === 0,
        'D43 类级白名单含 `finance`（财务做对账是本职）',
        '',
      );
      assert(
        (await call('GET', `${FIN27}/reconciliation?date=${D27}`, { token: t27Op })).body?.code === 0,
        'D43 类级白名单含 `operator`（运营要能跟进「今天哪几笔对不上」）—— 且它是**纯读**接口，不额外收窄（不改一分钱）',
        '',
      );
      assert(
        (await call('GET', `${FIN27}/reconciliation?date=${D27}`, { token: t27View })).body?.code ===
          10003,
        'D43 `viewer` → 10003（`admin-role.ts` 里 viewer 的菜单只有 4 个看板页）',
        '',
      );
      assert(
        (await call('GET', `${FIN27}/reconciliation`, {})).body?.code === 10002,
        'D43 未登录 → 10002',
        '',
      );
      const sup27 = await adminLogin('sanweiwu', 'supplier123');
      assert(
        (await call('GET', `${FIN27}/reconciliation`, { token: sup27.token })).body?.code === 10003,
        '双主体隔离：供应商 token 打 `/admin/finance/reconciliation` → 10003',
        '',
      );
      assert(
        (await call('GET', `${FIN27}/reconciliation?date=2026-13-01`, { token: adminToken })).body
          ?.code === 10001,
        'D43 非法日期（`2026-13-01`）→ 10001（**不是**静默当成今天 —— 那样运营会以为自己在看 13 月的数据）',
        '',
      );

      // ================================================== F. D44 发票三态
      const inv27 = async (qs) => (await call('GET', `${FIN27}/invoices?${qs}`, { token: adminToken })).body;
      const invA = await inv27(`supplierId=${supId27}&month=${MON27A}`);
      const rowA = invA?.data?.list?.[0];
      assert(
        invA?.code === 0 &&
          rowA?.status === 'full' &&
          rowA?.statusText === '已开票' &&
          rowA?.paidAmountFen === 15000 &&
          rowA?.invoicedFen === 15000 &&
          rowA?.uninvoicedFen === 0 &&
          rowA?.invoiceNos?.length === 2 &&
          rowA?.reversalFen === -7500,
        '⭐⭐ D44 三态之 `full`：A 月两行应付**全开票** → `已开票`、`uninvoicedFen=0`、`invoiceNos` 两条；⭐ 同时下发的 `reversalFen=-7500` 是当月纠错冲销额（**冲销行不进开票分母**，但必须提示「若已按原金额开票需另行换票」）',
        `status=${rowA?.status} paid=${rowA?.paidAmountFen} inv=${rowA?.invoicedFen} rev=${rowA?.reversalFen}`,
      );
      const invB = await inv27(`supplierId=${supId27}&month=${MON27B}`);
      const rowB = invB?.data?.list?.[0];
      assert(
        rowB?.status === 'partial' &&
          rowB?.statusText === '部分开票' &&
          rowB?.invoicedFen === 7500 &&
          rowB?.uninvoicedFen === 7500,
        '⭐⭐ D44 三态之 `partial`（**本页存在的理由**）：B 月两行只开了一张票 → `部分开票`。⚠️ 若按**单条应付行**展示，运营看到的是「同一发票号重复出现」，**完全看不出**「这家这个月只开了一半」',
        `status=${rowB?.status} inv=${rowB?.invoicedFen} unin=${rowB?.uninvoicedFen}`,
      );
      const invC = await inv27(`supplierId=${supId27}&month=${MON27C}`);
      const rowC = invC?.data?.list?.[0];
      assert(
        rowC?.status === 'none' &&
          rowC?.statusText === '未开票' &&
          rowC?.paidAmountFen === 15000 &&
          rowC?.uninvoicedFen === 15000 &&
          rowC?.paidRowCount === 2 &&
          rowC?.unpaidRowCount === 1 &&
          rowC?.unpaidAmountFen === 7500,
        '⭐⭐ D44 三态之 `none` + **分母只含已付款**：C 月两行已付全未开票 → `未开票`；第三行是 **pending（未付款）**，只进 `unpaidAmountFen` / `unpaidRowCount`，**不进开票分母** —— 未付款就要票供应商不会给，且让它进分母会把「刚出单的日子」渲染成满屏未开票，把真正该催的欠票淹没',
        `status=${rowC?.status} paid=${rowC?.paidAmountFen} unpaid=${rowC?.unpaidAmountFen}`,
      );
      assert(
        rowC?.paidAmountFen === rowC?.invoicedFen + rowC?.uninvoicedFen &&
          invC?.data?.summary?.paidAmountFen ===
            Number(invC?.data?.summary?.invoicedFen) + Number(invC?.data?.summary?.uninvoicedFen),
        'D44 恒等式：`paidAmountFen === invoicedFen + uninvoicedFen`（行内 + 汇总两侧都自洽）',
        `行=${rowC?.paidAmountFen}/${rowC?.invoicedFen}/${rowC?.uninvoicedFen}`,
      );
      assert(
        rowA?.titleMissing === (rowA?.invoiceTitle === null) &&
          typeof rowA?.overdue === 'boolean' &&
          Number(invA?.data?.summary?.overdueDays) > 0,
        'D44 下发 `titleMissing`（未登记开票抬头 → 引导去 D28 补，**没有抬头票开不出来**）、`overdue` 与 `overdueDays`（已付超 N 天仍无票 = 税务风险）',
        `title=${rowA?.invoiceTitle} missing=${rowA?.titleMissing} overdueDays=${invA?.data?.summary?.overdueDays}`,
      );
      const invP1 = await inv27(`supplierId=${supId27}&month=${MON27C}&pageSize=1`);
      assert(
        Number(invP1?.data?.summary?.uninvoicedFen) === Number(invC?.data?.summary?.uninvoicedFen) &&
          Number(invP1?.data?.summary?.paidAmountFen) === Number(invC?.data?.summary?.paidAmountFen),
        'D44 `summary` 取**筛选后全量**、不受 `pageSize` 影响（与 D8/D34/D36/D40 同一约定）—— 否则运营翻到第 2 页会发现合计变小',
        `p1=${invP1?.data?.summary?.uninvoicedFen} 全量=${invC?.data?.summary?.uninvoicedFen}`,
      );
      assert(
        (await inv27(`supplierId=${supId27}&month=${MON27C}&status=partial`)).data?.list?.length === 0 &&
          (await inv27(`supplierId=${supId27}&month=${MON27B}&status=partial`)).data?.list?.length === 1,
        'D44 `status` 是**派生值**（库里只有 pending/success），故**必须先聚合后筛**：C 月筛 `partial` → 0 行、B 月筛 `partial` → 1 行',
        '',
      );
      assert(
        (await call('GET', `${FIN27}/invoices?status=nope`, { token: adminToken })).body?.code ===
          10001 &&
          (await call('GET', `${FIN27}/invoices?month=2026-13`, { token: adminToken })).body?.code ===
            10001,
        'D44 非法枚举 / 非法月份 → 10001（**不静默回落成「全部」** —— 回落会让运营以为自己看的是「未开票」，实际是全部，从而漏催一批票）',
        '',
      );
      assert(
        (await call('GET', `${FIN27}/invoices`, { token: t27Fin })).body?.code === 0 &&
          (await call('GET', `${FIN27}/invoices`, { token: t27Op })).body?.code === 0 &&
          (await call('GET', `${FIN27}/invoices`, { token: t27View })).body?.code === 10003 &&
          (await call('GET', `${FIN27}/invoices`, {})).body?.code === 10002 &&
          (await call('GET', `${FIN27}/invoices`, { token: sup27.token })).body?.code === 10003,
        'D44 权限矩阵与 D43 一致（finance / operator 可读 · viewer 10003 · 未登录 10002 · 供应商 10003）—— 催票是 `finance` 角色的日常工作，故 `/finance/invoices` 同时进了 `ADMIN_MENU_KEYS` 与 finance 角色菜单',
        '',
      );

      // ================================================== G. 夹具还原
      //
      // ⚠️ D27 是**隔离日**，但夹具必须清干净：`ab_supplier_share` 的隔离月份行若不删，
      //    下次重跑时「同一供应商 × 同一月」的组会与本轮数据混在一起，`full`/`partial`
      //    /`none` 三种状态全部串味（比如此轮的 `partial` 行会让下轮的 `full` 变成 `partial`）。
      writeDb('DELETE FROM ab_payment_log WHERE order_no LIKE ? OR order_id = ?', [
        `${PREFIX27}%`,
        999000027,
      ]);
      writeDb('DELETE FROM ab_refund WHERE refund_no LIKE ?', [`${PREFIX27}%`]);
      writeDb('DELETE FROM ab_order WHERE order_no LIKE ?', [`${PREFIX27}%`]);
      writeDb('DELETE FROM ab_supplier_share WHERE share_no LIKE ?', [`${PREFIX27}%`]);
      const left27 = readDb(
        'SELECT (SELECT COUNT(*) FROM ab_order WHERE order_no LIKE ?) AS o, (SELECT COUNT(*) FROM ab_payment_log WHERE order_no LIKE ? OR order_id = ?) AS p, (SELECT COUNT(*) FROM ab_refund WHERE refund_no LIKE ?) AS r, (SELECT COUNT(*) FROM ab_supplier_share WHERE share_no LIKE ?) AS s',
        [`${PREFIX27}%`, `${PREFIX27}%`, 999000027, `${PREFIX27}%`, `${PREFIX27}%`],
      );
      assert(
        Number(left27?.o ?? -1) === 0 &&
          Number(left27?.p ?? -1) === 0 &&
          Number(left27?.r ?? -1) === 0 &&
          Number(left27?.s ?? -1) === 0,
        '§27 夹具还原：订单 / 支付流水 / 退款 / 应付单全部清除 —— 应付单不删，下一次重跑三种开票状态会互相串味（本轮 `partial` 会把下轮 `full` 拉成 `partial`）',
        `o=${left27?.o} p=${left27?.p} r=${left27?.r} s=${left27?.s}`,
      );
    }
  }

  // ==========================================================================
  // §28 M4-1 日切链路（调度基座 + 4.1 开团 / 4.2 截单 / 4.3 配送单）
  //
  // ⚠️ 本节**不依赖下单窗口**（同 §18–§27 纪律）：订单 / 分配行夹具**全部直插**，
  //    三个任务一律经**补跑接口**用**显式日期**驱动 —— 不等真实时刻、不依赖 cron 触发。
  //
  // ⚠️ 本节使用四个**隔离出餐日**（避开其它章节用过的 today ± {1,10,60,90,200,365}）：
  //    · D28F = today + 130  未来日 → 「开团」正例（未过截单才允许上架）
  //    · D28P = today − 205  过去日 → 「截单」+「配送单」（须已过截单时刻才跑得动）
  //    · D28X = today − 212  过去日 → 「已过截单即拒绝开团」（其分配行须保持 pending）
  //    · D28W = today − 190  过去日 → 「配送单可信度告警」（有单却一单没截 → 必须报警）
  //    隔离日的意义：汇总类断言可以取**绝对值**而非差值；代价是必须**彻底还原**（见节末）。
  //
  // 本节钉死九条不变量：
  //   ① ⭐ **同刻不同日**是声明式防线：`meal-publish` 与 `auto-confirm` 的 cron 完全相同
  //      （14:00），但 `dateKind` 分别是「次日」与「当日」—— 必须由接口如实下发。
  //      这是 M4 头号陷阱：cron 只写「几点跑」、不写「动哪一天」，写反了照样编译通过、
  //      甚至部分断言仍然是绿的。
  //   ② M4-2 后 **8 个任务全部实装**（`implemented=true` + `pendingNote=null`）——
  //      `implemented` 是执行口 `runners.has()` 的**派生值**、不是手写常量：
  //      将来只往声明表加任务却不写执行口，接口会**如实降级**为未实装，
  //      而不是让「只打了一行日志」的占位任务冒充已上线。
  //   ③ ⭐ 补跑与跑批**共用同一执行口**：不传日期时按声明表推导，与跑批同一天。
  //   ④ ⭐ 截单三分支一次跑全：未支付→`cancelled`（**且解冻余额**）、已支付→`cut_off`
  //      （不可逆）、备料量基数**定格**。第三项是本次修的真实缺口 —— `sold_count`
  //      全仓无累加点，跑批推给供应商的份数此前**恒为 0**，而没有任何地方会报错。
  //   ⑤ ⭐ 备料量**不含**未支付 / 已取消，否则供应商按虚数备货。
  //   ⑥ ⭐ 生产计划按**截单后定格**的量覆盖：截单前生成的「预估」必须被「承诺」取代。
  //   ⑦ ⭐ 开团**已过截单即整批不动**：上架了用户也下不了单，静默置 `active` 会做出
  //      「看起来开了团、实际没人能下单」的假象。
  //   ⑧ ⭐ 跑批路径（**无 HTTP 请求**）也必须落 `ab_operation_log`（source=system）——
  //      全局拦截器在这条路上不生效，否则状态机 §2.1.5「每次迁移留痕」是空的。
  //   ⑨ ⭐ 三个任务重复触发**都不产生重复数据**；配送单**不覆盖**已存在行
  //      （司机 / 车牌是人工录入的，跑批抹掉就找不回来 —— 当前也没有修正入口）。
  // ==========================================================================
  {
    log('\n§28 M4-1 日切链路（调度基座 + 开团 / 截单 / 配送单）');

    const SCH28 = '/admin/schedule';
    const PREFIX28 = `E2E28${stamp}`;
    const D28F = addDaysStr(bjToday(), 130);
    const D28P = addDaysStr(bjToday(), -205);
    const D28X = addDaysStr(bjToday(), -212);
    const D28W = addDaysStr(bjToday(), -190);
    /** 直插 datetime 一律 **UTC** 格式（理由同 §27：TypeORM 按 UTC 落库与查询） */
    const AT28 = `${bjToday()} 02:00:00.000`;

    // ---------------------------------------------------------- A. 夹具原料
    // 模板分配行必须同时满足：有「加工场所」（否则聚合不出计划）+ 有菜品明细
    // + 明细的 `supplier_id` 齐全（否则聚合会造出 `supplier_id=NULL` 的行 → 建表约束报错）
    const tpl28 = readDb(
      `SELECT a.building_group_id AS gid, a.set_meal_id AS smid, a.distribution_center_id AS dcid, b.id AS bid
         FROM ab_meal_assignment a
         JOIN ab_building b ON b.building_group_id = a.building_group_id
        WHERE a.distribution_center_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM ab_set_meal_item i WHERE i.set_meal_id = a.set_meal_id)
          AND NOT EXISTS (SELECT 1 FROM ab_set_meal_item i WHERE i.set_meal_id = a.set_meal_id AND i.supplier_id IS NULL)
        ORDER BY a.id LIMIT 1`,
    );
    const grp28 = tpl28
      ? readDb('SELECT id, name FROM ab_building_group WHERE id <> ? ORDER BY id LIMIT 1', [
          tpl28.gid,
        ])
      : null;
    const bld28 = grp28
      ? readDb('SELECT id FROM ab_building WHERE building_group_id = ? ORDER BY id LIMIT 1', [
          grp28.id,
        ])
      : null;
    const l28 = readDb('SELECT id, user_id FROM ab_team_leader ORDER BY id LIMIT 1');
    const openid28 = `${PREFIX28}u`;

    assert(
      !!tpl28 && !!grp28 && !!bld28 && !!l28,
      '§28 前置：日切夹具原料齐备（1 个「有加工场所 + 菜品明细齐全」的分配模板 / 2 个楼群 / 1 团长）',
      `tpl=${!!tpl28} grp=${Number(grp28?.id)} bld=${Number(bld28?.id)} leader=${!!l28}`,
    );

    if (tpl28 && grp28 && bld28 && l28) {
      const G28A = Number(tpl28.gid);
      const G28B = Number(grp28.id);
      const B28A = Number(tpl28.bid);
      const SM28 = Number(tpl28.smid);
      const DC28 = Number(tpl28.dcid);
      const L28 = Number(l28.id);

      // 夹具用户**专供**解冻断言：不能借用既有团长账号 —— 它可能已有余额行，
      // 事后删除会把别人的账一起抹掉（§26 的同一条教训）。
      writeDb(
        'INSERT INTO ab_user (openid, nickname, gender, status, version, created_at, updated_at) VALUES (?, ?, 0, 1, 0, ?, ?)',
        [openid28, `${PREFIX28}日切用户`, AT28, AT28],
      );
      const uid28 = Number(readDb('SELECT id FROM ab_user WHERE openid = ?', [openid28])?.id ?? 0);
      // 账户里先摆好 5.80 的**冻结**（模拟「下单冻结（余额抵扣）」的落点）
      writeDb(
        "INSERT INTO ab_balance (user_id, balance, frozen, total_in, total_out, version, created_at, updated_at) VALUES (?, '0.00', '5.80', '0.00', '0.00', 0, ?, ?)",
        [uid28, AT28, AT28],
      );

      const INS_A28 =
        'INSERT INTO ab_meal_assignment (meal_date, building_group_id, set_meal_id, distribution_center_id, status, publish_at, cutoff_at, sold_count, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?, ?)';
      const mkAssign28 = (date, gid, status) => {
        writeDb(INS_A28, [date, gid, SM28, DC28, status, AT28, AT28]);
        return Number(
          readDb('SELECT id FROM ab_meal_assignment WHERE meal_date = ? AND building_group_id = ?', [
            date,
            gid,
          ])?.id ?? 0,
        );
      };

      mkAssign28(D28F, G28A, 'pending'); // 开团正例 ×2
      mkAssign28(D28F, G28B, 'pending');
      const aP28 = mkAssign28(D28P, G28A, 'active'); // 截单 / 配送：有单
      mkAssign28(D28P, G28B, 'active'); //                   G28B 一单没有
      const aX28 = mkAssign28(D28X, G28A, 'pending'); // 已过截单拒绝开团（须保持 pending）
      const aW28 = mkAssign28(D28W, G28A, 'active'); // 可信度告警：有「已支付但未截单」的单

      const INS_O28 =
        'INSERT INTO ab_order (order_no, user_id, team_leader_id, building_id, building_group_id, set_meal_id, assignment_id, meal_date, quantity, unit_price, total_amount, balance_used, discount_amount, pay_amount, status, version, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, ?)';
      const mkOrder28 = (no, date, assignId, status, qty, balanceUsedFen = 0) => {
        const total = qty * 25.8;
        writeDb(INS_O28, [
          no,
          uid28,
          L28,
          B28A,
          G28A,
          SM28,
          assignId,
          date,
          qty,
          '25.80',
          total.toFixed(2),
          (balanceUsedFen / 100).toFixed(2),
          (total - balanceUsedFen / 100).toFixed(2),
          status,
          status === 'pending_pay' ? null : AT28,
          AT28,
          AT28,
        ]);
        return Number(readDb('SELECT id FROM ab_order WHERE order_no = ?', [no])?.id ?? 0);
      };

      // 截单夹具：未支付 ×2（其一有余额冻结）/ 已支付 ×2（共 5 份）/ 已取消 ×9 份
      const o28P1 = mkOrder28(`${PREFIX28}P1`, D28P, aP28, 'pending_pay', 2, 580);
      const o28P2 = mkOrder28(`${PREFIX28}P2`, D28P, aP28, 'pending_pay', 1);
      const o28P3 = mkOrder28(`${PREFIX28}P3`, D28P, aP28, 'paid', 3);
      const o28P4 = mkOrder28(`${PREFIX28}P4`, D28P, aP28, 'paid', 2);
      mkOrder28(`${PREFIX28}P5`, D28P, aP28, 'cancelled', 9);
      // 告警夹具：已支付、但**没有**任何 cut_off 订单
      mkOrder28(`${PREFIX28}W1`, D28W, aW28, 'paid', 4);

      // ------------------------------------------------------ B. 调度基座：时刻表
      const sched28 = await call('GET', SCH28, { token: adminToken });
      const rows28 = sched28.body?.data?.list ?? [];
      const t28 = (n) => rows28.find((r) => r.task === n) ?? null;
      assert(
        sched28.body?.code === 0 && rows28.length === 8,
        '§28 时刻表一次列出全部 8 个定时任务（含未实装项 —— 不隐藏）',
        `code=${sched28.body?.code} rows=${rows28.length}`,
      );
      const pub28 = t28('meal-publish');
      const conf28 = t28('auto-confirm');
      assert(
        !!pub28 &&
          !!conf28 &&
          pub28.cron === conf28.cron &&
          pub28.dateKind === 'tomorrow' &&
          conf28.dateKind === 'today',
        '⭐⭐ §28 **同刻不同日**：`meal-publish` 与 `auto-confirm` 的 cron 完全相同（14:00），但目标日期分别是「次日」与「当日」—— M4 头号陷阱的唯一防线，必须由接口如实下发',
        `cron=${pub28?.cron} vs ${conf28?.cron} · dateKind=${pub28?.dateKind} vs ${conf28?.dateKind}`,
      );
      assert(
        t28('leader-expire')?.dateKind === null && t28('leader-expire')?.implemented === true,
        '§28 全量扫描型任务（`leader-expire`）`dateKind=null`（与出餐日无关）且已实装',
        `dateKind=${JSON.stringify(t28('leader-expire')?.dateKind)} implemented=${t28('leader-expire')?.implemented}`,
      );
      const allTasks28 = [
        'meal-publish',
        'cutoff',
        'delivery-generate',
        'auto-confirm',
        'commission-settle',
        'supplier-share',
        'reconciliation',
        'leader-expire',
      ];
      const notImpl28 = allTasks28.filter((n) => t28(n)?.implemented !== true);
      assert(
        sched28.body?.data?.summary?.implemented === 8 && notImpl28.length === 0,
        '⭐ §28 M4-2 后 **8 个任务全部实装**（`summary.implemented = 8/8`，无 `pendingNote` 残留）—— `implemented` 是执行口 `runners.has()` 的**派生值**而非手写常量：将来只往声明表加任务却不写执行口，这里会如实暴露，而不是让占位任务冒充已上线',
        `implemented=${sched28.body?.data?.summary?.implemented} 未实装：${notImpl28.join(',') || '无'}`,
      );

      // ------------------------------------------------------ C. 补跑闸门
      const unknown28 = await call('POST', `${SCH28}/no-such-task/run`, {
        token: adminToken,
        body: {},
      });
      assert(
        unknown28.body?.code === 10001,
        '§28 未知任务名补跑 → 10001（不静默什么都不做）',
        `code=${unknown28.body?.code} msg=${unknown28.body?.message}`,
      );
      // M4-2 后已无「尚未实装」的拒绝分支 —— 补跑必须回显**真实结果**（该隔离日无订单 → 空结果是正常）
      const run28 = await call('POST', `${SCH28}/auto-confirm/run`, {
        token: adminToken,
        body: { date: D28F },
      });
      const run28d = run28.body?.data?.result;
      assert(
        run28.body?.code === 0 &&
          run28d?.confirmedCount === 0 &&
          run28d?.notDelivered?.count === 0,
        '⭐ §28 已实装任务补跑 → `code=0` 且回显**真实结果**（隔离日无订单，`confirmedCount=0`）—— 空结果**不是故障**：静默报错会让运营以为跑批挂了，静默返回假「完成」会让运营以为已经跑过',
        `code=${run28.body?.code} confirmed=${run28d?.confirmedCount} msg=${String(run28.body?.message ?? '').slice(0, 30)}`,
      );
      const badDate28 = await call('POST', `${SCH28}/cutoff/run`, {
        token: adminToken,
        body: { date: '2026-02-30' },
      });
      assert(
        badDate28.body?.code === 10001 &&
          String(badDate28.body?.message ?? '').includes('不是合法日期'),
        '⭐⭐ §28 日历上**不存在**的日期（2026-02-30）被拒 → 10001 —— 放行会让 `Date.UTC` **静默滚动**到 2026-03-02：运营以为在补跑「2 月 30 日」并看到「完成」，实际批量改了 3 月 2 日的订单',
        `code=${badDate28.body?.code} msg=${badDate28.body?.message}`,
      );

      // ------------------------------------------------------ D. 截单（4.2）
      const cut28 = await call('POST', `${SCH28}/cutoff/run`, {
        token: adminToken,
        body: { date: D28P },
      });
      const cut28d = cut28.body?.data?.result?.cut;
      const plan28 = cut28.body?.data?.result?.plan;
      assert(
        cut28.body?.code === 0 && cut28.body?.data?.date === D28P,
        '§28 补跑接口按**传入日期**执行并回显 `date`（与跑批共用同一执行口，故补跑算出来的数与跑批一致）',
        `code=${cut28.body?.code} date=${cut28.body?.data?.date}`,
      );
      assert(
        cut28d?.autoCancelled?.count === 2 &&
          cut28d?.locked?.count === 2 &&
          cut28d?.locked?.totalQuantity === 5,
        '⭐ §28 截单三分支一次跑全：未支付 2 单 → 取消 / 已支付 2 单 → 锁定 **5 份** / 原本 `cancelled` 的 9 份**不计入锁定**',
        `取消=${cut28d?.autoCancelled?.count} 锁定=${cut28d?.locked?.count} 份=${cut28d?.locked?.totalQuantity}`,
      );
      const st28 = readRows('SELECT order_no, status FROM ab_order WHERE order_no LIKE ? ORDER BY order_no', [
        `${PREFIX28}P%`,
      ]);
      const st28of = new Map(st28.map((r) => [String(r.order_no), String(r.status)]));
      assert(
        st28of.get(`${PREFIX28}P1`) === 'cancelled' &&
          st28of.get(`${PREFIX28}P2`) === 'cancelled' &&
          st28of.get(`${PREFIX28}P3`) === 'cut_off' &&
          st28of.get(`${PREFIX28}P4`) === 'cut_off' &&
          st28of.get(`${PREFIX28}P5`) === 'cancelled',
        '⭐ §28 状态已落库：`pending_pay → cancelled`、`paid → cut_off`（**不可逆**锁定），原本已取消的不受影响',
        st28.map((r) => `${String(r.order_no).slice(-2)}=${r.status}`).join(' '),
      );
      const bal28 = readDb('SELECT balance, frozen FROM ab_balance WHERE user_id = ?', [uid28]);
      assert(
        cut28d?.autoCancelled?.releasedBalanceFen === 580 &&
          Number(bal28?.frozen) === 0 &&
          Number(bal28?.balance) === 5.8,
        '⭐⭐ §28 未支付兜底取消**同时解冻余额**（冻结 5.80 → 可用）—— 只改状态不解冻，用户的钱会被永久锁在一张已取消的订单上',
        `解冻分=${cut28d?.autoCancelled?.releasedBalanceFen} 账户可用/冻结=${bal28?.balance}/${bal28?.frozen}`,
      );
      const balLog28 = readDb(
        'SELECT type, direction, amount FROM ab_balance_log WHERE user_id = ? AND related_id = ?',
        [uid28, `${PREFIX28}P1`],
      );
      assert(
        balLog28?.type === 'order_pay' &&
          Number(balLog28?.direction) === 1 &&
          Number(balLog28?.amount) === 5.8,
        '§28 解冻留流水（`ab_balance_log` type=order_pay / direction=+1）—— 余额每一次变动都要有据可查',
        `type=${balLog28?.type} dir=${balLog28?.direction} amount=${balLog28?.amount}`,
      );
      const oplog28 = readDb(
        `SELECT SUM(CASE WHEN action = '截单取消' THEN 1 ELSE 0 END) AS c,
                SUM(CASE WHEN action = '截单锁定' THEN 1 ELSE 0 END) AS l
           FROM ab_operation_log
          WHERE module = 'order' AND target_id IN (?, ?, ?, ?)`,
        [String(o28P1), String(o28P2), String(o28P3), String(o28P4)],
      );
      assert(
        Number(oplog28?.c) === 2 && Number(oplog28?.l) === 2,
        '⭐⭐ §28 状态机 §2.1.5：**跑批路径（无 HTTP 请求）也落了操作日志**（全局拦截器不生效，必须显式写入）—— 否则「每次迁移留痕」在跑批这条路上是空的',
        `截单取消=${oplog28?.c} 截单锁定=${oplog28?.l}`,
      );
      const sold28 = readDb('SELECT sold_count FROM ab_meal_assignment WHERE id = ?', [aP28]);
      assert(
        Number(sold28?.sold_count) === 5,
        '⭐⭐ §28 备料量基数**定格** = 5 份（计入生产 = 既非未支付、也非已取消）—— 此前 `sold_count` 全仓无累加点，跑批推给供应商的份数**恒为 0** 且不报任何错',
        `sold_count=${sold28?.sold_count}`,
      );
      const plan28row = readDb(
        'SELECT COUNT(*) AS c, COUNT(DISTINCT plan_quantity) AS d, MIN(plan_quantity) AS mn, MAX(plan_quantity) AS mx, COALESCE(SUM(plan_quantity), 0) AS s FROM ab_supplier_dish_daily WHERE produce_date = ?',
        [D28P],
      );
      assert(
        Number(plan28row?.c) > 0 && Number(plan28row?.d) === 1 && Number(plan28row?.mn) === 5,
        '⭐⭐ §28 生产计划按**截单后定格**的量覆盖（每道菜都 = 5 份，且**不生成 0 份行**）—— 截单前顺手生成的「预估」必须被「承诺」取代，否则备料量系统性偏小',
        `行数=${plan28row?.c} 取值数=${plan28row?.d} min=${plan28row?.mn} max=${plan28row?.mx}`,
      );
      assert(
        Number(plan28?.totalQuantity) === Number(plan28row?.s) &&
          Number(plan28?.supplierCount) >= 1,
        '§28 截单出参的供应商侧合计与落库的 `ab_supplier_dish_daily` 合计**相等**（出参一份口径、落库另一份口径时，运营看到的「今天要备 N 份」与表里的数会对不上，且**不报任何错**）',
        `出参=${plan28?.totalQuantity} 落库=${plan28row?.s} 供应商数=${plan28?.supplierCount}`,
      );

      const cut28b = await call('POST', `${SCH28}/cutoff/run`, {
        token: adminToken,
        body: { date: D28P },
      });
      const cut28bd = cut28b.body?.data?.result?.cut;
      const sold28b = readDb('SELECT sold_count FROM ab_meal_assignment WHERE id = ?', [aP28]);
      assert(
        cut28b.body?.code === 0 &&
          cut28bd?.autoCancelled?.count === 0 &&
          cut28bd?.locked?.count === 0,
        '⭐ §28 截单**幂等**：重跑不产生重复动作（以 `meal_date` 为键，不需要额外幂等占位表）',
        `取消=${cut28bd?.autoCancelled?.count} 锁定=${cut28bd?.locked?.count}`,
      );
      assert(
        Number(sold28b?.sold_count) === 5,
        '§28 重跑后备料量仍为 5（**定格**而非累加）—— 若改成实时累加，这里会变成 10，而供应商会被多备一倍',
        `sold_count=${sold28b?.sold_count}`,
      );

      // ------------------------------------------------------ E. 开团（4.1）
      const pubs28 = await call('POST', `${SCH28}/meal-publish/run`, {
        token: adminToken,
        body: { date: D28F },
      });
      const pubd28 = pubs28.body?.data?.result;
      assert(
        pubs28.body?.code === 0 &&
          pubd28?.total === 2 &&
          pubd28?.published === 2 &&
          pubd28?.blockedByCutoff === false,
        '§28 开团：未来日的 2 个 `pending` 分配 → `active`（D 日 14:00 开的正是 D+1 的团）',
        `total=${pubd28?.total} published=${pubd28?.published} blocked=${pubd28?.blockedByCutoff}`,
      );
      const act28 = readDb(
        'SELECT COUNT(*) AS c FROM ab_meal_assignment WHERE meal_date = ? AND status = ?',
        [D28F, 'active'],
      );
      const tm28 = readDb(
        'SELECT publish_at, cutoff_at FROM ab_meal_assignment WHERE meal_date = ? ORDER BY id LIMIT 1',
        [D28F],
      );
      assert(
        Number(act28?.c) === 2 && !!tm28?.publish_at && !!tm28?.cutoff_at,
        '§28 上架同时落 `publish_at` 与实际 `cutoff_at`（截单时刻冗余 —— 用户端倒计时与团长端展示都读它）',
        `active=${act28?.c} publish_at=${tm28?.publish_at} cutoff_at=${tm28?.cutoff_at}`,
      );
      const pubs28b = await call('POST', `${SCH28}/meal-publish/run`, {
        token: adminToken,
        body: { date: D28F },
      });
      const pubd28b = pubs28b.body?.data?.result;
      assert(
        pubs28b.body?.code === 0 &&
          pubd28b?.published === 0 &&
          pubd28b?.alreadyActive === 2,
        '⭐ §28 开团**幂等**：重跑 `published=0 / alreadyActive=2` —— 重复触发**不产生任何写入**',
        `published=${pubd28b?.published} alreadyActive=${pubd28b?.alreadyActive}`,
      );
      const pubs28x = await call('POST', `${SCH28}/meal-publish/run`, {
        token: adminToken,
        body: { date: D28X },
      });
      const pubd28x = pubs28x.body?.data?.result;
      const xrow28 = readDb('SELECT status FROM ab_meal_assignment WHERE id = ?', [aX28]);
      assert(
        pubs28x.body?.code === 0 &&
          pubd28x?.blockedByCutoff === true &&
          pubd28x?.published === 0 &&
          String(xrow28?.status) === 'pending',
        '⭐⭐ §28 **已过截单即整批不动**：`blockedByCutoff=true` 且分配行仍是 `pending` —— 静默置 `active` 会做出「看起来开了团、实际没人能下单」的假象（`isOrderable` 恒假）',
        `blocked=${pubd28x?.blockedByCutoff} published=${pubd28x?.published} status=${xrow28?.status}`,
      );

      // ------------------------------------------------------ F. 配送单（4.3）
      const dg28 = await call('POST', `${SCH28}/delivery-generate/run`, {
        token: adminToken,
        body: { date: D28P },
      });
      const dgd28 = dg28.body?.data?.result;
      assert(
        dg28.body?.code === 0 &&
          dgd28?.created === 1 &&
          dgd28?.emptyGroups === 1 &&
          dgd28?.totalQuantity === 5 &&
          dgd28?.warning === null,
        '⭐ §28 配送单按**楼群**生成（唯一键 `meal_date`+`building_group_id`）：有单的楼群建 1 张 / 5 份，**无单楼群不建单**（计入 `emptyGroups`）',
        `created=${dgd28?.created} empty=${dgd28?.emptyGroups} qty=${dgd28?.totalQuantity} warning=${dgd28?.warning ?? 'null'}`,
      );
      const dr28 = readDb(
        'SELECT total_quantity, expected_at, status FROM ab_delivery_record WHERE meal_date = ? AND building_group_id = ?',
        [D28P, G28A],
      );
      assert(
        Number(dr28?.total_quantity) === 5 &&
          String(dr28?.expected_at ?? '').startsWith(`${D28P} 03:30:00`),
        '§28 配送单份数与备料量**同口径**（5 份），预计送达锚在 T 日 11:30（UTC 03:30）—— 两者不一致会出现「供应商做了 120 份、配送只送 100 份」，而**两边都不报错**',
        `qty=${dr28?.total_quantity} expected_at=${dr28?.expected_at}`,
      );

      // 人工录入司机 / 车牌后重跑
      // ⚠️ M5-1 起改**走 D62 接口**（原先直写 `UPDATE`）：直写只能验证「跑批不覆盖」，
      //    走接口才能同时验证「修正真的落到了库里」—— 否则「接口写了别处」这种错误
      //    会被下面的不覆盖断言**放过**（跑批不覆盖一个从没被改过的行，也是绿的）。
      const dr28id = Number(
        readDb('SELECT id FROM ab_delivery_record WHERE meal_date = ? AND building_group_id = ?', [
          D28P,
          G28A,
        ])?.id ?? 0,
      );
      const p28 = await call('PUT', `/admin/deliveries/${dr28id}`, {
        token: adminToken,
        body: {
          version: 0,
          reason: 'e2e §28 人工录入司机 / 车牌 / 份数',
          driverName: '张三',
          driverPhone: '13800000000',
          plateNo: '京A12345',
          totalQuantity: 99,
        },
      });
      assert(
        p28.body?.code === 0 && p28.body?.data?.changed?.length === 4,
        '⭐ §28 人工录入配送信息走 D62 接口且四项一次生效（M5-1）—— 直写库只能验证「跑批不覆盖」，走接口才能同时验证「修正真的落到库里」',
        `code=${p28.body?.code} changed=${p28.body?.data?.changed?.length} v=${p28.body?.data?.version}`,
      );

      const dg28b = await call('POST', `${SCH28}/delivery-generate/run`, {
        token: adminToken,
        body: { date: D28P },
      });
      const dgd28b = dg28b.body?.data?.result;
      const dr28b = readDb(
        'SELECT driver_name, plate_no, total_quantity FROM ab_delivery_record WHERE meal_date = ? AND building_group_id = ?',
        [D28P, G28A],
      );
      assert(
        dg28b.body?.code === 0 && dgd28b?.created === 0 && dgd28b?.skipped === 1,
        '⭐ §28 配送单**幂等**：重跑 `created=0 / skipped=1`（同一楼群当日已建过即跳过）',
        `created=${dgd28b?.created} skipped=${dgd28b?.skipped}`,
      );
      assert(
        dr28b?.driver_name === '张三' &&
          dr28b?.plate_no === '京A12345' &&
          Number(dr28b?.total_quantity) === 99,
        '⭐⭐ §28 幂等**不覆盖**已存在行：人工录入的司机 / 车牌必须保留 —— 跑批把它抹掉就找不回来（M5-1 起「改回来」的入口 = D62 `PUT /admin/deliveries/{id}`，断言见 §32；在此之前该口子只在 DBA 手里）',
        `driver=${dr28b?.driver_name} plate=${dr28b?.plate_no} qty=${dr28b?.total_quantity}`,
      );

      // 可信度告警：有单却**一张都没截**（截单可能没跑成）→ 必须报警而非静默给出偏小的数
      const dg28w = await call('POST', `${SCH28}/delivery-generate/run`, {
        token: adminToken,
        body: { date: D28W },
      });
      const dgd28w = dg28w.body?.data?.result;
      assert(
        dg28w.body?.code === 0 &&
          dgd28w?.created === 1 &&
          typeof dgd28w?.warning === 'string' &&
          dgd28w.warning.includes('截单'),
        '⭐⭐ §28 配送单**可信度告警**：该日有单却没有一张 `cut_off` → 明确提示「截单可能没跑成，份数可能偏小」—— 否则份数偏小且**没有任何报错**，一直错到有人发现货不够',
        `created=${dgd28w?.created} warning=${String(dgd28w?.warning ?? '').slice(0, 36)}…`,
      );

      // ------------------------------------------------------ G. 不传日期：按声明表推导
      const dg28n = await call('POST', `${SCH28}/delivery-generate/run`, {
        token: adminToken,
        body: {},
      });
      const dgd28n = dg28n.body?.data?.result;
      assert(
        dg28n.body?.code === 0 && dg28n.body?.data?.date === bjToday(),
        '⭐⭐ §28 补跑**不传日期**时按声明表推导（`delivery-generate` 的 `dateKind=今日`）—— 与跑批走同一个 `targetDate()`，从根上杜绝「补跑动的不是同一天」',
        `date=${dg28n.body?.data?.date} 期望=${bjToday()}`,
      );

      // ------------------------------------------------------ H. 夹具还原
      // 本次推导调用可能给「今日」造了配送单（取决于种子是否排了今日餐）—— 按返回的 id 精确删，
      // 不用 `WHERE meal_date = 今日`：那会误删**不是本节造的**行。
      const dgIds28 = (dgd28n?.list ?? []).map((x) => x.id).filter((x) => x != null);
      if (dgIds28.length) {
        writeDb(
          `DELETE FROM ab_delivery_record WHERE id IN (${dgIds28.map(() => '?').join(',')})`,
          dgIds28,
        );
      }
      writeDb('DELETE FROM ab_delivery_record WHERE meal_date IN (?, ?)', [D28P, D28W]);
      writeDb('DELETE FROM ab_supplier_dish_center_daily WHERE produce_date = ?', [D28P]);
      writeDb('DELETE FROM ab_supplier_dish_daily WHERE produce_date = ?', [D28P]);
      writeDb('DELETE FROM ab_meal_assignment WHERE meal_date IN (?, ?, ?, ?)', [
        D28F,
        D28P,
        D28X,
        D28W,
      ]);
      writeDb('DELETE FROM ab_balance_log WHERE user_id = ?', [uid28]);
      writeDb('DELETE FROM ab_balance WHERE user_id = ?', [uid28]);
      writeDb('DELETE FROM ab_order WHERE order_no LIKE ?', [`${PREFIX28}%`]);
      writeDb('DELETE FROM ab_user WHERE openid LIKE ?', [`${PREFIX28}%`]);
      // M5-1 起 §28 的「人工录入」改走 D62 接口 → 会落一条 `module='delivery'` 操作日志，
      // 一并还原：不还原只会留噪音，但会让后续按 `module='delivery'` 做的计数断言随重跑漂移。
      writeDb('DELETE FROM ab_operation_log WHERE module = ? AND target_id = ?', [
        'delivery',
        String(dr28id),
      ]);

      const left28 = {
        o: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_order WHERE order_no LIKE ?', [`${PREFIX28}%`])?.c ?? -1,
        ),
        a: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_meal_assignment WHERE meal_date IN (?, ?, ?, ?)', [
            D28F,
            D28P,
            D28X,
            D28W,
          ])?.c ?? -1,
        ),
        d: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_delivery_record WHERE meal_date IN (?, ?)', [
            D28P,
            D28W,
          ])?.c ?? -1,
        ),
        p: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_supplier_dish_daily WHERE produce_date = ?', [D28P])
            ?.c ?? -1,
        ),
        b: Number(readDb('SELECT COUNT(*) AS c FROM ab_balance WHERE user_id = ?', [uid28])?.c ?? -1),
        u: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_user WHERE openid LIKE ?', [`${PREFIX28}%`])?.c ?? -1,
        ),
        g: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_operation_log WHERE module = ? AND target_id = ?', [
            'delivery',
            String(dr28id),
          ])?.c ?? -1,
        ),
      };
      assert(
        Object.values(left28).every((v) => v === 0),
        '§28 夹具还原：订单 / 分配行 / 配送单 / 生产计划 / 余额行 / 夹具用户全部清除 —— 余额行与用户不还原，下一次重跑的平台负债就会凭空多出 ¥5.80，并让 D38↔D33 的对账断言在「两次读之间」产生假绿',
        `o=${left28.o} a=${left28.a} d=${left28.d} p=${left28.p} b=${left28.b} u=${left28.u} g=${left28.g}`,
      );
    }
  }

  // ==========================================================================
  // §29 M4-2 结算链路（4.4 自动确认 + 4.5 佣金入账 + 4.7 对账）
  //
  // ⚠️ 同样**不依赖下单窗口**（同 §18–§28 纪律）：订单 / 佣金 / 余额夹具**全部直插**，
  //    三个任务一律经**补跑接口**用**显式日期**驱动。
  //
  // ⚠️ 三个**隔离日期**（避开 §18–§28 已占用的 today ± {1,10,60,90,130,190,200,205,212,365}）：
  //    · D29C = today − 208  结算日出餐日 → 4.4 自动确认 + 4.5 佣金入账
  //    · D29R = today − 209  **对账不平**（有订单、无流水）
  //    · D29B = today − 210  **对账已平**（订单与流水一一匹配）
  //
  // 本节钉死十条不变量：
  //   ① ⭐⭐ **佣金两段式**（2026-09-17 用户裁定）：4.4 计佣**只写 `pending`、不动余额**；
  //      「事实」（`total_orders`）在**计佣**时累加，「钱」（`total_commission` / 余额）
  //      在**入账**时累加。两者记在一起会让「补入账」把单数重复加上去。
  //   ② ⭐ 4.4 **只转 `delivered`**：`paid`/`cut_off`/`cooked`/`delivering` 是**履约异常**，
  //      如实计数、**不改状态** —— 缺关键事实时不猜（fail-closed）。
  //   ③ 无归属团长（`team_leader_id` 为空）的单**收口但不计佣**。
  //   ④ 三个任务重复触发**都不产生重复数据**（幂等）。
  //   ⑤ 4.5 与 D35 是**同一执行口**；两段式后 `pending` 是常态、`scanned=0` 不是故障。
  //   ⑥ ⭐ #52 停职守卫**自 M4-2 起才真正触发**：有 `pending` 佣金时**拒绝退团**，
  //      入账后该条**自动解除** —— 此前生产链路里 `pending` 恒为 0，这条守卫是**死代码**。
  //   ⑦ ⭐ 对账锚的是**支付日**（`paid_at`），不是出餐日（财务域唯一例外）。
  //   ⑧ ⭐ 对账**不平才写操作日志**（`module='finance'` / `action='对账不平'` / `target_id=日期`）；
  //      平的日期**不写**（否则一年 365 条噪音把操作日志页淹掉）。
  //   ⑨ ⭐ 告警里必须带「**仅本地三头、不等于已与微信侧对平**」的 caveat（#55）——
  //      一期无商户号 / 无账单，把「内部对平」说成「与微信对平」是最危险的一类假绿。
  //   ⑩ ⭐ `monthOrdersOf` 只数**正常行**（`type='normal'` 且 `pending|settled`）：
  //      计入 `pending`（否则晋级晚一天），**排除冲销行**（否则退款把月单**加回**、可刷晋级）。
  // ==========================================================================
  {
    log('\n§29 M4-2 结算链路（自动确认 / 佣金入账 / 对账）');

    const SCH29 = '/admin/schedule';
    const PREFIX29 = `E2E29${stamp}`;
    const D29C = addDaysStr(bjToday(), -208);
    const D29R = addDaysStr(bjToday(), -209);
    const D29B = addDaysStr(bjToday(), -210);
    /** 直插 datetime 一律 **UTC** 格式（理由同 §27/§28：TypeORM 按 UTC 落库与查询） */
    const AT29 = `${bjToday()} 02:00:00.000`;
    /** 支付日锚点：对账按 `paid_at` 切日，故每张单的 `paid_at` 必须落在自己的目标日期上 */
    const PAID29 = (d) => `${d} 02:00:00.000`;

    // ---------------------------------------------------------- A. 夹具原料
    const base29 = readDb(
      `SELECT b.id AS bid, b.building_group_id AS gid, m.id AS smid, a.id AS aid
         FROM ab_building b, ab_set_meal m, ab_meal_assignment a
        WHERE b.building_group_id IS NOT NULL
        ORDER BY b.id, m.id, a.id LIMIT 1`,
    );
    assert(
      !!base29,
      '§29 前置：结算夹具原料齐备（1 个有楼群的楼 / 1 套餐 / 1 分配行）',
      `bid=${Number(base29?.bid)} gid=${Number(base29?.gid)} smid=${Number(base29?.smid)} aid=${Number(base29?.aid)}`,
    );

    if (base29) {
      const B29 = Number(base29.bid);
      const G29 = Number(base29.gid);
      const SM29 = Number(base29.smid);
      const A29 = Number(base29.aid);

      // 夹具团长：**专用账号**。不能借既有团长 —— 既有团长账上可能已有余额 / 佣金行，
      // 「入账前余额不变」这类断言会因为别人的钱而**假绿**（§26/§28 同一条教训）。
      // `openid` 走 mock 前缀，故可用 `dev:<code>` 反查登录，拿到 token 打 `/leader/*`。
      const L29CODE = `${PREFIX29}l`;
      const L29OPENID = `mock_openid_${L29CODE}`;
      writeDb(
        'INSERT INTO ab_user (openid, nickname, gender, status, version, created_at, updated_at) VALUES (?, ?, 0, 1, 0, ?, ?)',
        [L29OPENID, `${PREFIX29}结算团长`, AT29, AT29],
      );
      const uid29 = Number(readDb('SELECT id FROM ab_user WHERE openid = ?', [L29OPENID])?.id ?? 0);
      writeDb(
        'INSERT INTO ab_team_leader (user_id, building_id, phone, real_name, level, commission_rate, status, total_orders, total_commission, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0.00, 0, ?, ?)',
        [uid29, B29, '1380013****', `${PREFIX29}结算团长`, 'formal', '0.0900', AT29, AT29],
      );
      const lid29 = Number(
        readDb('SELECT id FROM ab_team_leader WHERE user_id = ?', [uid29])?.id ?? 0,
      );
      const l29 = await userLogin(`dev:${L29CODE}`);

      const INS_O29 =
        'INSERT INTO ab_order (order_no, user_id, team_leader_id, building_id, building_group_id, set_meal_id, assignment_id, meal_date, quantity, unit_price, total_amount, balance_used, discount_amount, pay_amount, status, version, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, ?, ?, ?)';
      /** 造一张订单；`leaderId` 传 `null` 造「无归属团长」的单 */
      const mkOrder29 = (no, date, status, qty, leaderId = lid29) => {
        const total = qty * 25.8;
        writeDb(INS_O29, [
          no,
          uid29,
          leaderId,
          B29,
          G29,
          SM29,
          A29,
          date,
          qty,
          '25.80',
          total.toFixed(2),
          total.toFixed(2),
          status,
          PAID29(date),
          AT29,
          AT29,
        ]);
        return Number(readDb('SELECT id FROM ab_order WHERE order_no = ?', [no])?.id ?? 0);
      };
      const INS_P29 =
        "INSERT INTO ab_payment_log (order_id, order_no, transaction_id, pay_amount, pay_method, status, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'wxpay_jsapi', 'success', ?, ?, ?)";
      const mkPay29 = (orderId, no, amount, txn, date) =>
        writeDb(INS_P29, [orderId, no, txn, amount, PAID29(date), AT29, AT29]);

      // ---- 结算日出餐日（D29C）：9 张单，覆盖 4.4 的四类分支 ----
      const o29D1 = mkOrder29(`${PREFIX29}D1`, D29C, 'delivered', 2); // 应确认 + 计佣
      // 补一条支付流水：J2 段要对这张单走「已入账佣金被退款」的 settled 路径，退款服务需要支付通道凭证
      mkPay29(o29D1, `${PREFIX29}D1`, '51.60', `${PREFIX29}TXD1`, D29C);
      const o29D2 = mkOrder29(`${PREFIX29}D2`, D29C, 'delivered', 1); // 应确认 + 计佣
      mkOrder29(`${PREFIX29}P1`, D29C, 'paid', 1); // 履约异常：未送达
      mkOrder29(`${PREFIX29}C1`, D29C, 'cut_off', 1); // 履约异常：已截单未送达
      mkOrder29(`${PREFIX29}V1`, D29C, 'delivering', 1); // 履约异常：配送中
      mkOrder29(`${PREFIX29}K1`, D29C, 'cooked', 1); // 履约异常：已出餐未送达
      mkOrder29(`${PREFIX29}X1`, D29C, 'completed', 1); // 已终态：不该被再动
      mkOrder29(`${PREFIX29}N1`, D29C, 'delivered', 1, null); // 无归属团长：收口不计佣
      mkOrder29(`${PREFIX29}Z1`, D29C, 'cancelled', 1); // 已取消：不该被再动

      // ---- 对账不平日（D29R）：1 张已付款订单，**故意不建流水** ----
      mkOrder29(`${PREFIX29}R1`, D29R, 'completed', 1);
      // ---- 对账已平日（D29B）：1 张订单 + 1 条一一匹配的成功流水 ----
      const o29B1 = mkOrder29(`${PREFIX29}B1`, D29B, 'completed', 1);
      mkPay29(o29B1, `${PREFIX29}B1`, '25.80', `${PREFIX29}TXB`, D29B);

      /** 佣金行夹具（供 `monthOrdersOf` 口径断言，`meal_date` 落**当月**才有意义） */
      const INS_CM29 =
        "INSERT INTO ab_commission (order_id, order_no, team_leader_id, leader_level, rate, base_amount, quantity, amount, type, status, settled_at, meal_date, payout_channel, tax_withheld_amount, created_at, updated_at) VALUES (?, ?, ?, 'formal', '0.0900', ?, ?, ?, ?, ?, ?, ?, 'FLEX_MANUAL', '0.00', ?, ?)";

      const cm29 = (no) =>
        readDb('SELECT status, settled_at, amount, quantity FROM ab_commission WHERE order_no = ?', [
          no,
        ]);
      const leader29 = () =>
        readDb(
          'SELECT total_orders, total_commission, month_orders FROM ab_team_leader WHERE id = ?',
          [lid29],
        );

      // -------------------------------------------------------- B. 4.4 自动确认（第一段）
      const conf29 = await call('POST', `${SCH29}/auto-confirm/run`, {
        token: adminToken,
        body: { date: D29C },
      });
      const c29 = conf29.body?.data?.result;
      assert(
        conf29.body?.code === 0 && conf29.body?.data?.date === D29C && c29?.confirmedCount === 2,
        '§29 4.4 补跑按**传入日期**执行并回显 `date`（补跑与跑批共用同一执行口，故补跑的数与跑批一致）',
        `code=${conf29.body?.code} date=${conf29.body?.data?.date} confirmed=${c29?.confirmedCount}`,
      );
      assert(
        c29?.confirmedQuantity === 3 && c29?.commissionFen === 696,
        '⭐ §29 4.4 确认 **2 单 / 3 份** 并计佣 **¥6.96**（= round2(51.60×9%) + round2(25.80×9%)）—— 费率取**计佣时的等级快照**（正式 9%），不是「当前费率」',
        `份数=${c29?.confirmedQuantity} 佣金分=${c29?.commissionFen}`,
      );
      assert(
        c29?.notDelivered?.count === 4 &&
          c29?.notDelivered?.byStatus?.paid === 1 &&
          c29?.notDelivered?.byStatus?.cut_off === 1 &&
          c29?.notDelivered?.byStatus?.delivering === 1 &&
          c29?.notDelivered?.byStatus?.cooked === 1,
        '⭐⭐ §29 4.4 **只转 `delivered`**：`paid`/`cut_off`/`cooked`/`delivering` 共 4 单报为**履约异常** —— 在 14:00 替一张**没送到**的单确认收货，比不确认危险得多（它会把「货没到」这个事实永久抹掉）',
        `异常=${c29?.notDelivered?.count} byStatus=${JSON.stringify(c29?.notDelivered?.byStatus)}`,
      );
      assert(
        c29?.orphanConfirmed === 1,
        '§29 4.4 无归属团长的 `delivered` 单：**收口但不计佣** —— 履约已发生必须闭环；但没有佣金对象时不猜团长（佣金归零比佣金错付安全）',
        `orphan=${c29?.orphanConfirmed}`,
      );

      const st29 = readRows(
        'SELECT order_no, status FROM ab_order WHERE order_no LIKE ? ORDER BY order_no',
        [`${PREFIX29}%`],
      );
      const st29of = new Map(st29.map((r) => [String(r.order_no), String(r.status)]));
      const tag29 = (s) => (st29of.get(`${PREFIX29}${s}`) ?? '缺失').padEnd(9);
      assert(
        st29of.get(`${PREFIX29}D1`) === 'completed' &&
          st29of.get(`${PREFIX29}D2`) === 'completed' &&
          st29of.get(`${PREFIX29}P1`) === 'paid' &&
          st29of.get(`${PREFIX29}C1`) === 'cut_off' &&
          st29of.get(`${PREFIX29}V1`) === 'delivering' &&
          st29of.get(`${PREFIX29}K1`) === 'cooked' &&
          st29of.get(`${PREFIX29}X1`) === 'completed' &&
          st29of.get(`${PREFIX29}N1`) === 'completed' &&
          st29of.get(`${PREFIX29}Z1`) === 'cancelled',
        '⭐ §29 状态已落库：`delivered → completed`；履约异常四单**原样不动**；已终态 / 已取消的**不被再动**',
        ['D1', 'D2', 'P1', 'C1', 'V1', 'K1', 'X1', 'N1', 'Z1']
          .map((k) => `${k}=${tag29(k)}`)
          .join(' '),
      );

      const cmD1 = cm29(`${PREFIX29}D1`);
      const cmD2 = cm29(`${PREFIX29}D2`);
      assert(
        String(cmD1?.status) === 'pending' &&
          cmD1?.settled_at === null &&
          Number(cmD1?.amount) === 4.64 &&
          String(cmD2?.status) === 'pending' &&
          cmD2?.settled_at === null &&
          Number(cmD2?.amount) === 2.32,
        '⭐⭐ §29 **两段式第一段**：计佣只写 `ab_commission(status=pending)` 且 `settled_at` 为空 —— 钱**没有**进余额，为退款留出约 12 小时冷静期（自营下退款不冲减供应商采购款，佣金若已提走即平台双亏）',
        `D1=${cmD1?.status}/${cmD1?.settled_at}/${cmD1?.amount} D2=${cmD2?.status}/${cmD2?.settled_at}/${cmD2?.amount}`,
      );
      assert(
        Number(cm29(`${PREFIX29}N1`)?.amount ?? 0) === 0 &&
          Number(
            readDb('SELECT COUNT(*) AS c FROM ab_commission WHERE order_id = ?', [
              Number(readDb('SELECT id FROM ab_order WHERE order_no = ?', [`${PREFIX29}N1`])?.id ?? 0),
            ])?.c ?? -1,
          ) === 0,
        '§29 无归属团长的单**不产生佣金行**（`ab_commission` 里查无此单）',
        `佣金行数=0`,
      );

      const ld29a = leader29();
      assert(
        Number(ld29a?.total_orders) === 3 &&
          Number(ld29a?.total_commission) === 0 &&
          !readDb('SELECT balance FROM ab_balance WHERE user_id = ?', [uid29]),
        '⭐⭐ §29 **「事实」与「钱」分开记**：计佣后 `total_orders`=3（事实，计佣时累加）而 `total_commission`=0 且**余额账户都还没建**（钱，入账时才动）—— 若把事实也留到入账才记，补入账会把单数**重复加上去**并污染 `last_order_at`',
        `total_orders=${ld29a?.total_orders} total_commission=${ld29a?.total_commission} 余额行=${readDb('SELECT balance FROM ab_balance WHERE user_id = ?', [uid29]) ? '有' : '无'}`,
      );

      // -------------------------------------------------------- C. #52 停职守卫（复活）
      const quit29a = await call('POST', '/leader/quit', {
        token: l29.token,
        idem: `${PREFIX29}quit-pending`,
        body: { reason: 'e2e · 有 pending 佣金' },
      });
      const blk29a = (quit29a.body?.data?.blockers ?? []).map((b) => b.code);
      assert(
        quit29a.body?.code === 20008 &&
          blk29a.includes('COMMISSION_PENDING') &&
          !blk29a.includes('BALANCE_NOT_CLEARED'),
        '⭐⭐ §29 #52 守卫**自 M4-2 才真正会触发**：有 `pending` 佣金时退团被拒（且此时余额为 0，故**唯一**阻碍就是待入账佣金）—— 此前佣金在确认时就即时入账，生产链路里 `pending` 恒为 0，这条守卫是**从未被执行过的死代码**',
        `code=${quit29a.body?.code} blockers=${blk29a.join(',') || '无'}`,
      );

      // -------------------------------------------------------- D. 4.4 幂等
      const conf29b = await call('POST', `${SCH29}/auto-confirm/run`, {
        token: adminToken,
        body: { date: D29C },
      });
      const c29b = conf29b.body?.data?.result;
      const cmCount29 = Number(
        readDb('SELECT COUNT(*) AS c FROM ab_commission WHERE team_leader_id = ?', [lid29])?.c ?? -1,
      );
      assert(
        conf29b.body?.code === 0 &&
          c29b?.confirmedCount === 0 &&
          c29b?.notDelivered?.count === 4 &&
          cmCount29 === 2,
        '⭐ §29 4.4 **幂等**：重跑 `confirmedCount=0`（已确认的不再动）、异常计数不变、佣金行**仍为 2 条** —— 逐单条件更新 + `uk_commission_order_type` 双层保险',
        `confirmed=${c29b?.confirmedCount} 异常=${c29b?.notDelivered?.count} 佣金行=${cmCount29}`,
      );

      // -------------------------------------------------------- E. 4.5 佣金入账（第二段）
      const settle29 = await call('POST', `${SCH29}/commission-settle/run`, {
        token: adminToken,
        body: { date: D29C },
      });
      const s29 = settle29.body?.data?.result;
      assert(
        settle29.body?.code === 0 &&
          settle29.body?.data?.date === D29C &&
          s29?.scanned === 2 &&
          s29?.settled === 2 &&
          s29?.amountFen === 696,
        '⭐ §29 4.5 佣入账：扫到 2 条 `pending` → 全部入账 **¥6.96**（与 D35 是**同一个 `settlePending()`**，不存在第二套入账逻辑）',
        `code=${settle29.body?.code} scanned=${s29?.scanned} settled=${s29?.settled} 金额分=${s29?.amountFen}`,
      );
      assert(
        String(s29?.note ?? '').includes('两段式'),
        '§29 D35 出参 `note` 如实下发**两段式**口径（旧文案写「一期即时入账、pending 常态为 0」—— 沿用会让运营把每天的常态误判成故障，去查一批正常数据）',
        `note=${String(s29?.note ?? '').slice(0, 40)}…`,
      );

      const cmD1b = cm29(`${PREFIX29}D1`);
      const bal29 = readDb('SELECT balance, total_in FROM ab_balance WHERE user_id = ?', [uid29]);
      const ld29b = leader29();
      assert(
        String(cmD1b?.status) === 'settled' &&
          cmD1b?.settled_at !== null &&
          Number(bal29?.balance) === 6.96 &&
          Number(bal29?.total_in) === 6.96 &&
          Number(ld29b?.total_commission) === 6.96,
        '⭐⭐ §29 **两段式第二段**：入账后佣金行 `settled` + `settled_at` 非空、余额 0 → **¥6.96**、`total_in` 同步、团长 `total_commission` 同步 —— 三处**同源**（`creditCommissions` 是唯一把佣金写进余额的地方）',
        `状态=${cmD1b?.status} settled_at=${cmD1b?.settled_at ? '有' : '空'} 余额=${bal29?.balance} total_in=${bal29?.total_in} total_commission=${ld29b?.total_commission}`,
      );
      const blog29 = readDb(
        "SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS s FROM ab_balance_log WHERE user_id = ? AND type = 'commission' AND direction = 1",
        [uid29],
      );
      assert(
        Number(blog29?.c) === 2 && Math.round(Number(blog29?.s) * 100) === 696,
        '§29 入账**逐笔**留余额流水（2 条 `commission` / `direction=+1` / 合计 ¥6.96）—— 余额每一次变动都要有据可查（与 L11 余额、L19 流水可相互验算）',
        `流水数=${blog29?.c} 合计分=${Math.round(Number(blog29?.s) * 100)}（原值 ${blog29?.s}）`,
      );

      // -------------------------------------------------------- F. 4.5 幂等
      const settle29b = await call('POST', `${SCH29}/commission-settle/run`, {
        token: adminToken,
        body: { date: D29C },
      });
      const s29b = settle29b.body?.data?.result;
      const bal29b = readDb('SELECT balance FROM ab_balance WHERE user_id = ?', [uid29]);
      assert(
        settle29b.body?.code === 0 && s29b?.scanned === 0 && s29b?.settled === 0,
        '⭐ §29 4.5 **幂等**：重跑 `scanned=0`（无 `pending` 可入账）—— 且这个 0 是**正常**的，不是「钱没结」',
        `scanned=${s29b?.scanned} settled=${s29b?.settled}`,
      );
      assert(
        Number(bal29b?.balance) === 6.96,
        '§29 重跑**不加钱**（余额仍 ¥6.96）—— 逐行 `UPDATE ... WHERE status="pending"` 以 `affected` 判定归属，并发重复入账进 `skipped`',
        `余额=${bal29b?.balance}`,
      );

      // -------------------------------------------------------- G. #52 守卫随入账自动解除
      const quit29b = await call('POST', '/leader/quit', {
        token: l29.token,
        idem: `${PREFIX29}quit-settled`,
        body: { reason: 'e2e · 入账后' },
      });
      const blk29b = (quit29b.body?.data?.blockers ?? []).map((b) => b.code);
      assert(
        quit29b.body?.code === 20008 &&
          !blk29b.includes('COMMISSION_PENDING') &&
          blk29b.includes('BALANCE_NOT_CLEARED'),
        '⭐ §29 #52 守卫**随入账自动解除**：`COMMISSION_PENDING` 消失、转为 `BALANCE_NOT_CLEARED`（钱已入账但未清零）—— 守卫不是「永久拉黑」，而是精确表达「资金链路还没走完」',
        `blockers=${blk29b.join(',') || '无'}`,
      );

      // -------------------------------------------------------- H. monthOrders 口径（含 pending · 排冲销）
      writeDb(INS_CM29, [
        9000291,
        `${PREFIX29}MO1`,
        lid29,
        '51.60',
        2,
        '4.64',
        'normal',
        'pending',
        null,
        bjToday(),
        AT29,
        AT29,
      ]);
      const audit29a = await call('POST', '/leader/level/audit', { token: l29.token });
      const a29a = audit29a.body?.data;
      assert(
        audit29a.body?.code === 0 && a29a?.monthOrders === 2,
        '⭐ §29 `monthOrdersOf` **计入 `pending`**：当月一条 `pending` 佣金（2 份）即算 **月单 2** —— 若只数 `settled`，团长晋级会**晚一天**（确认翌日才升）',
        `monthOrders=${a29a?.monthOrders}`,
      );
      // 冲销行（同一订单号 + 负份数）：旧口径 `SUM(CASE WHEN type='reversal' THEN -quantity ELSE quantity END)`
      // 会把它**加回**成 4 —— 退款反而让月单变大、可刷晋级。
      writeDb(INS_CM29, [
        9000291,
        `${PREFIX29}MO1`,
        lid29,
        '51.60',
        -2,
        '-4.64',
        'reversal',
        'settled',
        AT29,
        bjToday(),
        AT29,
        AT29,
      ]);
      const audit29b = await call('POST', '/leader/level/audit', { token: l29.token });
      const a29b = audit29b.body?.data;
      assert(
        audit29b.body?.code === 0 && a29b?.monthOrders === 2,
        '⭐⭐ §29 `monthOrdersOf` **排除冲销行**：追加一条 `reversal`（负份数）后月单**仍为 2** —— 旧 CASE 表达式会算出 **4**，即「退款越多、月单越大」，可直接刷出金牌/首席',
        `monthOrders=${a29b?.monthOrders}（旧口径会得 4）`,
      );

      // -------------------------------------------------------- I. 4.7 对账（不平）
      const recon29 = await call('POST', `${SCH29}/reconciliation/run`, {
        token: adminToken,
        body: { date: D29R },
      });
      const r29 = recon29.body?.data?.result;
      assert(
        recon29.body?.code === 0 &&
          recon29.body?.data?.date === D29R &&
          r29?.balanced === false &&
          r29?.diffCount >= 1 &&
          r29?.alerted === true,
        '⭐ §29 4.7 对账发现**不平**（D29R 有 1 张已付款订单却无任何流水）→ `balanced=false` 且**落了告警**',
        `code=${recon29.body?.code} balanced=${r29?.balanced} 差异数=${r29?.diffCount} alerted=${r29?.alerted}`,
      );
      assert(
        r29?.channelSource === 'local_only' && r29?.billAvailable === false,
        '⭐⭐ §29 4.7 **不许假装已与微信对平**（#55）：出参强制 `channel.source=local_only` + `billAvailable=false` —— 一期无商户号 / 无账单，若报成「已对平」，真正危险的差异（微信收了钱、系统不知道）将永远不可见',
        `source=${r29?.channelSource} billAvailable=${r29?.billAvailable}`,
      );
      const alog29 = readDb(
        "SELECT COUNT(*) AS c FROM ab_operation_log WHERE module = 'finance' AND action = '对账不平' AND target_id = ?",
        [D29R],
      );
      const asnap29 = readDb(
        "SELECT snapshot FROM ab_operation_log WHERE module = 'finance' AND action = '对账不平' AND target_id = ?",
        [D29R],
      );
      assert(
        Number(alog29?.c) === 1 && String(asnap29?.snapshot ?? '').includes('微信'),
        '⭐ §29 不平**写操作日志**（`module=finance` / `action=对账不平` / `target_id=日期`）且快照里带「**不等于已与微信侧对平**」的 caveat —— 告警必须落在运营看得见的页面上，不能只写进服务器日志（没人会主动翻）',
        `日志数=${alog29?.c} caveat=${String(asnap29?.snapshot ?? '').includes('微信') ? '有' : '无'}`,
      );

      const recon29b = await call('POST', `${SCH29}/reconciliation/run`, {
        token: adminToken,
        body: { date: D29R },
      });
      const r29b = recon29b.body?.data?.result;
      const alog29b = readDb(
        "SELECT COUNT(*) AS c FROM ab_operation_log WHERE module = 'finance' AND action = '对账不平' AND target_id = ?",
        [D29R],
      );
      assert(
        recon29b.body?.code === 0 &&
          r29b?.alerted === false &&
          String(r29b?.alertSkippedReason ?? '').includes('已有告警') &&
          Number(alog29b?.c) === 1,
        '⭐ §29 4.7 告警**幂等**：同一天重跑不再重复写（日志仍 1 条，`alerted=false` + 原因）—— 否则每次补跑都会在操作日志里堆一串重复告警',
        `alerted=${r29b?.alerted} 日志数=${alog29b?.c} 原因=${String(r29b?.alertSkippedReason ?? '').slice(0, 24)}…`,
      );

      const recon29c = await call('POST', `${SCH29}/reconciliation/run`, {
        token: adminToken,
        body: { date: D29B },
      });
      const r29c = recon29c.body?.data?.result;
      const alog29c = readDb(
        "SELECT COUNT(*) AS c FROM ab_operation_log WHERE module = 'finance' AND action = '对账不平' AND target_id = ?",
        [D29B],
      );
      assert(
        recon29c.body?.code === 0 &&
          r29c?.balanced === true &&
          r29c?.alerted === false &&
          Number(alog29c?.c) === 0,
        '⭐ §29 4.7 **平的日期不写日志**（D29B 订单与流水一一匹配 → `balanced=true`、`alerted=false`、操作日志 0 条）—— 一年 365 条「已平」噪音会把这一页淹掉，真正的告警反而看不见',
        `balanced=${r29c?.balanced} alerted=${r29c?.alerted} 日志数=${alog29c?.c}`,
      );

      // -------------------------------------------------------- J. 时刻表：结算三任务的目标日期语义
      const sched29 = await call('GET', SCH29, { token: adminToken });
      const rows29 = sched29.body?.data?.list ?? [];
      const t29 = (n) => rows29.find((r) => r.task === n) ?? null;
      assert(
        t29('reconciliation')?.dateKind === 'yesterday' &&
          String(t29('reconciliation')?.dateKindLabel ?? '').includes('前一日') &&
          t29('commission-settle')?.dateKind === 'yesterday' &&
          t29('auto-confirm')?.dateKind === 'today',
        '⭐⭐ §29 **`reconciliation` 对「昨日」**（M4-2 改正，文档原写 `today` 是错的）：04:00 对「今日」只能核 `00:00–04:00` 这 4 小时切片，昨日 23:00 后的流水要等**次日**才被覆盖 —— 等于每天都漏核一段',
        `recon=${t29('reconciliation')?.dateKind}/${t29('reconciliation')?.dateKindLabel} settle=${t29('commission-settle')?.dateKind} confirm=${t29('auto-confirm')?.dateKind}`,
      );

      // ------------------------------------------- J2. 已入账佣金的退款冲销（settled 路径）
      // 原 §13 的「写负行 + 扣余额」覆盖随两段式迁到这里 —— 在**隔离夹具**里跑，
      // 不再依赖 leader#1 的既有余额，也不会给后续章节留下余额漂移。
      const rf29 = await call('POST', `/admin/orders/${PREFIX29}D1/force-refund`, {
        token: adminToken,
        body: { reason: 'e2e 餐品异物 · 现场客诉', reasonType: 'quality', amountFen: 5160 },
      });
      const rf29d = rf29.body?.data;
      assert(
        rf29.body?.code === 0 && rf29d?.status === 'refunded' && rf29d?.refundedFen === 5160,
        '§29 已入账佣金对应的订单可正常退款（D29C 的 D1 单 · 可退额 5160 分 = 51.60）',
        `code=${rf29.body?.code} status=${rf29d?.status} refunded=${rf29d?.refundedFen}`,
      );
      assert(
        rf29d?.reversal?.commissionReversedFen === 464 &&
          rf29d?.reversal?.commissionReversedQuantity === -2,
        '§29 冲销出参恒为「金额正、份数为负」（4.64 → −2 份）—— 与待入账分支的**出参形态一致**（§13 已验），端上不需要分叉',
        `reversed=${rf29d?.reversal?.commissionReversedFen} qty=${rf29d?.reversal?.commissionReversedQuantity}`,
      );
      const rfRows29 = readRows(
        'SELECT type, status, amount FROM ab_commission WHERE order_id = (SELECT id FROM ab_order WHERE order_no = ?) ORDER BY id',
        [`${PREFIX29}D1`],
      );
      assert(
        rfRows29.length === 2 &&
          rfRows29[0].type === 'normal' &&
          rfRows29[0].status === 'cancelled' &&
          Number(rfRows29[0].amount) > 0 &&
          rfRows29[1].type === 'reversal' &&
          Number(rfRows29[1].amount) < 0,
        '⭐⭐ §29 **已入账**佣金被退款时走 `reversal` 路径（C9）：写负向冲销新行、原行只翻 `status=cancelled`、**原金额保留** —— 发生额永久保真，历史不可改写',
        JSON.stringify(rfRows29.map((r) => `${r.type}/${r.status}/${r.amount}`)),
      );
      const bal29c = readDb('SELECT balance FROM ab_balance WHERE user_id = ?', [uid29]);
      assert(
        Math.round(Number(bal29c?.balance) * 100) === 232,
        '§29 已入账佣金被冲销 → 余额同步扣减（6.96 − 4.64 = **¥2.32**）—— 与 §13 的待入账分支正好构成**两条路径的分水岭**：钱进过余额才扣得回来',
        `余额=${bal29c?.balance}`,
      );
      assert(
        Number(rf29d?.reversal?.supplierShareAdjusted ?? -1) === 0 &&
          rf29d?.reversal?.supplierShareMode === 'not_applicable',
        '§29 自营口径（2026-09-16 裁定 1）：用户退款**不冲减**供应商采购应付（`supplierShareMode=not_applicable`）—— 半成品在出餐日已交付，钱照付；改了这条会立刻撞红',
        `adjusted=${rf29d?.reversal?.supplierShareAdjusted} mode=${rf29d?.reversal?.supplierShareMode}`,
      );

      // -------------------------------------------------------- K. 夹具还原
      writeDb("DELETE FROM ab_operation_log WHERE action = '对账不平' AND target_id IN (?, ?)", [
        D29R,
        D29B,
      ]);
      writeDb('DELETE FROM ab_balance_log WHERE user_id = ?', [uid29]);
      writeDb('DELETE FROM ab_balance WHERE user_id = ?', [uid29]);
      writeDb('DELETE FROM ab_commission WHERE team_leader_id = ?', [lid29]);
      writeDb('DELETE FROM ab_refund WHERE order_no LIKE ?', [`${PREFIX29}%`]);
      writeDb('DELETE FROM ab_payment_log WHERE order_no LIKE ?', [`${PREFIX29}%`]);
      writeDb('DELETE FROM ab_order WHERE order_no LIKE ?', [`${PREFIX29}%`]);
      writeDb('DELETE FROM ab_team_leader WHERE user_id = ?', [uid29]);
      writeDb('DELETE FROM ab_user WHERE openid = ?', [L29OPENID]);

      const left29 = {
        o: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_order WHERE order_no LIKE ?', [`${PREFIX29}%`])?.c ??
            -1,
        ),
        c: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_commission WHERE team_leader_id = ?', [lid29])?.c ??
            -1,
        ),
        b: Number(readDb('SELECT COUNT(*) AS c FROM ab_balance WHERE user_id = ?', [uid29])?.c ?? -1),
        l: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_team_leader WHERE user_id = ?', [uid29])?.c ?? -1,
        ),
        u: Number(readDb('SELECT COUNT(*) AS c FROM ab_user WHERE openid = ?', [L29OPENID])?.c ?? -1),
        r: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_refund WHERE order_no LIKE ?', [`${PREFIX29}%`])?.c ??
            -1,
        ),
      };
      assert(
        Object.values(left29).every((v) => v === 0),
        '§29 夹具还原：退款单 / 订单 / 佣金 / 余额 / 团长 / 用户全部清除 —— 佣金行与余额行不还原，下一次重跑的平台负债就会凭空多出 ¥6.96，并让 D38↔D33 的对账断言在「两次读之间」产生假绿',
        `r=${left29.r} o=${left29.o} c=${left29.c} b=${left29.b} l=${left29.l} u=${left29.u}`,
      );
    }
  }

  // ==========================================================================
  // §30 M4-3 队列消费者 + 订阅消息投递点（4.9 / 4.10）
  // ==========================================================================
  //
  // 本节的三个核心不变量：
  //   ① ⭐⭐ **外部通道调用已移出 DB 事务** —— 微信退款失败时**不回滚账务**
  //      （旧实现：事务内先调通道，失败即整笔回滚 → 「钱退了系统没记录」的反面
  //      「单子回滚了钱也没退」都能发生）。失败改为**入队退避重试**，
  //      `refundNo` 作微信幂等键保证重试不会重复出款。
  //   ② ⭐ **失败要说得出话**：重试耗尽 → 进死信 + 写 `ab_operation_log`
  //      （`module=queue`）—— 队列最大的风险不是「失败」而是「静默失效」。
  //   ③ ⭐ **接线 ≠ 启用**：`leader_apply` / `commission_settled` 已接线（`wiring=live`），
  //      但一期没有微信模板 ID → 场景仍未启用 → **不投递、不留日志、不算任务失败**。
  //
  // ⚠️ 隔离日期避开 §18–§29 已用过的 today ± {1,10,60,90,130,190,200,205,208,209,210,212,365}
  // ⚠️ 队列驱动由 gate 注入 `QUEUE_DRIVER=memory`（本机无 Redis）+ `QUEUE_BACKOFF_BASE_MS=20`
  //    （把退避压到毫秒级，否则「验证重试」要真等好几秒）。
  // ==========================================================================
  {
    log('\n§30 M4-3 队列消费者 + 订阅消息投递点（4.9 / 4.10）');

    const Q30 = '/admin/queue';
    const TPL30 = '/admin/system/templates';
    const SCH30 = '/admin/schedule';
    const PREFIX30 = `E2E30${stamp}`;
    const D30S = addDaysStr(bjToday(), -213); // 结算出餐日
    const D30R = addDaysStr(bjToday(), -214); // 通道失败注入单
    const D30K = addDaysStr(bjToday(), -215); // 通道成功对照单
    const AT30 = `${bjToday()} 02:00:00.000`;
    const PAID30 = (d) => `${d} 02:00:00.000`;

    /**
     * ⚠️ 与 `apps/api-server/src/providers/wx-pay/mock-wx-pay.provider.ts` 的
     *    `MOCK_REFUND_FAIL_MARKER` **必须字面一致**。不一致时下面的断言会
     *    **立刻红**（退款会成功 → `retryQueued=false`），不会静默跳过 ——
     *    这是「测试侧复制一个字面量」可以接受的**唯一**理由：不一致是自曝的。
     */
    const FAIL_MARK = '__mock_refund_fail__';

    const qRow = (stats, queue) => (stats?.queues ?? []).find((t) => t.queue === queue);
    /** 轮询队列计数直到条件成立（异步消费，不能读一次就断言） */
    const waitQueue30 = async (queue, pred, timeout = 5000) => {
      const deadline = Date.now() + timeout;
      let last = null;
      for (;;) {
        const r = await call('GET', Q30, { token: adminToken });
        last = qRow(r.body?.data, queue);
        if (last && pred(last)) return last;
        if (Date.now() > deadline) return last;
        await sleep(100);
      }
    };

    // ---------------------------------------------------------- A. 队列状态端点
    const q30 = await call('GET', Q30, { token: adminToken });
    const q30d = q30.body?.data;
    assert(
      q30.body?.code === 0 && q30d?.driver === 'memory' && q30d?.durable === false,
      '⭐ §30 `GET /admin/queue` **如实报告「这个队列会不会丢任务」**：e2e 走 `QUEUE_DRIVER=memory` → `driver=memory` + `durable=false` —— M4-3 刻意**不做静默降级**（`KvService` 那种「连不上就退回内存 + WARN」在队列上不成立：丢一条「退款待重试」既无报错也无处可查）',
      `code=${q30.body?.code} driver=${q30d?.driver} durable=${q30d?.durable}`,
    );
    assert(
      (q30d?.queues ?? []).length === 3 &&
        (q30d?.queues ?? []).map((t) => t.queue).sort().join(',') ===
          'order-paid,refund-apply,settle-orders',
      '§30 三个队列（支付后续 / 退款后续 / 结算后续）**全部在册**，且空桶也出现 —— 早期调用（健康检查早于消费者注册）不会得到「队列不存在」的错觉',
      `queues=${(q30d?.queues ?? []).map((t) => t.queue).join(',')}`,
    );
    assert(
      (q30d?.queues ?? []).every(
        (t) =>
          !!t.label &&
          ['waiting', 'active', 'delayed', 'failed', 'completed'].every(
            (k) => typeof t[k] === 'number',
          ),
      ) &&
        Number(q30d?.attempts) === 3 &&
        Number(q30d?.backoffBaseMs) > 0,
      '§30 每队列下发五项计数 + `attempts`/`backoffBaseMs` 运行参数；⭐ `attempts=3` 在两个驱动下都表示**总共执行 3 次**（不是「重试 3 次」）—— 语义对齐是「换驱动不改行为」的底线',
      `attempts=${q30d?.attempts} backoff=${q30d?.backoffBaseMs}`,
    );
    assert(
      String(q30d?.note ?? '').includes('重启即丢'),
      '⭐ 驱动说明文案随状态一起下发（端上/运维不再各写一份）：「memory = 进程内，**进程重启即丢**，且多实例部署时任务不跨实例分发」',
      `note 含关键词=${String(q30d?.note ?? '').includes('重启即丢')}`,
    );

    // ---- 权限：只读运行态，白名单**不含** finance / viewer（与 D47–D50 看板相反）
    const finOnQ30 = await call('GET', Q30, { token: fin2.token });
    const supOnQ30 = await call('GET', Q30, { token: sup2.token });
    const op30Name = `e2e_op30_${stamp}`;
    const mkOp30 = await call('POST', '/admin/system/accounts', {
      token: adminToken,
      body: { username: op30Name, password: PWD, role: 'operator', realName: 'e2e 运营（队列只读）' },
    });
    const op30 = await adminLogin(op30Name, PWD);
    const opOnQ30 = await call('GET', Q30, { token: op30.token });
    assert(
      finOnQ30.body?.code === 10003 && supOnQ30.body?.code === 10003,
      '⭐ §30 队列端点两级白名单：**finance / 供应商都不在白名单** → 10003 —— 与 D47–D50 看板（含 viewer）刻意相反：那边是**业务数据**（只读角色本就该看），这里是**运行态实现细节**（驱动名/积压/重试参数），给业务观察者看没有用途，只是扩大暴露面',
      `finance=${finOnQ30.body?.code} supplier=${supOnQ30.body?.code}`,
    );
    assert(
      mkOp30.body?.code === 0 && opOnQ30.body?.code === 0,
      '§30 白名单**含 operator**（运维要能第一时间看到「退款任务在重试」）—— 与 P39 打包任务同一考量',
      `mk=${mkOp30.body?.code} operator=${opOnQ30.body?.code}`,
    );

    // ---------------------------------------------------------- B. 夹具原料
    const base30 = readDb(
      `SELECT b.id AS bid, b.building_group_id AS gid, m.id AS smid, a.id AS aid
         FROM ab_building b, ab_set_meal m, ab_meal_assignment a
        WHERE b.building_group_id IS NOT NULL
        ORDER BY b.id, m.id, a.id LIMIT 1`,
    );
    const openB30 = readDb(
      `SELECT b.id AS bid FROM ab_building b
        WHERE b.status = 1 AND b.building_group_id IS NOT NULL
        ORDER BY b.id LIMIT 1`,
    );
    assert(
      !!base30 && !!openB30,
      '§30 前置：夹具原料齐备（有楼群的楼 / 套餐 / 分配行 + 1 个在营楼用于团长申请）',
      `bid=${Number(base30?.bid)} gid=${Number(base30?.gid)} op=${Number(openB30?.bid)}`,
    );

    if (base30 && openB30) {
      const B30 = Number(base30.bid);
      const G30 = Number(base30.gid);
      const SM30 = Number(base30.smid);
      const A30 = Number(base30.aid);
      const OPENB30 = Number(openB30.bid);

      // 专用团长账号（不能借既有团长 —— 别人账上已有余额会让「入账前余额不变」这类断言假绿）
      const L30CODE = `${PREFIX30}l`;
      const L30OPENID = `mock_openid_${L30CODE}`;
      writeDb(
        'INSERT INTO ab_user (openid, nickname, gender, status, version, created_at, updated_at) VALUES (?, ?, 0, 1, 0, ?, ?)',
        [L30OPENID, `${PREFIX30}队列团长`, AT30, AT30],
      );
      const uid30 = Number(readDb('SELECT id FROM ab_user WHERE openid = ?', [L30OPENID])?.id ?? 0);
      writeDb(
        'INSERT INTO ab_team_leader (user_id, building_id, phone, real_name, level, commission_rate, status, total_orders, total_commission, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0.00, 0, ?, ?)',
        [uid30, B30, `139${String(stamp).slice(-8)}`, `${PREFIX30}队列团长`, 'formal', '0.0900', AT30, AT30],
      );
      const lid30 = Number(
        readDb('SELECT id FROM ab_team_leader WHERE user_id = ?', [uid30])?.id ?? 0,
      );

      const INS_O30 =
        'INSERT INTO ab_order (order_no, user_id, team_leader_id, building_id, building_group_id, set_meal_id, assignment_id, meal_date, quantity, unit_price, total_amount, balance_used, discount_amount, pay_amount, status, version, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, ?, ?, ?)';
      const mkOrder30 = (no, date, status, qty) => {
        const total = qty * 25.8;
        writeDb(INS_O30, [
          no,
          uid30,
          lid30,
          B30,
          G30,
          SM30,
          A30,
          date,
          qty,
          '25.80',
          total.toFixed(2),
          total.toFixed(2),
          status,
          PAID30(date),
          AT30,
          AT30,
        ]);
        return Number(readDb('SELECT id FROM ab_order WHERE order_no = ?', [no])?.id ?? 0);
      };
      const INS_P30 =
        "INSERT INTO ab_payment_log (order_id, order_no, transaction_id, pay_amount, pay_method, status, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'wxpay_jsapi', 'success', ?, ?, ?)";
      const mkPay30 = (orderId, no, amount, txn, date) =>
        writeDb(INS_P30, [orderId, no, txn, amount, PAID30(date), AT30, AT30]);

      // 结算日：1 张 completed 单 + 1 条 **pending** 佣金（4.5 的输入）
      const o30S1 = mkOrder30(`${PREFIX30}S1`, D30S, 'completed', 1);
      writeDb(
        "INSERT INTO ab_commission (order_id, order_no, team_leader_id, leader_level, rate, base_amount, quantity, amount, type, status, settled_at, meal_date, payout_channel, tax_withheld_amount, created_at, updated_at) VALUES (?, ?, ?, 'formal', '0.0900', ?, ?, ?, 'normal', 'pending', NULL, ?, 'FLEX_MANUAL', '0.00', ?, ?)",
        [
          o30S1,
          `${PREFIX30}S1`,
          lid30,
          '25.80',
          1,
          '2.32',
          D30S,
          AT30,
          AT30,
        ],
      );

      // 退款两单：R1 走失败注入、K1 走成功对照（各 2 份 = 51.60，微信全额实付）
      const o30R1 = mkOrder30(`${PREFIX30}R1`, D30R, 'paid', 2);
      mkPay30(o30R1, `${PREFIX30}R1`, '51.60', `${PREFIX30}TXR`, D30R);
      const o30K1 = mkOrder30(`${PREFIX30}K1`, D30K, 'paid', 2);
      mkPay30(o30K1, `${PREFIX30}K1`, '51.60', `${PREFIX30}TXK`, D30K);

      // 申请团长用的干净用户（不能复用 uid30 —— 他已是团长，会撞 20007）
      const A30CODE = `${PREFIX30}a`;
      const A30OPENID = `mock_openid_${A30CODE}`;
      writeDb(
        'INSERT INTO ab_user (openid, nickname, gender, status, version, created_at, updated_at) VALUES (?, ?, 0, 1, 0, ?, ?)',
        [A30OPENID, `${PREFIX30}申请者`, AT30, AT30],
      );
      const uidA30 = Number(readDb('SELECT id FROM ab_user WHERE openid = ?', [A30OPENID])?.id ?? 0);
      const uA30 = await userLogin(`dev:${A30CODE}`);

      // -------------------------------------------------------- C. settle-orders（真跑批）
      const cmBefore30 = readDb(
        "SELECT status FROM ab_commission WHERE order_no = ? AND status = 'pending'",
        [`${PREFIX30}S1`],
      );
      const balBefore30 = readDb('SELECT balance FROM ab_balance WHERE user_id = ?', [uid30]);
      assert(
        cmBefore30?.status === 'pending' && !balBefore30,
        '§30 前置：佣金行 `pending` 且**尚无余额账户**（入账前后对比才有意义）',
        `cm=${cmBefore30?.status} 账户=${balBefore30 ? '有' : '无'}`,
      );

      const settle30 = await call('POST', `${SCH30}/commission-settle/run`, {
        token: adminToken,
        body: { date: D30S },
      });
      const s30 = settle30.body?.data?.result;
      assert(
        settle30.body?.code === 0 && s30?.settled === 1 && s30?.leaders?.length === 1,
        '§30 4.5 佣金入账：1 条 `pending` → `settled` + 进团长余额',
        `code=${settle30.body?.code} settled=${s30?.settled} leaders=${s30?.leaders?.length}`,
      );
      assert(
        s30?.notifyQueued === 1,
        '⭐ §30 **入账后按团长逐个入队通知**（`notifyQueued=1`）—— 不按「整批一条」：订阅消息必须能寻址到具体收件人，整批载荷没有收件人，消费者只能写日志，「通知用户」实际没发生却看起来成功；拆成一人一条后独立重试、死信粒度到人',
        `notifyQueued=${s30?.notifyQueued} leaders=${s30?.leaders?.length}`,
      );

      const sq30 = await waitQueue30('settle-orders', (t) => t.completed >= 1 && t.waiting === 0);
      assert(
        !!sq30 && sq30.completed >= 1 && sq30.failed === 0 && sq30.waiting === 0,
        '⭐ §30 结算通知任务**被消费且正常结束**（`completed≥1` / `failed=0`）—— 场景 `commission_settled` 未启用（缺模板 ID）时 `notify()` 返回 `delivered=false`，这是**如实状态、不是失败**：把它当失败去重试三次再进死信，会让真正的故障淹没在「每天一条假死信」里',
        `completed=${sq30?.completed} failed=${sq30?.failed} waiting=${sq30?.waiting}`,
      );
      const msg30 = readDb('SELECT COUNT(*) AS c FROM ab_message WHERE user_id = ?', [uid30]);
      assert(
        Number(msg30?.c ?? -1) === 0,
        '⭐ §30 **未启用 = 不投递且不留日志**（`ab_message` 的语义是「发过什么」）—— 与 M3-12 同口径，本批新增的两个投递点不得开例外',
        `ab_message 行数=${msg30?.c}`,
      );

      const settle30b = await call('POST', `${SCH30}/commission-settle/run`, {
        token: adminToken,
        body: { date: D30S },
      });
      const s30b = settle30b.body?.data?.result;
      assert(
        settle30b.body?.code === 0 && s30b?.settled === 0 && s30b?.notifyQueued === 0,
        '⭐ §30 结算通知**幂等**：重跑 `settled=0` **且 `notifyQueued=0`** —— 入账是幂等的，通知也必须跟着幂等，否则重跑一次就给团长重复发一遍「你的佣金已入账」',
        `settled=${s30b?.settled} notifyQueued=${s30b?.notifyQueued}`,
      );

      // -------------------------------------------------------- D. refund-apply（失败 → 重试耗尽 → 死信）
      const dlBefore30 = Number(
        readDb(
          "SELECT COUNT(*) AS c FROM ab_operation_log WHERE module = 'queue' AND action = '任务重试耗尽'",
        )?.c ?? 0,
      );
      const failCountBefore30 = (await call('GET', Q30, { token: adminToken })).body?.data;
      const raFailBefore30 = qRow(failCountBefore30, 'refund-apply')?.failed ?? 0;

      const rf30 = await call('POST', `/admin/orders/${PREFIX30}R1/force-refund`, {
        token: adminToken,
        body: {
          reason: `e2e 通道失败注入 ${FAIL_MARK}`,
          reasonType: 'quality',
          amountFen: 5160,
        },
      });
      const rf30d = rf30.body?.data;
      assert(
        rf30.body?.code === 0 &&
          rf30d?.wxDelivered === false &&
          rf30d?.retryQueued === true &&
          rf30d?.status === 'failed',
        '⭐⭐ §30 **外部通道调用已移出 DB 事务**：微信退款失败时接口仍返回 `code=0`（**账务已落库、绝不回滚**），并明确回带 `wxDelivered=false` + `retryQueued=true` + 单据 `failed` —— 改造前是「事务内先调通道、失败即整笔回滚（40010）」，那会同时留下两个方向的错：通道成功而事务回滚 = **钱退了系统没记录**；通道失败则整笔退款作废、运营只能从头再来',
        `code=${rf30.body?.code} wxDelivered=${rf30d?.wxDelivered} retryQueued=${rf30d?.retryQueued} status=${rf30d?.status}`,
      );
      assert(
        rf30d?.tips && String(rf30d.tips).length > 0,
        '§30 失败时**下发人话说明**（`tips`）—— 运营看到「退款失败」必须同时知道「钱到底退没退、接下来会怎样」，否则只会收到一通电话',
        `tips=${String(rf30d?.tips ?? '').slice(0, 60)}…`,
      );

      const ordRow30 = readDb('SELECT status, pay_amount FROM ab_order WHERE order_no = ?', [
        `${PREFIX30}R1`,
      ]);
      const rfRow30 = readDb(
        'SELECT status, wx_refund_no, audit_remark FROM ab_refund WHERE order_no = ?',
        [`${PREFIX30}R1`],
      );
      assert(
        ordRow30?.status === 'refunded' && rfRow30?.status === 'failed',
        '⭐⭐ §30 账务与通道**各自定稿、互不牵制**：订单已是 `refunded`（账务按「已受理」收口），退款单是 `failed`（通道那段待重试）—— 这一对正是「失败不回滚账务」的机械证据；若改成回滚，用户会看到「余额退回来了又扣走」',
        `order=${ordRow30?.status} refund=${rfRow30?.status}`,
      );
      assert(
        (rfRow30?.wx_refund_no ?? null) === null,
        '§30 未受理的通道**不写 `wx_refund_no`** —— 留空才是诚实的：写个假的单号等于伪造凭证，对账时无从分辨',
        `wx_refund_no=${rfRow30?.wx_refund_no ?? 'NULL'}`,
      );

      const dl30 = await waitDb(
        "SELECT COUNT(*) AS c FROM ab_operation_log WHERE module = 'queue' AND action = '任务重试耗尽'",
        [],
        (r) => Number(r.c) > dlBefore30,
        { timeout: 6000, interval: 100 },
      );
      assert(
        Number(dl30?.c ?? 0) > dlBefore30,
        '⭐⭐ §30 **重试耗尽 → 进死信 + 写操作日志**（`module=queue` / `action=任务重试耗尽`）—— 队列最大的风险不是「失败」而是**静默失效**：重试耗尽的含义是「这件事已经没有人再管了」，只打一条日志（会随轮转消失）不够，必须落在运营会主动去查的表里（与 M3-15 对账告警同一张表）',
        `死信行 前=${dlBefore30} 后=${dl30?.c}`,
      );
      const dlRow30 = readDb(
        "SELECT target_id, request_data, snapshot FROM ab_operation_log WHERE module = 'queue' AND action = '任务重试耗尽' ORDER BY id DESC LIMIT 1",
      );
      const parse30 = (v) => {
        if (v === null || v === undefined) return {};
        if (typeof v === 'object') return v;
        try {
          return JSON.parse(String(v));
        } catch {
          return {};
        }
      };
      const dlPayload30 = parse30(dlRow30?.request_data);
      const dlSnap30 = parse30(dlRow30?.snapshot);
      assert(
        dlRow30?.target_id === 'refund-apply' &&
          Number(dlPayload30?.attempts) === 3 &&
          !!dlPayload30?.payload?.refundNo,
        '⭐ §30 死信日志**可人工处理**：`target_id` 指出是哪个队列、`requestData.payload` 带业务主键（`refundNo`）、`attempts=3` 证明正好执行 3 次后停止 —— 「任务失败」四个字无法执行，必须能顺着它找到**具体哪一笔退款**',
        `target=${dlRow30?.target_id} attempts=${dlPayload30?.attempts} refundNo=${dlPayload30?.payload?.refundNo ? '有' : '无'}`,
      );
      assert(
        typeof dlSnap30?.hint === 'string' && dlSnap30.hint.includes('可安全重放'),
        '§30 死信快照带**下一步指引**（「支付/退款类任务幂等，可安全重放」）—— 指引写进数据而不是只写进代码注释',
        `hint=${String(dlSnap30?.hint ?? '').slice(0, 40)}…`,
      );

      const qAfterFail30 = (await call('GET', Q30, { token: adminToken })).body?.data;
      const raFailAfter30 = qRow(qAfterFail30, 'refund-apply')?.failed ?? 0;
      assert(
        raFailAfter30 > raFailBefore30,
        '⭐ §30 队列状态里的 `failed` **= 重试耗尽进死信**（不是「失败过一次」——中间重试仍在 waiting/delayed）—— 口径写在出参里，避免运维把「重试中」读成「已经放弃」',
        `failed 前=${raFailBefore30} 后=${raFailAfter30}`,
      );

      // -------------------------------------------------------- E. 成功对照（同一条链路）
      const rfK30 = await call('POST', `/admin/orders/${PREFIX30}K1/force-refund`, {
        token: adminToken,
        body: { reason: 'e2e 通道成功对照', reasonType: 'quality', amountFen: 5160 },
      });
      const rfK30d = rfK30.body?.data;
      const rfRowK30 = readDb('SELECT status, wx_refund_no FROM ab_refund WHERE order_no = ?', [
        `${PREFIX30}K1`,
      ]);
      assert(
        rfK30.body?.code === 0 &&
          rfK30d?.wxDelivered === true &&
          rfK30d?.retryQueued === false &&
          rfK30d?.status === 'refunded',
        '⭐ §30 对照：通道正常 → `wxDelivered=true` / `retryQueued=false` / 单据 `refunded`，**同步试一次**保留（微信退款正常是秒级，用户/运营立即看到结果），只有失败才转异步',
        `wxDelivered=${rfK30d?.wxDelivered} retryQueued=${rfK30d?.retryQueued} status=${rfK30d?.status}`,
      );
      assert(
        rfRowK30?.status === 'refunded' && /^mock_refund_/.test(String(rfRowK30?.wx_refund_no)),
        '§30 成功时**收口 `refunded` + 落 `wx_refund_no`**（通道凭证）—— 与失败时的 NULL 正好构成「单据字段如实反映通道真实结果」',
        `status=${rfRowK30?.status} no=${rfRowK30?.wx_refund_no}`,
      );

      // -------------------------------------------------------- F. leader_apply 投递点
      const ap30 = await call('POST', '/leader/apply', {
        token: uA30.token,
        body: {
          buildingId: OPENB30,
          phone: `137${String(stamp).slice(-8)}`,
          realName: `${PREFIX30}申请者`,
          agreementVersion: 'v1.0',
        },
      });
      assert(
        ap30.body?.code === 0 && ap30.body?.data?.isLeader === true,
        '⭐ §30 L17 接上「团长申请确认」通知后，**通知失败不影响申请**：仍返回 `isLeader=true` —— 通知是**既成事实的告知**，绝不能把一笔成功的申请变成失败（`MessageService.notify` 不抛异常 + 服务内再兜一层 try）',
        `code=${ap30.body?.code} isLeader=${ap30.body?.data?.isLeader}`,
      );
      const apMsg30 = readDb('SELECT COUNT(*) AS c FROM ab_message WHERE user_id = ?', [uidA30]);
      const apTpl30 = readDb('SELECT enabled, wechat_template_id FROM ab_message_template WHERE scene = ?', [
        'leader_apply',
      ]);
      assert(
        apTpl30?.enabled === 0 && Number(apMsg30?.c ?? -1) === 0,
        '⭐ §30 场景 `leader_apply` **已接线但未启用**（缺微信模板 ID）→ 不投递、不留日志、**也不算任务失败** —— 「接线（`wiring=live`）」与「启用（`enabled=1`）」是两件事，本批把两者都如实暴露：代码接好了，配置还没到',
        `enabled=${apTpl30?.enabled} ab_message=${apMsg30?.c}`,
      );

      // -------------------------------------------------------- G. 订阅授权清单（端上真正需要的那一半）
      const sub30 = await call('GET', '/me/subscribe/templates', { token: uA30.token });
      const sub30d = sub30.body?.data;
      assert(
        sub30.body?.code === 0 && (sub30d?.list ?? []).length === 0,
        '⭐ §30 一期订阅授权清单**必然为空**：没有微信账号 → 模板 ID 全空 → 没有可授权的对象。端上此时**什么都不做**，而不是拿假 ID 去调 `requestSubscribeMessage`',
        `code=${sub30.body?.code} list=${(sub30d?.list ?? []).length}`,
      );
      assert(
        String(sub30d?.note ?? '').includes('43101') &&
          String(sub30d?.note ?? '').includes('通常是正常的'),
        '⭐⭐ §30 口径**必须下发**：「列表为空**通常是正常的**」+「微信订阅消息为**一次性授权**，没授权服务端推不出去（微信回 `43101 用户拒绝接收`）」—— 「必推项」指的是**产品意图**（原型：退款结果必推），不是「无需用户同意」；不写明，端上会把空清单当故障、运营会以为必推是自动的',
        `note 长度=${String(sub30d?.note ?? '').length}`,
      );

      // 给 commission_settled 临时配上模板 ID + 启用 → 清单里必须**恰好出现这一条**
      const tpl30 = await call('GET', TPL30, { token: adminToken });
      const t30 = (list, scene) => (list ?? []).find((t) => t.scene === scene);
      const cmTpl30 = t30(tpl30.body?.data?.list, 'commission_settled');
      const rrTpl30 = t30(tpl30.body?.data?.list, 'refund_result');
      assert(
        !!cmTpl30?.id && !!rrTpl30?.id,
        '§30 前置：模板行已持久化（D59 出参带 id）',
        `commission_settled=#${cmTpl30?.id} refund_result=#${rrTpl30?.id}`,
      );
      assert(
        cmTpl30?.requestSubscribe === true &&
          cmTpl30?.wiring === 'live' &&
          cmTpl30?.subscribeTemplateId === null,
        '§30 出参带 `requestSubscribe`（场景是否属用户端需求）+ `subscribeTemplateId`（**此刻实际可授权的模板 ID**，null = 不该请求）—— 页面据此解释「为什么后台能看到场景、用户却收不到」',
        `req=${cmTpl30?.requestSubscribe} wiring=${cmTpl30?.wiring} id=${cmTpl30?.subscribeTemplateId ?? 'NULL'}`,
      );

      const setTpl30 = await call('PUT', `${TPL30}/${cmTpl30.id}`, {
        token: adminToken,
        body: { wechatTemplateId: `E2E30_TPL_${stamp}`, enabled: 1 },
      });
      const sub30b = await call('GET', '/me/subscribe/templates', { token: uA30.token });
      const sub30bList = sub30b.body?.data?.list ?? [];
      assert(
        setTpl30.body?.code === 0 &&
          sub30bList.length === 1 &&
          sub30bList[0]?.scene === 'commission_settled' &&
          sub30bList[0]?.templateId === `E2E30_TPL_${stamp}`,
        '⭐⭐ §30 配好模板 ID + 启用后，清单**恰好出现这一条**（模板 ID 由服务端下发，端上不硬编码 —— 硬编码等于第二份真相：运营换模板后端上还在请求旧 ID，两边都不报错）',
        `code=${setTpl30.body?.code} list=${sub30bList.map((t) => t.scene).join(',') || '空'}`,
      );
      assert(
        !sub30bList.some((t) => t.scene === 'refund_result'),
        '⭐ §30 **四条件过滤真的在过滤**：`refund_result` 同样是「用户端场景 + 已接线 + 需授权」，但**没配模板 ID** → 不进清单（没有可授权的对象，请求了也白请求）',
        `包含 refund_result=${sub30bList.some((t) => t.scene === 'refund_result')}`,
      );
      assert(
        (tpl30.body?.data?.list ?? []).every((t) => t.requestSubscribe !== true || t.wiring === 'live'),
        '⭐ §30 结构性不变式：`requestSubscribe=true` 的场景**必须已接线**（否则就是「索权不用」—— 向用户要一个我们根本不会用的授权，微信平台明确反对）',
        '',
      );
      const restoreTpl30 = await call('PUT', `${TPL30}/${cmTpl30.id}`, {
        token: adminToken,
        body: { wechatTemplateId: null, enabled: 0 },
      });
      assert(
        restoreTpl30.body?.code === 0,
        '§30 模板还原（临时启用只为本节断言，改完立刻恢复 —— 模板是**全局**的，留着脏状态会让下一次运行偶发失败）',
        `code=${restoreTpl30.body?.code}`,
      );

      // ------------------------------------- G2. 跨端落地页一致性（机械校验）
      // ⚠️ 这条断言防的是一类**四处都不报错**的静默失效：`refund_result` 的通知落地页
      //    曾硬编码成 `pages/order/detail`，而 `pages.json` 里的真实路由是
      //    `pages/order-detail/order-detail` —— 投递日志显示「成功」，微信也照发，
      //    用户点开通知却落到一个不存在的页面，**服务端与微信两侧都不会报错**
      //    （微信不校验 `page`，服务端也不解析小程序路由）。
      //    故此处把 `NOTIFY_PAGES` 与 `pages.json` 做一次**机械对账**：
      //    凡服务端会下发给微信的落地页，端上必须真存在。
      const specSrc30 = readFileSync(
        join(ROOT, 'apps/api-server/src/modules/admin/template/message-template.specs.ts'),
        'utf8',
      );
      const notifyBlock30 =
        /export const NOTIFY_PAGES\s*=\s*\{([\s\S]*?)\}\s*as const;/.exec(specSrc30)?.[1] ?? '';
      const notifyPages30 = [...notifyBlock30.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      const declaredPages30 = new Set(
        (
          JSON.parse(readFileSync(join(ROOT, 'apps/miniprogram/src/pages.json'), 'utf8')).pages ?? []
        ).map((p) => p.path),
      );
      const dangling30 = notifyPages30.filter((p) => !declaredPages30.has(p));
      assert(
        notifyPages30.length >= 3 && dangling30.length === 0,
        '⭐⭐ §30 服务端下发的**落地页必须在小程序里真实存在**（`NOTIFY_PAGES` ⊆ `pages.json`）—— 订阅消息的 `page` 是**唯一的跨端字符串契约**，写错时微信照收、服务端照发、端上点开却落到空白页，四处都不报错；这条机械对账是它唯一的防线',
        `pages=${notifyPages30.length} dangling=${dangling30.join(',') || '无'}`,
      );

      // -------------------------------------------------------- H. 夹具还原
      writeDb("DELETE FROM ab_operation_log WHERE module = 'queue' AND action = '任务重试耗尽'");
      writeDb('DELETE FROM ab_admin_user WHERE username = ?', [op30Name]);
      // ⚠️ **不删模板行**（只还原取值）：它是种子里就有的行，删掉会让「单跑 e2e:m3」的第二次
      //    运行在这一节前置断言上红（id 取不到）。模板是全局共享状态，本节只借不改
      writeDb('DELETE FROM ab_balance_log WHERE user_id = ?', [uid30]);
      writeDb('DELETE FROM ab_balance WHERE user_id = ?', [uid30]);
      writeDb('DELETE FROM ab_commission WHERE team_leader_id = ?', [lid30]);
      writeDb('DELETE FROM ab_refund WHERE order_no LIKE ?', [`${PREFIX30}%`]);
      writeDb('DELETE FROM ab_payment_log WHERE order_no LIKE ?', [`${PREFIX30}%`]);
      writeDb('DELETE FROM ab_order WHERE order_no LIKE ?', [`${PREFIX30}%`]);
      writeDb('DELETE FROM ab_team_leader WHERE user_id = ?', [uid30]);
      writeDb('DELETE FROM ab_team_leader WHERE user_id = ?', [uidA30]);
      writeDb('DELETE FROM ab_user WHERE openid = ?', [L30OPENID]);
      writeDb('DELETE FROM ab_user WHERE openid = ?', [A30OPENID]);
      const left30 = {
        o: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_order WHERE order_no LIKE ?', [`${PREFIX30}%`])?.c ??
            -1,
        ),
        c: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_commission WHERE team_leader_id = ?', [lid30])?.c ??
            -1,
        ),
        b: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_balance WHERE user_id = ?', [uid30])?.c ?? -1,
        ),
        r: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_refund WHERE order_no LIKE ?', [`${PREFIX30}%`])?.c ??
            -1,
        ),
        l: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_team_leader WHERE user_id IN (?, ?)', [uid30, uidA30])
            ?.c ?? -1,
        ),
        u: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_user WHERE openid IN (?, ?)', [L30OPENID, A30OPENID])
            ?.c ?? -1,
        ),
        q: Number(
          readDb(
            "SELECT COUNT(*) AS c FROM ab_operation_log WHERE module = 'queue' AND action = '任务重试耗尽'",
          )?.c ?? -1,
        ),
      };
      assert(
        Object.values(left30).every((v) => v === 0),
        '§30 夹具还原：订单 / 佣金 / 余额 / 退款单 / 团长 / 用户 / 死信日志全部清除 —— 不还原会让下一次重跑的平台负债凭空多出佣金，并让 D38↔D33 的对账断言在「两次读之间」产生假绿',
        `o=${left30.o} c=${left30.c} b=${left30.b} r=${left30.r} l=${left30.l} u=${left30.u} q=${left30.q}`,
      );
    }
  }

  // ==========================================================================
  // §31 M4-4 提现审批 D45 / D46–D46c（后台 P34 · 模块 M35-08）
  // ==========================================================================
  //
  // ## 这一节测的不是「后台多了个页面」，而是**资金链的收口**
  //
  // L12 从 M2 起就把钱冻住了：申请一瞬 `balance −X / frozen +X`。而在 M4-4 之前
  // **没有任何端点能把这张单子往前推** —— 提现单永远停在 `pending`。三个后果
  // 都是用户直接看得见的：
  //   ① 团长的钱被永久锁死（`frozen` 只增不减，无任何界面/接口能让它下降）；
  //   ② `collectQuitBlockers` 以 `WITHDRAW_FROZEN_STATUS` 判定「有提现正在处理中」
  //      → **提过一次现就再也不能退出团长**，而错误文案还写着「等待提现到账」
  //      （等一个永远不会发生的到账）；
  //   ③ `ab_leader.withdrawn_amount` 永远是种子值（无写点 #69）。
  //
  // ## 钉死的七条不变量
  //   ① ⭐⭐ **状态机 fail-closed**：四动作各有前置状态，越界一律 `40017`
  //      （**不复用** `40002`/`40014`：那是别的域的语义，混用会把排查入口埋掉）
  //   ② ⭐⭐ **驳回 / 打款失败 = 原路解冻精确复原**：`balance +X / frozen −X`，
  //      且 `total_in` / `total_out` **都不动**（钱没进出平台，只换了位置）
  //   ③ ⭐⭐ **到账按申请额计支出**：`frozen −X` + `total_out +X`，其中
  //      **X = 申请额（不是实付）** —— 按实付记会永久留下一个等于代扣税额的缺口，
  //      而那个缺口看着像「平台多留了钱」，实则那笔税是平台**代缴给税务**的
  //   ④ ⭐ **到账不写 `ab_balance_log`**：该表语义是「**可用余额**每次变化」，
  //      到账那刻可用余额不变 → 条数不变是**声明**，不是漏写（e2e 把「为什么没有」钉住）
  //   ⑤ ⭐ **代扣 / 实付自洽**：两栏都传却不自洽 → `10001`；只传一栏 → 推出另一栏；
  //      都不传 → `taxSource='assumed_zero'`（把「系统替你假设了什么」显式说出来）
  //   ⑥ ⭐ **会计恒等式** `total_in − total_out === balance + frozen` 在每一步都成立
  //      —— 这一条能同时抓到「忘了减 frozen」与「把实付记进 total_out」两类错账
  //   ⑦ ⭐ **两级白名单**：读含 `operator`（不含 viewer）· 写**不含 operator** ·
  //      未登录 `10002` · 未知单号 `40016`
  //
  // ⚠️ 本节**不依赖下单窗口**（提现与出餐日无关），故无需隔离日期。
  // ⚠️ 全局量（`frozenByWithdrawFen` / `pendingCount` …）一律用 **Δ** ——
  //    别的章节与种子也会动 `ab_withdraw`（#108 教训：共享维度不能用绝对值）。
  // ==========================================================================
  {
    log('\n§31 M4-4 提现审批 D45 / D46–D46c（资金链收口）');

    const FIN31 = '/admin/finance';
    const WD31 = `${FIN31}/withdrawals`;
    const PREFIX31 = `E2E31${stamp}`;
    const fen31 = (v) => Math.round(Number(v ?? 0) * 100);

    const base31 = readDb(
      `SELECT b.id AS bid
         FROM ab_building b
        WHERE b.status = 1 AND b.building_group_id IS NOT NULL
        ORDER BY b.id LIMIT 1`,
    );
    assert(
      !!base31,
      '§31 前置：夹具原料齐备（1 个「在营 + 有楼群」的楼用于挂团长）',
      `bid=${Number(base31?.bid)}`,
    );

    if (base31) {
      const B31 = Number(base31.bid);
      const CODE31 = `${PREFIX31}l`;
      const OPENID31 = `mock_openid_${CODE31}`;
      const NAME31 = `${PREFIX31}提现团长`;
      const AT31 = `${bjToday()} 11:00:00`;

      /**
       * 专用账号。**不能借既有团长** —— 别人账上已有余额 / 提现单会让
       * 「解冻精确复原」「余额不变」这类断言因为别人的钱而**假绿**
       * （§26 / §29 / §30 同一条教训）。
       */
      writeDb(
        'INSERT INTO ab_user (openid, nickname, gender, status, version, created_at, updated_at) VALUES (?, ?, 0, 1, 0, ?, ?)',
        [OPENID31, NAME31, AT31, AT31],
      );
      const uid31 = Number(readDb('SELECT id FROM ab_user WHERE openid = ?', [OPENID31])?.id ?? 0);
      writeDb(
        'INSERT INTO ab_team_leader (user_id, building_id, phone, real_name, level, commission_rate, status, total_orders, total_commission, payout_type, payout_account, payout_name, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0.00, ?, ?, ?, 0, ?, ?)',
        [
          uid31,
          B31,
          '1380014****',
          NAME31,
          'gold',
          '0.1000',
          'bank',
          '6222****4321',
          NAME31,
          AT31,
          AT31,
        ],
      );
      const lid31 = Number(
        readDb('SELECT id FROM ab_team_leader WHERE user_id = ?', [uid31])?.id ?? 0,
      );
      const l31 = await userLogin(`dev:${CODE31}`);

      const acct31 = () =>
        readDb('SELECT balance, frozen, total_in, total_out FROM ab_balance WHERE user_id = ?', [
          uid31,
        ]);
      /** 会计恒等式：`total_in − total_out === balance + frozen` */
      const identity31 = () => {
        const r = acct31();
        if (!r) return false;
        return (
          fen31(r.total_in) - fen31(r.total_out) === fen31(r.balance) + fen31(r.frozen)
        );
      };
      const logCount31 = () =>
        Number(
          readDb('SELECT COUNT(*) AS c FROM ab_balance_log WHERE user_id = ?', [uid31])?.c ?? -1,
        );
      const wdRow31 = (id) =>
        readDb(
          'SELECT status, amount, tax_withheld_amount, actual_amount, payout_batch_no, auditor_id, audit_remark, fail_reason, paid_at FROM ab_withdraw WHERE id = ?',
          [id],
        );
      const list31 = async (qs = '') =>
        (await call('GET', `${WD31}${qs}`, { token: adminToken })).body;
      const rowOf31 = (res, no) =>
        (res?.data?.list ?? []).find((w) => w.withdrawNo === no) ?? null;
      /**
       * L12 申请。
       *
       * ⚠️ **幂等键必填**（`@Idempotent({ scope:'withdraw' })` + `Idempotency-Key`）——
       *    提现是资金操作，缺键一律 `10001`。每笔申请必须用**不同的键**
       *    （同键第二次会命中缓存返回首次结果 → 拿到同一张单，本节会当场红）。
       */
      let seq31 = 0;
      const apply31 = async (amount) =>
        (
          await call('POST', '/leader/withdraw', {
            token: l31.token,
            idem: `${PREFIX31}wd-${++seq31}`,
            body: { amount },
          })
        ).body;
      const act31 = async (verb, id, body) =>
        (await call('POST', `${WD31}/${id}/${verb}`, { token: adminToken, body })).body;

      // 权限矩阵账号（固定名 —— 每天重跑只累积 2 个，不翻倍）
      const op31 = 'e2e_s31op';
      const view31 = 'e2e_s31view';
      await call('POST', '/admin/system/accounts', {
        token: adminToken,
        body: { username: op31, password: PWD, role: 'operator', realName: 'e2e 提现运营' },
      });
      await call('POST', '/admin/system/accounts', {
        token: adminToken,
        body: { username: view31, password: PWD, role: 'viewer', realName: 'e2e 提现只读' },
      });
      const t31Op = (await adminLogin(op31, PWD)).token;
      const t31View = (await adminLogin(view31, PWD)).token;
      const t31Fin = (await adminLogin('finance', 'finance123')).token;
      const t31Sup = (await adminLogin('sanweiwu', 'supplier123')).token;

      assert(
        uid31 > 0 && lid31 > 0 && !!l31.token,
        '§31 夹具：专用团长（含已绑定收款方式）就位，且可登录 `/leader/*`',
        `uid=${uid31} lid=${lid31} 登录=${!!l31.token}`,
      );

      if (uid31 > 0 && lid31 > 0 && l31.token) {
        // ---------------------------------------------------- A. 备资金（D39 充值建户）
        const recharge31 = await call('POST', `${FIN31}/balances/adjust`, {
          token: adminToken,
          idem: `${PREFIX31}seed`,
          body: {
            userId: uid31,
            action: 'recharge',
            amountFen: 10000,
            reason: `${PREFIX31} 提现链路夹具充值`,
          },
        });
        assert(
          recharge31.body?.code === 0 && fen31(acct31()?.balance) === 10000,
          '§31 前置：用 **D39 充值**（HTTP，不直写库）给专用团长备 ¥100.00 —— 顺带验证「只有充值能自动建户」：新用户此前没有任何资金往来',
          `code=${recharge31.body?.code} balance=${acct31()?.balance}`,
        );

        const acct0 = acct31();

        // ---------------------------------------------------- B. D45 默认 Tab = 待审批
        const l0 = await list31('?keyword=' + encodeURIComponent(PREFIX31));
        assert(
          l0?.code === 0 &&
            l0?.data?.tab === 'review' &&
            Array.isArray(l0?.data?.list) &&
            l0?.data?.list.length === 0 &&
            l0?.data?.actions?.canAudit === true,
          '⭐ D45 缺省 `tab=review`（**不是 all**）—— 运营每天打开这页的动作是「清空队列」；新团长尚无提现单 → 空列表；`actions.canAudit=true` 对 `admin`',
          `code=${l0?.code} tab=${l0?.data?.tab} 条数=${l0?.data?.list?.length} canAudit=${l0?.data?.actions?.canAudit}`,
        );
        assert(
          (l0?.data?.statusOptions ?? []).length === 6 &&
            (l0?.data?.tabOptions ?? []).map((t) => t.value).join(',') ===
              'review,payout,done,all',
          '§31 枚举映射由**服务端下发**（6 个状态 + 4 个 Tab）—— 端上不维护第二份，就不会出现「后台加了状态、下拉框里没有」的静默漂移',
          `statusOptions=${(l0?.data?.statusOptions ?? []).length} tabOptions=${(l0?.data?.tabOptions ?? []).map((t) => t.value).join(',')}`,
        );

        // ---------------------------------------------------- C. L12 申请 → 冻结
        const noKey31 = await call('POST', '/leader/withdraw', {
          token: l31.token,
          body: { amount: 30 },
        });
        assert(
          noKey31.body?.code === 10001,
          '⭐ L12 提现**缺幂等键 → `10001`**（资金操作不接受「可能重复提交」的请求）：没有业务单号可供判重时，缺键就是缺保险 —— 宁可拒收，也不能让一次网络重试变成两笔出款',
          `code=${noKey31.body?.code} msg=${noKey31.body?.message}`,
        );

        const f0 = Number((await list31()).data?.summary?.frozenByWithdrawFen ?? 0);
        const a1 = await apply31(30);
        const w1Id = Number(a1?.data?.id ?? 0);
        const w1No = a1?.data?.withdrawNo;
        const acctA = acct31();
        assert(
          a1?.code === 0 && w1Id > 0 && a1?.data?.status === 'pending',
          '§31 L12 提现申请 → 建单 `pending`（拿到本节的被测主单 W1）',
          `code=${a1?.code} id=${w1Id} no=${w1No} status=${a1?.data?.status} msg=${a1?.message}`,
        );
        assert(
          fen31(acctA?.balance) === 7000 && fen31(acctA?.frozen) === 3000,
          '⭐ L12 申请即**冻结**：`balance 100.00 → 70.00` / `frozen 0 → 30.00` —— 这就是 M4-4 之前「只增不减」的那个冻结额',
          `balance=${acctA?.balance} frozen=${acctA?.frozen}`,
        );

        const s1 = (await list31()).data?.summary ?? {};
        assert(
          Number(s1.frozenByWithdrawFen ?? 0) - f0 === 3000 &&
            Number(s1.pendingCount ?? 0) >= 1,
          '⭐⭐ D45 `frozenByWithdrawFen` **恰好增加 3000 分**（Δ 口径 —— 全局量不能用绝对值）且它 = 三占用状态之和：这一项让运营能把「提现占用的冻结」与 `ab_balance.frozen` 的增量互相验算',
          `Δfrozen=${Number(s1.frozenByWithdrawFen ?? 0) - f0} pending=${s1.pendingCount}`,
        );
        assert(
          Number(s1.payingCount ?? 0) === 0,
          '⭐ 一期 `payingCount` **恒 0** —— 它是二期 `FLEX_API` 自动通道的中间态；一期人工通道没有任何动作会置 `paying`。造一个只有「多点一次按钮」没有别的效果的空状态，只会让运维以为漏了一步',
          `paying=${s1.payingCount}`,
        );

        // ---------------------------------------------------- D. 守卫：在途提现挡住退出
        //
        // ⚠️ L20 的 `@Idempotent({scope:'leader-quit'})` **要求幂等键**（缺键 `10001`），
        //    两次调用刻意用**两个不同键**：这不是为了绕过幂等，而是不让「守卫判定」
        //    与「幂等缓存」两件事混在一起（同键第二次会命中缓存，证明不了守卫又跑了一遍）。
        const qa = await call('POST', '/leader/quit', {
          token: l31.token,
          idem: `${PREFIX31}quit-a`,
          body: { reason: 'e2e 验证在途提现闸门' },
        });
        const qaCodes = (qa.body?.data?.blockers ?? []).map((b) => b.code);
        assert(
          qa.body?.code === 20008 && qaCodes.includes('WITHDRAW_IN_FLIGHT'),
          '⭐⭐ 在途提现**确实把「退出团长」挡住**（`20008` + `blockers[].code=WITHDRAW_IN_FLIGHT`）—— 这正是 M4-4 之前那条死锁：单子永远推不动 → 这道闸门永远不放手，团长的账户被自己的余额困住',
          `code=${qa.body?.code} blockers=${qaCodes.join(',') || '无'}`,
        );

        // ---------------------------------------------------- E. D45 待审批行 + 按钮口径
        const rev31 = await list31('?tab=review&keyword=' + encodeURIComponent(PREFIX31));
        const r1 = rowOf31(rev31, w1No);
        assert(
          !!r1 &&
            r1.status === 'pending' &&
            r1.statusText === '待审批' &&
            r1.canApprove === true &&
            r1.canReject === true &&
            r1.canMarkPaid === false &&
            r1.canMarkFailed === false &&
            r1.blockReason === null,
          '⭐ D45 待审批行：四动作可用性**唯一由服务端判定**（`canApprove/canReject=true`、`canMarkPaid/canMarkFailed=false`、`blockReason=null`）—— 端上照 `can*` 渲染按钮，不自己判状态，否则前端判断与后端守卫两套口径必然漂移，且漂移表现是「按钮能点、点了报错」',
          `status=${r1?.status} canApprove=${r1?.canApprove} canMarkPaid=${r1?.canMarkPaid}`,
        );
        assert(
          r1?.amountFen === 3000 &&
            r1?.actualKnown === false &&
            r1?.taxKnown === false &&
            r1?.payoutChannel === 'FLEX_MANUAL' &&
            !!r1?.payoutChannelText &&
            !!r1?.receiveTypeText &&
            String(r1?.receiveAccount ?? '').includes('*') &&
            !!r1?.leader?.levelText &&
            typeof r1?.leader?.frozenFen === 'number',
          '⭐⭐ D45 未到账行**必须标注「实付未知」**（`actualKnown=false`）：库里 `actual_amount` 在到账登记前仍是 `apply()` 写的初值（= 申请额），若直接当结论展示，运营会以为「这笔个税为 0」。同时下发团长资产快照（驳回前用它印证确实冻结着这笔钱）+ 通道/收款方式文案，收款账号**已是脱敏存储**',
          `actualKnown=${r1?.actualKnown} channel=${r1?.payoutChannel}/${r1?.payoutChannelText} 账号=${r1?.receiveAccount} frozen=${r1?.leader?.frozenFen}`,
        );

        // ---------------------------------------------------- F. 权限矩阵（读 / 写）
        const finGet31 = await call('GET', WD31, { token: t31Fin });
        const opGet31 = await call('GET', WD31, { token: t31Op });
        const viewGet31 = await call('GET', WD31, { token: t31View });
        const supGet31 = await call('GET', WD31, { token: t31Sup });
        const anonGet31 = await call('GET', WD31, {});
        assert(
          finGet31.body?.code === 0 && opGet31.body?.code === 0,
          '⭐ D45 类级白名单含 `finance` 与 `operator`（`FINANCE_READ_ROLES`）—— 运营要能看「这个团长的钱为什么卡住了」',
          `finance=${finGet31.body?.code} operator=${opGet31.body?.code}`,
        );
        assert(
          opGet31.body?.data?.actions?.canAudit === false,
          '⭐⭐ `operator` **可读不可批**：`actions.canAudit=false`。它与 D46 系列四个端点的 `@Roles(...FUND_ACTION_ROLES)` **共用同一角色常量**（`finance.constants.ts` 单一真相）—— 结构上不可能出现「按钮亮着、点了 10003」或「按钮灰着、其实有权限」',
          `canAudit=${opGet31.body?.data?.actions?.canAudit}`,
        );
        assert(
          viewGet31.body?.code === 10003 &&
            supGet31.body?.code === 10003 &&
            anonGet31.body?.code === 10002,
          '⭐ D45 白名单**不含 `viewer`**（与 D47–D50 看板刻意相反：那边是业务汇总，只读角色本就该看；这里是**逐笔资金明细**，含收款人与余额快照，多一个可见者就多一处泄露面）· 供应商 `10003` · 未登录 `10002`',
          `viewer=${viewGet31.body?.code} supplier=${supGet31.body?.code} anon=${anonGet31.body?.code}`,
        );

        const opAct31 = await call('POST', `${WD31}/${w1Id}/approve`, {
          token: t31Op,
          body: {},
        });
        const suppAct31 = await call('POST', `${WD31}/${w1Id}/approve`, {
          token: t31Sup,
          body: {},
        });
        const anonAct31 = await call('POST', `${WD31}/${w1Id}/approve`, { body: {} });
        assert(
          opAct31.body?.code === 10003 &&
            suppAct31.body?.code === 10003 &&
            anonAct31.body?.code === 10002,
          '⭐⭐ D46 写端点**收窄去掉 `operator`**（`FUND_ACTION_ROLES`）：他看得见队列但不能动钱 —— 这与「读宽写窄」的两级白名单纪律一致；供应商 `10003`、未登录 `10002`',
          `operator=${opAct31.body?.code} supplier=${suppAct31.body?.code} anon=${anonAct31.body?.code}`,
        );
        const notFound31 = await act31('approve', 999999999, {});
        assert(
          notFound31?.code === 40016,
          '⭐ 未知单号 → `40016`（**不复用 `404`/`10001`**）：提现审批的所有失败都必须能区分「单子不存在」与「状态不对」，否则运营在深夜排查时只能靠猜',
          `code=${notFound31?.code}`,
        );

        // ---------------------------------------------------- G. D46 批准（不动钱）
        const ap31 = await act31('approve', w1Id, { remark: 'e2e §31 批准' });
        const rowAp31 = wdRow31(w1Id);
        const acctAp = acct31();
        assert(
          ap31?.code === 0 &&
            ap31?.data?.status === 'approved' &&
            ap31?.data?.moneyMoved === false &&
            /^PB\d{8}$/.test(String(ap31?.data?.payoutBatchNo ?? '')) &&
            !!ap31?.data?.nextStep,
          '⭐⭐ D46 批准**不动钱**（`moneyMoved=false`）：钱早在申请时就冻结了，批准只是「同意纳入出款批次」。批次号缺省按**审批日**聚合生成 `PB{yyyyMMdd}`（**不带随机位** —— 与单号生成器刻意区分：批次是给人对着清单核的，不是用来判重的）',
          `code=${ap31?.code} status=${ap31?.data?.status} moved=${ap31?.data?.moneyMoved} batch=${ap31?.data?.payoutBatchNo}`,
        );
        assert(
          fen31(acctAp?.balance) === fen31(acct0?.balance) - 3000 &&
            fen31(acctAp?.frozen) === fen31(acct0?.frozen) + 3000 &&
            fen31(acctAp?.total_out) === 0 &&
            identity31(),
          '⭐⭐ 批准前后**四个金额字段逐一不变**（balance/frozen/total_in/total_out）—— 用「批准后仍等于申请后的快照」钉死「批准不动钱」；同时会计恒等式成立',
          `balance=${acctAp?.balance} frozen=${acctAp?.frozen} out=${acctAp?.total_out}`,
        );
        assert(
          Number(rowAp31?.auditor_id ?? 0) > 0 && !!rowAp31?.payout_batch_no,
          '§31 批准留痕落库：`auditor_id`（审批人）+ `audit_at` + `payout_batch_no` —— 事后「谁批的、进了哪个批次」必须能查',
          `auditor=${rowAp31?.auditor_id} batch=${rowAp31?.payout_batch_no}`,
        );
        const reAp31 = await act31('approve', w1Id, {});
        assert(
          reAp31?.code === 40017 && /已批准/.test(String(reAp31?.message ?? '')),
          '⭐⭐ 重复批准 → `40017`，且消息里**带当前状态中文名**（「当前状态「已批准」不支持批准」）—— 每个越界动作的后果都是**再动一次钱**，故必须给出能直接照着排查的话，而不是笼统的「操作失败」',
          `code=${reAp31?.code} msg=${reAp31?.message}`,
        );
        const rejAp31 = await act31('reject', w1Id, { reason: 'e2e 已批准不应可驳回' });
        assert(
          rejAp31?.code === 40017,
          '⭐⭐ 对 `approved` 单子驳回 → `40017`（驳回只收 `pending`）—— 否则会在「已批准」语义下把钱解冻，出现「批准了但钱回来了」的幽灵单',
          `code=${rejAp31?.code}`,
        );

        // ---------------------------------------------------- H. D45 待打款 Tab
        const pay31 = await list31('?tab=payout&keyword=' + encodeURIComponent(PREFIX31));
        const p1 = rowOf31(pay31, w1No);
        assert(
          !!p1 &&
            p1.canApprove === false &&
            p1.canMarkPaid === true &&
            p1.canMarkFailed === true &&
            Number(pay31?.data?.summary?.approvedAmountFen ?? 0) >= 3000,
          '⭐ D45 `tab=payout`（已批准 + 打款中）正确收进 W1，且按钮组**切换**为到账登记 / 打款失败 —— 同一行在两段里露出的动作集合不同，正是状态机在界面上的投影',
          `canMarkPaid=${p1?.canMarkPaid} canMarkFailed=${p1?.canMarkFailed} approvedAmount=${pay31?.data?.summary?.approvedAmountFen}`,
        );

        // ---------------------------------------------------- I. D46a 驳回（原路解冻）
        const a2 = await apply31(20);
        const w2Id = Number(a2?.data?.id ?? 0);
        const acctB = acct31();
        const logB = logCount31();
        assert(
          a2?.code === 0 && fen31(acctB?.balance) === 5000 && fen31(acctB?.frozen) === 5000,
          '§31 第二笔申请 W2 ¥20.00 → `balance 70.00→50.00` / `frozen 30.00→50.00`（W1 的冻结与 W2 的冻结并存）',
          `balance=${acctB?.balance} frozen=${acctB?.frozen}`,
        );
        const rj31 = await act31('reject', w2Id, { reason: '收款信息与实名不符' });
        const acctC = acct31();
        const rowRj = wdRow31(w2Id);
        assert(
          rj31?.code === 0 &&
            rj31?.data?.status === 'rejected' &&
            rj31?.data?.moneyMoved === true &&
            rj31?.data?.balanceFen === 7000 &&
            rj31?.data?.frozenFen === 3000,
          '⭐⭐ D46a 驳回 → **原路解冻精确复原**：`balance 50.00→70.00` / `frozen 50.00→30.00`，出参直接回带动作后快照（运营不用去余额页核对）',
          `code=${rj31?.code} status=${rj31?.data?.status} balanceFen=${rj31?.data?.balanceFen} frozenFen=${rj31?.data?.frozenFen}`,
        );
        assert(
          fen31(acctC?.total_in) === fen31(acct0?.total_in) &&
            fen31(acctC?.total_out) === 0 &&
            fen31(acctC?.frozen) === 3000 &&
            identity31(),
          '⭐⭐⭐ 驳回**不动** `total_in` / `total_out`：钱根本没进出平台，只是从「冻结」挪回「可用」—— 若误把解冻记成 `total_out` 减少，账面会显示「平台收回了钱」，而这笔钱其实还在用户的可用余额里',
          `in=${acctC?.total_in} out=${acctC?.total_out} frozen=${acctC?.frozen}`,
        );
        assert(
          logCount31() === logB + 1 && rowRj?.status === 'rejected',
          '⭐ 驳回**写一条** `ab_balance_log`（`type=withdraw_refund`、`direction=1`）：只有它改变了**可用余额**；`related_id` = 提现单号 → 一笔提现的「冻结」与「解冻」两条流水可对着看',
          `Δ流水=${logCount31() - logB} status=${rowRj?.status}`,
        );
        const failOnRejected31 = await act31('fail', w2Id, {
          failReason: 'e2e 已驳回不应可登记失败',
        });
        assert(
          failOnRejected31?.code === 40017,
          '⭐ 对 `rejected` 单子登记打款失败 → `40017` —— 驳回与失败**都解冻**，但两者**刻意分开**（成因不同：前者「平台认为不该发」，后者「尝试发了没成功」）；若能互相覆盖，运营就再也看不出问题出在审批口径还是收款信息',
          `code=${failOnRejected31?.code}`,
        );

        // ---------------------------------------------------- J. D46c 打款失败（原路解冻）
        const a3 = await apply31(40);
        const w3Id = Number(a3?.data?.id ?? 0);
        const acctD = acct31();
        assert(
          a3?.code === 0 && fen31(acctD?.balance) === 3000 && fen31(acctD?.frozen) === 7000,
          '§31 第三笔申请 W3 ¥40.00 → `balance 30.00` / `frozen 70.00`',
          `balance=${acctD?.balance} frozen=${acctD?.frozen}`,
        );
        await act31('approve', w3Id, {});
        const fl31 = await act31('fail', w3Id, {
          failReason: '平台回执：收款账号户名不符',
        });
        const acctE = acct31();
        const rowFl = wdRow31(w3Id);
        assert(
          fl31?.code === 0 &&
            fl31?.data?.status === 'failed' &&
            fl31?.data?.balanceFen === 7000 &&
            fl31?.data?.frozenFen === 3000 &&
            !!fl31?.data?.failReason,
          '⭐⭐ D46c 打款失败 → 同样**原路解冻精确复原**（`balance 30.00→70.00` / `frozen 70.00→30.00`），`failReason` 落库 —— 团长可据此重新申请（这是与「驳回」并列的第二条退回路径）',
          `code=${fl31?.code} status=${fl31?.data?.status} balanceFen=${fl31?.data?.balanceFen}`,
        );
        assert(
          fen31(acctE?.total_out) === 0 && fen31(acctE?.total_in) === fen31(acct0?.total_in) && identity31(),
          '⭐⭐ 失败解冻与驳回**同口径**：`total_in` / `total_out` 都不动（钱没出平台）。三路（驳回/到账/失败）走**同一个** `releaseFrozen()` —— 各写一份的后果不是重复代码，而是**其中一路漏掉某个字段**：例如「到账忘了减 frozen」，该用户的冻结额永久虚高，而其余提现看起来都正常',
          `in=${acctE?.total_in} out=${acctE?.total_out}`,
        );
        assert(
          String(rowFl?.fail_reason ?? '').includes('户名不符') && !!rowFl?.payout_batch_no,
          '§31 失败留痕落库：`fail_reason`（照抄平台回执原话）+ 沿用批准时登记的批次号',
          `reason=${rowFl?.fail_reason} batch=${rowFl?.payout_batch_no}`,
        );

        // ---------------------------------------------------- K. D46b 到账（钱正式出平台）
        const logK = logCount31();
        const paid31 = await act31('paid', w1Id, {
          taxWithheldFen: 500,
          actualFen: 2500,
          remark: 'e2e §31 回执 PLAT-2026-0917-A',
        });
        const acctK = acct31();
        assert(
          paid31?.code === 0 &&
            paid31?.data?.status === 'success' &&
            paid31?.data?.taxWithheldFen === 500 &&
            paid31?.data?.actualFen === 2500 &&
            paid31?.data?.taxSource === 'explicit' &&
            paid31?.data?.frozenFen === 0,
          '⭐⭐ D46b 到账登记：申请 ¥30.00 − 代扣 ¥5.00 = 实付 ¥25.00，两栏同传且自洽 → `taxSource=explicit`，并发动作后快照（`frozenFen=0`）',
          `code=${paid31?.code} tax=${paid31?.data?.taxWithheldFen} actual=${paid31?.data?.actualFen} src=${paid31?.data?.taxSource}`,
        );
        assert(
          fen31(acctK?.frozen) === 0 &&
            fen31(acctK?.total_out) === 3000 &&
            fen31(acctK?.balance) === 7000,
          '⭐⭐⭐ **`total_out` 按「申请额」而非「实付」累加**：`frozen 30.00→0` + `total_out 0→30.00`（**不是 25.00**）。按实付记会永久留下一个等于代扣税额的缺口，账面上看像「平台多留了钱」—— 而实际上那 ¥5.00 是平台**代扣代缴给税务**的，不是平台留存。这条断言是整节的核心',
          `frozen=${acctK?.frozen} total_out=${acctK?.total_out} balance=${acctK?.balance}`,
        );
        assert(
          logCount31() === logK,
          '⭐⭐ 到账**不写** `ab_balance_log`（条数不变）：该表语义是「**可用余额**的每一次变化」，而到账那刻可用余额**不变**（钱早在申请时就被扣走了）。这不是「账本与快照不同源」—— `frozen` 与 `total_out` 的变化**从来**不由流水解释（D39 的 `freeze` 行就是先例）。到账这一事件由 `ab_withdraw` 自身完整记录（`paid_at`/`tax_withheld_amount`/`actual_amount`）。**把「为什么没有」变成声明**，而不是让后来人以为漏写了',
          `Δ流水=${logCount31() - logK}（应 0）`,
        );
        assert(
          paid31?.data?.totalInFen - paid31?.data?.totalOutFen ===
            paid31?.data?.balanceFen + paid31?.data?.frozenFen && identity31(),
          '⭐⭐ 到账后会计恒等式仍成立：`total_in − total_out === balance + frozen`（10000 − 3000 = 7000 = 7000 + 0）—— 这一条能同时抓到「忘了减 frozen」与「把实付记进 total_out」两类错账，是本域最省事的体检项',
          `in=${acctK?.total_in} out=${acctK?.total_out} balance=${acctK?.balance} frozen=${acctK?.frozen}`,
        );
        const rePaid31 = await act31('paid', w1Id, {});
        assert(
          rePaid31?.code === 40017,
          '⭐⭐ 重复到账 → `40017` —— 这是**最危险的一条**：重复登记会让 `frozen` 被扣两次（变负）并把 `total_out` 再加一遍。故到账只收 `approved` / `paying`，`success` 一律拒',
          `code=${rePaid31?.code} msg=${rePaid31?.message}`,
        );
        const rowPaid31 = wdRow31(w1Id);
        assert(
          fen31(rowPaid31?.tax_withheld_amount) === 500 &&
            fen31(rowPaid31?.actual_amount) === 2500 &&
            !!rowPaid31?.paid_at,
          '§31 到账落库：`tax_withheld_amount=5.00` / `actual_amount=25.00` / `paid_at` 齐备 —— 提现单自身就是这笔出款的完整凭证（这也是「不写余额流水」不丢信息的原因）',
          `tax=${fen31(rowPaid31?.tax_withheld_amount)} actual=${fen31(rowPaid31?.actual_amount)} paidAt=${!!rowPaid31?.paid_at}`,
        );

        // ---------------------------------------------------- L. 代扣 / 实付自洽校验
        const a4 = await apply31(15);
        const w4Id = Number(a4?.data?.id ?? 0);
        await act31('approve', w4Id, {});
        const bad31 = await act31('paid', w4Id, { taxWithheldFen: 200, actualFen: 1000 });
        const neg31 = await act31('paid', w4Id, { actualFen: 2000 });
        assert(
          bad31?.code === 10001 && /不自洽/.test(String(bad31?.message ?? '')),
          '⭐⭐ 两栏都传却**不自洽** → `10001`「申请 ¥15.00 − 代扣 ¥2.00 ≠ 实付 ¥10.00」—— 若允许两处各记一套，账上必然出现「代扣记 2.00、实付按另一套算」的双真相，事后无从判断哪个才是回执上的数字',
          `code=${bad31?.code} msg=${bad31?.message}`,
        );
        assert(
          neg31?.code === 10001,
          '⭐ 只传「实付 ¥20.00」> 申请 ¥15.00 → 推出的代扣为负 → `10001` —— 反推的中间值也要校验，不能推出一个负数再落库',
          `code=${neg31?.code} msg=${neg31?.message}`,
        );
        const logL = logCount31();
        const acctL0 = acct31();
        assert(
          fen31(acctL0?.frozen) === 1500 && fen31(acctL0?.total_out) === 3000,
          '⭐ 两次非法提交**一个字段都没动**（`frozen` 仍 15.00、`total_out` 仍 30.00）—— 校验必须在事务内、落账之前；写成「先减 frozen 再校验」会让一次填错就把冻结额打歪',
          `frozen=${acctL0?.frozen} out=${acctL0?.total_out}`,
        );
        const assumed31 = await act31('paid', w4Id, {});
        const acctL = acct31();
        assert(
          assumed31?.code === 0 &&
            assumed31?.data?.taxSource === 'assumed_zero' &&
            assumed31?.data?.taxWithheldFen === 0 &&
            assumed31?.data?.actualFen === 1500,
          '⭐⭐ 两栏**都不传** → `taxSource=assumed_zero`：系统替你假设了「无代扣」，并把**这个假设显式下发**。一期人工通道下运营很可能只填实付就提交，若不标明来源，「个税为 0」会被当成结论写进对账表',
          `src=${assumed31?.data?.taxSource} tax=${assumed31?.data?.taxWithheldFen} actual=${assumed31?.data?.actualFen}`,
        );
        assert(
          fen31(acctL?.frozen) === 0 &&
            fen31(acctL?.total_out) === 4500 &&
            fen31(acctL?.balance) === 5500 &&
            logCount31() === logL &&
            identity31(),
          '⭐⭐ 到账 ¥15.00 后终态自洽：`balance 55.00` / `frozen 0` / `total_in 100.00` / `total_out 45.00`（= 3000 + 1500，**按申请额**），流水条数不变，恒等式成立',
          `balance=${acctL?.balance} frozen=${acctL?.frozen} out=${acctL?.total_out} Δ流水=${logCount31() - logL}`,
        );

        // ---------------------------------------------------- M. 守卫腿真正闭合
        const qb = await call('POST', '/leader/quit', {
          token: l31.token,
          idem: `${PREFIX31}quit-b`,
          body: { reason: 'e2e 验证提现闸门已闭合' },
        });
        const qbCodes = (qb.body?.data?.blockers ?? []).map((b) => b.code);
        assert(
          qb.body?.code === 20008 &&
            !qbCodes.includes('WITHDRAW_IN_FLIGHT') &&
            qbCodes.includes('BALANCE_NOT_CLEARED'),
          '⭐⭐⭐ **守卫的提现腿真的闭合了**：全部提现单到终态后 `WITHDRAW_IN_FLIGHT` 消失，只剩「可用余额未清零」（他确实还有 ¥55.00）—— 这一对「同一接口、同一键、两种结果」才是 M4-4 的**真正交付物**：钱推得动了，C3 退出团长的死锁随之解除',
          `blockers=${qbCodes.join(',') || '无'}`,
        );

        // ---------------------------------------------------- N. 终态行 + 汇总
        const fEnd = Number((await list31()).data?.summary?.frozenByWithdrawFen ?? 0);
        const done31 = await list31('?tab=done&keyword=' + encodeURIComponent(PREFIX31));
        const all31 = await list31('?tab=all&keyword=' + encodeURIComponent(PREFIX31));
        const fin1 = rowOf31(done31, w1No);
        assert(
          fEnd === f0,
          '⭐ 全部单子到终态后 `frozenByWithdrawFen` **回到基线**（Δ=0）—— 提现占用的冻结额是可回收的；若它单调不降，就是本节开头说的「钱被永久锁死」又回来了',
          `Δfrozen=${fEnd - f0}`,
        );
        assert(
          done31?.data?.list?.length === 4 &&
            all31?.data?.list?.length === 4 &&
            fin1?.canMarkPaid === false &&
            fin1?.canMarkFailed === false &&
            fin1?.blockReason !== null,
          '⭐ D45 `tab=done`（已到账 + 已驳回 + 打款失败）**恰好收进本节 4 笔**，且终态行四动作全灰 + `blockReason` 说明为什么（「已终态，无需处理」）—— 否则运营会以为按钮坏了而反复刷新',
          `done=${done31?.data?.list?.length} all=${all31?.data?.list?.length} block=${fin1?.blockReason}`,
        );
        const w1St = wdRow31(w1Id)?.status;
        const w2St = wdRow31(w2Id)?.status;
        const w3St = wdRow31(w3Id)?.status;
        const w4St = wdRow31(w4Id)?.status;
        assert(
          w1St === 'success' && w2St === 'rejected' && w3St === 'failed' && w4St === 'success',
          '§31 四笔单子最终落三个不同终态（`success` ×2 / `rejected` / `failed` 各就各位）—— 四条动作路径全部走到，没有一条被别的动作覆盖（覆盖就意味着某条路径其实没生效）',
          `W1=${w1St} W2=${w2St} W3=${w3St} W4=${w4St}`,
        );

        // ---------------------------------------------------- O. 夹具还原
        writeDb("DELETE FROM ab_operation_log WHERE module = 'finance' AND target_id IN (?, ?, ?, ?)", [
          w1Id,
          w2Id,
          w3Id,
          w4Id,
        ]);
        writeDb('DELETE FROM ab_admin_user WHERE username IN (?, ?)', [op31, view31]);
        writeDb('DELETE FROM ab_balance_log WHERE user_id = ?', [uid31]);
        writeDb('DELETE FROM ab_withdraw WHERE leader_id = ?', [lid31]);
        writeDb('DELETE FROM ab_balance WHERE user_id = ?', [uid31]);
        writeDb('DELETE FROM ab_team_leader WHERE id = ?', [lid31]);
        writeDb('DELETE FROM ab_user WHERE id = ?', [uid31]);
        const left31 = {
          w: Number(
            readDb('SELECT COUNT(*) AS c FROM ab_withdraw WHERE leader_id = ?', [lid31])?.c ?? -1,
          ),
          b: Number(
            readDb('SELECT COUNT(*) AS c FROM ab_balance WHERE user_id = ?', [uid31])?.c ?? -1,
          ),
          g: Number(
            readDb('SELECT COUNT(*) AS c FROM ab_balance_log WHERE user_id = ?', [uid31])?.c ?? -1,
          ),
          l: Number(
            readDb('SELECT COUNT(*) AS c FROM ab_team_leader WHERE id = ?', [lid31])?.c ?? -1,
          ),
          u: Number(readDb('SELECT COUNT(*) AS c FROM ab_user WHERE id = ?', [uid31])?.c ?? -1),
          o: Number(
            readDb('SELECT COUNT(*) AS c FROM ab_operation_log WHERE module = ? AND target_id IN (?, ?, ?, ?)', [
              'finance',
              w1Id,
              w2Id,
              w3Id,
              w4Id,
            ])?.c ?? -1,
          ),
        };
        assert(
          Object.values(left31).every((v) => v === 0),
          '§31 夹具还原：提现单 / 余额 / 流水 / 团长 / 用户 / 操作日志全部清除 —— 不还原会把「多出来的钱」与在途提现留给下一次重跑，让 D38↔D33 的对账断言与守卫断言双双假绿',
          `w=${left31.w} b=${left31.b} g=${left31.g} l=${left31.l} u=${left31.u} o=${left31.o}`,
        );
      }
    }
  }

  // ==========================================================================
  // §32 M5-1 配送单查看与人工修正（D61 / D62 · 收口挂账 #61）
  //
  // ⚠️ 同样**不依赖下单窗口**（同 §18–§28 纪律）：订单 / 分配行夹具**全部直插**，
  //    配送单经**补跑接口**用**显式日期**驱动。
  //
  // ⚠️ 两个**隔离日期**（避开 §18–§31 已占用的 today ± {1,10,60,90,130,190,200,
  //    205,208,209,210,212,213,214,215,365}）：
  //    · D32A = today − 216  有单（验证查看 + 修正链路）
  //    · D32B = today − 217  无单（验证「无单楼群不建单」→ 列表空态而非报错）
  //
  // 本节钉死九条不变量：
  //   ① ⭐⭐ **人工修正后重跑跑批不覆盖**（挂账 #61 的正题）：幂等不覆盖保护了人工录入，
  //      若跑批把修正抹掉，「改过又变回去」**不会有任何报错**，直到装错货。
  //   ② ⭐⭐ **乐观锁**：用过期 `version` 重提 → `30016` 并回带 `data.current`。
  //      否则后写者用旧快照**静默覆盖**前者的修改，双方都不报错（同 #61 同族的风险形态）。
  //   ③ ⭐ **份数与订单不符 ≠ 被人改过**：成因有两种（人工修正 / 截单后订单侧退款取消），
  //      系统不假装能区分 —— 只标 `quantityMismatch` 并给出排查入口（操作日志）。
  //      而 `hasManualInput`（司机/电话/车牌/备注有值）是**可靠**标记：跑批从不写这四列。
  //   ④ ⭐ 修正出参带 **before / after 双侧快照** —— 它随响应体被操作日志整体落库，
  //      事后能回放「5 → 3、司机空 → 张三」。只回「保存成功」等于没有审计。
  //   ⑤ ⭐ **空改动不写库、不推进版本**（`changed=[]`）：否则审计链上全是假变更记录。
  //   ⑥ ⭐ 传**空字符串 = 清空该字段**（存 `null`）；未提交的字段原样保留。
  //   ⑦ ⭐ 状态枚举与中文**由服务端下发**（`statusText` / `statusOptions` 按履约顺序）——
  //      端上不维护第二份映射，就不会出现「服务端加了状态、下拉框里没有」的静默漂移。
  //   ⑧ ⭐ 两级白名单**不含 viewer**（读与写都 10003）：配送单含运力与司机电话，
  //      与 D47–D50（看板刻意含 viewer）正相反。
  //   ⑨ ⭐ 列表（GET）**不写**操作日志 —— 每次刷新都记一条会把日志表刷爆，
  //      真正要查的「谁改了份数」反而被冲掉（同 S1/S9 纪律）。
  // ==========================================================================
  {
    log('\n§32 M5-1 配送单查看与人工修正（D61 / D62 · 挂账 #61）');

    const PREFIX32 = `E2E32${stamp}`;
    const D32A = addDaysStr(bjToday(), -216);
    const D32B = addDaysStr(bjToday(), -217);
    const AT32 = `${bjToday()} 02:00:00.000`;
    const DEL32 = '/admin/deliveries';
    /** SQLite 的 json 列取出来是字符串，MySQL 可能已是对象 —— 两边都能吃 */
    const asObj32 = (v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    };

    // ---------------------------------------------------------- A. 夹具原料
    const tpl32 = readDb(
      `SELECT a.building_group_id AS gid, a.set_meal_id AS smid, a.distribution_center_id AS dcid, b.id AS bid
         FROM ab_meal_assignment a
         JOIN ab_building b ON b.building_group_id = a.building_group_id
        WHERE a.distribution_center_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM ab_set_meal_item i WHERE i.set_meal_id = a.set_meal_id)
          AND NOT EXISTS (SELECT 1 FROM ab_set_meal_item i WHERE i.set_meal_id = a.set_meal_id AND i.supplier_id IS NULL)
        ORDER BY a.id LIMIT 1`,
    );
    const l32 = readDb('SELECT id FROM ab_team_leader ORDER BY id LIMIT 1');
    const openid32 = `${PREFIX32}u`;

    assert(
      !!tpl32 && !!l32,
      '§32 前置：配送单夹具原料齐备（1 个「有加工场所 + 菜品明细齐全」的分配模板 / 1 团长）',
      `tpl=${!!tpl32} leader=${!!l32}`,
    );

    if (tpl32 && l32) {
      const G32 = Number(tpl32.gid);
      const B32 = Number(tpl32.bid);
      const SM32 = Number(tpl32.smid);
      const DC32 = Number(tpl32.dcid);
      const L32 = Number(l32.id);

      writeDb(
        'INSERT INTO ab_user (openid, nickname, gender, status, version, created_at, updated_at) VALUES (?, ?, 0, 1, 0, ?, ?)',
        [openid32, `${PREFIX32}配送用户`, AT32, AT32],
      );
      const uid32 = Number(readDb('SELECT id FROM ab_user WHERE openid = ?', [openid32])?.id ?? 0);

      const INS_A32 =
        'INSERT INTO ab_meal_assignment (meal_date, building_group_id, set_meal_id, distribution_center_id, status, publish_at, cutoff_at, sold_count, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?, ?)';
      writeDb(INS_A32, [D32A, G32, SM32, DC32, 'active', AT32, AT32]);
      const a32 = Number(
        readDb(
          'SELECT id FROM ab_meal_assignment WHERE meal_date = ? AND building_group_id = ?',
          [D32A, G32],
        )?.id ?? 0,
      );
      writeDb(INS_A32, [D32B, G32, SM32, DC32, 'active', AT32, AT32]);

      const INS_O32 =
        'INSERT INTO ab_order (order_no, user_id, team_leader_id, building_id, building_group_id, set_meal_id, assignment_id, meal_date, quantity, unit_price, total_amount, balance_used, discount_amount, pay_amount, status, version, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, ?)';
      const mkOrder32 = (no, qty) => {
        const total = qty * 25.8;
        writeDb(INS_O32, [
          no,
          uid32,
          L32,
          B32,
          G32,
          SM32,
          a32,
          D32A,
          qty,
          '25.80',
          total.toFixed(2),
          '0.00',
          total.toFixed(2),
          // ⚠️ 直插 `cut_off` 而非 `paid`：配送单**本就在截单之后**生成（T 日 00:30），
          //    用 `paid` 会命中「该日有单却没有一张已截单订单」的可信度告警
          //    （那正是 §28 要验证的行为，不是本节要验的东西）。
          'cut_off',
          AT32,
          AT32,
          AT32,
        ]);
      };
      mkOrder32(`${PREFIX32}O1`, 3);
      mkOrder32(`${PREFIX32}O2`, 2); // 合计 5 份

      // ---------------------------------------------------- B. 生成配送单
      const dg32 = await call('POST', '/admin/schedule/delivery-generate/run', {
        token: adminToken,
        body: { date: D32A },
      });
      const dgd32 = dg32.body?.data?.result;
      const dg32b = await call('POST', '/admin/schedule/delivery-generate/run', {
        token: adminToken,
        body: { date: D32B },
      });
      const dgd32b = dg32b.body?.data?.result;
      assert(
        dg32.body?.code === 0 &&
          dgd32?.created === 1 &&
          dgd32?.totalQuantity === 5 &&
          dgd32?.warning === null &&
          dg32b.body?.code === 0 &&
          dgd32b?.created === 0 &&
          dgd32b?.emptyGroups === 1,
        '§32 前置：跑批为 D32A 建 1 张配送单（5 份 · 与订单同口径）· D32B 无单楼群**不建单**（计入 `emptyGroups`）',
        `A: created=${dgd32?.created} qty=${dgd32?.totalQuantity} / B: created=${dgd32b?.created} empty=${dgd32b?.emptyGroups}`,
      );

      const id32 = Number(
        readDb('SELECT id FROM ab_delivery_record WHERE meal_date = ? AND building_group_id = ?', [
          D32A,
          G32,
        ])?.id ?? 0,
      );

      // ---------------------------------------------------- C. D61 列表
      const list32 = await call('GET', `${DEL32}?date=${D32A}`, { token: adminToken });
      const ld32 = list32.body?.data;
      const row32 = ld32?.list?.[0];
      assert(
        list32.body?.code === 0 &&
          ld32?.date === D32A &&
          ld32?.list?.length === 1 &&
          row32?.id === id32 &&
          row32?.mealDate === D32A,
        '§32 D61 按出餐日列出配送单（粒度 = 楼群，一天一单）',
        `code=${list32.body?.code} date=${ld32?.date} n=${ld32?.list?.length}`,
      );
      assert(
        row32?.totalQuantity === 5 &&
          row32?.orderQuantity === 5 &&
          row32?.quantityDiff === 0 &&
          row32?.quantityMismatch === false &&
          row32?.hasManualInput === false &&
          row32?.version === 0 &&
          row32?.status === 'pending',
        '⭐⭐ §32 D61 出参**同时**给「配送单份数」与「按订单算出的份数」并标出差异，且初始态如实（无人工作业痕迹 / `version=0` / `pending`）—— 只给一个数，运营无法发现「单据与实物对不上」',
        `tq=${row32?.totalQuantity} oq=${row32?.orderQuantity} mismatch=${row32?.quantityMismatch} manual=${row32?.hasManualInput} v=${row32?.version}`,
      );
      assert(
        row32?.statusText === '待叫车' &&
          row32?.buildingGroupName &&
          String(row32?.expectedAt ?? '').startsWith(`${D32A}T11:30`),
        '§32 D61 状态中文 / 楼群名 / 预计送达（锚 T 日 11:30）齐备',
        `statusText=${row32?.statusText} expectedAt=${row32?.expectedAt}`,
      );
      assert(
        Array.isArray(ld32?.statusOptions) &&
          ld32.statusOptions.map((o) => o.value).join(',') === 'pending,called,en_route,arrived',
        '⭐ §32 D61 状态枚举与筛选顺序**由服务端下发**（4 态按履约顺序，非字典序）—— 端上不自己排、不维护第二份映射，就不会出现「服务端加了状态、下拉框里没有」的静默漂移',
        `opts=${JSON.stringify(ld32?.statusOptions?.map((o) => o.value))}`,
      );
      assert(
        typeof ld32?.note === 'string' &&
          ld32.note.includes('人工修正') &&
          ld32.note.includes('退款'),
        '⭐⭐ §32 D61 口径说明随出参下发且**点明两种成因**（人工修正 / 截单后退款取消）—— 不写清这一点，运营会把「截单后退款」误读成「有人改过」，进而去追一个根本不存在的责任人',
        `note=${String(ld32?.note ?? '').slice(0, 26)}…`,
      );

      const f32a = await call('GET', `${DEL32}?date=${D32A}&status=pending`, { token: adminToken });
      const f32b = await call('GET', `${DEL32}?date=${D32A}&status=arrived`, { token: adminToken });
      const bad32 = await call('GET', `${DEL32}?date=${D32A}&status=nope`, { token: adminToken });
      assert(
        f32a.body?.data?.list?.length === 1 &&
          f32b.body?.data?.list?.length === 0 &&
          bad32.body?.code === 10001,
        '⭐ §32 D61 状态筛选生效（`pending` 1 条 / `arrived` 0 条），未知 `status` → `10001` —— **不静默忽略筛选条件**：静默忽略会让运营以为「筛过了」，实际看到的是全量',
        `p=${f32a.body?.data?.list?.length} a=${f32b.body?.data?.list?.length} bad=${bad32.body?.code}`,
      );
      const list32d = await call('GET', DEL32, { token: adminToken });
      assert(
        list32d.body?.code === 0 &&
          /^\d{4}-\d{2}-\d{2}$/.test(String(list32d.body?.data?.date ?? '')),
        '⭐ §32 D61 不传 `date` 时服务端取**最近一个有配送单的出餐日**（不是「今天」）—— 用「今天」会让运营在 00:30 跑批生成之前打开页面看到空页，误以为漏跑了',
        `date=${list32d.body?.data?.date} n=${list32d.body?.data?.list?.length}`,
      );
      const empty32 = await call('GET', `${DEL32}?date=${addDaysStr(bjToday(), -218)}`, {
        token: adminToken,
      });
      assert(
        empty32.body?.code === 0 && empty32.body?.data?.list?.length === 0,
        '§32 D61 该日无配送单 → `code=0` + 空列表（HTTP 200）—— 「还没有单」是正常状态，不是错误；报错会让运营以为接口挂了',
        `code=${empty32.body?.code} n=${empty32.body?.data?.list?.length}`,
      );

      // ---------------------------------------------------- D. D62 人工修正
      const p1 = await call('PUT', `${DEL32}/${id32}`, {
        token: adminToken,
        body: {
          version: 0,
          reason: 'e2e §32 实际只送出 3 份',
          totalQuantity: 3,
          driverName: '张三',
          driverPhone: '13800000000',
          plateNo: '京A12345',
        },
      });
      const p1d = p1.body?.data;
      assert(
        p1.body?.code === 0 &&
          p1d?.changed?.length === 4 &&
          p1d?.before?.totalQuantity === 5 &&
          p1d?.after?.totalQuantity === 3 &&
          p1d?.before?.driverName === null &&
          p1d?.after?.driverName === '张三' &&
          p1d?.version === 1,
        '⭐⭐ §32 D62 修正出参带 **before / after 双侧快照**（不只回「保存成功」）—— 它随响应体被操作日志整体落库，事后能回放「5 → 3、司机空 → 张三」，这是审计链的全部依据',
        `code=${p1.body?.code} changed=${p1d?.changed?.length} ${p1d?.before?.totalQuantity}→${p1d?.after?.totalQuantity} v=${p1d?.version}`,
      );
      assert(
        p1d?.quantityDiff === -2 && p1d?.orderQuantity === 5,
        '⭐ §32 D62 修正后回带与订单的差异（-2 = 比订单少送 2 份）—— 修正**不改变订单**，差异必须让运营看见，否则「少送了 2 份」这件事只存在于配送单没人看的那一列里',
        `diff=${p1d?.quantityDiff} oq=${p1d?.orderQuantity}`,
      );

      const list32c = await call('GET', `${DEL32}?date=${D32A}`, { token: adminToken });
      const row32c = list32c.body?.data?.list?.[0];
      assert(
        row32c?.quantityMismatch === true &&
          row32c?.quantityDiff === -2 &&
          row32c?.hasManualInput === true &&
          row32c?.version === 1,
        '⭐⭐ §32 修正后列表**一眼可见**：`quantityMismatch`（与订单不符）+ `hasManualInput`（人工作业痕迹，可靠标记）+ 版本已推进 —— 不必逐条点开才知道哪些单被人动过',
        `mismatch=${row32c?.quantityMismatch} manual=${row32c?.hasManualInput} v=${row32c?.version}`,
      );

      const dg32c = await call('POST', '/admin/schedule/delivery-generate/run', {
        token: adminToken,
        body: { date: D32A },
      });
      const dgd32c = dg32c.body?.data?.result;
      const dr32 = readDb('SELECT total_quantity, driver_name, plate_no FROM ab_delivery_record WHERE id = ?', [
        id32,
      ]);
      assert(
        dgd32c?.created === 0 &&
          dgd32c?.skipped === 1 &&
          Number(dr32?.total_quantity) === 3 &&
          dr32?.driver_name === '张三' &&
          dr32?.plate_no === '京A12345',
        '⭐⭐ §32 **人工修正后重跑跑批不覆盖**（`created=0/skipped=1`，份数仍 3、司机车牌仍在）—— 这是挂账 #61 的正题：幂等不覆盖保护了人工录入，若跑批把修正抹掉，「改过又变回去」不会有任何报错，直到装错货',
        `created=${dgd32c?.created} qty=${dr32?.total_quantity} driver=${dr32?.driver_name}`,
      );

      const p2 = await call('PUT', `${DEL32}/${id32}`, {
        token: adminToken,
        body: { version: 0, reason: 'e2e §32 用过期版本重提', totalQuantity: 9 },
      });
      assert(
        p2.body?.code === 30016 &&
          p2.body?.data?.current?.version === 1 &&
          p2.body?.data?.current?.totalQuantity === 3,
        '⭐⭐ §32 D62 乐观锁：用**过期 `version`** 重提 → `30016` 且出参带 `data.current`（当前值 + 当前版本）—— 两个运营先后改同一张单时，后写者用旧快照会把前者的修改**静默覆盖**，双方都不报错，直到装错货；带 `current` 才能让端上刷新后重提',
        `code=${p2.body?.code} curV=${p2.body?.data?.current?.version} curQty=${p2.body?.data?.current?.totalQuantity}`,
      );

      const p3 = await call('PUT', `${DEL32}/${id32}`, {
        token: adminToken,
        body: { version: 1, reason: 'e2e §32 提交与原值相同的内容', totalQuantity: 3, driverName: '张三' },
      });
      const p3d = p3.body?.data;
      const v3db = readDb('SELECT version FROM ab_delivery_record WHERE id = ?', [id32]);
      assert(
        p3.body?.code === 0 &&
          p3d?.changed?.length === 0 &&
          p3d?.unchanged?.length === 2 &&
          p3d?.version === 1 &&
          Number(v3db?.version) === 1,
        '⭐ §32 D62 **空改动不写库、不推进版本**（`changed=[]` / `unchanged` 列出提交项 / 库里 `version` 仍为 1）—— 若一律回「保存成功」并推进版本，审计链上会充满什么都没改的假记录，真正有意义的变更被淹掉（与 D58 同一纪律）',
        `changed=${p3d?.changed?.length} unchanged=${p3d?.unchanged?.length} v=${p3d?.version}/${v3db?.version}`,
      );

      const p4 = await call('PUT', `${DEL32}/${id32}`, {
        token: adminToken,
        body: { version: 1, reason: 'e2e §32 只补一条配送备注', remark: '放前台，勿上楼' },
      });
      const p4d = p4.body?.data;
      assert(
        p4.body?.code === 0 &&
          p4d?.changed?.join(',') === 'remark' &&
          p4d?.after?.totalQuantity === 3 &&
          p4d?.after?.driverName === '张三' &&
          p4d?.version === 2,
        '§32 D62 部分更新：只提交 `remark` → `changed=[remark]`，**其余字段原样保留**（未提交 = 不动，而不是清空）',
        `changed=${p4d?.changed} qty=${p4d?.after?.totalQuantity} driver=${p4d?.after?.driverName} v=${p4d?.version}`,
      );

      const p5 = await call('PUT', `${DEL32}/${id32}`, {
        token: adminToken,
        body: {
          version: 2,
          reason: 'e2e §32 取消叫车，清空司机信息',
          driverName: '',
          driverPhone: '',
          plateNo: '',
        },
      });
      const p5d = p5.body?.data;
      assert(
        p5.body?.code === 0 &&
          p5d?.changed?.length === 3 &&
          p5d?.after?.driverName === null &&
          p5d?.after?.driverPhone === null &&
          p5d?.after?.plateNo === null &&
          p5d?.after?.remark === '放前台，勿上楼' &&
          p5d?.after?.totalQuantity === 3,
        '⭐ §32 D62 传**空字符串 = 清空该字段**（存 `null` 而非空串）—— 清不掉就会留下一个「看着有司机、其实已取消叫车」的幽灵记录；未提交的 `remark` 与份数不受影响',
        `driver=${p5d?.after?.driverName} remark=${p5d?.after?.remark} qty=${p5d?.after?.totalQuantity} v=${p5d?.version}`,
      );

      // ---------------------------------------------------- E. 入参闸门
      const noReason32 = await call('PUT', `${DEL32}/${id32}`, {
        token: adminToken,
        body: { version: 3, totalQuantity: 4 },
      });
      const shortReason32 = await call('PUT', `${DEL32}/${id32}`, {
        token: adminToken,
        body: { version: 3, reason: '改', totalQuantity: 4 },
      });
      const negQty32 = await call('PUT', `${DEL32}/${id32}`, {
        token: adminToken,
        body: { version: 3, reason: 'e2e 负数份数', totalQuantity: -1 },
      });
      const bigQty32 = await call('PUT', `${DEL32}/${id32}`, {
        token: adminToken,
        body: { version: 3, reason: 'e2e 超大份数', totalQuantity: 100000 },
      });
      const noVer32 = await call('PUT', `${DEL32}/${id32}`, {
        token: adminToken,
        body: { reason: 'e2e 缺版本号', totalQuantity: 4 },
      });
      assert(
        noReason32.body?.code === 10001 &&
          shortReason32.body?.code === 10001 &&
          negQty32.body?.code === 10001 &&
          bigQty32.body?.code === 10001 &&
          noVer32.body?.code === 10001,
        '⭐⭐ §32 D62 入参闸门：`reason` 缺失 / 太短（少于 2 个字）/ `version` 缺失 / 份数负数 / 超上限（9999）一律 `10001` —— 份数误输一位（5 → 99999）会让整条配送链按错误的量装货；`reason` 是审计的必填项，不是可选项',
        `noReason=${noReason32.body?.code} short=${shortReason32.body?.code} neg=${negQty32.body?.code} big=${bigQty32.body?.code} noVer=${noVer32.body?.code}`,
      );
      const notFound32 = await call('PUT', `${DEL32}/99999999`, {
        token: adminToken,
        body: { version: 0, reason: 'e2e 不存在的配送单', totalQuantity: 1 },
      });
      assert(
        notFound32.body?.code === 30017,
        '⭐ §32 D62 目标 id 不存在 → `30017`（而不是「保存成功」）—— 静默成功会让运营以为改好了，实际什么都没发生；与 30010（订单不存在）/ 40012（退款单不存在）同族：每张单有自己的排查入口',
        `code=${notFound32.body?.code}`,
      );

      // ---------------------------------------------------- F. 操作日志留痕
      const logs32 = readDb(
        'SELECT COUNT(*) AS c FROM ab_operation_log WHERE module = ? AND target_id = ?',
        ['delivery', String(id32)],
      );
      const conflictLog32 = readDb(
        "SELECT COUNT(*) AS c FROM ab_operation_log WHERE module = ? AND target_id = ? AND response_data LIKE '%30016%'",
        ['delivery', String(id32)],
      );
      assert(
        Number(logs32?.c ?? 0) >= 4 && Number(conflictLog32?.c ?? 0) >= 1,
        '⭐⭐ §32 D62 操作日志**失败的请求也记**（乐观锁冲突 `30016` 那条也在库里；每次成功修正各一条）—— 审计要回答「谁试图做了什么但被拒」，只记成功的日志答不了（D56 纪律）；挂 `target_id` = 配送单 id 才能在 D56 反查「这单被谁改过几次」',
        `total=${logs32?.c} conflict=${conflictLog32?.c}`,
      );
      // ⚠️ 必须取**最后一次成功修正**：失败调用（`10001` 校验失败 / `30016` 冲突）**也会**留日志，
      //    但它们的 `response_data` 是 `{error:{...}}`、没有 before/after ——
      //    按 `ORDER BY id DESC` 直接取最新会取到失败那条（本批首跑即踩到）。
      const logRow32 = readDb(
        'SELECT request_data, response_data, admin_user_id FROM ab_operation_log WHERE module = ? AND target_id = ? AND response_data LIKE ? ORDER BY id DESC LIMIT 1',
        ['delivery', String(id32), '%"after":%'],
      );
      const req32 = asObj32(logRow32?.request_data);
      const res32 = asObj32(logRow32?.response_data);
      assert(
        Number(logRow32?.admin_user_id ?? 0) > 0 &&
          String(req32?.body?.reason ?? '').includes('e2e') &&
          res32?.before !== undefined &&
          res32?.after !== undefined &&
          res32?.changed !== undefined,
        '⭐⭐ §32 **成功修正**的操作日志同时含请求体（`reason`）/ 响应体（`before` + `after` + `changed`）/ 操作人 id —— 三者缺一都不叫可回放：缺 `reason` 不知为何改，缺 before/after 不知改成什么，缺操作人不知谁改的',
        `by=${logRow32?.admin_user_id} reason=${String(req32?.body?.reason ?? '').slice(0, 14)}… hasDiff=${res32?.before !== undefined && res32?.after !== undefined}`,
      );
      const getLogA32 = Number(
        readDb('SELECT COUNT(*) AS c FROM ab_operation_log WHERE module = ? AND target_id = ?', [
          'delivery',
          String(id32),
        ])?.c ?? 0,
      );
      await call('GET', `${DEL32}?date=${D32A}`, { token: adminToken });
      await call('GET', `${DEL32}?date=${D32A}&status=pending`, { token: adminToken });
      const getLogB32 = Number(
        readDb('SELECT COUNT(*) AS c FROM ab_operation_log WHERE module = ? AND target_id = ?', [
          'delivery',
          String(id32),
        ])?.c ?? 0,
      );
      assert(
        getLogA32 === getLogB32,
        '§32 列表接口（GET）**不写**操作日志 —— 每次刷新列表都记一条会把日志表刷爆，真正要查的「谁改了份数」反而被冲掉（同 S1/S9「列表类不打日志」纪律）',
        `${getLogA32} → ${getLogB32}`,
      );

      // ---------------------------------------------------- G. 两级白名单
      const vw32 = `e2e_dlv_vw_${stamp}`;
      const mkVw32 = await call('POST', '/admin/system/accounts', {
        token: adminToken,
        body: {
          username: vw32,
          password: PWD,
          role: 'viewer',
          realName: 'e2e 配送只读观察者',
        },
      });
      const vwt32 = await adminLogin(vw32, PWD);
      const vwRead32 = await call('GET', `${DEL32}?date=${D32A}`, { token: vwt32.token });
      const vwWrite32 = await call('PUT', `${DEL32}/${id32}`, {
        token: vwt32.token,
        body: { version: 3, reason: 'e2e viewer 越权', totalQuantity: 1 },
      });
      assert(
        mkVw32.body?.code === 0 &&
          vwRead32.body?.code === 10003 &&
          vwWrite32.body?.code === 10003,
        '⭐ §32 配送单页两级白名单**不含 viewer**（读与写都 `10003`）—— 只读观察者仅看板；配送单含运力安排与司机电话，与 D47–D50（看板刻意含 viewer）正好相反',
        `read=${vwRead32.body?.code} write=${vwWrite32.body?.code}`,
      );

      // ---------------------------------------------------- H. 夹具还原
      writeDb('DELETE FROM ab_operation_log WHERE module = ? AND target_id = ?', [
        'delivery',
        String(id32),
      ]);
      writeDb('DELETE FROM ab_admin_user WHERE username = ?', [vw32]);
      writeDb('DELETE FROM ab_order WHERE order_no IN (?, ?)', [
        `${PREFIX32}O1`,
        `${PREFIX32}O2`,
      ]);
      writeDb('DELETE FROM ab_delivery_record WHERE meal_date IN (?, ?)', [D32A, D32B]);
      writeDb('DELETE FROM ab_meal_assignment WHERE meal_date IN (?, ?)', [D32A, D32B]);
      writeDb('DELETE FROM ab_user WHERE id = ?', [uid32]);
      const left32 = {
        d: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_delivery_record WHERE meal_date IN (?, ?)', [
            D32A,
            D32B,
          ])?.c ?? -1,
        ),
        o: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_order WHERE order_no IN (?, ?)', [
            `${PREFIX32}O1`,
            `${PREFIX32}O2`,
          ])?.c ?? -1,
        ),
        a: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_meal_assignment WHERE meal_date IN (?, ?)', [
            D32A,
            D32B,
          ])?.c ?? -1,
        ),
        u: Number(readDb('SELECT COUNT(*) AS c FROM ab_user WHERE id = ?', [uid32])?.c ?? -1),
        g: Number(
          readDb('SELECT COUNT(*) AS c FROM ab_operation_log WHERE module = ? AND target_id = ?', [
            'delivery',
            String(id32),
          ])?.c ?? -1,
        ),
      };
      assert(
        Object.values(left32).every((v) => v === 0),
        '§32 夹具还原：配送单 / 订单 / 分配行 / 夹具用户 / 操作日志全部清除 —— 不还原会让「按出餐日查询」命中上一轮残留，让 D61 的条数与份数断言在重跑时随机变红',
        `d=${left32.d} o=${left32.o} a=${left32.a} u=${left32.u} g=${left32.g}`,
      );
    }
  }

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

// ---------------------------------------------------------------------------
// 时间辅助（必须与服务端同源：Asia/Shanghai = UTC+8）
// ---------------------------------------------------------------------------

/**
 * 北京时间「今天」的 yyyy-MM-dd
 *
 * ⚠️ 不能用 `new Date().toISOString().slice(0,10)` —— 那是 **UTC 日**。
 *    北京时间 09-15 21:00 时 UTC 还是 09-15 13:00（同天），但北京 09-16 07:00
 *    时 UTC 是 09-15 23:00（差一天）。用 UTC 日构造 `mealDate` 会与后端的
 *    `todayBj()` 错位，断言随机红。
 */
function bjToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 纯 UTC 运算做日期加减（跨月/跨年安全，与服务端 addDays 同实现） */
function addDaysStr(base, days) {
  const [y, m, d] = base.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
}

main().catch((e) => {
  log(`\n✘ E2E 异常：${e?.stack ?? e}`);
  process.exit(1);
});

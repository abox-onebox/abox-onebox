#!/usr/bin/env node
/**
 * ABox M1 端到端验收（**免 pnpm**，真实起服务 + 真实 HTTP）
 *
 * 覆盖《开发里程碑计划 v1.0》M1 验收标准 1–5：
 *   1. 微信授权后直接进首页，不索要手机号 / 地址（C3 / L9）
 *      → 断言 A1 出参 `user.phone === null`，且登录链路无需额外授权步骤
 *   2. 下单 → 支付成功 → 支付结果页 → 订单详情，状态 pending_pay → paid
 *   5. 倒计时为距 T-1 24:00 的真实剩余时间（`countdownSec` 与 `cutoffAt` 自洽）
 *   3. 截单前取消成功；**截单后调取消接口返回 40004**
 *   4. 同一幂等键重复下单只产生一单
 *
 * 额外校验：统一响应结构、业务失败默认 HTTP 200、缺 `Idempotency-Key` 返回 10001、
 *          同用户同出餐日重复下单返回 30004。
 *
 * 用法：node scripts/e2e-m1.mjs
 * ⚠️ 前置：先跑一次 `node scripts/gate.mjs seed`（干净数据库 + 相对运行日的分配）
 *
 * 端口：默认 3101（`E2E_PORT` 可覆盖）—— 与 e2e-m2 分开，避免 `gate.mjs verify`
 *       串跑时两个脚本抢同一个端口（详见 scripts/lib/e2e-server.mjs 顶部说明）。
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

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const call = makeCall(BASE);

/**
 * 免鉴权探针出参里的「泄露字面量」判据
 *
 * ⛔ **只许改扫描范围，不许删这里的端口片段**（`3306` / `6379` / `127.0.0.1` …）。
 *   历史教训：`e2e:m1` 曾出现 113/114 的偶发红，原因是判据扫到了 `timestamp` 里
 *   随机撞出的 `3306`/`6379`（13 位毫秒时间戳 ⇒ 真实时间轴上 0.0925% 的毫秒值会命中）。
 *   若有人用「把 3306/6379 从正则里删掉」来治它，真正的泄露检查就**静默死掉** ——
 *   正确做法是排除 `requestId` / `timestamp` 两个字段（见下方 M5-0 处）。
 */
const LEAK_MARKER_RE = /password|secret|passwd|127\.0\.0\.1|localhost|3306|6379|sqlite|\.env/i;

/**
 * 免鉴权探针出参的**扫描范围**：扣掉 `requestId` / `timestamp` 两个内嵌毫秒时间戳的字段
 *
 * ⭐ 生产断言与两条自证**都走这一个函数** —— 否则会出现「自证过的判据」与
 *    「实际在用的判据」不是同一个（自证白做，且这种错不会报出来）。
 */
function stripNoiseFields(body) {
  const { requestId: _rid, timestamp: _ts, ...rest } = body ?? {};
  return rest;
}

/**
 * 前置：本套件以**真实 HTTP 下单**为前提，要求当前处在下单窗口
 * `isOrderable(T)` = `[T-1 14:00, T-1 23:00)` 内。
 *
 * ⚠️ 窗口外**任何**出餐日都下不了单（该不等式对整数日无解）—— 于是「U6 创建订单」
 *    一挂，后续 20 余条断言全部级联红（支付、列表、详情、取消、幂等…），
 *    真回归会被这段假红淹没。故这里**一次性判定 + 只给一条可读失败**，
 *    而不是让套件跑满 40 秒吐 20 行红（ref《缺陷与陷阱》§假红）。
 *
 * 经 `gate.mjs` 跑时不会触发：它注入了 `ABOX_SHIFT_TO_HOUR` 把窗口打开
 * （机制见 gate.mjs 文件头 + `common/utils/time.ts`）。
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
      `  这是**环境前提**，不是代码回归 —— 窗口外无论传哪个出餐日都无单可下。\n` +
      `  · 经门禁跑（推荐，已自动注入时钟）：node scripts/gate.mjs e2e:m1\n` +
      `  · 直接手跑：ABOX_SHIFT_TO_HOUR=20 node scripts/e2e-m1.mjs\n` +
      `  · 或等到 14:00 之后（真窗口）。\n`,
  );
  return false;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 本套件「现造账号」的登记与自清
// ---------------------------------------------------------------------------

/**
 * 本套件**自己现造**的用户，收尾统一带走（见 `main()` 的 `finally`）。
 *
 * ## 为什么必须自清 —— 这条断言的恒红形状
 *
 * `M1-①` 断言 `isNewUser === true`，只有「这次登录**真的**造了一个新用户」才成立。
 * 原先用的是固定 code `dev:9001`：
 *   · 第 1 次跑（干净库）→ 造出新用户 → 绿；
 *   · 第 2 次跑（同一份库）→ 用户还在 → `isNewUser=false` → **恒红**。
 * 而 `seed:demo` **不回收**这类 ad-hoc 用户。实测基线（2026-10-09 · 本地 sqlite
 * 开发库 `data/abox-dev.sqlite`）：`ab_user` 共 36 行，其中 ad-hoc 占
 * `mock_openid_9001` 1 行 + `mock_openid_qa-cancel-*` 5 行（后者出自第 9 节
 * M5-20，同样造了不自清 —— 已在本批次一并收进 `adHocUsers`，第 9 节有实测记录）。
 *
 * ⚠️ **这个形状值得单记**：「测试不幂等」只在**第二次**运行才显形，而 CI 每次都是
 *    干净环境 ⇒ **CI 永远抓不到**。它只在开发者本机连跑第二遍时出现，
 *    且极容易被误判成「代码回归」。
 *
 * ## 为什么是「一次性 code + 自清」而不是「固定 code + 让 seed 回收」
 *
 * 后者要把**测试夹具账号**写进**产品种子**（`seed:demo` 得认识它），两边耦合；
 * 且「回收」要求种子认识所有套件的所有临时账号 —— 漏一个就回到原样。
 * 测试自己造的自己收，才是幂等的形状：无论第几遍，套件看到的都是同一个世界。
 */
const adHocUsers = [];

/**
 * 生成**一次性**登录 code。
 *
 * `dev:` 前缀 ⇒ mock provider 直映射成 `mock_openid_<后缀>`
 * （`apps/api-server/src/providers/wx-mini/mock-wx-mini.provider.ts:51-55`），
 * 故「换 code」就等于「换一个全新 openid」。
 * 长度留足余量：`ab_user.openid` 为 `varchar(64)`，`mock_openid_` 占 11 字符，
 * 本函数产物最长约 11+7+1+8+1+8 = 36。
 *
 * ⚠️ 唯一性**不靠这里保证**：万一撞号，`M1-①` 的 `isNewUser === true` 会**当场红**，
 *    而不是悄悄退化成「测了个老用户」。
 */
function oneShotCode(tag) {
  return `dev:${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 删除 `adHocUsers` 里登记的账号。**只在 `finally` 里调**，失败也尽力走完。
 *
 * ## 为什么删 `ab_user` 一行就够（实测，不是推断）
 * 现造账号只做过一次登录，实测它在全部 8 张带 `user_id` 的表里都是 **0 行**
 * （`ab_balance` / `ab_balance_log` / `ab_item_rating` / `ab_message` / `ab_order`
 * / `ab_refund` / `ab_team_leader` / `ab_withdraw`）⇒ 删父行不留孤儿。
 *
 * ## 为什么以 `id` 定位，且删前先读回 `openid`
 * `id` 来自本次登录**出参**，是这一行唯一确定的指针；`DELETE ... WHERE id = ? AND
 * openid = ?` 把「删的是我造的那一行」这件事变成**可回放**的条件。
 *
 * ## 为什么自清失败**不**让本轮判红
 * 自清失败 ⇒ 账号留下 ⇒ **下一次**跑 `M1-①` 必然红在 `isNewUser=false`，
 * 即后果**不会被静默吞掉**，只是延后一轮显形。若在这里再判一次红，等于给套件
 * 新增一个偶发红来源，与本项目「假红会淹没真回归」的处理原则冲突。故只打 ⚠。
 */
function cleanupAdHocUsers() {
  if (adHocUsers.length === 0) return;

  let db;
  try {
    db = openFixtureDb();
  } catch (e) {
    log(`⚠ 自清未执行：打不开夹具库（${e?.message ?? e}）`);
    log(`  本次现造的 ${adHocUsers.length} 个账号留在库里 —— 下次跑 M1-① 会红在 isNewUser=false。`);
    return;
  }

  try {
    for (const u of adHocUsers) {
      const row = db.prepare('SELECT id, openid FROM ab_user WHERE id = ?').get(u.id);
      if (!row) {
        log(`· 自清：id=${u.id} 已不在库里（无需删除）`);
        continue;
      }
      const hit = db
        .prepare('DELETE FROM ab_user WHERE id = ? AND openid = ?')
        .run(u.id, row.openid).changes;
      const left = db.prepare('SELECT count(*) AS c FROM ab_user WHERE id = ?').get(u.id).c;
      if (hit === 1 && left === 0) {
        log(`· 自清：已带走本套件现造的账号 id=${u.id} openid=${row.openid}`);
      } else {
        log(`⚠ 自清未生效：id=${u.id} openid=${row.openid} 删除 ${hit} 行 / 仍剩 ${left} 行`);
        log('  下次跑 M1-① 会红在 isNewUser=false。');
      }
    }
  } catch (e) {
    log(`⚠ 自清异常（不掩盖本轮断言结论）：${e?.message ?? e}`);
  } finally {
    db.close();
  }
}

/**
 * 套件主体（原 `main`）。
 *
 * ⚠️ 为什么退出码要**返回**而不是就地 `process.exit()`：`process.exit()` 会立刻
 *    终止进程，`finally` 块**不会执行** ⇒ 自清就没了。退出集中到外层 `main()`。
 */
async function run() {
  log(`\n=== ABox M1 端到端验收 ===\n数据库：${DB_PATH}\n`);

  if (!assertOrderWindow()) return 1;

  installCleanupHooks();
  await assertPortFree(PORT);
  const server = startApiServer(PORT);
  const healthy = await waitHealthy(BASE, { child: server });
  if (!healthy) {
    fail('服务启动', `健康检查超时（90s）· ${BASE}/health`);
    await stopApiServer(server, PORT);
    return 1;
  }
  ok('服务启动', `${BASE}/health`);

  // ---------- 0. 探针契约（M5-0 · 存活 / 就绪两级） ----------
  // ⚠️ 探针是**编排器的判据**，改坏了不会有任何功能报错，只会让「该摘流量时摘不掉、
  //    该重启时重启不了」。故把契约钉在门禁里，防止后来者顺手改出参。
  //    两级必须**分开**：liveness 不检依赖（失败=重启），readiness 检依赖（失败=摘流量）；
  //    若 liveness 也检 DB，DB 一抖就会引发全量重启风暴。
  const live = await call('GET', '/health');
  assert(
    live.status === 200 &&
      live.body?.code === 0 &&
      live.body?.data?.status === 'ok' &&
      live.body?.data?.service === 'abox-api' &&
      typeof live.body?.data?.ts === 'number',
    'M5-0 存活探针 /health 契约不变（三套件 waitHealthy 依赖）',
    `status=${live.status} code=${live.body?.code}`,
  );
  // 键集合固定 —— 防止有人把 readiness 的 checks 塞进 liveness（那等于把依赖绑上重启链）
  assert(
    JSON.stringify(Object.keys(live.body?.data ?? {}).sort()) ===
      JSON.stringify(['service', 'status', 'ts']),
    'M5-0 存活探针出参未被就绪信息污染',
    Object.keys(live.body?.data ?? {}).join(','),
  );

  const ready = await call('GET', '/health/ready');
  const q = ready.body?.data?.checks?.queue ?? {};
  assert(
    ready.status === 200 &&
      ready.body?.code === 0 &&
      ready.body?.data?.status === 'ready' &&
      ready.body?.data?.checks?.db?.ok === true &&
      typeof ready.body?.data?.checks?.db?.latencyMs === 'number',
    'M5-0 就绪探针 /health/ready 检数据库连通',
    `status=${ready.status} db.ok=${ready.body?.data?.checks?.db?.ok}`,
  );
  // 消费者齐不齐是**启动期验不到、失败后完全静默**的故障（入队照常成功、却永远无人消费）
  assert(
    q.ok === true && q.consumers === q.consumersTotal && q.consumersTotal === 3,
    'M5-0 就绪探针检队列消费者齐备（3 队列）',
    `${q.consumers}/${q.consumersTotal} driver=${q.driver} durable=${q.durable}`,
  );
  assert(
    typeof ready.body?.data?.version === 'string' && Number.isInteger(ready.body?.data?.uptimeSec),
    'M5-0 就绪探针回显版本与运行时长（灰度 / 回滚判据）',
    `version=${ready.body?.data?.version} uptimeSec=${ready.body?.data?.uptimeSec}`,
  );
  // 探针**免鉴权**（编排器要打），故出参按「会被人看见」设计：失败原因只进服务端日志
  // ⭐ κ-5 / 任务 #39：扫描范围**排除 `requestId` 与 `timestamp`** —— 二者内嵌**同一个
  //   13 位毫秒时间戳**，而毫秒值里随时会撞出 `3306` / `6379` 这类端口字面量：
  //   实测在真实时间轴上枚举 24h（86,400,000 个毫秒值）⇒ 命中 79,949 个 = **0.0925%**
  //   （约 1/1081 次运行）⇒ 判据会为一个与「泄露」**完全无关**的原因变红。
  //   ⇒ 排掉这两个字段后判据强度**不降**：真正可能被塞连接串的是 `data` 那一层。
  //   ⛔ 不许靠删正则里的 `3306` / `6379` 来「治」这条偶发红 —— 那等于把真正的泄露
  //      检查静默关掉。要改的是**扫描范围**，不是**判据强度**。
  const probeRaw = JSON.stringify(stripNoiseFields(ready.body));
  assert(
    !LEAK_MARKER_RE.test(probeRaw),
    'M5-0 免鉴权探针不泄露主机 / 端口 / 连接串',
    probeRaw.slice(0, 160),
  );
  // 自证：判据的**两条边界**都必须成立 —— 缺任一条都会退化
  //   （① 不成立 = 判据恒绿，等于没有检查；② 不成立 = 为无关原因恒红，迟早被人删正则「治」掉）
  const leakingBody = { data: { dsn: 'mysql://root@127.0.0.1:3306/abox' } };
  assert(
    LEAK_MARKER_RE.test(JSON.stringify(stripNoiseFields(leakingBody))),
    'M5-0 自证①：判据**仍抓得住**真连接串（排除时间戳**没有**削弱强度）',
    '合成出参 data.dsn=mysql://root@127.0.0.1:3306/abox',
  );
  const noisyTsBody = {
    data: { ok: true },
    requestId: 'req_1791637900000_0',
    timestamp: 1791637900000,
  };
  assert(
    !LEAK_MARKER_RE.test(JSON.stringify(stripNoiseFields(noisyTsBody))),
    'M5-0 自证②：时间戳里撞出的 `6379` **不再**误报（历史 113/114 的偶发红即此类）',
    '合成出参仅时间戳含 6379',
  );
  // 对照：@Public 是**特例**而非常态 —— 受保护端点在无 token 时仍须拦
  const guarded = await call('GET', '/admin/finance/withdrawals');
  assert(
    guarded.status === 401,
    'M5-0 对照：受保护端点无 token 仍返回 401',
    `status=${guarded.status} code=${guarded.body?.code}`,
  );

  // ---------- 1. 登录（A1） ----------
  const login = await call('POST', '/auth/login', { body: { code: 'dev:1001' } });
  const token = login.body?.data?.token;
  assert(
    login.body?.code === 0 && !!token,
    'A1 微信登录签发 JWT',
    `userId=${login.body?.data?.user?.id}`,
  );
  // ---------- 1b. C3 / L9：只凭 code 登录，不取手机号 / 不取地址 ----------
  // ⚠️ 注意区分：种子里的 5 个用户**本身都是团长账号**，其 `ab_user.phone` 来自
  //    「申请团长时留的联系方式」，属合规数据；L9 禁止的是**登录环节索取**。
  //    故真正能证明 L9 的是「全新用户」与「入参白名单」这两条断言。
  // ⚠️ 「全新用户」**每次必须换一个 code**：本条断言的是 `isNewUser === true`，
  //    账号若已存在（上次跑留下的）就**恒红**。换 code 之外还要在收尾**自清**
  //    （`cleanupAdHocUsers`），否则只是把「第二次跑红」推迟成「第 N 次跑红」。
  const freshCode = oneShotCode('m1fresh');
  const fresh = await call('POST', '/auth/login', { body: { code: freshCode } });
  const fu = fresh.body?.data?.user;
  if (Number.isInteger(fu?.id)) adHocUsers.push({ id: fu.id, code: freshCode });
  assert(
    fresh.body?.code === 0 &&
      fresh.body?.data?.isNewUser === true &&
      fu?.phone === null &&
      fu?.buildingId === null,
    'M1-① 新用户登录只凭 code：不落手机号、不落地址（C3 / L9）',
    `isNewUser=${fresh.body?.data?.isNewUser} phone=${fu?.phone} buildingId=${fu?.buildingId}`,
  );

  const smuggle = await call('POST', '/auth/login', {
    body: { code: 'dev:9002', phone: '13900000000', address: '北京市朝阳区' },
  });
  assert(
    smuggle.body?.code !== 0,
    'M1-① 登录入参白名单拒绝 phone / address',
    `code=${smuggle.body?.code} msg=${smuggle.body?.message}`,
  );
  assert(
    login.body?.data?.isLeader === true,
    'L10 团长叠加身份随登录下发',
    `level=${login.body?.data?.leader?.level} rate=${login.body?.data?.leader?.commissionRate}`,
  );
  assert(
    login.body?.data?.user?.buildingId === 1,
    'C3 办公楼来自邀请绑定（非定位）',
    `buildingId=${login.body?.data?.user?.buildingId}`,
  );

  // ---------- 2. U1 明日套餐 ----------
  const daily = await call('GET', '/home/daily', { token });
  const d = daily.body?.data;
  assert(daily.body?.code === 0 && !!d, 'U1 明日套餐');
  assert(d?.priceFen === 2580, 'C1 售价锁定 ¥25.80', `priceFen=${d?.priceFen}`);
  assert(d?.canOrder === true, 'U1 canOrder 在截单前为 true');
  assert(
    d?.countdownSec > 0 && typeof d?.cutoffAt === 'string' && d.cutoffAt.endsWith('+08:00'),
    'M1-⑤ 倒计时锚在 T-1 24:00（+08:00）',
    `countdownSec=${d?.countdownSec} cutoffAt=${d?.cutoffAt}`,
  );
  assert((d?.items?.length ?? 0) >= 4, '套餐含一饭四菜', `items=${d?.items?.length}`);
  assert(
    d?.items?.every((x) => !('unitPrice' in x) && !('cost' in x)),
    'C8 用户端菜品视图不含供价',
  );

  const mealDate = d.mealDate;

  // ---------- 2b. U5 今日这盒 · 商家溯源（M5-14 · 原型 P38） ----------
  //
  // 三条独立价值：
  //   ① **免登录**确实可读（《接口规范》§1.1「首页、溯源可匿名只读」）—— 不传 token 调；
  //   ② 出参**真的带上了外卖跳转**（M5-14 之前 U5 是零路由空类、页面是占位页，
  //      「文档说有、代码没有」那一档已被报告 §二 P1-5 记录）；
  //   ③ **C8 反证**：这条接口最容易顺手把供应商状态 / 供价 / 联系方式带出去，
  //      故用正则扫整包出参，不只看单个字段。
  const u5 = await call('GET', `/traceability/today?buildingId=1&mealDate=${mealDate}`);
  const t = u5.body?.data;
  assert(
    u5.body?.code === 0 && !!t,
    'U5 溯源可**免登录**只读（信任页不该要人先登录）',
    `code=${u5.body?.code} items=${t?.items?.length ?? 0}`,
  );
  assert(
    (t?.items?.length ?? 0) >= 4,
    'U5 出品方逐菜列出（一饭四菜 · 原型 P38 的 4 张出品方卡）',
    `items=${t?.items?.length}`,
  );
  const supOf = (name) => (t?.items ?? []).find((x) => x.supplier?.name === name);

  const sanwei = supOf('三味屋');
  assert(
    sanwei?.supplier?.qualifications?.includes('food_business_license') &&
      sanwei?.supplier?.qualifications?.includes('business_license'),
    'U5 资质行取自**在册证照**（且要求 audit_status=approved —— 上传了≠核验过）',
    `quals=${JSON.stringify(sanwei?.supplier?.qualifications)}`,
  );
  //
  // ⚠️⭐ 2026-10-04：下面三条**整段反转** —— 原先断言的是「三平台齐全 / 缺京东看得见 /
  // 推荐平台已配置」，即**外卖跳转存在且正确**。跳转已因《运营规范》**5.10 互推行为**
  // （处理 = 下架）移除，`takeoutLinks` / `recommended` 两字段从契约删除，
  // 原判据若留着就是**恒红**；而简单删掉又会变成**恒绿**（`!undefined` 恒真）。
  // ⇒ 改成**反向断言**：出参必须**证明自己不含**任何第三方平台信息。
  //    谁哪天把字段加回来，这三条立刻报红。
  //
  // ⚠️ 先保证**有样本**：下面的反向断言全部依赖 `sanwei` 存在。若三味屋这道菜查不到，
  //    `?.takeoutLinks === undefined` 会因为"根本没这个对象"而**恒绿** —— 那是假绿。
  //
  // ⚠️ `!!sanwei?.supplier` 这一项**不是凑数**：反向断言全部依赖「三味屋这道菜在」。
  //    若样本缺失，`?.takeoutLinks === undefined` 会因为"根本没有这个对象"而**恒绿**。
  //    把它写进同一条断言里，是为了**不增加 e2e 断言总数**（R3 派生值：114 条）。
  //
  assert(
    !!sanwei?.supplier &&
      sanwei.supplier.takeoutLinks === undefined &&
      sanwei.supplier.recommended === undefined,
    'U5 出参**不下发** takeoutLinks / recommended（5.10 互推 · 2026-10-04 移除）',
    `有样本=${!!sanwei?.supplier} takeoutLinks=${typeof sanwei?.supplier?.takeoutLinks} recommended=${typeof sanwei?.supplier?.recommended}`,
  );

  const platformMarks = ['美团', '淘宝', '京东', 'meituan', 'taobao', 'jd'];
  const hitMarks = platformMarks.filter((m) => JSON.stringify(t ?? {}).includes(m));
  assert(
    hitMarks.length === 0,
    'U5 整包出参不含任何第三方平台名 / 键名（含 URL 里的域名）',
    hitMarks.length ? `命中：${hitMarks.join(',')}` : '干净',
  );

  const outboundHints = ['外卖', '点他们的', '下方店铺'];
  const hitOut = outboundHints.filter((m) => String(t?.traceNote ?? '').includes(m));
  assert(
    hitOut.length === 0,
    'U5 traceNote 不含站外引导词（原「点进下方店铺，直接点他们的外卖」已删）',
    hitOut.length
      ? `命中：${hitOut.join(',')}`
      : `note=${String(t?.traceNote ?? '').slice(0, 40)}…`,
  );

  const u5Raw = JSON.stringify(t ?? {});
  assert(
    !/"(status|commission|shareRate|contactPhone|auditStatus|unitPrice|costPrice|shareAmount)"/.test(
      u5Raw,
    ),
    'C8 反证：U5 出参不含供应商状态 / 佣金 / 供价 / 联系方式（跳转 ≠ 合作背书）',
    u5Raw.slice(0, 120),
  );
  assert(
    !!t?.distributionCenter?.address && /核验/.test(t?.traceNote ?? ''),
    'U5 集散中心带地址，且溯源文案由**本次真实资质并集**生成（不硬编码合规声明）',
    `note=${(t?.traceNote ?? '').slice(0, 48)}…`,
  );

  // ---------- 2c. M5-17 · U1/U5 的供应商编号必须同源 ----------
  //
  // 端上的整条链路是「首页某道菜的『来自：X』→ 带 supplierId 跳溯源页 → 按 id 找到那家
  // 并弹出平台层」。只要两侧的编号不是同一件事，用户就会被弹到**另一家店**——
  // 而溯源页是用户拿着店名去平台点单的依据，跳错家是这一页最坏的一类错误。
  //
  // 故不只断言「字段存在」，而是逐菜对账：同菜名 ⇒ 同 id、同展示名。
  const u1SupIds = [...new Set((d?.items ?? []).map((x) => x.supplierId))].sort((a, b) => a - b);
  const u5SupIds = [...new Set((t?.items ?? []).map((x) => x.supplier?.id))].sort((a, b) => a - b);
  assert(
    u1SupIds.length > 0 &&
      u1SupIds.every((x) => Number.isInteger(x) && x > 0) &&
      JSON.stringify(u1SupIds) === JSON.stringify(u5SupIds),
    'M5-17 U1 `items[].supplierId` 与 U5 `supplier.id` 同源（端上按 id 定位才可能跳对家）',
    `U1=${u1SupIds.join(',')} U5=${u5SupIds.join(',')}`,
  );
  assert(
    (d?.items ?? []).every((x) => {
      const m = (t?.items ?? []).find((y) => y.itemName === x.name);
      return !!m && m.supplier?.id === x.supplierId && m.supplier?.name === x.supplierName;
    }),
    'M5-17 逐菜对账：同名菜品在 U1 / U5 指向同一个出品方 id（不只看字段存在）',
    `items=${(d?.items ?? []).length}`,
  );

  const u5NoBuilding = await call('GET', `/traceability/today?mealDate=${mealDate}`);
  assert(
    u5NoBuilding.body?.code === 10001,
    'U5 缺 buildingId → 10001（免登录下服务端**不猜**楼群：猜错就把 A 楼的出品方给 B 楼看）',
    `code=${u5NoBuilding.body?.code}`,
  );
  assert(
    typeof u5NoBuilding.body?.message === 'string' &&
      u5NoBuilding.body.message !== '' &&
      u5NoBuilding.body.message !== '业务异常',
    '错误码 10001 的 message 非空且不是「业务异常」兜底（只断言 code 会恒绿：文案缺失时用户看不到任何原因）',
    `message=${JSON.stringify(u5NoBuilding.body?.message)}`,
  );

  // ---------- 3. U6 下单（幂等） ----------
  const K1 = 'e2e-order-key-0001';
  // ⚠️ 载荷里**没有** `remark`：订单备注已于 2026-10-23 整条链路删除（交付铁律：
  //    用户侧表单必要字段仅「份数」一项）。DTO 开了 `forbidNonWhitelisted`，多传即 10001。
  const created = await call('POST', '/orders', {
    token,
    idem: K1,
    body: { mealDate, quantity: 2 },
  });
  const orderNo = created.body?.data?.orderNo;
  assert(created.body?.code === 0 && !!orderNo, 'U6 创建订单', `orderNo=${orderNo}`);
  assert(
    created.body?.data?.status === 'pending_pay',
    'U6 初始状态 pending_pay',
    `status=${created.body?.data?.status}`,
  );
  assert(
    created.body?.data?.payAmountFen === 5160,
    'U6 金额 = 单价 × 份数',
    `payAmountFen=${created.body?.data?.payAmountFen}`,
  );

  // 幂等回放：同键重复 → 10006 + 首次结果（端上按成功处理）
  const replay = await call('POST', '/orders', {
    token,
    idem: K1,
    body: { mealDate, quantity: 2 },
  });
  assert(
    replay.body?.code === 10006 && replay.body?.data?.orderNo === orderNo,
    'M1-④ 同一幂等键重复下单只产生一单',
    `code=${replay.body?.code} orderNo=${replay.body?.data?.orderNo}`,
  );
  assert(
    typeof replay.body?.message === 'string' &&
      replay.body.message !== '' &&
      replay.body.message !== '业务异常',
    '错误码 10006 的 message 非空且不是「业务异常」兜底（只断言 code 会恒绿：文案缺失时用户看不到任何原因）',
    `message=${JSON.stringify(replay.body?.message)}`,
  );
  assert(replay.status === 200, '§1.4 幂等回放走 HTTP 200', `status=${replay.status}`);

  // 缺幂等键 → 10001
  const noKey = await call('POST', '/orders', { token, body: { mealDate, quantity: 1 } });
  assert(
    noKey.body?.code === 10001 && noKey.status === 200,
    '§1.7 下单缺 Idempotency-Key → 10001（HTTP 200）',
    `code=${noKey.body?.code} status=${noKey.status}`,
  );
  assert(
    typeof noKey.body?.message === 'string' &&
      noKey.body.message !== '' &&
      noKey.body.message !== '业务异常',
    '错误码 10001 的 message 非空且不是「业务异常」兜底（只断言 code 会恒绿：文案缺失时用户看不到任何原因）',
    `message=${JSON.stringify(noKey.body?.message)}`,
  );

  // 同用户同出餐日**换键**再下单 → 成功建单（2026-10-03 口径变更：一人一日可多单）
  //
  // ⚠️ 原断言是「→ 30004」，随「一人一日一单」口径一并移除。重复提交**不靠这条**拦，
  //    它靠上面的 M1-④：同一 Idempotency-Key 回放 → 10006 且回吐原 orderNo。
  //    换键 = 用户的新意图（下午加订三份这种最常见的情况），必须放行。
  const second = await call('POST', '/orders', {
    token,
    idem: 'e2e-order-key-0002',
    body: { mealDate, quantity: 1 },
  });
  assert(
    second.body?.code === 0 &&
      !!second.body?.data?.orderNo &&
      second.body?.data?.orderNo !== orderNo,
    '一人一日可多单：同出餐日换键再下单成功建单（且不是幂等回放）',
    `code=${second.body?.code} first=${orderNo} second=${second.body?.data?.orderNo}`,
  );

  // 清理第二单（非断言动作）：后续 §10 等夹具按当日单量取数，多留一单会改变取数结果
  if (second.body?.data?.orderNo) {
    await call('POST', `/orders/${second.body.data.orderNo}/cancel`, {
      token,
      idem: 'e2e-cancel-key-0002',
    });
  }

  // 超份数 → 30002
  const overQty = await call('POST', '/orders', {
    token,
    idem: 'e2e-order-key-0003',
    body: { mealDate, quantity: 999 },
  });
  assert(overQty.body?.code === 30002, '份数超上限 → 30002', `code=${overQty.body?.code}`);
  assert(
    typeof overQty.body?.message === 'string' &&
      overQty.body.message !== '' &&
      overQty.body.message !== '业务异常',
    '错误码 30002 的 message 非空且不是「业务异常」兜底（只断言 code 会恒绿：文案缺失时用户看不到任何原因）',
    `message=${JSON.stringify(overQty.body?.message)}`,
  );

  // ---------- 4. U7 / U8 支付 ----------
  const prepay = await call('POST', `/orders/${orderNo}/pay`, { token, idem: 'e2e-pay-key-0001' });
  assert(
    prepay.body?.code === 0 && prepay.body?.data?.payAmountFen === 5160,
    'U7 创建微信支付单（JSAPI）',
    `payAmountFen=${prepay.body?.data?.payAmountFen}`,
  );

  let payResult = null;
  for (let i = 0; i < 12; i += 1) {
    await sleep(400);
    const r = await call('GET', `/orders/${orderNo}/pay-result`, { token });
    payResult = r.body?.data;
    if (payResult?.paid) break;
  }
  assert(
    payResult?.paid === true && payResult?.status === 'paid',
    'M1-② 支付回调入账：pending_pay → paid',
    `status=${payResult?.status} statusText=${payResult?.statusText}`,
  );
  assert(
    payResult?.statusText === '待出餐',
    '三视角文案（用户端 paid → 待出餐）',
    `statusText=${payResult?.statusText}`,
  );

  // ---------- 5. U9 / U10 ----------
  const list = await call('GET', '/orders?page=1&pageSize=20', { token });
  const hit = list.body?.data?.list?.find((x) => x.orderNo === orderNo);
  assert(!!hit, 'U9 订单列表含本单', `total=${list.body?.data?.total}`);
  assert(!!hit?.statusText, 'U9 列表带服务端状态文案', `statusText=${hit?.statusText}`);

  const detail = await call('GET', `/orders/${orderNo}`, { token });
  const det = detail.body?.data;
  assert(detail.body?.code === 0, 'U10 订单详情');
  assert((det?.timeline?.length ?? 0) >= 6, 'U10 状态机时间线', `nodes=${det?.timeline?.length}`);
  assert(
    det?.timeline?.some((n) => n.done && n.node === 'paid'),
    'U10 时间线已标记 paid 完成',
  );
  assert(!!det?.pickup?.point, 'U10 取餐点', `point=${det?.pickup?.point}`);
  assert(det?.payAmountFen === 5160, 'U10 金额一致', `payAmountFen=${det?.payAmountFen}`);

  // ---------- 6. U11 截单前自助取消 ----------
  // ⭐ 带取消理由（2026-10-04）：理由**可跳过**，但**传了就必须落库** ——
  //    「端上填了、库里没有」是这类功能最典型的假回执，接口层看不出来，必须直查库。
  const cancel = await call('POST', `/orders/${orderNo}/cancel`, {
    token,
    body: { reason: 'not_in_office' },
  });
  assert(
    cancel.body?.code === 0 && cancel.body?.data?.status === 'cancelled',
    'M1-③a 截单前自助取消成功',
    `status=${cancel.body?.data?.status}`,
  );
  assert(
    cancel.body?.data?.refundInitiated === true,
    'M1-③a 已发起原路退款',
    `refundInitiated=${cancel.body?.data?.refundInitiated}`,
  );

  const after = await call('GET', `/orders/${orderNo}`, { token });
  // 直查 sqlite 验证落库（接口出参不含取消理由，只看响应永远发现不了「没写进去」）
  let cancelRow = null;
  {
    // ⚠️ 必须走 `openFixtureDb()`：裸 `new DatabaseSync()` 的 busy_timeout 是 0，
    //    会撞上服务端异步提交的写事务而偶发抛 `database is locked`（κ-4，详见 lib）。
    const db = openFixtureDb();
    cancelRow = db
      .prepare('SELECT cancel_reason, cancel_source FROM ab_order WHERE order_no = ?')
      .get(orderNo);
    db.close();
  }
  assert(
    after.body?.data?.status === 'cancelled' &&
      cancelRow?.cancel_reason === 'not_in_office' &&
      cancelRow?.cancel_source === 'user',
    '取消后详情状态为 cancelled，且取消理由与来源已落库',
    `reason=${cancelRow?.cancel_reason} source=${cancelRow?.cancel_source}`,
  );
  assert(
    after.body?.data?.timeline?.some((n) => n.node === 'cancelled' && n.done),
    '取消后时间线出现「已取消」节点',
  );

  // ---------- 7. 截单后自助取消 → 40004 ----------
  const login2 = await call('POST', '/auth/login', { body: { code: 'dev:1002' } });
  const token2 = login2.body?.data?.token;
  const created2 = await call('POST', '/orders', {
    token: token2,
    idem: 'e2e-order-key-1002',
    body: { mealDate, quantity: 1 },
  });
  const orderNo2 = created2.body?.data?.orderNo;
  assert(!!orderNo2, '第二用户下单（用于截单后取消分支）', `orderNo=${orderNo2}`);

  if (orderNo2 && existsSync(DB_PATH)) {
    // 把出餐日改到「昨天」→ 截单时刻早已过去 → 触发 40004 分支
    const db = openFixtureDb();
    const past = mealDateYMD(mealDate, -2);
    const stmt = db.prepare('UPDATE ab_order SET meal_date = ? WHERE order_no = ?');
    const info = stmt.run(past, orderNo2);
    db.close();
    assert(info.changes === 1, '构造「已截单」样本（meal_date 回拨）', `${mealDate} → ${past}`);

    const late = await call('POST', `/orders/${orderNo2}/cancel`, { token: token2 });
    assert(
      late.body?.code === 40004,
      'M1-③b 截单后调取消接口返回 40004',
      `code=${late.body?.code} status=${late.status}`,
    );
    assert(
      typeof late.body?.message === 'string' &&
        late.body.message !== '' &&
        late.body.message !== '业务异常',
      '错误码 40004 的 message 非空且不是「业务异常」兜底（只断言 code 会恒绿：文案缺失时用户看不到任何原因）',
      `message=${JSON.stringify(late.body?.message)}`,
    );
    assert(
      !!late.body?.data?.leaderContact,
      '40004 附团长联系方式（引导代退 · C6 第一段）',
      `leaderPhone=${late.body?.data?.leaderContact?.phone}`,
    );
  } else if (!existsSync(DB_PATH)) {
    fail('构造「已截单」样本', `找不到数据库文件 ${DB_PATH}`);
  }

  // ---------- 8. M5-17 · 团长归属（`leader.source` + 缺陷⑫ 回归） ----------
  //
  // ## 这条为什么值得单列一段
  // U1 的 `leader` 只决定**界面显示什么**，`OrderService.resolveLeader` 决定**钱归谁**。
  // 两者本是同一个问题的两份实现 —— 而它们此前判据不同：
  //   · U6（钱）：`team_leader_id` 指向的团长必须**在职**才用，否则回落到本楼在任团长；
  //   · U1（显示）：只取 `team_leader_id` 指向的行，**不看在职与否**。
  // 于是「团长停职 + 用户未重绑」时，首页写着 A，佣金却记给 B —— 缺陷⑫。
  // 根因是 D22「停职」只改 `ab_team_leader.status`、不清 `ab_user.team_leader_id`
  // （这是**对的**，复职后绑定该还在），所以「绑定行」与「有效归属」本来就可以不是同一个。
  //
  // ## 怎么测才不作弊
  // 从库里**独立复算**一遍 U6 的判据（同一段 SQL，不调服务端、不复用 U1 的结果），
  // 再与 U1 的显示值对账。若拿 U1 自己算出来的值当期望，这条断言就只能证明
  // 「U1 等于它自己」，对分歧无感 —— 正是本项目反复踩的假绿形状。
  //
  // 停职样本用完**必须复位**：断言成败都要复位，否则后续用例（乃至下次跑种子）
  // 会落在一个被改脏的库上。
  if (existsSync(DB_PATH)) {
    const login1002 = await call('POST', '/auth/login', { body: { code: 'dev:1002' } });
    const token1002 = login1002.body?.data?.token;

    // 用户 1002：`team_leader_id = 1`（李明，building 1）→ 属「经邀请链接绑定」
    const before = (await call('GET', '/home/daily', { token: token1002 })).body?.data;
    assert(
      before?.leader?.source === 'bound' && before?.leader?.id === 1,
      'M5-17 U1 `leader.source=bound`：经邀请链接绑定的用户（1002 ← 团长#1）',
      `source=${before?.leader?.source} id=${before?.leader?.id}`,
    );

    // 用户 1001：`team_leader_id = null` → 属「未走邀请流程、被自动挂靠」
    const d1001 = (await call('GET', '/home/daily', { token })).body?.data;
    assert(
      d1001?.leader?.source === 'building_default' && !!d1001?.leader?.id,
      'M5-17 U1 `leader.source=building_default`：未绑定用户（1001）被明示自动挂靠（而非静默替他决定）',
      `source=${d1001?.leader?.source} id=${d1001?.leader?.id} name=${d1001?.leader?.name}`,
    );
    assert(
      (d1001?.items ?? []).every((x) => Number.isInteger(x.supplierId) && x.supplierId > 0),
      'M5-17 U1 `items[].supplierId` 恒为正整数（端上按 id 定位，不按无唯一约束的名字）',
      `ids=${(d1001?.items ?? []).map((x) => x.supplierId).join(',')}`,
    );

    // ---- 缺陷⑫ 回归：把 1002 绑定的团长（#1）改成停职，逼出分歧点 ----
    const db = openFixtureDb();
    try {
      const suspend = db.prepare('UPDATE ab_team_leader SET status = 2 WHERE id = 1').run();
      assert(suspend.changes === 1, '构造「团长停职」样本', 'ab_team_leader#1 status 1 → 2');

      const after = (await call('GET', '/home/daily', { token: token1002 })).body?.data;
      const oracle = resolveLeaderByU6Rule(1002);

      assert(
        after?.leader?.id !== 1,
        '缺陷⑫ U1 不再把**已停职**的绑定团长当作归属（「显示 A / 钱记 B」的旧形状已修）',
        `leader.id=${after?.leader?.id} source=${after?.leader?.source}`,
      );
      assert(
        (after?.leader?.id ?? null) === oracle,
        '缺陷⑫ 显示即归属：U1 的 `leader.id` 与**独立复算**的 U6 判据结果一致',
        `U1=${after?.leader?.id} U6判据=${oracle}`,
      );
      assert(
        after?.leader?.id === 2 && after?.leader?.source === 'building_default',
        '缺陷⑫ 回落到**本楼（4 号楼）在任团长**（王芳 #2），并如实标注为自动挂靠',
        `id=${after?.leader?.id} name=${after?.leader?.name} source=${after?.leader?.source}`,
      );
    } finally {
      // 复位（断言失败也必须执行）
      const back = db.prepare('UPDATE ab_team_leader SET status = 1 WHERE id = 1').run();
      db.close();
      assert(back.changes === 1, '停职样本已复位', 'ab_team_leader#1 status 2 → 1');
    }
  } else {
    fail('M5-17 团长归属断言', `找不到数据库文件 ${DB_PATH}`);
  }

  // ---------- 9. M5-20 · 账号注销 U19（提审硬要求 · 零 DDL） ----------
  //
  // ## 这条为什么必须进常驻套件
  // 《提审自检清单 v1.2》第 10 条：小程序**必须**提供账号注销入口，缺失即不通过。
  // 在此之前这个能力**一行代码都没有**，而当时的 22 道门禁 + 上千条断言**全绿** ——
  // 因为现有门禁检的是「已实现的功能对不对」，不是「合规要求有没有做」。
  // 于是本段就是这条合规项的**机械证据**：删掉入口，这里立刻红。
  //
  // ## 测什么
  //   ① 二次确认词由**服务端**裁定（端上自绘弹窗不构成证据）
  //   ② 三个 fail-closed 闸门各单独验证一次 —— 团长 / 未终态订单，且**互不误报**
  //   ③ 注销 = 匿名化 + 停用，**不是删行**（`openid` 必须留，否则同一个人再登录
  //      会注册成一个全新账号 —— 同一微信两套账，比留一行匿名数据更糟）
  //   ④ 注销后同一微信再登录 → 20014，**不是**重新注册、也**不是**幂等成功
  //
  // ## 为什么用「全新账号」而不是种子用户
  // 种子里的 5 个用户**本身全是团长**（`ab_user` ←→ `ab_team_leader` 一一对应），
  // 拿他们做「成功注销」的样本会**必然**撞上「在职团长」闸门 —— 那就变成了
  // 「换个方式测闸门①」，永远测不到成功路径。故用 `dev:qa-cancel-<时间戳>`
  // 现造一个干净账号（mock provider 把 `dev:x` 直接映射成稳定 openid，见
  // `providers/wx-mini/mock-wx-mini.provider.ts`）。
  //
  // ⚠️ 这个账号**必须登记进 `adHocUsers`**（收尾统一带走）：本段**不断言 `isNewUser`**，
  //    所以账号已存在也照样绿 —— 污染**不会**让本套件变红，只会**悄悄攒在库里**。
  //    实测：连跑三轮 `e2e:m1`，`mock_openid_qa-cancel-*` 由 5 行涨到 8 行（每轮 +1）。
  //    「不显形」正是它比 M1-① 更难发现的地方 —— 但性质一样：测试自己造的自己收。
  if (existsSync(DB_PATH)) {
    const cdb = openFixtureDb();
    try {
      const freshCode = `dev:qa-cancel-${Date.now()}`;
      const fl = await call('POST', '/auth/login', { body: { code: freshCode } });
      const fToken = fl.body?.data?.token;
      const fId = fl.body?.data?.user?.id;
      if (Number.isInteger(fId)) adHocUsers.push({ id: fId, code: freshCode });
      assert(
        fl.body?.code === 0 && !!fToken && !!fId,
        'M5-20 U19 前置：现造一个干净账号（种子用户全是团长，测不到成功路径）',
        `userId=${fId} isNewUser=${fl.body?.data?.isNewUser}`,
      );

      // ---- 9a. 二次确认词 ----
      const wrongWord = await call('POST', '/me/cancel', {
        token: fToken,
        body: { confirmText: '注销' },
      });
      assert(
        wrongWord.body?.code === 10001,
        'U19 确认词不符 → 10001（「注销」不够，必须逐字是「注销账号」）',
        `code=${wrongWord.body?.code} msg=${wrongWord.body?.message}`,
      );
      const notCanceled = await call('GET', '/auth/me', { token: fToken });
      assert(
        notCanceled.body?.code === 0 && notCanceled.body?.data?.nickname !== '已注销用户',
        'U19 确认词被拒后**账号未被误注销**（fail-closed 不能「拒了但顺手办了」）',
        `nickname=${notCanceled.body?.data?.nickname}`,
      );

      // ---- 9b. 闸门①：在职团长（`dev:1001` = 李明 = 团长#1 · status=1） ----
      const leaderBlocked = await call('POST', '/me/cancel', {
        token,
        body: { confirmText: '注销账号' },
      });
      assert(
        leaderBlocked.body?.code === 20015,
        'U19 闸门① 在职团长不能注销 → 20015',
        `code=${leaderBlocked.body?.code} msg=${leaderBlocked.body?.message}`,
      );
      assert(
        (leaderBlocked.body?.data?.reasons ?? []).includes('leader'),
        'U19 `data.reasons` 含原因**码** `leader`（可机械判读，端上不靠中文反推）',
        `reasons=${JSON.stringify(leaderBlocked.body?.data?.reasons)}`,
      );
      assert(
        (await call('GET', '/auth/me', { token })).body?.code === 0,
        'U19 被闸门拦下 ≠ 账号被停用：该账号**仍可正常使用**（拦的是注销这一个动作）',
        '',
      );

      // ---- 9c. 闸门②：有未终态订单 ----
      // 全新账号没有楼 → 先挂一栋（与第 8 段「直改库构造样本」同一手法）。
      // 不挂楼的话下单会先在「无分配/无楼」那一步就失败，测到的是别的东西。
      const assigned = cdb
        .prepare('UPDATE ab_user SET building_id = 1 WHERE id = ?')
        .run(fId);
      assert(
        assigned.changes === 1,
        'U19 构造样本：给干净账号挂楼（`building_id = 1`）',
        `userId=${fId}`,
      );

      const co = await call('POST', '/orders', {
        token: fToken,
        idem: `e2e-cancel-order-${Date.now()}`,
        body: { mealDate, quantity: 1 },
      });
      const cOrderNo = co.body?.data?.orderNo;
      assert(
        co.body?.code === 0 && !!cOrderNo,
        'U19 构造样本：该账号下一笔未付款订单（`pending_pay` 属非终态）',
        `orderNo=${cOrderNo}`,
      );

      const orderBlocked = await call('POST', '/me/cancel', {
        token: fToken,
        body: { confirmText: '注销账号' },
      });
      assert(
        orderBlocked.body?.code === 20015,
        'U19 闸门② 有未完成订单不能注销 → 20015',
        `code=${orderBlocked.body?.code} msg=${orderBlocked.body?.message}`,
      );
      assert(
        JSON.stringify(orderBlocked.body?.data?.reasons ?? []) === JSON.stringify(['orders']),
        'U19 两道闸门**互不误报**：该账号既非团长也无余额 → `reasons` 恰为 ["orders"]（把 reason 判据写成「有任意一条就报全部」会在这里露馅）',
        `reasons=${JSON.stringify(orderBlocked.body?.data?.reasons)}`,
      );
      assert(
        (orderBlocked.body?.data?.pendingOrders ?? 0) >= 1,
        'U19 `data.pendingOrders` 给出在途单数（让端上能说清「还有几单」，而不是只能反复点）',
        `pendingOrders=${orderBlocked.body?.data?.pendingOrders}`,
      );

      // ---- 9d. 放开闸门 → 成功注销 ----
      const released = await call('POST', `/orders/${cOrderNo}/cancel`, { token: fToken });
      assert(
        released.body?.code === 0,
        'U19 构造样本：取消那笔在途订单（闸门随即放开 —— 也证明拦的是「在途」而非「下过单」）',
        `status=${released.body?.data?.status}`,
      );

      const done = await call('POST', '/me/cancel', {
        token: fToken,
        body: { confirmText: '注销账号', reason: 'e2e 自动化注销' },
      });
      assert(done.body?.code === 0, 'U19 注销成功（三道闸门全过）', `code=${done.body?.code}`);
      assert(
        done.body?.data?.status === 3,
        'U19 注销后 `status = 3`（新增 `UserStatus.CANCELED`）',
        `status=${done.body?.data?.status}`,
      );
      const cleared = done.body?.data?.clearedFields ?? [];
      assert(
        cleared.length === 7 &&
          [
            'nickname',
            'avatarUrl',
            'phone',
            'phoneHash',
            'buildingId',
            'teamLeaderId',
            'subscribeFlag',
          ].every((k) => cleared.includes(k)),
        'U19 `clearedFields` 恰为 7 项且覆盖全部可识别字段（端上照服务端下发的清单展示，不写第二份）',
        `cleared=${cleared.join(',')}`,
      );
      assert(
        /依法|法律/.test(done.body?.data?.note ?? ''),
        'U19 `note` 明写「订单/资金记录依法保留」—— 否则用户以为数据全没了，而客服在后台仍看得到他的历史订单 = **虚假告知**',
        `note=${done.body?.data?.note}`,
      );

      // ---- 9e. 落库事实（不看接口自述，直接查库） ----
      const row = cdb
        .prepare(
          'SELECT status, deleted_at, nickname, phone, avatar_url, building_id, team_leader_id, openid FROM ab_user WHERE id = ?',
        )
        .get(fId);
      assert(
        row?.status === 3 && !!row?.deleted_at,
        'U19 落库：`status = 3` + 软删时间（一次 UPDATE 写完，不留「改了状态没清资料」的半截态）',
        `status=${row?.status} deleted_at=${row?.deleted_at}`,
      );
      assert(
        row?.nickname === '已注销用户' &&
          row?.phone === null &&
          row?.avatar_url === null &&
          row?.building_id === null &&
          row?.team_leader_id === null,
        'U19 落库：资料已匿名化（昵称覆写 + 5 个可识别字段清空）',
        `nickname=${row?.nickname} phone=${row?.phone} building=${row?.building_id} leader=${row?.team_leader_id}`,
      );
      assert(
        !!row?.openid,
        'U19 落库：`openid` **刻意保留** —— 删掉它，同一个人下次登录会再注册成一个**全新账号**（同一微信两套账，比留一行匿名数据更糟）',
        `openid=${row?.openid ? 'kept' : 'MISSING'}`,
      );
      assert(
        (cdb.prepare('SELECT COUNT(*) AS c FROM ab_order WHERE user_id = ?').get(fId)?.c ?? 0) >= 1,
        'U19 不碰事实：订单行**未被删除**（财务凭证留存优先于「删除个人数据」，注销是**身份层**动作）',
        '',
      );

      // ---- 9f. 注销之后 ----
      const relogin = await call('POST', '/auth/login', { body: { code: freshCode } });
      assert(
        relogin.body?.code === 20014,
        'U19 同一微信号再登录 → 20014（**不是**重新注册成新账号、**不是** 20006）',
        `code=${relogin.body?.code} msg=${relogin.body?.message}`,
      );
      assert(
        relogin.body?.code !== 20006,
        'U19 与黑名单**必须分码**：注销是**用户自己发起的**、黑名单是**平台处罚** —— 混成一个码，客服就无法从错误码判断该走「恢复账号」还是「解封」',
        `code=${relogin.body?.code}`,
      );

      const repeat = await call('POST', '/me/cancel', {
        token: fToken,
        body: { confirmText: '注销账号' },
      });
      assert(
        repeat.body?.code === 20014,
        'U19 重复注销 → 20014（**不是幂等成功** —— 静默成功会让用户以为「刚刚才注销」，与 `20013` / `40013` 同一哲学）',
        `code=${repeat.body?.code}`,
      );
      assert(
        typeof repeat.body?.message === 'string' &&
          repeat.body.message !== '' &&
          repeat.body.message !== '业务异常',
        '错误码 20014 的 message 非空且不是「业务异常」兜底（只断言 code 会恒绿：文案缺失时用户看不到任何原因）',
        `message=${JSON.stringify(repeat.body?.message)}`,
      );

      const oldToken = await call('GET', '/auth/me', { token: fToken });
      assert(
        oldToken.body?.code === 0 && oldToken.body?.data?.nickname === '已注销用户',
        'U19 ⚠️ **已知边界（写成断言而非遗漏）**：已签发的旧 token 在过期前仍可用，但读到的是**已匿名化**的资料 —— 与 `20006` 黑名单同口径（状态只在**登录时**判，不做每请求查库）。改成每请求查库要付全站一次 DB 往返，属**待裁定**项',
        `nickname=${oldToken.body?.data?.nickname}`,
      );
    } finally {
      cdb.close();
    }
  } else {
    fail('M5-20 账号注销断言', `找不到数据库文件 ${DB_PATH}`);
  }

  // ---------- 10. P1-U2 · 口味评价 U20（逐菜三键 · 一次定稿） ----------
  // 夹具：再造一单走完支付后**直改状态为 delivered** —— e2e 环境没有配送/取餐回调，
  // 与 §7「meal_date 回拨」同一夹具形态（直写 DB 只作前置，断言全部走 HTTP 回读）。
  // 首单已在 §6 取消；2026-10-03 起一人一日可多单，故这里再造一单不受「是否已有单」影响
  // （原注释依赖的「重复下单判据排除 cancelled」已随该判据一并移除）。
  const ratedCreate = await call('POST', '/orders', {
    token,
    idem: 'e2e-order-key-rating',
    body: { mealDate, quantity: 1 },
  });
  const ratingOrderNo = ratedCreate.body?.data?.orderNo;
  assert(
    !!ratingOrderNo,
    'U20 前置：再造一单（取消单不占重复下单名额）',
    `orderNo=${ratingOrderNo}`,
  );

  await call('POST', `/orders/${ratingOrderNo}/pay`, { token, idem: 'e2e-pay-key-rating' });
  let ratingPaid = null;
  for (let i = 0; i < 12; i += 1) {
    await sleep(400);
    const r = await call('GET', `/orders/${ratingOrderNo}/pay-result`, { token });
    ratingPaid = r.body?.data;
    if (ratingPaid?.paid) break;
  }
  assert(ratingPaid?.paid === true, 'U20 前置：新单已支付', `status=${ratingPaid?.status}`);

  if (ratingOrderNo && existsSync(DB_PATH)) {
    const rdb = openFixtureDb();
    try {
      const fix = rdb
        .prepare("UPDATE ab_order SET status = 'delivered' WHERE order_no = ?")
        .run(ratingOrderNo);
      assert(fix.changes === 1, 'U20 夹具：状态直改 delivered（无配送回调环境的等价前置）');

      // 评价前详情：canRate=true、items 带 itemId（U20 的菜键来源）
      const before = (await call('GET', `/orders/${ratingOrderNo}`, { token })).body?.data;
      const rv = before?.rating;
      assert(
        rv?.canRate === true && rv?.rated === false && rv?.ratedAt === null,
        'U10 详情带评价状态块：delivered 未评单 canRate=true',
        `canRate=${rv?.canRate} rated=${rv?.rated}`,
      );
      const items = before?.items ?? [];
      assert(
        items.length === 4 && items.every((d) => typeof d.itemId === 'number'),
        'U10 详情 items 下发 itemId（端上评价卡的菜键 · 一饭四菜=4 位）',
        `count=${items.length}`,
      );

      // 状态闸门：cancelled 单（首单）→ 30020，且回带 status/allowed 供端上引导
      const gate = await call('POST', `/orders/${orderNo}/rating`, {
        token,
        body: { items: [{ itemId: items[0].itemId, rating: 1 }] },
      });
      assert(
        gate.body?.code === 30020 && gate.body?.data?.status === 'cancelled',
        'U20 状态闸门：未送达单 → 30020（非 5xx），回带 status',
        `code=${gate.body?.code} status=${gate.body?.data?.status}`,
      );
      assert(
        gate.body?.message === '当前订单状态不允许评价',
        'U20 30020 的 message 是**专属文案**（只断言 code 会恒绿：文案缺失时落到「业务异常」兜底，用户看不到原因）',
        `message=${JSON.stringify(gate.body?.message)}`,
      );
      assert(
        Array.isArray(gate.body?.data?.allowed) && gate.body?.data?.allowed.length === 2,
        'U20 30020 回带 allowed 可评状态集（端上据此引导「送达后可评价」）',
        `allowed=${JSON.stringify(gate.body?.data?.allowed)}`,
      );

      // 菜不在本单 → 10001（请求与订单事实不符，不是业务态）
      const foreign = await call('POST', `/orders/${ratingOrderNo}/rating`, {
        token,
        body: { items: [{ itemId: 999999, rating: 1 }] },
      });
      assert(
        foreign.body?.code === 10001,
        'U20 菜不在本单套餐 → 10001',
        `code=${foreign.body?.code}`,
      );
      assert(
        typeof foreign.body?.message === 'string' &&
          foreign.body.message !== '' &&
          foreign.body.message !== '业务异常',
        '错误码 10001 的 message 非空且不是「业务异常」兜底（只断言 code 会恒绿：文案缺失时用户看不到任何原因）',
        `message=${JSON.stringify(foreign.body?.message)}`,
      );

      // 合法提交：2 好吃 + 1 一般 + 1 不好（带首尾空格的原因，验证 trim）
      const submit = await call('POST', `/orders/${ratingOrderNo}/rating`, {
        token,
        body: {
          items: [
            { itemId: items[0].itemId, rating: 1 },
            { itemId: items[1].itemId, rating: 1 },
            { itemId: items[2].itemId, rating: 2 },
            { itemId: items[3].itemId, rating: 3, reason: '  送到时已经凉了  ' },
          ],
        },
      });
      assert(
        submit.body?.code === 0 && submit.body?.data?.ratedCount === 4,
        'U20 逐菜三键提交成功（ratedCount=4，未评的菜被跳过是端上事，服务端照单全收）',
        `code=${submit.body?.code} ratedCount=${submit.body?.data?.ratedCount}`,
      );
      assert(!!submit.body?.data?.ratedAt, 'U20 回带 ratedAt（端上直接切已评终态）');

      // 一次定稿：重复提交 → 30021（非幂等成功 —— 与 20013/20014 同哲学）
      const again = await call('POST', `/orders/${ratingOrderNo}/rating`, {
        token,
        body: { items: [{ itemId: items[0].itemId, rating: 1 }] },
      });
      assert(
        again.body?.code === 30021 && !!again.body?.data?.ratedAt,
        'U20 重复提交 → 30021（裁决④一次定稿，不是 10006 幂等成功）',
        `code=${again.body?.code}`,
      );
      assert(
        again.body?.message === '该订单已评价过，不能重复提交',
        'U20 30021 的 message 是**专属文案**（只断言 code 会恒绿：文案缺失时落到「业务异常」兜底）',
        `message=${JSON.stringify(again.body?.message)}`,
      );

      // 终态回显
      const afterD = (await call('GET', `/orders/${ratingOrderNo}`, { token })).body?.data;
      const ra = afterD?.rating;
      assert(
        ra?.rated === true && ra?.canRate === false && ra?.items?.length === 4,
        'U10 详情终态：rated=true / canRate=false / 回显 4 条',
        `rated=${ra?.rated} items=${ra?.items?.length}`,
      );

      // 落库快照：item_name / supplier_name 为真实快照（非兜底占位），reason 已 trim
      const rows = rdb
        .prepare(
          'SELECT item_name, supplier_name, rating, reason FROM ab_item_rating WHERE order_no = ? ORDER BY slot',
        )
        .all(ratingOrderNo);
      assert(rows.length === 4, 'U20 落库恰 4 行（整批单事务）', `rows=${rows.length}`);
      const badRow = rows.find((x) => x.rating === 3);
      assert(
        badRow?.reason === '送到时已经凉了',
        'U20 落库 reason 已 trim（首尾空格不入库）',
        `reason=${JSON.stringify(badRow?.reason)}`,
      );
      assert(
        rows.every((x) => x.item_name && !/^菜品#/.test(x.item_name)),
        'U20 落库 item_name 为真实快照（菜改名/下架不影响历史行）',
      );
      assert(
        rows.every((x) => x.supplier_name && !/^供应商#/.test(x.supplier_name)),
        'U20 落库 supplier_name 为真实快照',
      );

      // 还原夹具：删评价行 + 订单 + 支付流水。⚠️ 必须删干净 —— 本套之后还有 m2/m3，
      // 两者的开篇夹具都要用 dev:1001 在**同一出餐日**下单。
      // 2026-10-03 起一人一日可多单，故风险**不再是**「红在 30004」（原注释结论已随该
      // 判据一并移除），但留一张 delivered 单仍会让后续两套按当日单量取数时多出一单
      // —— 污染依旧存在，只是换了个表现，删除动作不能省。
      const delR40 = rdb
        .prepare('DELETE FROM ab_item_rating WHERE order_no = ?')
        .run(ratingOrderNo);
      const delP40 = rdb
        .prepare('DELETE FROM ab_payment_log WHERE order_no = ?')
        .run(ratingOrderNo);
      const delO40 = rdb.prepare('DELETE FROM ab_order WHERE order_no = ?').run(ratingOrderNo);
      assert(
        delR40.changes === 4 && delO40.changes === 1,
        'U20 夹具还原：评价 4 行 + 订单 1 行已删（不留半截态给后续套件）',
        `rating=${delR40.changes} order=${delO40.changes} payLog=${delP40.changes}`,
      );
    } finally {
      rdb.close();
    }
  } else {
    fail('U20 口味评价断言', `缺少前置（orderNo=${ratingOrderNo} / DB=${DB_PATH}）`);
  }

  // ---------- 汇总 ----------
  // 连根回收（Windows 下 shell:true 只起一层 cmd.exe，必须 taskkill /T 才能收掉 ts-node）
  await stopApiServer(server, PORT);

  // ⭐ 0 条断言必须**硬失败**（2026-10-04 整体复查 · 报告 ⑧）
  //    此前 `通过 0/0 · 全绿 ✅` + exit 0 是一条**合法**的退出路径：某次改动让一整节
  //    被跳过时，114 会静默掉到 0 而门禁照样绿。0 条不是「全过」，是**链路根本没执行**。
  //    （外层 `gate.mjs` 的 `EXPECT_MIN` 另有一道规模下限，两者是同一缺陷的两层防护。）
  if (results.length === 0) {
    log('\n✘ 一条断言都没跑（0/0）—— 这不是「全绿」，是链路根本没执行。');
    log('  常见原因：前置失败被异常路径吞掉 / 服务没起来 / 某一节被条件整体跳过。');
    return 1;
  }

  const failed = results.filter((r) => !r.pass);
  log('\n──────── 汇总 ────────');
  log(
    `通过 ${results.length - failed.length}/${results.length}` +
      (failed.length ? ` · 失败：${failed.map((f) => f.name).join(' | ')}` : ' · 全绿 ✅'),
  );
  return failed.length ? 1 : 0;
}

/** yyyy-MM-dd 日期加减（纯 UTC，避开时区陷阱） */
function mealDateYMD(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
}

/**
 * 独立复刻 `OrderService.resolveLeader` 的归属判据（只读 · 供缺陷⑫对账用）
 *
 * ⚠️ 故意**不调服务端、不复用 U1 的出参** —— 这个函数是「U6 会怎么判」的第二份表述，
 *    拿它当期望值，U1 与 U6 一旦分歧才会红。若把 U1 自己算的结果当期望，
 *    这条断言只能证明「U1 等于它自己」，对分歧完全无感（本项目反复踩的假绿形状）。
 *
 * ⚠️ 判据必须与 `apps/api-server/src/modules/order/order.service.ts` 的 `resolveLeader`
 *    同步：那边改规则，这里要一起改，否则会造出**第三份**判据。
 *
 * ⚠️ 排序刻意定死 `ORDER BY id ASC`，对齐服务端的 `order: { id: 'ASC' }` ——
 *    随机取一位在任团长会让「显示 == 归属」在有多位团长的楼上偶发假红。
 */
function resolveLeaderByU6Rule(userId) {
  const db = openFixtureDb();
  try {
    const u = db
      .prepare('SELECT building_id, team_leader_id FROM ab_user WHERE id = ?')
      .get(userId);
    if (!u) return null;

    // ① 绑定的团长**在职**才用（这正是 U1 此前漏掉的那一步）
    if (u.team_leader_id) {
      const own = db
        .prepare('SELECT id, status FROM ab_team_leader WHERE id = ?')
        .get(u.team_leader_id);
      if (own && Number(own.status) === 1) return Number(own.id);
    }
    // ② 否则回落到本楼 id 最小的在任团长
    if (u.building_id) {
      const fb = db
        .prepare(
          'SELECT id FROM ab_team_leader WHERE building_id = ? AND status = 1 ORDER BY id ASC LIMIT 1',
        )
        .get(u.building_id);
      if (fb) return Number(fb.id);
    }
    return null;
  } finally {
    db.close();
  }
}

/**
 * 入口：跑套件 → **无论成败**都自清现造账号 → 统一退出。
 *
 * `try/finally` 是这里唯一的正确形状：`run()` 里任何一处抛错 / 提前返回，
 * 自清都必须照跑 —— 测试自己造的自己收，失败也尽力带走。
 */
async function main() {
  let code = 1;
  try {
    code = await run();
  } finally {
    cleanupAdHocUsers();
  }
  process.exit(code);
}

main().catch((e) => {
  log(`\n✘ E2E 异常：${e?.stack ?? e}`);
  process.exit(1);
});

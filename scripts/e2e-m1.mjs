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
import { DatabaseSync } from 'node:sqlite';

import {
  BASE,
  DB_PATH,
  PORT,
  assertPortFree,
  installCleanupHooks,
  makeCall,
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
async function main() {
  log(`\n=== ABox M1 端到端验收 ===\n数据库：${DB_PATH}\n`);

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
    typeof ready.body?.data?.version === 'string' &&
      Number.isInteger(ready.body?.data?.uptimeSec),
    'M5-0 就绪探针回显版本与运行时长（灰度 / 回滚判据）',
    `version=${ready.body?.data?.version} uptimeSec=${ready.body?.data?.uptimeSec}`,
  );
  // 探针**免鉴权**（编排器要打），故出参按「会被人看见」设计：失败原因只进服务端日志
  const probeRaw = JSON.stringify(ready.body);
  assert(
    !/password|secret|passwd|127\.0\.0\.1|localhost|3306|6379|sqlite|\.env/i.test(probeRaw),
    'M5-0 免鉴权探针不泄露主机 / 端口 / 连接串',
    probeRaw.slice(0, 160),
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
  assert(login.body?.code === 0 && !!token, 'A1 微信登录签发 JWT', `userId=${login.body?.data?.user?.id}`);
  // ---------- 1b. C3 / L9：只凭 code 登录，不取手机号 / 不取地址 ----------
  // ⚠️ 注意区分：种子里的 5 个用户**本身都是团长账号**，其 `ab_user.phone` 来自
  //    「申请团长时留的联系方式」，属合规数据；L9 禁止的是**登录环节索取**。
  //    故真正能证明 L9 的是「全新用户」与「入参白名单」这两条断言。
  const fresh = await call('POST', '/auth/login', { body: { code: 'dev:9001' } });
  const fu = fresh.body?.data?.user;
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
  assert((d?.dishes?.length ?? 0) >= 4, '套餐含一饭四菜', `dishes=${d?.dishes?.length}`);
  assert(
    d?.dishes?.every((x) => !('unitPrice' in x) && !('cost' in x)),
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
    `code=${u5.body?.code} dishes=${t?.dishes?.length ?? 0}`,
  );
  assert(
    (t?.dishes?.length ?? 0) >= 4,
    'U5 出品方逐菜列出（一饭四菜 · 原型 P38 的 4 张出品方卡）',
    `dishes=${t?.dishes?.length}`,
  );

  const supOf = (name) => (t?.dishes ?? []).find((x) => x.supplier?.name === name);

  const sanwei = supOf('三味屋');
  assert(
    sanwei?.supplier?.qualifications?.includes('food_business_license') &&
      sanwei?.supplier?.qualifications?.includes('business_license'),
    'U5 资质行取自**在册证照**（且要求 audit_status=approved —— 上传了≠核验过）',
    `quals=${JSON.stringify(sanwei?.supplier?.qualifications)}`,
  );
  assert(
    sanwei?.supplier?.takeoutLinks?.length === 3 &&
      sanwei.supplier.takeoutLinks.filter((l) => l.configured).length === 3 &&
      sanwei?.supplier?.recommended === 'meituan',
    'U5 三味屋三平台齐全 + 推荐美团（对齐原型 P33 配置表）',
    `configured=${sanwei?.supplier?.takeoutLinks?.filter((l) => l.configured).length} rec=${sanwei?.supplier?.recommended}`,
  );

  const sijiJd = (supOf('四季鲜蔬')?.supplier?.takeoutLinks ?? []).find((l) => l.platform === 'jd');
  assert(
    (supOf('四季鲜蔬')?.supplier?.takeoutLinks ?? []).length === 3 &&
      sijiJd?.configured === false &&
      sijiJd?.url === null,
    'U5 「缺京东」**看得见**：三平台恒返回，未入驻的 configured=false 且 url=null（端上置灰，不是整行消失）',
    `jd=${JSON.stringify(sijiJd)}`,
  );
  assert(
    (t?.dishes ?? []).every(
      (x) =>
        !x.supplier?.recommended ||
        x.supplier.takeoutLinks.some((l) => l.platform === x.supplier.recommended && l.configured),
    ),
    'U5 推荐平台必为**已配置**的平台（悬空推荐 = 用户点到一个没反应的入口）',
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
  const u1SupIds = [...new Set((d?.dishes ?? []).map((x) => x.supplierId))].sort((a, b) => a - b);
  const u5SupIds = [...new Set((t?.dishes ?? []).map((x) => x.supplier?.id))].sort((a, b) => a - b);
  assert(
    u1SupIds.length > 0 &&
      u1SupIds.every((x) => Number.isInteger(x) && x > 0) &&
      JSON.stringify(u1SupIds) === JSON.stringify(u5SupIds),
    'M5-17 U1 `dishes[].supplierId` 与 U5 `supplier.id` 同源（端上按 id 定位才可能跳对家）',
    `U1=${u1SupIds.join(',')} U5=${u5SupIds.join(',')}`,
  );
  assert(
    (d?.dishes ?? []).every((x) => {
      const m = (t?.dishes ?? []).find((y) => y.dishName === x.name);
      return !!m && m.supplier?.id === x.supplierId && m.supplier?.name === x.supplierName;
    }),
    'M5-17 逐菜对账：同名菜品在 U1 / U5 指向同一个出品方 id（不只看字段存在）',
    `dishes=${(d?.dishes ?? []).length}`,
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
    "错误码 10001 的 message 非空且不是「业务异常」兜底（只断言 code 会恒绿：文案缺失时用户看不到任何原因）",
    `message=${JSON.stringify(u5NoBuilding.body?.message)}`,
  );

  // ---------- 3. U6 下单（幂等） ----------
  const K1 = 'e2e-order-key-0001';
  const created = await call('POST', '/orders', {
    token,
    idem: K1,
    body: { mealDate, quantity: 2, remark: 'e2e 冒烟' },
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
    body: { mealDate, quantity: 2, remark: 'e2e 冒烟' },
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
    "错误码 10006 的 message 非空且不是「业务异常」兜底（只断言 code 会恒绿：文案缺失时用户看不到任何原因）",
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
    "错误码 10001 的 message 非空且不是「业务异常」兜底（只断言 code 会恒绿：文案缺失时用户看不到任何原因）",
    `message=${JSON.stringify(noKey.body?.message)}`,
  );

  // 同用户同出餐日重复下单（换键）→ 30004
  const dup = await call('POST', '/orders', {
    token,
    idem: 'e2e-order-key-0002',
    body: { mealDate, quantity: 1 },
  });
  assert(
    dup.body?.code === 30004,
    '业务层幂等：同用户同出餐日重复下单 → 30004',
    `code=${dup.body?.code} msg=${dup.body?.message}`,
  );

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
    "错误码 30002 的 message 非空且不是「业务异常」兜底（只断言 code 会恒绿：文案缺失时用户看不到任何原因）",
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
  const cancel = await call('POST', `/orders/${orderNo}/cancel`, { token });
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
  assert(after.body?.data?.status === 'cancelled', '取消后详情状态为 cancelled');
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
    const db = new DatabaseSync(DB_PATH);
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
      "错误码 40004 的 message 非空且不是「业务异常」兜底（只断言 code 会恒绿：文案缺失时用户看不到任何原因）",
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
      (d1001?.dishes ?? []).every((x) => Number.isInteger(x.supplierId) && x.supplierId > 0),
      'M5-17 U1 `dishes[].supplierId` 恒为正整数（端上按 id 定位，不按无唯一约束的名字）',
      `ids=${(d1001?.dishes ?? []).map((x) => x.supplierId).join(',')}`,
    );

    // ---- 缺陷⑫ 回归：把 1002 绑定的团长（#1）改成停职，逼出分歧点 ----
    const db = new DatabaseSync(DB_PATH);
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
  if (existsSync(DB_PATH)) {
    const cdb = new DatabaseSync(DB_PATH);
    try {
      const freshCode = `dev:qa-cancel-${Date.now()}`;
      const fl = await call('POST', '/auth/login', { body: { code: freshCode } });
      const fToken = fl.body?.data?.token;
      const fId = fl.body?.data?.user?.id;
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
          ['nickname', 'avatarUrl', 'phone', 'phoneHash', 'buildingId', 'teamLeaderId', 'subscribeFlag'].every(
            (k) => cleared.includes(k),
          ),
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
        "错误码 20014 的 message 非空且不是「业务异常」兜底（只断言 code 会恒绿：文案缺失时用户看不到任何原因）",
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
  // 首单已在 §6 取消，而重复下单判据排除 cancelled ⇒ 同用户同出餐日可再造一单。
  const ratedCreate = await call('POST', '/orders', {
    token,
    idem: 'e2e-order-key-rating',
    body: { mealDate, quantity: 1 },
  });
  const ratingOrderNo = ratedCreate.body?.data?.orderNo;
  assert(!!ratingOrderNo, 'U20 前置：再造一单（取消单不占重复下单名额）', `orderNo=${ratingOrderNo}`);

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
    const rdb = new DatabaseSync(DB_PATH);
    try {
      const fix = rdb
        .prepare("UPDATE ab_order SET status = 'delivered' WHERE order_no = ?")
        .run(ratingOrderNo);
      assert(fix.changes === 1, 'U20 夹具：状态直改 delivered（无配送回调环境的等价前置）');

      // 评价前详情：canRate=true、dishes 带 dishId（U20 的菜键来源）
      const before = (await call('GET', `/orders/${ratingOrderNo}`, { token })).body?.data;
      const rv = before?.rating;
      assert(
        rv?.canRate === true && rv?.rated === false && rv?.ratedAt === null,
        'U10 详情带评价状态块：delivered 未评单 canRate=true',
        `canRate=${rv?.canRate} rated=${rv?.rated}`,
      );
      const dishes = before?.dishes ?? [];
      assert(
        dishes.length === 4 && dishes.every((d) => typeof d.dishId === 'number'),
        'U10 详情 dishes 下发 dishId（端上评价卡的菜键 · 一饭四菜=4 位）',
        `count=${dishes.length}`,
      );

      // 状态闸门：cancelled 单（首单）→ 30020，且回带 status/allowed 供端上引导
      const gate = await call('POST', `/orders/${orderNo}/rating`, {
        token,
        body: { items: [{ dishId: dishes[0].dishId, rating: 1 }] },
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
        body: { items: [{ dishId: 999999, rating: 1 }] },
      });
      assert(foreign.body?.code === 10001, 'U20 菜不在本单套餐 → 10001', `code=${foreign.body?.code}`);
      assert(
        typeof foreign.body?.message === 'string' &&
          foreign.body.message !== '' &&
          foreign.body.message !== '业务异常',
        "错误码 10001 的 message 非空且不是「业务异常」兜底（只断言 code 会恒绿：文案缺失时用户看不到任何原因）",
        `message=${JSON.stringify(foreign.body?.message)}`,
      );

      // 合法提交：2 好吃 + 1 一般 + 1 不好（带首尾空格的原因，验证 trim）
      const submit = await call('POST', `/orders/${ratingOrderNo}/rating`, {
        token,
        body: {
          items: [
            { dishId: dishes[0].dishId, rating: 1 },
            { dishId: dishes[1].dishId, rating: 1 },
            { dishId: dishes[2].dishId, rating: 2 },
            { dishId: dishes[3].dishId, rating: 3, reason: '  送到时已经凉了  ' },
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
        body: { items: [{ dishId: dishes[0].dishId, rating: 1 }] },
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

      // 落库快照：dish_name / supplier_name 为真实快照（非兜底占位），reason 已 trim
      const rows = rdb
        .prepare(
          'SELECT dish_name, supplier_name, rating, reason FROM ab_dish_rating WHERE order_no = ? ORDER BY slot',
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
        rows.every((x) => x.dish_name && !/^菜品#/.test(x.dish_name)),
        'U20 落库 dish_name 为真实快照（菜改名/下架不影响历史行）',
      );
      assert(
        rows.every((x) => x.supplier_name && !/^供应商#/.test(x.supplier_name)),
        'U20 落库 supplier_name 为真实快照',
      );

      // 还原夹具：删评价行 + 订单 + 支付流水。⚠️ 必须删干净 —— 本套之后还有 m2/m3，
      // 两者的开篇夹具都要用 dev:1001 在**同一出餐日**下单，而重复下单判据只排除
      // cancelled —— 留一张 delivered 单会让后续两套的开篇夹具全部红在 30004
      // （本轮实测：组合套跑 m2/m3 双红，单跑却全绿 —— 顺序效应，非产品缺陷）。
      const delR40 = rdb
        .prepare('DELETE FROM ab_dish_rating WHERE order_no = ?')
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

  const failed = results.filter((r) => !r.pass);
  log('\n──────── 汇总 ────────');
  log(`通过 ${results.length - failed.length}/${results.length}` + (failed.length ? ` · 失败：${failed.map((f) => f.name).join(' | ')}` : ' · 全绿 ✅'));
  process.exit(failed.length ? 1 : 0);
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
  const db = new DatabaseSync(DB_PATH);
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

main().catch((e) => {
  log(`\n✘ E2E 异常：${e?.stack ?? e}`);
  process.exit(1);
});

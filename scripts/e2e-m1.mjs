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
  assert(replay.status === 200, '§1.4 幂等回放走 HTTP 200', `status=${replay.status}`);

  // 缺幂等键 → 10001
  const noKey = await call('POST', '/orders', { token, body: { mealDate, quantity: 1 } });
  assert(
    noKey.body?.code === 10001 && noKey.status === 200,
    '§1.7 下单缺 Idempotency-Key → 10001（HTTP 200）',
    `code=${noKey.body?.code} status=${noKey.status}`,
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
      !!late.body?.data?.leaderContact,
      '40004 附团长联系方式（引导代退 · C6 第一段）',
      `leaderPhone=${late.body?.data?.leaderContact?.phone}`,
    );
  } else if (!existsSync(DB_PATH)) {
    fail('构造「已截单」样本', `找不到数据库文件 ${DB_PATH}`);
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

main().catch((e) => {
  log(`\n✘ E2E 异常：${e?.stack ?? e}`);
  process.exit(1);
});

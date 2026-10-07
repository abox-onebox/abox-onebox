/**
 * 深度测试第三层 · 取消理由（2026-10-04 新增功能）
 *
 * 为什么单独起一个服务实例：本地 3000 端口那个是改代码**之前**起的进程
 * （`ts-node src/main.ts` 非 watch），拿它测得的是旧代码。这里复用项目自带的
 * `scripts/lib/e2e-server.mjs` 在 3101 起一个干净实例，测完即关。
 *
 * 用法：node scripts/probes/deep-cancel.mjs
 */
// ── 收编注入（2026-10-07）：以下路径**相对本文件推导**，换机器无需改一行 ──────────
import { fileURLToPath as __aboxFup } from 'node:url';
const __aboxU = (p) => __aboxFup(new URL(p, import.meta.url)).replace(/[\/]+$/, '');

import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const ROOT = __aboxU('../..');
const NODE = process.execPath;

const {
  BASE,
  DB_PATH,
  startApiServer,
  waitHealthy,
  stopApiServer,
} = await import(`file:///${ROOT}/scripts/lib/e2e-server.mjs`);

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
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

function tomorrowBj() {
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  return new Date(bj.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 直查 sqlite —— 接口出参不含取消理由，只看响应永远发现不了「没写进去」。
 *
 * ⚠️ 必须设 `busy_timeout`：API 服务自己也持有同一个 sqlite 连接，刚发生过写
 *    （尤其 mock 支付）时，探针直接开连接会撞 `database is locked`（实测 C18 前
 *    必崩）。这不是产品缺陷 —— 是探针没等锁。
 */
function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 8000');
  return db;
}

function readCancel(orderNo) {
  const db = openDb();
  const row = db
    .prepare(
      'SELECT status, cancel_reason, cancel_note, cancel_source FROM ab_order WHERE order_no = ?',
    )
    .get(orderNo);
  db.close();
  return row ?? null;
}

/** 带重试的写：锁冲突是瞬时的，退避几次再试（仍失败则抛出，不当成通过） */
function writeDb(sql, params, tries = 8) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    let db = null;
    try {
      db = openDb();
      const r = db.prepare(sql).run(...params);
      db.close();
      return r;
    } catch (e) {
      lastErr = e;
      if (db) {
        try {
          db.close();
        } catch {
          /* 已经关了就算了 */
        }
      }
      const ms = 120 * (i + 1);
      const until = Date.now() + ms;
      while (Date.now() < until) {
        /* 忙等：这里不能用 await，writeDb 是同步的 */
      }
    }
  }
  throw new Error(`writeDb 重试 ${tries} 次仍失败：${lastErr?.message}`);
}

let seq = 0;
async function placeOrder(token, mealDate) {
  seq++;
  const r = await call('POST', '/orders', {
    token,
    idem: `dt-cancel-order-${Date.now()}-${seq}`,
    body: { mealDate, quantity: 1 },
  });
  return r.body?.data?.orderNo ?? null;
}

async function main() {
  console.log('重置种子…');
  // ⚠️ 本机 stdio:'pipe' 一律 EBUSY（记忆 C5/C19）：起子进程必须挂 pipefix 垫片
  const PF = process.env.ABOX_PIPEFIX ?? ''; // 本机专用 child_process 垫片（**不在仓库内**，它自述「勿入仓库」）；设 `ABOX_PIPEFIX=<路径>` 才启用
  const seed = spawnSync(NODE, ['scripts/gate.mjs', 'seed'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PIPEFIX_QUIET: '1',
      NODE_OPTIONS: PF ? `--require ${PF}` : (process.env.NODE_OPTIONS ?? ''),
    },
  });
  if (seed.status !== 0) {
    console.error(
      'seed 失败 exit=' + seed.status,
      ((seed.stdout || '') + (seed.stderr || '')).slice(0, 800),
    );
    process.exit(2);
  }

  console.log('起服务…');
  const child = startApiServer();
  // ⚠️ waitHealthy 内部会自己拼 `/health`（`makeCall(base)` 是 `${base}${path}`）；
  //    这里再拼一次会变成 `…/api/v1/health/health` 恒 404 —— 表现为「一直起不来」。
  const healthy = await waitHealthy(BASE, { child, timeoutMs: 120000 });
  if (!healthy) {
    console.error('服务未就绪');
    process.exit(2);
  }
  console.log(`服务就绪 ${BASE}\n`);

  const mealDate = tomorrowBj();
  const login = await call('POST', '/auth/login', { body: { code: 'dev:1' } });
  const token = login.body?.data?.token;
  ok('C1 登录取 token', !!token, token ? 'ok' : JSON.stringify(login.body).slice(0, 160));
  if (!token) {
    await stopApiServer(child);
    return;
  }
  await call('PUT', '/me/building', { token, body: { buildingId: 1 } });

  // ---- 场景 1：带普通理由取消 ----
  const o1 = await placeOrder(token, mealDate);
  ok('C2 建单成功', !!o1, `no=${o1}`);
  const c1 = await call('POST', `/orders/${o1}/cancel`, {
    token,
    idem: `dt-c1-${Date.now()}`,
    body: { reason: 'dish_dislike' },
  });
  ok('C3 带理由取消 → 成功', c1.body?.code === 0, `code=${c1.body?.code}`);
  const r1 = readCancel(o1);
  ok(
    'C4 理由与来源落库（reason=dish_dislike / source=user）',
    r1?.cancel_reason === 'dish_dislike' && r1?.cancel_source === 'user',
    `reason=${r1?.cancel_reason} source=${r1?.cancel_source}`,
  );

  // ---- 场景 2：选「其他」并补充文字 ----
  const o2 = await placeOrder(token, mealDate);
  const c2 = await call('POST', `/orders/${o2}/cancel`, {
    token,
    idem: `dt-c2-${Date.now()}`,
    body: { reason: 'other', note: '客户临时开会' },
  });
  ok('C5 选「其他」取消 → 成功', c2.body?.code === 0, `code=${c2.body?.code}`);
  const r2 = readCancel(o2);
  ok(
    'C6 note 落库（其他理由的补充说明）',
    r2?.cancel_reason === 'other' && r2?.cancel_note === '客户临时开会',
    `reason=${r2?.cancel_reason} note=${r2?.cancel_note}`,
  );

  // ---- 场景 3：不填理由（可跳过）----
  const o3 = await placeOrder(token, mealDate);
  const c3 = await call('POST', `/orders/${o3}/cancel`, {
    token,
    idem: `dt-c3-${Date.now()}`,
  });
  ok('C7 不填理由也能取消（可跳过）', c3.body?.code === 0, `code=${c3.body?.code}`);
  const r3 = readCancel(o3);
  ok(
    'C8 理由为 null 但来源仍记 user（区分「不愿说」与「系统清掉」）',
    r3?.cancel_reason === null && r3?.cancel_source === 'user',
    `reason=${r3?.cancel_reason} source=${r3?.cancel_source}`,
  );

  // ---- 场景 4：非 other 带 note → 应忽略不落库 ----
  const o4 = await placeOrder(token, mealDate);
  await call('POST', `/orders/${o4}/cancel`, {
    token,
    idem: `dt-c4-${Date.now()}`,
    body: { reason: 'price', note: '这条不该被记录' },
  });
  const r4 = readCancel(o4);
  ok(
    'C9 非「其他」理由带 note → 忽略不落库',
    r4?.cancel_reason === 'price' && r4?.cancel_note === null,
    `reason=${r4?.cancel_reason} note=${r4?.cancel_note}`,
  );

  // ---- 场景 5：非法 reason → 校验拦成 10001 ----
  const o5 = await placeOrder(token, mealDate);
  const bad = await call('POST', `/orders/${o5}/cancel`, {
    token,
    idem: `dt-c5-${Date.now()}`,
    body: { reason: 'not_a_valid_reason' },
  });
  ok('C10 非法 reason → 10001（参数校验拦住）', bad.body?.code === 10001, `code=${bad.body?.code}`);
  const r5 = readCancel(o5);
  ok(
    'C11 非法请求未改动订单（仍是原状态、无取消痕迹）',
    r5?.status !== 'cancelled' && r5?.cancel_source === null,
    `status=${r5?.status} source=${r5?.cancel_source}`,
  );

  // ---- 场景 6：系统截单清未支付单 → source=system / reason=timeout_unpaid ----
  // ⭐ 这是「三处全记」里**量最大**的一块，也是最容易被漏的：不标 system 的话，
  //    「忘付款被系统清掉」会混进用户主动放弃的统计，把流失结论带偏。
  const adm = await call('POST', '/auth/admin-login', {
    body: { username: 'admin', password: 'admin123' },
  });
  const adminToken = adm.body?.data?.token;
  ok('C12 后台登录取 token', !!adminToken, `code=${adm.body?.code}`);
  if (adminToken) {
    const o6 = await placeOrder(token, mealDate);
    // 构造「已过截单时刻」的样本：把出餐日回拨到 2 天前（照 e2e-m1 §7 的做法）
    const past = new Date(Date.now() + 8 * 3600 * 1000 - 2 * 86400000)
      .toISOString()
      .slice(0, 10);
    writeDb('UPDATE ab_order SET meal_date = ? WHERE order_no = ?', [past, o6]);
    const cut = await call('POST', '/admin/schedule/cutoff/run', {
      token: adminToken,
      body: { date: past },
    });
    ok(
      'C13 截单跑批执行成功',
      cut.body?.code === 0,
      `code=${cut.body?.code} msg=${String(cut.body?.message ?? '').slice(0, 60)}`,
    );
    const r6 = readCancel(o6);
    ok(
      'C14 系统取消落库（source=system / reason=timeout_unpaid）',
      r6?.cancel_source === 'system' && r6?.cancel_reason === 'timeout_unpaid',
      `source=${r6?.cancel_source} reason=${r6?.cancel_reason} status=${r6?.status}`,
    );
  }

  // ---- 场景 7：团长代退（source=leader）+ 驳回后必须清空 ----
  // ⭐ 这是三处里唯一「申请」语义的路径：申请时预写标记、驳回时必须配对清除。
  //    只测写入不测清除，等于放行「订单回到 paid 却带着取消标记」的脏数据 ——
  //    取消统计会凭空多出一笔，而且这类脏数据不会报错，只会让报表慢慢失真。
  {
    const ldr = await call('POST', '/auth/login', { body: { code: 'dev:1001' } });
    const lt = ldr.body?.data?.token;
    ok('C15 团长登录取 token', !!lt, `code=${ldr.body?.code}`);
    if (lt) {
      const o7 = await placeOrder(lt, mealDate);
      ok('C16 团长侧建单成功', !!o7, `no=${o7}`);
      const pay = await call('POST', '/pay/mock/paid', { body: { orderNo: o7 } });
      ok('C17 mock 支付成功（代退要求已支付单）', pay.body?.code === 0, `code=${pay.body?.code}`);

      // 代退要求订单归属本团长所辖楼栋，照 e2e-m2 夹具的做法直写 leader 归属
      writeDb('UPDATE ab_order SET team_leader_id = 1 WHERE order_no = ?', [o7]);

      const ap = await call('POST', `/orders/${o7}/refund-apply`, {
        token: lt,
        body: { reasonType: 'quality', reason: 'e2e · 菜品有异味' },
      });
      ok('C18 团长代退申请成功', ap.body?.code === 0, `code=${ap.body?.code}`);
      const r7 = readCancel(o7);
      ok(
        'C19 代退预写落库（source=leader / reason 沿用 RefundReasonType）',
        r7?.cancel_source === 'leader' && r7?.cancel_reason === 'quality',
        `source=${r7?.cancel_source} reason=${r7?.cancel_reason} status=${r7?.status}`,
      );

      // ---- 场景 7b：后台「看得见」—— 代退理由必须显示中文，不是英文枚举名 ----
      // ⭐ 2026-10-04 整体复查（报告 3.2）：`decorate()` 此前**一律**查 `CANCEL_REASON_LABEL`，
      //    而代退落的是 `RefundReasonType`（quality / missing …）⇒ 后台列表 / 详情 / **导出**
      //    三处都显示**英文枚举名**，`REFUND_REASON_LABEL` 已 import 却没被用。
      //    「取消理由用于数据分析」这条需求，导出拿到 `quality` 等于没闭环。
      //    α 批次已改为按 `cancelSource` 分派文案表 —— 这里是它**唯一**的一条回归。
      const det = await call('GET', `/admin/orders/${o7}`, { token: adminToken });
      const d = det.body?.data ?? {};
      const rtxt = d.cancelReasonText ?? d.order?.cancelReasonText ?? null;
      ok(
        'C23 后台详情：代退理由显示中文（非英文枚举名）',
        rtxt === '品质问题',
        `cancelReasonText=${rtxt} · sourceText=${d.cancelSourceText ?? '?'} · raw=${d.cancelReason ?? '?'}`,
      );

      const exp = await call('GET', '/admin/orders/export', { token: adminToken });
      // ⚠️ 探针首版写成了 `data.header`，实际字段名是 `headers`（`list` 同理）⇒ 列位恒 -1。
      //    「探针不命中，先怀疑探针」—— 这里就是：产品是对的，探针才是错的那个。
      const hdr = exp.body?.data?.headers ?? [];
      const rows = exp.body?.data?.list ?? [];
      const iNo = hdr.indexOf('订单号');
      const iReason = hdr.indexOf('取消理由');
      const row7 = rows.find((r) => Array.isArray(r) && r[iNo] === o7);
      ok(
        'C24 导出「取消理由」列为中文（运营拿到就能直接统计）',
        iReason >= 0 && !!row7 && row7[iReason] === '品质问题',
        `列位=${iReason} · 命中该单=${!!row7} · 值=${row7 ? row7[iReason] : '未找到该单'}` +
          ` · [探针自检] code=${exp.body?.code} dataKeys=${Object.keys(exp.body?.data ?? {}).join(',')}` +
          ` header前6=${hdr.slice(0, 6).join('|')} 行数=${rows.length}`,
      );

      // 驳回：三列必须一起清掉
      let rid = null;
      {
        const db = openDb();
        rid = db
          .prepare('SELECT id FROM ab_refund WHERE order_no = ? ORDER BY id DESC LIMIT 1')
          .get(o7)?.id;
        db.close();
      }
      ok('C20 取到退款单 id', rid != null, `id=${rid}`);
      if (rid != null) {
        const rj = await call('POST', `/admin/finance/refunds/${rid}/reject`, {
          token: adminToken,
          idem: `dt-rj-${Date.now()}`,
          body: { reason: '证据不足，驳回' },
        });
        ok('C21 后台驳回成功', rj.body?.code === 0, `code=${rj.body?.code}`);
        const r8 = readCancel(o7);
        ok(
          'C22 驳回后三列清空（订单回到 paid，不留取消痕迹）',
          r8?.cancel_source === null &&
            r8?.cancel_reason === null &&
            r8?.cancel_note === null &&
            r8?.status === 'paid',
          `source=${r8?.cancel_source} reason=${r8?.cancel_reason} note=${r8?.cancel_note} status=${r8?.status}`,
        );
      }
    }
  }

  // ---- 场景 8：D11 后台强制退款（source=admin）----
  // ⭐ 2026-10-07 β-2：`settleRefundDb` 把订单推到 `refunded` 并写 `cancelled_at`，
  //    却**一列 cancel_* 都不写**（它没有「申请」段），而后台口径是
  //    「取消来源空白 = 未取消」⇒ **后台强制退款这一整类在运营取数时凭空消失**。
  //    e2e 的 D11 用例只断言 refundNo / 状态 / 金额，**不查三列** ⇒ 本场景是唯一回归。
  {
    const l8 = await call('POST', '/auth/login', { body: { code: 'dev:1001' } });
    const lt8 = l8.body?.data?.token;
    const o8 = lt8 ? await placeOrder(lt8, mealDate) : null;
    ok('C25 D11 夹具：建单成功', !!o8, `no=${o8}`);
    if (o8 && lt8) {
      const pay8 = await call('POST', '/pay/mock/paid', { body: { orderNo: o8 } });
      ok('C26 D11 夹具：支付成功', pay8.body?.code === 0, `code=${pay8.body?.code}`);
      const fr = await call('POST', `/admin/orders/${o8}/force-refund`, {
        token: adminToken,
        body: { reason: 'e2e · 后台强制退款（客诉兜底）' },
      });
      ok(
        'C27 D11 强制退款受理',
        fr.body?.code === 0,
        `code=${fr.body?.code} msg=${String(fr.body?.message ?? '').slice(0, 60)}`,
      );
      const rc8 = readCancel(o8);
      ok(
        'C28 ⭐ D11 写全取消三列（source=admin）—— 否则运营取数时这一整类凭空消失',
        rc8?.cancel_source === 'admin' && rc8?.cancel_note !== null,
        `source=${rc8?.cancel_source} reason=${rc8?.cancel_reason} note=${rc8?.cancel_note} status=${rc8?.status}`,
      );
      const det8 = await call('GET', `/admin/orders/${o8}`, { token: adminToken });
      const d8 = det8.body?.data ?? {};
      ok(
        'C29 后台详情：取消来源显示中文「后台强制退款」（`CANCEL_SOURCE_LABEL` 新档）',
        (d8.cancelSourceText ?? d8.order?.cancelSourceText) === '后台强制退款',
        `cancelSourceText=${d8.cancelSourceText ?? d8.order?.cancelSourceText ?? '?'} · source=${rc8?.cancel_source}`,
      );
    }
  }

  // ---- 场景 9：取消路径的退款金额必须**含余额抵扣** ----
  // ⭐ 2026-10-07 β-4：`buildRefundRow` 原先记 `wxFen`（仅微信实付），而代退路径 `:192`
  //    早已用 `refundableYuan`（总额 − 优惠）⇒ 同一笔钱两个口径，财务按 `ab_refund`
  //    汇总时**系统性少算余额抵扣部分**。
  //    ⚠️ 差异被 e2e 掩盖至今：取消用例全是纯微信支付（balanceUsed=0），两口径恰好相等。
  //    ⇒ 本场景刻意构造 `balance_used > 0` 的已支付单，这是全仓唯一会撞出差异的样本。
  {
    const l9 = await call('POST', '/auth/login', { body: { code: 'dev:1001' } });
    const lt9 = l9.body?.data?.token;
    const o9 = lt9 ? await placeOrder(lt9, mealDate) : null;
    ok('C30 金额口径夹具：建单成功', !!o9, `no=${o9}`);
    if (o9 && lt9) {
      await call('POST', '/pay/mock/paid', { body: { orderNo: o9 } });
      // 造出「微信实付 20.00 + 余额抵扣 5.80」的组合（总额仍 25.80）
      writeDb('UPDATE ab_order SET balance_used = ?, pay_amount = ? WHERE order_no = ?', [
        '5.80',
        '20.00',
        o9,
      ]);
      const cx = await call('POST', `/orders/${o9}/cancel`, {
        token: lt9,
        body: { reason: 'other', note: 'e2e · 验证退款金额口径' },
      });
      ok(
        'C31 带余额抵扣的已支付单可自助取消',
        cx.body?.code === 0,
        `code=${cx.body?.code} msg=${String(cx.body?.message ?? '').slice(0, 60)}`,
      );
      const db9 = openDb();
      const rf9 = db9
        .prepare('SELECT amount FROM ab_refund WHERE order_no = ? ORDER BY id DESC LIMIT 1')
        .get(o9);
      const ord9 = db9
        .prepare('SELECT total_amount, discount_amount, pay_amount, balance_used FROM ab_order WHERE order_no = ?')
        .get(o9);
      db9.close();
      const expect9 = (
        Math.round((Number(ord9?.total_amount) - Number(ord9?.discount_amount)) * 100) / 100
      ).toFixed(2);
      // ⭐ **夹具自证**：必须先证明这一单**真的**有余额抵扣。
      //   若哪天夹具退化成 `balance_used = 0`，「总额−优惠」与「微信实付」恰好相等，
      //   下面那条断言就会**恒绿** —— 而它存在的唯一理由就是撞出这两个口径的差异。
      //   （e2e 至今没抓到这个缺陷，正是因为它的取消用例全是纯微信支付。）
      ok(
        'C31b [自证] 夹具确实构造了「余额抵扣 > 0」（否则两口径相等、C32 恒绿）',
        Number(ord9?.balance_used) > 0 && Number(ord9?.pay_amount) > 0,
        `抵扣=${ord9?.balance_used} 微信实付=${ord9?.pay_amount}`,
      );
      ok(
        'C32 ⭐ 退款单金额 = 总额 − 优惠（**含**余额抵扣 5.80，不是微信实付 20.00）',
        Number(rf9?.amount).toFixed(2) === expect9 &&
          // 后半句 = **必报样本**：旧写法（记微信实付）在这里必然不相等
          Number(rf9?.amount).toFixed(2) !== Number(ord9?.pay_amount).toFixed(2),
        `ab_refund.amount=${rf9?.amount} · 期望(总额−优惠)=${expect9} · 微信实付=${ord9?.pay_amount} 抵扣=${ord9?.balance_used}`,
      );
    }
  }

  console.log(`\n合计：通过 ${pass} · 失败 ${fail}`);
  if (fail) console.log('失败项：' + fails.join(' | '));

  await stopApiServer(child);
  if (fail) process.exit(1);
}

main().catch(async (e) => {
  console.error('探针自身异常：', e.message);
  process.exit(2);
});

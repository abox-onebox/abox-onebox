/**
 * 本地内部测试 · 环境自检（走**端上真正用的那条路**：H5 端口 → 同源代理 → API）
 *
 * 为什么不在 3000 端口上直连自检：那样只证明「后端活着」，
 * 证明不了「手机打开页面能登录取数」—— 而后者才是内部测试要的东西。
 * 代理、静态产物、Mock 通道、时钟注入，四者任一坏掉，直连自检都是绿的。
 *
 * ⚠️ 两条刻意的设计：
 *   ① **可反复跑**：同一用户同一出餐日只允许一单，故重跑会命中「重复下单保护」
 *      （`30004`）—— 这被当作**通过**，并改为校验既有那单的状态。否则自检变成
 *      一次性消耗品，第二次跑就红，人就不信它了。
 *   ② **不占用标杆账号**：自检从 `dev:1002` 起挑**当日无单**的团长账号，把
 *      `dev:1001`（李明，手册与演示里的标杆账号）留给人工演示。
 */

const ok = (b) => (b ? '✔' : '✖');

async function json(url, init) {
  const res = await fetch(url, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON（网关错误页 / HTML） */
  }
  return { status: res.status, body };
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const post = (url, payload, headers = {}) =>
  json(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

/** 自检候选账号（种子里的 5 位团长）—— 刻意从 `dev:1002` 起，理由见文件头 ② */
export const CANDIDATES = ['dev:1002', 'dev:1003', 'dev:1004', 'dev:1005', 'dev:1001'];

/** 挑一个「能下单且当日还没单」的账号；全都已有单时退回第一个可下单账号 */
async function pickAccount(h5Url) {
  let fallback = null;
  for (const code of CANDIDATES) {
    const login = await post(`${h5Url}/api/v1/auth/login`, { code });
    const token = login.body?.data?.token;
    if (!token) continue;

    const daily = await json(`${h5Url}/api/v1/home/daily`, { headers: auth(token) });
    const d = daily.body?.data;
    // 10004 = NOT_FOUND：该账号所属楼栋/楼群暂无可用团（新用户即如此），换下一个
    if (daily.body?.code !== 0 || d?.canOrder !== true) continue;

    const list = await json(`${h5Url}/api/v1/orders?page=1&pageSize=20`, { headers: auth(token) });
    const busy = (list.body?.data?.list ?? []).some((o) => o.mealDate === d.mealDate);

    const hit = {
      code,
      token,
      daily: d,
      busy,
      nickname: login.body?.data?.user?.nickname ?? '-',
      isLeader: login.body?.data?.isLeader,
    };
    if (!busy) return hit;
    fallback = fallback ?? hit;
  }
  return fallback;
}

/**
 * 跑完自检并逐条打印
 *
 * @returns `true` = 全绿
 */
export async function smoke({ h5Url, adminUrl, apiPort, log = console.log }) {
  const results = [];
  const check = (name, pass, detail = '') => {
    results.push({ name, pass, detail });
    log(`    ${ok(pass)} ${name}${detail ? `  —  ${detail}` : ''}`);
  };

  // ── 一、用户端（手机走的就是这条路） ───────────────────────────────────
  log('  【用户端 · 手机访问路径】');

  const pageRes = await fetch(`${h5Url}/`);
  const html = await pageRes.text();
  check('页面可达且是应用外壳', pageRes.status === 200 && html.includes('<div id="app">'), `${h5Url}/`);

  const h = await json(`${h5Url}/api/v1/health`);
  check('同源代理连通后端', h.body?.code === 0, `code=${h.body?.code}`);

  const acc = await pickAccount(h5Url);
  if (!acc) {
    check(
      '找到可下单的测试账号',
      false,
      '5 个种子团长账号均拿不到「明日团」—— 请先重置种子（--seed）',
    );
  } else {
    const { code, token, daily: d, busy, nickname, isLeader } = acc;
    log(`    · 自检账号：${code}（${nickname} · 团长=${isLeader}）${busy ? ' · 当日已有单' : ''}`);
    check(
      `Mock 登录并取到「明日」套餐（${code}）`,
      d?.priceFen === 2580 && d?.canOrder === true && (d?.dishes?.length ?? 0) >= 4,
      `mealDate=${d?.mealDate} priceFen=${d?.priceFen} 菜数=${d?.dishes?.length}`,
    );

    // 下单（幂等键必填，故必须带上）
    const created = await post(
      `${h5Url}/api/v1/orders`,
      { mealDate: d?.mealDate, quantity: 1, remark: '内部测试自检' },
      { ...auth(token), 'Idempotency-Key': `smoke-${Date.now()}` },
    );
    let targetNo = created.body?.data?.orderNo ?? null;

    if (created.body?.code === 0) {
      check(
        '下单成功（等待支付）',
        created.body?.data?.status === 'pending_pay',
        `orderNo=${targetNo} 应付=${created.body?.data?.payAmountFen}分`,
      );
    } else if (created.body?.code === 30004) {
      // 自检重跑会走到这里，属**预期**，不是故障
      check('重复下单被拦（当日已有单 · 自检重跑的正常路径）', true, created.body?.message ?? '');
    } else {
      check('下单成功（等待支付）', false, `code=${created.body?.code} ${created.body?.message ?? ''}`);
    }

    // 缺幂等键必须被拒（写接口的硬约束，顺手验一条）
    const noKey = await post(
      `${h5Url}/api/v1/orders`,
      { mealDate: d?.mealDate, quantity: 1 },
      auth(token),
    );
    check('下单缺幂等键被拒（10001）', noKey.body?.code === 10001, `code=${noKey.body?.code}`);

    // 定位「当日那一单」（首次跑用刚建的，重跑用既有的）
    const list0 = await json(`${h5Url}/api/v1/orders?page=1&pageSize=20`, { headers: auth(token) });
    const cur = (list0.body?.data?.list ?? []).find((o) => o.mealDate === d?.mealDate);
    targetNo = targetNo ?? cur?.orderNo ?? null;

    // ⭐ 发起支付：Mock 自动回调是**挂在这一步**的（下单本身不会自动支付）
    if (cur?.status === 'pending_pay' && targetNo) {
      const pay = await post(`${h5Url}/api/v1/orders/${targetNo}/pay`, {}, {
        ...auth(token),
        'Idempotency-Key': `smoke-pay-${Date.now()}`,
      });
      check('发起微信支付单（Mock 预支付）', pay.body?.code === 0, `code=${pay.body?.code}`);
      await new Promise((r) => setTimeout(r, 3000)); // 等 Mock 回调（默认延迟 800ms）
    }

    const list1 = await json(`${h5Url}/api/v1/orders?page=1&pageSize=20`, { headers: auth(token) });
    const mine = (list1.body?.data?.list ?? []).find((o) => o.mealDate === d?.mealDate);
    check(
      '支付后订单状态已推进（Mock 自动回调生效）',
      !!mine && mine.status !== 'pending_pay',
      `status=${mine?.status ?? '(未找到当日单)'} orderNo=${mine?.orderNo ?? '-'}`,
    );
  }

  // ── 二、运营后台 ──────────────────────────────────────────────────────
  log('  【运营后台】');

  const adminHtml = await (await fetch(`${adminUrl}/`)).text();
  check('后台页面可达', adminHtml.includes('<div id="app">'), `${adminUrl}/`);

  const ah = await json(`${adminUrl}/api/v1/health`);
  check('后台同源代理连通后端', ah.body?.code === 0, `code=${ah.body?.code}`);

  const al = await post(`${adminUrl}/api/v1/auth/admin-login`, {
    username: 'admin',
    password: 'admin123',
  });
  const aToken = al.body?.data?.token;
  check(
    '后台账号登录（admin）',
    al.body?.code === 0 && !!aToken,
    `角色=${al.body?.data?.account?.role ?? '-'}`,
  );

  const sched = await json(`${adminUrl}/api/v1/admin/schedule`, { headers: auth(aToken) });
  check(
    '后台读取业务时刻表（8 个定时任务）',
    sched.body?.code === 0 && (sched.body?.data?.list?.length ?? 0) >= 8,
    `任务数=${sched.body?.data?.list?.length}`,
  );

  // ── 三、结论 ─────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.pass);
  log('');
  if (failed.length) {
    log(`  ✖ 自检未通过：${results.length - failed.length}/${results.length} —— 失败项：`);
    for (const f of failed) log(`      · ${f.name}${f.detail ? `（${f.detail}）` : ''}`);
    log(`    → 排查顺序：后端是否在 ${apiPort} 端口运行 → 是否跑过 seed → 端口是否被占用`);
  } else {
    log(`  ✔ 环境自检全绿（${results.length}/${results.length}）—— 可以去手机上试了。`);
  }
  return failed.length === 0;
}

#!/usr/bin/env node
/**
 * N1 / N2 / W1 · 楼宇停用与一键停售 —— 运行时回归骨架（B0 基线 + B4 并发/跨日 + B2-12）
 *
 * ══ 这是什么 ════════════════════════════════════════════════════════════════
 * 本文件是**骨架**，不是可跑的套件。
 * 它与 `scripts/check-n1n2-w1-suspend-rules.mjs`（静态门禁）**严格分工**：
 *
 *   静态脚本  = 「代码里写没写」    —— 毫秒级，每次改码都能跑
 *   本文件    = 「跑起来是不是真的」—— 分钟级，必须连库、真起服务
 *
 * ⚠️ **§C.2 那 10 条「静态管不到」的一条都不许混进静态脚本**，反过来也成立：
 *    本文件的每一条都**必须**连库跑 —— 能通过静态判据替代的，就不该出现在这里。
 *
 * ══ 为什么现在是骨架而不是套件 ══════════════════════════════════════════════
 * 本批是**边写边查**：P3-1 ~ P3-8 分批落地，很多被测能力（错误码 / `ab_sales_pause` 表 /
 * 编排层接线）此刻尚未存在。若现在就写成能跑的套件，只有两种结果：
 *   ① 全红 ⇒ 噪音，且会淹没真正的回归信号；
 *   ② 为了让它们变绿而弱化断言 ⇒ **假绿，比不测更坏**。
 * ⇒ 骨架的每条场景都**显式标注依赖哪一批**（`batch`），未落地时记 **PENDING**，
 *    且 PENDING **必须**让退出码非 0（见下）。
 *
 * ══ ⚠️ PENDING 不是通过（反恒绿纪律）════════════════════════════════════════
 * 一个「跑不出来就当过」的骨架 = 买个永远亮绿灯的红绿灯。故：
 *
 *   退出码 0 = 全部通过 **且** 无 PENDING ⇒ 这才是「这个套件真的通过」
 *   退出码 1 = 有 FAIL
 *   退出码 3 = 有 PENDING（能力未落地）⇒ **不得被任何门禁当成通过**
 *
 * 汇总行在存在 PENDING 时**绝不**打印「全绿」。
 * ⇒ 接进 `gate.mjs` 时，期望正则必须同时匹配 `通过 N/M` 与 `待落地 K`，
 *    且 gate 侧只能接受退出码 0 —— 否则「尚未实现」会被静默计成通过。
 *
 * ══ ★ 一个必须写在这里的回源修正：时钟注入**跨不了零点** ════════════════════
 * AC v2.1 把 B2-12 / B4-3 / B4-6 写成「注入时钟跨 T-1 24:00」。**这是做不到的**，
 * 是我（QA）当初没回源就写下的静默漂移。回源 `common/utils/time.ts:60-84`：
 *
 *     SHIFT_MS = ABOX_SHIFT_TO_HOUR * 3_600_000 - withinDayMs
 *     now()    = new Date(Date.now() + SHIFT_MS)
 *
 *   ⇒ 注入后 `now()` **恒等于「本北京日 HH:00:00.000」**，两个后果：
 *     ① **日历日不变**（源码注释明写：真实 03:00 → 注入 20:00 **同日**）；
 *     ② **只能落整点**（`ABOX_SHIFT_TO_HOUR` 经 `Number.isInteger` 校验，0–23 整数）。
 *
 *   ⇒ 能测：下单窗口内（14:00–23:00 整点）、开团前（00:00–13:00 整点）
 *   ⇒ **不能测**：跨零点、以及 23:50–24:00 这段「刚过截单」的窄带
 *     （窗口上界是 `截单 − cutoff_window_minutes` 算出来的，不是固定时刻）
 *
 * ⇒ **所有跨零点 / 跨截单断言，一律走 `POST /admin/schedule/:task/run` 补跑接口**
 *   （它收显式 `date`，与时钟无关，且与跑批共用同一执行口 —— 见
 *   `tasks/schedule-admin.service.ts` 的 `run()` 注释）。
 *   这也是唯一正确的机制：B2-12 的 A/B 翻转，本质是**跑批把订单从 `paid` 推进到
 *   `cut_off`** 从而换组，跟墙钟走没走一点关系都没有。
 *
 * 用法：
 *   node scripts/e2e-n1n2w1-suspend.mjs              # 跑全部（未落地的记 PENDING）
 *   node scripts/e2e-n1n2w1-suspend.mjs --list       # 只看场景清单与依赖批次
 *   node scripts/e2e-n1n2w1-suspend.mjs --only P3-4  # 只跑某一批依赖的场景
 *   ⚠️ 前置：先跑 `node scripts/gate.mjs seed`
 *   端口：默认 3106（E2E_PORT 可覆盖）—— 与 m1/m2/m3/coupon-blindbox/referral 分开
 */
import { existsSync } from 'node:fs';

import { BASE, DB_PATH, PORT, assertPortFree, installCleanupHooks, makeCall, openFixtureDb, startApiServer, stopApiServer, waitHealthy } from './lib/e2e-server.mjs';

// ── 结果收集 ────────────────────────────────────────────────────────────────
const results = [];
const log = (s) => process.stdout.write(`${s}\n`);

function ok(name, detail = '') {
  results.push({ name, state: 'PASS' });
  log(`✔ ${name}${detail ? `  › ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ name, state: 'FAIL' });
  log(`✘ ${name}${detail ? `  › ${detail}` : ''}`);
}
/** 依赖批次尚未落地 ⇒ 既不记 PASS 也不记 FAIL（记了就是制造假信号） */
function pending(name, batch, detail = '') {
  results.push({ name, state: 'PENDING' });
  log(`－ ${name}  [依赖 ${batch} 未落地]${detail ? `  › ${detail}` : ''}`);
}
function assert(cond, name, detail = '') {
  if (cond) ok(name, detail);
  else fail(name, detail);
  return cond;
}

// ── 夹具工具（骨架阶段给出**签名与意图**，实现随批次落地补齐）────────────────
// ⚠️ 与 `e2e-referral.mjs` 同款纪律：夹具**直接改 sqlite**（`openFixtureDb()`），
//    不借道业务接口造数据 —— 借道会让「造数据」本身被测代码污染。

/** 把一栋楼置为指定 status（1 ACTIVE / 2 PREPARING / 3 SUSPENDED） */
function setBuildingStatus(buildingId, status) {
  const db = openFixtureDb();
  try {
    db.prepare('UPDATE ab_building SET status = ? WHERE id = ?').run(status, buildingId);
  } finally {
    db.close();
  }
}

/** 直接 UPDATE 造订单状态（跨状态机推进时只能用这招 —— 业务接口不给你停在中间态） */
function setOrderStatus(orderId, status) {
  const db = openFixtureDb();
  try {
    db.prepare('UPDATE ab_order SET status = ? WHERE id = ?').run(status, orderId);
  } finally {
    db.close();
  }
}

const countOrders = (sql, params = []) => {
  const db = openFixtureDb();
  try {
    return Number(db.prepare(sql).get(...params)?.n ?? 0);
  } finally {
    db.close();
  }
};

/** 补跑定时任务 —— ★ 跨零点 / 跨截单断言的**唯一**正确机制（见文件头说明） */
const runTask = (call, task, date, token) =>
  call('POST', `/admin/schedule/${task}/run`, { body: { date }, token });

// ════════════════════════════════════════════════════════════════════════════
// 场景清单
//
//   id       对应 AC 文档 §B 的编号
//   batch    依赖哪个落地批次（P3-x）；未落地 ⇒ 记 PENDING
//   must     true = 必过（挂了就是 P0，不得带病上线）
//
// ⚠️ B4 的断言一律写**不变量**，不写「期望某个具体时序」—— 后者会变成 flaky 的
//    sleep 竞赛：并发下谁先到是不确定的，断言「A 一定发生在 B 之前」必然偶发红。
//    不变量的写法是「无论时序如何，最终状态必须满足 X，且不得出现第三态」。
// ════════════════════════════════════════════════════════════════════════════
// ⚠️ 用 `let`：`--only <batch>` 会就地过滤这个数组
let SCENARIOS = [
  // ── B0 · 回归基线（改动前后都必须成立）───────────────────────────────────
  {
    id: 'B0-1',
    batch: 'P3-4',
    must: true,
    title: '对 status=2/3 的楼 bindBuilding 仍抛 BUILDING_NOT_FOUND（不得被本批改松）',
    async run(call, ctx) {
      // 断言：POST /user/building { buildingId: <status=3 的楼> } → code = BUILDING_NOT_FOUND
      // ⚠️ 这条是**回归基线**：本批改的是「能不能下单」，不是「能不能绑楼」。
      //    两者共用同一个 status 字段，极易被一次改动一起放宽。
      pending(`${this.id} ${this.title}`, this.batch);
    },
  },
  {
    id: 'B0-2',
    batch: 'P3-4',
    must: true,
    title: '选楼列表只含 ACTIVE（1 ACTIVE + 1 SUSPENDED ⇒ length === 1）',
    async run(call, ctx) {
      // 断言：GET /building 列表长度 === 1 且只含 ACTIVE 那栋
      pending(`${this.id} ${this.title}`, this.batch);
    },
  },
  {
    id: 'B0-3',
    batch: 'P3-3',
    must: true,
    title: '正常下单（楼/群 ACTIVE、未过截单、无停售）⇒ U1 canOrder=true 且三端恒等',
    async run(call, ctx) {
      // 断言：U1 canOrder=true · U6 成功 · 工作台 canOrder=true —— 三者布尔**恒等**
      // ⚠️ 「三端恒等」是本批 N1 的核心诉求，必须每次都断言，不能只在 B1-7 断言一次
      pending(`${this.id} ${this.title}`, this.batch);
    },
  },
  {
    id: 'B0-4',
    batch: 'P3-3',
    must: true,
    title: '已过截单 ⇒ U1 canOrder=false + reason=cutoff；U6 30001',
    async run(call, ctx) {
      pending(`${this.id} ${this.title}`, this.batch);
    },
  },
  {
    id: 'B0-5',
    batch: 'P3-2',
    must: true,
    title: '楼群非空停用仍返回 60003，不得被 60007 吞掉',
    async run(call, ctx) {
      // ⚠️ 60003（群非空）与 60007（群下有未完结单）是两个**不同**的拒绝理由，
      //    合并会让运营看不出该「先搬楼」还是「先处理订单」
      pending(`${this.id} ${this.title}`, this.batch);
    },
  },
  {
    id: 'B0-6',
    batch: 'P3-2',
    must: true,
    title: '楼群「搬空 + 停用」同一次请求仍必须放行（:962 的顺序要求）',
    async run(call, ctx) {
      // ⚠️ 这是最容易在「加校验」时被误伤的一条：先搬空再停用，若校验顺序反了，
      //    「搬空」之后群下已无楼，新校验却按「停用前」的快照算 ⇒ 误拦
      pending(`${this.id} ${this.title}`, this.batch);
    },
  },
  {
    id: 'B0-7',
    batch: 'P3-7',
    must: true,
    title: 'delivered 单跑 T 日 14:00 job 仍走到 completed + 佣金入账（停用不得阻止）',
    async run(call, ctx) {
      // 走 runTask(call, 'auto-confirm', <mealDate>) —— 不依赖时钟
      pending(`${this.id} ${this.title}`, this.batch);
    },
  },
  {
    id: 'B0-8',
    batch: 'P3-7',
    must: true,
    title: 'pending_pay 单跑超时取消仍正常（N1-AC-06 依赖它收口存量单）',
    async run(call, ctx) {
      // ⚠️ 状态机不得被冻结：停用/停售只拦**新单**，不得让定时任务跳过存量单
      pending(`${this.id} ${this.title}`, this.batch);
    },
  },

  // ── ★ B2-12 · 跨零点 A/B 翻转 —— 团队裁定：单独一条，标为必过 ─────────────
  {
    id: 'B2-12',
    batch: 'P3-5',
    must: true,
    title: '★ 跨零点 A/B 翻转：同一份夹具，截单前 ⇒ 60006（可 force）／截单后 ⇒ 60012（force 也拒）',
    // ⚠️ 为什么必须单独一条：
    //    `cut_off` 是**时间派生**的状态 ⇒ 同一笔订单会在截单那一刻从 B 组翻进 A 组。
    //    A 组是硬约束（60012，force 与审批都无效），B 组可以 force 放行 —— 也就是说
    //    **force 这个逃生舱会在 00:00 无声消失**。运营在 23:50 试过能强停、00:10 再试
    //    被拒，且两次的错误码长得完全不像同一个原因。这个面没有任何静态判据能守，
    //    只有把「翻转」本身写成一条用例才守得住。
    //
    // ⚠️ 机制（见文件头回源修正）：**不用时钟注入**，用补跑接口推进订单状态：
    //      ① 夹具：1 栋 ACTIVE 楼 + 1 笔 mealDate=<T> 的 `paid` 单
    //      ② 截单前：`PUT /admin/buildings/{id} {status:3, forceSuspend:true, suspendReason}`
    //         ⇒ 断言 **60006**（B 组），且 payload 含 unfinishedCount=1
    //      ③ runTask(call, 'cutoff', <T>) ⇒ 该单 `paid` → `cut_off`（换组）
    //      ④ 再调同一次停用 ⇒ 断言 **60012**（A 组），force 无效、approval 无效
    //      ⑤ 断言 `ab_building.status` 全程未变（两次都被拦）
    //
    // ⚠️ 断言必须**两组判据分开走**，不得合并成一个 case —— 合并后即便 A/B 分组退化成
    //    单一分组，用例仍然绿（这就等于没测）。
    async run(call, ctx) {
      pending(`${this.id} ${this.title}`, this.batch);
    },
  },

  // ── B4 · 并发与跨日（全部必须用**不变量**断言）───────────────────────────
  {
    id: 'B4-1',
    batch: 'P3-5',
    must: true,
    title: '支付中 + 运营点停用（≥50 轮）：不变量 = 不存在「订单已 paid 但楼已停用且用户无通知」第三态',
    // ⚠️ 断言写法（**不**断言时序）：
    //    每轮并发发出「支付回调」与「停用」两个请求，结束后断言**析取式**：
    //      (停用被 N2 拦下 ⇒ 楼仍 ACTIVE ⇒ 用户仍可下单)
    //    ∨ (订单先 paid ⇒ 按 N1-AC-06 履约 ⇒ ab_message 有对应通知)
    //    **二者之一必须成立**；出现「订单 paid 成功 + 楼已 SUSPENDED + 没有通知」即 FAIL。
    //    ⇒ 这才是并发测试该有的形状：断言的是**不可能出现的状态**，不是**应该出现的顺序**。
    async run(call, ctx) {
      pending(`${this.id} ${this.title}`, this.batch);
    },
  },
  {
    id: 'B4-2',
    batch: 'P3-5',
    must: true,
    title: '停用后支付回调到达：回调必须正常推进到 paid 并计入未完结，不得丢弃/退款项',
    async run(call, ctx) {
      // ⚠️ 这是「支付回调竞态」面：静态脚本里根本没有可被扫的「回调入口」，只能跑
      pending(`${this.id} ${this.title}`, this.batch);
    },
  },
  {
    id: 'B4-3',
    batch: 'P3-5',
    must: true,
    title: '跨零点下单：T 日 00:01 的下单目标已是 T+1 ⇒ 仍必须被 60010 拦；同时 T 日那批单照常 cut_off',
    // ⚠️ 机制：**补跑接口**（runTask(call,'cutoff',<T>)），不是时钟注入（见文件头）
    // ⚠️ 两个断言必须**同时**成立：拦新单 与 不冻结存量单 缺一不可。
    //    只断言前者 ⇒ 「为了拦新单把跑批也停了」这种实现会全绿。
    async run(call, ctx) {
      pending(`${this.id} ${this.title}`, this.batch);
    },
  },
  {
    id: 'B4-4',
    batch: 'P3-7',
    must: true,
    title: '停用后「已支付未截单」订单跑完截单 job：仍走到 cut_off→cooked→delivered；sold_count 不受反向影响',
    async run(call, ctx) {
      // 依次 runTask: cutoff → delivery-generate → auto-confirm（均带显式 date）
      // ⚠️ `sold_count` 是**另一个模块**的写入副作用（M4-1 才修的「截单定格」），
      //    静态扫不到，只能跑完查 `ab_meal_assignment.sold_count` 是否仍等于截单时快照
      pending(`${this.id} ${this.title}`, this.batch);
    },
  },
  {
    id: 'B4-5',
    batch: 'P3-2',
    must: false,
    title: '先停成员楼（force）再停群：第二次仍必须被 N2 拦；60003 与 60007 并存且给出不同错误码',
    async run(call, ctx) {
      pending(`${this.id} ${this.title}`, this.batch);
    },
  },
  {
    id: 'B4-6',
    batch: 'P3-6',
    must: true,
    title: '跨零点停售：T-1 23:59 开停售、T 日 00:01 关停售 ⇒ 00:01 后 60009 消失，夜间被截的单不漏处理',
    // ⚠️ 机制：补跑接口 + 显式 date，**不**用时钟注入（见文件头）
    async run(call, ctx) {
      pending(`${this.id} ${this.title}`, this.batch);
    },
  },
  {
    id: 'B4-7',
    batch: 'P3-2',
    must: false,
    title: '停用 → 立刻恢复 → 再下单：下单成功，且期间历史订单状态未被回滚/重放',
    async run(call, ctx) {
      pending(`${this.id} ${this.title}`, this.batch);
    },
  },

  // ── 改名一致性（Team Lead 指定的补充运行时断言）───────────────────────────
  {
    id: 'X-1',
    batch: 'P3-8',
    must: true,
    title: '★ 列表页 canAssignCount === 概览页 canAssignCount（两个独立计算的同源校验）',
    // ⚠️ 缘起：`building-admin.service.ts:438` 的 `canAssignCount` 曾被查出是**第三份判据**
    //    （自己内联 `status===ACTIVE && buildingGroupId`，不消费列表页那个字段）。
    //    改名时若只改字段名而漏掉它，「楼宇概览」就会留一份没人管的旧判据 ——
    //    与列表页是两个独立数字，将来对不上也没人查得出。
    //
    // ⇒ 静态判据 N1-16 能判「内联合取还在不在」，**判不了「两个数字相不相等」**：
    //    两处都调 `canAssignOf()` 但传参不同（比如一处漏传 `buildingGroupStatus`），
    //    静态看不出错，只有跑一遍比对才看得见。这是必须放运行时的典型。
    //
    // 断言：GET /admin/buildings 的 summary.canAssignCount
    //    === GET /admin/buildings/overview 的 buildings.canAssignCount
    // 且两者都 === 直接查库「status=1 且 building_group_id 非空且所属群未停用」的行数
    //   ⚠️ 第三个断言是**独立算一遍** —— 只比两个接口，两边一起错就看不出来
    async run(call, ctx) {
      const list = await call('GET', '/admin/buildings?pageSize=1', { token: ctx.adminToken });
      const overview = await call('GET', '/admin/buildings/overview', { token: ctx.adminToken });
      const a = list.body?.data?.summary?.canAssignCount;
      const b = overview.body?.data?.buildings?.canAssignCount;
      if (a === undefined || b === undefined) {
        pending(`${this.id} ${this.title}`, this.batch, '两个端点之一尚未下发 canAssignCount');
        return;
      }
      const n = countOrders(
        `SELECT COUNT(*) AS n FROM ab_building b
           LEFT JOIN ab_building_group g ON g.id = b.building_group_id AND g.deleted_at IS NULL
          WHERE b.deleted_at IS NULL
            AND b.status = 1
            AND b.building_group_id IS NOT NULL
            AND (g.status IS NULL OR g.status = 1)`,
      );
      assert(a === b, `${this.id} 列表页 canAssignCount === 概览页 canAssignCount`, `${a} vs ${b}`);
      assert(a === n, `${this.id} canAssignCount === 独立查询行数`, `${a} vs ${n}`);
    },
  },
];

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function run() {
  if (!existsSync(DB_PATH)) {
    log(`\n✘ 前置失败：未找到 sqlite 夹具（${DB_PATH}）\n  请先跑：node scripts/gate.mjs seed\n`);
    return 1;
  }

  log(`\n=== N1/N2/W1 运行时回归骨架 ===`);
  log(`数据库：${DB_PATH}\n`);

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
  // ⚠️ 骨架阶段 ctx 只给出**形状**：真实 token 由 P3-1 之后的登录夹具提供
  const ctx = { adminToken: process.env.E2E_ADMIN_TOKEN ?? '', call };

  let code = 0;
  try {
    for (const s of SCENARIOS) {
      await s.run(call, ctx);
    }
  } catch (e) {
    fail('套件异常', e?.message ?? String(e));
    console.error(e);
    code = 1;
  } finally {
    await stopApiServer(server, PORT);
  }

  const pass = results.filter((r) => r.state === 'PASS').length;
  const failed = results.filter((r) => r.state === 'FAIL');
  const pend = results.filter((r) => r.state === 'PENDING').length;
  const total = results.length;

  log('\n──────── 汇总 ────────');
  log(`通过 ${pass}/${total} · 待落地 ${pend}`);
  if (failed.length) {
    log(`\n失败 ${failed.length} 条：`);
    for (const f of failed) log(`  ✘ ${f.name}`);
    code = 1;
  }
  if (pend) {
    // ⚠️ 待落地**必须**让退出码非 0 —— 否则「还没实现」会被当成通过
    log(`\n⚠️ 待落地 ${pend} 条 —— 依赖批次收口后必须全部转为 PASS/FAIL。`);
    log('   ⚠️ 本退出码为 3，**不得**被任何门禁当作通过信号。');
    if (!code) code = 3;
  }
  if (!failed.length && !pend) log('全绿 ✅');
  return code;
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--list')) {
    log('\n场景清单（id · 依赖批次 · 必过 · 标题）');
    for (const s of SCENARIOS) {
      log(`  ${s.id.padEnd(7)} [${s.batch}] ${s.must ? '★必过' : '     '} ${s.title}`);
    }
    log(`\n合计 ${SCENARIOS.length} 条 · 必过 ${SCENARIOS.filter((s) => s.must).length} 条`);
    return 0;
  }

  const onlyIdx = argv.indexOf('--only');
  if (onlyIdx >= 0 && argv[onlyIdx + 1]) {
    const want = argv[onlyIdx + 1];
    SCENARIOS = SCENARIOS.filter((s) => s.batch === want);
    if (!SCENARIOS.length) {
      log(`\n✘ 没有依赖批次为 ${want} 的场景（用 --list 查看）`);
      return 1;
    }
    log(`\n只跑依赖批次 ${want} 的 ${SCENARIOS.length} 条场景`);
  }

  let code = 1;
  try {
    code = await run();
  } catch (e) {
    fail('套件异常', e?.message ?? String(e));
    console.error(e);
    code = 1;
  }
  process.exit(code);
}

main();

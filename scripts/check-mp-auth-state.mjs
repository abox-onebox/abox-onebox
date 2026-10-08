#!/usr/bin/env node
/**
 * 小程序「登录态裁决权」门禁 —— P1-16 的回归保护
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * `api/request.ts` 对 `10002 / 401 / 20014` 是按**单次请求**裁决 session 的：
 * 只要有一次响应是这些码，就无条件 `clearAuthStorage()`。
 * 而 P6 订单列表是「主请求（走 useRequest，能重登重试）+ 4 个旁路计数（裸调）」**并发**，
 * token 恰好过期时 —— 主请求正在重登重试，4 个旁路拿着**同一个旧 token** 回来也是 10002
 * ⇒ 把重登刚写进去的**新 token 又删掉**，用户被自己看不见的副请求踢下线（P1-16）。
 *
 * 修法是在请求层加显式开关 `keepAuthState`，让旁路请求**只失败、不出手裁决 session**。
 * 但这类修复有一个天然的脆弱面：**它没有任何运行时症状可被观察**（计数失败本来就是静默的），
 * 开关被删掉、或者旁路改回裸调，全仓 typecheck / lint / e2e 都会全绿。
 * 本门禁就是把「谁有权裁决登录态」从**注释里的约定**变成**可跑的断言**。
 *
 * ── 三条不变量（对**当前源码**断言，不用冻结副本）──────────────────────────
 *   ① **主路径必须仍然会清态**（防过度修复）
 *      一次「真拒」——请求携带的就是当时最新 token，被服务端判 10002 ⇒ 恰好清态 1 次。
 *      少清一次 = 有人把 session 裁决权收得太死，用户会卡在半登录状态。
 *   ② **旁路不得踩踏新 token**（P1-16 本体）
 *      4 个计数请求携带旧 token、且在新 token 写入**之后**才回来 ⇒ 清态 **0** 次。
 *   ③ **正常路径行为不变**（防功能回归）
 *      5 次请求 / 0 次登录 / token 不动 / 不弹错 / 四档各自拿到自己那一档的 total。
 *
 * ── 两个必须避开的判据坑（都实测踩过）──────────────────────────────────────
 *   · **不比对「最终 token 是否为空」**：主路径那次清态本来就是合法的，
 *     「改前也是空、改后也是空」会让这条判据变成一个恒绿的空壳。
 *     真正的判据是区分**陈旧裁决**与**合法清态**：
 *       陈旧 = 请求携带的 token ≠ 该响应到达时本进程**已写过的最新 token**。
 *   · **不与上一个失败Timing比值/不比「响应到达时的存储现值」**：第一个旁路清完之后现值是空，
 *     后三个会被误读成「合法」。必须比「写到过的最新 token」，才能把 4 次伤害一视同仁数出来。
 *   · **样本为 0 必须算未达标**：危险条件根本没构造出来（时序写错 / 页面改了 orchestration）
 *     时①②③ 都会是「0 违规」，与「全部达标」同形。 ---- 见下方 `noSample` 处置
 *     （与 `check-icon-lock.mjs` 的「样本为 0」同一口径）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   node scripts/check-mp-auth-state.mjs              # 跑全部场景 —— 门禁唯一走法
 *
 * 场景族（**四套，互不替代**）：
 *   · `leak` / `ok` / `truereject` —— `order-list` 单页，判据 ①②③④
 *                                     换发来源：**本页** `run()` 并发重登
 *   · `salvo:<id>`                 —— `PAGES` 里登记的每一页，判据 ②① +「逐腿 0 样本」守卫
 *                                     换发来源：**在飞期间 token 到期**（别处重登写入的
 *                                     新 token 是**结果**不是原因 —— 见 `PAGES` 上方）
 *                                     每页另配 F（全删）/ G（只删一处）两针
 *
 * ⛔ 刻意**不提供**「只跑单个场景」的开关：单场景会拿到「不完整却全绿」的结论且无人拦截。
 *
 * 退出码：0 = 全部通过；1 = 有不达标项（含样本为 0）；2 = 依赖缺失 / 打包失败
 */
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, '..');
const SRC = join(REPO, 'apps/miniprogram/src');
/**
 * `order-list`：判据 ①②③④ 的**既有**场景族（leak / ok / truereject）。
 *
 * ⛔ 与下面的 `PAGES` **刻意不合并**：两者的换发**来源**不同 ——
 *    leak 是「**本页** `run()` 并发重登」换发，salvo 是「**在飞期间 token 到期**」换发
 *    （新 token 由**别处**那条路径重登写入，是同一失效事件的结果，不是原因）。
 *    合并会把两条判据揉成一条，将来改一处忘一处就制造出第二个真相。
 */
const PAGE = join(SRC, 'pages/order-list/order-list.vue');

/**
 * 多页登记：**齐射**（`salvo`）场景族的被测页数组。
 *
 * ── 场景的真实触发器（2026-10-05 订正 · 原叙事写错了）───────────────────────
 * 旧叙事：「跨页换发 —— 别的页面重登 ⇒ 旧 token 变 401」。这条**在后端不成立**，已证伪：
 *   · `apps/api-server/src/modules/auth/auth.module.ts:35`
 *       `signOptions: { expiresIn: cfg.get('app.jwtExpiresIn') ?? '7d' }` —— 无状态签发
 *   · `apps/api-server/src/modules/auth/auth.service.ts:106-112`
 *       `jwt.signAsync({ sub, typ, openid, isLeader, teamLeaderId })` —— payload 里
 *       **没有** `jti` / `tokenVersion`；全仓也搜不到这两个字段或任何 token 黑名单
 *       ⇒ 别处重登**不会**让还在飞的那枚旧 JWT 变 401
 *   · `apps/api-server/src/modules/auth/auth.service.ts:93`
 *       `20014`（已注销）只在**登录时**抛；`common/guards/jwt-auth.guard.ts`（92 行）
 *       只在 passport 验签后看 `typ` / `rt` / 路径作用域，**全程不查用户状态**
 *       ⇒ 在飞请求也不会因为「别处在别处注销 / 重登」被拒
 * ⇒ **唯一真触发器 = token 到期（齐射）**：一批并发请求同时携带那枚刚到期的 token，
 *   主路径重登先回并写入新 token，旁路随后带着旧 token 回来吃 `10002`（未登录或登录已过期）。
 *   harness 里那枚由「别处」写进来的 `T3` 是**同一失效事件的结果**，不是原因。
 *
 * ⛔ 因此本族**不**叫「跨页」：触发器与「谁在哪一页重登」无关，只与「token 到期」有关。
 *    （**机制一字未改** —— 事件放闸 / 逐条放行 / 逐腿 0 样本守卫都原样保留，只订正叙事。）
 *
 * ⚠️ 为什么必须另开一套机制（不是 leak 的扩展）：leak 只能证明「本页 `run()` 重登
 *    **这一条**换发路径」不踩踏；`keepAuthState` 真正要防的是**任何来源**的换发。
 *    mine.vue 的 5 个位点当初就是**零覆盖**：把 5 个 `keepAuthState` 全删，
 *    leak/ok/truereject 三个场景照样全绿（实测）。
 *
 * 每页配置四件事：
 *   · `mainUrl`  —— 走 `run()` 的主路径 URL（重登源；**不进**旁路集合）
 *   · `bypass`   —— 旁路腿 `[URL 子串, 标签]`，**条数即期望腿数**
 *   · `dropAll`  —— 变异针 1：**全删**该页所有位点的开关（≡ 把修复整体退回去）
 *   · `dropOne`  —— 变异针 2：**只删一处**
 *      两针都必须被判据 ② 报出。`dropOne` 尤其关键：它证明**每一条腿都真的被判别**，
 *      而不是「总体 0 违规」这种假绿 —— 单腿不被判别时，门禁长得跟它不存在一模一样。
 *
 * ⚠️ 新增一页只需往这个数组里加一项，不需要改判据本体。
 *    当前登记 5 页：`mine`(5 腿) / `pickup`(1) / `building`(3) / `workbench`(3) /
 *    `commission`(2)。⚠️ `profile` **刻意不登记**（口径不符，见数组末尾那段注释）。
 */
const MINE_PAGE = join(SRC, 'pages/mine/mine.vue');
const S_ALL_MINE = '__MUT_ALL_MINE';
const S_ONE_MINE = '__MUT_ONE_MINE';
const S_ALL_PICKUP = '__MUT_ALL_PICKUP';
const S_ONE_PICKUP = '__MUT_ONE_PICKUP';
const S_ALL_BUILDING = '__MUT_ALL_BUILDING';
const S_ONE_BUILDING = '__MUT_ONE_BUILDING';
const S_ALL_WORKBENCH = '__MUT_ALL_WORKBENCH';
const S_ONE_WORKBENCH = '__MUT_ONE_WORKBENCH';
const S_ALL_COMMISSION = '__MUT_ALL_COMMISSION';
const S_ONE_COMMISSION = '__MUT_ONE_COMMISSION';

const PAGES = [
  {
    id: 'mine',
    file: MINE_PAGE,
    mainUrl: '/auth/me',
    /**
     * 主路径 200 响应体：必须给 `isLeader: true` + `leader`，否则
     * `loadMonthCommission` / `loadPendingDeliver` 会被 `leaderStore.isLeader` 闸门挡掉
     * ⇒ 两条腿根本不发 ⇒ 「已判别腿 3/5」⇒ 0 样本守卫直接判红（设计如此，不是噪声）。
     */
    /** ⚠️ 必须是**完整响应体**（带 `code: 0` + `data`）—— 只给 `data` 里的字段，
     *    请求层会当成「code 不是 0」直接抛错 ⇒ `loadProfile` 早退 ⇒ 团长腿不发。 */
    mainBody: {
      code: 0,
      data: {
        id: 1,
        nickname: 'gate',
        avatarUrl: null,
        phone: null,
        buildingId: 1,
        buildingName: '国贸三期 A 座',
        leaderName: '李明',
        teamLeaderId: 9,
        isLeader: true,
        leader: {
          id: 9,
          level: 'gold',
          commissionRate: '0.1000',
          balance: '0.00',
          balanceFen: 0,
          frozenFen: 0,
        },
      },
    },
    bypass: [
      ['/me/balance', 'BALANCE'],
      ['/orders', 'ORDERS'],
      ['/leader/commissions', 'COMMISSION'],
      ['/leader/workbench', 'PENDING'],
      ['/me/support', 'SUPPORT'],
    ],
    /**
     * 变异针 1：全删 5 处开关。形态取「**整段不传**」（`{}`）而非「开关置 false」——
     * 后者在源码里还留着 `keepAuthState` 这个字，而真实的回归形态是
     * 「把这 5 个并发裸调复制到别处时**忘带**开关」⇒ 源码里根本没这个字（同必报 D 的口径）。
     */
    dropAll: [
      {
        from: 'fetchMyBalance({ keepAuthState: true })',
        to: `((globalThis.${S_ALL_MINE} = true), fetchMyBalance({}))`,
        expect: 1,
      },
      {
        from: 'fetchOrders({ page: 1, pageSize: 1 }, { keepAuthState: true })',
        to: `((globalThis.${S_ALL_MINE} = true), fetchOrders({ page: 1, pageSize: 1 }, {}))`,
        expect: 1,
      },
      // ⚠️ 这一针的 `from` 带 6 个前导空格 + 尾逗号：mine.vue 的**注释**里也有
      //    `{ keepAuthState: true }`（:332 / :554），不带缩进就会把变异打进注释
      //    ⇒ 变异体永不执行 ⇒ 「必报通过」是假的。`expect: 1` 兜住这个失效形态。
      {
        from: '      { keepAuthState: true },',
        to: `      ((globalThis.${S_ALL_MINE} = true), {}),`,
        expect: 1,
      },
      {
        from: 'fetchWorkbench({ keepAuthState: true })',
        to: `((globalThis.${S_ALL_MINE} = true), fetchWorkbench({}))`,
        expect: 1,
      },
      {
        from: 'fetchSupportContact({ keepAuthState: true })',
        to: `((globalThis.${S_ALL_MINE} = true), fetchSupportContact({}))`,
        expect: 1,
      },
    ],
    /** 变异针 2：只删 `:444 fetchSupportContact` 一处 —— 逐腿判别能力的证明 */
    dropOne: {
      label: 'mine.vue:444 fetchSupportContact',
      needle: {
        from: 'fetchSupportContact({ keepAuthState: true })',
        to: `((globalThis.${S_ONE_MINE} = true), fetchSupportContact({}))`,
        expect: 1,
      },
    },
    sentinelAll: S_ALL_MINE,
    sentinelOne: S_ONE_MINE,
  },

  // ── pickup：1 条腿（费率）──────────────────────────────────────────────────
  {
    id: 'pickup',
    file: join(SRC, 'pages/leader/pickup.vue'),
    mainUrl: '/leader/pickup/today',
    /** `PickupTodayData`（`api/leader-order.ts:194`）—— 只需满足 `reload()` 之后真正读到的字段 */
    mainBody: {
      code: 0,
      data: {
        mealDate: '2026-10-09',
        totalQuantity: 0,
        confirmedQuantity: 0,
        pendingQuantity: 0,
        canConfirm: false,
        delivery: null,
        members: [],
      },
    },
    bypass: [['/leader/workbench', 'RATE']],
    dropAll: [
      {
        from: 'fetchWorkbench({ keepAuthState: true })',
        to: `((globalThis.${S_ALL_PICKUP} = true), fetchWorkbench({}))`,
        expect: 1,
      },
    ],
    /**
     * ⚠️ 单腿页的 G **不能**与 F 同形（否则它零信息量），故换一种真实回归形态：
     * 「开关**在**，但被置成 `false`」。`api/request.ts:205` 的判据是 `!keepAuthState && …`
     * ⇒ `false` 与「整段不传」**等价有害**，判据必须同样报出。
     */
    dropOne: {
      label: 'pickup.vue:336 fetchWorkbench（开关置 false 形态）',
      needle: {
        from: 'fetchWorkbench({ keepAuthState: true })',
        to: `((globalThis.${S_ONE_PICKUP} = true), fetchWorkbench({ keepAuthState: false }))`,
        expect: 1,
      },
    },
    sentinelAll: S_ALL_PICKUP,
    sentinelOne: S_ONE_PICKUP,
  },

  // ── building：3 条腿（档案 / 战报 / 异常单）────────────────────────────────
  {
    id: 'building',
    file: join(SRC, 'pages/leader/building.vue'),
    mainUrl: '/leader/pickup/today',
    mainBody: {
      code: 0,
      data: {
        mealDate: '2026-10-09',
        totalQuantity: 0,
        confirmedQuantity: 0,
        pendingQuantity: 0,
        canConfirm: false,
        delivery: null,
        members: [],
      },
    },
    bypass: [
      ['/leader/profile', 'PROFILE'],
      ['/leader/workbench', 'WAR'],
      ['/leader/orders/abnormal', 'ABNORMAL'],
    ],
    dropAll: [
      {
        from: 'fetchLeaderProfile({ keepAuthState: true })',
        to: `((globalThis.${S_ALL_BUILDING} = true), fetchLeaderProfile({}))`,
        expect: 1,
      },
      {
        from: 'fetchWorkbench({ keepAuthState: true })',
        to: `((globalThis.${S_ALL_BUILDING} = true), fetchWorkbench({}))`,
        expect: 1,
      },
      {
        from: 'fetchLeaderAbnormal({}, { keepAuthState: true })',
        to: `((globalThis.${S_ALL_BUILDING} = true), fetchLeaderAbnormal({}, {}))`,
        expect: 1,
      },
    ],
    dropOne: {
      label: 'building.vue:236 fetchWorkbench',
      needle: {
        from: 'fetchWorkbench({ keepAuthState: true })',
        to: `((globalThis.${S_ONE_BUILDING} = true), fetchWorkbench({}))`,
        expect: 1,
      },
    },
    sentinelAll: S_ALL_BUILDING,
    sentinelOne: S_ONE_BUILDING,
  },

  // ── workbench：3 条腿（DAILY 是 fire-and-forget，最容易晚回来）──────────────
  {
    id: 'workbench',
    file: join(SRC, 'pages/leader/workbench.vue'),
    mainUrl: '/leader/workbench',
    /**
     * `LeaderWorkbenchData`（`api/leader.ts:80`）。
     * ⚠️ `tomorrow.mealDate` **必须给**：`reload()` 拿它去调 `startCountdown(data.value.tomorrow.mealDate)`，
     *    给不出来的话 `data.value.tomorrow` 是 undefined ⇒ `doQuit` 式 TypeError ⇒ DAILY 腿根本不发
     *    ⇒ 0 样本守卫报「DAILY 未被判别」。给够了它就在批次内（实测 3/3）。
     */
    mainBody: {
      code: 0,
      data: {
        today: {
          mealDate: '2026-10-09',
          orderCount: 0,
          quantity: 0,
          refundCount: 0,
          amountFen: 0,
          completedQuantity: 0,
          commissionFen: 0,
          level: 'gold',
          levelLabel: '金牌',
          rate: 0.1,
        },
        tomorrow: {
          mealDate: '2026-10-10',
          orderedCount: 0,
          orderedOrders: 0,
          cutoffAt: null,
          canOrder: true,
          unitPriceFen: 2580,
        },
        pickup: {
          point: null,
          buildingName: null,
          floor: null,
          status: 'pending',
          statusText: '待确认分发',
          expectAt: '',
          expectAtIso: null,
          actualAt: null,
          driverName: null,
          driverPhone: null,
          plateNo: null,
        },
      },
    },
    bypass: [
      ['/home/daily', 'DAILY'],
      ['/leader/profile', 'PROFILE'],
      ['/leader/pickup/today', 'PICKUP'],
    ],
    dropAll: [
      {
        from: 'fetchDaily(mealDate, { keepAuthState: true })',
        to: `((globalThis.${S_ALL_WORKBENCH} = true), fetchDaily(mealDate, {}))`,
        expect: 1,
      },
      {
        from: 'fetchLeaderProfile({ keepAuthState: true })',
        to: `((globalThis.${S_ALL_WORKBENCH} = true), fetchLeaderProfile({}))`,
        expect: 1,
      },
      {
        from: 'fetchPickupToday({}, { keepAuthState: true })',
        to: `((globalThis.${S_ALL_WORKBENCH} = true), fetchPickupToday({}, {}))`,
        expect: 1,
      },
    ],
    /** G 特意挑 **DAILY**：它是 `void startCountdown()` 发射后不管的那条腿，最该被单独证明 */
    dropOne: {
      label: 'workbench.vue:329 fetchDaily（fire-and-forget 那条）',
      needle: {
        from: 'fetchDaily(mealDate, { keepAuthState: true })',
        to: `((globalThis.${S_ONE_WORKBENCH} = true), fetchDaily(mealDate, {}))`,
        expect: 1,
      },
    },
    sentinelAll: S_ALL_WORKBENCH,
    sentinelOne: S_ONE_WORKBENCH,
  },

  // ── commission：2 条腿（余额 / 等级规则）───────────────────────────────────
  {
    id: 'commission',
    file: join(SRC, 'pages/leader/commission.vue'),
    mainUrl: '/leader/commissions',
    /** `LeaderCommissionsData`（`api/leader-finance.ts:71`）—— `fetchPage()` 读 `summary/list/page/hasMore` */
    mainBody: {
      code: 0,
      data: {
        summary: {
          range: 'day',
          startDate: '2026-10-09',
          endDate: '2026-10-09',
          earnedFen: 0,
          reversedFen: 0,
          netFen: 0,
          quantity: 0,
          level: 'gold',
          levelLabel: '金牌',
          rate: 0.1,
        },
        list: [],
        page: 1,
        pageSize: 10,
        total: 0,
        hasMore: false,
      },
    },
    bypass: [
      ['/leader/balance', 'BALANCE'],
      ['/leader/level-rules', 'LEVEL'],
    ],
    dropAll: [
      {
        from: 'fetchLeaderBalance({ keepAuthState: true })',
        to: `((globalThis.${S_ALL_COMMISSION} = true), fetchLeaderBalance({}))`,
        expect: 1,
      },
      {
        from: 'fetchLevelRules({ keepAuthState: true })',
        to: `((globalThis.${S_ALL_COMMISSION} = true), fetchLevelRules({}))`,
        expect: 1,
      },
    ],
    dropOne: {
      label: 'commission.vue:364 fetchLevelRules',
      needle: {
        from: 'fetchLevelRules({ keepAuthState: true })',
        to: `((globalThis.${S_ONE_COMMISSION} = true), fetchLevelRules({}))`,
        expect: 1,
      },
    },
    sentinelAll: S_ALL_COMMISSION,
    sentinelOne: S_ONE_COMMISSION,
  },

  // ══ `pages/leader/profile.vue` **刻意不登记** —— 不是覆盖不足，是登记口径不符 ══
  //
  // ⛔ 后来者：看到「profile 没进 PAGES」**不要**当成覆盖缺口去补。它两条前提都不成立：
  //
  //  1. **那条腿不是并发旁路**。`profile.vue:577` 的 `fetchMe({ keepAuthState: true })`
  //     位于 `doQuit()` 内、且排在 `await run(() => quitLeader(...))` **之后**：
  //       await run(() => quitLeader({ reason: '用户端主动退出团长' }, quitKey));
  //       quitKey = '';
  //       leaderStore.clear();
  //       try { const res = await fetchMe({ keepAuthState: true }); … }
  //     ⇒ 它是**顺序补刀**，携带 `run()` 刚刷新过的 token，不与任何东西并发。
  //     salvo 场景族测的是「一批并发请求同时撞上 token 到期」，它根本不是批次成员。
  //     （触发链还要先过 `confirmQuit()` → `uni.showModal` 用户点确认，`onShow` 不会碰到。）
  //
  //  2. **本页是双并发主路径**，与判据 ① 的「单主路径」假设不符：
  //       Promise.all([run(() => fetchLeaderProfile()), run(() => fetchLevelRules())])
  //     ⇒ 两条主路径各带过期 token 各吃一次 10002 ⇒ 合法清态 2 次 ⇒ 判据 ① 恒红。
  //
  // 实测过：登记进来就是 3 项红（① 清态=2 / 旁路扣住 0 条 / ME 未被判别）。
  //
  // ⛔ 要覆盖它得**另开场景族**（`uni.showModal` 替身 + 交互钩子 + 非 onShow 触发器），
  //    代价与收益不成比例 —— **当前明确不做**。
  //
  // ✅ `:577` 那个 `keepAuthState` **flag 本身是对的、要保留**：那条腿是裸调、没有
  //    `run()` 兜底 ⇒ 无权裁决登录态；而它的 `catch` 只有一句 `console.warn`
  //    ⇒ 一旦清态，用户**悄无声息地掉线**（理由见 `profile.vue:573-576` 前端注释）。
  //    留痕：该腿**不在 salvo 保护范围内**（它不并发）；将来 `doQuit()` 里若出现
  //    **并发**调用，需要重估本条结论。
];

const require_ = createRequire(pathToFileURL(join(REPO, 'package.json')).href);

// ── 依赖：esbuild + @vue/compiler-sfc（都在仓根 node_modules）────────────────
let build;
let parse;
let compileScript;
try {
  ({ build } = require_('esbuild'));
  ({ parse, compileScript } = require_('@vue/compiler-sfc'));
} catch (e) {
  console.error(`❌ 依赖缺失，无法执行判据：${e.message}`);
  console.error('   需要 esbuild 与 @vue/compiler-sfc（仓根 node_modules）');
  process.exit(2);
}

// ── 常量 ─────────────────────────────────────────────────────────────────────
const TOKEN_OLD = 'T1-expired';
const TOKEN_NEW = 'T2-fresh';
/** 齐射场景用的第三个 token：T2 到期后，由「**别处**那条路径」重登写入，本页无从知晓 */
const TOKEN_ROT = 'T3-rotated';
/** 四档各自的 total —— 取四个**互不相同**的值，才能证明「各拿自己那一档」而不是都拿到同一个兜底值 */
const TOTALS = { '': 12, paid: 3, completed: 7, cancelled: 2 };
const TAB_VALUES = ['', 'paid', 'completed', 'cancelled'];

/**
 * 时序（leak 场景的关键）：主列表 50ms 就回 10002 ⇒ 触发重登（150ms）⇒ T2 在 ~205ms 写入；
 * 4 个计数**刻意 300ms** 才回 ⇒ 落在「新 token 已写入之后」。
 * 余量约 95ms：即便多跳一两个事件循环也不会错序，但若机器极端卡顿则需复查本注释。
 */
const TIMING = { listBad: 50, login: 150, countBad: 300, okAll: 40, revokeAfter: 200 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (s) => console.log(s);

// ── 假 transport ─────────────────────────────────────────────────────────────
/**
 * 每个场景建**一个全新**的 sink（事件流水 / 假 storage / toast），避免样本间串扰 ——
 * 这一点踩过坑：早版本在单进程里连跑多个样本，泄漏的定时器会污染后一个样本的计数。
 */
function createSink() {
  return {
    events: [],
    storage: Object.create(null),
    toasts: [],
    requests: [],
    pending: [],
    /** 正在派发的那个响应事件（用于把「清态」**归因**到具体某一次响应） */
    current: null,
  };
}

const statusOf = (url) => {
  const m = /[?&]status=([^&]*)/.exec(String(url));
  return m ? decodeURIComponent(m[1]) : '';
};
const isList = (url) => String(url).includes('pageSize=20');

/** 旁路腿标签；不在旁路集合里返回 null（主路径 / 与本页无关的请求都走既有分支） */
const bypassLabelOf = (url, pageCfg) => {
  if (!pageCfg) return null;
  const hit = pageCfg.bypass.find(([p]) => String(url).includes(p));
  return hit ? hit[1] : null;
};

function labelOf(url, pageCfg) {
  const u = String(url);
  if (u.includes('/auth/login')) return 'LOGIN';
  if (pageCfg) {
    const b = bypassLabelOf(u, pageCfg);
    if (b) return b;
    if (u.includes(pageCfg.mainUrl)) return 'MAIN';
    return u;
  }
  const s = statusOf(u);
  return isList(u) ? 'LIST' : `CNT(${s || 'all'})`;
}

/** 200 响应体：多页登记里主路径用自己的 `mainBody`，其余沿用 order-list 的通用体 */
const okBodyFor = (url, cfg) => {
  const p = cfg.pageCfg;
  if (p && p.mainBody && String(url).includes(p.mainUrl)) return p.mainBody;
  return {
    code: 0,
    data: {
      list: [],
      page: 1,
      pageSize: isList(url) ? 20 : 1,
      total: TOTALS[statusOf(url)] ?? TOTALS[''],
      hasMore: false,
    },
  };
};

function createTransport(sink, cfg) {
  const log = (e) => sink.events.push({ t: Date.now() - cfg.t0, ...e });

  return {
    getStorageSync: (k) => (k in sink.storage ? sink.storage[k] : ''),
    setStorageSync: (k, v) => {
      sink.storage[k] = v;
      if (k === 'abox_token')
        log({ kind: 'TOK', op: '写入', label: '', code: '', tok: '', v: String(v) });
    },
    removeStorageSync: (k) => {
      delete sink.storage[k];
      if (k === 'abox_token') {
        log({ kind: 'TOK', op: '删除', label: '', code: '', tok: '', v: '' });
        // ⭐ **归因**，不是「时间相近」：把这次清态记到「正在派发的那个响应」头上。
        //    若清态发生在派发之外（微任务里），退而记到最近一次响应。
        //    ⛔ 绝不能用 `|t - 删除时间| <= 1ms` 归因：同一批放行的 N 个响应时间戳几乎
        //    相同 ⇒ **一个**清态会被算成 **N** 次踩踏。实测：必报 G（只删 1 处）应报
        //    1 次，用时间归因时报成了 5 次 —— 判据照样红，「有牙齿」却是假的。
        const ev = sink.current ?? [...sink.events].reverse().find((e) => e.kind === 'RES');
        if (ev) ev.cleared = true;
      }
    },
    showLoading: () => {},
    hideLoading: () => {},
    showToast: (o) => sink.toasts.push(o),
    request(opts) {
      const url = String(opts.url);
      const carried = String(
        (opts.header && (opts.header.Authorization || opts.header.authorization)) || '',
      ).replace('Bearer ', '');
      sink.requests.push({ url, tok: carried });
      log({ kind: 'REQ', op: '', label: labelOf(url, cfg.pageCfg), code: '', tok: carried, v: '' });

      const finish = (statusCode, body) => {
        const ev = {
          t: Date.now() - cfg.t0,
          kind: 'RES',
          op: '',
          label: labelOf(url, cfg.pageCfg),
          code: body && typeof body === 'object' ? body.code : '?',
          tok: carried,
          v: '',
          /** 这次响应**有没有出手清态** —— 由 `removeStorageSync` 归因写入，不靠时间猜 */
          cleared: false,
        };
        sink.events.push(ev);
        const prev = sink.current;
        sink.current = ev;
        try {
          opts.success({ statusCode, data: body });
        } finally {
          sink.current = prev;
        }
      };

      if (url.includes('/auth/login')) {
        return setTimeout(
          () =>
            finish(200, {
              code: 0,
              data: {
                token: TOKEN_NEW,
                isNewUser: false,
                isLeader: false,
                leader: null,
                user: {
                  id: 1,
                  nickname: 'gate',
                  avatarUrl: null,
                  phone: null,
                  buildingId: 1,
                  teamLeaderId: null,
                },
              },
            }),
          cfg.loginDelay,
        );
      }

      // ⚠️ 齐射场景：旁路请求**一到达就扣住**（此时它携带的 T2 还没到期），
      //    等「全部旁路都在途」这一**事件**放闸后，再让 T2 到期（别处重登写入 T3）并放行
      //    ⇒ 一轮覆盖全部腿。
      //    （不这么做的话，先返回的腿会赶在到期之前拿到 200 ⇒ 那条腿**永不被判别**
      //      ⇒ 它的开关被删也测不出 —— mine.vue 的 SUPPORT 腿就是这个失效模式的实例。）
      if (cfg.holdBypass && bypassLabelOf(url, cfg.pageCfg)) {
        sink.pending.push(() =>
          finish(200, { code: 10002, message: '未登录或登录已过期', data: null }),
        );
        return;
      }

      if (carried === (cfg.valid ? cfg.valid.token : cfg.validToken)) {
        return setTimeout(
          () =>
            // ⚠️ 作废判定必须在**响应到达的这一刻**做，不能在请求发出时做 ——
            //    真拒场景的语义正是「发出时有效、回来时已被服务端作废」。
            //    （实测踩过：判在发出时刻 ⇒ 旁路一路 200 ⇒ 真拒 0 次，场景静默退化。）
            cfg.revokeAt != null && Date.now() - cfg.t0 >= cfg.revokeAt
              ? finish(200, { code: 10002, message: '未登录或登录已过期', data: null })
              : finish(200, okBodyFor(url, cfg)),
          cfg.okDelay(url),
        );
      }

      // ⚠️ 时序**不靠定时器赌**：leak 场景的旁路响应先**扣住**，等「重登写入新 token」
      //    这一**事件**放闸（`holdStale`）。原写法用 `countBad: 300ms` 去猜「晚于重登」——
      //    忙机上事件循环一漂（>150ms 的余量）⇒ 危险条件根本没构造出来 ⇒ **假红**。
      //    改成事件驱动后，「旁路晚于新 token 写入」与机器快慢无关。
      if (cfg.holdStale && !isList(url)) {
        sink.pending.push(() =>
          finish(200, { code: 10002, message: '未登录或登录已过期', data: null }),
        );
        return;
      }

      return setTimeout(
        () => finish(200, { code: 10002, message: '未登录或登录已过期', data: null }),
        cfg.badDelay(url),
      );
    },
  };
}

// ── 判据：区分「陈旧裁决」与「合法清态」───────────────────────────────────────
function classify(sink) {
  const writes = sink.events.filter((e) => e.kind === 'TOK' && e.op === '写入');
  // ⚠️ 比的是「写到过的最新 token」，不是「响应到达时的存储现值」—— 见文件头两个坑
  const latestAt = (t) => {
    const prior = writes.filter((w) => w.t <= t);
    return prior.length ? prior[prior.length - 1].v : '';
  };
  const hits = sink.events.filter((e) => e.kind === 'RES' && e.code === 10002);
  const isStale = (e) => {
    const latest = latestAt(e.t);
    return Boolean(e.tok && latest && e.tok !== latest);
  };
  return {
    // ⚠️ `e.cleared` 是**归因**结果（哪一次响应出的手），不是「时间相近」—— 见 `removeStorageSync`
    stale: hits.filter((e) => isStale(e) && e.cleared),
    legit: hits.filter((e) => !isStale(e) && e.cleared),
    /** 「危险条件」实录：携带旧 token 的响应，且当时**已经写到过**更新的 token */
    dangerous: hits.filter((e) => isStale(e)),
    countHits: hits.filter((e) => e.label.startsWith('CNT')),
  };
}

// ── 打包：真页面 SFC + 真请求层 + 真 store ───────────────────────────────────
/**
 * entry 用 esbuild 的 stdin（不必在仓里留 harness 文件）；
 * 只有 `@dcloudio/uni-app` 是替身（Node 里没有小程序运行时），
 * 请求层 / useRequest / ensureLogin / pinia store / storage **全是真源码**。
 */
const HARNESS = `
import { createPinia, setActivePinia } from 'pinia';
import { useUserStore } from '@/stores/user';
import { getToken } from '@/utils/storage';
import { __hooks } from '@dcloudio/uni-app';
import Page from 'virtual:page';

export function mountPage(initialToken) {
  setActivePinia(createPinia());
  if (initialToken) {
    useUserStore().setLogin(initialToken, {
      id: 1, nickname: 'gate', avatarUrl: null, phone: null, buildingId: 1, teamLeaderId: null,
    });
  }
  const comp = Page.default ?? Page;
  const setup = comp.setup;
  if (typeof setup !== 'function') throw new Error('页面编译产物里没有 setup()，判据前提不成立');
  return setup({}, { expose: () => {}, emit: () => {} });
}

export function fireOnShow() { for (const fn of __hooks.onShow) fn(); }
export function currentToken() { return getToken(); }
`;

/**
 * 变异覆盖表：**键 = 真文件的绝对路径**（不是 import 写法）
 *
 * ⚠️ 为什么必须按路径判、不能按写法判（实测踩过）：`api/order.ts` 用相对路径 `'./request'`、
 *    而 `composables/use-request.ts` 用别名 `'@/api/request'` —— 只覆盖后者会让 bundle 里
 *    出现**两份 request.ts** ⇒ `ApiError` 变成两个类 ⇒ `useRequest` 的 `e instanceof ApiError`
 *    **恒假** ⇒ 重登压根不触发 ⇒ 样本静默造不出来（只报「没观察到重登」，极难定位）。
 */
let OVERRIDE = {};
/** 换掉被测页面（变异体）；null = 用真源码 */
let PAGE_OVERRIDE = null;

let bundlePath = null;

async function ensureBundle(opts = {}) {
  OVERRIDE = opts.override ?? {};
  PAGE_OVERRIDE = opts.page ?? null;

  const dir = mkdtempSync(join(tmpdir(), 'abox-mp-auth-'));
  bundlePath = join(dir, 'bundle.mjs');

  const { errors } = await build({
    absWorkingDir: REPO,
    stdin: { contents: HARNESS, resolveDir: REPO, sourcefile: 'harness.ts', loader: 'ts' },
    outfile: bundlePath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    nodePaths: [join(REPO, 'node_modules')],
    external: [],
    logLevel: 'warning',
    define: {
      'import.meta.env.MODE': '"development"',
      'import.meta.env.VITE_API_BASE_URL': '"http://127.0.0.1:3999/api/v1"',
      'import.meta.env.VITE_WX_MINI_APPID': '""',
      'import.meta.env.VITE_WX_DEV_LOGIN_CODE': '"dev:1001"',
    },
    plugins: [
      {
        name: 'sfc',
        setup(b) {
          b.onResolve({ filter: /\.vue$/ }, (args) => ({
            path: resolve(args.resolveDir, args.path),
            namespace: 'sfc',
          }));
          b.onResolve({ filter: /^virtual:page$/ }, () => ({
            path: PAGE_OVERRIDE ?? PAGE,
            namespace: 'sfc',
          }));
          b.onResolve({ filter: /^@dcloudio\/uni-app$/ }, () => ({
            path: 'stub-uniapp',
            namespace: 'stub',
          }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: `
export const __hooks = { onShow: [] };
export function onShow(fn) { __hooks.onShow.push(fn); }
export function onLoad() {}
export function onHide() {}
export function onUnload() {}
export function onReady() {}
export function onPullDownRefresh() {}
export function onReachBottom() {}
`,
            loader: 'js',
            resolveDir: REPO,
          }));
          b.onLoad({ filter: /.*/, namespace: 'sfc' }, (args) => {
            const source = readFileSync(args.path, 'utf8');
            const { descriptor } = parse(source, { filename: args.path });
            const compiled = compileScript(descriptor, { id: 'gate', isProd: false });
            return { contents: compiled.content, loader: 'ts', resolveDir: REPO };
          });
        },
      },
      {
        name: 'alias',
        setup(b) {
          const EXTS = ['', '.ts', '.tsx', '.js', '.mjs', '.vue', '/index.ts', '/index.js'];
          /** 先解析成真文件，再查覆盖表 ⇒ 写法不同也只认同一份文件 */
          const resolveFile = (base) => {
            for (const ext of EXTS) {
              const p = base + ext;
              if (existsSync(p) && statSync(p).isFile()) return p;
            }
            return null;
          };
          const mapped = (file) => {
            const m = OVERRIDE[file];
            return m === undefined
              ? { path: file, namespace: file.endsWith('.vue') ? 'sfc' : undefined }
              : { path: m, namespace: m.endsWith('.vue') ? 'sfc' : undefined };
          };

          b.onResolve({ filter: /^@\// }, (args) => {
            const abs = resolve(SRC, args.path.slice(2));
            const file = resolveFile(abs);
            if (!file) return { errors: [{ text: `别名未命中：${args.path} → ${abs}` }] };
            return mapped(file);
          });

          // ⭐ 相对路径同样要过覆盖表：见 `OVERRIDE` 头注的那次踩坑（`order.ts` 的 `'./request'`）
          b.onResolve({ filter: /^\.{1,2}\// }, (args) => {
            const file = resolveFile(resolve(args.resolveDir, args.path));
            if (!file || OVERRIDE[file] === undefined) return undefined;
            return mapped(file);
          });
        },
      },
    ],
  });

  if (errors && errors.length) {
    throw new Error(`打包失败：${errors.map((e) => e.text).join(' / ')}`);
  }
  return bundlePath;
}

// ── 场景 ─────────────────────────────────────────────────────────────────────
/** 轮询等一个**条件**成立（不是等时间）—— 超时返回 false，由调用方判「样本没造出来」 */
async function waitUntil(fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
}

async function runLeak(cfg, bundleOverride) {
  const sink = createSink();
  globalThis.uni = createTransport(sink, cfg);

  const mod = await freshImport('leak', bundleOverride);
  mod.mountPage(TOKEN_OLD);
  mod.fireOnShow();

  if (cfg.holdStale) {
    // 「重登已写入新 token」是**事件**，不是时间 —— 等到它才放闸；
    //    等不到 ⇒ 判据前提不成立（不许拿「0 违规」当通过，也不许当失败，直接判样本没造出来）
    const sawNewToken = await waitUntil(
      () => sink.events.some((e) => e.kind === 'TOK' && e.op === '写入' && e.v === TOKEN_NEW),
      8000,
    );
    if (!sawNewToken) throw new Error('leak 样本没造出来：始终没有观察到「重登写入新 token」');
    // ⚠️ **逐条**放行，每条之间隔一个宏任务：请求层的清态发生在 `await uniRequest(...)`
    //    的**微任务**里，若一次性全部放行，N 次清态会挤在同一轮微任务里 ⇒ 归因时
    //    全都落到「最后一次响应」头上 ⇒ N 次踩踏被记成 1 次（实测踩到）。
    for (const release of sink.pending.splice(0)) {
      release();
      await sleep(0);
    }
    await sleep(400);
  } else {
    await sleep(1500);
  }

  const c = classify(sink);
  const binds = c;
  const loginCount = sink.events.filter((e) => e.kind === 'REQ' && e.label === 'LOGIN').length;
  const finalToken = mod.currentToken();

  const bad = [];
  if (binds.stale.length !== 0) {
    bad.push(
      `② 旁路踩踏新 token：${binds.stale.length} 次（必须 0）` +
        binds.stale.map((e) => `  ${e.t}ms ${e.label} 携带=${e.tok}`).join(''),
    );
  }
  // ① 同 `runSalvo`：假设**单**并发主路径（`order-list` 满足：`run(fetchOrders)` 一条）。
  if (binds.legit.length !== 1) {
    bad.push(
      `① 主路径清态次数=${binds.legit.length}（必须恰好 1 —— 少了=过度修复，多了=主路径自己在乱清）` +
        `（⚠️ 本判据假设**单**并发主路径）`,
    );
  }
  if (finalToken !== TOKEN_NEW) {
    bad.push(`① 最终 token="${finalToken}"（应为重登写入的 ${TOKEN_NEW}）`);
  }

  // 样本下限：危险条件必须**真的构造出来**了，否则上面的「0 违规」毫无意义
  const noSample = [];
  if (loginCount < 1) noSample.push('未触发重登（loginCount=0）');
  if (binds.legit.length < 1) noSample.push('主路径真拒 0 次');
  if (binds.dangerous.length < 4) {
    noSample.push(
      `危险条件只出现 ${binds.dangerous.length} 次（需 ≥4：4 个旁路都携带旧 token 且晚于新 token 写入）`,
    );
  }

  return {
    scenario: 'leak',
    desc: 'token 恰好过期：主路径重登重试中，4 个旁路计数拿旧 token 晚一步回来',
    bad,
    noSample,
    sink,
    // ⚠️ 数值一并回传：必报（变异）场景要靠它们判断「判据有没有牙齿」
    staleN: binds.stale.length,
    legitN: binds.legit.length,
    dangerousN: binds.dangerous.length,
    samples: {
      请求数: sink.requests.length,
      登录: loginCount,
      陈旧裁决: `${binds.dangerous.length} 次（其中出手清态 ${binds.stale.length} 次）`,
      合法清态: `${binds.legit.length} 次`,
      最终token: finalToken,
    },
  };
}

async function runOk(cfg, bundleOverride) {
  const sink = createSink();
  globalThis.uni = createTransport(sink, cfg);

  const mod = await freshImport('ok', bundleOverride);
  const bindings = mod.mountPage(TOKEN_OLD);
  mod.fireOnShow();
  await sleep(1200);

  const loginCount = sink.events.filter((e) => e.kind === 'REQ' && e.label === 'LOGIN').length;
  const finalToken = mod.currentToken();
  const counts = TAB_VALUES.map((v) => [v, bindings.countOf(v)]);

  const bad = [];
  if (sink.requests.length !== 5)
    bad.push(`③ 请求数=${sink.requests.length}（应为 5：1 列表 + 4 计数）`);
  if (loginCount !== 0) bad.push(`③ 触发了 ${loginCount} 次重登（正常路径应为 0）`);
  if (finalToken !== TOKEN_OLD) bad.push(`③ 登录态被改动：${finalToken}`);
  if (sink.toasts.length !== 0)
    bad.push(`③ 弹了 ${sink.toasts.length} 次 toast（计数失败应当静默）`);
  const wrong = counts.filter(([v, n]) => n !== TOTALS[v]);
  if (wrong.length) {
    bad.push(
      `③ 计数取错：${wrong.map(([v, n]) => `${v || 'ALL'}=${String(n)}(应 ${TOTALS[v]})`).join(' ')}`,
    );
  }

  const noSample = [];
  const cntRes = sink.events.filter((e) => e.kind === 'RES' && e.label.startsWith('CNT')).length;
  if (cntRes < 4) noSample.push(`旁路计数只回来 ${cntRes} 条（需 ≥4）`);
  if (sink.requests.length < 5) noSample.push('主+旁路共 <5 次请求，③ 的分母不足');

  return {
    scenario: 'ok',
    desc: '正常 200：四档计数必须照常拿到各自的 total，登录态不动、不弹错',
    bad,
    noSample,
    samples: {
      请求数: sink.requests.length,
      登录: loginCount,
      toast: sink.toasts.length,
      四档计数: counts.map(([v, n]) => `${v || 'ALL'}=${String(n)}`).join(' '),
      最终token: finalToken,
    },
  };
}

/** 真拒场景的观测快照：某一时刻的「清态 / 真拒 / 主路径成功 / 重登 / token」 */
function snapshot(sink, mod) {
  const writes = sink.events.filter((e) => e.kind === 'TOK' && e.op === '写入');
  const latestAt = (t) => {
    const prior = writes.filter((w) => w.t <= t);
    return prior.length ? prior[prior.length - 1].v : '';
  };
  const hits = sink.events.filter((e) => e.kind === 'RES' && e.code === 10002);
  return {
    clears: sink.events.filter((e) => e.kind === 'TOK' && e.op === '删除').length,
    /** 真拒 = 响应携带的 token **就是**它到达时本进程写到过的最新 token */
    trueRejects: hits.filter((e) => e.tok && e.tok === latestAt(e.t)).length,
    listOk: sink.events.filter((e) => e.kind === 'RES' && e.label === 'LIST' && e.code === 0)
      .length,
    logins: sink.events.filter((e) => e.kind === 'REQ' && e.label === 'LOGIN').length,
    token: mod.currentToken(),
  };
}

/**
 * 场景 trueReject：**真拒**（旁路携带的就是当时最新 token，服务端照样 10002）
 *
 * ⚠️ 为什么必须有这个场景（判据 ④ 的由来）：判据①②③ 只覆盖「陈旧裁决」这一种成因 ——
 *    旁路拿旧 token 回来、把主路径刚重登写入的新 token 清掉。`keepAuthState` 治好了它，
 *    但代价是**旁路从此永远不清态**。于是必须回答反方向的问题：
 *      若 token **真的**死了（携带最新 token 仍被拒），会不会出现**无人清态**的永久停留？
 *    清态的**唯一**调用点是 `api/request.ts:208`（`useRequest` 只负责重登、**自己不清态**，
 *    见其注释「request 层已清空本地登录态」），所以这个问题只能实测，不能靠读码推断。
 *
 * 构造（真实时序，不是把延迟调大凑出来的）：
 *    · 主路径 LIST 40ms 就回 200（成功 ⇒ 主路径不会再跑、也不会再触发重登）
 *    · 200ms 服务端作废所有 token
 *    · 4 个旁路 CNT 300ms 才回 ⇒ 携带 T1，**而 T1 到那时仍是本进程写到过的最新 token**
 *      ⇒ 这是「真拒」，不是「陈旧裁决」
 *    ⇒ 主路径已成功过不会再触发，旁路又带着 `keepAuthState` 不清态
 *      ⇒ 若无人清态，用户就会停留在「看起来登录着」的死会话里
 */
async function runTrueReject(cfg, bundleOverride) {
  const sink = createSink();
  // ⚠️ 本场景必须用**自己的** t0：`revokeAt` 是**相对量**（场景开始后 120ms 才作废）。
  //    若沿用 main 的全局 t0，前面 leak/ok 已耗掉数秒 ⇒ 一开局就被判 revoked ⇒
  //    所有请求一律 10002 ⇒ 主路径永远不成功 ⇒ 「真拒」的前提压根不成立（实测踩到过）。
  const cfg2 = { ...cfg, t0: Date.now() };
  globalThis.uni = createTransport(sink, cfg2);

  const mod = await freshImport('truereject', bundleOverride);
  mod.mountPage(TOKEN_OLD);
  mod.fireOnShow();
  await sleep(1200);
  const phase1 = snapshot(sink, mod);

  // 阶段 2：**用户下一次操作**（再触发一次 onShow ≡ 切 tab / 下拉刷新 / 重进本页）
  //    ⚠️ 这一步才是判据 ④ 的本体：真拒当下无人清态是 `keepAuthState` 的**设计**（旁路
  //    无权裁决 session），真正要守住的是**不许永远没人清** —— 下一次主请求必须发现并清态。
  //    只测到阶段 1 就下「永久停留」的结论，是把「延迟发现」误判成「永不发现」。
  mod.fireOnShow();
  await sleep(2000);
  const phase2 = snapshot(sink, mod);

  const bad = [];
  // ④ 第 4 条不变量：真拒之后，**下一次主请求必须发现并清态**（不许永远没人清）
  //    ⚠️ 阶段 1 无人清态是 `keepAuthState` 的**设计**（旁路无权裁决 session），**不判红**；
  //    判红的是「阶段 2 仍没人清」—— 那才是真正的永久停留。
  //    （只测阶段 1 就下结论，会把「延迟到下次操作才发现」误判成「永不发现」。）
  if (phase2.clears < 1) {
    bad.push(
      `④ 真拒之后连**下一次主请求**都没人清态` +
        `（阶段1 清态 ${phase1.clears} 次 → 阶段2 清态 ${phase2.clears} 次）` +
        ` —— 用户永久停留在「看起来登录着」的死会话里` +
        `（重登 ${phase2.logins} 次 · 最终 token="${phase2.token}"）`,
    );
  }

  // 样本下限：真拒必须**真的构造出来**了，否则「有人清态」这句话毫无意义
  const noSample = [];
  if (!phase1.listOk)
    noSample.push('阶段1 主路径没成功 —— 真拒场景的前提（主路径已拿到数据、不再触发）不成立');
  if (phase1.trueRejects < 4)
    noSample.push(
      `真拒只出现 ${phase1.trueRejects} 次（需 ≥4：4 个旁路都携带最新 token 且被服务端拒）`,
    );
  if (phase2.clears < 1 && phase2.logins < 1)
    noSample.push('阶段2 既没清态也没重登 —— 第二次 onShow 没真正发出请求，④ 的分母不足');

  return {
    scenario: 'truereject',
    desc: '真拒：主路径已成功后服务端作废 token，4 个旁路携带**最新** token 仍被拒（下次主请求必须清态）',
    bad,
    noSample,
    sink,
    staleN: 0,
    // ⚠️ 判据 ④ 的「牙齿」看这个数：必报 C（摘掉唯一清态点）必须让它归 0
    clearsN: phase2.clears,
    samples: {
      请求数: sink.requests.length,
      阶段1: `主路径 ${phase1.listOk} 次 200 · 旁路真拒 ${phase1.trueRejects} 次 · 清态 ${phase1.clears} 次（属判据② 的判断范围，此处不判）`,
      阶段2: `下一次主请求 → 清态 ${phase2.clears} 次 · 重登 ${phase2.logins} 次（④ 要求清态 ≥1）`,
      最终token: phase2.token,
    },
  };
}

/**
 * 场景 salvo：**在飞期间 token 到期的齐射**（多页登记 `PAGES` 里每一页都跑一遍）
 *
 * ⚠️ 为什么必须另开这个场景（不是 leak 的变体）：leak 造的换发来自**本页**的 `run()`，
 *    `keepAuthState` 之外还有一层「顺序约定」在起作用（旁路排在 `run()` 之后）。
 *    而真实世界里换发**不由本页发起** —— token 恰好在这一批并发请求在飞时到期，
 *    重登可能由本页发起、也可能由**别处**那条路径发起（本页无从知晓）。
 *    mine.vue 当初就是这么踩的：`loadSupport()` 是**第二条** `run()` 路径，
 *    顺序约定只关掉了第一条那个窗口。
 *
 * ⛔ 触发器是「**token 到期**」，不是「别处重登」：JWT 无状态（见 `PAGES` 上方三处证据），
 *    别处重登**不会**让在飞的旧 token 变 401。harness 里「别处写入 T3」只是把
 *    「这一批请求携带的 T2 已经失效」这一事实**落到本页可见的位置**，是结果不是原因。
 *
 * 构造（**事件放闸**，不靠定时器赌顺序）：
 *   1. 进场 token=T1 已过期 ⇒ 主路径 `/auth/me` 吃 10002 ⇒ `run()` 重登 ⇒ 写入 T2
 *   2. N 条旁路**一到达就扣住**（`holdBypass`），此时它们携带的都是还没到期的 T2
 *   3. 等「**N 条旁路全部在途**」这一**计数事件**成立 ⇒ 令 T2 到期：
 *      服务端改认 T3（`cfg.valid.token`）+ storage 写入 T3（由别处那条路径重登写入）
 *   4. 放行 ⇒ N 条旁路**全部**携带已失效的 T2 回来吃 10002，而此时最新已写到 T3
 *      ⇒ 全是「陈旧裁决」
 *
 * ⇒ 一轮就覆盖 **N/N** 条腿。旧写法靠「把某条腿的延迟调大」来让它落在换发之后，
 *    结果 SUPPORT 那条腿（60ms）永远赶在换发之前返回 200 ⇒ **永不被判别**
 *    ⇒ 它的开关被删，门禁照样绿（实测坐实）。
 */
async function runSalvo(pageCfg, bundleOverride) {
  const sink = createSink();
  // ⚠️ 自带 t0 + 自带可变 valid：场景内要改「服务端当前认哪个 token」，
  //    沿用 main 的全局 t0 / 共享 cfg 会让多个样本互相污染（truereject 踩过同一类坑）。
  const cfg = {
    t0: Date.now(),
    loginDelay: TIMING.login,
    valid: { token: TOKEN_NEW },
    okDelay: () => TIMING.okAll,
    badDelay: () => TIMING.listBad,
    holdBypass: true,
    pageCfg,
  };
  globalThis.uni = createTransport(sink, cfg);

  const legs = pageCfg.bypass.length;
  const mod = await freshImport(`salvo-${pageCfg.id}`, bundleOverride);
  mod.mountPage(TOKEN_OLD);
  mod.fireOnShow();

  const noSample = [];
  const got = await waitUntil(() => sink.pending.length >= legs, 8000);
  if (!got) {
    noSample.push(
      `旁路只扣住 ${sink.pending.length} 条（需 ≥${legs}）—— 危险条件根本没构造出来`,
    );
  } else {
    // T2 到期：由「N 条旁路全部在途」这一**事件**放闸 —— 与机器快慢无关。
    // ⛔ 顺序的含义是「T2 到期了，随后别处那条路径重登写入 T3」，
    //    不是「T3 的签发导致 T2 失效」—— JWT 无状态，别处重登作废不了在飞的旧 token。
    globalThis.uni.setStorageSync('abox_token', TOKEN_ROT);
    cfg.valid.token = TOKEN_ROT;
    sink.events.push({
      t: Date.now() - cfg.t0,
      kind: 'NOTE',
      op: 'T2 到期 · 别处重登写入',
      label: '',
      code: '',
      tok: TOKEN_ROT,
      v: TOKEN_ROT,
    });
    // ⚠️ **逐条**放行（同 leak 那条注释）：一次全放会把 N 次清态全归因到最后一条响应上
    for (const release of sink.pending.splice(0)) {
      release();
      await sleep(0);
    }
  }
  await sleep(500);

  const c = classify(sink);
  const loginCount = sink.events.filter((e) => e.kind === 'REQ' && e.label === 'LOGIN').length;
  const finalToken = mod.currentToken();

  const bad = [];
  if (c.stale.length !== 0) {
    bad.push(
      `② ${pageCfg.id} 旁路踩踏别处重登写入的新 token：${c.stale.length} 次（必须 0）` +
        c.stale.map((e) => `  ${e.t}ms ${e.label} 携带=${e.tok}`).join(''),
    );
  }
  // ① 主路径清态次数：⚠️ 本判据**假设本页只有一条并发主路径**（`run()`）。
  //    双主路径页（如 `profile` 的 `Promise.all([run(fetchLeaderProfile), run(fetchLevelRules)])`）
  //    会各吃一次 10002 ⇒ 合法清态 2 次 ⇒ 本判据**不适用**，不得直接登记进 `PAGES`
  //    （见 `PAGES` 末尾那段注释）。⛔ 不要为此加「期望值旋钮」—— 剩下 5 页全是单主路径，
  //    加一个没人用的旋钮 = 死代码，且会变成将来「把红改成绿」的把手。假设写在这里即可。
  if (c.legit.length !== 1) {
    bad.push(
      `① 主路径清态次数=${c.legit.length}（必须恰好 1 —— 少了=过度修复，多了=主路径自己在乱清）` +
        `（⚠️ 本判据假设**单**并发主路径；若本页是 ` +
        `\`Promise.all([run(), run()])\` 这类双主路径，这里会恒红 ⇒ 该页不适用本场景族）`,
    );
  }

  // ── 0 样本守卫（**逐腿**，不只是总数）─────────────────────────────────────
  //    总数够但某条腿缺席，和「该腿的开关被删了」长得一模一样 ⇒ 必须逐腿核对。
  const covered = new Set(c.dangerous.map((e) => e.label));
  const missing = pageCfg.bypass.map(([, l]) => l).filter((l) => !covered.has(l));
  if (missing.length) {
    noSample.push(
      `旁路腿未被判别：${missing.join(' / ')}` +
        ` —— 这些位点的开关被删也测不出，与它们不存在同形`,
    );
  }
  if (loginCount < 1) noSample.push('未触发重登（loginCount=0）');

  return {
    scenario: `salvo:${pageCfg.id}`,
    desc:
      `齐射：主路径重登拿到 ${TOKEN_NEW} 后，${legs} 条旁路在途期间 ${TOKEN_NEW} **到期**` +
      `（别处那条路径重登写入 ${TOKEN_ROT}）⇒ 旁路携带已失效的 ${TOKEN_NEW} 晚回来吃 10002，` +
      `清态必须 0 次`,
    bad,
    noSample,
    sink,
    staleN: c.stale.length,
    legitN: c.legit.length,
    samples: {
      请求数: sink.requests.length,
      登录: loginCount,
      陈旧裁决: `${c.dangerous.length} 次（其中出手清态 ${c.stale.length} 次）`,
      合法清态: `${c.legit.length} 次`,
      已判别腿: `${covered.size}/${legs}${missing.length ? ` 缺：${missing.join(' / ')}` : ''}`,
      最终token: finalToken,
    },
  };
}

/** 事件流水（失败诊断用）：按时间排好，能直接读出因果链 */
function timelineOf(sink) {
  return sink.events
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((e) =>
      e.kind === 'TOK'
        ? `${e.t}ms TOKEN ${e.op}${e.op === '写入' ? ` ${e.v}` : ''}`
        : `${e.t}ms ${e.kind === 'REQ' ? '→发出' : '←响应'} ${e.label}${e.kind === 'RES' ? ` code=${e.code}` : ''}${e.tok ? ` 携带=${e.tok}` : ''}`,
    );
}

/** cache-busting 重新 import ⇒ 每个场景拿到**全新模块图**（尤其 utils/auth 的 pending 去重变量） */
let importNonce = 0;
async function freshImport(tag, bundleOverride) {
  const p = bundleOverride ?? bundlePath;
  return import(`${pathToFileURL(p).href}?sc=${tag}&n=${importNonce++}`);
}

// ── 必报（变异）样本：证明判据**有牙齿** ─────────────────────────────────────
//    只断言「当前源码是对的」是**不够的** —— 判据自身失效时它照样绿（恒绿陷阱）。
//    故人为造**五个**失效形态，各自**必须被对应的判据报出**；报不出即判据不可用：
//      A 页面侧开关关闭 / B 请求层守卫摘除  ⇒ 判据 ②（修没修够）
//      D 页面侧整段不传 `keepAuthState`    ⇒ 判据 ②（**复制时忘带开关**）
//      E 主路径也挂 `keepAuthState`        ⇒ 判据 ①（**修过头**：没人清态）
//      C 摘掉唯一清态点                     ⇒ 判据 ④（真拒后无人清态）
//    ⚠️ 五个方向各自独立，缺任何一个，对应那条判据就是「谁也没见过它红」。
//
// ⚠️ 变异替身里带 `globalThis.__MUT_*` 运行时哨兵：光「替换成功」不算数，必须证明
//    **变异后的那份代码真的进了 bundle 并执行了**。踩过的坑：页面注释里也写着
//    `keepAuthState: true`（order-list.vue:143），只匹配裸字面量会把变异打进**注释**
//    ⇒ 变异体永不执行 ⇒ 「必报样本通过」是假的。
const MUT_PAGE = {
  from: '{ keepAuthState: true },',
  to: '{ keepAuthState: (globalThis.__MUT_PAGE = true, false) },',
};
const MUT_REQ = { from: '!keepAuthState &&', to: '((globalThis.__MUT_REQ = true), true) &&' };
/**
 * 必报 C 的变异针：与 B 同一个位置，但方向相反 —— B 是「无条件清态」（修没修够），
 * C 是「**永不**清态」（把唯一清态点摘掉）。C 专门用来证明判据 ④ 有牙齿。
 */
const MUT_REQ2 = { from: '!keepAuthState &&', to: '((globalThis.__MUT_REQ2 = true), false) &&' };
/**
 * 必报 D 的变异针（= 原先只能手动打的 R3 那一针，本轮收编进来）：
 *    · 必报 A 是 `{ keepAuthState: true } → false`（开关**还在**，只是被关掉）
 *    · 必报 D 是 `{ keepAuthState: true },` → `{}`（**整段不传**）
 *      ≡ 有人把这 4 个并发裸调**复制到别处时忘带 `keepAuthState`** 的形态
 *
 * ⚠️ 为什么必须单独一针：A 的 `from` 本身就是 `'{ keepAuthState: true },'`，在「整段不存在」
 *    的源码形态下**零命中** ⇒ `writeMutant` 抛「变异失效」。那只能证明「变异针没打中」，
 *    **证明不了**「判据 ② 抓得住这种回归」。D 是从当前正确源码出发、把它改成遗漏形态，
 *    才有资格断言「报不出 = 判据失效」。
 *
 * ⚠️ `to` 用「传空对象 + 哨兵」而不是「把这行删掉」，是为了保住与 A/B/C 同款的运行时哨兵：
 *    `__MUT_PAGE_DROP === true` 才作数 —— 否则会掉进「变异体从未执行 ⇒ 上面的『必报通过』
 *    不作数」那个坑（判据里已有这条防线）。
 */
const MUT_PAGE_DROP = {
  from: '{ keepAuthState: true },',
  to: '((globalThis.__MUT_PAGE_DROP = true), {}),',
};
/**
 * 必报 E 的变异针（「**修过头**」方向 —— 原先只能手动打的那一针，本轮收编）：
 *    把主路径 `fetchPage` 的 `fetchOrders(...)` 也挂上 `keepAuthState`
 *    ⇒ 真正 token 失效时**主路径也不清态** ⇒ 判据 ① 必须报错（合法清态次数归 0）。
 *
 * ⚠️ 与 A/B/D 不是同一个方向：那三针验「判据 ② 抓得住踩踏」，E 验「判据 ① 抓得住过度修复」。
 *    少掉 E，判据 ① 就是一条谁也没见过它红的判据。
 *
 * ⚠️ 锚点是**两行**（`pageSize: PAGE_SIZE,` + `}),`），比单 token 脆 —— 但它的失败形态是
 *    「命中 0 ⇒ `writeMutant` 抛错 ⇒ 门禁红 ⇒ 逼人更新针」，**不是静默放行**，所以可接受。
 *    代价是：将来 `fetchPage` 被 prettier 重排时要同步改这里。
 *    ⛔ 绝不许为了「好写」放宽成「命中 0 也放行」——那等于把自证整条拆掉。
 *    命中数应为 1（`loadCounts` 用的是 `pageSize: 1`，不会撞）。
 */
const MUT_PAGE_OVER = {
  from: '      pageSize: PAGE_SIZE,\n    }),',
  to: '      pageSize: PAGE_SIZE,\n    }, { keepAuthState: (globalThis.__MUT_PAGE_OVER = true, true) }),',
};
const REQUEST_TS = join(SRC, 'api', 'request.ts');

/**
 * 写变异体；**没命中就抛**（变异失效 ≡ 自证失效，不许静默放行）
 *
 * @param needles 可以是一**组**针（`dropAll` 要一次改多处）。`needle.expect` 给了就
 *                必须恰好命中这么多处 —— 防止「针打进注释 / 打进别的同名调用」这种
 *                **命中数变多**的失效形态（只判「命中 0」挡不住它）。
 */
function writeMutants(srcAbs, needles, outAbs) {
  let text = readFileSync(srcAbs, 'utf8');
  let total = 0;
  for (const needle of needles) {
    const n = text.split(needle.from).length - 1;
    if (n === 0) {
      throw new Error(
        `变异失效：${srcAbs} 里找不到 \`${needle.from}\` —— 源码形态已变，必须同步更新变异针，而不是放行`,
      );
    }
    if (needle.expect != null && n !== needle.expect) {
      throw new Error(
        `变异命中数异常：${srcAbs} 里 \`${needle.from}\` 命中 ${n} 处（预期 ${needle.expect} 处）` +
          ` —— 多半是打进注释或撞上同名调用，必须同步更新变异针，而不是放行`,
      );
    }
    text = text.split(needle.from).join(needle.to);
    total += n;
  }
  writeFileSync(outAbs, text);
  return total;
}

function writeMutant(srcAbs, needle, outAbs) {
  return writeMutants(srcAbs, [needle], outAbs);
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(PAGE)) {
    console.error(`❌ 找不到被测页面：${PAGE}`);
    return 2;
  }
  for (const p of PAGES) {
    if (!existsSync(p.file)) {
      console.error(`❌ 找不到被测页面（多页登记 ${p.id}）：${p.file}`);
      return 2;
    }
  }

  const t0 = Date.now();
  const baseCfg = { t0, loginDelay: TIMING.login };
  const leakCfg = {
    ...baseCfg,
    validToken: TOKEN_NEW,
    okDelay: () => TIMING.okAll,
    badDelay: (url) => (isList(url) ? TIMING.listBad : TIMING.countBad),
    holdStale: true,
  };
  // 真拒场景：主路径 40ms 就成功（⇒ 不再触发重登），120ms 服务端作废，旁路 300ms 才回
  const trCfg = {
    ...baseCfg,
    validToken: TOKEN_OLD,
    okDelay: (url) => (isList(url) ? TIMING.okAll : TIMING.countBad),
    badDelay: () => TIMING.okAll,
    holdStale: false,
    revokeAt: TIMING.revokeAfter,
  };

  const want = ['leak', 'ok', 'truereject']; // 固定全跑；无单场景开关（见文件头）
  const results = [];
  const mutants = [];
  const tmpDirs = [];

  let realBundle = null;
  try {
    realBundle = await ensureBundle();
    tmpDirs.push(dirname(realBundle));
  } catch (e) {
    console.error(`❌ ${e.message}`);
    return 2;
  }

  try {
    if (want.includes('leak')) results.push(await runLeak(leakCfg, realBundle));
    if (want.includes('ok')) {
      results.push(
        await runOk(
          {
            ...baseCfg,
            validToken: TOKEN_OLD,
            okDelay: () => TIMING.okAll,
            badDelay: () => TIMING.okAll,
          },
          realBundle,
        ),
      );
    }

    if (want.includes('truereject')) results.push(await runTrueReject(trCfg, realBundle));

    // ⚠️ 必报（变异）样本**只在真源码本身达标时才需要**：真源码已经在踩踏 ⇒ 结论明确，
    //    此时再造变异体必然失败（开关已不在源码里 ⇒ 变异针找不到），反而会盖掉真正的结论。
    const realLeak = results.find((r) => r.scenario === 'leak');
    const realClean = !realLeak || (realLeak.bad.length === 0 && realLeak.noSample.length === 0);
    // 判据 ④ 单独算：真拒场景若真源码已红，也不必再造必报 C
    const realTr = results.find((r) => r.scenario === 'truereject');
    const realTrClean = !realTr || (realTr.bad.length === 0 && realTr.noSample.length === 0);
    if (!realClean) {
      line('');
      line('（真源码已不达标 ⇒ 跳过必报变异样本：结论已经明确，判据显然有牙齿）');
    }

    if (realClean) {
      // 必报 A：页面侧开关关闭（≡ 修复前：旁路照样裸调）
      const mutDir = mkdtempSync(join(tmpdir(), 'abox-mp-mut-'));
      tmpDirs.push(mutDir);
      const nPage = writeMutant(PAGE, MUT_PAGE, join(mutDir, 'page-mutant.vue'));
      globalThis.__MUT_PAGE = false;
      const bundleA = await ensureBundle({ page: join(mutDir, 'page-mutant.vue') });
      tmpDirs.push(dirname(bundleA));
      mutants.push({
        name: `必报 A · 页面侧 \`keepAuthState\` 关闭（${nPage} 处）`,
        r: await runLeak(leakCfg, bundleA),
        sentinel: () => globalThis.__MUT_PAGE === true,
      });

      // 必报 B：请求层守卫摘除（≡ 无条件清态）
      const nReq = writeMutant(REQUEST_TS, MUT_REQ, join(mutDir, 'request-mutant.ts'));
      globalThis.__MUT_REQ = false;
      const bundleB = await ensureBundle({
        override: { [REQUEST_TS]: join(mutDir, 'request-mutant.ts') },
      });
      tmpDirs.push(dirname(bundleB));
      mutants.push({
        name: `必报 B · 请求层守卫摘除（${nReq} 处）`,
        r: await runLeak(leakCfg, bundleB),
        sentinel: () => globalThis.__MUT_REQ === true,
      });

      // 必报 D（原 R3 手动针的收编）：页面侧**整段不传** `keepAuthState`
      //    ≡ 有人把这 4 个并发裸调复制到别处时忘带开关。
      //    ⚠️ A 的变异针 `from` 就是 `'{ keepAuthState: true },'`，在「整段不存在」的形态下
      //    零命中 ⇒ 只能抛「变异失效」，**证明不了判据 ② 抓得住这种回归**。故必须单列这一针。
      const nDrop = writeMutant(PAGE, MUT_PAGE_DROP, join(mutDir, 'page-drop.vue'));
      globalThis.__MUT_PAGE_DROP = false;
      const bundleD = await ensureBundle({ page: join(mutDir, 'page-drop.vue') });
      tmpDirs.push(dirname(bundleD));
      mutants.push({
        name: `必报 D · 页面侧整段不传 \`keepAuthState\`（${nDrop} 处）≡ 复制时忘带开关`,
        r: await runLeak(leakCfg, bundleD),
        sentinel: () => globalThis.__MUT_PAGE_DROP === true,
      });

      // 必报 E（**修过头**方向）：主路径 `fetchPage` 的 `fetchOrders(...)` 也挂上 `keepAuthState`
      //    ⇒ 真 token 失效时主路径也不清态 ⇒ 判据 ① 必须报错（合法清态次数归 0）。
      //    ⚠️ 与 A/B/D 不同向：那三针验判据 ②，E 验判据 ①。少掉 E，判据 ① 就是一条
      //    「谁也没见过它红」的判据。
      const nOver = writeMutant(PAGE, MUT_PAGE_OVER, join(mutDir, 'page-over.vue'));
      globalThis.__MUT_PAGE_OVER = false;
      const bundleE = await ensureBundle({ page: join(mutDir, 'page-over.vue') });
      tmpDirs.push(dirname(bundleE));
      mutants.push({
        kind: 'over',
        name: `必报 E · 主路径也挂 \`keepAuthState\`（${nOver} 处）⇒ 修过头`,
        r: await runLeak(leakCfg, bundleE),
        sentinel: () => globalThis.__MUT_PAGE_OVER === true,
      });

      // 必报 C：把**唯一**清态点（`api/request.ts:208`）也摘掉 ⇒ 真拒后无人清态
      //    ⚠️ 这一针是判据 ④ 的牙齿：没有它，④ 就是一条谁也没见过它红的判据。
      if (realTrClean) {
        const nReq2 = writeMutant(REQUEST_TS, MUT_REQ2, join(mutDir, 'request-noclear.ts'));
        globalThis.__MUT_REQ2 = false;
        const bundleC = await ensureBundle({
          override: { [REQUEST_TS]: join(mutDir, 'request-noclear.ts') },
        });
        tmpDirs.push(dirname(bundleC));
        mutants.push({
          kind: 'noclear',
          name: `必报 C · 摘掉唯一清态点（${nReq2} 处）⇒ 真拒后无人清态`,
          r: await runTrueReject(trCfg, bundleC),
          sentinel: () => globalThis.__MUT_REQ2 === true,
        });
      }
    }

    // ── 多页登记（`PAGES`）：每页一套「真源码 + 全删针 + 只删一处针」──────────
    //    ⚠️ 与上面 order-list 的 A/B/C/D/E **互不替代**：那五针守的是「**本页重登**换发」，
    //    这两针守的是「**在飞期间 token 到期**」的齐射。缺了 F/G，mine 那 5 个位点
    //    就是零覆盖（实测过）。
    const salvoReal = [];
    for (const p of PAGES) {
      const bundle = await ensureBundle({ page: p.file });
      tmpDirs.push(dirname(bundle));
      const r = await runSalvo(p, bundle);
      salvoReal.push(r);
      results.push(r);
    }

    for (let i = 0; i < PAGES.length; i += 1) {
      const p = PAGES[i];
      const real = salvoReal[i];
      // 真源码本身已经不达标 ⇒ 结论明确，再造变异体反而会盖住它（且变异针会找不到）
      if (real.bad.length || real.noSample.length) {
        line('');
        line(
          `（${p.id} 真源码已不达标 ⇒ 跳过它的必报变异样本：结论已经明确，判据显然有牙齿）`,
        );
        continue;
      }

      const mutDir = mkdtempSync(join(tmpdir(), `abox-mp-mut-${p.id}-`));
      tmpDirs.push(mutDir);

      // 必报 F：全删该页所有位点的开关（≡ 把 (c) 的修复整体退回去）
      const nAll = writeMutants(p.file, p.dropAll, join(mutDir, 'drop-all.vue'));
      globalThis[p.sentinelAll] = false;
      const bundleAll = await ensureBundle({ page: join(mutDir, 'drop-all.vue') });
      tmpDirs.push(dirname(bundleAll));
      mutants.push({
        name: `必报 F·${p.id} · 全删 ${nAll} 处 \`keepAuthState\`（≡ 把修复整体退回）`,
        r: await runSalvo(p, bundleAll),
        sentinel: () => globalThis[p.sentinelAll] === true,
      });

      // 必报 G：**只删一处** —— 逐腿判别能力的证明。
      //   F 只证明「整体退回去会被抓」；若某条腿压根没被判别（旧的 SUPPORT 腿就是），
      //   删它那一处 F 也照样红 ⇒ 看不出那条腿是瞎的。G 专治这种假绿。
      const nOne = writeMutants(p.file, [p.dropOne.needle], join(mutDir, 'drop-one.vue'));
      globalThis[p.sentinelOne] = false;
      const bundleOne = await ensureBundle({ page: join(mutDir, 'drop-one.vue') });
      tmpDirs.push(dirname(bundleOne));
      mutants.push({
        name: `必报 G·${p.id} · 只删 ${p.dropOne.label}（${nOne} 处）⇒ 逐腿判别能力的证明`,
        r: await runSalvo(p, bundleOne),
        sentinel: () => globalThis[p.sentinelOne] === true,
      });
    }
  } catch (e) {
    console.error(`❌ 场景执行失败（判据未真正跑完）：${e.message}`);
    return 1;
  } finally {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响判据，忽略 */
      }
    }
  }

  let bad_ = 0;
  for (const r of results) {
    line('');
    line(`═══ scenario=${r.scenario} ═══`);
    line(`  ${r.desc}`);
    for (const [k, v] of Object.entries(r.samples)) line(`    ${k}: ${v}`);
    if (r.bad.length) {
      bad_ += r.bad.length;
      for (const b of r.bad) line(`    ❌ ${b}`);
      // 失败时把事件流水全量打出：定位只看结论是没法复现的
      line('    事件流水（→发出 / ←响应[携带token] / TOKEN 读写）：');
      for (const e of timelineOf(r.sink)) line(`      ${e}`);
    } else if (r.scenario.startsWith('salvo:')) {
      line(`    ✅ 齐射不踩踏 · 主路径清态 1 次 · 全部旁路腿均已判别（${r.samples.已判别腿}）`);
    } else {
      line('    ✅ 三条不变量全部满足');
    }
    if (r.noSample.length) {
      bad_ += r.noSample.length;
      line('');
      line(`    ❌ instrumentation broken：样本为 0，判据并未真正执行：${r.noSample.join(' / ')}`);
      line('       —— 这种情况一律按未达标处理，不许给 pass');
      // 样本没造出来时同样要打流水：「哪条腿没发 / 主路径拿到了什么」只能从流水里读出来
      line('    事件流水（→发出 / ←响应[携带token] / TOKEN 读写）：');
      for (const e of timelineOf(r.sink)) line(`      ${e}`);
    }
  }

  // 必报（变异）样本：**必须被报出踩踏**，报不出 = 判据没有牙齿 = 检查器不可用
  for (const m of mutants) {
    line('');
    line(`═══ ${m.name} ═══`);
    if (m.kind === 'over') {
      // 判据 ① 的必报：主路径也被豁免 ⇒ 合法清态归 0，且判据必须把它报出来（bad 非空）
      line(`  主路径合法清态: ${m.r.legitN} 次（必须 0 —— 主路径也被豁免了，没人清态）`);
      const ok = m.r.legitN === 0 && m.r.bad.length > 0;
      if (!ok) {
        bad_ += 1;
        line('    ❌ 必报样本**没有**被报出 —— 判据 ① 已失效（不许记通过）');
        line(`       合法清态 ${m.r.legitN} 次 / 报出项 ${m.r.bad.length} 条`);
        line('    事件流水（→发出 / ←响应[携带token] / TOKEN 读写）：');
        for (const e of timelineOf(m.r.sink)) line(`      ${e}`);
      } else {
        line('    ✅ 判据有牙齿（修过头会被抓住）');
      }
    } else if (m.kind === 'noclear') {
      // 判据 ④ 的必报：变异后**无人清态**，且判据必须把它报出来（bad 非空）
      line(`  真拒后清态: ${m.r.clearsN} 次（必须 0 —— 唯一清态点已被摘掉）`);
      const ok = m.r.clearsN === 0 && m.r.bad.length > 0;
      if (!ok) {
        bad_ += 1;
        line('    ❌ 必报样本**没有**被报出 —— 判据 ④ 已失效（不许记通过）');
        line(`       清态 ${m.r.clearsN} 次 / 报出项 ${m.r.bad.length} 条`);
        line('    事件流水（→发出 / ←响应[携带token] / TOKEN 读写）：');
        for (const e of timelineOf(m.r.sink)) line(`      ${e}`);
      } else {
        line('    ✅ 判据有牙齿（真拒后无人清态会被抓住）');
      }
    } else {
      line(`  踩踏式清态: ${m.r.staleN} 次（必须 ≥1 —— 报不出说明判据抓不到回归）`);
      if (m.r.staleN < 1) {
        bad_ += 1;
        line('    ❌ 必报样本**没有**被报出 —— 判据已失效（不许记通过）');
        line('    事件流水（→发出 / ←响应[携带token] / TOKEN 读写）：');
        for (const e of timelineOf(m.r.sink)) line(`      ${e}`);
      } else {
        line('    ✅ 判据有牙齿（回归会被抓住）');
      }
    }
    // ⭐ 哨兵：变异体必须**真的被执行**（防「变异打进注释 / 打进没被采纳的那份模块」）
    if (!m.sentinel()) {
      bad_ += 1;
      line('    ❌ 变异体从未被执行（哨兵未触发）—— 上面的「必报通过」不作数');
    }
  }

  line('');
  line(`${bad_ === 0 ? '✅ 全部通过' : `❌ 共 ${bad_} 项未达标`}`);
  return bad_ === 0 ? 0 : 1;
}

process.exit(await main());

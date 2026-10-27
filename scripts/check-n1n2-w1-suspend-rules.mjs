#!/usr/bin/env node
/**
 * N1 / N2 / W1 · 楼宇停用与一键停售 —— 静态约束门禁
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * N1 的根因是「同一件事四处理述」（U1 / U6 / 团长工作台 / 管家端），N2 是「停用零校验」，
 * W1 是净新增。三者的共同点：**规则写在文档里，没人执行就会被悄悄绕过**。
 * 典型失效方式：
 *   · 只在 U6 补了判据、U1 没补 ⇒ 「首页能点、下单报错」；
 *   · 管家端顺手调了用户端那个函数 ⇒ 夜间 KPI 把「过了截单」误报成配置缺口；
 *   · 未完结订单用 6 态白名单 ⇒ 不报错、不崩溃、悄悄少拦 `refund_applying` / `refunding`；
 *   · 停售走 `ab_config` ⇒ 60s TTL 缓存让「点了停售还在收单」。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────────
 *   N1-1  orderability.ts 导出三个符号（evaluateStructure / evaluateAvailability / REASON_TEXT）
 *   N1-2  纯函数零 IO：文件内不得出现 await / new Date( / Repository
 *   N1-3  U1 / U6 / 团长工作台三处都必须调用用户端谓词（编排层）
 *   N1-3b 管家端**只得**调 evaluateStructure，不得调 evaluateAvailability（函数级边界）
 *   N1-4  三处各自体内不得再内联 `status === BuildingStatus.ACTIVE &&` 合取
 *   N1-5  REASON_TEXT 必须是查表（Record），且 not_open_yet / cutoff 留空串防忘插值
 *   N1-6  building_preparing 与 building_suspended 文案逐字不同
 *   N1-7  order.service 不得再用 NOT_FOUND 承担「楼未归群」语义 → 应走 60011
 *   N1-8  结构层求值全序 building_not_grouped → preparing → suspended → group_suspended
 *   W1-8  sales_paused 必须在 evaluateAvailability 中**最先**判（严格优先于截单）
 *   N1-9  assignMembers 与 updateBuilding 归群分支必须查目标楼群状态 → 60008
 *   N2-1  停用统计块内不得硬编码 OrderStatus.X 字面量（必须黑名单反算）
 *   N2-2  必须引用 ORDER_TERMINAL_STATUS（证明是反算）
 *   N2-3  时间边界必须出现 todayBj()（A 组唯一反死锁机制）
 *   N2-8   A/B 分组必须从常量派生，不得 `OrderStatus.X || OrderStatus.Y || ...` 长串
 *   N2-10 阈值必须读 building.suspend_force_max_count，不得硬编码
 *   N2-11 两个 building.* 键登记进 config.specs.ts 且 wiring: 'live'
 *   N2-12 BizConfigService 有对应 reader 且缺省值 20 / 10
 *   W1-1  SalesPause 实体存在且多词列显式写 name:
 *   W1-2  ALL_ENTITIES 含 SalesPause
 *   W1-3  存在迁移 1700000000019-sales-pause.ts
 *   W1-4  config.specs.ts 不得出现任何停售键（防把 config 路线加回来）
 *   W1-5  OrderAvailabilityService 内不得出现任何缓存（直读 DB）
 *   W1-6  停售路径严禁批量取消/退款标识符
 *   W1-7  条件护栏：有缓存 ⇒ 必须有 fail-open（守「会随时间退化的不变量」）
 *   ERR-1 八个新错误码 60006–60013 在 enum 登记
 *   ERR-2 八个新错误码在 ERROR_MESSAGE 成对登记
 *   N1-10 结构层第 1 条必须同时覆盖三个「不存在」（三个字段全用 === null）
 *   N1-11 文案单一出口：编排层不得直接索引 REASON_TEXT[
 *   N1-12 reasonText 必须对 not_open_yet / cutoff 插值（两键表里是空串）
 *   N1-13 resolveGroup() 三处出口各归各位（1619 保留 / 1624 20016 / 1628 60011）
 *   N1-14 编排层查楼 / 楼群必须带 deletedAt: IsNull()
 *   N1-15 编排层只许调 reasonText()（reasonTextOf / toBjIso / REASON_TEXT[ 命中 0）
 *   N1-16 ★「楼状态 ∧ 已归群」的内联合取在 building-admin.service.ts 内命中数必须为 0
 *   N1-17 管家端类型不得再用 canOrder（admin-web api 剥注释后命中 0）
 *   N1-19 ★ 模板里访问改名后的字段必须走 asRow()（el-table 插槽 row 逃逸类型检查）
 *   N1-18 Swagger / 接口规范不得再把管家端字段**定义**成 canOrder
 *   DOC-1 ★ 反向判据：历史测试报告必须保留旧字段名 canOrder（不得回改历史结论）
 *
 * ⚠️ ** §C.2 那 10 条「静态管不到」的一条都不在列**（并发 / 跨零点 / 支付回调竞态 /
 *    定时任务是否冻结 / soldCount / 通知真发了吗 / 三端同时一致 / 结果集形状 /
 *    停售立刻生效 / 前端 forceSuspend 默认值）—— 它们必须连库跑，写进静态脚本就是
 *    买个永远亮绿灯的红绿灯。
 *
 * ── 自证（必做：恒绿或恒红的检查等于没有检查）─────────────────────────────────
 * 每条判据配 `mutate`：破坏它守的那处表述，断言 `pred(mutate(x)) === false`。
 *
 * ⚠️ **本文件不同于 `check-d3-withdraw-rules.mjs` 的地方**：那一份的目标**全部已实现**，
 *    故「必不报」样本天然可以用真实文件。本批是**边写边查**——2026-10-26 探测时
 *    `orderability.ts` 已落地但尚无任何调用方，错误码与 `building.*` 也还没登记，
 *    大量判据在真文件上**本来就该是红的**。若照搬 `pred(real) === true` 会让自证全崩，
 *    也会掩盖「这条现在是红的」这件真实信息。故本脚本把「必不报样本」分两类并**显式标注**：
 *
 *      [REAL]  good 样本 = 仓库里真实且未改动的原文
 *      [SYNTH] good 样本 = 尚未写出的落码目标形态（文件不存在或规则尚未满足）
 *
 *    两者同样证明「必报的报得出」（这是自证的真正目的），但只有 [REAL] 证明
 *    「必不报的不报」。Phase 3 收口后应让 [SYNTH] 全部退化为 [REAL]。
 *
 * 退出码：0 通过 · 1 有违规 · 2 自证失败（检查器自身不可信）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'apps', 'api-server', 'src');
const PKG = join(ROOT, 'packages', 'shared-types', 'src');

const F = {
  orderability: join(SRC, 'common', 'utils', 'orderability.ts'),
  availability: join(SRC, 'common', 'services', 'order-availability.service.ts'),
  meal: join(SRC, 'modules', 'meal', 'meal.service.ts'),
  order: join(SRC, 'modules', 'order', 'order.service.ts'),
  workbench: join(SRC, 'modules', 'team-leader', 'workbench.service.ts'),
  buildingAdmin: join(SRC, 'modules', 'building', 'building-admin.service.ts'),
  // T5（2026-10-27）：N2 停用闸门与存量通知从 `building-admin.service.ts` 拆出，
  //   判据**跟着真源走**（钉在原文件会因「产物变好」而假红 —— 本批第 5 次同类）
  buildingSuspend: join(SRC, 'modules', 'building', 'building-suspend.service.ts'),
  // T5 第三步（2026-10-27）：读侧四视图 + `loadContext` 再拆出去。
  //   ⚠️ 与上面同一条规矩：**判据跟着真源走**，不放宽、不删除。
  buildingQuery: join(SRC, 'modules', 'building', 'building-query.service.ts'),
  // ⚠️ **本条路径是「按语义扫」扫出来的第三份**（Team Lead 2026-10-26 指出）：
  //    发现时 `meal.service` / `order.service` 已在 P3-4 改为 60011，唯独这里仍是 10004，
  //    而我们的判据只盯了前两个文件 —— 因为我们**按「已知文件清单」扫**，
  //    而不是按「这个语义会出现在哪」扫。见 `scanHits()` 注释。
  //    （当日 21:47 后端已修，三处抛点统一 `BUILDING_NOT_GROUPED`；判据留着守回归。）
  traceability: join(SRC, 'modules', 'traceability', 'traceability.service.ts'),
  errCode: join(SRC, 'common', 'constants', 'error-code.ts'),
  specs: join(SRC, 'modules', 'admin', 'config', 'config.specs.ts'),
  bizConfig: join(SRC, 'common', 'services', 'biz-config.service.ts'),
  systemEntity: join(SRC, 'database', 'entities', 'system.entity.ts'),
  entitiesIndex: join(SRC, 'database', 'entities', 'index.ts'),
  orderStatus: join(PKG, 'enums', 'order-status.ts'),
  // 改名 / 文档一致性面（canOrder → canAssign）
  buildingAdminController: join(SRC, 'modules', 'building', 'building-admin.controller.ts'),
  // P3-5 抽出的停用闸门纯函数（谓词 + A/B 分组 + 决策 + 错误码 + hint）
  suspendGate: join(SRC, 'common', 'utils', 'suspend-gate.ts'),
  // ⚠️ admin-web 侧的路径在 `apps/api-server` 之外，故用 ROOT 而非 SRC
  adminBuildingApi: join(ROOT, 'apps', 'admin-web', 'src', 'api', 'building.ts'),
  // ⚠️ `.vue` 文件：`stripComments()` 按 `'` / `"` / `` ` `` 判字符串，模板属性里的引号是配对的，
  //    可安全剥离；但 `<template>` 标签内的中文正文**不含**这些引号，不受影响。
  leaderBindingVue: join(
    ROOT,
    'apps',
    'admin-web',
    'src',
    'views',
    'building',
    'leader-binding.vue',
  ),
  apiSpec: join(ROOT, 'docs', 'ABox一盒接口规范v1.0.md'),
  historyReport: join(ROOT, 'docs', 'ABox一盒深度测试第二轮报告v1.0.md'),
  // ── W1 呈现层（v2.5 新增）────────────────────────────────────────────────
  // ⚠️ 小程序真实路径是 `apps/miniprogram/src/pages/...`（**有 `src/` 一层**）。
  //    Team Lead 派单里写的 `apps/miniprogram/pages/index/index.vue` 不存在 ——
  //    本批第四次「消息里的路径 grep 不到」。判据一律按 `src/` 下的真实路径取。
  salesPauseVue: join(ROOT, 'apps', 'admin-web', 'src', 'views', 'system', 'sales-pause.vue'),
  orderCreateVue: join(
    ROOT,
    'apps',
    'miniprogram',
    'src',
    'pages',
    'order-create',
    'order-create.vue',
  ),
  tplSpecs: join(SRC, 'modules', 'admin', 'template', 'message-template.specs.ts'),
  salesPauseService: join(SRC, 'modules', 'admin', 'sales-pause', 'sales-pause.service.ts'),
  salesPauseController: join(SRC, 'modules', 'admin', 'sales-pause', 'sales-pause.controller.ts'),
};
const MP = join(ROOT, 'apps', 'miniprogram', 'src');

/**
 * N1-26 的「专属分支白名单」—— 端上唯一允许为某个错误码硬编码中文的地方。
 *
 * ⚠️ **每条必须带 `why`**：判定标准是「这个码用户能不能**自己解决**」，
 *    而这是**语义判断，机械判据做不了**。白名单的作用不是放行，是逼每一个想往里
 *    加码的人**先把那个问题的答案写出来** —— 登记动作本身就是那句「要加就先问」。
 *
 * ⚠️ **按常量名匹配，不按码值**：按码值匹配 ⇒ 端上写裸数字 `err.code === 20016`
 *    也能绕过，口子只是换了个位置（前端提示，已采纳）。
 */
const EXCLUSIVE_BRANCH_ALLOWLIST = [
  {
    name: 'CODE_BUILDING_UNBOUND',
    why: '用户能**自己解决**（去「我的」重选一栋楼）⇒ 才配专属分支；且服务端 message 是给运营看的口径，直接呈现反而看不懂',
  },
];

// ── 工具：照抄 check-d3-withdraw-rules.mjs ──────────────────────────────────
/** 剥离注释（保留字符串字面量）⚠️ 不简化处理正则字面量：受检文件确认不含 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let mode = 'code'; // code | line | block | sq | dq | tpl
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') {
        mode = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && n === '*') {
        mode = 'block';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        mode = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl';
        out += c;
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += c;
      }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    out += c;
    if (c === '\\') {
      out += src[i + 1] ?? '';
      i += 2;
      continue;
    }
    const end = mode === 'sq' ? "'" : mode === 'dq' ? '"' : '`';
    if (c === end) mode = 'code';
    i += 1;
  }
  return out;
}

/**
 * 从 startMark 起按花括号配平取块
 *
 * ⚠️ **2026-10-26 修过一个「判据被正确产物弄瞎」的缺陷**，根因就在这三行：
 *
 *     const open = text.indexOf('{', i);   // ← 病根
 *
 *    `resolveGroup` 的返回类型从 `Promise<number>` 改成
 *    `Promise<{ building: Building; groupId: number }>`（本批**必需**的修复：
 *    要把 `building.status` 喂给可订性判定）之后，`indexOf('{')` 命中的是**返回类型泛型里**
 *    那个花括号 —— 于是 `depth` 在 `number }` 处归零，取到的「函数体」是
 *    `async resolveGroup(user: User): Promise<{ building: Building; groupId: number }`，
 *    **函数体一个字符都没有**。
 *
 *    ⇒ 这一类失效最阴的地方：判据**不会报错**，它只会安静地返回「不合」，看起来就像
 *      产物没做对。且 `!NOT_FOUND.test('')` 恒真 ⇒ 四条合取里还有一条是**假的绿** ——
 *      一次失配同时制造了假红与假绿。
 *
 * ⇒ 修法：先跳过参数列表（圆括号配对），再跳过返回类型（泛型 `<...>` 内的 `{` 不算），
 *    之后才认函数体起点。
 *
 * ⚠️ **`=>` 必须当成一个整体跳过**：否则 `Promise<(x: number) => { y: 1 }>` 里
 *    箭头那个 `>` 会把 `gen` 提前减到 0，紧随其后的 `{` 就被误当成函数体起点。
 *    （下面 `HELPER_CHECKS` 第 3 条专门守这个形状。）
 *
 * ⚠️ 仍然存在的已知边界：参数列表里的字符串若含未配对的 `)`，圆括号配对会偏移。
 *    受检文件经 grep 确认不含此类写法；真出现了会由 `HELPER_CHECKS` 之外的判据自证暴露
 *    （取块为空 ⇒ 判据恒红 ⇒ 一眼可见），不会静默。
 */
function blockOf(text, startMark) {
  const i = text.indexOf(startMark);
  if (i < 0) return '';

  // ① 跳过参数列表（圆括号配对）
  let k = text.indexOf('(', i + startMark.length - 1);
  if (k < 0) return '';
  let paren = 0;
  for (; k < text.length; k += 1) {
    if (text[k] === '(') paren += 1;
    else if (text[k] === ')') {
      paren -= 1;
      if (paren === 0) {
        k += 1;
        break;
      }
    }
  }

  // ② 跳过返回类型，定位函数体的 `{`
  let gen = 0;
  let open = -1;
  for (let j = k; j < text.length; j += 1) {
    const c = text[j];
    if (c === '=' && text[j + 1] === '>') {
      j += 1; // `=>` 整体跳过，不让它的 `>` 去减 gen
      continue;
    }
    if (c === '<') gen += 1;
    else if (c === '>') {
      if (gen > 0) gen -= 1;
    } else if (c === '{' && gen === 0) {
      open = j;
      break;
    }
  }
  if (open < 0) return '';

  let depth = 0;
  for (let j = open; j < text.length; j += 1) {
    if (text[j] === '{') depth += 1;
    else if (text[j] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return text.slice(i);
}

const methodOf = (text, name) => blockOf(text, `async ${name}(`);
const fnOf = (text, name) => blockOf(text, `function ${name}(`);

/** 取 goto `label: 'x'` 所在对象块 */
function objBlockOf(text, label) {
  const i = text.indexOf(`label: '${label}'`);
  if (i < 0) return '';
  const start = text.lastIndexOf('{', i);
  let depth = 0;
  for (let j = start; j < text.length; j += 1) {
    if (text[j] === '{') depth += 1;
    else if (text[j] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  return '';
}

/** 按出现先后返回一组探针的下标（用于断言求值全序） */
function orderOf(text, marks) {
  return marks.map((m) => text.indexOf(m));
}
const isAscending = (idx) => idx.every((v, k) => v >= 0 && (k === 0 || v > idx[k - 1]));

/**
 * **全仓按语义扫描**：返回所有含 `needle` 的命中点及其上下文。
 *
 * ⚠️ **为什么必须有这个工具 —— 本批最贵的一条教训**：
 *
 *    `traceability.service.ts` 里那个以 `!building.buildingGroupId` 为条件的抛点，
 *    一度仍抛 `10004`，是「楼未归群」这个语义的**第三条路径**，
 *    而我们 39 条判据没有一条盯它。
 *
 *    漏的原因不是懒，是**取数方式**：我们都是
 *
 *        「先想出一份『涉及到的文件清单』，再去清单里找」
 *
 *    前者只能找到清单里已有的东西 —— **清单外的第三、第四条路径永远找不到**。
 *    而「楼未归群」这种横切语义，天然会散落在任何一处查楼的编排层里，
 *    清单法对它结构性失效。
 *
 *    ⇒ 改为：**先 grep 旧文案字面，按命中点列清单，再逐点判；不要从既有接线点倒推。**
 *
 * ⚠️ `needle` 是**正则**，允许写成 `未配置楼群|暂未开通服务` 覆盖「文案正在改名」的
 *    过渡期，避免「收尾批一改文案，判据就因为扫不到东西而恒绿」。
 *
 * ⚠️ **空命中必须判红**，不能靠 `every()`：`[].every(...)` 恒为 true，
 *    「一个都没扫到」会被当成「全都满足」—— 这恰恰是最需要报警的那一档
 *    （要么是文案被改掉了判据没跟上，要么是文件被整个删了）。
 *    本脚本在 `HELPER_CHECKS` 里专门守这一条。
 */
function scanHits(rootDir, needle, { radius = 120, ext = /\.ts$/ } = {}) {
  const re = new RegExp(needle, 'g');
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (/^(node_modules|dist|__tests__|\..+)$/.test(e.name)) continue;
        walk(p);
      } else if (ext.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)) {
        const text = readFileSync(p, 'utf8');
        const lines = text.split('\n');
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          const lineNo = text.slice(0, m.index).split('\n').length;
          const lineText = lines[lineNo - 1] ?? '';
          // `fwd`：**命中点之后**的最近一个 `throw` 语句。
          //    ⚠️ 为什么需要「往后看」：「楼未归群」的语义锚点是**条件**（`if (!x.buildingGroupId)`），
          //    抛点在条件**之后**。只提供「往前回扫」的 `stmt` 时，命中点在条件行，
          //    回扫会抓到**上一个**抛点（traceability 里就是 `:282` 那个合法的
          //    「办公楼不存在 10004」）—— 又是一次「卷入邻居」。
          //    ⇒ **取数方向必须跟语义方向一致**：条件在前、抛点在后 ⇒ 往后取。
          let fw = text.indexOf('throw new', m.index);
          const fwEnd = fw >= 0 ? text.indexOf('\n', fw) : -1;
          // `stmt`：**命中点所在的 `throw` 语句**（按结构取数，不是按距离取数）
          //
          // ⚠️ **2026-10-26 变异自证抓出的缺陷**：首版按「字面 ±200 字」取窗口，
          //    判出 `traceability.service.ts:285` 不合。可我把它临时改对之后，**它还是红的**。
          //    查下去：`285` 上一行（`:282`）是
          //        `throw new BizException(ErrorCode.NOT_FOUND, \`办公楼 #${id} 不存在\`);`
          //    —— 那是一个**完全合法**的 10004（办公楼不存在，本就该是 10004），
          //    但它落在 ±200 字窗口里 ⇒ `!/NOT_FOUND/` 这条合取被邻居行带翻了。
          //
          //    ⇒ **按距离取窗口会把邻居行上的合法代码卷进来**。判据要的是
          //      「这一处抛点用的是哪个码」，那就必须取**这一个抛语句**，
          //      而不是「以字面为圆心的一个字符圆」。见 AC §C.3 第 7 条。
          let from = text.lastIndexOf('throw new', m.index);
          if (from >= 0 && m.index - from > 400) from = -1; // 隔太远 ⇒ 不是同一个语句
          const to = text.indexOf('\n', m.index);
          out.push({
            file: relative(ROOT, p).replaceAll('\\', '/'),
            line: lineNo,
            lineText: lineText.trim(),
            stmt: from >= 0 ? text.slice(from, to < 0 ? text.length : to) : lineText,
            fwd:
              fw >= 0 && fw - m.index <= 300 ? text.slice(fw, fwEnd < 0 ? text.length : fwEnd) : '',
            // `call`：**命中点所在的 `BizException(...)` 完整调用**（圆括号配对，**可跨行**）
            //
            // ⚠️ 为什么必须单列：首版 N1-24 用 `stmt`（回扫到 `throw new`、
            //    前扫到**行尾**）取调用，而 `order.service.ts:293` 那个 4 参调用是
            //    **跨行**的（`…, undefined, undefined, {` 换行到 `});`）⇒ 取到的是
            //    括号不平衡的半截 ⇒ `argsOf` 返回 null ⇒ 判红。
            //    ⇒ **「按行尾截断」是另一种按距离取数**：它假设语句不跨行，
            //      而这个假设对「带 payload 的调用」不成立。故改为圆括号配对。
            call: (() => {
              const key = 'BizException(';
              const bi = text.lastIndexOf(key, m.index);
              if (bi < 0 || m.index - bi > 400) return '';
              let d = 0;
              let inStr = null;
              for (let j = bi + key.length - 1; j < text.length; j += 1) {
                const c = text[j];
                if (inStr) {
                  if (c === '\\') j += 1;
                  else if (c === inStr) inStr = null;
                  continue;
                }
                if (c === "'" || c === '"' || c === '`') {
                  inStr = c;
                  continue;
                }
                if (c === '(') d += 1;
                else if (c === ')') {
                  d -= 1;
                  if (d === 0) return text.slice(bi, j + 1);
                }
              }
              return '';
            })(),
            // `blk`：**包围命中点的 `computed(...)` 块**（按结构取数）。
            //    ⚠️ 为什么需要它：N1-26 要判的是「同一个 computed 里、code 判定之后的
            //    那一支 return 有没有回落到服务端 message」。只看 `ctx`（±N 字）时，
            //    拿不到完整的 computed 边界 ⇒ 分不清「这一支是 code 已知的还是未知的」。
            //    ⇒ 又是一次「按距离取窗口不够，必须按结构取块」。
            //
            // ⚠️ **不能用 `blockOf(text.slice(ci), 'computed(')`** —— 首版这么写，
            //    结果 `blk` 全空。根因：`blockOf` 的圆括号配对从 `computed(` 那个 `(` 起算，
            //    而箭头函数 `() => {…}` 的 `()` 被当成**嵌套**计入 ⇒ 深度回到 0 的那一刻
            //    落在文件最末尾 ⇒ 取到的是「从 computed( 到文件结束」的整段。
            //    ⇒ `computed(` 的**参数**是「一个函数」，不是「一个参数列表」，
            //      `blockOf` 的假设（参数列表内无嵌套圆括号）对它不成立。
            //    ⇒ 直接用花括号配对即可：`computed(` 之后的第一个 `{` 就是函数体起点。
            //      （已知边界：`computed(() => ({ a: 1 }))` 这种返回值是对象字面量的写法
            //       会取到对象而非函数体；那种 computed 里没有 `return`，对本判据无影响。）
            blk: (() => {
              const ci = text.lastIndexOf('computed(', m.index);
              if (ci < 0 || m.index - ci > 800) return '';
              const after = text.slice(ci);
              const open = after.indexOf('{');
              if (open < 0) return '';
              // ⚠️ **表达式体的 computed 必须排除**：`computed(() => x.code === Y)`
              //    没有花括号，首个 `{` 落在**下一个** computed 上 ⇒ blk 把后面的代码整段吞掉
              //    ⇒ 判到别人的分支上去（首版把 `needsBuilding` 那个无花括号 computed
              //       判成不合，而它压根没有兜底分支）。
              //    ⇒ 判据：`;` 出现在 `{` 之前 ⇒ 这是表达式体 ⇒ 不是我们要判的形状。
              const semi = after.indexOf(';');
              if (semi >= 0 && semi < open) return '';
              let depth = 0;
              for (let j = open; j < after.length; j += 1) {
                if (after[j] === '{') depth += 1;
                else if (after[j] === '}') {
                  depth -= 1;
                  if (depth === 0) return after.slice(0, j + 1);
                }
              }
              return '';
            })(),
            // ⚠️ `isComment`：**按语义扫不等于把所有命中都算数**。
            //    首版 N1-7 没区分，7 处命中里 4 处报红，其中 3 处是误报 ——
            //    两处是**解释「为什么不能复用 10004」的说明注释**（`error-code.ts:107/530`，
            //    它们恰恰是本次要保留的正确文档），一处是 `orderability.ts` 的 `REASON_TEXT`。
            //    ⇒ 判据误报比漏报更伤：**误报一多，人就不会再看它。**
            isComment: /^\s*(\*|\/\/|\/\*)/.test(lineText),
            ctx: text.slice(Math.max(0, m.index - radius), m.index + radius),
          });
        }
      }
    }
  };
  walk(rootDir);
  return out;
}

/**
 * 自证用：把一个已知片段包成命中点。
 * ⚠️ `stmt` 与 `ctx` **必须分开给** —— 判据只看 `stmt`，`ctx` 专用来塞「邻居行干扰」。
 */
const ctxOf = (text, ctx) => ({
  file: '<sample>',
  line: 1,
  lineText: '',
  isComment: false,
  stmt: text,
  fwd: '',
  // ⚠️ 样本里的 `call` 要**就地派生**：判据改看 `call` 之后，
  //    若样本不填这个字段，自证会报 `good通过=false` —— 那是**样本**缺字段，不是判据错。
  call: /BizException\(/.test(text) ? text.slice(text.indexOf('BizException(')) : '',
  blk: '',
  ctx: ctx ?? text,
});
/** 自证用：包一个「条件在前、抛点在后」的命中点（`fwd` = 抛语句） */
const guardOf = (guard, throwStmt) => ({
  file: '<sample>',
  line: 1,
  lineText: guard,
  isComment: false,
  stmt: '',
  fwd: throwStmt,
  blk: '',
  ctx: `${guard}\n${throwStmt}`,
});
/** 自证用：包一个「含 code 判定的 computed」命中点（`blk` = computed 块） */
const blkOf = (block) => ({
  file: '<sample>',
  line: 1,
  lineText: '',
  isComment: false,
  stmt: '',
  fwd: '',
  blk: block,
  ctx: block,
});

/**
 * 取出 `new BizException(a, b, c, d)` 的**顶层**实参列表。
 *
 * ⚠️ 必须按括号深度切：`BizException(code, undefined, undefined, { a: 1, b: 2 })`
 *    里 payload 对象内部的逗号不是分隔符 —— 按 `split(',')` 切会把 payload 拆碎，
 *    于是「第二参数」取到 `{ a: 1` 这种东西，判据对着空气判。
 */
function argsOf(stmt) {
  const key = 'BizException(';
  const i = stmt.indexOf(key);
  if (i < 0) return null;
  const from = i + key.length;
  let depth = 1;
  let gen = 0;
  for (let j = from; j < stmt.length; j += 1) {
    const c = stmt[j];
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') depth -= 1;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return splitTopLevel(stmt.slice(from, j));
    } else if (c === '<') gen += 1;
    else if (c === '>' && gen > 0) gen -= 1;
  }
  return null;
}
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') depth -= 1;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/**
 * 取出「以 `!x.buildingGroupId` 为条件、紧跟其后抛异常」的那些命中点。
 *
 * ⚠️ **判据与 `detailOf()` 必须共用这一个函数**。首版我分别在 `pred` 和输出里各写一遍
 *    过滤条件，两边一旦漂移，就会出现「判据说红、输出说扫到了 3 处全好」这种自相矛盾
 *    —— 门禁一旦自相矛盾，人就只会相信自己肉眼看到的那一半。
 */
function guardedThrowsOf(hits) {
  return hits.filter(
    (h) =>
      !h.isComment &&
      /!\s*[\w?.]*buildingGroupId/.test(`${h.lineText ?? ''}\n${h.ctx ?? ''}`) &&
      /throw\s+new\s+BizException\s*\(/.test(h.fwd ?? ''),
  );
}

/**
 * N1-12 的一般式判据：`REASON_TEXT` 的「动态键」必须都有对应的插值分支。
 *
 * ⚠️ **把判据抽成具名函数，是为了让「当前真空的那一侧」也能被自证覆盖**：
 *    判据的**自证**只跑真文件，而侧 A（带 `{` 的键）当前**全仓无此形态** ⇒
 *    真文件跑一万次也证明不了侧 A 存在。⇒ 侧 A 的射程交给 `HELPER_CHECKS`
 *    里的专项样本验证（见那里），两侧共用这一个函数 ⇒ 不会「判据说一套、自证说一套」。
 *
 * 侧 A：值里带 `{占位符}` 的键 ⇒ 必须有 case，且该 case 必须真的插值（用到 `ctx.`）
 *       （缺了 ⇒ 走 `default: return REASON_TEXT[reason]` ⇒ 用户看到 `{reason}` 原文）
 * 侧 B：值是空串的键 ⇒ 必须有 case
 *       （缺了 ⇒ 用户收到空文案，而**空串是合法的 `string`，类型检查与构建全都不拦**）
 */
/**
 * N2-TPL-1 用：取出某个停用通知场景在 `message-template.specs.ts` 里的声明片段。
 *
 * ⚠️ **按结构取块，不按距离取窗口**：`scene:` 与它的 `seed.groupContent` 之间
 *    隔着 `label` / `audience` / `channels` / `trigger` / `variables` / 一大段 `note`
 *    ⇒ 距离不固定（fulfill 那份比 refund 那份多一段 `note`）。
 *    ⇒ 取「从 `scene: '<name>'` 到下一个 `scene: '` 或文件末尾」这段。
 */
function suspendSpecOf(text, scene) {
  const b = stripComments(text);
  const at = b.indexOf(`scene: '${scene}'`);
  if (at < 0) return null;
  const next = b.indexOf("\n    scene: '", at + 1);
  const seg = b.slice(at, next < 0 ? b.length : next);
  return {
    seg,
    content: seg.match(/groupContent:\s*'([^']*)'/)?.[1] ?? null,
    vars: seg.match(/variables:\s*\[([^\]]*)\]/)?.[1] ?? '',
  };
}

function reasonTextCoversDynamicKeys(text) {
  const b = stripComments(text);
  // ⚠️ 必须**先剥注释**：`not_open_yet: '', // 动态文案：今日 {HH:mm} 开团`
  //    那句注释里就有 `{HH:mm}` ⇒ 不剥会被当成「值里带占位符」⇒ 误判。
  const table = b.match(/REASON_TEXT[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1];
  if (!table) return false;
  const entries = [...table.matchAll(/^\s*([a-z_][\w]*):\s*'([^']*)'/gm)].map((m) => ({
    key: m[1],
    val: m[2],
  }));
  if (entries.length === 0) return false; // 取不到表 ⇒ 不妄判（与「表合规」区分开）
  const fn = fnOf(b, 'reasonText');
  if (!fn) return false;
  // ⚠️ **按结构切 case 块**：按「下一个 `case`」的**位置**切，不按字符串搜索 ——
  //    `case 'sales_paused': {` 后面跟的是 `{`，用 `split('case ')` 会把
  //    块内的注释/模板串一起卷进来（本批第 N 次「取数取到邻居」）。
  const marks = [...fn.matchAll(/\n\s*(?:case\s+'([a-z_][\w]*)'|default)\s*:/g)];
  const bodies = new Map();
  marks.forEach((m, i) => {
    if (!m[1]) return;
    const end = i + 1 < marks.length ? marks[i + 1].index : fn.length;
    bodies.set(m[1], fn.slice(m.index, end));
  });
  const sideA = entries
    .filter((e) => /\{[^}]*\}/.test(e.val))
    .every((e) => bodies.has(e.key) && /\bctx\./.test(bodies.get(e.key) ?? ''));
  const sideB = entries.filter((e) => e.val === '').every((e) => bodies.has(e.key));
  return sideA && sideB;
}

// ── 判据 ────────────────────────────────────────────────────────────────────
// file: 目标文件；pred 通过=true；mutate 破坏；sample: 尚未落地时的目标形态（可省）
const RULES = [
  {
    id: 'N1-1',
    desc: 'orderability.ts 导出 evaluateStructure / evaluateAvailability / REASON_TEXT',
    file: 'orderability',
    pred: (t) =>
      /^export function evaluateStructure\(/m.test(t) &&
      /^export function evaluateAvailability\(/m.test(t) &&
      /^export const REASON_TEXT/m.test(t),
    mutate: (t) => t.replace('export function evaluateStructure(', 'function evaluateStructureX('),
  },
  {
    // ───────────────────────────────────────────────────────────────────────
    // ⚠️ **本条已降级为「提示」，不计入红绿**（Team Lead 2026-10-26 裁定；对应 spec §0 G11）
    //
    //    **降级原因：判据形态与约束形态不匹配。**
    //    约束是「运行时不读环境时钟」—— 这是一个**行为**约束。
    //    判据是「文件里不出现 `Date.now()` 字样」—— 这是一个**结构**观察。
    //
    //    架构师给出了反例：在文件顶部插一行 `const x = Date.now();`，
    //    **不动任何 import、不碰任何签名**，我的判据照样全绿 ——
    //    而约束已经被违反了。⇒ **判据的绿和约束的绿可以是相反的。**
    //
    //    ⚠️ 这里最要命的不是「它漏了」，是 **它漏了还绿着**，且一度**通过了自证**：
    //    `mutate` 插的 `Date.now()` 确实让判据变红，所以自证说「我会失败」；
    //    但自证证明的是「**观察对象**变了会红」，证明不了「**被约束的东西**变了会红」。
    //    这两件事不一样 —— 见 AC §C.3 第 4、5 条（G11 三条判别式）。
    //
    //    ⇒ 行为约束只能由**跑得起来的检查**守：jest（能真的注入时钟、真的调用）。
    //      见 `apps/api-server/test/unit/orderability.spec.ts`（后端）的时钟相关用例。
    //      静态门禁对此无能为力，**宁可不判，不要留一个恒绿的判据。**
    //
    // ⚠️ **`mode: 'hint'` 的判据不做自证**：给它自证只会重演上面的假象
    //    （「我插了 `Date.now()` 它会红」—— 但这不代表它守住了约束）。
    // ───────────────────────────────────────────────────────────────────────
    id: 'N1-2',
    mode: 'hint',
    desc: '（提示·非判据）orderability.ts 不读时钟 —— 行为约束，静态守不住，真判据在 jest',
    hintWhy:
      '约束是运行时行为（不读环境时钟），静态只能看字面 ⇒ 形态不匹配，' +
      '插一行 `const x = Date.now();` 即可「满足判据且违反约束」。真判据见 jest：' +
      'apps/api-server/test/unit/orderability.spec.ts',
    file: 'orderability',
    // ⚠️ 必须先剥注释：头注释里就有「零 await / 零 new Date()」这句话（注释命中 = 恒红）
    //
    // ⚠️ **不得**禁 `new Date(ms)`：`reasonText()` 里那次是**毫秒 → Date 的纯换算**
    //    （入参由调用方注入），判定因此在单测里完全可复现 —— 真正要禁的是**读环境时钟**
    //    的无参 `new Date()` 与 `Date.now()`。首版写成 `!/new Date\s*\(/` 会把这处误报成 P1，
    //    而它恰恰是本文件「不读时钟」原则的正面 exemplar。（本文件行 12–15 已自述该边界）
    pred: (t) => {
      const b = stripComments(t);
      return (
        !/\bawait\b/.test(b) &&
        !/Repository/.test(b) &&
        !/new Date\s*\(\s*\)/.test(b) &&
        !/Date\.now\s*\(/.test(b)
      );
    },
  },
  {
    id: 'N1-3',
    desc: 'U1 / U6 / 团长工作台都必须调用用户端谓词（少一处就是 N1 未修复）',
    files: ['meal', 'order', 'workbench'],
    pred: (ts) => ts.every((t) => /evaluateAvailability|OrderAvailabilityService/.test(t)),
    sample: [
      `  async daily(userId: number) {
    const input = await this.availability.load(userId);
    const r = evaluateAvailability(input);
    return { canOrder: r.canOrder, reason: r.reason };
  }`,
      `  async create(userId: number, dto: any) {
    const input = await this.availability.load(userId);
    const r = evaluateAvailability(input);
    if (!r.canOrder) throw new BizException(ErrorCode.X);
    return r;
  }`,
      `  async summary(leaderId: number) {
    const input = await this.availability.load(leaderId);
    const r = evaluateAvailability(input);
    return { tomorrow: { canOrder: r.canOrder } };
  }`,
    ],
    mutateFirst: (t) => t.replace('evaluateAvailability(input)', 'evaluateStructure(input)'),
  },
  {
    id: 'N1-3b',
    desc: '管家端只得调 evaluateStructure，不得调 evaluateAvailability / OrderAvailabilityService',
    // T5 第三步（2026-10-27）：读侧四视图迁进 `building-query.service.ts` 后，管家端
    //    分散在两个文件里 —— 只盯主文件 ⇒ 新文件引入可用性层没人拦。
    //    **判据跟着真源走**：改成扫两个文件，不放宽判据本身。
    files: ['buildingAdmin', 'buildingQuery'],
    // ⚠️ **必须剥注释**：`building-admin.service.ts` 的说明注释里写着
    //    （行号仅作路标，随时会漂 —— 它不参与判定，判的是「为什么」那句话在不在）
    //    「为什么管家端只调结构层、不调 `evaluateAvailability()`」—— 这句话是本次判据要求的
    //    **正面 exemplar**（它把「为什么」讲给下一个人听）。不剥注释 ⇒ 判据恒红，
    //    逼着执行者删掉一份正确的说明。**门禁报假警比不报更伤，因为它会让人下次不信它。**
    pred: (ts) =>
      ts.every((t) => !/evaluateAvailability|OrderAvailabilityService/.test(stripComments(t))),
    // 走 REAL 分支（无 sample）⇒ 破化作用于 `files[0]`（主文件）；锚点
    //    `import { BizException }` 在主文件里真实存在 ✓ —— 多文件判据的
    //    `mutateFirst` 锚点**必须**存在于 `files[0]`，否则破化无效、自证假绿。
    mutateFirst: (t) =>
      t.replace(
        'import { BizException }',
        "import { OrderAvailabilityService } from '../../common/services/order-availability.service';\nimport { BizException }",
      ),
  },
  {
    id: 'N1-4',
    desc: '三处调用方各自不得再内联 `status === BuildingStatus.ACTIVE &&` 合取',
    files: ['meal', 'order', 'workbench'],
    pred: (ts) => ts.every((t) => !/status\s*===\s*BuildingStatus\.ACTIVE\s*&&/.test(t)),
    sample: [
      `  async daily(userId: number) {
    const input = await this.availability.load(userId);
    return evaluateAvailability(input);
  }`,
      `  async create(userId: number, dto: any) {
    const input = await this.availability.load(userId);
    return evaluateAvailability(input);
  }`,
      `  async summary(leaderId: number) {
    const input = await this.availability.load(leaderId);
    return evaluateAvailability(input);
  }`,
    ],
    mutateFirst: (t) =>
      t.replace(
        'return evaluateAvailability(input);',
        'return (building.status === BuildingStatus.ACTIVE && gid !== null) && evaluateAvailability(input);',
      ),
  },
  {
    id: 'N1-5',
    desc: 'REASON_TEXT 必须是查表，且 not_open_yet / cutoff 留空串（防忘了插值）',
    file: 'orderability',
    pred: (t) => {
      const b = fnOf(t, 'evaluateAvailability');
      return (
        /export const REASON_TEXT: Record<OrderBlockReason, string>/.test(t) &&
        /not_open_yet:\s*''/.test(t) &&
        /cutoff:\s*''/.test(t) &&
        b !== '' &&
        !/\?[\s\S]{0,200}\?/.test(b)
      );
    },
    mutate: (t) => t.replace("not_open_yet: '',", "not_open_yet: '今日 {HH:mm} 开团',"),
  },
  {
    id: 'N1-6',
    desc: 'building_preparing 与 building_suspended 文案必须逐字不同',
    file: 'orderability',
    pred: (t) => {
      const a = t.match(/building_preparing:\s*'([^']*)'/);
      const b = t.match(/building_suspended:\s*'([^']*)'/);
      if (!a || !b) return false;
      return a[1] !== '' && b[1] !== '' && a[1] !== b[1];
    },
    mutate: (t) =>
      t.replace(
        "building_preparing: '该办公楼尚未开通，敬请期待'",
        "building_preparing: '该办公楼已暂停服务'",
      ),
  },
  {
    // ───────────────────────────────────────────────────────────────────────
    // ⚠️ **2026-10-26 从「单文件」改成「全仓按语义扫」**（Team Lead 指出 + 架构师建议）
    //
    //    旧形态：`file: 'order'`，只在 `order.service.ts` 里找不到 `NOT_FOUND + 未配置楼群`。
    //    ⇒ `traceability.service.ts` 里长期是
    //         `throw new BizException(ErrorCode.NOT_FOUND, '所属办公楼未配置楼群，请联系运营');`
    //      而旧判据**全绿** —— 它连那个文件都没打开过。（当日 21:47 后端已修。）
    //
    //    漏的根因是取数方式：我们**按「已知文件清单」扫**，而不是**按「这个语义会出现在哪」扫**。
    //    清单法对「楼未归群」这种横切语义结构性失效 —— 清单外的第三、第四条路径永远找不到。
    //
    //    ⇒ 新形态：**先扫语义特征、按命中点列清单，再逐点判；不从既有接线点倒推。**
    //      这样即使明天冒出第四条路径，它也会自动进判据。
    //
    // ⚠️ `needle` 写成 `未配置楼群|暂未开通服务`：60011 文案「收尾批」会把前者改成后者
    //    （旧文案向用户暴露了「楼群」这个内部运维概念）。若只写前者，收尾批一落地
    //    ⇒ 扫到 0 处 ⇒ 判红；若只写后者 ⇒ 现在扫到 0 处 ⇒ 判红。两个都写才跨得过过渡期。
    //    ⚠️ 收尾批**做完后**应把 `未配置楼群` 分支从 needle 里删掉（见 AC §C.7）。
    // ───────────────────────────────────────────────────────────────────────
    id: 'N1-7',
    desc: '★ 全仓扫「楼未归群」语义：以 `!x.buildingGroupId` 为条件的每个抛点都必须抛 60011（按语义扫，不按文件清单扫）',
    // ⚠️ **needle 锚「条件」而不是锚「文案」** —— 2026-10-26 第二次失配后改定。
    //    第一版锚文案字面（`未配置楼群`），第二版刚写完，后端就把三处抛点的行内文案
    //    全部去掉了（统一由 `ERROR_MESSAGE` 提供，这是**更正确**的写法）⇒ 抛点上再无字面
    //    ⇒ 扫到 0 个抛点。
    //    ⇒ 文案是会变的（本批收尾批还要改一次），**「判定条件」才是这个语义的稳定锚点**：
    //      「以 `!x.buildingGroupId` 为条件抛异常 ⇒ 必须抛 60011」。
    scan: { dir: () => SRC, needle: 'buildingGroupId', radius: 200 },
    scope: guardedThrowsOf,
    //
    // ⚠️ **取数范围必须精确到能区分目标与非目标** —— 本批第三个实例（前两个：`blockOf`
    //    取数失配、`N2-13` 全文匹配含 `OrderStatus.X` 的 A/B 常量）。首版把「全仓命中」
    //    当抛点，7 处里报红 4 处，其中 3 处是误报 ⇒ **误报比漏报更伤：误报一多，
    //    人就不会再看它。** 故分两层收窄：
    //
    //    第一层 `!isComment`：剥掉说明注释。它们讲的是「为什么不能复用 10004」，
    //      是本次要**保留**的正确文档，判它红就是逼人删掉正确说明。
    //    第二层 `throw new BizException(`：只留**抛点**。
    //      · `error-code.ts:662` 消息表 `[ErrorCode.BUILDING_NOT_GROUPED]: '…'` 不是抛点
    //      · `orderability.ts` 的 `REASON_TEXT.building_not_grouped` 不是抛点
    //      这两处的正确性由 `ERR-2` / `N1-5` 各守各的，不归本条管。
    //
    // ① 抛点至少 1 处（防 `[].every()` 恒绿 —— 空列表 ≡ 全满足）
    // ② 每处抛点必须是 BUILDING_NOT_GROUPED / 60011，且不得出现 NOT_FOUND
    // ⚠️ 全部判定基于 `guardedThrowsOf()`（条件 + 紧随其后的抛语句），
    //    不基于 `h.ctx`（±N 字窗口）—— 窗口会把邻居行卷进来，见 `scanHits` 注释。
    pred: (hits) => {
      const throws = guardedThrowsOf(hits);
      // ① 至少 1 处（防 `[].every()` 恒绿：空列表 ≡ 全满足）
      if (throws.length === 0) return false;
      // ② 每处必须是 60011，且不得出现 10004
      return throws.every(
        (h) => /BUILDING_NOT_GROUPED|60011/.test(h.fwd) && !/NOT_FOUND/.test(h.fwd),
      );
    },
    scanGood: () => [
      guardOf(
        'if (!building.buildingGroupId) {',
        'throw new BizException(ErrorCode.BUILDING_NOT_GROUPED);',
      ),
      guardOf(
        'if (!building?.buildingGroupId) {',
        'throw new BizException(ErrorCode.BUILDING_NOT_GROUPED);',
      ),
    ],
    scanBroken: () => [
      guardOf('if (!building.buildingGroupId) {', 'throw new BizException(ErrorCode.NOT_FOUND);'),
    ],
    absentHint:
      '全仓未在**非注释代码**里扫到「未配置楼群 / 暂未开通服务」的抛点 ⇒ ' +
      '要么文案已整体改名（需同步 needle），要么抛点被删 —— 两者都必须报红',
  },
  {
    id: 'N1-8',
    desc: '结构层求值全序：building_not_grouped → preparing → suspended → group_suspended',
    file: 'orderability',
    pred: (t) => {
      const b = fnOf(t, 'evaluateStructure');
      if (!b) return false;
      return isAscending(
        orderOf(b, [
          's.buildingGroupId === null',
          's.buildingStatus === BuildingStatus.PREPARING',
          's.buildingStatus === BuildingStatus.SUSPENDED',
          's.buildingGroupStatus === BuildingGroupStatus.SUSPENDED',
        ]),
      );
    },
    mutate: (t) =>
      t.replace(
        "  if (s.buildingStatus === BuildingStatus.PREPARING) {\n    return { ok: false, reason: 'building_preparing' };\n  }\n",
        '',
      ),
  },
  {
    id: 'W1-8',
    desc: 'sales_paused 必须在 evaluateAvailability 中**最先**判（严格优先于截单）',
    file: 'orderability',
    pred: (t) => {
      const b = fnOf(t, 'evaluateAvailability');
      if (!b) return false;
      const i = b.indexOf('i.salesPaused');
      if (i < 0) return false;
      return isAscending(
        orderOf(b, ['i.salesPaused', 'evaluateStructure(i)', 'assignmentStatus', 'publishAtMs']),
      );
    },
    mutate: (t) =>
      t
        .replace("  if (i.salesPaused) return { canOrder: false, reason: 'sales_paused' };\n\n", '')
        .replace(
          '  return { canOrder: true, reason: null };',
          "  if (i.salesPaused) return { canOrder: false, reason: 'sales_paused' };\n  return { canOrder: true, reason: null };",
        ),
  },
  {
    id: 'N1-9-a',
    // ───────────────────────────────────────────────────────────────────────
    // ⚠️ **2026-10-26 22:28 重写 · 23:10 拆条（本批第 5 次「产物进步导致探针失配」）**
    //
    //    旧判据：`assignMembers` 与 `updateBuilding` 各自**函数体内**必须出现
    //    `BUILDING_GROUP_SUSPENDED_REJECT`。
    //
    //    后端随后把 60008 判据抽成 `groupGate()` + 统一准入 `assertGroupOpen()`，
    //    三条写路径共用 —— **这正是 N1 这一批在治的病被治好了**：
    //    同一件事三份表述 ⇒ 收敛成一份。⇒ 旧探针判红，而产物是**变好了**。
    //
    //    ⇒ 新判据不再要求「各路径内联抛码」，而是要求**收敛**，且**拆成两条**：
    //
    //    **N1-9-a（本条）调用存在**：三条写路径各自调 `assertGroupOpen(`。
    //      ⚠️ `createBuilding` 是**第三个**写路径 —— 后端新发现的
    //      （原来只调存在性校验，`POST /admin/buildings` 带停用楼群 id 也能建进去），
    //      spec 与 AC 的 `B1-9` / `S-N1-9` 当时只锚了两条 ⇒ 这条旁路一度没人守。
    //      ⇒ **必须三条一起判**，只判两条 ⇒ 少一条就是一条可用旁路。
    //
    //    **N1-9-b（下一条）抛点唯一**：全仓 60008 抛点 == 1，且落在 `assertGroupOpen` 内。
    //      ⚠️ 只判 a 不判 b ⇒ 「闸门还在、各路径还在调它，但抛码被摊回调用点」
    //        照样算过 —— 那正是「收敛」这个动作要防的失效形状；
    //        反过来只判 b 不判 a ⇒ 「抛点只剩一处」也可能只是「另外两条路径压根没接」。
    //
    //    ⚠️ 为什么要拆而不用一条 `&&` 合起来：**合一条 OR 会漏，合一条 AND 会混**。
    //      两条故障的修法完全不同（补调用 vs 收抛点），报成一条红 ⇒
    //      看的人得先自己分辨是哪一半，而门禁的职责恰恰是帮他把这件事做完。
    // ───────────────────────────────────────────────────────────────────────
    desc: '★ 三条写路径（createBuilding / updateBuilding 归群分支 / assignMembers）各自调用唯一准入 assertGroupOpen(',
    file: 'buildingAdmin',
    pred: (t) => {
      const b = stripComments(t);
      const gate = methodOf(b, 'groupGate');
      const open = methodOf(b, 'assertGroupOpen');
      if (!gate || !open) return false; // 判据与准入都必须存在（少一个 ⇒ 收口没做完）
      const paths = ['createBuilding', 'updateBuilding', 'assignMembers'].map((n) =>
        blockOf(b, `async ${n}(`),
      );
      if (paths.some((p) => !p)) return false;
      // ⚠️ 认**调用**，不认字面常量的位置 —— 后者在本批已经失配过一次
      //    （把逻辑抽成一个函数 ⇒ 方法体内再无字面量 ⇒ 判据转红而产物更对）。
      return paths.every((p) => /assertGroupOpen\s*\(/.test(p));
    },
    // ⚠️ 样本必须体现**收敛后**的形态（三条路径共用唯一准入），不是旧的内联抛码形态。
    //    首版没同步改样本 ⇒ 自证报 `good通过=false`（样本不合规，不是判据错）。
    sample: `
  async createBuilding(dto: any): Promise<any> {
    if (dto.buildingGroupId) await this.assertGroupOpen(dto.buildingGroupId);
    return dto;
  }
  async updateBuilding(id: number, dto: any): Promise<any> {
    if (dto.buildingGroupId) await this.assertGroupOpen(dto.buildingGroupId);
    return dto;
  }
  private async assignMembers(gid: number, ids: number[]): Promise<number> {
    await this.assertGroupOpen(gid);
    return ids.length;
  }
  private async groupGate(gid: number): Promise<'missing' | 'suspended' | 'ok'> {
    return 'ok';
  }
  private async assertGroupOpen(gid: number): Promise<void> {
    const gate = await this.groupGate(gid);
    if (gate === 'suspended') {
      throw new BizException(ErrorCode.BUILDING_GROUP_SUSPENDED_REJECT, undefined, undefined, {});
    }
  }`,
    // 破化方向 = **抽掉一条路径的闸门**（Team Lead 指定的第 2 个自证样本）。
    //    选它的理由：这是「第四条写路径将来出现却没人接闸门」的真实形状。
    mutate: (t) =>
      t.replace(
        '    await this.assertGroupOpen(gid);\n    return ids.length;',
        '    return ids.length;',
      ),
  },
  {
    id: 'N1-9-b',
    desc: '★ 全仓 BUILDING_GROUP_SUSPENDED_REJECT 抛点 == 1，且落在唯一准入 assertGroupOpen 内（不得摊回各调用点）',
    // ⚠️ **为什么走全仓扫描而不是单文件**：team-lead 裁的是「全仓抛点 == 1」。
    //    只看 `building-admin.service.ts` ⇒ 有人把抛码抄到 `order.service.ts` 里去
    //    就扫不到 —— 而「同一件事第二份表述」正是本批的主病。
    scan: { dir: () => SRC, needle: 'BUILDING_GROUP_SUSPENDED_REJECT', radius: 400 },
    // ⚠️ 与 `pred` 同口径（供 `detailOf()` 复用），否则判据说一套、输出说一套。
    scope: (hits) =>
      hits.filter((h) => !h.isComment && /^throw\s+new\s+BizException\s*\(/.test(h.stmt ?? '')),
    pred: (hits) => {
      const throws = hits.filter(
        (h) => !h.isComment && /^throw\s+new\s+BizException\s*\(/.test(h.stmt ?? ''),
      );
      // 空集合 ⇒ 恒红（`[].every()` 恒真这个陷阱本批已踩过：`scanHits()` 注释）
      if (throws.length !== 1) return false;
      // ⚠️ 光「== 1」还不够：把抛点**搬出** `assertGroupOpen`（比如搬进 `createBuilding`）
      //    数量仍是 1 ⇒ 必须再锁「它在哪个函数里」。
      //    ⇒ 用 `ctx`（命中点前后各 radius 字符）反查所在函数；`assertGroupOpen`
      //      的函数头离抛点约 6 行，radius 400 足够覆盖。
      return /assertGroupOpen/.test(throws[0].ctx ?? '');
    },
    // ⚠️ 样本必须**自带 `ctx`**：判据要反查抛点所在函数，`ctx` 就是它看得到的全部上下文。
    //    不给 ⇒ `ctx` 为空 ⇒ 自证 `good通过=false`，而那是**样本**缺字段，不是判据错。
    scanGood: () => [
      ctxOf(
        'throw new BizException(ErrorCode.BUILDING_GROUP_SUSPENDED_REJECT, undefined, undefined, {\n      targetGroupId: gid,\n    });',
        "private async assertGroupOpen(gid: number): Promise<void> {\n    const gate = await this.groupGate(gid);\n    if (gate === 'suspended') {\n      throw new BizException(ErrorCode.BUILDING_GROUP_SUSPENDED_REJECT, undefined, undefined, {\n        targetGroupId: gid,\n      });",
      ),
    ],
    // 破化方向 = 把抛点复制一份到第二个函数体 ⇒ 数量变 2 ⇒ 必红
    scanBroken: () => [
      ctxOf(
        'throw new BizException(ErrorCode.BUILDING_GROUP_SUSPENDED_REJECT);',
        'private async assertGroupOpen(gid: number): Promise<void> {\n    throw new BizException(ErrorCode.BUILDING_GROUP_SUSPENDED_REJECT);',
      ),
      ctxOf(
        'throw new BizException(ErrorCode.BUILDING_GROUP_SUSPENDED_REJECT);',
        'async createBuilding(dto: any) {\n    throw new BizException(ErrorCode.BUILDING_GROUP_SUSPENDED_REJECT);',
      ),
    ],
    absentHint: '全仓未扫到 BUILDING_GROUP_SUSPENDED_REJECT 抛点 ⇒ N4 尚未落地，或码名改了',
  },
  {
    id: 'N2-1',
    desc: '★ isUnfinished() 体内不得硬编码 OrderStatus.X（必须黑名单反算）',
    file: 'suspendGate',
    // ⚠️ **2026-10-26 重定向**：P3-5 把谓词抽成 `common/utils/suspend-gate.ts` 的纯函数后，
    //    原探针（在 `building-admin.service.ts` 里找 `countUnfinishedOrders` 块）**失配** ——
    //    这是本批第三次「产物进步导致探针失配」（前两次：`blockOf` 泛型返回类型、
    //    `ORDER_TERMINAL_STATUS` 落 shared-types）。若不重定向，后端会看到「N2-1 红」
    //    而以为工作没做 —— 与 N1-13 那次**一模一样的伤害路径**。
    //
    // ⚠️ 必须**定位到 `isUnfinished` 函数体**：文件里 `ORDER_FULFILLING_STATUS` /
    //    `ORDER_RELEASABLE_STATUS` 两个 A/B 分组常量**本来就含** `OrderStatus.X` 字面量
    //    （那是 N2-8 要求的「显式分组」，不是硬编码未完结清单）。全文匹配 ⇒ **恒红**。
    pred: (t) => {
      if (!t) return false;
      const b = fnOf(stripComments(t), 'isUnfinished');
      if (!b) return false;
      return !/OrderStatus\.[A-Z_]+/.test(b);
    },
    sample: `export function isUnfinished(status: string): boolean {
  return !ORDER_TERMINAL_STATUS.includes(status as OrderStatus);
}`,
    mutate: (t) =>
      t.replace(
        'return !ORDER_TERMINAL_STATUS.includes(status as OrderStatus);',
        'return [OrderStatus.PAID, OrderStatus.CUT_OFF].includes(status as OrderStatus);',
      ),
  },
  {
    id: 'N2-2',
    desc: 'isUnfinished() 必须引用 ORDER_TERMINAL_STATUS（证明是反算而非白名单）',
    file: 'suspendGate',
    // ⚠️ 与 N2-1 同样重定向到 `suspend-gate.ts`。
    //    ⚠️ 必须定位到函数体：文件头的注释里就写了「禁止硬编码未完结清单」这句话，
    //    全文匹配 ⇒ 只写注释不写代码也判绿。
    pred: (t) => {
      if (!t) return false;
      const b = fnOf(stripComments(t), 'isUnfinished');
      return !!b && /ORDER_TERMINAL_STATUS/.test(b);
    },
    sample: `export function isUnfinished(status: string): boolean {
  return !ORDER_TERMINAL_STATUS.includes(status as OrderStatus);
}`,
    mutate: (t) =>
      t.replace(
        'return !ORDER_TERMINAL_STATUS.includes(status as OrderStatus);',
        'return !ORDER_UNFINISHED_STATUS.includes(status as OrderStatus);',
      ),
  },
  {
    id: 'N2-13',
    desc: '★ suspend-gate.ts 必须是纯决策模块：零时钟 / 零 Repository / 零配置读取 / 零字数校验',
    file: 'suspendGate',
    // ⚠️ 这条守的是**形态**，不是内容。P3-5 把谓词抽成纯函数之后，「每次现算、不得缓存」
    //    这条约束就由**结构**保证了 —— 模块内没有任何可缓存的东西。
    //
    //    ⇒ 判据因此从「去 service 里找有没有现算」变成「断言这个模块里没有 IO」。
    //      前者靠自觉且扫不准，后者机械可判。（架构师的建议，采纳。）
    //
    // ⚠️ 四个「零」各有各的失效方式：
    //   · 时钟 ⇒ 决策随时间漂移（B2-12 的病灶）
    //   · Repository ⇒ 不可单测，且「每次现算」失去结构保证
    //   · 配置读取（`BizConfigService`）⇒ `threshold` 由调用方注入，内部再读一遍就是两份口径
    //   · 字数校验（`suspendReason.length` / `@MinLength` 之外的校验）⇒ 与 DTO 的第二份校验
    pred: (t) => {
      if (!t) return false;
      const b = stripComments(t);
      return (
        !/new Date\s*\(\s*\)/.test(b) &&
        !/Date\.now\s*\(/.test(b) &&
        !/Repository/.test(b) &&
        !/BizConfigService|bizConfig/.test(b) &&
        !/suspendReason\.(length|trim)/.test(b)
      );
    },
    sample: `import { ORDER_TERMINAL_STATUS, OrderStatus } from '@abox/shared-types';

export function isUnfinished(status: string): boolean {
  return !ORDER_TERMINAL_STATUS.includes(status as OrderStatus);
}

export function decideSuspend(i: SuspendGateInput): SuspendDecision {
  return { ok: true, reason: null };
}`,
    // 破坏方向：把时钟读回来 —— 决策函数一旦能读钟，就重新有了随时间漂移的入口
    mutate: (t) =>
      t.replace(
        'export function isUnfinished(',
        'const __now = Date.now();\nexport function isUnfinished(',
      ),
  },
  {
    id: 'N2-3',
    desc: '时间边界必须出现 todayBj()（A 组唯一的反死锁机制）',
    file: 'buildingAdmin',
    pred: (t) => /todayBj\s*\(/.test(t),
    // ───────────────────────────────────────────────────────────────────────
    // ⚠️ **2026-10-26 修过一个「产物变好把探针弄瞎」的缺陷（本批第 4 次同类）**
    //
    //    原写法 `t.replace('todayBj()', "''")` **只删第一处**。
    //    而本判据是**存在性**判据（「至少出现一次」）—— 破化它必须删掉**全部**命中。
    //
    //    后端后续又加了 3 处 `todayBj()`（未完结订单的 `mealDate >= todayBj()` 等），
    //    于是：删 1 处，还剩 3 处 ⇒ `pred(broken)` 仍为 true ⇒ **自证报「破化后没报错」**。
    //
    //    ⇒ 这一类的狠处在于：**产物越正确，判据越假**。
    //      加三处正确的时间边界是纯进步，却让守着它的判据失去分辨力。
    //
    //    ⇒ 通律：**存在性判据（≥1）的破化必须 `replaceAll`；
    //       唯一性判据（==1 / 有序 / 全序）才用 `replace`。** 见 AC §C.3 第 6 条。
    // ───────────────────────────────────────────────────────────────────────
    mutate: (t) => t.replaceAll('todayBj()', "''"),
  },
  {
    id: 'N2-8',
    desc: 'A/B 分组必须从常量派生，不得 `OrderStatus.X || OrderStatus.Y ||` 长串',
    // 同 N1-3b：读侧迁出后管家端在两个文件里，判据跟着真源扫两个文件。
    files: ['buildingAdmin', 'buildingQuery'],
    // ⚠️ **锚点腐烂登记（2026-10-27 核实，未修）**：`mutateFirst` 的锚点
    //    `const GROUP_A_STATUS` 在真文件里**已不存在**（A/B 分组常量随停用闸门迁出后
    //    已不叫这个名字）⇒ 真文件侧无法破化，本条只能靠 `sample` 自证（SYNTH 路径）。
    //    这是「判据还在绿，但已经不能证明真文件被守着」的形状，与 N1-16 旧盲区同类
    //    —— 下批应把锚点换成真文件里真实存在的串，别让自证只活在样本上。
    pred: (ts) =>
      ts.every(
        (t) =>
          !/OrderStatus\.[A-Z_]+\s*\|\|[\s\S]{0,120}OrderStatus\.[A-Z_]+\s*\|\|/.test(
            stripComments(t),
          ),
      ),
    sample: [
      `
  const GROUP_A_STATUS = [OrderStatus.CUT_OFF, OrderStatus.COOKED,
    OrderStatus.DELIVERING, OrderStatus.DELIVERED];`,
    ],
    mutateFirst: (t) =>
      t.replace(
        'const GROUP_A_STATUS',
        'const x = s === OrderStatus.CUT_OFF || s === OrderStatus.COOKED || s === OrderStatus.DELIVERING;',
      ),
  },
  {
    id: 'N2-10',
    desc: '阈值必须读 building.suspend_force_max_count，不得硬编码',
    // T5（2026-10-27）：阈值的唯一读取点随停用闸门迁入 `building-suspend.service.ts`，
    //   判据跟着真源改指 —— 不改就会因「代码搬走了」而假红。
    file: 'buildingSuspend',
    pred: (t) => /suspendForceMaxCount|building\.suspend_force_max_count/.test(t),
    sample: `
    const threshold = await this.bizConfig.suspendForceMaxCount();
    if (n > threshold) throw new BizException(ErrorCode.SUSPEND_REQUIRE_APPROVAL);`,
    mutate: (t) => t.replace('await this.bizConfig.suspendForceMaxCount()', '20'),
  },
  {
    id: 'N2-11',
    desc: 'building.suspend_force_max_count 必须 wiring:live + reader 缺省 20（阈值**运行时真读**）',
    files: ['specs', 'bizConfig'],
    pred: (ts) => {
      const [t, b] = ts;
      const i = t.indexOf("key: 'building.suspend_force_max_count'");
      if (i < 0) return false;
      const win = t.slice(i, i + 240);
      return (
        /wiring:\s*'live'/.test(win) &&
        /suspendForceMaxCount\(\)[\s\S]{0,200}?getNumber\('building\.suspend_force_max_count',\s*20\)/.test(
          b,
        )
      );
    },
    sample: [
      `    {
      key: 'building.suspend_force_max_count',
      group: 'building',
      wiring: 'live',
      defaultValue: '20',
    },`,
      `  async suspendForceMaxCount(): Promise<number> {
    return this.getNumber('building.suspend_force_max_count', 20);
  }`,
    ],
    // 破坏方向：把 wiring 改成非 live（阈值键运行时真读，必须 live）
    mutateFirst: (t) => t.replace("wiring: 'live'", "wiring: 'unwired'"),
  },
  {
    id: 'N2-12',
    desc: 'building.suspend_reason_min_length 必须 unwired + unwiredReason，且**不得**有 reader（防假接线）',
    files: ['specs', 'bizConfig'],
    // ⚠️ 第二个键**不被代码读**（reason 字数由 DTO `@MinLength` 编译期固定）。
    //    写 `wiring:'live'` ⇒ 后台显示「已生效」、运营改了不生效 ⇒ 正是「假的接线状态」；
    //    给它加 reader 更糟：`unwired` 的键没有消费点，加一个没人调用的 reader 是死代码，
    //    还会反向暗示「代码读了这个键」，与自己的 unwiredReason 自相矛盾。
    //    ⇒ 本条刻意守**两个方向**（wiring 必须 unwired **且** 不得有 reader）。
    pred: (ts) => {
      const [t, b] = ts;
      const i = t.indexOf("key: 'building.suspend_reason_min_length'");
      if (i < 0) return false;
      const win = t.slice(i, i + 320);
      return (
        /wiring:\s*'unwired'/.test(win) &&
        /unwiredReason/.test(win) &&
        !/suspendReasonMinLength\s*\(/.test(b)
      );
    },
    sample: [
      `    {
      key: 'building.suspend_reason_min_length',
      group: 'building',
      wiring: 'unwired',
      unwiredReason: '字数由 DTO @MinLength 编译期固定，运行时不读本键，修改不会生效',
      defaultValue: '10',
    },`,
      `  async someOtherReader(): Promise<number> {
    return this.getNumber('order.max_quantity', 5);
  }`,
    ],
    // 破坏方向①：把 wiring 改回 live（重新造出假接线）
    mutateFirst: (t) => t.replace("wiring: 'unwired'", "wiring: 'live'"),
  },
  {
    id: 'W1-1',
    desc: 'SalesPause 实体存在，且多词列显式写 name:',
    file: 'systemEntity',
    pred: (t) =>
      /export class SalesPause/.test(t) &&
      /name:\s*'meal_date_from'/.test(t) &&
      /name:\s*'meal_date_to'/.test(t) &&
      /resumed_at|resumedAt/.test(t),
    sample: `@Entity('ab_sales_pause')
export class SalesPause {
  @Column({ name: 'meal_date_from', type: 'varchar', length: 10 })
  mealDateFrom!: string;
  @Column({ name: 'meal_date_to', type: 'varchar', length: 10 })
  mealDateTo!: string;
  @Column({ name: 'resumed_at', type: 'datetime', precision: 3, nullable: true })
  resumedAt?: Date | null;
}`,
    mutate: (t) => t.replace("name: 'meal_date_from'", "name: 'mealdatefrom'"),
  },
  {
    id: 'W1-2',
    desc: 'ALL_ENTITIES 必须登记 SalesPause（否则 TypeORM 建不出表）',
    file: 'entitiesIndex',
    pred: (t) => /\bSalesPause\b/.test(t) && /ALL_ENTITIES/.test(t),
    sample: `export const ALL_ENTITIES = [OpBlocklist, AdminUser, OperationRequest, SalesPause];`,
    // ⚠️ 存在性判据 ⇒ `replaceAll`（当前文件里只有 1 处 `SalesPause`，但 `ALL_ENTITIES`
    //    一旦再加一个同类实体，单处 `replace` 就会让自证静默失效 —— N2-3 就是这么坏的）
    mutate: (t) => t.replaceAll('SalesPause', 'SalesPauseX'),
  },
  {
    id: 'W1-3',
    desc: '存在 ab_sales_pause 迁移（按命名规则下一个应为 1700000000019-sales-pause.ts）',
    migration: '1700000000019-sales-pause.ts',
    // ⚠️ 旧提示写成「存在迁移 1700000000019-sales-pause.ts」，在**文件尚不存在**时读起来
    //    像在陈述一个既成事实 —— 而它恰恰是「还没写」。改为**动态推导**下一个编号，
    //    这样即便别人的分支先占了号，提示也不会说谎（硬编码的号位会随仓库演进而过期）。
    absentHint: () => `目标缺失 ⇒ 未判定；按命名规则下一个应为 ${nextMigrationName()}`,

    pred: (t) => /ab_sales_pause/.test(t) && /idx_sales_pause_range/.test(t),
    sample: `await queryRunner.query(
  'CREATE INDEX idx_sales_pause_range ON ab_sales_pause (meal_date_from, meal_date_to)',
);`,
    mutate: (t) => t.replace('idx_sales_pause_range', 'idx_other'),
  },
  {
    id: 'W1-4',
    desc: 'config.specs.ts 不得出现任何停售键（防把 config 路线加回来）',
    file: 'specs',
    pred: (t) => !/key:\s*'[^']*(sales_pause|stop_sale|global_stop)[^']*'/.test(t),
    mutate: (t) => t.replace("key: 'commission.min_withdraw'", "key: 'order.global_stop_sale'"),
  },
  {
    id: 'W1-5',
    desc: 'OrderAvailabilityService 内不得出现任何缓存（直读 DB）',
    file: 'availability',
    pred: (t) => {
      if (!t) return false;
      return !/cach|\bttl\b|memo|refreshAt/i.test(stripComments(t));
    },
    sample: `  async load(buildingId: number): Promise<AvailabilityInput> {
    const b = await this.buildingRepo.findOne({ where: { id: buildingId } });
    const pause = await this.pauseRepo.find({ where: { resumedAt: IsNull() } });
    return { buildingStatus: b.status, salesPaused: pause.length > 0 };
  }`,
    // ⚠️ 必须落成能被 `\bcache\b` 命中的形态：`cachedRows` 里的 cache 后面跟着 d，
    //    \b 不成立 ⇒ 判据不会变红（mutate 假生效，自证当场抓出来）
    mutate: (t) =>
      t.replace(
        'const b = await this.buildingRepo.findOne',
        'const rows = this.cache.get(key);\n    const b = await this.buildingRepo.findOne',
      ),
  },
  {
    id: 'W1-6',
    desc: '停售/可用性路径严禁批量取消/退款标识符',
    file: 'availability',
    pred: (t) => {
      if (!t) return false;
      return !/forceRefund|bulkCancel|autoRefund|cancelUnpaid/i.test(stripComments(t));
    },
    sample: `  async load(buildingId: number): Promise<AvailabilityInput> {
    const rows = await this.pauseRepo.find({ where: { resumedAt: IsNull() } });
    return { salesPaused: rows.length > 0 };
  }`,
    mutate: (t) =>
      t.replace(
        'const rows = await this.pauseRepo.find',
        'await this.forceRefund(buildingId);\n    const rows = await this.pauseRepo.find',
      ),
  },
  {
    id: 'W1-7',
    desc: '★ 条件护栏：有缓存就必须有 fail-open（守「会随时间退化的不变量」）',
    file: 'availability',
    pred: (t) => {
      if (!t) return false;
      const b = stripComments(t);
      // ⚠️ 必须包含 `cach`（词根）而非 `\bcache\b`：`cached` / `cachedRows` 里的 cache
      //    后面跟着字母 ⇒ \b 不成立 ⇒ 检测器自己看不见自己要守的东西（自证抓出）
      const hasCache = /cach|\bttl\b|memo|refreshAt/i.test(b);
      if (!hasCache) return true; // 本批不引入缓存 ⇒ 通过
      // 一旦引入缓存：必须有 catch + 不阻断（fail-open）
      return /catch\s*\(/.test(b) && /fail-open|failOpen|放行/.test(b);
    },
    sample: `  private async read(): Promise<Row[]> {
    try {
      return this.cached ?? (await this.repo.find());
    } catch (e) {
      this.logger.warn('fail-open：沿用旧值');
      return this.cached ?? [];
    }
  }`,
    // 把 catch 短路掉 ⇒ 「有缓存却没有 fail-open 分支」⇒ 判据必须在②这个 punish 点上变红
    mutate: (t) => t.replace('} catch (e) {', '} if (false) {'),
  },
  {
    id: 'N1-10',
    desc: '★ evaluateStructure 第 1 条必须同时覆盖三个「不存在」（三个字段全用 === null，不用相等判定）',
    file: 'orderability',
    // ⚠️ 实测出来的 fail-open：输入 { buildingStatus: null, buildingGroupId: 7, buildingGroupStatus: 1 }
    //    旧版只判 buildingGroupId === null ⇒ 四步全过返回 ok:true，一栋**不存在的楼被判可下单**。
    //    编译过、跑得过、断言全绿，只在没人构造的输入上错 ⇒ 必须靠静态判据守则。
    //
    // ⚠️ **病根不是「漏了一行」**：两个同源字段（`buildingGroupId` 与 `buildingGroupStatus`
    //    都来自「楼群那一行」）用了**两套判据风格** —— 前者用 `=== null` 判存在性，
    //    后者用 `=== BuildingGroupStatus.SUSPENDED` 判语义。**相等判定天然漏 `null`**：
    //    行查不到 ⇒ `buildingGroupStatus` 为 null ⇒ `null === SUSPENDED` 为 false ⇒ 放行。
    //
    // ⚠️ **判据形状（关键，别写反）**：
    //    ✅ 正确 = 「第 1 条同时覆盖三个 `=== null`」
    //    ❌ 错误 = 「第 4 条的相等判定消失」
    //    第 4 条（`buildingGroupStatus === BuildingGroupStatus.SUSPENDED`）**必须保留**：
    //    `group_suspended` 是 60010 的四个输入之一，且有独立文案「该区域已暂停服务」；
    //    删掉它会让这个 reason 整体消失。存在性由第 1 条用**同一套** `=== null` 兜住，
    //    第 4 条只管语义 —— 这才是要的那个**对称性**。
    //    ⇒ 按「第 4 条消失」写判据，会在架构师这版实现上**恒红**。
    //
    // ⚠️ **2026-10-26 补入反向合取（= 架构师的 `D-N2-4-a`）**
    //    Team Lead 让我核它是否与本条重复 ⇒ **结论：不重复，但也不该单立。**
    //      本条 = 正向断言「三个 `=== null` 都在」
    //      D-N2-4-a = 反向断言「不得用 `!x` / `== null` / `=== undefined`」
    //    两者是**同一条约束的互补两半**（像 N1-15 的「禁 A 且要求 B」），
    //    单立会造成「两条判据守同一行代码」的腐烂 —— 修一处看到两条红，
    //    会让人以为有两个问题。⇒ 补进本条，不单独立号。
    //
    //    ⚠️ **但 Team Lead 给的理由（「`status` 是 0 起步的数值枚举，`!x` 会把营业中
    //    判成不存在」）回源后不成立**：`BuildingStatus` 是 `ACTIVE = 1 / PREPARING = 2 /
    //    SUSPENDED = 3`，**不从 0 起步**。真实的理由是另一条，而且更硬：
    //
    //      **`!x` 把「null」与「falsy」并成一路，而存在性判定必须只认 `null`。
    //      现在它碰巧不出错，是**靠枚举取值侥幸**，不是**靠语义正确**。**
    //
    //    ⇒ 一旦枚举加 0 值（`BuildingStatus.UNKNOWN = 0`），或 `buildingGroupId`
    //      出现 0（种子数据 / 迁移回填都可能），判据**立刻**失效，
    //      且失效方式是**静默的 fail-open**：把「不存在」判成「存在」⇒ 放行下单。
    //    ⇒ **判据要守的是「存在性只能用 `=== null` 表达」这个写法纪律，
    //      不是「当前枚举取值下结果对不对」。结果对 ≠ 写法对。**
    pred: (t) => {
      const b = fnOf(stripComments(t), 'evaluateStructure');
      if (!b) return false;
      const first = b.slice(0, b.indexOf('return') < 0 ? b.length : b.indexOf('return'));
      // 正向：三个 `=== null` 都在（且必须是严格 `===`）
      const positive =
        /\bbuildingStatus\s*===\s*null\b/.test(first) &&
        /\bbuildingGroupId\s*===\s*null\b/.test(first) &&
        /\bbuildingGroupStatus\s*===\s*null\b/.test(first);
      // 反向：不得出现 `!x` / `== null` / `=== undefined` 这三种「并成一路」的写法
      //
      // ⚠️ `==\s*null` 必须加**后顾断言** `(?<![!=])` 且排除 `==` 后紧跟 `=`：
      //    `=== null` 里，从第二个 `=` 起就是 `== null`（`=` `=` ` ` `n`…）。
      //    首版写成 `/==\s*null\b/` ⇒ **`=== null` 被判成 `== null`** ⇒ 反向合取恒假
      //    ⇒ N1-10 恒红。自证当场报出来（good 样本过不了）。
      //    ⇒ 顺带：`!==` 也要排除，故 `(?<![!=])`。
      const negative =
        !/!\s*s\.\w+/.test(first) &&
        !/(?<![!=])==(?!\s*=)\s*null\b/.test(first) &&
        !/===\s*undefined\b/.test(first);
      return positive && negative;
    },
    // 破坏方向：把第三个 `=== null` 摘掉 —— 正是 D-N1-8 修之前那个洞的形状
    mutate: (t) => t.replace(' || s.buildingGroupStatus === null', ''),
  },
  {
    id: 'N1-11',
    desc: '文案单一出口：import orderability 的模块不得直接索引 REASON_TEXT[（必须走 reasonText()）',
    file: 'availability',
    // ⚠️ `user.service.ts:19` 另有一个**同名**但无关的 `REASON_TEXT`（注销原因），
    //    故本条**只**检查 import 了 orderability 的模块，不做全仓扫描 —— 否则假红。
    pred: (t) => {
      if (!t) return false;
      const b = stripComments(t);
      return /from\s+'[^']*orderability'/.test(b) && !/REASON_TEXT\s*\[/.test(b);
    },
    sample: `import { evaluateAvailability, reasonText } from '../utils/orderability';
// …
      reasonText: result.reason ? reasonText(result.reason, { publishAtMs, cutoffAtMs, cutoffWindowMinutes }) : null,`,
    mutate: (t) => t.replace('reasonText(result.reason, {', 'REASON_TEXT[result.reason] ?? ('),
  },
  {
    id: 'N1-12',
    // ⚠️ **2026-10-26 从列举式改成一般式**。
    //
    //    旧判据：`reasonText()` 必须对 `not_open_yet` / `cutoff` **两个键**插值。
    //    随后 W1 把 `sales_paused` 也改走插值（`REASON_TEXT.sales_paused` 变空串、
    //    模板留在 `reasonText()` 的 switch 里）⇒ 列举式判据当场失效：
    //    **有人删了 `sales_paused` 的插值分支，判据照样绿**。
    //
    //    ⇒ **列举式判据天生防不住「新增同类」，一般式才防得住。**
    //      这与 `N1-7` 从「锚文案」改成「锚判定条件」是同一个道理的两面：
    //      一个是防不住「改名」，一个是防不住「新增」。
    //
    // ⇒ 一般式 = **双侧**（漏一侧就有真空地带）：
    //     侧 A：表里**带 `{` 占位符**的键 ⇒ 必须有插值分支（否则用户看到 `{reason}` 原文）
    //     侧 B：表里**是空串**的键     ⇒ 必须有分支（否则用户收到空文案，静默失败）
    //   `sales_paused` 落在侧 B 的射程内；侧 A 当前**全仓无此形态**（真空），
    //   故侧 A 的射程由 `HELPER_CHECKS` 里的专项自证覆盖 —— 见那里。
    desc: '★ REASON_TEXT 的「动态键」必须都有对应的插值分支：带 `{` 的键要插值、空串键要有分支（一般式，防新增同类漏网）',
    file: 'orderability',
    pred: reasonTextCoversDynamicKeys,
    // 破化方向 = **删掉一个空串键的插值分支**（`sales_paused` 正是这样入网的）
    mutate: (t) => t.replace("    case 'sales_paused': {", "    case 'sales_paused_moved': {"),
  },
  {
    id: 'N1-13',
    desc: '★ resolveGroup() 三处出口各归各位（1619 LEADER_NOT_FOUND 保留 · 1624 20016 · 1628 60011）',
    file: 'order',
    // ⚠️ **为什么整条重写**：旧版用「`ErrorCode.NOT_FOUND` 后 120 字内出现『你还未绑定办公楼』」
    //    来判红 —— 而 1624 的**文案本次也要改**（「请通过团长邀请链接进入」是错的指引，
    //    下单场景应给「你还没有选择办公楼，选好即可下单」）。于是存在一条作弊路径：
    //    **只改文案、不改码** ⇒ 旧判据的正则失配 ⇒ 该红却绿。这正是 backend 提的陷阱。
    //    ⇒ 判据必须以**枚举名**为准、以**文案**为辅，且必须**定位到函数体**分别检查三行。
    pred: (t) => {
      const src = stripComments(t);
      const g = methodOf(src, 'resolveGroup');
      const leader = methodOf(src, 'resolveLeader');
      if (!g || !leader) return false;
      // ① resolveGroup 内再无 NOT_FOUND（两处语义各有专属码，不得再挤在一个通用码里）
      const noNotFound = !/ErrorCode\.NOT_FOUND/.test(g);
      // ② 「无办公楼」→ 20016，且指引必须是「选好即可下单」而不是团长的邀请链接
      const unboundOk =
        /ErrorCode\.USER_BUILDING_UNBOUND[\s\S]{0,80}选好即可下单/.test(g) &&
        !/ErrorCode\.USER_BUILDING_UNBOUND[\s\S]{0,80}请通过团长邀请链接进入/.test(g);
      // ③ 「楼未归群」→ 60011
      const groupedOk = /ErrorCode\.BUILDING_NOT_GROUPED/.test(g);
      // ④ 反向护栏：resolveLeader 里的 1619 必须原样保留（两行文案都含「请通过团长邀请链接进入」，
      //    执行者极易一起改掉 ⇒ 必须单独钉住）
      const kept = /LEADER_NOT_FOUND[\s\S]{0,120}未绑定团长，请通过团长邀请链接进入/.test(leader);
      return noNotFound && unboundOk && groupedOk && kept;
    },
    sample: `
  private async resolveLeader(leaderCode: string | undefined, user: User): Promise<TeamLeader> {
    // …
    throw new BizException(ErrorCode.LEADER_NOT_FOUND, '未绑定团长，请通过团长邀请链接进入');
  }

  private async resolveGroup(user: User): Promise<number> {
    if (!user.buildingId) {
      throw new BizException(ErrorCode.USER_BUILDING_UNBOUND, '你还没有选择办公楼，选好即可下单');
    }
    const building = await this.buildingRepo.findOne({ where: { id: user.buildingId } });
    if (!building?.buildingGroupId) {
      throw new BizException(ErrorCode.BUILDING_NOT_GROUPED, '所属办公楼未配置楼群，请联系运营');
    }
    return building.buildingGroupId;
  }`,
    // 破化方向 = **backend 指出的那条作弊路径本身**：文案改了、码没改。
    // 选它的理由：这正是「改文案比改码容易」时最可能发生的事，也是旧判据漏掉的那一条。
    mutate: (t) =>
      t.replace(
        "throw new BizException(ErrorCode.USER_BUILDING_UNBOUND, '你还没有选择办公楼，选好即可下单');",
        "throw new BizException(ErrorCode.NOT_FOUND, '你还没有选择办公楼，选好即可下单');",
      ),
  },
  {
    id: 'ERR-1',
    desc: '八个新错误码 60006–60013 在 ErrorCode enum 登记',
    file: 'errCode',
    pred: (t) =>
      [
        ['BUILDING_UNFINISHED_ORDERS', 60006],
        ['BUILDING_GROUP_UNFINISHED_ORDERS', 60007],
        ['BUILDING_GROUP_SUSPENDED_REJECT', 60008],
        ['SALES_PAUSED', 60009],
        ['BUILDING_SUSPENDED', 60010],
        ['BUILDING_NOT_GROUPED', 60011],
        ['SUSPEND_REQUIRE_APPROVAL', 60012],
        ['SUSPEND_CANNOT_REVOKE_ACCEPTED', 60013],
      ].every(([n, v]) => new RegExp(`${n} = ${v}`).test(t)),
    sample: `
  BUILDING_UNFINISHED_ORDERS = 60006,
  BUILDING_GROUP_UNFINISHED_ORDERS = 60007,
  BUILDING_GROUP_SUSPENDED_REJECT = 60008,
  SALES_PAUSED = 60009,
  BUILDING_SUSPENDED = 60010,
  BUILDING_NOT_GROUPED = 60011,
  SUSPEND_REQUIRE_APPROVAL = 60012,
  SUSPEND_CANNOT_REVOKE_ACCEPTED = 60013,`,
    mutate: (t) => t.replace('BUILDING_SUSPENDED = 60010', 'BUILDING_SUSPENDED = 60021'),
  },
  {
    id: 'ERR-2',
    desc: '八个新错误码在 ERROR_MESSAGE 成对登记',
    file: 'errCode',
    pred: (t) =>
      [
        'BUILDING_UNFINISHED_ORDERS',
        'BUILDING_GROUP_UNFINISHED_ORDERS',
        'BUILDING_GROUP_SUSPENDED_REJECT',
        'SALES_PAUSED',
        'BUILDING_SUSPENDED',
        'BUILDING_NOT_GROUPED',
        'SUSPEND_REQUIRE_APPROVAL',
        'SUSPEND_CANNOT_REVOKE_ACCEPTED',
      ].every((n) => new RegExp(`\\[ErrorCode\\.${n}\\]:`).test(t)),
    sample: `
  [ErrorCode.BUILDING_UNFINISHED_ORDERS]: '该办公楼仍有未完结订单，不能直接停用',
  [ErrorCode.BUILDING_GROUP_UNFINISHED_ORDERS]: '该楼群仍有未完结订单，不能直接停用',
  [ErrorCode.BUILDING_GROUP_SUSPENDED_REJECT]: '目标楼群已停用，不能把办公楼挂进去',
  [ErrorCode.SALES_PAUSED]: '当前已暂停接单',
  [ErrorCode.BUILDING_SUSPENDED]: '该办公楼暂不可下单',
  [ErrorCode.BUILDING_NOT_GROUPED]: '该办公楼未配置楼群，请联系运营',
  [ErrorCode.SUSPEND_REQUIRE_APPROVAL]: '未完结订单超过阈值，请提交审批',
  [ErrorCode.SUSPEND_CANNOT_REVOKE_ACCEPTED]: '已有订单进入履约阶段，无法通过停用撤回',`,
    mutate: (t) => t.replace('  [ErrorCode.BUILDING_SUSPENDED]:', '  // removed:'),
  },
  {
    id: 'N1-14',
    desc: '★ 编排层查楼 / 楼群必须带 deletedAt: IsNull()（软删列是普通 @Column，TypeORM 不自动过滤）',
    file: 'availability',
    // ⚠️ **必须剥注释**：本文件 68–72 行的说明注释里就写了两遍 `deletedAt: IsNull()`，
    //    不剥 ⇒ 注释一改判据就跟着抖，更糟的是**只写注释不写代码也会绿**。
    //
    // ⚠️ 为什么必须带：`ab_building.deleted_at` / `ab_building_group.deleted_at` 都是
    //    普通 `@Column` 而非 `@DeleteDateColumn` ⇒ TypeORM **不会**自动过滤软删行；
    //    软删时若没同步改 `status`，一栋已删的楼会被查到并判为**可下单** = fail-open。
    //
    // ⚠️ 为什么 `idxs.length === 0` 要判红：若哪天编排层不再查楼（改成上游传参），
    //    `every()` 会对空数组返回 true ⇒ 判据**自动恒绿**，而它守的东西已经无从谈起。
    //    空集合必须显式判红（「查都没查」不是通过）。
    pred: (t) => {
      if (!t) return false;
      const b = stripComments(t);
      const idxs = [...b.matchAll(/this\.(?:buildingRepo|groupRepo)\.findOne\(/g)].map(
        (m) => m.index,
      );
      if (idxs.length === 0) return false;
      return idxs.every((i) => /deletedAt:\s*IsNull\(\)/.test(b.slice(i, i + 220)));
    },
    sample: `  private async resolve(mealDate: string, buildingId: number | null): Promise<OrderAvailability> {
    const building = buildingId
      ? await this.buildingRepo.findOne({ where: { id: buildingId, deletedAt: IsNull() } })
      : null;
    const groupId = building?.buildingGroupId ?? null;
    const [group] = await Promise.all([
      groupId
        ? this.groupRepo.findOne({ where: { id: groupId, deletedAt: IsNull() } })
        : Promise.resolve<BuildingGroup | null>(null),
    ]);
    return { buildingStatus: building?.status ?? null, groupId, group } as any;
  }`,
    // 破坏方向：摘掉 group 那一处的过滤（只漏一处就够 ⇒ 证明不是靠「全文出现过一次」蒙混）
    mutate: (t) =>
      t
        .replaceAll('deletedAt: IsNull()', 'deletedAt: undefined')
        .replace('{ id: groupId, deletedAt: undefined }', '{ id: groupId }'),
  },
  {
    id: 'N1-15',
    desc: '编排层只许调 reasonText()：reasonTextOf / toBjIso / REASON_TEXT[ 命中数必须为 0',
    file: 'availability',
    // ⚠️ 这条比「文案内容正确」更能防复发：内容对了但**多一份实现**，下次改文案就少改一处。
    //    backend 在编排层写过一个 `reasonTextOf()`，后来主动删了 —— 删得掉一次，删不掉第二次，
    //    靠人记不住，靠 grep 记得住。
    //
    // ⚠️ 四个合取缺一不可：
    //    · 三个「禁」是正向拦截；
    //    · 第四个 `/reasonText\(/` 是**反向**要求 —— 少了它，把整个文案出口删掉也判绿
    //      （「不做」不等于「做对」，判据必须守住「真的走了唯一出口」）。
    pred: (t) => {
      if (!t) return false;
      const b = stripComments(t);
      return (
        !/reasonTextOf/.test(b) &&
        !/toBjIso/.test(b) &&
        !/REASON_TEXT\s*\[/.test(b) &&
        /reasonText\s*\(/.test(b)
      );
    },
    sample: `import { evaluateAvailability, reasonText } from '../utils/orderability';
// …
    return {
      ...result,
      reasonText: result.reason
        ? reasonText(result.reason, { publishAtMs, cutoffAtMs, cutoffWindowMinutes })
        : null,
    };`,
    // 破坏方向：把唯一出口换成「自己造一份」—— 同时触发 `REASON_TEXT[` 与 `reasonTextOf`，
    // 且 `/reasonText\(/` 因 `reasonTextOf(` 而不匹配 ⇒ 四个合取一起变红。
    mutate: (t) =>
      t.replace('reasonText(result.reason, {', 'REASON_TEXT[result.reason] ?? reasonTextOf('),
  },
  {
    id: 'N1-16',
    desc: '★「楼状态 ∧ 已归群」的内联合取命中数必须为 0（唯一持有者 = evaluateStructure；`buildingWarnings` 的分条文案为**显式豁免**）',
    files: ['buildingAdmin', 'buildingQuery'],
    // ⚠️ **缘起**：改名巡检时挖出楼宇概览里那个 `canAssignCount` 是**第三份判据**
    //    —— 它既不消费列表页那个字段，也不调纯函数，而是自己内联了
    //    `b.status === BuildingStatus.ACTIVE && b.buildingGroupId`。
    //    改名若只改字段名而漏掉它，「楼宇概览」就会留一份没人管的旧判据，与列表页是
    //    两个独立数字，将来对不上也没人查得出。
    //
    // ⚠️ **四种书写形态都要覆盖**（旧版只认前两档，**自证当场抓出过这个盲区**）：
    //    · `b.status` / `saved.status` —— 列表、编辑回显
    //    · `buildingStatus` —— 抽成 `canAssignOf()` 后用**形参名**写（最容易被漏的一档：
    //      首版正则写成 `status\s*===`，而 `buildingStatus` 里的 S 是大写 ⇒ **匹配不上**，
    //      判据对它完全失明。故前缀放开成 `[A-Za-z]*[Ss]tatus`）
    //    · `!==` —— 旧版只写 `===` ⇒ `buildingWarnings` 的第一行**在视野外**
    //    · `gid === null` —— 旧版只写 `gid !== null` ⇒ 第二行同样在视野外
    //
    // ⚠️ 必须 `stripComments()`：本文件注释极多（说明性注释里原样抄了这行合取做说明），
    //    全文匹配会**恒红**。
    //
    // ── 2026-10-27 盲区裁定（G14 · 有意保留的字面两边都要写清）──────────────
    // 旧版因为上面第 3、4 档没覆盖 ⇒ `buildingWarnings()` 的两行**完全失明**：
    //    判据恒绿，但不是因为它对，是因为它看不见 —— 这比红更坏。
    // 修法 = **先让它看得见，再显式豁免**，而不是继续看不见：
    //    `buildingWarnings` 是**合法形态**，理由是本判据的**缘起**管不到它 ——
    //    缘起防的是「第二份判据 ⇒ 两个独立**数字**对不上」；而它产出的是**分条文案**
    //    （「已非营业中」/「未归入楼群」），粒度比 `canAssign` 的三态更细：
    //    三态合一回答不了「为什么不行」，运营要看的正是分条原因。它不是数字，
    //    不存在与列表页对不上的问题 ⇒ **不改为派生**（那会改动出参文案，属行为变更）。
    // ⚠️ 豁免必须**指着一个真实存在的对象**：`blockOf()` 取不到方法块就直接判红 ——
    //    豁免指向空气 ⇒ 判据退化成永久盲区，比不豁免更坏（HELPER_CHECKS 有专项自证）。
    //
    // ⚠️ T5 第三步（2026-10-27）：读侧四视图迁进 `building-query.service.ts`，
    //    判据**跟着真源**改成扫两个文件（不放宽判据本身）。
    pred: (ts) =>
      ts.every((t) => {
        if (!t) return false;
        const b = stripComments(t);
        const re =
          /[A-Za-z]*[Ss]tatus\s*(?:===|!==)\s*BuildingStatus\.ACTIVE\s*&&\s*(?:gid\s*(?:===|!==)\s*null|(?:[\w.]+\.)?buildingGroupId\b(?:\s*(?:===|!==)\s*null)?)/g;
        if ((b.match(re) ?? []).length === 0) return true;
        const w = blockOf(b, 'private buildingWarnings(');
        if (!w) return false; // 豁免对象不在 ⇒ 严格判红
        return (b.replace(w, '').match(re) ?? []).length === 0;
      }),
    sample: [
      `  private canAssignOf(
    buildingStatus: number,
    buildingGroupId: number | null,
    buildingGroupStatus: number | null,
  ): boolean {
    return evaluateStructure({ buildingStatus, buildingGroupId, buildingGroupStatus }).ok;
  }
  // 概览页与列表页同源：
  canAssignCount: buildings.filter((b) => {
    const gid = b.buildingGroupId ? Number(b.buildingGroupId) : null;
    return this.canAssignOf(b.status, gid, gid ? (groupStatusMap.get(gid) ?? null) : null);
  }).length,`,
    ],
    // 破坏方向：**写回**一份内联合取（这正是 438 被挖出来时的现状）。
    //    刻意用 `b.status ... gid !== null` 这一档 —— 它与概览页原状同形，
    //    是执行者「把判据抄回内联」时最自然的写法。
    //    ⚠️ 多文件判据只破化 `files[0]`，故锚点必须写在 `sample[0]` 里。
    mutateFirst: (t) =>
      t.replace(
        'return evaluateStructure({ buildingStatus, buildingGroupId, buildingGroupStatus }).ok;',
        'return b.status === BuildingStatus.ACTIVE && gid !== null;',
      ),
  },
  {
    id: 'N1-17',
    desc: '管家端类型不得再用 canOrder（已改名 canAssign）：admin-web/src/api/building.ts 剥注释后命中 0',
    file: 'adminBuildingApi',
    // ⚠️ **必须剥注释**：`apps/admin-web/src/api/building.ts:57` 的说明注释里写着
    //    「⚠️ 语义 ≠ 用户端 / 团长端那个仍用旧名的字段：那边问的是『此刻能否下单』」——
    //    这句话是**正确且必要**的文档
    //    （它正是在防止下一个人把两个语义混为一谈）。不剥注释 ⇒ 判据**恒红**，
    //    逼着执行者去删掉一份正确的说明。**门禁报假警比不报更伤。**
    //
    // ⚠️ 为什么这条必须由判据守：admin-web 的 DTO 是**手抄**的（`apps/admin-web/src/api/`），
    //    `vue-tsc` 只检查 admin-web 自己的 tsconfig 覆盖范围，**后端改名不会让前端报错**。
    //    这是 architect 指出的 tsconfig 缺口 —— 类型系统补不上，只能靠静态判据补。
    //
    // ⚠️ 只扫 `api/building.ts`：**不做全仓扫描**。用户端 / 团长端的 `canOrder` 是另一个
    //    语义（「此刻能否下单」），**必须保留**（`meal.service.ts` / `orderability.ts` /
    //    `miniprogram` 多处），全仓扫描 ⇒ 恒红且误导。
    pred: (t) => {
      if (!t) return false;
      const b = stripComments(t);
      return !/\bcanOrder\b/.test(b) && /\bcanAssign\b/.test(b);
    },
    sample: `  /** 能否编排套餐（配置层面，无时间维度）= 营业中 ∧ 已归群
   *
   * ⚠️ 与用户端 / 团长端的 canOrder 不是同一个语义。
   */
  canAssign: boolean;
  canAssignCount: number;`,
    mutate: (t) => t.replaceAll('canAssign', 'canOrder'),
  },
  {
    id: 'N1-18',
    desc: 'Swagger / 接口规范不得再把管家端字段**定义**成 canOrder',
    files: ['buildingAdminController', 'apiSpec'],
    // ⚠️ **为什么不是「全文禁 canOrder」**：`building-admin.controller.ts:61` 写着
    //    「与用户端「此刻能否下单」的 `canOrder` 不是同一件事」—— 这句话是本次改名要
    //    **新增**的正确文档（它解释的正是两个语义的区别）。一刀切 ⇒ 逼人删掉它。
    //
    // ⇒ 判据精确定位在「**定义**」这个动作上：`` `canOrder` = ``（Swagger 定义行）与
    //    `**D13 `canOrder`**`（接口规范里的字段行）。引用可以留，定义不许留。
    //
    // ⚠️ 第二个合取是**反向**要求：只禁不禁建 ⇒ 把定义**删掉**（而不是改对）也判绿。
    //    「不做」不等于「做对」。
    pred: (ts) => {
      const [ctl, spec] = ts;
      const noDef = (s) => !/`canOrder`\s*=/.test(s) && !/\*\*D13\s*`canOrder`\*\*/.test(s);
      const hasDef = (s, re) => re.test(s);
      return (
        noDef(ctl) &&
        noDef(spec) &&
        hasDef(ctl, /`canAssign`\s*=/) &&
        hasDef(spec, /\*\*D13\s*`canAssign`\*\*/)
      );
    },
    sample: [
      `      '\`canAssign\` = 配置上能不能开团（营业中 ∧ 已归群 ∧ 所属楼群未停用），**无时间维度**；' +
      '与用户端「此刻能否下单」的 \`canOrder\` 不是同一件事。' +`,
      `| **D13 \`canAssign\`** | = 营业中 ∧ 已归群 | 与 U1「今日这盒」是否可下单不是同一判据 |`,
    ],
    mutateFirst: (t) =>
      t.replace('`canAssign` = 配置上能不能开团', '`canOrder` = 配置上能不能开团'),
  },
  {
    id: 'N1-19',
    desc: '★ 模板里访问本次改名的字段必须走 asRow() 收窄（el-table 插槽的 row 是 DefaultRow，属性访问逃逸类型检查）',
    file: 'leaderBindingVue',
    // ⚠️ **为什么单列这一条**：`apps/admin-web/src/views/**/*.vue` 里，el-table 插槽的
    //    `row` 是 `DefaultRow` ⇒ **属性访问逃逸类型检查** —— 直接写 `row.canAssign` 时，
    //    字段名写错、改名没跟上，**tsc 一声不响**。N1-17 只扫 `api/building.ts`（类型定义文件），
    //    抓不到模板里的这两处。
    //
    // ⚠️ **为什么只守「本次改名的字段」而不是「所有 row. 访问」**：
    //    全仓 `.vue` 里有 20+ 处未收窄的 `row.xxx`（`delivery-map.vue` 一处就有 10 处）。
    //    写成「所有 `row.` 都必须走 asRow()」⇒ **恒红**，逼着执行者去改造一批与本次无关的
    //    老代码 —— 那是**把范围蔓延包装成严谨**。本条只守本次改名字段的访问形状。
    //
    // ✅ **反向对照已实测**（架构师要的「命中数 0 → 2」）：
    //    把 `BuildingRow.canAssign` 改名后跑 `vue-tsc`，tsc 报出
    //    `leader-binding.vue(105,37)` 与 `(106,27)` 两条 TS2551 —— 收窄之后类型系统**盯得住**。
    //    ⇒ 前端已落 `asRow()`，本条现在是绿的；若有人把它退回 `row.canAssign`，本条立刻红。
    pred: (t) => {
      if (!t) return false;
      const b = stripComments(t);
      // ① 反向：不得出现未收窄的 `row.canAssign`
      //    ⚠️ `asRow(row).canAssign` 里也含 `canAssign`，故必须排除 `asRow(row).` 前缀
      const raw = /(?<!asRow\(row\)\.)\brow\.canAssign\b/.test(b);
      // ② 正向：收窄后的访问必须真的出现（防「把整块 UI 删掉」也算过）
      const narrowed = /asRow\(row\)\.canAssign/.test(b);
      return !raw && narrowed;
    },
    sample: `        <template #default="{ row }">
          <el-tag :type="asRow(row).canAssign ? 'success' : 'info'" size="small" effect="plain">
            {{ asRow(row).canAssign ? '是' : '否' }}
          </el-tag>
        </template>`,
    // 破坏方向：退回未收窄的 `row.canAssign` —— 正是「改名在模板里没跟上且 tsc 沉默」的形状
    mutate: (t) => t.replaceAll('asRow(row).canAssign', 'row.canAssign'),
  },
  {
    id: 'DOC-1',
    desc: '★ 反向判据：历史测试报告必须保留旧字段名 canOrder=true（不得回改历史结论）',
    file: 'historyReport',
    // ⚠️ **这是一条反向判据，绿 = 历史没被篡改，红 = 有人在改历史**。
    //    《深度测试第二轮报告 v1.0》第 74 行记的是「F4 仍有订单时照样能继续下单 ✅ canOrder=true」——
    //    那是**当时用当时的字段名跑出来的实测结论**。本次改名把 `canOrder` 换成了 `canAssign`，
    //    执行者很容易顺手全局替换，把一份历史实测记录改成当时并不存在的字段名，
    //    **结论没变，但记录变成了假的**。历史文档只能追加，不能重写。
    //
    // ⚠️ md **不剥注释**：`stripComments()` 会把 ``` 代码围栏当成模板字符串，成段吞掉正文。
    pred: (t) => /canOrder\s*=\s*true/.test(t),
    sample: `| F4 | 仍有订单时照样能继续下单 | ✅ canOrder=true |`,
    // 破化方向 = 那条最可能的误操作：全局替换把历史结论也一起改了
    mutate: (t) => t.replaceAll('canOrder=true', 'canAssign=true'),
  },
  {
    // ───────────────────────────────────────────────────────────────────────
    // ⚠️ **为什么必须是「存在性 + 内容」双重断言**（Team Lead 2026-10-26 明确要求）
    //
    //    「后台 `canOrder` 命中数 ≤ 2」这种写法是**恒绿**的：
    //      · 注释被人顺手删了 ⇒ 命中 0 ⇒ ≤ 2 ⇒ 绿
    //      · 注释被改成 `canAssign`（变成「与用户端 canAssign 不是一回事」这种废话）⇒ 命中 0 ⇒ 绿
    //      · 两处都还在且正确 ⇒ 命中 2 ⇒ 绿
    //    ⇒ **三个完全不同的产物状态，判据给出同一个答案**。它在判别的东西，不是要守的东西。
    //
    //    正确形态是三条合取，每条对应一个**具体的失效动作**：
    //      ① 存在性：`canOrder` 必须出现 —— 防「**被删**」、防「**被全局替换**」
    //      ② 同现：必须与「用户端」同现 —— 防「被改成 canAssign 后变成一句废话」
    //      ③ 内容：必须含「不要全局替换」警示语 —— 防「注释还在但没讲清为什么不能动」
    //
    // ⚠️ **本条刻意不剥注释** —— 与 N1-17 / N1-3b 相反。
    //    那两条盯的是**代码**，说明注释里的同名符号是噪音（不剥 ⇒ 恒红）；
    //    这一条盯的**就是注释本身**，剥了它就什么都没了 ⇒ 恒绿。
    //    ⇒ **「剥不剥注释」不是一个可以全局定的开关，取决于「这一条盯的是代码还是注释」。**
    //
    // ⚠️ 当前状态：**③ 未满足**（后端尚未在原地补警示语）⇒ 本条现在**是红的**，这是对的。
    // ───────────────────────────────────────────────────────────────────────
    id: 'N1-20',
    desc: '★ 后台两处 canOrder 解释性引用：必须存在 ∧ 与「用户端」同现 ∧ 含「不要全局替换」警示语',
    // ⚠️ T5 第三步（2026-10-27）：那段解释性注释随 `listBuildings()` 迁进了
    //    `building-query.service.ts`。**判据跟着真源改指**（钉在原文件 ⇒ 真文件侧
    //    `realAlso` 恒 false，判据表面绿、实际已失明 —— 与 N1-16 盲区同一形状）。
    //    `files[0]` 是破化对象，故 `buildingQuery` 必须排第一。
    files: ['buildingQuery', 'buildingAdminController'],
    pred: (ts) =>
      ts.every((t) => {
        if (!t) return false;
        // ① 存在性
        if (!/\bcanOrder\b/.test(t)) return false;
        // ②③ 定位每一处 `canOrder`，取其 ±240 字邻域，要求「用户端」与警示语同现
        const re = /\bcanOrder\b/g;
        let m;
        while ((m = re.exec(t)) !== null) {
          const near = t.slice(Math.max(0, m.index - 240), m.index + 240);
          if (/用户端/.test(near) && /不要全局替换|不得全局替换|勿全局替换/.test(near)) return true;
        }
        return false;
      }),
    sample: [
      `        /**
         * 配置上能不能开团（**无时间维度** · 管家端语义，与用户端 \`canOrder\` 不是一回事）
         *
         * ⚠️ 这里的 \`canOrder\` 是**解释性引用**（说明管家端语义与用户端语义的区别），
         *    **不要全局替换**为 \`canAssign\` —— 用户端 / 团长端的字段名仍是 \`canOrder\`。
         */
        canAssign: this.canAssignOf(`,
      `      '\`canAssign\` = 配置上能不能开团（营业中 ∧ 已归群 ∧ 所属楼群未停用），**无时间维度**；' +
      '与用户端「此刻能否下单」的 \`canOrder\` 不是同一件事；' +
      '⚠️ 此处的 \`canOrder\` 是解释性引用，**不要全局替换**为用户端之外的写法。' +`,
    ],
    // 破化方向 = 三种真实误操作里最隐蔽的一种：注释还在、字数没变，但警示语被删了
    // （另两种「整段删除」与「改成 canAssign」由下面 HELPER_CHECKS 里的两条专项自证覆盖）
    mutateFirst: (t) => t.replace('**不要全局替换**为 `canAssign`', '**改名后**为 `canAssign`'),
    absentHint:
      'building-admin.service.ts / building-admin.controller.ts 存在性检查（两文件缺一即不判定）',
  },

  // ════════════════════════════════════════════════════════════════════════════
  // v2.5 · 架构师新增判据（编号已顺延：原 N1-20/21/22 → N1-23/24/25，
  //        因 `N1-20` 已被上面「后台 canOrder 解释性引用」占用）
  // ════════════════════════════════════════════════════════════════════════════
  {
    // ───────────────────────────────────────────────────────────────────────
    // ⚠️ **取值范围必须精确到两个常量本身，不能全文匹配**（架构师特意点出）。
    //    `orderability.ts` 的注释里就含「楼群」二字（「`building_not_grouped` 的唯一来源…」），
    //    全文匹配会把**正确的注释**判成违规 ⇒ 逼执行者删掉它。本批这个坑已踩三次。
    //    ⇒ 故用**带键名的锚定正则**各取一侧，逐字比对：
    //       · `building_not_grouped: '…'`          （REASON_TEXT 的键）
    //       · `[ErrorCode.BUILDING_NOT_GROUPED]: '…'`（ERROR_MESSAGE 的键）
    //
    // ⚠️ 三条合取，缺一不可：
    //    ① 两侧常量都取得到 —— 取不到 ⇒ 判红（防「把一侧删掉也算过」）
    //    ② 都非空 —— 空串 ⇒ 判红（用户会看到空白）
    //    ③ 逐字相等 —— 任一侧改了另一侧没改 ⇒ 红
    // ───────────────────────────────────────────────────────────────────────
    id: 'N1-23',
    desc: '★ REASON_TEXT.building_not_grouped 与 ERROR_MESSAGE[BUILDING_NOT_GROUPED] 必须逐字相等（文案两处同源）',
    files: ['orderability', 'errCode'],
    pred: (ts) => {
      const [ord, err] = ts;
      const a = ord.match(/building_not_grouped:\s*'([^']*)'/)?.[1];
      const b = err.match(/\[ErrorCode\.BUILDING_NOT_GROUPED\]:\s*'([^']*)'/)?.[1];
      if (a === undefined || b === undefined) return false; // ①
      if (a === '' || b === '') return false; // ②
      return a === b; // ③
    },
    // ⚠️ **「必不报」样本必须是「人为改一致之后」的构造形态**，不能拿不一致的现状当必不报
    //    （那样等于把「它本来就该报」当成了「它不该报」）。本样本两侧同源同文。
    sample: [
      `  building_not_grouped: '该办公楼暂未开通服务，请联系运营',`,
      `  [ErrorCode.BUILDING_NOT_GROUPED]: '该办公楼暂未开通服务，请联系运营',`,
    ],
    // 破化方向 = 最可能的误操作：只改了 REASON_TEXT 一侧，忘了 ERROR_MESSAGE
    mutateFirst: (t) =>
      t.replace(
        "building_not_grouped: '该办公楼暂未开通服务，请联系运营'",
        "building_not_grouped: '该办公楼未配置楼群'",
      ),
    absentHint: 'orderability.ts / error-code.ts 两侧文案一致性检查（两文件缺一即不判定）',
  },
  {
    // ───────────────────────────────────────────────────────────────────────
    // ⚠️ **不写死行号清单，全仓 grep `BUILDING_NOT_GROUPED` 的 throw 点逐个查**
    //    （架构师建议，理由同 N1-7：从「抛点在哪」倒推会漏）。
    //    实测 4 处抛点：
    //      `meal.service.ts` · `order.service.ts:293`（**4 参形式**，第 2 参是 `undefined`
    //      因为要传第 4 个 payload）· `order.service.ts:1693` · `traceability.service.ts`
    //    ⇒ 第 2 参为 `undefined` 是**合规**的（占位），只有写死文案才红。
    //
    // ⚠️ ① 抛点至少 1 处（防 `[].every()` 恒绿）
    //   ② 每个抛点的第 2 实参要么没有、要么是 `undefined`
    // ───────────────────────────────────────────────────────────────────────
    id: 'N1-24',
    desc: '★ 抛 BUILDING_NOT_GROUPED 时不得传第二参数（文案统一由 ERROR_MESSAGE 提供，调用点不得内联覆写）',
    scan: { dir: () => SRC, needle: 'BUILDING_NOT_GROUPED', radius: 200 },
    scope: (hits) =>
      hits.filter((h) => !h.isComment && /^throw\s+new\s+BizException\s*\(/.test(h.stmt ?? '')),
    pred: (hits) => {
      const throws = hits.filter(
        (h) => !h.isComment && /^throw\s+new\s+BizException\s*\(/.test(h.stmt ?? ''),
      );
      if (throws.length === 0) return false; // ①
      return throws.every((h) => {
        // ⚠️ 用 `call`（圆括号配对的**完整调用**），不能用 `stmt`（会被行尾截断）
        const args = argsOf(h.call ?? '');
        if (!args) return false;
        return args.length === 1 || args[1] === 'undefined'; // ②
      });
    },
    scanGood: () => [
      ctxOf('throw new BizException(ErrorCode.BUILDING_NOT_GROUPED);'),
      ctxOf(
        'throw new BizException(ErrorCode.BUILDING_NOT_GROUPED, undefined, undefined, { a: 1 });',
      ),
    ],
    scanBroken: () => [
      ctxOf(
        "throw new BizException(ErrorCode.BUILDING_NOT_GROUPED, '所属办公楼未配置楼群，请联系运营');",
      ),
    ],
    absentHint:
      '全仓未扫到 BUILDING_NOT_GROUPED 的抛点 ⇒ 要么抛点被删，要么改名了（需同步 needle）',
  },
  {
    // ───────────────────────────────────────────────────────────────────────
    // ⚠️ **取值范围必须精确到「含 code 判定的 computed」，❌ 全文件扫中文会恒红**
    //    （架构师特意点出 —— 满文件都是中文，全扫等于禁掉中文，那是胡来）。
    //
    // ⚠️ **为什么不恒红**：`code === undefined`（网络失败 / 服务端没给 message）那一支
    //    **允许**硬编码 —— 那时确实没有服务端文案可回落。判据只判
    //    「**code 已知**那一支」，不带 message 的分支不在范围内。
    //
    //    ⇒ 本批最贴切的一个实例，同一个文件里两支写法正对着：
    //        apps/miniprogram/src/pages/index/index.vue
    //        · emptyHint（✅）：`loadError.value?.message ?? '选好办公楼后即可查看次日组合'`
    //        · emptyText（❌）：`code === undefined` 之后仍 `return '你还没有选择办公楼'`
    //      ⇒ **全文件扫中文会把 emptyHint 一起判红**，逼人删掉正确写法。
    //
    // 判定式（机械）：
    //   ① 扫 `code === undefined` / `code !== undefined`，取包围它的 `computed(` 块
    //   ② 只看该块里**位于 code 判定之后**的 `return`
    //   ③ 该 return 若含中文且未引用 `.message` ⇒ 红
    //      （与守卫**同一行**且守卫是 `=== undefined` 的 ⇒ 属「码未知」支，放行）
    // ───────────────────────────────────────────────────────────────────────
    id: 'N1-26',
    desc: '★ 端上错误兜底：服务端已给 code 的那一支必须回落 `.message`，不得硬编码中文',
    // ⚠️ **`ext` 必须显式放开到 `.vue`**：`scanHits` 默认只扫 `.ts`（因为前两条扫描判据
    //    盯的是 api-server/src），而端上兜底逻辑**全在 `.vue` 里** ⇒ 首版扫到 0 处。
    //    ⇒ 又一次「默认范围不够 ⇒ 判据对着空气判」，且失效方向是**恒红**（看得见，还好）。
    scan: { dir: () => MP, needle: 'code\\s*={3}|code\\s*!={2}', radius: 600, ext: /\.(ts|vue)$/ },
    // ⚠️ **按块去重**：同一个 computed 里往往有 2~3 个 `code ===` 命中点，
    //    不去重 ⇒ 同一个缺陷被报 2~3 次（首版报了 `index.vue:377 / 378` 两条，
    //    其实是同一个 computed 里的同一处）。这正是 Team Lead 提醒的
    //    **「红条数虚高，让人以为有两个问题」**。
    scope: (hits) => {
      const seen = new Set();
      return hits.filter((h) => {
        if (h.isComment || !h.blk) return false;
        if (seen.has(h.blk)) return false;
        seen.add(h.blk);
        return true;
      });
    },
    pred: (hits) => {
      const coded = hits.filter((h) => !h.isComment && h.blk);
      if (coded.length === 0) return false; // 防 [].every() 恒绿
      return coded.every((h) => {
        const b = h.blk;
        const gi = b.search(/code\s*(?:===\s*undefined|!==\s*undefined)/);
        if (gi < 0) return true; // 不是我们要判的那个形状
        const guardUnknown = /code\s*===\s*undefined/.test(b.slice(gi, gi + 80));
        const re = /\breturn\b/g;
        let m;
        while ((m = re.exec(b)) !== null) {
          if (m.index < gi) continue;
          const lineStart = b.lastIndexOf('\n', m.index) + 1;
          const lineEnd = b.indexOf('\n', m.index);
          const line = b.slice(lineStart, lineEnd < 0 ? b.length : lineEnd);
          // ①「码未知」支（与 `=== undefined` 守卫同行）⇒ 服务端没给 ⇒ 允许硬编码
          if (/code\s*(?:===\s*undefined|!==\s*undefined)/.test(line) && guardUnknown) continue;
          // ② **专属分支白名单**（显式登记，**不是**按形状豁免）
          //
          //    ⚠️ **为什么必须是白名单**：首版按形状豁免（「分支条件是某个常量就放行」），
          //       于是任何人把硬编码写成
          //          `if (err.code === 60011) return '该办公楼暂未开通服务';`
          //       这种**专属分支形态**，判据就绿 —— 而架构师明令「不要给 60011 补专属分支」。
          //       ⇒ 这是「判据可被规避」的**又一种形态**：
          //         上一次（W1-UI-1/2/3）是**改注释**就能绕过，这一次是**改分支形状**。
          //          改注释那次还能靠「剥注释」一劳永逸；改分支形状没有等价的通用手段 ——
          //          「这个码用户能不能自己解决」是**语义判断，机械判据做不了**。
          //       ⇒ 只剩一条路：**白名单 + 每条带理由**。想往里加码的人必须**先回答那个问题**，
          //          登记动作本身就是那句「要加就先问」。这是 fail-closed，形状豁免是 fail-open。
          //
          //    ⚠️ **必须按常量名匹配，不能按码值**：按码值匹配 ⇒ 端上写裸数字
          //       `err.code === 20016` 也能绕过，口子只是换了个位置。
          const branchName = line.match(/code\s*===\s*([A-Za-z_][\w.]*)/)?.[1] ?? '';
          // 码未知支（`undefined` / `null`）⇒ 服务端根本没给 ⇒ 允许硬编码（与 ① 同族）
          if (branchName === 'undefined' || branchName === 'null') continue;
          if (EXCLUSIVE_BRANCH_ALLOWLIST.some((w) => w.name === branchName)) continue;
          const stmt = b.slice(m.index, lineEnd < 0 ? b.length : lineEnd);
          if (/[一-龥]/.test(stmt) && !/\.message/.test(stmt)) return false;
        }
        return true;
      });
    },
    // ⚠️ **必不报样本必须覆盖白名单支**：只给「回落支回落 `.message`」这一个样本时，
    //    白名单那段逻辑**一次都没被执行过** ⇒ 白名单改坏了自证照样绿
    //    （单向 mutate 只证明「必报的会报」，证明不了「不该报的没被误伤」）。
    scanGood: () => [
      // ① 白名单内的专属分支（`CODE_BUILDING_UNBOUND`）⇒ **必不报**
      blkOf(`computed(() => {
  const err = loadError.value;
  if (!err || err.code === undefined) return '今日暂无开团';
  if (err.code === CODE_BUILDING_UNBOUND) return '你还没有选择办公楼';
  return err.message || '今日暂无开团';
})`),
      // ② 回落支回落 `.message` ⇒ **必不报**
      blkOf(`computed(() => {
  if (loadError.value?.code === undefined) return '今日暂无开团';
  return loadError.value?.message ?? '本楼今日未开团';
})`),
    ],
    scanBroken: () => [
      // ① **绕过白名单的形态**：给 60011 补一支专属分支，且用**裸码值**写
      //    ⇒ 白名单按**常量名**匹配 ⇒ 匹配不上 ⇒ **必报**（正是要堵的那个口子）
      blkOf(`computed(() => {
  const err = loadError.value;
  if (!err || err.code === undefined) return '今日暂无开团';
  if (err.code === 60011) return '该办公楼暂未开通服务，请联系运营';
  return err.message || '今日暂无开团';
})`),
      // ② **绕过白名单的另一种形态**：换成常量名也照样红 —— 名字不在白名单里
      //    ⇒ 「想加专属分支先登记」这件事真的被执行，而不是换个写法就能免
      blkOf(`computed(() => {
  const err = loadError.value;
  if (!err || err.code === undefined) return '今日暂无开团';
  if (err.code === CODE_BUILDING_NOT_GROUPED) return '该办公楼暂未开通服务';
  return err.message || '今日暂无开团';
})`),
      // ③ 回落支硬编码中文（原样本）⇒ **必报**
      blkOf(`computed(() => {
  if (loadError.value?.code === undefined) return '今日暂无开团';
  return needsBuilding.value ? '你还没有选择办公楼' : '本楼今日未开团';
})`),
    ],
    absentHint:
      '小程序侧未扫到含 `code === undefined` 判定的 computed ⇒ 要么兜底形态整体改了，要么路径变了',
  },

  // ════════════════════════════════════════════════════════════════════════════
  // v2.5 · W1 呈现层四条
  // ════════════════════════════════════════════════════════════════════════════
  {
    id: 'W1-UI-1',
    desc: '★ W1 停售页不得走 ab_config / bizConfig 路线（状态读取只走 GET /admin/sales-pause）',
    file: 'salesPauseVue',
    // ⚠️ **必须剥注释**：该文件 `:155` 的说明注释正写着「状态读取只走 GET /admin/sales-pause
    //    （§13.1 的两条『不得』）」—— 这类注释是正面 exemplar。不剥 ⇒ 将来有人补一句
    //    「不要读 ab_config」的注释就被判红，逼人删掉正确的说明。
    pred: (t) => !/ab_config|bizConfig|BizConfigService/i.test(stripComments(t)),
    sample: `  // W1 · 状态读取只走 GET /admin/sales-pause
  const { data } = await http.get('/admin/sales-pause');`,
    mutate: (t) => t.replace("await http.get('/admin/sales-pause')", 'await bizConfig.get()'),
    absentHint: 'apps/admin-web/src/views/system/sales-pause.vue 尚未落地',
  },
  {
    id: 'W1-UI-2',
    desc: '★ 小程序停售分支必须比对 60009（CODE_SALES_PAUSED），且**不得**出现 60010',
    file: 'orderCreateVue',
    // ⚠️ **必须剥注释**：`:287` 的说明注释里写着「区分信号只有 U6 下单返回的 `60009`」。
    //    不剥 ⇒ **只写注释不写代码也判绿**（本批 N1-14 那个形状再来一次）。
    //
    // ⚠️ 为什么禁 60010：60009（全局停售）与 60010（某栋楼停用）**号位相邻、极易记串**。
    //    判停售必须比对**码号**，别比对文案 —— 右邻码写错，端上会把「全站停售」
    //    显示成「你这栋楼停了」，而其余楼其实也停了。
    pred: (t) => {
      const b = stripComments(t);
      return /CODE_SALES_PAUSED/.test(b) && !/\b60010\b/.test(b);
    },
    sample: `    if (e instanceof ApiError && e.code === CODE_SALES_PAUSED) {`,
    // 破化方向 = 那个最容易犯的错：写成相邻的 60010
    mutate: (t) => t.replace('e.code === CODE_SALES_PAUSED', 'e.code === 60010'),
    absentHint: 'apps/miniprogram/src/pages/order-create/order-create.vue 尚未落地',
  },
  {
    id: 'W1-UI-3',
    desc: '★ admin/sales-pause/ 写路径不得出现 60006/60007/60012/60013（那四个是**停用**码，不是停售码）',
    files: ['salesPauseService', 'salesPauseController'],
    // ⚠️ **「命中数 0」型判据必须配反向要求** —— 否则「把整个目录删掉」也算过。
    //    这是本批第三次撞上「恒绿 = 没检查」：只禁不禁建 ⇒ 「不做」不等于「做对」。
    //    ⇒ 反向要求：写路径（`create` / `resume`）必须真的还在。
    pred: (ts) => {
      const [svc, ctl] = ts;
      const alive = /\basync create\(/.test(svc) && /\basync resume\(/.test(svc) && ctl.length > 0;
      const clean = ts.every((t) => !/60006|60007|60012|60013/.test(stripComments(t)));
      return alive && clean;
    },
    // ⚠️ 样本必须同时含 `create` 与 `resume` —— 判据里的**反向要求**（写路径还在）
    //    要的就是这两条；首版样本只写了 `create` ⇒ 自证报 `good通过=false`，
    //    那是**样本**不合规，不是判据错。（自证的价值就在这里：它连样本一起验。）
    sample: [
      `  async create(dto: CreateSalesPauseDto, actor: JwtPayload): Promise<SalesPause> {
    return this.repo.save(dto);
  }
  async resume(id: number, actor: JwtPayload): Promise<SalesPause> {
    return this.repo.save({ id });
  }`,
      `  @Post()
  create(@Body() dto: CreateSalesPauseDto) { return this.svc.create(dto, null); }
  @Post(':id/resume')
  resume(@Param('id') id: number) { return this.svc.resume(id, null); }`,
    ],
    // 破化方向 = 顺手把停用码搬过来当停售码用
    mutateFirst: (t) =>
      t.replace(
        'async create(dto: CreateSalesPauseDto',
        'const X = 60012;\n  async create(dto: CreateSalesPauseDto',
      ),
    absentHint: 'apps/api-server/src/modules/admin/sales-pause/ 尚未落地',
  },
  {
    id: 'W1-UI-4',
    desc: '★ 小程序停售态展示分支必须同时给出「已下订单不受影响」（否则用户以为自己的单也被停了）',
    file: 'orderCreateVue',
    // ⚠️ 取值范围精确到 `CODE_SALES_PAUSED` 所在的**那个 if 分支块**，不做全文件扫
    //    （全文件扫会把 `constants/index.ts` 里的常量定义算进来 ⇒ 恒绿）。
    //
    // ⚠️ **首版取窄了，自证之外又踩一次**：写成「从 `CODE_SALES_PAUSED` 到第一个 `}`」，
    //    而模板字符串 `` `${e.message} ${SALES_PAUSED_UNAFFECTED_NOTICE}` `` 里
    //    `${e.message}` 的 `}` 排在最前面 ⇒ 分支块被截在常量**之前** ⇒ 判红。
    //    ⇒ **按距离取字符（哪怕只取到「下一个 `}`」）都会把结构切错**；
    //      要按结构：回找 `if (`，再花括号配对取整个分支块。
    // ⚠️ **必须遍历所有出现点，不能用 `indexOf` 取第一个**：
    //    `order-create.vue:178` 是 `import { ApiError, CODE_SALES_PAUSED } from '@/api/request'`
    //    —— **import 排在使用分支之前**，首版 `indexOf` 命中的就是它 ⇒
    //    `lastIndexOf('if (', i)` 抓到远处一个不相干的 `if (` ⇒ 距离超阈值 ⇒ 判红。
    //    ⇒ 又是一次「取第一个匹配」而不是「取目标形态的那个匹配」。
    pred: (t) => {
      const b = stripComments(t);
      const re = /CODE_SALES_PAUSED/g;
      let m;
      while ((m = re.exec(b)) !== null) {
        const i = m.index;
        const ifStart = b.lastIndexOf('if (', i);
        if (ifStart < 0 || i - ifStart > 200) continue; // 这一处不是分支判定（比如 import）
        const open = b.indexOf('{', i);
        if (open < 0) continue;
        let depth = 0;
        let end = -1;
        for (let j = open; j < b.length; j += 1) {
          if (b[j] === '{') depth += 1;
          else if (b[j] === '}') {
            depth -= 1;
            if (depth === 0) {
              end = j;
              break;
            }
          }
        }
        if (end < 0) continue;
        const branch = b.slice(open, end);
        // ① **认常量名**（推荐形态）：文案收进 `constants/index.ts`，分支引用常量。
        //    这是**更正确**的写法（避免同一句措辞演化成两个出处），判据必须认它 ——
        //    只扫中文字面 ⇒ 对着一个被引用的常量扫到 0 命中 ⇒ **假红**
        //    （team-lead 有 `git diff` 实证，backend-w1 也报了同一条红）。
        if (/SALES_PAUSED_UNAFFECTED_NOTICE/.test(branch)) return true;
        // ② **兜底认值里的「不受影响」**：有人直接内联文案（没走常量）也算数。
        //    ⇒ 判据**不钉死一句完整文案** —— 前端换措辞就被判红那是误伤，
        //       而误伤的下场是有人去改掉那个本来就合法的东西。
        if (/不受影响/.test(branch)) return true;
      }
      // 走到这里 = 没有**任何一个**停售分支给出不受影响说明（或压根没有停售分支）
      return false;
    },
    // ⚠️ 样本必须是**花括号配平的分支块**：判据要 brace-match 整个 if 分支，
    //    收尾的 `}` 缺失 ⇒ 配对失败 ⇒ 自证报 `good通过=false`。
    //    （首版样本抄的是「到 showToast 为止」的片段，被自证当场拦下。）
    sample: `    if (e instanceof ApiError && e.code === CODE_SALES_PAUSED) {
      uni.showToast({ title: \`\${e.message} \${SALES_PAUSED_UNAFFECTED_NOTICE}\` });
    } else {
      toastApiError(e);
    }`,
    // 破化方向 = 只报停售、不告诉用户已有订单没事
    mutate: (t) => t.replace('${e.message} ${SALES_PAUSED_UNAFFECTED_NOTICE}', '${e.message}'),
    absentHint: 'apps/miniprogram/src/pages/order-create/order-create.vue 尚未落地',
  },
  {
    // ───────────────────────────────────────────────────────────────────────
    // N2-TPL-1 / N2-TPL-2 · **「发错通知模板」的静态契约面**
    //
    // ⚠️ 起因（backend 破化自证出来的，看板 48 条 + jest 115 条**全不红**）：
    //    他把 `notifySuspendAffected()` 里 `refund_applying / refunding` 的场景名
    //    改成 `building_suspend_fulfill` —— 等于给一个**正在退款**的用户发
    //    「照常配送」。⇒ spec §6.5 D-N2-3b「**发错比不发更糟**」这条本批最重的
    //    用户可感缺陷，**一度没有任何自动检查**。
    //
    //    ⇒ jest 那侧（`test/unit/suspend-notify.spec.ts`）守**运行时发的是哪一条**；
    //      本条守**契约面**：模板文案与 scene 的对应关系、以及接线端的三元方向。
    //      两者不是同一件事 —— jest 锚的是生产模板（后端明确要求别锚测试里的字面量），
    //      而「模板文案被换掉」这件事 jest 那份**照绿**（它读的就是被换掉之后的值）。
    // ───────────────────────────────────────────────────────────────────────
    id: 'N2-TPL-1',
    desc: '★ 停用通知两个场景的**文案契约**：fulfill 必须承诺「照常」，refund **不得**出现履约承诺',
    file: 'tplSpecs',
    pred: (t) => {
      const fulfill = suspendSpecOf(t, 'building_suspend_fulfill');
      const refund = suspendSpecOf(t, 'building_suspend_refund');
      if (!fulfill || !refund) return false; // 两个场景都必须在（合成一个 ⇒ 立刻红）
      if (fulfill.content === null || refund.content === null) return false;
      // ① 履约场景**必须**给出「照常」承诺 —— 用户真正想知道的就是「我的饭还来不来」
      if (!/照常/.test(fulfill.content)) return false;
      // ② 退款场景**不得**出现任何履约承诺措辞 ⇒ 否则是**事实性错误**，
      //    用户会据此不做午饭安排，而他的饭根本不会来（AC N2-AC-07）
      if (/照常|将送达|会送达|正常配送/.test(refund.content)) return false;
      // ③ 两个场景的 `variables` 都必须含 `orderNo`：
      //    spec §6.5 要求运营事后看得到「漏的是**谁**」，`orderNo` 是唯一凭据
      return /'orderNo'/.test(fulfill.vars) && /'orderNo'/.test(refund.vars);
    },
    // 破化方向 = **backend 那个变异的契约面版本**：把「照常配送」写进退款模板
    mutate: (t) =>
      t.replace(
        "'【ABox 通知】您 {{mealDate}} 的订单退款正在处理中，款项将原路退回，请注意查收。'",
        "'【ABox 通知】您 {{mealDate}} 的订单退款正在处理中，款项将原路退回，会照常配送。'",
      ),
    absentHint: 'apps/api-server/src/modules/admin/template/message-template.specs.ts 未落地',
  },
  {
    id: 'N2-TPL-2',
    desc: '★ 停用通知的**接线方向**：三元真支必须是 refund 场景、假支必须是 fulfill，且条件认退款态',
    // T5（2026-10-27）：`notifySuspendAffected()` 已迁入 `building-suspend.service.ts`
    file: 'buildingSuspend',
    pred: (t) => {
      const fn = methodOf(stripComments(t), 'notifySuspendAffected');
      if (!fn) return false;
      // ① 两个 scene 各出现**恰好 1 次**（多一份 ⇒ 又变成「同一件事两份表述」）
      const nRefund = (fn.match(/'building_suspend_refund'/g) ?? []).length;
      const nFulfill = (fn.match(/'building_suspend_fulfill'/g) ?? []).length;
      if (nRefund !== 1 || nFulfill !== 1) return false;
      // ② **方向**：`条件 ? 'refund' : 'fulfill'`
      //    ⚠️ 方向搞反 ⇒ 退款中的用户收到「照常配送」，而他的饭不会来。
      //       这正是 backend 那个变异的形状，也是本条存在的唯一理由。
      const tern = fn.match(/\?\s*'(building_suspend_\w+)'\s*:\s*'(building_suspend_\w+)'/);
      if (!tern) return false;
      if (tern[1] !== 'building_suspend_refund') return false;
      if (tern[2] !== 'building_suspend_fulfill') return false;
      // ③ 三元的**条件**必须认退款态 —— 否则「方向对」只是巧合
      const q = fn.indexOf('?', fn.indexOf(tern[0]) - tern[0].length);
      const cond = fn.slice(Math.max(0, q - 260), q);
      return /REFUND_APPLYING|REFUNDING/.test(cond);
    },
    // 破化方向 = 把三元两端**对调**（backend 那个变异的接线面版本）
    mutate: (t) =>
      t.replace(
        "? 'building_suspend_refund'\n                  : 'building_suspend_fulfill',",
        "? 'building_suspend_fulfill'\n                  : 'building_suspend_refund',",
      ),
  },
  {
    // ───────────────────────────────────────────────────────────────────────
    // W1-UI-5 · **端上不得把 U1 的 `reason` 当枚举码做字符串比较**
    //
    // ⚠️ 背景（这次的坑有多安静）：spec §7.6 上一版写着「U1 返回 `reason = 'sales_paused'`」
    //    —— **是错的**。回源 `meal.service.ts:144` 是 `reason: availability.reasonText`，
    //    U1 下发的 `reason` 是**中文文案**；枚举码只存在于服务内部（`reason` 与 `reasonText`
    //    两个字段，到 HTTP 层**文案顶掉了码的位置，还叫同一个名字**）。
    //    ⇒ 照规格写的人不会觉得自己在犯错，而**类型检查、构建、e2e 全都不会红**：
    //      端上拿到中文文案，`=== 'sales_paused'` 恒 false，分支静默不进，
    //      页面表现只是「少了那句话」，没人会去查。
    //
    // ⚠️ **必须按「字段来源」收窄，不能按变量名 `reason` 全扫**：
    //    小程序里有 4 处 `reason === 'other'` 是 **U11 自助取消理由** ——
    //    `reason` 是**端上自己的枚举**，且是**请求入参**（`api/order.ts:70` /
    //    `pages/order-cancel/order-cancel.vue:91`），`'other'` 是**服务端认的字面值**，
    //    改掉它等于直接破坏取消理由提交。⇒ **同名不同义**，按变量名扫必误伤。
    //    ⇒ needle 钉到 `daily.reason`（U1 下发的那个字段的读取表达式）。
    //
    // ⚠️ **必须剥注释**：`pages/order-create/order-create.vue:284` 的说明注释里
    //    刻意写着 `reason === 'sales_paused'` 这个字面 —— 它正是在解释
    //    「**为什么这里不能这么写**」。连注释一起扫 ⇒ 惩罚「把禁止理由写清楚」，
    //    下一个人会**把注释删掉**而不是改代码。
    //    （与 W1-UI-1/2/3 同款；`N1-20` 那种刻意盯注释存在性的判据才该不剥。）
    //
    // ⚠️ 形态自问（G11 第 1 条）：守的是**结构模式**（有没有拿 `daily.reason`
    //    和字符串字面量做相等比较），不是运行时行为 ⇒ **静态有效，不需要 jest**。
    // ───────────────────────────────────────────────────────────────────────
    id: 'W1-UI-5',
    desc: '★ 端上不得把 U1 的 `daily.reason`（下发的是**中文文案**）当枚举码做字符串比较',
    scan: { dir: () => MP, needle: 'daily\\.reason', radius: 200, ext: /\.(ts|vue)$/ },
    // ⚠️ 与 `pred` 同口径（供 `detailOf()` 复用），否则判据说一套、输出说一套。
    scope: (hits) => hits.filter((h) => !h.isComment),
    pred: (hits) => {
      const code = hits.filter((h) => !h.isComment);
      if (code.length === 0) return false; // 防 [].every() 恒绿
      return code.every((h) => {
        const ctx = h.ctx ?? '';
        const i = ctx.indexOf('daily.reason');
        if (i < 0) return true; // 取不到上下文 ⇒ 不妄判
        const after = ctx.slice(i, i + 160);
        // 红 ⇔ `daily.reason` 被当成**码**与字符串字面量做**相等比较**
        //
        // ⚠️ 三条边界（写宽了会恒红 / 会误伤，team-lead 与架构师都点名要求）：
        //   ① `reason === 'sales_paused'` 这类**枚举码字符串比较**      ⇒ 禁（红）
        //   ② `e.code === 60009` 这类**数值错误码比较**                  ⇒ 允许
        //      （唯一可靠的机器判别手段，`CODE_SALES_PAUSED = 60009` 就是这么写的）
        //   ③ 把 `reason` 当**文案**直接展示 / `.trim()` / 拼接           ⇒ 允许
        //      （它本来就是文案；`??` / `||` / `.trim()` 都不是相等比较）
        //   ⇒ 只禁「**字段 + 相等比较 + 字符串字面量**」三者同现，
        //      写成「端上不得出现服务端枚举字面」一定恒红。
        return !/daily\.reason\s*(?:[!=]==?)\s*['"`]/.test(after);
      });
    },
    scanGood: () => [
      // ① 真实形态：把 `reason` 当**文案**展示（含 `??` 兜底）⇒ **必不报**
      ctxOf("{{ daily.reason ?? '当前不可下单' }}"),
      // ② 数值错误码比较（唯一可靠的机器判别手段）⇒ **必不报**
      ctxOf('if (e instanceof ApiError && e.code === 60009) {'),
      // ③ **防误伤负控**：U11 自助取消理由里的 `reason === 'other'`（端上枚举、
      //    请求入参、与 U1 同名不同义）⇒ **必不报**。
      //    缺了这一条，判据就会把主链路扫红而没人认领 ——
      //    正是 team-lead 在 N1-26 上刚栽过的那一种。
      ctxOf("? { reason, ...(reason === 'other' && note?.trim() ? { note: note.trim() } : {}) }"),
    ],
    scanBroken: () => [
      // 破化方向 = 照着**写错的规格**抄一遍（本次真实发生的失败路径）
      ctxOf("if (daily.reason === 'sales_paused') return '今日暂停接单';"),
      // 反向破化 = 换成别的原因码也一样红（**一类写法，不是一个字面**）
      ctxOf("const suspended = daily.reason === 'building_suspended';"),
    ],
    absentHint: '小程序侧未扫到 `daily.reason` 的读取点 ⇒ 字段名改了或页面形态变了，需回源确认锚点',
  },
  {
    // ───────────────────────────────────────────────────────────────────────
    // D-N2-4-b：**单立**（Team Lead 裁定「未被覆盖，值得单立」）
    //
    // 什么时候红：有人把第 4 条改成「不存在或已停用」⇒ 红。
    // 理由：存在性已由第 1 条三选一承担，第 4 条再承担一次就是**重复判定**；
    //       且 `group_suspended` 这个 reason 会整体消失（它是 60010 的四输入之一，
    //       且有独立文案「该区域已暂停服务」）。
    // ───────────────────────────────────────────────────────────────────────
    id: 'D-N2-4-b',
    desc: '★ evaluateStructure 第 4 条必须仍是「楼群**已停用**」的语义判定（不得并入存在性）',
    file: 'orderability',
    pred: (t) => {
      const b = fnOf(stripComments(t), 'evaluateStructure');
      if (!b) return false;
      return (
        /buildingGroupStatus\s*===\s*BuildingGroupStatus\.SUSPENDED/.test(b) &&
        /reason:\s*'group_suspended'/.test(b)
      );
    },
    // ⚠️ 样本**必须带 `function evaluateStructure(` 这个函数头**：判据用
    //    `fnOf(t, 'evaluateStructure')` 取函数体，取不到就返回空串 ⇒ 自证 `good通过=false`。
    //    首版样本只抄了函数体里那三行 ⇒ 自证当场报出来。（与 `blockOf` 那次同源：
    //    **取数取不到**与**产物不合**在输出上一模一样，靠自证才分得开。）
    sample: `export function evaluateStructure(s: StructureScope): StructureResult {
  if (s.buildingGroupStatus === BuildingGroupStatus.SUSPENDED) {
    return { ok: false, reason: 'group_suspended' };
  }
  return { ok: true, reason: null };
}`,
    // 破化方向 = 把第 4 条并进存在性（于是 group_suspended 这个 reason 消失）
    mutate: (t) =>
      t.replace(
        'if (s.buildingGroupStatus === BuildingGroupStatus.SUSPENDED) {',
        'if (s.buildingGroupStatus === null) {',
      ),
  },
];

// ── 取数 ────────────────────────────────────────────────────────────────────
const cache = new Map();
function read(key) {
  if (cache.has(key)) return cache.get(key);
  const p = F[key];
  const v = p && existsSync(p) ? readFileSync(p, 'utf8') : null;
  cache.set(key, v);
  return v;
}
function readMigration(name) {
  const dir = join(SRC, 'database', 'migrations');
  const p = join(dir, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/**
 * 按 `NNNNNNNNNNNN-<slug>.ts` 命名规则推导下一个迁移号。
 * ⚠️ 不用硬编码号位：别人的分支一旦先占了号，硬编码的那句提示就成了假信息。
 */
function nextMigrationName(slug = 'sales-pause') {
  const dir = join(SRC, 'database', 'migrations');
  if (!existsSync(dir)) return `1700000000001-${slug}.ts`;
  const max = readdirSync(dir)
    .map((f) => Number(f.match(/^(\d{10,})-/)?.[1] ?? 0))
    .reduce((a, b) => (b > a ? b : a), 0);
  return `${max + 1}-${slug}.ts`;
}

/** 「未判定」时的人话提示（默认回落到 desc，保证不新增静默） */
function hintOf(r) {
  if (!r.absentHint) return r.desc;
  return typeof r.absentHint === 'function' ? r.absentHint() : r.absentHint;
}

/** 返回 {kind, real, good, mutateText} —— good 是「必不报样本」，real 是真实文本 */
function samplesOf(r) {
  if (r.mode === 'hint') return { kind: 'HINT', real: null, root: null };
  if (r.scan) {
    // 全仓扫描型：取数单位不是「文件内容」而是「命中点列表」，故自证样本也用命中点列表。
    // ⚠️ 刻意**不复用** `mutate`：扫描型判据的输入是 `scanHits()` 的产物，
    //    对文本做字符串替换造不出「某个命中点变了」这个事件。
    const real = scanHits(r.scan.dir(), r.scan.needle, r.scan);
    return {
      kind: 'SCAN',
      real,
      root: r.scanGood(),
      broken: r.scanBroken(),
      realAlso: r.pred(real) === true,
    };
  }
  if (r.migration) {
    const real = readMigration(r.migration);
    if (real !== null) return { kind: 'REAL', real, root: real };
    return { kind: 'SYNTH', real: null, root: r.sample ?? '' };
  }
  if (r.files) {
    const reals = r.files.map(read);
    const missing = reals.some((v) => v === null);
    if (missing) return { kind: 'MISSING', real: null, root: null };
    // 同单文件分支：给了 sample 就一律以 sample 为 good 根（锚点一致性，见下注释）
    // ⚠️ `realAlso` 同样要在这里算 —— 首版只给单文件分支加了它，于是多文件判据
    //    （N1-18 / N1-11 / N1-14 这类）在**真检已绿**时仍被标成「真文件尚未满足」。
    //    ⇒ **修「工具说真话」这类改动，必须两个分支一起改**，否则只是把假话挪了个地方。
    const realAlso = (() => {
      try {
        return r.pred(reals) === true;
      } catch {
        return false;
      }
    })();
    if (Array.isArray(r.sample)) {
      const broke = r.sample.slice();
      broke[0] = r.mutateFirst(r.sample[0]);
      return { kind: 'SYNTH', real: reals, root: r.sample, broken: broke, realAlso };
    }
    if (r.pred(reals)) {
      const broke = reals.slice();
      broke[0] = r.mutateFirst(reals[0]);
      if (JSON.stringify(broke) !== JSON.stringify(reals)) {
        return { kind: 'REAL', real: reals, root: reals, broken: broke };
      }
    }
    return { kind: 'SYNTH-NO-SAMPLE', real: reals, root: null };
  }
  const real = read(r.file);
  // ⚠️ 只要给了 sample，就**一律以 sample 作为 good 根**：
  //    目标文件可能在中途被建出来（本批就是边写边查），届时若切成 REAL 路径，
  //    mutate 的锚点（写在 sample 里）在真文件上不存在 ⇒ replace 不生效 ⇒ 自证假失败。
  if (r.sample) {
    // ⚠️ `realAlso`：**真文件当前是否也已满足本判据**。
    //    有 sample 时 good 根一律取 sample（锚点一致性），但**这不代表真文件不满足** ——
    //    本批是边写边查，很多判据在写判据时目标尚未落地、后来落了地。
    //    若标签仍写「真文件尚未满足」，那就是**门禁在说假话**（N1-19 即是实例：
    //    真检已绿，自证却标 [SYNTH]「尚未满足」）。
    //    ⇒ 收口验收条件是「[SYNTH] 全部退化」，标签失真会让这个条件没法核。
    const realAlso =
      real !== null &&
      r.sample !== undefined &&
      (() => {
        try {
          return r.pred(real) === true;
        } catch {
          return false;
        }
      })();
    if (Array.isArray(r.sample)) {
      const broke = r.sample.slice();
      broke[0] = r.mutateFirst(r.sample[0]);
      return { kind: 'SYNTH', real, root: r.sample, broken: broke, realAlso };
    }
    return { kind: 'SYNTH', real, root: r.sample, broken: r.mutate(r.sample), realAlso };
  }
  if (real === null) return { kind: 'MISSING', real: null, root: null };
  if (r.pred(real)) {
    return { kind: 'REAL', real, root: real, broken: r.mutate(real) };
  }
  return { kind: 'SYNTH-NO-SAMPLE', real, root: null };
}

// ── 工具函数自证 ────────────────────────────────────────────────────────────
// ⚠️ RULES 的自证只覆盖「判据对不对」，覆盖不到「**取数工具对不对**」。
//    `blockOf` 正是被一个**正确且必要**的修复弄瞎过 —— 而当时 37 条判据的自证全绿，
//    因为它失配后返回空串，判据只是「不合」，自证看不出「不合」是**真的不合**还是
//    **探针没取到**。
//    ⇒ **凡是「先取一段文本再判断」的判据链，取数这一环必须单独自证。**
//
// 每条 = 「构造一个已知答案的样本，反向验证检测器本身」。已知答案是自证的前提：
// 如果我不知道正确答案，我就没有在验证，只是在记录。
const HELPER_CHECKS = [
  {
    name: 'N1-16 · 豁免对象 `buildingWarnings` 必须真实存在（防豁免指向空气 ⇒ 判据退化成永久盲区）',
    // 已知答案：豁免的前提是「被豁免的东西还在原位」。方法一旦被删或改名，
    //   `blockOf()` 取不到块 ⇒ pred 走严格分支 ⇒ 同样的合取立刻红。
    //   ⇒ 「豁免」不是一次性免死金牌，它**随对象消失而失效**。
    fn: () => {
      const r = RULES.find((x) => x.id === 'N1-16');
      const withWarn = [
        '  private buildingWarnings(b: Building) {',
        "    if (b.status !== BuildingStatus.ACTIVE && gid !== null) { w.push('x'); }",
        '  }',
      ].join('\n');
      const renamed = [
        '  private helper(b: Building) {',
        "    if (b.status !== BuildingStatus.ACTIVE && gid !== null) { w.push('x'); }",
        '  }',
      ].join('\n');
      return r.pred([withWarn]) === true && r.pred([renamed]) === false;
    },
  },
  {
    name: 'blockOf · 返回类型是泛型对象 Promise<{…}> 时仍能取到完整函数体',
    // 已知答案：应当取到含 `USER_BUILDING_UNBOUND` 与 `return { … }` 的整个函数体
    fn: () => {
      const src = [
        '  private async resolveGroup(user: User): Promise<{ building: Building; groupId: number }> {',
        '    if (!user.buildingId) {',
        "      throw new BizException(ErrorCode.USER_BUILDING_UNBOUND, 'x');",
        '    }',
        '    return { building, groupId: 1 };',
        '  }',
      ].join('\n');
      const b = blockOf(src, 'async resolveGroup(');
      return (
        b.includes('ErrorCode.USER_BUILDING_UNBOUND') &&
        b.includes('return { building, groupId: 1 };') &&
        b.trimEnd().endsWith('}')
      );
    },
  },
  {
    name: 'blockOf · 返回类型是无花括号的 Promise<number> 时结果不变（防改坏旧形状）',
    fn: () => {
      const src = [
        '  private async resolveGroup(user: User): Promise<number> {',
        '    if (!user.buildingId) {',
        "      throw new BizException(ErrorCode.USER_BUILDING_UNBOUND, 'x');",
        '    }',
        '    return 1;',
        '  }',
      ].join('\n');
      const b = blockOf(src, 'async resolveGroup(');
      return b.includes('ErrorCode.USER_BUILDING_UNBOUND') && b.includes('return 1;');
    },
  },
  {
    name: 'blockOf · 返回类型含箭头函数泛型 Promise<(x) => { y: 1 }> 不误判函数体起点',
    // ⚠️ 这条专门守 `=>` 的坑：不给 `=>` 特殊处理时，箭头那个 `>` 会把 gen 减到 0，
    //    紧随的 `{ y: 1 }` 会被当成函数体 ⇒ 取到 `… => { y: 1 }`，永远拿不到 BODY_MARK。
    fn: () => {
      const src = [
        '  async f(x: number): Promise<(x: number) => { y: 1 }> {',
        '    return BODY_MARK;',
        '  }',
      ].join('\n');
      const b = blockOf(src, 'async f(');
      return b.includes('return BODY_MARK;');
    },
  },
  {
    name: 'blockOf · 目标不存在时返回空串（不得抛异常，也不得返回全文）',
    fn: () => blockOf('const x = 1;\nfunction g() { return 2; }', 'async notThere(') === '',
  },
  {
    name: 'blockOf · 无返回类型标注的裸函数仍能取到函数体',
    fn: () => {
      const b = blockOf('function h(a: number) { return a + 1; }', 'function h(');
      return b === 'function h(a: number) { return a + 1; }';
    },
  },

  // ── 以下三条是「判据级」专项自证 ────────────────────────────────────────
  // 为什么需要它们：**通用自证只破化第一份**。
  //   多文件判据走 `mutateFirst`，只改 `files[0]`；扫描型判据走 `scanBroken`，只给一份样本。
  //   ⇒ 通用自证全绿，**证明不了第二、第三份也在被判**。本批恰恰是第三份漏了
  //   （`traceability.service.ts:285`），而通用自证当时是绿的。
  //
  // 每条都对应一个**具体的失效动作**，而不是「再跑一遍通用自证」。
  {
    name: 'N1-7 · traceability 那份**单独**破化也必报红（防 mutateFirst 只覆盖第一份）',
    fn: () => {
      const r = RULES.find((x) => x.id === 'N1-7');
      // 已知答案：这是 `traceability.service.ts` 修复**之前**的真实形状 ⇒ 必须判红
      const bad = [
        guardOf('if (!building.buildingGroupId) {', 'throw new BizException(ErrorCode.NOT_FOUND);'),
      ];
      const good = [
        guardOf(
          'if (!building.buildingGroupId) {',
          'throw new BizException(ErrorCode.BUILDING_NOT_GROUPED);',
        ),
      ];
      return r.pred(good) === true && r.pred(bad) === false;
    },
  },
  {
    name: 'N1-7 · 空命中列表必须判红（防 `every()` 恒绿：[] ≡ 全满足）',
    // ⚠️ 这是本批最典型的陷阱形状：文案整体改名 / 文件被删 ⇒ 扫不到任何一处
    //    ⇒ `[].every(...)` 恒真 ⇒ **最该报警的那一档反而全绿**。
    fn: () => RULES.find((x) => x.id === 'N1-7').pred([]) === false,
  },
  {
    name: 'N1-7 · 上一个抛点是**合法的** NOT_FOUND（办公楼不存在）时，本条仍须判绿（防回扫抓错抛点）',
    // ⚠️ 这条是**变异自证**抓出来的，不是推理出来的：
    //    我把 `traceability.service.ts:285` 临时改成 `BUILDING_NOT_GROUPED` 之后，
    //    N1-7 **仍然报红**，而它本该转绿。查下去是 ±200 字窗口把 `:282` 那个
    //    **合法的** `NOT_FOUND`（办公楼不存在，本就该是 10004）卷了进来。
    //
    //    ⇒ 教训：`mutate` 只覆盖「**必报的**报得出」，覆盖不到
    //      「**必不报的**不报」里的这一类。要抓它，必须**真的把产物改对一次看它绿不绿**。
    //      （这就是 AC §C.6.3 把「变异自证」定成硬性要求的原因。）
    fn: () => {
      const r = RULES.find((x) => x.id === 'N1-7');
      // 干扰项只塞进 `ctx` 与 `stmt`（判据不看的字段），`fwd` 是判据唯一依据
      const fixed = [
        {
          file: 'a.ts',
          line: 284,
          lineText: 'if (!building.buildingGroupId) {',
          isComment: false,
          stmt: 'throw new BizException(ErrorCode.NOT_FOUND, `办公楼 #1 不存在`);',
          fwd: 'throw new BizException(ErrorCode.BUILDING_NOT_GROUPED);',
          ctx: 'if (!building.buildingGroupId) {\nthrow new BizException(ErrorCode.NOT_FOUND, `办公楼 #1 不存在`);',
        },
      ];
      return r.pred(fixed) === true;
    },
  },
  // ⚠️ N1-20 的三条合取各配一条专项自证 —— 一条合取一条，不合并。
  //    合并成「任意一处不对就红」的写法会盖住**哪一条合取在起作用**，
  //    等哪天有人把某条合取删了，合并版照样绿。
  {
    name: 'N1-20 · ① 存在性：整段解释性注释被删掉（`canOrder` 一个都没有）⇒ 必红（防「命中数 ≤ 2」式恒绿）',
    fn: () => {
      const r = RULES.find((x) => x.id === 'N1-20');
      const deleted = ['// 这里原有一段解释 canAssign 与用户端语义区别的注释，被顺手删掉了'];
      return r.pred(deleted) === false;
    },
  },
  {
    name: 'N1-20 · ② 同现：`canOrder` 与警示语都在，但离「用户端」超过 240 字 ⇒ 必红（防「有字样就算过」）',
    fn: () => {
      const r = RULES.find((x) => x.id === 'N1-20');
      const pad = 'x'.repeat(400); // 撑开距离，让「用户端」掉出邻域窗口
      const far = [
        `此处提到 canOrder，也写了不要全局替换，${pad}而「用户端」这三个字在 400 字之外。`,
      ];
      return r.pred(far) === false;
    },
  },
  {
    name: 'N1-20 · ③ 内容：`canOrder` 与「用户端」同现，但警示语被删 ⇒ 必红（正是当前真文件的状态）',
    fn: () => {
      const r = RULES.find((x) => x.id === 'N1-20');
      const noWarn = [
        '/** 配置上能不能开团（无时间维度 · 管家端语义，与用户端 `canOrder` 不是一回事） */',
      ];
      return r.pred(noWarn) === false;
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  // N1-12 侧 A 的射程自证。
  //
  // ⚠️ **为什么必须放在 `HELPER_CHECKS` 而不是靠判据自证**：判据自证只跑真文件，
  //    而侧 A（表里值带 `{占位符}` 的键）当前**全仓无此形态** ⇒ 真文件跑一万次
  //    也证明不了侧 A 存在（这正是「真空的合取」最容易腐烂的地方：
  //    它对任何输入都成立，于是永远绿）。
  //    ⇒ **凡是「当前恒真」的那一半，都必须单独造样本证明它「能红」**。
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: 'N1-12 侧 A · 表里带 `{占位符}` 的键没有插值分支 ⇒ 必红（该侧当前在真文件里是真空，靠样本证明它没瞎）',
    fn: () => {
      const src = `
export const REASON_TEXT: Record<string, string> = {
  plain_key: '静态文案，不需要插值',
  tpl_key: '今日 {HH:mm} 开团，敬请期待',
};
export function reasonText(reason: string, ctx: any): string {
  switch (reason) {
    case 'plain_key':
      return REASON_TEXT[reason];
    default:
      return REASON_TEXT[reason];
  }
}`;
      return reasonTextCoversDynamicKeys(src) === false;
    },
  },
  {
    name: 'N1-12 侧 A · 表里带 `{占位符}` 的键**有**插值分支（且真的用到 `ctx.`）⇒ 必绿（防误伤）',
    fn: () => {
      const src = `
export const REASON_TEXT: Record<string, string> = {
  plain_key: '静态文案，不需要插值',
  tpl_key: '今日 {HH:mm} 开团，敬请期待',
};
export function reasonText(reason: string, ctx: any): string {
  switch (reason) {
    case 'plain_key':
      return REASON_TEXT[reason];
    case 'tpl_key':
      return \`今日 \${ctx.hhmm} 开团，敬请期待\`;
    default:
      return REASON_TEXT[reason];
  }
}`;
      return reasonTextCoversDynamicKeys(src) === true;
    },
  },
  {
    name: 'N1-12 · 表上方的 `// 动态文案：今日 {HH:mm} 开团` 注释**不得**被当成「值里带占位符」（必须剥注释）',
    fn: () => {
      const src = `
export const REASON_TEXT: Record<string, string> = {
  later_key: '', // 动态文案：今日 {HH:mm} 开团，敬请期待
};
export function reasonText(reason: string, ctx: any): string {
  switch (reason) {
    case 'later_key':
      return \`今日 \${ctx.hhmm} 开团，敬请期待\`;
    default:
      return REASON_TEXT[reason];
  }
}`;
      // 剥注释后 `later_key` 的值是空串（走侧 B，有分支 ⇒ 绿）
      return reasonTextCoversDynamicKeys(src) === true;
    },
  },
];

// ── 自证 ────────────────────────────────────────────────────────────────────
let selfFail = 0;
let realCount = 0;
let synthCount = 0;
let pendingCount = 0;
let hintCount = 0;

console.log('──────── 取数与判据取样自证（已知答案反向验证）────────');
let helperFail = 0;
for (const h of HELPER_CHECKS) {
  let pass = false;
  try {
    pass = h.fn() === true;
  } catch {
    pass = false;
  }
  if (pass) console.log(`✔ ${h.name}`);
  else {
    helperFail += 1;
    console.log(`✘ ${h.name}`);
  }
}
if (helperFail) {
  console.error(`\n工具自证失败 ${helperFail} 条 ⇒ 判据取数不可信，判红判绿都没有意义，退出 2`);
  process.exit(2);
}
console.log(`工具自证 ${HELPER_CHECKS.length}/${HELPER_CHECKS.length} 通过 ✅\n`);

console.log('──────── 自证（每条判据：必报的报得出）────────');
for (const r of RULES) {
  const s = samplesOf(r);

  // ⚠️ `mode: 'hint'` 的判据**不做自证** —— 见 N1-2 处的长注释：
  //    给它做自证只会重演「插一行 Date.now() 它就红」的假象，
  //    而那证明不了「被约束的东西变了它会红」。
  if (s.kind === 'HINT') {
    hintCount += 1;
    console.log(`ℹ ${r.id} 提示项（判据形态与约束形态不匹配，已降级）· 不作自证、不计红绿`);
    continue;
  }

  if (s.kind === 'MISSING' || s.kind === 'SYNTH-NO-SAMPLE') {
    pendingCount += 1;
    console.log(`－ ${r.id} 目标尚未落地且无目标形态样本 ⇒ 暂不判定（非通过）：${hintOf(r)}`);
    continue;
  }

  // ① 必不报：good 样本必须判「通过」
  const passOnGood = r.pred(s.root);
  // ② 必报：破坏后的文本必须判「不通过」
  const broken = s.broken;
  const changed = JSON.stringify(broken) !== JSON.stringify(s.root);
  const failOnBroken = !r.pred(broken);

  const ok = passOnGood && changed && failOnBroken;
  if (!ok) {
    selfFail += 1;
    console.log(
      `✘ ${r.id} 自证失败 · good通过=${passOnGood} · 破化生效=${changed} · 破化后报错=${failOnBroken}`,
    );
    // ⚠️ **看到红先重跑一次**（AC §C.4）。本批真实发生过一次：
    //    N1-8 / W1-8 自证忽然报红，重跑即绿 —— 根因是**门禁读到了并发写入中途的文件**
    //    （`orderability.ts` mtime 21:00:13，那一次的 `git diff` 甚至能看见写了一半的片段）。
    //    失效方向是 fail-closed（宁可报红也不放错），这个方向是对的，不要为了「让它绿」去改判据。
    //    ⇒ 提示写在这里，是为了让下一次遇到的人先花 5 秒重跑，而不是花 30 分钟找 bug。
    console.log(
      `   ⚠️ 若本条为偶发（重跑即绿）：门禁可能读到了并发写入中途的文件 —— 先跑一次 ` +
        '`node scripts/check-n1n2-w1-suspend-rules.mjs` 确认；' +
        '确实持续报红才是判据或产物的问题。',
    );
    // ⚠️ 三种自证失败的形态不一样，提示必须分别给，否则看的人无从下手：
    if (!changed)
      console.log('   → 破化根本没生效：`mutate` 的锚点在样本里不存在，改判据或改锚点。');
    if (!passOnGood) console.log('   → good 样本就没过：判据写错了，或目标形态本身不符合本判据。');
    if (!failOnBroken && changed) {
      console.log(
        '   → 破化生效了但判据仍判「通过」：**判据对这次破化不敏感**。\n' +
          '     最常见的原因（本批已 4 次）：判据是**存在性**（≥1），而 `mutate` 用 `replace` 只删了第一处，\n' +
          '     剩下的命中照样满足它 ⇒ 改用 `replaceAll`。\n' +
          '     另一个常见原因：`mutateFirst` 只破化多文件里的**第一份**，其余几份没人守。',
      );
    }
  } else {
    if (s.kind === 'REAL') {
      realCount += 1;
      console.log(`✔ ${r.id} [REAL]  真文件通过 + 破化必报`);
    } else if (s.realAlso) {
      // ⚠️ **样本是 [REAL] 之外的另一类证据，但真文件已经满足** —— 标签不得再说「尚未满足」。
      //    （仍计入 SYNTH：good 根取的是 sample 而非真文件，严格说还没完成退化。）
      synthCount += 1;
      console.log(
        `✔ ${r.id} [SYNTH·真文件已绿] 目标形态通过 + 破化必报（good 根仍为样本，收口时应去掉 sample 改走真文件）`,
      );
    } else {
      synthCount += 1;
      console.log(`✔ ${r.id} [SYNTH] 目标形态通过 + 破化必报（真文件尚未满足）`);
    }
  }
}

console.log(
  `\n自证汇总：[REAL] ${realCount} · [SYNTH] ${synthCount} · 未判定 ${pendingCount} · 提示项 ${hintCount}（不计红绿）`,
);
if (selfFail) {
  console.error(`\n自证失败 ${selfFail} 条 ⇒ 检查器自身不可信，退出 2`);
  console.error('⚠️ 若只在某一次运行中出现：先原样重跑一次 —— 门禁可能读到了并发写入中途的文件。');
  process.exit(2);
}

// ── 真检 ────────────────────────────────────────────────────────────────────
console.log('\n──────── 真检 ────────');
let bad = 0;
let missing = 0;
const redList = [];
for (const r of RULES) {
  // 提示项：只打印当前观察值，绝不计数（它守不住约束，让它计数就是给它它不该有的权威）
  if (r.mode === 'hint') {
    let text;
    if (r.files) text = r.files.map(read);
    else text = read(r.file);
    const absent = text === null || (Array.isArray(text) && text.some((v) => v === null));
    const observed = absent ? '目标缺失' : r.pred(text) ? '字面未见' : '字面命中';
    console.log(`ℹ ${r.id} ${observed} · ${r.desc}`);
    console.log(`    理由：${r.hintWhy}`);
    continue;
  }

  let text;
  if (r.scan) text = scanHits(r.scan.dir(), r.scan.needle, r.scan);
  else if (r.migration) text = readMigration(r.migration);
  else if (r.files) text = r.files.map(read);
  else text = read(r.file);

  const absent =
    text === null ||
    (Array.isArray(text) && text.length === 0) ||
    (Array.isArray(text) && text.some((v) => v === null));

  // ⚠️ 扫描型判据的「空命中」**不是文件缺失**，是**真的没扫到** ⇒ 必须判红，不能算 ⚠。
  //    若算 ⚠，`[].every()` 恒真这个陷阱就又被放回去了（见 `scanHits()` 注释）。
  const isEmptyScan = r.scan && Array.isArray(text) && text.length === 0;

  if (absent && !isEmptyScan) {
    missing += 1;
    console.log(`⚠ ${r.id} ${hintOf(r)}`);
    continue;
  }
  // 目标形态已落地但尚未满足规则的（没有 SYNTH 样本可替代）不重复计数，统一在下面判红
  if (r.pred(text)) {
    console.log(`✔ ${r.id} ${r.desc}${detailOf(r, text)}`);
  } else {
    bad += 1;
    redList.push(r.id);
    console.log(`✘ ${r.id} ${r.desc}${detailOf(r, text)}`);
  }
}

/**
 * 判红/判绿时把**观察到的东西**一并打出来。
 *
 * ⚠️ 为什么需要：只打「✘ N1-7」时，看的人不知道它扫到了几个点、哪几个不合，
 *    于是只能选择「信它」或「不信它」—— 两者都不是核对。
 *    ⇒ 扫描型判据尤其必须列出命中点：它的取数范围是**全仓**，
 *      「扫到几个」本身就是这次检查的结论之一（扫到 0 ≠ 全满足）。
 */
function detailOf(r, text) {
  if (!r.scan) return '';
  const hits = Array.isArray(text) ? text : [];
  const code = hits.filter((h) => !h.isComment);
  // ⚠️ **必须与 `pred` 用同一个 `scope`**：首版在这里硬编码了 N1-7 的过滤函数，
  //    于是 N1-24 / N1-26 打印的「受判抛点」用的是**别人的口径** ——
  //    判据说一套、输出说一套。门禁一旦自相矛盾，人就只会相信自己肉眼看到的那一半。
  const throws = r.scope ? r.scope(hits) : [];
  const scope = `命中 ${hits.length} 处 · 非注释 ${code.length} · **受判 ${throws.length}**`;
  if (throws.length === 0) return ` · ${scope}（⚠ 受判对象为 0 必须判红，见 scanHits 注释）`;
  const bads = throws.filter((h) => !r.pred([h]));
  return ` · ${scope}${
    bads.length
      ? `，其中 ${bads.length} 处不合：${bads.map((b) => `${b.file}:${b.line}`).join(' / ')}`
      : ''
  }`;
}

console.log('\n──────── 汇总 ────────');
console.log(`判据 ${RULES.length} 条（其中提示项 ${hintCount} 条不计红绿）`);
if (bad) {
  console.error(`不通过 ${bad} 条 ❌${redList.length ? `：${redList.join(' / ')}` : ''}`);
}
if (missing) console.warn(`未判定（文件缺失）${missing} 条 ⚠`);
if (bad) process.exit(1);
if (missing) {
  console.warn('\n⚠️ 存在「文件缺失」的未判定项 —— Phase 3 收口前不得视为门禁通过。');
  console.warn(
    '   届时本脚本应全绿且无 ⚠，用 `node scripts/check-n1n2-w1-suspend-rules.mjs` 复跑确认。',
  );
}
// ⚠️ **提示项不得被算成「通过」** —— 首版写成 `RULES.length - bad - missing`，
//    于是 `N1-2` 那条「判据形态不匹配、已降级」的也被算进了通过数，
//    输出「通过 40/40」⇒ **门禁在说假话**：它暗示 N1-2 被判过了，而它恰恰是判不了的。
//    ⇒ 分母分子都减掉 hintCount：受判 39 条里通过 39 条，另有 1 条提示项。
const judged = RULES.length - hintCount;
console.log(
  `受判 ${judged} 条：通过 ${judged - bad - missing}/${judged} ✅（另有提示项 ${hintCount} 条未受判）`,
);

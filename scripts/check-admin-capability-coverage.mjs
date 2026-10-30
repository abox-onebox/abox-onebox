#!/usr/bin/env node
/**
 * 门禁：后台「有能力 ↔ 有入口」覆盖度（防「接口做了、页面没做」）
 *
 * ## 为什么必须有这条门禁
 *
 * 一个后端能力真正可用，需要**两份表述同时成立**：
 *   ① 服务端有端点（`@Get/@Post/...` 装饰器）；
 *   ② 前端有承载它的页面 / 操作入口（引用该端点的代码）。
 *
 * 而这两份表述**没有任何自动化在比对** —— 于是「只做了 ① 没做 ②」是一种
 * **完全静默**的缺陷：tsc 绿、eslint 绿、build 绿、e2e 也绿（e2e 打的是接口，
 * 不打页面），接口 curl 一下还返回 `code=0`。只有**人想去用的时候**才发现没门。
 *
 * ## 它已经复发过两次（这才是加门禁的理由）
 *
 * | 时间 | 被漏掉的能力 | 表现 |
 * |---|---|---|
 * | 2026-10-29 | 代金券**批量发放 / 回收** | 券系统 2026-10-23 就上线了，但只能一人一人发、发错无法撤回；全量补偿要填 73 遍手机号 |
 * | 2026-10-30 | 页面停留**读侧**（D77） | 埋点自 2026-10-20 起一直在写库，但 `track.controller` 只有 POST、后台零页面 —— 运营想看数据无处可看 |
 *
 * 两次都是**用户人工发现**的，不是任何检查发现的。两次的形状也相同：
 * 「后端能力清单」与「前端入口清单」是两份东西，而只有人在脑子里比对。
 * （同族教训见 `nav:consistency` / `schema:parity` / `index:parity`：项目里凡是
 *   「两份表述」的地方，不被执行的那份必然会错。）
 *
 * ## 判据
 *
 *   A. **有能力无入口**：后端端点（admin 域）在前端源码里**零引用** ⇒ 报。
 *      路径参数归一（`:id` / `${id}` 一律视为 `:p`），并接受「前缀 + 参数」形态
 *      （`'/admin/orders/' + id` 也应算命中 `/admin/orders/:id`）。
 *   B. **接口已接未落地**：`api/*.ts` 里导出的方法，**没有任何页面引用它** ⇒ 报。
 *      （比 A 更隐蔽：端点有人调了，可那个方法是个孤儿 —— 页面根本没用它。）
 *
 * ## 防「恒绿的检查」
 *
 * 一条判据如果在「取不到值」时自动判过，等于没有检查。故**每次运行都断言**：
 *   · 解析出的端点数、前端引用数、导出方法数**都必须大于阈值**（空集合直接红）；
 *   · 自证（见下）必须能造出「必报」样本，且干净输入必须零问题。
 *
 * ## 自证（每次运行都做，`--selftest` 单独跑）
 *
 *   ① 必报：假 controller 带 `/admin/ghost/thing` + 空前端 ⇒ A 必须报；
 *   ② 必报：假 api 文件导出 `fetchGhost` 无人引用 ⇒ B 必须报；
 *   ③ 必不报：前端真引用了该端点 / 真引用了该方法 ⇒ 不报（判据写反会在这里红）；
 *   ④ 恒绿检测：端点集合为空 ⇒ 必须报错退出（不许悄悄通过）。
 *
 * 用法：
 *   node scripts/check-admin-capability-coverage.mjs                # 真实对账
 *   node scripts/check-admin-capability-coverage.mjs --selftest      # 只跑自证
 *
 * 退出码：0 = 无缺口且自证通过；1 = 有缺口或自证失败。
 */
import {
  readFileSync,
  readdirSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);

// ---------------------------------------------------------------- 参数化（自证要换目录）

/** 一个「目标端」= 后端域名前缀 + 前端源码目录 + 前端 api 目录 */
const TARGETS = {
  admin: {
    label: '后台',
    // 后端：路径以 /admin/ 开头（或 controller base 为 admin）
    matchRoute: (p, file) =>
      p === '/admin' ||
      p.startsWith('/admin/') ||
      p.startsWith('/auth/') ||
      /\.admin\.controller\.ts$/.test(file ?? ''),
    frontDirs: [join(REPO, 'apps/admin-web/src')],
    apiDir: join(REPO, 'apps/admin-web/src/api'),
  },
  mp: {
    label: '用户端',
    matchRoute: (p, file) =>
      !p.startsWith('/admin') && !p.startsWith('/auth/') && !/\.admin\.controller\.ts$/.test(file ?? ''),
    frontDirs: [join(REPO, 'apps/miniprogram/src'), join(REPO, 'apps/h5/src')],
    apiDir: join(REPO, 'apps/miniprogram/src/api'),
  },
};

// ⭐ 集合规模下限：低于它说明「取数失败」，而取数失败时判据会自动判过（恒绿 = 没有检查）
const MIN_ROUTES = 20;
const MIN_REFS = 20;
const MIN_EXPORTS = 10;

/**
 * 豁免表（**每条必须自带理由**，且会被「自收紧」检查）
 *
 * 加豁免前先问：是真的不需要入口，还是懒得做？后者请直接做页面。
 */
const EXEMPT = [
  { method: 'GET', path: '/health', reason: '存活探针：供容器健康检查与 nginx 反代探测，不是业务能力，无页面是设计如此' },
  { method: 'GET', path: '/health/ready', reason: '就绪探针：deploy.sh 第 7 步轮询它判定发布是否成功' },
  { method: 'POST', path: '/pay/notify', reason: '微信支付回调：服务端↔微信，端上永不需要入口' },
  { method: 'GET', path: '/wecom/kb/callback', reason: '企微回调（URL 验证）：服务端↔企微' },
  { method: 'POST', path: '/wecom/kb/callback', reason: '企微回调（事件推送）：服务端↔企微' },
];

/**
 * 已知缺口（**真缺口，不是"设计如此"**）
 *
 * 与 EXEMPT 的区别：EXEMPT 是「本来就不该有页面」，KNOWN_GAPS 是「**该有但没有**」——
 * 它们是本门禁跑出来的真问题，尚未补页面。
 *
 * ⚠️ 为什么要单列而不直接让它红：门禁常红 = 没人看（与「恒绿」同样没用）。
 *    但**绝不能**把它们塞进 EXEMPT 假装无事 —— 那正是「代金券 / 页面停留」两轮
 *    缺陷的共同成因：缺口存在，却没有任何东西持续提醒。
 *    ⇒ 折中：单独成表、**每次运行都打印**、且**自收紧**（一旦补了页面，
 *      [缺口已修] 会报出，逼你把它从表里删掉，不许留着假装还缺）。
 *
 * 每条必须带 `todo`（待办编号）与 `since`（发现日期）。
 */
const KNOWN_GAPS = [
  // ✅ 2026-10-30 已修并已从本表删除（删条目的正是这段自收紧检查，见下方 C-0）：
  //    · 待办#40 `/admin/op-blocklist` GET/POST/DELETE —— 新增 `views/system/op-blocklist.vue`
  //    · 待办#42 `POST /auth/change-password` —— 顶栏「修改口令」（挂外壳，不进菜单）
  //    · 待办#46 导出方法 `setSettleAccount` —— 名录页「结算账户」弹窗
  //    （同时修掉 form.vue 里三个「能填但不提交」的银行输入框）
  {
    method: 'POST',
    path: '/admin/operation-requests/:p/recall',
    reason: '运营申请「撤回」无入口：列表/审批页面有，撤回按钮没有',
    todo: '待办#41',
    since: '2026-10-30',
  },
  {
    method: 'GET',
    path: '/admin/buildings/filter-options',
    reason: '筛选选项端点未被使用（页面未做筛选或另取来源）',
    todo: '待办#43',
    since: '2026-10-30',
  },
  {
    method: 'GET',
    path: '/admin/building-groups/filter-options',
    reason: '同上',
    todo: '待办#43',
    since: '2026-10-30',
  },
  {
    method: 'GET',
    path: '/admin/suppliers/filter-options',
    reason: '同上',
    todo: '待办#43',
    since: '2026-10-30',
  },
  {
    method: 'POST',
    path: '/wecom/kb/bindings',
    reason: '企微知识库绑定无后台页面（待裁决：是否要有运营入口）',
    todo: '待办#44',
    since: '2026-10-30',
  },
  {
    method: 'GET',
    path: '/wecom/kb/bindings',
    reason: '同上',
    todo: '待办#44',
    since: '2026-10-30',
  },
  {
    method: 'DELETE',
    path: '/wecom/kb/bindings/:p',
    reason: '同上',
    todo: '待办#44',
    since: '2026-10-30',
  },
  // ---- 「接口已接未落地」类：方法写好了，页面没用它 ----
  {
    target: 'admin',
    export: 'refreshAdminToken',
    reason: 'api/auth.ts 导出但无人调用（疑似预留）：要么接进 request 拦截器，要么删掉',
    todo: '待办#45',
    since: '2026-10-30',
  },
  {
    target: 'admin',
    export: 'fetchBuildingDetail',
    reason: '楼宇详情接口已封装，无页面使用（页面可能走了 overview）',
    todo: '待办#45',
    since: '2026-10-30',
  },
  {
    target: 'admin',
    export: 'fetchGroupDetail',
    reason: '同上（楼宇组详情）',
    todo: '待办#45',
    since: '2026-10-30',
  },
  {
    target: 'admin',
    export: 'fetchRefundDetail',
    reason: '退款详情接口已封装，无页面使用',
    todo: '待办#45',
    since: '2026-10-30',
  },
  {
    target: 'mp',
    export: 'auditMyLevel',
    reason: '端上导出未使用',
    todo: '待办#45',
    since: '2026-10-30',
  },
  {
    target: 'mp',
    export: 'fetchTraceabilityToday',
    reason: '溯源接口已封装，端上无页面使用',
    todo: '待办#45',
    since: '2026-10-30',
  },
  {
    method: 'GET',
    path: '/home/history',
    reason: '历史菜单端点端上无引用（小程序「历史订单/往期菜单」未落地）',
    todo: '待办#47',
    since: '2026-10-30',
  },
];

// ---------------------------------------------------------------- 通用：遍历

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (!isDir && !isFile && e.isSymbolicLink()) {
      try {
        const st = statSync(p);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) walk(p, out);
    else if (isFile) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- 后端端点解析

const ALL_VERBS = /@(Get|Post|Put|Patch|Delete|Options|Head)\s*\(/g;
const VERB_LINE = /@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)?\s*\)/;
const CONTROLLER_LINE =
  /@Controller\(\s*(?:'([^']*)'|"([^"]*)"|\{[^}]*?path\s*:\s*['"]([^'"]*)['"])/;

function normalPath(base, sub) {
  const raw = ['/api/v1', base, sub].filter((x) => x !== undefined && x !== null).join('/');
  const p = raw.replace(/\/{2,}/g, '/');
  return p.length > 1 ? p.replace(/\/$/, '') : p;
}

/** 归一化：去掉 /api/v1 前缀；路径参数一律 :p；去尾斜杠；小写 */
function norm(p) {
  let s = String(p).trim();
  s = s.replace(/^\/api\/v\d+/, '');
  s = s.replace(/\$\{[^}]*\}/g, ':p');
  s = s.replace(/\{[^}]+\}/g, ':p');
  s = s.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p');
  s = s.replace(/\/{2,}/g, '/');
  s = s.replace(/\/+$/, '');
  return s.toLowerCase();
}

/** 解析一个后端源码树，返回端点 + 解析自证差异 */
export function parseRoutes(apiSrc) {
  const routes = [];
  const parseMisses = [];
  for (const file of walk(apiSrc).filter((f) => f.endsWith('.controller.ts'))) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split(/\r?\n/);
    let base = null;
    let hits = [];
    for (let i = 0; i < lines.length; i++) {
      const cm = lines[i].match(CONTROLLER_LINE);
      if (cm) base = cm[1] ?? cm[2] ?? cm[3] ?? '';
      const vm = lines[i].match(VERB_LINE);
      if (vm) {
        if (base === null) continue;
        const sub = vm[2] ?? vm[3] ?? vm[4] ?? '';
        hits.push({
          method: vm[1].toUpperCase(),
          path: normalPath(base, sub),
          norm: norm(normalPath(base, sub)),
          file,
          line: i + 1,
        });
      }
    }
    // 自证：文件内动词装饰器出现次数必须 == 解析命中数（多行写法会在此暴露）
    const declared = (src.match(ALL_VERBS) ?? []).length;
    if (declared !== hits.length) parseMisses.push({ file, declared, parsed: hits.length });
    routes.push(...hits);
    hits = [];
  }
  return { routes, parseMisses };
}

// ---------------------------------------------------------------- 前端引用解析

/**
 * 引用抽取的两条正则（**并用**，因为各有一种盲区）
 *
 * ① `HTTP_CALL_RE` —— 直接认 `http.get('/x')` 这类调用形态（含泛型 `http.get<T>(...)`）。
 *    ⭐ 这条是主力：**按调用形态取，不猜路径前缀**。
 * ② `REF_RE` —— 路径字面量兜底（常量表、注释里的路径也算线索）。
 *
 * ⚠️ 首版只用了 ② 且带前缀白名单，结果漏掉 `/home/daily` —— 端上明明写着
 *    `http.get(\`/home/daily${q}\`)`，只因 `home` 不在白名单里就被判成「无入口」。
 *    **假红的代价是判据失去可信度**，而**漏报**更糟（真缺口被判成已覆盖）。
 *    ⇒ 认调用形态，不认前缀名单。
 *
 * ⚠️ ① 的捕获组是 `[^'"`$]*`（**到第一个 `$` 为止**），不是 `[^'"`]+`：
 *    端上普遍写成 `` `/leader/commissions${query({ range: 'month' })}` `` ——
 *    插值里带着**单引号**，用 `[^'"`]+` 会被引号提前截断，捕获成
 *    `/leader/commissions${query({` ⇒ 团长端 5 个端点被误报成「无入口」。
 *    取到 `${` 之前即可得到干净路径前缀（`/leader/commissions`）。
 *    ⚠️ 已知边界：`/x/${id}/detail` 这类**参数在中间**的形态，① 只能取到 `/x/`，
 *       靠 isReferenced 的前缀兜底接住；即便如此仍是**漏报方向**（判成已覆盖），
 *       故 ② 的路径字面量兜底保留，且不得再给 ① 加宽。
 */
const HTTP_CALL_RE =
  /http\s*\.\s*(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`$]*)/g;
// ⚠️ 字符类必须包含 `()`：端上普遍写成
//    `` `/orders/${encodeURIComponent(orderNo)}/cancel` `` —— 缺了括号就会截断在
//    `encodeURIComponent(` 处，捕获成不完整的串 ⇒ 订单取消/支付/评价 5 个端点
//    被误报成「无入口」（2026-10-30 实测）。
const REF_RE = /['"`](\/[A-Za-z][\w\-/:{}$.()]*)/g;

/** 抽取前端源码里出现的所有后端路径字面量（归一化） */
export function parseRefs(frontDirs) {
  const refs = new Map(); // norm -> [{file,line,raw}]
  for (const dir of frontDirs) {
    for (const file of walk(dir).filter((f) => /\.(ts|vue|js|jsx)$/.test(f))) {
      const src = readFileSync(file, 'utf8');
      const lines = src.split(/\r?\n/);
      // ⚠️ **整文件**匹配，不逐行：端上大量调用是跨行模板字符串
      //    （`http.get<T>(\n  \`/leader/commissions${q}\`,\n)`），逐行匹配会整类漏掉
      //    —— 团长端 5 个端点就是这么被误报成「无入口」的。
      const lineOf = (idx) => src.slice(0, idx).split(/\r?\n/).length;

      // ① 调用形态
      let m;
      HTTP_CALL_RE.lastIndex = 0;
      while ((m = HTTP_CALL_RE.exec(src)) !== null) {
        const n = norm(m[2]);
        if (!n) continue;
        const hit = refs.get(n) ?? [];
        hit.push({ file, line: lineOf(m.index), raw: m[2] });
        refs.set(n, hit);
      }
      // ② 路径字面量兜底
      REF_RE.lastIndex = 0;
      while ((m = REF_RE.exec(src)) !== null) {
        const raw = m[1];
        // 过滤明显不是接口路径的（样式/静态资源/文件路径）
        if (/\.(css|scss|png|jpe?g|svg|ttf|woff2?|js|json)$/i.test(raw)) continue;
        if (/^\/(static|assets|node_modules|src)\//.test(raw)) continue;
        const n = norm(raw);
        if (!n || n.length < 4) continue;
        const hit = refs.get(n) ?? [];
        hit.push({ file, line: lineOf(m.index), raw });
        refs.set(n, hit);
      }
    }
  }
  return refs;
}

/**
 * 端点是否被前端引用
 *
 * 除了精确匹配，还接受「前缀 + 拼接参数」形态：`'/admin/orders/' + id`
 * 抽出来是 `/admin/orders/`，而端点是 `/admin/orders/:id` ⇒ 按前缀判定命中。
 */
function isReferenced(routeNorm, refs) {
  if (refs.has(routeNorm)) return true;
  // ⚠️ 前缀兜底**只允许**用于「末段是路径参数」的端点（`/admin/orders/:p`），
  //    用来接住 `'/admin/orders/' + id` 这类拼接形态。
  //    首版对**所有**端点都做前缀兜底，结果 `/admin/op-blocklist` 被任意
  //    `/admin/xxx` 命中 ⇒ 整个后台都被判成「已覆盖」—— 这比假红危险得多：
  //    真缺口被判成已覆盖，检查就变成摆设（运营黑名单正是这么被漏掉的）。
  if (!/\/:[^/]+$/.test(routeNorm)) return false;
  const head = routeNorm.replace(/\/[^/]*$/, '');
  if (!head) return false;
  for (const key of refs.keys()) {
    if (key === head || key === head + '/' || key.startsWith(head + '/')) return true;
  }
  return false;
}

// ---------------------------------------------------------------- 前端 api 导出 → 页面引用

/**
 * 只取**函数类**导出
 *
 * ⚠️ 为什么不能「凡是 export const 都算」：`CODE_OK`、`ADMIN_ORDER_STATUS_OPTIONS`
 *    、`NETWORK_ERROR_CODE` 这些是**常量**，本就不该有「页面引用」——把它们算进来，
 *    首轮就虚报了 6 条（假红会让判据失去可信度，进而被人忽略）。
 *    ⇒ 只认 `export function` 与 `export const x = (...` / `= async (` 两种函数形态。
 */
const EXPORT_FN_RE = /export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/g;
const EXPORT_ARROW_RE =
  /export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g;

export function parseExports(apiDir) {
  const out = [];
  if (!apiDir) return out;
  for (const file of walk(apiDir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(file, 'utf8');
    for (const re of [EXPORT_FN_RE, EXPORT_ARROW_RE]) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(src)) !== null) out.push({ name: m[1], file });
    }
  }
  // 同一函数可能被两条正则都命中（先 function 后 const 不会），去重
  const seen = new Set();
  return out.filter((e) => (seen.has(e.name) ? false : seen.add(e.name)));
}

/**
 * 统计每个导出函数在**其他文件**里的被引用次数
 *
 * ⚠️ 为什么排除的是「定义它的那个文件」而不是「整个 api 目录」：
 *    `refreshAdminToken` 被同目录的 `request.ts` 拦截器调用，是**真在用**；
 *    若把整个 api 目录排除，它会变成假红。反过来，若连定义文件自己都算引用，
 *    则**每个函数都恒被引用** ⇒ 判据永远不报（恒绿）。
 *    ⇒ 精确的那一刀是：排除自身文件，其余都算。
 */
export function parseIdentRefs(exports, frontDirs) {
  const counts = new Map();
  if (!exports.length) return counts;
  const defFile = new Map(exports.map((e) => [e.name, e.file]));
  for (const dir of frontDirs) {
    for (const file of walk(dir).filter((f) => /\.(ts|vue|js|jsx)$/.test(f))) {
      const src = readFileSync(file, 'utf8');
      for (const [name, def] of defFile) {
        if (file === def) continue;
        const re = new RegExp(`\\b${name}\\b`, 'g');
        const c = (src.match(re) ?? []).length;
        if (c > 0) counts.set(name, (counts.get(name) ?? 0) + c);
      }
    }
  }
  return counts;
}

// ---------------------------------------------------------------- 对账

/**
 * 核心对账（纯函数 · 自证时用变异输入再跑一遍）
 *
 * @returns {{findings: Array, stats: Object}}
 */
export function check({ routes, refs, exports, identRefs, target, exempt, allRefs, knownGaps }) {
  const findings = [];
  const t = TARGETS[target];
  const myRoutes = routes.filter((r) => t.matchRoute(r.norm, r.file));

  // 集合非空断言（防「取不到值 ⇒ 自动判过」）
  if (myRoutes.length < MIN_ROUTES) {
    findings.push({
      kind: '[取数失败]',
      detail: `${t.label}端点仅 ${myRoutes.length} 条（< ${MIN_ROUTES}），判据已失效，不许通过`,
    });
  }
  if (refs.size < MIN_REFS) {
    findings.push({
      kind: '[取数失败]',
      detail: `${t.label}前端引用仅 ${refs.size} 条（< ${MIN_REFS}），判据已失效，不许通过`,
    });
  }
  if (exports.length < MIN_EXPORTS) {
    findings.push({
      kind: '[取数失败]',
      detail: `${t.label}api 导出仅 ${exports.length} 个（< ${MIN_EXPORTS}），判据已失效，不许通过`,
    });
  }

  const exemptKey = (m, p) => `${m} ${p}`;

  // A. 有能力无入口
  //
  // ⚠️ 命中集合是 **allRefs（全前端：admin-web + 小程序 + h5）**，不是本端 refs：
  //    端归属无法靠路径前缀判准 —— `/supplier/workbench` 看着像用户端，实际承载在
  //    admin-web 的供应商门户里；`/auth/login` 看着像后台，实际是小程序登录。
  //    首版按前缀分域，两端各判一次，结果这类端点**两边都报**缺口（假红）。
  //    用户真正要问的是「**有没有任何入口**」，不是「在哪个端」—— 故合并判定。
  const coverRefs = allRefs ?? refs;
  const knownHits = [];
  for (const r of myRoutes) {
    if (isReferenced(r.norm, coverRefs)) continue;
    const ex = exempt.find(
      (e) => (!e.target || e.target === target) && (!e.method || e.method === r.method) && e.path === r.norm,
    );
    if (ex) continue;
    const known = (knownGaps ?? []).find(
      (k) => (!k.method || k.method === r.method) && k.path === r.norm,
    );
    if (known) {
      // 自收紧：已补了页面却还挂在已知缺口表里 ⇒ 必须删（否则表会腐烂成新的谎言）
      knownHits.push({ kind: known.todo, detail: `${r.method} ${r.norm}`, reason: known.reason });
      continue;
    }
    findings.push({
      kind: '[有能力无入口]',
      detail: `${r.method} ${r.norm}`,
      where: `${r.file.replace(REPO + '\\', '').replace(REPO + '/', '')}:${r.line}`,
    });
  }

  // B. 接口已接未落地（api 导出的方法无人引用）
  for (const e of exports) {
    if ((identRefs.get(e.name) ?? 0) > 0) continue;
    const ex = exempt.find((x) => x.target === target && x.export === e.name);
    if (ex) continue;
    const knownB = (knownGaps ?? []).find((k) => k.export === e.name);
    if (knownB) {
      knownHits.push({
        kind: knownB.todo,
        detail: `导出方法 ${e.name} 无页面引用`,
        reason: knownB.reason,
      });
      continue;
    }
    findings.push({
      kind: '[接口已接未落地]',
      detail: `导出方法 ${e.name} 无任何页面引用`,
      where: e.file.replace(REPO + '\\', '').replace(REPO + '/', ''),
    });
  }

  // C-0. 已知缺口表的**自收紧**（头注承诺过、这里才是真正的落实）
  //
  // ⭐ 为什么必须单独扫一遍 KNOWN_GAPS：上面的循环只在「端点**未被引用**」时才命中
  //    knownHits —— 一旦页面补上，条目就**静默从打印里消失**，既不报也不留痕，
  //    表里那条记录从此变成一句没人会来核对的假话（正是注释想防的「表腐烂成新谎言」）。
  //    ⇒ 这里反过来查：条目还在、但缺口已经没了 ⇒ 报出来逼人删条目。
  //
  // ⚠️ 按 target 归属：无 `target` 字段的条目要先用 `matchRoute` 判它属不属于本端，
  //    否则 `/home/history` 在 admin 端会被误报成「条目失效」。
  for (const k of knownGaps ?? []) {
    if (k.target && k.target !== target) continue;
    const tag = `${k.todo} · ${k.since}`;
    if (k.export) {
      if ((identRefs.get(k.export) ?? 0) > 0) {
        findings.push({
          kind: '[缺口已修·请删条目]',
          detail: `导出方法 ${k.export} 已被页面引用（${tag}）`,
          where: 'scripts/check-admin-capability-coverage.mjs ∷ KNOWN_GAPS',
        });
      }
      continue;
    }
    // ⚠️ 归属判定不能只看 path 前缀：`/wecom/kb/bindings` 是靠
    //    `*.admin.controller.ts` 的**文件名**归入 admin 端的（见 TARGETS.matchRoute），
    //    只按前缀判会把它错判给 mp 端、再误报成「条目失效」。
    //    ⇒ 失效只在**全仓都找不到**这个端点时才报；找得到但不属于本端，交给那一端去判。
    const anywhere = routes.find((r) => (!k.method || k.method === r.method) && k.path === r.norm);
    if (!anywhere) {
      findings.push({
        kind: '[缺口条目失效]',
        detail: `${k.method ?? ''} ${k.path} 在代码里已不存在（${tag}）`,
        where: 'scripts/check-admin-capability-coverage.mjs ∷ KNOWN_GAPS',
      });
      continue;
    }
    const hit = myRoutes.find((r) => (!k.method || k.method === r.method) && k.path === r.norm);
    if (!hit) continue; // 属于另一端，由那一端负责判定
    if (isReferenced(hit.norm, coverRefs)) {
      findings.push({
        kind: '[缺口已修·请删条目]',
        detail: `${hit.method} ${hit.norm} 已被前端引用（${tag}）`,
        where: 'scripts/check-admin-capability-coverage.mjs ∷ KNOWN_GAPS',
      });
    }
  }

  // C. 豁免过期（自收紧：已被引用的端点不许继续豁免）
  for (const ex of exempt.filter((x) => x.target === target && x.path)) {
    if (isReferenced(ex.path, refs)) {
      findings.push({
        kind: '[豁免过期]',
        detail: `${ex.path} 已被前端引用，应从豁免表删除`,
      });
    }
  }

  return {
    findings,
    knownHits,
    stats: {
      routes: myRoutes.length,
      refs: refs.size,
      exports: exports.length,
    },
  };
}

// ---------------------------------------------------------------- 主流程

function runReal() {
  let bad = 0;
  const { routes, parseMisses } = parseRoutes(join(REPO, 'apps/api-server/src'));
  if (parseMisses.length) {
    console.log('  [解析自证] 以下 controller 的装饰器数与解析命中数不符 ⇒ 解析不可信：');
    for (const m of parseMisses) console.log(`    ${m.file}: 声明 ${m.declared} / 解析 ${m.parsed}`);
    bad += parseMisses.length;
  }

  const ALL_FRONT = [
    join(REPO, 'apps/admin-web/src'),
    join(REPO, 'apps/miniprogram/src'),
    join(REPO, 'apps/h5/src'),
  ];
  const allRefs = parseRefs(ALL_FRONT);

  for (const target of ['admin', 'mp']) {
    const t = TARGETS[target];
    const refs = parseRefs(t.frontDirs);
    const exports = parseExports(t.apiDir);
    const identRefs = parseIdentRefs(exports, t.frontDirs);

    const { findings, knownHits, stats } = check({
      routes,
      refs,
      exports,
      identRefs,
      target,
      exempt: EXEMPT,
      allRefs,
      knownGaps: KNOWN_GAPS,
    });

    console.log(
      `\n=== ${t.label}（${target}）=== 端点 ${stats.routes} · 前端引用 ${stats.refs} · api 导出 ${stats.exports}`,
    );
    if (knownHits.length) {
      console.log(`  [已知缺口·已登记待办] × ${knownHits.length} —— 不阻断门禁，但每次都会打印`);
      for (const k of knownHits) console.log(`    · ${k.detail}  ${k.kind}  ${k.reason}`);
    }
    if (!findings.length) {
      console.log('  OK 无新增缺口');
      continue;
    }
    const byKind = new Map();
    for (const f of findings) {
      const arr = byKind.get(f.kind) ?? [];
      arr.push(f);
      byKind.set(f.kind, arr);
    }
    for (const [kind, arr] of byKind) {
      console.log(`  ${kind} × ${arr.length}`);
      for (const f of arr.slice(0, 40)) {
        console.log(`    · ${f.detail}${f.where ? `  ← ${f.where}` : ''}`);
      }
      if (arr.length > 40) console.log(`    … 其余 ${arr.length - 40} 条略`);
    }
    bad += findings.length;
  }

  if (bad) {
    console.log(`\n[FAIL] 共 ${bad} 项。缺口要么补页面，要么在 EXEMPT 写明理由（后者请先自问：是真不需要，还是懒得做）。`);
    return 1;
  }
  console.log('\n[OK] 有能力 ↔ 有入口，双向无缺口');
  return 0;
}

// ---------------------------------------------------------------- 自证

function selftest() {
  const tmp = mkdtempSync(join(tmpdir(), 'abox-cov-'));
  const results = [];
  const ok = (name, cond, extra = '') => {
    results.push({ name, pass: Boolean(cond), extra });
  };

  try {
    const apiSrc = join(tmp, 'api');
    const frontSrc = join(tmp, 'front');
    const apiDir = join(frontSrc, 'api');
    for (const d of [apiSrc, frontSrc, apiDir]) {
      writeFileSync(join(tmp, '.keep'), '');
      mkdirSync(d, { recursive: true });
    }

    const ctrl = `import { Controller, Get, Post } from '@nestjs/common';
@Controller('admin/ghost')
export class GhostController {
  @Get('thing')
  thing() {}

  @Post('do')
  doIt() {}
}
@Controller('admin/used')
export class UsedController {
  @Get('list')
  list() {}
}
`;
    writeFileSync(join(apiSrc, 'ghost.controller.ts'), ctrl);

    // ① 空前端 ⇒ 两条 admin 端点都必须报「有能力无入口」
    let { routes } = parseRoutes(apiSrc);
    let refs = parseRefs([frontSrc]);
    let exports = parseExports(apiDir);
    let identRefs = parseIdentRefs(exports, [frontSrc]);
    let r1 = check({
      routes,
      refs,
      exports,
      identRefs,
      target: 'admin',
      exempt: [],
    });
    const a1 = r1.findings.filter((f) => f.kind === '[有能力无入口]').map((f) => f.detail);
    ok('必报：空前端时 admin/ghost/thing 应报缺口', a1.includes('GET /admin/ghost/thing'), a1.join('|'));
    ok('必报：空前端时 admin/ghost/do 应报缺口', a1.includes('POST /admin/ghost/do'), a1.join('|'));
    // 集合规模断言必须触发（此时端点仅 3 条 < MIN_ROUTES ⇒ 取数失败必须报）
    ok(
      '恒绿检测：端点过少必须报 [取数失败]',
      r1.findings.some((f) => f.kind === '[取数失败]'),
      JSON.stringify(r1.stats),
    );

    // ② 前端引用了 /admin/used/list ⇒ 该条不报（判据写反会在这里红）
    writeFileSync(
      join(frontSrc, 'used.ts'),
      "export const fetchUsed = () => http.get('/admin/used/list');\n",
    );
    writeFileSync(
      join(frontSrc, 'used.vue'),
      "<script setup>import { fetchUsed } from './used'; fetchUsed();</script>\n",
    );
    refs = parseRefs([frontSrc]);
    exports = parseExports(apiDir);
    identRefs = parseIdentRefs(exports, [frontSrc]);
    const r2 = check({ routes, refs, exports, identRefs, target: 'admin', exempt: [] });
    ok(
      '必不报：前端已引用的 /admin/used/list 不得报缺口',
      !r2.findings.some((f) => f.detail === 'GET /admin/used/list'),
      JSON.stringify(r2.findings.map((f) => f.detail)),
    );

    // ③ 模板字符串 / 拼接参数形态必须算命中（否则整类真引用被误报）
    writeFileSync(
      join(frontSrc, 'detail.ts'),
      'export const fetchOne = (id: number) => http.get(`/admin/used/${id}/detail`);\n',
    );
    refs = parseRefs([frontSrc]);
    ok(
      '必不报：尾参形态 `/admin/used/` + id 必须按前缀命中 /admin/used/:p',
      isReferenced('/admin/used/:p', refs),
      [...refs.keys()].join('|'),
    );
    ok(
      '必报：非参数端点不得靠前缀蒙混过关（/admin/other 不该被 /admin/used/ 命中）',
      !isReferenced('/admin/other', refs),
      [...refs.keys()].join('|'),
    );

    // ④ 必报：api 导出的方法无人引用 ⇒ [接口已接未落地]
    writeFileSync(join(apiDir, 'orphan.ts'), 'export const fetchOrphan = () => http.get("/admin/x/y");\n');
    exports = parseExports(apiDir);
    identRefs = parseIdentRefs(exports, [frontSrc]);
    const r4 = check({ routes, refs, exports, identRefs, target: 'admin', exempt: [] });
    ok(
      '必报：无人引用的导出方法 fetchOrphan 应报缺口',
      r4.findings.some((f) => f.kind === '[接口已接未落地]' && f.detail.includes('fetchOrphan')),
      JSON.stringify(r4.findings.map((f) => f.kind + f.detail)),
    );

    // ⑤ 豁免过期
    const r5 = check({
      routes,
      refs,
      exports,
      identRefs,
      target: 'admin',
      exempt: [{ target: 'admin', method: 'GET', path: '/admin/used/list', reason: 'test' }],
    });
    ok(
      '必报：已被引用的端点仍在豁免表 ⇒ [豁免过期]',
      r5.findings.some((f) => f.kind === '[豁免过期]'),
      JSON.stringify(r5.findings.map((f) => f.kind)),
    );

    // ⑥ 已知缺口表的自收紧（C-0）：补了页面必须逼删条目，条目失效也要报
    const gaps = [
      { method: 'GET', path: '/admin/used/list', reason: 'r', todo: 'T-used', since: 's' },
      { method: 'GET', path: '/admin/ghost/thing', reason: 'r', todo: 'T-ghost', since: 's' },
      { method: 'GET', path: '/admin/nope/gone', reason: 'r', todo: 'T-gone', since: 's' },
    ];
    const r6 = check({
      routes,
      refs,
      exports,
      identRefs,
      target: 'admin',
      exempt: [],
      knownGaps: gaps,
    });
    const fixed6 = r6.findings
      .filter((f) => f.kind === '[缺口已修·请删条目]')
      .map((f) => f.detail)
      .join('|');
    const gone6 = r6.findings
      .filter((f) => f.kind === '[缺口条目失效]')
      .map((f) => f.detail)
      .join('|');
    ok('必报：条目仍在但端点已被引用 ⇒ [缺口已修·请删条目]', fixed6.includes('/admin/used/list'), fixed6);
    ok('必不报：端点仍未被引用 ⇒ 不许报「已修」', !fixed6.includes('/admin/ghost/thing'), fixed6);
    ok('必报：条目写了代码里没有的端点 ⇒ [缺口条目失效]', gone6.includes('/admin/nope/gone'), gone6);

    // ⑦ 真实仓库跑一遍：集合必须非空（否则说明解析在真实代码上失效）
    const realRoutes = parseRoutes(join(REPO, 'apps/api-server/src')).routes;
    const realRefs = parseRefs(TARGETS.admin.frontDirs);
    const realExports = parseExports(TARGETS.admin.apiDir);
    ok('真实仓库：admin 端点数应 > 阈值', realRoutes.length > MIN_ROUTES, String(realRoutes.length));
    ok('真实仓库：前端引用数应 > 阈值', realRefs.size > MIN_REFS, String(realRefs.size));
    ok('真实仓库：api 导出数应 > 阈值', realExports.length > MIN_EXPORTS, String(realExports.length));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  let fail = 0;
  for (const r of results) {
    console.log(`  ${r.pass ? 'OK  ' : 'FAIL'}  ${r.name}${r.pass ? '' : `  ← ${r.extra}`}`);
    if (!r.pass) fail += 1;
  }
  console.log(`\n自证 ${results.length - fail}/${results.length}`);
  return fail ? 1 : 0;
}

// ---------------------------------------------------------------- 入口

const args = process.argv.slice(2);
if (args.includes('--selftest')) {
  process.exit(selftest());
}
process.exit(runReal());

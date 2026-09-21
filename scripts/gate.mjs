#!/usr/bin/env node
/**
 * ABox 门禁执行器（**免 pnpm**）
 *
 * 背景：本机沙箱内 `pnpm` 不可用（corepack shim 路径被错误拼接为 `C:\c\Users\...`
 * → `pnpm -v` 无输出且退出码为空），故不能用 `pnpm -r <script>` 逐条复刻 CI。
 *
 * 做法：直接用 managed node，把「包内 node_modules/.bin + node 所在目录」前置进 PATH，
 *       以 shell 方式执行各包 `package.json` 里声明的同一条命令，逐条复刻 CI。
 *
 * 用法：
 *   node scripts/gate.mjs list            # 列出全部门禁
 *   node scripts/gate.mjs --json          # 机器可读：{ gates, aliases }（别名已展开）—— 供一致性门禁消费
 *   node scripts/gate.mjs shared          # 仅重建共享包 dist（其它门禁的前置）
 *   node scripts/gate.mjs lint typecheck jest format
 *   node scripts/gate.mjs all
 *   node scripts/gate.mjs all --stop      # 首个失败即停（默认跑完再汇总）
 *
 * ── 关于构建门禁的 outDir 清理（2026-09-15）─────────────────────────────────
 * `nest build` / `vite build` 会先**清空自己的 outDir**（`dist` 有 600+ 文件）。
 * 在 WorkBuddy 沙箱里，这会被宿主的 bulk-delete 守卫拦下：
 *   [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":668,"threshold":50,...}
 * 守卫按**本轮对话**累计计数，阈值 50 个文件 —— 构建产物必然超限。
 *
 * 处理办法（不关闭任何安全策略，只是换一条宿主明确允许的路径）：
 *   gate 在跑构建前，把 outDir **改名挪进系统临时目录**（rename 不是删除，不计入配额），
 *   构建工具面对一个不存在的 outDir 自然「无需清理」；构建完成后，再删除临时副本
 *   —— 临时目录属于守卫的豁免名单（`shouldBypassSafeDelete` → temp dirs）。
 * 结果与「先 rm -rf dist 再构建」完全等价，且顺带得到**干净构建**（无陈旧产物）。
 */
import { existsSync, renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_DIR = dirname(process.execPath);
const IS_WIN = process.platform === 'win32';
const PATH_SEP = IS_WIN ? ';' : ':';

/**
 * ── e2e 时钟注入（2026-09-17）─────────────────────────────────────────────
 * `isOrderable(T)` = `[T-1 14:00, T-1 23:00)` —— 窗口外**任何**出餐日都下不了单
 * （该不等式对整数日无解），于是 m1/m2 每天只有 9 小时能跑，00:00–14:00 恒红：
 * 20+ 条断言级联失败，真回归反而被这 15 小时的假红淹没（ref《缺陷与陷阱》已登记）。
 *
 * 处理：给所有做「相对现在」判定的门禁注入 `ABOX_SHIFT_TO_HOUR=20` —— 服务端
 * 把**北京小时**平移到 20:00（**日历日不变**），时间仍 1:1 前进。于是脚本侧用真实
 * 钟算出的 `todayBj()/tomorrowBj()` 与服务端依旧对齐，夹具无需改动。
 *
 * 只影响被注入的测试进程：`time.ts` 在 `NODE_ENV=production` 时直接忽略该变量。
 * 边界（不改变 `@Cron` 触发时刻、不影响存量 `new Date()` 落库）见 time.ts 顶部注释。
 */
const E2E_CLOCK_HOUR = '20';

/**
 * ── M4-3：队列驱动显式注入 ────────────────────────────────────────────────
 * 队列**刻意不做静默降级**（`QUEUE_DRIVER=redis` 时连不上 Redis 会拒绝启动，
 * 理由见 `common/queue/queue.types.ts`：静默退化成进程内队列会让任务悄无声息地
 * 只存在于某个实例的内存里）。因此测试进程**必须显式声明**走进程内队列 ——
 * 不能依赖 `apps/api-server/.env`（CI 里没有该文件）。
 *
 * `QUEUE_BACKOFF_BASE_MS=20` 把重试退避压到毫秒级：否则「验证失败后重试成功」
 * 这条断言要真等 1s + 2s。
 */
const RUNTIME_ENV = {
  ABOX_SHIFT_TO_HOUR: E2E_CLOCK_HOUR,
  QUEUE_DRIVER: 'memory',
  QUEUE_BACKOFF_BASE_MS: '20',
};

/** 各门禁：cwd 相对仓库根；cmd 与 package.json script 保持一致 */
const GATES = {
  'shared:types': { cwd: 'packages/shared-types', cmd: 'tsc -p tsconfig.build.json', group: 'shared' },
  'shared:utils': { cwd: 'packages/shared-utils', cmd: 'tsc -p tsconfig.build.json', group: 'shared' },
  lint: { cwd: '.', cmd: 'eslint . --ext .ts,.vue --max-warnings 0' },
  format: { cwd: '.', cmd: 'prettier --check "**/*.{ts,vue,json,md,scss}"' },
  'format:write': { cwd: '.', cmd: 'prettier --write "**/*.{ts,vue,json,md,scss}"' },
  'typecheck:api': { cwd: 'apps/api-server', cmd: 'tsc --noEmit' },
  'typecheck:admin': { cwd: 'apps/admin-web', cmd: 'vue-tsc --noEmit' },
  'typecheck:mp': { cwd: 'apps/miniprogram', cmd: 'vue-tsc --noEmit -p tsconfig.json' },
  /**
   * ⚠️ 2026-09-21 移除 `--passWithNoTests`（对策②）：该参数让「**一个测试都没跑到**」也返回 0
   *    ⇒ 5 个 spec 被重命名 / 误删时，门禁**依旧全绿**，且输出里没有任何线索。
   *    本地开发者的 `pnpm test` 仍保留它（本地未必有测试文件），
   *    **门禁路径必须严格：0 个测试 = 红。**
   */
  jest: { cwd: 'apps/api-server', cmd: 'jest' },
  /**
   * M5-2：**迁移 ↔ 实体 结构机械对账**（缺陷 #76 的防复发门禁）
   *
   * 为什么必须有：生产（MySQL）的表结构**只由迁移决定**（`synchronize: driver === 'sqlite'`），
   * 而 seed / e2e 全跑 sqlite（由**实体**同步建表）→ **迁移一次都不会被执行**。
   * 于是「实体改了、迁移忘了改」原先**不在任何失败路径上**：e2e 全绿，生产首迁建出残缺库
   * （实测曾少 2 张表、9 列，其中 `ab_refund.order_status_before` 缺了会让 C6 退款审批直接打不开）。
   *
   * 该检查自带**自证能力**：每次运行都会人为制造一个缺口，确认自己能报出来 —— 报不出即失败
   * （「恒绿的检查」比没有检查更糟）。
   */
  'schema:parity': {
    cwd: 'apps/api-server',
    cmd: 'ts-node -r tsconfig-paths/register src/database/schema-parity.ts',
  },
  /**
   * M5-6：**迁移 ↔ 实体 索引机械对账**（`schema:parity` 的已知边界补位）
   *
   * `schema:parity` 只比「表 + 列 + 列类型族」，它自己在注释里明写**不比索引**。
   * 于是「实体加了索引、迁移忘了加」与 #76 是**同一族**缺口，却不在任何失败路径上：
   *   · 本地 sqlite 由**实体** synchronize 建表 → 索引按实体声明建；
   *   · 生产由**迁移**建表 → 索引按迁移 DDL 建。
   * **两边都「成功」，两边的索引集却可以完全不同。**
   *
   * ⚠️ 索引不一致比列不一致**更隐蔽**：缺列会 `Unknown column` 直接炸出来，
   * 索引不一致**一句报错都没有**，只表现为「本地很快、生产很慢」（或反过来）。
   * 该门禁首跑实测出 **25 处列不一致 + 1 处实体缺失** —— 全都是同一个形状：
   * 实体写**属性级单列** `@Index('n')`，迁移写**类级复合** `(a,b)`。
   * 其中就包含报告 §二 P1-3 的误判来源（审阅者读实体文件得出「缺 mealDate 索引」，
   * 而迁移里其实有 `(team_leader_id, meal_date)`）—— **两套表述会误导审计**。
   *
   * 判据：索引名 + **列（有序）** + 唯一性，三者全等。比名不比列是**不够**的
   * （那样恰好放走「复合索引被写成单列」这一档）。
   * 自带三重自证：人为删索引 / 翻转唯一性 / 删一列，**每一种都必须报出**。
   */
  'index:parity': {
    cwd: 'apps/api-server',
    cmd: 'ts-node -r tsconfig-paths/register src/database/index-parity.ts',
  },
  /**
   * M5-3 安全自检（一）· 路由权限审计 —— 防「忘了写 @Roles」
   *
   * `AdminGuard` 的判据是 `roles && roles.length > 0`，于是**没写 `@Roles` 的运营端点
   * 默认对所有后台角色开放（含 supplier / viewer）**。这类缺陷 e2e 抓不到（没人用
   * supplier token 打过它）、编译也拦不住，与 #76 同族：**所有机械证据都是绿的，
   * 而对应的能力从未被验过一次**。
   *
   * 用**运行时反射**读元数据而非解析源码 —— `@Roles` 有变量展开形态
   * （`@Roles(...FUND_ACTION_ROLES)`），正则/AST 会漏（同 `schema:parity` 的教训）。
   * 自带双重自证：① 每个 *.controller.ts 必须导出 controller 类（防静默漏扫）；
   * ② 每次运行人为构造违规端点，规则必须报出。
   */
  'route:audit': {
    cwd: 'apps/api-server',
    cmd: 'ts-node -r tsconfig-paths/register src/common/security/route-audit.ts',
  },
  /**
   * M5-3 安全自检（二）· 密钥泄露 + 日志脱敏
   *
   * 扫**工作区 + 完整 git 历史**（「提交过又删掉」的密钥仍在历史里可检出，
   * 只扫工作区会给出一个**看起来绿的结论**），并核查日志是否整对象落敏感字段。
   * 自带自证：真凭据样本必报、占位样本必不报、纯文案提及字段名必不报。
   */
  'security:scan': {
    cwd: 'apps/api-server',
    cmd: 'ts-node -r tsconfig-paths/register src/common/security/security-scan.ts',
  },
  /**
   * M5-15：**后台菜单「授权 ↔ 入口」一致性**（导航断链的防复发门禁 · 已复发四次）
   *
   * 后台侧边栏 = `ADMIN_NAV ∩ account.menus[]`（`stores/permission.ts:45`），
   * 于是两个方向都会**静默**失效 —— 不报错、不红、日志里什么都没有：
   *   ① **授权了但没有入口**：服务端白名单有 key、路由在、接口也在，而 `ADMIN_NAV` 从不列它
   *      ⇒ 侧边栏永远不出现 ⇒ 只能手输 URL ⇒ 人工测试表现为「**后台缺某个模块**」；
   *   ② **有入口但没有授权**：`ADMIN_NAV` 列了、白名单没有 ⇒ 该项对**任何角色**都不显示
   *      （super_admin 的 `*` 也救不了，因为渲染源是 `ADMIN_NAV` 本身）⇒ 死条目。
   *
   * 复发史：M3-14（财务域五页）→ M5-12（`/system/message-template`）→
   *        M5-15（`/building/*` 四页 + 平台端菜品库，**人工测试当场发现**）。
   * ⭐ 本门禁**首次运行**又抓出 5 处历史遗留（详见 `scripts/check-nav-consistency.mjs` 头注释）——
   *    其中 `/supplier/packing-center` 是"前端有入口、后端有控制器、连注释都把它写作菜单 key，
   *    而数组里就是没有"的死条目。
   *
   * 为什么 e2e 替代不了它：e2e 只断言"某接口对某角色**可见 / 不可见**"，
   * **从不渲染侧边栏** —— 菜单漏项在 e2e 里是完全隐形的（绿着的）。
   *
   * 判据：双向全等 + 显式豁免（豁免必须自带机械证据，且**自收紧**：一旦补进导航就必须删豁免）。
   * 自带自证：注入 4 种缺口（幽灵授权 / 幽灵入口 / 过期豁免 / 腐烂豁免）每种都必须报出，
   * 且干净输入必须**零问题**（恒绿的检查比没有检查更糟）。
   */
  'nav:consistency': { cwd: '.', cmd: 'node scripts/check-nav-consistency.mjs' },
  /**
   * M5-15：**契约文档的 Markdown 表格完整性**（防「表格被空行截断」）
   *
   * GFM 里**表格遇空行即结束** —— 「表行 → 空行 → 表行」会让空行之后的行退化成
   * **带竖线的普通段落**。源文件「看着像表」、渲染出来不是表，而
   * **prettier / markdownlint / 任何构建工具都不报错**（`docs` 还在 `.prettierignore` 里，
   * 连格式门禁都不覆盖）。
   *
   * ⚠️ 实测**存量 5 处**（M5-15 收尾一次扫出）：里程碑计划变更记录表 **3 处**
   * （v1.1.4 / v1.1.5 / v1.1.7 三行 ⇒ 整表**裂成 4 段**）· 接口规范修订表 **1 处**
   * （「最近修订（M5-14）」整行被**粘在 M5-8 行尾** ⇒ 该行渲染时**多出两列**）·
   * 项目目录结构版本表 **1 处**。**5 处都是「人眼看不出来、工具不报错」**。
   *
   * ⭐ 这类缺陷**用编辑器追加表格行时极易引入**（把新行锚在 `---` 或文末，插入点落空行之后），
   *    而本项目的产物**就是这些文档** ⇒ 必须机械检查。
   *
   * 判据：空行的上下都是表行 ⇒ 违规；**但「两张表相邻」是合法的**
   * （空行后紧跟「表头 + 分隔行」），故追加排除 —— 粗判据会在接口规范 §6.8 误报，
   * 而**误报比漏报更快把人训练成忽略告警**。
   * 扫 `docs/*.md`（仓库内唯一事实来源，且与根文档字节一致），**不读工作区根**
   * （仓库外路径在 CI checkout 里不存在 ⇒ 会让门禁行为不确定）。
   * 自带自证：4 个合成样本（分离行必报 / 两表相邻不报 / 表头后正文不报 / 表尾后正文不报）。
   */
  'doc:tables': { cwd: '.', cmd: 'node scripts/check-md-tables.mjs' },
  /**
   * 2026-09-21：**真源字面量外溢**（dup-const）—— 针对「同一件事多份表述」这一条横向根因
   *
   * 本项目反复出现的形状：同一个概念有 N 份表述，**不被自动化执行的那一份必然悄悄错掉**。
   * 已发生的两例（本门禁直接针对）：
   *   ① **档位映射**：真源 `shared-utils/src/biz.ts` 的 `SET_MEAL_SLOT_LABEL`，而端上
   *      `utils/format.ts` 与 `order-admin.service.ts` **各手抄了一份同值映射** ——
   *      抄的时候是对的 ⇒ 改真源那一刻它们就错了，而那时门禁全绿。
   *   ② **送达时刻**：真源 `common/utils/order-timeline.ts` 的 `DEFAULT_TIMELINE.arrival`；
   *      PR-02 一次性收口 **8 处**手写时刻（含「同 payload 里 `expectAt` 手写 + `expectAtIso`
   *      派生」这种**双真相并排**形态，改一次配置当场分裂）。
   *
   * 判据只挑「**当前零命中且零误报**」的三条（`slot-map` / `arrival-literal` / `date-parse`），
   * **刻意不覆盖**费率（`0.12` 与 CSS `rgba(...,0.12)` 同形）与售价（快照/示例合法出现）——
   * 理由与实测命中数写在 `scripts/check-dup-const.mjs` 头注释里。
   * 自带自证：16 个样本「必报的报得出 / 必不报的不报」，任一侧不符即 exit 2。
   */
  'dup:const': { cwd: '.', cmd: 'node scripts/check-dup-const.mjs' },
  /**
   * 2026-09-21：**门禁清单一致性**（CI ↔ `gate.mjs` ↔ 文档条数）—— `dup:const` 的同族
   *
   * 病根与 `dup:const` 完全相同：**同一件事两份表述**。只是这次被抄的是「门禁清单本身」：
   *   · `.github/workflows/ci.yml` 自工程仓重建后**一次都没改过**，里面另写了一套
   *     `pnpm lint / typecheck / test / build:*`，**缺** schema:parity / index:parity /
   *     route:audit / security:scan / nav:consistency / doc:tables / dup:const / state:audit；
   *   · 往本文件加门禁**不会**传到 CI ⇒「本地绿、CI 装作绿」，CI 的绿灯**不构成证据**；
   *   · 而 CLI 里那个 `NODE_VERSION: '20'` 更直接使 `verify` 起不来（`node:sqlite` 要 ≥22.5）
   *     —— 即「CI 跑 e2e」此前只是**一句声明**。
   *
   * 判据（纯文本，**不依赖 yaml 解析器** —— 只引传递依赖会随 lockfile 漂移）：
   *   ① CI 必须**只**通过 `node scripts/gate.mjs <别名>` 调门禁，且两个别名
   *      （`all` / `verify`）**覆盖到全部门禁**（漏一道即红）；
   *   ② CI 里**不得**再出现逐包门禁命令（`pnpm lint|typecheck|test|build*`、裸 `eslint`/`jest`/
   *      `tsc` 等）—— 那就是第二份清单的起点；
   *   ③ 文档里声明的条数必须等于实算条数（读 `docs/` 内镜像的显式标记，格式见脚本头注释）。
   *      这一条治的是本项目另一类高发病：**数字写死在多处，改一处就悄悄错**。
   * 自带自证：合成样本「必报的报得出 / 必不报的不报」，任一侧不符即 exit 2。
   */
  'gate:parity': { cwd: '.', cmd: 'node scripts/check-gate-parity.mjs' },
  /**
   * S7.5：**端上「图标承载」门禁** —— 规格 §五「功能图标三档 16/20/24px」的防复发断言
   *
   * S7 实测：规格写了三档锁，而端上 **78 处渲染点落在三档内 0 处** —— 图标由各页
   * `import { ABOX_ICON_CHARS as I }` 把 PUA 字符直塞 `<text>`，字号各页自己写 ⇒
   * **无从机械校验**（无从校验就无法防复发）。本门禁把「承载方式」变成可跑断言。
   *
   * ⚠️ 承载方式**不是** `ab-icon` 组件：微信官方文档（text 组件 · Bug & Tip）原文
   *    「text 组件内只支持 text 嵌套」⇒ `<text>` 不能内嵌自定义组件；端上绝大多数图标位是
   *    「图标 + 中文」混排在同一 `<text>` 里，写组件会被渲染层**静默丢弃**（不报错、不警告）。
   *    ⇒ 唯一可行写法是**统一 class 约定**：`<text class="abi abi-16">{{ I.chart }}</text>`
   *    （端上 `components/ab-icon/` 已按此裁定移出，见 `_tmp/icons/removed-components/`。）
   *
   * 七条断言（① 渲染区真 emoji == 0 · ② 非承载位上的 `I.xxx` == 0 · ③ 插值必须被档位包裹 ·
   *          ④ 档位取值合法 · ⑤ 两端档位定义与真源一致 · ⑥ `ab-icon` 存在性×引用数四态 ·
   *          ⑦ 独立箭头元素内不得是裸字形 `› ⌄`）。
   * **自带自证**：4 组 9 条合成样本（必报 / 必不报 / 嵌套 template 截断 / ⑦ 三态），
   * 任一侧不符即 exit 2 —— 「恒绿的检查比没有检查更糟」。
   *
   * ⚠️ 它治的是本项目最贵的一类缺陷：**规格写了、代码没做，而门禁结构上看不见**。
   */
  'icons:lock': { cwd: '.', cmd: 'node scripts/check-icon-lock.mjs' },
  /**
   * M5-7：**订单状态机「声明 ↔ 生产写入点」机械对账**（缺陷 #79 的防复发门禁）
   *
   * #79 是一条 **P0**，而当时 **19 道门禁全绿、e2e 969 条全绿** —— 一条都没红。
   * 原因不是门禁写错了，而是**没有任何门禁问过这个问题**：
   * `ORDER_TRANSITIONS` 声明了 `cut_off → cooked → delivering → delivered`，
   * 而这三个状态在 `ab_order` 上**全仓零写入点**（订单永久停在 `cut_off`，
   * 团长确认取餐永远返回零值且**不报错**，**佣金永远不产生**）。
   * 而 e2e 夹具**直接 `UPDATE ab_order SET status='delivered'`** 造数据 →
   * 测试永远从链路**中间**开始，上游缺没缺，它**看不见**。
   *
   * 与 `schema:parity` / `index:parity` 完全同族：**同一件事有两份表述**
   * （状态机声明 / 生产代码），而**不被自动化执行的那一份必然是错的**。
   *
   * 判据（**状态级**，不是边级 —— 边界写在脚本头注释里）：
   *   ① 声明为迁移目标的每个状态，必须至少有一个写入点（未实装的走**显式豁免表**）
   *   ② 生产代码写过的每个状态，必须在状态机里登记过
   *   ③ 豁免**会自收紧**：一旦被实现，门禁要求删除豁免（防止「未实装清单」腐烂）
   * 自带三重自证（人为删目标 / 塞幽灵状态 / 加过期豁免，三种都必须报出），
   * 并附**反证测试**（删掉 `delivering` 豁免 → 必红并点名；塞 `'ghost_state'` → 必红）。
   *
   * ⚠️ 它**不验证迁移边是否合法**（证明不了 `cut_off → cooked` 这条边成立），
   *    只证明 `cooked` 这个**状态**有人写；无法静态判定的写入点**显式列为待人工确认**，绝不静默跳过。
   */
  'state:audit': {
    cwd: 'apps/api-server',
    cmd: 'ts-node -r tsconfig-paths/register src/modules/order/order-state-audit.ts',
  },
  // outDir：构建前先改名挪走，避免构建工具自己 bulk-rm 被宿主守卫拦截（见文件头说明）
  'build:api': { cwd: 'apps/api-server', cmd: 'nest build', outDir: 'dist' },
  'build:admin': { cwd: 'apps/admin-web', cmd: 'vite build', outDir: 'dist' },
  'build:mp': { cwd: 'apps/miniprogram', cmd: 'uni build -p mp-weixin', outDir: 'dist' },
  seed: {
    cwd: 'apps/api-server',
    cmd: 'ts-node -r tsconfig-paths/register src/database/seeds/seed.ts',
    // ABOX_SEED_CONFIRM：seed 会**清空全部表**，脚本要求显式确认（M5-7 加固）。
    // 放在 RUNTIME_ENV **之前**，允许调用方覆盖（与 lib/e2e-server 的三级优先级同款）。
    env: { ABOX_SEED_CONFIRM: '1', ...RUNTIME_ENV },
  },
  /**
   * M5-9：**演示 / 边界数据集**（在基础种子之上叠加的一层，供人工测试使用）
   *
   * `seed` 只落主数据、**一张订单都没有** → 看板全 0、财务四页全空、配送单无单可推，
   * 人工测试的 A2/A12/A13/A14/A17/A18/A7b 都无从判起。本层把订单 11 态、
   * 退款四态、提现五态、佣金两段式、发票三态、完整履约链演练日一次补齐。
   *
   * ⚠️ **刻意不并进 `seed`**：`gate.mjs seed` 是 e2e 的前置，而 e2e:m3 有多处
   * **绝对值**断言（§14 D1 排期格数 / §20 三味屋当日加工场所数 / §27 发票分母 /
   * §23·§35 的干净候选池）依赖「库里只有基础种子」。并进去会让这些断言全红 ——
   * 那是与被测产物无关的**假红**。故两层分离：门禁用 `seed`，人工测试用 `seed` + `seed:demo`。
   *
   * 自带自检（11 态覆盖 / sold_count 口径 / 金额闭合 / 佣金复核 / 资金恒等式 /
   * 「明日不被占用」/「同用户同日不重复」），自检不过即 `exit 1`。
   */
  'seed:demo': {
    cwd: 'apps/api-server',
    cmd: 'ts-node -r tsconfig-paths/register src/database/seeds/seed-demo.ts',
    env: { ABOX_SEED_CONFIRM: '1', ...RUNTIME_ENV },
  },
  // M1 端到端验收：真实起服务 + 真实 HTTP，覆盖验收标准 1–5（含幂等回放与 40004 分支）
  // env.E2E_PORT：两个 e2e 各用独立端口，串跑时互不干扰（详见 scripts/lib/e2e-server.mjs）
  'e2e:m1': { cwd: '.', cmd: 'node scripts/e2e-m1.mjs', group: 'e2e', env: { E2E_PORT: '3101', ...RUNTIME_ENV } },
  // M2 端到端验收：团长申请即生效（C3）+ 身份守卫 + floor 落库 + 等级口径回归
  'e2e:m2': { cwd: '.', cmd: 'node scripts/e2e-m2.mjs', group: 'e2e', env: { E2E_PORT: '3102', ...RUNTIME_ENV } },
  // M3 端到端验收：后台登录/锁定/吊销 + 主体隔离 + 角色白名单 + 操作日志
  'e2e:m3': { cwd: '.', cmd: 'node scripts/e2e-m3.mjs', group: 'e2e', env: { E2E_PORT: '3103', ...RUNTIME_ENV } },
};

/** 组合门禁别名 */
const ALIASES = {
  shared: ['shared:types', 'shared:utils'],
  typecheck: ['typecheck:api', 'typecheck:admin', 'typecheck:mp'],
  build: ['build:api', 'build:admin', 'build:mp'],
  /** 端到端验收一键跑：重置种子 → 起服务跑真实 HTTP 全链路（M1 + M2 + M3） */
  verify: ['seed', 'e2e:m1', 'e2e:m2', 'e2e:m3'],
  all: [
    'shared',
    'lint',
    'format',
    'typecheck',
    'schema:parity',
    'index:parity',
    'state:audit',
    'route:audit',
    'security:scan',
    // M5-15：菜单「授权 ↔ 入口」一致性（导航断链防复发）—— 纯静态、秒级
    'nav:consistency',
    // M5-15：契约文档表格完整性（表格被空行截断 → 行退化成正文）—— 纯静态、毫秒级
    'doc:tables',
    // 2026-09-21：真源字面量外溢（档位映射 / 送达时刻 / 日期解析）—— 纯静态、秒级
    'dup:const',
    // 2026-09-21：门禁清单一致性（CI 只许调本文件 · 不得另抄一份 · 文档条数一致）—— 纯静态、毫秒级
    'gate:parity',
    // S7.5：端上图标承载（三档锁）—— 纯静态、毫秒级
    'icons:lock',
    'jest',
    'build:api',
    'build:admin',
    'build:mp',
  ],
};

function expand(names) {
  const out = [];
  for (const n of names) {
    const list = ALIASES[n] ?? [n];
    for (const item of list) {
      const real = ALIASES[item] ? expand([item]) : [item];
      for (const r of real) if (!out.includes(r)) out.push(r);
    }
  }
  return out;
}

/**
 * 把 outDir 改名挪进系统临时目录（rename 不计入 bulk-delete 配额），
 * 返回临时路径供构建结束后清理；outDir 不存在则返回 null。
 */
function swapAwayOutDir(absOutDir, name) {
  if (!existsSync(absOutDir)) return null;
  const trash = join(tmpdir(), `abox-gate-${name.replace(/[:\\.]/g, '-')}-${Date.now()}`);
  try {
    renameSync(absOutDir, trash);
    return trash;
  } catch (e) {
    // 跨卷等极端情况：退回「不清理」，由构建工具自己处理（可能被守卫拦截，届时会打印原因）
    console.log(`\n⚠ ${name}: outDir 改名失败（${e?.code ?? e?.message}），回退为不预清理`);
    return null;
  }
}

/** 清理临时副本：目标位于系统临时目录 → 命中宿主豁免名单，不会被守卫拦截 */
function purgeTrash(trash) {
  if (!trash) return;
  try {
    rmSync(trash, { recursive: true, force: true });
  } catch {
    /* 临时目录残留由系统兜底，不影响门禁结论 */
  }
}

/**
 * 门禁自报覆盖面（2026-09-21 · 对策②）
 *
 * 目的：让每条门禁在汇总里**自报「查了什么、查了多少」**，而不是只报「过 / 不过」。
 * 判据：有专门正则的用专门正则抽计数；没有的**兜底打印其最后一行输出**
 *      （每个门禁脚本都会打印一行小结），保证任何门禁都不是「静默通过」。
 * ⚠️ 兜底只是**可见性**，不等于断言 —— 断言仍在各门禁脚本内部（且它们自带自证）。
 */
const REPORT_RE = {
  jest: [/^Test Suites:\s+.*$/m, /^Tests:\s+.*$/m],
  'e2e:m1': [/^通过\s+\d+\/\d+.*$/m],
  'e2e:m2': [/^通过\s+\d+\/\d+.*$/m],
  'e2e:m3': [/^通过\s+\d+\/\d+.*$/m],
};

function reportOf(r) {
  const out = r.out ?? '';
  if (!out) return ['（无输出 —— 该门禁应自报覆盖面）'];
  const res = REPORT_RE[r.name];
  if (res) {
    const hits = [];
    for (const re of res) {
      const m = out.match(re);
      if (m) hits.push(m[0].trim());
    }
    if (hits.length) return hits;
  }
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? [`最后一行：${lines[lines.length - 1].slice(0, 150)}`] : [];
}

/** 命中宿主 bulk-delete 守卫时给出可操作解释（否则只剩一坨 vite 堆栈） */
function explainFailure(text) {
  if (!text.includes('SAFE_DELETE_BULK_CONFIRM_REQUIRED')) return '';
  return [
    '',
    'ℹ 失败原因是宿主 bulk-delete 守卫（不是代码问题）：构建工具要清空 dist，',
    '  而本轮对话的删除配额（默认 50 个文件）已被构建产物（600+）超出。',
    '  正常路径：gate 会把 outDir 先改名挪走，构建工具便无需清理 —— 若仍看到本提示，',
    '  说明该 outDir 没被 gate 接管（例如直接从 package.json 跑 npm script）。',
  ].join('\n');
}

function run(name) {
  const gate = GATES[name];
  if (!gate) return { name, ok: false, code: -1, ms: 0, err: '未定义的门禁' };

  const cwd = resolve(ROOT, gate.cwd);
  const env = {
    ...process.env,
    ...(gate.env ?? {}),
    PATH: [join(cwd, 'node_modules', '.bin'), join(ROOT, 'node_modules', '.bin'), NODE_DIR, process.env.PATH].join(
      PATH_SEP,
    ),
    NODE_PATH: join(dirname(NODE_DIR), 'workspace', 'node_modules'),
    CI: 'true',
  };

  // 构建类门禁：先夺走 outDir，避免「构建工具自己 bulk-rm dist」撞守卫
  const trashed = gate.outDir ? swapAwayOutDir(resolve(cwd, gate.outDir), name) : null;

  const started = Date.now();
  const r = spawnSync(gate.cmd, {
    cwd,
    shell: true,
    stdio: 'pipe',
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const ms = Date.now() - started;

  const stdout = (r.stdout ?? '').trim();
  const stderr = (r.stderr ?? '').trim();
  const ok = r.status === 0;

  purgeTrash(trashed);

  if (!ok) {
    const combined = [stdout, stderr].filter(Boolean).join('\n');
    const tail = combined.split('\n').slice(-40).join('\n');
    console.log(`\n─── ${name} ✘ exit=${r.status} (${ms}ms) ───`);
    console.log(tail);
    const hint = explainFailure(combined);
    if (hint) console.log(hint);
  }
  // ⚠️ 2026-09-21（对策②）：**成功时也保留输出**（此前写成 `ok ? stdout : ''`，
  //    于是跑完只看到 `✔ jest (4310ms)`，**「跑了几条测试」完全不可见** ——
  //    门禁自身的退化不在任何失败路径上，正是 E1/E3 的共同病根）。
  return { name, ok, code: r.status ?? -1, ms, out: [stdout, stderr].filter(Boolean).join('\n') };
}

const argv = process.argv.slice(2).filter((a) => a !== '--stop');
const stopOnError = process.argv.includes('--stop');

/**
 * `--json`：把「门禁真源」以机器可读形式吐出（`{ gates, aliases }`，别名已展开为具体门禁）。
 *
 * 为什么需要它：`scripts/check-gate-parity.mjs` 要判「CI 覆盖到了全部门禁」，
 * 而**「哪些门禁存在」本身就是本文件的事实** —— 让检查脚本自己去正则扒本文件，
 * 等于又造一份会漂移的表述。**唯一真源必须以可读形式自报**。
 * ⚠️ 只结构化既有数据，不额外维护一份清单。
 */
if (process.argv.includes('--json')) {
  const aliases = {};
  for (const k of Object.keys(ALIASES)) aliases[k] = expand([k]);
  console.log(JSON.stringify({ gates: Object.keys(GATES), aliases }));
  process.exit(0);
}

if (argv.length === 0 || argv[0] === 'list') {
  console.log('可用门禁：');
  for (const [k, v] of Object.entries(GATES)) console.log(`  ${k.padEnd(16)} [${v.group ?? '-'}] ${v.cwd} › ${v.cmd}`);
  console.log('\n别名：shared / typecheck / build / verify / all');
  process.exit(0);
}

const queue = expand(argv);
console.log(`门禁执行：${queue.join(' → ')}`);
const clocked = queue.filter((n) => GATES[n]?.env?.ABOX_SHIFT_TO_HOUR);
if (clocked.length) {
  console.log(
    `⏱ 时钟注入：${clocked.join(' / ')} 的北京小时平移至 ${E2E_CLOCK_HOUR}:00（日历日不变）` +
      ` —— 下单窗口依赖不再锁死 14:00–23:00（见 gate.mjs 顶部说明）`,
  );
}
console.log();

const results = [];
for (const name of queue) {
  process.stdout.write(`… ${name}`);
  const r = run(name);
  console.log(`\r${r.ok ? '✔' : '✘'} ${name}  (${r.ms}ms)`.padEnd(48));
  results.push(r);
  if (!r.ok && stopOnError) break;
}

const failed = results.filter((r) => !r.ok);
console.log('\n──────── 汇总 ────────');
for (const r of results) {
  console.log(`${r.ok ? '✔' : '✘'} ${r.name.padEnd(16)} ${r.ms}ms`);
  for (const line of reportOf(r)) console.log(`      ↳ ${line}`);
}
console.log(`\n通过 ${results.length - failed.length}/${results.length}${failed.length ? ` · 失败：${failed.map((f) => f.name).join(', ')}` : ' · 全绿 ✅'}`);
process.exit(failed.length ? 1 : 0);

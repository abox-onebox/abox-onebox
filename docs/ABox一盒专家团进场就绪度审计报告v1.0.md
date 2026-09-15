# ABox 一盒 · 专家团进场就绪度审计报告 v1.0

> **审计时间**：2026-09-14 22:56 – 23:15（GMT+8）
> **审计对象**：`abox-onebox/` 仓库 + 项目根文档资产，面向「明天引入开发专家团」这一决策
> **审计方式**：**全部结论均来自实机复跑**（`tsc` / `nest build` / `vite build` / `uni build` / `jest` / `eslint` / `pnpm install --frozen-lockfile` / HTTP 探活），非文档推断
> **审计人**：AI 助手（WorkBuddy）
> **审计口径**：`✅ 通过` = 实测 exit 0 且产物正确；`⚠️ 有风险` = 能跑但存在隐患；`❌ 未就绪` = 实测失败

---

## 〇、结论摘要（先看这段）

**一句话**：**后端地基是扎实的、可以开工的；但"前端构建 + CI 门禁 + 测试 + 提交钩子 + 文档入仓"五个环节尚未就绪，如果今天不处理，专家团明天进场第一天的产出会全部卡在 CI 门口。**

### 就绪度评分

| 维度 | 就绪度 | 结论 |
| --- | --- | --- |
| 环境配置 | **85%** | 本机可开发（sqlite 零依赖模式已跑通）；缺 Docker、缺 git 远端 |
| 代码基础（后端） | **90%** | 建表/种子/登录/构建/运行全绿 ✅ |
| 代码基础（前端） | **20%** | **两个前端均构建失败** ❌，且业务层是空壳 |
| 依赖可复现性 | **80%** | lockfile 可复现 ✅；但 `vue-tsc` 与 TS 版本冲突 ❌ |
| 文档资产 | **60%** | 根目录 23 份文档齐全 ✅；**但仓库 `docs/` 里一份都没有** ❌ |
| 协作基建 | **40%** | CI 配置齐全，但**实测 4 个作业 3 红 1 假绿** ❌；husky 未接线；无 git 远端 |

### 是否建议明天如期引入专家团？

> **建议：可以引入，但请先花 30–60 分钟修掉 3 项 P0**（详见 §四）。
> 否则专家团进场后要自行排查"为什么我第一行代码还没写，CI 就是红的"，这会消耗掉他们本该用于业务开发的宝贵时间。
>
> 你此前判定的「**云资源未开通不阻塞 M1**」是**正确的** —— 本地 sqlite 基座已实际跑通建表与种子（这条已实测验证，见 §二）。

---

## 一、环境配置与运行时

| # | 检查项 | 实测结果 | 判定 |
| --- | --- | --- | --- |
| 1.1 | Node 运行时 | `v22.22.2`（满足 `engines: >=20`） | ✅ |
| 1.2 | pnpm 包管理器 | **实际 12.4.1**，但 `package.json` 声明 `packageManager: pnpm@9.0.0` | ⚠️ P2 |
| 1.3 | git 客户端 | `2.55.0.windows.3`，但**不在 PATH**，须用绝对路径 `…\PortableGit\versions\1.2.0\cmd\git.exe` | ⚠️ P2 |
| 1.4 | Docker | **未安装** → 本机无法跑 MySQL8 / Redis7 / MinIO | ⚠️ 已知（走 sqlite 模式） |
| 1.5 | `.env` 是否泄密入库 | 仅 `.env.example` ×3 入库；`.env` 已被 `.gitignore` 正确排除 | ✅ |
| 1.6 | 本地 `.env` 就位 | 存在于 `apps/api-server/.env`，内容为 `DB_DRIVER=sqlite / QUEUE_DRIVER=memory / STORAGE_DRIVER=local / PROVIDER_MODE=mock` | ✅ |
| 1.7 | **根目录 `.env`** | **不存在**（配置实际落在 `apps/api-server/.env`；因 `ConfigModule` 读取顺序为 `apps/api-server/.env → ../../.env`，故当前能生效，但新人极易困惑） | ⚠️ P2 |
| 1.8 | 端口 3000 | 无占用 | ✅ |
| 1.9 | 构建产物是否入库 | `dist/`、`node_modules/`、`data/` 均 **0 个被跟踪** | ✅ |

**根因说明（1.2 / 1.3 为什么是隐患）**：`packageManager` 声明 pnpm@9 而本机跑的是 pnpm@12，会导致**不同人执行 `pnpm install` 得到不同的依赖树**；好在实测 `pnpm install --frozen-lockfile` **通过**（`Lockfile is up to date`），所以风险被锁文件兜住了。git 不在 PATH 会让自动化的 `git` 调用随机失败 —— 建议在专家团的环境准备说明里显式写明绝对路径，或让其自装 Git for Windows。

---

## 二、代码基础

### 2.1 后端：**已实测跑通**（这部分可以放心）

| # | 检查项 | 实测命令 | 结果 | 判定 |
| --- | --- | --- | --- | --- |
| 2.1.1 | 类型检查 | `tsc --noEmit` | exit 0，0 错误 | ✅ |
| 2.1.2 | 生产构建 | `nest build` | exit 0，产出 `dist/main.js` | ✅ |
| 2.1.3 | 建表 + 种子 | `ts-node src/database/seeds/seed.ts` | exit 0；**连跑两次均成功（幂等）** | ✅ |
| 2.1.4 | 种子数据量 | — | 5 楼群 / 12 楼 / 5 团长 / 4 邀请关系 / 10 供应商 / 4 集散 / 12 菜 / 7 套餐 / 27 明细 / 23 配置 | ✅ |
| 2.1.5 | 服务启动 | `node dist/main.js` | 22 个模块全部初始化 | ✅ |
| 2.1.6 | 健康检查 | `GET /api/v1/health` | 200，统一响应体 `{code:0,…}` | ✅ |
| 2.1.7 | **Mock 登录闭环** | `POST /auth/login {"code":"dev:1001"}` | 200，JWT + `isLeader:true` + 李明（chief/12%/余额 `"575.86"`） | ✅ |
| 2.1.8 | 鉴权链路 | `GET /auth/me` + Bearer | 200，返回用户 + 团长详情 | ✅ |
| 2.1.9 | 接口文档 | `GET /docs` | 200 | ✅ |
| 2.1.10 | 结算校验式 | 种子输出 | **等式闭合**打印通过（`售价 ¥25.80 = 供价 14.00(示例) + 场地 0.00 + 打包人工 0.00 + 配送 0.00 + 佣金 3.10 + 毛利 8.70(结果值)` · C9 2026-09-15 修订：成本项可配置、毛利为结果值） | ✅ |

### 2.2 前端：**两个 app 均构建失败** ❌（P0-1 / P0-2）

| # | 检查项 | 实测命令 | 结果 | 判定 |
| --- | --- | --- | --- | --- |
| 2.2.1 | **admin-web 生产构建** | `vite build` | **exit 1**；`[vite:css] [sass] Undefined variable` → `$space-4` @ `src/views/meal/template.vue:3` | ❌ **P0** |
| 2.2.2 | **小程序生产构建** | `uni build -p mp-weixin` | **Build failed**；`[vite:css] Can't find stylesheet to import` → `./styles/tokens.scss` @ `src/pages/index/index.vue:5` | ❌ **P0** |
| 2.2.3 | 两前端 typecheck | `vue-tsc --noEmit` | **进程崩溃**：`Search string not found: "/supportedTSExtensions = .*(?=;)/"` | ❌ **P0-3** |

**根因（已定位到具体文件，非推测）**：

- **admin-web**：`vite.config.ts` **没有配置 SCSS 自动注入**，而 33 个视图的 `<style lang="scss" scoped>` 中直接使用 `$space-4` / `$c-text-weak` / `$fs-caption` 等 token 变量。scoped style 是独立编译单元，`styles/index.scss` 里的 `@use './tokens.scss'` 传递不到它们 → 变量未定义。
  > 注意这与《协作规范 v1.0》§7.3「设计 token 只写在 `styles/tokens.scss`，**禁止散落硬编码色值**」**直接冲突**：规范要求用变量，但基建没提供注入机制。脚手架生成了样式却从未真正构建过。
- **miniprogram**：`src/uni.scss` 里写的是 **相对路径** `@import './styles/tokens.scss';`。uni-app 会把 `uni.scss` **自动注入到每个组件**的 style 中，注入后该相对路径按**宿主文件**解析（`src/pages/index/styles/tokens.scss`）→ 找不到文件。
- **两前端共同点**：受影响文件 **36 个**（33 视图 + 2 布局 + index.scss）。
- **vue-tsc 崩溃**：`vue-tsc@1.8.27` 通过字符串匹配 patch TypeScript 内部实现，而 `typescript` 被 `^5.3.0` 解析到了 **5.9.3**，TS 5.5+ 改了 `supportedTSExtensions` 的写法 → vue-tsc 直接抛异常退出。

### 2.3 业务层实现度：**基本为空壳**（这是事实，必须让专家团知情）

| 层 | 实测数据 | 判定 |
| --- | --- | --- |
| 后端控制器 | 15 个中 **14 个业务控制器 `routes=0`**；只有 `auth`(2 路由) + `health`(1 路由) 有真实路由 | ❌ 骨架 |
| 后端服务 | 35 个 service 中 **33 个仅 2–6 行**；`auth.service.ts`(112 行) 是唯一实现 | ❌ 骨架 |
| 小程序 API 层 | 8 个文件 **各 2 行**（`export {};` 占位） | ❌ 骨架 |
| 小程序页面 | 22 个页面，**各 45–46 行**（空壳模板） | ❌ 骨架 |
| 后台视图 | 33 个视图，**各 19–20 行**（空壳模板） | ❌ 骨架 |

> **含义**：M1–M5 的业务代码 **100% 待写**。地基（配置层 / 公共层 / Provider + Mock / 24 实体 / 迁移 / 种子 / 登录 / CI 骨架 / 文档）是现成的，这是好消息；但"骨架已搭好"不等于"业务快写完了"，排期应按**从零写业务**来估。

---

## 三、依赖与构建可复现性

| # | 检查项 | 实测结果 | 判定 |
| --- | --- | --- | --- |
| 3.1 | 锁文件 | `pnpm-lock.yaml` 已入库，`lockfileVersion: '9.0'` | ✅ |
| 3.2 | **CI 首步可复现性** | `pnpm install --frozen-lockfile` → **exit 0**，`Lockfile is up to date, resolution step is skipped`（1m22s） | ✅ |
| 3.3 | 原生依赖 | `better-sqlite3` 的 `better_sqlite3.node`（1.72MB）已落地 | ✅ |
| 3.4 | 构建脚本白名单 | `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 列全 10 个实测包 | ✅ |
| 3.5 | uni-app 版本真实性 | `3.0.0-alpha-5020620260914001`（`vue3` dist-tag，真实存在） | ✅ |
| 3.6 | **vue-tsc ↔ TypeScript 兼容性** | `vue-tsc@1.8.27` + `typescript@5.9.3` → **崩溃** | ❌ **P0-3** |
| 3.7 | 工作区识别 | `Scope: all 8 workspace projects`（3 app + 4 package + 1 根） | ✅ |

---

## 四、文档资产与协作基建

### 4.1 文档：根目录齐全，**但仓库里没有**

| # | 检查项 | 实测结果 | 判定 |
| --- | --- | --- | --- |
| 4.1.1 | 根目录权威文档 | **23 份齐全**（交接包 v1.3 / PRD v2.1 / ER v2.1 / 接口规范 33KB / 状态机 17KB / 目录结构 v2.0 34KB / 协作规范 / 里程碑 M1–M5 / 冻结清单 / 账号资源清单 / 表结构评审 / 种子清单 / 合规清单 / M0 纪要 / 本地开发手册 v1.1 …） | ✅ |
| 4.1.2 | **仓库 `docs/` 内容** | **只有 1 个 1.9KB 的 README** —— `pnpm docs:sync` **从未执行** | ❌ **P1** |
| 4.1.3 | 文档冻结校验 | 冻结清单记录了文件名 + 字节数 + SHA-256（前 12 位）三重校验基准 | ✅ |
| 4.1.4 | **账号清单 `.env` 变量名** | 与代码**不一致**（见下表） | ❌ **P1** |
| 4.1.5 | 废弃文档隔离 | 5 份已废弃文档与现行文档**混放在同一目录**，仅靠文件名版本号区分 | ⚠️ P2 |

**4.1.4 变量名对照（专家团照文档填 `.env` 会踩空）**

| 文档《账号资源与密钥清单 v1.0》§七 写的 | 代码实际读取的（`config/wechat.config.ts` 等） |
| --- | --- |
| `DB_NAME` | `DB_DATABASE` |
| `PORT` | `APP_PORT` |
| `WX_APPID` | `WX_MINI_APPID` |
| `WX_SECRET` | `WX_MINI_SECRET` |
| `WXPAY_MCHID` | `WXPAY_MCH_ID` |
| `WX_SUBSCRIBE_TEMPLATE_*` | `WX_TPL_*` |
| `FLEX_PLATFORM_SECRET` | `FLEX_PLATFORM_APP_SECRET` |

> **影响**：本地 mock 模式不受影响（这些值本就可留空）；**一旦切到 `PROVIDER_MODE=real`，登录/支付会因密钥读不到而静默失败**，排查成本高。

### 4.2 协作基建：**CI 实测 3 红 1 假绿**

| # | 检查项 | 实测结果 | 判定 |
| --- | --- | --- | --- |
| 4.2.1 | CI 工作流 | `.github/workflows/ci.yml` 存在，含 lint / typecheck / test / build **四作业** | ✅ |
| 4.2.2 | PR / Issue 模板 | `pull_request_template.md` + `bug_report.md` + `feature_request.md` | ✅ |
| 4.2.3 | commitlint 配置 | `commitlint.config.cjs` 存在（Conventional Commits，header ≤ 100） | ✅ |
| 4.2.4 | lint-staged 配置 | `lint-staged.config.cjs` 存在 | ✅ |
| 4.2.5 | **husky 接线** | **`.husky/` 目录不存在，`package.json` 也没有 `prepare` 脚本** → commitlint / lint-staged **永远不会触发** | ❌ **P1** |
| 4.2.6 | **git 远端** | **无任何 remote** —— 纯本地裸库，**无法多人协作、无法开 PR** | ❌ **P1** |
| 4.2.7 | 单元测试 | `jest --listTests` 返回**空**；`jest` 输出 `No tests found, exiting with code 0`（因 `--passWithNoTests`） | ❌ **P1** |

**CI 四作业实测预判（这是本报告最关键的一张表）**

| 作业 | CI 命令 | 实测预判 | 证据 |
| --- | --- | --- | --- |
| `lint` | `pnpm lint` | ❌ **红** | 实测 exit 1：`seed.ts` 有 10 个 `no-unused-vars` 警告，`--max-warnings 0` 判失败 |
| `typecheck` | `pnpm typecheck` | ❌ **红** | `vue-tsc` 崩溃（TS 版本不兼容） |
| `test` | `pnpm test` | ⚠️ **假绿** | 收集到 **0 个测试**，`exit 0` —— 看着通过，实际零覆盖 |
| `build` | `pnpm build:api && pnpm build:admin` | ❌ **红** | `build:admin` 实测 exit 1（sass 变量未定义） |

> ⚠️ **连锁后果**：《协作规范 v1.0》§4.1 规定「CI 四个作业**全绿**方可合并」，§8.2 把四作业列为质量门禁。**当前状态下，专家团提交的任何一个 PR 都不可能通过 CI** → 门禁直接把所有协作卡死，且团队会很快学会"忽略 CI 红灯"，规范随之失效。

### 4.3 测试资产的真实处境

| # | 检查项 | 实测结果 |
| --- | --- | --- |
| 4.3.1 | 唯一业务单测 | `apps/api-server/test/unit/order-state-machine.spec.ts`（1546 字节）**存在** |
| 4.3.2 | 它会被执行吗？ | **不会**。jest 配置 `rootDir: "src"` + `testRegex: ".*\\.spec\\.ts$"`，而该文件在 `src/` **之外** |
| 4.3.3 | `src/` 下的 spec 数 | **0** |
| 4.3.4 | e2e 配置 | `test/jest-e2e.json` 的 `rootDir: "."` 是对的，但 `test:e2e` **不在 CI 四作业里**，永远不会被执行 |

---

## 五、隐患清单与处理建议（按优先级）

### 🔴 P0 · 阻塞明天开工（建议今天修完，预计 40 分钟）

| ID | 隐患 | 证据 | 影响 | 修复方案 |
| --- | --- | --- | --- | --- |
| **P0-1** | admin-web 构建失败（SCSS token 未注入） | `vite build` exit 1 | CI build 红；后台无法打包部署 | 在 `apps/admin-web/vite.config.ts` 增加：<br>`css: { preprocessorOptions: { scss: { additionalData: \`@use "@/styles/tokens.scss" as *;\` } } }` |
| **P0-2** | 小程序构建失败（`uni.scss` 相对路径） | `uni build` Build failed | CI 无法验证小程序；真机调试前必踩 | 把 `apps/miniprogram/src/uni.scss` 的 `@import './styles/tokens.scss';` 改为 `@import '@/styles/tokens.scss';` |
| **P0-3** | `vue-tsc@1.8.27` 与 `typescript@5.9.3` 不兼容 → typecheck 崩溃 | 直接抛异常退出 | 两个前端**无法做类型检查**；CI typecheck 红 | 二选一：① 把 `typescript` 锁到 `~5.4.5`（最小改动，vue-tsc 1.x 兼容）；② 升 `vue-tsc` 到 `^2.x`。改后需重跑 `pnpm install` 让 lockfile 同步 |

> **P0 的处理顺序建议**：P0-3（依赖，需重装，耗时最长）→ P0-1 → P0-2。三项修完后建议立刻复跑 `pnpm lint / typecheck / build`，确认 CI 由红转绿。

### 🟠 P1 · 影响协作质量与效率（建议本周内、专家团进场首日处理）

| ID | 隐患 | 证据 | 影响 | 修复方案 |
| --- | --- | --- | --- | --- |
| **P1-1** | **git 无远端** | `git remote -v` 为空 | **专家团无法拉代码、无法开 PR、无法并行开发**；协作完全无法启动 | 你需先决定托管平台（GitHub / GitLab / CNB / 内网 Gitea），建空仓库后 `git remote add origin … && git push -u origin main --tags` |
| **P1-2** | **`docs/` 未入仓** | 仓库 `docs/` 仅 1 个 1.9KB README | 专家团拿到仓库后**看不到交接包/PRD/ER/接口规范/状态机**，等于闭眼开发 | 执行 `pnpm docs:sync`（会把根目录 23 份文档复制进 `docs/`）后提交 |
| **P1-3** | **jest 0 测试（假绿）** | `No tests found, exiting with code 0` | 唯一的状态机单测从未运行；团队误以为有测试保护 | 把 `apps/api-server/package.json` 的 jest `rootDir` 从 `"src"` 改为 `"."`，并同步修正 `moduleNameMapper` 与 `collectCoverageFrom` 相对路径 |
| **P1-4** | **husky 未接线** | 无 `.husky/`、无 `prepare` 脚本 | commitlint / lint-staged 形同虚设，提交规范靠自觉 | `pnpm add -D husky && npx husky init`，添加 `commit-msg`（commitlint）与 `pre-commit`（lint-staged）钩子；`package.json` 补 `"prepare": "husky"` |
| **P1-5** | **账号清单 `.env` 变量名与代码不符** | 7 处不一致（§4.1.4 表） | 切云时 real 模式静默失败，排查成本高 | 以代码为准回改《账号资源与密钥清单 v1.0》§七；或反向统一（需先裁决以谁为准） |
| **P1-6** | **`pnpm lint` 本就失败** | 实测 exit 1，10 warnings | CI lint 红 | 清理 `seed.ts` 中 10 个未使用的实体 import（`Commission` / `Balance` / `BalanceLog` / `SupplierShare` / `DeliveryRecord` / `Order` / `PaymentLog` / `Refund` / `Message` / `OperationLog`）；建议保留 `--max-warnings 0` 的严格口径 |

### 🟡 P2 · 改进项（可在 M1 期间择机处理）

| ID | 隐患 | 建议 |
| --- | --- | --- |
| P2-1 | `packageManager: pnpm@9.0.0` vs 实际 12.4.1 | 统一版本声明；或在 README 显式写明「本机以 corepack 自动拉取」 |
| P2-2 | 根目录无 `.env`（配置藏在 `apps/api-server/.env`） | 在本地开发手册中明确「配置放哪」；或统一约定根目录 `.env` |
| P2-3 | 文档滞后：M0 清单第 6 项仍写「云资源**阻塞 M1 建表**」 | **该结论已被证伪**（sqlite 本地建表已跑通）→ 建议更新为「云资源阻塞**部署**，不阻塞**开发**」 |
| P2-4 | 5 份已废弃文档与现行文档混放 | 移入 `archive/` 子目录，避免专家团误读 |
| P2-5 | 小程序缺 `.env.example` | 补一份（至少含 `VITE_API_BASE_URL`），与后台对齐 |
| P2-6 | CI 的 `format` 作业跑 `prettier --write`（写文件而非校验） | 改为 `prettier --check`，否则该作业无法真正拦截格式问题 |
| P2-7 | `test:e2e` 不在 CI 里 | 视需要加入 CI 或明确标注「本地手动跑」 |
| P2-8 | Sass `@import` 大面积弃用警告（Dart Sass 3.0 将移除） | M1 期间择机迁移到 `@use`，避免未来升级踩雷 |

---

## 六、明天开工前的行动清单（可直接照做）

**第一步 · 修 P0（约 40 分钟，其中依赖重装约 2 分钟）**

```powershell
# 1) P0-3 依赖版本：把 apps/api-server|admin-web|miniprogram 的 typescript 锁到 ~5.4.5
#    或升 vue-tsc 到 ^2.x，然后：
pnpm install                       # 同步 lockfile
pnpm --filter admin-web typecheck  # 应 exit 0
pnpm --filter miniprogram typecheck

# 2) P0-1 admin-web：在 vite.config.ts 加 scss additionalData（见 §五 P0-1）
pnpm build:admin                   # 应 exit 0，产出 dist/

# 3) P0-2 小程序：uni.scss 改 @/styles/tokens.scss
pnpm build:mp                      # 应 Build success
```

**第二步 · 修 P1（约 40 分钟）**

```powershell
# 4) P1-6 清理 seed.ts 未使用 import
pnpm lint                          # 应 exit 0

# 5) P1-3 jest rootDir 改 "."，让 test/unit/ 的单测真正跑起来
pnpm test                          # 应看到 order-state-machine.spec.ts 执行

# 6) P1-2 文档入仓
pnpm docs:sync                     # 23 份文档进 docs/
git add -A; git commit -m "docs: 同步权威文档入仓"

# 7) P1-4 husky 接线
pnpm add -D husky; npx husky init  # 配 commit-msg + pre-commit 钩子
```

**第三步 · 你需要决策的两件事**

| # | 事项 | 为什么需要你 |
| --- | --- | --- |
| A | **代码托管平台选型**（GitHub / GitLab / CNB / 内网） | 无远端 = 协作无法启动，这是**明天开工的硬前提**，我无法替你决定平台 |
| B | **P1-5 变量名以谁为准** | 涉及"文档 vs 代码"的单一事实来源裁决（协作规范 P4） |

**第四步 · 专家团进场材料包（建议准备）**

1. `abox-onebox` 仓库访问权限（对应第三步 A）
2. 《ABox一盒协作规范v1.0.md》（分支/提交/评审/DoD，**必读**）
3. 《ABox一盒开发里程碑计划v1.0.md》§一 M1 任务分解（**12 项任务已拆到条**，可直接派单）
4. 《ABox一盒本地开发手册v1.0.md》（含零依赖模式启动方式）
5. 《ABox一盒接口规范v1.0.md》+《ER v2.1》+《状态机 v1.0》（写代码时的唯一依据）

---

## 七、附：本次审计的实测证据索引

| 证据 | 命令 / 路径 | 关键输出 |
| --- | --- | --- |
| 后端类型检查 | `tsc --noEmit -p apps/api-server/tsconfig.json` | exit 0 |
| 后端构建 | `nest build` | exit 0，`dist/main.js` |
| 种子幂等 | `ts-node src/database/seeds/seed.ts` ×2 | exit 0 ×2 |
| Mock 登录 | `POST /api/v1/auth/login {"code":"dev:1001"}` | JWT + 李明 + 余额 `"575.86"` |
| **admin 构建失败** | `vite build`（apps/admin-web） | exit 1，`Undefined variable $space-4` |
| **小程序构建失败** | `uni build -p mp-weixin` | `Can't find stylesheet to import` |
| **vue-tsc 崩溃** | `vue-tsc --noEmit` | `Search string not found: supportedTSExtensions` |
| **lint 失败** | `eslint . --ext .ts,.vue --max-warnings 0` | exit 1，10 warnings |
| **jest 空跑** | `jest --listTests` / `jest` | 0 tests，`exiting with code 0` |
| 依赖可复现 | `pnpm install --frozen-lockfile` | exit 0，`Lockfile is up to date` |
| 路由实现度 | 正则统计 `@(Get\|Post\|Put\|Delete)(` | 14 个业务控制器 = 0 |
| 文档入仓状态 | `ls docs/` | 仅 1 个 README |

---

*报告结束 · ABox 一盒 · 专家团进场就绪度审计报告 v1.0 · 2026-09-14*

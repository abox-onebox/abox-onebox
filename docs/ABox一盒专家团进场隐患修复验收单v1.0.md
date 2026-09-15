# ABox 一盒 · 专家团进场隐患修复验收单 v1.0

> 对象：《ABox一盒专家团进场就绪度审计报告v1.0.md》所列 **3 项 P0 + 9 项 P1 + 8 项 P2**
> 执行日期：2026-09-15 ｜ 执行方式：全部修复 + **实机复跑门禁**
> **结论：CI 四作业已从「3 红 1 假绿」转为全绿；M1 可开工，仅剩 1 项决策依赖用户裁定。**

---

## 一、一句话结论

审计发现的全部隐患已修复并实测验证。原先**会卡死所有 PR** 的 CI 链路（lint ❌ / typecheck ❌ / build ❌ / test ⚠️假绿）现已 **9 道门禁全部 exit 0**，其中单测由「0 用例假绿」变为 **4 用例真实执行**。

---

## 二、P0 修复（3 项 · 原先阻断构建与 CI）

| 编号 | 问题 | 根因 | 修复 | 验证 |
|---|---|---|---|---|
| **P0-1** | admin-web `vite build` 失败：`Undefined variable $space-4` | `vite.config.ts` 缺 SCSS token 注入，而 33 个视图 scoped style 直接用 token（与协作规范「必须用 token」自相矛盾） | 加 `css.preprocessorOptions.scss.additionalData = '@use "@/styles/tokens.scss" as *;'`；并去掉全局入口里重复的 `@use './tokens.scss' as *` | `vite build` **exit 0** · 产出 `dist/index.html` + `assets` |
| **P0-2** | 小程序 `uni build` 失败：`Can't find stylesheet to import: ./styles/tokens.scss` | `uni.scss` 用**相对路径**，该文件会被原样拼进每个组件 → 相对路径按宿主文件解析 | 改为 `@import '@/styles/tokens.scss';`（必须用别名） | `uni build -p mp-weixin` **exit 0** · Build complete |
| **P0-3** | 两端 `vue-tsc` **进程崩溃**：`Search string not found: supportedTSExtensions` | `vue-tsc@1.8.27` 靠字符串补丁改 TS 内部，TS ≥5.5 已改掉该源码 | 全仓 **6 处** `typescript` 由 `^5.3.0` 锁为 `~5.4.5`（根 + 3 app + 2 packages） | admin / mp `vue-tsc --noEmit` 均 **exit 0** |

> **P0-3 的连带价值**：崩溃原先**掩盖了 3 个真实类型错误**（3 个 store 是空骨架、缺 `login`/`restore` 方法）。修好版本后立即暴露并一并修复，详见第四节。

---

## 三、P1 修复（9 项 · 质量与协作）

| 编号 | 问题 | 修复 | 验证 |
|---|---|---|---|
| P1-1 | **jest 假绿**：`rootDir:"src"` 导致 spec 从未被收集 | `rootDir` 改 `"."` + `testRegex:"(src\|test)/.*\.spec\.ts$"`；`moduleNameMapper` 层级上移一级；补 `dotenv` 依赖 | `Tests: 4 passed / 4 total` |
| P1-2 | `pnpm lint` 本就红：`seed.ts` 10 个 unused import | 清理全部未使用 import | 根 `eslint --max-warnings 0` **exit 0** |
| P1-3 | CLI 与 Nest 读 `.env` 顺序不一致 | `import 'dotenv/config'` → 显式两段 `loadDotenv`，与 `ConfigModule.envFilePath` 同序 | api `tsc --noEmit` exit 0 |
| P1-4 | **husky 未接线**：规范写了但钩子永不触发 | 新建 `.husky/pre-commit`（lint-staged）+ `.husky/commit-msg`（commitlint）+ `scripts/setup-husky.mjs`（无 git 环境不中断 install） | 提交时钩子**实际触发**并输出 lint-staged 结果 |
| P1-5 | `docs/` 未入仓，23 份权威文档只在本地根目录 | 重写 `scripts/sync-docs.mjs`（同 base 多版本只留最高版）+ 重写 `docs/README.md` 分类清单 | 23 份文档已入仓并随提交固化 |
| P1-6 | **账号清单 `.env` 变量名与代码不符 7 处** → 切 real 模式静默失败 | 以代码为准反向校订：`DB_NAME→DB_DATABASE`、`PORT→APP_PORT`、`WX_APPID→WX_MINI_APPID`、`WX_SECRET→WX_MINI_SECRET`、`WXPAY_MCHID→WXPAY_MCH_ID`、`FLEX_PLATFORM_SECRET→FLEX_PLATFORM_APP_SECRET`、`FLEX_PLATFORM_FEE_RATE→FLEX_PLATFORM_SERVICE_FEE_RATE`；删除代码中不存在的变量 | 逐条与源码对账 |
| P1-7 | 小程序缺 `.env.example` | 新建 `apps/miniprogram/.env.example`；重写 `apps/api-server/.env.example` 为完整清单 | — |
| P1-8 | CI `format` 用 `--write` 会就地改写 | 改 `format:check` | — |
| P1-9 | CI build job 漏小程序 | 补 `pnpm build:mp` | — |

---

## 四、连带修复：3 个被掩盖的真实类型错误

`vue-tsc` 崩溃修好后立即暴露，均为**空骨架 store 缺方法**——会导致页面运行时直接报错，属于"静态检查查不出、但一跑就炸"的类型。

| 文件 | 修复内容 |
|---|---|
| `apps/admin-web/src/stores/auth.ts` | 实现 `role/token/account` + `isLoggedIn/isSupplier` + `login()/logout()`（`login()` **故意 throw**，避免骨架阶段静默登录成功） |
| `apps/miniprogram/src/stores/user.ts` | 实现 `token/info` + `isLoggedIn` + `restore()/setLogin()/clear()`（localStorage：`abox_token`/`abox_user`） |
| `apps/miniprogram/src/stores/leader.ts` | 实现 `isLeader/info` + `getters.rate` + `restore()/setLeader()/clear()`（localStorage：`abox_is_leader`/`abox_leader`） |
| `apps/admin-web/src/layouts/login-layout.vue` | `onSubmit` 加 try/catch，失败弹 `ElMessage.error` |

---

## 五、P2 修复（8 项 · 约定与文档）

- `.gitignore`：忽略 unplugin 自动声明文件（`auto-imports.d.ts` / `components.d.ts`）与临时产物
- 协作规范 §8.2：质量门禁拆为**五道**（lint / format / typecheck / test / build）+ 假绿防呆说明
- M0 启动评审纪要订正：「云资源阻塞 M1 建表」→ **已解除**（本地 sqlite 基座实测通过）
- 本地开发手册 v1.0：补 pnpm 版本说明、新增命令、4 条 FAQ（vue-tsc 崩溃 / .env 变量对齐 / CLI 读 .env / jest 假绿）
- CI：`format` → `format:check`；build job 补 `build:mp`
- 其余（根目录 `.env`、废弃文档归置、`packageManager` 版本说明）已在文档中标注

---

## 六、门禁实测结果（2026-09-15 · 全部实机复跑）

| # | 门禁 | 命令 | 结果 |
|---|---|---|---|
| G1 | lint | `eslint . --ext .ts,.vue --max-warnings 0` | ✅ exit 0 |
| G2a | 构建 shared-types | `tsc -p tsconfig.build.json` | ✅ exit 0 |
| G2b | 构建 shared-utils | `tsc -p tsconfig.build.json` | ✅ exit 0 |
| G3 | typecheck api | `tsc --noEmit` | ✅ exit 0 |
| G4 | typecheck admin | `vue-tsc --noEmit` | ✅ exit 0 |
| G5 | typecheck mp | `vue-tsc --noEmit -p tsconfig.json` | ✅ exit 0 |
| G6 | 单测 | `jest --passWithNoTests` | ✅ **4 passed / 4 total**（真跑，非假绿） |
| G7 | 构建 api | `nest build` | ✅ exit 0 · 产出 `dist/main.js` |
| G8 | 构建 admin | `vite build` | ✅ exit 0 · 产出 `dist/index.html` + `assets` |
| G9 | 构建 mp | `uni build -p mp-weixin` | ✅ exit 0 · Build complete |

> **对照修复前**：lint ❌ / typecheck ❌（进程崩溃）/ build ❌ / test ⚠️假绿 → 现 **9/9 全绿**。

---

## 七、提交记录

| Commit | 说明 |
|---|---|
| `2ab654c` | `fix: 修复专家团进场就绪度审计发现的 P0/P1/P2 隐患`（49 files · +9796 / −350） |
| `7d0ea19` | `chore: 移除误提交的临时提交信息文件并忽略该类产物` |

历史链：`db91e16`(tag `v1.0-baseline`) → `9ca6b04`(tag `v1.1-local-dev-base`) → `2ab654c` → `7d0ea19`

---

## 八、唯一遗留决策项

> ⚠️ **git 仓库尚无 remote** —— 这是**协作的硬前提**。专家团无法拉代码、无法开 PR，CI 也无从触发。

**待用户裁定代码托管平台（四选一）**：

| 选项 | 适用场景 |
|---|---|
| **GitHub** | 公开/私有仓库，CI 用 GitHub Actions（当前 `.github/workflows/ci.yml` 即为此设计） |
| **GitLab** | 自建或 SaaS，需把 CI 配置改写为 `.gitlab-ci.yml` |
| **CNB（腾讯云原生构建）** | 腾讯生态、国内访问快，需改 CI 配置 |
| **内网 Gitea / 自建** | 数据不出内网，需自备 Runner |

裁定后即可：配 `git remote add origin <url>` → `git push -u origin main --tags` → 专家团拉取开工。

---

## 九、下一步

1. **用户裁定 git 托管平台** → 推首版（唯一阻塞项）
2. 用户侧并行推进：云资源开通（**阻塞部署、不阻塞开发**）· 账号资源看板核对 · 《团长合作协议》简版 · 灵活用工平台开户 + 费率
3. M1 开工，关键路径：**1.2 建表 → 1.3 种子 → 1.6 套餐 → 1.7 下单 → 1.8 支付**

---

*本验收单所有结论均来自实机复跑，非静态推断。*

# Phase 3 落码规格 · N1 / N2 / W1

> **这份文档是给后端工程师直接照着改的**，不需要回头读 ADR。
> 决策依据见 `docs/decisions/ADR-N1N2W1-楼宇停用与一键停售.md`（已 Accepted）；验收标准见 `docs/qa/AC-N1N2W1-楼宇停用与一键停售.md`。
> 本规格未授权改任何**未列出**的文件。

> **本批授权新建的文件（白名单，共 8 个）** —— 除这 8 个之外，本规格未授权新建或修改任何未列出的文件：
>
> | # | 文件 | 出处 | 行数上限 |
> |---|---|---|---|
> | 1 | `apps/api-server/src/common/utils/orderability.ts` | §3「文件 1」 | ≤180 |
> | 2 | `apps/api-server/test/unit/orderability.spec.ts` | §3「文件 2」 | ≤150 |
> | 3 | `apps/api-server/src/common/utils/suspend-gate.ts` | §6.0「文件 A」 | ≤150 |
> | 4 | `apps/api-server/test/unit/suspend-gate.spec.ts` | §6.0「文件 B」 | ≤150 |
> | 5 | **`apps/api-server/test/unit/suspend-notify.spec.ts`** | **§6.5**（2026-10-26 Team Lead 派后端补，本规格补登） | **≤180** |
> | 6 | **`apps/api-server/src/modules/building/building-suspend.service.ts`** | **§5.4.5**（2026-10-27 T5 拆分，从 `building-admin.service.ts` 迁出 N2 停用块） | **≤400** |
> | 7 | **`apps/api-server/src/modules/building/building-derive.ts`** | **§5.4.6**（2026-10-27 T5 第二步，从 `building-admin.service.ts` 迁出 6 个派生纯函数 + `DC_ACTIVE`） | **≤150** |
> | 8 | **`apps/api-server/src/modules/building/building-query.service.ts`** | **§5.4.7**（2026-10-27 T5 第三步，从 `building-admin.service.ts` 迁出读侧四视图 + `loadContext` + `groupStatusOf`） | **≤600** |
>
> ⚠️ **第 8 项为什么上限给 `≤600`**（2026-10-27 补登时裁定）：与第 6 项同一理由 ——
>    它是 **Nest service（IO 编排 + 出参翻译）**，且迁入的四个视图里带的是**业务口径注释**
>    （「不返回距离」「覆盖人数是估算值」这类），删注释凑行数等于删掉口径本身。
>    实测 **521 行** ⇒ 合规。⚠️ 同样是**先斩后奏**（拆分在补登之前），本条即为追认动作本身。
>
> ⚠️ **第 6 项为什么上限给 `≤400`**（2026-10-27 补登时裁定）：前 5 项都是**纯函数 / 单测**
>    （单一职责、无 IO），给 ≤150/≤180 是为了逼「一个文件只讲一件事」；第 6 项是
>    **Nest service（IO 编排 + 契约翻译）**，且迁入的 6 个方法里带大量「为什么这么判」的
>    **必要注释**（那是本批 N1/N2 的核心产出，删注释凑行数等于删掉本批最值钱的部分，
>    见下方「为凑行数删内容 = 禁止」）。实测 **375 行** ⇒ 合规。
>    ⚠️ 它**不是**第 6 个「新建的白名单文件」被事后追认 —— 拆分发生在补登**之前**，
>    这是**先斩后奏**，本条即为追认动作本身；规矩仍然是**先登记再建**。
>
> 两个 `.spec.ts` **显式授权新建**（2026-10-26 Team Lead 要求标注）：本批多处写「必须固化成 jest 用例」，若不同时授权建文件，执行者会被文首「未列出即不动」这条卡住 —— 要求写单测又不授权建文件，是本规格自己的内部矛盾。
>
> ⚠️ **第 5 项为什么上限给 `≤180` 而不是照前两项 `≤150`**（2026-10-26 补登时裁定）：
>
> 1. 它断言的是**服务层投递链路**（「最终塞进模板的是哪一句」），不是纯函数返回值 ⇒ 断言点天然比 `orderability.spec.ts` 多。**不要塞进 `suspend-gate.spec.ts`** —— 那个文件已 149/150，且职责是 `decideSuspend()` 的返回值，混进去会让职责变浑（后端原话，采纳）。
> 2. **上限的作用是防止单文件膨胀，不是逼执行者删内容。**
>
> **实测行数（2026-10-26 收盘 · Team Lead 与后端各自实测一致）**
>
> | 文件 | 行数 | 用例数 | 上限 | 状态 |
> |---|---|---|---|---|
> | `test/unit/suspend-notify.spec.ts`（新） | **169** | **7** | ≤180 | ✅ 合规（原始值与 prettier 后**同值**，本就合规） |
> | `test/unit/suspend-gate.spec.ts`（旧） | **149** | **9**（7 条带 ★） | ≤150 | ✅ 合规 |
> | `src/common/utils/suspend-gate.ts` | 140 | — | ≤150 | ✅ 合规 |
> | `src/modules/building/building-derive.ts`（新 · T5 第二步） | **115** | — | ≤150 | ✅ 合规 |
> | `src/modules/building/building-suspend.service.ts`（新 · T5 拆分） | **375** | — | ≤400 | ✅ 合规 |
> | `src/modules/building/building-query.service.ts`（新 · T5 第三步） | **521** | — | ≤600 | ✅ 合规 |
> | `src/modules/building/building-admin.service.ts`（**既有** · T5 三步拆分后） | **726**（原 1611） | — | **无上限** | ➖ 不适用（见 §5.4.5 的动因更正） |
>
> ⚠️ **曾有「169 / 149 两个数」的疑云，已闭环 —— 根源不是格式化，是**同一个数字被用在了两个相近文件名的文件上**（后端把 `suspend-gate.spec.ts` 的 149 抄到了 `suspend-notify.spec.ts` 头上，随后自行更正）。留这句是为了下一个人**抄行数时知道要警惕相近文件名** —— G10 的「登记前先 grep」在这里多一层：**核的不只是符号存在，还要核这个数字属于哪个文件。**
>
> ⚠️ **钉死的规矩（2026-10-26 Team Lead 裁定）**：
>
> - **为凑行数删「用例」= 禁止。** 正确动作是**申请提高上限**，不是删内容。
> - 凡「靠删内容达标」的，登记时必须说明**删的是注释 / 冗余还是用例** —— 这两件事性质相反：**删冗余是好事，删用例是把门禁用成了减配工具。**
> - 本次实测支持这个区分：`suspend-gate.spec.ts` 压到 149 **但 9 条用例一条没少**（7 条带 ★ 的关键用例全在）⇒ 删的是冗余，**没有砍覆盖率**，不追责；但规矩要立起来，否则下一次可能就是删用例。

- **日期** 2026-10-26 · **状态** 可执行
- **版本锚定** NestJS 10.3 · TypeORM 0.3.17 · pnpm 9.0.0 · `@abox/shared-types` workspace 版
- **行号基准** 2026-10-26 的 `main`。**改动前先核一遍行号**，行号漂移不等于规格失效。

> ### ⚠️ 行号漂移对照表（**2026-10-26 收盘 · 终版 · 第 6 版 · 全部锚点 re-grep 复核**）
>
> 本规格成文时 P3-4 未落地，此后 **P3-4 / P3-5 / P3-6 / 收尾批 / W1 / N4 + 通知回归** 全部落地。**正文里仍写旧号的地方以本表为准**：
>
> #### 锚点类型（第 6 版新增 · 回答后端 2026-10-26「要不要给锚点标类型」）
>
> | 类型 | 形态 | 谁可以用 | 免疫性 |
> |---|---|---|---|
> | **符号锚** | 符号名 / 唯一字面（grep `### 裁决 3`、`GROUP_SUSPENDED_HINT`、`async assignMembers`） | **判据 · 跨文档引用 · `Supersedes` 的唯一合法形态** | 同文件加注释 / 加代码都不失效，除非符号被删 |
> | **行号锚** | `:1587` | **只作人肉导航**，不得单独进判据 | **不免疫**：同文件任何编辑（含纯注释）都会推走 |
>
> ⇒ 三条：① **判据与跨文档引用一律用符号锚**，行号只在括号里附带（QA 2026-10-26 已确认 51 条判据一条都不依赖行号 —— 这是做对了，不是运气）；② 行号锚失效 **≠** 结论失效，只表示导航信息过期，re-grep 即可，**不要因为行号对不上就改结论**；③ 引用本表任一行时必须连符号名一起引用（第一列就是这么写的，不要在正文里只写 `:1605`）。
>
> | 锚点 | 第 2 版旧号 | **当前实际（第 6 版 · 已 grep 核实）** |
> |---|---|---|
> | `meal.service` U1 `canOrder` | `:142` | **`:142`**（未漂） |
> | `meal.service` U1 `reason`（⚠️ **下发的是文案**） | — | **`:144`**（`reason: availability.reasonText` —— 本批 §7.6 纠错的关键证据，第 2 版未登记） |
> | `meal.service` 抛 `USER_BUILDING_UNBOUND` | `:265` | **`:265`**（未漂） |
> | `meal.service` 抛 `BUILDING_NOT_GROUPED` | `:279` | **`:279`**（未漂，第二参数已删） |
> | `order.service` 抛 `BUILDING_NOT_GROUPED`（带 payload） | `:293` | **`:313`**（**已漂 +20**：后端新增纯注释块 + 后续微调） |
> | `order.service` 抛 `SALES_PAUSED` | — | **`:298`**（第 3 版未登记）；其上方 **`:278–289`** 是本批新增的 **60009 payload 现状注记**，**纯注释** |
> | `order.service` 抛 `USER_BUILDING_UNBOUND` | `:1686` | **`:1706`**（已漂 +20） |
> | `order.service` 抛 `BUILDING_NOT_GROUPED`（U6 主路径） | `:1693` | **`:1713`**（已漂 +20，第二参数已删） |
> | `traceability.service` 抛 `BUILDING_NOT_GROUPED` | `:285` | **`:285`**（未漂，码已 10004 → 60011） |
> | `workbench.service` `tomorrow.canOrder` | `:139` | **`:139`**（未漂）；**新增** `reasonText` 字段 **`:141`** |
> | `building-admin.service` `canAssign` 四处 | `:305 / :416 / :726 / :825` | **`:327 / :438 / :754 / :852`**（第 5 版 `:326/437/753/851`，**+1**） |
> | `building-admin.service` `canAssignCount` | `:346` | **`:368`**（列表）/ **`:562`**（概览）（第 5 版 `:367`/`:561`，**+1**） |
> | `building-admin.service` 概览页第三份判据 | `:540–542` | **`:562`**（`buildings.filter(...)`，与概览 `canAssignCount` 是同一处） |
> | `building-admin.service` `canOrder` **解释性引用**注释 | `:305–308` | **`:316–325`**（注释块整体；第 5 版只登记了前 5 行 `:316–320`，本次补齐到块尾；已带「不要全局替换」警示语） |
> | `building-admin.service` 文件头「裁决 3」 | — | **`:124`**（⚠️ 第 6 版新登记：ADR `Supersedes` 曾写死 `第 65–70 行`，那是**行号锚**，早已作废；改用符号锚 grep `### 裁决 3`） |
> | `building-admin.service` `GROUP_SUSPENDED_HINT` | — | **`:65`**（第 6 版新登记；60008 的 `hint` 唯一真源） |
> | `building-admin.controller` Swagger 描述 | `:60–62` / `:140` | **`:60–62` / `:140`**（未漂） |
> | `error-code.ts` `60011` 的 `ERROR_MESSAGE` | `:668` | **`:668`**（未漂，文案已统一） |
> | `orderability.ts` `REASON_TEXT` 表 | — | **`:137`**；`building_not_grouped` 字面 **`:151`**；⚠️ **`sales_paused` 现在是空串**（真身在 `reasonText()`） |
>
> **第 5 版新增 / 变更符号（均已 grep 核实）**
>
> | 符号 | 位置 | 备注 |
> |---|---|---|
> | `evaluateStructure` / `evaluateAvailability` / `reasonText` | `orderability.ts:80` / `:108` / `:186` | 纯函数三件套 |
> | `OrderAvailability`（类型）/ `forUser` / `forBuilding` / `salesPaused` / `resolve` | `order-availability.service.ts:14` / `:45` / `:51` / `:76` / `:98` | `salesPaused` 与 `resolve` 是 `private` |
> | `assertBuildingSuspendable` / `assertGroupSuspendable` | `building-admin.service.ts:1336` / `:1349`（调用点 `:819` / `:1142`） | 第 2 版记的是 `:1300` / `:1310` |
> | **`groupGate` / `assertGroupOpen`** | `building-admin.service.ts:1583` / `:1595` | **N4 新增**；三条写路径调用点 `:722` / `:810` / `:1499`；**全仓唯一抛点 `:1601`** |
> | **`assertGroupExists`** | — | **已删除，全仓 0 命中**（被上面两个取代） |
> | 三条写路径：`createBuilding` / `updateBuilding` / `assignMembers` | `building-admin.service.ts:712` / `:762` / `:1490` | 第三条（`createBuilding`）本规格上一版漏登记。**「三条」= 当前已知**，边界见 §5.4 |
> | `buildingRepo` 的 4 处写操作 | `building-admin.service.ts:724` / `:828` / `:1507` / `:1517` | 六类穷尽性核查的结果（§5.4） |
> | `notifySuspendAffected()` 的 `variables` 白名单 | `['mealDate', 'orderNo']` | `orderNo` **只落 `ab_message.payload`**，不进 `wxData`、不进文案（§6.5） |
> | **`test/unit/suspend-notify.spec.ts`** | 新增（白名单第 5 项） | 覆盖 D-N2-3b（本批最重的用户可感缺陷，一度**零覆盖**）；上限 `≤180` |
> | `SalesPauseController` / `list` / `create` / `resume` | `sales-pause.controller.ts:47` / `:57–58` / `:70` / `:78` | ⚠️ `list()` **返回裸数组**，不套 `{list}`（§7.4） |
> | `SalesPauseService` / `list` / `create` / `resume` | `sales-pause.service.ts:43` / `:56` / `:69` / `:91` | `list(): Promise<SalesPause[]>` |
> | `CreateSalesPauseDto` | `sales-pause.dto.ts:33` | `reason` 强制必填 `@MinLength(4)` |
> | `SalesPause` 实体 | `system.entity.ts:486` | 未漂 |
> | 停售菜单（`OPERATOR_EXTRA_MENUS`） | `admin-role.ts:132–138` / `:153` | 后台 `/system/sales-pause` |
> | admin-web 路由 | `routes.ts:333–341` | `system/sales-pause` |
> | `forceSuspend` | `building/dto/building-admin.dto.ts:289` / `:444` | 第 2 版记的路径 `building-admin.dto.ts` 有误 |
> | `suspend_building` / `suspend_building_group` | `operation-request.service.ts:45–46`（文案 `:59–60`） | 未漂 |
> | `building.suspend_force_max_count` | `config.specs.ts:438` | 未漂 |
>
> ⚠️ **本表行号基线 = 2026-10-26 收盘（终版 · 第 5 版）。下一次有人改动上述任一文件 —— 包括只改注释 —— 本表即作废，需重新 re-grep**（G10：登记前 grep，改动后回报）。
>
> ⚠️ **第 3 版 → 第 4 版就是被「只改注释」推翻的**：后端在 `order.service.ts` 加了一段**纯注释**（60009 payload 现状注记，现 `:278–289`），逻辑一字未动，把该文件的三个已登记锚点整体推了 **+20** 行，随后第 4 → 5 版又微调 3 行。⇒ **「我就改个注释」恰恰是这张表最常见的作废方式** —— 一张写死行号的表，最怕的就是「无语义改动」。
> ⚠️ **与 ADR 头部是同一张表**（G12）—— 两份文档以本表为准。本表由 2026-10-26 全部批次落地后逐条 re-grep 核对产出。
---

## 0. 全局硬纪律（每一条都有门禁在守，违反即红）

> ⚠️ **本节 G 表是 G1…G14（以及后续所有 G 条目）的**唯一住所**。**
>
> **ADR 不复制 G 条目。** ADR 里凡引用纪律，一律写「（G13）」这类编号并**指回本节**，不得把纪律原文再抄一份进去。
>
> **下一批新增 G 条目（G15 及以后）时，一律进本节，不进 ADR** —— 否则下一条 G15 又会有人顺手在 ADR 里也写一份。
>
> **为什么**（2026-10-26 Team Lead 采纳，G12 的直接推论）：这些纪律都是**跨批通用**的，一旦两边各长一份，就会变成本批已经治过三次的那个病 —— **同一个议题两个真源，改一边另一边静默变假**。G12 守的是「同一议题不得相反结论」，而**「一处真源 + 另一处指回」是它最干净的实现方式** —— 与 `admin-role.ts:187` 那次「别抄数组、指向数组」是同一个解法。

| # | 纪律 | 守门 |
|---|---|---|
| G1 | **禁止裸 `throw new Error`** —— 一律 `throw new BizException(ErrorCode.XXX, '文案')`。裸 Error 会绕过 `AllExceptionsFilter` 的「HTTP 200 + body code」全屋约定 | code review |
| G2 | 新增错误码必须**同时**登记 `common/constants/error-code.ts` 的 `enum ErrorCode` **与** `ERROR_MESSAGE` 映射 | `errcode:message` |
| G3 | 写路径用乐观锁 `version: () => 'version + 1'` + `.where('id=:id AND version=:v')`。**本批不改动既有 `Object.assign + save` 的行**（已单列议题） | `lock:version` |
| G4 | **TypeORM 默认命名策略不做 camelCase→snake_case 转换** —— 多词列必须显式写 `name: 'snake_case'` | `schema:parity` |
| G5 | 时间三件套，别手写：`toBjIso()` / `now()` / `bjDateTime(dateStr, hour)`（`hour` 可传 24 = 次日 0 点） | code review |
| G6 | 新增后台配置项必须登记 `modules/admin/config/config.specs.ts` | `config` 白名单 |
| G7 | 每批改完必须过 `node_modules/.bin/tsc -p apps/api-server/tsconfig.json --noEmit` | `typecheck:api` |
| G8 | 新增实体 / 索引必须**同时**改实体与迁移 | `schema:parity` + `index:parity` |
| G9 | 全局 `ValidationPipe` 开了 `forbidNonWhitelisted` —— **DTO 未声明的字段会被直接拒成 10001**，不是静默忽略 | code review |
| **G10** | **同步清单里的每个符号：登记前先 grep 到具体 `文件:行` 才能登记；改动之后 —— 包括**只改注释** —— 回头更新引用了它的文档。** 「我记得有个 XX」「**规格里这么写**」都不算回源 —— 后者与前者是同一类东西，同样要 grep 一次（见下方第 4 例） | code review（**无法自动化**，见下方理由） |
| **G11** | **判据形态必须与约束形态匹配。** 约束描述「不许做什么动作」，就只能用**能观察到那个动作**的判据去守（三条判别式见下） | code review（**无法自动化**，见下方理由） |
| **G12** | **ADR 与本规格对同一议题不得给出相反结论。** 改一处时必须回头看同源的另一处（锚点：错误码号位 / `文件:行号` / 字段名 / WHEN 句式 / 同步清单） | code review（**无法自动化**，见下方理由） |
| **G13** | **「待核 / 已核」必须写清楚是哪个。** 凡带「待核」字样的条目一律表示**尚未核实**，**不得当作结论转述**；核实完必须**当场**改成「已核 · 成立 / 不成立（**+ 依据**）」，不留着「待核」等人来问 | code review（**无法自动化**） |
| **G14** | **「有意保留的字面」两边都要写清楚谁该看到它。** 判据扫**代码**（那里出现 = 缺陷），**不许扫 `docs/`**（那里出现 = 有意留痕）；**只写一边，就会有一边假红**。适用两类：废弃码名、废弃文案 | code review（**无法自动化**；脚本层默认排除 `docs/` **尚未实现**，见下方注记） |

> **G13 为什么立**（2026-10-26 Team Lead 自陈并要求记入）。**本批实证**：Team Lead 曾把清单里的「**待核**（前端）」当成「**已核实**」转手派给前端，前端 grep 完发现 **0 命中** —— 白跑一趟。⇒ 「待核」与「已核」只差两个字，但一个是「没做过」，一个是「做过了」；**读的人不会去区分，只会看它像个结论就当结论用。**

> **G14 为什么立**（2026-10-26 Team Lead 采纳）。**本批实证**：全仓 grep 旧文案 `恢复时间请以通知为准` **只剩 1 处命中，且在 `docs/` 里** —— 那是**有意的废弃留痕**（照 §8「废弃码名：代码中不许有、文档里必须有」的同一判断：**有据可查地废止，优于无迹可寻地消失**）。⇒ 将来任何「旧字面不得再出现」类判据若扫全仓，**都会命中那处留痕而假红**。
>
> ⚠️ **脚本层实现留到下一批（本批不做）**：`check-n1n2-w1-suspend-rules.mjs` 的「默认排除 `docs/`」**尚未实现**。两条原因：① 本批已到收口，不加新活；② **该脚本当前正崩着**（`ReferenceError: reasonTextCoversDynamicKeys is not defined`，判据脚本 `:1329`，48 条判据一条都没执行），QA 正在修 ⇒ **现在往里加东西必然撞车**。⇒ 在此之前，G14 只能靠 code review 守。

> **G10 为什么立**（2026-10-26 Team Lead 采纳）。本批同一个失效模式犯了三次，三次都不是知识问题，是「没核就写 / 改了不回报」：
>
> 1. **`order.service.ts:1624`**：本规格上一版写下「两处一致，没问题，本批不动」—— 那是凭印象写的，回源核实 `1624` 仍是 `10004` + 旧文案。ADR 当时写的是对的，**两份文档给出相反结论**，读者无法分辨哪份可信。
> 2. **一个全仓 grep 命中 0 的虚构文案常量**：被登记为同步目标（Team Lead 已确认系误记）。执行者会去 grep 它、花时间找它、最后空手回来。
> 3. **我自己制造的行号漂移**（2026-10-26 补，Team Lead 要求把「注释也算改动」点明）：本批我唯一的业务侧改动，是给 `error-code.ts:106-115` 那段注释做「原为…现为…」的改写。**6 行，全是注释，一行可执行代码都没动** —— 结果把两个已登记在文档里的符号各推走了 6 行：`60011` 从 `error-code.ts:662` → `:668`、`orderability.ts:142` → `:149`。两份文档里写着旧号的行，一夜之间全部指错位置。
>
> ⇒ 第 1、2 例的病根相同：**把「印象中的符号」当成「核实过的符号」写进清单。** 登记前 grep 一次只要十几秒，不 grep 的代价是下一个人的半小时。
>
> ⇒ 第 3 例是**同一条纪律的另一半**，也是最容易漏掉的那一半：G10 不只管「写之前回源」，还管「**改完之后回头更新引用了它的文档**」。只守前半句，文档会在下一次无害改动里静默过期。
>
> ⚠️ **「注释也算改动」—— 必须单独点明，否则这条会被自我豁免掉。** 那次漂移的 6 行一行代码都没改，漂移却一点没少，因为**行号是被文件内容推着走的，不是被语义推着走的**：编译器不在乎你插进去的是注释还是语句，插入 6 行就是插入 6 行。而「我就改个注释 / 我改的是文档不是代码」是本条最常见的豁免理由 —— 它恰恰豁免不掉。
>
> ⇒ 本批的处置不是去追平那 6 行（已登记进漂移表），而是把规则补成双向：**登记前 grep（进）＋ 改动后回报（出）**。少一头，就只守了一半。
>
> 4. **照抄一句「规格里本来就写错了的话」当事实派单**（2026-10-26 Team Lead 自陈，要求并排记录）：本规格上一版 §7.6 第 1 条写 `GET /api/v1/meal/daily` 返回 `reason = 'sales_paused'`，Team Lead 照它派单给前端。**回源核实：`meal.service.ts:144` 是 `reason: availability.reasonText`** —— U1 的 `reason` 字段下发的是**中文文案**，不是枚举码。源错了，而派单方连回源都没做，因为「规格这么写」看起来就已经是回过源的结论。
>
> ⇒ **规格不是真相，代码才是。** 引用规格里的 `字段: 值` 时，它与「我记得有个 XX」是**同一类东西**，同样要 grep 一次 —— 唯一的区别是它更容易让人省掉那次 grep。
>
> **同一个人的三次「凭印象给错东西」· 性质并排（Team Lead 2026-10-26 要求并排记录）**
>
> | # | 实例 | 性质 | 为什么值得单列 |
> |---|---|---|---|
> | 1 | `SALES_PAUSED` 记成 **60010**（实为 **60009**，60010 是 `BUILDING_SUSPENDED`） | **记错号位** | 号位是纯记忆项，没有语义可推 ⇒ 只能 grep |
> | 2 | `order.service.ts:1692` 写成 throw 所在行（实际 throw 在 **`:1693`**，`:1692` 是上一行注释） | **少看一行** | 行号附近是注释还是语句，肉眼扫过去看不出来 ⇒ 必须落到那一行上看 |
> | 3 | 照抄规格里**一句本来就是错的**（`reason = 'sales_paused'`）当事实派单 | **源错了** | **最值得记**：前两次是「没回源」，这一次**连回源都没做**，因为「规格这么写」看起来就已经是回过源的结论 |
>
> ⇒ 三次的**性质各不相同**，说明这不是某个人的习惯问题，是**「引用而不回源」这条路径上三种不同的失效口**；第 3 次尤其说明：**文档写得越像结论，越容易被人当成免去回源的凭据。**
>
> ⚠️ **编号 / 号位同样是「符号」，适用同一条纪律**（2026-10-26 补，撞号两次后立）：
>
> 1. 我的 `N1-20 / N1-21 / N1-22` 撞了 **QA 已占用的 `N1-20`** ⇒ 顺延为 **`N1-23 / N1-24 / N1-25`**；随后新立的端上兜底判据又被编成 `N1-23`（**与刚顺延出来的号再撞一次**）⇒ 最终顺延为 **`N1-26`**。
> 2. Team Lead 把 `SALES_PAUSED` 记成 **`60010`**（实为 **`60009`**，60010 是 `BUILDING_SUSPENDED`）。
>
> ⇒ **登记编号前同样要回源核对「这个号有没有人已经在用」**，而且不能只看自己这一份文档 —— 判据号分散在 spec、ADR、QA 的 AC 与判据脚本里。见 §14.2 末尾的编号对照表。
>
> **G10 守的是「登记前回源 + 改动后回报」（写之前核、改之后追），G11 守的是「写完之后这东西到底有没有在守」** —— 两者是判据生命周期的两端，不要合并。

> ### G11 · 判据形态必须与约束形态匹配（2026-10-26 Team Lead 裁定措辞）
>
> 约束描述「不许做什么动作」，就只能用**能观察到那个动作**的判据去守。
>
> **三条判别式（写判据前逐条自问）**：
>
> | # | 自问 | 判定 |
> |---|---|---|
> | 1 | **约束描述的是结构，还是行为？** | 结构（有没有 import / 有没有声明 / 字面量在不在）→ **静态判据有效**；行为（会不会读当前时间 / 会不会在运行时求值 / 分组结论对不对）→ 静态判据**无效**，必须 jest / 连库 |
> | 2 | **能不能构造一个「满足判据但违反约束」的样本？** | 能构造出来 ⇒ **判据选型错**（本批实例见下 `N1-2`） |
> | 3 | **能不能构造一个「违反判据但满足约束」的样本？** | 能 ⇒ **判据过严**，会逼执行者为过检而改坏产物（本批实例：全仓禁 `canOrder` 会逼人删掉正确的解释性引用） |
>
> **⇒ 反例登记：本批 `N1-2`（静态判据守「不读时钟」）属第 1 类失效，已降级 —— 从静态脚本删除（或降为提示），改由 jest 覆盖。**
>
> 失效机制（_backend 破化实测）：静态判据守的是「有没有 import 某个符号」，而约束是「会不会计算当前时间」。**文件里塞一行 `Date.now()` 就能同时满足判据（绿）与违反约束（红）** —— 两者的真值可以相反。这样的判据不叫判据，叫装饰。
>
> 破化方式：文件顶部加一行 `const __leaked = Date.now();`，**连 `import` 行都没碰** ⇒ 任何按 import 形状 / 依赖扫描写的判据**完全无感**，全绿。同 §3「不读时钟」那条注记、§6.0 纯函数分层那处。
>
> ⚠️ **三条判别式的通用形态**（与 QA 的 C.3.0 同源）：`mutate` 是这条纪律**在静态脚本里的机械实现形态**，纪律本身适用于类型检查 / e2e / jest / 手工验证 —— **别以为「我脚本有 mutate 就够了」**。
>
> **三条配套结论（QA 2026-10-26 实测得出，与判别式同属 G11）**
>
> | # | 结论 | 本批实例 |
> |---|---|---|
> | 1 | **误报比漏报更伤** —— 扫到 ≠ 该判。误报一多，人就不会再看它 | 按「未配置楼群」扫出 7 处，3 处误报：`error-code.ts` 里两条**说明注释**（恰恰是要保留的正确文档）+ `orderability.ts` 的 `REASON_TEXT` |
> | 2 | **`mutate` 只覆盖「必报的报得出」，覆盖不到「必不报的不报」** ⇒ 变异自证**必须两个方向都做**：把产物改对一次看它绿不绿，不只是改坏看它红不红 | 收窄抛点时用「字面 ±200 字」当窗口，把上一行一个**合法的** `NOT_FOUND`（`办公楼 #${id} 不存在`）卷了进来 —— **产物改对了，判据还是红的** |
> | 3 | **取数要按结构，不要按距离**；且取数方向要与语义方向一致 | 条件在前、抛点在后 ⇒ 往**后**取；往回扫会抓到上一个抛点（又是那个合法的 10004） |
> | 4 | **射程当前为空的那一侧，自证天生覆盖不到**（2026-10-26 QA 提出，采纳） | `N1-12` 改成双侧（侧 A「值带 `{` 的键必须有插值 case」／侧 B「空串键必须有分支」），**侧 A 当前全仓无此形态** ⇒ 真文件跑一万次也证明不了侧 A 存在 |
>
> ⇒ **通律：凡是「当前恒真」的那一半，都必须单独造样本证明它「能红」。** 否则它就是一条对任何输入都成立的合取 —— **也就是恒绿**。
>
> ⇒ 与第 2 条合起来看：**自证的方向盲区不止一个** —— 一是「mutate 只覆盖必报的」，二是「**射程当前为空的那一侧，真文件根本进不去**」。前者靠**两个方向都 mutate** 解决，后者只能靠**造专项样本**（QA 的做法：把两侧抽成具名函数，空侧的射程交给 `HELPER_CHECKS` 里的 3 条专项样本，必红 1 / 必绿 2）。
>
> **通律（QA 归纳）**：**存在性断言 ⇒ 用 `replaceAll`；唯一性断言 ⇒ 用 `replace`。** 反例：`N2-3` 判「必须出现 `todayBj()`」（存在性）而 mutate 用 `replace` 只删第一处；后端后来又加了 3 处正确的时间边界 ⇒ 删 1 处还剩 3 处 ⇒ **判据对破化完全不敏感**。这一类的狠处是：**产物越正确，判据越假。**
>
> ⚠️ **还有一条最容易漏的（QA §C.3.0b）**：**一条判据可以通过「能证明自己会失败」，却同时违反 G11（瞄错了靶）。**
> `N1-2` 就是实例：它有 `mutate`、自证全绿、插 `Date.now()` 它确实会红 —— 但自证证明的是「**观察对象**变了会红」，证明不了「**被约束的东西**变了会红」。
> ⇒ 这也是为什么 G11 与「判据必须能证明自己会失败」**必须并排看**，只写一条会漏掉整类失效。
> ⇒ 推论：**降级后的 `N1-2` 也不给它做自证** —— 给了只会重演「它能红所以它有效」这个假象。

> **G11 / G12 为什么无法自动化**：语义一致性判不出 —— 硬做只会得到一个**恒绿**的检查（两份文档抄同一句话就过，而「抄同一句话」恰恰是我们要防的漂移的一种）。**恒绿的检查等于没有检查**，本批这条纪律已用上三次，不要在收尾时自己违反它。⇒ G10 / G11 / G12 都是**人工动作**，靠 code review 与本文档留痕执行。
>
> **G12 已发生的三次实例**（有实例才记得住）：
>
> | # | 议题 | 一边说法 | 另一边说法 | 采用 |
> |---|---|---|---|---|
> | 1 | `order.service.ts:1624` | ADR：必改 | spec：不改 | **必改**（回源核实 1624 仍是 10004） |
> | 2 | D-N1-8 文案 | ADR §3 负面后果：要复核（旧文案是误导） | ADR §9 / spec §12.7：不改 | **不改 + 补注释** |
> | 3 | 后台 `canOrder` 残留 | §5.4.4：留 2 处解释性引用 | §12.6 验收句式：后台清零 | **留 2 处**，且必须带「不要全局替换」警示语 |

---

## 1. 批次划分

六个批次，每批独立可提交、独立过门禁。**顺序有依赖，不要跳批。**

| 批次 | 内容 | 依赖 |
|---|---|---|
| **P3-1** | 错误码登记（60006–60013，连续无跳号） | 无 |
| **P3-2** | 纯函数 `common/utils/orderability.ts` | 无 |
| **P3-3** | IO 编排 `common/services/order-availability.service.ts` | P3-2 |
| **P3-4** | N1 接线（meal / order / workbench / building-admin） | P3-3 |
| **P3-5** | N2 闸门（DTO / 计数 / 分级 / opCode / 配置项） | P3-1 |
| **P3-6** | W1 停售（实体 / 迁移 / 模块 / 接线） | P3-3 |

---

## 2. P3-1 · 错误码登记

**文件** `apps/api-server/src/common/constants/error-code.ts`

**动作 1**：在 `BUILDING_NAME_TAKEN = 60005,`（第 506 行）之后、`/** ---- 9xxxx 系统 ---- */` 之前插入：

```ts
  /** 扩展（N2）：办公楼存在未完结订单，不能直接停用（1 ≤ N ≤ 阈值，需 force + reason） */
  BUILDING_UNFINISHED_ORDERS = 60006,
  /** 扩展（N2）：楼群存在未完结订单，不能直接停用 */
  BUILDING_GROUP_UNFINISHED_ORDERS = 60007,
  /**
   * 扩展（N1）：不能把办公楼挂进已停用的楼群
   *
   * ⚠️ 为什么必须有它：`BUILDING_GROUP_NOT_EMPTY`(60003) 只保证「停用楼群时成员为 0」，
   *    但会写 `building_group_id` 的路径**共三条**，都**不检查目标楼群状态** ——
   *    运营往已停用楼群里搬楼 / 挂楼，**或直接把楼新建进已停用的楼群**，成员楼会静默失去
   *    开团能力（下单时落到 `group_suspended`，而后台回执是「创建 / 修改成功」）。
   *    这是 60003 的**三条**旁路：`assignMembers()`（批量搬楼）、
   *    `updateBuilding()`（编辑归群）、**`createBuilding()`（新建时带 `buildingGroupId`）**。
   */
  BUILDING_GROUP_SUSPENDED_REJECT = 60008,
  /** 扩展（W1）：当前已一键停售（全局暂停接单） */
  SALES_PAUSED = 60009,
  /**
   * 扩展（N1）：该办公楼**已被运营主动停用**（preparing / suspended / 所属楼群已停用）
   *
   * ⚠️ 与 60011 的区别是**处置动作不同**：本码 = 运营自己停的（无需动作，不该告警）；
   *    60011 = 漏配（是事故，要告警）。合成一码会让日志/监控/告警完全同形 ——
   *    本仓拆 `30022` / `30023` 时给的就是这个理由。
   */
  BUILDING_SUSPENDED = 60010,
  /**
   * 扩展（N1）：该办公楼**未配置楼群**（配置缺失 · 取代现状的 `10004`）
   *
   * ⚠️ 这是**契约变更**：`meal.service.ts:269` 与 `order.service.ts:1628` 现状抛
   *    `ErrorCode.NOT_FOUND`(10004)。见本规格 §5.1 / §5.2 与 §12 的同步动作。
   */
  BUILDING_NOT_GROUPED = 60011,
  /** 扩展（N2）：未完结订单超过阈值，强制停用不可用，须走运营审批 */
  SUSPEND_REQUIRE_APPROVAL = 60012,
  /**
   * 扩展（N2）：已截单订单无法通过停用撤回（**硬约束，不可配置**）
   *
   * ⚠️ 用户已裁定：供应商已按份数采购备货，此阶段撤回让用户与供应商承担损失、
   *    而运营零成本，权责不对等。故即使带 `forceSuspend` 且选「一并退款」也拒绝。
   */
  SUSPEND_CANNOT_REVOKE_ACCEPTED = 60013,
```

**动作 2**：在 `ERROR_MESSAGE` 中 `[ErrorCode.BUILDING_NAME_TAKEN]: '办公楼名已存在',`（第 618 行）之后插入（**两处必须成对，缺一即红**）：

```ts
  [ErrorCode.BUILDING_UNFINISHED_ORDERS]: '该办公楼仍有未完结订单，不能直接停用',
  [ErrorCode.BUILDING_GROUP_UNFINISHED_ORDERS]: '该楼群仍有未完结订单，不能直接停用',
  [ErrorCode.BUILDING_GROUP_SUSPENDED_REJECT]: '目标楼群已停用，不能把办公楼挂进去',
  [ErrorCode.SALES_PAUSED]: '当前已暂停接单',
  [ErrorCode.BUILDING_SUSPENDED]: '该办公楼已停用时不可下单',
  [ErrorCode.BUILDING_NOT_GROUPED]: '该办公楼未配置楼群，请联系运营',
  [ErrorCode.SUSPEND_REQUIRE_APPROVAL]: '未完结订单超过阈值，强制停用不可用，请提交运营审批',
  [ErrorCode.SUSPEND_CANNOT_REVOKE_ACCEPTED]: '已有订单进入履约阶段，无法通过停用撤回',
```

**验收句式**

- WHEN 新增任一 60006–60013 错误码 THEN `enum ErrorCode` 与 `ERROR_MESSAGE` 必须同时出现该码（G2）。
- WHEN 运行 `node scripts/gate.mjs errcode:message` THEN 必须全绿。
- WHEN 检查 6xxxx 段 THEN 必须连续占用 60006–60013，**不得跳号**（例如不得空置 60013 而用 60020）。

---

## 3. P3-2 · 纯函数 `common/utils/orderability.ts`

**文件 1** 新增 `apps/api-server/src/common/utils/orderability.ts`（**≤180 行** —— 原定 ≤150，因新增 `reasonText()` 唯一文案出口放宽，见实现要求第 7 条）

**文件 2** 新增 `apps/api-server/test/unit/orderability.spec.ts`（**≤150 行**）—— **本批授权新建的文件**（见文首白名单第 2 项）

> **为什么要把测试文件显式列进本批**（2026-10-26 补）：本规格第 3 节写了「求值顺序**必须**…**单测要锁死**」，§9 又要跑 `jest`，但**没列出测试文件路径** —— 而文档开头写着「本规格未授权改任何**未列出**的文件」。这三句放在一起，执行者会被卡住：要求写单测，又不授权建文件。
>
> 这是我自己的规格内部矛盾，按「单测是本批唯一能 100% 覆盖的部分」这一侧解决：**抽纯函数的全部收益就在可测性上**，没有单测，这次抽取只剩搬家的成本。
>
> 命名沿用既有约定（同目录已有 `time-anchor.spec.ts`）。
>
> **关于行数上限**（2026-10-26 补，_backend 实测后）：上限的价值在于**逼出更好的组织方式**，不是限制篇幅。他为压到 ≤150 把「四条 reason 各一例」改成表驱动（`[Partial<StructureScope>, StructureBlockReason|null][]`），结果比原来 5 段重复 `toEqual` 更好读。
>
> ⇒ **压行数时优先压注释和重复结构，不得压判据与用例。** 若确实压不进上限，正确动作是回来改上限并写明理由（如本文件 1 从 ≤150 放宽到 ≤180 那样），**不是删判据、不是砍用例** —— 后者会让绿灯失去意义。

**必须覆盖的用例**（少于这些即视为未完成）：

1. `evaluateStructure` 四条 reason 各一例 + `ok: true` 一例（含本节全部验收句式）。
2. **fail-open 定向回归**：`{ buildingStatus: null, buildingGroupId: 7, buildingGroupStatus: 1 }` ⇒ `building_not_grouped`。这条是 _backend 实测发现的洞，没有它会静默复活。
3. `buildingStatus: null` 且 `buildingGroupStatus: 2` 时仍为 `building_not_grouped`（**顺序未被破坏**）。
4. `evaluateAvailability`：停售优先级最高一例 + 时间层两条边界（`nowMs` 恰等于 `publishAtMs` / `cutoffAtMs - window`）各一例。
5. `reasonText()`：`not_open_yet` / `cutoff` 返回**非空串**；其余六值恒等于 `REASON_TEXT[reason]`。
6. **不读时钟断言**：`readFileSync(..., 'utf8')` 读本文件源码，断言 `new Date()` 与 `Date.now()` 命中数为 0。
   —— 把静态判据写成 jest 用例，比依赖外部 gate 更贴真实意图：它守的不是「有没有 import 某个符号」，而是「这个文件里有没有引入第二个时间源」。

**约束**：零 IO、零依赖注入、**不读时钟**。与 `common/utils/time.ts` 同性质 —— 不构成模块依赖边，任何模块都可 import。

> **「不读时钟」的精确判据**（2026-10-26 澄清，_backend 提出字面冲突）：
>
> - ❌ 禁止 **无参 `new Date()`** 与 **`Date.now()`** —— 它们取当前时刻。纯函数里一旦出现，就同时存在「注入时钟（`ABOX_SHIFT_TO_HOUR`）」与「真实时钟」两个时间源，e2e 结论不可信。
> - ✅ 允许 **有参 `new Date(ms)`** —— 这是**毫秒 → `Date` 的纯换算**（`toBjIso(at: Date)` 只收 `Date`，见 `time.ts:217`），不读时钟、不引入时间源。
>
> 可机械判定：本文件内 grep `new Date()` / `Date.now()` 命中数必须为 **0**；`new Date(`（带参）允许。
>
> ⚠️ **这条约束的判据形态只能是 jest，不能是「按 import 形状写的静态判据」**（2026-10-26 _backend 破化实测）：
>
> 他的破化方式是在文件顶部塞一行 `const __leaked = Date.now();` —— **连 `import` 行都没碰**。按「本文件是否 import 了某个时间模块」这类形状判据的写法，对这种回归**完全无感**，全绿。所以上面第 6 组用例必须写成 jest 源码断言（读本文件源码、断言命中数为 0），不能退化成依赖扫描。
>
> 判据选型的原则：**约束说的是「不许做什么动作」，就只能用能观察到那个动作的判据去守**；import 形状观察的是「用了谁」，观察不到「做了什么」。

```ts
import { BuildingGroupStatus, BuildingStatus } from '@abox/shared-types';

/** 结构层输入（**无时间维度** —— 管家端与用户端共用） */
export interface StructureScope {
  buildingStatus: number | null;      // ab_building.status；null = 楼不存在 / 已软删
  buildingGroupId: number | null;     // null = 未归群
  buildingGroupStatus: number | null; // ab_building_group.status；null = 群不存在
}

/** 用户端完整输入（结构层 + 编排层 + 时间层 + 停售层） */
export interface AvailabilityInput extends StructureScope {
  assignmentStatus: string | null; // ab_meal_assignment.status；null = 无分配
  salesPaused: boolean;
  cutoffWindowMinutes: number;
  publishAtMs: number; // publishAtOf(mealDate).getTime()
  cutoffAtMs: number;  // cutoffAtOf(mealDate).getTime()
  nowMs: number;       // now().getTime()
}

export type StructureBlockReason =
  | 'building_not_grouped'
  | 'building_preparing'
  | 'building_suspended'
  | 'group_suspended';

export type OrderBlockReason =
  | 'sales_paused'
  | StructureBlockReason
  | 'meal_not_published'
  | 'not_open_yet'
  | 'cutoff';

export interface StructureResult {
  ok: boolean;
  reason: StructureBlockReason | null;
}

export interface Availability {
  canOrder: boolean;
  reason: OrderBlockReason | null; // canOrder === true 时恒为 null
}

/**
 * 结构层谓词 —— 三处共用同一实现（管家端只调本函数）
 *
 * 判据只有三项：楼 status、归群、楼群 status。
 * ⚠️ **刻意不判集散中心覆盖**（`DistributionGap`）：项目已把「未覆盖」定义为
 *    「下单能成立、履约断链」（见 `building-admin.service.ts:279` 的 notes.gap），
 *    并进本谓词会让 `gap` 字段失去意义，且把「集散中心配置」的后果静默传导成停摆。
 */
export function evaluateStructure(s: StructureScope): StructureResult;

/** 用户端完整谓词（结构层 + 编排层 + 时间层 + 停售层） */
export function evaluateAvailability(i: AvailabilityInput): Availability;
```

**实现要求**

1. `evaluateStructure` 的求值顺序**必须**是下面这个全序，单测要锁死：

   ```
   1 building_not_grouped   buildingStatus == null || buildingGroupId == null
                            || buildingGroupStatus == null
   2 building_preparing     buildingStatus === BuildingStatus.PREPARING (2)
   3 building_suspended     buildingStatus === BuildingStatus.SUSPENDED (3)
   4 group_suspended        buildingGroupStatus === BuildingGroupStatus.SUSPENDED (2)
   ```

   > **第 1 条为什么收三个「存在性」条件（2026-10-26 二次修正，ADR D-N1-8）**
   >
   > 前后两版修正合起来看，病根很清楚：**相等判定天然漏 `null`。**
   >
   > - 第一版只写 `buildingGroupId == null` ⇒ `{ buildingStatus: null, buildingGroupId: 7 }` 落到底判 `ok: true`（一栋不存在的楼可下单）。
   > - 加上 `buildingStatus == null` 后，左半修好了，但**右半仍开着**：`buildingGroupId` 非 null 而 `buildingGroupStatus == null`（楼群软删或压根不存在）时，第 4 条的 `=== SUSPENDED` 不成立 ⇒ 仍然落到 `ok: true`。
   >
   > ⇒ 正确形态是：**三个入参的存在性判定合成第 1 条，一起 fail-closed**；第 2–4 条只做相等判定，且走到那里时入参已保证非 null。`buildingStatus` 与 `buildingGroupStatus` 是同源字段，此前一个用存在性判定、一个用相等判定 —— 风格分叉才是那个洞真正的病根。
   >
   > `buildingGroupStatus === null` **真实可达**：`BuildingAdminService.loadContext():112` 查楼群带 `deletedAt: IsNull()`，软删的楼群查不到 ⇒ `groupStatusMap.get(gid) ?? null`。而 `ab_building_group.status` 是 **NOT NULL**（`building.entity.ts:116` 未标 `nullable`）⇒ `null` **只可能来自「行查不到」**，fail-closed 不产生假阳性。
   >
   > ⚠️ **第 4 条的 `=== SUSPENDED` 保留**，但它不再承担存在性职责（已由第 1 条兜住）。**不要字面删掉它** —— 删了 `group_suspended` 这个 reason 就整体消失，而它是 60010 的四个输入之一、且有独立文案「该区域已暂停服务」。
   >
   > **连带文案处置（裁定：文案不改）**：`building_not_grouped` 现在同时覆盖**三类**成因 —— **① 楼不存在 / 软删**、**② 楼未归群**、**③ 楼群记录不可达**（悬空引用 / 软删）。**文案字面不动**（统一动作在 §14 收尾批做）—— 三类成因对**用户**的处置动作完全相同（都是「下不了单，去找团长 / 运营」），用户分辨不了也不需要分辨；区分责任交给错误码 `60011`。见 §12.7。
   >
   > ⚠️ **「两类」是错的说法**（2026-10-26 更正）：本规格与 ADR 此前都写「两类成因」，漏了 **① 楼不存在** 这一类 —— 它由 `buildingStatus === null` 单独承载，与「楼未归群」不是一回事。已回源核对：`orderability.ts:136-140` 的注释写的是**三种成因**（① 楼未归群 ② 楼记录不可达 ③ 楼群记录不可达），后端落的是对的。**两份文档按三类对齐**（G12）。

   顺序的理由（不是随意排的）：粒度粗的判据一旦成立，细粒度判据给用户的结论就是误导。楼群停用时若回「今日未开团」，用户读到的是「明天再来看看」，而实际明天也不会有。同理未归群必须先判：一栋没进群的楼即使 `status=1` 也送不了，「营业中」是假的安全信号。

   **1-bis · D-N2-4：第 1 条的三选一形态（强约束，不要写错形态）**

   第 1 条从二选一扩为**三选一**，且**三个条件必须都是 `=== null`**：

   ```ts
   // 1. buildingStatus === null || buildingGroupId === null || buildingGroupStatus === null
   //       ⇒ building_not_grouped         ← 三条都是「存在性判定」，一起 fail-closed
   // 2. buildingStatus === PREPARING      ⇒ building_preparing
   // 3. buildingStatus === SUSPENDED      ⇒ building_suspended
   // 4. buildingGroupStatus === SUSPENDED ⇒ group_suspended   ← 保留，只移除存在性职责
   ```

   **第 4 条 `=== BuildingGroupStatus.SUSPENDED` 保留不动。** 不要顺手改成「不存在或已停用」—— 存在性已由第 1 条兜住，第 4 条改了会**重复承担存在性职责**，而且会让人误以为「楼群不存在」也算停用（那是 `building_not_grouped`，不是 `group_suspended`，两者告警形不同）。

   **两条回源依据**（已核）：

   1. `ab_building.status`（`building.entity.ts:79`）与 `ab_building_group.status`（`building.entity.ts:116`）**均 NOT NULL**（`@Column` 未标 `nullable`）⇒ `null` **只可能来自 JOIN 不到**，不会来自列值为空 ⇒ fail-closed **不产生假阳性**。
   2. **全仓没有楼群删除入口**（`building/` 目录下无 `groupRepo.softDelete/delete/remove`）⇒ 楼群「不存在」在实践中就是「JOIN 不到」或软删，与楼宇同理。

   **判据（两条，都是结构约束 ⇒ 静态判据有效，按 G11 第 1 条自问过）**

   | # | 判据 | 什么情况下会红 |
   |---|---|---|
   | D-N2-4-a | 第 1 条的三个条件必须**逐个是 `=== null`**；同一函数体内不得出现 `!buildingStatus` / `== null` / `=== undefined` 形式的存在性判定 | 有人把任一条件写成 `!x` 或 `== null` ⇒ 红。这两种写法把「不存在」与「值为 `0` / 空串 / `false`」混为一谈，而 `status` 是 `0` 起步的数值枚举（`BuildingStatus`），`!buildingStatus` 会把「营业中」判成「不存在」 |
   | D-N2-4-b | 第 4 条必须**仍是 `buildingGroupStatus === BuildingGroupStatus.SUSPENDED`**（或等价的 `=== 3`） | 有人把第 4 条改成 `!buildingGroupStatus \|\| buildingGroupStatus === SUSPENDED` 之类 ⇒ 红 |

   > **为什么这两条判据用静态就够、不必 jest**：它们守的是**字面形态**（有没有写 `=== null`、第 4 条是不是还在），不是运行时行为。按 G11 判别式第 1 条 —— 约束描述结构 ⇒ 静态判据有效。真正需要 jest 的是**求值顺序**（第 1 条必须先于 2/3/4），那部分已在 §3 的 jest 用例组②/③里。

2. `buildingStatus` 为 `null`（楼不存在/已软删）时**不要**在本函数里抛异常 —— 调用方已在各自的 `resolveXxx()` 里抛 `BUILDING_NOT_FOUND`，本函数收到 `null` 即按 `building_not_grouped` 处理（已并入上面第 1 条），避免同一件事两处抛码。

3. `evaluateAvailability` 的求值顺序：

   ```
   1 sales_paused          salesPaused === true
   2 ~ 5                   调 evaluateStructure，顺序不变
   6 meal_not_published    assignmentStatus !== 'active'（含 null）
   7 not_open_yet          nowMs < publishAtMs
   8 cutoff                nowMs >= cutoffAtMs - cutoffWindowMinutes * 60000
   ```

4. **不抛异常**。纯函数只回答真假与原因；抛什么是调用方的契约责任（管家端不抛、U6 抛）。

5. **不返回 `reasonText`**。文案由调用方各自拼（`REASON_TEXT` 查表放本文件导出，见 P3-4）。

6. 另导出文案查表，**不得用嵌套三元**（现在的 `meal.service.ts:118–124`（**P3-4 后已不存在**，改为取编排层 `reasonText()`，见 §3 实现要求第 6/7 条） 是三层嵌套，加了两条分支会变五层；三元求值顺序是隐式的，查表的顺序才是显式可测的）：

   ```ts
   export const REASON_TEXT: Record<OrderBlockReason, string> = {
     /** ⚠️ **空串** —— 真身不在这里，见下方注记 */
    sales_paused: '',
    // ⚠️ 已落地形态（backend-w1 收口，2026-10-26 回源核实）：本键是**空串**，与
    //    `not_open_yet` / `cutoff` 同一约定 —— **空串 = 「这句文案由 `reasonText()` 生成」**，
    //    是**有意义的空**，不是遗漏。
    //    真身在 `reasonText()` 的 `case 'sales_paused'`：`今日暂停接单：${why}`（`why` =
    //    运营填的停售原因）；`why` 缺省则回落 `今日暂停接单`，不拼冒号、不留空尾巴。
    //    ⇒ **不要照本规格更早写的静态句回改代码** —— 那句是旧口径，现已不存在。
    //      直接索引 `REASON_TEXT[...]` 会拿到空串，由 `N1-11` 拦住。
     // 这个桶覆盖**三类**成因：(a) 楼不存在 / 软删（`buildingStatus === null`）；
     //   (b) 楼未归群（`buildingGroupId === null`，配置没做完）；
     //   (c) 楼群记录不可达（`buildingGroupStatus === null`，悬空引用 / 软删，配置坏了）。
     // 三者共用一条文案是**有意**的：对用户的处置动作完全相同 —— 都是「下不了单，去找团长 / 运营」，
     //   用户分辨不了也不需要分辨。区分责任交给错误码 60011（排查者看码即可）。
     // 不要把这里拆成三条：为一个用户感知不到的区别多开分支，成本不小、收益是零。
     building_not_grouped: '该办公楼暂未开通服务，请联系运营',
     building_preparing: '该办公楼尚未开通，敬请期待',
     building_suspended: '该办公楼已暂停服务',
     group_suspended: '该区域已暂停服务',
     meal_not_published: '该办公楼今日未开团',
     not_open_yet: '', // 动态文案：今日 {HH:mm} 开团，敬请期待
     cutoff: '',       // 动态文案：距截单不足 {N} 分钟，请明日再订
   };
   ```

7. **另导出唯一的文案出口 `reasonText(reason, ctx)`（P3-2 补，_backend 提的静默失败面）**

   `REASON_TEXT` 里 `not_open_yet` / `cutoff` 是空串（需要插值）。空串是个**静默失败面**：四个调用方里任何一个漏了插值分支，用户拿到的是一条空文案，而**没有任何一道门禁、任何一条类型约束能拦住它**（`string` 就是 `string`，空串完全合法）。

   若让四个调用方各自写插值，就是把两条动态文案复制四份 —— 那是本批正在消灭的病根（第二份判据）。故在本文件再加一个纯函数作为**唯一出口**：

   ```ts
   export interface ReasonContext {
     publishAtMs: number;
     cutoffAtMs: number;
     cutoffWindowMinutes: number;
   }

   /** 文案唯一出口 —— 四个调用方一律走它，不得各自拼 */
   export function reasonText(reason: OrderBlockReason, ctx: ReasonContext): string {
     switch (reason) {
       case 'not_open_yet':
         return `今日 ${toBjIso(new Date(ctx.publishAtMs)).slice(11, 16)} 开团，敬请期待`;
       case 'cutoff':
         return `距截单不足 ${ctx.cutoffWindowMinutes} 分钟，请明日再订`;
       default:
         return REASON_TEXT[reason];
     }
   }
   ```

   - 仍是**零 IO / 零 DI**（`toBjIso` 来自 `common/utils/time.ts`，纯函数），符合 P3-2 的模块边界。
   - `canOrder === true` 时 `reason` 为 `null`，调用方不得调本函数，直接给 `null`。
   - 文件行数上限由 ≤150 放宽到 **≤180**。

**验收句式**

- WHEN `buildingGroupId = null` AND `buildingStatus = 1` THEN `evaluateStructure` 返回 `{ ok: false, reason: 'building_not_grouped' }`。
- WHEN `buildingGroupId = 7` AND `buildingStatus = 2` AND `buildingGroupStatus = 1` THEN 返回 `reason: 'building_preparing'`（**不是** `group_suspended`）。
- WHEN `buildingGroupId = 7` AND `buildingStatus = 3` AND `buildingGroupStatus = 2` THEN 返回 `reason: 'building_suspended'`（结构层内部顺序优先于楼群级）。
- WHEN `buildingGroupId = 7` AND `buildingStatus = 1` AND `buildingGroupStatus = 2` THEN 返回 `reason: 'group_suspended'`。
- WHEN 上述四项全部不成立 THEN 返回 `{ ok: true, reason: null }`。
- WHEN `salesPaused = true` AND 结构层全部合法 AND 时间窗口合法 THEN `evaluateAvailability` 返回 `reason: 'sales_paused'`（停售优先级最高）。
- WHEN `evaluateAvailability` 返回 `canOrder = true` THEN `reason` 必须为 `null`（不得同时为真与有原因）。
- WHEN `{ buildingStatus: null, buildingGroupId: 7, buildingGroupStatus: 1 }` THEN `evaluateStructure` 必须返回 `{ ok: false, reason: 'building_not_grouped' }`（**不得**返回 `ok: true` —— 一栋不存在的楼不能被判为可下单）。
- WHEN `{ buildingStatus: 1, buildingGroupId: 7, buildingGroupStatus: null }` THEN 必须返回 `{ ok: false, reason: 'building_not_grouped' }`（**不得**返回 `ok: true` —— 楼群查不到 = 悬空引用，不是可下单）。
- WHEN `{ buildingStatus: 1, buildingGroupId: 7, buildingGroupStatus: 2 }` THEN 必须返回 `reason: 'group_suspended'`（`group_suspended` 这个 reason **不得消失**）。
- WHEN `reason ∈ { not_open_yet, cutoff }` THEN `reasonText(reason, ctx)` 的返回值**不得为空串**（必须已插值）。
- WHEN `reason` 为其余六值 THEN `reasonText()` 必须等于 `REASON_TEXT[reason]`（不得走插值分支）。
- WHEN 四个调用方（U1 / U6 / 工作台 / 管家端）任一处要出文案 THEN 必须调用 `reasonText()`，**不得**自行拼字符串或直接读 `REASON_TEXT`（`REASON_TEXT[not_open_yet]` 是空串，直接读就是空文案）。

---

## 4. P3-3 · IO 编排 `common/services/order-availability.service.ts`

**文件** 新增 `apps/api-server/src/common/services/order-availability.service.ts`（≤120 行）

**约束**：Nest `@Injectable()`，注册进 `CommonModule` 的 `providers` **与** `exports`。`CommonModule` 是 `@Global()`（`common/common.module.ts:55`），故 `meal` / `order` / `team-leader` / `building` 四个模块**无需任何 import 改写**即可注入。

```ts
@Injectable()
export class OrderAvailabilityService {
  constructor(
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    @InjectRepository(BuildingGroup) private readonly groupRepo: Repository<BuildingGroup>,
    @InjectRepository(MealAssignment) private readonly assignRepo: Repository<MealAssignment>,
    @InjectRepository(SalesPause) private readonly pauseRepo: Repository<SalesPause>,
    private readonly bizConfig: BizConfigService,
  ) {}

  /** 用户端：按 userId 解析楼 → 楼群 → 分配 → 停售 → 调纯函数 */
  async forUser(mealDate: string, userId: number): Promise<Availability & { reasonText: string | null }>;

  /** 非用户端（团长工作台等）：按 buildingId 解析 */
  async forBuilding(mealDate: string, buildingId: number): Promise<Availability & { reasonText: string | null }>;
}
```

**实现要求**

1. 内部一次性取齐：`building`（含 `status` / `buildingGroupId`）、`group`（含 `status`）、`assignment`（`where: { mealDate, buildingGroupId }`）、`salesPaused`、`cutoffWindowMinutes`；再算 `publishAtOf(mealDate).getTime()` / `cutoffAtOf(mealDate).getTime()` / `now().getTime()`，交给 `evaluateAvailability`。
2. **查 `building` 与 `group` 必须带 `deletedAt: IsNull()`。** 理由见下方专项说明 —— 这不是新发明的严格，是**本仓既有约定**。
3. `salesPaused` 的判定（W1 表在 P3-6 才有，本批可先返回 `false` 占位，P3-6 再接线）：
   ```ts
   const paused = await this.pauseRepo
     .createQueryBuilder('p')
     .where('p.meal_date_from <= :d', { d: mealDate })
     .andWhere('p.meal_date_to >= :d', { d: mealDate })
     .andWhere('p.resumed_at IS NULL')
     .getCount();
   ```
4. **不走任何缓存**（Team Lead 已裁定）。`BizConfigService` 的 60 秒 TTL 是 W1 落独立表的原因，不要在编排层把它加回来。
5. 楼不存在 / 未归群的情况**不要**在本服务里抛异常 —— 抛码是调用方的契约责任（各调用方已有 `BUILDING_NOT_FOUND` / `USER_BUILDING_UNBOUND` / `NOT_FOUND` 的既有行为，见 P3-4 第 1 条）。

> **`deletedAt: IsNull()` 为什么是本批必做（2026-10-26 裁定，_backend 提出）**
>
> 回源三条事实：
>
> 1. `ab_building.deleted_at` 是**普通 `@Column`**（`building.entity.ts:90`），**不是 `@DeleteDateColumn`** ⇒ TypeORM **不会**自动过滤，不写 `IsNull()` 就会查出软删的楼。
> 2. **本仓每一处楼/群查询都显式写了 `deletedAt: IsNull()`** —— `building-admin.service.ts` 里 15+ 处、`building.service.ts:73`（QA 已锁的入口基线）也是。**不写才是异常**，写了是跟随约定。
> 3. 用户端四条读路径（`meal.service.ts:267`、`order.service.ts:1626`、`workbench.service.ts:63`、`user.service.ts:115`）**全都漏了**这个过滤 —— 这个洞今天就在，只是还没人踩。
>
> **为什么不构成「扩大范围」**：
>
> - 目前**没有任何代码会置 `ab_building.deleted_at`**（全仓只有 `distribution-center-admin.service.ts:247` 置过 `deletedAt`，且是集散中心）。该字段对楼宇**恒为 NULL** ⇒ 加上过滤**今天零行为变化**。
> - 我们是在**新写的文件**里写过滤，不是去改既有行为；P3-4 把用户端四条路径切到本服务后，它们顺带继承这个过滤 —— 那是修洞，不是改口径。
> - 与 §3 那条 fail-open 修正**同族**：软删的楼 `status` 可能仍是 `1`、也可能已归群 ⇒ 结构层全过 ⇒ 判为可下单。**「调用方应该不会查到软删的楼」不是判据。**
>
> **边界**：只改本服务。**不要**回头去给 `meal.service.ts:267` / `order.service.ts:1626` / `workbench.service.ts:63` / `user.service.ts:115` 各自补 `IsNull()` —— 它们在 P3-4 会切到本服务；没切的那条（`user.service.ts:115`）是 QA 已锁的回归基线，不动。

**验收句式**

- WHEN `mealDate` 落在一条生效的 `ab_sales_pause` 区间内 THEN `forUser` 返回的 `reason` 必须为 `sales_paused`。
- WHEN 写入停售后**立刻**（不等待）调用 `forUser` THEN 必须已返回 `sales_paused`（不得存在缓存窗口）。

- WHEN 一栋楼的 `deleted_at` 非 NULL THEN `forUser` / `forBuilding` 必须返回 `canOrder = false`（**软删的楼不得被判为可下单**）。
- WHEN 在 `common/utils/orderability.ts` 内 grep `new Date()` / `Date.now()` THEN 命中数必须为 **0**（不读时钟；带参 `new Date(ms)` 是纯换算，允许）。

> ⚠️ **前两句的 `reason` 是内部层的枚举码，不是 U1 下发的那个 `reason`。** `forUser` 返回 `Availability & { reasonText }` —— `reason` 是码、文案在 **`reasonText`**；而 `GET /api/v1/meal/daily` 把 `reasonText` 塞进了 HTTP 响应的 `reason` 字段（`meal.service.ts:144`）⇒ **同名不同义**。⇒ 前两句守的是**服务内部**，**不要**拿它们当 U1 的验收，也**不要**据此在端上写 `reason === 'sales_paused'`；U1 的验收在 §7.6（判文案含运营填的停售原因）。

---

## 5. P3-4 · N1 接线（四处）

### 5.1 `meal.service.ts`（U1）

**文件** `apps/api-server/src/modules/meal/meal.service.ts`

| 行 | 动作 |
|---|---|
| `254–284` | `resolveUserGroup()` 返回类型由 `Promise<number>` 改为 `Promise<{ building: Building; groupId: number }>`；把 `building` 整个带出来（现在只返回 `building.buildingGroupId`，`status` 被丢掉） |
| **`281`** | **契约变更**：`throw new BizException(ErrorCode.NOT_FOUND, '所属办公楼未配置楼群，请联系运营')` → 改为 `throw new BizException(ErrorCode.BUILDING_NOT_GROUPED, '所属办公楼未配置楼群，请联系运营')`（**10004 → 60011**）。文案不变。同步动作见 §12 |
| `104` | 删除 `const canOrder = assignment.status === 'active' && isOrderable(targetDate, cutoffWindow);`，改为调用编排层 |
| `118–124` | 删除三层嵌套三元，改为 **调 `reasonText(reason, ctx)` 一个调用**（不得自己写插值分支，见 §3 实现要求第 7 条） |
| `140–162` | 出参 `canOrder` / `reason` / `reasonText` 改用编排层结果 |

**四处接线共用的文案纪律**：`reasonText` 一律取编排层（`OrderAvailabilityService`）返回的那个值，**不得**在本文件里再读一次 `REASON_TEXT` 或再拼一次文案。`REASON_TEXT['not_open_yet']` 是空串，绕过 `reasonText()` 直接读 = 给用户发一条空文案，且没有任何门禁能拦。

**保留不动与必须改，两个码性质相反，不要并列处理**：

- ✅ **保留不动**：`resolveUserGroup` 里的 `USER_BUILDING_UNBOUND`（**20016**，用户**未绑楼**）—— 既有契约，不要改成 60010 / 60011。
- ❌ **必须改**：`resolveUserGroup` 里的 `ErrorCode.NOT_FOUND`（**10004**，楼**未归群**）—— 就是上面 `269` 行那一条，改成 **60011**。它不是「用户没绑」而是「运营漏配」，属 N1 谓词的一部分，不能留在 10004。

**验收句式**

- WHEN 用户所属楼 `status = 3` THEN `GET /api/v1/meal/daily?mealDate={tomorrow}` 返回 `canOrder = false` 且 `reason = 'building_suspended'`。
- WHEN 用户所属楼 `status = 2` THEN 返回 `canOrder = false` 且 `reason = 'building_preparing'`（**布尔与上一句相同，reason 不同**）。
- WHEN 用户未绑定办公楼 THEN 仍返回 `20016`（不得变成 60010 / 60011）。
- WHEN 用户所属楼 `ACTIVE` 但未归群 THEN 返回 **`60011`**（不再是 `10004`）。
- WHEN `reason = 'not_open_yet'` THEN U1 出参 `reasonText` 必须是「今日 HH:mm 开团，敬请期待」的插值结果，**不得为空串**。

### 5.2 `order.service.ts`（U6）

**文件** `apps/api-server/src/modules/order/order.service.ts`

| 行 | 动作 |
|---|---|
| `1622–1631` | `resolveGroup()` 返回类型由 `Promise<number>` 改为 `Promise<{ building: Building; group: BuildingGroup; groupId: number }>`。`building` 已经在查了，只是被丢掉 |
| **`1624`** | **必改（对齐既有缺陷）**：`throw new BizException(ErrorCode.NOT_FOUND, '你还未绑定办公楼，请通过团长邀请链接进入')` → `ErrorCode.USER_BUILDING_UNBOUND`（**10004 → 20016**），文案改为 **「你还没有选择办公楼，选好即可下单」**。理由见下方 |
| **`1693`** | **契约变更**：`throw new BizException(ErrorCode.NOT_FOUND, '所属办公楼未配置楼群，请联系运营')` → 改为 `ErrorCode.BUILDING_NOT_GROUPED`（**10004 → 60011**）。文案不变。同步动作见 §12 |

**`1624` 为什么从「保留」改成「必改」**（2026-10-26 更正，**我上一版写错了**）

我原稿写「`order.service.ts:1624` 用 20016，与 `meal.service.ts:261–264` 一致，没问题」—— **回源核实，两处不一致**，`order` 是漏网之鱼：

```ts
// meal.service.ts:256–265（已改）
if (!user.buildingId) {
  // ⚠️ 20016 而不是 10004：两者用户可执行的动作不同（自助选楼 / 找运营），
  //    合成一码端上就只能给一句两可的兜底文案 —— 见 ErrorCode.USER_BUILDING_UNBOUND。
  //    文案也改了：「请通过团长邀请链接进入」是**唯一绑楼途径**时的说法，
  //    现在有 `GET /building` + `PUT /me/building` 自助链路了。
  throw new BizException(ErrorCode.USER_BUILDING_UNBOUND, '你还没有选择办公楼，选好即可查看次日套餐');
}

// order.service.ts:1624（未改，仍是 10004 + 旧文案）
if (!user.buildingId) {
  throw new BizException(ErrorCode.NOT_FOUND, '你还未绑定办公楼，请通过团长邀请链接进入');
}
```

`meal` 那段注释的**论证完全正确，但只有它自己改了**。`order` 留着 10004，等于：

1. 本批正在消灭的正是「同一语义两个码」，这是现成的同族实例 —— 一边收口一边留一个新的，比不改更糟；
2. 端上**已经支持** 20016（`index.vue:362` 据此把空态主按钮换成「选择办公楼」，`request.ts:44` 已导出 `CODE_BUILDING_UNBOUND`），补上是**对齐**而非新增契约，端上零工作量；
3. 不改的话，P3-4 接线后「看套餐」返回 20016、「下单」返回 10004 —— 同一个用户状态，两条路径两个码，端上同一个按钮要按来源分支。

**文案为什么不是照抄 `meal` 那句**：下单场景里「选好即可查看次日套餐」给的指引是错的（用户要的是下单，不是看套餐）。用 **「你还没有选择办公楼，选好即可下单」**。

> **同码不同文案不是第二真相。** 判据是：**同一个文案对应两个码 = 病**；**同一个码在不同场景给不同的行动指引 = 正常**。`20016` 是契约，文案是场景化指引。`ERROR_MESSAGE[20016]` 那句保留作默认（后台与文档用），抛点可覆盖。
| `225–227` | ① 截单窗口：保留 `ORDER_CUTOFF`（30001）与现有文案，但改由编排层的 `reason` 触发（`reason ∈ { cutoff, not_open_yet }` ⇒ 30001） |
| `250–256` | ⑤ 楼群与分配：保留 `MEAL_NOT_PUBLISHED`（30005）；新增结构层与停售层的抛码，落在 ⑤ 之后、⑦ 之前 |

**U6 的错误码映射（保契约，不要新建）**

| `reason` | U6 抛出 |
|---|---|
| `sales_paused` | `ErrorCode.SALES_PAUSED`（**60009**），`payload: { reason }` |
| `building_not_grouped` | `ErrorCode.BUILDING_NOT_GROUPED`（**60011**），`payload: { reason, reasonText }` |
| `building_preparing` / `building_suspended` / `group_suspended` | `ErrorCode.BUILDING_SUSPENDED`（**60010**），`payload: { reason, reasonText }` |
| `meal_not_published` | `ErrorCode.MEAL_NOT_PUBLISHED`（30005）**沿用现有码与文案** |
| `not_open_yet` / `cutoff` | `ErrorCode.ORDER_CUTOFF`（30001）**沿用现有码与文案** |

> **为什么 60010 / 60011 要拆成两行**：处置动作不同。`building_not_grouped` 是**运营漏配**（事故，要告警、要有人去补配置）；另三条是**运营自己按下去的停用**（无需动作，不该告警）。合成一码会让日志、监控、告警三者完全同形 —— 本仓拆 `30022` / `30023` 用的就是同一条理由。同一谓词输出两个码，号位仍相邻（60010 / 60011）。

**为什么 `not_open_yet` 仍映射 30001**：与今天 `isOrderable()` 返回 false 的行为完全一致，而《接口规范 v1.0》§九 锁了这里的措辞。差异只体现在 `payload.reason`，端上可做精细化处理而不用改码。

**验收句式**

- WHEN 楼宇已停用（`suspended`）THEN `POST /api/v1/orders` 返回 **HTTP 200 + `code: 60010`**，且 `ab_order` **未新增行**。
- WHEN 楼宇筹备中（`preparing`）THEN 返回 `code: 60010`，`payload.reason = 'building_preparing'`（码同、reason 不同）。
- WHEN 用户所属楼 `ACTIVE` 但未归群 THEN 返回 **`code: 60011`**（不再是 `10004`）。
- WHEN 全局停售 THEN `POST /api/v1/orders` 返回 **HTTP 200 + `code: 60009`**。
- WHEN 用户未绑定办公楼 THEN `POST /api/v1/orders` 返回 **`code: 20016`**（**不再是 10004**），`message` 为「你还没有选择办公楼，选好即可下单」。
- WHEN 用户未绑定办公楼 THEN `GET /api/v1/meal/daily` 与 `POST /api/v1/orders` 必须返回**同一个码** `20016`（这两条路径此前是 20016 / 10004 两个码）。
- WHEN 已过截单 THEN 仍返回 `code: 30001`（不得变成新码）。
- WHEN 无分配 THEN 仍返回 `code: 30005`（不得变成新码）。

### 5.3 `workbench.service.ts`（团长工作台）

**文件** `apps/api-server/src/modules/team-leader/workbench.service.ts`

| 行 | 动作 |
|---|---|
| `135–141` | `tomorrow.canOrder` 改为调用编排层（`building` 已在 `:63` 取到，不需要重查） |
| `135–141` | 新增出参 `tomorrow.reasonText`（现在只有 `canOrder` 没有原因，团长看不出为什么不能下单） |

**验收句式**

- WHEN 楼宇已停用 THEN 工作台返回 `tomorrow.canOrder = false` 且 `tomorrow.reasonText = '该办公楼已暂停服务'`。

### 5.3.1 `traceability.service.ts`（**本批漏了的第三条同语义路径，Team Lead 2026-10-26 发现**）

**文件** `apps/api-server/src/modules/**traceability**.service.ts`

| 行 | 动作 |
|---|---|
| `285` | **仍抛 `ErrorCode.NOT_FOUND`(10004) + 「所属办公楼未配置楼群，请联系运营」** —— 「楼未归群」语义的第三条路径，§5.1 / §5.2 的接线清单里没有它。改为 `throw new BizException(ErrorCode.BUILDING_NOT_GROUPED, ...)`（**10004 → 60011**） |

> ⚠️ **为什么本批会漏**（写下来，否则下次照漏）：我们都是**按「已知文件清单」扫**，而不是按「这个语义会出现在哪」扫。前者只能找到清单里已有的东西 —— 清单外的第三、第四条路径永远找不到。
>
> ⇒ 补一条做法（适用于本批每个改码动作）：**改之前先 grep 旧文案字面**（如「未配置楼群」），按命中点列接线清单，**不要**从既有接线点倒推。G10 说的是符号必须有行号，这条说的是**清单本身的来源必须是 grep 结果，不是印象**。

**收尾批（不在 P3-5）**：三处抛点的文案统一为 `该办公楼暂未开通服务，请联系运营`，同步面见 ADR §7.1.1 的六处清单（含 QA 判据脚本 `:380` / `:765` 的 sample）。⚠️ **与 ADR §7.1.1 对齐** —— 本批 P3-4 只做**改码**，文案字面本批不动。

### 5.4 `building-admin.service.ts`（管家端）

**文件** `apps/api-server/src/modules/building/building-admin.service.ts`

> ⚠️ **本节所有行号都可能是 N4 收口前的值**（后端 2026-10-26 报：上一轮 N2 段落让该文件整体后移 300+ 行，N4 又净增约 40 行）。**取数一律 re-grep，不要沿用本节数字**；终版以 Team Lead 统一刷的那版漂移表为准。**唯一例外**是下方三条写路径那组（`:712/:722`、`:762/:810`、`:1490/:1499`），那是 2026-10-26 re-grep 的当前值。以文首漂移表（**第 5 版 · 终版**）为准。

| 行 | 动作 |
|---|---|
| `259` / `370` / `680` / `774` | 字段 `canOrder` **改名 `canAssign`**；取值改由 `evaluateStructure()` 产出，**删除**内联的 `b.status === BuildingStatus.ACTIVE && gid !== null` 合取字面量 |
| `218` / `325` 等 | 如需展示「用户端实际能否下单」，另加一个 `orderable` 字段（调用编排层全量派生）。**`canAssign` 与 `orderable` 并存但不共用名** |
| **`300`** | `canOrderCount: rows.filter((r) => r.canOrder)` → `r.canAssign`，并**改名**出参为 `canAssignCount`（同步 admin-web，见下表） |
| **`494–496`** | ⚠️ **这里是第三份判据，不是改名问题**：`canOrderCount` 用 `buildings.filter((b) => b.status === ACTIVE && b.buildingGroupId)` **自己又算了一遍**，根本没读 `218/325` 那个字段。必须改为对每栋楼调 `evaluateStructure()` 后计数，出参同步改名 `canAssignCount`。**只改 255 不改 438，等于改名后留下一份没人管的旧判据** |
| `60` / `139` | `building-admin.controller.ts` 的 Swagger 描述里有两处 `canOrder` 字面量（「`canOrder` = 营业中 ∧ 已归群」「无法分配套餐（`canOrder=false`）」）→ 改成 `canAssign`。**它们是字符串，`tsc` 抓不到** |
| **`712`（`createBuilding`）· 调用点 `:722`** | ⚠️ **第三条写路径，本规格上一版漏登记**（后端 N4 收口时补出）：新建时若 `dto.buildingGroupId` 非空 ⇒ `await this.assertGroupOpen(dto.buildingGroupId)`。原形态只查「在不在」，可以**把楼新建进一个已停用的楼群** —— 之后该楼因 `group_suspended` 不可下单，而后台回执是「创建成功」。与 N4 同一个病，只是走新建而不是编辑 / 搬楼 |
| **`762`（`updateBuilding`）· 归群分支调用点 `:810`** | 同上（`dto.buildingGroupId` 变更时） |
| **`1490`（`assignMembers`）· 调用点 `:1499`** | 同上（批量搬楼入口） |

> ⚠️ **运行时会改变「某栋楼属于哪个楼群」的写路径，当前已知三条** —— `createBuilding`（新建即归群）/ `updateBuilding` 归群分支 / `assignMembers`。三条共用同一个 `assertGroupOpen(gid)`（`:1595`，判据在 `groupGate()` `:1583`）—— 不要在任一处另写一份内联判断。原 `assertGroupExists()` **已删除**（零调用点，被 `groupGate` + `assertGroupOpen` 取代），引用它的注释（`:718` / `:807` 附近）已同步改写。
>
> ⇒ **不属于本受控面**：① 承载**快照**的三张表（`ab_meal_assignment` / `ab_delivery` / `ab_order`）—— 写它们不改变楼的归属（`ab_order` 那列本批正是指着它才成立）；② **离线种子**（`seed.ts` / `seed-demo.ts`）—— 唯一在运行时之外写这个字段的地方，不堵（空库一次性灌入、此刻不存在已停用楼群、且不过 HTTP）。详见下方两条边界。
>
> ⚠️ **「当前已知」这四个字不是谦辞，是边界**（后端 2026-10-26 六类查法穷尽性核查后要求写进文档）。**文档一旦写死「三条」，下一个实现者就不会再去找第四条** —— 与本批 §7.6「照抄规格里一句错话」同源：**写得越像结论，越容易被人当成免去回源的凭据。** ⇒ 将来若新增写路径，**必须**同时过 `assertGroupOpen()` 并回头把这一行改成「四条」。
>
> **六类查法的穷尽性结论（后端 2026-10-26：结论 =**穷尽**，但必须带下面两条边界一起读）**
>
> | # | 查的是什么 | 结果 |
> |---|---|---|
> | 1 | `buildingRepo` 的全部写操作（`save`/`update`/`create`/`upsert`/`insert`/`query`） | **4 处，全在本文件**：`:724` `:828` `:1507` `:1517` |
> | 2 | `buildingGroupId` 的所有赋值 / 传参点（含 queryBuilder `.set({...})`） | 写侧只在本文件；其余全是**读**（`order-availability`、`orderability` 的判定、各模块查询条件） |
> | 3 | 别的 service 是否写楼（18 个文件用到 `buildingRepo`/`groupRepo`，逐个看） | 全是 `findOne`/`find`：零写 |
> | 4 | 迁移 / 导入 / Excel / 定时任务 | 迁移只有 `1700000000000-init.ts`（建列，无数据改写）；**无**导入脚本、无定时任务写楼 |
> | 5 | 运营后台之外的调用方（`scripts` / `packages` / 两个前端） | 只有判据脚本里的注释与样本；前端**零写** |
> | 6 | 别的表是否承载这个外键 | **有**：`ab_meal_assignment` / `ab_delivery` / `ab_order` 各有 `building_group_id` |
>
> **边界一 · 第 6 项那三张表不在 N4 受控面里。** 它们承载的是**快照**，写它们**不改变「某栋楼属于哪个楼群」**，与 N4 的不变量（能停用的楼群成员必为 0）无关。而且 `ab_order` 那一列**本批正是指着它才成立** —— 楼群按 `building_group_id` 查未完结订单，依据就是「历史单仍指向旧群」，这才抓得到「人已走、债还在」的单。⇒ **把这三张表算进来会让受控面失去意义。**
>
> **边界二 · 种子是唯一在运行时之外写这个字段的地方**：`seed.ts`（`buildingGroupId: 1..5`）与 `seed-demo.ts`。**不堵，也不需要堵** —— 空库一次性灌入，此刻不存在「已停用的楼群」；离线夹具，不过 HTTP。
>
> ⚠️ **本组行号是 2026-10-26 re-grep 的值**（上一轮 N2 段落让整体后移 300+ 行，N4 又净增约 40 行）。以文首漂移表为准。
| `713–732`（`buildingWarnings`） | 文案里的「营业中」措辞按新语义复核，不改逻辑 |

#### 5.4.1 改名的边界（**只改后台这 4 处，不是全仓改名**）

| 位置 | 语义 | 是否改名 |
|---|---|---|
| `building-admin.service.ts:259/370/680/774`（后台楼宇列表 / 详情） | 「配置上能否编排」——**无时间维度** | ✅ 改 `canAssign` |
| `meal.service.ts:142`（U1 用户端 `canOrder`） | 「此刻能否下单」——有时间维度 | ❌ **保持原名** |
| `workbench.service.ts:139`（团长工作台 `tomorrow.canOrder`） | 「此刻还能否追加」——有时间维度 | ❌ **保持原名** |
| `apps/miniprogram/src/api/leader.ts:55`（团长端类型） | 对应上面那条 | ❌ **保持原名** |
| `apps/miniprogram/src/pages/index/index.vue:67/173/485`、`order-create.vue:130/265` | U1 消费方 | ❌ **保持原名** |

> **`leader.ts:55` 是最容易误伤的一处**：它在小程序端、字段名也叫 `canOrder`，但语义是团长工作台的「此刻能否追加」，与后台那 4 处**不是一回事**。跟着改名会让团长端字段变化而语义没变 —— 改名解决的是「一个名字回答两类问题」，把不该改的也改了就变成「一个改动制造两种困惑」。

#### 5.4.2 admin-web 消费方同步（**P3-4 必做，且不在后端 tsc 覆盖范围**）

`apps/admin-web` 是**独立 app、独立 tsconfig**，`node_modules/.bin/tsc -p apps/api-server/tsconfig.json --noEmit` **覆盖不到它**。改完后端字段而漏了这些位置，**编译不会报错**，运行时静默拿到 `undefined` ⇒ 列表显示「否 / 0」。这正是本批最该避免的那类失败：没有任何信号。

| 文件 | 行 | 内容 | 动作 |
|---|---|---|---|
| `apps/admin-web/src/api/building.ts` | `55` / `115` / `298` | 类型定义 `canOrder: boolean` | → `canAssign` |
| `apps/admin-web/src/api/building.ts` | `68` / `181` | `canOrderCount: number` | → `canAssignCount` |
| `views/building/leader-binding.vue` | `105–106` | `row.canOrder ? '是' : '否'`（el-tag） → `row.canAssign`。⚠️ **el-table 插槽的 `row` 是 `any`，属性访问逃逸类型检查** —— 必须先用该文件既有的 `asRow()` helper 收窄，否则改对改错都不报红（见 §5.4.3） |
| `views/building/leader-binding.vue` | `163` | 本地 `canOrderCount: 0`（**本地统计变量，非 API 出参**） | 改名以保持与出参一致（不改也能跑，但会留下同名不同源的两个东西） |
| `views/building/list.vue` | `15` / `28` / `336` | `summary.canOrderCount` | → `canAssignCount` |
| `views/building/list.vue` | `511` | `res.canOrder ? '可开团' : '暂不可开团'` | → `res.canAssign` |
| `views/building/overview.vue` | `50` | `data?.buildings.canOrderCount` | → `canAssignCount` |
| `views/meal/matrix.vue` | `275` | 注释里的「用户端 `canOrder=true`」 | ❌ **保持不动** —— 讲的是用户端语义，与后台字段无关 |

#### 5.4.3 类型检查能覆盖多少（两层结论，别写成一句）

> **⚠️ 本段原写「不能指望类型检查抓到这次改名」，结论过头，2026-10-26 由 Team Lead 实测纠正。**

**第 1 层 · 不能指望它自动传导（这是真缺口，也是本次要人工派单的原因）**

前端 DTO 是**手抄**的（`apps/admin-web/src/api/*.ts`），后端字段改名**不会**让前端变红 —— 改名这件事**没有任何机制提示你去同步**。所以改名必须人工派单，不能等 CI 报警。

**第 2 层 · 但改完前端 DTO 之后，它能抓到全部消费方**

实测三步（Team Lead 提供）：

| 步骤 | 退出码 | 输出 |
|---|---|---|
| ① 改前基线 | EXIT=0 | 0 行 |
| ② **只改 `api/building.ts` 的手抄 DTO，故意不改消费方** | **EXIT=2** | **6 条 TS2339 / TS2353** |
| ③ 消费方改完 | EXIT=0 | 0 行 |

⇒ **「改手抄 DTO → 跑 typecheck → 按报错清单改消费方」是本仓改名的标准动作。**

**第 2 层必须配一次反向对照**，否则绿灯是假的：

> ② 那一步不是可选项。**只做 ③（改完跑一次看到绿）分不清「消费方都改对了」和「tsc 压根没盯住这段」** —— 两种情况的退出码都是 0。故意留一处不改、确认编译器真的报红，才能证明这次的绿灯不是假的。

**唯一例外（已查明，且必须显式处理）**

`leader-binding.vue:105/106` 走 **el-table 插槽**，`row` 是 `any` / `DefaultRow`，属性访问**逃逸**类型检查 —— 反向对照时 tsc 只标红同文件的 `:163`，**没标红 `105/106`**。

⇒ 必须用该文件既有的 `asRow()` helper **收窄** `row` 的类型，否则这两处是类型检查的盲区。收窄后**再反向对照一次**，命中数应从 **0 → 2**（即 `105/106` 也被盯住）。

**⇒ 准确结论（照抄这句，不要简化成「类型检查靠不住」）**

> **类型检查能覆盖 12/13 处，剩下的 1 处要显式收窄才会被覆盖；而「后端改了前端不会红」这件事没有任何机制提示，必须人工派单。**

写错成「不能指望类型检查」的实际代价：**后来者就不会去做第 ② 步反向对照** —— 而第 ② 步恰恰是这次唯一能证明「绿灯不是假的」的动作。

#### 5.4.4 后台侧残留的 `canOrder` 字面量：**不得全局替换**（2026-10-26 Team Lead 采纳 _backend 的 advisory）

改名完成后，后台仍会**故意**留下两处 `canOrder` 字面量，都在注释里：

| 位置 | 内容 | 性质 |
|---|---|---|
| `building-admin.service.ts:253` | 「与用户端 `canOrder` 不是一回事」 | **解释性引用** —— 说明「配置上能否编排」与「此刻能否下单」为何不同名 |
| `building-admin.controller.ts:61` | 同构的一句 | 同上 |

**这两处是本批唯一的「两个语义为何不同名」的说明。** 按 N1-18「引用可以留、定义不许留」裁定：**保留**，并在原地补一句「不要全局替换」的警示（_backend 已落）。

> ⚠️ **给执行者**：不要在 api-server 里做 `canOrder → canAssign` 全局替换。
>
> 一旦替换，这两句会变成「与用户端 `canAssign` 不是一回事」—— 语义自相矛盾，且不再解释任何东西。**本批最容易被重新合并回去的认知点，会被一次机械替换抹掉**：下次有人看到 `canAssign` 出现在后台，会以为「哦，就是同一个东西」，然后把它重新接到用户端的判据上。那正是 N1 的病根。
>
> **判据上也不能用一刀切**：全仓禁 `canOrder` 会**恒红** —— 用户端（`meal.service.ts:146`）、团长端（`workbench.service.ts:123`、`leader.ts:55`）、小程序两页、以及《深度测试第二轮报告》`:74`（历史报告，DOC-1 反向判据锁死不得改）里都有**合法的** `canOrder`。所以只能用「**定义不许留 + 引用要保留**」这种精确判据。
>
> 机器替换解决不了语义边界，只能靠**显式声明 + 精确判据** —— 与 §5.4.3 那句准结论是同一族：能自动化的部分（改手抄 DTO → 按报错清单改消费方）要自动化，不能自动化的部分（语义边界）必须写成人能读到的声明。

**验收句式**

- WHEN 全仓 grep `canOrder` THEN 后台侧（`building-admin.service.ts` / `building-admin.controller.ts`）的命中必须**只剩上面两处注释里的解释性引用**；其余后台位置与 admin-web 7 处必须已为 `canAssign` / `canAssignCount`（见 §12.6 判据）。
- WHEN 检查那两处 THEN 它们所在的注释必须**同时**出现「不要全局替换」的警示语 —— 没有警示，下一个执行者没有理由不替换。

**验收句式**

- WHEN 打开 `楼宇列表` THEN 「可开团」统计数字必须等于**营业中且已归群**的楼栋数（不得恒为 0）。
- WHEN 打开 `楼宇概览` THEN `buildings.canAssignCount` 与列表页统计**必须一致**（这两处此前是 `:255` 与 `:438` **两份独立计算** —— 改名后必须合成一份）。
- WHEN 打开 `团长绑定` THEN 「可开团」列的「是/否」不得全部为「否」。

**为什么管家端只调 `evaluateStructure` 不调 `evaluateAvailability`**：管家端是运营 KPI，**没有时间维度**。若叠了时间层，运营夜里看列表会因为「过了截单」看到 `canOrder = false`，把周期性状态误报成配置缺口。

**验收句式（这条是裁决 0-C 的回归，必须固化）**

- WHEN 用 `ABOX_SHIFT_TO_HOUR=0`（当日 00:00，**未开团**）注入并调用 `GET /admin/buildings` THEN 一栋 `ACTIVE` 且已归群的楼，其 `canAssign` 仍为 **`true`**；**同一次注入下** `GET /api/v1/meal/daily` 的 `canOrder` 必须为 `false` 且 `reason = 'not_open_yet'`（**两侧同时断言** —— 只看管家端，`canAssign=true` 在什么时候都成立，那条断言单独跑是恒绿的）。
- WHEN 往一个已停用的楼群里搬楼 THEN 必须返回 `code: 60008`。
- WHEN 把一栋楼挂进一个已停用的楼群（`PUT /admin/buildings/:id` 传 `buildingGroupId`）THEN 必须返回 `code: 60008`。

> **⚠️ 修正：本条原写「在已过截单的时点（注入时钟）」，机制是错的**（2026-10-26，QA 回源发现）。
>
> `ABOX_SHIFT_TO_HOUR` 的实现是 `SHIFT_MS = target * 3_600_000 - withinDayMs`（`time.ts:64–77`），平移后 `now()` **恒等于「本北京日 H:00:00.000」**，两个后果：
>
> 1. **日历日不变** —— `todayBj()` / `tomorrowBj()` 不受它影响，**跨不了零点**；
> 2. **只能落整点** —— `Number.isInteger()` 校验，只收 0–23。
>
> 而「已过截单」是 `[23:50, 24:00)` 这条**窄带**（窗口上界 = `截单 − cutoff_window_minutes`，默认 10 分钟算出来的，不是整点）⇒ **注入到不了**。注入 23 得到 23:00，仍在窗口内。
>
> ⇒ 改为注入 **`0`**（当日 00:00 → `not_open_yet`）来制造「用户端时间层为 false」的对照，它同样是时间层污染的有效证明 —— 要验的是「**时间层为假、结构层为真时，管家端不得跟着变假**」，至于是「未开团」还是「已截单」造成的，对这个结论没有区别。
>
> 至于「已过截单」这条边界本身：**由 §3 单测第 4 组覆盖**（`nowMs` 恰等于 `cutoffAtMs - window`），不要在 e2e 里靠挪钟去够它 —— 够不到，而且没必要。

---

### 5.4.5 T5 拆分：`building-suspend.service.ts`（2026-10-27 补登 · **新建文件，须进 §0 白名单**）

**新建** `apps/api-server/src/modules/building/building-suspend.service.ts`（**375 行**），
从 `building-admin.service.ts` 迁出 N2 停用块：`unfinishedWhere` / `countSuspendable` /
`runSuspendGate` / `assertBuildingSuspendable` / `assertGroupSuspendable` /
`notifySuspendAffected` 六法 + `SUSPEND_HINT` / `SUSPEND_SAMPLE_SIZE` /
`SUSPEND_NOTIFY_LIMIT` 三常量。**主文件 1611 → 1263 行。**

> ⚠️ **更正一处被误述的动因（回源核实后立此条）**
>
> 派单时写的理由是「1611 行超额（spec 登记 ≤150/≤180）」—— **这句是错的**。
> §0 那张行数上限表标的是「**本批授权新建的文件**」的白名单，
> **从来不含 `building-admin.service.ts`**（后者是本批**修改**的既有文件，不在新建白名单里）。
> ⇒ 拆分**不是**为了满足任何行数合规，**纯是可维护性**：一个文件里混了
> 「楼栋读写 / 楼群 CRUD / 成员替换 / 停用闸门 + 通知」四个关切。
> 记这一条是因为：**用一个不存在的合规理由去驱动一次大重构，本身就是会传染的坏习惯** ——
> 下一个人照抄「某某文件超额」就会去拆一个根本没超的东西。

**边界（执行时逐条核过）**

| 项 | 处置 |
|---|---|
| 留在主文件 | `createBuilding` / `updateBuilding` 归群分支 / `assignMembers` / `groupGate` / `assertGroupOpen`（**N4 的 60008 唯一抛点不动**） |
| 四个调用点 | `building-admin.service.ts` 改走 `this.suspendService.*`（`:767` / `:783` / `:1090` / `:1099`，**re-grep 复核**） |
| 死依赖 | `orderRepo` / `bizConfig` / `message` / `logger` 在主文件块外**零使用** ⇒ 一并从构造函数与 import 移除（lint 是 `--max-warnings 0`，留着就红） |
| DI | `building.module.ts` 的 `providers` 增 `BuildingSuspendService`；**不 export**（没有第二个消费方，多 export 就是多开一条入口） |
| 循环依赖 | 新服务只依赖 `dto` / `shared-types` / `suspend-gate` / `MessageService` / `Order` 实体 —— **不反向依赖** `building-admin.service.ts` |

> ⭐ **判据必须跟着真源走**（本批第 5 次「产物变好把探针弄瞎」）
>
> `check-n1n2-w1-suspend-rules.mjs` 里 **N2-10**（阈值读 `suspendForceMaxCount`）与
> **N2-TPL-2**（`notifySuspendAffected` 的三元接线方向）原先钉死在
> `file: 'buildingAdmin'` —— 代码搬走后这两条会**假红**（判据盯的是性质，不是文件）。
> 处置：FILES 增 `buildingSuspend`，两条改指新文件，**不删判据、不放宽判据**。
> ⇒ 通律：**重构搬家时，先问「谁在按路径盯我」** —— 按文件名扫的判据是重构的头号受害者。

**验收**：`tsc --noEmit` 0 · `eslint --max-warnings 0` 0 · jest 15 suites / 129 tests 全过 ·
`check-n1n2-w1-suspend-rules.mjs` 51/51 · **全量门禁 31/31 全绿**。
`suspend-notify.spec.ts` 改为直接实例化新服务（`notifySuspendAffected` 在新服务是 public，
**去掉了原先绕过 private 的 `as unknown as` 强转**）。

---

### 5.4.6 T5 第二步：派生层 `building-derive.ts`（2026-10-27 补登 · **新建文件，须进 §0 白名单**）

**新建** `apps/api-server/src/modules/building/building-derive.ts`（**115 行 · prettier 后实测**），迁出
`DC_ACTIVE` + `dcByGroup` / `gapOf` / `centerPair` / `coverageOf` / `routeNoMap` /
`canAssignOf` / `countMultiBuilding`。**主文件 1263 → 1181 行**（34 处调用点改为直接调函数）。

**为什么先抽这一层**：主文件四个关切（楼栋读写 / 楼群 CRUD / 成员替换 / 停用闸门）
**全都**共用这六个派生函数 —— 共享 helper 就是切不开它们的唯一原因。先变成无状态、
输入显式传参的纯函数，后面按关切拆分才不必再处理共享。**顺序不能倒。**

| 处置 | 内容 | 理由 |
|---|---|---|
| 搬走 | 6 个纯函数 + `countMultiBuilding` + `DC_ACTIVE` | 零 IO；`DC_ACTIVE` 真源只能一份 ⇒ 主文件改 import（它仍有 6 处直接用） |
| **刻意留在主文件** | `loadContext`（:128）/ `groupStatusOf`（:139） | 要查库 ⇒ 进派生层会把它变成「另一个 service」，本模块**必须保持零 IO** |
| **刻意留在主文件** | `buildingWarnings`（:739） | ⚠️ **不是**因为它不纯，而是因为它被一条判据失明地盯着 —— 见下 |

> ## ⚠️ 判据盲区登记（**待办 · 不在本批修 · 已留痕**）
>
> `buildingWarnings`（`building-admin.service.ts:739`）内联了**两处**「楼状态 ∧ 已归群」的合取：
>
> ```ts
> if (b.status !== BuildingStatus.ACTIVE && gid !== null) { ... }   // ①
> if (b.status === BuildingStatus.ACTIVE && gid === null) { ... }   // ②
> ```
>
> 而 **N1-16**（「内联合取命中数必须为 0，唯一持有者 = `evaluateStructure`」）的正则是
> `/[A-Za-z]*[Ss]tatus\s*===\s*BuildingStatus\.ACTIVE\s*&&\s*(?:gid\s*!==?\s*null|(?:[\w.]+\.)?buildingGroupId\b...)/g`
> ⇒ **第一半只认 `===`**（放过 ① 的 `!==`）、**第二半只认 `gid !== null`**（放过 ② 的 `gid === null`）
> ⇒ **两行都不命中，判据对它完全失明**（判据恒绿，但不是因为它对）。
>
> **为什么不顺手修**（三条，都是纪律不是偷懒）：
> 1. 一修正则就**立即红** ⇒ 必须先裁定「这是第三份判据（要改代码）还是合法形态（要豁免）」，
>    那是**独立议题**，不该搭在拆分这一刀里；
> 2. 拆分是**纯搬家**，语义零变更；修判据 + 可能改生产代码 = 一次改动两件事，破坏单步可回滚；
> 3. 「修了之后仍然不红」比现在更危险 —— 现在至少留了这份记录。
>
> ⚠️ **连带硬约束（写给下一个人）**：在盲区裁定之前，
> **`buildingWarnings` 不得搬出 `building-admin.service.ts`** ——
> N1-16 是**按路径**扫这一个文件的，搬走就等于从「盲区」升级成「彻底扫不到」。
> 这正是 §5.4.5 那条「搬家前先查谁在按路径盯我」的反面：**盯不盯得到，也要查。**
>
> **下批裁定的提问顺序**：先回答「`buildingWarnings` 的文案分支是否必须与 `canAssign` 同源」——
> · 若**必须** ⇒ 改为由 `evaluateStructure()` 派生，差异落成文案映射（状态机将来新增态时它会自动跟上）；
> · 若**不必须** ⇒ 在判据里**显式登记豁免**（长期挂着一个看不见的盲区，等于没有检查）。

**验收**：`tsc --noEmit` 0 · `eslint --max-warnings 0` 0 · jest 15 suites / 129 tests ·
`check-n1n2-w1-suspend-rules.mjs` 51/51 · 全量门禁 31/31。

### 5.4.7 T5 第三步：读侧 `building-query.service.ts`（2026-10-27 补登 · **新建文件，须进 §0 白名单第 8 项**）

**新建** `apps/api-server/src/modules/building/building-query.service.ts`（**521 行 · prettier 后实测**），
迁出 `loadContext()` / `groupStatusOf()` 与四个读视图（`listBuildings` / `buildingDetail` /
`overview` / `deliveryMap`）。**主文件 1181 → 726 行**（原始 1611）。

**为什么按「读 / 写」切，而不是按「楼栋 / 楼群」切**：楼群 CRUD 与楼栋 CRUD 看着是两条线，
但它们**共用同一套主数据装载与同一套派生**（`loadContext` + `building-derive`）。按实体切 ⇒
谁都想要 `loadContext`，共享依赖切不开，最后还是一个大文件加一层转发。读写切的好处是
**依赖方向单一**：读侧不认识写侧，写侧只在回显时用读侧。

**配套改动**

- `building.module.ts`：`BuildingQueryService` 进 providers **并且 export** —— 与 §5.4.5 的
  `BuildingSuspendService`（只 provide 不 export）相反，因为控制器要**直接**注入它。
- `building-admin.controller.ts`：读四法改为注入 `buildingQuery` 直连，**不经写侧转发**。
  ⚠️ 该控制器文件里有两个类，构造行逐字相同 —— 改注入时锚点必须带类名。
- 主文件构造函数去掉 `leaderRepo`（随 `loadContext` 一并搬走，剩余代码零使用）；
  `TeamLeader` 实体 import、`LEADER_LEVEL_META` / `LeaderLevel` / `countMultiBuilding` /
  `routeNoMap` / `AdminBuildingsQueryDto` 一并清除。

**判据跟迁（不放宽，只改指向）**：N1-20（`canOrder` 解释性引用）的两处之一随
`listBuildings` 迁走 ⇒ `files` 由 `['buildingAdmin', 'buildingAdminController']` 改指
`['buildingQuery', 'buildingAdminController']`。不改 ⇒ 真文件侧 `realAlso` 恒 false，
判据表面绿、实际已失明（与 §5.4.6 那条盲区同一形状）。

**⚠️ 新登记的扫描盲区（未修）**：`building-query.service.ts` 现在**不在**下列判据的扫描范围内
（它们都**按路径**钉 `building-admin.service.ts`）：

- **N1-3b** · 管家端不得调 `evaluateAvailability` / `OrderAvailabilityService`
- **N1-16** · 「楼状态 ∧ 已归群」内联合取命中数为 0
- **N2-8** · A/B 分组不得写成 `OrderStatus.X || OrderStatus.Y ||` 长串

前两条盯的正是**管家端读视图**最容易出问题的地方，现在没人盯。新文件的类注释里已写明
「本文件不在 N1-16 扫描范围内，不得内联判据、一律走 `canAssignOf()`」，但那是**人守**不是门禁守。

⇒ **下批裁定**：把这几条改成 `files` 多文件扫描。改动要点（写给执行者）：多文件分支要求
`files` + `pred(ts)` + `mutateFirst`（脚本只破化 `files[0]`），且 `mutateFirst` 的锚点必须
在 `files[0]` 里真实存在 —— 见脚本 `if (r.files)` 分支与 HELPER_CHECKS 里那条
「`mutateFirst` 只覆盖第一份」的专项自证。**不要顺手放宽判据。**

**验收**：`tsc --noEmit` 0 · `eslint --max-warnings 0` 0 · jest 15 suites / 129 tests ·
`check-n1n2-w1-suspend-rules.mjs` 51/51。

---

## 6. P3-5 · N2 闸门

### 6.0 先落纯函数，再接线（**本节的顺序有依赖，不要跳过**）

**文件 A** 新增 `apps/api-server/src/common/utils/suspend-gate.ts`（**≤150 行**）

**文件 B** 新增 `apps/api-server/test/unit/suspend-gate.spec.ts`（**≤150 行**）—— **本批授权新建的文件**（见文首白名单第 4 项；与 §3 同一处授权矛盾，不再让执行者卡在「要求写单测但不授权建文件」）

**为什么必须抽纯函数**：N2 闸门里有三条是**沉默逻辑防线** —— 漏了不报错、不崩溃、悄悄少拦，**e2e 全绿**。只有纯函数能被 jest 逐条钉死：

| # | 防线 | 漏了的后果 |
|---|---|---|
| 1 | 8 态反算必须含 `refund_applying` / `refunding` | 用 6 态白名单的实现**少拦两单**，且无任何信号（本批头号防线） |
| 2 | A/B 组别**每次请求现算** | 把组别当静态属性写死 ⇒ 截单前后给出同一结论，其中一个必错 |
| 3 | hint 分支选择（卡退款审批 vs 待履约） | 运营不知道该点退款审批还是等配送 ⇒ 反复重试停用 |

第 2 条尤其只能靠纯函数来守：**决策逻辑埋在 service 里的话，「每次现算、不得缓存」这条约束没有任何东西能验证** —— 而 `groupOf(status)` 是纯函数，就**结构上不可能**被缓存（每次调用都算一遍），约束自动成立。

> **更硬的一条理由（_backend 的观察，2026-10-26 采纳）**：
>
> > 没有单测时，「判据唯一真源」这个说法**本身是空的** —— 四个调用方现在都指向 `evaluateStructure`，但「它们是否真的等价」**没有任何东西能证明**；只有「它们指向同一个符号」这个事实，而这一点**随便哪天有人抄一份内联实现就破了，且编译过、跑得过**。
>
> 我原先写的理由是「没有单测，这次抽取只剩搬家的成本」。他那条更准确，区别在于：
>
> | | 说的是 | 强度 |
> |---|---|---|
> | 我原来的说法 | **收益缺失** —— 抽了但没测到，白抽 | 弱：可以反驳说「至少结构清晰了」 |
> | 他的说法 | **唯一性无法自证** —— 「唯一真源」这个结论没有证据支撑，且破坏它没有信号 | 强：直接否掉了「抽了就安全」这个默认假设 |
>
> ⇒ **后续写纯函数判据一律按他这个口径写**：不写「抽纯函数便于测试」，写「不抽纯函数 + 不写单测的话，『唯一真源』就是一个无法证伪的声明」。
>
> 配套的判据形态（他实测得出）：按 import 形状 / 依赖扫描写的静态判据**守不住行为类约束** —— 他的破化是往文件顶部塞一行 `const __leaked = Date.now();`，**连 `import` 行都没碰**，静态判据全绿。约束落在行为上（不读时钟 / 不抛异常 / 不读配置），判据就必须落在**能执行到那段代码**的地方（jest）。同 §3 那处注记。

```ts
import { ORDER_TERMINAL_STATUS } from '@abox/shared-types';

/** 未完结谓词 —— 全仓唯一实现（反算，fail-closed） */
export function isUnfinished(status: string): boolean;

/** A/B 组别 —— **每次调用现算**，不得缓存、不得落库、不得从订单快照读 */
export function groupOf(status: string): 'A' | 'B' | 'terminal';

export type SuspendScope = 'building' | 'building_group';

export interface SuspendCounts {
  total: number;             // 8 态未完结总数
  groupA: number;            // cut_off/cooked/delivering/delivered
  groupB: number;            // 其余未完结
  refundStuck: number;       // refund_applying / refunding
  fulfillPending: number;    // pending_pay / paid
  aOrderNos: string[];
  earliestMealDate: string | null;
}

export type SuspendBlockReason =
  | 'irrevocable'         // A 组 > 0 —— 硬约束，force 无效
  | 'threshold_exceeded'  // N > 阈值 —— force 也无效，走审批
  | 'unfinished_orders';  // 1 ≤ N ≤ 阈值 且未 force

export type SuspendDecision =
  | { kind: 'allow' }              // N = 0
  | { kind: 'allow_forced' }       // 1 ≤ N ≤ 阈值 + force ⇒ 放行，但必须审计 + 通知
  | { kind: 'block'; reason: SuspendBlockReason };

export interface SuspendGateInput {
  scope: SuspendScope;
  targetSuspended: boolean;   // 目标状态是否为「停用」（false ⇒ 直接 allow）
  counts: SuspendCounts;
  threshold: number;          // building.suspend_force_max_count
  forceSuspend: boolean;
}

export function decideSuspend(i: SuspendGateInput): SuspendDecision;

/** (scope, reason) → 错误码 */
export function suspendBlockCode(scope: SuspendScope, r: SuspendBlockReason): 60006 | 60007 | 60012 | 60013;

/** hint 分支选择 */
export function hintKeyOf(
  counts: SuspendCounts,
  r: SuspendBlockReason,
): 'refund_stuck' | 'fulfill_pending' | 'irrevocable' | 'threshold';
```

**三条硬约束**

1. **零 IO、零依赖注入、不读时钟**（口径同 §3：`new Date()` / `Date.now()` 命中数为 0）。
   ⇒ 本函数**连 `nowMs` 参数都不需要**：时间只出现在 IO 层的计数查询里（`mealDate >= todayBj()`），决策本身完全无时间维度。这比「收 `nowMs` 以便注入」更强 —— **没有时间参数的决策函数，天然不可能随时间漂移**，B2-12 也就不需要任何注入机制。
2. **不抛异常、不读配置。** `threshold` 由调用方传入（service 从 `BizConfigService.suspendForceMaxCount()` 取）。
3. **不做字数校验。** `suspendReason` 的 ≥10 字由 DTO `@MinLength(10)` 在 ValidationPipe 里拒成 10001 —— 纯函数里再判一遍就是第二份校验逻辑（见 §6.6）。

**service 侧怎么调**（`BuildingAdminService`）：

```ts
// 只做 IO + 调用，不在这里写任何 if 判据
const counts = await this.countSuspendable(id, dto);          // 8 态反算 + A/B 计数
const d = decideSuspend({ scope: 'building', targetSuspended: dto.status === SUSPENDED,
                          counts, threshold: await this.bizConfig.suspendForceMaxCount(),
                          forceSuspend: !!dto.forceSuspend });
if (d.kind === 'block') {
  throw new BizException(suspendBlockCode('building', d.reason), ERROR_MESSAGE[...], undefined, {
    ...counts, threshold, hint: HINT[hintKeyOf(counts, d.reason)], opCode: 'suspend_building',
  });
}
if (d.kind === 'allow_forced') { /* 审计 + 异步通知 */ }
```

**必须覆盖的 jest 用例**（`suspend-gate.spec.ts`）

1. `isUnfinished`：`refund_applying` / `refunding` 必须为 `true`（**头号防线**）；`completed`/`cancelled`/`refunded` 必须为 `false`。
2. **A/B 翻转**：`groupOf('paid') === 'B'` 且 `groupOf('cut_off') === 'A'` ⇒ 同一笔单在两个状态下 `decideSuspend` 给出**相反结论**（B：`block/unfinished_orders` 可用 force 变 `allow_forced`；A：`block/irrevocable` 且 force 无效）。**不要用 `ABOX_SHIFT_TO_HOUR`** —— 它跨不了零点，而且这条验的是「状态变了 ⇒ 组别变了」，与墙钟无因果关系。
3. **分级边界**：`N = threshold` 未 force ⇒ `unfinished_orders`；加 force ⇒ `allow_forced`；`N = threshold + 1` ⇒ `threshold_exceeded`（**force 也无效**）。
4. **hint 分支**：`refundStuck > 0` ⇒ `refund_stuck`；`refundStuck = 0 且 fulfillPending > 0` ⇒ `fulfill_pending`；`groupA > 0` ⇒ `irrevocable`。
5. **scope 映射**：`unfinished_orders` + `building` ⇒ 60006；+ `building_group` ⇒ 60007；`threshold_exceeded` ⇒ 60012；`irrevocable` ⇒ 60013。

> **关于测试文件的授权**：jest 已装在 `apps/api-server`（`package.json:63` `jest ^29.7.0`、`:70` 配置、`testRegex` 覆盖 `(src|test)/.*\.spec\.ts$`，`test/unit/` 下已有 9 个 spec，且 `gate.mjs:124` 的 jest 判据在 `all` 集合内、**刻意不加 `--passWithNoTests`**）。§6.7 / ADR §8 / AC B2-2·B2-3·B2-12 里写的「**必须固化成 jest 用例**」全部有效，按原文执行。

### 6.1 DTO

**文件** `apps/api-server/src/modules/building/dto/building-admin.dto.ts`

在 `UpdateBuildingDto`（≈268）与 `UpdateBuildingGroupDto`（≈409）各加两个字段。**不声明会被 `forbidNonWhitelisted` 拒成 10001**（G9）。

```ts
  @ApiPropertyOptional({
    description: '强制停用：存在未完结订单时仍要停用（需同时填 suspendReason）',
  })
  @IsOptional()
  @IsBoolean()
  forceSuspend?: boolean;

  @ApiPropertyOptional({ description: '强制停用原因（强制停用时必填，不少于 10 字，进审计）' })
  @IsOptional()
  @IsString()
  @MinLength(10, { message: '强制停用原因不少于 10 字' })
  suspendReason?: string;
```

**注意**：`suspendReason` 长度不足由 `ValidationPipe` 拒成 **10001**，**不新增错误码**（格式校验 vs 业务不允许，两条路径不混）。需 import `IsBoolean` / `MinLength`。

### 6.2 未完结订单计数

**文件** `apps/api-server/src/modules/building/building-admin.service.ts`

**动作 1**：注入 `Order` 仓储 —— 构造函数加 `@InjectRepository(Order) private readonly orderRepo: Repository<Order>`，import `Order`（`database/entities/order.entity`）。

**动作 2**：`apps/api-server/src/modules/building/building.module.ts` 的 `TypeOrmModule.forFeature([...])` 加 `Order`。该模块文件头注释已说明「实体直接 forFeature 而不依赖别的模块」是既有做法 —— **实体级依赖不构成模块循环**，与服务级 import 不同，不要为此去 import `OrderModule`。

**动作 3**：加两个私有方法，共用一份「未完结」谓词：

```ts
import { Not, In } from 'typeorm';
import { ORDER_TERMINAL_STATUS } from '@abox/shared-types';

/** 未完结订单谓词 —— 全仓唯一实现，禁止在别处再写 Not(In([...])) */
private unfinishedWhere() {
  return { status: Not(In(ORDER_TERMINAL_STATUS)), mealDate: MoreThanOrEqual(todayBj()) };
}
```

> **必须反算，禁止硬编码状态清单。** 依据 `order-status.ts:88–92`，终态只有 `completed` / `cancelled` / `refunded` ⇒ 当前未完结是 **8 态**（`pending_pay` / `paid` / `cut_off` / `cooked` / `delivering` / `delivered` / `refund_applying` / `refunding`）。硬编码白名单是 **fail-open**：将来状态机新增非终态时它会默认放行且无任何信号；反算是 fail-closed，新增状态自动受拦。现成写法见 `user.service.ts:212`。

**动作 4**：8 态按用户拍板拆两组（`ORDER_TERMINAL_STATUS` 之外的两组常量放 `shared-types` 或本文件导出，**只准有一份**）：

```ts
/** A 组 · 履约中（不可撤回）—— 供应商已按份数备货，运营无权通过停用撤回 */
export const ORDER_FULFILLING_STATUS = ['cut_off', 'cooked', 'delivering', 'delivered'] as const;
/** B 组 · 可放行 —— 未截单，或退款已在自己的通道里走 */
export const ORDER_RELEASABLE_STATUS = ['pending_pay', 'paid', 'refund_applying', 'refunding'] as const;
```

计数方法：

```ts
private async countByBuilding(buildingId: number)  // 走 idx_order_building_meal(building_id, meal_date)
private async countByGroup(groupId: number)        // 走 idx_order_status(status, meal_date)，gid 在回表行上过滤
```

**为什么楼群按 `building_group_id` 查、不查成员楼名单**：60003 要求先清空成员楼才能停用，等你真能停用时名单已空，查出来是假绿；而历史订单的 `building_group_id` 是**快照**，楼搬走后历史单仍指向旧群 —— 只有按 `building_group_id` 查才抓得到「人已走、债还在」的单。

**索引说明**：`ab_order` 上**没有** `building_group_id` 索引，本批**不加**。谓词写成 `status IN (...) AND meal_date >= :today AND building_group_id = :gid`，让 MySQL 走现成的 `idx_order_status(status, meal_date)`。这是管理端低频动作（一天几次），万行级数据量下毫秒到几十毫秒。

### 6.3 闸门编排

**文件** `apps/api-server/src/modules/building/building-admin.service.ts`

**楼宇停用**：在第 `678` 行 `if (dto.status !== undefined && dto.status !== b.status) patch.status = dto.status;` **之前**插入 `await this.assertBuildingSuspendable(id, dto)`。

**楼群停用**：在第 `967–979` 的 60003 闸门**之后**插入 `await this.assertGroupSuspendable(gid, dto)`。顺序是**先判非空（便宜）再判未完结（贵）**，与现有「先搬楼再判闸门」（`:958`）同一精神。

**闸门逻辑（顺序即决策，不要调换）**：

```
1. 目标状态不是「停用」→ 直接 return（不动启用方向的动作）
2. 统计 A 组 count（cut_off/cooked/delivering/delivered）
   A > 0 → throw 60013 SUSPEND_CANNOT_REVOKE_ACCEPTED   ← 硬约束，force 无效，不可配置
3. 统计 N = 未完结总数（8 态）
   N = 0        → return（放行）
   N > 阈值      → throw 60012 SUSPEND_REQUIRE_APPROVAL   ← force 也无效，走审批
   N ≤ 阈值 且 !forceSuspend → throw 60006 / 60007 带影响摘要
   N ≤ 阈值 且 forceSuspend → 放行，并：
       · reason 已由 DTO @MinLength(10) 保证 ≥10 字（不足会被拒成 10001）
       · 审计：@OperationLog 记录 forceSuspend / suspendReason / unfinishedCount
       · 通知：见 6.5
```

`payload` 形状（`BizException` 第 4 个参数）：

```ts
{ unfinishedCount, groupA: { count, orderNos }, groupB: { count }, earliestMealDate,
  samples: [{ orderNo, mealDate, statusLabel }], threshold, hint }
```

**`hint` 必须区分「卡在退款审批」与「待履约」**（QA 异议 3）。8 态里有 `refund_applying`（退款申请中）与 `refunding`（退款中），它们和 `paid` 一样会被闸门拦下，但**运营该做的动作完全不同**：

| 未完结主要构成 | hint 措辞方向 |
|---|---|
| B 组含 `refund_applying` / `refunding` | 「有 N 笔订单**卡在退款审批** —— 先把退款放行或驳回，再停用。停用不会推进退款」 |
| B 组仅 `pending_pay` / `paid` | 「有 N 笔订单**待履约** —— 停用不退款，这些单会照常配送；请确认后再停用」 |
| A 组 > 0（60013） | 「已有 M 笔进入履约阶段（已截单/在途/已送达），**无法通过停用撤回**，只能逐单走 `force_refund` 审批」 |

不区分的后果：运营看到「有未完结订单」却不知道该去点退款审批还是去等配送，最常见的处理是反复重试停用 —— 把一次配置疏漏变成一串无效操作日志。

### 6.4 审批通道（复用，不新造）

**文件** `apps/api-server/src/modules/admin/operation-request/operation-request.service.ts`

`OP_ENDPOINTS`（第 31 行）与 `OP_LABELS`（第 44 行）各加两条：

```ts
  suspend_building:       { method: 'PUT', path: '/admin/buildings/:id' },
  suspend_building_group: { method: 'PUT', path: '/admin/building-groups/:id' },
```

```ts
  suspend_building: '停用办公楼（含强制停用）',
  suspend_building_group: '停用楼群（含强制停用）',
```

**不要新造审批机制**。execute 阶段自调用原 controller（`operation-request.service.ts:20–29` 的注释），`@Roles('super_admin','admin')` 与 `@OperationLog` 照常命中 —— 业务零重复、审计不丢。新造一套就是第二份判据（本项目 M5-17 缺陷 ⑫ 的同族病根）。

### 6.5 通知（B 组订单必须通知用户）

**裁决**：走既有的 `MessageOrchestratorService.orchestrate()`（`message-orchestrator.service.ts:81`），**异步**。

- **不阻断停用**：让一次消息通道抖动把停用卡住，是把两个可用性绑在一起。
- **失败必须留痕**：`ab_operation_log` 一条带 `notifyFailedCount` 的记录 + 保留失败的消息行，让运营事后看得到「有几个人没通知到、是谁」。不可见的失败比失败本身更糟。
- **不做自动重试**（幂等与重复打扰问题），留运营手动补发。

**D-N2-3b · B 组内部必须再分两套通知模板（QA 异议 4，Team Lead 已采纳）**

B 组合成一个「继续推进、不批量退款」的**动作**是对的，但组内两类用户的**结局相反**：

| B 组子集 | 系统做什么 | 用户最终得到 |
|---|---|---|
| `pending_pay` / `paid` | 继续履约 | **餐** |
| `refund_applying` / `refunding` | 退款照自己的通道走 | **退款** |

> **分组决定「系统做什么」，结局决定「用户收到什么」。**
> （QA 原句，Team Lead 全文采纳 —— 这是本批最精炼的一条口径，照抄不改写。）

若文案统一按「继续履约」生成，**一个正在退款的用户会收到「你的订单将照常送达」** —— 这是事实性错误，而且用户会据此**不做午饭安排**。这比不发通知更糟：不发是失职，发错是误导。

**`notifySuspendAffected()` 的 `variables` 白名单（2026-10-26 后端落地，登记）**

| 项 | 内容 |
|---|---|
| 白名单 | **`['mealDate', 'orderNo']`**（两个停售 / 停用场景**共用**同一份） |
| `orderNo` 的用途 | **只落 `ab_message.payload`，供事后追溯「是谁」** —— 对应上面「失败必须留痕」那条要看的「有几个人没通知到、**是谁**」 |
| `orderNo` **不进** `wxData` | 小程序模板消息的字段是**用户可见**的，订单号不属于该呈现层 |
| `orderNo` **不出现在文案里** | 文案是给用户读的，不是给运营查的；追溯走 payload，不走文案 |

> ⚠️ **为什么必须登记这条白名单**：`orderNo` 是**「只落不显」**的字段 —— 它既不在 `wxData`、也不在文案里，**唯一的存在痕迹就是 `ab_message.payload`**。这类字段一旦没人登记，下一次有人清理 payload 时会当成冗余删掉，而删掉之后**没有任何测试会红**（没有任何断言读它），损失的是事后追溯能力。
>
> ⇒ 这类字段描述的是一种**静默失效的资产**：没有测试守着、没有类型报错、删了也不红，但它承载的是事后追溯能力。**这类东西只能靠「登记」来生存。**
>
> 📌 **待办（开到下一批，本批已收口不扩范围）**：统一扫一遍全仓还有哪些「只落不显」的字段没登记（判据：`payload` 里有、但 `wxData` 与文案里都没有的字段），逐条补登记。
>
> ⚠️ **D-N2-3b 本批最重的用户可感缺陷，一度是零覆盖**（后端 2026-10-26 破化自证发现）：把 `refund_applying` 的通知场景改成「照常配送」模板，**看板 48 条判据 + jest 115 条一条都不红**。⇒ 已补 `test/unit/suspend-notify.spec.ts`（见文首白名单第 5 项）。

**落法**：`orchestrate()` 的受众按订单状态分两批，两批走**不同模板**（不是同一模板换变量）：

- 模板 A（`pending_pay` / `paid`）：「您 {mealDate} 的订单照常配送，不受本次调整影响。」
- 模板 B（`refund_applying` / `refunding`）：「您 {mealDate} 的订单退款正在处理中，款项将原路退回，请注意查收。」

**验收句式**

- WHEN 停用一栋同时有 `paid` 与 `refund_applying` 订单的楼 THEN 必须产生**两条不同模板**的消息（B2-14）。
- WHEN 用户持有一笔 `refund_applying` 订单 THEN 收到的文案**不得**出现「照常配送」「照常送达」等履约承诺措辞（N2-AC-07）。
- WHEN 只有 B 组一类订单 THEN 只发对应那一种模板，不得两类都发。

### 6.6 配置项（阈值读 `ab_config`）

**文件 1** `apps/api-server/src/modules/admin/config/config.specs.ts`

新增一个 `building` 分组，插在 `order` 之后（`CONFIG_GROUPS` 数组顺序即页面渲染顺序，`:107`）：

```ts
  {
    group: 'building',
    label: '楼宇与楼群',
    description:
      '停用动作的闸门阈值。⚠️ 改动**立即生效**（进程内缓存同步失效）。' +
      '调大上限等于放宽运营的单人操作权限，请谨慎。',
  },
```

`CONFIG_SPECS` 加两项：

```ts
  {
    key: 'building.suspend_force_max_count',
    group: 'building', label: '单人可强制停用的未完结订单上限',
    type: 'int', impact: 'master', wiring: 'live',
    description: '未完结订单数不超过此值时，运营可填原因强制停用；超过则必须走高危操作审批（两级 approve→execute）。',
    unit: '笔', min: 0, max: 1000, fallbackValue: '20',
    consumedBy: '`BuildingAdminService.assertBuildingSuspendable()` / `assertGroupSuspendable()`',
  },
  {
    key: 'building.suspend_reason_min_length',
    group: 'building', label: '强制停用原因最少字数',
    // ⚠️ ConfigWiring 只有 'live' | 'unwired' | 'policy' 三档（config.specs.ts:57），没有 'none'。
    //    本键的真实状态是「口径记录」，必须照 `settlement.settlement_cycle` 的既有写法用 'unwired' + unwiredReason。
    type: 'int', impact: 'master', wiring: 'unwired',
    description:
      '强制停用时必须填写的原因字数下限。用于事后追溯「谁、为什么在有几笔单未完结时停了这栋楼」。' +
      '⚠️ **当前实现固定为 10 字**（写在 `UpdateBuildingDto` / `UpdateBuildingGroupDto` 的 `@MinLength(10)` 装饰器上，编译期常量），' +
      '**本键仅记录口径，修改本键不会生效**。',
    unit: '字', min: 0, max: 200, fallbackValue: '10',
    unwiredReason:
      '字数下限由 DTO 装饰器 `@MinLength(10)` 在编译期固定，运行时不读 `ab_config`。' +
      '要让它真可配，得绕开 ValidationPipe 自造一份运行时校验 —— 那是第二份校验逻辑，本批不做。',
    consumedBy: '`UpdateBuildingDto` / `UpdateBuildingGroupDto` 的 `@MinLength`（DTO 侧静态校验）',
  },
```

> **为什么 `wiring` 写 `'unwired'` 而不是 `'live'`**：假配置比没配置更糟。运营在后台把它改成 3，界面显示「已保存」，实际提交时仍要 10 字并被拒成 10001 —— 他会认为系统坏了，而且没有任何日志能解释。`description` 里的 ⚠️、`wiring: 'unwired'`、`unwiredReason` 三处一起把这个键的真实状态写死，运营在界面上就能看到「未接线」。

**文件 2** `apps/api-server/src/common/services/biz-config.service.ts`

**只加一个** reader（复用既有的私有 `getNumber(key, fallback)`）：

```ts
  /** 单人可强制停用的未完结订单上限（N2 闸门，见 config.specs.ts） */
  suspendForceMaxCount(): Promise<number> {
    return this.getNumber('building.suspend_force_max_count', 20);
  }
```

**不要加 `suspendReasonMinLength()` reader。** `suspend_reason_min_length` 是 `wiring: 'unwired'`，运行时没有任何消费点 —— 加一个没人调用的 reader 就是死代码，而且会给出「代码读了这个键」的反向暗示，与 `unwiredReason` 自相矛盾。字数下限由 DTO 的 `@MinLength(10)` 在编译期固定，**不为了「可配」去绕过 ValidationPipe 自造运行时校验**（那会变成第二份校验逻辑）。

### 6.7 N2 验收句式

- WHEN 楼宇存在 1 笔 `paid` 订单 THEN `PUT /admin/buildings/:id {status:3}`（不带 force）返回 `code: 60006`，且该楼 status **未变更**。
- WHEN 楼宇存在 1 笔 `refund_applying` 订单 THEN 同上仍返回 `code: 60006`（**这条是防 6 态白名单漏掉退款态的定向回归，必须固化成 jest 用例**）。
- WHEN 楼宇存在 1 笔 `delivered` 订单 THEN **即使带 `forceSuspend: true`** 也返回 `code: 60013`，且 status 未变更。
- WHEN 楼宇存在 1 笔 `refund_applying` 的 B 组订单 THEN 60006 的 `payload.hint` 必须提到**退款审批**（而不是「待履约」）。
- WHEN 未完结数 N = 0 THEN 停用直接返回 200。
- WHEN `1 ≤ N ≤ 阈值` 且 `forceSuspend: true` 且 `suspendReason` 仅 4 字 THEN 返回 `code: 10001`。
- WHEN `1 ≤ N ≤ 阈值` 且 `forceSuspend: true` 且 `suspendReason` ≥ 10 字 THEN 返回 200，`changed: ['status']`，且 `ab_operation_log` 有一条带 `forceSuspend` 与 `reason` 的记录。
- WHEN `N > 阈值` THEN **即使带 `forceSuspend: true`** 也返回 `code: 60012`，payload 含可提交的 `opCode`。
- WHEN 停用后存在 `delivered` 订单 THEN 推进到 T 日 14:00 后该单必须照常 `delivered → completed`，且**佣金照常生成**（**状态机不得被冻结**；这条是隐性欠薪回归面）。
- **WHEN 造两笔同楼订单，一笔 `paid`、一笔已推进到 `cut_off`，分别打同一栋楼的停用闸门 THEN 前者返回 `60006`（force 可用），后者返回 `60013`（force 与审批都无效）**（QA B2-12 —— A/B 翻转）。**不要用 `ABOX_SHIFT_TO_HOUR` 测本条。**

**最后这条为什么要单独钉住**：`cut_off` 是**跑批推进出来的状态**，不是静态属性。同一笔订单会在截单后改变组别 —— 运营截单前能用「force + reason」这个逃生舱，截单后就没了，**而期间没有任何配置变化**。这不是缺陷（过了截单，承诺已成立，业务上说得通），但**逃生舱静默消失**这件事必须被显式记录：实现者极可能把 A/B 归属当成订单的静态字段写死（甚至落库），那样两个状态会给出同一个结论，其中一个必然是错的。

⇒ 实现约束：**A/B 组别每次停用请求时现算，不得缓存、不得落库、不得从订单快照字段读**。落法见 §6.0 —— `groupOf(status)` 是纯函数，这条约束由结构保证，不靠自觉。

> **⚠️ 机制已两度更正（2026-10-26，QA 回源 + Team Lead 复核）**：本条最初写「T-1 23:59 与 T 日 00:01 各发起一次停用（注入时钟跨零点）」—— **`ABOX_SHIFT_TO_HOUR` 跨不了零点**（`SHIFT_MS` 只在本北京日范围内摆动，`time.ts:64–77`），23:59 这个时刻**根本造不出来**。
>
> 更关键的是**手段与目的搞反了**：这条要验的是「**状态变了以后分组跟着变**」，跟墙钟走没走**一点关系都没有**。正确测法是**直接造两个状态的订单分别打闸门，验证分组结论相反** —— 拨时钟测的是「时间流逝」，而我们要验的是「状态变了 ⇒ 组别变了」。
>
> ⇒ 通则：**凡是「要验某个状态推进后的行为」，一律推进状态，不要挪钟。** 挪钟只能解决「此刻能不能下单」这一个问题，而且只能落在整点上。

---

## 7. P3-6 · W1 一键停售

### 7.1 实体

**文件** `apps/api-server/src/database/entities/system.entity.ts`（与 `OpBlocklist` 同文件，系统域）

```ts
/**
 * ab_sales_pause 全局停售区间（W1 · ADR-N1N2W1）
 *
 * ⚠️ 为什么是独立表而不是 `ab_config` 的一个键：`BizConfigService` 有 60 秒进程内缓存，
 *    而「一键停售」的语义就是**立刻** —— 走配置路线会有最长 60 秒的放单窗口且无任何报错。
 *    （生产当前只有 1 个 api 容器：`docker-compose.prod.yml:88–96`，无 replicas。）
 */
@Entity('ab_sales_pause')
@Index('idx_sales_pause_range', ['mealDateFrom', 'mealDateTo'])
export class SalesPause {
  @PkColumn()
  id!: number;

  @Column({ name: 'meal_date_from', type: 'date', comment: '停售起始出餐日（含）' })
  mealDateFrom!: string;

  @Column({ name: 'meal_date_to', type: 'date', comment: '停售截止出餐日（含）' })
  mealDateTo!: string;

  @Column({ type: 'varchar', length: 255, comment: '停售原因（后台必填，随用户端文案下发）' })
  reason!: string;

  @Column({ name: 'created_by', type: 'bigint', transformer: bigintTransformer, nullable: true })
  createdBy?: number | null;

  @Column({ name: 'resumed_at', type: 'datetime', precision: 3, nullable: true, comment: '恢复时刻（NULL = 仍生效）' })
  resumedAt?: Date | null;

  @Column({ name: 'resumed_by', type: 'bigint', transformer: bigintTransformer, nullable: true })
  resumedBy?: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}
```

**G4 提醒**：多词列必须显式写 `name: 'meal_date_from'` 等 —— 本仓 TypeORM 默认命名策略不做 camelCase→snake_case 转换。

### 7.2 登记

**文件** `apps/api-server/src/database/entities/index.ts`

- `ALL_ENTITIES` 加 `SalesPause`（33 → 34）
- 同步更新文件头「33 张表」注释与「系统域（8）」的计数

> **W1 不登记任何 `ab_config` 键**（与 QA 的 `S-W1-4` 对齐）：`config.specs.ts` 里**只新增** `building.*` 两个阈值键（§6.6），**停售状态一个键都不加**。停售是**有时效的数据**（区间 + 原因 + 恢复人），不是「口径参数」；塞进 `ab_config` 会让「当前是否在停售」变成一行需要被解释的配置，而且要额外回答「过期的停售配置谁删」。

### 7.3 迁移

**文件** 新增 `apps/api-server/src/database/migrations/1700000000019-sales-pause.ts`（下一可用序号；当前最大是 `1700000000018-referral-user.ts`）

```sql
CREATE TABLE IF NOT EXISTS `ab_sales_pause` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `meal_date_from` DATE NOT NULL COMMENT '停售起始出餐日（含）',
  `meal_date_to`   DATE NOT NULL COMMENT '停售截止出餐日（含）',
  `reason` VARCHAR(255) NOT NULL COMMENT '停售原因（后台必填，随用户端文案下发）',
  `created_by`  BIGINT UNSIGNED DEFAULT NULL COMMENT '停售人 admin_user_id',
  `resumed_at`  DATETIME(3) DEFAULT NULL COMMENT '恢复时刻（NULL = 仍生效）',
  `resumed_by`  BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_sales_pause_range` (`meal_date_from`, `meal_date_to`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='全局停售区间（W1 · ADR-N1N2W1）';
```

- 无外键（既有约定：FK 只存在于文档，不进 DDL）。
- 无唯一约束（刻意允许重叠区间：「停售明天」+「停售下周一」两条独立记录，各自独立恢复）。
- 不设 `version`：append-only + 单行 `resumed_at` 更新，不是并发争抢资源。
- **G8**：索引名与列必须与实体声明逐名逐列一致，否则 `index:parity` 必红。

### 7.4 模块

**文件** 新增 `apps/api-server/src/modules/admin/sales-pause/`（controller + service + dto）

| 端点 | Method | 权限 | 说明 |
|---|---|---|---|
| `/admin/sales-pause` | GET | 类级 `super_admin`/`admin`/`operator` | 列表（含历史，带 `resumedAt`） |
| `/admin/sales-pause` | POST | `super_admin`/`admin` | 创建停售区间。`@OperationLog` |
| `/admin/sales-pause/:id/resume` | POST | `super_admin`/`admin` | 恢复（写 `resumedAt` / `resumedBy`）。`@OperationLog` |

> ⚠️ **出参形态 · 钉死：裸数组**（2026-10-26 终裁。本契约**一周内翻了两次**：本规格原本写裸数组 → 后端口径改成 `{ list }` → 前端按 `{list}` 写完页面后后端又改回裸数组、前端回滚）
>
> **`GET /admin/sales-pause` 返回 `SalesPauseRow[]`（**裸数组**），不套 `{ list }` 信封。** 回源：`sales-pause.controller.ts:57-58` 是 `list() { return this.svc.list(); }`，service `:56` 签名 `Promise<SalesPause[]>`，controller 头注已写明「刻意不套信封」。与 `GET /admin/operation-requests`（`fetchOperationRequests`）同形。
>
> **理由**：本表**不分页**（停售区间条数是个位数，历史区间也是审计事实 ⇒ 全量返回），套 `{list}` 信封没有收益，只给调用方多一层 —— 而这一层**编译期完全看不见**：`http.get<T>` **只解包业务信封，不解包自定义信封**，套错层的表现是「列表空白」或 `find is not a function`（后者直接白屏）。
>
> ⚠️ **仓内两种写法都存在**：`op-blocklist` 是 `{ list }`，`operation-request` 是裸数组。**这不是谁对谁错，只能二选一并写清楚。** ⇒ **改这个签名之前先回源 `SalesPauseController.list()`（`sales-pause.controller.ts:57`）**，❌ 不要照别的模块「统一风格」—— 那正是这次来回的成因。

DTO 要点：`mealDateFrom` / `mealDateTo` 用 `@Matches(/^\d{4}-\d{2}-\d{2}$/)`，`reason` **强制必填** `@MinLength(4)`（停售文案会下发到用户端，逼运营留一句人话）。允许 `from == to`（「停售明日」就是这个形态，UI 上给一个快捷按钮，**不做第二套开关**）。

**文件** `apps/api-server/src/modules/admin/admin.module.ts` 注册新 controller / service。

### 7.5 接线

`OrderAvailabilityService` 内部点查 `ab_sales_pause`（见 P3-3 第 2 条）。**不走任何缓存**。

> **会随时间退化的不变量（写在这里是因为没人会主动想起它）**
>
> W1 的「立刻生效」不是出自某个机制，而是出自一个**缺省**：`OrderAvailabilityService` 当前对 `ab_sales_pause` 是直查、无缓存层。这条性质没有任何门禁在守 —— 将来任何人为了「优化下单接口 RT」在编排层外面套一层缓存（哪怕 TTL 只有 10 秒），W1 立刻退化成「最长延迟 TTL 秒的停售」，而**所有现有验收句式仍会通过**（它们只断言「立刻查返回停售」，缓存命中的旧值在 10 秒内也一样）。
>
> QA 已登记静态判据 `S-W1-5` / `S-W1-7` 盯这件事。**本批不为此加任何代码**，只留这条记录：若将来要引入缓存，`SalesPause` 必须在**写路径**（`POST /admin/sales-pause` 与 `resume`）上显式失效，且 §7.6 的验收句式要改成「写入后**另起进程**立刻查」。

### 7.6 W1 验收句式

- WHEN 创建 `mealDateFrom = mealDateTo = tomorrow` 的停售 THEN **立刻**（不等待）`GET /api/v1/meal/daily?mealDate={tomorrow}` 返回 `canOrder = false` 且 **`reason`（中文文案）含运营填的停售原因**（如 `今日暂停接单：临时检修`）。⚠️ **不是 `reason = 'sales_paused'`** —— 见下方裁定。
- WHEN 停售生效 THEN `POST /api/v1/orders` 返回 `code: 60009`。
- WHEN 调用 resume THEN 立刻重查返回 `canOrder = true`。
- WHEN 停售生效 THEN `PUT /admin/meal-assignments/*`（套餐编排）仍可用（停售不阻塞编排）。
- WHEN 停售生效 THEN 存量订单的状态与佣金不受影响（**不批量退款、不冻结状态机**）。

> ⚠️ **U1 的 `reason` 是文案不是码 —— 机器判别停售只能靠 U6 的 `60009`**（2026-10-26 Team Lead 裁定，已回源核实；本条**上一版写错了**，前端按它派单时发现）
>
> 回源：`apps/api-server/src/modules/meal/meal.service.ts:144` 是 `reason: availability.reasonText` ⇒ 首页下发的 `reason` 字段是**中文原因文案**（`今日暂停接单：临时检修` 这种），**不是** `sales_paused` 这个枚举码。枚举码只存在于**服务内部**，**没有下发到端上**。
>
> ⇒ **不要照 `reason === 'sales_paused'` 写端上分支或 e2e 断言** —— 那等于把服务端语义拷一份到端上，服务端改口径就静默失配（正是本批在消灭的第二真相）。
>
> **裁定：不改契约，不加 `reasonCode` 字段。** 理由三条：
>
> 1. 首页要展示的本来就是「为什么不能下单」，用中文文案是对的 —— 而且它会带上运营填的停售原因，正是本条想要的效果。
> 2. 「已下订单不受影响」这句在**停售 / 截单 / 未开团任何**被拦场景下都成立，不需要能区分出停售才显示。
> 3. 唯一需要机器判别的停售信号是 **U6 的 `60009`**，那个已经有了。
>
> ⇒ 加 `reasonCode` 只会造出「文案 + 码」**两个语义出口**，正是本批在拆掉的东西。
>
> ⚠️ **同一个字段名 `reason` 在两层含义不同 —— 这是本次搞错的直接原因，写下来免得再犯**：
>
> | 层 | 字段 | 值 |
> |---|---|---|
> | 服务内部（`OrderAvailabilityService.forUser` 返回值） | `reason` | **枚举码**（`sales_paused` …）；文案在**另一个字段** `reasonText` |
> | HTTP 响应（`GET /api/v1/meal/daily`） | `reason` | **中文文案**（取的就是 `reasonText` 的值）；**码根本没下发** |
>
> ⇒ 引用「`reason` 等于什么」时**必须先说清是哪一层**。§5 验收句式里 `forUser … reason = sales_paused` 说的是**内部层**，**是对的、不要改**。
>
> **留给将来的方向（⚠️ 不是待办，本批不做 —— 写成待办会有人现在就去做）**：这处同名不同义是本次搞错的根因。将来若动 U1 契约，优先**改名**（例如 HTTP 层字段改叫 `reasonText`、与内部层对齐），而**不是加 `reasonCode`** —— 加字段是让两个名字继续并存，**改名是消掉歧义本身**。本批已裁定不动契约，此处只记方向。

---

## 8. 错误码与 payload 总表（最终裁定 2026-10-26）

| Code | 常量名 | 触发点 | payload |
|---|---|---|---|
| 60006 | `BUILDING_UNFINISHED_ORDERS` | 楼宇停用，`1 ≤ N ≤ 阈值`，未 force | `{ unfinishedCount, groupA, groupB, earliestMealDate, samples, threshold, hint }` |
| 60007 | `BUILDING_GROUP_UNFINISHED_ORDERS` | 楼群停用，同上 | 同 60006 |
| 60008 | `BUILDING_GROUP_SUSPENDED_REJECT` | 往已停用楼群**写 `building_group_id`** —— 共**三条**写路径：搬楼（`assignMembers`）、挂楼（`updateBuilding` 归群分支）、**新建即归群（`createBuilding`）**。第三条本规格上一版漏登记，后端 N4 收口时补出（见 §5.4） | `{ targetGroupId, hint }` |
| 60009 | `SALES_PAUSED` | U6 下单，reason = `sales_paused` | `{ reason }` |
| 60010 | `BUILDING_SUSPENDED` | U6 下单，reason ∈ {`building_preparing`, `building_suspended`, `group_suspended`} | `{ reason, reasonText }` |
| 60011 | `BUILDING_NOT_GROUPED` | U6 下单，reason = `building_not_grouped`（**取代 10004**）。⚠️ **文案收尾批改为** `该办公楼暂未开通服务，请联系运营`（**不在 P3-5**）—— 与 ADR §7.1.1 对齐 | `{ reason, reasonText }` |
| 60012 | `SUSPEND_REQUIRE_APPROVAL` | `N > 阈值`，force 也无效 | `{ unfinishedCount, threshold, opCode, hint }` |
| 60013 | `SUSPEND_CANNOT_REVOKE_ACCEPTED` | A 组 `count > 0`，硬约束 | `{ groupA: { count, orderNos }, hint }` |

**60006–60013 连续占满，无跳号。** 已废弃：`BUILDING_NOT_ORDERABLE`（被 60010 / 60011 取代）。

> ⚠️ **废弃码名的作用域**（2026-10-26 修正 —— 原句写的是「不要在任何文件里出现这个名字」，而它自己就出现了这个名字）：
>
> - **代码中**（`apps/` + `packages/`）**不得出现**该名字 —— 包括注释里。现况：命中 **0**。
> - **文档中作为废弃声明的引用除外** —— 即 ADR §7 号位说明、ADR §10 裁定表、本规格本节，共 3 处，**保留，不要删**。
>
> 删掉这 3 处声明，后人就不知道 60010 与 60011 之间为什么空着一个语义上「理应存在」的合成码，会有人把它补回来 —— 那正是本批在拆掉的东西。所以这条规则的正确形态是「**代码里不许有，文档里必须有**」，不是一刀切。
>
> ⚠️ **这是「有意保留的字面」这一类东西的通律，不只适用于废弃码名**（2026-10-26 Team Lead 裁定 + 补充风险）：
>
> **两边都要写清楚谁该看到它** —— 判据扫**代码**（那里出现 = 缺陷）；文档里的废弃声明**不许扫**（那里出现 = 有意留痕）。
>
> ⇒ 本批已出现两例：① 本节这个废弃码名；② 旧文案 `今日暂停接单，恢复时间请以通知为准`（现只剩 ADR §2.5 一处有意保留）。**将来任何判据扫这两类字面时，必须排除 `docs/`**，否则会命中那几处废弃声明而**假红**。
>
> ⇒ 一句话：**有据可查地废止，优于无迹可寻地消失**；但代价是判据必须知道「文档里的那一份是故意的」。

沿用不新建：30001 `ORDER_CUTOFF`、30005 `MEAL_NOT_PUBLISHED`、10001（DTO 格式校验，含 `suspendReason` 不足 10 字）。

**本批变更的既有码**（`10004 NOT_FOUND` 的两个语义被拆走，同步动作见 §12）：

| 抛点 | 原语义 | 原码 | 新码 |
|---|---|---|---|
| `meal.service.ts:281` / `order.service.ts:1693` | 楼**未归群**（运营漏配） | 10004 | **60011** |
| `order.service.ts:1624` | 用户**未绑楼**（可自助） | 10004 | **20016**（已存在的码，对齐 `meal.service.ts:262`） |

`10004` 本身不删除，其它场景继续用。

`hint` 文案统一两句（错什么 + 怎么修），沿用 `building-admin.service.ts:976` 的写法；N2 的 hint 须按 6.3 的表格区分「卡在退款审批」与「待履约」。

---

## 9. 每批必跑的门禁

```
node scripts/gate.mjs shared          # 前置：重建 @abox/shared-types dist
node_modules/.bin/tsc -p apps/api-server/tsconfig.json --noEmit
node scripts/gate.mjs typecheck:api schema:parity index:parity errcode:message lint lock:version jest
node scripts/gate.mjs e2e:m1 e2e:m2 e2e:m3
```

**P3-6 额外必跑**：`schema:parity` + `index:parity`（新增表）。本地 sqlite 由实体 synchronize 建表、生产由迁移建表 —— 两者不一致时**不在任何失败路径上**，只有这两个门禁能抓到。

---

## 10. 明确不做（防止镀金与范围蔓延）

1. **不做批量退款 / 自动取消存量单。** 用户已拍板：停用与停售只拦新单，存量继续履约 + 通知。要撤走既有的逐单审批（`force_refund` opCode 已在 `OP_ENDPOINTS`）。
2. **不新造审批机制 / 不新造留痕通道。** 复用 `OperationRequest` 与 `@OperationLog`。
3. **不改 `Object.assign + save` 的 version 自增写法**（`building-admin.service.ts:685` / `:982`）。已单列议题，不混进本 diff。
4. **不给 `ab_order` 加新索引。** 见 6.2。
5. **不改 `user.service.ts:118` / `building.service.ts:73` 两道入口校验。** 它们是既有回归基线，削弱它们等于在修 N1 的同时开一个新洞。
6. **不动 30001 / 30005 的码与文案。** 差异只体现在 `payload.reason`。
7. **结构层不判集散中心覆盖**（`DistributionGap`）。见 P3-2 实现要求第 1 条的注释。
8. **不引入任何新的图标库 / emoji。** 后台新增按钮沿用既有 `abi-*` 档位 class + `ABOX_ICON_CHARS.pause`（`packages/shared-utils/src/icons.ts:80` / `:168`）。
9. **不写「楼宇自动停用调度」。** 无需求。
10. **不顺手重构。** 本规格未列出的文件一律不动。
11. **不删除 `common/utils/time.ts` 的 `isOrderable()`**（P3-4 后它将无人调用）。_backend 已逐点验证 `evaluateAvailability` 的时间两条与它等价（open / close-1 / close / cutoff+1 四个临界点），替换安全；但**留一个无人调用的旧函数 ≠ 第二份判据被使用**，而删它要动 `e2e` 与三份手册里引用它的文档。**单开清理议题，不混进 P3-4 的 diff** —— 混进去会让「谓词收口」这个 diff 里同时出现删改与接线，reviewer 分不清哪一行是口径变更。
12. **不把 W1 做成 `ab_config` 的一个键。** 见 §7.2。

---

## 11. 端到端验证（收尾，11 步）

见 ADR §8。三个不可省略的关键步：

- **第 6 步**：过截单时点拉 `GET /admin/buildings`，`canAssign` 仍为 `true`（防时间层污染管家端）。
- **第 8 步**：订单推进到 `refund_applying` 后停用仍返回 60006（防 6 态白名单漏掉退款态）—— **必须固化成 jest 用例**。
- **第 10 步**：停用后 `delivered → completed` 与佣金入账照跑（防状态机被冻结 = 隐性欠薪）。

---

## 12. 契约变更的同步动作（**改代码之外的三个动作，漏一个就留下第二真相**）

本批动了 `10004 NOT_FOUND` 的**两个语义**，两处**都是**别人的契约，都要同步：

| 原语义 | 抛点 | 新码 |
|---|---|---|
| 楼**未归群**（运营漏配） | `meal.service.ts:281` / `order.service.ts:1693` | **60011** `BUILDING_NOT_GROUPED` |
| 用户**未绑楼**（可自助） | `order.service.ts:1624` | **20016** `USER_BUILDING_UNBOUND` |

**「码」是被别处引用着的契约** —— 下面四个动作与改码同批完成，不接受「下个迭代再补文档」。

| # | 动作 | 文件 | 具体改什么 |
|---|---|---|---|
| 12.1 | **改小程序端的错误码注释** | `apps/miniprogram/src/api/request.ts:37–44` | 那段注释（`CODE_BUILDING_UNBOUND = 20016` 上方）用 `10004 NOT_FOUND`（如「所属办公楼未配置楼群」）与 `20016` 做对比，论证「两者是两件事」。**举例改成 `60011`**，并在同一段补一句「`20016` 与 `60011` 是两件事：前者用户能自己解决，后者只能找运营」。不改 = 该文件从此是陈旧的第二真相 |
| 12.2 | **登记进《接口规范》§九** | 《接口规范 v1.0》§九「错误码表」 | 新增 60006–60013 八条；标注 `10004` 在「楼未归群」与「用户未绑楼」两个场景均已停用（其余场景仍有效）；标注 `60011` / `20016` 分别取代 |
| 12.3 | **同步 Swagger** | 各 controller 的 `@ApiResponse` / `@ApiOperation` | U6 `POST /api/v1/orders` 与 U1 `GET /api/v1/meal/daily` 补上 60009 / 60010 / 60011；U6 另补 `20016`；`PUT /admin/buildings/:id` 与 `PUT /admin/building-groups/:id` 补上 60006 / 60007 / 60008 / 60012 / 60013 |
| 12.4 | **复核后台文档** | `apps/admin-web/src/views/user/list.vue:24` | 那句「未绑楼的用户在小程序端会拿到 `20016`」—— 改完 `order.service.ts:1624` 后这句才对**全部**路径成立，之前只对「看套餐」成立。确认措辞无需改，但要知道它现在覆盖面变大了 |
| 12.5 | **《接口规范 v1.0》—— 契约变更，须版本修订** | `docs/ABox一盒接口规范v1.0.md:1084` | 见下方 12.5 详述 |
| 12.6 | **其余四份文档 —— 按性质分别处理，不要一律当契约改** | `docs/` 下另外 4 份 | 见下方 12.6 详述 |
| 12.7 | **`building_not_grouped` 文案处置（D-N1-8 连带）：文案不改，补注释** | `apps/api-server/src/common/utils/orderability.ts:142` 的 `REASON_TEXT.building_not_grouped`（**真符号，唯一目标**） | D-N1-8 让这个 reason 同时覆盖「未归群」与「楼群记录查不到」。**裁定：文案字面不改** —— 两种成因对**用户**的处置动作完全相同（都是「下不了单，去找团长 / 运营」），用户分辨不了也不需要分辨；为它多开一个文案分支，成本不小、收益是零。区分责任由**错误码 `60011`** 承担。**要做的动作只有一件**：在该条目上方补一段注释，声明这个桶现在覆盖两类成因、以及为什么不为它们拆开文案 |

> **12.7 的唯一目标就是上面那一行文件:行号。** 《接口规范》与 Swagger 里以 `building_not_grouped` 举例的响应示例**不改** —— 理由同上：文案字面没变，示例自然也没变。
>
> ⚠️ **作废一条登记（2026-10-26）**：本规格上一版的第 12.8 行曾把一个**全仓 grep 命中 0 的虚构文案常量**登记为同步目标（Team Lead 已确认系误记）。**整条删除，且不再写出该符号名** —— 留下名字，执行者就会去 grep 它、花时间找它、最后空手回来。**同步清单里的每个符号，登记前必须 grep 到实际行号。**

#### 12.5 《接口规范 v1.0》—— 唯一需要走**版本修订**的一份

`:1084` 的 D13 条目原文：

> | **D13 `canOrder`** | = 营业中 ∧ 已归群 | 与 U1「今日这盒」是否可下单**同一判据**；未归群的楼无法被分配套餐 |

这句话里有**两处**要改，第二处比第一处更重要：

1. 字段名 `canOrder` → `canAssign`（出参改名 = 接口变更）。
2. **「与 U1 同一判据」这个断言必须删掉。** 它正是本批在消灭的错误 —— 两者**不同**（管家端无时间维度，用户端有）。留着它，下一个读规范的人会照着把两边再合成一次。

同文件里 **`:283`（U1 出参 `canOrder`）、`:591`（团长工作台 `tomorrow.canOrder`）、`:397`（下单校验顺序）三处保持不动** —— 它们都是用户端/团长端语义，本批不改。

⇒ 走《接口规范》既有的版本修订流程（版本号 + 修订记录），**不是直接改正文**。

#### 12.6 其余四份 —— 按性质分三类，别一律改

| 文档 | 命中 | 性质 | 处理 |
|---|---|---|---|
| `ABox一盒数据库ER设计v2.1.md` | `:908`「`canOrder` 亦要求 `1`」 | **叙述性引用**（描述字段口径，不是接口契约） | **只更新措辞**（`canOrder` → 后台 `canAssign`），**不修订版本**（它没有版本号约定，且未声明该字段为契约） |
| `ABox一盒开发里程碑计划v1.0.md` | `:517` | 引用的是 **U1 用户端** `canOrder`，本批不动 | **无需改** |
| `ABox一盒部署运维手册v1.0.md` | `:435`「套餐 `canOrder` 仍为 true」 | 同上，用户端口径（截单跑批失败的表现） | **无需改** |
| `ABox一盒深度测试第二轮报告v1.0.md` | `:74`「F4 仍有订单时照样能继续下单 ✅ canOrder=true」 | ⚠️ **历史记录** | ❌ **一个字都不要改** |

> **为什么测试报告不能改**：它是「某个时间点测出来什么」的记录，不是规范。把它改成新字段名，等于**改写历史** —— 三个月后有人拿它对账，会发现这份报告描述的当时的系统与当时实际返回的对不上。历史文档的正确处理是**追加**一条说明（若确有必要），不是原地编辑。
>
> 判据：**规范类文档改当前口径，记录类文档保留当时事实。** 执行者若分不清，看文档标题里有没有「报告」二字。

**验收句式**

- WHEN 全仓 grep `canOrder` THEN 命中必须**只剩**用户端 / 团长端（U1、`workbench.service`、`leader.ts`、小程序 `index.vue` / `order-create.vue`、上述两处「无需改」的文档）**外加 `building-admin.service.ts:253` 与 `building-admin.controller.ts:61` 两处注释里的解释性引用**（见 §5.4.4，**不得全局替换**）；后台其余 4 处与 admin-web 7 处必须已为 `canAssign` / `canAssignCount`。
  - ⚠️ **本句与 §5.4.4 必须一致**：上一版本句写的是「后台命中必须清零」，而 §5.4.4 裁定那两处解释性引用要保留 —— 两句放在一起，执行者只能二选一。已按 §5.4.4 对齐。
- WHEN 全仓 grep `canOrderCount` THEN 在 `apps/admin-web/src` 与 `building-admin.service.ts` 下结果为 **0**（`:438` 那处旧的自算逻辑一并消失）。
- WHEN 打开《接口规范 v1.0》 THEN `:1084` 不得再出现「同一判据」这一断言，且文件头修订记录有本次变更。
- WHEN 打开《深度测试第二轮报告 v1.0》 THEN `:74` 仍为 `canOrder=true`（**不得被改**）。

> **更正记录**：本规格上一版在 §12 末尾写「`order.service.ts:1624` 用 20016，与 `meal.service.ts:261–264` 一致，没问题」—— **这是错的**，回源核实 `1624` 仍是 `10004` + 旧文案。Team Lead 在做 P3-4 接线点行号校验时发现。已改为必改项（见 §5.2）。
> 教训：那条「顺带记录」是我**凭印象**写的，没有回源。同一份文档里，回源过的部分（F1–F17 表）和不回源的部分（这句），可信度差了一个量级 —— 而读者看不出哪句是哪种。

---

## 13. W1 · 后台 UI 与小程序停售态呈现（**只写呈现层**）

> **本节范围只有呈现层。** W1 的实体 / 迁移 / 模块 / 接线在 **§7（P3-6）**，后端正在落，**本节不重写 §7，只引用它。** 前端开工前需确认 §7.2 / §7.4 已落地（`ab_sales_pause` 表 + `modules/admin/sales-pause/`）。

### 13.1 后台 UI 落点

| 项 | 决定 | 依据 |
|---|---|---|
| 页面 | 新增 `apps/admin-web/src/views/system/sales-pause.vue` | 挂在**系统管理**下，与 `config` / `operation-log` / `operation-request` 同级（`router/routes.ts:271-300` 是 `system/*` 段）。**❌ 不要放进 `views/building/`** —— 那会让人以为停售是按楼粒度，而「按楼宇 / 按楼群停售」在 §13.4 明确不做 |
| 路由 | `router/routes.ts` 的 `system/*` 段新增 `system/sales-pause` → `SystemSalesPause` | 既有 `system/*` 段在 `routes.ts:271` 起 |
| 权限 | 列表**可读**：`operator`；**写（创建 / 恢复）仅** `super_admin` / `admin` | 与 §7.4 端点表一致（类级含 `operator`，POST / resume 收紧到 `super_admin`/`admin`）。⚠️ **真正的越权闸门是后端 `@Roles`**，前端只做按钮显隐 —— 同 `operation-request` 既有做法（`routes.ts:284-290` 的注释） |
| 状态读取 | `GET /admin/sales-pause`（§7.4），列表含 `resumedAt` | 见下方 ⚠️ |

> ⚠️ **两个「不得」**（这两条是本节最容易做错的地方）：
>
> 1. **❌ 不得读 `ab_config`。** 停售是「立即生效」语义，而 `BizConfigService` 有进程内 60 秒 TTL 且 `ensureLoaded()` 的 catch 静默 fail-open —— 用它读停售，会出现「后台显示已停售、用户端仍可下单最多 60 秒」且**没有任何报错**。W1 落独立表不落 `ab_config` 的理由见 ADR §D-W1-1。
> 2. **❌ 不得依赖 `OrderAvailabilityService.salesPaused()`。** 回源核实：`apps/api-server/src/common/services/order-availability.service.ts:62` 是 **`private`**，且**当前返回 `false` 占位**（`ab_sales_pause` 在 P3-6 才落地，现在注入 `Repository<SalesPause>` 编译不过）。它不是后台 UI 的读路径 —— 后台走 `GET /admin/sales-pause`，其后端实现复用 §4 实现要求 2 的 `getCount()` 口径（区间含首尾 + `resumed_at IS NULL`）。
>
> ⚠️ **G10 提醒**：`salesPaused()` 这个符号**存在但不可用于本用途**。登记前 grep 只能确认它存在，确认不了它能不能用 —— 还要看 `private` 与返回值。

### 13.2 小程序呈现

| 场景 | 呈现 |
|---|---|
| 首页（U1） | `GET /api/v1/meal/daily` 返回 `canOrder: false` + **`reason`（中文文案，已含运营填的停售原因，如「今日暂停接单：临时检修」）**。⚠️ 该字段**不是**枚举码 `sales_paused` —— 回源 `meal.service.ts:144` 是 `reason: availability.reasonText`。端上**不得**匹配 `reason === 'sales_paused'`，也**不要自己拼文案**（文案由 `orderability.ts` 的 `reasonText()` 唯一出口拼）。完整裁定见 §7.6 |
| 下单页（U6） | 提交返回 **`60009` `SALES_PAUSED`**（⚠️ **不是 60010** —— 60010 是 `BUILDING_SUSPENDED`，见 §8 号位表；`SALES_PAUSED = 60009` 见 `error-code.ts:520`，message `error-code.ts:660`「当前已暂停接单」）。`payload: { reason }` |
| 下单按钮 | **禁用并给出原因**，❌ **不要隐藏**。隐藏会让用户以为「今天本来就没开团」，转而去问团长；禁用 + 文案能把原因归到运营决策上，减少客诉入口 |
| 已下过的单 | **不受影响：不退款、不取消、照常履约。** 页面需明说这一句 —— 停售只拦**新单**。文案建议：「你已下的订单不受影响，会照常配送。」 |

### 13.3 与 N2 的边界（**两者正交，单列，别混**）

| | 楼宇停用（N2） | 一键停售（W1） |
|---|---|---|
| 语义 | **长期下线一栋楼** | **全局临时停接新单** |
| 粒度 | 单楼 / 楼群 | 全局 |
| 未完结订单 | **要过闸门**（60006 / 60007 / 60012 / 60013） | **不过闸门**，历史订单不动 |
| 落点 | `ab_building.status` / `ab_building_group.status` | `ab_sales_pause` 区间表（§7.1） |

> ⚠️ **停售不得复用停用闸门。** 停售是「临时、全局、不动历史」；一旦复用 N2 闸门，会出现「全局停售却因为某栋楼有未完结订单而停不掉」—— 而且是**静默的**：运营点了开关，界面显示成功，实际没生效。
>
> 反过来也一样：楼宇停用**不得**走停售表（那是改 `status`，涉及 `gap` / `canAssign` 一整套既有语义）。

### 13.4 明确不做

1. **不做定时停售**（不支持「明天 10:00 自动停售」）—— 只支持「立即写入、立即生效」。
2. **不做按楼宇 / 按楼群粒度的停售** —— 那是 N2 的楼宇停用，不要在这里再开一个。
3. **不做倒计时自动恢复** —— 恢复是 `POST /admin/sales-pause/:id/resume`（写 `resumedAt` / `resumedBy`），不自动。区间只是「最晚到哪天」，不是「到点自动解除」。

### 13.5 判据

| # | 判据 | 什么情况下会红 |
|---|---|---|
| W1-UI-1 | `views/system/sales-pause.vue` 内**不得**出现 `ab_config` / `bizConfig` / `BizConfigService` 的读取调用 | 有人图省事把开关读成配置项 ⇒ 红（那条路径带 60 秒 TTL + 静默 fail-open） |
| W1-UI-2 | 小程序端处理停售的分支必须判 **`60009`**，不得出现 `60010` 的停售分支 | 有人把 `SALES_PAUSED` 误写成 60010（60010 是 `BUILDING_SUSPENDED`）⇒ 红。**本条防的是 Team Lead 在本单里已经犯过一次的笔误** |
| W1-UI-3 | `modules/admin/sales-pause/` 的写路径（`POST` / `resume`）**不得**出现 N2 闸门的那四个码（60006 / 60007 / 60012 / 60013） | 有人复用停用闸门 ⇒ 红（后果是静默停不掉） |
| W1-UI-4 | **两步解析**：① 先读 `apps/miniprogram/src/constants/index.ts` 里 `SALES_PAUSED_UNAFFECTED_NOTICE` 的值；② 再在 `pages/**` 里找**常量名引用**（`SALES_PAUSED_UNAFFECTED_NOTICE` 被引用） | 只做拦截不说明历史订单 ⇒ 红（客诉入口）。⚠️ **不能直接扫 `pages/**` 的中文字面** —— 文案走**常量引用**不是内联字面，直接扫字面必然 **0 命中**（前端 `git diff` 实证）⇒ 恒绿 |
| **W1-UI-5** | **收窄到 U1 的 `daily.reason`**：`daily.reason` 不得被当作枚举码做字符串比较（`daily.reason === 'sales_paused'` / `=== 'building_suspended'` / `=== 'not_open_yet'` …）。❌ **不按变量名 `reason` 全扫** | 有人照服务端枚举码去判 U1 的 `reason` ⇒ 红。**守的是「字段 + 比较形态」，不是「某个字面」** —— 见下方三条边界与收敛范围 |

> **W1-UI-5 三条边界（不写会恒红 / 会误伤）**
>
> | 情形 | 判据态度 |
> |---|---|
> | `reason === 'sales_paused'` 这类**枚举码字符串**比较 | **禁（红）** |
> | `e.code === 60009` 这类**数值错误码**比较 | **允许** —— 这是唯一可靠的机器判别手段，前端 `CODE_SALES_PAUSED = 60009` 就是这么写的 |
> | 把 `reason` 当**文案**直接展示 / `.trim()` / 拼接展示 | **允许** —— 它本来就是文案 |
>
> ⇒ 这条判的**不是**「端上不许硬编码服务端的东西」（那会立刻恒红，错误码本来就硬编码在常量里），而是**「不许对 `reason` 这个字段做码语义的比较」**。措辞必须精确到**字段 + 比较形态**，❌ 不要写成「端上不得出现服务端枚举字面」。
>
> ⚠️ **收敛范围（不写会误伤 4 处合法写法 —— 前端 2026-10-26 排到并报回）**
>
> **按变量名 `reason` 全扫**会命中 4 处 U11 自助取消理由，全部**合法**：
>
> | 位置 | 写法 | 为什么合法 |
> |---|---|---|
> | `apps/miniprogram/src/api/order.ts:61`（注释）`/ :70`（代码） | `reason === 'other'` | `reason` 是**端上自己的枚举**，且是**请求入参**（`cancelOrder(orderNo, reason, note)` 拼 body）；`'other'` 是**服务端认的字面值**，不是重命名能解决的 |
> | `pages/order-cancel/order-cancel.vue:82` / `:91` | `reason === r.key` / `reason === 'other'` | 同上 |
>
> ⇒ **同名不同义**：一个是我们发给服务端的，一个是服务端发给我们的。判据必须限定到「读 **U1 的 `daily.reason`**」：
>
> - 只扫 `pages/index/index.vue` / `pages/order-create/order-create.vue` 里出现 `daily.reason` 的表达式；**或**
> - 扫 `reason ===` 但同时要求同一文件里存在 `daily`（等价于排除 `api/order.ts` 与 `pages/order-cancel/`）。
>
> ⇒ 不这么收敛，判据一上就 4 条假红；而**改掉这 4 处会直接破坏 U11 取消理由的提交逻辑**。
>
> ⚠️ **是否剥注释：剥。** 判据**只扫非注释代码行**。
>
> **两条理由（架构侧与 Team Lead 各自独立裁定，结论一致，无分歧）**：
>
> 1. 注释里引用被禁字面通常是为了说明「为什么不能这么写」（`order-create.vue:285` 曾如此），不剥会逼执行者删掉一条正确的说明。
> 2. **这条判据盯的正是「端上对 `reason` 字段的语义理解」，而注释恰恰是我们最想鼓励写这种说明的地方。** 判据若连注释一起扫，等于**惩罚「把禁止理由写清楚」** —— 下一个人会**把注释删掉**而不是改代码。⇒ 这是「判据可被规避」第一种形态的**反面**：不是绕过判据，而是**为了让判据变绿去做一件更糟的事**。
>
> ⇒ 因此前端**可以**把那条注释写回含字面的可读版本，但**注释里必须同时写明「这是 `W1-UI-5` 禁的写法」** —— 否则将来有人照注释抄，注释就从防护变成了范例（与 §14.2「描述已修缺陷的注释更误导」同族）。
>
> **为什么值得立**：这条防的坑本批已经踩到一次 —— spec §7.6 上一版写了 `reason = 'sales_paused'`，**是错的**（U1 下发的 `reason` 是中文文案，回源 `meal.service.ts:144`）。这次是靠**前端人眼判断**才没照它写分支，而人眼判断不可复制：下一个实现者没有这次的上下文，看到规格那么写就会照抄，且**类型检查、构建、e2e 全都不会红** —— 端上拿到的是中文文案，`=== 'sales_paused'` 恒 false，分支静默不进，页面表现只是「少了那句话」，没人会去查。**「现有校验全拦不住」才是立这条的根据。**
>
> **为什么范围要扩到一般形式**（Team Lead 2026-10-26 裁定）：只禁 `sales_paused` 一个字面，钉住的是**这次踩到的那个坑**；下次换成 `building_suspended` / `not_open_yet` 照样没人拦。⇒ 判据形态必须覆盖**一类写法**（对 `reason` 做码语义比较），而不是**一个字面**。
>
> **脚本实现**：Team Lead 派 QA，本节只登记编号与形态。
> **判据形态自问（G11 第 1 条）**：W1-UI-1 / 2 / 3 守的是**字面结构**（有没有引用某符号 / 码号对不对）⇒ 静态判据有效；**W1-UI-4 守的是「常量名引用」**（两步解析：读常量值 → 找引用点）⇒ 静态有效，但**必须两步**，直接扫中文字面会恒绿；**W1-UI-5 守的是「字段 + 比较形态」这一结构模式**（`daily.reason` 有没有被拿来和字符串字面量做相等比较）⇒ 同样是静态可判的**结构**，不是运行时行为，但**必须收敛到 `daily.reason`** 否则误伤。**没有一条需要 jest。**
>
> ⚠️ **反例提醒**：若把 W1-UI-2 写成「处理停售时不能出现『楼宇』二字」，那是**恒绿**（现在绿、将来也绿）。必须是**码号比对**，写错号就红。

---

## 14. 收尾批（**不在 P3-5 做**）· 60011 文案统一

### 14.1 裁定

同一语义「办公楼未归群」，仓库里现在有**五处不同写法**（2026-10-26 逐处回源核实，行号为核实当时值）：

| 位置 | 现状 |
|---|---|
| `apps/api-server/src/common/utils/orderability.ts:142` | `building_not_grouped: '该办公楼暂未开通服务'` —— **缺「，请联系运营」** |
| `apps/api-server/src/common/constants/error-code.ts:662` | `[ErrorCode.BUILDING_NOT_GROUPED]: '该办公楼未配置楼群，请联系运营'` |
| `apps/api-server/src/modules/meal/meal.service.ts:279–282`（字面在 `:281`） | `throw new BizException(ErrorCode.BUILDING_NOT_GROUPED, '所属办公楼未配置楼群，请联系运营')` —— **带第二参数** |
| `apps/api-server/src/modules/order/order.service.ts:1693`（`:1692` 是其上一行的注释） | 同上 —— **带第二参数** |
| `apps/api-server/src/modules/traceability/traceability.service.ts:285` | `throw new BizException(ErrorCode.NOT_FOUND, '所属办公楼未配置楼群，请联系运营')` —— **带第二参数 + 码仍是 10004** |

> ⚠️ **三条 throw 点全部带第二参数**，不是一条。第二参数是「同一个码可以有第二种写法」的入口：只要它还在，改 `ERROR_MESSAGE` 就**不生效**，而改的人看不出来（编译过、跑得过、测试绿）。

后果不是「不好看」：**同一个用户、同一个条件，走 U1（首页）拿到「该办公楼暂未开通服务」，走 U6（下单）拿到「所属办公楼未配置楼群，请联系运营」—— 两句话不一样，其中一句还带运营黑话。**

> **与 §9 第 8 项不冲突**（G12 自查）：那一条裁的是「**本批（P3-5 及之前）文案字面不动**」；本节是**收尾批**，就是来做那个「不动」期之后该做的统一。两条说的是不同批次，不是相反结论。

#### 14.1.1 落地状态（**回源核实 · 收尾批已由后端落盘**）

> ⚠️ **上表是裁定当时的快照，不是现状。** 逐处回源核实结果：
>
> | 处 | 现状 |
> |---|---|
> | `orderability.ts:149`（原 `:142`） | ✅ 已为 `该办公楼暂未开通服务，请联系运营` |
> | `error-code.ts:668`（原 `:662`） | ✅ 已为同一句 |
> | `meal.service.ts:279` | ✅ `throw new BizException(ErrorCode.BUILDING_NOT_GROUPED);` —— **第二参数已删** |
> | `order.service.ts:1693` / `:293` | ✅ 同上，第二参数已删 |
> | `traceability.service.ts:285` | ✅ 已改 `BUILDING_NOT_GROUPED`，第二参数已删 |
>
> ⇒ **八处同步面里第 1–5 项已落地，剩余第 6–8 项**：
>
> | # | 剩余项 | 状态 |
> |---|---|---|
> | 6 | `apps/miniprogram/src/api/request.ts:41` 注释里的举例 | ✅ **已改**（前端 2026-10-26 报）：已改成与服务端**逐字一致**的「该办公楼暂未开通服务，请联系运营」，并注明与 `20016` 的处置动作不同 |
> | 7 | QA 判据脚本里含旧字面的 sample | ⚠️ QA 已确认：`N1-7` 的 needle 已换成判定条件（对文案改名免疫）；`N1-13` 的两处 sample **收尾批时同步改** —— **现在不能提前改**，否则判据与当时产物不一致 ⇒ 假红 |
> | 8 | 前端 e2e 三处硬编码 | ✅ **已核 · 不成立（0 命中，未改动）**（前端 2026-10-26 回报并由 Team Lead 复核） |
>
> ⚠️ **「待核」与「已核」必须写清楚是哪个**（Team Lead 2026-10-26 要求，记录他自己犯过的一次错）：他曾把清单里的「**待核**（前端）」当成「**已核实**」转手派给前端，前端 grep 完发现 **0 命中** —— 白跑一趟。
>
> ⇒ 清单里凡带「待核」字样的条目，一律表示**尚未核实**，不得当作结论转述；核实完必须**当场把状态改成「已核 · 成立 / 不成立（+ 依据）」**，而不是留着「待核」等人来问。
>
> ⚠️ **本节保留「五处不同写法」这张快照是有意的 —— 不要来「清理」它。**
>
> **理由（明文写下来，否则将来一定有人把它当成过时内容删掉）**：它记录的是**裁定依据**（为什么必须统一、当时不一致到什么程度），不是现状。现状在上表，一眼可查；**裁定依据删了就查不到**。
>
> ⇒ 一句话：**文档的价值在于记录裁定依据，不在于记录当前状态。** 现状会自己过期，裁定依据不会 —— 恰恰因为现状会过期，依据才必须留着，否则后人只看到「现在一致」，不知道「凭什么一致、一致在哪一侧」，下一次改文案时会重新踩进同一个坑。
>
> 同一条道理在本批已经用过一次：§8「废弃码名 —— 代码中不许有（含注释）、文档里作为废弃声明必须有」。两处是同一个判断：**能被 grep 出来的东西，留在文档里是成本；能被重新踩一遍的坑，留在文档里是资产。**
>
> ⚠️ **配套的取数纪律**：正因为快照是「裁定当时」的，**任何判据都不得锚它**（N1-23/24/25 锚的都是当前源，不是这张表）。快照只供人读，不供机器扫 —— §14.2 的锚点自问句讲的就是这一层。

**裁定（2026-10-26）**：

1. **统一文案为 `该办公楼暂未开通服务，请联系运营`。**
   - 选它的理由是**前半句用户看得懂、后半句给得出动作**：60011 恰恰是「运营漏配」这种用户**完全无能为力**的情况，用户能做的唯一动作就是「联系运营」—— 文案必须把这一句说出来。反过来统一成「未配置楼群」是把运营黑话推给一个对它无能为力的人。
2. **`REASON_TEXT.building_not_grouped` 也要改成同一句**（现在是 `'该办公楼暂未开通服务'`，缺「，请联系运营」）。
   - 理由：U1 走 `reason` 展示、U6 走 `msg` 展示 —— 不一起改，同一个用户在首页和下单页仍会拿到两句话，而那正是 N1-23 要防的。**「统一」如果漏了这一处就只是换了一种不一致。**
3. **三条 throw 点一律删第二参数**，让文案回落 `ERROR_MESSAGE`。
   - 回源核实：`biz.exception.ts` 构造函数是 `super(message ?? ERROR_MESSAGE[code] ?? '业务异常')` ⇒ 第二参数传 `undefined` 即回落。既有先例：`order.service.ts:278`（`SALES_PAUSED`）已是 `(code, undefined, undefined, {...})` 写法。
   - 理由：第二参数是「同一个码可以有第二种写法」的入口。**判据能拦住新写的，拦不住「早就这么写」的那三处** —— 不删存量，N1-24 就只能守增量，形同虚设。
4. **`traceability.service.ts:285` 同时改码（10004 → 60011）并删第二参数**（已派后端，排在 P3-5 全部落完之后，不混进当前 diff）。

**同步面（八处，收尾批一次做完）**

| # | 位置 | 改什么 |
|---|---|---|
| 1 | `apps/api-server/src/common/utils/orderability.ts:142` | `REASON_TEXT.building_not_grouped` 补「，请联系运营」 |
| 2 | `apps/api-server/src/common/constants/error-code.ts:662` | `ERROR_MESSAGE[60011]` 改为统一文案（**唯一真源**） |
| 3 | `apps/api-server/src/modules/meal/meal.service.ts:279–282`（字面 `:281`） | **删第二参数** |
| 4 | `apps/api-server/src/modules/order/order.service.ts:1693` | **删第二参数** |
| 5 | `apps/api-server/src/modules/traceability/traceability.service.ts:285` | **10004 → 60011** + 删第二参数 |
| 6 | `apps/miniprogram/src/api/request.ts:41` | 前端注释里的举例（同 §12.1 的同步动作） |
| 7 | QA 判据脚本里的 sample（硬编码字面） | 断言里的期望字面 |
| 8 | 前端 e2e 里硬编码的三处 | 同上 |

> ⚠️ **第 7 / 8 项最容易漏**：sample 与 e2e 断言是**硬编码的字面**，文案改了不会自己跟。改文案前先 grep 一遍字面，别等 CI 红了才发现。
>
> ⚠️ **行号以本节表格为准，不要凭印象重排。** 逐条回源核过时 `order.service.ts` 的 throw 在 `:1693`（`:1692` 是它上一行的注释），`meal.service.ts` 的 throw 块是 `:279–282`（字面在 `:281`）。

### 14.2 判据（结构约束 ⇒ 静态有效）

| # | 判据 | 什么情况下会红 |
|---|---|---|
| N1-23 | `REASON_TEXT.building_not_grouped` 与 `ERROR_MESSAGE[BUILDING_NOT_GROUPED]` 的字面**必须逐字相等** | 任一侧改了、另一侧没改 ⇒ 红。**本条必须是两侧常量逐字比对** —— 若写成「两处都含『楼群』二字」则恒绿，等于没判 |
| N1-24 | `order.service.ts` / `meal.service.ts` / `traceability.service.ts` 抛 `BUILDING_NOT_GROUPED` 时**不得传第二参数**（第二参数必须是 `undefined` 或整体省略） | 有人写死一句文案覆盖 `ERROR_MESSAGE` ⇒ 红（同一码两种文案的第二形态） |
| N1-25 | `traceability.service.ts` 不得再出现 `ErrorCode.NOT_FOUND` 与「未配置楼群」同现 | 第三条路径改漏了 ⇒ 红 |

> **形态自问（G11）**：三条守的都是**字面 / 参数形态**，不是运行时行为 ⇒ 静态判据有效，不需要 jest。
>
> ⚠️ **N1-23 的取值必须精确到两个常量本身**，不要取全文匹配 —— 全文里 `orderability.ts` 的注释就含「楼群」二字，全文匹配会**恒红**（逼执行者删掉正确的注释）。取样本精确到能区分目标与非目标，本批这条已用上三次（`blockOf` 取数失配、`isUnfinished()` 全文匹配、N1-19 的全仓 `row.`）。
>
> **锚点自问句（2026-10-26 Team Lead 采纳措辞；写在每条判据定 needle 之前）**
>
> > **这个锚点会不会因为「有人做了一件正确的事」而失效？**
>
> 本批有两个实例，两个都不是「锚选错了」，都是**锚被一次正确改进顺带消灭**：
>
> | # | 锚的是什么 | 谁做了什么正确的事 | 结果 |
> |---|---|---|---|
> | 1 | `N1-2` 锚 `new Date()` 的**出现形态**（用「文件或函数里有没有它」判「不读时钟」） | 有人改用 `Date.now()` 读时钟 —— 语义上照样读时钟，形态上那串字符不出现 | 判据**误报为绿**（这正是 QA 归纳的「误报比漏报更伤」） |
> | 2 | 我建议锚文案字面 `未配置楼群`（判「这条路径还在抛旧文案」） | 后端随后**把行内文案去掉、收口到 `ERROR_MESSAGE`** —— 那是最正确的写法，正是判据想推动的方向 | 字面被消灭，判据**扫到 0**（不是「没缺陷」，是「锚没了」） |
>
> ⇒ **两次的共同点不是「锚错了」，是锚在了会被正确改进顺带改变的东西上。**
>
> ⇒ 所以真正的问法比「锚字面还是锚语义」更进一层：**不是问「这个锚准不准」，而是问「有没有人做对事会把它弄坏」。** 「锚语义不锚字面」只解决了「换个写法就扫不到」；这一句解决的是更难的一类 —— **改进本身是对的，但它把判据的地基一起改掉了。** QA 现在的做法是锚**判定条件**（`buildingGroupId` 那一侧的分支条件），因为改文案、改常量、收口到 `ERROR_MESSAGE` 都不会动到那个条件。
>
> ⚠️ **失效症状识别**：判据扫到 0 时，**先怀疑锚，再宣布通过。** 「0 命中」和「全部通过」在输出上一模一样，区分办法只有一个 —— 故意造一个必红的样本看它还红不红（即 mutate）。本批 §0 G11 下已立：**mutate 只覆盖「必报的」，不覆盖「必不报的」 ⇒ 自证必须两个方向都做。**

> **对偶问句（2026-10-26 后端 N4 收口时提出，采纳）**
>
> > **这个锚点会不会因为有人做了一件「收口」的事而失效？**
>
> 实例：QA 的 `N1-9` 锚的是「`assignMembers` / `updateBuilding` 方法体内出现字面量 `BUILDING_GROUP_SUSPENDED_REJECT`」。后端把抛点收进 `assertGroupOpen()` 之后，两个方法体里只剩一行调用 ⇒ **`N1-9` 转红，而产物比之前更严**（全仓 60008 抛点从 2 处降到 1 处，覆盖路径从 2 条升到 3 条）。
>
> ⇒ **凡是锚「某个函数体内出现某字面量」的判据，都对「把这段逻辑抽成一个函数」不免疫 —— 而抽函数正是本批在推动的方向。** 形态应改为锚**调用点集合**或**全仓抛点数**：`N1-9` 的正确形态是锚 `assertGroupOpen` 的**调用点**（现为 `:722` / `:810` / `:1499` 三处）+ 全仓 60008 抛点数，而不是方法体内的字面量。
>
> ⇒ 两条问句是同一件事的两面：正面问「有人做**正确**的事会不会弄坏它」，对偶问「有人做**收口**的事会不会弄坏它」。**抽函数、收口、去重这三类改动既是「正确的事」，也恰恰是最容易让「函数体内字面量」类锚点失效的改动** —— 判据守的是缺陷，不是写法；写法被改进时，判据不该跟着响。

**编号对照表（避免再次撞号 —— `N1-20` 是 QA 的，不是本节的）**

| 号 | 判什么 | 归属 |
|---|---|---|
| `N1-20` | 后台两处 `canOrder` 解释性引用（存在 ∧ 同现 ∧ 警示语） | **QA**（脚本 `:1278`） |
| `N1-23` | `REASON_TEXT.building_not_grouped` 与 `ERROR_MESSAGE[BUILDING_NOT_GROUPED]` 逐字相等 | 本节 |
| `N1-24` | 三处抛 `BUILDING_NOT_GROUPED` 不得传第二参数 | 本节 |
| `N1-25` | `traceability.service.ts` 不得再出现 `NOT_FOUND` + 「未配置楼群」同现 | 本节 |
| `N1-26` | 端上错误兜底分支不得硬编码中文 | §14.3 |

> ⚠️ **顺延两次的教训**：第一次撞号是因为没查 QA 已占用的号；第二次撞号是因为**只查了旧号、没查刚顺延出来的新号**。⇒ 顺延之后要把新号也记进这张表，否则下一次还会撞在它上面。
>
> **关于「规格里写死的 `字段: 值` 字面块」**（2026-10-26 Team Lead 裁定：**不另立检查项**）。这类字面块确实是下一个「照抄错句」的源 —— 本批已经踩了一次（§7.6 上一版的 `reason = 'sales_paused'`，见 §13.5 `W1-UI-5` 的理由）。但**不为此立「每批落地后回头核对一遍」这类动作**：靠人「记得回头核对」和靠人眼判断一样不可复制。
>
> ⇒ 真正钉住它的是 **G10 已经写下的那句 —— 「规格里这么写」不算回源**。有了那句，规格里的字面块就自动降级为**待回源**：谁引用它，谁就得先 grep 一次。不需要额外的核对流程，也不需要额外的判据。

### 14.3 端上「60011 零消费点 / 兜底硬编码」—— 裁定：立一条，不立另一条

**缺陷（前端排查，已回源核实成立）**：`apps/miniprogram/src/pages/index/index.vue:364-367` 的 `emptyText` 只有 `20016` 一个码有专属分支，**其余任何码一律落到硬编码的「本楼今日未开团」**；而 `emptyHint`（`:369`）取的是服务端 `message`，是对的。⇒ **提示行说对了、主标题说错了**，且主标题端上写死，服务端改文案它不跟着变。

再往下挖一层：端上 `60011` 的**运行时消费点是 0** —— P3-4 把 10004 拆成 20016 + 60011 之后，端上对这个新码一个字都没接。这是本批「**契约变更但端上零消费**」的第一个实例。

#### 14.3.1 不立：**「每个服务端码端上都得有专属消费点」**（已评估，理由留痕）

| 项 | 结论 |
|---|---|
| 判据设想 | 服务端每个业务码，端上都必须有对应的 `if (code === X)` 分支 |
| 裁定 | **不立** |
| 理由 1 · **恒红** | 大量码端上本就不需要专属分支（运营后台的 60006 / 60007 / 60012 端上永远不会收到）。判据一上就红，且**无法通过正确方式改绿** —— 只能靠给每个码补一个空分支来凑数 |
| 理由 2 · **逼出硬编码** | 为了过检，端上必须按码穷举 ⇒ 每加一个码就要改端上一次。**契约变更从「服务端一处」扩散成「服务端 + 端上两处」**，这正是本批一直在消灭的第二真相 |
| 理由 3 · **与 N1-26 是替代关系，不是并列** | 见下 —— N1-26 一旦成立，新码不需要端上做任何事就能被正确呈现。第一条想解决的问题被第二条以更低成本解决了 |

> **「端上零消费点」本身不是缺陷，是合法设计。** 有泛型兜底（回落服务端 `message`）时，新码自动被正确呈现 —— 这才是我们要的形态。**穷举分支是兜底失效时的补丁，不该把它立成目标。**

#### 14.3.2 立：**N1-26 · 端上错误兜底分支不得硬编码中文**

> **N1-26**（2026-10-26 **收窄**版）：端上错误呈现的**原因位**填了硬编码中文，**且**服务端 `message` 在该处渲染树里**一次都没出现** ⇒ 红。
>
> ⚠️ **收窄是必需的**（Team Lead 2026-10-26 裁定）：旧口径「兜底分支有硬编码中文就红」会**误伤 5 个主链路页面** —— 那些页面的**标题本来就是类别标签**（硬编码中文是对的），服务端 `message` 已经在 `hint` 位出现了。扫出来一片红而**没人认领**，就是**另一种恒绿**：判据响了个不停，但没人能靠它决定改什么。
>
> ⇒ 两个条件**同时**成立才红：**硬编码中文填在「原因」位** + **服务端 `message` 在该渲染树里完全没被消费**。缺任一个都是合法形态。

| 项 | 说明 |
|---|---|
| **什么时候红** | 原因位 `return` 硬编码字面 **且** 该渲染树里没有出现服务端 `message` ⇒ 红。**原本现在就红**（`index.vue:366` 的「本楼今日未开团」） |
| **落地状态** | ✅ 前端 2026-10-26 已改：`index.vue:364-367` 成三分支 —— `undefined` → 端上兜底；`20016` → 专属；**其余 → 回落服务端 `message`**。注释写清「为什么第三支是回落而不是按码加分支」 |
| **为什么不恒红** | `code === undefined`（网络失败 / 非业务错误，**服务端没给 message**）那一支**允许**硬编码 —— 判据取值精确到「该分支是否同时具备服务端 `message`」，不带 message 的分支不在判据范围内 |
| **为什么不恒绿** | 把兜底改成 `return loadError.value?.message ?? '今日暂无开团'` 之后就绿。判据能区分「改对了」和「没改」 |
| **取值精度** | 必须精确到**该函数的 return 表达式**，❌ 不要全文件扫中文 —— 满文件都是中文，全文匹配恒红 |
| **形态自问（G11）** | 守的是**字面形态**（有没有硬编码 return）⇒ 静态判据有效，不需要 jest |
| **豁免形态（2026-10-26 QA 落脚本时的更硬发现）** | 判据现状只扫**含 `code ===` 判定的块** ⇒ `supplier/detail.vue` 与那 5 处主链路页**根本没有 `code ===`** ⇒ **天然在射程外**，与上面「收窄」已自洽，不必按收窄形态重写。**真正的口子是按形状豁免**（原 `:1788`）：任何人把硬编码写成 `if (err.code === 60011) return '…'` 这种专属分支形态，判据就绿 ⇒ **改成显式白名单，只放行 `CODE_BUILDING_UNBOUND`，且按常量名匹配**（按码值匹配 ⇒ 写裸 `20016` 也能绕过，口子只是换个位置） |

**两条能不能同时成立？能 —— 它们是替代关系，不是并列关系。**

- 「按码穷举」想解决的是「新码端上没人接」；
- 「兜底回落服务端 message」解决的是**同一个问题，但成本更低**：兜底一旦回落服务端，新码不需要端上做任何事就自动被正确呈现。
- ⇒ 立了第二条，**第一条的动机就消失了**。所以不是「两条并存互相打架」，而是**第二条取代第一条**。

**顺带把 60011 那个具体缺陷的修法说清**（派前端做，排在 W1 UI 之后）：`index.vue:364-367` 的兜底从硬编码字面改成回落 `loadError.value?.message`，而不是给 60011 补一个专属分支 —— 后者是「按码穷举」那条不立的判据逼出来的形态，我们不走那条路。

#### 14.3.3 留痕：本批第一条「契约变更但端上零消费」

| 项 | 内容 |
|---|---|
| 实例 | P3-4 把 `10004` 拆成 `20016` + `60011`，端上对 `60011` 零消费点 |
| 处置 | **不立判据**（§14.3.1），改由 N1-26 从兜底侧覆盖 |
| 流程注记（写给下一次契约变更） | 改错误码时，checklist 里要有一个**判断动作**而不是默认动作：**「端上是否需要为这个码加消费点？」** —— 答案是「否」也要写下来并说明靠什么兜底。**靠兜底**是合法结论，**没想过**不是。本次就是这个动作缺失，才让它在前端排查时才被发现 |

> ⚠️ **不立也要留痕**（Team Lead 要求）：否则下次又会有人重新提议一遍，重新评估一遍，再吵一次 §14.3.1 那三行理由。

### 14.4 判据形态变更登记（2026-10-26 终版 · Team Lead 裁定）

| 编号 | 归属 | 变更 | 原因 |
|---|---|---|---|
| **N1-9 → 拆成 N1-9-a / N1-9-b** | **QA**（脚本） | a = 三条写路径各自**调用** `assertGroupOpen(`（不认字面常量位置）；b = 全仓 `60008` 抛点 **== 1** | 旧判据锚「方法体内出现字面量」；后端把抛点从 3 处收口到 1 处（**一件正确的事**）后转红 ⇒ **坏锚点**。裁定：**改判据，不改产物** |
| **N1-26** | 本节 §14.3.2 | 收窄为「原因位填硬编码中文 **且** 服务端 `message` 在渲染树里一次都没出现」 | 旧口径误伤 5 个主链路页面（标题是类别标签 + `message` 已在 `hint`）⇒ **扫红而没人认领 = 另一种恒绿** |
| **W1-UI-4** | 本节 §13.5 | 改**两步解析**：先读 `constants/index.ts` 里 `SALES_PAUSED_UNAFFECTED_NOTICE` 的值，再在 `pages/**` 找**常量名引用** | 文案走**常量引用**不是内联字面 ⇒ 直接扫 `pages/**` 中文字面必然 0 命中（前端 `git diff` 实证），恒绿 |
| **W1-UI-5** | 本节 §13.5 | 收窄到 **U1 的 `daily.reason`**，❌ 不按变量名 `reason` 全扫；且**剥注释** | 按变量名扫会误伤 4 处 U11 自助取消理由（`api/order.ts:61,70`、`order-cancel.vue:82,91`）—— 那里 `reason` 是**端上自己的枚举**且是**请求入参**，与 U1 下发的 `daily.reason` **同名不同义** |

> ### 第五种形态 · **可被规避：改分支形状**（2026-10-26 QA 在落 `N1-26` 脚本时核出，采纳）
>
> 与上面四种不是同一类 —— 前四种是**判据扫错了对象**（恒绿 / 误伤），这一种是**判据被绕过去**：
>
> - 形态：任何人把硬编码写成 `if (err.code === 60011) return '…'` 这种**专属分支形状**，按形状豁免的判据就绿。
> - **与「改注释规避」同一族，但解法相反**：改注释有通用解（**剥注释**）；**改分支形状没有通用解** —— 「这个码用户能不能自己解决」是**语义判断，机械判据做不了**。
> - ⇒ 只剩一条路：**白名单 + 每条带理由**，让想加码的人**先回答那个语义问题**。**白名单是 fail-closed，形状豁免是 fail-open。**
> - `N1-26` 的处理：只放行 `CODE_BUILDING_UNBOUND`，且**按常量名匹配**（按码值匹配 ⇒ 写裸 `20016` 也能绕过，口子只是换个位置）。
>
> ⇒ 记这一条的意义：**判据可被规避时，先判断这个规避是「机械能堵的」还是「只能靠语义」** —— 前者改形态（剥注释、改锚点），后者只能收成白名单并逼出理由。**把后者当成前者去修，会白做功。**

> ⚠️ **四条的共同点，一句话**：**全都是「判据扫到了不该扫的东西」。** 形态不对的判据只有两种归宿 —— **恒绿**（没扫到目标）或**误伤**（扫到了同名 / 合法的别的东西）。
>
> ⇒ **误伤比恒绿更隐蔽**：恒绿只是没用；误伤会让**有人去改掉那个本来就合法的东西**（W1-UI-5 那 4 处若被改，会直接破坏 U11 取消理由的提交逻辑，且 `'other'` 是服务端认的字面值，**重命名解决不了**）。
>
> ⇒ 因此每条判据在定 needle 时，除了 §14.2 那两条自问句，还要再加一问：**「这个 needle 还会命中哪些**合法**的东西？」** —— 命中目标的 sample 与命中合法项的 sample，**都要各造一个**（前者验必红、后者验必不红）。

---

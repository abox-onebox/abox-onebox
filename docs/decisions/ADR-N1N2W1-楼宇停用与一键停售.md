# ADR-N1N2W1 · 楼宇停用与一键停售的口径收口与闸门

- **Status** **Accepted**（2026-10-26 · Team Lead 已裁定 §10 五项开放项 + 错误码号位；可据此进入 Phase 3）
- **Date** 2026-10-26
- **Deciders** 架构师（提案）· Team Lead + 用户（业务口径已拍板）· QA（判据复核）
- **Supersedes** `apps/api-server/src/modules/building/building-admin.service.ts` 文件头「裁决 3」（第 65–70 行）
- **Related** 《ABox一盒接口规范 v1.0》§3.1 U1 / §3.3 U6 · §6.3 D13–D18 · §6.7 D57/D58 · 《ABox一盒订单状态机与全链路流转 v1.0》§1.1 · `docs/qa/AC-N1N2W1-楼宇停用与一键停售.md`
- **版本锚定** NestJS 10.3 · TypeORM 0.3.17 · pnpm 9.0.0 · `@abox/shared-types` workspace 版 · 后端 API 前缀 `/api/v1`，业务失败一律 HTTP 200 + `body.code != 0`

> 本 ADR 只做**设计与裁决**，不含任何业务代码改动。所有行号为 2026-10-26 回源核实的结果，动工前请以当时代码为准复核一遍。
>
> ⚠️ **通用纪律条目（G1…G14）的唯一住所是落码规格 §0 的 G 表，本 ADR 不复制。** 本文件凡引用纪律只写编号（如「（G12）」「（G10）」）并**指回 `docs/specs/PHASE3-N1N2W1-落码规格.md §0`**；需要看原文时去那里，不要在本文件另存一份。⇒ **下一批新增 G 条目（G15 及以后）一律进落码规格 §0，不进本 ADR**（理由：跨批通用纪律一旦两边各长一份，就是「同一议题两个真源」，改一边另一边静默变假 —— 与 `admin-role.ts:187`「别抄数组、指向数组」同一个解法）。

> ### ⚠️ 行号漂移对照表（**2026-10-26 收盘 · 终版 · 第 5 版 · 全部锚点 re-grep 复核**）
>
> 本 ADR 成文时 P3-4 未落地，此后 **P3-4 / P3-5 / P3-6 / 收尾批 / W1 / N4 + 通知回归** 全部落地。**正文里仍写旧号的地方以本表为准**：
>
> | 锚点 | 第 2 版旧号 | **当前实际（第 5 版 · 终版 · 已 grep 核实）** |
> |---|---|---|
> | `meal.service` U1 `canOrder` | `:142` | **`:142`**（未漂） |
> | `meal.service` U1 `reason`（⚠️ **下发的是文案**） | — | **`:144`**（`reason: availability.reasonText` —— §7.6 纠错的关键证据，第 2 版未登记） |
> | `meal.service` 抛 `USER_BUILDING_UNBOUND` / `BUILDING_NOT_GROUPED` | `:265` / `:279` | **`:265` / `:279`**（未漂，第二参数已删） |
> | `order.service` 抛 `BUILDING_NOT_GROUPED`（带 payload / U6 主路径） | `:293` / `:1693` | **`:313` / `:1713`**（**已漂 +20**，第二参数已删） |
> | `order.service` 抛 `SALES_PAUSED` | — | **`:298`**（第 3 版未登记）；上方 **`:278–289`** 是本批新增的 60009 payload 注记，**纯注释** |
> | `order.service` 抛 `USER_BUILDING_UNBOUND` | `:1686` | **`:1706`**（已漂 +20） |
> | `traceability.service` 抛 `BUILDING_NOT_GROUPED` | `:285` | **`:285`**（未漂，码已 10004 → 60011） |
> | `workbench.service` `tomorrow.canOrder` | `:139` | **`:139`**（未漂）；**新增** `reasonText` **`:141`** |
> | `building-admin.service` `canAssign` 四处 | `:305 / :416 / :726 / :825` | **`:326 / :437 / :753 / :851`** |
> | `building-admin.service` `canAssignCount` | `:346` | **`:367`**（列表）/ **`:561`**（概览，即第三份判据那一处） |
> | `building-admin.service` `canOrder` **解释性引用**注释 | `:305–308` | **`:316–320`** |
> | `building-admin.controller` Swagger 描述 | `:60–62` / `:140` | **`:60–62` / `:140`**（未漂） |
> | `error-code.ts` `60011` 的 `ERROR_MESSAGE` | `:668` | **`:668`**（未漂，文案已统一） |
> | `orderability.ts` `REASON_TEXT` | `:149` | **`:137`**（表）/ **`:151`**（`building_not_grouped`）；⚠️ **`sales_paused` 现为空串**，真身在 `reasonText()` |
>
> **第 5 版新增 / 变更符号（均已 grep 核实）**
>
> | 符号 | 位置 | 备注 |
> |---|---|---|
> | `evaluateStructure` / `evaluateAvailability` / `reasonText` | `orderability.ts:80` / `:108` / `:186` | 纯函数三件套 |
> | `OrderAvailability` / `forUser` / `forBuilding` / `salesPaused` / `resolve` | `order-availability.service.ts:14` / `:45` / `:51` / `:76` / `:98` | `salesPaused` / `resolve` 是 `private` |
> | `assertBuildingSuspendable` / `assertGroupSuspendable` | `building-admin.service.ts:1336` / `:1349`（调用点 `:819` / `:1142`） | 第 2 版记 `:1300` / `:1310` |
> | **`groupGate` / `assertGroupOpen`** | `building-admin.service.ts:1583` / `:1595` | **N4 新增**；三条写路径调用点 `:722` / `:810` / `:1499`；**全仓唯一抛点 `:1601`** |
> | **`assertGroupExists`** | — | **已删除，全仓 0 命中** |
> | 三条写路径 `createBuilding` / `updateBuilding` / `assignMembers` | `building-admin.service.ts:712` / `:762` / `:1490` | 第三条（`createBuilding`）本 ADR 上一版漏登记（§1.4 / D-N1-7）。**「三条」= 当前已知**，边界见 §1.4 |
> | `buildingRepo` 的 4 处写操作 | `building-admin.service.ts:724` / `:828` / `:1507` / `:1517` | 六类穷尽性核查的结果（§1.4） |
> | `notifySuspendAffected()` 的 `variables` 白名单 | `['mealDate', 'orderNo']` | `orderNo` **只落 `ab_message.payload`**，不进 `wxData`、不进文案 |
> | **`test/unit/suspend-notify.spec.ts`** | 新增 | 覆盖 D-N2-3b（本批最重的用户可感缺陷，一度**零覆盖**） |
> | `SalesPauseController` / `list` / `create` / `resume` | `sales-pause.controller.ts:47` / `:57–58` / `:70` / `:78` | ⚠️ `list()` **返回裸数组**，不套 `{list}` |
> | `SalesPauseService` / `list` / `create` / `resume` | `sales-pause.service.ts:43` / `:56` / `:69` / `:91` | `list(): Promise<SalesPause[]>` |
> | `CreateSalesPauseDto` | `sales-pause.dto.ts:33` | `reason` 强制必填 |
> | `SalesPause` 实体 | `system.entity.ts:486` | 未漂 |
> | 停售菜单 `OPERATOR_EXTRA_MENUS` | `admin-role.ts:132–138` / `:153` | |
> | admin-web 路由 | `routes.ts:333–341` | `system/sales-pause` |
> | `forceSuspend` | `building/dto/building-admin.dto.ts:289` / `:444` | 第 2 版路径记错（漏 `dto/`） |
> | `suspend_building` / `suspend_building_group` | `operation-request.service.ts:45–46`（文案 `:59–60`） | 未漂 |
> | `building.suspend_force_max_count` | `config.specs.ts:438` | 未漂 |
>
> ⚠️ **与落码规格头部是同一张表**（G12）—— 两份文档以本表为准。**下一次有人改动上述任一文件 —— 包括只改注释 —— 本表即作废，需重新 re-grep**（G10）。
>
> ⚠️ **第 3 版 → 第 4 版就是被「只改注释」推翻的**：后端在 `order.service.ts` 加了一段**纯注释**（60009 payload 现状注记，现 `:278–289`），逻辑一字未动，把该文件的三个已登记锚点整体推了 **+20** 行（第 4 → 5 版又微调 3 行）。⇒ **「我就改个注释」恰恰是这张表最常见的作废方式。**
---

## 0. TL;DR

| 编号 | 议题 | 裁决 |
|---|---|---|
| **N1** | canOrder 口径 | **不合并成一个函数**，分两层：`evaluateStructure`（无时间维度，管家端与用户端共用同一实现）+ `evaluateAvailability`（结构层 ∧ 编排层 ∧ 时间层 ∧ 停售层，只有用户端用）。既有的 `isOrderable()` 是时间层，口径沿用但不再被四处直接调用。谓词归属：`common/utils/orderability.ts`（纯函数）+ `common/services/order-availability.service.ts`（IO 编排，`CommonModule` 是 `@Global()`） |
| **N2** | 停用前校验 | 未完结用 `Not(In(ORDER_TERMINAL_STATUS))` **反算**（当前 8 态），禁硬编码。8 态再拆**两组**：履约中四态 **硬约束不可撤回**（60013）；其余四态走**分级拦截**（N=0 放行 / 1–20 force+reason / >20 走 OperationRequest，超阈值是 60012）。阈值读 `ab_config` 新建 `building.*` 命名空间 |
| **W1** | 一键停售 | **净新增功能**（全仓零实现），落独立表 `ab_sales_pause`，支持日期区间，「停售明日」= `from == to` 的退化形态 |
| **业务口径** | 用户已拍板三项 | ① `pending_pay`/`paid` → 继续履约 + 必须通知用户，**不得批量退款**；② `cut_off`→`delivered` → **强制继续履约，运营无权撤回**（不可配置，60013）；③ 分级拦截阈值 |

---

## 1. 背景

### 1.1 已回源核实的现状（可复核，非推测）

| # | 事实 | 位置 |
|---|---|---|
| F1 | 后台楼宇 `canOrder` = `status === ACTIVE && gid !== null` | `building-admin.service.ts:259 / 370 / 680 / 774`（**P3-4 后漂移**，原 `218 / 325 / 623 / 701`）|
| F2 | 用户端 U1 `canOrder` = `assignment.status === 'active' && isOrderable(...)`，**楼宇状态完全不参与** | `meal.service.ts:104` |
| F3 | 团长工作台 `tomorrow.canOrder` = 只有 `isOrderable(tomorrow, cutoff)`，**既不看 assignment 也不看楼宇** | `workbench.service.ts:139`（**P3-4 后漂移**，原 `:123`）|
| F4 | 套餐分配 `ab_meal_assignment` 是**楼群维度** | `meal-admin.service.ts:235`（Map key = `` `${a.mealDate}#${a.buildingGroupId}` ``）|
| F5 | 订单 `ab_order` 同时有**楼宇维度索引**与 `building_group_id` 列 | `order.entity.ts:19` `idx_order_building_meal(['buildingId','mealDate'])`；`order.entity.ts:47–48` |
| F6 | `BuildingStatus`（1/2/3）与 `BuildingGroupStatus`（1/2）是两套枚举，值域刻意不同构 | `packages/shared-types/src/enums/building-admin.ts:26–33 / 57–62` |
| F7 | 楼宇停用零校验，一行直接 patch | `building-admin.service.ts:678` |
| F8 | 楼群停用只拦「成员楼非空」，不拦未完结订单 | `building-admin.service.ts:967–979`（`BUILDING_GROUP_NOT_EMPTY` / 60003）|
| F9 | 终态常量已存在：`ORDER_TERMINAL_STATUS = [completed, cancelled, refunded]` | `packages/shared-types/src/enums/order-status.ts:88–92` |
| F10 | 现成的反算写法：`where: { userId, status: Not(In(ORDER_TERMINAL_STATUS)) }` | `user.service.ts:212` |
| F11 | 现成的判据风格：先搬楼再判闸门 + `hint` 载荷 | `building-admin.service.ts:958–979` |
| F12 | 6xxxx 号段只用到 60001–60005 | `common/constants/error-code.ts:491–506` |
| F13 | 迁移已到 `1700000000018-referral-user.ts`，实体 33 张 | `apps/api-server/src/database/migrations/` · `database/entities/index.ts` |
| F14 | `CommonModule` 是 `@Global()` | `common/common.module.ts:55` |
| F15 | 高危审批通道已存在：`OP_ENDPOINTS` + 两级 approve→execute，execute 自调用原 controller | `operation-request.service.ts:31–42`（`OP_ENDPOINTS`）、`:20–29`（执行机制注释）|
| F16 | 消息编排服务已存在：`MessageOrchestratorService.orchestrate(input)` | `message-orchestrator.service.ts:81` |
| F17 | W1 全仓零实现（`停售 / stop_sale / globalStop / 全局停` 无命中，`config.specs.ts` 无键） | — |

### 1.2 根因：不是「三套口径要合并」，是「两层语义没分开」

`canOrder` 在四处出现，问的是**两类**问题，差别在**有没有时间维度**：

| 位置 | 真实语义 | 时间维度 |
|---|---|---|
| 后台楼宇列表/详情 | 这栋楼**配置上**具备接单条件（运营 KPI flag） | **无**（结构性） |
| U1 明日套餐 | **此刻**用户能否下单 | **有**（publishAt ~ cutoff） |
| U6 下单 | **此刻**这一笔能否落库 | **有** |
| 团长工作台 | **此刻**还能不能再追加 | **有** |

⇒ **裁决 0-C（采纳 QA，我复核后认可）：不合并。**

若强行把四处合成一个 `canOrder()`，管家端会被时间污染：运营夜里看 KPI，一栋楼因为「过了截单」显示 `canOrder = false` —— 把**周期性状态**误报成**配置缺口**。这正是 `building-admin.ts` 枚举注释里明令要治的病（「`2` 有两种含义 ⇒ 界面分不出来」），等于在另一处 reintroduce 同族缺陷。

正确形态是**共用结构层、各自决定叠不叠时间**：

```
// common/utils/orderability.ts（纯函数，零 IO / 零 DI）
evaluateStructure(scope)      // 楼 status + 群 status + 归群      ← 管家端与用户端共用同一实现
evaluateAvailability(input)   // 结构层 + 编排层 + 时间层 + 停售层  ← 只有用户端用它
                              //   内部调用 evaluateStructure，时间层沿用既有的 isOrderable() 口径

用户端 U1/U6/工作台  canOrder = evaluateAvailability(...)   // 结构 ∧ 编排 ∧ 时间 ∧ ¬停售
管家端 building-admin  canOrder = evaluateStructure(...)    // 不叠时间，保留原语义
```

> **命名统一（2026-10-26 修订）**：本 ADR 早期稿在 TL;DR 与本节用过 `isOrderableStructure` / `isOrderableNow` 两个名字，与 §2.1 的正式签名不一致 —— 同一件事两个名字，正是本批要消灭的同族缺陷，**提这条的人自己先犯了**。全文档统一为 `evaluateStructure` / `evaluateAvailability`（与 `docs/specs/PHASE3-N1N2W1-落码规格.md` §3 一致）。`isOrderable()` 这个**既有的**时间层函数保留原名不动，它只出现在描述现状的段落里。

### 1.3 N1 的真实漏洞面比「三套口径」更窄，也更准

用户侧**入口已有两道校验**，这是既有回归基线，**不得被削弱**：

- `user.service.ts:118`（`bindBuilding`）：`if (building.status !== BuildingStatus.ACTIVE) throw` —— 文件内注释写得很直白：「『待开通 / 已暂停』的楼没有开团资格 —— 不给用户一个必然下不了单的选项」。
- `building.service.ts:73`（`listSelectable`）：`where: { status: BuildingStatus.ACTIVE, deletedAt: IsNull() }`。

真正的洞只在两条**读取**路径，都只取 `buildingGroupId`、不读 `status`：

- `meal.service.ts:254–284` `resolveUserGroup()`（**P3-4 后行号**；调用点 `:81` / `:170`）
- `order.service.ts:1673–1696` `resolveGroup()`（**P3-4 后行号**；调用点 `:253`）

⇒ **N1 的实际受影响面 = 「绑定当时是 ACTIVE、之后被运营改成 PREPARING / SUSPENDED 的存量已绑用户」**，新用户根本绑不进来。

两个设计后果：

1. 修复必须落在这两处**读取**，不是再加 bind 校验（那里已经有了，加就是第二份判据）。
2. **`PREPARING` 必须和 `SUSPENDED` 一并处理** —— 存量用户会被运营改到 `PREPARING`（例如楼重新装修、等新团长），此时同样下不了单。只处理 `SUSPENDED` 会漏掉一半受影响面。

### 1.4 一个被忽略的事实（决定了结构层要不要含 `group_suspended`）

`BUILDING_GROUP_NOT_EMPTY`（60003）在语义上保证了：**能成功停用的楼群，成员楼数必然为 0**。按这个不变量，`group_suspended` 分支**永远不可达**。

但这个不变量有**三条**旁路打破它，三条**都未被任何校验覆盖**：

1. `assignMembers()`（`building-admin.service.ts:1490`，调用点 `:1499`）—— 往一个**已停用**的楼群里搬楼，不检查目标楼群状态；
2. `updateBuilding()` 的 `buildingGroupId` 分支（`building-admin.service.ts:762`，调用点 `:810`）—— 把某栋楼挂进一个**已停用**的楼群，也不检查；
3. **`createBuilding()` 新建时带 `buildingGroupId`（`building-admin.service.ts:712`，调用点 `:722`）** —— ⚠️ **本 ADR 上一版漏登记这条**（后端 N4 收口时补出）。原形态只查「在不在」，可以**把楼新建进一个已停用的楼群**：之后该楼因 `group_suspended` 不可下单，而后台回执是「创建成功」。与上面两条同一个病，只是走新建而不是编辑 / 搬楼。

⇒ `group_suspended` 不仅可达，而且走的正是运营最高频的动作（搬楼、新建楼）。因此它必须进结构层谓词，并另设一个错误码堵这**三**条旁路（**60008**，见 §7）。**用户已裁决：60008 本批一起修，不是可选项** —— 它正是同一个可订谓词的一部分，一起修谓词才完整；且走的是运营最高频动作，留着会持续产生脏数据。

> ⚠️ **「三条」的穷尽性与两条边界**（后端 2026-10-26 六类查法核查：**结论 = 穷尽**，但必须带边界一起读 —— 与落码规格 §5.4 同一段，G12）
>
> **「当前已知三条」不是谦辞，是边界**：文档一旦写死「三条」，下一个实现者就不会再去找第四条 —— 与本批 §7.6「照抄规格里一句错话」同源：**写得越像结论，越容易被人当成免去回源的凭据。**
>
> 六类查法：`buildingRepo` 全部写操作（4 处，全在 `building-admin.service.ts`）/ `buildingGroupId` 全部赋值点（写侧只在该文件）/ 另 18 个用到 `buildingRepo`/`groupRepo` 的 service（全是 `find`，零写）/ 迁移·导入·Excel·定时任务（无）/ `scripts`·`packages`·两个前端（零写）/ 别的表是否承载此外键（**有**，见下）。
>
> - **边界一**：`ab_meal_assignment` / `ab_delivery` / `ab_order` 各有 `building_group_id`，但**不在 N4 受控面里** —— 它们承载的是**快照**，写它们不改变「某栋楼属于哪个楼群」。且 `ab_order` 那一列**本批正是指着它才成立**：楼群按 `building_group_id` 查未完结订单，依据就是「历史单仍指向旧群」，这才抓得到「人已走、债还在」的单。算进来会让受控面失去意义。
> - **边界二**：种子（`seed.ts` / `seed-demo.ts`）是唯一在运行时之外写这个字段的地方，**不堵也不需要堵** —— 空库一次性灌入，此刻不存在「已停用的楼群」；离线夹具，不过 HTTP。

---

## 2. 统一裁决：谓词分两层 + 归属

### 2.1 裁决 2-A · 归属：`common/utils/orderability.ts` + `common/services/order-availability.service.ts`

三个候选的取舍：

| 候选 | 结论 | 理由 |
|---|---|---|
| `building-admin.service` | 否决 | ① **语义错**：它是「后台管理服务」，带 `viewerRole` 权限入参和 4 个后台出参构造函数；让用户端下单判定去依赖它，等于把交易链路挂在管理端上。② **方向错**：`meal` / `order` / `team-leader` 三个模块都得 import `building` 模块，形成「用户端 → 后台管理」的反向依赖，将来后台要加权限/分页参数时会被交易侧拖住。③ 该文件已 1095 行，再加谓词会突破单文件职责 |
| `meal.service` | 否决 | 反向更荒谬：后台（`building-admin`）为了算 KPI 要去 import 用户端套餐服务。且 `meal.service` 的 `resolveUserGroup()` 本身就是 N1 的洞之一 —— **把真源放进一个有洞的文件里，等于让洞自己定义什么叫没洞** |
| **独立共享谓词模块** | **选中** | 见下 |

选中方案的**两个文件**，各解决一个问题：

```
common/utils/orderability.ts                 ← 纯函数：零 IO、零 DI
    · evaluateStructure(scope)   → { ok, reason }          结构层（无时间）
    · evaluateTimeWindow(...)    → { ok, reason }          时间层（拆出 not_open_yet）
    · evaluateAvailability(...)  → { canOrder, reason, reasonText }   用户端编排

common/services/order-availability.service.ts ← Nest service：装载 5 表 + 1 配置，调上面
```

**为什么「归属」这个问题在纯函数层根本不成立**：`common/utils/orderability.ts` 是一个**零依赖的纯函数模块，不构成模块依赖边** —— 就像 `common/utils/time.ts` 一样，本仓 `meal` / `order` / `team-leader` / `building` 全都在 import 它，没人会问「`todayBj()` 归属哪个业务模块」。谓词的判据和 `todayBj()` 是同一类东西：一个不该被任何业务模块私有的事实函数。

**IO 编排层为什么能三处都够得着**：`CommonModule` 是 `@Global()`（`common/common.module.ts:55`），注册其上的 `OrderAvailabilityService` 对 `meal` / `order` / `team-leader` / `building` 四个模块**全部直接可见**，无需任何模块 import 改写。这与既有的 `BizConfigService` / `LeaderLookupService` / `OpBlocklistService` 完全同一手法。

⇒ 三处调用方**只 import 纯函数或注入 `OrderAvailabilityService`**，没有任何一处需要 import 另一个业务模块。循环依赖风险为零。

### 2.2 裁决 2-B · 结构层**不**吃集散中心覆盖（`DistributionGap`）

团队问我是否把 `gap` 并进 `evaluateStructure`。**裁决：不并入。** 三条理由：

1. **项目已明确把「未覆盖」定义为「下单能成立」。** `building-admin.service.ts:279` 的原文是：「『未覆盖』是**下单能成立、履约断链**的状态：用户点得动，却没有集散中心接单配送。」把它并进 canOrder，等于推翻这条已写进代码的口径，并让 `gap` 字段失去意义 —— 从此不可能出现「gap ≠ none 且 canOrder = true」。
2. **它会把一个配置动作静默传导成停摆。** 运营改的是「集散中心服务哪些楼群」（`ab_distribution_center.service_groups`），后果却是「一批楼的用户不能下单」。运营改 DC 时不会预期这个 —— 这正是 `BUILDING_GROUP_NOT_EMPTY`（60003）存在的理由：**静默影响一批楼的动作必须被拦，而不是让它静默生效**。
3. **要拦就拦在正确的位置。** 若产品确实认为「送不出去就不该卖」，正确做法是把闸门加在**集散中心配置动作**上（改 `serviceGroups` 会让某楼群失去覆盖 ⇒ 拦），而不是让下单侧静默失效。那是另一个议题，本批不做（列在 §10）。

⇒ `evaluateStructure` 的判据只有三项：**楼 status、归群、楼群 status**。`gap` 继续作为独立的派生展示值存在，两者不合并。

### 2.3 契约（新增 `common/utils/orderability.ts`）

```ts
/** 结构层输入（无时间维度） */
export interface StructureScope {
  buildingStatus: number | null;      // ab_building.status；null = 楼不存在 / 已软删
  buildingGroupId: number | null;     // null = 未归群
  buildingGroupStatus: number | null; // ab_building_group.status；null = 群不存在
}

/** 用户端完整输入 */
export interface AvailabilityInput extends StructureScope {
  mealDate: string;
  assignmentStatus: string | null;    // ab_meal_assignment.status；null = 无分配
  salesPaused: boolean;               // W1
  cutoffWindowMinutes: number;        // 读自 BizConfigService
  publishAtMs: number;                // publishAtOf(mealDate).getTime()
  cutoffAtMs: number;                 // cutoffAtOf(mealDate).getTime()
  nowMs: number;                      // now().getTime()（时钟注入下仍与 time.ts 同源）
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

export interface StructureResult { ok: boolean; reason: StructureBlockReason | null; }
export interface Availability {
  canOrder: boolean;
  reason: OrderBlockReason | null;   // canOrder === true 时恒为 null
  reasonText: string | null;
}

export function evaluateStructure(s: StructureScope): StructureResult;
export function evaluateAvailability(i: AvailabilityInput): Availability;
```

实现约束（不是建议）：

1. **零 IO、零依赖注入**，只收 string / number / boolean。三个时间毫秒值由调用方算好传进来 —— 调用方仍需服从本项目的时间纪律（`toBjIso()` / `now()` / `bjDateTime()`），纯函数体内不许出现 `new Date()`。
2. **`canOrder` 与 `reason` 由同一次求值产出**，任何调用方不得自行推导其中第二个。「canOrder 一个判据、reason 另一个判据」正是 N1 的原始病灶。
3. **管家端只调 `evaluateStructure()`**，不调 `evaluateAvailability()` —— 这条由 QA 的静态判据 `S-N1-4`（三个 service 内不得再内联 `status === BuildingStatus.ACTIVE &&` 合取字面量）机械锁死。
4. **不抛异常**。纯函数只回答真假与原因；抛什么是调用方的契约责任（管家端不抛、U6 抛），见 §3.5。

### 2.4 reason 优先级（顺序即决策）

**结构层**（管家端与用户端共用）：

```
1 building_not_grouped   → 楼未归群（前置：无 gid ⇒ 楼群级判据无从成立）
2 building_preparing     → 楼 = 待开通（status = 2）
3 building_suspended     → 楼 = 已暂停（status = 3）
4 group_suspended        → 所属楼群已停用
```

**用户端完整优先级**（结构层整体插在时间层之前）：

```
1 sales_paused           → 全局一键停售（W1）
2 ~ 5                    → 上述结构层四条，顺序不变
6 meal_not_published     → 无 assignment，或 assignment.status !== 'active'
7 not_open_yet           → 已上架，但未到开团时刻
8 cutoff                 → 已截单 / 距截单不足 cutoffWindow 分钟
```

**为什么是这个顺序**：粒度粗的判据一旦成立，细粒度判据给用户的结论就是误导。举例：楼群停用时若回「该办公楼今日未开团」，用户读出的可执行结论是「明天再来看看」；实际上明天也不会有 —— 真正的成因在楼群。同理 `building_not_grouped` 必须先于 2/3 判：一栋没进群的楼即使 `status = 1` 也送不了，「营业中」在这里是一个假的安全信号。

`building_preparing` 排在 `building_suspended` 之前没有语义分量（两者都输出不可下单），只是为了 `reason` 可预测 —— **单测必须锁定这张表的全序**。

### 2.5 `reasonText` 走查表，不走嵌套三元

现状 `meal.service.ts:118–124` 是三层嵌套三元，加两条分支后会变成五层。本批改为对 `reason` 做 map 查表（`REASON_TEXT: Record<OrderBlockReason, string>`）。理由不只是可读性：**嵌套三元的求值顺序是隐式的**（调换一行就换了优先级），而查表的优先级显式写在 §2.4 且可被单测锁住 —— 这与「口径必须有单一真源」是同一条纪律的第二次应用。

> ⚠️ **下表是「文案最终长什么样」，不是「从哪张表里取」**（2026-10-26 回源核实后修订，与 spec §3 同步）。
>
> ⚠️ `sales_paused` / `not_open_yet` / `cutoff` 三行在 `REASON_TEXT` 查表里的值是**空串** —— **空串 = 「这句由 `reasonText()` 生成」**，是有意义的空、不是遗漏。真身在 `reasonText()` 的 switch 里（`case 'sales_paused'` 输出 `今日暂停接单：{运营填的原因}`，缺省回落 `今日暂停接单`）。⇒ **不要照本表把代码回改成静态句**；更早那句 `今日暂停接单，恢复时间请以通知为准` 是**旧口径，已不存在**。
>
> **为什么这行旧字面还留在文档里**（2026-10-26 Team Lead 裁定：**保留**）。照 §8「废弃码名 —— 代码中不许有（含注释）、文档里作为废弃声明必须有」的同一判断：**有据可查地废止，优于无迹可寻地消失。** 删掉它，后人 grep 不到就不知道这句曾经存在过，也就不知道「为什么不能写回这句」。
>
> ⚠️ **配套风险（必须一起写）**：全仓 grep `恢复时间请以通知为准` **只剩这一处命中，且在 `docs/` 里**。⇒ **将来若立一条「旧文案不得再出现」的判据，它会命中文档而假红。** 判据扫此字面时**必须排除 `docs/`** —— 这里是**有意的**废弃留痕，不是遗漏。
>
> ⇒ 通律：**这类「有意保留的字面」两边都要写清楚谁该看到它** —— 代码中不许出现（判据扫代码）、文档中必须出现（判据勿扫文档）。本批这次是「保留在文档、判据扫代码」；下次可能反过来。**只写一边，就会有一边假红。**

| reason | 用户侧文案 |
|---|---|
| `sales_paused` | `今日暂停接单：{运营填的停售原因}`（缺省 → `今日暂停接单`）⚠️ 查表里为空串，由 `reasonText()` 生成 |
| `building_not_grouped` | `该办公楼暂未开通服务，请联系运营`（收尾批统一后的最终文案，见 §7.1.1） |
| `building_preparing` | `该办公楼尚未开通，敬请期待` |
| `building_suspended` | `该办公楼已暂停服务` |
| `group_suspended` | `该区域已暂停服务` |
| `meal_not_published` | `该办公楼今日未开团`（与 F2 现有文案逐字一致，不改契约） |
| `not_open_yet` | `今日 {HH:mm} 开团，敬请期待`（沿用 `meal.service.ts:123` 的 `toBjIso(...).slice(11,16)` 拼接） |
| `cutoff` | `距截单不足 {N} 分钟，请明日再订`（沿用 `meal.service.ts:124`） |

---

## 3. N1 · 用户端 canOrder 统一口径

### 3.1 Background

楼宇停用（改为 `SUSPENDED`）之后，该楼**存量已绑用户**照常下单（新用户绑不进来，见 §1.3）。套餐分配是楼群维度、两条读取路径不读 `status`（F2/F3/F4），所以这不是「某处漏了一行判断」，而是从来没有任何一处把这两个维度缝起来。团长工作台（F3）更松：只判时间窗口，连 assignment 都不看 —— 团长会看到一个「明日可下单」却根本没有明日套餐的组合。

### 3.2 Decision

**D-N1-1 · 结构层与时间层分开（裁决 0-C），三处共用结构层同一实现。** 见 §1.2、§2.1。

**D-N1-2 · 修复落在两条读取路径，不动入口校验。**

- `meal.service.ts:254–284` `resolveUserGroup()`：返回类型由 `number` 改为 `{ building, group }`，把 `building.status` 一路带出来。（**P3-4 已落地**）
- `order.service.ts:1673–1696` `resolveGroup()`：同上（`building` 已经查出来了，只是被丢掉）。（**P3-4 已落地**）
- `user.service.ts:118` 与 `building.service.ts:73` **保持不动**，它们是既有回归基线。

**D-N1-3 · U1 与 U6 都要接，且都调同一个编排层。** 两层的**失效后果不同**：

- 只改 U1 ⇒ 展示侧说不能下单、交易侧照收钱。用户走 API 或从历史入口进来还能支付成功，而这笔钱要往下走到已备料食物的履约链路，退款只能人工介入 —— 这是**展示与交易两份口径**，比今天的三份更少，但性质一样糟。
- 只改 U6 ⇒ 用户点得动、点了才被拒。按钮态说谎，产生无效客诉。

**D-N1-4 · `SUSPENDED` 与 `PREPARING`：布尔不区分，`reason` 区分，且两者都必须拦。**（存量用户会被改到 `PREPARING`，见 §1.3）

- 布尔不区分的理由：两者对用户的**可执行动作是同一个** —— 今天不能下单。再造第二个布尔就是重开 N1 的源头。
- `reason` 区分的理由：两者对**运营的修法不同**（「去开通」vs「去恢复」）。合成一句「该楼暂不可下单」，运营又只能猜 —— 这正是 `BuildingStatus` 当初被扩成三态的原因（`building-admin.ts:11–25` 注释已写明「一值两义」的教训）。

**D-N1-5 · 楼群 `SUSPENDED` 连带成员楼：由结构层派生，不写库。** `evaluateStructure()` 在拿到 `buildingGroupStatus` 后自行短路，任何调用方绕不过去。相对于「把停用下刷到每个成员楼的行上」，派生方案不引入「什么时候展开、什么时候回收」的调度与补偿 —— 没有数据要维护，就没有数据会和真源不一致。与本项目既有的「派生值不落库」哲学一致（`building-admin.service.ts:45–55` 裁决 1、`building-admin.ts:69–75`）。

**D-N1-6 · 管家端 `canOrder` 保留原语义（= 结构层，不叠时间），但字段改名 `canAssign`。**

- 语义上它答的是「这栋楼**能否被编排进套餐矩阵**」，不是「用户此刻能否下单」—— §1.2 那条纪律的落地：**不同问题不许共用一个字段名**。
- 取值仍是 `status === ACTIVE && gid !== null`，但现在**改由 `evaluateStructure()` 产出**，不再内联合取字面量（满足 QA 的 `S-N1-4`）。
- 若产品确实要在列表上看到「用户端实际能否下单」，另加一个 `orderable` 字段（结构层 ∧ 其余层，全量派生）—— **并存但不共用名**。

**D-N1-7 · 挂楼入已停用楼群：新增 60008 拦住 §1.4 那三条旁路（本批必做）。** 落点：`assignMembers()` 入口 + `updateBuilding()` 的 `buildingGroupId` 分支 + **`createBuilding()` 新建带 `buildingGroupId` 时**（第三条，后端 N4 收口时补出，本 ADR 上一版漏登记）。三条**共用同一个 `assertGroupOpen(gid)`**（判据在 `groupGate()`），不要在任一处另写一份内联判断。

**D-N1-8 · 楼群查不到（`buildingGroupStatus === null`）也是 fail-open，本批一起修（2026-10-26 裁定）。**

##### Background

结构层谓词修完 D-N1-2 那半之后，左右两半**不对称**：

| 情形 | 传入 | 修前结果 |
|---|---|---|
| 楼宇软删 / 查不到 | `buildingStatus = null` | ✅ fail-closed（落 `building_not_grouped`） |
| **楼群软删 / 查不到** | `buildingGroupId` 非 null、`buildingGroupStatus = null` | ❌ **fail-open —— 落到底判 `ok: true`** |

后果与 N1 同类：下单成立而履约断链（楼群不存在 ⇒ 集散、团长、配送全挂），**且没有任何报错**。

`null` 是**真实可达**的，不是理论值：`BuildingAdminService.loadContext():112` 查楼群带 `deletedAt: IsNull()`（已回源核实），软删的楼群查不到 ⇒ `groupStatusMap.get(gid) ?? null`。

##### Decision

**本批修，并且与 `buildingStatus` 用同一条判据、同一种风格。** 采纳 QA 的合并修法：

```
1. buildingStatus === null || buildingGroupId === null || buildingGroupStatus === null
     ⇒ building_not_grouped                       ← 三条都是「存在性判定」，一起 fail-closed
2. buildingStatus === PREPARING  ⇒ building_preparing
3. buildingStatus === SUSPENDED  ⇒ building_suspended
4. buildingGroupStatus === SUSPENDED ⇒ group_suspended   ← 走到这里时已保证非 null
```

**病根不是「漏了一行」，是两个同源字段用了两套判据风格。** `buildingStatus` 只做存在性判定（`null` 即 fail-closed），而 `buildingGroupStatus` 却在用**相等判定**去承担存在性 —— 相等判定天然漏 `null`。合并后三条一起做存在性判定，不再给「相等判定漏掉 null」留任何空间。

> **⚠️ 对 Team Lead 转述里「删除第 4 条里的 `=== BuildingGroupStatus.SUSPENDED` 相等判定」这半句的执行说明**：第 4 条的相等判定**保留**，但它**不再承担存在性职责**（存在性已由第 1 条兜住）。若字面删除它，`group_suspended` 这个 reason 会整体消失 —— 而它是 60010 的四个输入之一、且有独立文案「该区域已暂停服务」。我按保留相等判定、移除其存在性职责执行；若原意确为删除，请推翻本条。

##### Consequences

**正面**

- 结构层谓词对「楼 / 归群 / 楼群」三件事用的是**同一条判据**（存在性），不再有风格分叉 —— 这是那个洞真正的病根。
- 与 D-N1-2 合成后，谓词对**任何一个入参缺失**都 fail-closed，不存在「某个入参为 null 时反而放行」的组合。

**负面（夺去的容错）**

- **夺去「楼群记录缺失时仍可下单/编排」的容错。** 此前一栋挂着悬空 `building_group_id` 的楼是**可用**的（静默可用）；此后它变成不可用，且会在管家端显示为「未归群」。这是**有意为之**：悬空引用不是可用状态，是数据坏了。
- **`building_not_grouped` 的语义变宽。** 它现在同时覆盖「楼未归群」与「楼群记录找不到」两类。经裁定**文案字面不改**（两种成因对用户的处置动作完全相同），只在该文案上方补注释声明「覆盖两类成因、为何不拆开」；**区分责任交给错误码 `60011`**，不压给文案。见 §9 第 8 项。

##### 为什么不是单开议题（三条回源事实）

1. **`ab_building_group.status` 是 NOT NULL**（`building.entity.ts:116`，`@Column` 未标 `nullable`）⇒ `null` **只可能来自「行查不到」**，不会来自正常数据 ⇒ fail-closed **不产生假阳性**。
2. **没有任何代码会删楼群**（`building/` 目录下无 `groupRepo.softDelete/delete/remove`，亦无置 `deletedAt` 的写路径；全仓唯一的 `deletedAt` 写入点在 `distribution-center-admin.service.ts:247`，是集散中心）⇒ 与楼宇那条一样，**今天零行为变化**。
3. **与 D-N1-2 是同一个谓词的同一类洞**，且在**同一个新建文件**里。分开修的后果是：谓词留着「一半 fail-closed、一半 fail-open」的不对称，而读者看不出哪一半是故意的。

**若不修而单开，按 ADR §10 第 13 项登记为待办 —— 不登记的话半年后没人记得这里开着。**

### 3.3 Consequences

**正面**

- 管家端 KPI 不再被时间污染（夜里看列表不会因为过了截单而误报配置缺口）。
- 结构层判据在三端恒等且只有一份实现，N1 变成可回归的而不是一次性的手工验证。
- `canAssign` / `orderable` 两个字段把「能否编排」与「能否下单」的语义差显式化。

**负面（必须承认）**

- U1 / U6 各多一次 `ab_building_group` 与 `ab_sales_pause` 的读。可接受：`building` 本来就查了（`meal.service.ts:270`），且 U1 已在 `Promise.all` 里并发。真正增加的是**概念负担**（读代码的人现在要知道 canOrder 由四个层决定）—— 这份 ADR 就是为这个负担付的成本。
- 契约成本：`PUT admin/buildings` 出参字段名变更是接口出参变更，admin-web 必须同批改（见 §10 第 5 项）。

**夺去的容错**

- **夺去运营「把停用当软动作」的习惯。** 过去 `停用` 只影响套餐矩阵可选范围，运营实际把它当「先停一会儿看看」；改后它立刻从用户端生效，把当天 / 次日的套餐直接变成不可订。这个语义变化必须在后台停用入口写清楚，不是一句 toast 能 cover 的。
- **夺去用户「已下单但未支付」的一致性体感。** 停用后用户手里的 `pending_pay` 单仍在计时、可继续支付，但页面说「已暂停服务」。本 ADR 按用户拍板的口径：**停用只拦新单、不动存量单**，且存量单**继续履约 + 必须通知**（见 §4.2 D-N2-6）。存量 `pending_pay` 的超时取消仍走既有 T3 cron。
- **夺去 e2e 与种子脚本的一部分宽松度。** 任何「造个用户直接下单」的脚本，现在必须先保证楼是 `ACTIVE` 且已归群。这是**有意为之**（它把 N1 变成机械可测的），但需要在 §8 显式铺好前置 —— 别等 e2e 红了才发现种子数据里有一栋 `PREPARING` 的楼。

### 3.4 U6 的错误码映射（保契约，不新建）

`order.service.ts` 现有的两个码是《接口规范》§3.3 的契约，**必须保**：

| reason | U6 抛出 | 位置 |
|---|---|---|
| `cutoff` / `not_open_yet` | `ErrorCode.ORDER_CUTOFF`（30001），文案沿用现有 | 替换 `order.service.ts:225–227` |
| `meal_not_published` | `ErrorCode.MEAL_NOT_PUBLISHED`（30005） | 替换 `order.service.ts:254–256` |
| `building_preparing` / `building_suspended` / `group_suspended`（**业务主动停用**，运营自己停的，无需动作） | **60010** `BUILDING_SUSPENDED`（新增） | 新增，落在 ⑤ 与 ⑦ 之间 |
| `building_not_grouped`（**配置缺失**，楼宇未归群，属漏配事故） | **60011** `BUILDING_NOT_GROUPED`（新增，**取代现状的 10004**，见 §9 第 7 项） | 替换 `meal.service.ts:281` 与 `order.service.ts:1693` 现有的 `ErrorCode.NOT_FOUND` |
| `sales_paused` | **60009** `SALES_PAUSED`（新增） | 新增，落在 ① 之前（最高优先级） |

**为什么 `building_not_grouped` 要单独一个码（采纳 QA 异议 2）**：这两类的**处置动作完全不同** —— 配置缺失要运营去做归群（是事故，要告警）；业务主动停用是运营自己停的（无需动作，不该告警）。合成一码，日志 / 监控 / 告警里会**完全同形**，无法区分「有人漏配了」和「有人故意停的」。本仓自己拆 `30022` / `30023` 时给的就是这个理由（见 `error-code.ts`）。这不违背「号段相邻防第三份口径」：仍是单一谓词的输出，只是谓词输出两个码，且排成 60010 / 60011 相邻。

`not_open_yet` 在 U6 仍映射 30001（与今天 `isOrderable()` 返回 false 的行为一致）—— **有意保留契约**：《接口规范 v1.0》§九 锁了这里的措辞。差异只体现在 `payload.reason`，端上可做精细化处理而不必改码。

### 3.5 落码点清单

| 文件 | 行 | 动作 |
|---|---|---|
| `apps/api-server/src/common/utils/orderability.ts` | 新增（≤180 行） | `evaluateStructure` / `evaluateAvailability` + `REASON_TEXT` 查表 + `reasonText()` 文案唯一出口 |
| `apps/api-server/src/common/services/order-availability.service.ts` | 新增（≤120 行） | IO 编排；注册进 `CommonModule` 的 `providers` + `exports`（`@Global()` ⇒ 四处直接可见） |
| `apps/api-server/src/modules/meal/meal.service.ts` | `253–272`（`resolveUserGroup`）、`104`、`118–124` | 返回 `{ building, group }`；`canOrder` / `reason` 改由编排层产出 |
| `apps/api-server/src/modules/order/order.service.ts` | `1622–1631`（`resolveGroup`）、`225–227`、`250–256` | 同上；按 §3.4 映射抛码 |
| `apps/api-server/src/modules/team-leader/workbench.service.ts` | `117–125` | `tomorrow.canOrder` 改由编排层产出（`building` 已在 `:63` 取到），并补出参 `tomorrow.reasonText` |
| `apps/api-server/src/modules/building/building-admin.service.ts` | `218 / 325 / 623 / 701` | 字段改名 `canAssign`，取值改由 `evaluateStructure()` 产出；按需补 `orderable` |
| 同上 | **`255` 与 `438–440`** | ⚠️ **两处 `canOrderCount` 是两份独立计算**：`255` 读字段、`438` 自己又写了一遍 `status === ACTIVE && buildingGroupId`。改名后 `438` 会变成第三份没人管的判据 —— 两处都要改为由 `evaluateStructure()` 计数，出参改名 `canAssignCount` |
| `apps/api-server/src/modules/building/building-admin.controller.ts` | `60` / `138` | Swagger 描述里的 `canOrder` 字面量 → `canAssign`（**字符串，`tsc` 抓不到**） |
| 同上（`building-admin.service.ts`） | `1483`（`assignMembers`）、`762`（`updateBuilding` 归群）、**`712`（`createBuilding`）** | 加目标楼群状态检查，拦不住则 60008（**本批必做**）。⚠️ 第三条是本 ADR 上一版漏登记的 |
| `apps/miniprogram/src/api/leader.ts` | `55` | ❌ **不动** —— 团长工作台的 `canOrder` 是「此刻能否追加」，有时间维度，与后台那 4 处不是一回事 |
| `apps/admin-web/src/api/building.ts` | `55 / 68 / 115 / 181 / 298` | 类型同步改名。**admin-web 是独立 tsconfig，`typecheck:api` 覆盖不到** —— 漏改不报错，运行时静默变 `undefined` |
| `apps/admin-web/src/views/building/*` | `list.vue:15/28/336/511`、`overview.vue:50`、`leader-binding.vue:105–106/163` | 同上；`views/meal/matrix.vue:275` 那条注释讲的是**用户端** `canOrder`，**不动** |
| `apps/api-server/src/modules/user/user.service.ts` | `118` | **不动**（回归基线，QA 已锁） |
| `apps/api-server/src/modules/building/building.service.ts` | `73` | **不动**（回归基线，QA 已锁） |

> **改名的边界**：只有后台那 4 处改。U1 用户端、团长工作台、小程序 `leader.ts` 的 `canOrder` **保持原名** —— 它们回答的是「此刻能否下单」，有时间维度。「把 4 处改名」这句话容易被读成「全仓改名」，而全仓改名会把一个已经分清楚的区别重新抹平。

---

## 4. N2 · 停用前校验未完结订单

### 4.1 Background

F7/F8：楼宇停用是一行 `patch.status = dto.status`，不查任何东西；楼群停用只拦成员楼非空。运营可以在该楼还有 20 笔 `paid` 订单待履约时把它停掉 —— 这些订单明天 11:30 会被配送到一个「已暂停」的楼，而团长与集散中心那边没有任何感知渠道。

### 4.2 Decision

**D-N2-1 · 「未完结」用 `Not(In(ORDER_TERMINAL_STATUS))` 反算，禁硬编码清单。**

```
未完结 := ab_order.status NOT IN ORDER_TERMINAL_STATUS   -- completed / cancelled / refunded
          AND meal_date >= todayBj()
```

- 依据 `order-status.ts:88–92`，终态只有 3 个 ⇒ **当前未完结是 8 态**（`pending_pay` / `paid` / `cut_off` / `cooked` / `delivering` / `delivered` / `refund_applying` / `refunding`）。Team Lead 初版给的「6 态」漏了后两个，而这两态的钱正在往外退、同样未了结。
- **为什么必须反算**：硬编码白名单是 **fail-open** —— 将来状态机再加一个非终态（历史上 `refund_applying` / `refunding` 就是后加的），白名单默认放行它，且**没有任何信号提示你忘了更新**。反算是 **fail-closed**，新增状态自动受拦。在修一个「静默放行」的缺陷时预留一个更小的同款缺陷，是最不划算的一种实现。
- 现成写法已存在（`user.service.ts:212`），本批直接沿用其形态。
- 「未完结」谓词只准有一份实现（放 `common/utils/orderability.ts`），不许各处自己抄 `Not(In([...]))`。

**D-N2-2 · 8 态按用户拍板的口径拆成两组，处理完全不同。**

| 组 | 状态 | 语义 | 停用动作 |
|---|---|---|---|
| **A · 履约中（不可撤回）** | `cut_off` / `cooked` / `delivering` / `delivered` | 供应商已按份数采购备货，钱货都在路上 | **硬约束：强制继续履约，运营无权通过停用撤回**，即使带 `force` 且选「一并退款」也拒绝 → **60013**（不可配置） |
| **B · 可放行** | `pending_pay` / `paid` / `refund_applying` / `refunding` | 未截单，或退款已在自己的通道里走 | 继续履约 + 必须通知用户；按 §D-N2-5 分级拦截 |

**D-N2-3 · 用户拍板口径一：B 组「继续履约 + 必须通知」，不许批量退款。**

- 停用**不得**触发任何批量退款 / 批量取消。批量自动退款是最危险的形状：部分成功 + 重试 = 资金事故。真要撤，走既有的逐单审批通道（`force_refund` opCode 已在 `OP_ENDPOINTS` 里），不在停用动作里做批量。
- **必须通知用户**。停用一个有 B 组订单的楼，等于改变了用户「明天还送不送」的预期，不通知就是把知情成本转嫁给用户。
- **通知由谁发 / 同步还是异步 / 失败是否阻断**（团队要我裁决）：
  - **走 `MessageOrchestratorService.orchestrate()`（`message-orchestrator.service.ts:81`），异步**。它是本仓既有的群发编排入口（有受众选择器、有模板变量、有留痕），不需要新造。
  - **失败不阻断停用**。停用是运营已经做出的决定，通知是尽力而为的告知 —— 让一次消息通道抖动把停用卡住，是把两个可用性绑在一起。
  - **但失败必须留痕**：写 `ab_operation_log` 一条带 `notifyFailedCount` 的记录，并保留失败的消息行，让运营事后能看到「有几个人没通知到、是谁」。**不可见的失败比失败本身更糟。**

**D-N2-4 · 用户拍板口径二：A 组是硬约束，不可配置，且状态机推进不得被冻结。**

- **60013** 是**硬约束**而非配置项 —— 供应商已按份数采购备货，此阶段撤回让用户和供应商承担损失而运营零成本，权责不对等。（号位经两轮调整定稿，见 §7；早期稿写的是 60012，已被 60012 `SUSPEND_REQUIRE_APPROVAL` 占用。）
- **连带回归面（必须写进验收）**：停用后，未完结订单的**状态机推进不得被冻结**。尤其 `delivered → completed`（T 日 14:00 自动确认）与佣金入账必须照跑 —— 一旦被冻结，就是**隐性欠薪事故**：团长干完了活、佣金卡在半路，且列表上看不出原因。这条是本次改造最容易踩的隐性回归，列在 §8 第 10 步。

**D-N2-5 · 用户拍板口径三：分级拦截（N = 未完结订单数）。**

| N | 行为 |
|---|---|
| `0` | **直接放行**（不返回任何错误） |
| `1 ≤ N ≤ 阈值` | 硬拦 → **60006 / 60007** + 完整影响摘要；重发带 `forceSuspend: true` **且 `suspendReason` ≥ 10 字** ⇒ 放行并留审计 |
| `N > 阈值` | **`forceSuspend` 也无效** → **60012** `SUSPEND_REQUIRE_APPROVAL`；必须走既有的 `modules/admin/operation-request/` 两级审批（approve → execute） |

- **A 组优先于分级**（用户拍板的硬约束）：只要 A 组 `count > 0`，**无论 N 多少、无论是否带 force**，一律 **60013**。上面这张表只在 A 组为 0 时才生效。

- **阈值读 `ab_config`，不硬编码**。命名空间**新建 `building.*`**（现有只有 `order.*` / `set_meal.*` / `commission.*` / `service.*` / `settlement.*` / `timeline` 分组，无 `building.*`）：
  - `building.suspend_force_max_count`，缺省 `20`
  - `building.suspend_reason_min_length`，缺省 `10`
  - 两者**必须登记进 `config.specs.ts`**（新增一个 `building` 分组，插在 `order` 之后 —— `CONFIG_GROUPS` 数组顺序即页面渲染顺序），并在 `BizConfigService` 加对应 reader。见 §9 第 6 项的更正说明。
- **N > 阈值 走 OperationRequest：复用，不新造**（团队明确要求）。给 `OP_ENDPOINTS` / `OP_LABELS`（`operation-request.service.ts:31` / `:44`）加两条：
  ```ts
  suspend_building:      { method: 'PUT', path: '/admin/buildings/:id' },
  suspend_building_group:{ method: 'PUT', path: '/admin/building-groups/:id' },
  ```
  OP_LABELS：`'停用办公楼（含强制停用）'` / `'停用楼群（含强制停用）'`。
  复用的收益是白拿的：execute 阶段**自调用原 controller**（`operation-request.service.ts:20–29` 注释），所以 `@Roles('super_admin','admin')` 与 `@OperationLog` 全部照常命中，**业务零重复、审计不丢**。新造一套审批机制就是第二份判据 —— 本项目 M5-17 缺陷 ⑫ 的同族病根。
- **N 的计数维度**：楼宇停用数 `building_id`，楼群停用数 `building_group_id`。**刻意不查成员楼名单** —— 60003 要求先清空成员才能停用，等你真能停用时名单已空，查出来的 0 是**假绿**；而历史订单的 `building_group_id` 是**快照**，楼搬走后历史单仍指向旧群，只有按 `building_group_id` 查才抓得到这些「人已走、债还在」的单。
- **时间范围** `meal_date >= todayBj()`（含今天）：不限定的话，一笔卡在 `paid` 的历史脏单会**永久锁死**这栋楼的停用能力，而运营没权限修它，最后只能找技术改库 —— 等于把所有人逼回绕过闸门的那条路。含今天是因为今天的单在 11:30 送达、14:00 自动确认前都还在流转，恰恰最需要保护。

**D-N2-6 · `forceSuspend` 收窄到 admin 角色 + 强制留痕。**

- 角色：`PUT admin/buildings/:id` 已是 `@Roles('super_admin','admin')`（`building-admin.controller.ts:146`），楼群同理（`:221`）。`operator` 拿不到强制停用能力，不需要额外守卫。
- 审计：用 `@OperationLog(...)` 装饰器（该文件已 import），把 `forceSuspend` / `reason` / `unfinishedCount` 写进 `ab_operation_log`。**逃生舱如果不可追责，运营会把它当默认路径。**
- **唯一的前提（必须写进 admin-web 验收，不能只写在后端）**：`forceSuspend` 只有在前端要求一次**显式交互**（独立确认弹窗 + 必填 reason）时才成立。若前端默认写 `true`，这个闸门就是装饰性的。

### 4.3 Consequences

**正面**

- 楼宇 / 楼群停用从「零后果的瞬发动作」变成「先告知代价、再放行」的可控动作：运营在点下去之前就知道有几单、哪些单不可撤回、要不要走审批。
- 「哪些状态算未完结」「查本楼还是查本楼群」「N 多大要审批」三个判断都有唯一落点，不再各处自行解释。
- 审批通道复用既有的 `OperationRequest`，没有第二份判据，审计链完整。

**负面**

- `ab_order.building_group_id` 无索引 ⇒ 楼群停用校验是一次范围扫描。MVP 数据量（万行级）下毫秒到几十毫秒，可接受；**量级涨到百万行时必须回来加 `idx_order_group_meal(building_group_id, meal_date)`，且必须同时改实体与迁移**（否则 `index:parity` 会红 —— 那正是这个门禁存在的意义）。
- 分级拦截引入**四个分支**（0 / 1–20 / >20 / 含 A 组），比「一刀切硬拦」复杂。这个复杂度是用户拍板的业务口径带来的，不是设计自找的；成本是前端要按四种情况给四种提示。
- 通知是异步且允许失败 ⇒ 存在「停用了但有人没收到通知」的状态。已用「失败留痕 + 可重试」把它从不可见变成可见，但**无法消除**。

**夺去的容错**

- **首当其冲：运营在「必须立刻停」的紧急场景下的止损速度。** 食品安全、楼宇封控、供应商断供 —— 这些场景恰恰一定伴随未完结订单，而且往往是 A 组（已截单）订单。分级拦截 + A 组硬约束，意味着**运营在紧急场景下反而被拦得最死**。这是用户已拍板的业务口径（权责不对等），我照写，但必须把代价说清楚：**此时的正解不是「停用」，而是「走订单侧的逐单退款/改派」**，而那条路今天是否通畅，本 ADR 无法保证（列在 §10 第 6 项）。
- **其次：自动化脚本的 happy path。** 种子脚本与 e2e 里任何「直接把楼改成 SUSPENDED」的步骤，现在会因为存在今日 / 明日订单而被拒，或需要显式传 `forceSuspend` + `reason`。§8 已铺好前置。

### 4.4 落码点清单

| 文件 | 行 | 动作 |
|---|---|---|
| `apps/api-server/src/modules/building/building-admin.service.ts` | `678` | 停用前先调 `assertBuildingSuspendable(id, { force, reason })` |
| 同上 | `967–979` | 60003 闸门之后追加 `assertGroupSuspendable(gid, { force, reason })`。顺序：**先判非空（便宜）再判未完结（贵）**，与现有「先搬楼再判闸门」同一精神 |
| 同上 | 新增私有方法 | `countUnfinished({ buildingId })` / `countUnfinished({ buildingGroupId })`，按 D-N2-2 分 A/B 两组计数，共用一份「未完结」谓词 |
| `apps/api-server/src/modules/building/dto/building-admin.dto.ts` | `UpdateBuildingDto`（≈268）、`UpdateBuildingGroupDto`（≈409） | 加 `@IsOptional() @IsBoolean() forceSuspend?` 与 `@IsOptional() @IsString() @MinLength(10) suspendReason?`。**不声明会被 `forbidNonWhitelisted` 拒 10001** |
| `apps/api-server/src/modules/admin/operation-request/operation-request.service.ts` | `31`（`OP_ENDPOINTS`）、`44`（`OP_LABELS`） | 各加 `suspend_building` / `suspend_building_group` 两条 |
| `apps/api-server/src/modules/admin/config/config.specs.ts` | `CONFIG_GROUPS`（≈107）、`CONFIG_SPECS`（≈164） | 新增 `building` 分组 + 两个键（见 D-N2-5） |
| `apps/api-server/src/common/services/biz-config.service.ts` | — | 加两个 reader（复用 `getNumber(key, fallback)`） |
| `apps/api-server/src/common/constants/error-code.ts` | `≈506` 后、`≈616` 后 | 新增 enum 与 `ERROR_MESSAGE`，两处必须成对（`errcode:message` 门禁守配对） |

---

## 5. W1 · 一键停售（净新增功能）

### 5.1 Background

需要一个「全局暂停接单」能力。**它是净新增功能，不是缺陷修复**（F17：全仓 `停售 / stop_sale / globalStop / 全局停` 零命中，`config.specs.ts` 无键）。它没有旧行为可回归，但有一条特殊回归面：**必须证明它不影响既有链路**（见 §8 第 11 步）。

它和 N1/N2 共享同一份谓词 —— 这也是本 ADR 把三项并在一份文档里的原因：**分开设计一定会出现第三份 canOrder 口径。**

### 5.2 Decision

**D-W1-1 · 落独立表 `ab_sales_pause`，不落 `ab_config`。**

1. **生效时延（决定性理由）。** `BizConfigService` 是 **60 秒进程内 TTL 缓存**（`biz-config.service.ts:41` 的 `ttlMs`、`ensureLoaded` 的判定）。D58 写入后会调 `invalidate()` **同步**失效 —— 但那只刷新了「处理这次写请求的那个实例」；其余实例各自持有旧值，最长 60 秒。就现状而言 `docker-compose.prod.yml:88–96` 只定义了 1 个 api 容器（`abox-api-prod`，无 `deploy.replicas`），所以今天最坏情况是**整整 60 秒的放单窗口**；一旦哪天扩容到多实例，这个窗口还会变成「每个实例各自不一致」。**一键停售的语义就是「立刻」** —— 这 60 秒里系统在继续收单，且没有任何报错。这会造出一个新的「两个真相」，正是本项目反复出现的头号顽疾（`config.service.ts:117–119` 把这件事写进了文件头注释）。独立表每次直读 DB，没有缓存可以藏。
2. **日期区间表达。** `ab_config` 是键值文本表，多日停售只能把 `[from, to]` 序列化成 JSON 塞进 `value`，于是要新增一个解析器和它的失败分支。而这类解析器的缺省方向天然是「解析失败 → 回落不停售」（参见 `blindBoxItems()` 的 try/catch 回落）—— **对一个停售开关来说，这个缺省方向是危险的**。日期就该是 `date` 列。
3. **责任追踪。** 停售涉及履约与退款，事后一定被问「谁停的、为什么、什么时候恢复的」。`SysConfig` 行没有 `createdBy`；独立表天然带 `created_by` / `reason` / `resumed_at` / `resumed_by`。
4. **有先例。** 本项目对「单用途开关 / 清单」的做法本来就是开一张小表：`ab_op_blocklist`（迁移 `1700000000011`）。

**为什么不复用 `ab_op_blocklist`**（最容易被提出的「省一张表」方案，必须显式否决）：

- **约束的对象不对。** `OpBlocklistInterceptor` 只在请求带 `X-KB-OpBlock` 头时才生效（`op-blocklist.interceptor.ts:33–36`），那是**企业微信 KB 助手**的自动化写操作通道；小程序用户的下单请求没有这个头，**根本走不到这个闸**。
- **失效方向不对。** `isBlocked()` 查库异常时 `fail-open` 放行（`:46–49`）。对「AI 助手写后台数据」这个取向可以接受（后面还有 `OperationRequestService` 的强闸兜底）；对「全局停售」来说 fail-open 是错的 —— DB 一抖，停售就失效了。
- **语义不对。** 它表达的是「禁止某个 op 代码」，不是「某段日期不接受新订单」。硬塞一个 `op_code = 'order.create'` 进去，等于把「能不能下单」的第二份真源写进一张名字叫 op-blocklist 的表里 —— 又是 N1 的同型复发。

**D-W1-2 · 统一为「停售日期区间」，`from == to` 即「停售明日」。**

- 「停售明日」不是第二种能力，是 `[tomorrow, tomorrow]` 这个区间的**退化形态**。UI 上做一个「停售明日」快捷按钮填 `from = to = tomorrow` 即可，不需要第二个字段、第二个接口、第二种语义。
- 造两套（一个 boolean 立即开关 + 一个日期列表）必然产生「停售了但日期没填」这种半成品状态 —— 本项目的缺陷 #49、「写了不生效」、「两个真相」全部是这一类。
- **允许存在多条生效且重叠的记录**：「停售明天」+「停售下周一」是两条独立记录，各自独立恢复，互不干扰。**不做区间合并 / 拆分算法**（收益小于复杂度，且会引入「合并后又拆」的第二份语义）。
- 命中判据（一条 SQL，无歧义）：`meal_date_from <= :d AND meal_date_to >= :d AND resumed_at IS NULL`。

**D-W1-3 · 默认只拦新单，不动存量单 —— 与用户拍板的 N2 口径一致。**

- 停售**不**触发批量退款 / 批量取消，理由与 D-N2-3 相同（部分成功 + 重试 = 资金事故）。
- 停售响应里一并返回「存量未完结订单」摘要（复用 N2 那次查询），提示「仍有 N 笔待处理，退款请在订单管理页逐单处理」。**不返回摘要的停售 = 让运营对着空气做决定。**
- 停售**不冻结状态机**（同 D-N2-4）,`delivered → completed` 与佣金入账照跑。

**D-W1-4 · 停售不阻塞套餐编排（D2 上架照常）。**

运营需要在停售期间把后续日期的套餐排好，恢复后立刻可订。卡住 `ab_meal_assignment` 的写路径只会让「恢复」变成先解停售再一路补排 —— 停售本来就是忙的时候才用，不能在忙的时候更慢。

**D-W1-5 · 读写位置。**

- 读：`OrderAvailabilityService` 内部一次点查，**不走任何缓存**。
- 写：新增 `modules/admin/sales-pause/`（controller + service + dto），`@UseGuards(AdminGuard)` + `@Roles('super_admin','admin')`，写操作带 `@OperationLog`。
- ⚠️ **`GET /admin/sales-pause` 的出参是 `SalesPauseRow[]` 裸数组，不套 `{ list }`**（与 spec §7.4 同一裁定，G12）。本契约**一周内翻了两次**（裸数组 → `{list}` → 裸数组），故在此钉死：本表**不分页**，套信封无收益；且 `http.get<T>` **只解包业务信封**，套错层**编译期看不见**，表现是列表空白或 `find is not a function`。仓内两种写法并存（`op-blocklist` 用 `{list}`、`operation-request` 用裸数组），**不是谁对谁错，只能二选一** ⇒ 改签名前先回源 `SalesPauseController.list()`。
- **停售本身不登记进 `config.specs.ts`**（它不写 `ab_config`）。注意与 N2 的区分：**N2 的两个阈值要登记，W1 的停售不登记** —— 见 §9 第 6 项。

### 5.3 Consequences

**正面**

- 停售 / 恢复立即可见、可追溯、可按天精确控制粒度，且没有缓存窗口。
- W1 与 N1/N2 共用同一谓词，任何新增的下单入口都无法绕过它 —— 除非那个人绕过了 `OrderAvailabilityService`，而这在 code review 里一眼可见。
- 日期区间让「临时停一餐」和「停到下周三」用同一个机制表达，不需要第二套开关。

**负面**

- **多一张表 + 一条迁移 + 一处 `ALL_ENTITIES` 登记。** `schema:parity` 与 `index:parity` 会立即检查「迁移 ↔ 实体」一致性：本地 sqlite 走实体 synchronize、生产走迁移，两边不一致时**不在任何失败路径上**（这正是这两个门禁存在的原因）。所以任何「顺手加一列」都必须两侧同步。
- 每次 U1 / U6 多一次 DB 点查。`U6` 已经在事务内做更多的事，多一次点查不是瓶颈；若将来确实成为热点，正确做法是在 `OrderAvailabilityService` 内做**秒级**短缓存（而不是 60 秒），见 §10 第 3 项。
- 运营多一个决策点：停售后要不要主动处理存量单。这个成本无法消除，只能靠 D-W1-3 的摘要把它从「不知道」变成「知道」。

**夺去的容错**

- **夺去用户「习惯性下单」的容错。** 中午一键停售后，下午习惯性打开小程序的用户会被拒，且看到的是「今日暂停接单」这种没有恢复时间的话 —— 最容易引发客诉的形态。缓和：`reason` 为 `sales_paused` 时把 `ab_sales_pause.reason` 拼进文案下发，并且 `reason` **在 DTO 里强制必填**（`@MinLength(4)`），逼运营留一句人话。
- **夺去团长工作台「明日可下单」的可信度。** 团长会看到 `tomorrow.canOrder = false`，但成因不是没开团。缓和：`reasonText` 原样透传到工作台 `tomorrow` 块（那里目前只有 `canOrder`，本批补一个字段）。
- **夺去 `ab_config` 路线本可白嫖的省心。** 反面说法：走 `ab_config` 省一张表和一次 parity 对账，代价是在最需要「立刻」的场景里系统性地迟到一分钟。这笔账按「多出多少笔本不该收的订单」来算，不是按「少改几个文件」来算。

### 5.4 落码点清单

| 文件 | 动作 |
|---|---|
| `apps/api-server/src/database/entities/system.entity.ts` | 新增 `SalesPause` 实体（与 `OpBlocklist` 同文件，同属系统域）；多词列必须显式写 `name: 'meal_date_from'` 等（本仓 TypeORM 不做 camelCase→snake_case 转换） |
| `apps/api-server/src/database/entities/index.ts` | `ALL_ENTITIES` 增加 `SalesPause`（33 → 34），同步更新文件头「33 张表」注释与系统域计数 |
| `apps/api-server/src/database/migrations/1700000000019-sales-pause.ts` | 新增迁移（DDL 见 §6） |
| `apps/api-server/src/modules/admin/sales-pause/` | 新增 controller / service / dto（含 resume 端点） |
| `apps/api-server/src/modules/admin/admin.module.ts` | 注册新 controller 与 service |
| `apps/api-server/src/common/services/order-availability.service.ts` | 内部点查 `ab_sales_pause` |
| `apps/admin-web/src/` | 新增停售页 + 「停售明日」快捷按钮。图标沿用既有 `ABOX_ICON_CHARS.pause`（`packages/shared-utils/src/icons.ts:80` / `:168`）配 `abi-20` 档位 class，**禁止 emoji，不引入新的图标库** |

---

## 6. 数据库迁移

| 项 | 结论 |
|---|---|
| N1 | **不需要迁移。** 只新增纯函数与 service，表结构不变 |
| N2 | **不需要迁移，也不需要新索引。** 复用 `idx_order_building_meal(building_id, meal_date)` 与 `idx_order_status(status, meal_date)` |
| W1 | **需要 1 条迁移 + 1 个实体 + 1 处 `ALL_ENTITIES` 登记** |

```sql
-- 1700000000019-sales-pause.ts
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

实体侧必须同步声明同名同列索引，否则 `index:parity` 必红：

```ts
@Entity('ab_sales_pause')
@Index('idx_sales_pause_range', ['mealDateFrom', 'mealDateTo'])
export class SalesPause {
  /* 多词列必须显式写 name: 'meal_date_from' / 'meal_date_to' / 'created_by' / 'resumed_at' / 'resumed_by'
     —— 本仓 TypeORM 使用默认命名策略，不做 camelCase→snake_case 转换 */
}
```

- 无外键（本项目既有约定：FK 只存在于文档，不进 DDL）。
- 无唯一约束（刻意允许重叠区间，见 D-W1-2）。
- 不设 `version` 列：这张表是 append-only + 单行 `resumed_at` 更新，不是并发争抢的资源。若后续出现并发恢复需求，那时再加乐观锁。

迁移完成后必跑三条门禁：`schema:parity` / `index:parity` / `typecheck:api`。

---

## 7. 错误码与文案清单

号位以 **Team Lead 2026-10-26 最终裁定**为准。**`enum ErrorCode` 与 `ERROR_MESSAGE` 两处必须成对登记**，由 `errcode:message` 门禁守配对，缺一即红。

| Code | 常量名 | 默认文案 | 触发点 | `payload` |
|---|---|---|---|---|
| 60006 | `BUILDING_UNFINISHED_ORDERS` | `该办公楼仍有未完结订单，不能直接停用` | 楼宇停用，`1 ≤ N ≤ 阈值` 且未传 `forceSuspend` | `{ unfinishedCount, groupA, groupB, earliestMealDate, samples, threshold, hint }` |
| 60007 | `BUILDING_GROUP_UNFINISHED_ORDERS` | `该楼群仍有未完结订单，不能直接停用` | 楼群停用，`1 ≤ N ≤ 阈值` 且未传 `forceSuspend` | 同 60006 |
| 60008 | `BUILDING_GROUP_SUSPENDED_REJECT` | `目标楼群已停用，不能把办公楼挂进去` | `assignMembers()` / `updateBuilding(buildingGroupId)` / **`createBuilding(buildingGroupId)`** 指向已停用楼群（**三条写路径，本批必做**；第三条上一版漏登记） | `{ targetGroupId, hint }` |
| 60009 | `SALES_PAUSED` | `当前已暂停接单` | U6 下单且 reason = `sales_paused` | `{ reason }`（运营填的停售说明） |
| 60010 | `BUILDING_SUSPENDED` | `该办公楼已停用时不可下单` | U6 下单且 reason ∈ { `building_preparing`, `building_suspended`, `group_suspended` }（**业务主动停用**） | `{ reason, reasonText }` |
| 60011 | `BUILDING_NOT_GROUPED` | `该办公楼未配置楼群，请联系运营`（**收尾批改为** `该办公楼暂未开通服务，请联系运营`，见 §7.1.1） | U6 下单且 reason = `building_not_grouped`（**配置缺失**；同时取代 `meal.service.ts:281` / `order.service.ts:1693` 现状的 `10004`） | `{ reason, reasonText }` |
| 60012 | `SUSPEND_REQUIRE_APPROVAL` | `未完结订单超过阈值，强制停用不可用，请提交运营审批` | `N > 阈值`，**即使带 `forceSuspend` 也拒绝** | `{ unfinishedCount, threshold, opCode, hint }` |
| 60013 | `SUSPEND_CANNOT_REVOKE_ACCEPTED` | `已有订单进入履约阶段，无法通过停用撤回` | 存在 A 组订单（`cut_off`/`cooked`/`delivering`/`delivered`），**即使 force 且选「一并退款」也拒绝**（硬约束，不可配置） | `{ groupA: { count, orderNos }, hint }` |

**号位定稿说明**：60006–60013 连续八码，**无跳号**（Team Lead 2026-10-26 第二次调整，最终版）。`BUILDING_NOT_ORDERABLE` 这个合成码**已废弃**，拆为 60010 / 60011 两个。**废弃码名的作用域**：**代码中**（`apps/` + `packages/`，含注释）不得出现；**文档中作为废弃声明的引用保留**（本 ADR §7 / §10 与落码规格 §8 共 3 处）—— 删掉它们，后人就不知道这个号位为什么空着，会有人把合成码补回来。

### 7.1 收尾批（**不在 P3-5 做**）：60011 文案统一 + 第三条同语义路径

#### 7.1.1 60011 文案统一（收尾批）—— **五处写法不一致，不止两处**

同一语义「办公楼未归群」，**裁定当时**仓库里有**五处不同写法**（2026-10-26 逐处回源核实）：

> ⚠️ **此表是裁定当时的快照，不是现状**（G12 对齐 spec §14.1.1）。收尾批已由后端落盘，落地状态与剩余项见 spec §14.1.1。
>
> **为什么明知已失效还留着**：文档的价值在于**记录裁定依据**，不在于记录当前状态。现状会自己过期，裁定依据不会 —— 删掉这张表，后人只看到「现在一致」，不知道「凭什么一致、当时不一致到什么程度」，下次改文案会重新踩进同一个坑。与 §7「废弃码名 —— 代码中不许有（含注释）、文档中作为废弃声明必须有」是同一个判断。

| 位置 | 现状 | 问题 |
|---|---|---|
| `apps/api-server/src/common/utils/orderability.ts:142` | `building_not_grouped: '该办公楼暂未开通服务'` | 面向用户、中性，但**缺「，请联系运营」** |
| `apps/api-server/src/common/constants/error-code.ts:662` | `[ErrorCode.BUILDING_NOT_GROUPED]: '该办公楼未配置楼群，请联系运营'` | 含运营黑话「楼群」 |
| `apps/api-server/src/modules/meal/meal.service.ts:279–282`（字面 `:281`） | `throw new BizException(ErrorCode.BUILDING_NOT_GROUPED, '所属办公楼未配置楼群，请联系运营')` | **带第二参数**（Team Lead 2026-10-26 补出，我第一版漏了它）|
| `apps/api-server/src/modules/order/order.service.ts:1693`（`:1692` 是其上一行注释） | 同上 | **带第二参数** |
| `apps/api-server/src/modules/traceability/traceability.service.ts:285` | `throw new BizException(ErrorCode.NOT_FOUND, '所属办公楼未配置楼群，请联系运营')` | **仍是 10004**，本批遗漏的第三条同语义路径 |

后果不是「不好看」：**同一个用户、同一个条件，走 U1（首页）拿到「该办公楼暂未开通服务」，走 U6（下单）拿到「所属办公楼未配置楼群，请联系运营」—— 两句话不一样，其中一句还带运营黑话。** 这是 §10 第 14 项那条裁定（三类成因共用一条文案）在**另一个维度**上的同族病：那边是「一个桶三类成因」，这边是「一个码五种写法」。

> ⚠️ **三条 throw 点全部带第二参数**，不是一条。第二参数是「同一个码可以有第二种写法」的入口：只要它还在，改 `ERROR_MESSAGE` 就**不生效**，而改的人看不出来（编译过、跑得过、测试绿）。

**裁定**：

1. **统一为 `该办公楼暂未开通服务，请联系运营`。**
2. **`REASON_TEXT.building_not_grouped` 也要改成同一句**（现在缺「，请联系运营」）。理由：U1 走 `reason` 展示、U6 走 `msg` 展示 —— 不一起改，同一个用户在首页和下单页仍会拿到两句话。**「统一」漏了这一处就只是换了一种不一致。**
3. **三条 throw 点一律删第二参数**，让文案回落 `ERROR_MESSAGE`。改为 `throw new BizException(ErrorCode.BUILDING_NOT_GROUPED, undefined, undefined, { … })`。回源核实：`biz.exception.ts` 构造函数是 `super(message ?? ERROR_MESSAGE[code] ?? '业务异常')`，第二参数传 `undefined` 即回落。既有先例：`order.service.ts:278`（`SALES_PAUSED`）已是这个写法。
   - ⇒ 消灭的不只是一句文案，而是**「同一码两种文案」的第二种写法**。且**必须删存量**：判据能拦住新写的，拦不住「早就这么写」的那三处 —— 不删存量，`N1-24` 只能守增量，形同虚设。
4. **`traceability.service.ts:285` 改为 `ErrorCode.BUILDING_NOT_GROUPED`（10004 → 60011）并删第二参数**，见 §7.1.2。

**为什么不是反过来统一成「未配置楼群」**（Team Lead 2026-10-26 的判据，与我最初的建议相反，采纳他的）：我原先主张把 `REASON_TEXT.building_not_grouped` 向 60011 的 message 靠。Team Lead 换了一个判据得出相反结论 —— **60011 的旧文案向用户暴露了「楼群」这个内部运维概念**，用户根本不知道什么是楼群，那是运营侧的配置单元。

⇒ **正确方向是向中性说法靠**，且统一后的那句话要同时满足两条：**前半句用户看得懂、后半句给得出动作**。60011 恰恰是「运营漏配」这种用户**完全无能为力**的情况 —— 用户能做的唯一动作就是「联系运营」，文案必须把这一句说出来。反过来统一成「未配置楼群」，是把运营黑话推给一个对它无能为力的人。

这与 §9 第 8 项那条「三类成因共用一条文案」是**同一个判据的两次应用**：面向用户的字面不暴露运维概念，成因区分交给错误码。

**同步面（八处，收尾批一次做完）**

| # | 位置 | 改什么 |
|---|---|---|
| 1 | `apps/api-server/src/modules/meal/meal.service.ts:279–282`（字面 `:281`） | **删第二参数** |
| 2 | `apps/api-server/src/modules/order/order.service.ts:1693` | **删第二参数** |
| 3 | `apps/api-server/src/modules/traceability/traceability.service.ts:285` | **10004 → 60011** + 去掉第二参数（见 7.1.2，本批漏了的第三条路径）|
| 4 | `apps/api-server/src/common/constants/error-code.ts:662` | `ERROR_MESSAGE` 里的 `60011` 字面（**唯一真源**，另三处都回落到这里）|
| 5 | `apps/api-server/src/common/utils/orderability.ts:142` | `REASON_TEXT.building_not_grouped` 补「请联系运营」，与第 4 项逐字一致 |
| 6 | `apps/miniprogram/src/api/request.ts:41` | 前端注释里刚写的举例（同 §9 第 7 项的同步动作）|
| 7 | QA 判据脚本里的 sample（硬编码字面） | 断言里的期望字面 |
| 8 | 前端 e2e 里硬编码的三处 | 同上 |

> ⚠️ **第 7 / 8 项最容易漏**：sample 与 e2e 断言是**硬编码的字面**，文案改了不会自己跟。改文案前先 grep 一遍字面，别等 CI 红了才发现。
>
> ⚠️ **行号以本节表格为准**：逐条回源核过时 `order.service.ts` 的 throw 在 `:1693`（`:1692` 是它上一行的注释），`meal.service.ts` 的 throw 块是 `:279–282`（字面在 `:281`）。

#### 7.1.2 `traceability.service.ts:285` —— 本批漏掉的第三条同语义路径（Team Lead 2026-10-26 发现）

`traceability.service.ts:285` **仍抛 `10004` + 同样的「未配置楼群」文案**，是「楼未归群」这个语义的**第三条路径**，落码规格 §5 列的接线点里**没有它**。

> **为什么漏**：我们（我、后端、QA）都是**按「已知文件清单」扫**，而不是按「这个语义会出现在哪」扫。前者只能找到清单里已有的东西，后者才能找到清单外的。⇒ 本批补一条做法：**每接一个语义，先列出「这个语义可能出现在哪」，再逐个 grep 它的现文案**，而不是从既有接线点倒推。
>
> 已派后端改、派 QA 把判据扩到 `traceability`。

**`suspendReason` 缺字不设错误码**：它是**格式校验**，由 DTO 上的 `@MinLength(10)` 交给全局 `ValidationPipe` 拒成 **10001**，不需要业务码。「格式不合法」与「业务不允许」两条路径各归其位，不混。

`hint` 文案（两句：错什么 + 怎么修，沿用 `building-admin.service.ts:976` 的写法）：

- 60006：`{unfinishedCount} 笔订单尚未完成（最早 {earliestMealDate}）。未截单的将**继续履约并通知用户**；确认后勾选「强制停用」并填写不少于 10 字的原因。`
- 60007：`楼群下仍有 {unfinishedCount} 笔未完结订单（最早 {earliestMealDate}）。确认后勾选「强制停用」并填写不少于 10 字的原因。`
- 60008：`请先到「楼群划分」把该楼群恢复为启用，或改挂其他启用中的楼群。`
- 60012：`未完结订单 {unfinishedCount} 笔，超过可强制停用的上限 {threshold} 笔。请到「高危操作审批」提交 {opCode}，经第二人批准后执行。`
- 60013：`其中 {groupA.count} 笔已进入履约阶段（供应商已按份数备货），运营无权通过停用撤回。如需处理，请到订单管理页逐单走退款审批。`

**hint 必须区分「卡在退款审批」与「待履约」（采纳 QA 异议 3）**：`refund_applying` 计入未完结后，若退款审批流卡住，这栋楼会**长期无法停用**（`meal_date >= todayBj()` 挡得住历史脏单，挡不住本周内的卡单）。不改设计，但 hint 必须让运营知道该找谁：

- 当 B 组里 `refund_applying` / `refunding` 有量 ⇒ 追加一句：`其中 {refundCount} 笔卡在退款审批（找退款审批人），{fulfillCount} 笔待履约（找配送）。`
- 当 B 组只有 `pending_pay` / `paid` ⇒ 追加一句：`其中 {fulfillCount} 笔待履约（找配送）。`

**为什么这 8 个码全部落在 60006–60013 连续号段**：它们的共同点是「同一个谓词族的输出」。号段相邻本身就是一条弱的强制力 —— code review 时一眼能看出有没有人绕开谓词单独抛码。60009（停售）严格讲不属于「主数据」域，但摆在 60006–60008 旁边，比按域撒开更能防止第三份口径出现。60010 / 60011 虽由同一个谓词产出，但按**处置动作**拆开（业务主动停用 vs 配置缺失），是为了告警不同形 —— 这不违背号段相邻，两者仍然相邻。

---

## 8. 端到端验证步骤

> 规格不能停在「实现完成」。以下 11 步是本 ADR 的完成定义；第 8 / 10 / 11 步是刻意安排的关键错误流与回归面，不是可选项。

前置：`node scripts/gate.mjs shared`（重建 `@abox/shared-types` dist，其余门禁的前置）。

1. **准备**：`node scripts/gate.mjs seed` 后登录后台，取一栋 `ACTIVE`、已归群、次日已有 `active` assignment 的楼 B 及其楼群 G；再取一个**在 B 还是 ACTIVE 时就已绑定**的存量用户 U（新用户绑不进来，见 §1.3）。
2. **N1 happy path**：`GET /api/v1/meal/daily?mealDate={tomorrow}`（U）→ `canOrder: true`、`reason: null`。
3. **N1 核心缺陷**：`PUT /admin/buildings/{B}` `{status:3}` → 200。重跑第 2 步 → **`canOrder: false` 且 `reason === 'building_suspended'`**（修复前这里是 `true`）。
4. **N1 交易硬闸**：以 U 调 `POST /api/v1/orders` → **HTTP 200 + `code: 60010`**（`building_suspended`）或 **`60011`**（`building_not_grouped`，取决于构造哪种状态），且确认 `ab_order` **没有新增行**。再看 `GET /api/v1/team-leader/workbench` → `tomorrow.canOrder === false`、`tomorrow.reasonText === '该办公楼已暂停服务'`。
   - **另需单独验一条契约变更**：构造一栋「`ACTIVE` 但未归群」的楼 → 下单必须返回 **`60011`**，而**不再是现状的 `10004`**（见 §9 第 7 项）。
5. **N1 PREPARING 与 SUSPENDED 等价**：把 B 改成 `2（待开通）`，重跑第 2 步 → `canOrder: false` 但 `reason === 'building_preparing'`、文案为「该办公楼尚未开通，敬请期待」。**布尔相同、reason 不同 —— 这一步钉住 D-N1-4。**
6. **管家端不被时间污染（裁决 0-C 的回归）**：把 B 改回 `ACTIVE`，注入 `ABOX_SHIFT_TO_HOUR=0`（当日 00:00，**未开团**）后同时拉两个接口 → `GET /admin/buildings` 里 B 的 `canAssign` **仍为 `true`**，而 `GET /api/v1/meal/daily` 的 `canOrder === false` 且 `reason === 'not_open_yet'`。**两侧必须同时断言** —— 只看管家端的话，这条在什么时候都成立，单独跑是恒绿的。
   - ⚠️ **机制更正**：本步原写「在一个过了截单的时点（注入时钟）」—— **`ABOX_SHIFT_TO_HOUR` 跨不了零点，也落不到非整点**（`SHIFT_MS = target * 3_600_000 - withinDayMs`，`time.ts:64–77`）。而「已过截单」是 `[23:50, 24:00)` 这条窄带（上界由 `截单 − cutoff_window_minutes` 算出），**注入到不了**；注入 23 得到 23:00，仍在下单窗口内。改用注入 `0` 制造「用户端时间层为假」的对照 —— 要验的是「时间层为假、结构层为真时管家端不得跟着变假」，至于是「未开团」还是「已截单」造成的，对这个结论没有区别。
7. **N2 硬闸**：以 U 下一单并支付到 `paid`，再 `PUT /admin/buildings/{B}` `{status:3}`（不带 force）→ **HTTP 200 + `code: 60006`**，payload 含 `unfinishedCount >= 1`；确认 B 的 status **仍是 1**（未落库）。
8. **N2 沉默逻辑定向（关键错误流）**：把第 7 步那笔订单推进到 `refund_applying`（走团长代退 → 退款申请中），对 B 再发一次 `PUT {status:3}`（不带 force）→ **必须仍返回 60006**。这一步唯一的目的是防「硬编码 6 态白名单漏掉 `refund_applying` / `refunding`」的回归。**必须固化成 jest 用例，不能只手工跑一次。**
9. **N2 分级 + 逃生舱 + A 组硬约束**：
    - `1 ≤ N ≤ 阈值`：传 `forceSuspend: true` 但 `suspendReason` 只有 4 字 → **`10001`**（DTO `@MinLength(10)` 由 ValidationPipe 拒，不是业务码）；补足 10 字 → 200，`changed: ['status']`，`ab_operation_log` 有带 `forceSuspend` 与 `reason` 的记录。
    - 把某单推进到 `delivered`（A 组）后再停用 → **即使带 `forceSuspend` 也必须返回 `60013`**，且 B 的 status 未变。
    - `N > 阈值`：构造「阈值 + 1」笔 → **`60012`**，且提示的 opCode 能在 `/admin/operation-requests` 提交并走完 approve→execute。
10. **状态机不被冻结（隐性欠薪回归面）**：停用一个含 `delivered` 订单的楼后，推进到 T 日 14:00（或手动触发自动确认）→ 该单必须照常 `delivered → completed`，且**佣金照常生成**。这一步是 D-N2-4 最容易被漏掉的回归。
11. **W1 净新增 + 不影响既有链路**：
    - 以 admin 调 `POST /admin/sales-pause` `{mealDateFrom: tomorrow, mealDateTo: tomorrow, reason: '临时检修'}` → 200。**立刻**（不等缓存）重跑第 2 步 → `canOrder === false`、`reason`（**中文文案**）含「临时检修」；`POST /api/v1/orders` → `code: 60009`。
      - ⚠️ **这里曾是 `reason === 'sales_paused'`，是错的，已改**（2026-10-26 Team Lead 派单时发现）。回源 `meal.service.ts:144` = `reason: availability.reasonText` ⇒ U1 下发的 `reason` 是**中文文案**，枚举码只存在于服务内部、不下发。**机器判别停售只能靠 U6 的 `60009`。** 完整裁定与「不改契约、不加 `reasonCode`」的三条理由见 spec §7.6。
    - `POST /admin/sales-pause/{id}/resume` → 重跑第 2 步 → `canOrder === true`。
    - **回归面**：停售期间 `PUT /admin/meal-assignments/*`（编排）仍可用（D-W1-4）；`ab_order` 存量单状态与佣金不受影响（D-W1-3）。

收尾必跑：`node scripts/gate.mjs typecheck:api schema:parity index:parity errcode:message lint lock:version jest`，以及 `e2e:m1` / `e2e:m2` / `e2e:m3`。

---

## 9. 明确不做（out-of-scope）

写清楚，杜绝范围蔓延：

1. **不做批量退款 / 自动取消存量单。** 用户已拍板：停用与停售都只拦新单，存量单继续履约 + 通知。涉及钱的批量动作走既有的逐单审批通道。
2. **不做服务端两段式确认（预检 + token）。** 已否决（`N > 20` 走的是既有 `OperationRequest`，不是新造的临时 token）。
3. **不改现有 `Object.assign + save` 的 version 自增写法。** `updateBuilding` / `updateGroup` 目前是 `b.version = (b.version ?? 0) + 1`（`building-admin.service.ts:685`、`:982`），与 `lock:version` 门禁要求的 `version: () => 'version + 1'` + `WHERE version = :v` 形态不一致。本批**不改**，以免把「新增闸门」和「写路径并发收口」混进同一个 diff —— 已在 §10 单列。
4. **不做「楼宇自动停用调度」**（到点自动停）。没有需求，且它会让 N2 的受影响面处于无人签署的状态。
5. **不给 `ab_order` 加新索引。** 见 D-N2-5 的容量判断。
6. **更正前稿**：我在前稿写了「本批不在 `config.specs.ts` 登记任何东西」，**这条已被用户拍板的分级拦截推翻**。准确的口径是：**N2 的两个阈值（新建 `building.*` 命名空间）必须登记进 `config.specs.ts`；W1 的停售不登记**（它不写 `ab_config`）。不要为了「配置项要登记」这条纪律的形式，把一个不是配置项的东西塞进键值表 —— 反之，真写了 `ab_config` 的东西就必须登记。
7. **不动《接口规范 v1.0》§九 已锁的错误码 —— 但本批有一处**契约变更必须同步登记**。**
   - **保留原码原义**：`30001 ORDER_CUTOFF` / `30005 MEAL_NOT_PUBLISHED`。差异只体现在 `payload.reason`。
   - **变更**：「所属办公楼未配置楼群」的现状码是 **`ErrorCode.NOT_FOUND`（10004）**，抛点在 `meal.service.ts:281` 与 `order.service.ts:1693`，本批改为 **60011 `BUILDING_NOT_GROUPED`**。
   - **必须同步的两件事**（不做就会留下一处陈旧的第二真相 —— 正是本批在消灭的东西）：
     1. 修订 `apps/miniprogram/src/api/request.ts:37–44` 的注释：那里把「所属办公楼未配置楼群」当作 `10004` 的举例，用来论证 `20016` 与 `10004` 是两件事（我回源核过，原文属实）。举例要改成 `60011`，否则注释与代码互相打脸。
     2. 在《接口规范》§九登记这次错误码变更。
   - **同一条件的另一处也一并对齐（Team Lead 2026-10-26 裁决：不是顺手，是本批必做）**：`order.service.ts:1686`「你还没有选择办公楼」此前也是 `10004`，而 `meal.service.ts:262` 同样条件已是 `20016 USER_BUILDING_UNBOUND` —— **两个服务、同一条件、两个码**。
     - 本批把 `1624` 改为 **`20016`**，文案同步为「你还没有选择办公楼，选好即可下单」（旧文案「请通过团长邀请链接进入」是**唯一绑楼途径**时的说法，现在有 `GET /building` + `PUT /me/building` 自助链路）。
     - 三条理由：① 它就是本批正在消灭的「同一语义两个码」的现成实例；② 端上已支持 20016（`index.vue:362` 据此换空态主按钮、`request.ts:44` 已导出常量），补上是**对齐**而非新增契约；③ 不改则 P3-4 接线后「看套餐」返 20016、「下单」返 10004 —— 一边收口一边留一个新的。
     - ⚠️ **更正**：落码规格的上一版把这一条写成「两处一致，没问题，本批不动」。那是凭印象写的、没有回源 —— 而本 ADR 这一条当时写的是对的。同一议题两份文档给出相反结论，读者无法分辨哪份可信。已统一为「必改」。
8. **D-N1-8 的连带文案处置（`building_not_grouped` 语义变宽）：文案不改，补注释声明。**
   - 修完后 `building_not_grouped` 同时覆盖**三类**输入：**① 楼不存在 / 软删**（`buildingStatus === null`）、**② 楼未归群**（`buildingGroupId === null`，配置没做完）、**③ 楼群记录不可达**（`buildingGroupStatus === null`，悬空引用 / 软删）。
     - ⚠️ **「两类」是错的说法**（2026-10-26 更正）：漏了 **① 楼不存在** 这一类，它由 `buildingStatus === null` 单独承载，与「楼未归群」不是一回事。回源核对：`orderability.ts:136-140` 的注释写的是三种成因，后端落的是对的。**两份文档按三类对齐**（G12）。
   - **裁定：两种成因共用一条文案，字面不改。**（Team Lead 2026-10-26）
     - 理由：对**用户**而言，这三类成因的**处置动作完全相同** —— 都是「我下不了单，去找团长 / 运营问」。用户不需要、也分辨不了这两种成因；为一个用户感知不到的区别多开一个文案分支，成本不小、收益是零。
     - 面向**排查者**（运营 / 开发）的区分**由错误码承担**：`60011 BUILDING_NOT_GROUPED` 本身就是「配置缺失」信号，排查者看码即可，不要求文案再承担一遍。
     - ⚠️ **但「一个桶共用一条文案」不等于「一个码可以有四种写法」** —— 同一语义在仓库里现在有四处不同字面（含 `order.service.ts:1693` 用第二参数覆盖 `ERROR_MESSAGE`），那是**另一个维度**的同族病，在 §7.1.1 单独裁定。
   - **唯一需要登记的同步目标（真符号，一处）**：`apps/api-server/src/common/utils/orderability.ts:142` 的 `REASON_TEXT.building_not_grouped` —— 在其上方**补一段注释**，声明这个桶现在覆盖两类成因、以及为什么不为它们拆开文案。**文案字面不动。**
   - ⚠️ **作废一条登记**：本 ADR 上一版曾把一个**全仓 grep 命中 0 的虚构文案常量**登记为同步目标（Team Lead 2026-10-26 已确认系误记）。该登记**整条删除，且不再写出该符号名** —— 写下来就等于给下一个执行者留一道必红的题：他会 grep、会花时间找、最后只能空手回来。教训单独记在这里：**同步清单里的每个符号，登记前必须 grep 到实际行号。**
9. **不改小程序端的图标策略与视觉稿。** 后台新增按钮沿用既有 `abi-*` 档位 class + `ABOX_ICON_CHARS`，不新增图标来源、不引入 SVG 图标库、不使用 emoji。
10. **不改 `user.service.ts:118` / `building.service.ts:73` 两道入口校验。** 它们是既有回归基线（QA 已用静态判据锁死），削弱它们等于在修 N1 的同时开一个新洞。

---

## 10. 开放项的最终裁定（2026-10-26 · Team Lead）

| # | 事项 | 裁定 | 落实位置 |
|---|---|---|---|
| 1 | 结构层是否吃集散覆盖（`DistributionGap`） | **不吃**（§2.2）。若产品坚持要拦，正确落点是**集散中心配置动作**上的闸门，另立议题 | §2.2 |
| 2 | `OrderAvailabilityService` 要不要内建短缓存 | **不做**，直读 DB —— 加缓存只是把 60 秒换成更小的数字，没有消灭不一致，只是缩小它 | §5.3 负面 |
| 3 | `updateBuilding` / `updateGroup` 的乐观锁是否顺手收口 | **不动**，不把「新增闸门」和「写路径并发收口」混进同一 diff，单列议题 | §9 第 3 条 |
| 4 | 管家端 `canOrder` → `canAssign` 改名是否计入版本修订 | **同步改 Swagger 描述并记入版本修订** | §3.5 |
| 5 | A 组硬约束之下运营的紧急出口 | **未决**（见下） | — |
| 6 | 通知失败的重试与补发 | **留痕 + 运营手动补发**（复用 `MessageOrchestrator`），不做自动重试（幂等与重复打扰问题） | D-N2-3 |
| 7 | `forceSuspend` 的角色范围 | **放宽到 `admin`**（紧急场景往往只有值晚班运营在现场）；附加约束：**强制停用的 `reason` 必须进审计**，复用 `@OperationLog`，不新造留痕通道 | D-N2-6 |
| 8 | 错误码号位 | **60006–60013 连续八码，无跳号**（二次调整定稿）。`BUILDING_NOT_ORDERABLE` 废弃，拆为 60010 / 60011 | §7 |
| 9 | 60008（挂楼入已停用楼群）是否本批修 | **本批一起修，必做项** —— 它是同一个可订谓词的一部分，且走的是运营最高频动作，留着会持续产生脏数据 | D-N1-7 |
| 10 | A 组硬约束之下运营的紧急出口 | **用户已裁决：本批不扩建。** 现状核查结果为：订单侧只有单笔 `force-refund`；改派在已截单后被 30014 拦死且要求同楼群；批量能力全仓零命中 ⇒ 独立议题，**不写进本批 spec 的必做项** | 见下 |
| 11 | 未配置楼群的 `10004` → `60011` | **采纳 QA 异议 1，本批必做**：改码 + 同步修订 `request.ts:36–41` 注释 + 登记《接口规范》§九 | §9 第 7 项 |
| 12 | 未完结 hint 是否区分「卡退款审批」与「待履约」 | **采纳 QA 异议 3**：区分。`refund_applying` 计入未完结后若审批流卡住，该楼会长期无法停用，hint 必须告诉运营该找谁 | §4.2 D-N2-1 |
| 13 | 楼群查不到（`buildingGroupStatus === null`）的 fail-open | **本批修，不单开**。与 `buildingStatus === null` 合并成同一条存在性判据（三选一即 fail-closed）。三条依据：`status` NOT NULL ⇒ `null` 只来自「查不到」、无假阳性；无任何代码删楼群 ⇒ 今天零行为变化；与 D-N1-2 是同一谓词的同一类洞 | **D-N1-8** |
| 14 | `building_not_grouped` 语义变宽后文案要不要拆 | **不拆**（§9 第 8 项）：**三类**成因对用户的处置动作相同，区分责任交给错误码 `60011` | §9 第 8 项 |
| 15 | 同一语义「楼未归群」在仓库里有**五处不同写法**（三条 throw 点**都**带第二参数） | **收尾批统一（不在 P3-5）**为 `该办公楼暂未开通服务，请联系运营`；方向是**向中性说法靠**（旧文案暴露「楼群」这个内部运维概念）；**三条 throw 点一律删第二参数**（含存量，否则判据只能守增量）；`REASON_TEXT` 也改同一句 | §7.1.1 |
| 16 | `traceability.service.ts:285` 第三条同语义路径 | **本批漏了，已补登记**：仍抛 `10004` + 「未配置楼群」文案。已派后端改、派 QA 扩判据 | §7.1.2 |
| 17 | 端上「60011 零消费点」要不要立「每个码都必须有专属消费点」判据 | **不立**（恒红 + 逼端上按码穷举 = 制造第二真相）。**改立 N1-26**：端上错误兜底分支**在服务端给了 `message` 时**必须回落该 `message`，不得硬编码中文。两条是**替代关系**：兜底一旦回落服务端，新码不需要端上做任何事就自动被正确呈现 —— 第一条的动机因此消失 | 落码规格 §14.3 |
| 18 | 端上「契约变更但零消费」要不要当缺陷处理 | **不当缺陷，当流程缺口留痕**：靠泛型兜底是合法设计。流程注记 —— 改错误码时 checklist 要有一个**判断动作**（「端上是否需要消费点？」），答案是「否」也要写下来并说明靠什么兜底。**靠兜底是合法结论，没想过不是** | 落码规格 §14.3.3 |
| 19 | U1 下发的 `reason` 是**中文文案**不是枚举码（本 ADR 第 11 条验收**上一版写错了**，写成了 `reason === 'sales_paused'`）；要不要加 `reasonCode` 字段让端上能机器判别 | **不加、不改契约。** 三条理由：① 首页要展示的本就是「为什么不能下单」，用文案是对的，且会带上运营填的停售原因；②「已下订单不受影响」在任何被拦场景都成立，不需要能区分停售才显示；③ 唯一需要机器判别的停售信号是 **U6 的 `60009`**，已经有了。⇒ 加 `reasonCode` 只会造出「文案 + 码」两个语义出口，正是本批在拆掉的东西。**配套立 `W1-UI-5`**：端上不得把 `reason` 当枚举码做字符串比较（守「字段 + 比较形态」这一类写法，不只禁 `sales_paused` 一个字面；数值错误码比较与文案展示**允许**）。**留给将来的方向（非待办）**：若动契约，优先**改名**（HTTP 层改叫 `reasonText`）而不是加字段 —— 加字段让两个名字继续并存，改名消掉歧义本身 | 落码规格 §7.6 / §13.5 |

### 关于第 10 项（运营出口）—— 已裁决，但风险仍需被看见

用户裁决本批不扩建订单侧批量能力。我照办，且它不影响 N1/N2/W1 四处落码。但把结论留在文档里：

**紧急场景（楼宇封控 / 食品安全）且已截单时，运营当前既不能停用（60013），也没有批量改派 —— 唯一路径是逐单走 `force_refund` 审批。** 这个成本是真实存在的，只是用户选择现在不为它付费。将来订单侧补批量能力时，本 ADR 的 §4.3「夺去的容错」是那份需求的出处。

### 一个会随时间退化的不变量（必须写死，不能留成隐式假设）

**W1 的停售判定是 fail-closed（查停售表异常 ⇒ 拒绝下单）。这条结论依赖「`OrderAvailabilityService` 不加缓存」这个前提。**

- 现在成立的原因：停售读的是同一个 DB，这行查询失败时同事务其它操作也已在失败 —— 不存在「独立基础设施抖动」。此时 fail-open 的表现是「停售开着却继续收单」，不可接受。
- **一旦将来加了短缓存，「缓存抖动 ≠ DB 故障」重新成立**，fail-closed 会把一次缓存抖动变成**全站停售**，那时必须**反转回 fail-open**。
- QA 已配两条联动静态判据把这条钉住：`S-W1-5`（`OrderAvailabilityService` 内不得出现任何缓存）+ `S-W1-7`（有缓存 ⇒ 必须同时存在 fail-open 处理）。**任何人动这块缓存，请先看 `docs/qa/AC-N1N2W1-楼宇停用与一键停售.md` 的这两条。**

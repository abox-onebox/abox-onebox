# N1/N2/W1 · 楼宇停用与一键停售 —— 验收标准与回归设计

> 版本：**v2.1** · 日期：2026-10-26
> 作者：QA（mvp-dev-expert-team-qa）
> 状态：**Phase 2 测试设计产物** —— 本文只定义「怎样算做完」，**不含任何业务代码改动**
>
> **v2.0 变更（相对 v1.0）**：已按架构师 ADR（`docs/decisions/ADR-N1N2W1-楼宇停用与一键停售.md`）全面对齐。
> QA 已**独立回源复核 ADR 的全部关键事实，全部为真**（见 §0.5），因此采纳其设计；
> v1.0 中被否决的部分（W1 走 `ab_config`、blockers 数组、分级逃生舱、错误码号段）**已在本文删除而非标记作废** ——
> 留两份就会变成第三份口径，那正是本批要消灭的病根。
>
> **本文唯一异议**已收敛为 §0.6 的三条，需 Team Lead 裁决。

---

## 0. 事实基线

### 0.1 QA 第一轮回源（针对派工包 v2）

> 派工包已给出事实清单。QA 按「测试作者 ≠ 代码作者」纪律（`test-discipline.md` §4）**独立回源复核**，结论分三类。

| # | 派工包说法 | QA 复核 | 结论 |
|---|---|---|---|
| 1 | `building-admin.service.ts:218/325/623/701` 用 `status===ACTIVE && gid!==null` | 确认四处 | ✅ |
| 2 | `meal.service.ts:104` 用户端 U1 | 确认 `assignment.status==='active' && isOrderable(...)` | ✅ |
| 3 | `workbench.service.ts:123` 团长工作台 | 确认 `isOrderable(tomorrow, cutoffWindow)` | ✅ |
| 4 | 套餐分配楼群维度 / 订单楼宇维度 | 确认。`order.entity.ts:19` `idx_order_building_meal(['buildingId','mealDate'])` 已存在，且 `order.entity.ts:45/48` 同时有 `buildingId` 与 `buildingGroupId` | ✅ |
| 5 | 停用 patch 在 672 行 | **实为 678 行**（`updateGroup` 侧对应 951 行） | ⚠️ 行号修正 |
| 6 | 楼群停用只拦「楼群非空」60003 | 确认 `964-979` 仅 `remaining > 0`，不查订单 | ✅ |
| 7 | 未完结订单 6 态 | 实际 11 态；`ORDER_TERMINAL_STATUS`（`order-status.ts:88`）= `[completed, cancelled, refunded]` ⇒ **未完结 = 8 态** | ❗ 补充 |
| 8 | 两个状态枚举 | 逐字一致 | ✅ |
| 9 | 「一键停售」作为既有缺陷 | **全仓零命中** | ⚠️ 是净新增功能 |

### 0.2 裁决 0-A：未完结 = 8 态，且必须是黑名单反算

派工包的 6 态漏了 `refund_applying` / `refunding` —— 这两态**钱正在往外退**，恰好是 N2 要拦的人。

```
未完结 := ab_order.status NOT IN ORDER_TERMINAL_STATUS   -- completed / cancelled / refunded
          AND meal_date >= todayBj()
```

**禁止硬编码枚举清单**（`order.service` 全文到处都是 `OrderStatus.X`，白名单还有另一个致命性质：**将来新增任一中间态，白名单默认放行且不给任何信号**）。ADR D-N2-3 与本文档口径一致。

**fail-closed 的属性在此成立**：历史上 `refund_applying`/`refunding` 就是后加的，黑名单会自动拦住它。这是本批最硬的一条判据，见 `S-N2-1`/`S-N2-2`。

### 0.3 裁决 0-B：N1 的受影响面 = 存量已绑用户

用户侧入口其实**已有两道旧校验**（`user.service.ts:118` bindBuilding 拦非 ACTIVE、`building.service.ts:73` listSelectable 过滤 ACTIVE）。真正的洞只在两条读取路径，**均只取 `buildingGroupId`、不读 `status`**：

```
meal.service.ts:267-271    resolveUserGroup()   if (!building?.buildingGroupId) throw …   ← 无 status 判定
order.service.ts:1626-1630 resolveGroup()       if (!building?.buildingGroupId) throw …   ← 无 status 判定
```

⇒ 受影响面 = 「ACTIVE 时已绑、之后被改成 PREPARING/SUSPENDED」的**存量已绑用户**，新用户绑不进来。
⇒ 这两道旧校验是**回归基线**（B0-1 / B0-2），不得被本批削弱。
⇒ PREPARING 必须一并处理 —— 存量用户会被运营改过去，不能因为「反正绑不进来」就跳过。

### 0.4 时间口径（全部断言以此为基准）

```
T-1 14:00   publishAt   开团（ab_config: set_meal.publish_time）
T-1 24:00   cutoffAt    截单（= T 日 00:00）
T  11:30    arrivalAt   送达写字楼
T  14:00    autoConfirm 自动确认完成
```

---

## 0.5 ★ QA 对 ADR 关键事实的独立复核结果（全部为真）

> ADR 提出了若干决定性论据。QA 逐条回源，**没有一条是推测**。这是本文档采纳其设计的前提。

| ADR 论断 | QA 复核证据 | 结论 |
|---|---|---|
| D-W1-1① `BizConfigService` 是 **60 秒进程内 TTL 缓存** | `biz-config.service.ts:41` `private readonly ttlMs = 60_000`；文件头注释「后台改配置后最多 1 分钟生效」 | ✅ **属实** |
| D-W1-1③ `SysConfig` 无 `createdBy`（无法追责） | `system.entity.ts:119-138` 仅 `configKey/configValue/description/createdAt/updatedAt` | ✅ 属实 |
| D-W1-1④ 已有开小表的先例 | `migrations/1700000000011-op-blocklist.ts` 存在 | ✅ 属实 |
| 下一迁移号应为 `1700000000019` | 最新是 `1700000000018-referral-user.ts` | ✅ 属实 |
| `ab_op_blocklist` 不可复用（表头 `x-kb-opblock` 才生效 + fail-open） | `op-blocklist.interceptor.ts:32-35` `if (!raw) return next.handle()`；`:46-49` catch → `logger.warn('禁止清单查询失败，放行助手写操作')` | ✅ **属实，否决正确** |
| 旁路 1：`assignMembers` 不查目标楼群状态 | `building-admin.service.ts:1024-1045` 只做 `buildingRepo.find/save`，无 group 状态判定 | ✅ **属实** |
| 旁路 2：`updateBuilding` 归群分支不查目标楼群状态 | `:670-677` 只调 `assertGroupExists`，而 `:1091-1094` 仅 `findOne` 判存在、**不判 status` | ✅ **属实** |
| 6xxxx 号段 60006 起可用 | `error-code.ts:491-506` 只到 60005 | ✅ 属实 |

> ⚠️ **落地状态（2026-10-26 23:20 QA 回源复核）** —— 上面两张「旁路」行是**裁定当时的快照**，
> **现状已不成立**，保留它记录的是**裁定依据**（为什么必须堵），不是现状：
>
> | 快照里的说法 | 现状 |
> |---|---|
> | **两条**旁路（`assignMembers` / `updateBuilding`） | **三条** —— 后端补出 `createBuilding`（`POST /admin/buildings` 带 `buildingGroupId`）：原来只查「在不在」，可以把楼**新建**进一个已停用楼群，之后因 `group_suspended` 不可下单，而后台回执是「创建成功」。与另两条同一个病，只是走新建而不是编辑/搬楼 |
> | 符号 `assertGroupExists` | **已删除，全仓 0 命中**（收口进 `assertGroupOpen()`） |
> | 旧行号 `:1024-1045` / `:670-677` / `:1091-1094` | 该文件本轮后移 300+ 行、N4 收口又净增约 40 行 ⇒ 全部已漂 |
>
> 现状的三条写路径与唯一准入（**QA 自己 grep 的，不是转述**）：
>
> | 路径 | 方法 | `assertGroupOpen(` 调用点 |
> |---|---|---|
> | 新建带归群 | `createBuilding` **`:712`** | **`:722`** |
> | 编辑归群 | `updateBuilding` **`:762`** | **`:810`** |
> | 批量搬楼 | `assignMembers` **`:1490`** | **`:1499`** |
>
> 判据在 `groupGate()` **`:1583`**，抛码在 `assertGroupOpen()` **`:1595`**，全仓 60008 抛点 **1 处**（`:1601`）。
>
> ⚠️ **行号漂移提醒**：架构师同一批报的 `assignMembers` / `groupGate` / `assertGroupOpen` 行号
> 与我复核的**差 7 行**（他 `:1483` / `:1576` / `:1588`，我 `:1490` / `:1583` / `:1595`；
> `createBuilding` / `updateBuilding` 两侧一致）。取差的那三个都在文件**后半段** ⇒
> 是他在文件又长了 7 行之前 grep 的。**引用行号前先自己 grep 一遍**，别转手。

**⇒ 结论：ADR 的技术论证成立，QA 采纳。v1.0 中我提的 W1 走 `ab_config` 是错的**（60 秒窗口会导致「点了停售还在收单」，且 `ensureLoaded` 的 catch 分支是「沿用旧值/回落缺省 + 仅告警」—— 对一个停售开关而言这是**静默 fail-open**，方向危险）。

---

## 0.6 ⚠️ QA 保留的三条异议（需 Team Lead 裁决）

### 异议 1（P1）10004 → 60010 是一处**未被 ADR 声明**的契约变更

ADR §9 第 7 项写「不动《接口规范》§九 已锁的错误码，30001/30005 保留原码原义」，但漏了 **10004**：

- 现状：`meal.service.ts:269` 与 `order.service.ts:1628` 在「所属办公楼未配置楼群」时都抛 **`ErrorCode.NOT_FOUND`（10004）**
- ADR §3.4 把它映射为 **60010**
- **`apps/miniprogram/src/api/request.ts:36-41` 有一段注释把 10004 钉成既定契约**：「它与 `10004 NOT_FOUND`（如「所属办公楼未配置楼群」）是**两件事** —— 前者用户能自己解决，后者只能找运营。合成一码时端上就只能给一句两可的兜底文案。」

**裁决建议**：这次改动**方向是对的**（让 10004 回归纯粹的「目标不存在」，把「未配置楼群」独立成可寻址的码，与该注释倡导的纪律一致），但必须：
1. 同步修订 `request.ts:36-41` 的注释 —— 否则它就是一处**陈旧的第二真相**，而本仓反复整顿的正是这类东西；
2. 在《接口规范》§九登记，**不能只在 ADR 里提 30001/30005**。
⇒ 已落成回归用例 **B1-8**（断言 10004 不再承担「楼未归群」语义）与静态判据 **S-N1-7**。

### 异议 2（P2）四种 building 级 reason 合成一个 60010，会牺牲可观测性

ADR §7 把 `building_not_grouped / building_preparing / building_suspended / group_suspended` 四个 reason 合并返回同一个 `60010`，靠 `payload.reason` 区分。这在**端上分支**层面够用（用户只需要一句文案），但在**监控/告警**层面会同质化：`10004` 那种「运营要配一下」和 `building_suspended` 那种「业务主动暂停」是两类完全不同的事件。

对照本仓自己的先例：`error-code.ts` 拆 `30022`/`30023` 时给出的理由是「**可观测性**：两者此前共用一个码 ⇒ 日志/监控/告警里**完全同形**」。
⇒ 建议（非阻断）：至少把「数据是配置缺失（`building_not_grouped`）」与「运营主动停用（`building_suspended`/`group_suspended`）」拆成两码。已记入 §F 待裁。

### 异议 3（P2）`refund_applying` 存在自锁风险 —— 需要兜底口径

> **v2.1 更新：已被 ADR 部分解决**（时间边界保留 + `hint` 拆分 `groupA`/`groupB`），但你挡不住的就是每周内的卡单。
> `hint` **必须区分**「卡在退款中的单」与「待履约的单」，否则运营不知道该去找退款审批还是找配送。已落成 **B2-10**。

### 异议 4（P1 · v2.1 新增 · 对用户拍板口径的实质性补充）B 组内部必须再分两种通知文案

用户拍板把 `pending_pay`/`paid` 与 `refund_applying`/`refunding` 合成 **B 组统一动作**（都继续推进、都不批量退款）—— 这个合并 QA 认同。

但两组的**用户结局是相反的**：前者会得到餐，后者会得到退款。若通知文案统一按「继续履约」生成，一个**退款中的用户会收到「你的订单将照常送达」** —— 这是事实性错误，且用户会据此不做午饭安排，是可直接引发客诉的形状。

⇒ **建议：分组决定「系统做什么」，结局决定「用户收到什么」。** 已落成 **N2-AC-07** + **B2-14**（断言两类文案不同）。

### ⚠️ 协作风险记录（v2.1）：ADR 消息 table 与 ADR 文件不一致

本轮沟通中，架构师消息里给的错误码表（60006=挂楼 / 60007=reason / 60008=N>20 / 60020=停售 / 60021=结构层拦）
与 **ADR 文件实际内容不符** —— 文件第 567 行明确写「**不采用** 60020 / 60021 跳号」。

**QA 一律以文件为准**（已全部回源核对）。本文 §E 已按文件终稿登记。
⇒ **这恰恰是本批要消灭的那类问题的同族：** 同一件事两份表述，其中一份（消息）必然会悄悄错掉。
建议后续裁决结论统一沉淀进文件，不在消息里另给一份 table。

---

## A. 验收标准（EARS 格式 · 每条可机械判定）

**格式约定**：`While/When/If/Where + 系统 + 必须/应该 + 行为`；每条附「机械判定」。
「必须」= 硬性；「应该」= 建议性（P2 backlog）。

### A.0 贯穿三项的共同判据

> **AC-COMMON-1（P0）可下单判定必须有且只有一份实现。**
> **Where** 任何回答「此刻能否下单」的地方，**then** 系统 **必须** 调用同一谓词
> （ADR：`common/utils/orderability.ts` 的 `evaluateOrderability()` + `OrderAvailabilityService` 编排层），
> **不得** 在任何 service 内自行推导第二个布尔或其它判据。
>
> 三个调用点（缺一即 N1 未修复）：U1 `GET /api/v1/meal/daily` · U6 `POST /api/v1/orders` · 团长工作台 `tomorrow.canOrder`。
>
> **机械判定**：静态判据 `S-N1-3`/`S-N1-4` + 运行时 **B1-7**（三端同一秒调用，布尔必须恒等）。

> **AC-COMMON-2（P0）`canOrder` 与 `reason` 必须由同一次求值产出。**
> 「能否下单」一个判据、「为什么」另一个判据 —— 这正是 N1 的原始病灶。
> **机械判定**：`expect(reason === null).toBe(canOrder)` 对所有 8 条 reason 与 happy path 全覆盖（S-N1-8 单测锁死）。

> **AC-COMMON-3（P0）停用/停售一律「只拦新单，不动存量单」。**
> 不自动取消、不自动退款、不冻结任何状态机推进（含 `delivered → completed` 与佣金入账）。
> **机械判定**：B0-7 / B3-6 / B4-4。

---

### A.1 N1 · 楼宇停用的用户端表现

#### N1-AC-01（P0）SUSPENDED 楼禁止新增下单

> **When** 楼宇 B `status = 3 (SUSPENDED)`，**且**用户 U 停用前已绑定 B，
> **then** U6 `POST /api/v1/orders` **必须** 返回 HTTP 200 + `code = 60010`，`payload.reason === 'building_suspended'`，
> 且 `ab_order` **必须** 零新增。

#### N1-AC-02（P0）U1 首页必须同步不可下单，且仍完整下发套餐内容

> **When** 同上，**then** U1 `GET /api/v1/meal/daily?mealDate=T+1` **必须** 返回 `canOrder=false`、
> `reason='building_suspended'`、`reasonText='该办公楼已暂停服务'`，
> 且 `items` **必须** 非空（用户仍能看到明天本来吃什么）。

> ⚠️ 后半句**最容易漏**：只置 `canOrder=false` 顺手清空套餐 ⇒ 用户看到「今日未开团」，与事实不符。
> U6 也要接（ADR D-N1-1：**只改 U1 ⇒ 交易侧照收钱**；只改 U6 ⇒ 按钮态说谎）。两处都要。

#### N1-AC-03（P0）PREPARING 与 SUSPENDED：布尔不区分，reason 必须区分

> **Where** 楼宇 `status = 2 (PREPARING)`，**then** 系统 **必须** 返回 `canOrder=false` **且**
> `reason === 'building_preparing'`、`reasonText === '该办公楼尚未开通，敬请期待'`，
> 与 `building_suspended` 的布尔相同、**reason 与文案逐字不同**。

**机械判定**：`expect(resA.canOrder).toBe(resB.canOrder); expect(resA.reason).not.toBe(resB.reason);`
> 理由：布尔不区分是因为用户可执行动作相同；reason 区分是因为**运营的修法不同**（去开通 vs 去恢复）—— 这正是 `BuildingStatus` 当初扩成三态的原因。

#### N1-AC-04（P0）楼群 SUSPENDED 时成员楼连带不可下单（派生，不写库）

> **When** 楼群 G `status = 2`，成员楼 B **仍为 ACTIVE**，
> **then** B 下用户 **必须** 满足 N1-AC-01/02，`reason === 'group_suspended'`。
> **并且** `ab_building.status` **必须** 保持 1（不得把停用下刷到成员楼行上）。

#### N1-AC-05（P0）reason 优先级必须锁定全序（**替代 v1.0 的 blockers 数组**）

> **Where** 多个阻断原因同时成立，**then** 系统 **必须** 返回**单一** reason，取值严格服从：
> ```
> 1 sales_paused → 2 building_not_grouped → 3 building_preparing → 4 building_suspended
> → 5 group_suspended → 6 meal_not_published → 7 not_open_yet → 8 cutoff
> ```
> **不得** 返回第二个 reason（不再有 `blockers` 数组）。

**机械判定**：对 8 条 reason 做**全组合覆盖单测**（2^8 抽关键组合），断言返回的 reason === 优先级最高者。
> 为什么改成单一 reason：v1.0 我提 `blockers` 数组是为了「后台与用户端别对不上」，但 ADR 的**单一谓词**从根上解决了这点（两端调同一个函数，不存在各说各话）。而多个 reason 同时下发给用户，抵达成了一个没有可执行结论的列表。**以现在的方案更好，采纳。**
> 立即处置：`reason` 的可观测面改由单测全序锁 + U6 `payload.reason` 承担。

#### N1-AC-06（P0）「已下单未截单」时停用 —— 继续履约 + 必须通知用户

> **When** 运营在 **T-1 24:00 截单前** 把 B 置 SUSPENDED，且 B 下有 `pending_pay` / `paid` 订单，
> **then** 系统 **必须** 保持订单继续推进（不自动取消、不自动退款），**并且必须** 告知下单用户「已下的订单不受影响，仍将正常送达」。

**裁决理由**：① 停用语义是「不再新增」，不是「撤回过去」；② 用户已付钱；③ 在一个「一键」动作里批量发起退款是本仓最危险的形状（部分成功 + 重试 = 资金事故）。真正需要撤的场景走既有的 `force_refund` 逐单审批。
> 存量 `pending_pay` 由既有 T3 超时自动取消 cron 收口，**不新增逻辑**（ADR §3.3）。

#### N1-AC-07（P0）「已截单未送达」时停用 —— 强制继续履约，运营无权撤回

> **When** 停用发生在 **T-1 24:00 之后**，订单处于 `cut_off`/`cooked`/`delivering`/`delivered`，
> **then** 系统 **必须**：不改订单状态 · 出餐/配送/送达/自动确认照常 · **必须** 拒绝任何形式的「通过停用撤回」。

理由：截单意味着供应商已按份数采购备货，钱货承诺已成立。此阶段撤回是让供应商和用户承担损失而运营零成本，权责不对等。
> ✓ 本条在 ADR 设计下**天然成立**（停用从不碰订单），保留它是为了防止后续有人「顺手」加批量取消。

#### N1-AC-08（P0）60008：不得把楼挂进已停用的楼群

> **When** 通过 `createBuilding()`（新建带 `buildingGroupId`）／`assignMembers()`（含 `updateGroup`
> 的 `buildingIds`）／`updateBuilding()` 的 `buildingGroupId` 分支
> 把楼宇挂进一个 `status = SUSPENDED` 的楼群，**then** 系统 **必须** 返回 `60008`，且不落库。

**为什么必须有这条**（ADR §1.3，QA 已回源证实）：`BUILDING_GROUP_NOT_EMPTY`（60003）本该保证「能停用的楼群成员必为 0」，但**三条旁路打破这个不变量**，且它们走的是运营最高频的动作（新建 / 搬楼 / 改归群）。不堵住，`group_suspended` 分支就会由不可达变成常态。

⚠️ **2026-10-26 更新：两条 ⇒ 三条。** 后端在落 N4 时发现第三条 —— `createBuilding()`
（`POST /admin/buildings` 带 `buildingGroupId`）原来只做存在性校验，**不查目标楼群状态**
⇒ 可以把楼**新建**进一个已停用楼群。ADR §1.3 与本文档当时都只锚了两条 ⇒ **这条旁路一度没人守**。

⇒ 落点（三条写路径共用唯一准入，QA 自己 grep）：

| 路径 | 方法 | `assertGroupOpen(` 调用点 |
|---|---|---|
| 新建带归群 | `createBuilding` `:712` | `:722` |
| 编辑归群 | `updateBuilding` `:762` | `:810` |
| 批量搬楼 | `assignMembers` `:1490` | `:1499` |

判据在 `groupGate()` `:1583`，抛码在 `assertGroupOpen()` `:1595`（全仓 60008 抛点 **1 处**：`:1601`）。

#### N1-AC-09（P1）10004 的语义回归（对应 §0.6 异议 1）

> **When** 楼宇存在但未归群，**then** 系统 **必须** 返回 `60010`（reason=`building_not_grouped`），
> **不得** 再返回 `10004`；同时 `apps/miniprogram/src/api/request.ts:36-41` 的注释 **必须** 同步修订。

---

### A.2 N2 · 停用前的未完结订单拦截

> ⚠️ **本节的判定是两级流水，顺序不可颠倒**（用户拍板口径，ADR D-N2-4/D-N2-5）：
> ```
> ① 先算 A 组 count（cut_off/cooked/delivering/delivered）
>      A > 0  ⇒  一律 60012。无视 N、无视 force、无视 OperationRequest。硬约束，不可配置。
>      A = 0  ⇒  进入 ②
> ② 再按 N（未完结总数 = A + B）分级
>      N = 0          ⇒ 放行
>      1 ≤ N ≤ 阈值   ⇒ 60006/60007 硬拦（带 force + reason 可放行）
>      N > 阈值       ⇒ 60011（force 也无效，走 OperationRequest）
> ```
> **两条分支必须分开断言，不得合并成一个 case。**⇒ B2-12 / B2-13。

#### N2-AC-01（P0）楼宇停用硬拦 + 完整影响摘要

> **When** `PUT /admin/buildings/:id` 且 `dto.status ≠ ACTIVE`，**且** A 组 = 0 且 `1 ≤ N ≤ 阈值`，**且**未传 `forceSuspend`，
> **then** 系统 **必须** 返回 HTTP 200 + `code = 60006`，`ab_building.status` **必须** 保持原值（零副作用），
> payload **必须** 含 `unfinishedCount` / `groupA` / `groupB` / `earliestMealDate` / `samples[{orderNo, mealDate, status}]` / `threshold` / `hint`。

> `groupA` / `groupB` 必须**显式分别下发**（不只是一个总数）—— 运营要据此判断该找谁（配送 vs 退款审批）。

#### N2-AC-02（P0）查询维度：楼宇查 `building_id`，楼群查 `building_group_id`

> **When** 楼宇停用 → 查 `ab_order.building_id = :id`（命中现成索引 `idx_order_building_meal`）。
> **When** 楼群停用 → 查 `ab_order.building_group_id = :gid`，**刻意不是**「当前成员楼 id 集合」。

**为什么（ADR D-N2-2，QA 认同）**：60003 要求清空成员楼才能停用，等真能停用时名单已空，查出来 0 是**假绿**；而历史订单的 `building_group_id` 是**快照**，楼搬走后旧单仍指向旧群 —— 只有按 gid 查才抓得到「人已走、债还在」的单。

#### N2-AC-03（P0）8 态全覆盖 —— 含 `refund_applying` / `refunding`

> **Where** 订单状态为 `refund_applying` 或 `refunding`，**then** 该单 **必须** 计入 `unfinishedCount`（归入 **B 组**），且停用 **必须** 仍返回 60006。

**这是本批头号沉默逻辑错误防线**：用 6 态白名单的实现会「不报错、不崩溃、悄悄少拦两单，e2e 全绿」。⇒ **B2-2 / B2-3 必须固化为 jest，不许只手工跑一次。**

#### N2-AC-04（P0）时间边界 `mealDate >= todayBj()`

> **When** 存在一笔**历史**脏单（如卡在 `paid` 从未推进到终态，`mealDate` 早于今天），
> **then** 该单 **必须不计入** `unfinishedCount`，停用 **必须** 放行。

理由：不限定的话，一笔历史脏单会**永久锁死**这栋楼的停用能力，而运营没权限修它，最后只能找技术改库 —— 等于把所有人都逼回绕过闸门的那条路。
> `hint` 要带 `earliestMealDate`，让运营自己判断是正常履约还是历史脏单。
>
> ⚠️ **这条现在是唯一的反死锁机制，必须守住**：A 组的限制没有任何逃生口（force 与 OperationRequest 都无效），
> 一旦时间边界失效，一笔卡在 `cooked`/`delivered` 的历史单会让这栋楼**永久无法停用且无任何出口**。
> ⇒ S-N2-3 + B2-4 属本批必过项。

#### N2-AC-05（P0）A 组硬约束：60012 优先于一切

> **When** 存在任一 A 组订单（`cut_off` / `cooked` / `delivering` / `delivered`，且在时间边界内），
> **then** 系统 **必须** 返回 `60012`，且 payload 必须含 `groupA: { count, orderNos }` 与「请到订单管理页逐单走退款审批」的 hint；
> **`forceSuspend` 不得生效、强制走退款不得生效、`OperationRequest` 不得绕过**：`ab_building.status` **必须**保持原值。

理由（用户拍板）：供应商已按份数采购备货，此阶段撤回让用户和供应商承担损失而运营零成本，权责不对等。

#### N2-AC-06（P0）B 组：继续履约 + 必须通知，禁止批量退款

> **When** 停用放行时存在 B 组订单（`pending_pay` / `paid` / `refund_applying` / `refunding`），
> **then** 系统 **必须**：① 不改订单状态；② **不触发任何批量退款/批量取消**；③ **必须** 通知下单用户；④ 通知失败**不阻断**停用，但**必须**留痕（`ab_operation_log` 带 `notifyFailedCount`）。

> 理由：批量自动退款是最危险的形状（部分成功 + 重试 = 资金事故）。真要撤走既有 `force_refund` 逐单审批。
> 通知异步走 `MessageOrchestratorService.orchestrate()`（`message-orchestrator.service.ts:81`），失败不阻断 —— 不让消息通道抖动卡住停用。
> **不可见的失败比失败本身更糟**，所以失败必须留痕。

#### N2-AC-07（P1）★ B 组内部必须再分两种通知文案

> **Where** B 组订单是 `refund_applying` / `refunding`，**then** 通知文案 **必须** 是「退款流程继续处理」类表述，
> **不得** 套用 `pending_pay` / `paid` 的「你的订单将照常送达」文案。

**这是我对用户拍板口径提出的一条实质性补充（§0.6 异议 4）**：B 组把「待履约」与「退款在途」两种**相反结局**合在一组。
它们的**停用动作**可以一致（都继续推进、都不批量退款），但**用户收到的承诺**必须相反 —— 给一个退款中的用户发「餐会照常送达」是**事实性错误**，且用户会据此不做午饭安排。
⇒ B2-14 断言两类文案不同。

#### N2-AC-08（P0）分级拦截：`forceSuspend` + `suspendReason` ≥ 10 字

> **If** A 组 = 0 且 `1 ≤ N ≤ 阈值` 且显式传 `forceSuspend: true`，**then** 系统 **必须** 要求 `suspendReason` 长度 ≥ `building.suspend_reason_min_length`（缺省 10），
> 满足则放行并完成停用，**并且必须** 在 `ab_operation_log` 产生含 `forceSuspend` / `suspendReason` / `unfinishedCount` 的记录。

#### N2-AC-09（P0）超阈值：60011，`forceSuspend` 也无效

> **When** A 组 = 0 且 `N > 阈值`，**then** 系统 **必须** 返回 `60011 SUSPEND_REQUIRE_APPROVAL`（**即使带 `forceSuspend` 也拒绝**），
> payload **必须** 含 `opCode`，且该 opCode **必须** 能在 `/admin/operation-requests` 提交并走完 approve → execute。

#### N2-AC-10（P0）阈值与环境：必须读 `ab_config`，不得硬编码

> **Where** 存在阈值判定，**then** 系统 **必须** 读 `building.suspend_force_max_count`（缺省 20）与 `building.suspend_reason_min_length`（缺省 10），
> **不得** 出现数字字面量；两键 **必须** 登记进 `config.specs.ts`（新增 `building` 分组）。

⇒ **因此测试用例自己也不能写死 20**：必须先把阈值改成 2，再造 3 单断言 60011 —— 否则将来有人把缺省值改了，用例就会说谎。见 B2-13。

#### N2-AC-11（P1）楼群停用：`60003` 与 `60007` 并存且顺序确定

> **When** 停用楼群，**then** 系统 **必须** 先判成员非空（60003，便宜）再判未完结订单（60007，贵），
> 两个错误码**不得**互相吞掉，payload 形态同 N2-AC-01。

> ⚠️ **同时保留「搬空 + 停用」同一次请求仍放行**（`building-admin.service.ts:958-979` 的顺序要求）。这是最容易顺手踩坏的一处，见 B0-6。

#### N2-AC-12（P0）状态机不得被冻结（本批最容易踩的隐性回归）

> **While** 楼宇或楼群处于停用状态，**then** 未完结订单的**状态机推进必须照常**：
> 尤其 `delivered → completed`（T 日 14:00 自动确认）**必须** 执行，**佣金必须照常入账**。

> 一旦被冻结就是**隐性欠薪事故**：团长干完了活、佣金卡在半路，且列表上看不出原因。
> ⇒ B2-15（ADR §8 第 10 步，QA 已升格为必过）。

#### N2-AC-13（P0）前端 `forceSuspend` 不得默认为 true

> **Where** admin-web 的停用确认弹窗，**then** `forceSuspend` **必须** 默认为未勾选，且需一次**显式交互**。
> 若前端默认写成 `true`，上述所有闸门都是装饰性的。

> 由 B2-9 从前端侧验证（这是唯一一条静态与后端都够不到的地方）。

---

### A.3 W1 · 一键停售（净新增 · 独立表）

#### W1-AC-01（P0）落独立表 `ab_sales_pause`，不落 `ab_config`

> **Where** 停售状态存储在系统中，**then** 它 **必须** 落在 `ab_sales_pause` 表
> （列 `meal_date_from` / `meal_date_to` / `reason` / `created_by` / `resumed_at` / `resumed_by`），
> **必须** 由 `OrderAvailabilityService` **直读 DB、不走任何缓存**，
> **并且不得** 在 `config.specs.ts` 登记任何键。

**（v1.0 此处错误，已推翻）** QA 回源确认 `biz-config.service.ts:41` `ttlMs = 60_000`，且 `ensureLoaded()` 的 catch 分支是「沿用旧值/回落缺省 + 仅告警」= **静默 fail-open**。走 `ab_config` 会同时引入两个致命性质：① 最长 60 秒继续放单；② 首次载入失败时悄悄回落「未停售」。**对停售开关而言两个方向都是错的。**

**机械判定**：写停售之后**立刻**（不等待、不 sleep）调 U1/U6，必须已被拒。见 B3-2 / B3-9。

#### W1-AC-02（P0）命中判据与「停售明日」的退化形态

> **Where** 出餐日 d 满足 `meal_date_from <= d AND meal_date_to >= d AND resumed_at IS NULL`，**then** 必须 `sales_paused`。
> **Where** 「停售明日」，**then** 必须是 `[tomorrow, tomorrow]` 区间的**退化形态**，**不得** 存在第二个开关字段/第二套语义。

> 允许存在多条生效且**重叠**的记录（「停售明天」+「停售下周一」各自独立恢复），**不做**区间合并/拆分算法。⇒ B3-5。

#### W1-AC-03（P0）优先级：`sales_paused` 严格第一

> **When** 停售与任何其它阻断原因同时成立，**then** 系统 **必须** 返回 `reason = 'sales_paused'`，U6 **必须** 返回 `60009`（**不是** `60010`、**不是** `30001`）。

#### W1-AC-04（P0）停售后禁止新增下单

> **While** 停售生效，**then** 任何用户 U6 **必须** 返回 `60009`，`ab_order` **必须** 零新增；U1 **必须** `canOrder=false`。

#### W1-AC-05（P0）对已存在订单零影响

> **While** 停售生效，**then** 系统 **必须**：不自动取消/退款任何订单 · 不影响任何状态机推进（含三条退款态与 `delivered→completed`）· 不影响佣金结算 · 不影响已有 `force_refund`/`manual_adjust` 执行 · **不阻塞套餐编排**（D2 上架照常）。

> **但必须给运营可见性**：停售接口响应**必须**一并返回「存量未完结订单」摘要（复用 N2 那次查询），提示逐单处理。**不返回摘要的停售 = 让运营对着空气做决定。** ⇒ B3-7。

#### W1-AC-06（P0）留痕与可观测

> **When** 停售/恢复（任一方向），**then** 系统 **必须** 产生带 `created_by` / `reason` / `resumed_by` 的记录（`@OperationLog`），
> **并且必须** 存在只读端点供运营随时确认当前状态 —— **否则运营会忘记自己开着**，这是这类开关最常见的死法。

> `reason` 在 DTO 里 **必须强制必填**（`@MinLength(4)`），且 **必须**拼进用户端文案下发 —— 用户被拒时要看到一句人话而不是「暂停接单」。⇒ B3-8。

#### W1-AC-07（P0）★ 失败策略：**fail-closed**（v1.0 的 fail-open 已推翻）

> **If** 读取 `ab_sales_pause` 发生异常，**then** 下单链路 **必须** 拒绝下单，并记录 `logger.error`；
> **不得** fail-open，**不得** 裸吞异常。

**为什么推翻我 v1.0 的裁决**：v1.0 我引 `check-d3` 的 `N3-2`「`order:create` 不得设 failClosed（可用性优先）」，但那条针对的是**独立基础设施**（Redis）抖动的场景。**ADR 改设计后，停售读的是同一个 DB —— 「缓存独立抖动」这个前提不再存在**：这行查询如果失败了，同一事务里的其它 DB 操作也已经在失败。**此时 fail-open 的表现是「停售开着却继续收单」，失败方向危险。**

> ⚠️ **条件约束（必须写入代码注释，否则将来会踩）**：
> **若将来给 `OrderAvailabilityService` 加任何形式的缓存（ADR §10 第 3 项已把这个可能性摆在桌面上），本裁决立即失效，必须改回 fail-open。**
> 因为一旦有了独立缓存层，「缓存抖动 ≠ DB 故障」重新成立，此时 fail-closed 会把一次缓存抖动变成全站停售。
> ⇒ 静态判据 **S-W1-7** 负责在「出现缓存却又 fail-closed」时变红。这是本文档埋的一颗地雷，专门守这条随时间退化的不变量。

---

## B. 回归场景清单（必须连库跑 · 可脚本化）

> **先建 baseline**：改动前跑一遍 B0 全部场景记录期望值，改动后重跑对比。
> **回归率定义见 `test-discipline.md` §3：任何由绿转红的旧行为计入回归，回归率非零 ⇒ 不算完成。**

### B.0 回归基线（改动前后都必须成立）

| ID | 场景 | 断言 |
|---|---|---|
| B0-1 | `user.service:118` 对 `status=2/3` 的楼 `bindBuilding` | 仍抛 `BUILDING_NOT_FOUND`；**不得**被本批改松 |
| B0-2 | `building.service:73` 选楼列表（1 ACTIVE + 1 SUSPENDED） | 列表只含 ACTIVE，`list.length === 1` |
| B0-3 | 正常下单（楼/群 ACTIVE、未过截单、无停售） | U1 `canOrder=true`；U6 成功；三端恒等 |
| B0-4 | 已过截单 | U1 `canOrder=false`+`reason='cutoff'`；U6 `30001` |
| B0-5 | 楼群非空停用 | 仍返回 `60003`，**不得**被 60007 吞掉 |
| B0-6 | 楼群「搬空 + 停用」同一次请求 | **仍必须放行**（`:962` 的顺序要求），不被新校验破坏 |
| B0-7 | `delivered` 单跑 T 日 14:00 job | 仍走到 `completed` + 佣金入账；**停用/停售不得阻止它** |
| B0-8 | `pending_pay` 单跑 T3 超时 cron | 仍正常自动取消（N1-AC-06 依赖它收口存量单） |

### B.1 N1 场景

| ID | 前置 | 操作 | 断言 |
|---|---|---|---|
| B1-1 | U 绑楼 B(ACTIVE)，B∈G(ACTIVE)，G 有 T+1 active 分配 | 停用 B → U1 | `canOrder=false` `reason='building_suspended'`；`items.length>0` |
| B1-2 | 同上 | U6 下单 | HTTP200 `code=60010`；`ab_order` 零新增 |
| B1-3 | B `status=2` (PREPARING) | U1 + U6 | `canOrder=false` 同 B1-1；`reason='building_preparing'` 且**与 B1-1 逐字不同** |
| B1-4 | 楼群 G `status=2`，成员楼 B 仍 ACTIVE | U1 + U6 | `reason='group_suspended'`；且 **`ab_building.status` 仍为 1**（派生，不写库） |
| B1-5 | B `status=3` **且** G `status=2` | U6 | 单一 `reason='building_suspended'`（优先级 4 > 5）；**不得**返回 reason 数组 |
| B1-6 | B `status=3` | 重登 → `GET /building` | B 不出现在可选列表；U 的 `building_id` **不得**被静默清 0 |
| B1-7 | B `status=3` | 同一秒内串行调 U1 / U6 / 工作台 | 三处布尔**恒等**（三端口径一致性的硬闸） |
| **B1-8** | 楼存在但未归群 | U1 + U6 | **必须** `60010`/`reason='building_not_grouped'`，**不得**再是 `10004`（异议 1） |
| **B1-9** | 已停用楼群 G | 往 G 里挂楼，**三条**路径各测：① `assignMembers`（搬楼）② `updateBuilding(buildingGroupId)`（改归群）③ **`createBuilding`（新建带 `buildingGroupId`）** | **必须** `60008` 且不落库（N1-AC-08） |
| **B1-9-c** ⚠️ 新增 | 已停用楼群 G | **新建**一栋带 `buildingGroupId = G` 的楼（`POST /admin/buildings`） | **必须** `60008` 且不落库 —— ③ 是后端落 N4 时补出来的**第三条旁路**，ADR §1.3 与本表原来都只有两条 ⇒ 它一度**没有任何判据或用例覆盖** |
| **B1-10** | 注入 `ABOX_SHIFT_TO_HOUR=0`（当日 00:00 ⇒ 已过截单、未到开团） | **同一时刻同时**调 `GET /admin/buildings` 与 U1 | ⚠️ **两侧必须同时断言**：`canAssign === true` **且** U1 `canOrder === false` + `reason === 'not_open_yet'`。**只断言 `canAssign === true` 是恒绿的** —— 它在任何时刻都成立，单独跑等于没验（见 §C.3） |

### B.2 N2 场景

| ID | 前置 | 操作 | 断言 |
|---|---|---|---|
| B2-1 | B 有 1 单 `paid`（今日/明日） | `PUT {status:3}` 不带 force | `60006`；`unfinishedCount=1`；samples[0].status='paid'；**DB 中 status 仍为 1** |
| **B2-2** | B 有 8 单：6 态 + `refund_applying` + `refunding` 各 1 | 同上 | **`unfinishedCount = 8`**。这条是裁决 0-A 的守卫：**漏掉 `refund_applying`/`refunding` 中的任何一个，就是这条挂**。**必须固化为 jest** |
| B2-3 | B 有 `completed` / `cancelled` / `refunded` 各 1 | 同上 | `unfinishedCount=0` ⇒ **放行**，status 变 3 |
| **B2-4** | B 有一笔 `mealDate` **早于今天**的卡单（`paid` 未推进） | 同上 | **不计入**，停用放行（N2-AC-04 时间边界，防永久锁死） |
| B2-5 | 群 G 成员楼 A(无单)/B(1 单)，群外楼 C(1 单) | 停 G / 停 A / 停 C | 停 G ⇒ `60007`(N=1，指向 B) · 停 A ⇒ 放行 · 停 C ⇒ `60006`(N=1) |
| **B2-6** | 楼 B 曾被移出群 G，但 G 下仍有 B 的历史未完结单 | 停用空群 G | **必须**被拦（体现「人已走、债还在」；按 gid 查而非成员楼集合） |
| B2-7 | B 有 3 单 `paid` | `PUT {status:3, forceSuspend:true}` | 放行，status=3；`ab_operation_log` 有含 `forceSuspend` 与 `unfinishedCount=3` 的记录 |
| B2-8 | 同上 | `operator` 角色调用 | **必须**被 `@Roles` 拒（`10003`），拿不到逃生能力 |
| **B2-9** | 同上 | 检查 admin-web 停用弹窗的表单默认值 | **`forceSuspend` 默认必须为 `false`/未选中**，且必须有独立确认交互。前端默认 `true` ⇒ 闸门装饰性 ⇒ **P0** |
| **B2-10** | B 有单卡在 `refund_applying` | `PUT {status:3}` 不带 force | 仍 `60006`，且 `hint` **必须**让读者能区分「卡在退款审批」与「待履约」（异议 3） |
| B2-11 | A 组：B 有 1 单已 `cut_off` | `PUT {status:3, forceSuspend:true, suspendReason:'...'}` | **必须 `60012`**，`ab_building.status` 未变，payload 含 `groupA.count=1`（force 不得绕过） |
| **B2-12** | ★ 同一份夹具（1 单 `paid`，`mealDate=<T>`），**补跑 `POST /admin/schedule/cutoff/run {date:<T>}` 推进状态** | 截单**前** VS 截单**后**各调一次停用 | 前 ⇒ **60006**（可 force 放行）；后 ⇒ **60012**（force 也拒）。**断言两组判据分开走**，证明 A/B 归属随订单状态翻转且不能被合并成一个 case。⚠️ **机制已更正，见下方 C.5** |
| **B2-13** | 先把 `building.suspend_force_max_count` 改成 **2**，造 3 单 `paid`，恢复订单后再停用 | `PUT {status:3, forceSuspend:true}` | **必须 `60011`**（force 无效）且 payload 的 `opCode` 可在 `/admin/operation-requests` 走完 approve→execute。⚠️ **用例不许写死 20** |
| **B2-14** | B 组两种：1 单 `pending_pay` 与 1 单 `refunding` 分别触发通知 | 检查 `ab_message` 内容 | 两封**文案必须不同**（分别是「照常送达」与「退款继续处理」类），不得套用同一模板 |
| **B2-15** | 停用含 `delivered` 单的楼，跑 T 日 14:00 job | | `delivered→completed` **必须**发生，**佣金必须入账**；提示此条为状态机不得冻结的守卫（ADR §8 第 10 步，QA 升格为必过） |

### B.3 W1 场景

| ID | 前置 | 操作 | 断言 |
|---|---|---|---|
| B3-1 | 无停售 | U1/U6 | 正常（B0-3 仍绿） |
| **B3-2** | 写停售 `[tomorrow, tomorrow]` | **立刻**（零等待）U1+U6 | U1 `canOrder=false`/`reason='sales_paused'`；U6 `60009`。**不允许任何等待窗口**（60s 缓存回归 guardians） |
| B3-3 | 停售 + 楼 B `status=3` | U6 | **单一** `reason='sales_paused'`，`60009`（**不是** `60010`） |
| B3-4 | 停售 + 已过截单 | U6 | `60009`（**不是** `30001`）—— 优先级严格第一 |
| **B3-5** | 「停售明日」+「停售下周一」两条重叠记录 | 断言 T+1 与下周一都被拒；恢复其中一条 | 另一条**仍生效**，互不干扰（D-W1-2 不做合并/拆分） |
| B3-6 | 停售前造 `paid` 单 → 停售 → 跑到 T 日 14:00 | | 仍走到 `completed` + 佣金入账；**零自动退款记录**（W1-AC-05） |
| **B3-7** | 存在未完结订单时执行停售 | 查停售响应 | **必须**返回存量未完结订单摘要（N/样例），否则运营对着空气做决定 |
| B3-8 | 停售不带 `reason` / reason 长度 < 4 | | **必须** `10001` 拒绝；且用户端被拒文案**含**运营填的原因 |
| B3-9 | 恢复（`resume`） | 立刻 U1 | `canOrder` 回到 true（不与版本 60s 延迟） |
| **B3-10** | mock `ab_sales_pause` 查询抛异常 | U6 | **必须拒绝下单**（fail-closed）+ `logger.error`（对应 S-W1-7 的反向自证） |

### B.4 ★ 并发与跨日场景（本轮重点新增 —— **全部必须连库**）

| ID | 场景 | 断言（**用不变量断言，不用期望具体时序**） |
|---|---|---|
| **B4-1** | 支付中 + 运营点停用（≥50 轮） | 不存在「订单 paid 成功但楼已 SUSPENDED 且用户无任何通知」的中间态。要么停用被 N2 拦（因为有单）保持可下单性，要么订单先成功并按 N1-AC-06 通知。**二者之一必须成立，不得出现第三态** |
| **B4-2** | 停用后支付回调到达 | 回调**必须**正常推进到 `paid` 并计入未完结（不得丢弃/退款项），随后按 N1-AC-06 履约 |
| **B4-3** | 跨零点下单（**补跑 `cutoff` 推进，非时钟注入**，见 C.5） | T 日 00:01 的下单目标已是 T+1 ⇒ 仍**必须**被 `60010` 拦；同时 T 日 00:00 那批单**必须**照常 `cut_off`，不得因停用跳过 |
| **B4-4** | 停用后「已支付未截单」订单跑完截单 job（补跑 `cutoff` → `delivery-generate` → `auto-confirm`，均带显式 `date`） | 仍走到 `cut_off→cooked→delivered`；不得自动取消；`ab_meal_assignment.sold_count` 不受停用反向影响 |
| **B4-5** | 先停成员楼 B（force），再停群 G | 第二次**必须**仍被 N2 拦（B 属 G 且可能有单）；若 G 内成员均已单独停用且无单 ⇒ 允许停 G。**60003 与 60007 并存不冲突，须给出不同错误码** |
| **B4-6** | T-1 23:59 开停售，T 日 00:01 关停售（补跑推进，见 C.5） | 00:01 后 `60009` 消失；夜间被截的单不得漏处理 |
| **B4-7** | 停用 → 立刻恢复 → 再下单 | 下单成功；期间历史订单状态未被回滚/重放 |
| **X-1** ★新增 | 管家端两个入口各取一次（Team Lead 指定） | `GET /admin/buildings` 的 `summary.canAssignCount` **===** `GET /admin/buildings/overview` 的 `buildings.canAssignCount`，且**两者都 === 独立查库算出的行数**（`status=1 ∧ building_group_id 非空 ∧ 所属群未停用 ∧ 两侧 `deleted_at IS NULL`）。⚠️ 第三个断言是**独立算一遍** —— 只比两个接口，两边一起错就看不出来 |

> ⚠️ **B4 断言一律写「不变量」而非「期望某个具体时序」** —— 后者会变成 flaky 的 sleep 竞赛。
> 典型形状：B4-1 断言的是**析取式**（「要么停用被拦、要么订单先成功并已通知」二者之一必须成立，
> **不得出现第三态**），而不是「A 一定发生在 B 之前」。

---

## C. 静态自检脚本的判据设计

> 产出：新增 `scripts/check-n1n2-w1-suspend-rules.mjs`，**照抄 `check-d3-withdraw-rules.mjs` 骨架**
> （`stripComments` → `blockOf/transactionBlockOf/methodOf` → `RULES[{id,desc,file,pred,mutate}]` → 自证 → 真检 → exit 0/1/2）。

### ⚠️ 前提铁律

1. **每条判据必须配 `mutate` 自证**（必报的报得出）+ **真文件必通过**（必不报的不报），否则 exit 2。`check-d3` 首轮自证抓出 5 条自身缺陷，务必照做。
2. 一条判据只守**一处表述**；跨多处表述的判定拆成多条单侧判据。
3. **取块必须先剥注释**（`// 3 + 4)` 会让事务块截成 58 字符 ⇒ 判据恒红）。
4. W1 是净新增 ⇒ 其判据在实现前必然不通过。降级按 C.4 处理。

### C.1 静态判据清单

| ID | 检查什么 | 命中什么算红 | mutate 自证 |
|---|---|---|---|
| **S-N1-1** | `common/utils/orderability.ts` 存在且导出 `evaluateOrderability` | 缺失 | 删掉导出 ⇒ 红 |
| **S-N1-2** | 纯函数**零 IO**：体内不得出现 `await` / `Repository` / `new Date(` | 命中任一 | 加回一句 `await repo.find()` ⇒ 红 |
| **S-N1-3** | `meal.service` / `order.service` / `workbench.service` **三处都调用**编排层 | 任一未出现调用 | 把某处调用改回内联 ⇒ 红 |
| **S-N1-3b** | ★ **函数级边界**：`building-admin.service` **只得**调用 `evaluateStructure`，**不得**调用 `evaluateAvailability` / `order-availability.service` | 命中后者 | 把管家端改调用户端函数 ⇒ 红 |
| **S-N1-4** | 三者各自方法体内**不得**再内联 `status === BuildingStatus.ACTIVE &&` 合取 | 命中正则 | 加回内联合取 ⇒ 红 |
| **S-N1-5** | `REASON_TEXT` 必须是 `Record<...>` **查表**，predicate 体内不得出现嵌套三元 | 出现 `? ... ? ... :` 的多层嵌套 | 改回嵌套三元 ⇒ 红 |
| **S-N1-6** | PREPARING/SUSPENDED 文案是**两个不同常量**，不得共用 fallback | 两者同名或同串 | 改成同一串 ⇒ 红 |
| **S-N1-7** | `order.service` 内**不得**再出现 `ErrorCode.NOT_FOUND` 承担「楼未归群」语义 | 命中（配合 B1-8） | 改回 `NOT_FOUND` ⇒ 红 |
| **S-N1-8** | 8 条 reason 的**全序常量**（数组/元组）存在，顺序与 ADR §2.3 一致 | 顺序不符或缺失 | 调换相邻两项 ⇒ 红 |
| **S-N1-9** ⚠️ 已拆两条 | `createBuilding` / `updateBuilding` 归群分支 / `assignMembers` **三条**写路径**各自**调用唯一准入 `assertGroupOpen(`；且全仓 60008 抛点 **== 1**、落在 `assertGroupOpen` 内 | 任一路径未调用 ／ 抛点 ≠ 1 ／ 抛点不在唯一准入内 | ① 抽掉 `assignMembers` 的闸门调用 ⇒ **N1-9-a** 红 ② 把抛点复制一份到 `createBuilding` ⇒ **N1-9-b** 红 |
| **S-N2-1** | ★ 停用统计块内**不得**硬编码 `OrderStatus.X` 字面量 | 命中任一 | 把反算改写成硬编码数组 ⇒ 红 |
| **S-N2-2** | 必须**引用** `ORDER_TERMINAL_STATUS`（证明是黑名单反算） | 未出现 | 换成别的写法 ⇒ 红 |
| **S-N2-3** | 时间边界必须出现 `todayBj()`（**A 组唯一的反死锁机制**） | 未出现 | 删掉边界 ⇒ 红 |
| **S-N2-8** | ★ 两个组必须是**从常量派生**的显式分组（A/B），不得在判定里写 `if (status === 'cut_off' || ...)` 长串字面或 | 命中 `\|\|` 串联 ≥ 3 个 `OrderStatus.` | 改回长串或 ⇒ 红 |
| **S-N2-9** | **60012 判定必须优先于 force 与分级**（不得被后两者绕过） | 60012 判定出现在 force 分支之后 | 调换顺序 ⇒ 红 |
| **S-N2-10** | 阈值必须读 `building.suspend_force_max_count`，不得硬编码 | 出现 `/>\s*\d+\s*\)/` 形式的阈值比较或未出现该键 | 改成字面量 ⇒ 红 |
| **S-N2-11** | 两个 `building.*` 键必须登记进 `config.specs.ts` 且 `wiring: 'live'` | 缺失或非 live | 删掉键 ⇒ 红（照抄 `D3-1`） |
| **S-N2-12** | `BizConfigService` 必须有对应 reader 且缺省值正确（20 / 10） | 缺失或默认值错 | 改默认值 ⇒ 红（照抄 `D3-2`） |
| **S-N2-4** | 停用统计与写入**同事务** | 事务块内不含统计调用 | 移出事务 ⇒ 红 |
| **S-N2-5** | `forceSuspend` 在 DTO 里**必须声明**（否则 `forbidNonWhitelisted` 拒 10001） | 两个 DTO 任一缺声明 | 删掉声明 ⇒ 红 |
| **S-N2-6** | 停用方法**必须**挂 `@OperationLog` | 缺失 | 删掉装饰器 ⇒ 红 |
| **S-N2-7** | 60003 判定**必须**在 60007 判定**之前**（先便宜后贵） | 顺序相反 | 调换 ⇒ 红 |
| **S-W1-1** | `SalesPause` 实体存在且列名显式 `meal_date_from` / `meal_date_to` / `created_by` / `resumed_at` / `resumed_by` | 任一列名缺显式 `name:` | 去掉 `name:` ⇒ 红 |
| **S-W1-2** | `ALL_ENTITIES` 含 `SalesPause`，且文件头「表数」注释同步 33→34 | 缺失或计数不符 | 去掉登记 ⇒ 红 |
| **S-W1-3** | 存在迁移 `1700000000019-sales-pause.ts`，且实体索引 `idx_sales_pause_range` 与迁移同名 | 缺失或不同名 | 改名 ⇒ 红 |
| **S-W1-4** | `config.specs.ts` **不得**出现任何**停售**键（防有人把 config 路线加回来）。⚠️ 与 S-N2-11 互补：`building.*` 阈值键**必须**登记，停售键**必须**不登记 —— 只防后者 | 命中 `sales_pause` / `stop_sale` | 加回一个停售键 ⇒ 红 |
| **S-W1-5** | `OrderAvailabilityService` 内**不得**出现任何缓存（直读 DB） | 命中 `cache` / `ttl` / `memo` | 加回一处缓存 ⇒ 红 |
| **S-W1-6** | 停售/停售读取路径**严禁**自动化批量取消/退款标识符 | 命中 `forceRefund` / `bulkCancel` / `autoRefund` | 加回一句 ⇒ 红 |
| **S-W1-7** | ★ **条件护栏**：若 `OrderAvailabilityService` 出现缓存（违反 S-W1-5），则**必须**同时存在 fail-open 处理；有缓存无 fail-open ⇒ 红（守 W1-AC-07 那条会随时间退化的不变量） | 有缓存且无 fail-open | 加缓存但不加 fail-open ⇒ 红 |
| **S-W1-8** | `sales_paused` 在 reason 全序常量中**必须**是第 1 位 | 非首位 | 挪到后面 ⇒ 红 |
| **S-ERR-1** | 5 个新码 60006–60010 在 enum **与** `ERROR_MESSAGE` **两处**登记 | 单侧登记 | 删掉 ERROR_MESSAGE 那行 ⇒ 红 |

#### C.1.1 ⚠️ ID 口径说明（避免「文档写着 S-N1-2、脚本里叫 N1-2」的静默漂移）

脚本内判据 ID 用 **`N1-x` / `N2-x` / `W1-x` / `ERR-x` / `DOC-x`**（无 `S-` 前缀），本表用 `S-N1-x`。
**两者一一对应，去掉 `S-` 前缀即脚本 ID**。原因是脚本照抄 `check-d3-withdraw-rules.mjs`，其 ID 无前缀；
本表当初按「静态判据」语义加了 `S-`。**不再互相改名**（改名会同时破坏脚本输出与本文档引用），
在此显式登记映射关系。

#### C.1.2 v2.2 增补判据（改名巡检 + 编排层收口 · 全部已落脚本）

> 缘起：Team Lead / 架构师在「`canOrder` → `canAssign` 改名」巡检中挖出 `building-admin.service.ts:438`
> 的 `canOrderCount` 是**第三份判据**（既不消费 `:218` 那个字段，也不调纯函数，而是自己内联合取）。
> 以下 7 条把这个面封死。

| ID（脚本） | 检查什么 | 命中什么算红 | mutate 自证 | 真检现状 |
|---|---|---|---|---|
| **N1-13**（重写） | `resolveGroup()` **函数体**内三处出口各归各位：`USER_BUILDING_UNBOUND`(20016) + 文案含「选好即可下单」· `BUILDING_NOT_GROUPED`(60011) · **无** `NOT_FOUND`；`resolveLeader()` 内 `LEADER_NOT_FOUND` + 「未绑定团长，请通过团长邀请链接进入」**必须原样保留** | 任一不合 | **只改文案不改码**（把 `USER_BUILDING_UNBOUND` 换回 `NOT_FOUND` 但保留新文案）⇒ 红 | ✘ 红（P3-4 未做） |
| **N1-14** | ★ 编排层 `buildingRepo` / `groupRepo` 每次 `findOne` **必须**带 `deletedAt: IsNull()` | 任一处漏带；**或一次都没查**（`every()` 对空数组恒真 ⇒ 显式判红） | 摘掉 group 那处过滤 ⇒ 红 | ✔ 绿 |
| **N1-15** | 编排层**只许**调 `reasonText()`：`reasonTextOf` / `toBjIso` / `REASON_TEXT[` 命中数 **0**；且**反向**要求 `reasonText(` 命中 ≥1（防「把出口删掉也算过」） | 任一不合 | 换成 `REASON_TEXT[x] ?? reasonTextOf(` ⇒ 红 | ✔ 绿 |
| **N1-16** | ★「楼状态 ∧ 已归群」的**内联合取**在 `building-admin.service.ts` 内命中数必须为 **0**（唯一持有者 = `evaluateStructure()` / `canAssignOf()`） | 命中 ≥1 | 把内联合取写回 `canAssignOf()` ⇒ 红 | ✔ 绿（backend 已收口 438） |
| **N1-17** | 管家端类型**不得**再用 `canOrder`（已改名 `canAssign`）：`apps/admin-web/src/api/building.ts` **剥注释后**命中 0，且 `canAssign` 命中 ≥1 | 命中 `canOrder` | 全局换回 `canOrder` ⇒ 红 | ✔ 绿 |
| **N1-18** | Swagger / 接口规范**不得**再把管家端字段**定义**成 `canOrder`：`` `canOrder` = `` 与 `**D13 `canOrder`**` 命中 0；且**反向**要求 `` `canAssign` = `` 与 `**D13 `canAssign`**` 各命中 ≥1 | 任一不合 | 把 Swagger 定义行改回 `` `canOrder` = `` ⇒ 红 | ✘ 红（`docs/ABox一盒接口规范v1.0.md:1084` 未同步） |
| **DOC-1** | ★ **反向判据**：`docs/ABox一盒深度测试第二轮报告v1.0.md` **必须**保留 `canOrder=true`（第 74 行 F4 的实测记录） | **不含** `canOrder=true` ⇒ 红 | 全局替换成 `canAssign=true` ⇒ 红 | ✔ 绿 |
| **N1-19** | ★ 模板里访问改名后的字段**必须**走 `asRow()` 收窄（`el-table` 插槽的 `row` 是 `DefaultRow`，属性访问**逃逸类型检查**） | 出现未收窄的 `row.canAssign`，或收窄后的访问被删掉 | 退回 `row.canAssign` ⇒ 红 | ✔ 绿 |
| **N2-13**（新增 · P3-5 后） | ★ `suspend-gate.ts` 必须是**纯决策模块**：零时钟 / 零 `Repository` / 零配置读取 / 零字数校验 | 命中任一 | 塞回一行 `Date.now()` ⇒ 红 | ✔ 绿 |

##### ⚠️ N1-19 的**范围边界**（刻意收窄，别扩）

全仓 `.vue` 里有 **20+ 处**未收窄的 `row.xxx`（`delivery-map.vue` 一处就有 10 处）。
若把判据写成「所有 `row.` 都必须走 `asRow()`」⇒ **恒红**，逼着执行者去改造一批与本次无关的老代码 ——
那是**把范围蔓延包装成严谨**。⇒ 本条只守**本次改名那个字段**的访问形状。

✅ **反向对照已实测**（架构师要的「命中数 0 → 2」）：把 `BuildingRow.canAssign` 改名后跑 `vue-tsc`，
tsc 报出 `leader-binding.vue(105,37)` 与 `(106,27)` 两条 `TS2551` —— 说明前端落 `asRow()` 之后，
**类型系统盯得住这两处了**。（变异已还原，`cmp` 逐字节一致。）

##### ⚠️ v2.3 探针重定向（P3-5 落地后）—— 本批第三次「产物进步导致探针失配」

| 判据 | 原探针 | 新探针 | 为什么 |
|---|---|---|---|
| **N2-1** | `building-admin.service.ts` 里找 `countUnfinishedOrders` 块 | `suspend-gate.ts` 的 `isUnfinished()` **函数体** | 谓词抽成纯函数了。⚠️ 仍需取函数体：文件里 `ORDER_FULFILLING_STATUS` / `ORDER_RELEASABLE_STATUS` 两个 A/B 分组常量**本来就含** `OrderStatus.X`（那是 N2-8 要的显式分组），全文匹配 ⇒ 恒红 |
| **N2-2** | `building-admin.service.ts` 全文找 `ORDER_TERMINAL_STATUS` | `suspend-gate.ts` 的 `isUnfinished()` 函数体 | 同上。⚠️ 文件头注释里就写着「禁止硬编码未完结清单」，全文匹配 ⇒ 只写注释也判绿 |

⇒ **这三次的共同形状**：`blockOf` 泛型返回类型 / `ORDER_TERMINAL_STATUS` 落 shared-types /
谓词抽成 `suspend-gate.ts`。三次都是**产物往更好的方向走，探针没跟上**。

##### ⚠️ 第 4、5 次同类（v2.5 补记）—— 这一族已经成了本批的头号风险

| # | 判据 | 产物往好里改了什么 | 探针为什么瞎 |
|---|---|---|---|
| 4 | **N2-3** | 后端又加了 3 处正确的时间边界 `todayBj()` | 判据是**存在性**（≥1），而 `mutate` 用 `replace` **只删第一处** ⇒ 删 1 剩 3 ⇒ 判据对破化完全不敏感。**产物越正确，判据越假** |
| 5 | **N1-9** | 后端把 60008 判据抽成 `groupGate()`（自称「N4 判据 · 全仓唯一」）+ 统一准入 `assertGroupOpen()`，**三条写路径共用** —— 这正是 N1 要治的病被治好了 | 旧判据要求 `assignMembers` / `updateBuilding` **各自函数体内**出现 `BUILDING_GROUP_SUSPENDED_REJECT` ⇒ 收敛后不再内联 ⇒ 判红，而产物是**变好了** |

⇒ **N1-9 这条最值得记：判红会引导执行者去改一份更正确的代码。**
新判据不再要求「各路径内联抛码」，而是要求**收敛**：
① `groupGate` 存在 · ② `assertGroupOpen` 存在 · ③ 三条写路径都调它 ·
④ **反向**：`BUILDING_GROUP_SUSPENDED_REJECT` 的抛点**只许**在 `assertGroupOpen` 内
（防散回各调用点 ⇒ 又变成三份表述）。

⚠️ ④ 是关键：只判 ③ 不判 ④ ⇒ 「保留了中央函数、但各路径又各自抛一遍」也算过，
那正是「收敛」这个动作要防的失效形状。

⇒ 已上升为纪律：**探针不命中，先怀疑探针。** 判据报红时，第一步是确认探针还在
正确的位置上 —— 而不是拿它去反推产物的缺失。（N1-13 那次我就是反推错了。）

##### ⚠️ 这 7 条里三条「必须剥注释」的反例（全部是自证当场抓出来的）

| 位置 | 注释里写了什么 | 不剥的后果 |
|---|---|---|
| `building-admin.service.ts:173` | 「为什么管家端只调结构层、不调 `evaluateAvailability()`」 | **N1-3b 恒红**，逼执行者删掉一份正确的说明 |
| `order-availability.service.ts:68–72` | 两遍 `deletedAt: IsNull()` 的原理说明 | **N1-14 恒绿**（只写注释不写代码也过） |
| `admin-web/src/api/building.ts:57` | 「与用户端 / 团长端的 `canOrder` **不是同一个语义**」 | **N1-17 恒红**，逼执行者删掉这份防混淆的说明 |
| `building-admin.service.ts:480–484` | 原样抄了一行内联合取做「这是被挖出来的第三份判据」的说明 | **N1-16 恒红** |

> **判词：门禁报假警比不报更伤 —— 因为它会让人下次不信它。**
> 这四处的注释都是**正面 exemplar**（它们在向下一个執行者解释「为什么」），
> 判据若逼人删掉它们，就是在系统地删除项目里最值钱的那部分信息。

##### ⚠️ N1-18 为什么不是「全文禁 `canOrder`」

`building-admin.controller.ts:61` 写着
`与用户端「此刻能否下单」的 `canOrder` 不是同一件事。`
—— 这句话是本次改名**要新增**的正确文档（它解释的正是两个语义的区别）。
一刀切禁 `canOrder` ⇒ 逼人删掉它。故判据精确定位在**「定义」这个动作**上：
`` `canOrder` = ``（Swagger 定义行）与 `**D13 `canOrder`**`（接口规范字段行）。**引用可以留，定义不许留。**

同理，**只扫 `apps/admin-web/src/api/building.ts`，不做全仓扫描**：
用户端 / 团长端的 `canOrder`（「此刻能否下单」）是另一个语义，**必须保留**
（`meal.service.ts` / `orderability.ts` / `miniprogram` 多处），全仓扫描 ⇒ 恒红且误导。

#### C.1.3 v2.4 判据变更（2026-10-26 · 降级 1 条 / 重写 1 条 / 新增 1 条）

| 判据 | 变更 | 为什么 |
|---|---|---|
| **N1-2** | **降级为提示项**（`mode: 'hint'`），不作自证、不计红绿 | 见 **G11 / §C.3.0b**：约束是**行为**（不读环境时钟），静态只能看**字面**。架构师的反例：顶部插一行 `const x = Date.now();`，不动 import、不碰签名，判据照样全绿 —— 而约束已被违反。**宁可不判，不要留一个恒绿的判据。** 真判据在 `test/unit/orderability.spec.ts` |
| **N1-7** | **从「单文件」重写为「全仓按语义扫」** | 见下 §C.1.4 |
| **N1-20** | **新增**：后台两处 `canOrder` **解释性引用**的**存在性 + 内容双重断言** | 见下 §C.1.5 |

##### ⚠️ N1-2 降级时最容易想错的一点

> **它通过了自证，这恰恰是它危险的地方。**

`N1-2` 有 `mutate`，插进去的 `Date.now()` 确实让它变红，所以自证全绿、看起来很可靠。
但自证证明的是「**观察对象**变了会红」，**证明不了「被约束的东西**变了会红」。

⇒ 这两件事不一样，必须分开：
- **C.3.0**（判据必须能证明自己会失败）管前者 ⇒ `N1-2` **过**
- **G11**（判据形态必须与约束形态匹配）管后者 ⇒ `N1-2` **不过**

⇒ 一条判据可以**通过 C.3.0 却违反 G11**。这也是为什么 §C.3.0 与 §C.3.0b 必须**并排**看。

⇒ **降级后也不给它做自证**：给它自证只会重演「插一行 `Date.now()` 它就红」的假象。

##### C.1.4 ⚠️ N1-7：`traceability` 第三条路径 —— **按语义扫，不按文件清单扫**

**缺陷**：`traceability.service.ts:285` 至今仍抛 `10004` + 「所属办公楼未配置楼群」，
是「楼未归群」这个语义的**第三条路径**（`meal` / `order` 已在 P3-4 改为 60011），
而我们 39 条判据**没有一条盯它** —— 因为它不在我们心里那份「涉及到的文件清单」里。

**漏的根因不是懒，是取数方式**：

> 我们都是**先想出一份「已知文件清单」，再去清单里找**。
> 前者只能找到清单里已有的东西 —— **清单外的第三、第四条路径永远找不到。**

而「楼未归群」这种横切语义，天然会散落在任何一处查楼的编排层里，**清单法对它结构性失效**。

⇒ **改法：先 grep 旧文案字面（或语义特征），按命中点列清单，再逐点判；
不要从既有接线点倒推。** 这样即使明天冒出第四条路径，它也会自动进判据。

**判据形态（两次失配后定稿）**：

```
scan: { dir: SRC, needle: 'buildingGroupId', radius: 200 }
pred: ① 受判抛点 ≥ 1（防 [].every() 恒绿）
      ② 每个「以 !x.buildingGroupId 为条件、紧随其后抛异常」的抛点
         必须是 BUILDING_NOT_GROUPED / 60011，且不得出现 NOT_FOUND
```

⚠️ **needle 为什么从「文案字面」改成「条件」**：第一版锚文案（`未配置楼群`），
刚写完后端就把三处抛点的行内文案**全部去掉**了（统一由 `ERROR_MESSAGE` 提供，
这是**更正确**的写法）⇒ 抛点上再无字面 ⇒ 扫到 0 个抛点。
**文案是会变的（收尾批还要再改一次），「判定条件」才是这个语义的稳定锚点。**

⚠️ **收窄到抛点的两层过滤**（缺一层就会误报）：

| 层 | 过滤掉什么 | 不做的后果 |
|---|---|---|
| `!isComment` | `error-code.ts` 两处**解释「为什么不能复用 10004」的说明注释** | 判红 ⇒ 逼人删掉一份正确的说明 |
| 只看 `!x.buildingGroupId` 守卫后的抛点 | `error-code.ts` 的**消息表**、`orderability.ts` 的 `REASON_TEXT` | 误报（它们的正确性由 ERR-2 / N1-5 各守各的） |

实测：全仓 227 处 `buildingGroupId` → 非注释 220 → **受判抛点 3**（`meal` / `order` / `traceability`）。

##### C.1.5 ⚠️ N1-20：为什么「命中数 ≤ 2」是恒绿的

Team Lead 点名的形状：**「后台 `canOrder` 命中数 ≤ 2」这种写法分辨不出三种完全不同的产物状态**：

| 产物状态 | 命中数 | ≤2 判据的答案 |
|---|---|---|
| 两处都在且正确 | 2 | 绿 |
| 注释被人顺手删了 | 0 | **绿** |
| 被全局替换成 `canAssign`（变成「与用户端 canAssign 不是一回事」这种**废话**） | 0 | **绿** |

⇒ **三个不同的状态，判据给出同一个答案。它在判别的东西，不是要守的东西。**

⇒ 正确形态是**三条合取，每条对应一个具体的失效动作**：

| # | 合取 | 防的失效动作 |
|---|---|---|
| ① | `canOrder` **必须存在** | 被删 / 被全局替换 |
| ② | 必须与「用户端」**同现**（±240 字） | 被改成 `canAssign` 后变成废话 |
| ③ | 必须含「**不要全局替换**」警示语 | 注释还在但没讲清**为什么不能动** |

⚠️ **本条刻意不剥注释** —— 与 N1-17 / N1-3b **相反**。
那两条盯的是**代码**，说明注释里的同名符号是噪音（不剥 ⇒ 恒红）；
这一条盯的**就是注释本身**，剥了它就什么都没了 ⇒ 恒绿。
⇒ **「剥不剥注释」不是一个可以全局定的开关，取决于「这一条盯的是代码还是注释」。**

✅ 三条合取**各配一条专项自证**（不合并）：合并成「任意一处不对就红」会盖住
**哪一条合取在起作用**，等哪天有人把某条合取删了，合并版照样绿。
✅ 变异自证已实测：删掉 `building-admin.service.ts:297` 的警示语 ⇒ `N1-20` 由绿转红（`cmp` 已核验还原）。

#### C.1.6 v2.5 新增八条（架构师定 · 编号已顺延，其中两条经查重**不单立**）

| 号 | 判什么 | 现状 |
|---|---|---|
| **N1-23** | `REASON_TEXT.building_not_grouped` 与 `ERROR_MESSAGE[BUILDING_NOT_GROUPED]` **逐字相等** | ✅ 绿（收尾批已统一） |
| **N1-24** | 抛 `BUILDING_NOT_GROUPED` 时**不得传第二参数** | ✅ 绿（受判 4 处全过） |
| ~~N1-25~~ | ~~traceability 不得再出现 `NOT_FOUND`+「未配置楼群」~~ | **不单立 —— 与 N1-7 重复，见下** |
| **N1-26** | 端上兜底：服务端已给 `code` 的那一支必须回落 `.message`，不得硬编码中文 | ✅ 绿（前端在我工作期间改对了） |
| **W1-UI-1** | 停售页不得走 `ab_config` / `bizConfig` 路线 | ✅ 绿 |
| **W1-UI-2** | 小程序停售分支必须判 60009，出现 60010 即红 | ✅ 绿 |
| **W1-UI-3** | `admin/sales-pause/` 写路径不得出现 60006/60007/60012/60013 | ✅ 绿 |
| **W1-UI-4** | 停售态展示分支必须同时给出「已下订单不受影响」 | ✅ 绿 |
| ~~D-N2-4-a~~ | ~~第 1 条三个条件不得 `!x`/`== null`/`=== undefined`~~ | **不单立 —— 补进 N1-10，见下** |
| **D-N2-4-b** | 第 4 条必须仍是 `buildingGroupStatus === BuildingGroupStatus.SUSPENDED` | ✅ 绿（单立） |

**实落 8 条（48 = 40 + 8），不是 10 条。** 两条按下述理由不单立。

##### ⚠️ 查重结论 1：`N1-25` 不单立 —— 与 N1-7 是同一个约束

`N1-7`（全仓扫「以 `!x.buildingGroupId` 为条件、紧随其后抛异常」的抛点必须 60011）
**已经覆盖**了 `traceability` 那一处（实测受判抛点 3 处含它）。
再单立会让同一个问题报两次：**红条数虚高，且将来有人修一处、看到两条红以为有两个问题。**

⇒ 已把 `N1-25` 的语义并入 `N1-7`，并在 `N1-7` 的注释里写明它覆盖了这个面。

##### ⚠️ 查重结论 2：`D-N2-4-a` 不单立，但**不是**同义反复 —— 补进 `N1-10`

Team Lead 让我核它是否与 `N1-10` 重复。**结论：不重复，但也不该单立。**

| | 断言什么 |
|---|---|
| `N1-10` | **正向**：三个 `=== null` 都在 |
| `D-N2-4-a` | **反向**：不得用 `!x` / `== null` / `=== undefined` |

两者是**同一条约束的互补两半**（像 `N1-15` 的「禁 A 且要求 B」）。
单立 ⇒ 「两条判据守同一行代码」的腐烂；补进 ⇒ 一条判据承载一个完整约束。

⇒ **已把反向合取补进 `N1-10`**，不单独编号。

⚠️ **但 Team Lead 给的理由回源后不成立，我把真实的理由换上了**：
> ~~「`status` 是 0 起步的数值枚举，`!x` 会把营业中判成不存在」~~

回源 `packages/shared-types/src/enums/building-admin.ts:26-33`：
`ACTIVE = 1 / PREPARING = 2 / SUSPENDED = 3` —— **不从 0 起步**。

真实的理由是另一条，而且更硬：

> **`!x` 把「null」与「falsy」并成一路，而存在性判定必须只认 `null`。
> 现在它碰巧不出错，是**靠枚举取值侥幸**，不是**靠语义正确**。**

⇒ 一旦枚举加 0 值，或 `buildingGroupId` 出现 0（种子数据 / 迁移回填都可能），
判据**立刻**失效，且失效方式是**静默的 fail-open**：把「不存在」判成「存在」⇒ 放行下单。
⇒ **判据要守的是「存在性只能用 `=== null` 表达」这个写法纪律，
不是「当前枚举取值下结果对不对」。结果对 ≠ 写法对。**

##### ⚠️ 判据实现时踩到的两个新坑（第 5、6 次同类）

| # | 坑 | 形状 |
|---|---|---|
| ① | `blockOf` 不能用于 `computed(` | 它的圆括号配对从 `computed(` 那个 `(` 起算，而箭头函数 `() => {…}` 的 `()` 被当成**嵌套** ⇒ 深度回到 0 时已到文件末尾 ⇒ 取到整段。**`computed(` 的参数是「一个函数」，不是「一个参数列表」** —— `blockOf` 的假设对它不成立 |
| ② | `scanHits` 默认只扫 `.ts` | 端上兜底逻辑**全在 `.vue` 里** ⇒ `N1-26` 首版扫到 0 处。已给扫描型判据加 `ext` 选项显式放开 |

##### ⚠️ `apps/miniprogram/pages/index/index.vue` **不存在**（本批第 4 次路径 grep 不到）

派单里写的路径少了 `src/` 一层。真实路径是 **`apps/miniprogram/src/pages/...`**。
判据一律按真实路径取。⇒ 已立规矩：**派单里的路径/符号，grep 不到就当它是假的来问。**

#### C.1.7 v2.6 本批第二轮：判据形态的四次收窄（2026-10-26 23:20）

**实落 5 条**（`49 = 44 + 5`）：`N1-9-a` / `N1-9-b`（由 `N1-9` 拆出，+1 条）、`W1-UI-5`（新立，+1 条），
外加 `N1-26` 与 `W1-UI-4` 的形态收窄、`N1-12` 由列举式改一般式。

| 号 | 判什么 | 现状 | 变异自证 |
|---|---|---|---|
| **N1-9-a** | 三条写路径各自**调用**唯一准入 `assertGroupOpen(` | ✅ 绿 | 抽掉 `assignMembers` 的闸门 ⇒ 红 ／ 【负控】改一处无关行 ⇒ 绿 |
| **N1-9-b** | 全仓 60008 抛点 **== 1**，且落在 `assertGroupOpen` 内 | ✅ 绿（受判 1） | 把抛点复制一份到 `createBuilding` ⇒ 红 |
| **W1-UI-5** | 端上不得把 U1 的 `daily.reason`（下发的是**中文文案**）当枚举码做字符串比较 | ✅ 绿（受判 1） | `daily.reason === 'sales_paused'` ⇒ 红 ／ 【负控】U11 的 `reason === 'other2'` ⇒ 绿 ／ 【负控】`.trim()` 展示 ⇒ 绿 |
| **N1-26**（改） | 专属分支豁免由「按形状」改成**显式白名单**（只放行 `CODE_BUILDING_UNBOUND`） | ✅ 绿（受判 2） | `err.code === 60011`（裸码值）⇒ 红 ／ `err.code === CODE_BUILDING_NOT_GROUPED`（常量名）⇒ 红 |
| **N1-12**（改） | 由「对 `not_open_yet`/`cutoff` 两键插值」改成**一般式双侧**：带 `{` 的键要插值、空串键要有分支 | ✅ 绿 [REAL] | 删掉 `sales_paused` 的插值分支 ⇒ 红 |
| **N2-TPL-1** ⚠️ 新立 | 停用通知两场景的**文案契约**：fulfill 必须承诺「照常」、refund **不得**出现履约承诺；两者 `variables` 都必须含 `orderNo` | ✅ 绿 [REAL] | 把「照常配送」写进**退款**模板 ⇒ 红 ／ 删掉 fulfill 的「照常」 ⇒ 红 ／ 【负控】refund 的 `note` 里提「照常」字样 ⇒ 绿 |
| **N2-TPL-2** ⚠️ 新立 | 停用通知的**接线方向**：三元真支必须 `building_suspend_refund`、假支必须 `building_suspend_fulfill`，且条件认退款态、两码各出现 1 次 | ✅ 绿 [REAL] | 三元两端对调 ⇒ 红 ／ 两场景合成一个 ⇒ 红 ／ 【负控】加一处无关变量 ⇒ 绿 |

##### ⚠️ `N2-TPL-1/2` 为什么值得立（backend 破化自证出来的**零覆盖缺口**）

他把 `notifySuspendAffected()` 里 `refund_applying / refunding` 的场景名改成
`building_suspend_fulfill` —— 等于给一个**正在退款**的用户发「照常配送」：

> **看板 48 条：一条都不红。jest 115 条：一条都不红。**

而 spec §6.5 `D-N2-3b`「**发错比不发更糟**」是本批最重的用户可感缺陷。
⇒ 分工：**jest（`test/unit/suspend-notify.spec.ts`）守运行时发的是哪一条**；
**本两条守契约面**。两者不是同一件事 ——

> jest 那份锚的是**生产模板**（后端明确要求：别锚测试里另抄的文案）。
> 于是「**模板文案本身被换掉**」这件事，jest 那份**照绿**（它读的就是被换掉后的值）。
> ⇒ 只有静态契约能拦住「改了 `groupContent` 或改了三元方向」这两类。

⚠️ 三条边界（写宽了会误伤）：
| 情形 | 态度 |
|---|---|
| `seed.groupContent` 里的「照常」 | **判**（这是用户真正看到的东西） |
| `note` / 说明注释里的「照常配送」字样 | **不判**（`N2-TPL-1` 的负控样本已证实：说明文字里提到它不影响模板） |
| `variables` 里的 `orderNo` | **必须有**（spec §6.5「运营事后看得到漏的是**谁**」的唯一凭据） |

##### ⚠️ 本批「判据形态」失效的**第四、五种形态**（前三种见 §C.3.0b）

| # | 形态 | 实例 | 怎么发现的 |
|---|---|---|---|
| ④ | **可被规避 · 改注释** | `W1-UI-1/2/3`：执行者把注释里的敏感字面改掉 ⇒ 判据绿 | 前端主动报告 |
| ⑤ | **可被规避 · 改分支形状** | `N1-26`：把硬编码写成 `if (err.code === 60011) return '…'` 这种**专属分支形态** ⇒ 形状豁免放行 | 前端读判据实现时排到的 |

⇒ ④ 有通用解（剥注释），**⑤ 没有通用解**：

> **「这个码用户能不能自己解决」是语义判断，机械判据做不了。**

只剩一条路：**显式白名单 + 每条带理由**，想往里加码的人必须**先把那个问题的答案写出来**
—— 登记动作本身就是那句「要加就先问」。这是 **fail-closed**；形状豁免是 **fail-open**。

⚠️ 白名单**必须按常量名匹配，不能按码值**：按码值匹配 ⇒ 端上写裸数字 `err.code === 20016`
也能绕过，**口子只是换了个位置**（前端提示，已采纳）。

##### ⚠️ 判据形态失配的**第五、六次**：判据扫到了不该扫的东西

| # | 判据 | 失配形状 | 修法 |
|---|---|---|---|
| ⑤ | `W1-UI-4` | 只认中文字面 ⇒ 前端把文案收进常量 `SALES_PAUSED_UNAFFECTED_NOTICE` ⇒ **扫到 0 命中 ⇒ 假红**（而收进常量是**更正确**的写法） | 认**常量名** + 兜底认值里的「不受影响」（不钉死整句，换措辞不该红） |
| ⑥ | `W1-UI-5` | 按变量名 `reason` 扫 ⇒ 误伤 4 处 **U11 自助取消理由**（`reason === 'other'`，端上枚举、**请求入参**、与 U1 **同名不同义**） | 收窄到 **U1 的 `daily.reason`** 这个表达式 |

⇒ **定 needle 时再加一问**（架构师 §14.4 的归纳，本项目照收）：

> **这个 needle 还会命中哪些**合法**的东西？**

命中目标的样本与命中合法项的样本，**都要各造一个** —— 前者验必红、后者验必不红。
只造前一个 ⇒ 判据会把主链路扫红而没人认领，那和恒绿是同一种病（**误伤比恒绿更隐蔽**：
恒绿只是没用；误伤会让有人去改掉那个本来就合法的东西）。

##### ⚠️ `N1-9` 拆两条：**合一条 OR 会漏，合一条 AND 会混**

后端把 60008 抛点从 3 处收到 1 处（三个写路径共用 `assertGroupOpen()`）⇒
旧判据锚「方法体内出现 `BUILDING_GROUP_SUSPENDED_REJECT`」**转红，而产物更对了**。

- 只判 a（三条路径都调闸门）⇒ 「闸门还在、各路径还在调它，但抛码被摊回调用点」照样算过；
- 只判 b（抛点 == 1）⇒ 「抛点只剩一处」也可能只是「另外两条路径压根没接」。

⇒ **两条故障的修法完全不同**（补调用 vs 收抛点），报成一条红 ⇒ 看的人得先自己分辨是哪一半。

##### ⚠️ 一般式判据的「真空侧」必须用 `HELPER_CHECKS` 兜住

`N1-12` 改成一般式后有**双侧**：侧 A（值带 `{` 的键要插值）、侧 B（空串键要有分支）。
**侧 A 当前全仓无此形态** ⇒ 判据自证只跑真文件 ⇒ **真文件跑一万次也证明不了侧 A 存在**。

⇒ 已把两侧抽成具名函数 `reasonTextCoversDynamicKeys()`，侧 A 的射程交给 `HELPER_CHECKS`
里的 3 条专项样本（必红 1 / 必绿 2，含「必须剥注释」那条）。

> **通律：凡是「当前恒真」的那一半，都必须单独造样本证明它「能红」。**
> 否则它就是一条对任何输入都成立的合取 —— 也就是**恒绿**。

##### ⚠️ 行号漂移第 6 次：架构师与 QA 同批 grep 差 7 行

| 符号 | 架构师报的 | QA 复核的 |
|---|---|---|
| `createBuilding` / `updateBuilding` | `:712` / `:762` | 一致 ✅ |
| `assignMembers` | `:1483` | **`:1490`** |
| `groupGate` | `:1576` | **`:1583`** |
| `assertGroupOpen` | `:1588` | **`:1595`** |

取差的那三个**都在文件后半段** ⇒ 是他在文件又长了 7 行之前 grep 的。
⇒ **引用行号前先自己 grep 一遍，别转手。**（已在 §0.5 落地状态里同步更正）

### C.2 ⚠️ 静态**管不到**的 —— 必须连库，禁止写进静态脚本

> **这是本节要点。** 硬写成静态判据，必然做成「恒绿 = 没检查」或「恒红 = 噪音」。

| # | 为什么静态管不到 | 运行时验证 |
|---|---|---|
| **R-1** 并发（停用 ∩ 下单） | 静态只能证明「写在事务内」，证明不了隔离级别真拦得住（`count()` 加不加 `FOR UPDATE`） | B4-1 ≥50 轮不变量断言 |
| **R-2** 跨零点 / 时区 | 自然日边界要跑一遍才知道；用的**对不对**只能跑出来 | B4-3/B4-6 注入时钟 |
| **R-3** 支付回调竞态 | 回调是外部异步事件，代码里根本没有可被扫的「回调入口」 | B4-2 |
| **R-4** 定时任务不被冻结 | job 是否被跳过，取决于运行时 `WHERE` 命中的行 | B0-7 / B0-8 / B4-4 |
| **R-5** `soldCount` 不被反向影响 | 是另一个模块的写入副作用 | B4-4 |
| **R-6** 通知真发出去了 | 依赖消息通道与模板；静态只能证明「调了某个方法名」 | B1-1 / B4-4 断言通知表有记录+正确文案 |
| **R-7** 三端同一时刻一致 | 跨三个服务的组合结果 | B1-7 同一秒串行调用比对 |
| **R-8** 「人已走、债还在」的真实结果集 | SQL 结果集形状，`where` 写对也可能 join 错 | B2-6 |
| **R-9** 停售**立刻**生效（60s 缓存回归） | 「有没有缓存」可以静态扫，「写完立刻可见」只能测 | B3-2 零等待断言 |
| **R-10** 前端 `forceSuspend` 默认值 | 在 admin-web 的 Vue 里，不在受检的后端源文件内 | B2-9（人工/前端侧） |

> **给脚本作者的判词**：**凡是答案取决于「某一刻数据库里有什么」「两个请求谁先到」「用户真的看到了什么」的，都不属于静态脚本。** 写进去等于买个永远亮绿灯的红绿灯。

### C.3 反恒绿自证（针对本批特有的坑）

#### C.3.0 ★ 上位纪律：**判据必须能证明自己会失败**

> 这一条是下面 1–6 条的**上位抽象**。它们看起来是六种不同的技术细节，
> 其实是同一个形状的六个实例。

**任何一个「通过」的结论，都必须先证明这个检查有能力失败。**
没有失败过的检查等于没有检查 —— 它只是在每次运行时输出「通过」二字。

⇒ **判据必须能区分「目标达成了」与「判据没生效」。** 前者是真的通过，后者是假绿，
而**两者的输出常常一模一样**（退出码 0、全绿、0 行输出）—— 这正是它危险的原因。

三种最常见的失效形状：

| # | 失效形状 | 本批的真实实例 |
|---|---|---|
| ① | **判据没生效**（集合空 / 正则失配 / 取数取错） | **`blockOf` 取数失配**：`resolveGroup` 返回类型改成 `Promise<{…}>` 后，`indexOf('{')` 命中的是泛型花括号 ⇒ 取到 79 字符的**函数体空壳** ⇒ 判据安静地返回「不合」，看起来就像产物没做对。**更阴的是它同时制造假绿**：`!NOT_FOUND.test('')` 恒真 |
| ② | **断言恒真**（只断言了在任何情况下都成立的那一侧） | **B1-10 / spec §5.4**：只断言 `canAssign === true` —— 而它在**任何时刻**都成立，单独跑恒绿，等于没验 |
| ③ | **探针跟着产物一起变**（用「改成目标形态后的产物」当必不报样本 ⇒ 自证循环） | **`[SYNTH]` 样本**：`[REAL]` 才是真证据（真实且未改动的原文）；`[SYNTH]` 只证明「必报的报得出」，**不**证明「必不报的不报」 |

对应的四个动作：

- **反向对照**：故意破坏一次，确认它真的变红（静态脚本的 `mutate`；jest 的变异测试；类型检查的「只改 DTO 不改消费方」）
- **样本非空前置**：`X.length > 0`
- **两侧同时断言**：不只断言「应该怎样」，还断言「不该怎样」（或断言两个应当不同的东西**确实不同**）
- **必不报样本必须取真实且未改动的输入**

##### ⚠️ 与 `mutate` 自证机制的关系（别以为脚本有 mutate 就够了）

`scripts/check-n1n2-w1-suspend-rules.mjs` 的 `mutate` 自证，是**这条纪律在静态脚本里的机械实现形态**。
但**纪律本身适用于一切检查形态** —— 类型检查、e2e、jest、手工验证、代码评审，一个都不例外：

| 检查形态 | 反向对照怎么做 |
|---|---|
| 静态判据脚本 | 每条判据配 `mutate`，断言 `pred(mutate(x)) === false` |
| jest 单测 | 变异被测源码，确认**该红的红**（本批：`unfinished-orders.spec.ts` 变异后 11 条 → 6 红 5 绿） |
| 类型检查（改名批次） | **只改手抄 DTO、故意不改消费方**，确认编译器真的报红 |
| e2e / 手工验证 | 先跑一遍「改动前」，确认它**能给出不同结果**，再跑改动后 |

> ⚠️ **「跑通了」不是证据。** 只做最终态的类型检查分不清「消费方都改对了」和「tsc 压根没盯住这段」——
> 两种退出码都是 0。**第 ② 步（反向对照）不是可选项。**

---

以下是这条纪律在本批落成的六个具体形状：

1. **S-N2-1 的正则必须限定方法体**：必须先 `methodOf(stripComments(t), 'countUnfinished')`。`building-admin.service.ts` 全文若直接匹配会误伤 ⇒ **要么恒红**。真文件侧断言是唯一能抓住这个坑的一侧。
2. **S-N1-8 的全序必须比「内容」而非「存在」**：只检查 8 个字符串都在 ⇒ 顺序颠倒也绿。要按索引逐位比对。
3. **S-W1-7 的 pred 必须是条件句**（有缓存 ⇒ 必须有 fail-open），不是简单的「不得有缓存」—— 它与 S-W1-5 互补：本批两者都为绿，但将来有人加缓存时 S-W1-5 变红提醒改裁决，S-W1-7 防止他只加缓存不改失败策略。
4. **★ 空集合必须显式判红**（N1-14 自证时立下的规矩）：`idxs.every(...)` 对空数组**恒为 true**。
   若哪天编排层不再查楼（改成上游传参），判据会**自动恒绿**，而它守的东西已经无从谈起。
   ⇒ **凡是「对每个 X 断言 Y」的判据，必须先断言 `X.length > 0`。**
5. **★ 正则必须覆盖所有书写形态**（N1-16 自证时抓出的盲区）：首版写成 `status\s*===`，
   而 `canAssignOf()` 的形参名是 `buildingStatus`（**大写 S**）⇒ **匹配不上，判据对它完全失明**。
   放开成 `[A-Za-z]*[Ss]tatus` 后才覆盖。⇒ **写「禁止某种写法」的正则时，先列出执行者
   可能写出的所有自然变体，再逐条用 mutate 验一遍 —— 猜漏的那一种就是将来漏网的那一种。**
6. **★ 反向判据也要有**（N1-15 / N1-18 / DOC-1）：只写「禁止 A」⇒ 把 A **删掉**也算过
   （「不做」不等于「做对」）。故每条禁令**尽量配一条正向要求**：
   - N1-15：禁 `reasonTextOf` **且** 要求 `reasonText(` 命中 ≥1
   - N1-18：禁 `` `canOrder` = `` **且** 要求 `` `canAssign` = `` 命中 ≥1
   - DOC-1：整条就是反向的 —— 它禁的是「改历史」
7. **★ 取数范围必须精确到能区分目标与非目标**（本批**四次**踩到，2026-10-26 补）
   取数太宽 ⇒ 误报；误报一多，**人就不会再看它**。四个实例的形状各不相同：
   | # | 实例 | 取数太宽的形状 | 收窄到 |
   |---|---|---|---|
   | ① | `blockOf` | 把返回类型泛型 `Promise<{…}>` 的花括号当成函数体起点 | 先跳过参数列表与返回类型，再认函数体 |
   | ② | `N2-13` | 全文匹配 `OrderStatus.X`，而 A/B 两个常量**本来就含** ⇒ 恒红 | 取 `isUnfinished()` 函数体 |
   | ③ | `N1-19` | 想写「所有 `row.` 都必须走 `asRow()`」，而全仓有 20+ 处无关老代码 ⇒ 恒红 | 只守**本次改名字段**的访问形状 |
   | ④ | `N1-7` | 全仓扫到 7 处，其中 3 处是**说明注释**与**消息表** ⇒ 误报 | 剥注释 + 只留抛点 |
   ⇒ ③ 是最要警惕的：**误报常常穿着「严谨」的外衣**（「把所有情况都管起来」）。
   把范围蔓延包装成严谨，会逼着执行者去改造一批与本次无关的老代码。

   **④ 还有一个更隐蔽的后续（同一天第二次失配）**：收窄到抛点之后，
   我用「字面 ±200 字」当窗口，结果把**上一行一个完全合法的 `NOT_FOUND`**
   （`办公楼 #${id} 不存在`，本就该是 10004）卷了进来 —— 于是我把产物**改对了，
   判据还是红的**。
   ⇒ 补一条：**取数要按结构（语句 / 函数体 / 对象块），不要按距离（±N 字）。
   按距离取，就会把邻居行上的合法代码判成违规。**
   ⇒ 再补一条：**取数方向要跟语义方向一致。**「楼未归群」是**条件在前、
   抛点在后**，只提供「往回扫」就会抓到上一个抛点（又是那个合法的 10004）。
8. **★ 存在性判据的破化必须移除全部命中**（本批第 4 次「产物进步把探针弄瞎」）
   `N2-3` 的判据是「必须出现 `todayBj()`」（**存在性**），而 `mutate` 用
   `t.replace('todayBj()', "''")` —— **只删第一处**。后端后续又加了 3 处正确的时间边界，
   于是删 1 处还剩 3 处 ⇒ 判据对这次破化完全不敏感 ⇒ 自证报「破化后没报错」。
   ⇒ **这一类的狠处在于：产物越正确，判据越假。** 加三处正确的时间边界是纯进步，
   却让守着它的判据失去分辨力。
   ⇒ 通律：**存在性判据（≥1）⇒ `replaceAll`；唯一性判据（==1 / 有序 / 全序）⇒ `replace`。**
   脚本已在自证失败时按三种形态分别打印提示，见 `scripts/check-n1n2-w1-suspend-rules.mjs`。

#### C.3.0b ★ G11：**判据形态必须与约束形态匹配**

> 这条与 C.3.0 是**互补的两条**，必须并排看：
> - **C.3.0 管「它会不会失败」** —— 判据有没有分辨力；
> - **G11 管「它观察的是不是被约束的那个东西」** —— 判据有没有瞄错靶。
>
> 一条判据可以**通过 C.3.0 却违反 G11**：`N1-2` 就是实例 —— 它有 `mutate`、
> 自证全绿、插 `Date.now()` 它确实会红；但它瞄的是**字面**，约束的是**行为**，
> 于是「满足判据」和「满足约束」可以是相反的两件事。

**结构约束可以用静态判据守；行为约束只能用跑得起来的检查守。**

| 约束形态 | 静态判据是否有效 | 例 |
|---|---|---|
| 结构（`import` / 声明 / 字面量 / 字段名） | ✅ 有效 | 「管家端类型不得再出现 `canOrder`」（N1-17） |
| 行为（读时钟 / 运行时求值 / 分组结论 / 并发下的状态） | ❌ 无效 | 「`orderability.ts` 不读时钟」（N1-2 · **已降级**） |

三条判别式（写新判据时逐条自问）：

1. **约束说的是「代码长什么样」还是「运行时做什么」？** 后者 ⇒ 静态判据无效。
2. **能不能构造一个「满足判据但违反约束」的样本？** 能 ⇒ **判据过松**。
   本批实例：架构师在文件顶部插一行 `const x = Date.now();`，**不动任何 import、
   不碰任何签名**，`N1-2` 照样全绿 —— 而约束已被违反。
3. **能不能构造一个「违反判据但满足约束」的样本？** 能 ⇒ **判据过严**。
   本批两个实例：
   - 后台 `canOrder`：若判「全仓禁 `canOrder`」⇒ 会逼执行者删掉两处**正确的解释性引用**
   - `N1-19`：若判「所有 `row.` 都必须走 `asRow()`」⇒ 逼执行者改造 20+ 处无关老代码

⇒ **过严的判据不是更严谨，是会把产物改坏。** 发现过严时，正确动作是**缩小观察范围**
（盯「定义」而非「所有提及」；盯「本次改名字段」而非「所有字段」），不是降低要求。

⚠️ **踩到边界时的处理：宁可不判，不要造一个恒绿的判据。**
本批 `G10`（同步清单里每个符号必须附行号）与 `G12`（ADR 与 spec 不得给出相反结论）
**都刻意不配静态判据** —— 语义一致性判不出，硬做只会得到「两份文档抄同一句话就过」，
而**「抄同一句话」恰恰是要防的漂移之一**。这两条是人工动作，靠 code review。

### C.4 W1 净新增导致的「实现前恒红」处理

```
缺失目标文件/方法 → 打印 `⚠ S-W1-x 未实现，暂不判定`，**不计入 exit 1**
```
⚠️ **与 anti-gaming 的冲突风险**（§3 把「新增 skip」列为可疑）：该降级**必须**① 只降「目标不存在」这一类，不得扩到「存在但不通过」；② 输出 `⚠` 而非 `✔`；③ **Phase 3 结束后必须消失**，由 QA 在测试报告显式核验。

#### C.4.1 ★ 排障纪律：**看到红，先重跑一次**

> 本批真实发生过一次，值得单独立一条规矩 —— 因为它浪费的时间与它的重要性完全不成比例。

**现象**：`N1-8` / `W1-8` 两条判据的自证忽然报红，**重跑一次即绿**。

**根因**：**门禁读到了并发写入中途的文件。**
`orderability.ts` 的 mtime 是 `21:00:13`，那一次 `git diff` 甚至能看见写了一半的片段
（还夹着一行忘了删的 `const __leaked = Date.now();`）。
判据脚本是 `readFileSync` 直读磁盘，后端落盘与门禁读数之间**没有任何同步点**。

**处置**：

1. **先原样重跑一次** `node scripts/check-n1n2-w1-suspend-rules.mjs`。5 秒的事。
2. 重跑即绿 ⇒ **不是判据的问题，也不是产物的问题**，是时序问题。不需要改任何东西。
3. **持续报红** ⇒ 才是判据或产物的问题，再看输出里那三行分类提示。

⚠️ **失效方向是对的，不要为了「让它绿」去改判据。**
它 fail-closed（宁可报红也不放错），这个方向必须保留 —— 门禁宁可误报一次让人重跑，
也不能在落盘中途悄悄放行。⇒ 要改的是**人的第一反应**，不是脚本。

脚本侧已加两处提示（自证失败时打印）：

```
✘ N1-8 自证失败 · good通过=false · 破化生效=true · 破化后报错=true
   ⚠️ 若本条为偶发（重跑即绿）：门禁可能读到了并发写入中途的文件 —— 先跑一次
      `node scripts/check-n1n2-w1-suspend-rules.mjs` 确认；确实持续报红才是判据或产物的问题。
```

> ⇒ **CI 上若出现偶发的自证失败，第一嫌疑是并发写入，不是判据。**
> 判据每日都被同一批文件跑几十次，若它真的坏了，不会只坏一次。

#### C.4.2 ⚠️ 判据脚本**不依赖行号** —— 但注释里的行号会过期

架构师 2026-10-26 给出一张 12 处行号漂移对照表（`meal :269→281`、
`order :1628→1693`、`building-admin :218/325/623/701→259/370/680/774` 等），
提醒我核一遍脚本里写死的行号。**已回源核过，结论分两层**：

| 层 | 结论 |
|---|---|
| **判据逻辑** | ✅ **一条都不依赖行号**。全部 40 条判据都按「符号 / 字面 / 函数名 / 语义扫描」取数，行号漂移**不影响红绿** |
| **注释里的行号** | ⚠️ 有 7 处，已按漂移表更新；它们只是说明，不参与判定 |

⇒ **这条要立成规矩：判据里禁止出现行号。**
行号会随任何一次上游插入而漂移；而漂移后判据若**判红**，执行者会去改一份正确的代码；
若**照样绿**，它就只是在判别的东西 —— 后者更麻烦，**恒绿的判据等于没有判据**。
按符号 / 语义取数，行号只写在注释里当路标。

### C.5 ⚠️ 回源更正：**时钟注入只能落整点、且不能改变日历日**

> 这是 **QA 自己的静默漂移**：v2.1 把这三条写成「注入时钟跨 T-1 24:00」，**没回源就写下了**。
>
> ⚠️ **本节标题已从「跨不了零点」扩成「只能落整点、且不能改变日历日」** —— 理由见文末：
> 原标题按「**跨日**」筛，于是漏掉了 **B1-10** 这种**不跨日、但也够不到目标时刻**的用例。

回源 `apps/api-server/src/common/utils/time.ts:60-84`：

```js
const SHIFT_MS = ABOX_SHIFT_TO_HOUR * 3_600_000 - withinDayMs;  // withinDayMs = 本北京日已过毫秒
export function now() { return new Date(Date.now() + SHIFT_MS); }
```

⇒ 注入后 `now()` **恒等于「本北京日 HH:00:00.000」**，两个后果：

| # | 后果 | 证据 |
|---|---|---|
| ① | **日历日不变**（源码注释明写：真实 03:00 → 注入 20:00 **同日**） | `SHIFT_MS` 只在本日内摆动 |
| ② | **只能落整点** | `ABOX_SHIFT_TO_HOUR` 经 `Number.isInteger()` 校验，只收 0–23 整数 |

于是：

- **能测**：下单窗口内（14:00–23:00 整点）、开团前（00:00–13:00 整点）
- **不能测**：
  - **跨零点**（B2-12 / B4-3 / B4-6 原写法）—— 日历日不变，`todayBj()` 不受它影响；
  - **`[23:50, 24:00)` 这条窄带**（**B1-10** 原写法）—— 窗口上界是 `截单 − order.cutoff_window_minutes`
    **算出来的**（默认 10 分钟），不是整点。注入 23 只得到 23:00，**仍在下单窗口内**，
    根本造不出「已过截单」。

##### ⚠️ 为什么标题要扩（本节最该记住的一点）

我第一次修的时候是按「**跨日**」这个关键词筛的 —— 结果只修了 B2-12 / B4-3 / B4-6 三条，
**漏掉 B1-10**：它不跨日，但它要的那个时刻（`[23:50, 24:00)` 这段「刚过截单」）同样够不到。
**是架构师核出来的，不是我自查出来的。**

⇒ **按「用到的机制」筛，不要按「失效的现象」筛。** 现象有无数种（跨日、窄带、跨月、跨季），
机制只有一条：注入后 `now()` 恒为「本日 HH:00:00.000」。按现象筛，就会漏掉那些
现象不同、机制相同的用例。

**⇒ 正确机制：`POST /admin/schedule/{task}/run`，带显式 `date`。**
它接收显式出餐日、**与时钟无关**，且与跑批**共用同一执行口**（`runOnce()`），
算出来的数与跑批完全一致 —— `tasks/schedule-admin.service.ts:54-70` 的注释即如此声明。
任务名见 `schedule.service.ts` 的 `TaskName`：`meal-publish` / **`cutoff`** / `delivery-generate` /
`auto-confirm` / `commission-settle` / `supplier-share` / `reconciliation` / `leader-expire`。
其中 `cutoff` 的 `dateKind='today'`（D 日 00:00 截 D 日的单）。

> **更根本的一条认知**：B2-12 的 A/B 翻转，本质是**跑批把订单从 `paid` 推进到 `cut_off` 从而换组**，
> 跟墙钟走没走一点关系都没有。当初写成「注入时钟」是把**手段**当成了**目的** ——
> 真正要验的是「状态变了以后分组跟着变」，那直接把状态推进去就行。

### C.6 运行时骨架 —— **jest（纯函数面）+ e2e 脚本（连库面）双轨**

> ⚠️ **本节按 Team Lead 2026-10-26 的最终裁定重写。** 前一版把全部运行时场景都归到
> `scripts/e2e-*.mjs`，依据是「本项目无 jest」—— 那是**只查了根目录 `package.json`、
> 没查子包**得出的错误事实。回源后确认 jest 是 api-server 的既有基建：
> `apps/api-server/package.json` 有 `jest ^29.7.0` + `ts-jest` + 完整 jest 配置，
> `testRegex: "(src|test)/.*\\.spec\\.ts$"`，`scripts/gate.mjs:124` 的 `jest` 组在 `all` 内，
> 且**刻意不加 `--passWithNoTests`**（0 个测试 = 红）。

**三条防线各守一段，互不替代**：

| 防线 | 守什么 | 抓不到的反例 |
|---|---|---|
| 静态脚本 `check-n1n2-w1-suspend-rules.mjs` | **结构**层有没有写错 | 抓不到「6 态白名单少两个态」这类**行为**错误 |
| jest（`test/unit/*.spec.ts`） | **纯函数/常量**的行为对不对 | 抓不到「配置键假装接线」这类**结构**错误，也连不了库 |
| e2e 脚本（`scripts/e2e-*.mjs`） | 真实 DB + 状态推进 + 并发 | 慢，且依赖夹具 |

##### C.6.1 jest 基线（Team Lead 要求先跑并记录）

| 时点 | Suites | Tests | 结果 |
|---|---|---|---|
| 接手时（2026-10-26 21:02） | 10 | 81 | 全绿 ✅ |
| 加入 `unfinished-orders.spec.ts` 后 | **11** | **92** | 全绿 ✅ |
| 后端补 `orderability.spec.ts` 等后（21:52 复跑） | **12** | **101** | 全绿 ✅ |
| QA 落 `orderability-no-clock.spec.ts`（22:54 复跑） | **15** | **129** | 全绿 ✅ |

> ⚠️ **基线本身无历史红灯** ⇒ 无需修别人的用例。后续每加一个 spec，增量必须是
> `+N suite / +M tests`，且**总数只增不减** —— 数字变少 = 有人删了测试（anti-gaming 一级信号）。

##### C.6.2 已落地的 jest spec

| 文件 | 覆盖 AC | 断言要点 |
|---|---|---|
| `test/unit/unfinished-orders.spec.ts`（新增 · 11 条） | **B2-2 / B2-3** | ① 终态恰好 **3 项**（守「反算」这个**写法**，不只是守数字 —— 写白名单的人会把 `ORDER_TERMINAL_STATUS` 改成 8 项清单，那时「未完结 = 8」仍绿）；② `refund_applying` / `refunding` **必须**计入未完结（6 态白名单漏的正是这两个）；③ **不变量**：`未完结 ∪ 终态 ≡ 全枚举 且 无交集` ⇒ 将来新增状态忘归类或归错类都会红；④ `refunded`（放行）与 `refunding`（拦截）是两条不同的线 |
| `test/unit/orderability.spec.ts`（backend 已有 · 12 条） | N1-AC-05 / W1-AC-03 / N1-5 / N1-2 | 结构层四桶、停售优先、文案插值、纯函数不读时钟 |
| **`test/unit/orderability-no-clock.spec.ts`**（QA 新增 · 7 条） | **N1-2（行为判据）** | 见下 §C.6.2b |

##### C.6.2b ⚠️ N1-2 的**行为**判据：为什么它必须用 spy，不能用词法扫描

静态那条 `N1-2` 已降级为提示项（G11：判据形态与约束形态不匹配）。真判据落在这里：

```
装探针替换全局 Date ⇒ 记录 ① Date.now() 调用次数 ② **无参** new Date() 构造次数
⇒ 断言：evaluateStructure / evaluateAvailability / reasonText 期间全部为 0
⇒ 断言：模块**加载期**也为 0（防顶层 `const x = Date.now()`）
⇒ 断言：探针自证（装了探针后 Date.now() 确实被记录）⇒ 证明「0」不是「探针坏了」
```

三个关键设计：

1. **只记无参 `new Date()`**：`reasonText()` 里的 `new Date(ctx.publishAtMs)` 是
   **毫秒 → Date 的纯换算**（入参由调用方注入），是本文件「不读时钟」原则的**正面 exemplar**。
   把它判成违规就是逼人删掉正确写法。⇒ **盯的是「从哪拿时间」，不是「有没有用到 Date 这个类型」。**
2. **加载期也要覆盖**：顶层 `const x = Date.now()` 发生在 import 时，不在任何调用窗口里
   ⇒ 用 `jest.isolateModules` + 先装探针再 `require`。**这是变异自证抓出来的，不是推理出来的。**
3. **探针自证**：先证明探针抓得住，再信它的零。否则「零调用」可能只是「探针坏了」。

⚠️ **已知边界**：探针只覆盖 `Date.now` 与 `new Date`。若有人改用 `performance.now()` /
`process.hrtime()` 绕过，探针抓不到 —— 故另配一条**可复现性断言**（同一入参连续 200 次结果一致）
作第二道。它抓不到所有形态，但能抓到「结果真的随时间变了」那一类。

##### ⚠️ C.6.3 变异自证：**新写的 spec 必须先证明它能变红**

绿不是证明，**「该红的时候红了」才是**。已对 `unfinished-orders.spec.ts` 做变异验证：

```
变异：把 REFUND_APPLYING / REFUNDING 误加进 ORDER_TERMINAL_STATUS
      （= 6 态白名单的失效形状：这两个退款中间态被当成终态，悄悄少拦两单）
结果：11 条断言 → **6 红 5 绿**
```

- **变红的 6 条**（应有的）：终态恰好 3 项 · 未完结恰好 8 项 · refund_applying · refunding · 8 态逐一断言 · refunded/refunding 两条线
- **保持绿的 5 条**（也应如此）：不变量（并集仍覆盖全枚举、仍无交集，没被这次变异破坏）· 三个终态各一条 · 计数为 0

⇒ **红在该红的地方、绿在该绿的地方**，这才是「有判别力」的用例。

##### ⚠️ 变异自证是**硬性要求**，不是建议

**规则：每写一个新 spec / 新判据，必须先变异一次，看它红不红。一个从不失败的检查等于没有检查。**

且必须**两个方向都做**。只做一个方向会漏掉一半的失效形状：

| 方向 | 做法 | 抓什么 |
|---|---|---|
| **破化看红**（`mutate` 覆盖） | 把产物改错，确认判据报红 | 「必报的报得出」 |
| **修对看绿**（`mutate` **不**覆盖） | 把产物临时**改对**，确认判据**转绿** | 「必不报的不报」 |

⚠️ **「修对看绿」这一半是本批最贵的一条经验**，我是踩了才明白的：
`N1-7` 首版按「字面 ±200 字」取窗口，判出 `traceability.service.ts:285` 不合。
我把那一行**临时改成正确写法**之后，**它还是红的** —— 而它本该转绿。
查下去才发现：窗口把上一行一个**完全合法的** `NOT_FOUND`（办公楼不存在，本就该 10004）
卷了进来。

⇒ `mutate` 证明不了这一类。**要抓它，只能真的把产物改对一次，看它绿不绿。**
⇒ 已沉淀为 `HELPER_CHECKS` 里的一条常驻自证：
「N1-7 · 上一个抛点是合法的 NOT_FOUND 时，本条仍须判绿（防回扫抓错抛点）」。

**2026-10-26 已执行的变异自证（留痕）**：

| # | 对象 | 变异 | 结果 | 恢复核验 |
|---|---|---|---|---|
| 1 | `ORDER_TERMINAL_STATUS` | 把两个退款中间态误加进终态 | 11 条 → **6 红 5 绿** | `git diff packages/` 干净 |
| 2 | `BuildingRow.canAssign` | 改名 ⇒ 跑 `vue-tsc` | 报出 `leader-binding.vue(105,37)` `(106,27)` 两条 TS2551 | `cmp` 一致 |
| 3 | `traceability.service.ts:285` | 改成 `BUILDING_NOT_GROUPED`（**修对**方向） | **仍红** ⇒ 暴露窗口缺陷 ⇒ 已修 | `cmp` 一致 |
| 4 | `traceability.service.ts:285` | 改回 `NOT_FOUND`（破化方向） | 红，精确定位 `:284` | `cmp` 一致 |
| 5 | `building-admin.service.ts:297` | 删掉「不要全局替换」警示语 | `N1-20` 由绿转红 | `cmp` 一致 |
| 6 | `orderability.ts` 顶层 | 插一行 `const x = Date.now();` | **首版未红** ⇒ 抓出 spec 的时机盲区，见下 | `diff` 一致 |
| 7 | 新八条判据 | 每条一条定向变异（见下表） | **8/8 如期报红** | 副本上做，真仓零改动 |

##### ⚠️ 第 6 行是本批**第二次**证明「修对看绿」不可省

`orderability-no-clock.spec.ts` 首版只统计 `during(...)` 窗口内的时钟读取。
变异注入 `const __probe_leak = Date.now();` 后**6 条断言全绿** ——
因为顶层语句发生在**模块加载时**，不在任何调用窗口里。

⇒ 这跟静态判据掉的是**同一个坑的不同一层**：
  · 静态那条看的是**字面** ⇒ 漏「不动 import 也能读时钟」
  · jest 这条漏的是**时机** ⇒ 漏「读时钟发生在调用窗口之外」
⇒ **「不读时钟」是全时段约束，判据就不能只覆盖某一个时段。**

⇒ 补 `jest.isolateModules` + 先装探针再 `require` ⇒ 加载期读取也被记录 ⇒ 再变异，**如期报红**。

##### v2.5 八条判据的定向变异（在**只读快照副本**上做，真仓零改动）

| # | 判据 | 变异动作 | 结果 |
|---|---|---|---|
| 1 | N1-23 | 只改 `REASON_TEXT` 一侧，忘了 `ERROR_MESSAGE` | ✅ 红 |
| 2 | N1-24 | 调用点写死文案覆盖 `ERROR_MESSAGE` | ✅ 红 |
| 3 | N1-26 | 回落支改成硬编码（正是本批要治的形状） | ✅ 红 |
| 4 | W1-UI-2 | 写成相邻的右邻码 `60010` | ✅ 红 |
| 5 | W1-UI-4 | 删掉「不受影响」说明 | ✅ 红 |
| 6 | D-N2-4-b | 第 4 条并入存在性 ⇒ `group_suspended` 消失 | ✅ 红 |
| 7 | N1-10（反向合取） | 存在性改用 `!x` | ✅ 红 |
| 8 | N1-9 | `assignMembers` 绕过 60008 准入 | ✅ 红 |

##### ⚠️ 为什么变异改在**副本**上做（本轮新做法，建议推广）

Team Lead 明令「不要碰 `apps/api-server/src/`」（后端在并发落 P3-5，改了会互相覆盖），
而「变异自证」是我自己立的硬性要求。二者冲突时正确解法不是放弃其中一个：

⇒ **把仓库复制成只读快照，在快照上变异、在快照上跑门禁。**
真仓零改动 + 变异照做 + **顺带消除了「门禁读到半写文件」的干扰**。

⚠️ 顺带记一条我自己的**流程缺陷**：`cd X && … ; cd .. && 恢复` 这种链式写法在本环境里
**失败过两次**（`cd ..` 后相对路径解析不到）⇒ 变异残留留在了业务文件里，靠事后
`sed` 精确摘除 + `diff` 核验才救回来。
⇒ **规矩：恢复步骤一律用绝对路径，且不放在 `cd` 链里。**

> ⚠️ 每次变异后**必须 `cmp` 核验与备份逐字节一致**，再继续。
> 留一个变异在业务代码里，就是亲手造一个 P0。

##### C.6.4 e2e 骨架（`scripts/e2e-n1n2w1-suspend.mjs`）—— 保留，负责连库面

> jest 覆盖不了「真实 DB + 状态推进 + 并发」的部分，仍走 e2e 脚本路线。两者不互斥。

| 项 | 内容 |
|---|---|
| 形态 | `scripts/e2e-n1n2w1-suspend.mjs`，照抄 `e2e-referral.mjs` 骨架 + `scripts/lib/e2e-server.mjs` |
| 覆盖 | B0 基线 8 条 · B2-12（**单独一条，标必过**）· B4 并发/跨日 7 条 · X-1 改名一致性 1 条 = **17 条（必过 15）** |
| 批次标注 | 每条显式标 `batch`（P3-2 ~ P3-8）；`--list` 可只看清单，`--only <batch>` 只跑某批 |
| 反恒绿 | 未落地的能力记 **PENDING**（既不记 PASS 也不记 FAIL）；**退出码 3 = 有待落地项，任何门禁不得当成通过**；存在 PENDING 时汇总**绝不**打印「全绿」 |
| 断言形状 | B4 一律**不变量**（析取式 / 「不得出现第三态」），不写期望时序 |
| 夹具 | 直接改 sqlite（`openFixtureDb()`），与 `e2e-referral.mjs` 同款纪律 —— 借道业务接口造数据会让「造数据」本身被测代码污染 |

⚠️ **接进 `gate.mjs` 时的注意**：现有 `verify` 组的期望正则是 `/^通过\s+\d+\/\d+.*$/m`，
本骨架会多打一行 `待落地 K`。**必须**一并校验退出码为 0 —— 只看 `通过 N/M` 的话，
「全部待落地」也会被读成「N/N 通过」。

---

## D. 降级与风险

### D.1 硬拦会不会让运营在紧急场景无法止损？

| 项 | 内容 |
|---|---|
| **风险** | 食品安全/楼宇封控/供应商断供 —— **这些场景恰恰一定伴随未完结订单**，硬拦迫使运营多一次判断 |
| **缓解** | `forceSuspend` 保留活路；`hint` 给出「几单/最早哪天/样例单号」让决策可执行；`operator` 无此权限但无需额外守卫 |
| **更关键的认知（采纳 ADR §4.3）** | **`forceSuspend` 只解决「能不能做」，解决不了「敢不敢做」。** 而且真正要止损时，「停用」本身能力有限 —— 它只拦新单，对已付款的用户毫无作用。真正的止损工具是召回/退款（走既有逐单审批），必须验收**该路径独立于停用存在**（B2-11 + W1-AC-05） |
| **守住它的** | B2-7 / B2-8 / B2-9 / S-N2-5 / S-N2-6 |

### D.2 fail-closed 会不会误伤正常下单？

**裁决反转**：**推翻** v1.0 的 fail-open 裁决（见 W1-AC-07 的理由），本批改 fail-closed。
**残留风险**：停售读的是同一个 DB，因此 DB 一抖 ⇒ 全站不能下单。这是**刻意接受**的取舍 —— 权衡是「短暂不可下单」vs「停售开着却继续收单（造成无法履约的订单 + 必退款 + 若因食品安全则有实害）」。

> ⚠️ 但这条结论**依赖于「不引入缓存」**。一旦有人在 `OrderAvailabilityService` 加了短缓存（ADR §10 第 3 项已提出），「缓存抖动 ≠ DB 故障」重新成立，此时 fail-closed 会把一次缓存抖动变成全站停售 ⇒ **必须改回 fail-open**。
> ⇒ **S-W1-5 / S-W1-7** 两条判据联合守这条**会随时间退化**的不变量。这是本批唯一一条「今天正确、明天可能错」的裁决，必须写在代码注释里。

### D.3 本批改动自身的次生风险

| 风险 | 怎么发生 | 缓解 | 守住它的 |
|---|---|---|---|
| 首屏能点、下单才错 | 只改 U6 忘 U1（或反之） | AC-COMMON-1 要求三端同谓词 | B1-7 |
| 团长工作台漏改 | 三处只补两处 | 同上 | B1-7 |
| 忘记关停售开关 | 无告警、是这类开关最常见的死法 | 只读状态端点 + 切换留痕 + reason 强制必填 | B3-8 / B3-9 / W1-AC-06 |
| 「搬空+停用」被新校验破坏 | 新校验加在 members patch 之前 | B0-6 回归基线 | B0-6 / S-N2-7 |
| 60003 被 60007 吞掉 | 顺序写反 | S-N2-7 + B0-5 | B0-5 / B2-5 |
| PREPARING 与 SUSPENDED 合并 Fall | 图省事共用一句 | S-N1-6 + B1-3 | B1-3 |
| 8 态变 6 态（沉默回归） | 有人改回白名单 | **S-N2-1 + B2-2 双保险** | B2-2 / S-N2-1 / S-N2-2 |
| 历史脏单永久锁死停用 | 缺时间边界 | S-N2-3 + B2-4 | B2-4 |
| 停售后自动退款 = 资金事故 | 复用批量取消 job | S-W1-6 + W1-AC-05 | B3-6 / S-W1-6 |
| `10004` 注释变陈旧第二真相 | 改了码没改文档 | B1-8 + 异议 1 的修订要求 | B1-8 / S-N1-7 |

---

## E. 错误码清单（与 ADR §7 对齐）

**号位以 Team Lead 2026-10-26 最终裁定为准**（连续 60006–60013，无跳号；已同步进 `scripts/check-n1n2-w1-suspend-rules.mjs` 的 ERR-1/ERR-2）。

| Code | 常量名 | 触发 | payload |
|---|---|---|---|
| 60006 | `BUILDING_UNFINISHED_ORDERS` | 楼宇停用，A=0 且 `1≤N≤阈值` 且未 force | `{unfinishedCount, groupA, groupB, earliestMealDate, samples, threshold, hint}` |
| 60007 | `BUILDING_GROUP_UNFINISHED_ORDERS` | 楼群停用，同上条件 | 同 60006 |
| 60008 | `BUILDING_GROUP_SUSPENDED_REJECT` | 往已停用楼群挂楼（**本批必做**） | `{targetGroupId, hint}` |
| 60009 | `SALES_PAUSED` | U6 且 reason=`sales_paused` | `{reason}` |
| **60010** | **`BUILDING_SUSPENDED`** | U6 且 reason ∈ {`building_preparing`, `building_suspended`, `group_suspended`} —— **业务主动停用** | `{reason, reasonText}` |
| **60011** | **`BUILDING_NOT_GROUPED`** | U6 且 reason=`building_not_grouped` —— **配置缺失**（原 10004 场景） | `{reason, reasonText}` |
| **60012** | `SUSPEND_REQUIRE_APPROVAL` | `N > 阈值`，**即使 force 也拒绝** | `{unfinishedCount, threshold, opCode, hint}` |
| **60013** | `SUSPEND_CANNOT_REVOKE_ACCEPTED` | A 组 `count > 0`，**硬约束，force 与审批都不得绕过** | `{groupA:{count, orderNos}, hint}` |

> **60010/60011 拆分的理由**（异议 2 被采纳）：二者用户的可执行动作可能相同，但**运营的处置动作完全不同** ——
> 前者是运营自己停的（不该告警），后者是漏配事故（要告警、要有人去配）。同码会让监控分不开这两类事件。
> 对照本仓 30022/30023 的拆分先例，那里给的理由就是「共用一个码 ⇒ 日志/监控/告警里完全同形」。

**为什么是连续号段**（引 ADR 自述，QA 认同）：它们都是「同一个谓词族的输出」。号段相邻本身就是一条弱的强制力 —— review 时一眼能看出有没有人绕开谓词单独抛码。

**保留不动**：`30001`（cutoff / not_open_yet）· `30005`（meal_not_published）· `60003`（楼群非空）· `10004`（回归为目标不存在，**不再承担「楼未归群」** —— 见异议 1）。

**保留不动**：`30001`（cutoff / not_open_yet）· `30005`（meal_not_published）· `10004`（回归为目标不存在，**不再承担「楼未归群」** —— 见异议 1）。
登记纪律：enum 与 `ERROR_MESSAGE` **两处成对**，由 `errcode:message` 门禁守配对。

---

## F. Phase 4 判定口径

| 指标 | 目标 | 来源 |
|---|---|---|
| N1/N2/W1 的 P0 AC 通过率 | 100% | §A 全部 P0 条目逐条机械判定 |
| **回归率** | **0** | B0 全绿（尤其 B0-5/B0-6/B0-7）；任一由绿转红即阻断 |
| **沉默逻辑定向** | B2-2（8 态）**必须固化为 jest**，不许只手工跑 | ADR §8 第 8 步 |
| 并发与跨日 | B4-1~B4-7 全过且 **non-flaky**（连跑 10 轮一致） | 运行时 |
| **跨零点 A/B 翻转** | B2-12（同一夹具跨 T-1 24:00 断言 60006→60012 翻转）必过 | 运行时 |
| A 组无出口 + 时间边界 | B2-4 + S-N2-3 必过（这是唯一反死锁机制） | S-N2-3 / B2-4 |
| B 组通知文案不得同质 | B2-14 必过 | B2-14 / N2-AC-07 |
| 阈值不得硬编码 | B2-13 必过（先把阈值改成 2 再验 60011） | S-N2-10 / B2-13 |
| 管家端不被时间污染 | B1-10（注入 `=0` + **两侧同时断言**）+ S-N1-3b（静态） | B1-10 / S-N1-3b |
| 状态机不被冻结 | B2-15 必过（隐性欠薪防线） | B2-15 |

### 待 Team Lead 裁决（来自 §0.6 与 ADR §10）

| # | 事项 | QA 倾向 |
|---|---|---|
| 1 | 异议 1：确认 10004→60010 并同步修订 `request.ts` 注释 + 《接口规范》登记 | **必须做**，不是可选项 |
| 2 | 异议 2：`building_not_grouped`（配置缺失）要不要与 `building_suspended`（业务暂停）拆两码 | 倾向拆（可观测性） |
| 3 | 异议 3：hint 是否区分「卡在退款」与「待履约」 | 倾向要（ADR 已部分解决，需确认落到 payload） |
| 4 | **异议 4（新增）**：B 组通知文案是否按「待履约 / 退款中」分两套模板 | **建议分**，否则退款用户会收到「餐会照常送达」 |
| 5 | ADR §10-1：`forceSuspend` 是否收窄到 `super_admin` | 倾向维持 admin（夜班止损速度） |
| 6 | ADR §10-3：`OrderAvailabilityService` 是否加短缓存 | **倾向不加**；若加则触发 W1-AC-07 反转（改回 fail-open）+ S-W1-5/S-W1-7 |
| 7 | **v2.1 新增**：A 组（今日 00:00–14:00）导致该时段楼宇**完全不可停用**且无逃生口，是否接受 | 可接受，但**必须**保证 60012 的 hint 指向「逐单退款审批」这条路真的存在且可用（需 B2-11 验证 hint 可操作性） |

### ⚠️ ADR 自身的一处不一致（请架构师顺手修）

ADR **第 18 行（TL;DR）** 写的是 `isOrderableStructure` + `isOrderable`，而 **§2.1（第 121–124 行）** 写的是 `evaluateStructure` / `evaluateAvailability` —— 两处函数名不一致。
TL;DR 是大多数人唯一会读的部分，照它实现会用错名字。**这本身就是本批在消灭的「同一件事两个名字」的同族缺陷**，建议在动手前统一下。
| 静态自检 | `check-n1n2-w1-suspend-rules.mjs` exit 0 且**自证全过**（exit 2 = 检查器自身不可信） | 新增脚本 |
| 静态范围 | **不得**出现 R-1~R-10 被写成静态判据 | §C.2 judge review |
| C.4 降级 | Phase 3 结束后**必须消失** | 人工核验 |
| 反作弊完整性 | 实现 diff 与测试/门禁 diff **分开呈现**；无新增 skip/xfail；无弱化既有断言 | `test-integrity-anti-gaming.md` §3 |

### 待 Team Lead 裁决（来自 §0.6 与 ADR §10）

| # | 事项 | QA 倾向 |
|---|---|---|
| 1 | 异议 1：确认 10004→60010 并同步修订 `request.ts` 注释 + 《接口规范》登记 | **必须做**，不是可选项 |
| 2 | 异议 2：`building_not_grouped`（配置缺失）要不要与 `building_suspended`（业务暂停）拆两码 | 倾向拆（可观测性） |
| 3 | 异议 3：`refund_applying` 卡住时 hint 是否要区分处置路径 | 倾向要（成本低） |
| 4 | ADR §10-1：`forceSuspend` 是否收窄到 `super_admin` | 倾向维持 admin（夜班止损速度） |
| 5 | ADR §10-3：`OrderAvailabilityService` 是否加短缓存 | **倾向不加**；若加则触发 W1-AC-07 反转（改回 fail-open）+ S-W1-5/S-W1-7 |

---

## G. 收尾批登记（**只登记，不执行** —— Team Lead 2026-10-26 裁定）

> 以下动作**不在 P3-5/P3-6 范围内**，等主链路收口后单独做。
> 登记在这里是为了**不让它们被忘记**，也为了说明「为什么现在不动」。

### G.1 60011 文案统一：去掉「楼群」这个内部运维概念

```
'该办公楼未配置楼群，请联系运营'  →  '该办公楼暂未开通服务，请联系运营'
```

判据：旧文案向用户暴露了「楼群」这个内部概念，**用户不知道什么是楼群**；
保留「请联系运营」这条行动指引（用户需要知道下一步做什么）。

⚠️ **回源发现：这一项后端已经顺手做了**（2026-10-26 21:46 落盘）。
`error-code.ts:662` 与 `orderability.ts:142` 现在都是「该办公楼暂未开通服务」。
故本节**剩余动作只有核验**，不是改造。

### G.2 ⚠️ 判据脚本里的**硬编码 sample 不会跟着文案走**

架构师的提醒值得原样留下：

> **判据脚本里的 sample 是硬编码的字面**，文案改了它不会跟。
> 改文案前先 grep 一遍字面，别等 CI 红了才发现。

本批已受影响的处置：

| 位置 | 处置 |
|---|---|
| `N1-7` 的 `needle` | 已从「文案字面」改为「判定条件」`buildingGroupId` ⇒ **对文案改名免疫**（这是 §C.1.4 第二次失配换来的） |
| `N1-7` 的 `scanGood` / `scanBroken` | 样本里仍含「未配置楼群」字样，**随收尾批一起更新** |
| `N1-13` 的 sample（AC `:380` / `:765` 附近） | 含「所属办公楼未配置楼群」，**收尾批做的时候同步改** —— ⚠️ **现在不能改**：判据必须与**当时的产物**一致，提前改会让判据与产物对不上而假红 |

⇒ **规矩：判据里的字面，必须与产物里的字面同批更新，不允许提前、也不允许滞后。**
> 提前 ⇒ 判据与产物对不上（假红）；滞后 ⇒ 判据在判一个已经不存在的东西（假绿）。

### G.3 已撤回的登记项

| 项 | 处置 |
|---|---|
| `SWAGGER_*` 常量 | **撤回**。Team Lead 已确认「这个符号是我编的，不是你写的」；全仓 `grep -rn 'SWAGGER_' apps/api-server/src/` 命中 **0**。⇒ 我的 AC 里不存在依赖它的判据 |
| `REASON_TEXT.building_not_grouped` 文案 | **不改**，只补注释（架构师裁定：它才是真正的同步目标，不是 60011 的 message） |

> ⚠️ **协作纪律**：若在别人的消息里看到任何「看着像符号名、但 grep 不到」的东西，
> **直接当它是假的来问**，不要想办法让它成立 —— 本批已经第三次出现这种形状了。

---

*文档结束 · QA 未改动任何业务代码 · 全文 AC 均为「可机械判定」口径*

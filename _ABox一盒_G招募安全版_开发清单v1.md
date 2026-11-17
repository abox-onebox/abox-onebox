# G 招募安全版 · 完整开发清单 v1.1（已实现 · 待部署）

> 2026-11-17 · 祝总拍板三项：①触达对象=该楼活跃下单用户（可接受）②逐卡确认 ③本期=安全版（只生成任务卡+申请链接，不自动发消息、不建团长）。
> 本文是**照着能开发的文件级清单**，不是设计讨论。设计结论见 `_ABox一盒_G招募接执行_编排设计v1.md`。
> **⚠️ 已纠正上一版口径错误**：`POST /leader/apply` 是 **C3 提交即生效（status=ACTIVE，无人工审核）**；`/admin/leaders/:id/audit` 只做在职团长的停职/复职/补签/备注，不是申请闸。G 设计 v1 已同步修正。
> **v1.1 挑刺修订（2026-11-17）**：代码已实现但清单未回写，本版补齐 14 处口径——幂等真做、物料沿用 generate 原卡话术、generate 权限改为 operator 可看、skip 也记台账、降级回显缺口、删 `not_active` 死码、台账补 actorId 并 await、§14 缺口差集改为 StatsService 直接取数、部署句删误植的 h5 步骤、§12 增加物料一致性检查。

---

## §0 范围边界（先背下来，越界就是做错）

| 本期做 ✅                                               | 本期不做 ❌                                         |
| ------------------------------------------------------- | --------------------------------------------------- |
| 生成结构化**招募任务卡**（缺口楼+话术+优先级+目标分群） | 不自动发任何对外消息（不调 `send_message`）         |
| 生成**申请入口物料**（申请路径 + 可复制话术）           | 不建团长档案（不调 `appoint_leader`）               |
| 逐卡人工确认，批准后出物料、记台账                      | 不替用户提交 `/leader/apply`、不碰审核链路          |
| 台账 `ab_ai_insight` 记"批准/跳过"动作                  | 不新建业务表、不改 `ab_leader`/`ab_order`/`ab_user` |
| 三道校验（缺口白名单/实时复核/话术合规）                | 不碰钱、不计佣金、不测收益承诺                      |

一句话定义交付物：**运营在后台看到一批招募任务卡，逐张勾选批准，系统吐出"话术+申请路径"让他自己拿去发——全程系统不对外说一句话、不自动建一个人。**

---

## §1 改动文件清单（总览）

| #   | 文件                                                                        | 动作     | 职责                                                                                 |
| --- | --------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| 1   | `scripts/gen-recruit-taskcard.mjs`                                          | **新增** | 任务卡草稿器：吃缺口数据，出结构化 JSON + 三校验 + `--selftest`                      |
| 2   | `apps/api-server/src/modules/wecom-kb/recruit-taskcard.admin.controller.ts` | **新增** | 两个端点：generate / confirm，`@Controller('admin/recruit-taskcard')`                |
| 3   | `apps/api-server/src/modules/wecom-kb/recruit-taskcard.service.ts`          | **新增** | 组装缺口数据 → spawn 草稿器 → 确认时实时复核 → 出物料 → 记台账                       |
| 4   | `apps/api-server/src/modules/wecom-kb/wecom-kb.module.ts`                   | 修改     | 注册上述 controller + service（**不重复声明 `AiInsightService`**，见 §9 陷阱）       |
| 5   | `apps/admin-web/src/api/recruit-taskcard.ts`                                | **新增** | 前端 API：generate / confirm 两个方法                                                |
| 6   | `apps/admin-web/src/views/recruit/taskcard-draft.vue`                       | **新增** | 后台页：看卡 → 逐卡勾选 → 批准出物料 → 复制话术/路径                                 |
| 7   | `apps/admin-web/src/router/routes.ts`                                       | 修改     | 加后台页路由 + 菜单项（按 admin-web 现有约定）                                       |
| 8   | `apps/api-server/src/common/utils/recruit-taskcard.ts`                      | **新增** | 纯函数 `revalidateTaskCard`（确认时实时复核 + 话术合规闸），供 selftest 与服务端同源 |

> 不新增实体、不加 `ALL_ENTITIES`、不加迁移。`AiInsightService` 已存在（`ab_ai_insight`，第 37 表）。

---

## §2 草稿器 `gen-recruit-taskcard.mjs`（文件 1）

**定位**：把 `gen-recruit-proposal.mjs` 的"自由文本话术"升级成"可执行的结构化任务卡"。缺口数据由后端算好传入（stdin JSON 或 `--input`），脚本**只做组装与校验，绝不查库、绝不编造**。

### 2.1 输入（后端 `genRecruitProposal` 已算好的差集，复用不重造）

```json
{
  "generatedAt": "2026-11-17T...",
  "gaps": [
    {
      "buildingId": 12,
      "buildingName": "量子大厦",
      "orderCount30d": 138,
      "gmv30d": "3520.00",
      "activeLeader": 0
    }
  ],
  "coveredBuildingIds": [3, 7]
}
```

来源：`wecom-chat.service.ts` 的 `genRecruitProposal`（约 1918 行）现有"近 30 天有单楼 vs 在职团长覆盖楼"差集逻辑，抽成可复用函数返回结构化数据，**不要让它再只返回一段 markdown**。

### 2.2 输出（任务卡 JSON）

```json
{
  "date": "YYYY-MM-DD",
  "cards": [
    {
      "buildingId": 12,
      "buildingName": "量子大厦",
      "priority": 1,
      "gap": { "orderCount30d": 138, "gmv30d": "3520.00", "activeLeader": 0 },
      "targetSegment": "该楼近 30 天有过订单的用户",
      "pitchText": "可复制招募话术（继承 §3 全部硬约束）",
      "estimatedEarningText": "测算示例：…以实际订单与佣金率为准",
      "applyPath": "pages/leader-apply/leader-apply",
      "ref": null,
      "reason": "为什么优先拓这栋"
    }
  ],
  "rejected": [{ "buildingId": 7, "why": "已有在职团长/非在营/数据缺失" }],
  "notes": []
}
```

### 2.3 `applyPath` 与 `ref` 的规则（重要，别自作聪明）

- **本期 `ref` 恒为 `null`**：缺口楼没有团长，就没有真实推荐人；AI 编造 `USR`/`LDR` 码违反"绝不编造"，且会让推荐关系绑到不存在的人。
- `applyPath` 只给**裸申请路径** `pages/leader-apply/leader-apply`（端上 `onLoad` 无 ref 即自荐，见 §7）。
- 现成能力**不要重造**：真实裂变链接由 `user/referral`（返回 `referralLink`）和 `leader/share`（`generateQrcode`）提供，那是给真实用户/团长用的，不归 G 管。
- 若将来要给缺口楼配真实推荐人，改成"运营配置一个真实 USR 码"的配置项，仍不由 AI 生成。

### 2.4 三道校验（`--selftest` 必须自证）

1. **缺口白名单**：`buildingId` 必须来自输入 `gaps`；不在表内 → 该卡剔除进 `rejected`。
2. **话术合规闸**：`pitchText`/`estimatedEarningText` 命中禁用词（躺赚/零花钱/月入过万/独占/保底…）或缺"测算示例" → 脚本层进 `rejected`（服务端 confirm 复核时为 `blocked`）。
3. **数字真实性**：`orderCount30d`/`gmv30d` 必须等于输入值，脚本不得改写；缺失写"暂缺"。

`--selftest` 按项目纪律自带**必报样本**（编造 buildingId、含"躺赚"话术、篡改 GMV）+ **必不报样本**（用真实未改动的输入），任一判据恒绿/恒红即失败退出。

---

## §3 后端生成端点（文件 2/3）

**`POST /api/v1/admin/recruit-taskcard/generate`**

| 项         | 规格                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 挂哪       | `wecom-kb` 模块（缺口数据与 `AiInsightService` 都在此，避免跨模块 DI）                                                                         |
| 权限       | `@Roles('super_admin','admin','operator')`（只读，operator 可看；confirm 方法级收紧为 super_admin/admin）                                      |
| 入参       | 无 body 或 `{ force?: boolean }`（force=忽略当日缓存重算）                                                                                     |
| 逻辑       | ①调缺口差集函数拿结构化数据 → ②spawn `gen-recruit-taskcard.mjs` → ③解析 JSON → ④按 `priority` 排序 → ⑤返回                                     |
| 出参       | `{ date, cards[], rejected[], notes[], generatedAt }`（**只读，不写库**）                                                                      |
| 失败降级   | 脚本缺失/超时/异常 → 回显原始缺口数据 + `degraded:true`，绝不 500（继承 `genRecruitProposal` 现有降级策略）                                    |
| spawn 安全 | 实际实现：`spawn('node',[script,'--plain-file',临时文件])` + 60s 超时，参数走临时 JSON 文件、**不拼 shell 字符串**（v1 原写 execFile，未落地） |

---

## §4 后端确认端点（文件 2/3）—— 逐卡确认的核心

**`POST /api/v1/admin/recruit-taskcard/confirm`**

| 项                | 规格                                                                                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 权限              | `@Roles('super_admin','admin')`；从 JWT 取 `sub`→`actorId`、`username`→`actorName`（客户端 actorName 仅兜底）                                                                                                               |
| 入参              | `{ decisions: [{ buildingId, decision: 'approve'\|'skip', pitchText?, estimatedEarningText?, reason? }], actorName?: string }`                                                                                              |
| 逐卡语义          | 服务端**逐卡独立处理**，返回每卡结果（可部分成功）；`skip` 只记跳过、不出物料                                                                                                                                               |
| 每卡 approve 流程 | ①实时复核（见下）→ ②物料沿用 generate 原卡 `pitchText`（服务端再过合规闸；楼名/数字以实时缺口为准）→ ③`await` 写台账 → ④返回物料                                                                                            |
| 出参              | `{ results: [{ buildingId, ok, reason?, material?, idempotent? }], approvedCount, skippedCount }`                                                                                                                           |
| 幂等              | 同 `buildingId` 同日重复 approve → **先实时复核、再**查当日 `ab_ai_insight`（`meta.input` 的 `{date,buildingId,action}` + `meta.payload` 存物料）→ 返回已有物料、不重复写。跨实例并发不去重（无 DB 唯一索引，本期不加迁移） |

### 4.1 确认时实时复核（纯函数 `revalidateTaskCard`，文件 8）

1. 重拉"在营楼 + 在职团长覆盖楼"：若该楼**已被覆盖 / 不在近 30 天有单楼的缺口清单** → `block`，不出物料（「非在营/已不存在」由 `not_gap` 覆盖，无独立状态字段，v1 的 `not_active` 死码已删）。
2. 话术合规闸**再跑一遍**（防 generate 后有人改脚本或注入）。
3. 三真对齐：`buildingId` 在实时缺口白名单内；`buildingName`/数字**以实时缺口覆盖请求值**（请求方自报的名字与数字一律不采信，v1 写「匹配/一致校验」是过度描述）。

> 与 A 的 `revalidateMealTemplateDraft`（`common/utils/meal-template.ts`）同构——**纯函数、无副作用、blocked 就直接返回不落地**。这是"零侵入"的代码保证。

---

## §5 前端 API（文件 5）+ 后台页（文件 6/7）

### 5.1 `apps/admin-web/src/api/recruit-taskcard.ts`

```ts
generate(): Promise<{ date; cards; rejected; notes; generatedAt; degraded? }>
confirm(body: { decisions: {buildingId:number; decision:'approve'|'skip'; pitchText?; estimatedEarningText?; reason?}[] }):
  Promise<{ results; approvedCount; skippedCount }>
```

> 走 admin-web 现有 http 封装；后端业务错恒 HTTP 200 + `body.code`，鉴权失败 401+10002（判成败看 `body.code`，别只看 status）。

### 5.2 `taskcard-draft.vue`（对照 `views/meal/template-draft.vue` 复制骨架）

- 顶部：「重新生成」按钮 → 调 generate；显示 `generatedAt`、`degraded` 提示。
- 卡片列表：每卡显示 楼名 / 优先级 / 近30单量 / GMV / 缺口理由 / 话术全文 / 目标分群 / 测算示例文案。
- **逐卡勾选**：每卡两个按钮「批准」「跳过」，默认未决；底部「提交本批决策」→ 一次性调 confirm（服务端仍逐卡处理）。
- 批准后：该卡展开"物料区"——可复制话术 + 申请路径（admin 用 `navigator.clipboard`）。**物料与卡片同源**（v1 的实现曾用服务端常量话术，已修）；申请路径是小程序内部路由，运营需自行生成小程序码/入口投放；显示"系统未代发任何消息"的提示。
- 颜色遵守 `design:spec`：状态色不作文字色，warning 文字用 `$c-warn-fg`（参考 11-05 `44f7a21` 的坑）。

---

## §6 触达对象口径（决策① 的落点，本期只写字段不查数）

- **口径**：任务卡 `targetSegment = "该楼近 30 天有过订单的用户"`。
- **本期不查用户列表、不发消息**：stats 模块只有 `activeUserCount` 聚合，**没有**"按楼列出活跃用户 ID"的端点；不要为此新写查询（本期用不到）。
- **将来开触达时**才需要：新增"按楼取近 30 天活跃用户 ID"端点 + `send_message` 限频（同用户 30 天 ≤1 次）+ 静音名单；属下一期，不在本清单。

---

## §7 申请链接与 `buildingId` 的关键约束（必读，否则做出来是坏的）

`pages/leader-apply/leader-apply.vue` 的两条硬事实（本轮回源确认）：

1. **办公楼不可手选**：`buildingId` 取 `userStore.info?.buildingId`（由团长邀请链接绑定），端上不读定位；没有 buildingId 就申请不了。
2. `onLoad` 读 `?ref=USRxxxx/LDRxxxx` → 提交时带 `referralCode`；无 ref = 自荐。

**由此产生的真实待验证点（写进上线检查，不要假装已解决）**：

- 缺口楼恰恰**没有团长**，目标用户是否已绑定该楼 `building_id`？若未绑定，用户点裸申请路径进来会卡在"无楼可申请"。
- 本期安全版只出裸路径、不做绑定，所以**运营投放前须人工确认**目标用户已归属该楼（或先走现有团长邀请链接绑定流程）。这是运营话术里要交代的一句，不是代码能兜的。
- 不要在草稿器里"聪明地"给链接塞 `?buildingId=12`——端上不读这个参数，塞了也没用。

---

## §8 台账与"零侵入"自证（决策③ 的技术保证）

- 唯一写点：`AiInsightService.record({ kind:'recruit-taskcard', title, content, meta:{ mode:'admin_confirm', input:{ date, buildingId, action:'approve'|'skip' }, payload:material }, source:'admin', actorId:JWT.sub, actorName:JWT.username })`。**confirm 里 `await` 落库**（这是唯一写点、不是旁路；`record()` 自身吞异常不连带主流程）。
- **不新建表、不改任何业务表**：approve 只写台账 + 返回内存物料，不落 `ab_leader`、不发消息、不建团长。
- 零侵入自证（验证时做）：confirm 前后 `ab_leader` / `ab_order` / `ab_user` 行数与内容不变，`ab_ai_insight` 按**批准数 + 跳过数**增加（v1 只写批准，已修）。因 confirm 里 `await`，返回后查库即可，无异步时序坑。

---

## §9 模块注册与 DI 陷阱（血泪，别踩）

1. **`WecomKbModule` 必须 export `AiInsightService`**（11-05 `55a8488` 已修）：新增 service 若注入它，别在别处重复声明 provider——否则启动崩溃（与 `MealModule` 那个坑同源）。
2. 新增 controller/service 只在 `WecomKbModule` 注册一次；`@InjectRepository` 若新增，必须能在"本模块 + CommonModule"的 `forFeature` 找到（本期不新增仓库，但交付前仍跑 `check-di-forfeature`）。
3. 时间统一 `now()` / `toBjIso()`；判有无用 `Boolean(x)`；报错一律 `BizException(ErrorCode.*)`。

---

## §10 测试计划（照 A 的三段式，零副作用优先）

> **进度**：T1 已跑（草稿器 `--selftest` 8/8）；T2–T5 待部署后在生产 loopback 跑，本轮未部署、未写生产库。

| #   | 测试                | 方式                                                                 | 期望                                                        |
| --- | ------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| T1  | 草稿器 `--selftest` | 本地 `node --check` 后跑                                             | 必报样本全拦、必不报样本全过；非零退出码正确                |
| T2  | 生成端点只读        | 生产容器 loopback（复用 A 验证法：owner 账号登录、token 内存不落盘） | 对真实缺口产出合法卡，`degraded=false`，话术合规            |
| T3  | 闸口验证            | 构造"已覆盖楼 buildingId" approve                                    | 被实时复核拦下，`ok=false`，`reason` 明确；**零业务表写入** |
| T4  | 零侵入自证          | confirm 前后查 3 张业务表行数                                        | 全部不变；`ab_ai_insight` 仅按批准数 +N                     |
| T5  | 逐卡部分成功        | 一批里 1 通过 1 被拦                                                 | 返回逐卡结果，通过的出物料、被拦的不出                      |

> 生产验证脚本用完即删（容器 `docker exec -u 0`，服务器、容器、本地三处都清）；正样本必须有积极证据，不能靠"应该没问题"。

---

## §11 门禁与部署清单

**开发期（每次提交前）**

- [ ] `node --check scripts/gen-recruit-taskcard.mjs`
- [ ] `npm run lint` / `typecheck`（或 `node scripts/gate.mjs all` 全跑）
- [ ] `node scripts/check-di-forfeature.mjs`（DI 铁律）
- [ ] 若改了 controller/DTO 的 swagger 注解且端点要进企微操作目录：`format:write` → `gen-wecom-catalog` → `format:write`（**门禁强制全量重生成**：任何 controller 的 swagger 注解变更都必须跑，见下）
- [ ] 新增后台菜单项后跑 `nav:consistency`；加/改门禁后 `npm run docs:sync`

**op 目录口径（开工后按门禁事实修正）**：`gate all` 的 `wecom:catalog` 门禁强制所有带 swagger 注解的后台端点登记进 `op-catalog.generated.ts`（本次重生成后为 150 端点，含 G 的 generate/confirm 两条）。**登记 = 目录可见，不等于放权**：企微口语能否调用仍由 `tier` + `granted_ops` 决定，本期未给任何角色放权这两条 op，故企微口语面未扩大；但**后台 HTTP 面** generate 是 operator 可看、confirm 仅 super_admin/admin（v1 把两者都写成负责人可访问，已修）。若将来要"说人话生成招募卡"，再单独放权（无需重生成目录）。

**部署（沿用 A 的全套纪律）**

- [ ] 交付前 `tsc --noEmit` + `check-di-forfeature`
- [ ] 双备份（db + 代码）后再投；`git archive` → scp → `tar xzf` → `deploy.sh --tag manual-<ts>`
- [ ] ⚠️ `deploy.sh` 只 build api/admin；**本期只改 admin-web 后台页**，须确认 admin 产物已重建（8080）；h5 无变更，**不需要** `build h5`+`up -d h5`（v1 这句是通用纪律误植到本期）
- [ ] SSH 断 ≠ 失败，看 `.deploy-state`
- [ ] 门禁 35 道 + `verify` 6 道；**避开 23:50 后启动**（跨午夜假红）
- [ ] 基线重冻（每批收尾必跑）

---

## §12 上线检查清单（照着逐条打勾）

- [ ] 端点探活：无 token 打 generate → 401+10002（路由在）
- [ ] 真实缺口产出合法卡，`degraded=false`
- [ ] 编造 buildingId / "躺赚"话术 / 篡改数字 → 草稿器 selftest 必拦
- [ ] 已覆盖楼 approve → 实时复核拦下，零业务表写入
- [ ] 逐卡部分成功、重复 approve 幂等（返回已有物料、台账不增行）
- [ ] **批准物料的 `pitchText` 与卡片上 AI 话术一致**（不是服务端常量模板）
- [ ] `skip` 也有台账（批准+跳过总数 = 台账新增行数）
- [ ] 台账每条可追溯到 actorName + 楼 + 动作
- [ ] `applyPath` 为裸路径、`ref=null`（无编造推荐码）
- [ ] **运营话术含一句"确认目标用户已归属该楼再投放"**（§7 待验证点）
- [ ] 页面无状态原色作文字色（`design:spec`）
- [ ] 生产探针三处清理干净

---

## §13 诚实边界与待验证点

- **C3 提交即生效**：安全版不触发任何自动申请；链接投出去后是否成为团长，完全由真人自己在小程序里决定，系统不代劳。
- **"活跃下单用户"本期不实际取数**：只是卡片字段与投放口径，别当已实现。
- **§7 的 buildingId 绑定是真实待验证点**：缺口楼无团长 → 目标用户是否已绑楼未验证；本期靠运营人工确认，代码不兜。
- **幂等是查当日台账，不是 DB 唯一索引**：跨实例/并发双写不去重（本期不加迁移）；单人逐卡操作够用。
- **话术质量边界**：服务端只保证合规闸（禁用词+测算示例），不保证 AI 文案质量；运营从卡片带回原文，可在自己投放前人工改。
- 话术收益表述、对外触达合规，定案前建议法务过一遍；所有"测算示例"数字须用真实订单与佣金率回填。
- 本文是开发清单，不含法律/合规裁定。

---

## §14 建议开发顺序（依赖链）

```
① 草稿器 + selftest（纯脚本，零依赖，先把三校验跑绿）
   ↓
② 缺口差集（实际做法：service 注入 `StatsService.buildingRank` + `NameResolver.listLeaders` 直接算；**没有**改 wecom-chat.service，v1 这步未落地）
   ↓
③ revalidateTaskCard 纯函数（文件 8）
   ↓
④ service + controller（生成→确认→台账）
   ↓
⑤ 前端 API + 后台页 + 路由
   ↓
⑥ 门禁全跑（✅ 35/35）→ 部署（待）→ §10 T2–T5 验证（待）→ §12 上线检查（待）
```

每步收尾跑 `node --check`（脚本）/ `typecheck`（TS），别等全跑完才暴露语法错。

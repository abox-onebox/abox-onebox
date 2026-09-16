# ABox 一盒 · 接口规范 v1.0

> **文档性质**：开发阶段前后端唯一接口契约（Single Source of Truth）
> **依据**：交接包 v1.1（L1–L12 / C1–C9）· PRD v2.1 · ER v2.1（23 张表）· 项目目录结构 v2.0（12 模块 / 7 定时任务）
> **端-载体口径（C7）**：4 角色 · 3 载体 —— ① 小程序（用户 + 团长**同端**，团长为叠加身份）② 供应商 Web ③ 运营后台 Web
> **主体**：北京巡礼之年科技有限公司（品牌 ABox 一盒）

---

## 〇、文档信息

| 项 | 内容 |
| --- | --- |
| 版本 | v1.0 |
| 日期 | 2026-09-14 |
| 基地址（开发） | `http://localhost:3000/api/v1` |
| 基地址（生产） | `https://api.abox.<域名>/api/v1` |
| 协议 | HTTPS / JSON（`Content-Type: application/json; charset=utf-8`） |
| 风格 | RESTful + 资源化路径；动词仅用于不可资源化的动作（`/cancel`、`/approve`、`/retry`） |
| 文档产物 | Swagger 自动生成于 `/api/docs`（由 NestJS 装饰器产出，本文件为其人工契约前提） |
| 最近修订 | 2026-09-16 · ① **M3-1 后台鉴权基座**：A1–A6 重写（双主体隔离 / 登录失败锁定 / 令牌吊销 / 无状态登出 / 查库求证）+ D51–D56 口径 + 错误码 20009·20010；② **M3-2 套餐编排**：D1–D7 实现口径表 + 两个扩展选择器（`/admin/meal/dishes`、`/admin/meal/distribution-centers`）+ 错误码 30011·30012·30013；③ **M3-3 订单中心**：D8–D12 实现口径表 + C9 反向结算 + `executeRefund` 唯一执行口 + 错误码 30014·30015·40009–40011；④ **M3-4 退款审批（C6 三段式收口）**：D40–D42 实现口径表 + `ab_refund.order_status_before` + 错误码 40012·40013·40014；⑤ **M3-5 后台团长管理**：§6.3 补 D19–D22 实现口径表（26 项）+ 错误码 20011·20012·20013（**零 DDL 变更**）；⑥ **M3-6 后台供应商管理 + 集散**：§6.4 补 D23–D32 实现口径表（34 项）+ 扩展接口登记（`filter-options` / 详情 / 外卖链接 / 菜品库）+ `ab_supplier` 7 新列 + 错误码 50003·50005·50006·50007·50008；⑦ **M3-7 后台办公楼与楼群（P37 五视图）**：§6.3 补 D13–D18 实现口径表（27 项）+ 扩展接口登记（`filter-options` / `overview` / `delivery-map` / 详情）+ `ab_building` 增 `population` 列 + **状态三态修订**（`BuildingStatus` 1/2/3）+ `DistributionGap` 覆盖缺口三因 + 错误码 60001–60005（新号段 `6xxxx 主数据`）；⑧ **M3-8 供应商端出餐确认（S1–S3 · 原型 P21/P22）**：§五 补 S1–S3 实现口径表（派生落库 / 09:30 deadline 语义 / 按集散中心逐项确认 + 幂等 / S3 闸门与路线派生 / 不返回距离时长）+ 新表 `ab_supplier_dish_center_daily`（25→26 张）+ 错误码 50009·50010·50011；⑨ **结算口径改自营（2026-09-16 路线二次裁定）**：S9 应付结算口径**整表重写**（性质=半成品采购应付 / 计费基数=**实收量** / 应付对象仅供应商 / 场地费-打包-配送转为 ABox 自身成本不出付款单 / fail-closed 出单 + 未出单异常清单 / ⭐ **用户退款不冲减供应商应付**）+ 退款冲销段旧口径**作废标注**（`reverseSupplierShares` 待回退，列为 M3-9 开工前置）+ 错误码预留 50012·50013·50014 —— 详见《ABox一盒自营结算口径定义v1.0.md》；⑩ **M3-9 应付结算 S9 落地（自营口径首次实装 · 零 DDL）**：§五 补 S9 供应商端结算自查实现口径 + §6.5 补 D36/D37 实现口径表（出单 / 列表 / 付款登记 / 未出单异常清单）+ **回退 M3-3 `reverseSupplierShares`**（退款**不再**冲减供应商应付；出参显式声明 `supplierShareAdjusted=0` + `supplierShareMode='not_applicable'`）+ 落点登记（`/admin/supplier-shares` · `/supplier/settlement`）+ 错误码 50012·50013（**50014 未使用，号位已释放**）+ e2e `§21` 新增 41 条断言；⑪ **M3-10 系统配置（P36 · D57–D58 · 零 DDL）**：§6.7 补 D57/D58 实现口径表 + ⭐ **「接线状态」如实标注** —— 排查出 **9 项键「种子里配了、但服务端代码从不读取」**（时间类配置被 `@Cron()` 硬编码架空、`distribution_center.*` 已改表驱动），页面**只读展示 + 注明原因**，不给「改了不生效」的输入框；+ 配置白名单（未知键拒绝而非静默忽略）/ 整批原子 / percent **百分数↔比率单点换算** / 写完 `invalidate()` **同步刷新缓存** + e2e `§22` 新增 35 条断言；⑫ **M3-11 数据看板 D47–D50（P35 · M36 · 零 DDL · 零错误码）**：§6.6 **关键指标口径表修正 + 新增实现口径表（30 项）** —— ⭐ 修正 **GMV 口径**（原写「已完成订单、不含已退款」→ 改为「状态 ∉ {未支付, 已取消, 已退款}，**含在途退款**」：钱未退、佣金未冲销，剔除会造成双向错配）+ **客单价/单份均价并列下发**（原文括号里「份数 / 订单量」含糊，只给一个数必被读错）+ **退款率分子 = 订单数而非 `ab_refund` 条数** + **经营毛利减项改为净额口径**（采购/佣金剔 `cancelled`/`reversed`，`reversal` 负行计入）+ ⭐ **口径唯一真相 `stats.constants.ts`**（D47/D48/D49 三处同源，e2e 用「D48 合计 = D47 的 GMV」钉死）+ ⭐ **D49 按菜品合并**（一个菜被多套餐引用必须并到一行，否则热度腰斩；e2e 期望值从 `ab_set_meal_item` 推导）+ ⭐ **D50 留存数字成对下发**（观察窗口未走完 **或** 群为空 → `retainedWeek1`/`retentionRate1` 双 `null`，两种 `null` 语义不可混用）+ ⭐ **权限白名单必须含 `viewer`**（该角色菜单只有这 4 个看板页，漏了就「菜单能点、点了报 10003」）+ **区间只开 today/7d/30d 三档**（非法 `range` → `10001`，不静默回落）+ 内存聚合、不下推 SQL 的**选型理由**（跨 mysql/sqlite 金额逐分一致 + 三处同源，单量破万再下推）；§八 映射表 P35 转「**已实装**」；e2e `§23` 新增 **61 条断言**；⑬ **M3-12 通知模板（P36 · D59–D60 · 新增第 27 张表 `ab_message_template`）**：§6.7 补 M3-12 实现口径表 —— ⭐ **存储选型：独立表而非塞进 `ab_config`**（`CONFIG_SPECS` 是**扁平标量**类型系统，撑不住「场景 + 多渠道 + 变量白名单 + 闸门」；且 `ab_message` 实为**推送日志**表，不是模板定义）+ ⭐ **场景定义是代码事实、不落库**（`scene`/渠道/触发时机/变量白名单/是否必推全在 `message-template.specs.ts`，落库必然漂移成「库里写着走微信群、代码只发订阅消息」）+ ⭐⭐ **「启用」闸门 fail-closed**（每个渠道有必要条件 `wechat_subscribe→模板ID` / `wechat_group→文案`，缺一即拒启用 `10001`，判定按**改动后最终状态**以防「先清空条件再单独 enabled=1」绕过；判定函数 `missingForEnable()` 由**管理侧与投递侧共用**）+ ⭐ **接线状态两级如实标注**（场景级 `wiring` live/pending 且 pending 必附原因；字段级 `fieldWiring` 区分 `live` 与 `record_only`，`groupContent` 属后者）+ ⭐⭐ **明写「微信订阅消息文案由微信公众平台侧定义」**（本页文案服务人工发群与台账，改它不会改变用户收到的订阅消息 —— 同 M3-10「给了输入框却没接上线」）+ **变量白名单**（`{{bad}}`→`10001`；只有**双**花括号算占位符，单花括号 `{3}` 不误伤自然文本）+ **只读字段拒绝而非静默忽略**（`forbidNonWhitelisted`）+ **「未传」≠「传 null」**（判据 `!== undefined`，见《缺陷与陷阱》#46）+ ⭐ **真消费点 = 退款结果通知**（`refund.service.ts` 两个执行口在**事务外**调 `MessageService.notify()` —— 事务里发通知而事务回滚就是「用户收到退款通知但退款未发生」；`notify()` 不抛异常）+ **未启用 = 不投递且不留日志**（`ab_message` 语义是「发过什么」）+ 落点登记（管理侧 `/admin/system/templates`；投递侧由 M3-12 实装原空模块 `MessageService`，删除 `wechat-template.service.ts` / `templates/index.ts` 两个零引用死占位）+ 错误码 **零新增**（闸门/变量/只读字段/空请求 → `10001`，目标不存在 → `10004`）；§八 映射表 P36 转「**已实装**」并补载体 `ab_message_template`；e2e `§24` 新增 **47 条断言**；⑭ **M3-13 财务端点（P34 · D33–D35 · 零 DDL · 零新增错误码）**：§6.5 补 M3-13 实现口径表 —— ⭐⭐ **D33 不自己算一套口径**（收入/成本/履约/毛利/逐日趋势**全部取 `StatsService.dashboard()`**，与 D47 看板**同一个函数**；e2e 用「五项与 D47 逐项相等」钉死，谁把它改回自己 `SUM(...)` 立刻红）+ ⭐ **逐日分项之和 === 区间总额**（同一份数据的两种切法）+ ⭐ **`range` 复用 `STATS_RANGES`**（不另立「日/周/月」；非法值 `10001` 不静默回落）+ ⭐ **`date` 是区间终点锚点而非自由起止**（期末对账要看已过完的那天；该入参同时给 D47–D50）+ ⭐ **时点量 vs 区间量分离**（余额/冻结/待入账佣金不随 `range` 变化，带 `asOf` —— 时点量被读成「本期新增负债」最误导人）+ `payable.generated` 按「**是否有有效行**」判定（实收 0 的日子也会出单）+ 四态 `payableStatus` 是给人看的+ 已退金额用 **SQL 子查询**（`ab_refund` 无 `meal_date`；且 SQLite 绑定变量上限 999，拼大 `IN` 列表会本地绿、换驱动炸）+ ⭐⭐ **D34 行内等级/费率是结算快照**（e2e 用「**同一个团长**三条佣金分别显示见习/正式/首席」证明它不可能是当前值）+ D34 扩展入参 `status`/`type`/`keyword` 与 `byLevel[]` 拆分 + ⭐⭐ **D35 = M4 `commission-settle.task` 的同一执行口**（不另写第二套入账逻辑）+ ⭐⭐ **一期 `pending` 常态为 0 并如实下发 `note`**（佣金在取餐确认时即时入账，「点了按钮 0 条」必须说清不是故障）+ ⭐ **D35 刻意不做补计佣**（`ab_order` 没有下单时刻的团长等级快照 → 只能拿当前等级算，晋级后会多算；结构性缺口，非实现 bug）+ ⭐⭐ **补账只改账、不改事实**（只加 `total_commission`，**不动** `total_orders`/`last_order_at`，否则污染 C2 晋级审计）+ **整批单事务 + 逐行 `affected` 判归属**（并发不重复加钱）+ 无归属进 `skippedReasons`（不猜不静默丢）+ 入账段**唯一**（`accrueForOrders` 与 `settlePending` 共用 `creditCommissions`，流水文案取**行快照**）+ D35 入参**不收金额**（否则就是往团长余额加钱的后门）+ 权限两级（类级含 `operator`、D35 收窄到 `admin/finance`；**不含 `viewer`**，与 D47–D50 刻意含 viewer 正好相反）+ 删除零引用死占位 `finance.controller.ts`；§八 映射表 P34 更新；e2e `§25` 新增 **33 条断言**；⑮ **M3-14 余额账户管理与调整（P34 · D38–D39 · M35-04 · 零 DDL）**：§6.5 补 D38/D39 实现口径表 + ⭐⭐ **负债合计复用 D33 的同一函数**（`FinanceService.loadLiability()`；两页各算一套 `SUM(ab_balance)` 漂移**不报任何错**，e2e 用「D38 `liability` ≡ D33 `liability`」写前写后各钉一次） + ⭐ **负债是时点量**（`pageSize` / `accountType` / `keyword` 都不改变它，`total` 才是筛选命中数） + D39 **四动作**（充值 / 扣减 / 冻结 / **解冻** —— 规范原只写三动作，「不能解冻的冻结是死钱」） + ⭐⭐ **冻结 / 解冻不动 `total_in` / `total_out`**（钱没进出平台，只是从「可用」挪到「冻结」，与 L12 提现「申请阶段不计入累计支出」同口径） + ⭐⭐ **余额不得为负**（扣减 / 冻结越界 → `40002`「钱不够花」；解冻越界 → **新码 `40015`**「冻结账对不上」，**两码刻意分开** —— 合流一个码，运维就分不清该让人充钱还是该查数据） + ⭐ **幂等键必填**（调账无业务单号，重复提交就是重复加钱：缺键 `10001` / 命中 `10006` + 首次结果） + **乐观锁** `WHERE id=? AND version=?`（并发调账不丢更新） + ⭐ **只有「充值」能自动建户**（其余动作无账户时明确报错，**不是**先建 0 余额账户再报余额不足 —— 否则库里凭空多一行「余额 0」账户，D38 账户数与 D33 `accountCount` 悄悄错开） + ⭐ **权限常量单一真相**（`BALANCE_ADJUST_ROLES` 同时驱动 `@Roles()` 与出参 `actions.canAdjust`，结构上消除「按钮亮着点了 `10003`」；项目既有写法多为两处硬编码 + 注释对齐，本批改为常量） + ⭐ **新枚举值 `ab_balance_log.type='adjust'`**（与原五值分开避免污染佣金汇总；已回写 §九扩展登记，并同步补 `BALANCE_LOG_TYPE_LABEL`，否则用户在自己的余额明细里看到裸英文） + 未知 `action` **fail-closed**（否则静默走完 switch 会写出「余额没变却多一条流水」的脏数据 —— 余额看着对、只有账本对不上） + D38 **无账户空视图**（`hasAccount=false` 含最近流水：搜不到人 → 不敢充值，而 D39 恰恰支持首充建户） + 筛选走 **SQL 子查询**（避开 SQLite 绑定变量上限 999）+ 手机号一律脱敏 + 余额降序 + ⚠️ 顺手修掉**前端菜单缺口**（`ADMIN_NAV` 财务域原只挂 `/finance/overview` 一个入口，其余 5 个子页服务端早已授权却点不到，运营只能手输 URL）；§八 映射表 P34 更新；e2e `§26` 新增 **34 条断言** |

---

## 一、总则

### 1.1 路径与角色域

| 域 | 前缀 | 谁在用 | 鉴权 | 说明 |
| --- | --- | --- | --- | --- |
| 公共 | `/api/v1/auth`、`/api/v1/home`、`/api/v1/traceability` | 小程序 | JWT（部分免登录） | 首页、溯源可匿名只读 |
| 用户 | `/api/v1/orders`、`/api/v1/me` | 小程序（role=user） | JWT | 下单、订单、个人中心 |
| 团长 | `/api/v1/leader` | 小程序（同 token + `isLeader=true`） | JWT + 团长身份校验 | **不单独签发 token**，团长是叠加身份（C7） |
| 供应商 | `/api/v1/supplier` | 供应商 Web | JWT（role=supplier） | 出餐、结算单、资料 |
| 运营后台 | `/api/v1/admin` | 运营后台 Web | JWT（role=admin） | 含 RBAC 菜单与操作日志 |
| 回调 | `/api/v1/pay`、`/health` | 微信平台 / 探针 | 微信签名校验 | **免 JWT**，走 `wx-signature.guard` |

### 1.2 统一响应结构

**成功（HTTP 200）**

```json
{
  "code": 0,
  "message": "ok",
  "data": { },
  "requestId": "req_1757850000000_a1b2c3",
  "timestamp": 1757850000000
}
```

**失败（HTTP 4xx / 5xx，`code` 非 0）**

```json
{
  "code": 30001,
  "message": "今日 24:00 已截单，明日请早",
  "data": null,
  "requestId": "req_1757850000000_a1b2c3",
  "timestamp": 1757850000000
}
```

> 规则：**HTTP 状态码表达"传输层结果"，`code` 表达"业务层结果"**。前端只按 `code === 0` 判成功；`message` 可直接 toast，但关键文案仍由前端按 `code` 覆写（避免服务端改文案导致端上措辞漂移）。
> `requestId` 由 `request-id.middleware` 注入，随日志与 APM 串联，前端出问题时可直接提供。

### 1.3 分页约定

**请求（Query）**：`page`（默认 1）、`pageSize`（默认 20，**上限 100**，超出按 100 处理）

**响应**

```json
{
  "code": 0,
  "message": "ok",
  "data": { "list": [], "page": 1, "pageSize": 20, "total": 123, "hasMore": true },
  "requestId": "req_...",
  "timestamp": 1757850000000
}
```

### 1.4 幂等约定

| 场景 | 机制 |
| --- | --- |
| 下单 | 请求头 `Idempotency-Key`（前端生成 UUID，**同一意图复用**；服务端 Redis 键 `idem:order:{key}` 保留 10 分钟） |
| 支付创建 | 同上，键 `idem:pay:{orderNo}` |
| 佣金 / 应付跑批 | 服务端以 `(meal_date, subject)` 唯一约束兜底，重复触发返回上一次结果 |
| 微信回调 | 以 `out_trade_no` / `out_refund_no` 天然幂等，重复通知返回 `{"code":"SUCCESS"}` |

> 重复请求命中幂等键时返回 `code: 10006`，`data` 携带首次结果（HTTP 200），前端按成功处理。

### 1.5 鉴权与令牌

**小程序登录链路（`wx-mini.strategy`）**

```
前端 wx.login() → code
  → POST /auth/wx-login { code, leaderCode? }
  → 服务端 code2session → openid/unionid → 建/取 ab_user
  → 若带 leaderCode，绑定推荐团长（写 ab_leader_invite.pending）
  → 签发 JWT（7 天）+ refreshToken（30 天）
```

**JWT Payload**

```json
{
  "sub": "10086",
  "role": "user",
  "isLeader": true,
  "leaderId": 7,
  "level": "chief",
  "buildingId": 3,
  "iat": 1757850000,
  "exp": 1758454800
}
```

| 字段 | 说明 |
| --- | --- |
| `role` | `user`（小程序，含团长叠加）/ `supplier` / `admin` |
| `isLeader` | 叠加身份开关；**不因升级/失效而重签 token 之外的权限**，每次敏感接口以 DB 的 `ab_team_leader.status` 为准 |
| `level` | `trainee` / `formal` / `gold` / `chief`（仅缓存，权威值在 DB） |

**刷新与登出**：`POST /auth/refresh`（传 refreshToken）、`POST /auth/logout`（吊销 refreshToken + Redis 黑名单）

> ⚠️ **团长身份判定纪律**：任何 `/api/v1/leader/*` 接口，`auth.guard` 解析 JWT 后**必须再查一次 `ab_team_leader`**，确认 `status = 1（在职）` 且 `building_id` 匹配，禁止仅凭 JWT 内的 `isLeader` 放行。

### 1.6 金额、时间与手机号

| 项 | 约定 |
| --- | --- |
| **金额** | 一律**整数分**（`int`），字段名以 `Fen` 结尾（`priceFen: 2580`）。前端负责 ÷100 展示。**禁止浮点** |
| **时间** | 传输用 **ISO 8601 带时区**（`2026-09-15T11:30:00+08:00`）；跨天统一按 **Asia/Shanghai** |
| **日期** | `mealDate` 用 `YYYY-MM-DD`，语义为**出餐日（T 日）** |
| **手机号** | 出参一律脱敏（`138****0001`）；完整手机号仅 `/api/v1/leader/orders` 的导出接口返回，且写操作日志 |
| **图片** | 返回 COS 完整 URL；上传走后端签发的临时密钥（`POST /api/v1/me/upload-token`） |

### 1.7 请求头

| 头 | 必填 | 说明 |
| --- | --- | --- |
| `Authorization` | 是 | `Bearer <jwt>` |
| `Content-Type` | POST/PUT 是 | `application/json` |
| `Idempotency-Key` | 下单/支付是 | UUID |
| `X-Request-Id` | 否 | 前端可注入，缺省由服务端生成 |
| `X-Client` | 是 | `miniprogram` / `supplier-web` / `admin-web` |

---

## 二、鉴权模块 `/api/v1/auth`

| # | 方法 | 路径 | 说明 | 入参 | 出参要点 |
| --- | --- | --- | --- | --- | --- |
| A1 | POST | `/auth/login` | 小程序登录（唯一入口） | `{ code, nickname?, avatarUrl?, inviteCode? }` | `{ token, isNewUser, isLeader, user:{id,nickname,avatarUrl,phone,buildingId,teamLeaderId}, leader:{…}\|null }` |
| A2 | POST | `/auth/admin-login` | 后台登录（供应商 / 运营同一接口，按账号角色返回） | `{ username, password, captcha? }` | `{ token, refreshToken, expiresIn, account:{id,username,name,role,roleLabel,supplierId,menus[]} }` |
| A3 | POST | `/auth/refresh` | 刷新令牌 | `{ refreshToken }` | 同 A2 出参（轮换 access + refresh） |
| A4 | POST | `/auth/logout` | 登出 | — | `null` |
| A5 | GET | `/auth/profile` | 当前登录者 | — | 小程序返回 `user`；后台返回 `account`（含 `menus` 供前端渲染） |
| A6 | GET | `/auth/me` | 小程序端便捷别名（等价 A5 的用户分支） | — | 同 A5 用户分支 |

> 后台登录失败 5 次锁定 15 分钟（`code: 20005`）；账号体系独立于小程序，见 ER `ab_admin_user`。
>
> **M3 实现口径**
>
> | 项 | 口径 |
> | --- | --- |
> | A1 路径 | 实装为 `/auth/login`（v1.0 曾写作 `/auth/wx-login`，无别名保留）。出参与旧稿差异：`nickname`（非 `nickName`）、`avatarUrl`；`isLeader/leader` 平铺在 `data` 顶层（便于端上直接切 tab），`refreshToken` 一期未下发（见 A3） |
> | **双主体隔离** | `typ` 声明主体类型（`user`/`admin`，**缺省视为 `user`** 以兼容 M1/M2 旧令牌）。`JwtAuthGuard` 按路径集中隔离：`/admin/*` 与 `/supplier/*` **只收 `typ=admin`**，其余端点 **只收 `typ≠admin`** → 越权方向返回 `10003`（用户打后台）与 `10002`（后台打用户端）。**两套账号表 id 各自自增，不隔离即静默越权**。另：`/auth/profile` 与 `/auth/logout` 为**主体无关端点**，两种令牌都收，由 A5 按 `typ` 分流 |
> | A2 失败与锁定 | 校验顺序：**① 锁定闸门 ② 账号存在性与口令 ③ 账号状态**。①②失败同为 `20005`（不区分「账号不存在」与「密码错」→ 防用户名枚举），文案带剩余次数；锁定后即使口令正确也拒绝（否则响应差异会变成密码 oracle）。口令正确但账号停用 → `20006`。锁定计数落 KV `admin:login:fail:<username>`，**窗口 TTL 只首次落**（否则攻击者每 14 分钟失败一次即可永久锁死账号） |
> | A2 令牌有效期 | access `ADMIN_JWT_EXPIRES_IN`（默认 **12h**，短于小程序的 7d —— 后台是高权限面）；refresh `ADMIN_REFRESH_EXPIRES_IN`（默认 7d） |
> | A3 范围 | **一期仅服务后台**：小程序 A1 未下发 `refreshToken`，端上无值可传。用 **access token** 调本接口 → `10003`（否则「快过期令牌换新令牌」= 永不过期）；`rt=true` 的刷新令牌打业务端点 → `10002`。刷新时**重新查库**，角色变更/停用即刻生效 |
> | A4 | **服务端无状态，不吊销任何令牌**（JWT 无状态；靠短 TTL + 前端清态）。这是**有意为之而非缺陷**，已在此显式记录，避免后人反复「修」它 |
> | A5 | 每次**查库**取最新 `menus`，是前端刷新页面重建侧边栏的唯一来源；也是独立于 `AdminGuard` 的第二条账号状态防线（停用账号的旧令牌打 A5 → `20006`） |

---

## 三、用户端接口（小程序 · role=user）

### 3.1 首页与浏览（M01）

| # | 方法 | 路径 | 说明 | 关键出参 |
| --- | --- | --- | --- | --- |
| U1 | GET | `/home/daily` | 明日套餐 | `{ mealDate, publishAt, cutoffAt, canOrder, countdownSec, dishes:[{name,image,category,supplierName}], rice, priceFen:2580, leader:{id,name,building,floor} }` |
| U2 | GET | `/home/history` | 历史套餐归档（M01-02） | 分页 `{mealDate, dishes[], priceFen, ordersCount}` |
| U3 | GET | `/leader/invite/{leaderCode}` | 团长邀请落地（M01-03） | `{ leaderName, building, floor, slogan }`（**免登录**） |
| U4 | GET | `/me/upload-token` | COS 临时上传密钥 | `{ credentials, bucket, region, expiredAt }` |

> **U1 倒计时口径**：`canOrder` 以服务端为准（截单前 10 分钟即 `false`，见 `ab_config.order.cutoff_window_minutes`）；`countdownSec` 为距 `cutoffAt` 秒数，前端只做展示，**下单前必须以 U1/下单接口的 `canOrder` 复核**。

### 3.2 今日这盒 · 商家溯源（M01-04 · C8）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| U5 | GET | `/traceability/today?buildingId=&mealDate=` | 本餐实际出品方聚合（**只读**） |

**出参**

```json
{
  "mealDate": "2026-09-15",
  "dishes": [
    {
      "dishName": "红烧肉", "category": "主菜", "imageUrl": "...",
      "supplier": { "name": "三味屋", "qualifications": ["food_business_license","business_license","health_cert"] }
    }
  ],
  "distributionCenter": { "name": "集散中心 1（国贸片）", "address": "北京市朝阳区…" },
  "takeoutLinks": [
    { "platform": "meituan", "label": "美团", "url": "https://..." }
  ],
  "traceNote": "本餐 4 道菜由 4 家供应商分别出品，均通过食品经营许可、营业执照、从业人员健康证三重核验。"
}
```

> **硬约束（C8）**：出参**严禁**包含 `status`（合作中/备选）、`commission`、`shareRate`、备选商家清单、供应商联系方式。数据由后台「套餐编排 + 供应商管理」驱动；缓存 TTL ≤ 5 分钟（Redis `trace:{buildingId}:{mealDate}`）。

### 3.3 下单与支付（M02）

| # | 方法 | 路径 | 说明 | 幂等 |
| --- | --- | --- | --- | --- |
| U6 | POST | `/orders` | 创建订单 | ✅ |
| U7 | POST | `/orders/{orderNo}/pay` | 创建微信支付单（JSAPI） | ✅ |
| U8 | GET | `/orders/{orderNo}/pay-result` | 支付结果（前端轮询/回跳） | — |

**U6 请求**

```json
{
  "mealDate": "2026-09-15",
  "quantity": 1,
  "remark": "不要香菜",
  "useBalanceFen": 0,
  "leaderCode": "LDR0007"
}
```

**U6 业务校验顺序（服务端）**

1. `canOrder`（截单窗口）→ 否则 `30001`
2. 份数 1–N（`ab_config.order.max_quantity`，默认 20）→ 否则 `30002`
3. 团长存在且 `status = 1（在职）` → 否则 `30007`
4. 余额抵扣 ≤ 可用余额 → 否则 `40002`
5. 写 `ab_order`（`status='pending_pay'`）+ 冻结余额（如有）+ 返回 `orderNo`

**U7 响应**：`{ timeStamp, nonceStr, package, signType:"RSA", paySign }`（小程序 `wx.requestPayment` 直接可用）

### 3.4 订单管理（M03）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| U9 | GET | `/orders?status=&page=&pageSize=` | 我的订单列表（M03-01，按 `mealDate` 倒序） |
| U10 | GET | `/orders/{orderNo}` | 订单详情 + **状态机时间线**（M03-02） |
| U11 | POST | `/orders/{orderNo}/cancel` | 自助取消（M03-03，**仅 `pending_pay` / `paid` 且未截单**） |

**U10 时间线出参**

```json
{
  "orderNo": "AB2026091500071234",
  "status": "delivering",
  "statusText": "配送中",
  "timeline": [
    { "node": "paid",       "at": "2026-09-14T20:31:00+08:00", "done": true,  "text": "支付成功" },
    { "node": "cut_off",    "at": "2026-09-15T00:00:00+08:00", "done": true,  "text": "已截单" },
    { "node": "cooked",     "at": "2026-09-15T09:28:00+08:00", "done": true,  "text": "已出餐" },
    { "node": "delivering", "at": "2026-09-15T11:02:00+08:00", "done": true,  "text": "配送中" },
    { "node": "delivered",  "at": null, "done": false, "text": "预计 11:30 送达" },
    { "node": "completed",  "at": null, "done": false, "text": "待确认收货" }
  ],
  "pickup": { "point": "国贸三期 B 座 1 楼大堂", "leaderName": "李明", "leaderPhone": "138****0007" }
}
```

**U11 错误**：截单后调用 → `30003`，`message` 引导「截单后请联系团长协助退款」，并附 `data.leaderContact`。

### 3.5 个人中心（M04）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| U12 | GET | `/me` | 用户信息（含所属团长、办公楼） |
| U13 | GET | `/me/balance` | 可用余额（**单位分**） |
| U14 | GET | `/me/balance/logs?type=&page=` | 余额明细（M04-03） |
| U15 | POST | `/me/subscribe` | 上报订阅消息授权结果（模板 ID 列表） |
| U16 | GET | `/me/agreements?type=user\|privacy` | 用户协议 / 隐私政策正文（M04-06） |
| U17 | GET | `/me/support` | 客服入口配置（**一期：客服微信号 + 服务时间**） |

**U17 一期口径（2026-09-15 裁定）**

一期**不做在线客服**：所有「联系客服 / 联系运营」入口（**退出团长**、余额争议、提现异常等）统一跳「客服微信号」页面，由用户**手动添加客服微信、人工解决**。

```json
{
  "wechatId": "abox_service",
  "wechatQrcodeUrl": null,
  "phone": null,
  "hours": "工作日 9:00 – 18:00",
  "tips": "添加客服微信后，请备注「ABox + 你的姓名」，我们会尽快为你处理。"
}
```

> ⚠️ 全部字段由 `ab_config`（`service.*`）下发，**代码不得写死任何联系方式** —— 与「成本项不得写死」同一条纪律。运营在后台系统配置页维护即可换号。
> ⚠️ `wechatQrcodeUrl` 未配置时**返回 `null`**，端上据此隐藏图片位；**不得用 Logo 或占位图冒充真码**（否则联调会误判已打通）。

---

## 四、团长端接口（小程序 · `isLeader=true`）

> 全部接口经 `auth.guard` + **团长身份二次校验**（见 §1.5 纪律）。

### 4.1 工作台（M11）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| L1 | GET | `/leader/workbench` | 今日战报 + 明日进度（M11-01/02） |
| L2 | GET | `/leader/share` | 分享物料（小程序路径、海报底图、邀请码）（M11-03） |
| L3 | POST | `/leader/share/qrcode` | 生成带团长 ID 的小程序码（返回 COS URL） |

**L1 出参**

```json
{
  "today": { "mealDate":"2026-09-14", "orderCount":45, "refundCount":1, "amountFen":116100, "commissionFen":13932, "level":"chief", "rate":0.12 },
  "tomorrow": { "mealDate":"2026-09-15", "orderedCount":32, "cutoffAt":"2026-09-15T00:00:00+08:00", "canOrder":true },
  "pickup": { "point":"国贸三期 B 座 1 楼大堂", "status":"delivering", "expectAt":"11:30" }
}
```

> 佣金字段口径：`commissionFen` 按**实发份数**（当日 `completed` 订单份数，剔除已退款）计算，与《订单状态机》§4 一致。

### 4.2 订单聚合（M12）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| L4 | GET | `/leader/orders?mealDate=&status=&page=` | 所辖订单列表（**手机号脱敏**）（M12-01） |
| L5 | GET | `/leader/orders/export?mealDate=` | 导出 Excel（**完整手机号 + 写操作日志**）（M12-02） |
| L6 | GET | `/leader/orders/abnormal?mealDate=` | 异常订单（待支付催促）（M12-03） |
| L7 | POST | `/orders/{orderNo}/refund-apply` | **团长代退申请**（M12-04 · C6 第一段） |

**L7 请求**：`{ reason, reasonType, remark }`（`reasonType` ∈ `quality` / `missing` / `late` / `wrong` / `other`）

> ⚠️ **C6 口径**：此接口**只创建申请**（写 `ab_refund`，`status='applying'`），**不退款、不动任何账务**（申请阶段资金零变动 · C6；⚠️ 2026-09-16 自营口径：实际退款时也**不再冲减供应商应付**，见 §6.5）。实际退款在后台审批通过后由 `finance/refund.service` 执行（见 §6.5）。

### 4.3 取餐与确认（M13）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| L8 | GET | `/leader/pickup/today` | 本楼今日取餐（总份数、配送状态、成员列表）（M13-01） |
| L9 | POST | `/leader/pickup/confirm` | 确认收货并分发（M13-03，**幂等**） |

> L9 可选传 `{ orderNos: [] }` 局部确认；缺省为"全部确认"。14:00 由 `auto-confirm.task` 兜底。

### 4.4 佣金与提现（M14）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| L10 | GET | `/leader/commissions?range=day\|month&date=` | 佣金明细（M14-01） |
| L11 | GET | `/leader/balance` | 团长余额（提现/消费前的可用额） |
| L12 | POST | `/leader/withdraw` | 提现申请（M14-03，**≥ ¥10.00**） |
| L13 | GET | `/leader/withdrawals?page=` | 提现记录（M14-04） |
| L19 | GET | `/leader/balance-logs?type=&page=` | 余额流水（P17；与 L11 余额可相互验算） |

**L12 错误**：低于最低额 → `40003`（`data.minFen: 1000`）；未绑定收款方式 → `40007`；可用余额不足 → `50004`。

**L12 幂等（2026-09-15 定）**：提现属**资金操作**，请求头 `Idempotency-Key` **必填** ——
缺失 → `10001`；重复提交 → `10006` + 首次结果（端上按成功处理，**不会重复冻结**）。

> 幂等键在**业务失败时会被服务端释放**（删除占位键），故失败后同键可立即重试；
> 成功结果缓存 10 分钟。端上口径：「一次提交意图一个 key」，成功后须换新 key，
> 否则下一笔会被回放成上一笔的结果。

**L19 口径**：`amountFen` **恒为正数**，收支方向看 `direction`（`1` 收入 / `-1` 支出）
—— 与 L10 佣金明细「冲销笔存负数」相反，端上切勿混用同一套渲染逻辑。
`summary`（收 / 支 / 净额 / 条数）按**全量**统计，不受分页影响。

> L19 落的是 `ab_balance_log`：佣金入账、下单抵扣、提现冻结（`direction=-1`）、退款回退
> 都会逐笔留痕并带 `balanceAfterFen`，因此**流水净额应与 L11 的 `balanceFen` 相等**（可作联调自检）。

### 4.5 团长管理（M15）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| L14 | GET | `/leader/profile` | 团长资料（M15-01） |
| L15 | PUT | `/leader/profile` | 修改资料（手机号、楼层；办公楼变更需后台审核） |
| L16 | GET | `/leader/level-rules` | 4 级佣金规则 + **C2 双条件**升级门槛（M15-02） |
| L17 | POST | `/leader/apply` | **申请成为团长**（C3：**提交申请即生效**） |
| L18 | POST | `/leader/agreement` | 勾选同意《团长合作协议》（记录签署时间/IP/版本号） |
| L20 | POST | `/leader/quit` | **退出团长身份**（M2-2.8；停职保留档案，资金未清 → `20008`） |
| L21 | GET | `/leader/invites?page=` | **我的推荐**（邀请明细 + 转正汇总，M2-2.9） |
| L22 | POST | `/leader/level/audit` | **重新核算我的晋级**（月单 + 介绍转正 → 落表并升级，M2-2.9） |

**L17 业务（C3 · 无审核）**

```
前端：勾选协议复选框（不勾不可提交）
  → POST /leader/apply { buildingId, phone, floor, realName, agreementVersion }
  → 校验协议已勾选 → 建 ab_team_leader（level='trainee', status = 1（在职））
  → 立即写入 ab_leader_invite（inviter 为空，self_apply）
  → 返回 isLeader=true，前端 setIsLeader(true) 重渲染 tabBar（5 项）
```

**L17 出参**

```json
{
  "isLeader": true,
  "leader": {
    "id": 6, "level": "trainee", "levelLabel": "见习", "commissionRate": "0.0800",
    "floor": "12F", "buildingId": 1, "buildingName": "国贸三期 A 座",
    "status": 1, "agreedAt": "2026-09-15T10:00:00+08:00", "agreeVersion": "v1.0"
  }
}
```

> ⚠️ **入参含 `realName`**（2026-09-15 补）：`ab_team_leader.real_name` 为 `NOT NULL`，原型申请表单也要求填「公司 + 姓名」，此前契约漏写该字段 —— 缺失即 10001。
> ⚠️ **在职判据为 `status = 1`**（tinyint，2026-09-15 裁定以实体为准）；全表状态位统一 tinyint，不再使用字符串 `'active'`。

> **见习团长 30 天未促单自动取消资格**：由每日任务 `leader-expire.task` 扫描 `last_order_at` 判定（C2）。
> 第三方 CA 电子签列入二期，本期以"勾选 + 服务端留痕"为准。

### 4.6 团长晋级（C2 双条件）

**L16 出参**

```json
{
  "levels": [
    { "key":"trainee","name":"见习团长","rate":0.08,"condition":"提交申请即生效" },
    { "key":"formal", "name":"正式团长","rate":0.09,"condition":"月单 > 30 且 介绍 1 名转正团长" },
    { "key":"gold",   "name":"金牌团长","rate":0.10,"condition":"月单 > 60 且 介绍 2 名转正团长" },
    { "key":"chief",  "name":"首席团长","rate":0.12,"condition":"月单 > 100 且 介绍 3 名转正团长" }
  ],
  "mine": { "level":"chief", "monthOrders":186, "invitedFormalCount":5, "nextLevel":null, "progress":1.0 },
  "expireRule": "见习团长 30 天未促成订单自动取消资格"
}
```

> **条件语义**：「月单」指自然月已完成订单**份数**；「介绍 N 名转正团长」指经本人邀请码注册且**已升级为正式及以上**的团长数。二者**须同时满足**（AND）。

**L22 晋级审计口径（M2-2.9）**

等级与费率是**结果值**，由指标**推导**并落库，不得手改：

| 项 | 取数口径 |
| --- | --- |
| 月单 | 当自然月 `ab_commission` 的份数合计（按 `meal_date` 归月，只算 `status='settled'`）；计佣基数本就是**实发份数**，故天然等于「本月已完成份数」。`type='reversal'` 按**负数量**折算 |
| 介绍转正数 | `ab_leader_invite` 中「本人邀请 且 `is_formal=1`」的条数，与 `ab_team_leader.invited_formal_count`（后台可人工修正）**取大** —— 与 L16 呈现口径一致，避免「看得到晋级却升不了级」 |
| 只升不降 | 审计只在目标等级**严格高于**当前等级时升级；降级仅由 `leader-expire.task`（见习 30 天未促单）或后台人工操作触发 |
| 落表 | 即使未升级，`month_orders` / `invited_formal_count` 也**无条件回写**（否则 P16 进度条永远读陈旧种子值） |
| 链式 | 被邀请人升到「正式及以上」→ `is_formal` 翻转为 1 → 邀请人「介绍转正数」+1 → **立即复算邀请人**（递归深度上限 4，防 A↔B 数据环）。回执含 `inviterAudit` |
| 幂等 | 全部按当前值重算后条件更新，重复执行结果一致，不产生重复流水 |

### 4.7 退出团长身份（M2-2.8）

```
POST /leader/quit   【Idempotency-Key 必填】  body: { reason? }
  → ① 资金闸门（任一不满足 → 20008，data.blockers 逐条下发）
        · 可用余额未清零        BALANCE_NOT_CLEARED
        · 冻结余额未清零        FROZEN_NOT_CLEARED
        · 存在在途提现申请      WITHDRAW_IN_FLIGHT
        · 存在待结算佣金        COMMISSION_PENDING
  → ② 单事务：ab_team_leader.status = 2（停职） + ab_user.team_leader_id = NULL
  → ③ 返回 isLeader=false，端上把底栏还原为 4 项
```

> **语义：停职而非删除。** 订单 / 佣金 / 推荐关系 / 协议留痕**全部保留**，`level` 也不清空（历史等级快照仍可在「我的」查看）；`ab_user.building_id` **保留** —— 他仍是该办公楼用户，明天照样能订餐。
> **退出不是终点：** 再次 `POST /leader/apply` 即可复职，但**重置为见习 8%**（C2 阶梯从头走，避免停职期间白拿高费率）。
> **退出后身份立即失效：** 全部 `/leader/*` 返回 `20003`（`LeaderGuard` 二次查库，**token 未过期也拦**）。
> ⚠️ 由于 NestJS **守卫先于拦截器**执行，退出成功后再用同键重放会先被守卫拦成 `20003`（而非 `10006`）—— 状态已不可逆，两者对端上等价；`Idempotency-Key` 在此防的是**并发双击**与**失败后重试**（失败即释放占位键）。
> 退出/资金争议的人工兜底通道即 **U17 客服微信号**。

---

## 五、供应商端接口（供应商 Web · role=supplier）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| S1 | GET | `/supplier/workbench?date=` | 今日待生产份数 + 备料清单（M21-01） |
| S2 | POST | `/supplier/meal/cook-confirm` | 出餐确认（M21-02，**须在 09:30 前**） |
| S3 | GET | `/supplier/packing-tasks?date=` | 集散中心打包任务（M21-03，仅集散型/混合型可见） |
| S4 | GET | `/supplier/dishes` | 我的菜品库（M22-01） |
| S5 | POST | `/supplier/dishes` | 新增菜品 |
| S6 | PUT | `/supplier/dishes/{id}` | 编辑菜品 |
| S7 | POST | `/supplier/dish-applications` | 上架申请（申请参加某日套餐）（M22-02） |
| S8 | GET | `/supplier/history?page=` | 历史供应记录 + 好评率（M22-03） |
| **S9** | GET | **`/supplier/settlement?date=`** | **应付结算明细 / 自查**（日明细 + **跨日期待付合计**）（M23-01 · **已实装** M3-9） |
| S10 | GET | `/supplier/settle-account` | **对公结算账户**信息（M23-02） |
| S11 | POST | `/supplier/invoices` | 月度开票申请（M23-03） |
| S12 | GET | `/supplier/profile` | 商家资料 + 资质（M24-01） |
| S13 | PUT | `/supplier/profile` | 更新资料（资质变更需重新审核） |
| S14 | GET | `/supplier/agreement` | 供应商协议与结算规则（M24-02） |

---

#### M3-8 实现口径（S1–S3 · 供应商端出餐链路）

> **实现状态**：`S1 / S2 / S3` **已实装**（M3-8）。
> 落点 `apps/api-server/src/modules/supplier/{supplier.controller.ts, supplier.service.ts, dto/supplier.dto.ts}`；
> 视图 P21 `/supplier/workbench` · P22 `/supplier/cook-confirm` · 打包任务 `/supplier/packing`（`apps/admin-web/src/views/supplier/`）；
> 验收 `scripts/e2e-m3.mjs` **§20**（**不依赖下单窗口** —— 超时用例用「昨日」构造，见下）。

**主体与隔离**：`@Controller('supplier')` + `AdminGuard` + `@Roles('supplier')`；
数据范围由 token 里的 `supplierId` 收窄，**请求体刻意不接受 `supplierId`**（带了即 10001）——
收下这个字段就等于允许「A 供应商改 B 供应商的计划」。运营账号（`super_admin`）打 `/supplier/*` 同样 10003。

**生产计划是派生的，但必须落库（惰性 ensure）**：

```
ab_meal_assignment(status=active) × ab_set_meal_item
   → 按 (供应商, 菜, 集散中心) 聚合 sold_count
   → ab_supplier_dish_daily（日总量 · 父行）
   → ab_supplier_dish_center_daily（分中心明细）
```

| 口径 | 规定 |
| --- | --- |
| 生成时机 | **首次访问 S1/S2 时惰性生成**（只生成该主体）；**S3 生成全量**（闸门要看到所有供应商的到位情况，漏一家则「已到齐」是假象） |
| 冻结 | 父行**生成即冻结**，重复调用**不重算** —— 生产计划是给供应商的承诺数，截单后改单不能让备料量在背后变化（改单后要刷新计划属运营动作，**待办**） |
| 零产量 | **只生成 `planQuantity > 0` 的行** —— `status=active` 但 `sold_count=0` 的分配很常见，照单生成会让 P21 长出一串「0 份」的菜 |
| `unit_price` | 取 `ab_dish.cost_price`（**菜品属性**），不取 `ab_set_meal_item.share_amount` —— 供价是「逐菜协商」的菜品属性，同一道菜在不同套餐里不应有两个供价 |

**S2 出餐确认（09:30 是 deadline，不是 earliest）**：

| 项 | 规定 |
| --- | --- |
| 语义 | 出餐日当天 09:30 **之后不许确认**；**提前确认允许**（备好即可报）。09:30 是集散中心开始打包的上游时点 |
| 过期 | **fail-closed**：`COOK_CONFIRM_OVERDUE`=**50009**，不接受「补确认」把错过的时点抹平 —— 时间戳必须诚实，对账与追责都以它为准 |
| 粒度 | **(菜, 集散中心)** 逐项确认 —— 与原型 P22 逐卡勾选一致（红烧肉 385 份 → 4 个中心各 120/96/88/81） |
| 幂等 | 已确认项原样进 `skipped`，**不报错、不改时间戳**（网络重试是常态，不该显示「失败」） |
| 实送份数 | `actualQuantity` **不传 = 足额送达**；传了以申报值为准（短送留痕是对账依据） |
| 父行状态 | 由明细**派生**：无确认 → `pending`、部分 → `cooking`、全部 → `done`（+`completed_at`）。**沿用既有三值域，不新增 `partial`** |
| 校验顺序 | 资质（**50001**）→ 时间（50009）→ 生产计划存在（**50010**）→ 配送范围（**50011**）。先判「有没有资格」，再判「来不来得及」 |

**S3 打包任务**：

| 项 | 规定 |
| --- | --- |
| 可见性 | 名下**有启用中集散中心**才 `visible=true`；否则 `visible=false` + `reason`（**HTTP 200** ——「你没有这项任务」是正常状态，不是错误） |
| 闸门 | `ready=true` 仅当该中心当日**所有**菜品均已确认送达；否则 `blockers` 列出欠的供应商与菜品 —— 未到齐就开包会包出缺菜的餐 |
| 路线 | `R1…Rn` 按「主集散中心 id 升序」派生（与 D13 `delivery-map` **同口径**），站点按楼栋 id 升序；份数 = 所服务楼群当日已售份数之和 |
| **不返回** | **距离与单段时长** —— 无地图数据，原型上的 km/分钟是演示值，写进接口就是对外承诺 |

**S1 出参要点**：`supplier.canServe`（合作中 ∧ 资质已通过 ∧ 证照未过期，**与 D23 同一判据**）、
`deadline.{text,at,overdue,canConfirm}`、`summary.empty`（当日没派到计划 → 端上走空态，不显示全 0 表格）、
`notes`（口径说明由服务端下发，端上不自己编文案）。金额出参为**整数分**（`unitPriceFen`）。

**S9 应付结算口径（⚠️ 2026-09-16 自营裁定版 · 取代原 2026-09-15 版 · 详见《ABox一盒自营结算口径定义v1.0.md》）**

| 项 | 口径 |
| --- | --- |
| 结算性质 | **半成品采购应付**（B2B 采购），**不是分账**。供应商是供货方，不是入驻商户 |
| 计费基数 | **实收量** = `ab_supplier_dish_daily.actual_quantity`（S2 出餐确认申报值；未申报则 = 计划量）。**不是订单销量** |
| 单价 | 该供应商该菜品的**协商采购价**（`ab_dish.cost_price`，逐菜逐供应商议定，非固定） |
| 金额 | `quantity × unit_price`；出单粒度 = (供应商, 菜品, 出餐日) 一行 |
| 场地费 / 打包人工 / 配送费 | **不再是对外应付** —— 三者均属 ABox 自身成本（自有场所摊销 / ABox 用工 / ABox 履约），**不出付款单**，只进成本核算 |
| 冻结项 | `payee_type='distribution_center'` **冻结**：历史数据可读，**新单不再产生** |
| fail-closed | 该日该菜品父表 `status != 'done'`（出餐确认未完成）→ **不出单**，进「未出单异常清单」。此时 `actual_quantity` 只覆盖已确认明细，按它出单会**少付**、按计划补齐会**多付**，两种猜法都在钱上出错 |
| 幂等 | 同一 `(供应商, 菜品, 出餐日)` 只应有一行有效 `type='normal'`；跑批可重跑（补上先前跳过的行），键冲突不重复出单 |
| ⭐ 退款 | **用户退款不冲减供应商应付**（半成品出餐日已交付）。`type='reversal'` 改义为「应付单生成后发现算错」的**纠错冲销**，不再由退款触发 |
| 对账 | 供应商看到的实收量以其 S2 确认动作（`confirmed_at` / `confirmed_by` / `remark`）为准；回单号为付款完成唯一凭证 |
| 可见性 | **供应商端禁止出现**终端售价 ¥25.80 / 佣金 / 毛利 / 成本合计（不变量 I1：B2B 采购只该看到「我的价 × 我的量」） |

**付款方式不变**：本接口只做「应付金额计算与状态展示」—— 实际付款由财务走**人工对公转账**（系统不做任何支付通道调用），故状态是 `待付 / 已付 / 已冲减`，而非「分账成功 / 失败」。自营下**须索取增值税发票**（`invoice_no` 为税前扣除凭证）。

**M3-9 实现口径（S9 · 供应商端结算自查）**

> **实现状态**：**S9 已实装**（M3-9）。落点 `apps/api-server/src/modules/supplier/supplier.controller.ts`（`GET /supplier/settlement`）
> —— **刻意复用财务侧** `SupplierShareService.supplierView()`，而不是在供应商模块里再读一遍表：应付行的结构与状态文案只有一份实现，
> 就不会出现「运营看到的数」与「供应商看到的数」不一致。代价是 supplier 模块 → finance 模块的**单向依赖**（无循环）。
> 视图 P25 `/supplier/settlement`（`apps/admin-web/src/views/supplier/settlement.vue`）；验收 `scripts/e2e-m3.mjs` **§21**。

| 项 | 口径 |
| --- | --- |
| 路径偏离登记 | 文档原规划 `/supplier/shares`，实装为 **`/supplier/settlement`** —— 供应商端 `/supplier/shares` 与运营端 `/admin/supplier-shares` **仅差一个前缀**，正是双主体最容易看错的一对；用 `settlement` 在**命名层**把「供应商自查」与「平台结算台」分开（与 `/admin/suppliers` ↔ `/supplier` 的既有处理同思路）。⚠️ 页面上「供应商结算/资料」模块编号仍是 **S9**（`S4` 已被「我的菜品库」占用，不得借用） |
| 数据范围 | 由 token 内 `supplierId` 收窄，**请求体不收 `supplierId`**（带了即 `10001`）；查询恒带 `payee_type='supplier'` —— 即便将来出现别的应付主体，供应商也读不到 |
| `date` 缺省 | 缺省取**今日（北京时间）**；出单在 T+1 凌晨，故「当日无单」是正常态 → `empty=true` + 空列表（**HTTP 200**，不走报错分支） |
| 两个待付数 | `pendingAmountFen` = **该日**待付；`pendingTotalAmountFen` + `pendingTotalRowCount` = **不限日期**的待付合计。供应商真正关心的是「平台还欠我多少」，只给单日数等于逼他自己累加（e2e 用「增量 + 库内对照」双口径验证，不写死金额） |
| 枚举下发 | 状态文案由服务端下发（`statusOptions`），端上不维护第二份 |
| I1 落地位置 | 出参**结构里就没有**售价 / 佣金 / 毛利 / 成本项（不是靠前端隐藏）—— e2e §21 逐字段扫描断言 |

---

## 六、运营后台接口（运营后台 Web · role=admin）

### 6.1 套餐编排（M31）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| D1 | GET | `/admin/meal/matrix?startDate=&endDate=` | 日期 × 楼群 二维矩阵（M31-01） |
| D2 | POST | `/admin/meal/assignments` | 创建套餐分配（M31-02） |
| D3 | PUT | `/admin/meal/assignments/{id}` | 编辑分配 |
| D4 | POST | `/admin/meal/assignments/{id}/publish` | 上架 / 下架（M31-03） |
| D5 | POST | `/admin/meal/assignments/copy` | 批量复制（某日 → 某周 / 指定日期集） |
| D6 | GET | `/admin/meal/templates` | 套餐模板库（M31-04） |
| D7 | POST | `/admin/meal/templates` | 存为模板 |
| — | GET | `/admin/meal/dishes?keyword=` | **扩展**：菜品选择器（D7 编排页候选菜品 · 只读） |
| — | GET | `/admin/meal/distribution-centers` | **扩展**：集散中心选择器（D2/D3 前置 · 只读） |

> **实现状态**：D1–D7 **已实现**（M3-2，`apps/api-server/src/modules/meal/meal-admin.*`），验收脚本 `scripts/e2e-m3.mjs` §14。
> **权限**：类级 `@Roles('super_admin','admin','operator')` —— 套餐编排是运营的日常动作，财务与只读观察者不该有写权限。前端菜单过滤只是体验层，服务端白名单才是边界。
> **两个扩展选择器**为何挂在本模块而不在 `admin/supplier/*`：菜品的**管理**属 D23–D32（供应商模块），但这俩接口只做**只读挑选**；编排页不该依赖尚未落地的模块。

**D1 出参（矩阵）**

```json
{
  "startDate": "2026-09-15",
  "endDate": "2026-09-21",
  "dates": ["2026-09-15","2026-09-16"],
  "groups": [{ "id":1, "name":"国贸三期组", "buildingIds":[1,2,3,4],
               "assignedBuildings":[1,2,4], "emptyBuildings":[3] }],
  "cells": [
    { "mealDate":"2026-09-15", "groupId":1, "assignmentId":5,
      "setMealId":1, "setMealName":"红烧肉套餐", "setMealPriceFen":2580,
      "status":"active", "statusHint":"已上架", "dishCount":4,
      "distributionCenterId":1, "distributionCenterName":"集散中心 1（国贸/建外）",
      "assignedBuildings":[1,2,4], "emptyBuildings":[3],
      "soldCount":45, "cutoffPassed":false, "canPublish":true }
  ],
  "stats": { "dateCount":2, "groupCount":5, "cellCount":10,
             "assignedCells":5, "publishedCells":3, "emptyCells":5, "totalSold":45 },
  "note": "assignedBuildings = 楼群内「合作中」办公楼；emptyBuildings = 停用 / 待分配办公楼（UI 以禁用复选框呈现）。…"
}
```

> ⚠️ **矩阵单元格的 C 座口径**：`emptyBuildings` 表示该楼群内**未分配**的办公楼。原型 P27 中 C 座（龙湖 · 待分配）即此语义，UI 上以禁用复选框呈现，**与 P37 办公楼管理的状态一致**。
>
> ⚠️ **`ab_meal_assignment` 的粒度是「出餐日 × 楼群」**，没有「楼栋级分配」表。因此 `assignedBuildings` / `emptyBuildings` 是**派生值**：楼群内 `status=1`（合作中）算已分配，`status≠1`（停用 / 待分配）算未分配。种子数据里国贸组 C 座 `status=2` → 落进 `emptyBuildings`。

**M3-2 实现口径（勿推翻）**

| 主题 | 口径 | 为什么 |
| --- | --- | --- |
| D1 返回范围 | **完整网格**：`cells.length = dates.length × groups.length`，无分配的格子 `assignmentId=null` | 只回「有分配的格子」，运营就看不出**哪几天漏排了** —— 空格子本身就是信息 |
| 单次查询上限 | 跨度 ≤ 31 天；且 `日期数 × 楼群数 ≤ 400` 格 | 防止「查一年」把网格一次吐出 |
| **创建 ≠ 上架** | D2 建出来是 `pending`（用户端文案「该办公楼今日未开团」）；必须再走 D4 `publish` 才变 `active`、用户端才 `canOrder=true` | 编排可以提前几天做，开团是临近时的动作。两步分离不是冗余 |
| 唯一性 | 同一「出餐日 × 楼群」唯一（`uk_meal_assignment_date_group`）；重复创建 → **30011** | 唯一的业务化。已 `cancelled` 的历史行会被**复用**（唯一索引占着位），不新建 |
| D3 只改两项 | 只能改 `setMealId` / `distributionCenterId` | 改「出餐日 / 楼群」等于换成另一条分配，语义是删旧建新；混进 PUT 会让幂等与操作日志的「改前值 / 改后值」失去意义 |
| D3 截单闸门 | 已过截单（T 日 00:00）的分配不可修改 → **30003** | 订单已产生，改套餐会让「用户买到的」与「后台记的」不一致 |
| D4 上架闸门 | 已过截单时刻不许上架 → **30013** | 放行 = 用户端显示可下单、下单必被截单硬闸（30001）拦下 —— 等于**让运营亲手造一个「看得见点不动」的套餐** |
| D4 下架 | **不设**截单闸门 | 紧急下架是安全阀（套餐出问题要立刻停止接单）。已产生的订单不受影响，退款走 D11 |
| D4 幂等 | 重复同向操作返回当前状态，**不报错** | 运营双击按钮不该看到红字。这与「按 `Idempotency-Key` 去重」是两套机制，状态迁移本身天然幂等 |
| D5 三条口径 | ① **不覆盖**已存在项（进 `skipped[]` 并给 `reason`）② 复制出的一律 `pending` ③ 已截单的目标日跳过 | ①运营最怕「覆盖了我昨天调好的排期」②复制 `active` 会**绕过 D4 开团**，让未来若干天同时对外可下单 ③给过去的日期补排餐没有意义 |
| D5 事务 | 建多行时走一个事务 | 语义是「要么都建好，要么都不建」；部分成功会让运营无法判断哪几天已排好 |
| D6 `usedCount` | = 被多少个**未取消**的分配引用 | 模板库里最有用的一列：为 0 的可直接清理；数值大的改动前要评估影响面 |
| D7 入参**不含** | `supplierId` / `costPrice` / `shareAmount` | 供应商由菜品反查（`ab_dish.supplier_id`）、成本由菜品供价求和。让运营手填，迟早填出「记着 A 家的菜、算着 B 家的钱」，结算时才发现对不上 |
| D7 校验 | 同一道菜不得占两个档位 → **10001**；菜品不存在 / 已下架 → **30008** | 「两道素菜」可以是两道**不同**的素菜 |
| D7 售价缺省 | 未传 `price` → 回落 `ab_config.set_meal.default_price`（C1 锁定 ¥25.80） | 与 C1 统一定价同源 |
| 档位映射 | `slot`：1 主荤 / 2 半荤 / 3 素菜 / 4 汤 / 5 主食；**由 `GET /admin/meal/dishes` 出参下发** | 端上不维护第二份映射，口径唯一在服务端 |
| 选择器 | `/admin/meal/dishes` **只回上架菜品**（`status=1`） | 选中已下架的菜，D7 提交时必被打回；不如根本不给选 |

### 6.2 订单中心（M32）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| D8 | GET | `/admin/orders?mealDate=&startDate=&endDate=&buildingId=&groupId=&leaderId=&status=&keyword=&tab=&page=` | 全平台订单流（M32-01/02） |
| D9 | GET | `/admin/orders/{orderNo}` | 订单详情 + **操作日志** + 佣金明细 + `actions`（M32-03） |
| D10 | POST | `/admin/orders/manual-adjust` | 手动改单（改份数 / 改取餐楼）（M32-04） |
| D11 | POST | `/admin/orders/{orderNo}/force-refund` | 强制退款（M32-05） |
| D12 | GET | `/admin/orders/export?mealDate=&...` | 导出（表头 + 二维数组，端上拼 CSV）（M32-06） |
| — | GET | `/admin/orders/filter-options` | 筛选项下拉（楼群 / 办公楼 / 团长 / 11 态 · **只读扩展**） |

> D10 / D11 **必须写 `ab_operation_log`**（操作人、前后值、原因、IP）。实现方式为声明式 `@OperationLog()`，业务代码零侵入。

**实现状态（M3-3 已落地 · `modules/order/order-admin.*`）**

| 口径 | 取值 | 理由 |
| --- | --- | --- |
| 挂载路径 | `/admin/orders/*`（**不写成 `/orders/admin/*`**） | 前缀正是 `JwtAuthGuard` 的隔离依据；写成后者会让鉴权退回用户端规则，整个后台订单接口被 C 端 token 打开 |
| D8 返回集 | **完整网格语义**：无 `status` 过滤时返回该条件下的全部订单（含 `cancelled`） | 「已取消」是正常终态，运营需要看到；`summary` 单独把取消/退款剔出「有效营收」 |
| D8 `tab` | `all`（默认）/ `abnormal`＝`pending_pay` + `refund_applying` + `refunding` | **`cancelled` 刻意不算异常**，否则该 Tab 永远噪杂 |
| D8 `summary` | 按**同一过滤条件的全量**统计，不受分页影响 | 与 L10 / L19 同一约定；`validAmountFen = validQuantity × unitPrice` 恒成立 |
| D8 手机号 | 一律 `phoneMasked`（`186****0002`） | **后台不开后门**：全号只有 D12 导出一条路，且强制留痕 |
| D8 `keyword` | 命中订单号 **或** 下单用户昵称（子查询 `ab_user.nickname`） | 昵称无法只靠 `o.*` 表达，必须子查询 |
| D9 `actions` | `{canAdjust, adjustBlockReason, canForceRefund, refundBlockReason, refundableFen}` | **按钮可用性口径唯一在服务端**，端上不各判一套（避免「按钮亮着、点了报错」） |
| D9 金额 | 一律整数分（`Fen` 后缀） | 全局口径 |
| D10 语义 | 入参是**目标值**不是增量（`quantity` / `buildingId`） | 增量在重试下会翻倍：点「+1」、超时、再点一次就成了 +2，而订单看起来「改成功了」 |
| D10 改份数 | **仅 `pending_pay`**，已支付 → **30003** | 已支付改份数＝补收或退款，那是**支付通道动作**；一期不做部分退款/补收，引导「先退款再下单」 |
| D10 改取餐楼 | `pending_pay` / `paid` 均可；目标楼须与原楼**同楼群**，否则 **30015** | 楼群决定套餐分配与集散，跨群换楼＝换一整套履约，请走「取消 + 重新下单」 |
| D10 截单闸门 | 已过截单 → **30014**（两种动作都拦） | 供应商已按原份数备货，再改会让备货与单据对不上 |
| D10 不改用户归属 | `ab_user.building_id` 不动 | 归属楼是**长期属性**，本单取餐地是**短期事实**，两者不能混 |
| D10 日志 `targetId` | 取**请求体**里的 `orderNo`（路径里没有订单号） | 否则 P31 详情页按 `targetId=orderNo` 查该单日志会一条都查不到 |
| D11 与 D41 分工 | 订单处于 `refund_applying` → **40008**，请走 D41 审批 | D11 是**跳过申请与审批**的客诉兜底通道；刻意不做隐式分流，不让运营在两个入口之间猜 |
| D11 `amountFen` | **防误操作参数**：与可退金额不符 → **40011**；一期只支持全额 | 端上把可退金额放进二次确认弹窗，运营照着填 —— 这一填就排除了「看错订单」 |
| D11 退款拆两路 | 微信实付走通道原路退；**余额抵扣单独退回余额** | 余额当初就没走微信，喂给通道会被拒；喂进去了就是重复出款 |
| D11 反向结算 | 佣金冲销 + **毛利留存**（见 C9）· ⚠️ **2026-09-16 自营口径：「应付冲减」一项已作废**（半成品出餐日已交付，退款不冲减供应商应付） | 原记录一律不改写：冲销写新行、原行只翻 `status=cancelled` |
| D11 `reversal` 符号 | `commissionReversedFen` **恒正**、`commissionReversedQuantity` **为负** | 「冲掉了多少钱」是正数事实；出参给负号会让每个消费点自己 `Math.abs`，迟早漏一个 |
| D11 可退金额 | `total_amount − discount_amount`（＝微信实付 + 余额抵扣） | `pay_amount` 只是微信那一段；只退它会让「退款单金额 < 用户实际付的钱」 |
| D11 幂等 | 重复强制退款 → **40008** | 不产生第二张退款单 |
| D12 格式 | 「表头 + 二维数组」由端上拼 CSV | 服务端不引 `exceljs`，也避免在内存里多留一份含全量手机号的中间件 |
| D12 上限 | 单次 5000 行，超出截断并置 `truncated=true` | 防把内存拉爆；端上据此提示运营缩小范围 |
| D12 留痕 | 无条件写 `ab_operation_log`（含筛选条件、条数、来源 IP） | 含全号导出的合规底线：**谁在什么时候导了哪一批** |
| 角色白名单 | `super_admin` / `admin` / `operator` / `finance` | `finance` 要看订单（对账要用）；`viewer` 只读观察者只有看板 |

### 6.3 楼栋与楼群管理（M33）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| D13 | GET | `/admin/buildings?groupId=&status=&gap=&leaderState=&keyword=&page=` | 办公楼列表（M33-01，P37 五视图数据源） |
| D14 | POST | `/admin/buildings` | 新增办公楼 |
| D15 | PUT | `/admin/buildings/{id}` | 编辑；`buildingGroupId: null` = **移出楼群**；**不收 `leaderId`**（M3-7 修订，见下表） |
| D16 | GET | `/admin/building-groups` | 楼群列表（M33-02） |
| D17 | POST | `/admin/building-groups` | 新建楼群 |
| D18 | PUT | `/admin/building-groups/{id}` | 编辑楼群（含成员办公楼增删） |
| D19 | GET | `/admin/leaders?groupId=&buildingId=&level=&status=&page=` | 团长名录（M33-03，P32 数据源） |
| D20 | POST | `/admin/leaders` | 任命 / 转交团长（M33-04） |
| D21 | PUT | `/admin/leaders/{id}` | 变更团长（等级、状态、所属办公楼） |
| D22 | POST | `/admin/leaders/{id}/audit` | 资质审核 / 协议签署记录（M33-05） |

> **D22 说明**：C3 口径下**团长申请即生效、无前置审核**；此接口仅用于**事后资质补录**与**例外处理**（如违规停用）。界面文案须与 P32「提交申请即生效（无审核）」一致。

**M3-5 实现口径（D19–D22 · 原型 P32）**

| 项 | 口径 | 理由 |
| --- | --- | --- |
| D19 `view` | `roster`（默认）/ `applications`，**同一接口分流** | 两视图共用一套筛选与汇总；拆两个端点会让 `filter-options` 与 summary 各写一遍 |
| D19 `summary` | 按**同一过滤条件的全量**统计，不受分页影响 | 与 D8 订单中心 / L10 佣金明细同一约定：翻页时 KPI 卡不跳 |
| D19 `summary.pendingAuditCount` | **恒为 0** | C3 口径表达（申请即生效，无待审核队列），不是占位符 —— 界面不得渲染出「待审核 N」 |
| D19 手机号 | 一律 `138****0007` 脱敏 | 名录是日常浏览场景；要全号走 D12 导出（**强制留痕**） |
| D19 文案下发 | `levelLabel` / `commissionRateText` / `statusLabel` 由服务端给，映射定义在 `@abox/shared-types` | 端上不维护第二份映射，否则筛选器与列表会不同名 |
| D19 `actions` | 按钮可用性**唯一判定在服务端**（`canManage` / `canAudit`） | 与 D9 `actions` 同一设计：端上不自己判角色 |
| D19 申请流水「微信号」 | **不返回**（`notes.wechatId` 如实说明偏差），改回 `openidTail` + `nickname` | L17 申请表单从未采集微信号；返回一个「看起来像微信号」的假值比留空更危险 |
| D19 详情日志 | 按**团长 id 与 用户 id 双键**查 | D20 任命/转交日志的 `targetId` 是被任命**用户** id（请求体里没有团长 id），单键查会漏掉「他是怎么上任的」 |
| D19 路由顺序 | `GET /admin/leaders/filter-options` **必须声明在** `GET /admin/leaders/:id` 之前 | 否则 `filter-options` 被当成团长 id（同 D8 `export` 的坑） |
| D20 被任命者 | 必须是**已注册用户**，否则 20011 | 团长是叠加身份（L10）：没有 `ab_user` 就没有微信身份，收不到取餐提醒也登不进小程序 |
| D20 起始等级 | 默认 `trainee` 见习（8%） | 后台不替 C2 双条件做决定，避免「一上任就给高费率」 |
| D20 转交闸门 | 目标楼有在职团长时须显式传 `transferFromLeaderId` 且与现任一致，否则 **20012**（回带 `occupiedBy`）；传旧值/错值同样拦 | 一个误点就把别人经营中的楼换人（佣金归属还挂在他名下）；防「看到的是 A、确认时已变成 B」 |
| D20 转交落点 | 现任置 `status=2` **停职（非删除）**；继任者**新建档案**（id 独立） | 换人不抹账：历史佣金 / 推荐关系 / 在途提现都留在原团长名下 |
| D20/D21 归属同步 | 同时写 `ab_user.building_id` | 用户下单时的归属团长由它决定 |
| D21 改等级 | **必须同步写 `commission_rate`** | `level` 是标签、费率才是钱；只改标签会让佣金按旧费率结算，而界面上看不出矛盾 |
| D21 不收 `status` | 停用/复职**只有 D22 一个入口**（传 `status` 被 `forbidNonWhitelisted` 直接拒 → 10001） | 两个入口会让运营猜「哪个才是真的」 |
| D21 换楼 | 目标楼已有在职团长 → **20012**（同一闸门、同一错误码，提示改走 D20 转交） | 一栋楼两个在职团长会让下单归属变成不确定行为 |
| D21 空变更 | → **10001**（不写库、不写日志） | 否则审计里全是「改了但什么都没改」的记录 |
| D22 定位 | **不是审核入口**（C3 申请即生效），只做事后留痕与纠偏 | 界面文案须与 P32「提交申请即生效（无审核）」一致 |
| D22 `suspend` | `status=2` **且清 `ab_user.team_leader_id`**（同 L20 退出团长） | 撤销「我归属于某团长」；否则他已停职却仍挂在上级的团队下游 |
| D22 `restore` | `status=1` 且**不重置等级** | 纠错 ≠ 重新入行：L17「停职者重新申请」才重置为见习 |
| D22 `sign_agreement` | 写 `agreed_at` / `agree_version`；缺版本号 → **10001** | 历史团长未留痕 / 协议升级重签 |
| D22 `note` | 只留痕，不动任何字段 | 审计链上留一条「有人看过这份档案」 |
| D22 目标态重复 | → **20013**（不是幂等成功），停用与恢复**双向都拦** | 审计要能分清「是谁停的」 |
| 角色白名单 | 类级 `super_admin` / `admin` / `operator`；**D20/D21/D22 方法级收窄到 `super_admin` / `admin`** | 运营要能看名录、跟进团长、做资质补录；但任命决定「谁拿哪个楼的佣金」、改等级直接改费率 —— 看得见、点不了 |
| 越权副作用 | 守卫挡在业务层之前：**没建档、没改字段** | 不是「执行了再回滚」，不留半成品 |

**扩展接口（不占 D 号 · M3-7）**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/buildings/filter-options` | D13 附属 · 筛选器下拉（状态 / 楼群 / 覆盖缺口 / 团长归属） |
| GET | `/admin/buildings/overview` | P37 总览视图 · 主数据健康度（楼栋 / 楼群 / 集散覆盖 / 待分配团长） |
| GET | `/admin/buildings/delivery-map` | P37 集散中心映射视图 · 办公楼 → 主/备集散中心（**全派生**） |
| GET | `/admin/buildings/{id}` | D13 附属 · 办公楼详情（档案 + 楼群 + 团长只读 + 集散映射 + 近期套餐） |
| GET | `/admin/building-groups/filter-options` | D16 附属 · 楼群状态筛选器 |
| GET | `/admin/building-groups/{id}` | D16 附属 · 楼群详情（成员楼 + 服务集散中心） |

> ⚠️ **路由顺序**：`GET filter-options` / `overview` / `delivery-map` 三个静态段**必须声明在 `GET :id` 之前**，否则会被当成楼栋 id（同 D8 `export` 的坑）。

#### M3-7 实现口径（D13–D18 · 后台办公楼与楼群）

**DDL 变更（本批次唯一）**：`ab_building` 增 `population` 列（覆盖人数估算 · 原型 P37「约 N 人」）；**无新表**。同时把 `ab_building.status` 由旧注释的「1 合作中 / 2 停用」**扩为三态**（1 营业中 / 2 待开通 / 3 已暂停）。详见《ER v2.1》§5.6。

| 主题 | 口径 | 理由 |
| --- | --- | --- |
| **状态三态** | `BuildingStatus` = 1 营业中 / 2 待开通 / 3 已暂停（`tinyint` 值域扩展，`1` 语义不变） | 旧数据把「待开通」与「已暂停」都写成 `2` —— **一值两义**：运营既分不清「还没上线」和「已暂停合作」，也做不了「停用后恢复」的状态机。拆分后旧值 `2` 归「待开通」（保守：未确认合作状态的按未开通处理） |
| **楼群刻意二态** | `BuildingGroupStatus` = 1 启用 / 2 停用，**不沿用三态** | 楼群是纯组织维度：没有「待开通」这个中间态（群要么在用要么不用），多一个值只会让筛选器多一个永远为 0 的选项 |
| **覆盖缺口三因** | `DistributionGap`：`none` 已覆盖 / `no_group` 未归群 / `no_center` 楼群无集散中心 / `all_center_disabled` 集散中心已停用 | 三种成因对应三种修法（挂群 / 挂集散 / 恢复集散）。合成一个「未覆盖」，运营只能逐个点进去猜 |
| **集散映射全派生** | 主/备集散中心与路线号 R1…Rn **不落库**，由 `ab_distribution_center.service_groups` 实时派生（主 = 服务该楼群且启用中 id 最小者；R 按主集散中心 id 升序；路线内站点按楼栋 id 升序） | 落库就要有定时任务刷；M3-6 刚把「集散 → 楼群」做成配置驱动，楼栋上再存一份副本必然出现「改了配置、楼栋还显示老集散」。跨批次夹具已验：D30 挂载后 D13 的 `gap` 立刻翻转 |
| **不返回距离/时长** | `delivery-map` **不返回** `distanceKm` / `durationMin` | 需地图与真实路况数据，一期不具备；原型上的 km/分钟是演示值，写进交付口径就是对外承诺 |
| **D13 `gap` 出参** | 派生值 + `gapLabel` 文案由服务端给（映射在 `@abox/shared-types`） | 端上不维护第二份中文（M3-4 起的统一纪律） |
| **D13 `canOrder`** | = 营业中 ∧ 已归群 | 与 U1「今日这盒」是否可下单同一判据；未归群的楼无法被分配套餐 |
| **D13 列表筛选** | 状态/缺口/团长归属/关键词在**服务端内存**完成 | `leaderState` 依赖「`ab_building` × `ab_team_leader(status=1)`」联表 + 覆盖缺口又是派生值 —— 锁死为「服务端过滤」才能零改动切驱动（同 D29 楼群筛选） |
| **D13 分页** | `summary` 为**全量**统计，不受分页影响 | 与 D8/D19/D23 同一约定：翻页时 KPI 卡不跳 |
| **D14/D15 不收 `leaderId`** | 传了被 `forbidNonWhitelisted` 直接拒（10001） | D20/D21 是改团长的**唯一入口**，且带 20012 撞车闸门。若 D15 也能改，就绕过了闸门，还会造出「楼上写 A、团长档案写 B」的不一致 |
| **D14/D15 团长字段** | 只读下发（`leaderId` / `leaderName` / `leaderState`） | 看得见当前归属，但改不了 |
| **D15 `buildingGroupId: null`** | = **移出楼群**（置 `NULL`，不是 `0`、也不是「保持原值」） | 运营要能表达「这栋楼暂停合作、退回未归群」。没有这个语义就永远摘不出去，只能建空壳楼群当垃圾桶 |
| **D15 空变更** | → **10001**（不写库、不写日志） | 否则审计里全是「改了但什么都没改」 |
| **D15 停楼 vs 停群** | 停单栋楼**只出 `warnings` 不拦**；停楼群（仍有成员楼）→ **60003 硬拦** | 楼级动作影响面立刻可见；楼群停用是**静默影响一批楼**（楼下单能力没了，而楼自身仍显示「营业中」，列表上看不出异常） |
| **D18 顺序** | **先搬楼再判闸门** | 一次请求内「清空成员 + 停用」应当放行；倒过来判，运营必须分两次调用，中间态毫无意义 |
| **D18 整体替换** | `buildingIds` 传 `[]` = **清空成员楼**（不是保持原值）；列表**外**的本群楼被移出 | 与 D31 `serviceGroups` 同一纪律。实现成「空值 = 保持原值」，运营会以为解绑了、实际还挂着 |
| **D18 零副作用** | 被 60003 拦下时不落任何改动（状态仍是 1） | 「先改再校验」会留下停了一半的楼群 |
| **D17/D18 成员校验** | `buildingIds` 含不存在的楼 → **60001**（不静默跳过） | 静默跳过会让运营以为挂上了 3 栋、实际只挂上 2 栋 |
| **一楼一群** | `ab_building.building_group_id` 单值即覆盖：搬入新群时**自动脱离原群** | 楼群是「分发单位」的定义，一栋楼同时属于两个群会让「今日这盒」取谁的套餐变成不确定行为 |
| **重名** | 楼名 → **60005**；楼群名 → **60004** | 同名楼会让「按楼筛选」变成歧义操作，同名群会让「给国贸组发通知」发错对象 |
| **P37 总览范围** | 只做**主数据健康度**（楼栋 / 楼群 / 集散覆盖 / 待分配团长），**不含经营指标** | 经营指标看 P35 数据看板（D47）；同一指标两处口径必然打架 |
| **P37 总览同源** | 未覆盖清单与 D13 的 `gap` 判定、楼群分布与 D16 的覆盖状态**同一份派生函数** | 总览另算一套，就会出现「总览说 4 栋未覆盖、列表筛出来 3 栋」 |
| **配送映射守恒** | `coveredBuildingCount + uncoveredBuildingCount === totalBuildingCount` | 派生视图最容易在这里漏行（楼群没有集散中心时整群蒸发） |
| **两级白名单** | 类级 `super_admin` / `admin` / `operator`；**D14 / D15 / D17 / D18 方法级收窄到 `super_admin` / `admin`** | 运营要能看楼栋、查覆盖缺口、跟进团长空缺；但改楼栋档案会影响套餐矩阵可选范围与配送归属，是「决定哪些楼能开团」的事。`finance` / `viewer` 类级即不放（菜单矩阵里两者都没有 `/building/*`） |
| **越权副作用** | 守卫挡在业务层之前：**没建档、没改字段** | 不是「执行了再回滚」 |
| **错误码** | 新增 `60001` `BUILDING_NOT_FOUND` · `60002` `BUILDING_GROUP_NOT_FOUND` · `60003` `BUILDING_GROUP_NOT_EMPTY` · `60004` `BUILDING_GROUP_NAME_TAKEN` · `60005` `BUILDING_NAME_TAKEN` | 见 §九；号段 `6xxxx` = 主数据 |

> ⚠️ **一个反直觉的工程坑（真缺陷，已修）**：D15「未传字段」与「传 `null`」必须用 `!== undefined` 判定，**不能**用 `'buildingGroupId' in dto`。本项目 `target: ES2022` ⇒ `useDefineForClassFields` 默认 `true` ⇒ DTO 类字段声明会在实例上逐个 `defineProperty`（值为 `undefined`），于是 `in` 判断**恒为 `true`** —— 只改楼名的请求会被误判成「要移出楼群」。细则见《缺陷与陷阱》真缺陷 #47。

### 6.4 供应商管理（M34）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| D23 | GET | `/admin/suppliers?type=&status=&page=` | 供应商列表（M34-01） |
| D24 | POST | `/admin/suppliers` | 新增供应商 |
| D25 | PUT | `/admin/suppliers/{id}` | 编辑 |
| D26 | POST | `/admin/suppliers/{id}/audit` | 资质审核（营业执照、食品经营许可证）（M34-02） |
| D27 | PUT | `/admin/suppliers/{id}/type` | 设置类型：出餐型 / 集散型 / 混合型（M34-03） |
| D28 | PUT | `/admin/suppliers/{id}/settle-account` | **对公结算账户**（开户行、账号、发票抬头）（M34-04） |
| D29 | GET | `/admin/distribution-centers` | **集散中心配置列表（C4 · 表驱动）** |
| D30 | POST | `/admin/distribution-centers` | 新增集散中心 |
| D31 | PUT | `/admin/distribution-centers/{id}` | 编辑（含关联供应商、**结算参数**） |
| D32 | DELETE | `/admin/distribution-centers/{id}` | 停用（**软删**，保留历史结算关联） |

> **C4 纪律**：集散中心**不是硬编码 4 个**，而是 `ab_distribution_center` 表驱动、默认 4 个、可增删；费用项（场地费 / 打包人工 / 配送费，**默认均 ¥0** · C9 修订）存 `ab_config`，管理员可调。
> ⚠️ **2026-09-16 自营口径**：这三项是 **ABox 自身履约成本**（不再是「应付给集散中心」的对外应付），默认 0 仅表示**尚未登记** —— 详见 《ABox一盒自营结算口径定义v1.0.md》 §三。

**扩展接口（不占 D 号 · D33 起已归财务）**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/suppliers/filter-options` | D23 附属 · 枚举类筛选器（类型 / 审核状态 / 合作状态 / 付款方式） |
| GET | `/admin/suppliers/{id}` | D23 附属 · 供应商详情（档案 + 银行 + 菜品 + 集散 + 分账 + 日志 + 外卖链接） |
| PUT | `/admin/suppliers/{id}/takeout-links` | 外卖平台店铺链接（美团 / 淘宝闪购 / 京东 · 详见下表末） |
| GET / POST / PUT | `/admin/dishes` · `/admin/dishes/{id}` | 菜品库（供价是 C9 输入项） |
| POST | `/admin/dishes/batch-status` | 菜品批量上下架 |
| GET | `/admin/distribution-centers/filter-options` | D29 附属 · 集散筛选器 |

> ⚠️ **为什么详情独立成接口而不是塞进列表**：列表按行脱敏、**详情才回真实手机号**。若合成一个接口，「点开详情」与「翻列表」拿到的字段集相同，脱敏就形同虚设。

#### M3-6 实现口径（D23–D32 · 后台供应商管理）

**DDL 变更（本批次唯一）**：`ab_supplier` 增 7 列 —— `audit_status`（D26 落点）· `audit_remark` · `audited_at` · `audited_by` · `license_expire_at`（原型 P33「资质到期」列 · 123 号令要求）· `invoice_title`（D28）· `takeout_links`（JSON，外卖跳转）。详见《ER v2.1》§5.5。

| 主题 | 口径 | 理由 |
| --- | --- | --- |
| D23 手机号 | 列表只回 `contactPhoneMasked`；**详情同时回** `contactPhone` 与 `contactPhoneMasked` | 两个字段一起给，端上不必自己实现脱敏（各端实现一遍必然不一致） |
| D23 银行账号 | **任何后台接口都不回原文**，只回 `bankAccountMasked`；未登记 → **`null` 而非空串** | C10 人工对公转账，财务线下核对；`null` 让前端能区分「未登记」与「登记了空的」 |
| D23 派生值 | `licenseState`（`normal`/`expiring`/`expired`/`unknown`）、`canServe` 一律**不落库**，服务端现算 | 落库就要有定时任务刷；算错一次就是一整批脏数据 |
| D23 `canServe` | = 合作中 ∧ 资质已通过 ∧ 证照未过期 —— **与 S2 出餐前置校验同一判据** | 列表上显示「可出餐」而实际被拦，比不显示更糟 |
| D23 三处计数同源 | `dishCount` / `dcCount` 与详情数组长度**同一次查询得出** | 分两处算必然出现「列表 4 道、详情 3 道」 |
| D23 筛选器 | 枚举来自 `@abox/shared-types`，**不在控制器里再抄一份中文** | 端上不维护第二份文案（M3-4 起的统一纪律） |
| D23 品类下拉 | 由列表接口 `categoryOptions` 动态下发（真实数据去重） | 品类是自由文本，枚举写不出来 |
| D24 新建 | 一律 `audit_status=pending` → `canServe=false` | 资质未核验前不得出餐（50001 的前置） |
| D24 证照后置 | 证照与银行账户**允许为空**（C11 后置收集） | 不为「信息还没收齐」阻塞建档 |
| D25 资质字段 | **D25 不收** `auditStatus` / 证照审核字段 —— 资质只有 D26 一个入口 | 两个入口改同一件事，等于没有审核纪律 |
| D25 隐式副作用 | 把 `licenseExpireAt` 改成过去 → **同步下架其关联菜品**，出参回报 `unpublishedDishCount` | 证照过期却仍在上架列表里，是 123 号令下的实质违规 |
| D25 启停 | **D25 是供应商启停的唯一入口**（D 系列无单独停用接口） | 少一个入口少一套状态机分支 |
| D26 落库 | 写 `audit_status` + `audit_remark` + `audited_at` + `audited_by`；`rejected` 时审核意见必填（≥2 字） | 审核是合规动作，必须能回答「谁在什么时候批的、凭什么驳回」 |
| D26 与状态正交 | 审核**不改** `status`：驳回后**不自动下架**，需运营在 D25 显式停用 | 审核是事实判定，停用是经营决策 —— 混在一起会让「驳回」变成不可逆的经营动作 |
| D26 approved 前置 | 要求库中或入参有**未过期**的证照有效期，否则 50001 | 证照有效期不接受「先批后补」 |
| D27 与集散冲突 | 名下已有集散中心时不能降级为 `dish` → 50008 | 纯出餐商家名下挂集散中心是自相矛盾的主数据 |
| D27 目标态重复 | → 10001（不是幂等成功） | 审计要能分清「谁改的」，幂等成功会把无效操作记成有效 |
| D28 必填条件 | `payeeType=corporate` 时开户行与账号必填（**服务层校验，非仅 DTO**） | DTO 只表达「字段长什么样」；「什么条件下必填」是业务规则 |
| D28 发票抬头 | `invoice_title` **独立成列**，不复用 `name` | 展示名与开票名不一致是常态（个体户尤其） |
| D29 `canDelete` | 两道前置（历史应付 / 被分配引用）**合成一个布尔下发** | 前端据此禁用按钮，而不是点了才知道不行 |
| D29 楼群筛选 | 在**服务端内存**完成（JSON 列跨库字符串连接语义不同）—— 对外行为与 SQL 筛选一致 | sqlite `LIKE` 与 MySQL `JSON_CONTAINS` 语义不同；锁死为「服务端过滤」才能零改动切驱动 |
| D29 行内名称 | 服务楼群返回 **id 与名称两份** | 端上显示「国贸三期组」，不显示「#3」 |
| D30/D31 挂载冲突 | 挂到纯出餐型供应商 → 50008（**两个入口同一规则，都得拦**） | 只在 D30 拦，运营用 D31 就能绕过 |
| D31 `serviceGroups` | **整体替换**语义；**传空数组即清空** | 若实现成「空值 = 保持原值」，运营会以为解绑了、实际还挂着 |
| D31 `status=0` | 停用：保留记录、退出新分配、随时可恢复 | 停用 ≠ 删除（删除会被历史结算引用挡住，见 D32） |
| D32 软删前置 | 有历史应付 → 50002；被分配引用 → 50002。**错误信息给出「改用停用」的出路** | 只说「不行」运营就只能猜 |
| D32 零副作用 | 被拒时**不落 `deleted_at`**（软删标记只在两道前置都通过时才写） | 「先标记再校验」会留下删了一半的记录 |
| 费用默认值 | ⚠️ **2026-09-16 自营口径更正**：场地费 / 打包费默认 0 **只表示「尚未登记」，不代表成本为零** —— 自营下场地是 ABox 自有场所摊销、打包是 ABox 用工，**都是有真实成本的** | 与旧说法相反：**非 0 才是常态**。运营须登记真实值，否则经营毛利只是**上限值**、会被系统性高估（仍存 `ab_config`） |
| 两级白名单 | 类级 `super_admin` / `admin` / `operator`；**D24–D28 + 外卖链接 + 菜品所有写操作收窄到 `super_admin` / `admin`** | 运营要能看名录、跟进资质补办；但填档案、审资质、定类型、改结算账户，都是「决定钱付给谁」的事。`finance` 同样收窄（菜单矩阵里财务本就没有 `/supplier/*`） |
| 越权副作用 | 守卫挡在业务层之前：**没建档、没改字段** | 不是「执行了再回滚」 |
| 操作日志 `targetId` | **新建类接口从响应体兜底取新对象 id**（请求里没有 id，服务端生成） | 否则 `POST /admin/suppliers` 的日志永远 `targetId=null`，「这家供应商是谁建的」只能靠翻全文比对名字 —— 审计等于半残。只认 `id` / `data.id` 两层，不深挖子对象（`order.id` 与 `user.id` 同现时选错就把「改了这单」记成「改了这个用户」） |
| 外卖链接语义 | 只传要改的平台（未传 = 保持原值）；传 `url: null` = **清空该平台**（「未入驻」是合法状态）；**清空某平台会同步剔除悬空的「推荐」标记** | 推荐指向一个已不存在的链接，就是一条死引用。C8：能跳转 ≠ 是合作伙伴 |
| 错误码 | 新增 `50006` `SUPPLIER_NOT_FOUND` · `50007` `DISTRIBUTION_CENTER_NOT_FOUND` · `50008` `SUPPLIER_TYPE_CONFLICT`；复用 `50001` 资质未通过 · `50002` 集散被引用/有历史应付 | 见 §九 |

### 6.5 财务结算（M35）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| D33 | GET | `/admin/finance/overview?date=&range=` | 资金总览（日/周/月 GMV、平台收入、佣金支出）（M35-01） |
| D34 | GET | `/admin/finance/commissions?date=&leaderId=&page=` | 团长佣金结算明细（M35-02） |
| D35 | POST | `/admin/finance/commissions/settle` | 手动触发佣金入账（复核后重跑，**幂等**） |
| **D36** | GET | **`/admin/supplier-shares?date=&supplierId=&status=&keyword=&page=`** | **供应商应付结算单**（按出餐日，非「周期汇总」）（M35-03 · **已实装** M3-9） |
| D36a | GET | `/admin/supplier-shares/exceptions?date=` | **未出单异常清单**（M35-03 · 扩展接口 · M3-9） |
| D36b | POST | `/admin/supplier-shares/generate` | **手动出单 / 补跑**（与跑批同一执行口）（M35-03 · 扩展接口 · M3-9） |
| **D37** | POST | **`/admin/supplier-shares/{id}/payment`** | **付款登记**（银行回单号必填 → 状态置 `success`）（M35-03 · **已实装** M3-9） |
| **D38** | GET | **`/admin/finance/balances?userId=&accountType=&keyword=&page=`** | 余额账户管理（含**全量负债时点量** · **已实装** M3-14）（M35-04） |
| **D39** | POST | **`/admin/finance/balances/adjust`** | 充值 / 扣减 / 冻结 / **解冻**（**幂等键必填** + 必填原因 + 写账本）（M35-04 · **已实装** M3-14） |
| D40 | GET | `/admin/finance/refunds?status=&page=` | 退款流水（M35-05） |
| **D41** | **POST** | **`/admin/finance/refunds/{id}/approve`** | **退款审批通过 → 实际退款（C6 第二→三段）** |
| **D42** | **POST** | **`/admin/finance/refunds/{id}/reject`** | **退款驳回 → 回到原状态（C6）** |
| D43 | GET | `/admin/finance/reconciliation?date=` | 与微信支付对账（M35-06） |
| D44 | GET | `/admin/finance/invoices?page=` | 发票管理（M35-07） |
| D45 | GET | `/admin/finance/withdrawals?status=&page=` | 提现审批列表（M35-08） |
| D46 | POST | `/admin/finance/withdrawals/{id}/approve` | 提现审批通过 |

> **结算模式（2026-09-14 定案 · C10 + C11）**：**团长佣金**由系统自动结算（入佣金余额 → 提现由**灵活用工平台代发**并代扣个税；D45 / D46 审批后，`PayoutChannel` 生成**打款批次**并导出清单，一期运营提交平台后**回执登记**、二期接平台 API）；**供应商 / 集散中心**为**应付结算 · 日结**，系统只生成结算单与登记付款（D36 / D37），实际转账由财务在网银完成。详见《账号资源与密钥清单》§3.2。

**M3-13 实现口径（D33–D35 · 资金总览 / 佣金结算 / 佣金入账 · M35-01/02）**

> 落点 `apps/api-server/src/modules/finance/finance-admin.controller.ts` · `finance.service.ts`（D33）·
> `commission.service.ts`（D34 `listCommissionsForAdmin` / D35 `settlePending`）· `dto/finance.dto.ts`；
> 页面 P34 `/finance/overview`（`views/finance/overview.vue`）与 `/finance/commission`（`views/finance/commission.vue`）；
> 验收 `scripts/e2e-m3.mjs` **§25**（**不依赖下单窗口**，订单与佣金夹具全部直插）。
> **零 DDL · 零新增错误码。**

| 项 | 口径 |
| --- | --- |
| ⭐⭐ D33 **不自己算一套口径** | 收入 / 成本 / 履约 / 毛利 / 逐日趋势**全部取 `StatsService.dashboard()`** —— 与 D47 看板是**同一个函数**。故「财务页的 GMV」与「看板的 GMV」在结构上不可能漂移；e2e 用「D33 的 GMV / 单量 / 佣金 / 采购 / 毛利五项与 D47 **逐项相等**」钉死。若哪天有人把 D33 改成自己 `SUM(...)`，这条立刻红 |
| ⭐ D33 逐日**自洽** | `daily[]` 的 GMV/单量/份数取看板的 `trend`（同源），佣金/采购按出餐日分桶。e2e 断言 **Σ daily = 区间总额**（三项）—— 同一份数据的两种切法互为正反面 |
| D33 只补**资金视角**四样 | ① 应付单**付了没有**（`pending`/`paid` 拆分）② 已退回用户的**金额**（看板给的是退款**率**）③ 用户余额与冻结（**平台负债**）④ 待入账佣金 |
| ⭐ `range` 复用 `STATS_RANGES` | today / 7d / 30d，**不另立「日/周/月」**：同一句话在两页指两个区间，是最难查的一类对不上账。非法 `range` → `10001`（**不静默回落**：回落会让运营以为看的是 90 天） |
| ⭐ `date` = **区间终点锚点** | 起止仍由 `range` 推导（终点往前推 N−1 天），**不是自由起止**。需求来源：期末对账要看已经过完的那一天（今天的数据还在长）。该入参由 `StatsQueryDto` 承载，**D47–D50 同时获得**（向后兼容的扩展入参） |
| ⭐ 时点量 vs 区间量 | `liability`（余额 / 冻结 / 待入账佣金）是**时点量，不随 `range` 变化**，出参带 `asOf`。e2e 用「7d 与 30d 两次请求该三项完全相同」钉死 —— 时点量被误读成「本期新增负债」是最容易误导人的一类错 |
| `payable.generated` 判据 | 「**是否存在有效应付行**」而非「金额是否为 0」：实收量为 0 的日子**也会出单**（金额 0），按金额判会说「没出单」 |
| `payableStatus` 四态 | `none` / `pending` / `paid` / `partial` 是**给人看的**，不是库里的三态（库里只有 pending/success + 已失效）。中文文案服务端下发 |
| 已退金额的筛选方式 | `ab_refund` **没有** `meal_date`，按出餐日筛必须回到订单表；实现用 **SQL 子查询**而非 `IN (:...ids)` —— 30 天区间可能上千单，而 **SQLite 绑定变量上限 999**，拼大 IN 列表会在换驱动时直接报错（MySQL 却没事，于是本地全绿、换驱动才炸） |
| D34 粒度 | **按出餐日**一张表（不是区间）：佣金明细是「一天一张表」的核对习惯，要看多日就逐日切换，不让它长成第二个区间选择器 |
| ⭐⭐ D34 `rate`/`leaderLevel` 是**结算快照** | C2：团长后来晋级，历史行仍显示当时的等级与费率。列头直接写「（快照）」。e2e 用「**同一个团长**的三条佣金分别显示见习 8% / 正式 9% / 首席 12%」钉死 —— 一个团长只有一个当前等级，故这不可能是「当前值」 |
| D34 扩展入参 | `status` / `type` / `keyword`（M3-13 登记）。财务核对「哪些还没入账 / 哪些被冲销了」是高频动作，没有过滤就只能翻页。非法枚举 → `10001`（不静默忽略成「全部」） |
| D34 汇总 | `summary` 按**同一过滤条件的全量**（不受分页影响，与 D8/D36/D40 同一约定）+ `byLevel[]` 按等级拆分（财务问的是「今天首席/金牌各发多少」）。e2e 断言 `Σ byLevel = netFen`、`pageSize=1` 时汇总不变 |
| D34 手机号 | 一律 `phoneMasked` —— 团长档案里存的**本身就是脱敏号**，此处不额外开后门 |
| ⭐⭐ D35 的定位 | = M4 **`commission-settle.task`（T+1 02:00 佣金入账）的同一执行口**（`CommissionService.settlePending`）。跑批上线只需把 `@Cron` 接到本方法，**不另写第二套入账逻辑** |
| ⭐⭐ **一期 `pending` 常态为 0** | 佣金在 L9 取餐确认时**即时入账**（`accrueForOrders` 直接写 `settled`）。故 D35 出参**必须**带 `note` 说明「这不是故障、也不是钱没结」—— 否则「点了按钮 0 条」一定被当成故障报上来（同 M3-10 的「如实标注」纪律） |
| ⭐ D35 **刻意不做「补计佣」** | `ab_order` **没有**「下单/确认时刻的团长等级」快照 → 任何事后补计佣都只能用团长**当前**等级，团长晋级后会**多算佣金**。这是**结构性缺口**（非实现 bug），故 D35 严格限定为「`pending` → `settled` 入账」，并在《缺陷与陷阱》登记 |
| D35 原子与并发 | **整批单事务**（要么全入账、要么全不入账，不留「一半团长到账」）；逐行 `UPDATE ... WHERE id=? AND status='pending'`，以 `affected` 判定归属 —— 并发下已被别处入账的行进 `skipped` 而不是重复加钱 |
| D35 无归属 | 团长档案不存在 → `skipped` + **`skippedReasons`**（人话，含「X 条佣金跳过」）。**不猜、不建号、不静默丢弃** |
| ⭐⭐ 补账**只改账、不改事实** | `creditCommissions(..., touchOrderStats:false)` **只累加 `total_commission`**，不动 `total_orders` / `last_order_at`。补结算不是新下单，顺手刷活跃度会污染 C2 晋级审计（按 `month_orders`）。e2e 专门断言这一点（这个 bug 极其安静：余额对了、佣金对了，只有团长的晋级进度被悄悄推快） |
| 入账段**唯一** | `accrueForOrders`（计佣+入账）与 `settlePending`（补入账）共用 `creditCommissions` —— 同笔佣金经不同路径进账必须得出同一个 `balance_after`。流水文案里的等级/费率取**佣金行快照**（不是团长当前值），否则账本会写着「首席 12%」而钱按 8% 算 |
| D35 入参 | **刻意不收金额、不收团长**：入账金额一律以 `ab_commission` 行为准（计佣时冻结的快照）。一旦允许传金额，就等于开了「手工往团长余额加钱」的后门 |
| 权限（两级白名单） | **类级** `@Roles('super_admin','admin','finance','operator')` —— 运营要能看资金与佣金（跟进「为什么佣金没结」）；**D35 方法级收窄到 `('super_admin','admin','finance')`** —— 把钱记进团长余额是资金动作（同 D41）。**不含 `viewer`**：`admin-role.ts` 里 viewer 的菜单只有 4 个看板页，财务页不在其中 —— 这与 D47–D50 **刻意含 `viewer`** 正好相反，两处都是「白名单必须与菜单同源」 |
| 操作日志 | D35 由 `@OperationLog({ module:'finance', action:'佣金入账补跑' })` 落库（必须能回答「谁在什么时候把钱补记进团长余额」）；三个 GET 均不标 |
| ⚠️ 顺手清掉的死占位 | 删除 `modules/finance/finance.controller.ts`（原 `@Controller('finance')` 空类，零引用）—— 与 M3-12 删除 `MessageService` 两个空占位同一纪律：「财务端点该写哪」由此**只有一个答案** |

**M3-14 实现口径（D38–D39 · 余额账户管理与调整 · M35-04）**

> 落点 `apps/api-server/src/modules/finance/balance-admin.service.ts`（D38 `list` / D39 `adjust`）·
> `finance-admin.controller.ts`（`GET balances` · `POST balances/adjust`）· `dto/finance.dto.ts` ·
> 复用 `finance.service.ts` 的 `loadLiability()`（**由 `private` 改 `public`**，与 D33 同一函数）；
> 页面 P34 `/finance/balances`（`views/finance/balance.vue`）；
> 验收 `scripts/e2e-m3.mjs` **§26**（**不依赖下单窗口**，夹具直插新用户、节末全量还原）。
> **零 DDL · 新增 1 个错误码（`40015`）· 新增 1 个枚举值（`ab_balance_log.type='adjust'`）。**

| 项 | 口径 |
| --- | --- |
| ⭐⭐ 负债合计**不自己算** | D38 的 `liability` 直接调 `FinanceService.loadLiability()` —— 与 D33 资金总览是**同一个函数**。两页各写一套 `SUM(ab_balance)` 时漂移**不报任何错**，只会让运营在两页看到两个不同的「平台欠用户多少钱」。e2e 用「D38 `liability` **逐项等于** D33 `liability`」（写前 + 写后各一次）钉死；把 D38 改回自己 SUM 会立刻红 |
| ⭐⭐ 负债是**时点量** | `pageSize` / `accountType` / `keyword` **都不改变** `liability`（`total` 才是本次筛选命中数）。「平台还欠用户多少钱」不该因为运营在搜索框里敲了个昵称就变小。e2e 断言 `pageSize=1` 与 `pageSize=100`、`accountType=leader` 与全量的 `liability` **完全相同** —— 把 `liability` 做成「当前页求和」是最容易犯的错 |
| ⭐ D39 **四动作** | `recharge` / `deduct` / `freeze` / **`unfreeze`**。规范原只列「充值 / 扣减 / 冻结」三动作 —— **不能解冻的冻结是死钱**（冻结本是为争议 / 风控设的临时态，没有解冻口就只能改库）。中文文案由服务端 `BALANCE_ADJUST_ACTION_LABEL` 下发，端上不自造 |
| ⭐⭐ 冻结 / 解冻**不动** `total_in` / `total_out` | 钱没进出平台，只是从「可用」挪到「冻结」。若把冻结记成支出，`total_out` 会随冻结 / 解冻来回跳，并与提现累计互相污染（L12 提现也刻意「申请阶段不计入累计支出」）。e2e 断言「冻结后 `total_out` 不变、解冻后 `total_in` 不变」 |
| ⭐⭐ **余额不得为负** | 扣减 / 冻结超出可用额 → **`40002`**；解冻超出冻结额 → **`40015`**。**两码刻意分开**：`40002` 是「钱不够花」（等入账 / 充钱即可解决），`40015` 是「冻结账对不上」—— 冻结额里没有这笔钱，说明**余额快照与冻结记录不一致**，这是账实不符信号，要查数据而不是让人充钱。两者合流一个码，运维就分不清该做什么。两个出参都带 `data`（`availableFen` / `frozenFen`），否则运营只知道「失败了」不知道「差多少」 |
| ⭐ **幂等键必填** | D39 **没有业务单号**可供判重，重复提交就是**重复加钱**（与 L12 提现同一风险面）。故 `Idempotency-Key` **必填**：缺键 → `10001`；同键重复提交 → `10006` + **首次结果原样返回**，余额一分不再动。e2e 断言「同键两次提交后余额与流水条数均不变，且第二次出参等于第一次」 |
| **乐观锁** | `UPDATE ab_balance SET ..., version = version + 1 WHERE id = ? AND version = ?`，以 `affected` 判归属 —— 并发调账不丢更新（复用 `withdraw.service.ts` 的同一处理）。抢锁失败 → `10001` + 「请刷新后重试」 |
| ⭐ **只有「充值」能自动建户** | 其余三个动作在「无账户」时**明确报错**（`40002` / `40015` + `message` 写明该用户「从未发生资金往来」），**不是**先建一个 0 余额的账户再报「余额不足」—— 后者会在库里凭空长出一行「余额 0、从未有过资金往来」的账户，让 D38 的账户数与 D33 的 `accountCount` 悄悄错开。首充建户是 D39 的正当用途（「给从没下过单的用户发补偿」），若因无账户而失败，运营会卡死在这里 |
| ⭐⭐ 权限**单一真相** | `BALANCE_ADJUST_ROLES` 常量**同时**驱动控制器 `@Roles(...)` 与出参 `actions.canAdjust` —— 一处改动、两处生效，结构上不可能出现「按钮亮着、点了 `10003`」或「按钮灰着、其实有权限」。⚠️ 项目既有写法（如 `leader-admin.service.ts` 的 `canManage`）多为**两处硬编码 + 注释对齐**，本批改为常量 |
| 两级白名单 | **类级** `@Roles('super_admin','admin','finance','operator')`（运营要能看「这个用户余额为什么异常」）；**D39 方法级收窄**到 `('super_admin','admin','finance')` —— 把钱记进用户 / 团长余额是资金动作（同 D35 / D41）。**不含 `viewer`**：`admin-role.ts` 里 viewer 的菜单只有 4 个看板页 |
| ⭐ 新枚举值 `ab_balance_log.type = 'adjust'` | 与原五值（`commission` / `order_pay` / `withdraw` / `withdraw_refund` / `refund`）**刻意分开**：调账既不是佣金也不是消费，混进去会让「佣金支出」类汇总口径被污染。**已回写 §九扩展登记**，并同步补 `BALANCE_LOG_TYPE_LABEL['adjust'] = '管理端调整'` —— 漏了这一步，用户在自己的余额明细（L19）里会看到裸英文 `adjust` |
| 账本与快照**同源** | 每次调账在**同一事务**内写两处：`ab_balance`（快照）+ `ab_balance_log`（发生额，含 `balance_after` 逐步落痕、`related_id` = `AJ…` 单号）。故「当前余额」必须等于「末条流水的 `balance_after`」（L11 / L19 可相互验算的落点）。e2e 断言「5 条流水**全部** `type=adjust` 且带 `AJ…` 单号、`direction` 依次 +1 / −1 / −1 / +1 / +1、末条 `balance_after` === 当前 `balance`」 |
| ⭐ 流水 `remark` 带**操作人** | `@OperationLog` 记的是「谁调了这个接口」；而这条流水会被团长 / 用户在自己的余额明细里看到 —— `remark` 里带操作人，让「谁动过我的钱」在一处可查，不必让运营去翻后台日志 |
| 未知 `action` **fail-closed** | `switch` 的 `default` 抛 `10001`。DTO 的 `@IsIn` 已挡住未知值，但**内部调用**（将来别的服务直接调 `adjust()`）不经过 DTO 校验：若让它静默走完 `switch`，`nextXxx` 全等于原值 → UPDATE 把相同值写回（`version` 还 +1）→ 流水里多出一条「金额有、余额没变」的记录。**余额看着是对的，只有账本对不上** —— 最难查的一类脏数据 |
| 溢出前置挡 | `ab_balance` 四列均 `DECIMAL(12,2)`（上限 9,999,999,999.99 元）。不前置判就会由 DB 抛出**驱动相关**的底层错误（本地 SQLite 宽松、MySQL 报 Out of range），且**同一事务里的流水还没写**，运维拿到的报错无法定位是哪一步 → 统一 `10001` + 中文「调整后金额超出系统上限」 |
| D38 **无账户空视图** | 按 `userId` 精确查时**包含**「无账户」的用户（`hasAccount=false`、余额全 0、`logs=[]`）：否则运营搜不到人 → 以为查无此用户 → **不敢充值**，而 D39 恰恰支持首充建户。列表模式则**只列有账户的行** —— `ab_balance` 只在发生过资金往来后建行，把所有 `ab_user` 都铺满页面对运营毫无信息量，也会让 `total` 失去「有多少个账户」的含义 |
| D38 扩展入参（M3-14 登记） | `userId`（精确查，含空视图）/ `accountType`（`all` / `leader` / `user`）/ `keyword`（昵称**或**手机号模糊匹配）/ 分页。非法 `accountType` → `10001`（**不静默回落成 `all`** —— 静默回落会让「筛选没生效」看起来像「没有这类账户」）；`userId` 不存在 → `10004`（**不是**返回一行空账户：查无此人要能被区分出来） |
| 手机号**一律脱敏** | 列表与详情统一 `phoneMasked`（同 M3-6 纪律）—— 余额页不是查人资料的地方 |
| D38 筛选查询**用 SQL 子查询** | 前置条件（团长 / 关键词）的候选用户集合可能上千，而 **SQLite 绑定变量上限 999** —— `IN (:...ids)` 拼大列表会「本地全绿、换 MySQL 才炸」（M3-9 已踩过一次）。子查询没有这个上限。（但**当前页**的批量装饰只有 ≤100 个用户，用 `In` 列表安全） |
| 余额列**降序** | 运营点进余额页最想先看「谁的余额大得异常」，故 `ORDER BY balance DESC, id ASC` |
| 操作日志 | D39 由 `@OperationLog({ module:'finance', action:'余额调整' })` 落库（必须能回答「谁在什么时候给谁加了钱」）；D38 不标 |
| ⚠️ 顺手修掉**前端菜单缺口** | `admin-web` 的 `ADMIN_NAV` 财务域**原只挂 `/finance/overview` 一个入口**，而服务端 `ADMIN_MENU_KEYS` 早已含 6 个财务子页 —— 「授权了却无入口」，运营只能手输 URL 才能到佣金 / 应付 / 退款 / 对账 / 余额页。本批补全（**菜单与白名单同源**纪律的反向缺口） |

**D41 执行链（C6 · 三段式收口）**

```
approve
  → ab_refund.status: applying → approved
  → 调用微信退款 API（原路退用户）→ refunding → refunded
  → 反向结算（reversal.service，原记录不得改写）：
       ⭐ 供应商采购应付：不动（自营口径 2026-09-16 —— 半成品出餐日已交付，退款不冲减）
       团长佣金：扣减佣金流水（写反向 ab_commission，金额取负）
       经营毛利（结果值）留存（不参与回退）
  → 推送微信订阅消息给用户（退款结果必推）
```

> ⚠️✅ **【2026-09-16 自营裁定 · 本节旧口径已作废，回退已完成（M3-9）】**
> 原文为：「已付款后再退款：若 `ab_supplier_share` 已登记付款（`success`），须走 `reversal.service` 写**反向流水**（`type='reversal'`）并在**下期结算抵扣**；未付款的应付单直接冲减。」
> **作废理由**：该口径成立的前提是「供应商按用户卖出的份数**分账**」（旧有效订单口径）。
> 自营下应付基数是**实收量**（供应商实际交付的半成品），半成品在出餐日当日已交付并投入使用，
> **用户退不退款与供应商无关** → 退款**不得冲减**供应商应付。
> `type='reversal'` **保留但改义**为「应付单生成后发现算错」的**纠错冲销**（运营主动动作，非退款副作用）。
> ✅ **回退已完成（M3-9）**：`modules/finance/reversal.service.ts` 已移除 `reverseSupplierShares()`；出参改为显式声明 `supplierShareAdjusted = 0` + `supplierShareMode = 'not_applicable'` —— **保留字段而不是删掉**，是为了让「应付分文未动」成为一条可断言的事实（而不是「没人提到它」）。
> 佣金冲销与用户余额回退**不受影响**（那是 ABox ↔ 团长/用户 的关系）。详见《ABox一盒自营结算口径定义v1.0.md》§5。

**M3-9 实现口径（D36/D37 · 应付结算 S9 · 自营口径首次实装）**

> 落点 `apps/api-server/src/modules/finance/supplier-share-admin.controller.ts` · `supplier-share.service.ts` · `dto/supplier-share.dto.ts`；
> 跑批 `apps/api-server/src/tasks/supplier-share.task.ts`（**T+1 02:00**）；页面 P34 `/finance/supplier-share`（`apps/admin-web/src/views/finance/supplier-share.vue`）；
> 验收 `scripts/e2e-m3.mjs` **§21**（41 条断言 · **不依赖下单窗口**，夹具全部自造）。

| 项 | 口径 |
| --- | --- |
| 路径偏离登记 | 文档原规划 `/admin/finance/supplier-shares`，实装为 **`/admin/supplier-shares`**（资源式挂在模块根，与同批的 `/admin/suppliers` 一致）。**前缀仍是 `/admin/*`，鉴权依据不变** —— 路径变了要回写文档，正是因为「前缀即鉴权依据」这条纪律 |
| 权限（两级白名单） | **类级** `@Roles('super_admin','admin','finance','operator')` —— 运营要跟进「为什么没出单」所以**能看**；**方法级** `generate` / `payment` 收窄到 `('super_admin','admin','finance')` —— **决定「欠多少」「付没付」是资金动作**。`viewer` / `supplier` 一律 `10003` |
| 出单粒度 | 一行 = **(供应商, 菜品, 出餐日)**；`share_date` = 出单日、`meal_date` = 出餐日，**两个日期都要**（前者回答「哪期结算」、后者回答「哪天的货」） |
| 计费基数 | `ab_supplier_dish_daily.actual_quantity`（S2 申报值）；**`NULL` 视为足额 = `plan_quantity`**（与 S2「不传即足额」同语义，不是「没数据就不付」） |
| ⭐ 单价来源 | 取 `ab_supplier_dish_daily.unit_price` —— **出餐计划生成时冻结的协商价快照**；为空才回落 `ab_dish.cost_price`。若恒取当前成本价，就会出现「T 日按旧价交货、结算按新价付」，供应商对账必然拒绝（本批**修正了口径文档 §4.1 的旧写法**，e2e 用「夹具价 ≠ 当前成本价」把这条钉住） |
| fail-closed（出单） | 供应商资质异常（`canServe=false`，与 S2 的 50001 **同判据、同顺序**）→ 不出单；父行 `status != 'done'` → 不出单（`not_started` / `incomplete`）；`actual_missing`（已置完成但实收为空的历史数据）→ 不出单；实收 0 → 无采购事实，不出单 |
| fail-closed（付款） | 仅 `pending` 可登记（否则 **`50012`**：已付款的单再登记一次就是**重复出款**，钱转出去追不回来）；缺回单号 → **`50013`**（回单号是「这笔钱确实付了」的唯一凭证）；**同一回单号用于两笔 → `10001`**（两笔支出挂同一凭证，对账时分不清哪笔真付了） |
| 幂等（软层） | 同一 `(供应商, 菜品, 出餐日)` 已有有效 `normal` 行即跳过 —— **刻意不建 DB 唯一索引**：本表还要容纳 `type='reversal'` 负行，同键正负两行是**合法冲销**，唯一索引会误伤 |
| 异常清单 | `GET .../exceptions?date=`（`date` **必填**）——「历史上所有没出单的原因」不是一份可执行的清单；已出单的行会被过滤掉（清单要能收口，不能越看越长） |
| 出单出参 | `created[]` 回填 **`id`** —— 运营拿到 created 要能**直接对某条登记付款**，只给单号等于让人再去列表里搜一遍 |
| 汇总口径 | `summary` 按**同一过滤条件的全量**统计（与 D8 / D40 / L10 / L19 同一约定），并按状态拆 `pending` / `paid` |
| 按钮口径 | `canRegisterPayment` + `blockReason` 由服务端下发，端上不自算 |
| 操作日志 | `generate` / `payment` 由 `@OperationLog()` 声明式落 `ab_operation_log` |
| 与 S2 的关系 | 出单**只读父行**（`ab_supplier_dish_daily`），不读分中心明细 —— 明细是「谁在哪确认的」的过程留痕，付款只需总量 |

**M3-4 实现口径（D40–D42）**

> 落点：`apps/api-server/src/modules/finance/refund-admin.{controller,service}.ts` · `dto/refund-admin.dto.ts` · 页面 `apps/admin-web/src/views/finance/refund.vue`（P34 退款审批页）。

| 项 | 口径 |
| --- | --- |
| 权限（两级白名单） | **类级** `@Roles('super_admin','admin','finance','operator')` —— 运营要能跟进退款进度，所以 `operator` **能看**；**方法级** D41/D42 收窄到 `('super_admin','admin','finance')` —— **决定钱退不退是资金动作**，运营不能拍板。`viewer` / `supplier` 一律 `10003` |
| D40 路径与分页 | `GET /admin/finance/refunds`，出参 `{list,page,pageSize,total,hasMore}`；过滤 `tab` / `status` / `keyword` / `mealDate` |
| D40 `tab` | `all`（默认）/ `pending`（待审批）/ `approved`（已通过）/ `rejected`（已驳回）/ `refunded`（已退款）。**Tab → 状态集合由服务端展开**，端上不各记一套映射 |
| D40 `summary` | 按**同一过滤条件的全量**统计，不受分页影响（与 D8 / L10 / L19 同一约定）；含各 Tab 计数供角标使用 |
| D40 拆两路金额 | 行内分别给 `wxAmountFen`（微信实付原路退）与 `balanceAmountFen`（余额抵扣退回余额）。**不合成一个数** —— 两者出款通道不同，合成后前端只能靠反推 |
| D40 手机号 | 一律 `phoneMasked`；**后台不开后门**（全号只有 D12 导出一条路，且强制留痕） |
| D40 枚举下发 | `statusOptions[]` / `sourceOptions[]` 由服务端下发（`REFUND_STATUS_LABEL` / `REFUND_SOURCE_LABEL` 落 `packages/shared-types`），**端上不维护第二份文案** |
| D41 状态闸门 | 仅 `applying` 可审批，否则 **40013**；退款单不存在 **40012** |
| D41 金额复核 | 审批时以**当前订单**重算可退额 `total_amount − discount_amount`，与申请单金额不一致 → **40011**（防「申请后订单又被改」） |
| D41 审批与实退 | **同一事务**：先置 `approved` 再调 `executeRefund`（D11 与 D41 共用**唯一执行口** `refund.service.executeRefund`）。一期无 W2 退款结果回调 → 审批**不可逆见**；W2 接入后异步化 |
| D41 幂等 | 重复审批同一单 → **40013**（已是终态），不产生第二次出款 |
| D41 出参 | 回带订单快照 + `executionChain`（前端二次确认弹窗预览「将发生什么」） |
| D42 驳回 | **资金零变动**（不写任何流水）：`ab_refund.status: applying → rejected`，订单回退到 `ab_refund.order_status_before` |
| D42 `order_status_before` | 申请前订单状态，**驳回唯一回退依据**。订单状态机对退款分支只有单向箭头，**不记则驳回无家可回**；字段缺失 → **40014**（**fail-closed**，不猜、不回退到默认值） |
| D42 入参 | `reason` **必填 ≥2 字**（驳回要留痕，不接受空理由） |
| D42 可重申请 | 驳回后订单回到原状态，用户/团长可**再次发起**申请（C6 不设次数上限，但每次重走三段式） |
| 操作日志 | D41/D42 由 `@OperationLog()` 声明式落 `ab_operation_log`，**`targetId` = 退款单 id**（不是订单号） |

### 6.6 数据统计（M36）

> **实现状态**：`D47–D50` **已实装（M3-11 · 零 DDL · 零错误码）**。
> 落点：`apps/api-server/src/modules/stats/`（`stats.constants.ts` = **统计口径唯一真相**）· 页面：`apps/admin-web/src/views/stats/`。
> 验收：`scripts/e2e-m3.mjs` **§23**（61 条断言 · **不依赖下单窗口** · 夹具节末全量还原）。

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| D47 | GET | `/admin/stats/dashboard?range=` | 核心指标看板（GMV / 单量 / 客单价 / 复购率 / 经营毛利）（M36-01） |
| D48 | GET | `/admin/stats/building-rank?range=` | 楼群 / 楼栋排行（M36-02） |
| D49 | GET | `/admin/stats/dish-heat?range=&topN=` | 菜品热度（M36-03） |
| D50 | GET | `/admin/stats/retention?range=` | 留存分析（M36-04） |

**关键指标口径（与原型 P34/P35 一致 · 实现口径见下方 M3-11 表）**

| 指标 | 公式 |
| --- | --- |
| GMV | Σ **有效订单** `unitPriceFen × quantity`。<br>「有效」= 状态 ∉ {`pending_pay`, `cancelled`, `refunded`}，即 **含在途退款**（`refund_applying` / `refunding`）—— 钱还没退、佣金也尚未冲销，此时剔除会造成「钱已收但 GMV 不计、佣金却还在支出」的双向错配 |
| 经营毛利（**结果值** · 字段名仍为 `platformGrossProfit`） | GMV − 半成品采购款（实际应付单**净额**） − 履约成本（场所摊销 + 打包人工 + 配送费，**三项配置单价 × 份数**） − 团长佣金（**净额**）<br>⚠️ 自营口径（2026-09-16）：场地 / 打包 / 配送三项是 **ABox 自身履约成本**（不出付款单），但**必须登记真实值**，否则该毛利只是**上限值**、会被系统性高估。中文口径改称「**经营毛利**」，字段名保持不变 |
| 客单价 | GMV ÷ **有效订单数** |
| 单份均价 | GMV ÷ **份数**（与客单价**并列下发** —— 一单可多份，只给一个数必被读错；原文括号里「份数 / 订单量」表述含糊，故两个都出） |
| 退款率 | 退款三态（`refund_applying` + `refunding` + `refunded`）的**订单数** ÷ **全部**订单数（含未支付 / 已取消 / 已退款）<br>⚠️ 分子是**订单数**不是 `ab_refund` 条数：一单被驳回后再申请有两条记录，却只算**一次事故**；`rejected` 因订单已回退原态而天然排除 |
| 佣金支出 | Σ `ab_commission.amount`（`normal` 正项 + `reversal` 负项；`status='cancelled'` 剔除）= **净额** |

**M3-11 实现口径（D47–D50 · 零 DDL · 零错误码）**

| 项 | 口径 |
| --- | --- |
| ⭐ 口径唯一真相 `stats.constants.ts` | 状态集合 / 区间档位 / 基数选择 / TOP N 上限 / cohort 周数**全部收在一处**。看板每个数都是「多表 + 一组状态 + 一条时间轴」聚合出来的，而**同一指标极易在两个端点各算一套**（D47 的 GMV 与 D48 的楼群 GMV、D49 的菜品份数）—— 一旦漂移，运营会看到「总额 ¥4,798、分项加起来 ¥4,301」，从此不再信任任何一个数。e2e 用 **双端同源** 断言钉死（`D48.totalGmvFen === D47.metrics.gmvFen`） |
| ⭐ GMV 含在途退款 | 见上表。**这是本批次最容易被「顺手改错」的一条**：把 `refund_applying` 剔出 GMV 看似稳健，实则与「佣金/采购款取净额」的口径对不上，毛利被双向下拉。四个减项**必须放进同一个等式**才算得平，e2e 直接断言 `grossProfitFen === gmvFen − purchaseFen − fulfillmentFen − commissionFen` |
| ⭐ 成本侧取**净额** | 采购款 = Σ `ab_supplier_share.amount`（剔 `status ∈ {cancelled, reversed}`）；佣金 = Σ `ab_commission.amount`（剔 `status='cancelled'`）。`type='reversal'` 负行**必须计入**（它自己 status 有效）—— 只取正行会把已纠错的应付又算一遍 |
| 履约成本 | = (场所摊销 + 打包人工 + 配送费) 三项**配置单价之和 × 份数**，**不含** `settlement.supplier_total_default`（那是种子兜底示例值；采购款走实际应付单，两者都扣就是重复计成本）。单价来源与 D57 配置页**同一份** `BizConfigService.settlementCostState()` |
| ⭐ 毛利可靠性提示 `warnings` | 履约成本三项**未登记**（`isCostRegistered()` = 值 > 0，与 D57 同源）或采购应付单未生成 → 返回**「上限值」提示**。任何一个减项缺失都会让经营毛利虚高，不给提示等于让运营拿虚高的数做决策。前端另出 `costRegistration` / `costItems` / `purchaseGenerated` 供页面逐项标注 |
| 经营毛利可为负 | 退款订单的采购款仍要付（《自营结算口径定义》§5.1「退款不冲减供应商应付」），因此「GMV 不含 `refunded`、采购款却含它」会让该部分**毛利为负** —— 这是**刻意保留**的经营风险信号，不是 bug。前端 `is-negative` 标红 |
| 区间只开三档 | `range ∈ {today, 7d, 30d}`（缺省 `7d`，与原型首屏一致）；**非法值 → `10001`，不静默回落默认档** —— 否则运营以为在看 90 天、实际看的是 7 天。出参回带 `{range, days, startDate, endDate, label}`，**含末日**（近 7 日 = [今日−6, 今日]）；少算一天会静默丢掉昨天的数据，看板上完全看不出来 |
| 统计基准 | **出餐日**（`ab_order.meal_date`），不是下单时刻 —— 跨日下单（T-1 23:00 下单、T 日 11:30 送达）按下单时刻归集会落到错误的那一天 |
| D47 逐日趋势 `trend` | 区间内**每一天都给一行**（无单日补 0），端上不必自己补空洞；且 **Σ 逐日 GMV = 区间 GMV**（同源，不另算一套） |
| D47 出参结构 | `{ range, metrics, costRegistration, costItems, purchaseGenerated, warnings, trend }`。`metrics` 内 `avgOrderAmountFen`（客单价）与 `avgUnitPriceFen`（单份均价）**并列下发**；比率一律服务端算好（`refundRate` / `repeatRate` / `grossProfitRate`），端上不做除法 |
| ⭐ 双口径并列的取值 | `refundRate` / `repeatRate` 这类「分母可能为 0」的比率，分母为 0 时下发 **`0`**（页面要显示 0% 而不是空白）；而 `grossProfitRate` 分母为 0 时下发 **`null`**（毛利率 0% 与「没有收入」是两件事，页面显示「—」） |
| D48 楼群 / 楼栋 | 两个维度**分项之和 = 合计 GMV = D47 的 GMV**（楼栋被停用 / 软删也**保留行**，否则两个维度对不上）；行必带 `buildingGroupName`（找不到回退「未分组」/`楼群#id`，**不丢行**）；`gmvShare` 服务端算 |
| ⭐ D49 按**菜品**合并 | 份数 = Σ（该菜所属套餐被有效订单引用 × 订单份数）。⚠️ **一个菜被多个套餐引用时必须合并到同一行**（本库 `m1 = 菜品 1/6/4/7`、`m2 = 菜品 2/6/4/7`，6/4/7 三菜为两套餐共享）—— 按套餐展开就会拆成两行、热度被腰斩；e2e 的期望值**从 `ab_set_meal_item` 推导**而非写死（曾把共享菜当独占菜写死 5 份，实际应为 8 份） |
| D49 占比分母 | = 区间内**全部**菜品份数，**不是 topN 之和** —— 按 topN 之和算，排行末位的占比会凭空虚高。`topN` 缺省 10、上限 50（超限 → `10001`，不放开则一次查询即可拉全量菜品） |
| ⭐ D50 新客判定看**全历史**首单 | 首单出餐日落在本区间内 → 新客；早于区间 → 回流（`活跃 = 新客 + 回流` 必须闭合）。首单按**有效订单**判定（未支付/已取消/已退款不算首单，否则超时未支付会把用户判成老客）。**只看区间内的话，所有人都会显得像新客** |
| ⭐ D50 留存数字**成对下发** | `retainedWeek1` 与 `retentionRate1` **同生同灭**，只在「① 观察窗口（首单周 +7…+13）已走完**且** ② 该群非空」时才有值，否则两者都是 `null`。<br>① 未走完时算出来的低留存只是「数据还没长出来」，下发会让运营误判新客质量；② 0 人分群分母为 0（`0/0`），硬给 `0` 会被读成「0% 留存 = 新客质量极差」。<br>⚠️ **两种 `null` 不可混用**：`observable=false` = 观察中（页面标「观察中」），`observable=true` + 率为 null = 空群（页面显示「—」）。混成一个就会把「没人来」错说成「数据还没长出来」 |
| D50 cohort 划分 | **最近 4 个自然周**，**周一为始**（不是「最近 4 个 7 天窗口」—— 后者与日历周对不上，运营无法与周报对齐）；区间末日所在周为末群，故**末群必定「观察中」** |
| D50 出参 `note` | 口径说明随出参下发，端上**不复制第二份文案**（口径改了只改一处） |
| ⭐ 权限必须含 `viewer` | 类级 `@Roles('super_admin','admin','finance','operator','viewer')`。`admin-role.ts` 里 **`viewer` 的菜单只有这 4 个看板页** —— 接口白名单若漏了他，该角色会在自己**唯一拥有**的页面上拿 `10003`（「菜单能点、点了报无权限」，最容易被当成 bug 的一类不一致）。`operator`（运营要跟进经营数据）与 `finance`（要核毛利）同样必须放行 |
| 双主体隔离 | 小程序 token / 供应商 token 打 `/admin/stats/*` → `10003`。**不变量 I1 在看板上同样成立**：GMV / 佣金 / 毛利一个都不能漏给供应商；未登录 → `10002` |
| GET 不写操作日志 | 四个端点均为查询，**不标 `@OperationLog()`**（拦截器只记写操作） |
| 统计口径的**实现选型** | 取行回内存聚合，**不下推 SQL 求和**：① `SUM(decimal)` 在 MySQL 返回字符串、SQLite 返回浮点，归一方式不同，而四驱动零改动切换是硬约束 —— 取行后走 `fen()` 归一到整数分，跨驱动**逐分一致**；② 「有效订单」判定必须与 D47/D48/D49 三处**完全同源**，一处写进 SQL、一处写在 JS 就会漂移。代价是 O(行数)，MVP 单量下可接受，**单量破万后再把 `isValid` 下推 SQL（届时只改 `stats.service.ts` 一个文件）** |
| 错误码 | **无新增**（复用 `10001` 参数校验 / `10002` 未登录 / `10003` 无权限） |

### 6.7 系统管理（M37）

> **实现状态**：`D51–D56` 已实装（M3-1 基座批次）；**`D57–D58` 已实装（M3-10）**；`D59–D60` 待后续批次。
> 落点：`apps/api-server/src/modules/admin/` · 页面：`apps/admin-web/src/views/system/`。

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| D51 | GET | `/admin/system/accounts?page=` | 运营账号（M37-01） |
| D52 | POST | `/admin/system/accounts` | 新增账号 |
| D53 | PUT | `/admin/system/accounts/{id}` | 编辑 / 停用 |
| D54 | GET | `/admin/system/roles` | 角色与权限（RBAC） |
| D55 | PUT | `/admin/system/roles/{id}` | 权限调整 |
| D56 | GET | `/admin/system/logs?operatorId=&date=&page=` | 操作日志（M37-02） |
| D57 | GET | `/admin/system/configs` | 参数配置（套餐价、佣金比例、截单时间）（M37-03） |
| D58 | PUT | `/admin/system/configs` | 批量更新配置（**写日志 + 二次确认**） |
| D59 | GET | `/admin/system/templates` | 通知模板（M37-04） |
| D60 | PUT | `/admin/system/templates/{id}` | 编辑通知模板 |

**M3-1 实现口径（D51–D56）**

| 项 | 口径 |
| --- | --- |
| 权限范围 | 类级 `@Roles('super_admin','admin')` —— `operator` / `finance` / `viewer` / `supplier` 一律 `10003`。**前端菜单过滤只是体验层，判定权威在此** |
| D51 出参 | 分页（`{list,page,pageSize,total,hasMore}`）+ 每行附 `roleLabel` 与 `menus[]`（账号管理页可预览该角色可见菜单）。**任何接口都不回 `passwordHash`** |
| D52 入参 | `username`（3–64 位 `[A-Za-z0-9_.-]`）· `password`（≥8 位，**须同时含字母与数字**）· `role` · `realName?` · `supplierId?` · `phone?`。`role=supplier` 时 **`supplierId` 必填**（否则该账号登录后处处空白，形同故障）→ 缺则 `10001`；登录名重复 → `20009` |
| D53 入参 | `realName?` / `role?` / `supplierId?` / `phone?` / `status?`（1 启用 / 2 停用）。**不含密码**（改密属独立审计路径，一期由超管重建账号） |
| D53 防自锁 | 三条规则均返回 `20010`：① 不能停用自己 ② 不能降级自己 ③ 不能停用/降级**最后一个启用的 super_admin**。（③ 在「只有一个超管」时不可独立触发 —— 必先被 ①② 拦下，它是超管 ≥2 时的防线） |
| D53 副作用 | 角色或状态变更 → 写 KV 吊销标记 `admin:revoked:<id>`，**该账号旧 access token 立即失效**（`10002`），把原本最长 12h 的特权滞留窗口压到 0 |
| D54 出参 | `{ list: [{role,label,menus[],menuCount,isSystem}], note }`。`menuCount = -1` 表示全量通配（super_admin 的 `['*']`）。**menu key = 前端路由 path** |
| D55 | **一期明确不支持**（`10001` + 可行路径指引）。角色菜单定义在服务端代码 `common/constants/admin-role.ts`；改权限请走 D53 改账号角色。**刻意不返回「保存成功」** —— 权限改了却不生效比明确不支持危险得多 |
| D56 过滤 | `operatorId` / `module` / `date`（**按北京时间自然日**，服务端换算 `[d 00:00+08, d+1 00:00+08)`）。出参附 `operators[]` 供筛选器直接用 |
| D56 写入 | 由全局 `OperationLogInterceptor` 按 `@OperationLog({module,action})` 元数据落库：**写操作才记**（GET 不标）；**失败的请求也记**（`responseData.error.code`，审计要回答「谁试图做了什么但被拒」）；请求体内 `password`/`token` 等自动脱敏为 `[redacted]`；**写库失败仅 WARN，不影响业务** |

**M3-10 实现口径（D57–D58 · 零 DDL）**

> 落点：`apps/api-server/src/modules/admin/config/config.specs.ts`（**规格清单 = 唯一真相**）· `config.service.ts` · `dto/config.dto.ts`；
> 页面 `apps/admin-web/src/views/system/config.vue`（P36，**路由与菜单为脚手架预留，本批次无需改动**）；
> 验收 `scripts/e2e-m3.mjs` **§22**（35 条断言 · **不依赖下单窗口**）。

| 项 | 口径 |
| --- | --- |
| ⭐ 唯一真相 `CONFIG_SPECS` | **一份声明**同时驱动 D57 的分组/标签/说明、D58 的白名单与取值范围、前端的控件类型。若把中文标签写前端、校验规则写 DTO、可写判定藏服务方法，同一个键就有三份互相漂移的定义（本项目头号顽疾「两个真相」） |
| ⭐ `wiring` 接线状态（本批次核心产出） | 排查发现 **9 项键「种子里配了、服务端代码从不读取」**：`set_meal.publish_time` / `cutoff_time` / `delivery_arrival_time`、`commission.auto_confirm_time` / `settle_hour` —— 实际调度**硬编码在 `@Cron()` 装饰器**里（NestJS 的 cron 是静态元数据，不读配置）；`distribution_center.default_count` / `rice_fee` / `pack_fee`、`supplier.settle_cycle` —— 口径已改由表驱动或代码常量确定。**一律如实标注 + 置为只读 + 给出具体原因**（`unwiredReason` 要点名是哪个 task），而不是给一个「看起来能改、改完没反应」的输入框。另 **2 项为策略标识**（`settlement.supplier_purchase_price` = `negotiated`、`settlement.gross_profit_policy` = `residual`）—— 存的是策略名，塞个金额进去就把口径记录污染了 |
| 白名单 | 不在 `CONFIG_SPECS` 内的键 → **10001**（**不是静默忽略**）。`ab_config` 是通用键值表，放开「任意 key 都能改」等于开了改内部状态的后门；静默忽略更糟 —— 运营以为改了，实际什么都没发生。**未接线项与策略标识也一律拒写**（而非「写了但不生效」，那等于给假承诺） |
| 整批原子 | 任一项不合法 → **整批不写入**（同事务，不做部分写入）。部分成功会让「二次确认」失去意义：确认了 5 项、只生效 3 项，且看不出是哪 3 项 |
| ⭐ percent 单点换算 | 入参与出参**都是百分数**（`8` = 8%），库内存比率（`0.0800`）。换算只此一处（`normalizeForStore`）—— 若分散实现，迟早有某条路径把 `8` 直接写进费率列，**佣金算错 100 倍**。e2e 用「写 `8.5` → 库内必须是 `0.0850`」钉住 |
| 数值格式前置校验 | `Number('')` 与 `Number(' ')` 都是 `0` —— **必须**先过 `/^-?\d+(\.\d+)?$/`，否则运营清空金额输入框会被**静默存成 `0.00`**；对成本项而言就是「悄悄变回未登记」，且没有任何报错 |
| ⭐ 写完同步刷新缓存 | `BizConfigService` 有 60s 进程内缓存 → D58 写完**必须**调 `invalidate()`。等 TTL 就会出现「配置页显示已改、业务仍按旧值跑」。e2e 用「写 `site_fee` 后**立刻**重读 D57」把它钉住（D57 的 `meta` 刻意走缓存路径，否则这条断言验证不到任何东西） |
| 库中缺失的键 | `order.pay_timeout_minutes` / `settlement.supplier_total_default` **不在种子数据里**，靠 `getNumber(key, fallback)` 兜底运行。D57 显示 `valueSource='fallback'` + 兜底值（空白会让运营以为「配置丢了」，而系统其实正按该值在跑）；D58 首次调整时 **INSERT** 新行（`UPDATE` 不到就当失败 = 这个值永远改不了） |
| 履约成本登记判据 | 自营下场所摊销 / 打包人工 / 配送费都是**真实成本**，`0` 只可能表示「未登记」→ 判据 `isCostRegistered()` = `值 > 0`。实现只有 `shared-utils` 一份，**D57 配置页与 D47 数据看板共用** —— 两处各自实现必然出现「配置页说已登记、看板说未登记」 |
| D57 数据来源 | `groups[]` 明细**直读** `ab_config`（需要 `updatedAt` / `createdAt` 等表字段）；`meta.settlementCost` 走 `BizConfigService.settlementCostState()`（**经缓存**）。后者正是「写完即时生效」可被 e2e 验证的原因 |
| D58 出参 | `changed[]` 给出**变更前 → 变更后**（前端二次确认弹窗要能列 diff，而不是只说「保存成功」）+ `unchanged[]`（提交相同值时**不写库**、不产生假变更记录）；`effectiveAt` 回带生效时刻 |
| 前端二次确认 | D58 要求的「二次确认」落在**前端**：提交前弹窗逐项列出「前 → 后」。弹窗内容用 **VNode** 而非拼 HTML 字符串 —— 配置值里可能含尖括号，拼 HTML 等于把运营输入当代码渲染 |
| 权限 | 类级沿用 `@Roles('super_admin','admin')`。**刻意不收窄到只放超管**：`admin` 本就能改供应商结算账户（D28），改系统配置不构成新的权限升级。`finance` / `operator` / `viewer` / `supplier` 一律 `10003` |
| 操作日志 | `@OperationLog({ module:'system', action:'更新系统配置' })` —— 改了全局口径必须能回答「谁在什么时候改的」 |
| 未接线项为何不顺手接上 | ⚠️ **不在本批次把配置接到调度上**：`@Cron()` 是静态元数据，动态化需改用 `SchedulerRegistry` 或 `@Interval` + 运行期判断，会动到**下单窗口**（e2e 全量依赖 14:00–23:00 时间窗），属独立验收项。混在本批次只会让「配置页做完了」掩盖「调度还没接线」→ **已登记为独立待办（见《缺陷与陷阱》#49）** |
| 错误码 | **无新增**（复用 `10001`）；`data.fields` 回带逐条中文问题描述（如「『套餐默认售价』不能小于 0.01 元（当前 0）」） |

**M3-12 实现口径（D59–D60 · 新增第 27 张表 `ab_message_template`）**

> 落点：`apps/api-server/src/modules/admin/template/message-template.specs.ts`（**场景声明 = 唯一真相**）· `message-template.service.ts` · `dto/message-template.dto.ts` · `admin.controller.ts`（D59/D60 两个方法）；
> 投递侧 `apps/api-server/src/modules/message/message.service.ts`（M3-12 由空模块实装）；
> 页面 `apps/admin-web/src/views/system/message-template.vue`（P36 · 路由与菜单为脚手架预留，本批次无需改动）；
> 验收 `scripts/e2e-m3.mjs` **§24**（47 条断言 · **不依赖下单窗口**）。

| 项 | 口径 |
| --- | --- |
| 依据 | 原型 `P36 系统配置` 的「📨 消息推送策略（微信订阅消息）」卡片，**5 个场景逐行对应**。三条原文口径：① 用户端**常规订单状态不推送**（避免打扰），退款结果 / 异常属**必推项**；② 团长送达通知走「微信群 + 服务通知」双渠道；③ 初期以**微信群人工通知兜底** |
| ⭐ 与原型的一处**有意收窄**：团长送达通知只声明**单渠道** `wechat_group` | 原型把该场景写成「微信群 + 服务通知」双渠道，但一期**只有人工发群**（原型自己也写「初期以微信群人工通知兜底」，服务通知属**二期替代方案**）。若照抄双渠道：订阅消息是启用必要条件 → 该场景在种子里启用后**必然缺微信模板 ID** → 「已启用」与「启用闸门」当场互相矛盾（要么放行一个发不出去的场景，要么把唯一能用的场景也锁死）。**渠道是代码事实** —— 代码一期只发人工群，就照实写。二期接服务通知时，改 `specs` 加渠道即可（闸门会自动开始要求模板 ID） |
| ⭐ 存储选型：**独立表**而非塞进 `ab_config` | `CONFIG_SPECS` 的类型系统是**扁平标量**（money / percent / int / text / time），撑不住「场景 + 多渠道 + 变量白名单 + 启用闸门」。硬塞只有两条路：JSON-in-`config_value`（则 D58 的白名单与单点校验失效，校验逻辑四散 → 立刻多出第二个真相），或拆成十几个扁平键（则「一个场景」这个整体在库里不复存在，`ab_message.template_id` 也无从对应）。**规范 §八 原将 `ab_message` 列入 P36 依赖 —— 实际是「推送日志」表（`template_id` 存的是微信侧模板 ID），不是模板定义**，故本批次新增载体并在此登记 |
| ⭐ **场景定义是代码事实，不落库** | `scene` / 渠道组合 / 触发时机 / 变量白名单 / 是否必推全部在 `message-template.specs.ts`。落库会漂移成「库里写着走微信群、代码只发订阅消息」这种**无法自证**的矛盾。库表只存**可编辑部分**：`enabled` / `wechatTemplateId` / `groupContent` / `updatedBy` |
| ⭐⭐ **微信订阅消息的文案不由本页决定** | 订阅消息内容在**微信公众平台**按模板定义（`thing1` / `time2` 这类 keyword），服务端只能往 `data` 填值。故 D59 的 `note` **明写这一点**：本页文案字段服务「微信群人工通知」与台账存档，**改它不会改变用户收到的订阅消息**。不写明，运营会以为改了文案用户就能看到新内容 —— 即 M3-10「给了输入框却没接上线」的同类问题 |
| ⭐ **接线状态两级如实标注** | **场景级** `wiring`：`live`（有真实投递点）/ `pending`（一期无投递点，**必附 `pendingReason`** 点明为什么）。**字段级** `fieldWiring`：`enabled`/`wechatTemplateId` = `live`（真生效）、`groupContent` = `record_only`（供人工复制发群，**不是程序行为**）。一期 `live` 仅有 `refund_result` 一条 |
| ⭐⭐ **启用闸门 fail-closed** | 每个渠道有**必要条件**（`wechat_subscribe` → 模板 ID；`wechat_group` → 文案），缺一即**拒绝启用**（`10001`）。放行的后果是页面显示「已启用」而投递必然失败 —— 用户永远静默收不到，且**没有任何地方显示异常**。判定按**改动后的最终状态**（而非仅看本次提交的字段）：否则可「先清空模板 ID，再单独发一次 `enabled=1`」绕过 |
| 渠道必要条件单点 | 判定函数 `missingForEnable()` 在 `specs` 里，**管理侧（D60 保存前）与投递侧（`MessageService` 判断能否发）共用** —— 两边各写一遍迟早出现「管理侧允许启用、投递侧判定不可发」的死角 |
| 变量白名单 | `groupContent` 里 `{{变量}}` 必须 ∈ 该场景 `variables`，否则 `10001`。写错的变量发送时不会被替换，用户会直接看到 `{{xxx}}` 原文。**边界**：只有**双**花括号算占位符，单花括号 `{3}` 不匹配（否则「共 {12} 份」这类自然文本会被误判拒写）；空白容忍 `{{ orderNo }}` ≡ `{{orderNo}}` |
| ⭐ 只读字段**拒绝**而非静默忽略 | 全局 `ValidationPipe` 已开 `forbidNonWhitelisted: true` → DTO 未声明的字段（`scene` / `channels` …）直接 `10001`。**静默忽略更糟：调用方以为改成功了**。与 D58 的「未知键拒绝」同源 |
| 「未传」与「传 null」是两种语义 | 字段缺省 = **不改**；显式 `null` / 空串 = **清空**。判定用 `!== undefined`，**不能用** `'field' in dto`（DTO 类字段以 `undefined` 初始化 ⇒ `in` 恒为 true，见《缺陷与陷阱》#46）。空串在服务端归一到 `null`，避免「未配置」有两种表示 |
| 空请求 | 三个可编辑字段一个都没传 → `10001`。无意义的调用不是幂等成功 —— 回一句「已更新」会让调用方以为改了什么 |
| ⭐ 真消费点：退款结果通知 | `refund.service.ts` 的**两个退款执行口**（D11 强制退款 / D41 审批通过）在 **`dataSource.transaction()` 返回之后**调用 `MessageService.notify()`。⭐ **必须在事务外**：事务里发了通知而事务回滚，就是「用户收到退款通知但退款并未发生」。一期 `wxData` 的 key 用**我们自己的变量名**，真实 keyword 映射待微信模板创建后在**一处**完成 |
| 通知失败绝不影响业务 | `notify()` **不抛异常**，所有问题收敛进返回值（`delivered` / `reason` / `ok`）；调用点再兜一层 `try`。退款已成功、钱已出去，通知失败只能是「这次没通知到」，不能把成功的交易变成失败 |
| **未启用 = 不投递且不留日志** | `ab_message` 的语义是「**发过什么**」；把「因为没启用所以没发」也写进去，这张表就失去查询价值。e2e 用「关闭场景退款 → 日志增量为 0；启用后同操作 → 日志 +1 且 `status=success`」把这条钉死 |
| `userId → openid` 归投递侧 | 调用方只给业务对象（`userId`），换算在 `MessageService` 内完成 —— 业务侧不该为发通知去 join 用户表 |
| **不引入缓存** | 全表 5 行、只在「打开管理页」与「产生一条退款通知」时读，属低频路径。**没有缓存就没有「写完忘了失效」**。将来读频率上来再加，届时必须同时补 `invalidate()` 调用点（代码注释已留此约束） |
| 种子状态 | 由 `MESSAGE_TEMPLATE_SPECS` **派生**（不存在第二份场景列表）。⭐ **只有 `leader_delivery` 启用**：它含微信群渠道（人工发群只需文案），不依赖尚未申请的微信模板 ID；其余 4 个场景 `enabled=0`，如实反映「一期没有微信账号」 |
| 库中多余行 | 库里有、声明里没有的场景行**不展示**（代码不会用它投递），但**大声记 WARN 日志** —— 静默无视会让脏数据永远没人发现 |
| 权限 | 类级沿用 `@Roles('super_admin','admin')`（同 D51–D58）。`operator`（菜单本就不含 `/system/*`）/ `finance` / `viewer` / `supplier` / 小程序 token 一律 `10003`；未登录 `10002` |
| 操作日志 | `@OperationLog({ module:'system', action:'编辑通知模板' })` —— 必须能回答「谁在什么时候关掉了退款通知」。GET 不标 |
| 错误码 | **无新增**：目标不存在 → `10004`；闸门 / 变量 / 只读字段 / 空请求 / `id` 非法 → `10001`（`data.fields` 回带逐条中文说明） |

---

## 七、回调与探针

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| W1 | POST | `/pay/notify` | 微信支付结果通知（V3，验签 + 解密） |
| W2 | POST | `/pay/refund-notify` | 退款结果通知 |
| W3 | POST | `/pay/transfer-notify` | **佣金打款结果回执**（灵活用工平台代发结果；一期由运营登记，二期接平台回调） |
| W4 | GET | `/health` | 健康检查（DB / Redis / 微信连通性） |

> 回调统一返回 `{"code":"SUCCESS","message":"成功"}`；`wx-signature.guard` 校验 `Wechatpay-Signature` + 证书序列号，失败直接 401，**不入业务**。

---

## 八、接口 ↔ 页面 ↔ 表 映射总表

| 原型页 | 功能 | PRD | 主要接口 | 主要表 |
| --- | --- | --- | --- | --- |
| P1 | 首页 | M01-01 | U1 | `ab_meal_assignment`、`ab_set_meal`、`ab_set_meal_item`、`ab_dish` |
| P38 | 今日这盒溯源 | M01-04 | U5 | `ab_supplier_dish_daily`、`ab_dish`、`ab_supplier`、`ab_distribution_center` |
| P3/P4 | 下单/支付 | M02 | U6/U7/U8 | `ab_order`、`ab_payment_log`、`ab_balance` |
| P5/P6/P7 | 订单详情/列表/取消 | M03 | U9/U10/U11 | `ab_order`、`ab_refund` |
| P8/P9 | 个人中心/余额明细 | M04 | U12/U13/U14 | `ab_user`、`ab_balance`、`ab_balance_log` |
| P10 | 团长邀请落地 | M01-03 | U3 | `ab_leader_invite`、`ab_team_leader` |
| P11/P12 | 工作台/本楼概况 | M11/M12 | L1/L4 | `ab_order`、`ab_team_leader` |
| P13/P14 | 订单明细/退款处理 | M12 | L4/L5/L6/L7 | `ab_order`、`ab_refund` |
| P15 | 取餐确认 | M13 | L8/L9 | `ab_delivery_record`、`ab_order` |
| P16/P17/P18 | 佣金/余额/提现 | M14 | L10–L13、**L19** | `ab_commission`、`ab_balance`、`ab_balance_log`、**`ab_withdraw`** |
| P19/P20 | 分享/资料 | M11/M15 | L2/L3/L14–L18、**L20/L21/L22** | `ab_team_leader`、`ab_leader_invite`、`ab_balance`、`ab_withdraw` |
| 联系客服（无 P 编号） | 客服微信号 | M04 | **U17** | `ab_config`（`service.*`） |
| P21/P22 | 商家工作台/出餐 | M21 | S1/S2/S3 | `ab_supplier_dish_daily`、`ab_meal_assignment` |
| P23/P24 | 菜品/上架申请 | M22 | S4–S7 | `ab_dish`、`ab_supplier` |
| P25/P26 | 结算/资料 | M23/M24 | S9–S14 | `ab_supplier_share`、`ab_supplier` |
| P27/P28/P29 | 套餐矩阵/新建/模板 | M31 | D1–D7 | `ab_meal_assignment`、`ab_set_meal` |
| P30/P31 | 订单中心/详情 | M32 | D8–D12 | `ab_order`、`ab_operation_log` |
| P32 | 团长管理 | M33 | D19–D22 | `ab_team_leader`、`ab_leader_invite` |
| P33 | 供应商管理 | M34 | D23–D32 | `ab_supplier`、`ab_distribution_center` |
| P34 | 财务结算 | M35 | D33–D46（**已实装** D33–D35 资金总览/佣金/佣金入账（M3-13）· D36/D37 应付结算 · **D38–D39 余额账户管理与调整（M3-14）** · D40–D42 退款审批；**待落点** D43 对账 · D44 发票） | `ab_commission`、`ab_supplier_share`、`ab_refund`、**`ab_balance`、`ab_balance_log`** |
| P35 | 数据看板 | M36 | D47–D50（**已实装**） | 聚合查询 |
| P36 | 系统配置 | M37 | D51–D60（**已实装**） | `ab_admin_user`、`ab_operation_log`、`ab_config`、`ab_message`、**`ab_message_template`** |
| P37 | 办公楼管理 | M33 | D13–D18 | `ab_building`、`ab_building_group` |

---

## 九、错误码总表

| code | message（默认可覆写） | 触发场景 | 建议 HTTP |
| --- | --- | --- | --- |
| **0** | ok | 成功 | 200 |
| **10001** | 参数校验失败 | DTO 校验不通过（附 `data.fields`） | 400 |
| **10002** | 未登录或登录已过期 | JWT 缺失/失效 | 401 |
| **10003** | 无权限访问该资源 | 角色/团长身份不匹配 | 403 |
| **10004** | 资源不存在 | 订单/团长/供应商不存在 | 404 |
| **10005** | 请求过于频繁，请稍后再试 | 限流 | 429 |
| **10006** | 请勿重复提交 | 幂等键命中 | 200 |
| **20001** | 微信登录凭证已失效，请重试 | code2session 失败 | 400 |
| **20002** | 用户不存在 | openid 未注册 | 404 |
| **20003** | 团长身份已失效 | 见习超 30 天未促单（C2） | 403 |
| **20004** | 手机号已绑定其他账号 | 团长资料冲突 | 409 |
| **20005** | 账号或密码错误，已锁定 15 分钟 | 后台连续失败 5 次 | 423 |
| **20006** | 账号已被停用 | 小程序用户黑名单（**扩展**） | 403 |
| **20007** | 你已是团长 | 重复提交申请（C3 无审核，**扩展**） | 409 |
| **20008** | 暂不能退出：请先结清余额并等待提现到账 | 退出团长时资金未清（余额/冻结/在途提现/待结算佣金，`data.blockers` 逐条下发，**扩展**） | 409 |
| **20009** | 登录名已被占用 | D52 新增账号时 `username` 已存在（**扩展**） | 409 |
| **20010** | 账号受保护，不能停用或降级 | D53 防自锁三条规则（停用自己 / 降级自己 / 动最后一个 `super_admin`）（**扩展**） | 403 |
| **20011** | 被任命的用户不存在或不可用 | D20 被任命者不是已注册用户（或账号已停用）—— 团长是叠加身份，没有 `ab_user` 就收不到取餐提醒、登不进小程序，属纯脏数据（**扩展**） | 404 |
| **20012** | 该办公楼已有在职团长，转交需确认 | D20 任命 / D21 换楼：目标楼已被在职团长占用且未显式确认 —— 回带 `data.occupiedBy`（**扩展**） | 409 |
| **20013** | 团长当前状态不支持该操作 | D22 例外处理：对已停职者再停用 / 对已在职者再恢复 —— **不是幂等成功**，否则审计链上分不清「是谁停的」（**扩展**） | 409 |
| **30001** | 今日 24:00 已截单，明日请早 | 截单窗口外下单 | 409 |
| **30002** | 份数超出单次上限 | 超过 `order.max_quantity` | 400 |
| **30003** | 当前订单状态不支持该操作 | 状态机拒绝 | 409 |
| **30004** | 请勿重复下单 | 同用户同日重复提交 | 409 |
| **30005** | 该办公楼今日未开团 | 无套餐分配 | 404 |
| **30006** | 余额抵扣金额不合法 | 负数 / 非整数分 | 400 |
| **30007** | 团长不存在或已停用 | 邀请码无效 | 404 |
| **30008** | 套餐不存在 | 分配已下架 / id 非法（**扩展**） | 404 |
| **30009** | 已售罄 | 当日份数耗尽（**扩展**） | 409 |
| **30010** | 订单不存在 | 单号非法 / 越权访问（**扩展**） | 404 |
| **30011** | 该楼群当日已有套餐分配，请直接编辑 | D2 重复创建（`uk_meal_assignment_date_group` 的业务化） | 409 |
| **30012** | 套餐分配不存在 | D3/D4 目标 id 非法；D5 源日无分配可复制（**扩展**） | 404 |
| **30013** | 已过截单时刻，不能再上架 | D4 上架闸门 —— 放行会造出「看得见点不动」的套餐（**扩展**） | 409 |
| **30014** | 已过截单时刻，不能再改单 | D10 改单闸门（改份数与改楼都拦）—— 供应商已按原份数备货（**扩展**） | 409 |
| **30015** | 目标办公楼与原办公楼不在同一楼群 | D10 跨楼群改单 —— 跨群等于连套餐与集散一起换（**扩展**） | 409 |
| **40001** | 支付单创建失败，请稍后重试 | 微信下单异常 | 502 |
| **40002** | 余额不足 | 抵扣超出可用额 | 409 |
| **40003** | 提现金额低于最低限额 | < ¥10.00 | 400 |
| **40004** | 已截单，无法自助退款 | C6 拦截 | 409 |
| **40005** | 佣金结算失败，请联系运营 | 入账 / 灵活用工代发异常 | 502 |
| **40006** | 该笔应付已付款，需走反向冲减 | 直接改已付结算单被拒 | 409 |
| **40007** | 请先绑定收款方式 | 提现前置校验 | 400 |
| **40008** | 退款申请已存在，请勿重复提交 | 幂等 | 409 |
| **40009** | 支付单不存在 | U8 查询 / 补偿核对时未命中（**扩展**） | 404 |
| **40010** | 退款失败 | 微信退款未受理 —— 整个事务回滚，不留「有退款单没退款」的哑单（**扩展**） | 502 |
| **40011** | 可退金额与提交金额不一致 | D11 防误操作参数（不是部分退款，一期只支持全额）（**扩展**） | 409 |
| **40012** | 退款单不存在 | D41/D42/D40 详情目标 id 非法或越权（**扩展**） | 404 |
| **40013** | 当前退款单状态不支持该操作 | D41/D42 非 `applying` 态（含重复审批 —— 已是终态，不产生第二次出款）（**扩展**） | 409 |
| **40014** | 退款单缺少原订单状态，无法驳回 | D42 `order_status_before` 缺失 —— **fail-closed**：不回退到猜测的默认状态（**扩展**） | 409 |
| **40015** | 冻结余额不足 | D39 `unfreeze` 超出冻结额 —— **fail-closed**。与 `40002`（余额不足）**刻意分码**：`40002` 是「钱不够花」（等入账 / 充钱即可），`40015` 是「冻结账对不上」（余额快照与冻结记录不一致，**要查数据不是让人充钱**）；合流一个码，运维就分不清该做什么（**扩展**） | 409 |
| **50001** | 供应商资质未通过审核 | 出餐前置校验（S2 · D26 `audit_status != approved` 或证照过期）（**扩展**） | 403 |
| **50002** | 集散中心配置不可删除（存在历史结算） | 软删保护（D32 两道前置：历史应付 / 被分配引用）（**扩展**） | 409 |
| **50003** | 结算等式不闭合 | C9 校验：售价 ≠ 供价 + 场地费 + 打包人工 + 配送费 + 佣金 + 平台毛利（**扩展**） | 409 |
| **50004** | 可提现余额不足 | 提现申请超出可用余额（L12） | 409 |
| **50005** | 出款通道异常 | C11 灵活用工平台（`PayoutChannel`）异常（**扩展**） | 502 |
| **50006** | 供应商不存在或已停用 | D23/D25–D28（**扩展**） | 404 |
| **50007** | 集散中心不存在或已停用 | D31/D32（**扩展**） | 404 |
| **50008** | 供应商类型与集散中心冲突 | D27 降级为纯出餐型但名下仍有集散中心；D30/D31 把集散中心挂到纯出餐型主体下（**扩展**） | 409 |
| **50009** | 已过出餐确认截止时间 | S2 迟于出餐日当天 09:30 才确认 —— **fail-closed**，不接受「补确认」把错过的时点抹平（时间戳必须诚实，对账与追责都以它为准）（**扩展**） | 409 |
| **50010** | 当日无该菜品生产计划 | S2 目标菜不属于本供应商 / 该日无生产计划（**扩展**） | 404 |
| **50011** | 集散中心不在该菜品的配送范围 | S2 越界确认 —— 若放行，供应商能把 A 片的份数确认到 B 片头上，S3 在 B 片显示「已到齐」而实物没到，打包线在错误的时点开动（**扩展**） | 400 |
| **50012** | 应付单不存在或当前状态不可操作 | D37 付款登记目标 id 非法；或状态非 `pending`（已付款再登记就是**重复出款**，钱转出去追不回来）—— 与 50006/50007 同一形态：「查得到但动不了」与「压根不存在」合流一个码（对操作员是同一件事）（**扩展**） | 409 |
| **50013** | 付款登记缺银行回单号 | D37 `paymentVoucherNo` **必填** —— 回单号是「这笔钱确实付了」的唯一凭证；没有它，系统里的 `success` 只是一句口头承诺（**扩展**） | 400 |
| **60001** | 办公楼不存在 | D13 详情 / D15 编辑目标 id 非法；D14 `buildingGroupId`、D17/D18 `buildingIds` 里含不存在的楼 —— **不静默跳过**（否则运营以为挂上了 3 栋、实际只挂上 2 栋）（**扩展**） | 404 |
| **60002** | 楼群不存在 | D14 传入的 `buildingGroupId` 非法；D16 详情 / D17 / D18 目标 id 非法（**扩展**） | 404 |
| **60003** | 楼群下仍有办公楼，不能停用 | D18 停用非空楼群 —— **fail-closed**：停用会让成员楼**静默**失去开团能力，而楼自身状态仍显示「营业中」，运营在 P37 列表上看不出异常。出参带 `data.remaining` 与「改用停用」以外的出路提示（**扩展**） | 409 |
| **60004** | 楼群名称已存在 | D17 新建 / D18 改名撞已有楼群名 —— 同名群会让「给国贸组发通知」发错对象（**扩展**） | 409 |
| **60005** | 办公楼名称已存在 | D14 新建 / D15 改名撞已有楼名 —— 同名楼会让「按楼筛选」变成歧义操作（**扩展**） | 409 |
| **90001** | 系统繁忙，请稍后再试 | 未捕获异常 | 500 |

> **扩展码**：`20006` / `20007` / `20008` / `20009` / `20010` / `20011` / `20012` / `20013` / `30008` / `30009` / `30010` / `30011` / `30012` / `30013` / `30014` / `30015` / `40009` / `40010` / `40011` / `40012` / `40013` / `40014` / `40015` / `50003` / `50005` / `50006` / `50007` / `50008` / `50009` / `50010` / `50011` / `50012` / `50013` / `60001` / `60002` / `60003` / `60004` / `60005` 号段内文档原未列、但工程实现需要，已按「号段末尾登记」规则回写本表（见 `apps/api-server/src/common/constants/error-code.ts` 头部纪律）。**禁止挪用文档已占用的号位。**

> **号段划分**：`1xxxx` 通用 · `2xxxx` 账号/团长身份 · `3xxxx` 套餐与订单 · `4xxxx` 支付与退款 · `5xxxx` 供应商与集散 · **`6xxxx` 主数据（办公楼 / 楼群）** · `9xxxx` 系统。

> **前端契约**：`code` 为**稳定标识**，文案可迭代；端上对 `10002`（跳登录）、`30001`（截单提示）、`40004`（引导联系团长）做特殊分支处理。

---

## 十、变更与治理

| 项 | 规则 |
| --- | --- |
| 版本策略 | 路径版本 `/api/v1`；**破坏性变更**才升 v2，兼容性新增不改版本 |
| 字段新增 | 向后兼容，前端需容忍未知字段 |
| 字段废弃 | 先标注 `@deprecated` + 保留 2 个小版本，再移除 |
| 契约来源 | 本文件为**人工契约前提**；实现后由 NestJS Swagger 输出至 `/api/docs` 与 `docs/api/` |
| 变更审批 | 接口新增/变更须同步更新本文件 + `packages/shared-types` 类型 + 通知前端负责人 |
| 联调基线 | 以 `v1.0-baseline` tag 为起点，联调期禁止单方改契约 |

---

*文档结束 · ABox 一盒 · 接口规范 v1.0 · 2026-09-14*

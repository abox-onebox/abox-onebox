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
| 最近修订 | 2026-09-17 · ① **M3-1 后台鉴权基座**：A1–A6 重写（双主体隔离 / 登录失败锁定 / 令牌吊销 / 无状态登出 / 查库求证）+ D51–D56 口径 + 错误码 20009·20010；② **M3-2 套餐编排**：D1–D7 实现口径表 + 两个扩展选择器（`/admin/meal/dishes`、`/admin/meal/distribution-centers`）+ 错误码 30011·30012·30013；③ **M3-3 订单中心**：D8–D12 实现口径表 + C9 反向结算 + `executeRefund` 唯一执行口 + 错误码 30014·30015·40009–40011；④ **M3-4 退款审批（C6 三段式收口）**：D40–D42 实现口径表 + `ab_refund.order_status_before` + 错误码 40012·40013·40014；⑤ **M3-5 后台团长管理**：§6.3 补 D19–D22 实现口径表（26 项）+ 错误码 20011·20012·20013（**零 DDL 变更**）；⑥ **M3-6 后台供应商管理 + 集散**：§6.4 补 D23–D32 实现口径表（34 项）+ 扩展接口登记（`filter-options` / 详情 / 外卖链接 / 菜品库）+ `ab_supplier` 7 新列 + 错误码 50003·50005·50006·50007·50008；⑦ **M3-7 后台办公楼与楼群（P37 五视图）**：§6.3 补 D13–D18 实现口径表（27 项）+ 扩展接口登记（`filter-options` / `overview` / `delivery-map` / 详情）+ `ab_building` 增 `population` 列 + **状态三态修订**（`BuildingStatus` 1/2/3）+ `DistributionGap` 覆盖缺口三因 + 错误码 60001–60005（新号段 `6xxxx 主数据`）；⑧ **M3-8 供应商端出餐确认（S1–S3 · 原型 P21/P22）**：§五 补 S1–S3 实现口径表（派生落库 / 09:30 deadline 语义 / 按集散中心逐项确认 + 幂等 / S3 闸门与路线派生 / 不返回距离时长）+ 新表 `ab_supplier_dish_center_daily`（25→26 张）+ 错误码 50009·50010·50011；⑨ **结算口径改自营（2026-09-16 路线二次裁定）**：S9 应付结算口径**整表重写**（性质=半成品采购应付 / 计费基数=**实收量** / 应付对象仅供应商 / 场地费-打包-配送转为 ABox 自身成本不出付款单 / fail-closed 出单 + 未出单异常清单 / ⭐ **用户退款不冲减供应商应付**）+ 退款冲销段旧口径**作废标注**（`reverseSupplierShares` 待回退，列为 M3-9 开工前置）+ 错误码预留 50012·50013·50014 —— 详见《ABox一盒自营结算口径定义v1.0.md》；⑩ **M3-9 应付结算 S9 落地（自营口径首次实装 · 零 DDL）**：§五 补 S9 供应商端结算自查实现口径 + §6.5 补 D36/D37 实现口径表（出单 / 列表 / 付款登记 / 未出单异常清单）+ **回退 M3-3 `reverseSupplierShares`**（退款**不再**冲减供应商应付；出参显式声明 `supplierShareAdjusted=0` + `supplierShareMode='not_applicable'`）+ 落点登记（`/admin/supplier-shares` · `/supplier/settlement`）+ 错误码 50012·50013（**50014 未使用，号位已释放**）+ e2e `§21` 新增 41 条断言；⑪ **M3-10 系统配置（P36 · D57–D58 · 零 DDL）**：§6.7 补 D57/D58 实现口径表 + ⭐ **「接线状态」如实标注** —— 排查出 **9 项键「种子里配了、但服务端代码从不读取」**（时间类配置被 `@Cron()` 硬编码架空、`distribution_center.*` 已改表驱动），页面**只读展示 + 注明原因**，不给「改了不生效」的输入框；+ 配置白名单（未知键拒绝而非静默忽略）/ 整批原子 / percent **百分数↔比率单点换算** / 写完 `invalidate()` **同步刷新缓存** + e2e `§22` 新增 35 条断言；⑫ **M3-11 数据看板 D47–D50（P35 · M36 · 零 DDL · 零错误码）**：§6.6 **关键指标口径表修正 + 新增实现口径表（30 项）** —— ⭐ 修正 **GMV 口径**（原写「已完成订单、不含已退款」→ 改为「状态 ∉ {未支付, 已取消, 已退款}，**含在途退款**」：钱未退、佣金未冲销，剔除会造成双向错配）+ **客单价/单份均价并列下发**（原文括号里「份数 / 订单量」含糊，只给一个数必被读错）+ **退款率分子 = 订单数而非 `ab_refund` 条数** + **经营毛利减项改为净额口径**（采购/佣金剔 `cancelled`/`reversed`，`reversal` 负行计入）+ ⭐ **口径唯一真相 `stats.constants.ts`**（D47/D48/D49 三处同源，e2e 用「D48 合计 = D47 的 GMV」钉死）+ ⭐ **D49 按菜品合并**（一个菜被多套餐引用必须并到一行，否则热度腰斩；e2e 期望值从 `ab_set_meal_item` 推导）+ ⭐ **D50 留存数字成对下发**（观察窗口未走完 **或** 群为空 → `retainedWeek1`/`retentionRate1` 双 `null`，两种 `null` 语义不可混用）+ ⭐ **权限白名单必须含 `viewer`**（该角色菜单只有这 4 个看板页，漏了就「菜单能点、点了报 10003」）+ **区间只开 today/7d/30d 三档**（非法 `range` → `10001`，不静默回落）+ 内存聚合、不下推 SQL 的**选型理由**（跨 mysql/sqlite 金额逐分一致 + 三处同源，单量破万再下推）；§八 映射表 P35 转「**已实装**」；e2e `§23` 新增 **61 条断言**；⑬ **M3-12 通知模板（P36 · D59–D60 · 新增第 27 张表 `ab_message_template`）**：§6.7 补 M3-12 实现口径表 —— ⭐ **存储选型：独立表而非塞进 `ab_config`**（`CONFIG_SPECS` 是**扁平标量**类型系统，撑不住「场景 + 多渠道 + 变量白名单 + 闸门」；且 `ab_message` 实为**推送日志**表，不是模板定义）+ ⭐ **场景定义是代码事实、不落库**（`scene`/渠道/触发时机/变量白名单/是否必推全在 `message-template.specs.ts`，落库必然漂移成「库里写着走微信群、代码只发订阅消息」）+ ⭐⭐ **「启用」闸门 fail-closed**（每个渠道有必要条件 `wechat_subscribe→模板ID` / `wechat_group→文案`，缺一即拒启用 `10001`，判定按**改动后最终状态**以防「先清空条件再单独 enabled=1」绕过；判定函数 `missingForEnable()` 由**管理侧与投递侧共用**）+ ⭐ **接线状态两级如实标注**（场景级 `wiring` live/pending 且 pending 必附原因；字段级 `fieldWiring` 区分 `live` 与 `record_only`，`groupContent` 属后者）+ ⭐⭐ **明写「微信订阅消息文案由微信公众平台侧定义」**（本页文案服务人工发群与台账，改它不会改变用户收到的订阅消息 —— 同 M3-10「给了输入框却没接上线」）+ **变量白名单**（`{{bad}}`→`10001`；只有**双**花括号算占位符，单花括号 `{3}` 不误伤自然文本）+ **只读字段拒绝而非静默忽略**（`forbidNonWhitelisted`）+ **「未传」≠「传 null」**（判据 `!== undefined`，见《缺陷与陷阱》#46）+ ⭐ **真消费点 = 退款结果通知**（`refund.service.ts` 两个执行口在**事务外**调 `MessageService.notify()` —— 事务里发通知而事务回滚就是「用户收到退款通知但退款未发生」；`notify()` 不抛异常）+ **未启用 = 不投递且不留日志**（`ab_message` 语义是「发过什么」）+ 落点登记（管理侧 `/admin/system/templates`；投递侧由 M3-12 实装原空模块 `MessageService`，删除 `wechat-template.service.ts` / `templates/index.ts` 两个零引用死占位）+ 错误码 **零新增**（闸门/变量/只读字段/空请求 → `10001`，目标不存在 → `10004`）；§八 映射表 P36 转「**已实装**」并补载体 `ab_message_template`；e2e `§24` 新增 **47 条断言**；⑭ **M3-13 财务端点（P34 · D33–D35 · 零 DDL · 零新增错误码）**：§6.5 补 M3-13 实现口径表 —— ⭐⭐ **D33 不自己算一套口径**（收入/成本/履约/毛利/逐日趋势**全部取 `StatsService.dashboard()`**，与 D47 看板**同一个函数**；e2e 用「五项与 D47 逐项相等」钉死，谁把它改回自己 `SUM(...)` 立刻红）+ ⭐ **逐日分项之和 === 区间总额**（同一份数据的两种切法）+ ⭐ **`range` 复用 `STATS_RANGES`**（不另立「日/周/月」；非法值 `10001` 不静默回落）+ ⭐ **`date` 是区间终点锚点而非自由起止**（期末对账要看已过完的那天；该入参同时给 D47–D50）+ ⭐ **时点量 vs 区间量分离**（余额/冻结/待入账佣金不随 `range` 变化，带 `asOf` —— 时点量被读成「本期新增负债」最误导人）+ `payable.generated` 按「**是否有有效行**」判定（实收 0 的日子也会出单）+ 四态 `payableStatus` 是给人看的+ 已退金额用 **SQL 子查询**（`ab_refund` 无 `meal_date`；且 SQLite 绑定变量上限 999，拼大 `IN` 列表会本地绿、换驱动炸）+ ⭐⭐ **D34 行内等级/费率是结算快照**（e2e 用「**同一个团长**三条佣金分别显示见习/正式/首席」证明它不可能是当前值）+ D34 扩展入参 `status`/`type`/`keyword` 与 `byLevel[]` 拆分 + ⭐⭐ **D35 = M4 `commission-settle.task` 的同一执行口**（不另写第二套入账逻辑）+ ⭐⭐ **一期 `pending` 常态为 0 并如实下发 `note`**（佣金在取餐确认时即时入账，「点了按钮 0 条」必须说清不是故障）+ ⭐ **D35 刻意不做补计佣**（`ab_order` 没有下单时刻的团长等级快照 → 只能拿当前等级算，晋级后会多算；结构性缺口，非实现 bug）+ ⭐⭐ **补账只改账、不改事实**（只加 `total_commission`，**不动** `total_orders`/`last_order_at`，否则污染 C2 晋级审计）+ **整批单事务 + 逐行 `affected` 判归属**（并发不重复加钱）+ 无归属进 `skippedReasons`（不猜不静默丢）+ 入账段**唯一**（`accrueForOrders` 与 `settlePending` 共用 `creditCommissions`，流水文案取**行快照**）+ D35 入参**不收金额**（否则就是往团长余额加钱的后门）+ 权限两级（类级含 `operator`、D35 收窄到 `admin/finance`；**不含 `viewer`**，与 D47–D50 刻意含 viewer 正好相反）+ 删除零引用死占位 `finance.controller.ts`；§八 映射表 P34 更新；e2e `§25` 新增 **33 条断言**；⑮ **M3-14 余额账户管理与调整（P34 · D38–D39 · M35-04 · 零 DDL）**：§6.5 补 D38/D39 实现口径表 + ⭐⭐ **负债合计复用 D33 的同一函数**（`FinanceService.loadLiability()`；两页各算一套 `SUM(ab_balance)` 漂移**不报任何错**，e2e 用「D38 `liability` ≡ D33 `liability`」写前写后各钉一次） + ⭐ **负债是时点量**（`pageSize` / `accountType` / `keyword` 都不改变它，`total` 才是筛选命中数） + D39 **四动作**（充值 / 扣减 / 冻结 / **解冻** —— 规范原只写三动作，「不能解冻的冻结是死钱」） + ⭐⭐ **冻结 / 解冻不动 `total_in` / `total_out`**（钱没进出平台，只是从「可用」挪到「冻结」，与 L12 提现「申请阶段不计入累计支出」同口径） + ⭐⭐ **余额不得为负**（扣减 / 冻结越界 → `40002`「钱不够花」；解冻越界 → **新码 `40015`**「冻结账对不上」，**两码刻意分开** —— 合流一个码，运维就分不清该让人充钱还是该查数据） + ⭐ **幂等键必填**（调账无业务单号，重复提交就是重复加钱：缺键 `10001` / 命中 `10006` + 首次结果） + **乐观锁** `WHERE id=? AND version=?`（并发调账不丢更新） + ⭐ **只有「充值」能自动建户**（其余动作无账户时明确报错，**不是**先建 0 余额账户再报余额不足 —— 否则库里凭空多一行「余额 0」账户，D38 账户数与 D33 `accountCount` 悄悄错开） + ⭐ **权限常量单一真相**（`BALANCE_ADJUST_ROLES` 同时驱动 `@Roles()` 与出参 `actions.canAdjust`，结构上消除「按钮亮着点了 `10003`」；项目既有写法多为两处硬编码 + 注释对齐，本批改为常量） + ⭐ **新枚举值 `ab_balance_log.type='adjust'`**（与原五值分开避免污染佣金汇总；已回写 §九扩展登记，并同步补 `BALANCE_LOG_TYPE_LABEL`，否则用户在自己的余额明细里看到裸英文） + 未知 `action` **fail-closed**（否则静默走完 switch 会写出「余额没变却多一条流水」的脏数据 —— 余额看着对、只有账本对不上） + D38 **无账户空视图**（`hasAccount=false` 含最近流水：搜不到人 → 不敢充值，而 D39 恰恰支持首充建户） + 筛选走 **SQL 子查询**（避开 SQLite 绑定变量上限 999）+ 手机号一律脱敏 + 余额降序 + ⚠️ 顺手修掉**前端菜单缺口**（`ADMIN_NAV` 财务域原只挂 `/finance/overview` 一个入口，其余 5 个子页服务端早已授权却点不到，运营只能手输 URL）；§八 映射表 P34 更新；e2e `§26` 新增 **34 条断言**；⑯ **M3-15 对账 D43 + 发票 D44（P34 · 模块 M35-06/07 · 零 DDL · 零新增错误码）**：① ⭐⭐ **一期不许假装已与微信对平** —— 无商户号 + 无 API 证书即**拿不到微信账单**，出参强制带 `channel.source='local_only'` + `billAvailable=false` + note 明写「**不等于已与微信侧对平**」；若实现成「内部两表比对通过 → `balanced:true`」，运营会以为微信侧也平了，而真正危险的差异（微信收了钱、系统不知道）将**永远不可见**；② ⭐⭐ `date` 锚 = **支付日**（`anchor='paidAt'` + `anchorLabel='支付日'`）—— **财务域唯一一个 `date` 不指出餐日的端点**（微信账单按支付日切日），拿它对 D33/D34/D36 的出餐日数字必然对不上；③ ⭐ 页面主体是**差异清单**而非流水（当天进出账去 D33/D40 看），五类差异 `order_paid_no_log` / `log_success_no_order` / `amount_mismatch` / `duplicate_transaction` / `no_transaction_id`，**每类配套 `nextAction`**（「对账不平」四个字无法执行）；④ ⭐ **三角恒等式** `diffFen === orderFen − logFen`（正常为 0），退款按 `refunded_at` 单列、`netFen = orderFen − refundFen`；⑤ ⭐⭐ `balanced` **双条件**（金额相等 **且** 无结构差异）—— 重复/缺交易号可能不影响合计金额，**只比金额会报「已平」**，而凭证重复正是重复入账的前兆；⑥ ⭐ 差异检测**三个方向**：当日订单 → 「订单说付了、账上没有」（含流水停在 `pending`）；当日订单的**全部**流水（**不限日期**）→ 金额不一致（回调丢失时流水 `paid_at` 为空，**按日期切就把它切没了**）；当日成功流水 → 「钱收了但订单没标」+ 重复交易号；⑦ ⭐ **刻意不提供「一键平账」**（对账的作用是暴露差异，不是把差异抹掉）；⑧ ⭐⭐ D44 **零 DDL · 派生视图** —— 不建 `ab_invoice`（事实已在 `ab_supplier_share`：`invoice_no` + `paid_at` + `payee_id`），建表立刻产生**第二份真相**；⑨ ⭐⭐ D44 粒度 = **供应商 × 月份** —— 按单条应付行平铺会看到「同一发票号重复 30 次」，**完全看不出**「这家这个月只开了一半」，三态中 **`partial` 是本页存在的理由**；⑩ ⭐ D44 月份锚 = **应付单生成月**（`share_date`，权责发生制台账，跨月付款仍归原月），复用 `monthRangeOf()`；⑪ ⭐⭐ D44 开票分母**只含已付款行**（未付款就要票供应商不会给），未付款额单列 `unpaidAmountFen` —— 否则刚出单的日子会满屏「未开票」，把真正的欠票淹没；⑫ ⭐ D44 两个**可执行的下一步**：`titleMissing`（去 D28 补开票抬头，没有抬头票开不出来）· `overdue` + `overdueDays`（已付超 30 天无票 = **税前扣除凭证缺失**的税务风险）；⑬ ⭐ 纠错冲销行（`reversal`）**不进发票分母**，只累加 `reversalFen` 提示需**另行换票**；⑭ ⭐ D44 分月**必须在服务端内存**完成（`strftime`/`DATE_FORMAT` 是**驱动相关**语法，用了就破坏「四驱动零改动切换」，本地全绿、换驱动才炸）；⑮ D44 `status` 是**派生值**（库里只有 pending/success/failed/reversed）→ 必须**先聚合再筛**，非法枚举 `10001`（**不静默回落成「全部」**）；⑯ 两接口均为**纯读 GET** → 不额外收窄权限，类级 `FINANCE_VIEW_ROLES`（含 `operator`）即可，`/finance/invoices` 同时进 `ADMIN_MENU_KEYS` + finance 角色菜单 + `ADMIN_NAV`（授权了就必须有入口）；⑰ ⚠️ 顺手删掉**死占位** `reconciliation.service.ts`（原 `export {}` 骨架），「对账服务写哪」由此只有一个答案；e2e `§27` 新增 **34 条断言**；⑰ **M4-0 契约级修正（2026-09-16 · 自营口径前置 · 零新表 / 零停止使用以外的新码）**：① **场所归位** —— `ab_distribution_center.supplier_id`（原 NOT NULL）改为**可空历史字段**（列保留 · 新逻辑不读不写 · 前端传即 `10001`）；对外文案「集散中心」统一改称**「加工场所」**（实体名 `ab_distribution_center` 不变）；② **供应商类型停用** —— `ab_supplier.type`（`dish`/`distribute`/`both`）同模式转为历史字段，D23 列表**不再下发 `typeOptions`**、`?type=` 筛选**不再受理**（传了即 `10001`），D24 请求体去 `type`；③ ⭐ **D27 `PUT /admin/suppliers/{id}/type` 整条路由删除**（打旧路径 → `10004`；改走 D25 编辑亦不再收 `type` → `10001`），错误码 `50008` `SUPPLIER_TYPE_CONFLICT` 的**三处闸门全部拆除**、号位**保留但不再使用**；④ ⚠️ **第 4 处真风险（本轮盘出 · 非计划内）** —— S3 `GET /supplier/packing-tasks` 的可见性判据「本主体名下有启用中集散中心」在 `supplier_id` 停用后**整体失效**，且其语义本就把**他方到货明细**开给供应商（违反 I1「不泄露他方经营数据」）；只换判据治不了「不该看」，故 S3 **整条路由迁运营后台 `GET /admin/packing-tasks`（P39「加工场所打包」）**，供应商端路由**删除**（→ `10004`）；⑤ e2e `§18`/`§20` 同步改写（D23 详情 7 块→6 块 · D27 `50008`→`10004` · D30/D31 挂载冲突 `50008`→`10001` · S3 段全量改打 admin 端点）；⑱ **M4-3 队列消费者 + 订阅消息投递点（4.9 / 4.10 · 零 DDL · 零新增错误码）**：① ⭐⭐ **外部支付通道调用移出 DB 事务**（本批头号改造）—— `RefundService` 原在**事务内**先调微信退款、失败即抛 `40010` 整笔回滚；看似避免「有退款单没退款」，实则留下**更严重且不可自愈**的反面：**微信退款成功后事务若失败，钱已出去而系统里没有退款单**（账实不符且**无任何机制能发现**）→ 改为「**事务 A**（纯 DB：冲销 + 退款单 `refunding` + 订单 `refunded`）先提交 → **事务外**调通道 → 成功收口 / 失败**入队退避重试**」，`refundNo` 作微信幂等键（`out_refund_no`）**重试不重复出款**；对外语义收窄为「**已受理，通道那段待重试**」（订单仍 `refunded`、账务**不回滚**）；② ⭐ 三消费者实装（`order-paid` / `refund-apply` / `settle-orders`，**薄适配层**）+ **§6.9 `GET /admin/queue`**（如实报告 `driver`/`durable`，memory 驱动 → `durable=false`，**不做静默降级**；`failed` = **重试耗尽进死信**）；③ ⭐⭐ `settle-orders` 载荷由**整批一条**改为**按团长逐条**（订阅消息**必须能寻址到收件人**，聚合载荷没有收件人 → 「通知」实际没发生却**看起来成功**）；④ ⭐ 新增两个真实投递点 `leader_apply` / `commission_settled`（均在**事务外**、`notify()` 不抛异常）；⑤ ⭐ 场景 **5 → 6 行** + 每场景新增 `requestSubscribe`（**机器可读布尔**，不得从句中文反推）+ 出参 `subscribeTemplateId`；⑥ ⭐ 新增 **U18 `GET /me/subscribe/templates`**（四条件过滤 + 下发「空列表通常是正常的 / 一次性授权 43101」口径）；⚠️ 原型 **U15 `POST /me/subscribe` 一期未实装**（明确留名）；⑦ ⭐ `wiring=live`（有投递点）与 `enabled=1`（配置就绪）**是两件事**，一期 3 个 live 场景全部 `enabled=0`；⑧ ⚠️ 修正 `refund_result` 落地页（原 `pages/order/detail` → `pages/order-detail/order-detail`，**微信不校验 `page`、服务端不解析小程序路由 → 四处都不报错**），并加 **`NOTIFY_PAGES` ⊆ `pages.json`** 机械对账；⑨ ⚠️ 修掉 `FinanceModule` 漏注册 `OperationLog`（**`@Global()` 不二次导出 import 进来的 provider** → 启动即崩，而 `tsc`/`eslint`/`build` **都查不出 DI 错误**）；⑲ **M4-1 日切链路 / M4-2 结算链路（补记 —— 正文已在 §6.8 与 M4-2 实现口径，此前本行漏登记）**：① **M4-1**：`TASK_SCHEDULES` 8 任务声明表（cron + `dateKind`）为调度口径**唯一真相**（任务体**不写日期计算**，杜绝「同刻不同日」）；`meal-publish` / `cutoff` / `delivery-generate` 三任务实装 + **手动补跑接口** `GET /admin/schedule` · `POST /admin/schedule/{task}/run`（与跑批**共用同一执行口**、**刻意不加锁**、锁**不是保险丝**）+ ⏱ **时钟注入闸 `ABOX_SHIFT_TO_HOUR`**（平移北京小时、日历日不变，解开「下单窗口」对全量套件的锁）；⭐ 顺带修掉 `ab_meal_assignment.sold_count` **假累加**（备料量恒为 0 且不报错 → 改为**截单定格** + `freezeProducePlan()` 覆盖刷新）；② **M4-2**：⭐ **佣金两段式**（T 日 14:00 计佣写 `pending`、T+1 02:00 入账写 `settled` + 进余额；`creditCommissions` 是**唯一**把钱写进余额的地方）；⭐ **退款冲销拆两条路径**（`pending` 只作废原行 / `settled` 才写负行 + 扣余额 —— 旧实现会在 `pending` 窗口**扣一笔从未入账的钱**且余额允许为负 → 静默形成假欠款）；⭐ 同批修掉 `monthOrdersOf` **双计**（退款单被 `WHERE` 排除后又被 `CASE` 加回 → 可凭退款刷 C2 晋级）与 `reconciliation` 的 `dateKind` `today → yesterday`（04:00 对「今日」只核 4 小时切片 → 每天都漏核一段）；⭐ **激活**一条从未运行过的守卫（`pending` 之前恒为 0 → `collectQuitBlockers` 的「有未结算佣金不得停职」是死代码）；③ 两批均**零 DDL · 零新增错误码**，e2e 新增 **§28（30 条）/ §29（10 条不变量）**，`§28` 三条「未实装」断言翻转为 **8/8**；⑳ **M4-4 提现审批（D45 列表 · D46 批准 / D46a 驳回 / D46b 到账回执 / D46c 打款失败 · P34 · 模块 M35-08 · 零 DDL）**：① ⭐⭐ **这一页不是报表，是「钱出不去」的解法** —— L12（提现申请）从 M2 起就实装（申请瞬间 `balance −X / frozen +X`），而此前后台**没有任何端点能把这张单往前推**：① 团长的钱被**永久锁死**（`frozen` 只增不减）；② `collectQuitBlockers` 以 `pending`/`approved`/`paying` 判「有未完成的提现」→ 提过一次现后 C3 退出团长**再也不可能成功**，而错误文案还写着「等待提现到账」；③ `ab_team_leader.withdrawn_amount` 永远是种子值（无写点）；② ⭐⭐ **三路解冻共用一个 `releaseFrozen()`**（驳回 / 到账 / 失败），差别只在 `direction`：`'in'`（驳回/失败）= 把钱挪回可用（`balance +X / frozen −X`，**`total_in`/`total_out` 都不动** —— 钱没进出平台，同 D39 冻结/解冻口径）；`'out'`（到账）= 钱正式出平台（`frozen −X / total_out +X`，可用余额不变）—— **三路各写一份的后果不是重复代码，而是其中一路漏掉某个字段**（如「到账忘了减 frozen」→ 该用户冻结额永久虚高，而同一天其余提现看起来都正常）；③ ⭐⭐ **`total_out` 按「申请金额」而非「实付」累加**（申请时已扣走 X，到账只是把这笔被冻结的钱正式记为支出）：按实付记会让 `total_in − total_out` 与 `balance + frozen` 之间**永久**留下一个等于代扣税额的缺口，账面像「平台多留了钱」，而那笔税是平台**代扣代缴给税务**的、不是平台留存 —— e2e 用「到账前后 `(total_in − total_out)` 的差值 === 申请金额」钉死；④ ⭐⭐ **到账不写 `ab_balance_log`**（该表语义是「**可用余额**的每一次变化」，到账时可用余额**不变**，钱在申请时就已扣走；`frozen`/`total_out` 的变化**从来**不由流水解释 —— D39 的 `freeze` 行即先例），e2e 把「到账后流水条数不变」写成断言（让「为什么没有」成为**声明**）；⑤ ⭐⭐ **解冻前 fail-closed `40015`**（`frozen < 申请额`，**不复用 `40002`**）：前者是「**冻结账对不上**」的账实不符信号（有人绕过冻结口径）要查数据，后者是「钱不够花」；硬扣会让 `frozen` 变负并在**下一个用户**那里表现为「冻结额凭空多了」；⑥ ⭐ **状态机守卫 `40017`**（**不复用 `40013`** —— 形态相同但**排查入口不同**：退款单去 D40 看、提现单去 D45 看），四动作两两之间都可能被误操作且每次后果都是**再动一次钱**，故一律回「当前状态「已到账」不支持批准」这种能直接照着排查的话（`data.allowed` 回带允许集合）；**未知单号 `40016`** 与 `10004` 分开（后者含「在库但无权限」）；⑦ ⭐ **到账登记的自洽校验**：`申请额 − 代扣 = 实付`，两栏都传却不自洽 → `10001`（不允许两处各记一套 —— 那必然产生「账上代扣 50、实付另算」的双真相）；两栏都不传 → 视为无代扣但出参标 `taxSource='assumed_zero'`（**让「系统替你假设了 0」看得见**，否则「实付 = 申请额」看起来像一个已核实的结论）；⑧ ⭐ **`payoutBatchNo` = 审批日批次** `PB{yyyyMMdd}`（**刻意不含随机位**）：单号要「一单一号」（唯一）、批次号要「**同日同批**」（聚合，一期人工通道下运营每天集中汇总成一份清单提交平台、回执也整批回来）；需要一天内分批时由操作者显式覆盖，**不自造「当日第 N 批」计数器**（跨请求读-改-写并发会撞号，而批次号**不是**资金主键）；⑨ ⭐ **汇总两类量刻意分开**：在途量（`pending*`/`approved*`/`paying*`/`frozenByWithdrawFen`）取**全量、不随筛选变化**（「平台此刻因提现占用了用户多少钱」不该因搜了个姓名就变小）并带 `asOf`，⭐ `frozenByWithdrawFen` == 三状态金额之和、可与 `ab_balance.frozen` 的**增量**互相验算（后者还含 D39 手工冻结）；历史量（`paid*`/`released*`）取**同一过滤条件的全量**（不受分页影响）；⑩ ⭐⭐ **财务域角色白名单收敛为单一真相** `finance.constants.ts` 的 `FINANCE_READ_ROLES`（类级含 `operator`）/ `FUND_ACTION_ROLES`（方法级资金动作，不含 `operator`），由 **D35 / D39 / D41 / D42 / D46 系列共用一份** —— 此前五处各写字面量，漂移**不报错**；出参 `actions.canAudit` 与 `@Roles(...)` 共用同一常量；⑪ ⭐⭐⭐ **顺手修掉一条用户直接看得见的错（真缺陷 #69）**：`ab_team_leader.balance` / `withdrawn_amount` / `pending_amount` 三列**只在种子里被赋过值、全仓没有任何写点**，却被登录（A1）、团长资料（L14）、退出团长（L20）三处出参当作「可用余额 / 累计已提现 / 待入账佣金」下发 → 团长「我的」页显示的是**种子里写死的数字**（示例数据 ¥575.86），而「余额明细」页（L11 走 `ab_balance`）显示真值 —— **同一个人在同一时刻看到两个不同的余额，两边都不报错**；他去提现被 `50004 可提现余额不足` 挡下，而页面上明明写着有几百块（**必然产生的客服工单**）；修法**不是把三列写起来**（那就是第二份真相，漏掉任一写点就会悄悄分叉）而是**不再读**：新增 `LeaderMoneyService`（`common/services/`，四值全部**派生** —— 余额/冻结 ← `ab_balance`，待入账 ← `ab_commission(status='pending' ∧ type='normal')`（⭐ 必须排除 `reversal` 负行），累计已提现 ← `ab_withdraw(status='success').actual_amount`（**到账口径**，代扣的个税没到团长手里）），登录/资料/退出/后台团长列表与详情五处**共用同一份口径**，三列转**历史字段**（列保留 · 不再读写 · 与 M4-0 的 `ab_distribution_center.supplier_id` / `ab_supplier.type` 同一处理）；⭐ 同批修掉 `getBalance()` 的两处静默错算：`pendingCommissionFen` **漏排 `type='reversal'`**（负额冲销行会把「待入账」算小甚至算成负数）、`inFlightCount` **只数 `pending` 而注释写着「待审批 / 已批准 / 打款中」**（文案承诺三个状态、代码只数一个 → 运营一批准该数字立刻掉到 0，团长以为「没有处理中的提现」而那笔钱仍在冻结中）—— 改用 `WITHDRAW_FROZEN_STATUS`（shared-types 单一真相）；⑫ ⚠️ **`PayoutChannel` 枚举值大小写漂移（真缺陷 #70）**：枚举原写小写 `'flex_manual'`，而实际链路上**全是大写**（列默认值 / `BizConfigService.payoutChannel()` 缺省值 / e2e-m2 断言全是 `'FLEX_MANUAL'`）—— 此前因该枚举**全仓零消费点**才没炸；一旦有人照它写 `row.payoutChannel === PayoutChannel.FLEX_MANUAL`，比较会**恒为 false 且不报错**，故改为与落库值逐字一致；⑬ **零 DDL**（`ab_withdraw.payout_batch_no` 列早已存在）· **表数仍 27** · 新增错误码 `40016` / `40017`（已回写本文件 §九 + 扩展码登记）；⑭ **菜单与白名单同源**：`/finance/withdrawal` 进 `ADMIN_MENU_KEYS` + finance 角色菜单 + `ADMIN_NAV`；⑮ 前端 `withdrawal.vue`（四 Tab + 在途/本筛选两组汇总 + 权限提示 + 四弹窗；到账弹窗的「代扣/实付」用 `number | null | undefined` 三态 —— `el-input-number` 清空 emit `undefined`，只判 `=== null` 会漏；`paidHint` 与后端**同一套推导规则**）；⑯ e2e **§31 · 49 条断言**（**不依赖下单窗口**：专用团长夹具（**不借既有团长**，避免别人的钱造成假绿）+ D39 充值建户 + 四笔申请走 `success`/`rejected`/`failed`/`success`，覆盖状态机 fail-closed、驳回/失败**精确复原**、到账按申请额计支出、到账不写流水、代扣/实付自洽、**会计恒等式 `total_in − total_out === balance + frozen`**、两级白名单、**在途提现挡住退出团长**（`20008` + `WITHDRAW_IN_FLIGHT`）与「全部到终态后该腿闭合」；节末全量还原）；⑰ `SCAFFOLD_KEY` 增 **4 项** M4-4 契约载体；⑱ `gate.mjs all verify` **15/15 全绿**（m1 38 · m2 126 · **m3 876 → 925**，较上批 +49）。 |
| 最近修订（M5-0） | 2026-09-17 · ㉑ **M5-0 部署运维基座（M5 前置子批次 · 零 DDL · 零新增错误码）**：① ⭐⭐ **§七 探针拆分并纠偏（真缺陷 #75）** —— 原 W4 `/health` 描述为「健康检查（DB / Redis / 微信连通性）」，而**实现从不检任何依赖**（「文档说检、代码不检」正是该缺陷的成因），且微信侧无商户号与证书、一期也无法检通；现 §七 拆为 **W4 `/health`（存活 · 刻意不检依赖 · 出参契约不可改）** + **W5 `/health/ready`（就绪 · 检 DB `SELECT 1` + 3 个队列消费者齐备 · 未就绪 → HTTP 503 + `code 90002`）**，并写明「两条探针必须分开」的理由（混用 → 重启风暴 或 摘不掉流量）与「readiness 为何检消费者而不检 Redis 连通性」（连通性启动期已 fail-closed 验过；消费者未注册是**启动期验不到、失败后完全静默**的一类故障）；② ⭐ **§1.1 访问控制表**把「回调」与「探针」拆成两行 —— 探针**免 JWT**（`@Public()`）且**公网可达**，故出参按「会被人看见」设计、失败原因只进服务端日志；原文把 `/health` 与 `/api/v1/pay` 并列并声称「走 `wx-signature.guard`」与实现不符，已纠正；③ ⚠️ **本批无新增端点以外无契约变更** —— `90002 SERVICE_UNAVAILABLE` **早已存在**（无需新增错误码），本批只是把它**显式接到 HTTP 503**（该码不在 `HTTP_STATUS_OVERRIDE` 表里，不显式传就退化成 200，**编排器只看状态码 → 「不可用」会被判成健康**）；④ 同批修真缺陷 **#71**（`enableShutdownHooks` 缺失 → 两处 `onModuleDestroy` 从未执行）· **#72**（迁移 glob 只匹配 `*.ts` → 生产 `dist/*.js` 零命中且 TypeORM **不报错、退出码 0**）· **#73**（`deploy.sh` 空壳）· **#74**（骨架 Dockerfile 五处生产硬伤）—— 详见《缺陷与陷阱》；⑤ `gate.mjs all verify` **15/15 全绿** · e2e **m1 38 → 45**（探针契约 7 条并入）/ m2 126 / m3 925。 |
| 最近修订（M5-1） | 2026-09-17 · ㉒ **M5-1 配送单人工修正（M5 前置子批次 · 收口挂账 #61 · 零 DDL）**：① ⭐⭐ **§6.5 补 D61/D62 实现口径（16 项）** —— 收口挂账 **#61**：跑批对已存在的配送单**跳过不覆盖**（保护人工录入的司机 / 车牌），代价是份数**被一起冻住**、**没有任何页面能改**（`DeliveryController` 此前是空壳，口子只在 DBA 手里）；现补 D61 `GET /admin/deliveries`（按出餐日列表 + **份数差异标记**）与 D62 `PUT /admin/deliveries/{id}`（修正份数 / 司机 / 电话 / 车牌 / 备注）；② ⭐⭐ **`version` 乐观锁**（`ab_delivery_record.version` 列早已存在、此前**零使用**）—— 两个运营先后改同一张单，后写者用旧快照会**静默覆盖**前者的修改且双方都不报错，直到装错货；冲突 → **新码 `30016`** + `data.current`（当前值与版本，端上刷新后重提）；目标 id 非法 → **新码 `30017`**；③ ⭐⭐ **份数不符 ≠ 被人改过** —— `quantityMismatch` 的成因有两种（有人修正过 / **截单后订单侧退款取消**，而配送单份数在截单时已定格、不跟着降），系统**无法从数字本身区分**，故只如实标差异 + 给排查入口（`ab_operation_log` 按 `module='delivery'` 查）、**不假装知道**（同 #55）；另设一个**可靠**标记 `hasManualInput`（司机 / 电话 / 车牌 / 备注四列**跑批从不写**，有值 ⇔ 有人手工填过）；④ ⭐⭐ **审计 diff 不需要新表** —— D62 出参带 `{before, after, changed}`，随响应体被 `OperationLogInterceptor` **整体落库**（该拦截器的 `snapshot` 列只写 `{operator, role, at}`、**不含 diff**，真正的 diff 载体是 `response_data`）；`reason` **必填且不写进 `remark`**（后者是给配送员看的，混入审计原因会污染）；⑤ ⭐ **只改五项 · 不动 `status`**（状态是履约流转，有它自己的时点与责任，混进来审计分不清）+ **无 `POST` / 无 `DELETE`**（不手工建单以免绕过截单定格的份数口径；不删单以免当日配送链缺一个楼群且无痕迹 —— 份数改 `0` 才是「今天不送」）；⑥ ⭐ **份数聚合单一口径** —— 跑批生成（4.3）与 D61 对比**共用** `aggregateOrderQuantity()`（两处各写一遍 SQL，改口径只改一处就会出现「生成的份数」与「页面显示的应送份数」不一致而**两边都不报错**），且对比一律取**全量**聚合（不受筛选影响）；⑦ ⭐ **状态枚举由服务端下发**（`statusText` + `statusOptions` 按**履约顺序**而非字典序），并**收敛**原先在两处逐字重复的 `DELIVERY_STATUS_TEXT`（`order/leader-order.service.ts` 与 `team-leader/workbench.service.ts`）到**新增契约载体** `packages/shared-types/src/enums/delivery-status.ts`（#67 家族「同一枚举多处字面量」；不收敛则本次新建的后台页就是**第三份**）；⑧ 两级白名单**含 `operator`**（配送是运营日常作业）、**不含 `viewer`**（含运力安排与司机电话，与 D47–D50 刻意含 viewer 正相反）与 `finance`；`@OperationLog` **写操作才记** + **失败的请求也记**；`/order/delivery` 同时进 `ADMIN_MENU_KEYS` + `ADMIN_NAV` + `routes.ts`（授权了就必须有入口）；⑨ ⚠️ **顺手修掉 #49 的过时解释** —— 5 项 `wiring='unwired'` 的原因原写「硬编码在 `@Cron(...)`」，在 M4-1 建立 `TASK_SCHEDULES` 声明表之后**已不准确**，改为如实指向声明表，并写明「本键 / 声明表 / 下单窗口**三者无机械对账**」这一仍存在的缺口（#49 的**接线部分维持独立验收项** —— 会动用户可下单窗口，e2e 全量依赖 14:00–23:00）；⑩ e2e **§32 · 25 条断言**（**不依赖下单窗口**：隔离日 −216 / −217；`§28` 的「人工录入」同步从**直写库**改为**走 D62 接口** —— 直写只能验证「跑批不覆盖」，走接口才能同时验证「修正真的落到了库里」）；⑪ **零 DDL** · **表数仍 27** · 新增错误码 `30016` / `30017`（已回写 §九 + 扩展码登记）；`SCAFFOLD_KEY` 增 **4 项**；`gate.mjs all verify` **15/15 全绿**（m1 45 · m2 126 · **m3 925 → 951**，较上批 +26）。 |
| 最近修订（M5-3） | 2026-09-17 · ㉓ **M5-3 试运营交付 + 安全自检 + #49 时间类配置接调度（零 DDL · 零新增错误码 · 表数仍 27）**：① ⭐⭐ **§6.7 的「接线状态」翻转 —— 5 项时间类配置由 `unwired` 升为 `live`**（`set_meal.publish_time` / `cutoff_time` / `delivery_arrival_time`、`commission.auto_confirm_time` / `settle_hour`）：时刻的唯一真相收敛到新增 `common/utils/order-timeline.ts` 的 `DEFAULT_TIMELINE`，而「跑批 cron」与「下单窗口锚点」都是它的**派生值** —— 于是改配置 = **下单窗口与触发时刻一起改**，不再是「写了不生效」；余下 **4 项仍为 `unwired`**（`supplier.settle_cycle` / `distribution_center.*` 3 项），另 2 项为策略标识；② ⭐⭐ **D57 出参新增分组与两列**：分组 **6 → 7**（新增「业务时刻」组），每行新增 `effectiveAt`（生效时刻）与更精确的 `consumedBy`（指向 `currentTimeline()`）；③ ⭐⭐ **D58 的 `time` 类型接受 `24:00`**（= 次日 0 点，**截单口径的原生表达**）—— 旧正则只收 `00:00`–`23:59`，数据模型**根本表达不出 24:00**，于是种子只能写 `23:59` 近似值，与实际按 `00:00` 跑的 cron **差 1 分钟**且不会有任何一处报错（**这不是笔误，是模型缺一个值**）；校验改为复用 `parseTimeOfDay`，**判据与消费方同源**，并归一为 `HH:mm`（`9:00` → `09:00`）；④ ⭐⭐ **§6.8 S1 出参扩充**：`summary` 增 `registered`，每行增 **`registeredCron`（实际注册进调度器的 cron）** 与 `effectiveAt` —— 前者是「任务真的会被触发吗」的**唯一外部可观测证据**（`cron` 是出厂口径、两者不同即说明配置覆写了时刻）；⑤ ⭐⭐ **§6.8 补一节「跑批时刻由运行时注册器决定」**：`@Cron()` 是装饰器参数、模块加载即静态元数据 → 后台改配置**永远影响不到它**（「配了不生效」的机制性根因）；8 个任务类**已移除 `@Cron`**，改由 `ScheduleRegistrar` 按**生效时间轴**生成 cron 并 `SchedulerRegistry.addCronJob()`，且**订阅时间轴变更做热重载**（避免「用户已不能下单、截单跑批仍按旧时刻跑」的半生效状态）；⚠️ 该机制最危险的失败形态是**任务静默不跑**（e2e 全走补跑接口，发现不了）→ 三道防线：逐名 `doesExist` 核对（缺则**拒绝启动**）· 启动横幅 · S1 下发 `registeredCron`；⑥ ⭐ **安全自检两支并入门禁**（`route:audit` 越权全量机械对账 + `security:scan` 密钥/日志扫描），`gate.mjs` **16 → 18 道**；⚠️ 两者**均在「请求形状/自身逻辑」层面**，**不覆盖**「服务层数据收窄」（如按 `supplier_id` 过滤做到没有）与 `npm audit`，边界已如实登记（《安全自检报告 v1.0》）；⑦ ⭐ **`POST /pay/mock/paid` 加固为显式 fail-closed**（`!isMock` 即 `10004`，不暴露端点存在）—— 原仅靠「real provider 未实现该方法」隐式兜底，属**偶然成立**而非契约；⑧ **零新增错误码**（`10001` / `10004` 足够）· **零 DDL** · `SCAFFOLD_KEY` 增 **5 项** M5-3 契约载体；`gate.mjs all verify` **18/18 全绿**。 |
| 最近修订（M5-8） | 2026-09-18 · **履约链 T7/T8/T9 补实现（收口缺陷 #79 · 零 DDL）**：① ⭐⭐ **新增 §6.5 D63 `PATCH /admin/deliveries/{id}/status`** —— `ab_order` 的 `cooked`/`delivering`/`delivered` 三态**全仓零写入点**（订单支付后永远停在 `cut_off`、团长「确认取餐」永远返回零值**且不报错**、**佣金永不产生**、自动确认跑批每天把全部订单报成「履约异常」），而当时 **19 道门禁 + 969 条 e2e 全绿**（夹具直接 `UPDATE ab_order SET status='delivered'` 造数据 → 测试永远从链路**中间**开始）；现补上 T7（`SupplierService.advanceOrdersToCooked`，出餐确认**同事务**联动）与 T8/T9（D63）；② ⭐⭐ **「改数字」（D62 `PUT`）与「推进履约」（D63 `PATCH :id/status`）刻意分成两个端点** —— 合成一个会让「份数 5→3 顺便把状态也推了」变成一条记录两件事，审计上分不清责任；③ ⭐ **订单联动是「尽力而为 + 如实报告」**：不做「订单必须都在 `cooked`」的前置校验（会把运营卡在门口、然后绕过系统打电话），能推的推、推不动的计入 `orderTransition.remaining` 并给可照着排查的 `note`；④ ⭐ **`called`（已叫车）不动订单**（货还在加工场所），出参 `orderTransition=null` 且 `note` 写明「这不是漏了联动」；⑤ ⭐ **D61 列表每行新增 `orderStatusBreakdown`**（该楼群当日订单状态分布，口径与 `orderQuantity` 同源）—— 让「有几单没跟上」从**一个看不见的洞**变成**列表里的一行**；⑥ ⭐ **T9 的取餐通知不装样子**：场景 `leader_delivery` 一期渠道就是**微信群**（`wiring='pending'`），往 `wechat_group` 调 `notify()` 会被判「无程序投递点」跳过 —— 加一个必然跳过的调用点只会让接线状态变成**假的 `live`**，故出参明确写「需运营人工发群」；⑦ **新增错误码 `30018` `DELIVERY_STATUS_ILLEGAL`**（带 `data.allowed` · **刻意不复用 30016** —— 排查入口不同）；⑧ ⭐⭐ **门禁 `state:audit` 收紧至豁免 0** 并新增**规则④「不可达态必须显式登记」**（`ORDER_RESERVED_STATUSES` 登记 `refunding`），同时**删掉那条躺了三个批次的不可达边** `refund_applying → refunding`（M4-3 起订单审批通过一步到 `refunded`，通道进度交 `ab_refund.status`）；⚠️ 该门禁经 **5/5 反证探针**打红过（删写入点 / 恢复旧边 / 取消保留态 / 塞孤儿态 / 把判定函数改恒空）；⑨ e2e **新增 §35 · 27 条断言 · 全链路**（U6 下单 → 支付 → 截单 → 配送单生成 → 出餐确认 T7 → 已叫车 → 配送中 T8 → 已送达 T9 → 自动确认 T11 → 佣金入账 4.5，**除一处夹具外订单每次状态变化都来自真实 HTTP**）；⑩ ⭐⭐ **闸门③ 由「只能向前」收紧为「一次只能一步」**（`allowed` 只含紧邻下一态）—— 跳级（`called → arrived`）会**跳过 T8**，而 T9 的条件更新是 `delivering → delivered`，订单还在 `cooked` ⇒ **一单不动且不报错**（正是 #79 的形状）；⚠️ 这是实现自查出的**第二处「两份表述」漂移**（注释/文档写「跳级一律拒」而 `slice(fromIdx+1)` 实际放行），已补 e2e 断言 `allowed === ["en_route"]`；⑪ ⭐ **后台入口补齐**（`admin-web` 配送页「推进到 X」按钮 + 确认弹窗 + 「订单进度」列）—— **只有接口没有入口 = 能力存在但无人能到达**（与 #79 同族）；**零 DDL** · 表数仍 **27**。 |


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
| 回调 | `/api/v1/pay` | 微信平台 | 微信签名校验 | **免 JWT**，走 `wx-signature.guard` |
| 探针 | `/api/v1/health`、`/api/v1/health/ready` | 编排器 / 监控 | **无鉴权** | `@Public()`，**公网可达** → 出参按「会被人看见」设计，失败原因只进服务端日志（§七） |

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
  → POST /auth/login { code, nickname?, avatarUrl?, inviteCode? }
  → 服务端 code2session → openid/unionid → 建/取 ab_user
  → 若带 inviteCode，绑定推荐团长（写 ab_user.team_leader_id / building_id + ab_leader_invite）
  → 签发 JWT（7 天）+ refreshToken（30 天）
```

> ⚠️ **路径与字段名校正（2026-09-18 · M5-11 · 缺陷 #92 收口）**：本节 v1.0 原写作
> `POST /auth/wx-login { code, leaderCode? }` —— **该路径与 `leaderCode` 字段名均不存在**，
> 实装只有 `POST /auth/login`（见 A1 行）。这正是「同一件事两份表述」的老毛病
> （同族 #67 / #79 / #84）：**文档里的那份从未被任何代码执行过，所以永远是对的**。
> 同一处遗留的第二个问题是 `inviteCode` 字段：它自 M2 起就写在这里、也一直存在于 DTO，
> 但**服务端从没读过它**（死字段）—— 见下方绑定语义表，本批才补上实现。

**登录时邀请码绑定语义（`POST /auth/login { inviteCode? }`）**

| 情形 | 行为 |
| --- | --- |
| 未带 `inviteCode` | 不绑定，正常登录 |
| 码无效 / 团长已停职 | **整趟登录失败** `30007`；端上捕获后**回落不带码的普通登录**（不把人锁在门外） |
| 用户当前**无归属** | 落 `ab_user.team_leader_id` + `building_id`（取该团长的楼栋） |
| 已有归属且**同一团长** | 幂等，不写库 |
| 已有归属，**换团长** | 只改 `team_leader_id`，**楼栋不动**（变更办公楼属 L15 后台审核事项） |
| 用户本人即该团长（自荐） | 同普通用户路径，不做特殊处理 |

> 邀请关系落 `ab_leader_invite`，由 `bindOnInvite` 负责：**幂等**（已有记录直接返回）、
> **不覆盖邀请人**（邀请人是既成历史，改写等于篡改前一个邀请人的晋级依据）、
> `channel='self'` 的自荐记录**不被覆盖**。
> ⚠️ **停职也报「邀请码无效」而非单独错误码**：对扫码的人而言「这个码不能用」是同一件事，
> 区分原因只会泄漏「某团长被停职了」。

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
| U12 | GET | `/me` | 用户信息（含所属团长、办公楼）· ⚠️ **由 A2 `GET /auth/me` 承担，不另设端点**（M5-10 裁定：同一份数据两个端点必然漂移；`buildingName`/`leaderName` 两个派生只读字段已在 A2 出参补齐） |
| U13 | GET | `/me/balance` | 可用余额（**单位分**）· M5-10 实装；出参含 `hasBalanceAccount`（与 A2 逐字一致）+ **服务端下发口径说明 `note`**：「余额来自订单退款与团长佣金入账（用户与团长共用同一账户），不支持充值；下单时可直接抵扣」—— ⚠️ 原型 P9 的「用户余额仅来自订单退款、团长佣金是独立账户」为**过时文案**（`ab_balance` 主键是 `user_id`，两身份共用同一账户） |
| U14 | GET | `/me/balance/logs?type=&page=` | 余额明细（M04-03）· M5-10 实装；与 L19 `GET /leader/balance-logs` **共用同一实现**（`LeaderMoneyService.logsOf`），`summary` 按全量统计不受分页影响；**不传 `type` 即返回全部流水**（不做「用户只看退款」的默认筛选，否则大卡总额与流水对不上） |
| U15 | POST | `/me/subscribe` | 上报订阅消息授权结果（模板 ID 列表）· ⚠️ **一期未实装**（见下方 M4-3 说明） |
| U16 | GET | `/me/agreements?type=user\|privacy` | 用户协议 / 隐私政策正文（M04-06） |
| U17 | GET | `/me/support` | 客服入口配置（**一期：客服微信号 + 服务时间**） |
| **U18** | GET | **`/me/subscribe/templates`** | **可授权的微信订阅模板清单**（M4-3 新增 · 端上据此决定调不调 `requestSubscribeMessage`） |

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


**U15 / U18 一期口径（M4-3 · 2026-09-17）**

| 项 | 口径 |
| --- | --- |
| ⚠️ **U15（上报授权结果）一期未实装** | 上报需要一张记录「谁授权了哪个模板」的表（**新增 DDL**），且**一期没有微信账号 → 没有模板 ID 可授权 → 无法验证**。故本批**只做读侧**，U15 在此**明确留名**（不静默略过、也不假装已实装） |
| ⭐ U18 是「**问端上该请求什么**」而非「记录端上请求了什么」 | 端上要调 `uni.requestSubscribeMessage` 必须先知道**模板 ID**。硬编码在端上等于**第二份真相**：运营在后台换了模板，端上还在请求旧 ID，**两边都不报错**。故由服务端下发 |
| ⭐⭐ **四条件过滤**（缺一即不进清单） | ① 场景属**用户端需求**（`audience` 含用户侧）；② `wiring === 'live'`（**有真实投递点** —— 否则就是「**索权不用**」，向用户要一个我们根本不会用的授权）；③ `enabled === 1`（**配置就绪**）；④ **已配 `wechatTemplateId`**（没有模板 ID 就没有可授权的对象，请求了也白请求）。一期三条全不满足 → **清单必然为空** |
| ⭐⭐ **`requestSubscribe` 是机器可读布尔，不得从 `audience` 中文反推** | D59 出参的 `audience` 是**给人看的文案**（如「用户端」）。若端上靠 `audience.includes('用户')` 判断要不要索权，那么**改一次文案就静默失效**（不报错、只是从此不索权）。故 `specs` 里独立声明 `requestSubscribe: boolean`，并由 **`subscribeTemplateOf()` 四条件**推导 `subscribeTemplateId` |
| ⭐ 结构性不变式 | `requestSubscribe === true` 的场景**必须** `wiring === 'live'`（e2e §30 直接断言）—— 防止「索权不用」这种微信平台明确反对的形态 |
| ⭐⭐ **口径必须下发（`note`），不能只写在文档里** | 端上看到一个**空清单**时的默认反应是「**接口坏了**」，正确反应是「**本来就还没到那一步**」。故出参带 `note` 明写：① 列表为空**通常是正常的**（一期无微信账号 → 无模板 ID）；② 微信订阅消息是**一次性授权**，用户没授权时服务端推不出去，微信会回 **`43101 用户拒绝接收`** —— **「必推项」指的是产品意图（原型：退款结果必推），不是「无需用户同意」** |
| 端上两段式（`use-subscribe-message`） | `onLoad` 预加载清单（失败**静默**，不打扰用户）+ **点击时同步调** `requestFor()`。⚠️ `requestSubscribeMessage` **只在用户手势的同步调用流里可用** → `requestFor()` 必须在**首个 `await` 之前**调用，否则微信直接拒绝（**空清单时什么都不做**，不拿假 ID 去请求） |

> 落地页**单一真相**：服务端下发的 `page` 全部取自 `message-template.specs.ts` 的 `NOTIFY_PAGES`，
> 并由 e2e §30 与 `apps/miniprogram/src/pages.json` 做**机械对账**（`NOTIFY_PAGES` ⊆ `pages.json`）。
> ⚠️ 这条对账防的是「**微信照收、服务端照发、用户点开落到空白页，四处都不报错**」—— 微信不校验 `page`，服务端也不解析小程序路由。

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

> ⭐ **L12 打开的资金链由后台 D45 / D46 系列收口（M4-4）**：申请瞬间 `balance −X` / `frozen +X`，
> 此后**唯一**能推进它的地方是 P34「提现审批」（**D46** 批准 → **D46b** 到账 / **D46a** 驳回 · **D46c** 打款失败 → **原路解冻**）。
> 本批次之前后台**没有任何端点能推进提现单** → 单子永远停在 `pending`，被冻结的钱既出不去也回不来，
> 且 C3 退团守卫会以「有未完成的提现」把团长**永久困住**（错误文案还写着「等待提现到账」）。

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
  "mine": {
    "effectiveLevel": "chief",
    "derivedLevel":   "trainee",
    "monthOrders": 186,
    "invitedFormalCount": 5,
    "nextLevel": null,
    "progress": 1.0
  },
  "expireRule": "见习团长 30 天未促成订单自动取消资格"
}
```

> ⭐ **`mine` 三个等级字段的语义（2026-09-18 · M5-11 · 缺陷 #94 收口 —— 原名 `level` 已删除）**
>
> | 字段 | 含义 | 数据来源 |
> | --- | --- | --- |
> | `effectiveLevel` | **实际生效等级**（平台当前按此计佣） | `ab_team_leader.level`，与 L11 / L14 的 `level` **同值** |
> | `derivedLevel` | **按本月业绩反推的「应处等级」** | `resolveLevel(monthOrders, invitedFormalCount)` —— 它是**晋级审计的输入**，**根本不看当前等级** |
> | `nextLevel` / `progress` | 相对 **`effectiveLevel`** 的下一级与推进度 | 服务端按阶梯推导；已在最高级时 `nextLevel = null`、`progress = 1.0` |
>
> ⚠️ **为什么必须拆名**：二者在演示数据达标时恰好相等，**看不出矛盾**；一旦不达标
> （例如「首席团长但本月只做 7 单」）就会**同时命中** `chief` 与 `trainee` ——
> 两个值都「对」，只是语义不同。**同名不同义比「两个名字同一义」更危险：编译器与类型系统都拦不住。**
> 故：**端上展示「我的等级 / 分佣比例」一律取 `effectiveLevel`**（或 L11/L14），
> `derivedLevel` 仅供「晋升预测 / 审计」读取；**不得**把它当「我的等级」用。
> 旧字段 `level` **刻意不留别名**（留别名等于让漂移回来），读它只会拿到 `undefined`。

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
| S3 | — | ~~`/supplier/packing-tasks?date=`~~ | ⚠️ **2026-09-16 · M4-0 迁出（路由已删除，打旧路径 → `10004`）** —— 打包任务整条迁至运营后台 `GET /admin/packing-tasks`（见 §6.4 扩展接口 · P39「加工场所打包」）。原「仅集散型/混合型可见」判据依赖已停用的 `ab_supplier.type`；且「名下有启用中加工场所即放行」会把**他方到货明细**开给供应商（违反 I1） |
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

#### M3-8 实现口径（S1–S2 · 供应商端出餐链路）

> **实现状态**：`S1 / S2` **已实装**（M3-8）；`S3 打包任务` 于 **M4-0 迁运营后台**（`GET /admin/packing-tasks` · P39）。
> 落点 `apps/api-server/src/modules/supplier/{supplier.controller.ts, supplier.service.ts, dto/supplier.dto.ts}`；
> 视图 P21 `/supplier/workbench` · P22 `/supplier/cook-confirm`（`apps/admin-web/src/views/supplier/`）；
> 打包任务视图 P39 `/supplier/packing-center`（`apps/admin-web/src/views/supplier/packing-center.vue`，**运营后台**）；
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
| 生成时机 | **首次访问 S1/S2 时惰性生成**（只生成该主体）；**打包任务（`/admin/packing-tasks`）生成全量**（闸门要看到所有供应商的到位情况，漏一家则「已到齐」是假象） |
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

**打包任务（S3 → M4-0 迁运营后台 `GET /admin/packing-tasks`）**：

| 项 | 规定 |
| --- | --- |
| 位置 | **运营后台**（`@Controller('admin/packing-tasks')` + `AdminGuard` + `@Roles('super_admin','admin','operator')`）。供应商端原路由**已删除**（→ `10004`）—— 打包线的编排是 ABox 自身的作业，不是供应商的活 |
| 可见性 | 有**启用中加工场所**才 `visible=true`；否则 `visible=false` + `reason`（**HTTP 200** ——「今天没有打包任务」是正常状态，不是错误）。判据**不按供应商收窄**（原按 `supplier_id` 收窄的做法已随该列停用而失效） |
| 闸门 | `ready=true` 仅当该场所当日**所有**菜品均已确认送达；否则 `blockers` 列出欠的供应商与菜品 —— 未到齐就开包会包出缺菜的餐 |
| 路线 | `R1…Rn` 按「主加工场所 id 升序」派生（与 D13 `delivery-map` **同口径**），站点按楼栋 id 升序；份数 = 所服务楼群当日已售份数之和 |
| **不返回** | **距离与单段时长** —— 无地图数据，原型上的 km/分钟是演示值，写进接口就是对外承诺 |
| ⭐ 为何不在供应商端 | 「他方到货明细」看板天然**跨供应商**，开给任一供应商即泄露同业经营数据（I1）。换判据只能治「看不到」，治不了「不该看」 |

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
| D23 | GET | `/admin/suppliers?status=&page=` | 供应商列表（M34-01 · **2026-09-16 M4-0**：`type` 筛选停用，传即 `10001`） |
| D24 | POST | `/admin/suppliers` | 新增供应商 |
| D25 | PUT | `/admin/suppliers/{id}` | 编辑 |
| D26 | POST | `/admin/suppliers/{id}/audit` | 资质审核（营业执照、食品经营许可证）（M34-02） |
| D27 | — | ~~`/admin/suppliers/{id}/type`~~ | ⚠️ **2026-09-16 M4-0 下线（路由已删除 → `10004`）**：`ab_supplier.type` 属**已停用历史字段**，改类型不再有独立入口（D25 编辑亦不再收 `type`，传即 `10001`） |
| D28 | PUT | `/admin/suppliers/{id}/settle-account` | **对公结算账户**（开户行、账号、发票抬头）（M34-04） |
| D29 | GET | `/admin/distribution-centers` | **加工场所配置列表（C4 · 表驱动）**（M4-0 起不再按供应商筛选） |
| D30 | POST | `/admin/distribution-centers` | 新增加工场所（**不再收 `supplierId`**，传即 `10001`） |
| D31 | PUT | `/admin/distribution-centers/{id}` | 编辑（**不再收 `supplierId`**，传即 `10001`；保留**结算参数**） |
| D32 | DELETE | `/admin/distribution-centers/{id}` | 停用（**软删**，保留历史结算关联） |

> ⚠️ **2026-09-16 · M4-0（自营口径前置）**：`ab_distribution_center.supplier_id` 由 **NOT NULL 改为可空历史字段**（列保留 · 新逻辑不读不写）；D29/D30/D31 **均不再受理 `supplierId`**（传即 `10001`）。**理由**：自营下加工场所是 ABox 自有场地，归属供应商既无业务意义、又让「加工场所 → 供应商」的唯一性约束失真。对外文案统一改称**「加工场所」**，实体名 `ab_distribution_center` 不变 |

> **C4 纪律**：加工场所**不是硬编码 4 个**，而是 `ab_distribution_center` 表驱动、默认 4 个、可增删；费用项（场地费 / 打包人工 / 配送费，**默认均 ¥0** · C9 修订）存 `ab_config`，管理员可调。
> ⚠️ **2026-09-16 自营口径**：这三项是 **ABox 自身履约成本**（不再是「应付给集散中心」的对外应付），默认 0 仅表示**尚未登记** —— 详见 《ABox一盒自营结算口径定义v1.0.md》 §三。

**扩展接口（不占 D 号 · D33 起已归财务）**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/suppliers/filter-options` | D23 附属 · 枚举类筛选器（审核状态 / 合作状态 / 付款方式；**M4-0 起不再下发 `typeOptions`**） |
| GET | `/admin/suppliers/{id}` | D23 附属 · 供应商详情（档案 + 银行 + 菜品 + 日志 + 外卖链接；**M4-0 起移除「加工场所」块与 `dcCount`**，共 6 块） |
| PUT | `/admin/suppliers/{id}/takeout-links` | 外卖平台店铺链接（美团 / 淘宝闪购 / 京东 · 详见下表末） |
| GET / POST / PUT | `/admin/dishes` · `/admin/dishes/{id}` | 菜品库（供价是 C9 输入项） |
| POST | `/admin/dishes/batch-status` | 菜品批量上下架 |
| GET | `/admin/distribution-centers/filter-options` | D29 附属 · 加工场所筛选器 |
| GET | `/admin/packing-tasks?date=` | **加工场所打包任务（M21-03 · P39）** —— **M4-0 由供应商端 S3 整条迁入**（原 `GET /supplier/packing-tasks` 已删除）。类级 `super_admin`/`admin`/`operator`；`finance`/`viewer`/供应商/小程序 → `10003`，未登录 → `10002` |

> ⚠️ **为什么详情独立成接口而不是塞进列表**：列表按行脱敏、**详情才回真实手机号**。若合成一个接口，「点开详情」与「翻列表」拿到的字段集相同，脱敏就形同虚设。

#### M3-6 实现口径（D23–D32 · 后台供应商管理）

**DDL 变更（本批次唯一）**：`ab_supplier` 增 7 列 —— `audit_status`（D26 落点）· `audit_remark` · `audited_at` · `audited_by` · `license_expire_at`（原型 P33「资质到期」列 · 123 号令要求）· `invoice_title`（D28）· `takeout_links`（JSON，外卖跳转）。详见《ER v2.1》§5.5。

> ⚠️ **M4-0 补充（不新增列）**：`ab_distribution_center.supplier_id` 改为**可空**（历史字段）、`ab_supplier.type` 转为**历史字段** —— 两列**均保留**，仅新逻辑不读不写（详见本表末「M4-0 契约级修正」）。

| 主题 | 口径 | 理由 |
| --- | --- | --- |
| D23 手机号 | 列表只回 `contactPhoneMasked`；**详情同时回** `contactPhone` 与 `contactPhoneMasked` | 两个字段一起给，端上不必自己实现脱敏（各端实现一遍必然不一致） |
| D23 银行账号 | **任何后台接口都不回原文**，只回 `bankAccountMasked`；未登记 → **`null` 而非空串** | C10 人工对公转账，财务线下核对；`null` 让前端能区分「未登记」与「登记了空的」 |
| D23 派生值 | `licenseState`（`normal`/`expiring`/`expired`/`unknown`）、`canServe` 一律**不落库**，服务端现算 | 落库就要有定时任务刷；算错一次就是一整批脏数据 |
| D23 `canServe` | = 合作中 ∧ 资质已通过 ∧ 证照未过期 —— **与 S2 出餐前置校验同一判据** | 列表上显示「可出餐」而实际被拦，比不显示更糟 |
| D23 计数同源 | `dishCount` 与详情菜品数组长度**同一次查询得出**（**M4-0 起移除 `dcCount`** —— 供应商与加工场所已解耦，该计数不再成立） | 分两处算必然出现「列表 4 道、详情 3 道」 |
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
| ~~D27 与集散冲突~~ | ⚠️ **2026-09-16 M4-0 作废**：判据建立在 `ab_supplier.type` + `supplier_id` 之上，两者均已停用；D27 路由已删除，`50008` 闸门拆除 | 保留行仅为留痕（勿据此实现） |
| ~~D27 目标态重复~~ | ⚠️ **2026-09-16 M4-0 作废**（D27 已下线）；原语义由 D25 编辑承接：请求体带 `type` → `10001` | 保留行仅为留痕（勿据此实现） |
| D28 必填条件 | `payeeType=corporate` 时开户行与账号必填（**服务层校验，非仅 DTO**） | DTO 只表达「字段长什么样」；「什么条件下必填」是业务规则 |
| D28 发票抬头 | `invoice_title` **独立成列**，不复用 `name` | 展示名与开票名不一致是常态（个体户尤其） |
| D29 `canDelete` | 两道前置（历史应付 / 被分配引用）**合成一个布尔下发** | 前端据此禁用按钮，而不是点了才知道不行 |
| D29 楼群筛选 | 在**服务端内存**完成（JSON 列跨库字符串连接语义不同）—— 对外行为与 SQL 筛选一致 | sqlite `LIKE` 与 MySQL `JSON_CONTAINS` 语义不同；锁死为「服务端过滤」才能零改动切驱动 |
| D29 行内名称 | 服务楼群返回 **id 与名称两份** | 端上显示「国贸三期组」，不显示「#3」 |
| ⭐ D30/D31 停收 `supplierId` | 请求体带 `supplierId` → **10001**（`forbidNonWhitelisted` 直接拒；**不是** 50008） | 加工场所不再归属供应商（M4-0），该字段已从 DTO 移除。这与「值非法报业务码」不同 —— **字段本身已不存在**，属请求形状错误 |
| D31 `serviceGroups` | **整体替换**语义；**传空数组即清空** | 若实现成「空值 = 保持原值」，运营会以为解绑了、实际还挂着 |
| D31 `status=0` | 停用：保留记录、退出新分配、随时可恢复 | 停用 ≠ 删除（删除会被历史结算引用挡住，见 D32） |
| D32 软删前置 | 有历史应付 → 50002；被分配引用 → 50002。**错误信息给出「改用停用」的出路** | 只说「不行」运营就只能猜 |
| D32 零副作用 | 被拒时**不落 `deleted_at`**（软删标记只在两道前置都通过时才写） | 「先标记再校验」会留下删了一半的记录 |
| 费用默认值 | ⚠️ **2026-09-16 自营口径更正**：场地费 / 打包费默认 0 **只表示「尚未登记」，不代表成本为零** —— 自营下场地是 ABox 自有场所摊销、打包是 ABox 用工，**都是有真实成本的** | 与旧说法相反：**非 0 才是常态**。运营须登记真实值，否则经营毛利只是**上限值**、会被系统性高估（仍存 `ab_config`） |
| 两级白名单 | 类级 `super_admin` / `admin` / `operator`；**D24–D26 · D28 + 外卖链接 + 菜品所有写操作收窄到 `super_admin` / `admin`**（M4-0 起 D27 已下线，「定类型」不再存在） | 运营要能看名录、跟进资质补办；但填档案、审资质、改结算账户，都是「决定钱付给谁」的事。`finance` 同样收窄（菜单矩阵里财务本就没有 `/supplier/*`） |
| 越权副作用 | 守卫挡在业务层之前：**没建档、没改字段** | 不是「执行了再回滚」 |
| 操作日志 `targetId` | **新建类接口从响应体兜底取新对象 id**（请求里没有 id，服务端生成） | 否则 `POST /admin/suppliers` 的日志永远 `targetId=null`，「这家供应商是谁建的」只能靠翻全文比对名字 —— 审计等于半残。只认 `id` / `data.id` 两层，不深挖子对象（`order.id` 与 `user.id` 同现时选错就把「改了这单」记成「改了这个用户」） |
| 外卖链接语义 | 只传要改的平台（未传 = 保持原值）；传 `url: null` = **清空该平台**（「未入驻」是合法状态）；**清空某平台会同步剔除悬空的「推荐」标记** | 推荐指向一个已不存在的链接，就是一条死引用。C8：能跳转 ≠ 是合作伙伴 |
| 错误码 | 新增 `50006` `SUPPLIER_NOT_FOUND` · `50007` `DISTRIBUTION_CENTER_NOT_FOUND`；**`50008` `SUPPLIER_TYPE_CONFLICT` 于 M4-0 停用**（三处闸门拆除，号位保留不再使用）；复用 `50001` 资质未通过 · `50002` 加工场所被引用/有历史应付 | 见 §九 |

#### M4-0 契约级修正（2026-09-16 · 自营口径前置 · 零新增列 / 零新增错误码）

| 主题 | 口径 | 理由 |
| --- | --- | --- |
| 场所归属 | `ab_distribution_center.supplier_id` → **可空历史字段**（列保留 · 新逻辑不读不写） | 自营下加工场所是 ABox 自有场地；「场所属于某供应商」既无业务意义，又使唯一性约束失真 |
| 供应商类型 | `ab_supplier.type`（`dish`/`distribute`/`both`）→ **历史字段**（同上模式） | 「出餐型 / 集散型 / 混合型」三分类的前提是「供应商自己兼营场所」。自营下这个前提不成立，分类随之失去含义 |
| 历史字段统一手法 | **列保留 + 可空 + 新逻辑不读不写 + DTO 删字段**（前端传即 `10001`，**不静默忽略**） | 静默忽略会让前端「传了不报错、也不生效」，是最难查的一类不一致；`forbidNonWhitelisted` 让它立刻可见 |
| D27 下线 | `PUT /admin/suppliers/{id}/type` **整条路由删除** → `10004`；`50008` 号位保留不用 | 改类型的唯一动作对象是已停用的字段，留个入口只是留个坑 |
| D23 收敛 | 列表不再下发 `typeOptions`、`?type=` 不受理；详情移除「加工场所」块与 `dcCount`（7 块 → 6 块） | 派生/计数若还挂着已解耦的关系，就是「页面上还显示着已不存在的联系」 |
| D29–D31 收敛 | 三个入口**均不再收 `supplierId`** → `10001` | 与场所归属同一条主线：场所不再有「属于谁」这一说 |
| ⭐ S3 迁后台 | 打包任务 → `GET /admin/packing-tasks`（P39「加工场所打包」）；供应商端路由删除 → `10004` | 见下条「为何是迁移而非改判据」 |
| ⭐⭐ 为何是**迁移**而非**改判据** | 原判据「本主体名下有启用中集散中心」**在 `supplier_id` 停用后必然失效**（没有「名下」了）；但更根本的是它的**数据面本身就是跨供应商的** —— 打包线要按场所看到「所有供应商的到货明细」。只把判据换成「有任一启用场所」等于把同业数据开给每一个供应商，**违反 I1**。当前端只放行运营/管理员（`super_admin`/`admin`/`operator`），供应商与小程序一律 `10003` | 「看不到」是技术问题，「不该看」是合规问题 —— 换判据只能治前者 |
| 判据跨批次联动 | `defaultPackingDate()` 取**全量**最近生产计划日（不带走供应商的 `defaultDate(supplierId)`），否则「已到齐」在某些供应商视角下恒为假 | 闸门看到的是全局，取数也必须全局 |
| 错误码 | **零新增**：D27 旧路径 → `10004`、D25 带 `type` / D30/D31 带 `supplierId` → `10001` | 都是「路由不存在」或「字段不存在」，既有码足够 |
| 菜单同源 | 运营后台 `ADMIN_NAV` 业务组新增 `/supplier/packing-center`（P39）；供应商端 `SUPPLIER_NAV` 删 `/supplier/packing`；`ADMIN_MENU_KEYS` / `SUPPLIER_MENU_KEYS` 同步 | 授权了就必须有入口；入口撤了白名单也要撤（M3-14 的反向纪律） |

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
| **D43** | GET | **`/admin/finance/reconciliation?date=`** | 与微信支付对账（**支付日**锚 · **差异清单**为主体的纯读接口 · **已实装** M3-15）（M35-06） |
| **D44** | GET | **`/admin/finance/invoices?page=`** | 发票管理（**供应商 × 月份**派生台账 · **已实装** M3-15）（M35-07） |
| **D45** | GET | **`/admin/finance/withdrawals?tab=&status=&payoutBatchNo=&keyword=&page=`** | 提现审批列表（**已实装** M4-4）（M35-08） |
| **D46** | POST | **`/admin/finance/withdrawals/{id}/approve`** | 提现审批**通过**（`pending → approved` · **登记出款批次** · ⭐ **不动钱**）（**已实装** M4-4） |
| D46a | POST | `/admin/finance/withdrawals/{id}/reject` | 审批**驳回** → **原路解冻**（`balance +X` / `frozen −X`）（M4-4） |
| D46b | POST | `/admin/finance/withdrawals/{id}/paid` | 到账回执登记（`approved → success` · **一期人工通道的唯一收口**）（M4-4） |
| D46c | POST | `/admin/finance/withdrawals/{id}/fail` | 打款失败登记 → **原路解冻**（`approved/paying → failed`）（M4-4） |

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
| ⭐⭐ **两段式（2026-09-17 M4-2 定稿）：`pending` 是每天都出现的正常中间态** | 计佣（L9 取餐确认 / 4.4 自动确认）只写 `ab_commission(status='pending')`、**不动余额**；`settlePending` 是**唯一**把钱写进团长余额的地方（T+1 02:00 的 `commission-settle.task` 与 D35 共用它）。故 D35 出参**必须**带 `note` 说明「`scanned=0` 不是故障、也不是钱没结」—— 否则「点了按钮 0 条」一定被当成故障报上来（同 M3-10 的「如实标注」纪律）。⭐ 本次改动同时**激活**了一条此前从未运行过的守卫：`collectQuitBlockers` 的「有未结算佣金不得停职」（《缺陷与陷阱》#52） |
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

**M3-15 实现口径（D43 微信对账 · D44 发票管理 · M35-06/07）**

> 落点 `apps/api-server/src/modules/finance/reconciliation.service.ts`（D43 `reconcile`，**替换同名占位骨架**）·
> `invoice.service.ts`（D44 `list`，新建 · 纯读派生视图）· `finance-admin.controller.ts`
> （`GET reconciliation` · `GET invoices`）· `dto/finance.dto.ts`；
> 页面 P34 `/finance/reconciliation`（`views/finance/reconciliation.vue`，**由占位页改为实装**）
> 与 `/finance/invoices`（`views/finance/invoices.vue`，新增）；
> 验收 `scripts/e2e-m3.mjs` **§27**（**不依赖下单窗口**，夹具直插 + 使用**隔离支付日**取绝对值断言）。
> **零 DDL · 零新增错误码（两接口均为纯读 GET）· 零新增枚举值。**

| 项 | 口径 |
| --- | --- |
| ⭐⭐ D43 一期**不许假装已与微信对平** | 无商户号 + 无 API 证书 → **拿不到微信账单**。出参**强制**带 `channel.source='local_only'` + `billAvailable=false` + 人话 `note`（含「**不等于已与微信侧对平**」）。若实现成「内部两表比对通过 → `balanced: true`」，运营会以为微信侧也平了，而真正危险的差异（微信收了钱、系统不知道）**永远不可见**。接入账单下载后只补 `source='bill'` 与账单比对段，口径不变 |
| ⭐⭐ `date` 锚 = **支付日** | `anchor='paidAt'` + `anchorLabel='支付日'`（微信账单按**支付日**切日）。**这是财务域唯一一个 `date` 不指出餐日的端点** —— 拿它对 D33/D34/D36 的出餐日数字必然对不上（两个时间轴，不是 bug）。同 M3-13「同一句话在两页指两个区间」的同类陷阱，故显式回显锚 |
| ⭐ 主体是**差异清单**而非流水 | 当天所有进出账去 D33/D40 看；本页只回答「**哪几笔对不上**」。五类差异 `order_paid_no_log` / `log_success_no_order` / `amount_mismatch` / `duplicate_transaction` / `no_transaction_id`，**每类配套 `nextAction`（人话的下一步）**：「对账不平」四个字无法执行，「去商户平台按订单号查该笔是否真实收款」可以 |
| ⭐ 三角恒等式 | `orderFen`（`ab_order.paid_at` 当日已付款）− `logFen`（`ab_payment_log.paid_at` 当日 `success`）= `diffFen`，**正常必须为 0**；退款侧按 `refunded_at` 单列 `refundFen`，`netFen = orderFen − refundFen`（**收款与退款分开列**）。e2e 用**隔离支付日**钉死绝对金额 |
| ⭐⭐ `balanced` **双条件** | 同时要求**金额相等**与**无结构差异**：重复交易号 / 缺交易号可能不影响合计（金额一样、只是凭证异常），**只比金额会报「已平」** —— 而凭证重复恰恰是**重复入账**的前兆 |
| ⭐ 差异检测**三个方向** | ① 当日订单 → 检出「订单说付了、账上没有」（含「有流水但停在 `pending`」）；② 当日订单的**全部**流水（**不限日期**）→ 检金额不一致（回调丢失时流水 `paid_at` 为空，**按日期切就把它切没了**，恰好漏掉最该抓的一类）；③ 当日成功流水 → 检出「钱收了但订单没标」与重复交易号 |
| ⭐ 同订单多条流水 | 匹配时**优先取成功那条**，重复问题在 (c) 段另行单列 —— 避免「一条订单有两条流水」把匹配判成失败（两件事分开报，运维才知道该处理哪一个） |
| ⭐⭐ **刻意不提供「一键平账」** | 对账的作用是**暴露差异**，不是把差异抹掉。出参无任何写动作、无 `force` 参数 |
| ⭐⭐ D44 **零 DDL · 派生视图** | 不建 `ab_invoice` —— 发票的全部事实已在 `ab_supplier_share`（`invoice_no` + `paid_at` + `payee_id`）。建表立刻产生**第二份真相**（「应付表说付了、发票表说没票」时以谁为准）。与「派生值不落库」不变量一致 |
| ⭐⭐ D44 粒度 = **供应商 × 月份** | 发票按月开一张。按单条应付行平铺会看到「同一发票号重复 30 次」，**完全看不出**「这家这个月只开了一半」。三态 `none` / `partial` / `full` 中，**`partial` 是本页存在的理由**。e2e 造三个隔离月份分别钉死三态 |
| ⭐ D44 月份锚 = **应付单生成月**（`share_date`） | 权责发生制台账（跨月付款仍归原月），**不是付款月**。复用 `monthRangeOf()`（项目**月份边界的唯一实现**，与佣金/晋级审计同源） |
| ⭐⭐ D44 分母**只含已付款行** | 未付款就要票，供应商不会给。未付款额单列 `unpaidAmountFen` / `unpaidRowCount`，**不进开票状态判定** —— 否则一个刚出单的日子会满屏「未开票」，把真正的欠票淹没。e2e 在 `none` 组里插一行 `pending` 钉死 |
| ⭐ D44 两个**可执行的下一步** | `titleMissing`（未登记开票抬头 → 去 D28 补，**没有抬头票开不出来**）· `overdue` + `overdueDays`（已付款超 30 天仍无票 = **税前扣除凭证缺失**的税务风险） |
| ⭐ D44 冲销行**不进发票分母** | `reversal` 负行只累加 `reversalFen` 作提示（若已按原金额开票，需与供应商**另行换票**）。本期不做换票流程，故只提示、不改态 —— 边界已在出参 `note` 写明 |
| ⭐ D44 分月**必须在服务端内存**完成 | `strftime`（SQLite）与 `DATE_FORMAT`（MySQL）是**驱动相关**语法，用了就破坏「四驱动零改动切换」，且本地全绿、换驱动才炸（同 M3-6/D29 楼群筛选的既有处理）。`month` 筛选仍走 `share_date` 区间比较（跨库一致） |
| ⭐ D44 `status` 是**派生值** | 库里的三态是 `pending` / `success` / `failed` / `reversed`，开票三态是**算出来的** → 必须**先聚合再筛**。非法枚举 → `10001`（**不静默回落成「全部」**，回落会让运营以为在看「未开票」而漏催一批） |
| 复用（不新立口径） | 失效应付集合复用 `stats.constants.ts` 的 `PURCHASE_VOID_STATUSES`（不写第二份名单）· 月份边界复用 `monthRangeOf()` · 分页与汇总复用 `normalizePage` / `paginate`（`summary` 取**筛选后全量**、不受分页影响，与 D8/D34/D36/D40 同一约定） |
| 权限（两级白名单） | 两接口均为**纯读 GET**，故**不额外收窄**：类级 `FINANCE_VIEW_ROLES`（含 `operator` —— 运营要跟进「今天哪几笔对不上」）即可；**不含 `viewer`**（`admin-role.ts` 里 viewer 菜单只有 4 个看板页）。e2e 五档矩阵（finance / operator 可读 · viewer `10003` · 未登录 `10002` · 供应商 `10003`） |
| 菜单同源 | `/finance/invoices` 同时进 `ADMIN_MENU_KEYS` + `finance` 角色菜单 + `ADMIN_NAV` 入口（**授权了就必须有入口** —— M3-14 修掉的正是「授权却点不到」这个反向缺口） |
| ⚠️ 顺手删掉**死占位** | `modules/finance/reconciliation.service.ts` 原为 `export {}` 占位骨架 —— 本批由其真实实现替换，「对账服务写哪」由此**只有一个答案**（同 M3-13 删 `finance.controller.ts`、M3-12 删 `MessageService` 空占位） |

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

**M4-4 实现口径（D45 提现审批列表 · D46 / D46a / D46b / D46c 四动作 · P34 · 模块 M35-08）**

> 落点 `apps/api-server/src/modules/finance/withdraw-admin.service.ts`（新）+
> `finance-admin.controller.ts` + `dto/finance.dto.ts` + `finance.constants.ts`（新 · **域级角色白名单单一真相**）；
> 页面 P34 `/finance/withdrawal`（`views/finance/withdrawal.vue`，新）；
> 验收 `scripts/e2e-m3.mjs` **§31**（**不依赖下单窗口** · 专用团长夹具 · 节末全量还原）。
> **零 DDL**（`ab_withdraw.payout_batch_no` 列早已存在）· **新增两个错误码** `40016` / `40017`。

| 项 | 口径 |
| --- | --- |
| ⭐⭐ 这一页**不是报表，是「钱出不去」的解法** | L12（提现申请）从 M2 起就实装：申请一瞬间 `balance −X` / `frozen +X`。而本批次之前**后台没有任何端点能把这张单往前推** → 三个可观测后果：① 团长的钱被**永久锁死**（`frozen` 只增不减，且没有任何界面或接口能让它下降）；② `collectQuitBlockers` 的 `WITHDRAW_IN_FLIGHT` 分支以 `pending`/`approved`/`paying` 判定「有未完成的提现」→ 只要提过一次现，C3 退出团长**再也不可能成功**，而错误文案还写着「等待提现到账」（等一个永远不会发生的到账）；③ `ab_team_leader.withdrawn_amount` 永远是种子值（全仓无写点）。故本服务的定位是**把 L12 打开的资金链收口** |
| 状态机与四动作 | `pending → approved → success`；`pending → rejected`；`approved/paying → failed`（**驳回与失败都是原路解冻**）。⭐ 第四态 `paying` 是二期 `FLEX_API`（自动通道）的中间态，**一期刻意不提供入口** —— 人工通道下「已提交平台、等回执」在系统里没有可观测锚点，造一个只会让运营多点一次按钮却什么都不改变；但**两个收口动作都接受 `paying` 作为入参**（`WITHDRAW_FROZEN_STATUS` 已把它算作占用中），二期接 API 后无需改动收口逻辑 |
| ⭐⭐ 唯一的冻结释放口 | 驳回 / 到账 / 失败三路**共用** `releaseFrozen()`，差别只在 `direction`：`'in'`（驳回 / 失败）= 把钱**挪回可用余额**（`balance +X` / `frozen −X`，**`total_in`/`total_out` 都不动** —— 钱没进出平台，只是从「冻结」挪回「可用」，同 D39 冻结/解冻口径）；`'out'`（到账）= 钱**正式出平台**（`frozen −X` / `total_out +X`，可用余额不变）。⚠️ 三路各写一份的后果**不是重复代码，而是其中一路漏掉某个字段**：例如「到账忘了减 `frozen`」→ 该用户的冻结额永久虚高，而同一天其余提现看起来都正常，只有他自己的「可提现余额」越用越少 |
| ⭐⭐ `total_out` 按**申请金额**而非实付累加 | 申请时已从可用余额扣掉 X，到账只是把这笔被冻结的钱**正式记为支出**。若按实付（X − 代扣）记，`total_in − total_out` 与 `balance + frozen` 之间会**永久**留下一个等于代扣税额的缺口 —— 账面上看是「平台多留了钱」，而那笔税是**平台代扣代缴给税务**的、不是平台留存。e2e 用「到账前后 `(total_in − total_out)` 的差值 === 申请金额」钉死 |
| ⭐⭐ 到账**不写** `ab_balance_log` | 该表语义是「**可用余额**的每一次变化」（`direction` 只描述可用余额，`balanceAfter` 逐条落痕、末条 === 当前余额 —— L11 ↔ L19 靠这个互验）。到账那一刻可用余额**不变**（钱早在申请时就被扣走了），故没有一条属于它的行。⭐ 这不是「账本与快照不同源」：`frozen` 与 `total_out` 的变化**从来**不由流水解释（D39 的 `freeze` 行就是先例）。到账事件由 `ab_withdraw` 自身完整承载（`paid_at` / `tax_withheld_amount` / `actual_amount` / `payout_batch_no`）。e2e 把「到账后流水条数不变」写成断言 —— 让「为什么没有」变成**声明**，而不是让后来人以为漏写了 |
| ⭐⭐ 解冻前 fail-closed `40015` | 解冻**前**先校验 `frozen >= 申请额`，不足即 `40015`（**不复用 `40002`**）—— 前者是「**冻结账对不上**」的账实不符信号（有人绕过了冻结口径，该去查数据），后者是「钱不够花」（等入账 / 让人充钱即可）。硬扣会让 `frozen` 变负，并在**下一个用户**那里表现为「冻结额凭空多了」。用户无余额账户走同一码（`data.hasAccount=false`） |
| ⭐ 状态机守卫 `40017` | 四个动作两两之间都可能被误操作（对已到账的单再点「批准」、对已驳回的单点「到账」），而每个误操作的后果都是**再动一次钱**。故一律显式返回「当前状态「已到账」不支持批准（提现单 WD…）」这种**能直接照着排查**的话，`data.allowed` 回带允许集合。⚠️ **刻意不复用 `40013`**：两者形态相同，但**排查入口不同** —— 退款单去 D40 看、提现单去 D45 看，运营拿到码就知道该去哪个页面找这张单 |
| 未知单号 `40016` | 与 `10004`（通用「资源不存在」）**刻意分开**：`10004` 里还含着「在库但无权访问」，而这里是「这张单压根不在库里」—— 拿到码就知道该去 D45 找，而不是去查权限 |
| ⭐ `payoutBatchNo` = **审批日批次** | `PB{yyyyMMdd}`（`payoutBatchNoOf()`），**刻意不含随机位** —— 单号要「一单一号」（唯一），批次号要「**同日同批**」（**聚合**）：一期人工通道下运营每天集中把当天批准的提现汇总成一份清单提交灵活用工平台、回执也整批回来。需要一天内分批提交时由操作者在 D46 入参**显式覆盖**；**不自造「当日第 N 批」计数器**（计数器要跨请求读-改-写，并发下会撞号，而批次号**不是**资金主键 —— 提现单号才是），故也不为它引入锁 |
| ⭐ 到账登记的自洽校验 | 规则 `申请额 − 代扣 = 实付`。两栏**都传却不自洽 → `10001`**（**不允许两处各记一套**：那必然产生「账上代扣 50、实付按另算」的双真相，事后无从判断哪个是真的）；只传一栏 → 推出另一栏；**两栏都不传 → 视为无代扣**，但出参标 `taxSource='assumed_zero'`（**让「系统替你假设了 0」看得见** —— 否则页面上的「实付 = 申请额」看起来像一个已被核实的结论）；任一栏为负 → `10001` |
| ⭐ `actualKnown` / `taxKnown` | 一期人工通道里 `actual_amount` 在到账登记前**等于申请金额**（`apply()` 就是这么写的）。若页面上把「实付」直接当结论展示，运营会以为个税为 0 → 故**只在已到账时**把实付 / 代扣视为已知，否则双 `false`，端上显示「—」 |
| ⭐ 汇总两类量**刻意分开** | **在途量（时点量）**：`pending*` / `approved*` / `paying*` / `frozenByWithdrawFen` 取**全量**、**不随筛选变化**（「平台此刻因提现占用了用户多少钱」不该因为运营在搜索框里敲了个姓名就变小），出参带 `asOf`；⭐ `frozenByWithdrawFen` == 三状态金额之和，可与 `ab_balance.frozen` 的**增量**互相验算（后者还含 D39 的手工冻结）。**历史量**：`paid*` / `released*` 取**同一过滤条件的全量**（不受分页影响，翻页时数字不跳，与 D34/D40 同一约定） |
| ⭐ 每行动作可用性**唯一在服务端** | `canApprove` / `canReject` / `canMarkPaid` / `canMarkFailed` + `blockReason`（终态时给人话说明）由服务端下发，端上照渲染、**不自己判状态** —— 否则「前端判断」与「后端守卫」两套口径必然漂移，且漂移的表现是**按钮能点、点了报错**（同 D9/D40） |
| 排序 = 待审批最久优先 | `orderBy(status ASC, id ASC)` —— 运营这一页的动作是「**清空队列**」，不是「看最新的」。⚠️ `status` 是字符串枚举，字典序**不作**跨状态的时间语义解释，排序只用于把 `pending` 顶到前面 |
| 关键词跨四处匹配（子查询） | 单号 / 收款人 / 团长姓名 / 用户昵称；用**子查询**而非 JOIN —— JOIN 会让分页的 `getManyAndCount()` 行数被放大（一个用户多行时 count 失真），同时避开 SQLite 绑定变量上限 999（M3-9 已踩过） |
| 乐观锁 | 审批 `UPDATE ... WHERE id=? AND status='pending'`、解冻 `UPDATE ... WHERE id=? AND version=?`，`affected=0` 即 `10001`「请刷新后重试」（**不重试、不静默覆盖**） |
| ⭐⭐ 权限两级 + 常量单一真相 | **类级** `FINANCE_READ_ROLES`（`super_admin`/`admin`/`finance`/`operator`）—— 运营要能看提现队列、跟进「这笔提现怎么还没到账」；**D46 系列四个动作方法级收窄到 `FUND_ACTION_ROLES`**（`super_admin`/`admin`/`finance`，**不含 `operator`**）—— 决定「钱发不发」是资金动作，同 D35/D39/D41。⭐ 两个集合定义在 `finance.constants.ts`，由 **D35 / D39 / D41 / D42 / D46 系列共用一份**（此前五处各写字面量，那种副本的后果**不是编译失败而是静默漂移**：「按钮亮着、点了 `10003`」或更糟的「按钮灰着、其实有权限」）；出参 `actions.canAudit` 与 `@Roles(...)` **共用同一常量**。两集合**均不含 `viewer`**（其菜单只有 4 个看板页，与 D47–D50 刻意含 viewer 正好相反） |
| 操作日志 | 四个写端点各标 `@OperationLog({module:'finance', action: '提现审批通过' / '提现审批驳回' / '提现到账登记' / '提现打款失败'})` —— 必须能回答「谁在什么时候把这笔钱放出去了 / 打回来了」。D45 为纯读 GET，不标 |
| 菜单与白名单同源 | `/finance/withdrawal` 进 `ADMIN_MENU_KEYS` + finance 角色菜单 + `ADMIN_NAV`（**授权了就必须有入口** —— M3-14 曾漏挂 5 个子页，运营只能手输 URL；`FUND_ACTION_ROLES` 本就含 finance，故菜单必须给入口） |

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
| D61 | GET | `/admin/deliveries?date=&buildingGroupId=&status=` | 配送单列表 + 份数差异（M5-1 · 收口 #61） |
| D62 | PUT | `/admin/deliveries/{id}` | 配送单人工修正（份数 / 司机 / 车牌 / 备注 · `version` 乐观锁 + 写日志） |
| D63 | PATCH | `/admin/deliveries/{id}/status` | 配送单状态推进（履约流转 · **联动订单状态机 T8/T9** · `version` 乐观锁 + 写日志） |

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
| ⭐⭐ **跨键自洽性校验（M5-3 · #49）** | 时刻类配置**逐项合法 ≠ 组合有意义**：开团晚于截单 → 用户可下单窗口是**空区间**（谁都下不了单），而每一项单独校验都会通过、系统照跑、**没有任何报错** —— 这类矛盾**只有同时看两个键**才看得出来。故写入前做一次 `timelineConflict()`：① 开团必须**严格早于**截单；② 开团到截单的间隔必须**大于** `order.cutoff_window_minutes`（否则「截单前 N 分钟关窗」会把窗口吃光）。不满足 → `10001` + **点名是哪两个键冲突**，与逐项校验**同一批失败**（整批不写入）。⚠️ 判据放在服务端而非前端：前端只是入口之一 |
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
| 未接线项为何不顺手接上 | ⚠️ **M3-10 当时不在本批次把配置接到调度上**：`@Cron()` 是静态元数据，动态化需改用 `SchedulerRegistry` 或 `@Interval` + 运行期判断，会动到**下单窗口**（e2e 全量依赖 14:00–23:00 时间窗），属独立验收项。混在本批次只会让「配置页做完了」掩盖「调度还没接线」→ **已登记为独立待办（见《缺陷与陷阱》#49）**。<br>⭐ **2026-09-17（M5-3）已接线并关单**：8 个任务类**移除 `@Cron`**，改由 `ScheduleRegistrar` 按**生效时间轴**生成 cron 并热重载；`24:00` 成为合法时刻（截单口径的原生表达）；下单窗口上界改为**算出来的**（`截单 − order.cutoff_window_minutes`）。详见本文件「最近修订（M5-3）」与 §6.8 |
| 错误码 | **无新增**（复用 `10001`）；`data.fields` 回带逐条中文问题描述（如「『套餐默认售价』不能小于 0.01 元（当前 0）」） |

**M3-12 实现口径（D59–D60 · 新增第 27 张表 `ab_message_template`）**

> 落点：`apps/api-server/src/modules/admin/template/message-template.specs.ts`（**场景声明 = 唯一真相**）· `message-template.service.ts` · `dto/message-template.dto.ts` · `admin.controller.ts`（D59/D60 两个方法）；
> 投递侧 `apps/api-server/src/modules/message/message.service.ts`（M3-12 由空模块实装）；
> 页面 `apps/admin-web/src/views/system/message-template.vue`（P36 · 路由与菜单为脚手架预留，本批次无需改动）；
> 验收 `scripts/e2e-m3.mjs` **§24**（47 条断言 · **不依赖下单窗口**）。

| 项 | 口径 |
| --- | --- |
| 依据 | 原型 `P36 系统配置` 的「📨 消息推送策略（微信订阅消息）」卡片，**6 个场景逐行对应**（原型 5 行 + M4-3 新增 `commission_settled`）。三条原文口径：① 用户端**常规订单状态不推送**（避免打扰），退款结果 / 异常属**必推项**；② 团长送达通知走「微信群 + 服务通知」双渠道；③ 初期以**微信群人工通知兜底** |
| ⭐ 与原型的一处**有意收窄**：团长送达通知只声明**单渠道** `wechat_group` | 原型把该场景写成「微信群 + 服务通知」双渠道，但一期**只有人工发群**（原型自己也写「初期以微信群人工通知兜底」，服务通知属**二期替代方案**）。若照抄双渠道：订阅消息是启用必要条件 → 该场景在种子里启用后**必然缺微信模板 ID** → 「已启用」与「启用闸门」当场互相矛盾（要么放行一个发不出去的场景，要么把唯一能用的场景也锁死）。**渠道是代码事实** —— 代码一期只发人工群，就照实写。二期接服务通知时，改 `specs` 加渠道即可（闸门会自动开始要求模板 ID） |
| ⭐ 存储选型：**独立表**而非塞进 `ab_config` | `CONFIG_SPECS` 的类型系统是**扁平标量**（money / percent / int / text / time），撑不住「场景 + 多渠道 + 变量白名单 + 启用闸门」。硬塞只有两条路：JSON-in-`config_value`（则 D58 的白名单与单点校验失效，校验逻辑四散 → 立刻多出第二个真相），或拆成十几个扁平键（则「一个场景」这个整体在库里不复存在，`ab_message.template_id` 也无从对应）。**规范 §八 原将 `ab_message` 列入 P36 依赖 —— 实际是「推送日志」表（`template_id` 存的是微信侧模板 ID），不是模板定义**，故本批次新增载体并在此登记 |
| ⭐ **场景定义是代码事实，不落库** | `scene` / 渠道组合 / 触发时机 / 变量白名单 / 是否必推全部在 `message-template.specs.ts`。落库会漂移成「库里写着走微信群、代码只发订阅消息」这种**无法自证**的矛盾。库表只存**可编辑部分**：`enabled` / `wechatTemplateId` / `groupContent` / `updatedBy` |
| ⭐⭐ **微信订阅消息的文案不由本页决定** | 订阅消息内容在**微信公众平台**按模板定义（`thing1` / `time2` 这类 keyword），服务端只能往 `data` 填值。故 D59 的 `note` **明写这一点**：本页文案字段服务「微信群人工通知」与台账存档，**改它不会改变用户收到的订阅消息**。不写明，运营会以为改了文案用户就能看到新内容 —— 即 M3-10「给了输入框却没接上线」的同类问题 |
| ⭐ **接线状态两级如实标注** | **场景级** `wiring`：`live`（有真实投递点）/ `pending`（一期无投递点，**必附 `pendingReason`** 点明为什么）。**字段级** `fieldWiring`：`enabled`/`wechatTemplateId` = `live`（真生效）、`groupContent` = `record_only`（供人工复制发群，**不是程序行为**）。⭐ **M4-3 后 `live` 有 3 条**（`refund_result` / `leader_apply` / `commission_settled`）——但**三者 `enabled` 均为 0**：`wiring`（有真实投递点）与 `enabled`（配置就绪）是**两件事**，页面必须能同时表达「代码接好了、配置还没到」；三期接入微信账号后只需在后台配模板 ID |
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
| **不引入缓存** | 全表 6 行、只在「打开管理页」与「产生一条退款通知」时读，属低频路径。**没有缓存就没有「写完忘了失效」**。将来读频率上来再加，届时必须同时补 `invalidate()` 调用点（代码注释已留此约束） |
| 种子状态 | 由 `MESSAGE_TEMPLATE_SPECS` **派生**（不存在第二份场景列表）。⭐ **只有 `leader_delivery` 启用**：它含微信群渠道（人工发群只需文案），不依赖尚未申请的微信模板 ID；其余 5 个场景 `enabled=0`，如实反映「一期没有微信账号」 |
| 库中多余行 | 库里有、声明里没有的场景行**不展示**（代码不会用它投递），但**大声记 WARN 日志** —— 静默无视会让脏数据永远没人发现 |
| 权限 | 类级沿用 `@Roles('super_admin','admin')`（同 D51–D58）。`operator`（菜单本就不含 `/system/*`）/ `finance` / `viewer` / `supplier` / 小程序 token 一律 `10003`；未登录 `10002` |
| 操作日志 | `@OperationLog({ module:'system', action:'编辑通知模板' })` —— 必须能回答「谁在什么时候关掉了退款通知」。GET 不标 |
| 错误码 | **无新增**：目标不存在 → `10004`；闸门 / 变量 / 只读字段 / 空请求 / `id` 非法 → `10001`（`data.fields` 回带逐条中文说明） |

---

### 6.8 定时任务（M4-1 · 跑批与手动补跑）

> 权威清单：《订单状态机与全链路流转 v1.0》§3。**M4 分三批推进**：
> **M4-1 日切链路 ✅** · **M4-2 结算链路 ✅** · **M4-3 队列消费者 + 订阅消息投递点 ✅（本批 · 4.9 / 4.10）** —— **M4 全部收口（4.1–4.12）**。
> **本批零 DDL、零新增错误码。**

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| **S1** | GET | **`/admin/schedule`** | **跑批时刻表**：8 个任务的触发时刻 + **目标日期语义** + 职责 + **实装状态**（M4-1） |
| **S2** | POST | **`/admin/schedule/{task}/run`** | **手动补跑某一个任务**（`date` 可选，缺省按该任务的日期语义推导）（M4-1） |

**S1 出参**：`{ list: [...], summary: { total, implemented } }`，每行
`{ task, cron, timeZone, dateKind, dateKindLabel, what, implemented, pendingNote }`。

**8 个任务与目标日期（`dateKind` 是本节的重点）**

| 任务 | 触发 | 目标日期 `dateKind` | 职责 | 本批 |
| --- | --- | --- | --- | --- |
| `meal-publish` | T-1 14:00 | **`tomorrow`（次日）** | 开团：次日套餐上架（4.1） | ✅ 已实装 |
| `cutoff` | T 00:00 | `today`（当日） | 截单：未支付兜底取消 / 已支付锁定 / 定格备料量（4.2） | ✅ 已实装 |
| `delivery-generate` | T 00:30 | `today` | 按楼群生成配送单（4.3） | ✅ 已实装 |
| `auto-confirm` | T 14:00 | `today` | 自动确认收货（4.4 · **只转 `delivered`**）+ 计佣（写 `pending`） | ✅ 已实装（M4-2） |
| `commission-settle` | T+1 02:00 | `yesterday`（前一日） | 佣金入账（4.5 · `pending → settled` + 进余额） | ✅ 已实装（M4-2） |
| `supplier-share` | T+1 02:10 | `yesterday` | 供应商应付结算（4.6） | ✅ 已实装（M3-9） |
| `reconciliation` | 04:00 | **`yesterday`（前一日 · 2026-09-17 由 `today` 改正）** | 对账（4.7 · 核昨日完整自然日 · 按支付日切日） | ✅ 已实装（M4-2） |
| `leader-expire` | 03:00 | `null`（与出餐日无关） | 见习团长 30 天失效（4.8） | ✅ 已实装（M2） |

| 项 | 口径 |
| --- | --- |
| ⭐⭐ **同刻不同日** | `meal-publish` 与 `auto-confirm` 的 cron **完全相同**（`0 0 14 * * *`），但前者开「**次日**」的团、后者确认「**当日**」的单。cron 表达式只写「几点跑」、**不写「动哪一天」**，写反了照样编译通过。故 S1 **必须**下发 `dateKind`（并附中文 `dateKindLabel`）—— 这是该陷阱的唯一防线。⭐ **M5-3 起 `dateKind` 也由时间轴派生**（`dateKindFor()`）：`cutoff` 是唯一会随配置变化的 —— 截单 `24:00` 折算后落在 **T 日** 0 点（`dateKind='today'`），而配成 `23:30` 则落在 **T-1 日**（必须 `'tomorrow'`）。**写死 `today` 会让「把截单改到 23:30」变成静默锁错日期**（锁 T-1 的订单，而 T-1 的团早已截完 → 「跑批成功、当天订单一张都没锁」，且无任何报错） |
| ⭐ **声明表是唯一真相** | `TASK_SCHEDULES`（`tasks/schedule.service.ts`）一张表写清 8 个任务的「几点跑 + 动哪一天」。任务体**永远不写日期计算**：日期由 `ScheduleService.run()` 从表推导并**回传给任务**，任务里根本没有写错日期的地方 |
| ⭐⭐ **跑批时刻由运行时注册器决定（M5-3 · #49）** | `@Cron()` 是**装饰器参数**，模块加载时求值一次后即静态元数据 —— 后台改配置**永远不可能**影响它（这就是「配了不生效」的机制性根因）。故 8 个任务类**已移除 `@Cron`**，改由 `ScheduleRegistrar` 在 `onModuleInit` 读**生效时间轴**（`order-timeline.ts`）生成 cron 并 `SchedulerRegistry.addCronJob()`。⭐ **订阅时间轴变更做热重载**：改「截单时间」→ 下单窗口与 cron **同一次变更**，无需重启（否则会出现「用户已不能下单、截单跑批仍按旧时刻跑」的**半生效**状态，比不接线更难查）。⚠️ 该机制最危险的失败形态是**任务静默不跑** → 三道防线：注册完逐名 `doesExist` 核对（缺则**拒绝启动**）· 启动横幅 · S1 下发 `registeredCron` |
| ⭐ **补跑与跑批共用同一执行口** | 任务的 `runOnce(date)` 就是其 cron 处理器内部调用的那一个方法，补跑只做「推导日期 + 调它」。故「跑批算出来的数」与「手动补跑算出来的数」在结构上不可能不同 |
| ⭐ **补跑刻意不加锁** | 锁（`KvService.setNx`，键 = 任务 + 目标日期）的语义是「同一目标日期只跑一次（防并发重入）」，而补跑的动机恰恰是「跑批没跑成」—— 被锁挡住就失去用途。重复补跑的安全性由**业务幂等**保证（以 `meal_date` 为键） |
| ⭐ **跑批不落库运行记录** | 项目不变量「派生值不落库」。要查「昨夜跑了什么」看日志，不查表 |
| ⭐ **实装状态如实标注** | 未实装任务出参 `implemented:false` + `pendingNote`（点明补齐批次），且**补跑被明确拒绝**（`10001`）。把「只打一行日志」的占位任务显示成「已上线」，比不显示更伤运营信任（同 D57–D60 的接线状态标注纪律）。⭐ **M4-2 后 8/8 全部实装**（`summary.implemented === 8`）；`PENDING_NOTE` 表**刻意保留为空表** —— `implemented` 是 `runners.has(task)` 的**派生值**而非手写常量，将来「只加声明、不写执行口」时页面会自动如实显示「未实装」 |
| ⭐⭐ **日期校验必须是 `isRealDate`** | `date` 非法 → `10001`。**不能只做格式校验**：`2026-02-30` 格式合法但日历上不存在，放行后 `Date.UTC` 会**静默滚动**到 `2026-03-02` —— 运营以为在补跑「2 月 30 日」并看到「完成」，实际批量改了 3 月 2 日的订单（《缺陷与陷阱》#56 / #60） |
| ⭐ **`date` 缺省时的推导与跑批同源** | 走同一个 `ScheduleService.targetDate(kind)`；`dateKind=null` 的任务（`leader-expire`）缺省取**当日** |
| 权限（**两级**） | 类级 `@Roles('super_admin','admin')` —— **不含 `operator`**：补跑是**改写历史数据**的高危操作（把一个已过去的日期重新跑一遍），不是日常作业。与 P39 打包任务（含 `operator`）的取舍**相反，理由也相反**：那边是「运营每天都要用」，这边是「出事才用一次，且必须有人负责」。也不含 `viewer` / `finance`（只读角色不该有改写历史的能力）。未登录 `10002`；其它角色 `10003` |
| 菜单同源 | `/system/schedule` 进 `ADMIN_NAV` **系统组** + `ADMIN_MENU_KEYS`（仅 `super_admin` / `admin` 可见）—— 授权了就必须有入口 |
| 操作日志 | S2 标 `@OperationLog({ module:'schedule', action:'手动补跑定时任务' })` —— 必须能回答「谁在什么时候重跑了哪一天」。S1（GET）不标 |
| 错误码 | **零新增**：未知任务名 / 未实装 / 日期非法 → `10001`（均属「请求形状不对」，既有码足够） |
| 落库 | **零 DDL**：不新增表、不新增列。截单顺带回写 `ab_meal_assignment.sold_count`（语义见下） |

> ⭐ **截单顺带的语义修正（重要）**：`ab_meal_assignment.sold_count` 的注释原写「已订份数（实时累加）」，
> 但**全仓没有任何累加点**（下单不加、取消不减）—— 而它是「推给供应商的备料量」的聚合基数，
> 导致跑批推送的份数**恒为 0 且不报错**。本批改为在**截单这一「定格」时刻从订单表聚合一次并落库**，
> 语义明确为「**截单定格的已售份数**」：截单前不承诺准确，截单后不再变。
> 同一时点还会**覆盖刷新**生产计划（`freezeProducePlan`，只覆盖未开工父行）—— 否则截单前被访问
> 而惰性生成的偏小计划会一直留到供应商手里。

**M4-2 实现口径（4.4 自动确认 · 4.5 佣金入账 · 4.7 对账 · 结算链路）**

> 落点 `tasks/auto-confirm.task.ts` · `tasks/commission-settle.task.ts` · `tasks/reconciliation.task.ts` ·
> `modules/order/order.service.ts`（`autoConfirmByDate`）· `modules/finance/commission.service.ts`
> （`accrueForOrders` / `settlePending` / `monthOrdersOf`）· `modules/finance/reversal.service.ts` ·
> `modules/finance/reconciliation.service.ts`（`reconcile`）。
> 验收 `scripts/e2e-m3.mjs` **§29**（10 条不变量 · **不依赖下单窗口**）+ **§28** 三条「未实装」断言翻转为 8/8。
> **零 DDL · 零新增错误码。**

| 项 | 口径 |
| --- | --- |
| ⭐⭐ **佣金两段式（本批头号决策）** | `T 日 14:00 计佣（`pending`，不动余额）` → `T+1 02:00 入账（`settled` + 进余额）`。**计佣与入账是两个动词、两处落点**：`accrueForOrders` **只写 `ab_commission(status='pending')`**，`creditCommissions` 是**唯一**把钱写进余额的地方（只被 `settlePending` 调用）。旧实现「确认即入账」把两件事合成一件，退款窗口里就必然出问题（见下） |
| ⭐⭐ **退款的两条冲销路径（C9）** | ① **退款落在 `pending` 窗口** → **只把原行作废**（`pending → cancelled`），**不写负向冲销行、不动余额**，`notes` 明写「未动余额」；② **已入账（`settled`）** → 写 `type='reversal'` 负行 **+ 扣余额**。⭐ 旧实现只有路径②：在 ① 的窗口下会**从余额里扣一笔从未入账的钱**，而余额**允许为负** → 可能扣成负数形成**假欠款**，且**没有任何地方会报错**（《缺陷与陷阱》#62） |
| ⭐ 出参符号与「是否已入账」**无关** | `commissionReversedFen` **恒正**、`commissionReversedQuantity` **恒负**（端上按 `−X` 展示）。故端上**不需要**按「是否已入账」分叉 —— 一笔 `pending` 的佣金被退款，份数照样回退，只是钱没动 |
| ⭐⭐ 4.4 **只转 `delivered`** | `autoConfirmByDate` 只把 `status='delivered'` 的单转 `completed`；`pending_pay` / `paid` / `cut_off` / `cooked` / `delivering` / `refund_applying` / `refunding` **一律原样不动**，进 `notDelivered.byStatus` 并 `logger.warn`。**异常态 fail-closed**：到 14:00 还没送达是**履约异常**，把它当「确认收货」处理等于把异常洗成正常单（且佣金照计）。⚠️ 与 L9 手动确认刻意**宽严不同**：团长在楼下收款时可能面对 `delivering` 刚到货的实况，故 L9 放行 `delivered` / `delivering` |
| ⭐ **无归属团长** | 到了确认条件但订单没有归属团长 → 仍转 `completed` 并**收口计佣为 0**（`orphanConfirmed` 计数 + 日志），**不猜、不建号**（同 D35 `skippedReasons` 纪律） |
| ⭐⭐ 4.5 与 **D35 同一执行口** | `CommissionSettleTask.runOnce()` 就是 `CommissionService.settlePending()` —— 与后台「手动触发佣金入账」端点**同一个方法**。不存在第二套入账逻辑，故「跑批入账的数」与「运营点按钮入账的数」结构上不可能不同 |
| ⭐ `pending` 是**常态**、`scanned=0` 不是故障 | 两段式后每天都有 `pending` 待入账。`scanned=0` 只在「当天没有新确认的订单」时出现，**记 log 不记 warn** —— 否则运营每天凌晨被一条假告警吵醒 |
| ⭐ **不做「补计佣」** | 只把**已存在的** `pending` 行入账，不扫描「该计佣却没有佣金行的订单」（`ab_order` 没有确认时刻的团长等级快照 → 只能读**当前**等级 → 晋级后必然多算且无法自证）。《缺陷与陷阱》#51 |
| ⭐⭐ **#52 停职守卫复活** | `collectQuitBlockers` 的「存在未结算佣金则拦截停职」在两段式前**恒不触发**（`pending` 永远为 0）—— 是**死代码**。两段式后 `pending` 天天存在，这条守卫**真正开始运行**（e2e §29 直插 `pending` 钉死）。这正是「**枚举值若永不产生，所有以它为判据的守卫都是死代码**」的兑现 |
| ⭐⭐ 4.7 `reconciliation` 目标日期 = **昨日**（2026-09-17 改正） | 文档原写 `today`。04:00 对「今日」只能核 `00:00–04:00` 这 **4 小时切片**，昨日 23:00 后的流水要等次日才被覆盖 → **每天都漏核一段**。改对「昨日」后核的是**完整自然日**，且 T 日下单窗口（T-1 14:00–23:00）此时已闭合、流水齐全 |
| ⭐ **对账锚 = 支付日** | `reconcile()` 按 `paid_at` 切日（**财务域唯一不指出餐日的端点**，与 D33/D34/D36 刻意偏离）。e2e 用「造一笔支付日落在目标日、出餐日在别的日子」的夹具钉死 |
| ⭐⭐ **不平才写日志，平了不写** | 发现不平 → 落一条 `ab_operation_log`（`module='finance'` / `action='对账不平'` / `target_id=日期`），后台「操作日志」页直接可见、可人工跟进（**零 DDL**，不建对账异常表）。**平的日期不写** —— 否则一年 365 条噪音会把这页淹掉。**幂等**：同一天已有告警行则不重复写（补跑只回报 `alerted=false` + `alertSkippedReason`）。这也是「**不能把告警藏在服务器日志里**」的落实 —— 没人会主动翻服务器日志 |
| ⭐⭐ 告警里**必须**带 caveat | 告警快照含 `caveat`（「仅本地三头核对，**不等于已与微信侧对平**（一期无商户号与账单文件）」）+ `channelSource='local_only'` + `billAvailable=false`。「平不平」只针对**本地三头**，微信侧一期根本没核过（#55）—— 这句话**必须写进告警本身**，不能只写在文档里 |
| ⭐⭐ `monthOrdersOf` 的**双计**（已修） | 月度单量的旧写法 `SUM(CASE WHEN type='reversal' THEN -quantity ELSE quantity END)` 配合 `status` 过滤，会让**退款单先被 `status` 排除、又被 `CASE` 加回**（`reversal` 行 `quantity` 为负、`CASE` 又翻成正）→ 月单**不降反平**，可凭退款刷 C2 晋级。现只数 `type='normal' AND status IN ('pending','settled')`（《缺陷与陷阱》#63） |
| 两个任务的验证方式 | **跑批验收走补跑接口** `POST /admin/schedule/{task}/run` 而非等 cron（`@Cron` 是静态元数据，不受时钟注入影响）；e2e §29 用**隔离日期**（today−208 / −209 / −210，避开 §18–§28 已占偏移）造夹具，跑完全量还原（含 `ab_refund`） |



**M4-3 实现口径（4.9 三消费者 · 4.10 订阅消息投递点 · 「外部通道移出事务」）**

> 落点 `common/queue/`（`queue.service.ts` / `queue.types.ts` / `memory.queue.backend.ts` / `redis.queue.backend.ts`）·
> `queues/`（`queues.module.ts` / `queue-payloads.ts` / `queue-admin.controller.ts` / 三个 `.consumer.ts`）·
> `modules/finance/refund.service.ts`（**事务边界重构**）· `modules/finance/commission.service.ts`（`enqueueSettleNotices` / `notifySettled`）·
> `modules/team-leader/team-leader.service.ts`（`notifyLeaderApplied`）· `modules/message/message-subscribe.service.ts` + `message.controller.ts`（U18）·
> `modules/admin/template/message-template.specs.ts`（`NOTIFY_PAGES` / `subscribeTemplateOf()` / `specState()`）·
> `providers/wx-pay/mock-wx-pay.provider.ts`（失败注入点）· 小程序 `composables/use-subscribe-message.ts` + `api/user.ts` + 两个页面的点击接线。
> 验收 `scripts/e2e-m3.mjs` **§30**（68 条断言 · **不依赖下单窗口**）。
> **零 DDL · 零新增错误码。**

| 项 | 口径 |
| --- | --- |
| ⭐⭐ **外部通道调用必须移出 DB 事务（本批头号改造）** | 原实现把「调微信退款」放在 `dataSource.transaction()` **里面**，失败即抛 `40010` 整笔回滚。它防住了「有退款单没退款」，却留下**更严重且不可自愈**的反面：**微信退款已成功、事务随后失败（冲销报错 / 连接断）** → 钱出去了、系统里**没有退款单、订单也没变**，**账实不符且没有任何机制能发现它**。故拆两段：**事务 A**（纯 DB：冲销 + 退款单 `refunding` + 订单 `refunded`）**先提交** → **事务外**调通道 → 成功走**事务 B** 收口；失败入队重试 |
| ⭐⭐ **`refundNo` 是重试安全的前提** | 它就是微信侧的幂等键（`out_refund_no`）。重试携带**同一个号** → 微信识别为**同一笔**退款 → **不会重复出款**。没有这一条，自动重试就是把「一次失败」放大成「多次退款」 |
| ⭐⭐ **失败时不回滚账务** | 退款单 `failed` **只表示「通道那一段失败」**，账务已按「**已受理**」定稿（订单 `refunded`、余额已退）。回滚会造成用户可见的反复（**余额退回来了又被扣走**）。对外语义因此收窄：不是「什么都没发生、请重试」，而是「**已受理，通道待重试**」——`tips` 必须把这句话讲给运营听（否则运营只会收到一通电话） |
| ⭐ **留空 `wx_refund_no`** | 未受理就**不写**通道单号。写一个假的等于**伪造凭证**，对账时无从分辨「真退了」与「我们以为退了」 |
| ⭐⭐ **死信必须可人工处理** | 重试耗尽（`attempts=3`，语义是「**总共执行 3 次**」，不是「重试 3 次」）→ 队列 `failed` **计数 +1** **且**落一条 `ab_operation_log`（`module='queue'` / `action='任务重试耗尽'`，`target_id` = 队列名、`requestData.payload` 带业务主键如 `refundNo`、快照带**下一步指引**）。⚠️ **只打日志不够**（会随轮转消失）：队列最大的风险不是「失败」而是**静默失效** —— 重试耗尽的含义是「这件事**已经没有人再管了**」。与 M3-15 对账告警**同一张表**（运营会主动去查的那张） |
| ⭐ **入队失败也必须留痕** | 若「微信退款失败」之后**连重试任务都没能入队**（Redis 抖动），这件事就**既不会重试、也不会有人知道** —— 账务已冲销、余额已退回，用户却永远收不到微信那部分钱。故 `enqueueRefundRetry` 失败时**必须**写操作日志（`writeRetryLostLog`），并明确说明「需人工核对该笔退款单后手工重试」 |
| ⭐ **`durable` 如实下发，禁止静默降级** | `QUEUE_DRIVER=memory` → 出参与启动横幅都标 **`durable=false`**（进程内、重启即丢）。`KvService` 那种「连不上就退回内存 + WARN」在队列上**不成立**：缓存丢了只是慢一点，丢一条「退款待重试」**既无报错也无处可查**。故 redis 驱动**连不上拒绝启动**（fail-closed） |
| ⭐ **`failed` 的语义写进出参** | `failed` = **重试耗尽进死信**；中间的重试仍在 `waiting` / `delayed`。不写明，运维会把「**重试中**」读成「**已经放弃**」 |
| ⭐⭐ **订阅消息的载荷必须能寻址到收件人** | `settle-orders` 载荷原为**整批聚合**（`mealDate` / `settledCount` / `totalFen`）。而订阅消息**必须指定收件人**（`userId`）——聚合载荷里没有收件人，消费者只能写一条日志：**「通知了用户」实际没发生，却看起来成功了**。故改为**按 `leaderId` 逐条入队**（独立重试、**死信粒度到人**、并可幂等重跑：`notifyQueued=0`） |
| ⭐ **消费者是薄适配层** | 三个 `.consumer.ts` 只做「注册 + 转发到原服务」（`refund.attemptWxRefund` / `commissions.notifySettled` / …），**业务逻辑仍在原服务里** —— 不在消费者里复制第二份实现，否则「手动执行」与「队列执行」迟早分叉 |
| ⭐ **`attemptWxRefund` 必须自己判断「该不该跑」** | 幂等：单据已 `refunded` → 直接返回（上次其实成功了，只是收口没跑完）；已 `rejected` → **记 WARN 后正常结束**（那是一条**本不该存在**的任务，重试 3 次只是白等 3 次）。纯余额退款（`wxFen<=0`）**没有通道那一段** → 直接收口，不入队 |
| ⭐ **`order-paid` 消费者为何也在册** | 支付后续（如自动回调后的副作用）走队列，使「支付成功」这条主链路与 M4-3 的队列基座对齐。空桶也在 `GET /admin/queue` 里出现 —— 早期调用（健康检查早于消费者注册）不会得到「队列不存在」的错觉 |
| ⭐ **通知一律在事务外** | 三个投递点（`refund_result` / `leader_apply` / `commission_settled`）**全部**在 `dataSource.transaction()` 返回之后调用；且 `notify()` **不抛异常**（所有问题收敛进 `delivered` / `reason`），调用点再兜一层 `try`（**双保险**）。**通知是既成事实的告知**，永远不能把一笔成功的业务变成失败 |
| ⭐ **未启用 = 不投递且不留日志** | 与 M3-12 同口径（`ab_message` 的语义是「**发过什么**」），本批新增的两个投递点**不得开例外**。且「未启用导致 `delivered=false`」**不算任务失败**（不得重试 3 次再进死信）—— 否则真正的故障会淹没在「每天一条假死信」里 |
| ⭐ **`NOTIFY_PAGES` 单一真相 + 机械对账** | 落地页原硬编码 `pages/order/detail`，与 `pages.json` 真实路由 `pages/order-detail/order-detail` **不符** → 投递日志显示成功、微信照发，用户点开落到**不存在的页面**（**微信不校验 `page`、服务端不解析小程序路由 → 四处都不报错**）。现集中到 `NOTIFY_PAGES`，并由 e2e §30 与 `apps/miniprogram/src/pages.json` 做**机械对账** |
| 权限 | 类级 `@Roles('super_admin','admin','operator')` —— **含 `operator`**（运维要能第一时间看到「退款任务在重试」，同 P39 打包任务）；**不含 `finance` / `viewer` / 供应商 / 小程序 token**（`10003`）—— 与 D47–D50 看板（含 `viewer`）**刻意相反**：那边是**业务数据**（只读角色本就该看），这里是**运行态实现细节**（驱动名 / 积压 / 重试参数），给业务观察者看没有用途、只是扩大暴露面。未登录 `10002` |
| 操作日志 | `GET /admin/queue` 是**纯读** → 不标 `@OperationLog`。死信日志与「重试入队失败」日志由服务侧**显式写**（`source='system'`）—— 跑批与队列路径**没有 HTTP 拦截器**（同 M4-1 教训） |
| 错误码 | **零新增**：非法入参沿用 `10001`，退款单/订单不存在沿用既有的 `30010`/`40012` 等 |

**M5-1 实现口径（D61 配送单查看 · D62 人工修正 · 收口挂账 #61 · 零 DDL）**

> 落点：`apps/api-server/src/modules/delivery/`（`delivery.controller.ts` 由空壳实装 + `delivery.service.ts` 新增 `listByDate` / `patch` / `aggregateOrderQuantity`）· DTO `modules/delivery/dto/delivery.dto.ts`
> 页面 `apps/admin-web/src/views/order/delivery.vue`（菜单 key `/order/delivery`）· 契约载体 **新增** `packages/shared-types/src/enums/delivery-status.ts`
> 验收 `scripts/e2e-m3.mjs` **§32**（22 条断言 · **不依赖下单窗口**）。

| 项 | 口径 |
| --- | --- |
| ⭐⭐ 为什么需要 D62（《缺陷与陷阱》#61） | 跑批对已存在的 `(meal_date, building_group_id)` 行**跳过不覆盖**（保护人工录入的司机 / 车牌），代价是 `total_quantity` **也被一起冻住** —— 截单跑晚或补跑改过份数后，表里的份数与实际要送的对不上，而**此前没有任何页面能改**（`DeliveryController` 是空壳，口子只在 DBA 手里）。D62 把它收回运营后台。 |
| ⭐⭐ 份数不符 **≠** 被人改过 | `quantityMismatch` 只表示「配送单份数 ≠ 按订单算出的份数」，成因有两种：① 有人走 D62 修正过；② 截单之后订单侧发生退款 / 取消（配送单份数在截单时已定格、**不会跟着降**）。系统**无法从数字本身区分**这两者，故只如实标差异 + 给出排查入口（`ab_operation_log` 按 `module='delivery'` + 单 id 查），**不假装知道**（同 #55「让系统如实说我没做那一步」）。 |
| ⭐ `hasManualInput` 是**可靠**标记 | 司机 / 电话 / 车牌 / 备注四列**跑批从不写**（`generateByDate` 只写 `meal_date` / `building_group_id` / `expected_at` / `total_quantity` / `status`），故「有值 ⇔ 有人手工填过」。它与 `quantityMismatch`（有歧义）**刻意分开**，不能相互替代。 |
| ⭐⭐ `version` 乐观锁**必填** | 两个运营先后改同一张单（A 改份数 / B 改司机），后写者用**旧快照**会把前者的修改一起覆盖回去，且**双方都不报错**，直到装错货。故提交必带 `version`，服务端 CAS（`WHERE id = ? AND version = ?`）不匹配 → `30016` + 出参 `data.current`（当前值与版本，端上刷新后重提）。⚠️ 前置校验与实际写入之间仍有窗口，故写入时再带一次 `version` 条件。 |
| ⭐⭐ 出参带 **before / after 双侧快照** | D62 出参 `{before, after, changed, unchanged, version, quantityDiff, orderQuantity}` —— 它随响应体被 `OperationLogInterceptor` **整体落库**（该拦截器的 `snapshot` 列只写 `{operator, role, at}`、**不含 diff**；真正的 diff 载体是 `response_data`），故**不需要新表、不需要改拦截器**即可回放「5 → 3、司机空 → 张三」。 |
| ⭐ `reason` 必填且**不写进 `remark`** | 份数「5 → 3」必须能回答为什么。`reason` 只随请求体进 `ab_operation_log.request_data`；`remark` 是**给配送员看的**备注，混入审计原因会污染。二者职责分离，不合并。 |
| ⭐ 空改动**不写库** | 提交了但与现值相同的字段进 `unchanged[]` 且**不写库**；全部相同则连 `version` 都不推进（与 D58 同纪律）—— 否则审计链上会充满什么都没改的假记录，真正有意义的变更被淹掉。 |
| ⭐ 传**空串 = 清空** | `driverName` / `driverPhone` / `plateNo` / `remark` 传 `''` → 存 `null`（而非空串）；**未提交的字段原样保留**（未提交 = 不动，而非清空）。清不掉会留下一个「看着有司机、其实已取消叫车」的幽灵记录。 |
| ⭐ 份数聚合**单一口径** | 跑批生成（4.3）与 D61 的「订单份数」对比**共用** `aggregateOrderQuantity()` —— 两处各写一遍 SQL 的话，改口径只改一处就会出现「生成的份数」与「页面显示的应送份数」不一致，而**两边都不报错**。对比一律用**全量**聚合（不受 `status` / `buildingGroupId` 筛选影响，否则筛一下差异就成了无意义的数）。 |
| ⭐ 只改五项 · **不动 `status`** | 份数 / 司机 / 电话 / 车牌 / 备注。配送状态是履约流转（`called` → `en_route` → `arrived`），有它自己的时点与责任 —— 把状态塞进「人工修正」会让「改数字」与「推进履约」混成同一个动作，审计上分不清。 |
| ⭐ 无 `POST` / 无 `DELETE` | 不手工建单（手工建会绕过截单定格的份数口径，造出一张与订单脱钩的单）；不删单（删掉会让当日配送链缺一个楼群且**无任何痕迹**）—— 份数改成 `0` 才是「这个楼群今天不送」的正确表达。 |
| 状态枚举**由服务端下发** | `statusText` + `statusOptions`（4 态按**履约顺序**而非字典序）随出参下发，端上不维护第二份映射（与 D49 / D57 同纪律）。⚠️ 同批**收敛**了原先在两处逐字重复的 `DELIVERY_STATUS_TEXT`（`order/leader-order.service.ts` 与 `team-leader/workbench.service.ts`）到 `@abox/shared-types` 的 `DeliveryStatus` / `DELIVERY_STATUS_LABEL`（#67 家族「同一枚举多处字面量」；不收敛，本次新建的后台页就会是**第三份**）。 |
| 权限（两级） | 类级 `@Roles('super_admin','admin','operator')` —— **含 `operator`**（配送是运营日常作业：要叫车、要填司机车牌）；**不含 `viewer`**（配送单含运力安排与司机电话，与 D47–D50 刻意含 viewer 正相反）、**不含 `finance`**（菜单矩阵里财务没有这一页；API 放行而菜单没有 = 能调但进不去）。 |
| 操作日志 | `@OperationLog({ module:'delivery', action:'修正配送单', targetParam:'id' })` —— **写操作才记**（`GET` 列表不标，否则刷新一次就把日志表刷爆，真正要查的「谁改了份数」反被冲掉）；**失败的请求也记**（`30016` 冲突同样留痕，审计要回答「谁试图做了什么但被拒」）。 |
| 菜单与白名单**同源** | `/order/delivery` 同时进 `ADMIN_MENU_KEYS` + `ADMIN_NAV` + `routes.ts` —— 少一处该菜单对所有人消失（前端静默过滤）。 |
| 错误码 | 新增 **`30016` `DELIVERY_CONFLICT`**（乐观锁冲突 · **带 `data.current`**）· **`30017` `DELIVERY_NOT_FOUND`**（目标 id 非法）；入参闸门（`reason` 缺失/太短 · `version` 缺失 · 份数负数/超 9999）一律 `10001`。**零 DDL**（`ab_delivery_record.version` 列早已存在）。 |

**M5-8 实现口径（D63 配送单状态推进 · 履约链 T7/T8/T9 补实现 · 收口缺陷 #79 · 零 DDL）**

| 项 | 口径 |
| --- | --- |
| ⭐⭐ 为什么需要 D63（《缺陷与陷阱》#79） | `ab_order` 的 `cooked` / `delivering` / `delivered` **三个状态全仓零写入点** —— 订单支付后永远停在 `cut_off`，团长「确认取餐」永远返回零值（**且不报错**），**佣金永不产生**，自动确认跑批每天把当天全部订单报成「履约异常」。而当时 **19 道门禁 + 969 条 e2e 全绿**：`e2e` 夹具**直接 `UPDATE ab_order SET status='delivered'`** 造数据，测试永远从链路**中间**开始，上游那次状态推进有没有实现**它看不见**。补实现后：T7 的写入点在 `SupplierService.advanceOrdersToCooked`（供应商出餐确认的事务内），T8/T9 的唯一写入点即 D63。 |
| ⭐⭐「改数字」与「推进履约」**刻意分成两个端点** | D62（`PUT /admin/deliveries/{id}`）从 M5-1 起就把 `status` 挡在外面（状态有它自己的时点与责任），M5-8 才补 D63（`PATCH /admin/deliveries/{id}/status`）。合成一个端点会让「份数 5→3 顺便把状态也推了」变成**一条记录两件事**，审计上分不清责任。 |
| ⭐⭐ 订单联动是「**尽力而为 + 如实报告**」而非「要么全成要么全败」 | 物理世界不会因为系统里订单状态不对就不发车。故**不做**「订单必须都在 `cooked`」的前置校验（那会把运营卡在门口，然后绕过系统直接打电话，系统失去记录）。能推的推（逐单条件更新），推不动的如实计入 `orderTransition.remaining`（哪个状态还有几单）并给一句能照着排查的 `note`。⚠️ **这不是静默跳过**：数字与话都在出参里，且订单停在 `cut_off` 会在 T 日 14:00 的 `auto-confirm` 里计入 `notDelivered`（fail-closed 的告警出口）。 |
| ⭐⭐ 两段迁移**各写一个具名方法** | `advanceGroupOrdersToDelivering` / `...ToDelivered` 各自返回自述的 `from → to`，**不另立映射表**（#15/#63/#67/#76 全是「同一件事有两份表述」）。⚠️ 更关键的是**可静态对账性**：写成 `set({ status: dto.to })` 更短，但那样两处订单写入点在门禁 `state:audit` 的静态扫描下都是「动态值 · 判不出来」—— 等于亲手把 #79 逃过全部门禁的那个盲区**重新打开一次**。 |
| ⭐ `called`（已叫车）**不动订单** | 「已叫车」只是运力安排，货还在加工场所。订单要到「配送中」（货拉拉发出）才推进。出参 `orderTransition=null` 且 `note` **写明「这不是漏了联动」** —— 否则运营会把它读成一个 bug。 |
| ⭐ D61 列表新增 `orderStatusBreakdown` | 配送单状态与订单状态是**两条链**（T8/T9 才把它们接上）。只看配送单的「在途」，运营无法知道这批货对应的订单有没有跟上 —— 而「没跟上」的表现是订单永远停在 `cut_off`、佣金永不产生、**且不报任何错**（#79）。摆在每一行上，「有几单没跟上」就从「一个看不见的洞」变成「列表里的一行」。口径与 `orderQuantity` **同源**（同一份 `WHERE`，只多一列分组键 `status`），两项相加必然相等。 |
| ⭐ T9 的「取餐通知」**不在本方法里发** | 状态机 T9 的副作用列写着「订阅消息：取餐通知（团长）」，但场景 `leader_delivery` 一期渠道**只有微信群**（`message-template.specs.ts` 里 `wiring='pending'`，理由是原型原文「初期采用微信群人工通知兜底」）。往 `wechat_group` 场景调 `MessageService.notify()` 会被它自己判为「无程序投递点」而跳过 —— 加一个必然跳过的调用点，只会让接线状态变成**假的 `live`**。故出参 `note` 明确写「需运营按模板文案人工发群」，订阅消息渠道属二期（缺微信模板 ID）。 |
| D63 四道闸门 | ① **存在性** → `30017`；② **乐观锁前置** → `30016`（附 `current`）；③ **单向 + 单步** → `30018`（附 `allowed`；回退 / 跳级 / 原地一律拒，`allowed` **只含紧邻的下一态**，终态则 `[]`）；④ **CAS 写入**（前置校验与写入之间仍有窗口，写入时再带一次 `version`，`affected=0` → `30016`）。顺序不可调换：先判「有没有」，再判「是不是你的版本」，最后判「能不能这么走」。 |
| ⭐⭐ 为什么闸门③要「**一次只能一步**」而不是「只能向前」 | 放走跳级的代价不是「少点两次按钮」，而是**静默跳过订单联动**：`pending → arrived` 一步到底时只跑 T9，而 T9 的条件更新是 `delivering → delivered` —— 订单此刻还在 `cooked` ⇒ 条件不命中 ⇒ **一单都不会动、且不报任何错**，订单永远停在 `cooked`。**这正是 #79 的形状**（写入点缺失 ⇒ 静默卡死），不能在刚补好它的同一批里重开一次。要补记物理上已发生的过程，正确做法是**逐步补按**（每步各留一条日志、各联动一次订单）。（⚠️ 本处是**实现自查出的第二处漂移**：注释与文档都写着「跳级一律拒」，而 `slice(fromIdx+1)` 实际是放行的 —— 同族「同一件事有两份表述，不被执行的那份必然是错的」。） |
| ⭐ 后台入口（D63 不能只有接口） | `admin-web/src/views/order/delivery.vue` 每行新增「**推进到 X**」按钮（X 取**紧邻下一态**，终态置灰并给 tooltip）+ 确认弹窗（可填补充说明；**本楼群仍有 `cut_off` 订单时显式警示**「出餐未确认，推进不会带着它们走」）；出参把「配送单 → X」与「联动订单 N 单」写进**同一句提示**，`advanced=0` 时**另发一条 warning**。另新增「订单进度」列（`orderStatusBreakdown` chips，`cut_off` 高亮）。⚠️ 状态顺序与中文名**全部取自服务端下发的 `statusOptions`**，端上不写第二份 `['pending','called','en_route','arrived']`。**为什么这不算「顺便做的前端」**：只有接口没有入口，等于「能力存在但无人能到达」—— 与 #79 同一族，交付给测试人的清单里那几步依旧会失败。 |
| 权限与日志 | 类级 `@Roles('super_admin','admin','operator')`（与 D61/D62 同）；`@Idempotent({ scope:'delivery-status', required:false })` + `@OperationLog({ module:'delivery', action:'推进配送状态', targetParam:'id' })`；每次**订单**迁移另落一条 `module='order'`（`出餐推进` / `发车推进` / `送达推进` / `自动确认收货`）。 |
| 错误码 | 新增 **`30018` `DELIVERY_STATUS_ILLEGAL`**（配送单状态推进非法 · **带 `data.allowed`**）。⚠️ **刻意不复用 `30016`** —— 两者形态相似（都是「这次写入没落」），但**排查入口完全不同**：`30016` 说「别人改过了，刷新重提即可」，`30018` 说「这个动作本身就不该发生」（回退 / 原地）；合并会让「刷新重试」这条建议被误用到**重试一万次也不会成功**的请求上。**零 DDL**（`version` / `actual_at` 列早已存在，前者 M5-1 起启用）。 |
| 门禁（本批的防复发装置） | `gate.mjs state:audit`（M5-7 新增 · M5-8 收紧）机械比对「**状态机声明的迁移目标** ↔ **生产代码真的写过的状态**」。M5-7 建表时有 4 条豁免（`cooked`/`delivering`/`delivered` + `refunding`）；本批补实现前三条、删掉第四条那条**不可达边**后**豁免归零**，并新增**规则④「不可达态必须显式登记」**（`ORDER_RESERVED_STATUSES`）。⚠️ 该门禁的「绿」在被**反证测试**打红过之前**不构成证据** —— 本轮 5/5 探针按预期报出（删写入点 / 恢复旧边 / 取消保留态 / 塞孤儿态 / 把判定函数改恒空，分别被规则①②③④与自证④抓住）。 |
| e2e | 新增 **§35 · 27 条断言 · 全链路**（U6 下单 → mock 支付 → 截单 → 配送单生成 → 供应商出餐确认 T7 → D63 已叫车 → 配送中 T8 → 已送达 T9 → 自动确认 T11 → 佣金入账 4.5）+ **跳级闸门断言**（`called → arrived` → `30018` 且 `allowed` 恰好 `["en_route"]`）。⭐ **除「其余三家供应商已送达」这一处夹具外，订单的每一次状态变化都来自真实 HTTP** —— 这正是 #79 的处置意见所要求的：「凡是用「直插某状态」造数据的套件，都必须额外有一条走完整链路的用例」。m3 断言 **980 → 1007**。 |


---

### 6.9 队列观测（M4-3 · 运行态可见性）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| **Q1** | GET | **`/admin/queue`** | **队列状态**：驱动名 + `durable` + 每队列五项计数 + 运行参数（`attempts` / `backoffBaseMs`） |

**Q1 出参形态**：`{ driver, durable, note, attempts, backoffBaseMs, queues: [{ name, label, waiting, active, completed, failed, delayed }] }`。

| 项 | 口径 |
| --- | --- |
| ⭐ 为什么要把「实现细节」暴露给运营 | 队列的直接收益（「退款失败会自动重试」）**对运营是不可见的** —— 不暴露，运营遇到「用户说没收到退款」时**无从判断系统正在处理还是已经放弃**。这三项（驱动 / 积压 / 重试参数）恰好回答那个问题 |
| ⭐ `durable` 必须如实 | memory 驱动 `durable=false` + `note` 讲清楚「**进程重启即丢**」—— M4-3 **刻意不做静默降级**（理由见上表） |
| 空桶也在册 | 三个队列**恒在列表里**（含计数为 0 的），否则「队列不见了」与「队列为空」两种状态无法区分 |

---

## 七、回调与探针

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| W1 | POST | `/pay/notify` | 微信支付结果通知（V3，验签 + 解密） |
| W2 | POST | `/pay/refund-notify` | 退款结果通知 |
| W3 | POST | `/pay/transfer-notify` | **佣金打款结果回执**（灵活用工平台代发结果；一期由运营登记，二期接平台回调） |
| W4 | GET | `/health` | **存活探针（liveness）** —— 进程还能应答即 `200 / code 0`，**刻意不检任何依赖**；编排器据此判「要不要重启」 |
| W5 | GET | `/health/ready` | **就绪探针（readiness）** —— 检**数据库连通**（`SELECT 1`）+ **3 个队列消费者是否齐备**；编排器据此判「要不要给流量」。未就绪 → **HTTP 503** + `code 90002`（响应体含 `checks`），出参回显 `version` / `uptimeSec`（灰度 / 回滚判据） |

> ⭐ **两条探针必须分开**（M5-0 · 《缺陷与陷阱》#75）：若把 liveness 也做成「检 DB」，则 DB 一抖动 → 探针全红 → 编排器**重启所有容器** → 重启期间没人服务、DB 压力更大 → **重启风暴**（而 DB 挂了重启应用根本治不好）；若只保留「不检依赖」的那条当 readiness，则**摘不掉流量**。
> ⭐ **readiness 检「消费者齐不齐」而不是「Redis 通不通」**：Redis / DB 连通性在**启动期已 fail-closed 验过**（连不上即拒绝启动）；而「消费者没注册上」是**启动期验不到、失败后完全静默**的一类故障 —— 入队照常成功、`GET /admin/queue` 计数照常显示，但任务**永远无人消费**。
> ⚠️ **`/health` 的出参契约不可改**（`{status:'ok',service:'abox-api',ts}`）：三个 e2e 套件的 `waitHealthy()` 都以 `HTTP 200 && body.code === 0` 判定「服务已起」，改出参 = 三套件全红。新增能力一律走新端点。
> ⚠️ **原 W4 描述的「DB / Redis / 微信连通性」与实现不符**（实现从不检依赖；微信侧无商户号与证书，一期也无法检通）—— M5-0 已按实现纠偏，并把「检依赖」的职责交给 W5。**「文档说检、代码不检」正是 `#75` 的成因**，故此处以代码为准回写。

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
| P21/P22 | 商家工作台/出餐 | M21 | S1/S2（**S3 已 M4-0 迁 P39**） | `ab_supplier_dish_daily`、`ab_meal_assignment` |
| P23/P24 | 菜品/上架申请 | M22 | S4–S7 | `ab_dish`、`ab_supplier` |
| P25/P26 | 结算/资料 | M23/M24 | S9–S14 | `ab_supplier_share`、`ab_supplier` |
| P27/P28/P29 | 套餐矩阵/新建/模板 | M31 | D1–D7 | `ab_meal_assignment`、`ab_set_meal` |
| P30/P31 | 订单中心/详情 | M32 | D8–D12 | `ab_order`、`ab_operation_log` |
| P32 | 团长管理 | M33 | D19–D22 | `ab_team_leader`、`ab_leader_invite` |
| P33 | 供应商管理 | M34 | D23–D32 | `ab_supplier`、`ab_distribution_center` |
| P34 | 财务结算 | M35 | D33–D46（**已实装** D33–D35 资金总览/佣金/佣金入账（M3-13）· D36/D37 应付结算 · **D38–D39 余额账户管理与调整（M3-14）** · D40–D42 退款审批；**D43 微信对账 / D44 发票管理（M3-15）** · **D45 提现审批列表 + D46/D46a/D46b/D46c 四动作（M4-4）**） | `ab_commission`、`ab_supplier_share`、`ab_refund`、**`ab_balance`、`ab_balance_log`、`ab_withdraw`** |
| P35 | 数据看板 | M36 | D47–D50（**已实装**） | 聚合查询 |
| P36 | 系统配置 | M37 | D51–D60（**已实装**） | `ab_admin_user`、`ab_operation_log`、`ab_config`、`ab_message`、**`ab_message_template`** |
| P37 | 办公楼管理 | M33 | D13–D18 | `ab_building`、`ab_building_group` |
| P39 | 加工场所打包 | M21-03 | `GET /admin/packing-tasks`（**M4-0 由 S3 迁入**） | `ab_supplier_dish_center_daily`、`ab_distribution_center` |

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
| **30016** | 该配送单已被他人修改，请刷新后重试 | D62 `version` 乐观锁冲突（**扩展**）· 出参 `data.current` 带当前值与版本 —— 不拦就会「后写覆盖前写」且双方都不报错 | 409 |
| **30017** | 配送单不存在 | D62 目标 id 非法（**扩展**）—— 与 30010/40012 同族：每张单有自己的排查入口 | 404 |
| **30018** | 配送单当前状态不支持该推进（履约流只能向前） | D63 状态推进非法（**扩展**）· 出参 `data.allowed` 给出当前可推进到的状态 —— **刻意不复用 30016**：30016 是「刷新重提即可」，30018 是「这个动作本身不该发生」，合并会让重试建议被误用到重试一万次也不会成功的请求上 | 409 |
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
| **40016** | 提现单不存在 | D45/D46 系列目标 id 非法 —— 与 `10004` **刻意分开**：`10004` 里还含着「在库但无权访问」，而这里是「这张单压根不在库里」，拿到码就知道该去 D45 找（**扩展**） | 404 |
| **40017** | 提现单当前状态不支持该操作 | D46 系列非允许态（如对已到账的单再批准、对已驳回的单点到账）—— 每次误操作的后果都是**再动一次钱**，故显式拒绝并回带 `data.allowed`。⚠️ **不复用 `40013`**：形态相同但**排查入口不同**（退款单去 D40 看、提现单去 D45 看）（**扩展**） | 409 |
| **50001** | 供应商资质未通过审核 | 出餐前置校验（S2 · D26 `audit_status != approved` 或证照过期）（**扩展**） | 403 |
| **50002** | 集散中心配置不可删除（存在历史结算） | 软删保护（D32 两道前置：历史应付 / 被分配引用）（**扩展**） | 409 |
| **50003** | 结算等式不闭合 | C9 校验：售价 ≠ 供价 + 场地费 + 打包人工 + 配送费 + 佣金 + 平台毛利（**扩展**） | 409 |
| **50004** | 可提现余额不足 | 提现申请超出可用余额（L12） | 409 |
| **50005** | 出款通道异常 | C11 灵活用工平台（`PayoutChannel`）异常（**扩展**） | 502 |
| **50006** | 供应商不存在或已停用 | D23/D25–D28（**扩展**） | 404 |
| **50007** | 集散中心不存在或已停用 | D31/D32（**扩展**） | 404 |
| **50008** | ~~供应商类型与集散中心冲突~~ | ⚠️ **2026-09-16 M4-0 停用**（号位保留 · 不再使用）：判据依赖的 `ab_supplier.type` 已停用，D27 路由删除、D30/D31 不再收 `supplierId` —— 触发条件已不存在 | — |
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

> **扩展码**：`20006` / `20007` / `20008` / `20009` / `20010` / `20011` / `20012` / `20013` / `30008` / `30009` / `30010` / `30011` / `30012` / `30013` / `30014` / `30015` / `30016` / `30017` / `30018` / `40009` / `40010` / `40011` / `40012` / `40013` / `40014` / `40015` / `40016` / `40017` / `50003` / `50005` / `50006` / `50007` / `50008` / `50009` / `50010` / `50011` / `50012` / `50013` / `60001` / `60002` / `60003` / `60004` / `60005` 号段内文档原未列、但工程实现需要，已按「号段末尾登记」规则回写本表（见 `apps/api-server/src/common/constants/error-code.ts` 头部纪律）。**禁止挪用文档已占用的号位。**

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

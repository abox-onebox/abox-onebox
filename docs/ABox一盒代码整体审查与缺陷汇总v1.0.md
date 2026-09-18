# ABox 一盒 · 代码整体审查与缺陷汇总 v1.0

> 审查日期：2026-09-18 ｜ 基线：`70030ca`（远端 main 一致 ｜ 门禁 19/19 全绿 ｜ e2e m1 45 / m2 126 / m3 969）
> 审查方式：**5 域并发只读深审 + 逐条代码级复核**（不采信未复核的推断）
> 定位：**正式人工测试前的最后一轮静态审计**。目的不是「证明代码没问题」，而是**把人工测试的时间花在只有人能验的地方**。

---

## 〇、先说结论

**门禁全绿、e2e 969 条全绿，但这两件事都不能证明系统能跑通一条真实业务。**

本轮最重要的发现是 **1 条 P0 级功能断裂**，它**不在任何文档、缺陷账本或门禁的视野内**，且 **e2e 的绿色恰恰掩盖了它**：

> ⛔ **订单履约链 T7–T9 在 `ab_order` 上完全没有实现** —— `cooked` / `delivering` / `delivered` 三个状态**全仓零写入点**。订单支付后永远停在 `cut_off`；团长「确认取餐」永远返回空；**佣金永远不会产生**；自动确认跑批每天把当天所有订单报成「履约异常」。

e2e 之所以全绿：夹具**直接 `UPDATE ab_order SET status='delivered'`** 造数据（`scripts/e2e-m3.mjs:1821`、`:6282`、`:9517`），测的是**下游逻辑**，而**上游那次状态推进没有任何实现**。这是「机械证据全绿、真实链路是断的」的教科书案例 —— 与缺陷账本 #67 同族，但 **#67 是跨端字面量写错，#79 是整段逻辑缺席**。

**在裁决这条之前，任何人工测试跑到「取餐 → 佣金 → 结算」环节都必然全红。** 建议先读 §三.1。

---

## 一、审查范围与手法

| 域 | 覆盖对象 | 规模 |
| --- | --- | --- |
| A 资金链 | `modules/finance/**` + `order.service` 资金副作用段 | 21 文件 / 8.1K 行 |
| B 订单履约供应链 | `order` `meal` `delivery` `building` `supplier` `distribution-center` `traceability` | 51 文件 / 15.5K 行 |
| C 认证授权安全 | `common/security` `guards` `decorators` `middleware` `auth` `admin` + 前端请求层 | ~40 文件 |
| D 任务队列驱动资源 | `tasks` `queues` `common/queue` `providers` `config` `main/app.module` `health` | ~35 文件 |
| E 数据层与前端 | `database/**`（实体/迁移/种子/两道对账）+ `admin-web` + `miniprogram` + `packages/*` | 152 文件 / 36K 行 |

手法：机械穷举（写入点、调用点、装饰器声明、KV 写点）为主，读代码判语义为辅；**每一条 P0/P1 都由主审逐行复核过**，未复核的推断一律降级为「疑似」或剔除。

---

## 二、发现总览

| # | 级别 | 一句话 | 位置 |
| --- | --- | --- | --- |
| 1 | **P0** | 履约态 `cooked/delivering/delivered` 全仓零写入 → 订单卡死、**佣金永不产生** | `order-state-machine.ts:11-14` vs 全仓 |
| 2 | **P1** | 退款执行无原子占位 + 每次生成新 `out_refund_no` → **真双付**；后台还不发幂等键 | `refund.service.ts:291`/`:411`/`:610` |
| 3 | **P1** | 余额三处写点漏 `version` 校验（读-改-写覆盖） | `reversal.service.ts:114`/`:297`、`commission.service.ts:648` |
| 4 | **P1** | 无余额账户时静默跳过退款，但出参仍报「余额已退」 | `reversal.service.ts:104`、`refund.service.ts:617` |
| 5 | **P1** | `seed` 生产误清全库只靠 `NODE_ENV` 单点防护（清 **27** 张表） | `seeds/seed.ts:38`/`:52` |
| 6 | **P1** | `JWT_SECRET` 有硬编码兜底，且**门禁正则把它豁免了** | `config/app.config.ts:85`、`security-scan.ts:82` |
| 7 | P2 | `cors: true` 无白名单 + 无 helmet + 后台 token 存 localStorage | `main.ts:19` |
| 8 | P2 | `/pay/mock/paid` 是 `@Public()`，无「生产禁 mock」硬闸 | `payment.controller.ts:64` |
| 9 | P2 | 订阅消息生产**永远是 mock**（无 Real 实现，目录只有 1 个文件） | `providers/providers.module.ts:52` |
| 10 | P2 | 微信支付 real 通道是 `notReady()` 桩（回调验签未实装） | `real-wx-pay.provider.ts:51` |
| 11 | P2 | `TASKS_ENABLED` 是**死配置**（定义后全仓无读取点） | `config/app.config.ts:48`/`:97` |
| 12 | P2 | 后台与共享包**两套口径**（售价/佣金率各写一份） | `admin-web/src/constants/index.ts:2` |
| 13 | P2 | DB 配置 `commission.rate.*` 可编辑但不参与计算（死配置） | `biz-config.service.ts:168` |
| 14 | P2 | `schema:parity` 剥掉 UNSIGNED 与长度/精度 → 第三类漂移必漏报 | `schema-parity.ts:77` |
| 15 | P2 | `ab_refund` 无 `(order_id,status)` 唯一约束（#2 的结构前提） | `order.entity.ts:219` |
| 16 | P2 | 永续增长表（操作日志等）无归档/清理任务 | `tasks/`（无相关任务） |
| 17 | P3 | `canTransit()` 全仓零调用 → 状态机是纯声明，可被任意直写 | `order-state-machine.ts:40` |
| 18 | P3 | `traceability` 模块 3 文件×5 行全空壳；集散中心服务为空壳 | 见 §三.18 |
| 19 | P3 | `data-source.ts:64` CLI 默认密码 `root123`、无连接池上限（仅本地） | `data-source.ts:64` |
| 20 | P3 | Redis 失联时 KvService **静默**降级内存（多实例下锁/幂等/限流瞬时退化） | `kv.service.ts:46`/`:84` |
| 21 | P3 | 内存队列在途任务不在关闭时 await（Redis 侧已正确等待） | `memory.queue.backend.ts` |

---

## 三、逐条详情

### 1 ⛔【P0】履约状态链 T7–T9 完全没有实现 —— 订单卡死 + 佣金永不产生

**位置与证据链（全部为机械穷举结果）**

| 环节 | 文档要求 | 代码实际 |
| --- | --- | --- |
| T7 `cut_off → cooked` | 供应商出餐确认 | `supplier.service.ts` `cookConfirm` 只写 `ab_supplier_dish_daily.status='confirmed'`（`:307`/`:318`），**不碰 `ab_order`** |
| T8 `cooked → delivering` | 运营标记 / 配送单驱动 | `delivery.service.ts:240` **只读** `status=CUT_OFF` 生成配送单；`:222` 写的是 `ab_delivery_record.status='pending'`，**不碰 `ab_order`** |
| T9 `delivering → delivered` | 运营标记 11:30 送达 | 无任何写入点 |
| T10 `delivered → completed`（团长 L9） | 团长确认取餐 | `leader-order.service.ts:238-240` 要求 `status IN (delivering, delivered)` |
| T11 `delivered → completed`（兜底跑批） | T 日 14:00 自动确认 | `order.service.ts:816` 要求 `status = delivered` |

**全仓 `ab_order.status` 的写入点穷举结果**（唯一 8 处）：
`pending_pay`（`order.service.ts:266`）· `paid`（`:1090`）· `cancelled`（`:493`/`:517`/`:638`）· `cut_off`（`:701`）· `refund_applying`（`refund.service.ts:206`）· `refunded`（`refund.service.ts:637`）· `completed`（`leader-order.service.ts:265`、`order.service.ts:857`/`:932`）

→ **`cooked` / `delivering` / `delivered` 一次都没被写入过。**

**后果（这就是为什么必须知道它）**

1. 用户端 U10 时间线**永远停在「待出餐」**（`STATUS_PROGRESS` 停在 2），后面 4 个节点永不点亮。
2. 团长 L9「一键确认取餐」**永远返回零值**（`repeated: true` / `confirmedCount: 0` / `tips:'没有待确认的订单'`）—— 而且它是**幂等友好地**返回零值，**不报错**，看起来像「今天没单」。
3. **佣金永远不产生**：`accrueForOrders` 只有两个调用点（`leader-order.service.ts:273`、`order.service.ts:885`），**两个都在上述不可达分支里**。→ 结算跑批 `settlePending` 天天扫到 0、团长余额永不增加、晋级月单数永不增长。
4. 自动确认兜底跑批（T 日 14:00）**每天都把当天全部订单报成「履约异常」**（`NOT_DELIVERED_STATUSES`），把真实异常淹没在假告警里。
5. 供应商侧 `S2 出餐确认` **是做了的**（写生产计划、出应付单）→ 形成「两头都在动、中间那一段没接上」的错觉，更难排查。

**为什么能活到今天**：① 文档自身有歧义 —— 《状态机》T7 的「副作用」列只写「写 `ab_supplier_dish_daily.produced_at` + 订阅消息」，**没明写要改 `ab_order.status`**；② e2e 夹具直写 DB 造 `delivered` 单，**测试永远从链路的中间开始**；③ 没有任何门禁检查「状态机声明 ↔ 生产写入点」（`canTransit` 是死代码，见 #17）。

**修复建议（三选一，**这是产品范围裁决，不是纯代码问题**）**

- **① 补实现（推荐）**：`cookConfirm` 事务内追加 `UPDATE ab_order SET status='cooked' WHERE mealDate=? AND status='cut_off'`（按 `mealDate` 批量，条件更新天然幂等）；配送单状态推进时同步 `cooked → delivering`；后台补一个「标记送达」动作做 `delivering → delivered`（D8/D9 在文档里本就有位置，当前缺失）。
- **② 本期不上履约**：把 L9 与 T11 的准入条件从 `delivered/delivering` 放宽到 `cut_off`（并在文档同步「本期以截单为履约终点」）。**代价**：退款分支 T12 的准入态集合要跟着改。
- **③ 维持现状但如实登记**：在《状态机》与内部测试清单里写明「T7–T9 未实装、相关测试项跳过」，并给 `GET /admin/schedule` 或健康页一个可见标记。

**给人工测试的直接动作**：在裁决前，测试清单里 **U10 订单时间线 / L9 确认取餐 / 团长佣金 / 提现前置条件 / 结算跑批** 这 5 组步骤**必须先标注「依赖 #1 修复」**，否则测试者会全部报成 P0 并浪费一轮。

**验证方式**：`grep -rn "status = 'cooked'\|OrderStatus.COOKED," apps/api-server/src` 应能命中写入点；或走一遍「下单 → 支付 → 截单跑批 → 供应商出餐确认 → 查订单状态」的真实 HTTP 链路。

---

### 2 【P1】退款执行没有「原子占位」，且每次调用生成新的微信幂等单号 → 真双付

**位置**：`refund.service.ts:291-294`（D11 强制退款的重复检查是 `findOne` + 抛错）· `:411-427`（D42 审批通过同样是 `findOne` + `status` 判）· `:610-646`（`settleRefundDb` 对**退款单行本身无任何 claim**，订单收口 `.where('id = :id')` 也无状态条件）

**关键放大器**：`genRefundNo()` 在每次调用时生成**新的退款单号**（`:183`/`:307`），而它**就是微信侧的幂等键 `out_refund_no`**（`:58` 注释自述）。→ 两次并发审批产生**两个不同的 `out_refund_no`** → **微信不会去重，会真的退两次**。

**叠加因子**：后台请求层**不注入 `Idempotency-Key`**（`admin-web/src/api/request.ts:46` 只注入 `Authorization`），而这些写端点**也没标 `@Idempotent`**（`finance-admin.controller.ts:131/285/311/337/365`、`order-admin.controller.ts:81/109`；全文件只有 `balances/adjust`:180 标了）。而 `@Idempotent` 的 `required` **缺省是 true**（`idempotent.decorator.ts:13`）—— 也就是说**后台资金端点既没有声明幂等保护，也没有前端幂等键**，只剩「后端读一次状态再写」这一层。

**触发条件**：两次审批请求在同一瞬间到达（双击、两名运营同时操作、或网络重试）。

**影响范围**：同一订单 `ab_refund` 落两行 → 余额退回两次 + 佣金冲销两次 + 通道退款两次 → **真金白银双付**；且对账查不出来（因为余额流水本身也被写了两条）。

**修复建议**：在 `settleRefundDb` 入口对**退款单行**做一次原子占位 —— `UPDATE ab_refund SET status='refunding' WHERE id=? AND status IN ('applying','approved')`，`affected=0` 即早返回既有结果。**一处占位同时覆盖余额/佣金/通道三段**（这正是账本 #77 里给的同一修法，只是占位对象要从「订单」上移到「退款单」）。同时给 `order-admin.controller.ts:109` 与 `finance-admin.controller.ts:285` 补 `@Idempotent`。

**置信度**：已确认（代码形态）。**本地不可复现** —— `better-sqlite3` 单连接会把两个事务串行化。须真机 MySQL。

---

### 3 【P1】余额有三处写点漏掉 `version` 校验 —— 并发下丢更新

**位置**（都是「读 `balance` → JS 里加减 → `UPDATE … WHERE id=:id`」，`version` 只出现在 `SET` 里）：

- `reversal.service.ts:114-116`（退款退回余额）
- `reversal.service.ts:297-299`（佣金冲销扣余额）
- `commission.service.ts:648-652`（`creditCommissions` —— **佣金入账，唯一把钱写进余额的地方**）

**同模块内已有正确写法**（可作模板）：`withdraw.service.ts:98-105` · `withdraw-admin.service.ts:590-598` · `balance-admin.service.ts:321-329` —— 三者都用 `.where('id = :id AND version = :v')` + `affected` 判定。

**触发条件**：同一用户的余额被两个事务并发写。真实场景不是假设 —— T+1 02:00 佣金入账跑批与「当天正好有一笔退款退回余额」**天然会撞在同一用户上**。

**影响范围**：后提交者覆盖先提交者 → 余额少加/多加；且 `ab_balance_log.balanceAfter` 记的是**自己算的那个错值** → **对账永远查不出来**（流水与余额「自洽地一起错」）。

**修复建议**：统一为 `WHERE id=:id AND version=:v` + `affected=0` 重试/抛错；**更稳的写法是改用数据库侧表达式更新** `balance = balance + ?`（彻底消灭读-改-写窗口）。

---

### 4 【P1】没有余额账户时静默跳过退款，但出参仍宣称「余额已退」

**位置**：`reversal.service.ts:104-107`（`if (!account) { warn; return 0; }`）→ `refund.service.ts:617`（`const balanceFen = toFen(Number(order.balanceUsed))` **无条件赋值**）→ 该值被 `approveByAdmin` 当作「余额已退回」写进日志与响应（`:459`）。

**影响范围**：低概率（正常用余额支付必有账户行），但属**静默资损 + 无痕**。

**修复建议**：无账户时 **fail-closed 抛错**（让人工介入），或先补建账户行再退；至少让出参反映**真实退回额**（用 `refundBalancePart` 的返回值）。

---

### 5 【P1】`seed` 生产误清全库只靠一个环境变量

**位置**：`seeds/seed.ts:38-43` `assertNotProduction()` 只认 `process.env.NODE_ENV === 'production'`；`:52-59` `wipeAll()` 关外键后**逐表清空 27 张表**。

**触发条件**：以非 `production` 标签连到生产库（漏设 / 拼错 / 容器里没传）执行 `seed`。

**影响范围**：真实订单、佣金、余额、退款**全量清空且不可逆**。

**修复建议**：加第二道硬闸 —— 要求显式 `--force-prod`、或拒绝在**非空库**上清表、或校验连接串 host。**一道防线守 27 张表太薄**。

---

### 6 【P1】`JWT_SECRET` 有硬编码兜底，而且**门禁正好把它豁免了**

**位置**：`config/app.config.ts:85` → `str(process.env.JWT_SECRET, 'change_me_before_go_live')`；`config/storage.config.ts:27` → `MINIO_SECRET_KEY ?? 'abox123456'`。

**放大器（这条最值得记）**：`security-scan.ts:82` 的占位符豁免正则**包含 `change[-_]?me`** —— 于是 `'change_me_before_go_live'` 这个**真实的危险兜底值**被当作「示例」豁免，**扫描一声不响地放过**。安全门禁对「注释里的示例」豁免是本意，但这里豁免到的是 **`str(env, 默认值)` 的兜底实参**，性质完全不同。

**影响范围**：生产漏配 `JWT_SECRET` → 密钥是公开字符串 → 任何人可自签任意角色（含超管）的 token。

**修复建议**：① 生产环境缺失即 **fail-fast 启动失败**，禁止任何默认值；② 把 `security-scan` 的豁免规则收窄为「**只豁免注释内**」，**不豁免代码实参**（这条本身就该是一条门禁纪律）。

---

### 7【P2】CORS 全开 + 无 helmet + 后台 token 存 localStorage
`main.ts:19` `cors: true`（任意源）；未接 helmet；`admin-web` 把 token 放 localStorage。组合起来：一次 XSS 即可跨域带走 token 直调 API。→ 建议源白名单；token 改 httpOnly cookie 或内存态。

### 8【P2】`/pay/mock/paid` 免鉴权、且没有「生产禁 mock」硬闸
`payment.controller.ts:64-71` 标 `@Public()`；**防线上确实有** —— `payment.service.ts:122-125` 以 `!this.wxpay.isMock` 抛 `10004`（复核通过，fail-closed 是对的）。但全仓**没有**「`NODE_ENV=production` 时拒绝 `PROVIDER_MODE=mock`」的启动校验 → 一次错配即等于开放「任意订单标记已支付」。→ 建议启动期校验组合合法性。（该端点被 `security-scan` R10 以「simulatePaid 自 fail-closed」为由豁免，**表述有误导**：fail-closed 只在 provider 模式正确时成立。）

### 9【P2】订阅消息在生产**永远是 mock**
`providers/providers.module.ts:52-55` **无条件** `new MockWxNotifyProvider()`；`providers/wx-notify/` 目录下**只有 `wx-notify.provider.ts` 一个文件**，**不存在 Real 实现**。→ 团长佣金到账、退款结果等订阅消息在生产**只打日志、不真发**。而《接口规范》把订阅消息写成已完成能力。→ 要么补 `RealWxNotifyProvider`，要么在「未实装清单」里明确标注（当前它**不在任何未实装清单里**）。

### 10【P2】微信支付 real 通道是 `notReady()` 桩
`real-wx-pay.provider.ts:51/59/63/67` —— 下单/退款/回调解析全部抛错，`parseNotify` 未实装验签。属「等商户号」的已知外部依赖，但**测试清单必须写明「不要在 real 模式测支付」**，否则测试者会误判。

### 11【P2】`TASKS_ENABLED` 是死配置
`config/app.config.ts:48`（类型）+ `:97`（取值）**是全部命中**，全仓**无读取点**。→ 文档把它描述成「定时任务总开关」，实际设了没用；预览/维护环境停不掉跑批。→ 要么在 `ScheduleRegistrar`/队列消费处加载它，要么删掉配置与相关文档表述。

### 12【P2】后台与共享包两套口径
`admin-web/src/constants/index.ts:2`（`UNIT_PRICE = 25.8`）`:4-9`（`COMMISSION_RATE`）与 `packages/shared-utils/src/biz.ts` 的 `BIZ` **各写一份**（后台注释自称「与小程序端同源，权威值见 docs/」—— 但**同源不等于同一处**）。→ 改售价/佣金率时后台与服务端会**静默分叉**，页面算的毛利与后端不一致。**同族缺陷 #63「两个真相」**。→ 后台改为 `import { BIZ } from '@abox/shared-utils'`。

### 13【P2】DB 里的佣金率配置可编辑但不参与计算
`common/services/biz-config.service.ts:168-170` 的 `commissionRate()` 读的是 **`BIZ.commissionRate` 常量**，不读 `ab_config`。→ 运营在配置页改佣金率**不会生效**。→ 要么改读 DB，要么从配置页移除该组并标明「演示值」。

### 14【P2】`schema:parity` 有个**结构性盲区**（第三类漂移）
`schema-parity.ts:77-82` 的 `normType()` 做了两件归一：`.replace(/\s+UNSIGNED\b/,'')` 与 `.replace(/\(.*\)/,'')` → **列长度与精度根本不参与比对**。于是 `varchar(20) → varchar(50)`、`decimal(10,2) → decimal(12,4)` 这类漂移**门禁必然漏报**。
**本轮实测**：27 表逐列比长度/精度/可空/默认值，**除 `int` vs `INT UNSIGNED`（无害）外無实质差异** —— 也就是说**当前没有真漂移**，但**盲区是结构性的**，将来会漏。→ 建议把长度/精度/unsigned 纳入比对（可先作**告警级**）。

### 15【P2】`ab_refund` 缺 `(order_id, status)` 唯一约束
`order.entity.ts:219` 只有非唯一的 `idx_refund_order`。这是 §三.2 能够成立的结构前提 —— 有唯一约束时并发也只是「第二个请求失败」，而不是「两张单都成立」。→ 补部分唯一索引或应用层占位（与 #2 同修）。

### 16【P2】永续增长表无归档/清理
`tasks/` 内无任何针对 `ab_operation_log` / `ab_balance_log` / `ab_payment_log` 的归档或清理任务。→ 长期磁盘与查询性能风险。→ 至少给出一条运维手册里的手工归档 SQL。

### 17【P3】`canTransit()` 全仓零调用
`order-state-machine.ts:40` 定义后，**只有单测引用**（`test/unit/order-state-machine.spec.ts`）。→ 状态机是**纯声明表**：任何代码都可以把 `cut_off` 直写 `refunded` 而无人阻拦。→ 在关键 setter 前插 `canTransit` 断言（fail-closed），或把它变成一条**机械对账**（声明边 ⊇ 实际写入组合）。

### 18【P3】空壳模块
`modules/traceability/**` 3 个文件共 15 行（controller/service/module 全占位）—— 溯源能力为零；`modules/distribution-center/distribution-center.service.ts` 服务体为空，admin 侧只有 `activeCount` 统计（`:124`/`:299`），**无容量/满载/均衡逻辑**。→ 这两处已在「死文件注释」批次中标注，但**建议在对外文档/测试清单里明确排除**，否则测试者会照文档测出「功能不存在」。

### 19-21【P3】资源与降级
`data-source.ts:64` CLI 默认密码 `root123`、无连接池上限（仅本地 CLI 路径）；`kv.service.ts:46-51`/`:84-87` Redis 失联时**静默**降级内存（多实例下任务锁/幂等键/限流计数瞬时只剩单实例有效，仅打 WARN，无告警）;`memory.queue.backend.ts` 不像 Redis 侧 `worker.close()` 那样 await 在途 job。
**✅ 顺带修正一条常见误解**：`KvService` 的「无 TTL 键永驻」**当前无实害** —— 本轮把全部写入点过了一遍（`idempotent.interceptor.ts:71/78`、`rate-limit.middleware.ts:208`），**全部带 TTL**。风险是「将来有人写一个不带 TTL 的键」，属加固项。

---

## 四、已复核「确认没问题」的部分 —— **这些人工测试可以少花时间**

> 下面每一条都是本轮**逐行看过**的，不是「没报错所以没事」。

**资金与口径**
- 金额精度：全仓**无浮点存钱**（统一 `money.ts` 的 `toFen/round2/money`），无裸 `*100`；`ab_balance` 四列 `DECIMAL(12,2)`；实体 decimal 读出**归一为定长字符串**，MySQL/SQLite 驱动差异已消除。
- 退款金额边界强校验：`refund.service.ts:297`（强制退）与 `:430`（审批）都要求 `toFen(amount) === refundableFen`，只支持全额退 → 超付/多次部分退款累计超额**在结构上不可能**。
- 提现余额守恒：`withdraw.service.ts:98-105` 冻结、`withdraw-admin.service.ts:590-598` 释放，均 `version` 乐观锁 + `affected`；个税/实付自洽校验在 `withdraw-admin.service.ts:397`。
- **提现审批（D46）本身是安全的**：`:283` 用 `WHERE id=:id AND status=PENDING` + `affected` 做原子占位 —— 这是全仓**做得最对**的一处，可作其他端点的模板。
- 退款单/提现单状态机封闭：无孤儿态；终态不可回退（`attemptWxRefund` 对 `REFUNDED/REJECTED` 早返回，`:675-678`）。
- 对账口径同源：订单与流水两侧都用 `toFen(Number(...))`，`REFUND_DONE` 常量一致。
- 佣金「两段式」与 `monthOrdersOf` 的退款双计修复**均在位**（`commission.service.ts:536` / `:709`）。

**订单与时间**
- 下单窗口 `[open, close)` **闭开区间正确**：恰好 14:00 可下、截单前 1 秒可下、**恰好截单时刻不可下**。
- `24:00` 合法值处理正确（`time.ts:179-180` 用 `addDays(-1)+24h` 进位），**与跑批锚点同源**，无漂移。
- 时区：全链路北京时间（`bjDateTime`/`now()`），**无 UTC/本地混用**。
- 跑批幂等：`cutoffByDate`（`:701`）等都用「条件更新 + `affected`」，**可重复执行**；补跑与定时**共用同一执行口**。
- 供应商出餐确认 `cookConfirm` 逐项幂等（重复项进 `skipped`，`supplier.service.ts:307-316`）。
- 配送单人工修正：`version` 乐观锁生效，**不覆盖人工录入值**（#61 已收口）。
- 11 态枚举与 DB 取值逐字一致。

**安全**
- 垂直越权：`/admin/*`、`/supplier/*` **全部**有 `AdminGuard` + `@Roles()`，`route:audit` 机械对账通过。
- 水平越权：订单查询一律按 `userId` 收窄；供应商服务全程用**绑定的** `supplier.id`（非请求参数）；**团长身份由 `LeaderGuard` 查库校验在职状态，不信前端 `isLeader` 标志**。
- 登录防枚举：账号不存在与密码错**同码 20005**；失败 5 次锁 15 分钟（KV）。
- 令牌吊销：改角色/停用写 KV 黑名单，`AdminGuard` 比对 `iat` 立即失效。
- 注入：**无原生 SQL 字符串拼接**，全部 TypeORM 参数化。
- 错误响应**不泄露** SQL/堆栈（`all-exceptions.filter.ts:76-82` 未知异常只回「系统繁忙」）。
- 限流实装正确（M5-6 已验）：IP/账号双维度、`AppModule.configure()` 注册、生产硬忽略开关。

**数据与前端**
- 幂等键：**小程序侧全带**（下单/支付/提现/退出，`miniprogram/src/api/*.ts` 均已声明）；问题只出在后台侧（见 §三.2）。
- 导出接口**有量级上限**：`EXPORT_MAX_ROWS = 5000` + `truncated` 标志（`order-admin.service.ts:695`/`:447`）—— 不会把百万行读进内存。
- 队列重试语义两驱动**一致**（`attempts=3`）；Redis 驱动连不上是 **fail-closed 抛错**，不静默降级。
- 定时任务热重载**可重入、不重复注册**（`schedule.registrar.ts:157-212` 先删后建），`onModuleDestroy` 回收订阅。
- 时钟平移与限流开关在**生产环境硬忽略**。
- 嵌套事务已规避 TypeORM 静默丢事务（`commission.service.ts:573` 复用外层 manager）。
- 前端 401 处理：小程序有 `pending` 互斥（并发 401 只登一次），**无请求重试** → 不会因重试造成重复提交。

---

## 五、**必须人工/真机验证**的清单（本地自动化做不到）

| 项 | 为什么本地测不了 | 怎么验 |
| --- | --- | --- |
| #2 退款并发双付 | `better-sqlite3` 单连接把并发事务**串行化** | 真机 MySQL + 两个并发请求（或压测工具）打同一单 |
| #3 余额丢更新 | 同上 | 真机并发「退款退回」∥「佣金入账」 |
| #6 JWT 默认值 | 需生产形态配置 | 不设 `JWT_SECRET` 启动，应**失败**而非静默用默认值 |
| #8 mock 通道越权 | 需错配组合 | 生产参数 + `PROVIDER_MODE=mock` 启动，应被拒 |
| 履约链 #1 | 取决于裁决 | 裁决为①时：走真实 HTTP 全链路（下单→支付→截单→出餐确认→**查订单状态**→团长确认→查佣金） |
| 微信支付/退款/订阅消息 | 无商户号与证书 | 真机 + 商户号；当前 real 通道是桩 |

---

## 六、建议的修复顺序

1. **先裁决 §三.1**（履约链） —— 它是产品范围问题。**在它定下来之前，人工测试的清单就得先改**，否则必然浪费一轮。
2. **资金并发三连（#2 / #3 / #4 / #15）一次性改完**：都在 `finance` 模块、共用「原子占位 + 条件更新」一个原语，改完**上真机 MySQL 验证**。**不要分批** —— 这三处是同一族缺陷，分批改会留下一半。
3. **#6 安全默认值**（改动小、风险高，收益比最好）。
4. **#12 / #13 口径双源与死配置**（改动小，但能消除「改了没效果」这一类困惑）。
5. **#11 / #14 / #16 / #17** 门禁与运维加固。
6. **#5 seed 防护**（测试环境搭建期间最容易被误触）。

---

## 七、本次审查未覆盖的部分（诚实边界）

- **前端**：仅审了请求层、本地存储、路由守卫与错误处理；**未逐页审 XSS 与表单校验**；`admin-web` 的 22.8K 行只抽审。
- **`packages/shared-types` 与实际响应的逐字段一致性**：体量过大，只确认了 API 信封解包一致。
- **`config.specs.ts`（602 行）的取值范围校验**未逐条核对（只确认它是单一真源）。
- **短信/验证码**：产品当前无短信通道，未审。
- **性能**：未做压测；`132` 处 `.find({...})` 只做了抽样判断，未逐处判断是否缺 `take/skip`。
- **真机 MySQL 首迁**：迁移结构与实体已机械对账，但**从未在真机 MySQL 上跑过首迁**（延续既有挂账）。

---

## 八、与既有缺陷账本的衔接

- 上一轮账本 **#77**（`refundBalancePart` 无条件 `+=`）**本轮确认仍在**，且本轮把它**扩成了更大的一条**：真正的结构性缺口在**退款单行缺原子占位**（§三.2）—— 修那一处可同时关掉 #77 与 #2。
- 本轮新增 **#79**（履约态零写入点）、**#80**（退款单行无 claim + 新幂等单号 = 真双付）、**#81**（余额三处漏 version 校验）、**#82**（无账户静默跳过退款但报已退）、**#83**（`security-scan` 的占位符豁免把 `change_me` 兜底一起放过了）。
- **#67 同族的价值在这里再次显现**：那条记录的教训是「跨端字面量写错，没有任何人会报错」；**#79 是它的升级版 —— 整段逻辑缺席，而 e2e 从链路中间开始测，所以也永远不会红**。

---

*文档结束 · ABox 一盒 · 代码整体审查与缺陷汇总 v1.0 · 2026-09-18*

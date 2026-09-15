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
| 最近修订 | 2026-09-15 · ① **M3-1 后台鉴权基座**：A1–A6 重写（双主体隔离 / 登录失败锁定 / 令牌吊销 / 无状态登出 / 查库求证）+ D51–D56 口径 + 错误码 20009·20010；② **M3-2 套餐编排**：D1–D7 实现口径表 + 两个扩展选择器（`/admin/meal/dishes`、`/admin/meal/distribution-centers`）+ 错误码 30011·30012·30013 |

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

> ⚠️ **C6 口径**：此接口**只创建申请**（写 `ab_refund`，`status='applying'`），**不退款、不回退分账**。实际退款在后台审批通过后由 `finance/refund.service` 执行（见 §6.5）。

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
| S9 | GET | `/supplier/shares?date=&page=` | **应付结算明细**（日明细 + 周期汇总）（M23-01） |
| S10 | GET | `/supplier/settle-account` | **对公结算账户**信息（M23-02） |
| S11 | POST | `/supplier/invoices` | 月度开票申请（M23-03） |
| S12 | GET | `/supplier/profile` | 商家资料 + 资质（M24-01） |
| S13 | PUT | `/supplier/profile` | 更新资料（资质变更需重新审核） |
| S14 | GET | `/supplier/agreement` | 供应商协议与结算规则（M24-02） |

**S9 应付结算口径（C9 · 2026-09-15 修订）**：供应商单价 = 该供应商当日供应菜品的**协商供价**（示例红烧肉 ¥7.50/份，**逐菜逐供应商议定，非固定**）× 实发份数；集散/场地费**复用供应商场地、默认 ¥0**（科目保留）；**打包人工**（平台兼职）与**配送费**（货拉拉）**按实际发生额**单列。**本接口只做「应付金额计算与状态展示」—— 实际付款由财务走人工对公转账，系统不做任何支付通道分账调用**，故状态是 `待付 / 已付 / 已冲减`，而非「分账成功 / 失败」。

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
| D11 反向结算 | 佣金冲销 + 应付冲减 + **毛利留存**（见 C9） | 原记录一律不改写：冲销写新行、原行只翻 `status=cancelled` |
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
| D13 | GET | `/admin/buildings?groupId=&status=` | 办公楼列表（M33-01，P37 五视图数据源） |
| D14 | POST | `/admin/buildings` | 新增办公楼 |
| D15 | PUT | `/admin/buildings/{id}` | 编辑（含 `leaderId` 关联） |
| D16 | GET | `/admin/building-groups` | 楼群列表（M33-02） |
| D17 | POST | `/admin/building-groups` | 新建楼群 |
| D18 | PUT | `/admin/building-groups/{id}` | 编辑楼群（含成员办公楼增删） |
| D19 | GET | `/admin/leaders?groupId=&buildingId=&level=&status=&page=` | 团长名录（M33-03，P32 数据源） |
| D20 | POST | `/admin/leaders` | 任命 / 转交团长（M33-04） |
| D21 | PUT | `/admin/leaders/{id}` | 变更团长（等级、状态、所属办公楼） |
| D22 | POST | `/admin/leaders/{id}/audit` | 资质审核 / 协议签署记录（M33-05） |

> **D22 说明**：C3 口径下**团长申请即生效、无前置审核**；此接口仅用于**事后资质补录**与**例外处理**（如违规停用）。界面文案须与 P32「提交申请即生效（无审核）」一致。

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

### 6.5 财务结算（M35）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| D33 | GET | `/admin/finance/overview?date=&range=` | 资金总览（日/周/月 GMV、平台收入、佣金支出）（M35-01） |
| D34 | GET | `/admin/finance/commissions?date=&leaderId=&page=` | 团长佣金结算明细（M35-02） |
| D35 | POST | `/admin/finance/commissions/settle` | 手动触发佣金入账（复核后重跑，**幂等**） |
| D36 | GET | `/admin/finance/supplier-shares?period=&supplierId=` | **供应商应付结算单**（按周期汇总）（M35-03） |
| D37 | POST | `/admin/finance/supplier-shares/{id}/confirm-payment` | **付款登记**（上传银行回单号 → 状态置已付）（M35-03） |
| D38 | GET | `/admin/finance/balances?userId=&page=` | 余额账户管理（M35-04） |
| D39 | POST | `/admin/finance/balances/adjust` | 充值 / 扣减 / 冻结（**必填原因 + 写日志**）（M35-04） |
| D40 | GET | `/admin/finance/refunds?status=&page=` | 退款流水（M35-05） |
| **D41** | **POST** | **`/admin/finance/refunds/{id}/approve`** | **退款审批通过 → 实际退款（C6 第二→三段）** |
| **D42** | **POST** | **`/admin/finance/refunds/{id}/reject`** | **退款驳回 → 回到原状态（C6）** |
| D43 | GET | `/admin/finance/reconciliation?date=` | 与微信支付对账（M35-06） |
| D44 | GET | `/admin/finance/invoices?page=` | 发票管理（M35-07） |
| D45 | GET | `/admin/finance/withdrawals?status=&page=` | 提现审批列表（M35-08） |
| D46 | POST | `/admin/finance/withdrawals/{id}/approve` | 提现审批通过 |

> **结算模式（2026-09-14 定案 · C10 + C11）**：**团长佣金**由系统自动结算（入佣金余额 → 提现由**灵活用工平台代发**并代扣个税；D45 / D46 审批后，`PayoutChannel` 生成**打款批次**并导出清单，一期运营提交平台后**回执登记**、二期接平台 API）；**供应商 / 集散中心**为**应付结算 · 日结**，系统只生成结算单与登记付款（D36 / D37），实际转账由财务在网银完成。详见《账号资源与密钥清单》§3.2。

**D41 执行链（C6 · 三段式收口）**

```
approve
  → ab_refund.status: applying → approved
  → 调用微信退款 API（原路退用户）→ refunding → refunded
  → 反向结算（reversal.service，原记录不得改写）：
       供应商 / 集散中心：冲减应付（未付款 → 直接冲减；已付款 → 写反向流水，下期抵扣）
       团长佣金：扣减佣金流水（写反向 ab_commission，金额取负）
       平台毛利（结果值）留存（不参与回退）
  → 推送微信订阅消息给用户（退款结果必推）
```

> ⚠️ **已付款后再退款**：若 `ab_supplier_share` 已登记付款（`success` = 已付款），须走 `reversal.service` 写**反向流水**（`type='reversal'`）并在**下期结算抵扣**；未付款的应付单直接冲减。**原记录一律不得改写。**

### 6.6 数据统计（M36）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| D47 | GET | `/admin/stats/dashboard?range=` | 核心指标看板（DAU、订单量、复购率、客单价）（M36-01） |
| D48 | GET | `/admin/stats/building-rank?range=` | 楼群排行（M36-02） |
| D49 | GET | `/admin/stats/dish-heat?range=` | 菜品热度（M36-03） |
| D50 | GET | `/admin/stats/retention?range=` | 留存分析（M36-04） |

**关键指标口径（与原型 P34/P35 一致）**

| 指标 | 公式 |
| --- | --- |
| GMV | Σ 已完成订单 `unitPriceFen × quantity`（**不含已退款**） |
| 平台毛利（**结果值**） | GMV − 供应商应付（协商供价） − 集散/场地费 − 打包人工 − 配送费 − 团长佣金 |
| 客单价 | GMV ÷ 完成订单数（**份数**，非订单量） |
| 退款率 | 退款单数 ÷ 总订单数 |
| 佣金支出 | Σ `ab_commission.amount_fen`（含反向冲销） |

### 6.7 系统管理（M37）

> **实现状态**：`D51–D56` 已实装（M3-1 基座批次）；`D57–D60` 待 M3-7。
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
| P34 | 财务结算 | M35 | D33–D46 | `ab_commission`、`ab_supplier_share`、`ab_refund` |
| P35 | 数据看板 | M36 | D47–D50 | 聚合查询 |
| P36 | 系统配置 | M37 | D51–D60 | `ab_admin_user`、`ab_operation_log`、`ab_config`、`ab_message` |
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
| **50001** | 供应商资质未通过审核 | 出餐前置校验 | 403 |
| **50002** | 集散中心配置不可删除（存在历史结算） | 软删保护 | 409 |
| **50004** | 可提现余额不足 | 提现申请超出可用余额（L12） | 409 |
| **90001** | 系统繁忙，请稍后再试 | 未捕获异常 | 500 |

> **扩展码**：`20006` / `20007` / `20008` / `20009` / `20010` / `30008` / `30009` / `30010` / `30011` / `30012` / `30013` / `30014` / `30015` / `40009` / `40010` / `40011` 号段内文档原未列、但工程实现需要，已按「号段末尾登记」规则回写本表（见 `apps/api-server/src/common/constants/error-code.ts` 头部纪律）。**禁止挪用文档已占用的号位。**

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

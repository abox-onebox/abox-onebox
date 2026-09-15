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

> ⚠️ **团长身份判定纪律**：任何 `/api/v1/leader/*` 接口，`auth.guard` 解析 JWT 后**必须再查一次 `ab_team_leader`**，确认 `status='active'` 且 `building_id` 匹配，禁止仅凭 JWT 内的 `isLeader` 放行。

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
| A1 | POST | `/auth/wx-login` | 小程序登录（唯一入口） | `{ code, leaderCode? }` | `{ token, refreshToken, expiresIn, user:{id,nickName,avatar,isLeader,level,leaderId,buildingId} }` |
| A2 | POST | `/auth/admin-login` | 后台登录（供应商 / 运营同一接口，按账号角色返回） | `{ username, password, captcha? }` | `{ token, refreshToken, expiresIn, account:{id,name,role,menus[]} }` |
| A3 | POST | `/auth/refresh` | 刷新令牌 | `{ refreshToken }` | 同 A1 精简 |
| A4 | POST | `/auth/logout` | 登出 | — | `null` |
| A5 | GET | `/auth/profile` | 当前登录者 | — | 小程序返回 `user`；后台返回 `account`（含 `menus` 供前端渲染） |

> 后台登录失败 5 次锁定 15 分钟（`code: 20005`）；账号体系独立于小程序，见 ER `ab_admin_user`。

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
3. 团长存在且 `status='active'` → 否则 `30007`
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
| U17 | GET | `/me/support` | 客服入口配置（企微/电话/在线） |

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

**L12 错误**：低于最低额 → `40003`（`data.minFen: 1000`）；未绑定收款方式 → `40007`。

### 4.5 团长管理（M15）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| L14 | GET | `/leader/profile` | 团长资料（M15-01） |
| L15 | PUT | `/leader/profile` | 修改资料（手机号、楼层；办公楼变更需后台审核） |
| L16 | GET | `/leader/level-rules` | 4 级佣金规则 + **C2 双条件**升级门槛（M15-02） |
| L17 | POST | `/leader/apply` | **申请成为团长**（C3：**提交申请即生效**） |
| L18 | POST | `/leader/agreement` | 勾选同意《团长合作协议》（记录签署时间/IP/版本号） |

**L17 业务（C3 · 无审核）**

```
前端：勾选协议复选框（不勾不可提交）
  → POST /leader/apply { buildingId, phone, floor, agreementVersion }
  → 校验协议已勾选 → 建 ab_team_leader（level='trainee', status='active'）
  → 立即写入 ab_leader_invite（inviter 为空，self_apply）
  → 返回 isLeader=true，前端 setIsLeader(true) 重渲染 tabBar（5 项）
```

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

**D1 出参（矩阵）**

```json
{
  "dates": ["2026-09-15","2026-09-16"],
  "groups": [{ "id":1, "name":"国贸楼群", "buildingIds":[1,2,3,4] }],
  "cells": [
    { "mealDate":"2026-09-15", "groupId":1, "assignmentId":5, "setMealName":"红烧肉套餐", "status":"published",
      "dishCount":4, "distributionCenterId":1, "assignedBuildings":[1,2,3], "emptyBuildings":[4] }
  ]
}
```

> ⚠️ **矩阵单元格的 C 座口径**：`emptyBuildings` 表示该楼群内**未分配**的办公楼。原型 P27 中 C 座（龙湖 · 待分配）即此语义，UI 上以禁用复选框呈现，**与 P37 办公楼管理的状态一致**。

### 6.2 订单中心（M32）

| # | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| D8 | GET | `/admin/orders?mealDate=&buildingId=&groupId=&status=&leaderId=&page=` | 全平台订单流（M32-01/02） |
| D9 | GET | `/admin/orders/{orderNo}` | 订单详情 + **操作日志**（M32-03） |
| D10 | POST | `/admin/orders/manual-adjust` | 手动改单（加/减/改地址）（M32-04） |
| D11 | POST | `/admin/orders/{orderNo}/force-refund` | 强制退款（M32-05） |
| D12 | GET | `/admin/orders/export?mealDate=&...` | Excel 导出（M32-06） |

> D10 / D11 **必须写 `ab_operation_log`**（操作人、前后值、原因、IP）。

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
| P16/P17/P18 | 佣金/余额/提现 | M14 | L10–L13 | `ab_commission`、`ab_balance`、`ab_balance_log` |
| P19/P20 | 分享/资料 | M11/M15 | L2/L3/L14–L18 | `ab_team_leader`、`ab_leader_invite` |
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
| **30001** | 今日 24:00 已截单，明日请早 | 截单窗口外下单 | 409 |
| **30002** | 份数超出单次上限 | 超过 `order.max_quantity` | 400 |
| **30003** | 当前订单状态不支持该操作 | 状态机拒绝 | 409 |
| **30004** | 请勿重复下单 | 同用户同日重复提交 | 409 |
| **30005** | 该办公楼今日未开团 | 无套餐分配 | 404 |
| **30006** | 余额抵扣金额不合法 | 负数 / 非整数分 | 400 |
| **30007** | 团长不存在或已停用 | 邀请码无效 | 404 |
| **40001** | 支付单创建失败，请稍后重试 | 微信下单异常 | 502 |
| **40002** | 余额不足 | 抵扣超出可用额 | 409 |
| **40003** | 提现金额低于最低限额 | < ¥10.00 | 400 |
| **40004** | 已截单，无法自助退款 | C6 拦截 | 409 |
| **40005** | 佣金结算失败，请联系运营 | 入账 / 灵活用工代发异常 | 502 |
| **40006** | 该笔应付已付款，需走反向冲减 | 直接改已付结算单被拒 | 409 |
| **40007** | 请先绑定收款方式 | 提现前置校验 | 400 |
| **40008** | 退款申请已存在，请勿重复提交 | 幂等 | 409 |
| **50001** | 供应商资质未通过审核 | 出餐前置校验 | 403 |
| **50002** | 集散中心配置不可删除（存在历史结算） | 软删保护 | 409 |
| **90001** | 系统繁忙，请稍后再试 | 未捕获异常 | 500 |

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

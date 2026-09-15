# ABox 一盒 · 账号资源与密钥清单 v1.0

> **文档性质**：上线前置外部资源的**核对表 + 保管纪律**。本清单未打钩项 = 阻塞上线的硬依赖
> **使用方式**：逐项核对，把"实际值"填入留白列；**密钥类只登记"存放位置"，严禁写入本文件**
> **主责**：项目负责人（账号/合规）· 后端负责人（密钥/环境）

---

## 〇、文档信息

| 项 | 内容 |
| --- | --- |
| 版本 | v1.0 |
| 日期 | 2026-09-14 |
| 主体 | 北京巡礼之年科技有限公司 |
| 已知状态 | ⭐ **小程序认证 / 支付商户号 / 域名备案 三项长周期资源已就绪**（据项目负责人确认），本清单重点为**参数核对与补全** |

### 状态图例

| 标记 | 含义 |
| --- | --- |
| ✅ | 已就绪，参数已核对 |
| ⚠️ | 已具备但**参数待补全**或**能力待确认** |
| ❌ | 未开始，阻塞上线 |
| — | 不适用 |

---

## 一、资源总览看板

| # | 资源 | 状态 | 阻塞上线 | 责任人 | 目标完成 |
| --- | --- | --- | --- | --- | --- |
| R1 | 微信小程序（AppID + 认证） | ⚠️ 待核对 | 是 | 项目负责人 | 准备期 W1 |
| R2 | 微信支付商户号（JSAPI） | ⚠️ 待核对 | 是 | 项目负责人 | 准备期 W1 |
| R3 | **灵活用工平台**（佣金代发 + 个税代扣） | ❌ 待开户 | **是**（佣金出款） | 项目负责人 + 财务 | 准备期 W1 D5 |
| R4 | 域名（已备案） | ⚠️ 待核对 | 是 | 项目负责人 | 准备期 W1 |
| R5 | 服务器 / K8s 或云主机 | ❌ 待开通 | 是 | 后端负责人 | 准备期 W1–W2 |
| R6 | MySQL 8.0 | ❌ 待开通 | 是 | 后端负责人 | 准备期 W2 |
| R7 | Redis 7 | ❌ 待开通 | 是 | 后端负责人 | 准备期 W2 |
| R8 | 对象存储 COS | ❌ 待开通 | 是（图片/小程序码） | 后端负责人 | 准备期 W2 |
| R9 | HTTPS 证书 | ❌ 待签发 | 是 | 后端负责人 | 准备期 W2 |
| R10 | 微信订阅消息模板 | ❌ 待申请 | 否（但影响体验） | 项目负责人 | 开发期 W3 |
| R11 | 食品经营许可证（热食类制售） | ⚠️ 待核对 | 是（类目审核） | 项目负责人 | 准备期 W1 |

> **关键路径提示**：结算模式已于 2026-09-14 定案（**C10 + C11**）——**供应商 / 集散中心走人工对公转账 · 日结；团长佣金由系统自动结算，出款走灵活用工平台代发并代扣个税**。故：① **无需开通微信分账**、无需添加供应商为分账接收方（原「分账单笔 30% 上限 vs 供应商合计 54.3%」冲突消失）；② **也不再需要「商家转账到零钱」**，改为 R3「灵活用工平台」开户 —— 这是唯一的资金出账依赖，W1 D5 前完成即可不影响 M1。

---

## 二、微信小程序（R1）

| 项 | 待填 / 核对 | 备注 |
| --- | --- | --- |
| AppID | `wx________________` | 填入 `WX_APPID` 环境变量 |
| AppSecret | **（仅登记存放位置）** | 存于密钥管理系统 / 环境变量，**禁止入库、禁止入 Git** |
| 主体名称 | 北京巡礼之年科技有限公司 | 须与营业执照一致 |
| 认证状态 | ⚠️ 是否已完成**微信认证**（¥300/年） | 未认证无法使用支付、订阅消息 |
| 服务类目 | **餐饮 → 餐饮服务 / 食品经营** | 需上传《食品经营许可证》 |
| 开发者账号 | 需 ≥ 1 个管理员 + 若干开发者 | 建议开 1 个"体验版"专用账号 |
| 体验版 / 正式版 | ❌ 待配置 | 内测走体验版（≤ 100 人） |
| 合法域名配置 | ❌ 待配置（依赖 R4） | 见第四章 |

### 2.1 需在小程序后台配置的项

| 配置 | 值 |
| --- | --- |
| `request` 合法域名 | `https://api.abox.<你的域名>` |
| `uploadFile` 合法域名 | 同上 |
| `downloadFile` 合法域名 | 同上 + COS 域名 |
| `socket` 合法域名 | 同 `request`（如用长连接） |
| 业务域名 | 同 `request` |
| 订阅消息模板 ID | 见 R10 |

---

## 三、微信支付与佣金出款（R2 / R3）

### 3.1 商户号基础参数

| 项 | 待填 / 核对 | 备注 |
| --- | --- | --- |
| 商户号（mchid） | `________________` | 填入 `WXPAY_MCHID` |
| 商户类型 | ⚠️ 普通商户 / 特约商户（服务商） | 普通商户即可；因不需要分账，**不依赖服务商模式** |
| 绑定 AppID | ⚠️ 是否已与 R1 的 AppID 关联 | 未关联无法发起 JSAPI 支付 |
| APIv3 密钥 | **（仅登记存放位置）** | 32 位，`WXPAY_API_V3_KEY` |
| API 证书（apiclient_cert.pem / key.pem） | **（仅登记存放位置）** | 存于服务器安全路径，权限 600 |
| 商户证书序列号 | `________________` | `WXPAY_SERIAL_NO` |
| 支付回调地址 | `https://api.abox.<域名>/api/v1/pay/notify` | 须 HTTPS 且验签 |
| 退款回调地址 | `https://api.abox.<域名>/api/v1/pay/refund-notify` | — |
| 佣金打款回执地址 | `https://api.abox.<域名>/api/v1/pay/transfer-notify` | 团长佣金出款结果回执（一期运营登记，二期接灵活用工平台回调 · C11） |

### 3.2 ✅ 结算模式（2026-09-14 定案）

> **定案口径**：只有**团长佣金**走系统自动结算；**供应商与集散中心改由人工对公转账**，系统只负责生成应付结算单与登记付款。

| 收款方 | 金额/份 | 结算方式 | 系统职责 | 支付能力依赖 |
| --- | --- | --- | --- | --- |
| 4 家菜品供应商 | **按协商供价**（示例 ¥14.00） | **人工对公转账 · 日结**（平台对公账户 → 供应商公司账户，凭票付款；对公账户信息可后置收集） | 生成应付结算单 + 付款登记 + 发票管理 | ❌ 无（走网银 / 银企直连） |
| 集散 / 场地费 | **默认 ¥0**（复用供应商场地） | **人工对公转账 · 日结**（同上，集散中心即某供应商） | 同上 | ❌ 无 |
| 打包人工 | **按实际**（平台雇兼职） | **按实际发生登记**（可走灵活用工平台代发） | 费用登记 + 劳务凭证 | 视通道而定 |
| 配送费 | **按实际**（货拉拉） | **按实际发生登记**（货拉拉平台直付） | 费用登记 + 发票 | ❌ 无 |
| 团长佣金 | ¥3.10（≤12%） | **系统自动结算** → 计入团长佣金余额 → 团长提现 | 自动计算 + 入账 + 提现审批 + **打款批次** | ✅ **灵活用工平台代发**（C11） |
| 平台毛利 | **结果值**（示例 ¥8.70） | 留存 | 记账 | — |

**为什么原「方案 A / B」二选一不再适用**：

- 原顾虑是**微信分账单笔比例上限（通常 30%）** vs 供应商应付合计（示例 ¥14.00 / ¥25.80 ≈ 54.3%，实际以协商供价为准）；
- 供应商 / 集散中心退出分账后，**分账接收方只剩团长一个，单笔最高 12% < 30%**，技术上完全畅通；
- 又因佣金走「**余额 → 灵活用工平台代发**」（C11），**既不需要微信分账产品、也不再需要「商家转账到零钱」权限**，本方案更简单、启动更快、对账更清晰。

**仅需申请的能力**：☐ **灵活用工平台**（开户 + 服务协议；佣金代发 + 个税代扣）—— 微信侧**不再需要「商家转账到零钱」**

### 3.3 其他支付能力

| 能力 | 用途 | 状态 |
| --- | --- | --- |
| JSAPI 支付 | 用户下单 | ⚠️ 待确认开通 |
| 退款 API | C6 退款 | ⚠️ 待确认开通 |
| 商家转账到零钱 | — | ❌ **不再需要**（C11 改走灵活用工平台代发） |
| **灵活用工平台**（代发 + 完税） | **团长佣金代发 + 个税代扣代缴**（唯一需自动化的资金出账） | ❌ 待开户（**关键**，W1 D5） |
| 企业付款到对公 | — | ❌ **不需要**（供应商走人工对公转账：网银 / 银企直连） |
| 账单下载 | 每日对账 | ⚠️ 待确认 |

---

## 四、域名与备案（R4）

| 项 | 待填 / 核对 |
| --- | --- |
| 主域名 | `________________`（如 `abox.com`） |
| API 子域名 | `api.abox.<域名>` |
| 后台子域名 | `admin.abox.<域名>`（可选） |
| ICP 备案号 | `京ICP备________________号` |
| 备案主体 | 北京巡礼之年科技有限公司 |
| 备案状态 | ✅ 已完成（据项目负责人确认） |
| 域名注册商 / 到期日 | 待填 |
| 是否需**公安备案** | ⚠️ 待确认（小程序一般需 ICP 即可） |

> **要点**：小程序 `request` 合法域名**必须为 HTTPS + 已备案**，且**不能使用 IP**。备案主体需与小程序主体一致，否则审核受阻。

---

## 五、云资源（R5–R9）

### 5.1 清单

| 资源 | 规格建议（MVP） | 状态 | 用途 |
| --- | --- | --- | --- |
| 云服务器 / K8s | 4C8G × 1（或 K8s 2 节点） | ❌ 待开通 | 后端 + 后台前端 |
| MySQL 8.0 | 2C4G · 100GB SSD · 主从可选 | ❌ 待开通 | 主库（24 张表） |
| Redis 7 | 1G · 标准版 | ❌ 待开通 | 会话 / 幂等 / 缓存 / BullMQ 队列 |
| 对象存储 COS | 标准存储 50GB + CDN | ❌ 待开通 | 菜品图 / 小程序码 / 导出文件 |
| HTTPS 证书 | 免费 DV 或 OV | ❌ 待签发 | API + 后台 |
| 日志 / 监控 | 云监控 + 日志服务 | ⚠️ 可选 | 上线后补 |

> **MVP 体量参考**：≈500 单/天，单机 4C8G MySQL 可承载 10 个楼群 —— **不需要 K8s**，初期用云主机 + Docker Compose 即可，省成本与运维。

### 5.2 安全组 / 白名单

| 项 | 要求 |
| --- | --- |
| 3306（MySQL） | **仅内网**，禁止公网 |
| 6379（Redis） | **仅内网**，设密码 |
| 443（HTTPS） | 公网开放 |
| 80（HTTP） | 仅用于跳转 443 |
| SSH（22） | 限制来源 IP |

---

## 六、密钥保管与轮换纪律

### 6.1 铁律

| # | 纪律 |
| --- | --- |
| 1 | **密钥不入 Git**：`.env` 必须在 `.gitignore`；提交前用 `git-secrets` / 人工复查 |
| 2 | **密钥不入库**：`ab_config` 只存非密配置（价格/费率/时间） |
| 3 | **密钥不进文档**：本文件只登记"存放位置"，不写值 |
| 4 | **分发最小化**：仅后端负责人 + 1 名备份人可读生产密钥 |
| 5 | **环境隔离**：开发 / 测试 / 生产**三套独立**密钥，禁止复用 |
| 6 | **轮换**：APIv3 密钥与 API 证书**每 12 个月**轮换；人员离职立即轮换 |

### 6.2 存放位置登记

| 密钥 | 存放位置 | 谁可读 |
| --- | --- | --- |
| `WX_SECRET` | 生产环境变量（密钥管理服务） | 后端负责人 |
| `WXPAY_API_V3_KEY` | 同上 | 后端负责人 |
| `WXPAY_PRIVATE_KEY_PATH`（apiclient_key.pem） | 服务器 `/etc/abox/certs/`，权限 600 | 后端负责人 |
| `JWT_SECRET` | 环境变量（≥ 32 位随机） | 后端负责人 |
| `COS_SECRET_ID/KEY` | 环境变量 | 后端负责人 |
| DB / Redis 密码 | 环境变量 | 后端负责人 |

---

## 七、环境变量清单（`.env.example`）

```bash
# ===== 应用 =====
NODE_ENV=development
APP_PORT=3000                      # 注意：不是 PORT
APP_BASE_URL=https://api.abox.example.com
API_PREFIX=/api/v1
TASKS_ENABLED=true                 # 定时任务总开关（本地调试可关）

# ===== 驱动开关（本地 ↔ 云端零改动切换）=====
DB_DRIVER=mysql                    # mysql | sqlite（本机无 Docker 时用 sqlite）
QUEUE_DRIVER=redis                 # redis | memory
STORAGE_DRIVER=cos                 # cos | minio | local
PROVIDER_MODE=real                 # real | mock（无微信/支付账号时用 mock）
SQLITE_PATH=./data/abox-dev.sqlite # 仅 DB_DRIVER=sqlite 时生效

# ===== 数据库 =====
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=abox
DB_PASSWORD=
DB_DATABASE=abox_onebox            # 注意：不是 DB_NAME
DB_SYNCHRONIZE=false               # 生产恒 false；本地 sqlite 建表可为 true

# ===== Redis =====
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# ===== 鉴权 =====
JWT_SECRET=                        # ≥ 32 位随机
JWT_EXPIRES_IN=7d

# ===== 微信小程序 =====
WX_MINI_APPID=                     # 注意：不是 WX_APPID
WX_MINI_SECRET=                    # 注意：不是 WX_SECRET
WX_TPL_MEAL_PUBLISHED=             # 开团提醒模板 ID
WX_TPL_DELIVERY_ARRIVED=           # 送达提醒模板 ID
WX_TPL_COMMISSION_SETTLED=         # 佣金结算模板 ID

# ===== 微信支付 =====
WXPAY_MCH_ID=                      # 注意：不是 WXPAY_MCHID
WXPAY_API_V3_KEY=
WXPAY_SERIAL_NO=
WXPAY_PRIVATE_KEY_PATH=/etc/abox/certs/apiclient_key.pem
WXPAY_NOTIFY_URL=https://api.abox.example.com/api/v1/pay/notify

# ===== 灵活用工平台（C11：团长佣金代发 + 个税代扣）=====
FLEX_PLATFORM_NAME=                # 服务商名称（待定）
FLEX_PLATFORM_APP_ID=
FLEX_PLATFORM_APP_SECRET=          # 注意：不是 FLEX_PLATFORM_SECRET
FLEX_PLATFORM_API_BASE=
FLEX_PLATFORM_SERVICE_FEE_RATE=    # 注意：不是 FLEX_PLATFORM_FEE_RATE；6%–8% 待确认

# ===== 对象存储（COS）=====
COS_SECRET_ID=
COS_SECRET_KEY=
COS_BUCKET=
COS_REGION=ap-beijing

# ===== 对象存储（本地 / MinIO，仅 STORAGE_DRIVER 对应时生效）=====
LOCAL_UPLOAD_DIR=./data/uploads
LOCAL_UPLOAD_PUBLIC_BASE=http://localhost:3000/static
MINIO_ENDPOINT=http://127.0.0.1:9000
MINIO_ACCESS_KEY=abox
MINIO_SECRET_KEY=abox123456
MINIO_BUCKET=abox-uploads

# ===== Mock 参数（仅 PROVIDER_MODE=mock 生效）=====
MOCK_WX_OPENID_PREFIX=mock_openid_
MOCK_PAY_AUTO_SUCCESS=true         # 下单后自动回调支付成功
MOCK_PAY_CALLBACK_DELAY_MS=800
```

**前端（Vite 构建期注入，各自 app 目录下的 `.env`）**

```bash
# apps/admin-web/.env
VITE_API_BASE_URL=http://localhost:3000/api/v1
VITE_APP_TITLE=ABox 一盒 · 运营后台

# apps/miniprogram/.env
VITE_API_BASE_URL=http://localhost:3000/api/v1
VITE_WX_MINI_APPID=
```

> ⚠️ **本节以代码实际读取为准**（`apps/api-server/src/config/*.ts` 的 `process.env.*`）。
> 曾出现的偏差已订正：`DB_NAME`→`DB_DATABASE`、`WX_APPID`→`WX_MINI_APPID`、`WX_SECRET`→`WX_MINI_SECRET`、
> `WXPAY_MCHID`→`WXPAY_MCH_ID`、`FLEX_PLATFORM_SECRET`→`FLEX_PLATFORM_APP_SECRET`、
> `FLEX_PLATFORM_FEE_RATE`→`FLEX_PLATFORM_SERVICE_FEE_RATE`、`PORT`→`APP_PORT`（**照旧名填写会让 real 模式静默失败**）。
>
> 代码中**不存在**以下变量，已移除：`JWT_REFRESH_EXPIRES_IN`、`WXPAY_REFUND_NOTIFY_URL`、
> `WXPAY_TRANSFER_NOTIFY_URL`、`WXPAY_TRANSFER_ENABLED`、`FLEX_PLATFORM_ENABLED`（C11 后微信「商家转账到零钱」不再需要）。
>
> 交付物（单一事实来源）：根 `.env.example`（全量）· `apps/api-server/.env.example` · `apps/admin-web/.env.example` ·
> `apps/miniprogram/.env.example`。新人 `cp .env.example .env` 后自行填写，`.env` 已在 `.gitignore`。

---

## 八、待办与责任人（准备期 W1–W2）

| # | 待办 | 责任人 | 截止 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 核对 AppID / AppSecret / 认证状态 | 项目负责人 | W1 D2 | ☐ |
| 2 | 确认小程序服务类目已含"餐饮"并上传食品经营许可证 | 项目负责人 | W1 D2 | ☐ |
| 3 | **灵活用工平台**开户 + 服务协议 + 费率确认（佣金代发 + 个税代扣 · C11） | 项目负责人 + 财务 | **W1 D5** | ☐ |
| 4 | 核对商户号、APIv3 密钥、证书、序列号 | 后端负责人 | W1 D3 | ☐ |
| 5 | 开通 JSAPI 支付 + 退款 API（「商家转账到零钱」**不再需要** · C11） | 项目负责人 | W1 D3 | ☐ |
| 6 | 配置小程序合法域名（依赖域名核对） | 项目负责人 | W2 D1 | ☐ |
| 7 | 开通云主机 + MySQL + Redis + COS | 后端负责人 | W2 D1 | ☐ |
| 8 | 签发 HTTPS 证书并配置 Nginx | 后端负责人 | W2 D2 | ☐ |
| 9 | 申请 3 个订阅消息模板 | 项目负责人 | W3 | ☐ |
| 10 | 建 `.env.example` 并纳入仓库 | 后端负责人 | W2 D2 | ☐ |

---

*文档结束 · ABox 一盒 · 账号资源与密钥清单 v1.0 · 2026-09-14*

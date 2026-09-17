# ABox 一盒 · 部署运维手册 v1.0

> 版本：**v1.0**（2026-09-17 · M5-0）
> 适用阶段：**M5 三方联调 + 单楼灰度上线**
> 配套文档：`README.md` ·《ABox一盒本地开发手册v1.0.md》·《ABox一盒账号资源与密钥清单v1.0.md》·《ABox一盒协作规范v1.0.md》
> 配套脚本：`scripts/deploy.sh` · `rollback.sh` · `backup-db.sh` · `restore-db.sh` · `healthcheck.sh`

---

## 一、这份手册管什么

| 管 | 不管 |
| --- | --- |
| 生产/灰度环境的**部署、回滚、备份恢复** | 本地怎么开发（见《本地开发手册》） |
| **运营期间**的巡检、探针、告警、应急预案 | 业务口径（见《接口规范》《自营结算口径》） |
| 密钥与最小权限的**使用纪律** | 账号怎么申请（见《账号资源与密钥清单》） |

**阅读顺序**：§2 环境矩阵 → §4 密钥 → §5 部署 → §6 发布时机 → §7 监控 → §9 应急。
上线前务必逐项过 **§11 遗留风险**。

---

## 二、环境矩阵

四驱动开关（`DB_DRIVER` / `QUEUE_DRIVER` / `STORAGE_DRIVER` / `PROVIDER_MODE`）决定「跑什么」，代码零改动：

| 环境 | 用途 | DB | Queue | Storage | Provider | 编排文件 |
| --- | --- | --- | --- | --- | --- | --- |
| **本地零依赖** | 功能开发 / e2e | sqlite | memory | local | mock | 无（不需要 Docker） |
| **本地依赖** | 逼近生产的联调 | mysql | redis | minio | mock | `docker-compose.yml`（只有依赖） |
| **灰度/生产** | 单楼试运营 | mysql | redis | cos（或 local） | real | `docker-compose.prod.yml`（依赖 + 应用） |

⚠️ **两套 compose 的分工**：
- `docker-compose.yml`（开发）**只起依赖**（MySQL / Redis / 可选 MinIO），应用在宿主机上用 ts-node 跑 —— 改代码即时生效。
- `docker-compose.prod.yml`（生产）**连应用一起起**，镜像不可变、可回滚。
- 两者容器名带 `-prod` 后缀区分，同机同时起不互相顶掉。

---

## 三、部署拓扑

```
                    Internet / 内网
                          │
                          │ HTTPS（生产必须；见 §5.3）
                          ▼
            ┌─────────────────────────────┐
            │  admin  (nginx:80)          │  ← 唯一对外入口
            │  · 托管运营后台静态产物      │
            │  · /api/   → api:3000       │
            │  · /static/ → api:3000      │
            └──────────┬──────────────────┘
                       │ abox-net（内部 bridge，依赖不暴露宿主端口）
          ┌────────────┴────────────┬─────────────────┐
          ▼                         ▼                 ▼
   ┌─────────────┐          ┌─────────────┐   ┌─────────────┐
   │ api:3000    │          │ mysql:3306  │   │ redis:6379  │
   │ NestJS      │─────────▶│ 卷 mysql-data│   │ 卷 redis-data│
   │ init:true   │          └─────────────┘   └─────────────┘
   │ 非 root     │                 ▲                 ▲
   └─────────────┘                 │                 │
          │                  ┌─────┴─────────────────┴────┐
          └──────────────────│ 服务端专属：定时任务 ×8      │
                             │（@Cron 走 timeZone=Asia/    │
                             │  Shanghai，与容器时区无关）  │
                             └────────────────────────────┘
```

**关键设计**：
- `mysql` / `redis` **不映射宿主端口** —— 只有 `admin` 暴露（`ADMIN_PORT`，默认 8080）。要连库走 `docker compose exec`，需要长期外部访问再单独评估。
- `api` 带 `init: true`，与 `app.enableShutdownHooks()` 配套：容器停止时 `QueueService` / `KvService` 的关闭钩子才会真正执行。
- 小程序端**不在此拓扑内**：它由微信开发者工具上传发布，只依赖 `admin` 暴露的 HTTPS 域名。

---

## 四、生产环境变量与密钥

### 4.1 准备

```bash
cp .env.example .env.prod     # .env.prod 已在 .gitignore 中，绝不入库
# 按本表逐项填写
```

### 4.2 必填清单（灰度上线前）

| 变量 | 生产取值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `production` | ⚠️ 同时关掉 e2e 时钟注入（见 §11） |
| `APP_VERSION` | git sha | 由 `deploy.sh` 自动注入，**别手填** |
| `DB_DRIVER` / `QUEUE_DRIVER` | `mysql` / `redis` | 生产恒为这两个 |
| `MYSQL_ROOT_PASSWORD` | 强口令 | ⚠️ **必填**，缺失时 compose 直接拒绝启动 |
| `DB_DATABASE` | `abox_onebox` | |
| `REDIS_PASSWORD` | 强口令 | 留空 = 不开鉴权（仅限内网可信时） |
| `JWT_SECRET` | 32+ 位随机串 | ⚠️ 改掉 `change_me_before_go_live`；泄漏 = 可伪造任意用户 |
| `WX_MINI_APPID` / `WX_MINI_SECRET` | 微信后台 | |
| `WXPAY_MCH_ID` / `WXPAY_API_V3_KEY` / `WXPAY_SERIAL_NO` / `WXPAY_PRIVATE_KEY_PATH` | 商户平台 | 四件套缺一不可 |
| `WXPAY_NOTIFY_URL` | `https://<域名>/api/v1/payments/wxpay/notify` | ⚠️ 必须是**公网 HTTPS** |
| `FLEX_PLATFORM_*` | 灵活用工平台 | 佣金代发 + 个税代扣（C11） |
| `PROVIDER_MODE` | `real` | 切成真实微信/灵活用工 |

### 4.3 三条纪律

1. **密钥只进 `.env.prod`**：不写进 compose、不写进代码、不贴进聊天工具。`.dockerignore` 已把 `.env*` 排除在构建上下文外 —— **别改它**。
2. **最小权限**：数据库口令只给应用用；腾讯云子账号按需授权；微信支付证书用商户私钥文件挂载（不要把私钥打进镜像层 —— 镜像层删不掉）。
3. **轮换**：`JWT_SECRET` 轮换会使全部登录态失效（后台 + 小程序），选在**禁发窗口**做（§6）。

---

## 五、部署流程

### 5.1 首次部署核对（**逐项打勾，别跳**）

> ⚠️ 镜像与编排文件**从未在真机执行过**（开发机无 Docker）。首次上机请把它当成一次「联调」，而不是一次例行发布。

| # | 检查项 | 判据 |
| --- | --- | --- |
| 1 | Docker 20.10+ / Compose V2 | `docker compose version` |
| 2 | `.env.prod` 已按 §4.2 填全 | 启动不报「缺少 MYSQL_ROOT_PASSWORD」 |
| 3 | 域名与 HTTPS 已就绪 | `curl -I https://<域名>/` 返回 200（§5.3） |
| 4 | 微信支付回调地址已备案为公网 HTTPS | 商户平台能保存成功 |
| 5 | **镜像能构建成功** | `./scripts/deploy.sh --build-only` |
| 6 | **迁移能在生产库执行** | `deploy.sh` 第 5 步输出 `Migration Init1700000000000 has been executed successfully` |
| 7 | **readiness 转 ready** | `./scripts/healthcheck.sh` 输出 `[结果] 通过` |
| 8 | 备份可用 | `./scripts/backup-db.sh` 产出非空 `.gz` |
| 9 | **回滚演练成功** | 发一版 → `./scripts/rollback.sh` → 再发回来（M5 验收标准 #4：10 分钟内可回退） |

### 5.2 日常发布

```bash
# 1) 取最新代码、确认在 main 分支且工作区干净
git pull

# 2) 发布（脚本自动：预检 → 备份 → 迁移 → 起服务 → 健康验证 → 记录可回滚版本）
./scripts/deploy.sh                # tag 默认取 git short sha
# 或指定版本号：
./scripts/deploy.sh --tag v1.2.3
```

脚本会做的 7 件事：

| 步骤 | 动作 | 失败时 |
| --- | --- | --- |
| 1 | 预检（docker / compose 文件 / `.env.prod` / 取 tag） | 直接停 |
| 2 | **迁移前备份数据库** | 只警告（首次部署库还是空的，属正常） |
| 3 | 起依赖（mysql / redis） | 停 |
| 4 | 构建 api + admin 镜像 | 停 |
| 5 | **执行数据库迁移** | 停 |
| 6 | `up -d --force-recreate api admin` | 停 |
| 7 | 轮询 readiness（默认 90s） | 打印日志排查命令 + 回滚命令后停 |

**为什么不自动回滚**：迁移可能已经执行。此时把代码退回旧版、表结构却停在新版，属于「半新半旧」——往往比「新版本 + 已知故障」更难判断。所以脚本停下来把决定权交给运维（与项目「不做静默降级」的一贯取舍一致）。

### 5.3 HTTPS 与域名

`docker-compose.prod.yml` 里 `admin` 只开了 HTTP（`ADMIN_PORT`，默认 8080）。生产必须前置 HTTPS，两种常见做法：

| 做法 | 适用 | 要点 |
| --- | --- | --- |
| 宿主机 nginx/Caddy 反代 | 已有网关 | 把 `443` 反代到 `127.0.0.1:8080`；证书自动续期用 certbot/Caddy |
| 云负载均衡（CLB/ALB） | 上云 | 后端组指向 8080；健康检查路径填 `/api/v1/health` |

⚠️ **微信要求**：小程序请求域名 + 支付回调域名都必须是 **已备案的 HTTPS 域名**，且在小程序后台「服务器域名」白名单里登记。HTTP 或 IP 会被拒。

### 5.4 灰度发布（单楼）

按 M5 计划，灰度 = **一个办公楼真实闭环跑 3 天**：

1. 后台（`P37` 楼栋管理）只给**目标楼**开团，其余楼保持未开团；
2. 观察 3 天，每天核对 4 个数：订单数、结算等式、佣金、退款链路（§10 日巡检）；
3. 无 P0 缺陷、P1 ≤ 3 且有规避方案 → 再放量。

⚠️ **不要用「多开几栋楼」当压测**：M5 的 5.2（500 单/日无超时）尚未执行，见 §11。

### 5.5 回滚

```bash
./scripts/rollback.sh                       # 回滚到 .deploy-state 里的上一版
./scripts/rollback.sh --tag v1.2.2          # 指定版本
./scripts/rollback.sh --with-migrate-revert # 同时回退一次迁移（危险，见下）
./scripts/rollback.sh --dry-run             # 先看它打算做什么
```

| 要点 | 说明 |
| --- | --- |
| **默认不回退迁移** | `migration:revert` 的 `down()` 多为 drop 列/表，**不可逆**。多出来的列不影响旧代码读，通常留着更安全 |
| **依赖旧镜像在本机** | 回滚是「用旧 tag 重新起容器」，不重新构建。⚠️ **永远不要在生产机执行 `docker image prune -a`** —— 那会把回滚能力一起删掉 |
| 回滚前自动备份 | 脚本会先跑一次 `backup-db.sh`，万一回滚本身有问题还有退路 |
| 回滚后更新状态 | `.deploy-state` 会记 `ROLLED_BACK_FROM`，可再滚回去 |

---

## 六、发布时机：禁发窗口

跑批与截单是这个系统里**唯一不能被打断**的东西。以下时段禁止发布、禁止重启、禁止改配置：

| 时段（北京时间） | 为什么 |
| --- | --- |
| **T-1 23:30 – 24:30** | 截单窗口（`cutoff`，00:00 触发）—— 取消未支付 + 锁定已支付 + 推备料量，中断会导致「有的单锁了、有的没锁」 |
| **T 日 10:00 – 12:30** | 出餐 → 集散打包 → 配送 → 11:30 送达高峰 |
| **T 日 13:30 – 14:30** | 自动确认（`auto-confirm`，14:00）—— 计佣基数在此定格 |
| **T+1 01:30 – 04:30** | 日结跑批（02:00 佣金入账 / 02:10 供应商应付 / 04:00 对账） |

**可发窗口**（建议）：`T 日 15:00 – 22:00`，或 `T+1 05:00 – 23:00`。

⚠️ 容器重启会触发 `enableShutdownHooks()` 的优雅关闭，但**跑批是 `@Cron` 触发的独立流程，不等在途请求**。所以「优雅关闭」不等于「可以随便重启」——仍须避开上表窗口。

---

## 七、监控与探针

### 7.1 两级探针（职责必须分开）

| 端点 | 语义 | 检什么 | 失败时该做什么 |
| --- | --- | --- | --- |
| `GET /api/v1/health` | **存活**（liveness） | 什么都不检，进程能应答即 ok | **重启容器** |
| `GET /api/v1/health/ready` | **就绪**（readiness） | ① DB 真跑一条 `SELECT 1`（含耗时）② **3 个队列消费者是否都注册上了** | **摘流量**，**不要重启** |

```bash
./scripts/healthcheck.sh              # 从容器内查一次（默认查 readiness）
./scripts/healthcheck.sh --watch 60   # 轮询 60s
./scripts/healthcheck.sh --liveness   # 只查存活
./scripts/healthcheck.sh --url https://<域名>/api/v1   # 从网关侧查
```

**为什么必须分开**：若 liveness 也检 DB，DB 一抖动 → 探针全红 → 编排器重启所有容器 → 重启期间没人服务、DB 压力更大 → **重启风暴**。DB 挂了重启应用治不好，那是「摘流量 + 告警」的事。

**为什么 readiness 检的是「消费者齐不齐」而不是「Redis 通不通」**：Redis 连通性在**启动期已 fail-closed 验过**（连不上直接拒绝启动）；而「消费者没注册上」是启动期验不到、且失败后**完全静默**的故障 —— 入队照常成功、队列计数照常显示，但任务**永远无人消费**。

**出参示例**（免鉴权，故出参按「会被人看见」设计 —— 失败原因只写服务端日志）：

```json
{"code":0,"data":{"status":"ready",
  "checks":{"db":{"ok":true,"latencyMs":3},
            "queue":{"ok":true,"driver":"redis","durable":true,"consumers":3,"consumersTotal":3}},
  "uptimeSec":4211,"version":"0e6b1a9"}}
```

### 7.2 定时任务时刻表（值班用）

> 口径唯一真相 = 代码里的 `TASK_SCHEDULES`；后台 `GET /admin/schedule`（S1）可查实时时刻表与「未实装」标注。

| 任务 | 触发（北京时间） | 目标日 | 做什么 |
| --- | --- | --- | --- |
| `meal-publish` | T-1 14:00 | **明日** | 开团：次日套餐上架 |
| `cutoff` | T-1 24:00 | 今日 | 截单：取消未支付 + 锁定已支付 + 推备料量 |
| `delivery-generate` | T 00:30 | 今日 | 按楼群生成配送单 |
| `auto-confirm` | T 14:00 | 今日 | 自动确认收货 + **计佣（写 pending）** |
| `commission-settle` | T+1 02:00 | 昨日 | **佣金入账**到团长余额 |
| `supplier-share` | T+1 02:10 | 昨日 | 生成供应商应付结算单（不拨款） |
| `reconciliation` | 每日 04:00 | 昨日 | 对账（核**完整自然日**） |
| `leader-expire` | 每日 03:00 | — | 见习团长 30 天未促单失效 |

⚠️ `meal-publish` 与 `auto-confirm` **同为 14:00 但目标日不同**（明日 / 今日）—— 这是刻意的，改时刻时别把两者写成一样。

**补跑（跑批失败的救火入口）**：

```bash
POST /admin/schedule/{task}/run        # body 可带 {"date":"2026-09-17"}
```

- `date` 省略时按该任务的 `dateKind` 推目标日；
- 未知任务名 / 未实装 / 非法日期（如 `2026-02-30`）一律 `10001`；
- **补跑是幂等的**（以 `meal_date` 为键），重复执行不会重复扣款/重复计佣。

### 7.3 队列观测

```bash
GET /admin/queue          # Q1：三队列的等待/进行/完成/失败计数 + 驱动 + 是否持久化
```

⚠️ `durable:false` 是**重点**：它回答「现在这个队列会不会丢任务」。生产必须 `redis` 驱动（`durable:true`）；`memory` 驱动重启即丢，仅用于本地。

**死信**（重试耗尽 = 这件事已经没人再管了）会写 `ab_operation_log`：

```sql
SELECT * FROM ab_operation_log WHERE module='queue' AND action='任务重试耗尽' ORDER BY id DESC;
```

查到这个就要**按 payload 人工核对业务对象最终状态**，必要时手工重跑（支付/退款类任务幂等，可安全重放）。

### 7.4 日志

```bash
docker compose -f docker-compose.prod.yml logs -f --tail=200 api
docker compose -f docker-compose.prod.yml logs -f --tail=200 admin
```

- 容器日志已限制大小（`max-size: 50m` × 5 个文件）—— 不加这条，json-file 驱动会把磁盘打满，而那是**服务全挂**。
- 每条响应带 `requestId`（优先沿用 `X-Request-Id`），排查时用它串起一次请求的全部日志。
- `NODE_ENV=production` 下已关掉 e2e 时钟注入的告警噪音。

### 7.5 建议告警项

| 告警 | 触发 | 严重度 |
| --- | --- | --- |
| readiness 连续 3 次失败 | 依赖故障 | P0 |
| 对账不平 | `ab_operation_log` 出现 `module='finance' AND action='对账不平'` | P0（钱对不上） |
| 队列死信 | `module='queue' AND action='任务重试耗尽'` | P1 |
| 跑批未执行 | 时刻表某任务在应触发后 10 分钟无日志 | P1 |
| 容器重启次数 | `docker inspect` 重启计数增长 | P1 |

---

## 八、备份与恢复

### 8.1 备份

```bash
./scripts/backup-db.sh                  # → ./backups/abox-<库名>-<UTC>.sql.gz，保留最近 14 份
./scripts/backup-db.sh --keep 30        # 改保留份数
./scripts/backup-db.sh --out /mnt/nas   # 落到另一块盘/NAS
```

- 用 `mysqldump --single-transaction`：InnoDB 下拿一致性快照且**不锁表** —— 生产库在跑批时段也不能被锁。
- 密码走**容器内环境变量**，不进宿主命令行（否则同机任何进程都能从 `ps` 读到）。
- 保留策略只作用于 `./backups/` 内、匹配 `abox-*.sql.gz` 的文件。

**建议节奏**（灰度期）：

| 时机 | 方式 |
| --- | --- |
| 每次 `deploy.sh` 前 | 脚本自动（第 2 步） |
| 每日跑批完成后（05:00） | cron 调 `backup-db.sh` |
| 每周 | 复制一份到异地/对象存储（`.gz` 直接被带走即可） |
| 变更表结构前 | 手工再跑一次，并**记录恢复演练结果** |

### 8.2 恢复

```bash
./scripts/restore-db.sh backups/abox-abox_onebox-20260917T080000Z.sql.gz --yes
```

⚠️ **这是破坏性操作**：`mysqldump --databases` 的产物自带 `DROP TABLE IF EXISTS` + `CREATE TABLE`，灌进去 = **整库覆盖**，现有数据不可找回。因此：

- 必须显式 `--yes`（缺省只打印「将发生什么」然后退出）；
- 脚本会**自动再备份一次当前库**（除非 `--no-pre-backup`），万一恢复的备份本身是坏的还有退路；
- 恢复后立即 `./scripts/healthcheck.sh` + 后台抽样查单。

### 8.3 演练要求

**每季度至少恢复演练一次**，记录：备份文件、恢复耗时、抽样校验结果。
没演练过的备份**不算备份** —— 你无法知道它能不能恢复。

---

## 九、应急预案

### 9.1 截单跑批失败（P0）

**表现**：`T-1 24:00` 后订单仍是 `pending_payment`，或套餐 `canOrder` 仍为 true。

```bash
# 1) 查是不是没跑（看日志与锁）
docker compose -f docker-compose.prod.yml logs --since 30m api | grep cutoff
# 2) 立即补跑（幂等，可安全重放）
curl -X POST https://<域名>/api/v1/admin/schedule/cutoff/run -H "Authorization: Bearer <admin-token>"
# 3) 补跑后核对：当日未支付单是否已取消、已支付单是否已锁定
```

⚠️ 若在截单后、补跑前已有用户成功下单 —— 那是 `isOrderable` 窗口的前置校验失守（更严重），立即**停止该楼开团**并上报。

### 9.2 支付回调异常

**表现**：用户已付款但订单仍是待支付。

```bash
# 1) 查回调日志（验签失败 / 重复通知 / 网络）
docker compose -f docker-compose.prod.yml logs --since 30m api | grep -i "wxpay\|notify"
# 2) 查支付单状态
#    后台订单详情页；或按 orderNo 查 ab_payment
# 3) 付款确认无果 → 走后台人工补单（D10 手动改单）或按 C6 强制退款
```

⚠️ 回调**幂等**（同一 `transaction_id` 重复通知不会重复入账），所以重复投递是安全的。

### 9.3 队列积压 / 死信

```bash
curl https://<域名>/api/v1/admin/queue -H "Authorization: Bearer <admin-token>"
```

- **waiting/active 持续增长**：消费者没起来 → 查 readiness 的 `queue.consumers` 是否 3/3；查 `queues` 日志。
- **failed > 0**：查 `ab_operation_log` 的 `module='queue'`，按 payload 逐个核对业务对象。
- **driver 是 memory**：⚠️ 生产配错了 —— 改 `QUEUE_DRIVER=redis` 重启（重启即丢积压任务，先核对积压）。

### 9.4 Redis 失联

**表现**：服务起不来（fail-closed 设计：`QUEUE_DRIVER=redis` 连不上直接拒绝启动）。

```bash
docker compose -f docker-compose.prod.yml ps redis
docker compose -f docker-compose.prod.yml logs --tail=100 redis
# 数据卷 redis-data 持久化了 AOF，重启 Redis 即可
docker compose -f docker-compose.prod.yml restart redis
```

⚠️ **不要**为了「先让它起来」把 `QUEUE_DRIVER` 改成 `memory` —— 那会让所有队列任务变成进程内、重启即丢，退避重试与死信全部失效，且**没有任何报错**。

### 9.5 数据库故障

| 情况 | 处置 |
| --- | --- |
| MySQL 容器挂了 | `docker compose up -d mysql`；readiness 会先变 `not_ready`（api 不重启，这是设计） |
| 数据损坏 | `restore-db.sh` 恢复到最近备份 → **会丢备份点之后的数据**，先评估业务影响再动手 |
| 磁盘满 | `df -h`；清 `docker system df` 的无用镜像（⚠️ **别用 `prune -a`**，会删掉回滚用的旧镜像）；清旧日志 |

### 9.6 服务不可用 / 回滚决策

```
现象：用户打不开 / 接口大面积 5xx
  ↓
① ./scripts/healthcheck.sh          → readiness 说什么？
② 看日志定位：代码问题 还是 依赖问题？
  ├─ 依赖问题（DB/Redis）→ 修依赖，**不回滚**（回滚治不好依赖）
  └─ 代码问题 → ③
③ 判断本次发布是否含「不兼容的数据迁移」
  ├─ 没有 → ./scripts/rollback.sh           （10 分钟内可回退，M5 验收标准 #4）
  └─ 有   → 先评估「旧代码 + 新表结构」是否可跑；不确定就**停服 + 上报**，
             不要盲目回滚制造半新半旧
```

---

## 十、日常巡检清单

**每日**（建议 09:00 与 17:00 各一次）：

- [ ] `./scripts/healthcheck.sh` → 通过
- [ ] `GET /admin/queue` → `durable:true`、无增长中的 failed
- [ ] 查 `ab_operation_log`：有无 `对账不平` / `任务重试耗尽`
- [ ] 跑批是否按时执行（对照 §7.2 时刻表）
- [ ] 当日报错数、订单数是否符合预期
- [ ] 磁盘余量 `df -h`（别等 write 失败才发现）

**每周**：

- [ ] 结算等式抽查（单份：协商供价 + 场地费 + 打包人工 + 配送费 + 佣金 + 毛利 = 25.80）
- [ ] 提现审批积压（后台 P34）
- [ ] 备份文件可用性抽查（随机取一份，`gunzip -t` 验完整性）
- [ ] 容器重启次数与镜像版本（`/health/ready` 回显的 `version` 是否等于预期发布版本）

**每月**：

- [ ] 恢复演练（§8.3）
- [ ] 密钥轮换评估
- [ ] 依赖安全更新评估

---

## 十一、遗留风险与上线前必验项

> **这一节必须读完再上线。** 以下都是本次交付中**如实标注**的未验证项，不是「大概没问题」。

| # | 风险 | 影响 | 上线前必须做什么 |
| --- | --- | --- | --- |
| R1 | **Docker 产物从未真机执行**（开发机无 Docker）：两个 Dockerfile、`docker-compose.prod.yml`、`nginx.conf` | 构建可能失败（pnpm workspace + alpine） | 按 §5.1 逐项过；先在一台测试机完整跑一次 |
| R2 | **生产库从未执行过迁移**（开发全程用 sqlite 的 `synchronize` 自动建表）。⭐ **M5-2 升级**：**「迁移推演 ≡ 实体结构」已由 `schema:parity` 门禁机械保证**（全库 27 表 / 394 列逐表逐列对账，且检查器**每次运行自证能报出人为缺口**）；⚠️ **但「结构对」≠「跑得通」** —— 本机无 Docker / 无 MySQL，**MySQL 上真跑一次仍未做过** | 首次迁移可能因 **MySQL 方言差异**（如 `information_schema` 守卫行为、`JSON` 列、字符集 / `ENGINE` 子句）失败；⚠️ 另注：DDL 已按 #76 补齐为 **2 支迁移**（`1700000000000-init` 25 表 + `1700000000001-parity-fix` 补 2 表 9 列 1 索引），**两支都要 applied** 才等于实体结构 | 首次部署前在**空库**上预演一次；`typeorm migration:show` 必须列出 **两支** 且都为 `[X]`（`Init1700000000000` 与 `ParityFix1700000000001`）；再跑一次 `gate.mjs schema:parity` 确认结构一致 |
| R3 | **e2e 跑的是 sqlite + memory 驱动**，生产是 mysql + redis | 驱动差异带来的问题 e2e 覆盖不到 | 在灰度环境跑一遍核心链路（下单 → 支付 → 出餐 → 确认 → 结算） |
| R4 | **微信支付真实回调未验证**（无商户号/证书） | 支付链路上线即断 | 拿到商户号后先在**测试商户**跑通回调验签 |
| R5 | **未做压测**（M5 5.2：500 单/日无超时） | 峰值下性能未知 | 灰度期观察真实峰值；别用「多开楼」代替压测 |
| R6 | **HTTPS / 域名 / 备案未配** | 微信拒绝请求与回调 | §5.3 |
| R7 | 镜像未瘦身（含全量 devDeps，体积偏大） | 拉取慢、占盘 | 上线后优化（`pnpm deploy` 或分层裁剪），**不要在上线当口改** |
| R8 | 台账号/云资源/灵活用工开户未到位 | 佣金代发、个税代扣无法真实执行 | 见《账号资源与密钥清单》 |
| R9 | **食品经营许可证（热食类制售）未下** | 合规风险，正式经营前必须解除 | 见《资质与合规》 |

### 关于「优雅关闭」的一条运维常识

`app.enableShutdownHooks()` 已开启（M5-0 修正，此前 `onModuleDestroy` 写了却**从未执行**）。它带来的一个现象要知道：

> 容器收到 `SIGTERM` 后走完关闭流程，Node 会**以信号码结束进程** ——
> Linux 容器里退出码是 **143**（128+15），Windows 开发机上是 **1**。
> 这**不是崩溃**。编排器本来就按「信号导致的退出」处理正常停机。

排查重启原因时，别只看退出码非 0 就判定「服务挂了」——先看它是不是一次正常停机。

---

## 十二、变更记录

| 日期 | 版本 | 变更 | 作者 |
| --- | --- | --- | --- |
| 2026-09-17 | v1.0 | 首版：M5-0 部署运维基座 —— 两级探针（liveness/readiness）+ 优雅关闭、双镜像与生产编排、部署/回滚/备份/恢复/探针五脚本、禁发窗口、应急预案、遗留风险 9 条 | 项目总监 |
| 2026-09-17 | v1.0.1 | **M5-2 同步：R2 升级** —— 「迁移推演 ≡ 实体结构」已由 `schema:parity` 门禁机械保证（27 表 / 394 列）；⚠️ 但**不写成已验**（本机无 Docker/MySQL，MySQL 真跑仍待空库预演）；R2 的「上线前必须做什么」补明 **两支迁移都要 applied** + 用 `migration:show` 核对 + 复跑 `schema:parity` | 项目总监 |

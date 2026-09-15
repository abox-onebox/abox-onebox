# ABox 一盒 · 本地开发手册 v1.0

> 目标：**不依赖任何云资源**，在本机把 M1–M5 的业务代码开发完并自测通过；
> 云服务器就绪后，只改环境变量即可切换到生产形态部署。

---

## 一、一句话结论

| 能力 | 本地能否开发 | 靠什么 |
| --- | --- | --- |
| 后端全部业务逻辑（12 域） | ✅ 完全可 | NestJS + TypeORM |
| 数据库（24 张表） | ✅ 完全可 | SQLite（零安装）或 Docker MySQL8 |
| 缓存 / 队列 / 定时任务 | ✅ 完全可 | 进程内队列（或 Docker Redis7） |
| 微信登录 | ✅ 完全可 | Mock Provider（`code=dev:1001`） |
| 微信支付（下单→支付→回调） | ✅ 完全可 | Mock Provider（自动回调 / 手动触发） |
| 图片上传 | ✅ 完全可 | 本地磁盘 + `/static` 静态服务 |
| 订阅消息 | ✅ 完全可 | Mock（打日志 + 落 `ab_message`） |
| 灵活用工出款（C11） | ✅ 完全可 | Mock（生成批次 + 导出 CSV） |
| 后台 Web / 小程序 | ✅ 完全可 | Vite / uni-app 本地热更 |
| **真机微信登录 / 真机支付 / 备案域名** | ❌ 需云资源 | 小程序 AppID + 备案域名 + 支付商户号 |

**结论：约 90% 的工作量可以在本地完成**，只剩「真机端到端联调」必须等云资源与账号就绪。

---

## 二、前置条件

| 项 | 要求 | 本机状态 |
| --- | --- | --- |
| Node.js | ≥ 20（推荐 22） | ✅ 22.22.2 |
| pnpm | ≥ 9 | ✅ 经 corepack 自动就绪（无需单独安装） |
| Docker Desktop | 可选（走「完整模式」才需要） | ⬜ 未安装 |

> **pnpm 无需手动安装**：仓库 `package.json` 已声明 `packageManager: pnpm@9.0.0`，
> corepack 会在首次执行时自动下载对应版本。

---

## 三、两种运行模式

模式由 `.env` 里的**驱动开关**决定，**代码零改动**：

### 模式 A · 零依赖（推荐先用这个）

不需要 Docker、不需要任何云账号：

```env
DB_DRIVER=sqlite          # 本地文件数据库，首次启动自动建 24 张表
QUEUE_DRIVER=memory       # 进程内队列
STORAGE_DRIVER=local      # 图片落 ./data/uploads
PROVIDER_MODE=mock        # 微信/支付/灵活用工全部走假实现
```

### 模式 B · 完整（贴近生产）

装了 Docker Desktop 后：

```env
DB_DRIVER=mysql
QUEUE_DRIVER=redis
STORAGE_DRIVER=local      # 或 minio（docker compose --profile oss up -d）
PROVIDER_MODE=mock        # 真实微信账号就绪后再改 real
```

---

## 四、启动步骤

### 4.1 首次初始化

```bash
cd abox-onebox
cp .env.example .env                 # 复制环境变量样例
# 编辑 .env：按需改 DB_DRIVER / QUEUE_DRIVER / STORAGE_DRIVER / PROVIDER_MODE
pnpm install                         # 安装依赖（首次约 3–5 分钟）
pnpm build:shared                    # ⚠️ 必做：构建 @abox/shared-* 的 dist 产物
```

> **为什么必须先 `pnpm build:shared`**
> `@abox/shared-types` / `@abox/shared-utils` 是「源码包」，Vite 侧可直接吃 `.ts`；
> 但 api-server 是 **tsc/CJS** 编译，若把跨包源码拉进编译单元，会因文件不在 `rootDir` 下而报
> `TS6059`，导致 `nest build` / `typecheck` 直接失败。
> 因此这两个包改为**先编译出 `dist`（js + d.ts）**，api-server 通过 node_modules 包解析消费。
> 仓库已把这一步前置到 `dev:api` / `dev:mp` / `dev:admin` / `build:*` / `typecheck` 脚本里，
> 一般情况下你不需要手动执行；只有在单独跑 `nest build`、或新拉代码后直接跑 `tsc` 时才需要。

**模式 B 追加**：

```bash
pnpm docker:up                       # 起 MySQL8 + Redis7
```

### 4.2 建表与导入种子

```bash
# 模式 A（sqlite）：无需迁移，启动 API 时自动建表，直接导种子
pnpm db:seed

# 模式 B（mysql）：先跑迁移再导种子
pnpm db:migrate
pnpm db:seed
```

种子内容：5 楼群 · 12 办公楼 · 5 团长 · 4 出餐供应商 + 6 备选 · 4 集散中心 · 12 菜品 · 7 套餐 · 18 项配置。

### 4.3 启动

```bash
pnpm dev:api      # 后端 → http://localhost:3000/api/v1   文档 → /docs
pnpm dev:admin    # 运营后台 → http://localhost:5173
pnpm dev:mp       # 小程序 → 微信开发者工具导入 apps/miniprogram/dist/dev/mp-weixin
```

启动日志会打印当前驱动，便于确认模式：

```
[BootStrap] 驱动：db=sqlite · queue=memory · storage=local · provider=mock
[BootStrap] 当前为 MOCK 模式：登录用 code=dev:1001；支付成功自动回调
```

### 4.4 本地链路自测（30 秒）

```bash
# 1) 健康检查
curl http://localhost:3000/api/v1/health
# → {"code":0,"message":"ok","data":{"status":"ok",...}}

# 2) Mock 登录（拿 token）
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' -d '{"code":"dev:1001"}'
# → data.token / data.isLeader=true / data.leader.level="chief" / balance="575.86"

# 3) 带 token 取当前用户
curl http://localhost:3000/api/v1/auth/me -H "Authorization: Bearer <token>"
```

> 预期：金额字段一律是**两位小数定长字符串**（如 `"575.86"`）。
> 这是 `decimalTransformer` 的职责 —— MySQL 驱动返回 string、SQLite 返回 number，
> 不做归一化会导致本地与云端分账校验不一致。

---

## 五、Mock 使用说明

### 5.1 登录

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"code":"dev:1001"}'
```

`code` 传 `dev:<任意标识>` 可**稳定指定身份**：

| code | 得到的账号 | 说明 |
| --- | --- | --- |
| `dev:1001` | 李明 | 首席团长（种子中的标杆账号） |
| `dev:1002` | 王芳 | 金牌团长 |
| `dev:1005` | 陈强 | 见习团长（30 天失效规则观察对象） |
| `dev:newbie` | 全新用户 | 每次登录同一账号，用于测试首登建号 |

不传 `dev:` 前缀时，`code` 会被哈希成稳定 openid（同一 code 恒定同一账号）。

### 5.2 支付

`PROVIDER_MODE=mock` 下下单后会**自动触发支付成功回调**（默认延迟 800ms）：

```env
MOCK_PAY_AUTO_SUCCESS=true    # 想要手动控制就改 false
MOCK_PAY_CALLBACK_DELAY_MS=800
```

关掉自动回调后，可用调试端点手动触发（仅 mock 模式暴露）：

```
POST /api/v1/payments/mock/paid   { "orderNo": "AB202609150001" }
```

### 5.3 图片上传

`STORAGE_DRIVER=local` 时，文件写入 `./data/uploads/`，通过 `http://localhost:3000/static/<key>` 访问。

---

## 六、常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm build:shared` | **构建共享包 dist**（跨包编译失败时先跑它） |
| `pnpm dev:api` / `dev:admin` / `dev:mp` | 分别启动后端 / 后台 / 小程序（已自动前置 build:shared） |
| `pnpm db:migrate` / `db:seed` | 迁移 / 种子（仅 mysql 模式需要迁移） |
| `pnpm typecheck` / `lint` / `test` | 类型检查 / 静态检查 / 单测（= CI 前三道门禁） |
| `pnpm format:check` | 校验格式（**CI 用的是这个**；`pnpm format` 是就地改写，别在 CI 用） |
| `pnpm docs:sync` | 把工作区根目录的权威文档同步进 `docs/`（自动淘汰旧版本） |
| `pnpm docker:up` / `docker:down` | 起停本地 MySQL + Redis |
| `pwsh scripts/setup.ps1` | Windows 一键初始化（自动识别是否装了 Docker） |

**Git 钩子（husky）**：`pnpm install` 会自动装钩子（`prepare` → `scripts/setup-husky.mjs`）。
装完后每次提交会：

- `pre-commit` → `lint-staged`（对暂存文件跑 `eslint --fix` + `prettier --write`）
- `commit-msg` → `commitlint`（强制 Conventional Commits，类型见 `commitlint.config.cjs`）

> 若提示跳过钩子安装，说明当前环境 PATH 里没有 `git`；git 可用后在仓库根执行 `pnpm exec husky install` 即可。
> 提交信息写错格式会被拦下，用 `feat:` / `fix:` / `docs:` 等前缀重写即可。

---

## 七、切到云服务器时怎么改

只需替换 `.env`（**代码与文档均无需改动**）：

```env
NODE_ENV=production
DB_DRIVER=mysql
QUEUE_DRIVER=redis
STORAGE_DRIVER=cos
PROVIDER_MODE=real

DB_HOST=...            # 云数据库
REDIS_HOST=...
WX_MINI_APPID=...      # 小程序
WX_MINI_SECRET=...
WXPAY_MCH_ID=...       # 微信支付商户号 + 证书
WXPAY_API_V3_KEY=...
FLEX_PLATFORM_APP_ID=...   # 灵活用工平台（C11）
```

切换前检查清单：

- [ ] `PROVIDER_MODE=real` 前，`real-wx-pay.provider.ts` 的待办已补全（约 0.5 人天）
- [ ] `STORAGE_DRIVER=cos` 需先 `pnpm --filter api-server add cos-nodejs-sdk-v5` 并补实现
- [ ] 支付回调地址 `WXPAY_NOTIFY_URL` 已配为备案域名且公网可达
- [ ] 小程序后台把服务器域名加入 request 合法域名白名单

---

## 八、常见问题

**Q：`pnpm: command not found`**
用 corepack 自举：`corepack enable pnpm`，或在仓库目录内直接执行（corepack 会按 `packageManager` 字段自动拉取 pnpm 9）。

**Q：`pnpm install` 报 `NO_MATCHING_VERSION`（@dcloudio/...）**
uni-app 的 Vue3 系列发布在 `vue3` tag，版本号形如 `3.0.0-alpha-5020620260914001`，**必须带 `-alpha-` 前缀**。若报错请检查 `apps/miniprogram/package.json` 是否被改成了不带 alpha 的版本号。

**Q：sqlite 模式下看不到某张表**
sqlite 靠 `synchronize: true` 建表，改完 entity 重启 API 即可；如仍缺失，删除 `./data/abox-dev.sqlite` 重新启动。

**Q：`nest build` 报 `TS6059: File ... is not under 'rootDir'`**
共享包未构建。执行 `pnpm build:shared` 生成 `packages/*/dist` 后重试。
不要在 `apps/api-server/tsconfig.json` 里把 `@abox/*` 用 `paths` 指到 packages 源码 —— 那正是触发该错的原因。

> ⚠️ **同一个错配还会「污染源码目录」**：当文件落在 `rootDir` 之外时，tsc 会用 `../../` 回溯计算输出路径，
> 结果把 `.js` / `.js.map` **直接写进 `packages/*/src/`**（而不是报错后什么都不做）。
> 若在 `packages/shared-types/src/` 下看到 `.js` 文件，先删掉，再确认 `paths` 是否又被配回了源码。
> 正确产物只应出现在 `packages/*/dist/`。

**Q：`pool is closed` / `TypeError: Cannot find module '...better_sqlite3.node'`（sqlite 模式起不来）**
`better-sqlite3` 的原生二进制没落地（pnpm 10+ 会拦截依赖的构建脚本）。处理：
```bash
pnpm rebuild better-sqlite3
# 若仍不行，确认 pnpm-workspace.yaml 的 onlyBuiltDependencies 含 better-sqlite3
```
仓库已在 `pnpm-workspace.yaml` 里列全本项目需要构建的包，正常不会有此问题。

**Q：SQLite 报 `AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY`**
实体里不能把自增主键统一写成 `@PrimaryGeneratedColumn({ type: 'bigint' })`。
本项目已提供跨库工厂 `PkColumn()`（见 `entities/transformers.ts`）：sqlite → `integer`，mysql → `bigint`。新写实体请使用 `@PkColumn()`。

**Q：SQLite 报 `UNIQUE constraint failed`（明明名字是复合唯一）**
`@Index('uk_xxx', { unique: true })` 挂在**列上**只会约束该单列。复合唯一必须写在**类上**：
```ts
@Entity('ab_xxx')
@Index('uk_xxx', ['colA', 'colB'], { unique: true })
export class Xxx { ... }
```
（`ab_commission` / `ab_meal_assignment` / `ab_delivery_record` / `ab_supplier_dish_daily` 均已按此修正。）

**Q：`vue-tsc` 报 `Search string not found: supportedTSExtensions`（前端 typecheck 直接崩溃）**
`vue-tsc@1.8.x` 与 TypeScript ≥ 5.5 不兼容（它靠字符串匹配打补丁，TS 5.5 改了内部结构）。
**本项目已把 TypeScript 锁在 `~5.4.5`**（6 个 `package.json` 一致）。请勿随手升级到 5.5+；
若确需升级，必须同时把 `vue-tsc` 升到 `^2.x`，二者只能一起动。

**Q：照文档填了 `.env`，real 模式却静默不生效**
一律**以代码为准**：`apps/api-server/src/config/*.ts` 里的 `process.env.*` 才是唯一事实来源。
易错清单（左侧是错的、别用）：`DB_NAME`→`DB_DATABASE`、`WX_APPID`→`WX_MINI_APPID`、
`WX_SECRET`→`WX_MINI_SECRET`、`WXPAY_MCHID`→`WXPAY_MCH_ID`、`PORT`→`APP_PORT`、
`FLEX_PLATFORM_SECRET`→`FLEX_PLATFORM_APP_SECRET`、`FLEX_PLATFORM_FEE_RATE`→`FLEX_PLATFORM_SERVICE_FEE_RATE`。
直接 `cp apps/api-server/.env.example .env` 可避免手抄错。

**Q：CLI 脚本（`db:seed` / `db:migrate`）读不到 `.env`**
两处的读取顺序已统一为「`cwd/.env` → `../../.env`（仓库根兜底）」：
Nest 侧是 `ConfigModule.envFilePath`，CLI 侧是 `data-source.ts` 里的显式 `dotenv` 加载。
若你自己新写脚本，**不要**只用 `import 'dotenv/config'`（它只读 `cwd/.env`）。

**Q：`pnpm test` 显示通过，但其实一个测试都没跑**
这是"假绿"。jest 的 `rootDir` 若设为 `src`，`test/unit/**` 下的用例会被排除在外，
配合 `--passWithNoTests` 就会"成功且零覆盖"。
本项目 `apps/api-server` 的 jest 已改为 `rootDir: "."` + `testRegex: "(src|test)/.*\\.spec\\.ts$"`，
现在能真正跑到 `test/unit/order-state-machine.spec.ts`。**判断标准是看输出里的用例数，不是看退出码。**

**Q：MySQL 连不上**
先确认容器已起：`docker compose ps`；等 healthcheck 变 healthy（首次启动约 20–40 秒）。若端口被占用，改 `docker-compose.yml` 的映射端口并同步改 `.env`。

**Q：金额出现 100 倍误差**
DB 用「元」（DECIMAL），微信接口用「分」。转换只允许出现在 DTO ↔ Entity 边界，统一用 `packages/shared-utils` 的 `yuanToFen` / `fenToYuan`，禁止手写 ×100。

---

## 九、当前进度实况（2026-09-14）

> 表结构、配置层、Mock 层、登录闭环**已在本地跑通并验证**；业务控制器与服务仍是骨架。

### 9.1 已验证可用

| 项 | 验证方式 | 结果 |
| --- | --- | --- |
| 依赖安装 | `pnpm install` | ✅ 1476 包，lockfile 生成 |
| 24 张表建表 | sqlite `synchronize` | ✅ 无报错 |
| 种子导入 | `pnpm db:seed` | ✅ 5 楼群/12 楼/5 团长/10 供应商/4 集散/12 菜/7 套餐/27 明细/18 配置，**可重复执行** |
| 类型检查 | `tsc --noEmit` | ✅ 0 error |
| 生产构建 | `nest build` | ✅ `dist/main.js` 产出 |
| 服务启动 | `node dist/main.js` | ✅ 22 个模块全部初始化 |
| 健康检查 | `GET /api/v1/health` | ✅ 统一响应体 |
| Mock 登录 | `POST /auth/login {"code":"dev:1001"}` | ✅ JWT + `isLeader:true` + 李明(chief/12%/575.86) |
| 鉴权 | `GET /auth/me` + Bearer | ✅ 返回用户与团长信息 |
| 接口文档 | `GET /docs` | ✅ 200 |

### 9.2 待开发（全部可本地完成）

| 层 | 现状 |
| --- | --- |
| 业务控制器 | 仅 `auth`(2 路由) / `health`(1 路由) 有真实路由，其余为占位空类 |
| 业务服务 | 除 `auth.service.ts`(112 行) 外，均为 2–6 行骨架 |
| 待补的域 | 菜单开团、下单、支付与回调、退款三段式、分账与冲销、佣金结算与提现、配送、团长晋级/邀请、溯源、消息、统计、后台管理 |

---

## 十、与文档的对应关系

| 本手册涉及 | 权威文档 |
| --- | --- |
| 表结构（24 张） | `ABox一盒数据库ER设计v2.1.md` + `ABox一盒表结构评审意见v1.0.md` |
| 接口契约 | `ABox一盒接口规范v1.0.md` |
| 状态机与流转 | `ABox一盒订单状态机与全链路流转v1.0.md` |
| 种子数据 | `ABox一盒种子数据清单v1.0.md` |
| 结算口径（C1–C11） | `ABox一盒MVP优化交接包v1.3.md` |

---

*文档结束 · ABox 一盒 · 本地开发手册 v1.1 · 2026-09-14*
*(v1.1：新增 build:shared 前置步骤、本地链路自测、当前进度实况、4 条跨库/构建类 FAQ)*

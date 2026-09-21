# ABox 一盒 · 本地开发手册 v1.0

> 目标：**不依赖任何云资源**，在本机把 M1–M5 的业务代码开发完并自测通过；
> 云服务器就绪后，只改环境变量即可切换到生产形态部署。

---

## 一、一句话结论

| 能力 | 本地能否开发 | 靠什么 |
| --- | --- | --- |
| 后端全部业务逻辑（12 域） | ✅ 完全可 | NestJS + TypeORM |
| 数据库（**27** 张表） | ✅ 完全可 | SQLite（零安装）或 Docker MySQL8 |
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
DB_DRIVER=sqlite          # 本地文件数据库，首次启动自动建 **27** 张表
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
> 不做归一化会导致本地与云端金额校验不一致。

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
| `pnpm typecheck` / `lint` / `test` | 类型检查 / 静态检查 / 单测（三者都是 `gate.mjs` 里对应门禁的**同一条命令**） |
| `pnpm format:check` | 校验格式（`gate.mjs` 的 `format` 门禁用的就是这个；`pnpm format` 是就地改写，别在 CI 用） |
| `pnpm docs:sync` | 把工作区根目录的权威文档同步进 `docs/`（自动淘汰旧版本） |
| `pnpm docker:up` / `docker:down` | 起停本地 MySQL + Redis |
| `pwsh scripts/setup.ps1` | Windows 一键初始化（自动识别是否装了 Docker） |

### 6.1 ⚠️ 开发机沙箱内：`pnpm` 跑不了，改用仓库内 `scripts/gate.mjs`

**现象**：本机沙箱内 `pnpm -v` / `pnpm -C <dir> lint` **无任何输出、退出码为空**（corepack shim 路径被错拼成 `C:\\c\\Users\\...`）。
因此上表所有 `pnpm xxx` 在这台机器上**一律不可用**，但这**不影响任何验收口径** —— 绕开 pnpm 即可完整复刻 CI。

替代方案**只有一处**：仓库内 `abox-onebox/scripts/gate.mjs`（免 pnpm；自带 `all` / `verify` 别名，**含 e2e**）。

```powershell
# 跑全部门禁（node 用 managed 版本，勿用裸 node）
& "C:\Users\herma\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" abox-onebox\scripts\gate.mjs all
& "...\node.exe" abox-onebox\scripts\gate.mjs verify          # 4 道：seed → e2e:m1 → e2e:m2 → e2e:m3
& "...\node.exe" abox-onebox\scripts\gate.mjs --list          # 列出全部门禁与别名
& "...\node.exe" abox-onebox\scripts\gate.mjs typecheck:api   # 只跑某几道（快速回归）
```

> ⚠️ **工作区根 `tests/tools/gate.mjs` 已于 2026-09-21 删除** —— 它是一份只跑 12 道的**陈旧副本**，
> 缺 M5 期新增的**多道**「声明 ↔ 实现」对账门禁（`schema:parity` / `index:parity` / `state:audit` /
> `route:audit` / `security:scan` / `nav:consistency` / `doc:tables` / `dup:const` / `gate:parity`，
> 且**新旧两份的门禁数会各自独立漂移**），却自称「逐条复刻 CI 的**全部**作业」，
> 跑完打印「通过 12 / 失败 0」⇒ **会给出假绿的验收结论**。现行门禁执行器**只有一份**。
> 🔒 **新增 / 修改门禁一律改 `abox-onebox/scripts/gate.mjs`，不要在别处再写第二份实现**
> （「同一件事多份表述，而不被自动化执行的那一份必然是错的」）。
> 🔒 同理 **CI（`.github/workflows/ci.yml`）只许写 `node scripts/gate.mjs <别名>`**，
> 不许在 CI 里另列一套 `pnpm lint / typecheck / test / build` —— 那道门禁叫 `gate:parity`，它会在 CI 里红。

| 工具 | 用途 |
| --- | --- |
| `abox-onebox/scripts/gate.mjs` | **唯一**门禁执行器：`all` + `verify` 两个别名（含 e2e；条数见下方标记） |
| `tests/tools/verify-manifest.mjs` | 复核《基线冻结清单》全表「字节 + SHA-256」一致性 + 覆盖性 |
| `tests/tools/audit-contract.mjs` | 契约**静态**对账（与仓库内 `route:audit` 的**运行时反射**互为独立取数） |

> 📌 **门禁条数全文只在此处声明一次**（下面这行是**机器可读标记**，由 `gate:parity` 门禁校验；
> 加/删门禁后必须同步它，否则门禁会红并点名指出差多少）：
>
> `<!-- gate-count: all=20 verify=4 -->`
>
> ⚠️ **其余文档一律不要再写死条数** —— 本项目已反复出现「同一个数字写死在多处，改一处就悄悄错，
> 而没有任何工具会报错」。条数的**唯一真源**是 `gate.mjs` 自己：`node scripts/gate.mjs --json`。

**原理**：不经过 pnpm，直接把各包 `node_modules/.bin` 的 `.CMD` shim 塞进 `PATH`，再用 `spawnSync(cmd, {shell:true})` 调用。
共享包改动后必须先重建 dist（`gate.mjs` 的前两步已包含 `build-shared-types` / `build-shared-utils`）。

> 若在**别的机器**（pnpm 正常）上开发，直接用上表的 `pnpm xxx` 即可，本小节可忽略。

**Git 钩子（husky）**：`pnpm install` 会自动装钩子（`prepare` → `scripts/setup-husky.mjs`）。
装完后每次提交会：

- `pre-commit` → `lint-staged`（对暂存文件跑 `eslint --fix` + `prettier --write`）
- `commit-msg` → `commitlint`（强制 Conventional Commits，类型见 `commitlint.config.cjs`）

> 若提示跳过钩子安装，说明当前环境 PATH 里没有 `git`；git 可用后在仓库根执行 `pnpm exec husky install` 即可。
> 提交信息写错格式会被拦下，用 `feat:` / `fix:` / `docs:` 等前缀重写即可。

### 6.2 ⏱ 时钟注入：让「下单窗口」不再把端到端套件锁死在下午

**仓库内现行门禁是 `abox-onebox/scripts/gate.mjs`**（带 `all` / `verify` 别名，**含 e2e**；
工作区根那份「只跑 12 道」的旧副本已于 2026-09-21 删除，理由见 §6.1）。日常这样跑：

```bash
cd abox-onebox
export NODE_PATH=/c/Users/herma/.workbuddy/binaries/node/workspace/node_modules
NODE=/c/Users/herma/.workbuddy/binaries/node/versions/22.22.2-3/node.exe
$NODE scripts/gate.mjs all        # 全量静态门禁 + 单测 + 三端构建（条数见 §6.1 标记，勿在此写死）
                                  #   shared×2 / lint / format / typecheck×3 / jest / build×3
                                  #   + schema:parity / index:parity / state:audit / route:audit
                                  #   + security:scan / nav:consistency / doc:tables / dup:const / gate:parity
$NODE scripts/gate.mjs verify     # 4 道：seed → e2e:m1 → e2e:m2 → e2e:m3
$NODE scripts/gate.mjs e2e:m3     # 单跑某一段（⚠️ 单跑不重置种子，先补 `seed`）
```

**症状**：`e2e:m1` / `e2e:m2` 走**真实 HTTP 下单**，而 `isOrderable(T)` = `[T-1 14:00, T-1 23:00)`
—— 该不等式对整数日**无解**，所以**窗口外无论传哪个出餐日都下不了单**。结果是全量套件每天只有
9 小时能跑：**23:00–14:00 之间 `m1` 会红 20 余条（全部由「U6 创建订单」级联而来）**，
`m2` 更隐蔽 —— 拿不到 `orderNo` 后把 `undefined` 写进 SQLite，直接抛
`Provided value cannot be bound to SQLite parameter`，看起来像「脚本崩了」。

**机制**：`apps/api-server/src/common/utils/time.ts` 收敛出**唯一时间源 `now()`**。当设了
`ABOX_SHIFT_TO_HOUR=20`（且 `NODE_ENV !== 'production'`）时，服务端把**北京小时**平移到 20:00：

- **日历日不变** → 脚本侧用真实钟算出的 `todayBj()/tomorrowBj()` 与服务端**仍然对齐**，夹具无需改动；
- 时间仍 **1:1 前进**（不是冻住时钟）→ 时间戳单调性、`created_at < paid_at` 全部保持；
- `gate.mjs` 已给 `seed` / `e2e:m1` / `e2e:m2` / `e2e:m3` **自动注入**并打印一行横幅；
  服务端启动时也会 WARN 一行，避免把注入时刻误当成真实时刻排查问题。

手动起服务调试时同样可用：`ABOX_SHIFT_TO_HOUR=20 npm run dev:api`。

**边界（别把它当成能测一切）**：

1. **只影响 `now()`，不改 `@Cron()` 的真实触发时刻**（NestJS 的 cron 是静态元数据）。
   所以**跑批验收一律走手动补跑接口** `POST /admin/schedule/{task}/run`（接收显式出餐日，与时钟无关）；
2. 存量 `new Date()` 直接调用点（如 TypeORM 的 `@CreateDateColumn`）仍写**真实**时刻 ——
   二者相差一个固定平移量，先后关系自洽，但**别拿落库时刻与服务端 `now()` 直接相减**；
3. 注入后 `now()` 落在**未来**（真实 11:00 → 注入 20:00），不要用它做「距今多久」的断言；
4. 直接手跑某个 e2e 脚本（不经 gate）时不会注入 → 窗口外会先撞上「前置：当前不在下单窗口」
   **一条**可读失败并退出（这是**刻意**的 fail-fast，避免 20 余条假红淹没真回归）。

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

## 九、进度实况与内部测试（2026-09-17）

> ⚠️ 下面 9.1 / 9.2 是 **2026-09-14 的首次记录**（当时业务代码还是骨架），**已被 9.3 取代**。
> 保留只为留痕 —— **别据此判断现状**。现状与「不上云怎么测」看 9.3。

### 9.1 已验证可用（2026-09-14 · **历史留痕**）

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

### 9.2 待开发（2026-09-14 · **历史留痕 —— 所列各域已全部完成**，见 9.3）

| 层 | 现状 |
| --- | --- |
| 业务控制器 | 仅 `auth`(2 路由) / `health`(1 路由) 有真实路由，其余为占位空类 |
| 业务服务 | 除 `auth.service.ts`(112 行) 外，均为 2–6 行骨架 |
| 待补的域 | 菜单开团、下单、支付与回调、退款三段式、采购应付与冲销、佣金结算与提现、配送、团长晋级/邀请、溯源、消息、统计、后台管理 |

---

### 9.3 云服务器就绪前，内部测试怎么做（2026-09-17 新增）

**结论：能做，不必等人给服务器。** 三层能力，按「给谁看」挑：

| 层 | 形态 | 适合谁 | 数据 | 能真下单吗 | 前置条件 |
| --- | --- | --- | --- | --- | --- |
| 一 · 高保真原型 | 网页（**已线上**） | 团长 / 供应商 / 同事先看流程与视觉 | **假数据** | ❌ | 无，打开即用 |
| 二 · 本地真环境 ★ | 手机浏览器 + 电脑浏览器 | 你我、团长与供应商代表**上手试** | **真数据库** | ✅（Mock 支付） | 本机 + 同一 WiFi |
| 三 · 自动化验收 | 命令行 | 工程（防回归） | 临时库 | ✅（**959** 条断言） | 无 |

> ⭐ 关键前提：微信登录与支付在本环境走 **Mock 通道**（`code=dev:<标识>` + 支付自动回调），
> 所以**不需要 AppID、不需要备案域名、不需要商户号** —— 这正是「不等云资源也能测」的原因。
> 代价是**测不了任何微信平台能力**（见 9.3.5）。

#### 9.3.1 一条命令起环境

```bash
cd abox-onebox
node scripts/local-test.mjs --smoke    # 起环境 + 跑 11 项端到端自检
node scripts/local-test.mjs --seed     # 想要一套干净数据时加 --seed（重置种子）
node scripts/local-test.mjs --build    # 改过前端代码后加 --build（重建产物再起）
node scripts/local-test.mjs --help     # 见文件头注释；还有 --only= / --clock= / 各端口参数
```

它**一次做完三件事**：

1. **起真后端** —— `sqlite` 真库 + 进程内队列 + Mock 通道（**跑的是真实业务代码**，不是假接口）；
2. **起真前端** —— 小程序 **H5 版** + 运营后台，并用**同源代理**把接口接起来
   （页面与接口同端口 → **不依赖固定 IP**（换 WiFi 不用重建）、**不会踩跨域**）；
3. **时钟注入** —— 把**北京小时**平移到 20:00，使**任何时刻都能下单**。
   否则 `isOrderable(T)` = `[T-1 14:00, T-1 23:00)` 每天只开 9 小时，其余时间连单都下不了。

启动后在终端打印**手机扫码地址 / 后台地址 / 测试身份**；结束按 `Ctrl+C`，本次起的服务一并回收。

> ⚠️ **只绑本机、只用于内网**：它是静态托管 + 反向代理的极简实现，无 HTTPS、无访问控制。
> **不要**用它对外发链接。
>
> ⚠️ 用户端 H5 的产物落在 `apps/miniprogram/dist-h5/`，**刻意避开 `dist/`**：
> `dist/` 归门禁的 `build:mp` 所有（构建前把整个 outDir 改名挪走），放进去的话
> **每次跑门禁都会把手机测试环境清掉** —— 表现是「昨天还能开，今天说缺产物」。
> 该目录已在 `.gitignore` 中。

#### 9.3.2 四种打开方式

| 想做的事 | 怎么做 |
| --- | --- |
| 手机真机感受 | 与电脑同一 WiFi，扫终端二维码（或手输 `http://<本机IP>:5180/`） |
| 电脑上快速走流程 | 浏览器开 `http://localhost:5180/`，F12 切手机模式 |
| 看运营后台 | 浏览器开 `http://localhost:5173/`（`admin / admin123`） |
| 直接调接口 / 看契约 | `http://localhost:3000/docs`（Swagger）；健康检查 `/api/v1/health` |

#### 9.3.3 测试身份（Mock 通道 · 端上填 `code`）

| code | 身份 | 等级 | 佣金 | 备注 |
| --- | --- | --- | --- | --- |
| `dev:1001` | 李明 | 首席团长 `chief` | 12% | **标杆账号**（自检**不会**占用它） |
| `dev:1002` | 王芳 | 金牌团长 `gold` | 10% | |
| `dev:1003` | 张磊 | 正式团长 `formal` | 9% | |
| `dev:1004` | 赵静 | 正式团长 `formal` | 9% | |
| `dev:1005` | 陈强 | 见习团长 `trainee` | 8% | 30 天未促单取消的观察对象 |
| 任意新 code（如 `dev:abc`） | 新用户 | — | — | ⚠️ **拿不到团**：未绑楼栋 → `/home/daily` 回 `10004`，**属预期** |

运营后台账号：`admin / admin123`（超管）· `finance / finance123` · `sanweiwu / supplier123`。

> `--smoke` 会**真下一单**（占用一个团长账号的当日单，从 `dev:1002` 起挑闲置的）。
> 想全部复原：`Ctrl+C` 后加 `--seed` 重起。

#### 9.3.4 内部测试剧本（照着点即可）

> **操作清单（可打印 A4）**：`ABox一盒内部测试操作清单v1.0.html` —— 面向**执行测试的人**（不是工程）：
> **38 个编号步骤**（用户端/团长端 15 · 运营后台 20 · 负向用例 3）、每步都写清「**应该看到**」、
> 附**问题记录表**与严重度分档（P0 卡死 / P1 结果不对 / P2 不好用）、**身份分配提示**（多人共用
> 同一身份会互相撞「一天一单」，最容易误报）、以及**收工与复原**步骤。
> **供应商侧清单**：`ABox一盒供应商内部测试操作清单v1.0.html` —— **22 个编号步骤**（商家工作台 7 ·
> 出餐确认 5 · 应付结算 6 · 负向用例 4），另附一张**菜单地图**（哪几页已可用、哪几页尚未实装）——
> 供应商登录后第一眼落在**未实装的「概览」页**，是该侧最容易被误报成「登录失败」的一件事。
> 下面三段是同一剧本的**简表**，给工程快速自查用。

**A · 用户端 / 团长端（手机 · 用 `dev:1001`）**

1. 打开首页 → **明日**套餐（一饭四菜）、售价 ¥25.80、截单倒计时；
2. 下单 → 选份数 → 提交 → 跳支付页（Mock **约 1 秒自动成功**）；
3. 「我的 → 订单列表」→ 该单应为**已支付**；
4. **同一天再下一单** → 应被拦：「你已提交过 2026-09-18 的订单」（`30004`）；
5. 订单详情 → 取消订单 → 走退款（Mock 原路退回）；
6. 「溯源」→ 食材与**加工场所**信息；
7. 团长 tab → 邀请 / 我的佣金 / 余额明细；
8. 申请提现 → 进「待审批」，到后台财务 → 提现审批里审（D45）。

**B · 运营后台（电脑 · `admin/admin123`）**

1. **看板** → 核心指标（GMV **含在途退款**；成本取**净额**）；
2. **菜品矩阵** → 明日套餐与档位（校验一饭四菜）；
3. **订单** → 列表 / 详情 / **配送**（人工修正运力与份数，带 `version` 乐观锁）；
4. **团长** → 列表 / 详情（等级与费率是**快照**）/ 申请审批；
5. **加工场所** → **打包任务**（P39；该路由**已从供应商端迁到后台**）；
6. **财务** → 概览（与看板**同一函数**取数）/ 佣金 / 余额（四动作含**解冻**）/ 供应商应付 /
   退款 / 提现审批 / 对账（一期**如实标注未与微信对平**）/ 发票（供应商 × 月份三态）；
7. **统计** → 楼栋排行 / 菜品热度 / 留存（留存数字**成对下发**）；
8. **系统** → 配置（改 `set_meal.cutoff_time`，再到「时刻表」看**是否跟着变** —— 这是配置
   热重载的观测点）/ 账号 / 角色 / 操作日志 / 消息模板。

**C · 供应商端（电脑 · `sanweiwu/supplier123`）**

> 供应商与运营**共用同一个后台网址**，按账号分角色 → 左侧只有 **6 项**菜单，其中「概览」
> 「我的菜品」「上架申请 / 商家资料」**尚未实装**（显示「脚手架占位页」），不影响本轮。
> 补跑接口的用法见下方引用块。

1. **商家工作台** → 默认落在「最近一个有计划的出餐日」（种子预置**明日**）：三味屋 · 合作中 ·
   应出餐 **45** 份 · 涉及集散中心 **1** · 确认截止 **09:30**（是 `deadline` 不是 earliest，
   提前备好即可提前确认）；菜品显示「采购单价 ¥7.50 · 应出 45 份」；
2. **出餐确认** → 列表按 **(菜 × 集散中心)** 展开、未确认项**默认全选** → 提交 →
   「出餐确认成功：1 项」；**原样再提交一次**应回「新增 0 项、跳过 1 项」而**不报错**（幂等）；
3. 回工作台 → 已确认送达 45 / 待确认 0，集散中心行状态变「已送达」并带时间戳；
4. **应付结算明细** → 默认「今天」**本来就该是空的**（应付单在**出餐日之后**才生成）→ 把日期改成
   出餐日 → 出现 1 行：实收 **45** × 单价 **¥7.50** = **¥337.50** · 待付款 · 回单号空；
5. **关键判据（不是缺陷）**：该页**结构性不含** ¥25.80 / 佣金 / 毛利 —— B2B 采购关系下供应商
   只该看到「我的协商单价 × 我的交付量」（不变量 **I1**）。**出现才是缺陷**；
6. **越权与已下线**：供应商 token 打 `/admin/*` → `10003`；`/supplier/packing-tasks`（S3 已迁后台）
   → `10004`；请求体带 `supplierId` → `10001`（收了就等于允许「替别的供应商确认」）。

> 结算页要出数，需工程先补跑一次 `POST /admin/schedule/supplier-share/run`（带 `date`）。
> 跑批出参里，**未做出餐确认**的供应商会进 `exceptions`（原因「出餐确认尚未开始」）——
> 这就是「**不确认就不出单**」的现场证明：本轮三味屋出单、另外三家进 `exceptions`。

#### 9.3.5 能测什么 / 测不了什么（诚实边界）

| ✅ 本地已能覆盖 | ❌ 必须等云资源与账号 |
| --- | --- |
| 全部业务规则与状态机（订单 11 态） | 微信授权登录（要真 AppID + 备案域名） |
| 金额口径、佣金 4 级费率、结算与对账口径 | 真实微信支付 / 退款（要商户号 + API 证书） |
| 后台鉴权、角色白名单、操作日志、主体隔离 | 订阅消息真实下发（要模板 + 用户授权） |
| 看板 / 统计 / 财务**同口径** | 小程序**真机**（H5 不是小程序，**不能分享给外部人**） |
| 配置层与调度时刻表的热重载 | 压测 / 并发（sqlite + 单进程，不代表生产） |
| Mock 支付回调、退款、队列消费 | 灵活用工平台**真实出款**（要开户） |

#### 9.3.6 四条注意事项

1. ⚠️ **Mock 支付「自动成功」不产生真实资金流** —— 别把「已支付」当成钱到了；
2. ⚠️ **时钟被注入过**（北京小时 → 20:00）—— 别用它验「真实时间行为」；要按真实时间跑用 `--clock=off`；
3. ⚠️ 这是**内部**环境：**不要对外发链接、不要拉真实用户进来**（合规）；
4. ⚠️ 数据随手改没关系，但**别把它当权威** —— 权威永远是**种子脚本 + 迁移**。

#### 9.3.7 与自动化的关系

| | 验什么 | 怎么跑 |
| --- | --- | --- |
| e2e 三套件（m1 **45** / m2 **126** / m3 **959** 条断言） | **接口契约**（含幂等、并发、越权、口径回归） | `node scripts/gate.mjs verify` |
| `local-test.mjs --smoke`（11 项） | **端上那条路走不走得通**（产物已构建、代理已接上、页面可登录可下单） | `node scripts/local-test.mjs --smoke` |

两者**互补、缺一不可**：接口全绿但前端产物没构建 / 代理没接上时，只有后者会红。

---

## 十、与文档的对应关系

| 本手册涉及 | 权威文档 |
| --- | --- |
| 表结构（**27** 张） | `ABox一盒数据库ER设计v2.1.md` + `ABox一盒表结构评审意见v1.0.md` |
| 接口契约 | `ABox一盒接口规范v1.0.md` |
| 状态机与流转 | `ABox一盒订单状态机与全链路流转v1.0.md` |
| 种子数据 | `ABox一盒种子数据清单v1.0.md` |
| 结算口径（C1–C11） | `ABox一盒MVP优化交接包v1.3.md` |

---

*文档结束 · ABox 一盒 · 本地开发手册 v1.0 · 2026-09-17*
*(v1.1：新增 build:shared 前置步骤、本地链路自测、当前进度实况、4 条跨库/构建类 FAQ)*
*(v1.2：§六 补 `gate.mjs` 现行口径与 e2e 时钟注入边界；§九 9.1/9.2 降为历史留痕并新增
**9.3 云服务器就绪前的内部测试** —— 一键启动器 `scripts/local-test.mjs`、测试身份、
两套测试剧本、能力边界与四条注意事项)*
*(v1.3：§9.3.4 挂上**可打印操作清单** `ABox一盒内部测试操作清单v1.0.html`（38 步 + 记录表 +
严重度分档 + 身份分配 + 复原步骤），本手册保留简表用于工程快速自查)*
*(v1.4：§9.3.4 新增 **C · 供应商端**简表与**供应商侧操作清单** `ABox一盒供应商内部测试操作清单v1.0.html`
（22 步 + 菜单地图）—— 钉死三处易误报：**登录后默认落在未实装的「概览」页**、**结算页看不到售价与佣金
是刻意的（I1）**、**不做出餐确认就不出应付单**（跑批出参的 `exceptions` 即现场证明）)*

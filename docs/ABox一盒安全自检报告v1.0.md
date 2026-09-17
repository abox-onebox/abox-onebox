# ABox 一盒 · 安全自检报告 v1.0

> 对应里程碑 **5.3 安全自检（越权、幂等、重放、密钥泄露、日志脱敏）** 中**不依赖外部条件**的部分
> 日期：2026-09-17 · 范围：本地可执行项（HTTPS / 生产白名单核对**待环境**，见 §7）
> 复跑：`node scripts/gate.mjs route:audit security:scan`

---

## 1. 结论一览

| # | 检查项 | 方法 | 结果 |
|---|--------|------|------|
| 1 | **越权（路由权限）** | 运行时反射读 Nest 元数据，**全量 135 个端点**逐条核对白名单 | ✅ 通过（新增门禁 `route:audit`） |
| 2 | **越权（端到端）** | 已由 `e2e-m3` 抽样钉死（30+ 条断言） | ✅ 通过（沿用既有） |
| 3 | **幂等 / 重放** | 已由 `e2e-m1/m2/m3` 钉死（幂等键、`40004` 回放分支） | ✅ 通过（沿用既有） |
| 4 | **密钥泄露** | 扫**工作区 + 完整 git 历史**（66 提交 / 2.9MB） | ✅ 零命中 |
| 5 | **日志脱敏** | 扫全部 `logger.*` 调用：整对象落库 / 敏感插值 / 敏感字面量 | ⚠️ 2 项 WARN（**均为 mock 假值，判定可接受**，见 §5） |
| 6 | **加固** | 1 处「靠隐式约定兜底」的免鉴权端点改为**显式 fail-closed** | ✅ 已修（见 §6） |

**新增门禁 2 道**：`route:audit` · `security:scan`（`gate.mjs all verify` 由 **16/16 → 18/18**）。

---

## 2. 越权：为什么必须做**全量**机械对账

`AdminGuard` 的白名单判据是：

```ts
if (roles && roles.length > 0 && !roles.includes(payload.role ?? '')) throw FORBIDDEN;
//           ↑ 注意这一条
```

**没写 `@Roles` 的运营端点 = 对所有后台角色开放**，包括 `supplier`。而供应商账号一旦能进 `/admin/*`，就是**直接拿全平台数据**。

这类缺陷的可怕之处在于**它不在任何失败路径上**：

- 编译不报错；
- `e2e` 不报错 —— 因为**没人用 supplier token 打过那个端点**；
- 代码评审容易滑过 —— 「有 `@UseGuards(AdminGuard)` 啊」。

它与缺陷 **#76** 同族：**所有机械证据都是绿的，而对应的能力从未被验过一次**。所以必须把「有没有写白名单」变成机械事实，而不是靠自觉。

### 2.1 方法：运行时反射，不解析源码

`@Roles` 存在**变量展开**形态（`@Roles(...FUND_ACTION_ROLES)` / `@Roles(...FINANCE_VIEW_ROLES)` / `@Roles(...BALANCE_ADJUST_ROLES)` / `@Roles(...FINANCE_READ_ROLES)`）。

正则或 AST 解析要么漏掉展开、要么得自己实现常量求值 —— 这正是 **M5-2 `schema-parity` 的教训：让框架自己算一遍**。

`@Controller` / `@Get` / `@Roles` 本质都是 `Reflect.defineMetadata`，**import 类文件即写入元数据**，`Reflect.getMetadata` 读到的就是**求值后的真实白名单** —— 无需 bootstrap Nest，无需连数据库。

### 2.2 结果

```
源：30 个 *.controller.ts → 135 个端点
  /admin/* 89 · /supplier/* 3 · 资金/写 72 · 免鉴权 8
  「默认全角色开放」的运营端点：0 个
✔ 路由权限审计通过：135 个端点全部有明确白名单
```

| 类别 | 数量 | 说明 |
|------|------|------|
| 端点总数 | **135** | 30 个 controller 文件（含 3 个空骨架，见下） |
| `/admin/*` | 89 | 运营后台 |
| `/supplier/*` | 3 | 供应商 Web |
| 资金 / 写端点 | 72 | 非 GET，或路径含 withdraw/balance/adjust/settle/refund/commission/payout/invoice |
| 免鉴权（`@Public()`） | 8 | 逐条列出见 §2.4 |

### 2.3 十条规则

| 规则 | 级别 | 内容 |
|------|------|------|
| R1 | FAIL | `/admin/*` 未声明**有效**白名单 → 默认对含 `supplier` 的全角色开放 |
| R2 | FAIL | `/supplier/*` 未显式含 `supplier` → 运营账号可访问（跨角色） |
| R3 | FAIL | 方法级白名单**超出**类级 → 方法级覆盖类级导致「收窄被意外放宽」 |
| R4 | FAIL | 资金/写端点白名单含只读角色 `viewer` |
| R5 | WARN | 白名单含 `supplier` 而路径是 `/admin/*` → 需人工确认是否刻意 |
| R6 | FAIL | 白名单含**未登记角色**（拼错 → 该角色永久 403，功能静默坏） |
| R7 | FAIL | 后台作用域端点被标 `@Public()` → 免鉴权 |
| R8 | WARN | 同 controller 内静态路由声明在参数路由**之后** → 被吸收 |
| R9 | FAIL | 方法级 `@Roles()` **空**声明**覆盖并抹掉**类级白名单 → 退化为默认全开放 |
| R10 | FAIL | 免鉴权的调试/mock 端点未登记**自身**的 fail-closed 守卫 |

> **R9 与 R1 的判据必须与守卫逐字对齐**。本检查器第一版用 `!eff` 判「未声明」，
> 而空数组是 truthy —— 于是 `@Roles()` 会被**本检查器**放过，却被 `AdminGuard`
> 当成未声明。**检查器与被执行逻辑的判据不一致时，检查器自己就是漏洞。**
> 现已统一为 `!!eff && eff.length > 0`，与原码逐字一致。

### 2.4 免鉴权端点（逐条核对）

| 端点 | 判定 |
|------|------|
| `GET /health` · `GET /health/ready` | 编排器探针（M5-0 已验「出参不泄露主机/端口/连接串」） |
| `POST /auth/login` · `POST /auth/admin-login` · `POST /auth/refresh` | 登录入口，天然免鉴权 |
| `GET /leader/invite/:leaderCode` | 团长邀请落地页（分享链路，必须被未登录用户打开） |
| `POST /pay/notify` | 微信支付回调（`WxSignatureGuard` 验签） |
| `POST /pay/mock/paid` | ⚠️ 调试端点 —— **本次加固**，见 §6 |

### 2.5 豁免清单（审计的产出物，**只减不增是常态**）

| 端点 | 理由 |
|------|------|
| `GET /auth/profile` · `POST /auth/logout` | A4/A5 **双主体契约**：任意后台角色都要能看/登出**自己**，出参按 `role` 分流 |
| `POST /pay/mock/paid` | 本地 mock 支付通道专用；**已在服务层按 `isMock` fail-closed** |

---

## 3. 自证能力（防止「恒绿的检查」）

两道门禁都**每次运行验证自己还能报警**，报不出即**自身失败**：

| 门禁 | 自证内容 |
|------|----------|
| `route:audit` | ① 每个 `*.controller.ts` 必须导出 controller 类（防静默漏扫，**当场抓出过判据过严**：空骨架 `building.controller.ts` 等 3 个被误报为漏扫）；② 人为构造 9 个违规样本（未声明 / 空声明 / 拼错角色 / 供应商漏 supplier / 资金含 viewer / 免鉴权调试端点），**逐条必须被报出** |
| `security:scan` | 真凭据样本（私钥块 / AWS key / `sk-` / 连接串 / 硬编码密码）**必报**；占位样本（`your-` / `CHANGE_ME` / `<YOUR_API_KEY>`）**必不报**；日志纯文案提及字段名**必不报** |

**反证测试（实测）**：人为删掉 `building-admin.controller.ts` 的类级 `@Roles` → 门禁**变红并点名 5 个端点**（退出码 1）；还原后 sha256 逐字节一致。

---

## 4. 密钥泄露扫描（工作区 + 完整 git 历史）

**为什么必须扫历史**：「提交过又删掉」的密钥**仍然在历史里可检出**，而当前工作区看起来是干净的 —— 只扫工作区会给出一个**看起来绿的结论**。

扫描形态：私钥块 / AWS Access Key / 高熵 API Key（`sk-` `ghp_` `xox`）/ 连接串内嵌密码 / 硬编码敏感赋值 / JWT 字面量 / 微信商户号；**历史额外扫**「曾出现过又删除的敏感文件名」（`.env` / `*.pem` / `*.key` / `*.p12` / `*.crt`）。

**结果：工作区 0 命中 · git 历史 0 命中。**

> 占位与示例必须豁免（`.env.example` / 文档里的 `your-appid`），否则噪音会淹没真命中；
> 但**豁免不适用于看起来像真凭据的高熵串**（注释里写 `your-xxx` 掩盖不了 32 位随机串）。

---

## 5. 日志脱敏核查（2 项 WARN，均判定可接受）

| 位置 | 内容 | 判定 |
|------|------|------|
| `mock-wx-mini.provider.ts:32` | `` logger.debug(`[mock] code2Session code=${code} → openid=${openid}`) `` | **可接受** —— `mock` 驱动专用（生产 `driver=real` 不加载），打的是**生成的假 openid**，且 `debug` 级。⚠️ 若将来 `real-wx-mini.provider.ts` 也打 openid，**同一条规则会立刻报出** |
| `mock-wx-mini.provider.ts:42` | `logger.debug('[mock] getPhoneNumber → 13800138000')` | **可接受** —— 写死的**演示号码**，非真人数据 |

**关键核实**：`real-wx-mini.provider.ts` 只打 `errcode` / `errmsg` 与「配置缺失」文案，**从不打印 openid 或手机号** —— 生产路径脱敏良好。

> 检查器第一版把「文案里提到字段名」（`'WX_MINI_APPID / WX_MINI_SECRET 未配置'`）
> 也误报成 WARN。已收紧为：只有**插值 `${...字段...}`** 或**敏感值字面量**才算命中 ——
> **误报多了，真命中就没人看了。**

---

## 6. 加固 1 项：`POST /pay/mock/paid` 改为显式 fail-closed

**问题**：该端点 `@Public()`（免鉴权），能**把订单改成已支付**。此前它只靠一条**隐式约定**兜底 —— `simulatePaid` 在 provider 接口上是**可选方法**（`simulatePaid?`），real 通道恰好没实现它，于是 `if (!this.provider.simulatePaid) return false`。

**风险**：约定不会被任何机械检查守住。将来 real provider 补上该方法，就会**静默打开**一个免鉴权的改单口子。

**修法**：在服务层显式按通道拒绝。

```ts
async simulatePaid(orderNo: string, amountFen?: number) {
  if (!this.wxpay.isMock) throw new BizException(ErrorCode.NOT_FOUND);  // 10004，不暴露端点存在
  ...
}
```

并新增规则 **R10**：今后任何「免鉴权 + 路径含 mock/debug」的端点，**必须在豁免表里写明它自身如何 fail-closed**，否则门禁红。

---

## 7. 边界与未覆盖（如实标注，不写成已验）

| 项 | 状态 |
|----|------|
| **HTTPS / TLS 配置** | ⏳ **待环境**（需域名与证书）—— 未做 |
| **生产白名单核对**（微信后台 / 服务器安全组） | ⏳ **待环境** |
| **开发环境无 `supplier` 真实账号的端到端验证** | 已由 `e2e-m3` 用**新建的 supplier 账号**覆盖（抽样）；全量由 `route:audit` 静态覆盖 |
| **R5（白名单含 supplier 的运营端点）** | 当前 **0 项命中**；规则留着，将来若刻意开放会被强制人工确认 |
| **越权的「服务层数据收窄」** | ⚠️ **静态检查覆盖不到** —— `route:audit` 只能证明「角色进得来」，证明不了「进来后只看得到自己的数据」（如供应商只能看自己的单）。这一层目前靠 `e2e` 抽样 + 代码评审 |
| **依赖漏洞扫描**（`npm audit`） | 未做 —— 离线环境无法拉取漏洞库，**不假装已扫** |

---

## 8. 复跑方式

```bash
# 单独跑
node scripts/gate.mjs route:audit security:scan

# 打印全部 135 个端点的白名单（人工审计用）
cd apps/api-server && ts-node -r tsconfig-paths/register src/common/security/route-audit.ts --list

# 全量门禁（含这两道）
node scripts/gate.mjs all verify
```

---

## 9. 变更记录

| 日期 | 版本 | 内容 | 作者 |
|------|------|------|------|
| 2026-09-17 | v1.0 | 首版：越权全量机械对账（135 端点 / 10 条规则 / 双重自证）· 密钥扫描（工作区 + 66 提交全历史，0 命中）· 日志脱敏核查（2 WARN 判定可接受）· `mock/paid` 加固 · 新增门禁 `route:audit` / `security:scan`（16/16 → 18/18） | 项目总监 |

---

*文档结束 · ABox 一盒 · 安全自检报告 v1.0 · 2026-09-17*

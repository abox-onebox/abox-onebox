# scripts/probes —— 深度测试探针（排查工具，不是门禁）

> 2026-10-07 收编：这些脚本此前散在工作区 `_tmp/dt/`（**不进 git，随时会丢**），
> 现在全部搬进仓库。**它们不在 `gate.mjs` 里跑** —— 详见下方「为什么不当门禁」。

## 一、它们是什么

门禁（`scripts/check-*.mjs` / `e2e-m*.mjs`）测的是「能静态判定 + 每次都要成立」的东西。
但有一类问题**只有真发请求、真读响应才抓得到**（例如「接口还在下发第三方平台链接」——
前端按钮删了、服务端一行没动，静态扫全绿）。这类检查叫**探针**：带明确判据、可复跑，
但依赖真实服务实例，所以不进门禁。

## 二、清单

「**裸跑**」= 直接 `node scripts/probes/<文件名>` —— 不挂任何 `NODE_OPTIONS`、不起服务、3101/3102/3103 空闲。
下表是 2026-10-09 κ-6 **逐个实测**的退出码（口径与《ABox一盒本地开发手册》§6.3① 同源，两边不许各说各话）：

| 探针                         | 它测什么                                                                                                                                                                             | 裸跑                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| `deep-test.mjs`              | 资质墙 / 一人一日多单（28 项）。**自己不起服务**，要外部喂一个：`node scripts/probes/deep-test.mjs http://127.0.0.1:3000/api/v1`                                                     | ❌（`fetch failed`） |
| `deep-cancel.mjs`            | 取消理由与 `cancel_source` 四来源（22 项）。自带 seed + 起停                                                                                                                         | ❌                   |
| `deep-round2.mjs`            | 边界 / 闭环 / 多单 / 资质墙（32 项）。自带 seed + 起停                                                                                                                               | ❌                   |
| `deep-kf.mjs`                | 客服三档降级（`csMode`）的实测探针。自带 seed + 起停                                                                                                                                 | ❌                   |
| `audit-wx-compliance.mjs`    | **小程序合规审计**：只信实测响应，查溯源页 / 资质墙 / 客服页的出参里还有没有第三方平台痕迹与外部域名资源                                                                             | ❌                   |
| `run-layer3.mjs`             | 第三层一键：`deep-test` / `deep-cancel` / `deep-round2` 串跑（各自独立起停会抢 3101 端口）                                                                                           | ❌                   |
| `selftest-e2e-zero.mjs`      | 自证：e2e「0 条断言 ⇒ exit 1」的判据真会红（必报 + 必不报样本）                                                                                                                      | ✅                   |
| `selftest-expect-min.mjs`    | 自证：`gate.mjs` 的 `EXPECT_MIN` 规模判据真会红 / 会绿                                                                                                                               | ✅                   |
| `check-agreement-body.mjs`   | 协议正文（`constants/agreements.ts`）改动的机械复核                                                                                                                                  | ✅                   |
| `prod-mock-gate.mjs`         | 自证：`main.ts` 的**生产禁 mock 启动硬闸**判据（λ-1）—— 四场景 + 反证；纯判据、不起服务、不碰端口                                                                                    | ✅                   |
| `security-history-modes.mjs` | 自证：`security:scan` 的 git 历史**三态**（`complete` / `shallow` / `unavailable`）与「扫没扫到」是否自洽 —— 用**假 git** 顶在 PATH 最前把三态逼出来（κ-8 收编；需 ts-node，约 20s） | ✅                   |

⚠️ 上表 ❌ 的两类红**不是一回事**，别混着修：

- `deep-cancel` / `deep-round2` / `deep-kf` / `audit-wx-compliance` / `run-layer3` 这 **5 个** —— 内部是裸
  `spawnSync` 拉 `gate.mjs seed` ⇒ 进程**根本没起来**（`exit=null`），见下一节；
- `deep-test.mjs` —— **与进程创建无关**：它连 `http://127.0.0.1:3000`，红是因为**没有在跑的 API 服务**
  （`探针自身异常： fetch failed`）。先起服务再喂地址，换任何物料都救不了这一条。

## 三、怎么跑

在 `abox-onebox/` 下：

```
node scripts/probes/<文件名>
```

路径**全部相对本文件推导**（收编时已清掉本机绝对路径），换机器无需改一行。

### ⚠️ 裸跑 `exit=null` = **子进程起不来**，不是探针判红

本机（Windows · **机器级**，关掉沙箱同样复现）**无法为子进程创建匿名管道**，
`spawnSync` 起不来 ⇒ `status=null` + `EBUSY`，连 `node -v` 都跑不出来。表现是
**`exit=null`、耗时 1ms、无输出** —— 这是**环境故障伪装成测试失败**，不是探针的结论，
别照着它去改判据。

⭐ **病根是 `stdio[0]`（stdin），不是 stdout/stderr**（κ-9 逐路实测，每组 3 次稳定）：
`['pipe','ignore','ignore']` ⇒ ❌ EBUSY；而 **`['ignore','pipe','pipe']` ⇒ ✅ 正常**。
⇒ **最小修法只需把 stdin 钉成 `'ignore'`**，不必换掉整套 stdio。
（旧表述「只要走 `stdio:'pipe'` 就 EBUSY」不够精确 —— stdout/stderr 用 pipe 其实没事。）

**正确修法只有一条**：把脚本里那处裸 `spawnSync` 换成

```js
import { spawnCapture } from '../lib/spawn-capture.mjs';
```

`spawnCapture` 用「临时文件重定向 + 退出后回读」代替管道，行为对齐 `pipe`，
**在仓库内、跨机器可用、不需要任何仓库外物料**（`prod-mock-gate.mjs` 已经这么写了，所以它裸跑能过）。

> ⛔ **不要去找垫片**。曾经有过一个**外部**垫片 `_tmp/gatepipe/pipefix.cjs`（工作区外、从未入仓库），
> 它已于 **2026-10-09 κ-1 退役**，`scripts/gate.mjs` 自带 fd 重定向后不再需要它。
> 这 5 个探针里确实还留着 `ABOX_PIPEFIX=<路径>` 的挂载口，但**已经没有物料可挂** ——
> 拿着一个退役物料的绝对路径填进去只会让 node **启动即失败**（`Cannot find module`）。
> 看到 `exit=null`，动作是**换 `spawnCapture`**，不是把垫片找回来。

## 四、为什么它们不在门禁里

1. **要起真实服务 + seed**，跑一次几分钟，不适合每次提交都跑；
2. **依赖本机环境**（3101 端口、DB），在 CI 上形态不同；
3. 门禁要的是「恒绿/恒红都算失败」的**稳定判据**，探针的稳定性依赖外部实例。

⇒ 定位：**出问题时拿来取证、改完拿来复验**。跑完请**看判据的措辞**（不是只看通过数），
并在留痕里记结论。

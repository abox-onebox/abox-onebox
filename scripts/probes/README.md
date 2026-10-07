# scripts/probes —— 深度测试探针（排查工具，不是门禁）

> 2026-10-07 收编：这些脚本此前散在工作区 `_tmp/dt/`（**不进 git，随时会丢**），
> 现在全部搬进仓库。**它们不在 `gate.mjs` 里跑** —— 详见下方「为什么不当门禁」。

## 一、它们是什么

门禁（`scripts/check-*.mjs` / `e2e-m*.mjs`）测的是「能静态判定 + 每次都要成立」的东西。
但有一类问题**只有真发请求、真读响应才抓得到**（例如「接口还在下发第三方平台链接」——
前端按钮删了、服务端一行没动，静态扫全绿）。这类检查叫**探针**：带明确判据、可复跑，
但依赖真实服务实例，所以不进门禁。

## 二、清单

- `deep-test.mjs` —— 资质墙 / 一人一日多单（28 项）。**自己不起服务**，要外部喂一个：
  `node scripts/probes/deep-test.mjs http://127.0.0.1:3000/api/v1`
- `deep-cancel.mjs` —— 取消理由与 `cancel_source` 四来源（22 项）。自带 seed + 起停。
- `deep-round2.mjs` —— 边界 / 闭环 / 多单 / 资质墙（32 项）。自带 seed + 起停。
- `deep-kf.mjs` —— 客服三档降级（`csMode`）的实测探针。
- `audit-wx-compliance.mjs` —— **小程序合规审计**：只信实测响应，查溯源页 / 资质墙 / 客服页
  的出参里还有没有第三方平台痕迹与外部域名资源。
- `run-layer3.mjs` —— 第三层一键：上面三个探针串跑（各自独立起停会抢 3101 端口）。
- `selftest-e2e-zero.mjs` —— 自证：e2e「0 条断言 ⇒ exit 1」的判据真会红（必报 + 必不报样本）。
- `selftest-expect-min.mjs` —— 自证：gate.mjs 的 `EXPECT_MIN` 规模判据真会红/会绿。
- `check-agreement-body.mjs` —— 协议正文（`constants/agreements.ts`）改动的机械复核。

## 三、怎么跑

在 `abox-onebox/` 下：

```
node scripts/probes/<文件名>
```

路径**全部相对本文件推导**（收编时已清掉本机绝对路径），换机器无需改一行。

### 本机专用：pipefix 垫片

本机 `child_process` 在 `stdio:'pipe'` 下**一律 EBUSY**（机器级限制，连 `node -v` 都起不来），
所以需要 `pipefix.cjs` 把管道改写成临时文件重定向。**该垫片自述「勿入仓库」**，故不收编；
探针改为**可选启用**：

```
ABOX_PIPEFIX=<pipefix.cjs 的绝对路径> node scripts/probes/run-layer3.mjs
```

不设 `ABOX_PIPEFIX` 就不加 `--require` —— 正常机器（含 CI 的 Linux）本就不需要。
⇒ 这条也是「环境故障伪装成测试失败」的解药：垫片没生效时你会看到**明确的报错**，而不是一堆假红。

## 四、为什么它们不在门禁里

1. **要起真实服务 + seed**，跑一次几分钟，不适合每次提交都跑；
2. **依赖本机环境**（3101 端口、DB、pipefix），在 CI 上形态不同；
3. 门禁要的是「恒绿/恒红都算失败」的**稳定判据**，探针的稳定性依赖外部实例。

⇒ 定位：**出问题时拿来取证、改完拿来复验**。跑完请**看判据的措辞**（不是只看通过数），
并在留痕里记结论。

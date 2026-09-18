/**
 * ⚠️ **未实装 · 占位骨架**（内容只有 `export {}`，全仓 **0 引用**，已机械核对）
 *
 * 本文件来自《项目目录结构 v2.0》的骨架清单。**文件名描述的是「计划」，不是「事实」** ——
 * 勿据此文件判断项目具备该能力。
 *
 * 真实实现：**⚠️ 有意保留的契约占位（勿删）** —— C11 出款能力由 `modules/finance/withdraw-admin.service.ts`（D45/D46 审批与打款）+ `commission.service.ts`（佣金两段式）落地；本文件登记在《开发基线冻结清单》里
 *
 * 原骨架说明（原文件声明，未实装）：
 *   modules/finance/payout.service.ts —— 佣金出款（C11）占位骨架，开发阶段实现
 *   职责：
 *   1. 提现审批通过后，按团长 + 批次汇总生成 PayoutBatch（deduct 佣金余额）
 *   2. 导出打款清单（CSV / XLSX），交运营提交灵活用工平台
 *   3. 登记平台回执（到账 / 失败），回写 PayoutBatchStatus
 *   4. 记录代扣税额（tax_withheld_amount）以便核算团长税后到手金额
 *   通道抽象见 shared-types 的 PayoutChannel；一期走 FLEX_MANUAL。
 *   权威口径：交接包 v1.3 C11 · 接口规范 §4.4（D45 / D46 / W3）
 *
 * 核对方式：`tests/tools/dead-files-scan.mjs`（有效代码 ≤3 行 + 仅 `export {}` + 引用数 0）
 * 复活方式：若确要在此文件落地实现，**先删掉本段头注释**（否则会被继续当空壳扫出来）。
 */
export {};

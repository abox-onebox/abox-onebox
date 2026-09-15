/**
 * modules/finance/payout.service.ts —— 佣金出款（C11）占位骨架，开发阶段实现
 *
 * 职责：
 *   1. 提现审批通过后，按团长 + 批次汇总生成 PayoutBatch（deduct 佣金余额）
 *   2. 导出打款清单（CSV / XLSX），交运营提交灵活用工平台
 *   3. 登记平台回执（到账 / 失败），回写 PayoutBatchStatus
 *   4. 记录代扣税额（tax_withheld_amount）以便核算团长税后到手金额
 *
 * 通道抽象见 shared-types 的 PayoutChannel；一期走 FLEX_MANUAL。
 * 权威口径：交接包 v1.3 C11 · 接口规范 §4.4（D45 / D46 / W3）
 */
export {};

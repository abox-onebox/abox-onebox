/**
 * `ab_balance_log.type` → 中文文案（**服务端唯一真相**，端上不自造）
 *
 * ## 为什么单独成文件（而不是留在 `commission.service.ts` 里）
 *
 * 这张表有**两个读侧**：
 *   · 团长侧 L19 `GET /leader/balance-logs`（P17 余额流水）
 *   · 用户侧 U14 `GET /me/balance/logs`（P9 账户余额明细）
 *
 * 两者读的是**同一条余额链路**（用户与团长共用同一 `ab_balance`），
 * 但分属 `modules/finance` 与 `modules/user` 两个模块。
 * 文案表若留在 `modules/finance` 里，`modules/user` 要用就得跨模块 import
 * **业务模块**（common ← modules 的反向依赖），要么就在用户侧再抄一份 ——
 * 抄一份的后果是：某天有人添了新的 `type`，团长页显示中文、用户页显示裸英文
 * （`LABEL[type] ?? type` **不报错、只是变丑**），属于最难被发现的一类漂移。
 *
 * 故把「值 → 文案」提到 `common/constants/`，两侧**引用同一份**。
 * `commission.service.ts` 仍原样 re-export 旧名，既有导入点无需改动。
 */
export const BALANCE_LOG_TYPE_LABEL: Record<string, string> = {
  commission: '佣金入账',
  order_pay: '下单抵扣',
  withdraw: '提现',
  withdraw_refund: '提现退回',
  refund: '退款回退',
  /**
   * M3-14 新增：管理端手工调整（充 / 扣 / 冻 / 解）
   *
   * ⚠️ 漏了这条，用户与团长在余额明细里都会看到裸英文 `adjust` ——
   *    文案回退是 `LABEL[type] ?? type`，**不报错、只是变丑**。
   *    值的定义见 `balance-admin.service.ts`。
   */
  adjust: '管理端调整',
};

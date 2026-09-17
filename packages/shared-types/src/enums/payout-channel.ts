/**
 * 佣金出款通道（C11）
 * 权威来源：交接包 v1.3 C11
 *
 * 背景：团长佣金个税定案走「灵活用工平台」——
 *   平台对公账户 → 灵活用工平台 → 团长本人
 *   （代发 + 代扣代缴个税 + 向平台开具服务发票）。
 * 因此微信「商家转账到零钱」不再需要。本枚举把出款通道抽象出来，
 * 使「一期清单导出 + 回执登记」与「二期平台 API 直连」可平滑切换，
 * 且不阻塞 M1 开发（产品形态始终是「佣金余额 → 提现」，仅通道不同）。
 *
 * ⚠️ **2026-09-17（M4-4）修正：枚举值一律用大写，与落库值一致。**
 *    本枚举原先写成小写（`'flex_manual'`），而**实际链路上全是大写**：
 *    `ab_withdraw.payout_channel` 的列默认值、`BizConfigService.payoutChannel()`
 *    的缺省值、e2e-m2 的断言全是 `'FLEX_MANUAL'`。此前因为本枚举
 *    **全仓零消费点**（没人 import）才没炸；一旦有人照它写
 *    `row.payoutChannel === PayoutChannel.FLEX_MANUAL`，比较会**恒为 false**
 *    且不报错 —— 这类「不报错的错」最难查。故把枚举改成真实取值，
 *    让「照枚举写」与「照库写」指向同一个字符串。
 *    （登记于《缺陷与陷阱》#70）
 */
export enum PayoutChannel {
  /** 灵活用工平台 · 人工导出清单 + 回执登记（一期默认） */
  FLEX_MANUAL = 'FLEX_MANUAL',
  /** 灵活用工平台 · API 直连（二期） */
  FLEX_API = 'FLEX_API',
  /** 微信「商家转账到零钱」——C11 后停用，仅兼容历史流水 */
  WECHAT_TRANSFER = 'WECHAT_TRANSFER',
}

export const PAYOUT_CHANNEL_META: Record<
  PayoutChannel,
  { label: string; enabled: boolean; note: string }
> = {
  [PayoutChannel.FLEX_MANUAL]: {
    label: '灵活用工平台 · 清单导出',
    enabled: true,
    note: '一期：生成打款批次 → 导出清单 → 提交平台 → 回执登记',
  },
  [PayoutChannel.FLEX_API]: {
    label: '灵活用工平台 · API 直连',
    enabled: false,
    note: '二期：需平台提供打款 API',
  },
  [PayoutChannel.WECHAT_TRANSFER]: {
    label: '微信商家转账（已停用）',
    enabled: false,
    note: 'C11 后不再使用，仅用于解释历史流水',
  },
};

/** 打款批次状态（一期「清单导出 + 回执登记」的状态机） */
export enum PayoutBatchStatus {
  /** 已生成批次（待导出） */
  CREATED = 'created',
  /** 已导出清单 */
  EXPORTED = 'exported',
  /** 已提交灵活用工平台 */
  SUBMITTED = 'submitted',
  /** 平台已代发（已登记回执） */
  PAID = 'paid',
  /** 代发失败 */
  FAILED = 'failed',
}

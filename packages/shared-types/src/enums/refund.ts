/**
 * 退款 / 代退原因枚举（`ab_refund.reason_type`）
 *
 * 依据：《接口规范 v1.0》§4.2 L7（团长代退申请入参 `reasonType` 取值）
 *   `quality` 品质 / `missing` 缺漏 / `late` 延误 / `wrong` 错单 / `other` 其他
 *
 * C6 三段式：申请（本枚举）→ 后台审批 → 实际退款。
 */
export enum RefundReasonType {
  /** 品质问题（变味、异物、不新鲜） */
  QUALITY = 'quality',
  /** 缺漏（少送、漏菜） */
  MISSING = 'missing',
  /** 延误（送达超时） */
  LATE = 'late',
  /** 错单（送错楼/错份数/错套餐） */
  WRONG = 'wrong',
  /** 其他（需在 reason 中说明） */
  OTHER = 'other',
}

export const REFUND_REASON_LABEL: Record<RefundReasonType, string> = {
  [RefundReasonType.QUALITY]: '品质问题',
  [RefundReasonType.MISSING]: '缺漏少送',
  [RefundReasonType.LATE]: '配送延误',
  [RefundReasonType.WRONG]: '错单错送',
  [RefundReasonType.OTHER]: '其他',
};

/** 代退发起方（`ab_refund.apply_source`） */
export enum RefundApplySource {
  /** 用户自助（截单前） */
  USER = 'user',
  /** 团长代退（截单后唯一入口 · C6 第一段） */
  LEADER = 'leader',
  /** 后台强制（客诉兜底） */
  ADMIN = 'admin',
}

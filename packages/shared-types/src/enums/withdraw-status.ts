/**
 * 提现单状态机（`ab_withdraw.status`）
 *
 * 依据：《接口规范 v1.0》§4.4 L12/L13（团长提现申请 / 提现记录）
 *      + §6.5 D45/D46（后台提现审批）
 *      + C11（佣金出款走灵活用工平台，代扣代缴个税；一期 FLEX_MANUAL 人工登记）
 *
 * 流转：
 *   pending → approved → paying → success          （正常）
 *   pending → rejected                              （审批驳回，解冻余额）
 *   approved/paying → failed                        （打款失败，解冻余额，可重新申请）
 *
 * ⚠️ 只有 `pending/approved/paying` 占用（冻结）可用余额；
 *    `success` 转已提现（withdrawn_amount），`rejected/failed` 原路解冻。
 */
export enum WithdrawStatus {
  /** 待审批（申请已提交，余额已冻结） */
  PENDING = 'pending',
  /** 已批准（后台审批通过，待生成出款批次） */
  APPROVED = 'approved',
  /** 打款中（已提交灵活用工平台 / 人工转账处理中） */
  PAYING = 'paying',
  /** 已到账（税后金额已入团长账户） */
  SUCCESS = 'success',
  /** 已驳回（审批不通过，余额解冻） */
  REJECTED = 'rejected',
  /** 打款失败（通道异常，余额解冻） */
  FAILED = 'failed',
}

/** 提现状态 → 端上文案（团长侧与后台侧同文案，便于对账） */
export const WITHDRAW_STATUS_VIEW: Record<WithdrawStatus, string> = {
  [WithdrawStatus.PENDING]: '待审批',
  [WithdrawStatus.APPROVED]: '已批准',
  [WithdrawStatus.PAYING]: '打款中',
  [WithdrawStatus.SUCCESS]: '已到账',
  [WithdrawStatus.REJECTED]: '已驳回',
  [WithdrawStatus.FAILED]: '打款失败',
};

/** 占用（冻结）余额的状态集合 —— 申请提交即冻结，终态才释放 */
export const WITHDRAW_FROZEN_STATUS: WithdrawStatus[] = [
  WithdrawStatus.PENDING,
  WithdrawStatus.APPROVED,
  WithdrawStatus.PAYING,
];

/** 收款方式（C11 一期以银行对公/个人卡为主） */
export enum ReceiveType {
  BANK = 'bank',
  ALIPAY = 'alipay',
}

export const RECEIVE_TYPE_VIEW: Record<ReceiveType, string> = {
  [ReceiveType.BANK]: '银行卡',
  [ReceiveType.ALIPAY]: '支付宝',
};

/** 提现单号前缀（与 `common/utils/order-no.ts` 的 genWithdrawNo 对应） */
export const WITHDRAW_NO_PREFIX = 'WD';

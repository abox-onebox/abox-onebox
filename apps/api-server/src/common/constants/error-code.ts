/**
 * 全局错误码表
 *
 * 约定：0 = 成功；非 0 为失败。
 *   1xxxx 通用 / 鉴权
 *   2xxxx 用户与团长
 *   3xxxx 套餐与下单
 *   4xxxx 支付与退款
 *   5xxxx 财务与结算
 *   9xxxx 系统
 *
 * 与《接口规范 v1.0》§错误码 保持一致；新增须同步回该文档。
 */
export enum ErrorCode {
  OK = 0,

  /** ---- 1xxxx 通用 / 鉴权 ---- */
  PARAM_INVALID = 10001,
  UNAUTHORIZED = 10002,
  FORBIDDEN = 10003,
  NOT_FOUND = 10004,
  TOO_MANY_REQUESTS = 10005,
  CONFLICT = 10006,

  /** ---- 2xxxx 用户与团长 ---- */
  USER_NOT_FOUND = 20001,
  USER_DISABLED = 20002,
  LEADER_EXISTS = 20003,
  LEADER_NOT_FOUND = 20004,
  LEADER_DISQUALIFIED = 20005,

  /** ---- 3xxxx 套餐与下单 ---- */
  MEAL_NOT_FOUND = 30001,
  MEAL_NOT_ON_SALE = 30002,
  MEAL_SOLD_OUT = 30003,
  ORDER_CUTOFF = 30004,
  ORDER_NOT_FOUND = 30005,
  ORDER_STATUS_ILLEGAL = 30006,
  ORDER_DUPLICATED = 30007,

  /** ---- 4xxxx 支付与退款 ---- */
  PAY_FAILED = 40001,
  PAY_NOT_FOUND = 40002,
  REFUND_APPLY_CLOSED = 40003,
  REFUND_NOT_ALLOWED = 40004,
  REFUND_FAILED = 40005,

  /** ---- 5xxxx 财务与结算 ---- */
  SETTLE_AMOUNT_MISMATCH = 50001,
  WITHDRAW_BELOW_MIN = 50002,
  WITHDRAW_BALANCE_NOT_ENOUGH = 50003,
  PAYOUT_CHANNEL_ERROR = 50004,

  /** ---- 9xxxx 系统 ---- */
  INTERNAL_ERROR = 90001,
  SERVICE_UNAVAILABLE = 90002,
}

/** 默认文案（接口可覆盖） */
export const ERROR_MESSAGE: Record<number, string> = {
  [ErrorCode.OK]: 'ok',
  [ErrorCode.PARAM_INVALID]: '参数不合法',
  [ErrorCode.UNAUTHORIZED]: '未登录或登录已过期',
  [ErrorCode.FORBIDDEN]: '无权访问',
  [ErrorCode.NOT_FOUND]: '资源不存在',
  [ErrorCode.TOO_MANY_REQUESTS]: '请求过于频繁',
  [ErrorCode.CONFLICT]: '数据冲突，请重试',
  [ErrorCode.USER_NOT_FOUND]: '用户不存在',
  [ErrorCode.USER_DISABLED]: '账号已被停用',
  [ErrorCode.LEADER_EXISTS]: '你已是团长',
  [ErrorCode.LEADER_NOT_FOUND]: '团长身份不存在',
  [ErrorCode.LEADER_DISQUALIFIED]: '团长资格已失效',
  [ErrorCode.MEAL_NOT_FOUND]: '套餐不存在',
  [ErrorCode.MEAL_NOT_ON_SALE]: '当前不在预订时段',
  [ErrorCode.MEAL_SOLD_OUT]: '已售罄',
  [ErrorCode.ORDER_CUTOFF]: '已过截单时间，无法下单',
  [ErrorCode.ORDER_NOT_FOUND]: '订单不存在',
  [ErrorCode.ORDER_STATUS_ILLEGAL]: '订单状态不允许该操作',
  [ErrorCode.ORDER_DUPLICATED]: '请勿重复下单',
  [ErrorCode.PAY_FAILED]: '支付失败',
  [ErrorCode.PAY_NOT_FOUND]: '支付单不存在',
  [ErrorCode.REFUND_APPLY_CLOSED]: '截单后不可自助退款，请联系团长代退',
  [ErrorCode.REFUND_NOT_ALLOWED]: '该订单不支持退款',
  [ErrorCode.REFUND_FAILED]: '退款失败',
  [ErrorCode.SETTLE_AMOUNT_MISMATCH]: '结算金额校验不通过',
  [ErrorCode.WITHDRAW_BELOW_MIN]: '低于最低提现金额',
  [ErrorCode.WITHDRAW_BALANCE_NOT_ENOUGH]: '可提现余额不足',
  [ErrorCode.PAYOUT_CHANNEL_ERROR]: '出款通道异常',
  [ErrorCode.INTERNAL_ERROR]: '系统繁忙，请稍后再试',
  [ErrorCode.SERVICE_UNAVAILABLE]: '服务暂不可用',
};

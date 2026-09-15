/**
 * 全局错误码表
 *
 * ⚠️ **唯一事实来源 = 《ABox一盒接口规范v1.0.md》§九 错误码总表**
 *    （2026-09-15 裁定：文档 §九 为准，代码对齐文档；此前的 2xxxx/3xxxx/4xxxx/5xxxx
 *      段与文档语义逐条错位，已按文档重排 —— 详见《接口规范》§10 变更记录）
 *
 * 号段约定：
 *   0      成功
 *   1xxxx  通用 / 鉴权
 *   2xxxx  用户与团长
 *   3xxxx  套餐与下单
 *   4xxxx  支付 / 退款 / 出款
 *   5xxxx  财务 / 结算 / 供应商
 *   9xxxx  系统
 *
 * 【HTTP 状态码口径】
 *   业务失败**一律 HTTP 200**，由 `code` 表达业务结果（依据 §1.4：幂等命中即
 *   「`code:10006`，HTTP 200」，以及 §1.2「前端只按 `code === 0` 判成功」）。
 *   §九 的「建议 HTTP」列仅作**语义标注**，不参与端上判据。
 *   三个例外（保留真实 HTTP 码，供端上做拦截分支）：
 *     10002 未登录 → 401 · 10003 无权限 → 403 · 10005 限流 → 429
 *
 * 【扩展码】号段内文档未列、但工程需要的码，统一登记在号段末尾并标注「扩展」，
 *   上线前须回写《接口规范》§九。禁止挪用文档已占用的号位。
 */
export enum ErrorCode {
  OK = 0,

  /** ---- 1xxxx 通用 / 鉴权 ---- */
  PARAM_INVALID = 10001,
  UNAUTHORIZED = 10002,
  FORBIDDEN = 10003,
  NOT_FOUND = 10004,
  TOO_MANY_REQUESTS = 10005,
  DUPLICATE_SUBMIT = 10006,

  /** ---- 2xxxx 用户与团长 ---- */
  WX_CODE_INVALID = 20001,
  USER_NOT_FOUND = 20002,
  LEADER_DISQUALIFIED = 20003,
  PHONE_TAKEN = 20004,
  ADMIN_LOGIN_LOCKED = 20005,
  /** 扩展：账号已被停用（小程序用户黑名单，文档 §九 未列） */
  USER_DISABLED = 20006,
  /** 扩展：你已是团长（重复申请，文档 §九 未列） */
  LEADER_EXISTS = 20007,
  /** 扩展：暂不能退出团长（余额未结清 / 有在途提现 / 有待结算佣金） */
  LEADER_QUIT_BLOCKED = 20008,

  /** ---- 3xxxx 套餐与下单 ---- */
  /** 截单窗口外下单（U6 校验第 1 步） */
  ORDER_CUTOFF = 30001,
  /** 份数超出单次上限（U6 校验第 2 步） */
  QUANTITY_EXCEED = 30002,
  /** 状态机拒绝（U11 之外的非法迁移） */
  ORDER_STATUS_ILLEGAL = 30003,
  /** 同用户同日重复提交 */
  DUPLICATE_ORDER = 30004,
  /** 无套餐分配 —— 该办公楼今日未开团 */
  MEAL_NOT_PUBLISHED = 30005,
  /** 余额抵扣金额不合法（负数 / 非整数分） */
  BALANCE_AMOUNT_INVALID = 30006,
  /** 邀请码无效 —— 团长不存在或已停用 */
  LEADER_NOT_FOUND = 30007,
  /** 扩展：套餐不存在 */
  MEAL_NOT_FOUND = 30008,
  /** 扩展：已售罄 */
  MEAL_SOLD_OUT = 30009,
  /** 扩展：订单不存在 */
  ORDER_NOT_FOUND = 30010,

  /** ---- 4xxxx 支付 / 退款 / 出款 ---- */
  PAY_CREATE_FAILED = 40001,
  BALANCE_NOT_ENOUGH = 40002,
  WITHDRAW_BELOW_MIN = 40003,
  /** C6 拦截：已截单，用户不可自助退款（U11 截单后返回本码） */
  REFUND_NOT_ALLOWED = 40004,
  COMMISSION_SETTLE_FAILED = 40005,
  SHARE_ALREADY_PAID = 40006,
  PAYOUT_NOT_BOUND = 40007,
  REFUND_DUPLICATED = 40008,
  /** 扩展：支付单不存在 */
  PAY_NOT_FOUND = 40009,
  /** 扩展：退款失败 */
  REFUND_FAILED = 40010,

  /** ---- 5xxxx 财务 / 结算 / 供应商 ---- */
  SUPPLIER_NOT_QUALIFIED = 50001,
  DISTRIBUTION_CENTER_LOCKED = 50002,
  /** 扩展：结算等式不闭合（C9 校验） */
  SETTLE_AMOUNT_MISMATCH = 50003,
  /** 扩展：可提现余额不足 */
  WITHDRAW_BALANCE_NOT_ENOUGH = 50004,
  /** 扩展：出款通道异常（C11 灵活用工平台） */
  PAYOUT_CHANNEL_ERROR = 50005,

  /** ---- 9xxxx 系统 ---- */
  INTERNAL_ERROR = 90001,
  SERVICE_UNAVAILABLE = 90002,
}

/** 默认文案（与《接口规范》§九 message 列逐字一致；接口可覆写） */
export const ERROR_MESSAGE: Record<number, string> = {
  [ErrorCode.OK]: 'ok',
  [ErrorCode.PARAM_INVALID]: '参数校验失败',
  [ErrorCode.UNAUTHORIZED]: '未登录或登录已过期',
  [ErrorCode.FORBIDDEN]: '无权限访问该资源',
  [ErrorCode.NOT_FOUND]: '资源不存在',
  [ErrorCode.TOO_MANY_REQUESTS]: '请求过于频繁，请稍后再试',
  [ErrorCode.DUPLICATE_SUBMIT]: '请勿重复提交',
  [ErrorCode.WX_CODE_INVALID]: '微信登录凭证已失效，请重试',
  [ErrorCode.USER_NOT_FOUND]: '用户不存在',
  [ErrorCode.LEADER_DISQUALIFIED]: '团长身份已失效',
  [ErrorCode.PHONE_TAKEN]: '手机号已绑定其他账号',
  [ErrorCode.ADMIN_LOGIN_LOCKED]: '账号或密码错误，已锁定 15 分钟',
  [ErrorCode.USER_DISABLED]: '账号已被停用',
  [ErrorCode.LEADER_EXISTS]: '你已是团长',
  [ErrorCode.LEADER_QUIT_BLOCKED]: '暂不能退出：请先结清余额并等待提现到账',
  [ErrorCode.ORDER_CUTOFF]: '今日 24:00 已截单，明日请早',
  [ErrorCode.QUANTITY_EXCEED]: '份数超出单次上限',
  [ErrorCode.ORDER_STATUS_ILLEGAL]: '当前订单状态不支持该操作',
  [ErrorCode.DUPLICATE_ORDER]: '请勿重复下单',
  [ErrorCode.MEAL_NOT_PUBLISHED]: '该办公楼今日未开团',
  [ErrorCode.BALANCE_AMOUNT_INVALID]: '余额抵扣金额不合法',
  [ErrorCode.LEADER_NOT_FOUND]: '团长不存在或已停用',
  [ErrorCode.MEAL_NOT_FOUND]: '套餐不存在',
  [ErrorCode.MEAL_SOLD_OUT]: '已售罄',
  [ErrorCode.ORDER_NOT_FOUND]: '订单不存在',
  [ErrorCode.PAY_CREATE_FAILED]: '支付单创建失败，请稍后重试',
  [ErrorCode.BALANCE_NOT_ENOUGH]: '余额不足',
  [ErrorCode.WITHDRAW_BELOW_MIN]: '提现金额低于最低限额',
  [ErrorCode.REFUND_NOT_ALLOWED]: '已截单，无法自助退款',
  [ErrorCode.COMMISSION_SETTLE_FAILED]: '佣金结算失败，请联系运营',
  [ErrorCode.SHARE_ALREADY_PAID]: '该笔应付已付款，需走反向冲减',
  [ErrorCode.PAYOUT_NOT_BOUND]: '请先绑定收款方式',
  [ErrorCode.REFUND_DUPLICATED]: '退款申请已存在，请勿重复提交',
  [ErrorCode.PAY_NOT_FOUND]: '支付单不存在',
  [ErrorCode.REFUND_FAILED]: '退款失败',
  [ErrorCode.SUPPLIER_NOT_QUALIFIED]: '供应商资质未通过审核',
  [ErrorCode.DISTRIBUTION_CENTER_LOCKED]: '集散中心配置不可删除（存在历史结算）',
  [ErrorCode.SETTLE_AMOUNT_MISMATCH]: '结算金额校验不通过',
  [ErrorCode.WITHDRAW_BALANCE_NOT_ENOUGH]: '可提现余额不足',
  [ErrorCode.PAYOUT_CHANNEL_ERROR]: '出款通道异常',
  [ErrorCode.INTERNAL_ERROR]: '系统繁忙，请稍后再试',
  [ErrorCode.SERVICE_UNAVAILABLE]: '服务暂不可用',
};

/**
 * 需要保留真实 HTTP 状态码的业务码（其余业务失败一律 HTTP 200）。
 * 用途：端上需据 HTTP 码做全局拦截分支（跳登录 / 权限页 / 限流提示）。
 */
export const HTTP_STATUS_OVERRIDE: Partial<Record<ErrorCode, number>> = {
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.TOO_MANY_REQUESTS]: 429,
};

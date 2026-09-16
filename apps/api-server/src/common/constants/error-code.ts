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
 *   6xxxx  主数据（办公楼 / 楼群）
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
  /** 扩展（M3）：后台登录名已被占用（D52） */
  ADMIN_USERNAME_TAKEN = 20009,
  /** 扩展（M3）：该后台账号受保护，不能停用 / 降级（自己 / 最后一个超级管理员） */
  ADMIN_ACCOUNT_PROTECTED = 20010,
  /**
   * 扩展（M3-5）：任命对象不是可用用户（D20）
   *
   * 团长是**叠加在用户之上的身份**（L10），任命必须挂到一个已注册的 `ab_user` 上。
   * 传一个不存在的 userId 若被静默放过，会造出一条**没有微信身份的团长档案** ——
   * 该团长永远收不到取餐提醒、也没法登录小程序，是纯粹的脏数据。
   */
  LEADER_APPOINT_USER_INVALID = 20011,
  /**
   * 扩展（M3-5）：目标办公楼已有在职团长，转交需显式确认（D20）
   *
   * 附 `data.occupiedBy`（现任姓名与 id）供端上弹确认框。
   * 不默认顶替的理由：一次误点就把别人经营中的楼换了人，而对方的历史佣金、
   * 推荐关系、待结算佣金都还挂在他名下 —— 这种操作必须让人**看见对方是谁**再点。
   */
  BUILDING_LEADER_OCCUPIED = 20012,
  /**
   * 扩展（M3-5）：团长档案当前状态不支持该操作（D22 例外处理）
   *
   * 与 40013（退款单状态不允许）同一哲学：**对已处于目标态的档案重复操作是错误，
   * 不是幂等成功**。若返回成功，运营会以为「刚刚停用了他」，而其实他早就被停用了 ——
   * 审计链上就分不清是谁停的。
   */
  LEADER_STATUS_ILLEGAL = 20013,

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
  /** 扩展（M3-2）：该楼群在该出餐日已有套餐分配（D2 重复创建） */
  MEAL_ASSIGNMENT_EXISTS = 30011,
  /** 扩展（M3-2）：套餐分配不存在（D3/D4 目标 id 非法） */
  MEAL_ASSIGNMENT_NOT_FOUND = 30012,
  /**
   * 扩展（M3-2）：已过截单时刻，不能再上架（D4）
   *
   * ⚠️ 为什么必须拦：上架 = 用户端 `canOrder=true`，但下单会被截单硬闸（30001）拦下。
   *    放行就等于**让运营在后台亲手制造一个「看得见但点不动」的套餐**。
   */
  MEAL_PUBLISH_AFTER_CUTOFF = 30013,
  /**
   * 扩展（M3-3）：已过截单时刻，不能手动改单（D10）
   *
   * ⚠️ 与 30003 的分工：30003 是「状态不允许」（如已出餐 / 已退款单），
   *    本码专指**时间闸门**（订单状态可能仍是 `paid`，但截单已过 → 供应商已按
   *    原份数备货，再改单会让备货与单据对不上）。分开是为了让端上给出不同文案。
   */
  ORDER_ADJUST_AFTER_CUTOFF = 30014,
  /** 扩展（M3-3）：改单目标办公楼与订单不在同一楼群（D10） */
  ORDER_ADJUST_CROSS_GROUP = 30015,

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
  /** 扩展（M3-3）：强制退款的指定金额与可退金额不符（D11） */
  REFUND_AMOUNT_MISMATCH = 40011,
  /** 扩展（M3-4）：退款单不存在（D41/D42） */
  REFUND_NOT_FOUND = 40012,
  /** 扩展（M3-4）：退款单状态不允许该操作（如对已驳回的单再次审批） */
  REFUND_STATUS_ILLEGAL = 40013,
  /**
   * 扩展（M3-4）：缺少「申请前订单状态」，驳回不可执行（D42）
   *
   * 刻意 fail-closed：状态回退必须有据可依，猜一个状态比操作失败更糟。
   * 运营不会因此卡死 —— 兜底通道是 D11 强制退款。
   */
  REFUND_ORIGIN_UNKNOWN = 40014,

  /** ---- 5xxxx 财务 / 结算 / 供应商 ---- */
  SUPPLIER_NOT_QUALIFIED = 50001,
  DISTRIBUTION_CENTER_LOCKED = 50002,
  /** 扩展：结算等式不闭合（C9 校验） */
  SETTLE_AMOUNT_MISMATCH = 50003,
  /** 扩展：可提现余额不足 */
  WITHDRAW_BALANCE_NOT_ENOUGH = 50004,
  /** 扩展：出款通道异常（C11 灵活用工平台） */
  PAYOUT_CHANNEL_ERROR = 50005,
  /** 扩展（M3-6）：供应商不存在 / 已停用 */
  SUPPLIER_NOT_FOUND = 50006,
  /** 扩展（M3-6）：集散中心不存在 / 已停用 */
  DISTRIBUTION_CENTER_NOT_FOUND = 50007,
  /** 扩展（M3-6）：类型与关联集散中心冲突（D27 改类型会把集散中心指向「不出餐也不集散」的供应商） */
  SUPPLIER_TYPE_CONFLICT = 50008,

  /** ---- 6xxxx 主数据（办公楼 / 楼群）---- */
  /** 扩展（M3-7）：办公楼不存在（D13/D14/D15 目标 id 非法或已软删） */
  BUILDING_NOT_FOUND = 60001,
  /** 扩展（M3-7）：楼群不存在（D16/D17/D18 目标 id 非法或已软删） */
  BUILDING_GROUP_NOT_FOUND = 60002,
  /**
   * 扩展（M3-7）：楼群下仍有办公楼，不能停用（D18）
   *
   * ⚠️ fail-closed 的理由：停用楼群 = 该群退出套餐分配。若成员楼还挂着，
   *    那些楼会**静默**失去开团能力 —— 用户端「该办公楼今日未开团」，
   *    而运营在 P37 上看不出任何异常（楼还在、状态还是营业中）。
   *    要求先把楼搬走再停群，让「哪些楼被影响」是一个显式动作。
   */
  BUILDING_GROUP_NOT_EMPTY = 60003,
  /** 扩展（M3-7）：楼群名已存在（D17/D18） */
  BUILDING_GROUP_NAME_TAKEN = 60004,
  /** 扩展（M3-7）：办公楼名已存在（D14/D15）—— 同名楼会让「按楼筛选」变成歧义操作 */
  BUILDING_NAME_TAKEN = 60005,

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
  [ErrorCode.ADMIN_USERNAME_TAKEN]: '登录名已被占用',
  [ErrorCode.ADMIN_ACCOUNT_PROTECTED]: '该账号受保护，不能停用或降级',
  [ErrorCode.LEADER_APPOINT_USER_INVALID]: '被任命的用户不存在或不可用',
  [ErrorCode.BUILDING_LEADER_OCCUPIED]: '该办公楼已有在职团长，转交需确认',
  [ErrorCode.LEADER_STATUS_ILLEGAL]: '团长当前状态不支持该操作',
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
  [ErrorCode.MEAL_ASSIGNMENT_EXISTS]: '该楼群当日已有套餐分配，请直接编辑',
  [ErrorCode.MEAL_ASSIGNMENT_NOT_FOUND]: '套餐分配不存在',
  [ErrorCode.MEAL_PUBLISH_AFTER_CUTOFF]: '已过截单时刻，不能再上架',
  [ErrorCode.ORDER_ADJUST_AFTER_CUTOFF]: '已过截单时刻，不能再改单',
  [ErrorCode.ORDER_ADJUST_CROSS_GROUP]: '目标办公楼与订单不在同一楼群',
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
  [ErrorCode.REFUND_AMOUNT_MISMATCH]: '退款金额与可退金额不符',
  [ErrorCode.REFUND_NOT_FOUND]: '退款单不存在',
  [ErrorCode.REFUND_STATUS_ILLEGAL]: '退款单当前状态不支持该操作',
  [ErrorCode.REFUND_ORIGIN_UNKNOWN]: '退款申请缺少原状态记录，无法驳回',
  [ErrorCode.SUPPLIER_NOT_QUALIFIED]: '供应商资质未通过审核',
  [ErrorCode.DISTRIBUTION_CENTER_LOCKED]: '集散中心配置不可删除（存在历史结算）',
  [ErrorCode.SETTLE_AMOUNT_MISMATCH]: '结算金额校验不通过',
  [ErrorCode.WITHDRAW_BALANCE_NOT_ENOUGH]: '可提现余额不足',
  [ErrorCode.PAYOUT_CHANNEL_ERROR]: '出款通道异常',
  [ErrorCode.SUPPLIER_NOT_FOUND]: '供应商不存在或已停用',
  [ErrorCode.DISTRIBUTION_CENTER_NOT_FOUND]: '集散中心不存在或已停用',
  [ErrorCode.SUPPLIER_TYPE_CONFLICT]: '供应商类型与关联集散中心冲突',
  [ErrorCode.BUILDING_NOT_FOUND]: '办公楼不存在',
  [ErrorCode.BUILDING_GROUP_NOT_FOUND]: '楼群不存在',
  [ErrorCode.BUILDING_GROUP_NOT_EMPTY]: '楼群下仍有办公楼，请先移出成员楼',
  [ErrorCode.BUILDING_GROUP_NAME_TAKEN]: '楼群名已存在',
  [ErrorCode.BUILDING_NAME_TAKEN]: '办公楼名已存在',
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

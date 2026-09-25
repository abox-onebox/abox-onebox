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
  /**
   * 扩展（M5-20）：账号已注销（`ab_user.status = 3`）—— 登录与后续调用一律拦下
   *
   * ⚠️ **刻意不复用 `20006 USER_DISABLED`（黑名单）**：两者都是「账号不能用」，
   *    但**用户可见的动作完全不同** —— 黑名单是**平台侧处罚**，用户只能申诉；
   *    注销是**用户自己发起的**，他需要知道「是我注销的、我能怎么恢复」。
   *    合成一个码会让注销过的人看到「账号已被停用」，以为被封号了。
   *    （与 40015/40002、40017/40013 的取舍同源：形态相似、**排查入口不同**。）
   */
  ACCOUNT_CANCELED = 20014,
  /**
   * 扩展（M5-20）：暂不能注销 —— 存在未结清事项
   *
   * 附 `data.reasons: string[]`（`leader` 在职团长 / `balance` 有余额或冻结 /
   * `orders` 有在途订单），供端上逐条列出**为什么现在不能注销**。
   *
   * ⚠️ 为什么必须拦而不是「连余额一起清掉」：注销是不可逆动作，而余额与订单
   *    是**钱**。一期没有「余额清零/退款到微信」的自动通道（出款走灵活用工，
   *    见佣金口径），自动清掉就等于**用户的钱被系统吞了**，且**不会有任何报错**。
   *    fail-closed 在这里的正确含义是把用户挡在一次失败上，而不是让他安静地损失。
   */
  ACCOUNT_CANCEL_BLOCKED = 20015,

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
  /**
   * 扩展（M5-1）：配送单已被他人修改（D62 · `version` 乐观锁冲突）
   *
   * 附件 `data.current`（当前 `version` 与全量字段）供端上刷新后重提。
   *
   * ⚠️ 为什么必须拦而不是「后写覆盖前写」：配送单的份数是**要照着装车**的数字，
   *    两个运营先后改同一张单（A 改份数 / B 改司机），后写者会用自己那份**旧快照**
   *    把前者的份数一起覆盖回去 —— 表现为「改了但没生效」，而且**任何一方都不会报错**，
   *    直到装错货。这与 #61「定格错了就没救」是同一类风险，故给一个显式闸门。
   *
   * 刻意**不复用** `30011 MEAL_ASSIGNMENT_EXISTS`（重复创建）或 `30003`（状态机拒绝）：
   * 那两者都不带「当前值」，端上无法据此自动恢复；本码必须携带 `current`。
   */
  DELIVERY_CONFLICT = 30016,
  /**
   * 扩展（M5-1）：配送单不存在（D62 目标 id 非法）
   *
   * 与 30010（订单不存在）/ 40012（退款单不存在）同族：**每张单有自己的排查入口**，
   * 「查哪张单」这件事不该让运营去猜。
   */
  DELIVERY_NOT_FOUND = 30017,
  /**
   * 扩展（M5-8）：配送单状态**不能这样推进**（D63）
   *
   * 配送单是 `pending → called → en_route → arrived` 的**单向**履约流，只允许向前。
   * 回退 / 跳级 / 原地不动一律拒绝，并回带 `data.allowed`（当前状态允许推进到哪几态）
   * 与 `data.current`（当前值与版本），让端上能直接照着刷新。
   *
   * ⚠️ **刻意不复用 `30016`（乐观锁冲突）**：两者形态相似（都是「这次写入没落」），
   *    但**排查入口完全不同** —— `30016` 说「别人改过了，刷新重提即可」，
   *    本码说「刷新也没用，你按的是错的按钮」。合成一个码会让运营反复刷新后重试，
   *    而正确的动作其实是换一个动作或找技术核对。
   * ⚠️ **也不复用 `30003`（订单状态机拒绝）**：那是订单域的话术，配送单没有「订单状态」。
   */
  DELIVERY_STATUS_ILLEGAL = 30018,
  /**
   * 扩展（M5-15）：套餐模板**已进入排期**，菜品与售价不能再改（D7b 编辑模板）
   *
   * 判据：该模板被**至少一个未取消的分配**（`ab_meal_assignment.status != 'cancelled'`）引用。
   * 此时它已经是「某天某个楼群卖的那份饭」——
   *   · 改 `items`：当天已上架的菜品构成会**追溯变化**（用户端看到的菜变了，
   *     而供应商那边的备料量是照**旧构成**推的）→ 备料与菜单对不上；
   *   · 改 `price`：`ab_set_meal.price` 是用户端「明日套餐」的**展示价**，
   *     改一下就是同一份饭在同一天两个价。
   *
   * ⚠️ **刻意不复用 `30003`（订单状态机拒绝）**：那是订单域的话术；
   *    也不复用 `30011`（分配已存在）—— 两者排查入口完全不同。
   *    本码回带 `data.usedCount` 与 `data.assignmentDates`，运营据此知道
   *    「被哪几天占着」，要么先取消那些分配，要么另存一条新模板。
   * ⚠️ 名称 / 一句话介绍 / 描述 / 封面 / **上下架状态** 不受本闸门限制
   *    （改名不影响任何人的备料与价格）。
   */
  MEAL_TEMPLATE_IN_USE = 30019,

  /**
   * 扩展（U2 口味评价）：订单当前状态不可评价（U20）
   *
   * 判据：`status ∉ { delivered, completed }`。
   * 只有「已送达 / 已完成」的单才允许评价 —— 没吃到饭就评价，红黑榜会被
   * 「预期不满」而不是「口味反馈」污染（那该走客服/退款通道）。
   *
   * ⚠️ **刻意不复用 `30003`（订单状态机拒绝）**：那是「取消/改单」类操作对状态机的话术；
   * 评价的排查入口是「订单走到哪一步了」，回带 `data.allowed`（可评状态集）与
   * `data.status`（当前状态），端上据此给出「送达后可评价」的引导而不是干报错。
   */
  RATING_NOT_ALLOWED = 30020,
  /**
   * 扩展（U2 口味评价）：该订单已评价过，不可修改（U20）
   *
   * ⚠️ **裁决（2026-09-25 · P1-U2）**：评价**一次提交即定稿、不可改** ——
   *   ① 聚合口径要稳：允许改评就得处理「改评迁移」（旧分撤回、新分入账），
   *      红黑榜与月投诉计数都得多一套「以哪个为准」的口径；
   *   ② 极简：真源《系统地图》U2 的量级是「一个评价按钮 + 一张聚合表」；
   *   ③ 后悔的极端个案走客服（与「改价/改单」同一兜底路径）。
   *
   * ⚠️ **刻意不复用 `10006`（幂等重放）**：重放返回首次**成功结果**（HTTP 语义上是成功），
   * 而这里是**拒绝**新提交 —— 两者对端上的处理方式完全不同（前者可以当成功吞掉）。
   * 回带 `data.ratedAt`，端上直接切「已评价」终态展示。
   */
  RATING_ALREADY_SUBMITTED = 30021,

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
  /**
   * 扩展（M3-14）：冻结余额不足（D39 解冻超出该用户已冻结额）
   *
   * ⚠️ 刻意**不复用** `40002 BALANCE_NOT_ENOUGH`（可用余额不足）：
   *    两者运维含义完全不同 —— 前者是「钱不够花」，用户充值/等回款即可；
   *    本码是「**冻结账对不上**」，说明存在绕过冻结口径的写点，属**账实不符**信号，
   *    要查的是数据结构而不是让人去充钱。合成一个码会把这条线索埋掉。
   */
  BALANCE_FROZEN_NOT_ENOUGH = 40015,
  /** 扩展（M4-4）：提现单不存在（D45/D46 系列） */
  WITHDRAW_NOT_FOUND = 40016,
  /**
   * 扩展（M4-4）：提现单当前状态不支持该操作（D46 系列）
   *
   * ⚠️ 刻意**不复用** `40013 REFUND_STATUS_ILLEGAL`：两者虽然形态相同，
   *    但**排查入口不同** —— 退款单去 D40 看，提现单去 D45 看，运营拿到一个码
   *    就知道该去哪个页面找这张单。合成一个码会让「这是哪张单的子状态机报的」
   *    在一堆日志里失去线索（与 40015 复用 `40002` 的取舍同理）。
   */
  WITHDRAW_STATUS_ILLEGAL = 40017,
  /**
   * 扩展（M5-7）：余额行被并发修改，乐观锁未命中（`affected = 0`）
   *
   * ⚠️ 刻意**不复用** `40002 BALANCE_NOT_ENOUGH`：本码的运维含义**不是**「钱不够花」，
   *    而是「**有另一路写点正在动这条余额**」（跑批入账 × 退款退回 / 双提现撞车）。
   *    收到本码说明系统按设计 **fail-closed 停住了，不是故障** —— 重试即可；
   *    真正要查的是「哪两路在抢同一个账户」，排查入口是并发路径而不是余额数字。
   */
  BALANCE_CONCURRENT_MODIFIED = 40018,
  /**
   * 扩展（M5-7）：订单用了余额抵扣，但该用户**没有余额账户**（数据异常）
   *
   * 语义：钱在订单上记着扣过，`ab_balance` 里却根本没有这个账户 ——
   * 说明存在绕过余额写点的路径。此时退款**必须停住**：
   * 继续退会让「出参说已退、账本无痕迹、用户没收到」三件事同时错（缺陷 #82）。
   * 与 `40015` 同属「**账实不符信号**」，要查的是数据结构而不是催人充值。
   */
  BALANCE_ACCOUNT_MISSING = 40019,

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
  /**
   * ⚠️ **已失效（M4-0 · 自营口径）· 号位保留，代码中不再有触发点**
   *
   * 扩展（M3-6）：类型与关联集散中心冲突（D27 改类型会把集散中心指向「不出餐也不集散」的供应商）。
   *
   * 该闸门的前提是「集散中心挂在某供应商名下、且只有集散型/混合型能挂」——
   * 自营下加工场所属 ABox 自有（`ab_distribution_center.supplier_id` 已停用）、
   * 供应商也不再有类型（`ab_supplier.type` 已停用），前提整体消失，
   * D27 端点连同 D30/D31 的挂载校验一并删除。
   * **保留号位而不回收**：下游（前端 / 文档 / 排查手册）可能仍按 50008 检索历史问题单，
   * 号位换了含义会让老排查记录指向错误的原因（同 50014 的处理）。
   */
  SUPPLIER_TYPE_CONFLICT = 50008,
  /**
   * 扩展（M3-8）：出餐确认已过截止时间（S2 · 出餐日当天 09:30 之后）
   *
   * ⚠️ 这是 **deadline 而非 earliest** —— 提前确认（T-1 备好就确认）是**允许**的，
   *    只有「出餐日当天过了 09:30 才来确认」才拦。理由：09:30 是**集散中心开始打包**的
   *    上游时点，晚了则集散中心拿不到到位信号、当日配送链断在源头。
   *    刻意 fail-closed：不允许「补确认」把已错过的时点抹平 —— 事后补救走线下，
   *    系统里的时间戳必须诚实（对账与追责都以它为准）。
   */
  COOK_CONFIRM_OVERDUE = 50009,
  /** 扩展（M3-8）：当日无该菜品生产计划（S2 目标项不存在 / 不属于本供应商） */
  PRODUCE_PLAN_NOT_FOUND = 50010,
  /**
   * 扩展（M3-8）：集散中心不在该菜品的配送范围（S2）
   *
   * 越界确认必须拦：否则供应商能把 A 片的份数确认到 B 片头上，S3 在 B 片
   * 会显示「已到齐」而实物没到 —— 打包线在错误的时点开动。
   */
  COOK_CONFIRM_CENTER_MISMATCH = 50011,
  /**
   * 扩展（M3-9）：应付单不存在，或当前状态不允许该操作（付款登记 / 纠错冲销）
   *
   * 与 50006/50007 同一形态：「查得到但动不了」与「压根不存在」合流一个码
   * （对操作员是同一件事 —— 这条单现在动不了）。
   * 付款登记**只接受 `pending`**：已付款的单再登记一次就是**重复出款**，
   * 钱转出去就追不回来，故 fail-closed。
   */
  SUPPLIER_SHARE_NOT_PAYABLE = 50012,
  /** 扩展（M3-9）：付款登记缺银行回单号（`paymentVoucherNo` 必填 —— 它是付款完成的唯一凭证） */
  PAYMENT_VOUCHER_REQUIRED = 50013,
  // 注（M3-9）：**「出餐确认未完成 → 不出单」刻意不设错误码**。
  //   它不是一次失败，而是「这天还缺输入」的常态待办：转人工进
  //   「未出单异常清单」（`GET /admin/supplier-shares/exceptions?date=`），逐条给原因。
  //   做成错误码的话，运营只会看到「出单失败」，看不到「哪几家没确认」——
  //   而那恰恰是他唯一能执行的线索。原预留号位 `50014` 未使用，**已释放**。

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
  [ErrorCode.ACCOUNT_CANCELED]: '该账号已注销，如需恢复请联系客服',
  [ErrorCode.ACCOUNT_CANCEL_BLOCKED]: '存在未结清事项，暂不能注销',
  [ErrorCode.ORDER_CUTOFF]: '今日 24:00 已截单，明日请早',
  [ErrorCode.QUANTITY_EXCEED]: '份数超出单次上限',
  [ErrorCode.ORDER_STATUS_ILLEGAL]: '当前订单状态不支持该操作',
  [ErrorCode.DUPLICATE_ORDER]: '请勿重复下单',
  [ErrorCode.MEAL_NOT_PUBLISHED]: '该办公楼今日未开团',
  [ErrorCode.DELIVERY_STATUS_ILLEGAL]: '配送单当前状态不支持该推进（履约流只能向前）',
  [ErrorCode.MEAL_TEMPLATE_IN_USE]:
    '该套餐已排进某天的出餐计划，菜品与售价不能再改（可改名称，或另存为新模板）',
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
  /**
   * 30016 / 30017 此前**没有文案**（与 30020 / 30021 同族，由同一次覆盖度机算扫出）。
   * 现有抛点都自带 `message` 覆写（`delivery.service.ts` 647/987/653/710/993/1069），
   * 故兜底文案平时**看不到** —— 但它守的是「下一次新增抛点忘了带文案」：
   * 那一次用户会直接落到 `biz.exception.ts:24` 的「业务异常」四个字。
   */
  [ErrorCode.DELIVERY_CONFLICT]: '配送单已被他人修改，请刷新后重试',
  [ErrorCode.DELIVERY_NOT_FOUND]: '配送单不存在',
  /**
   * U20 评价：这两条此前**没有文案** ⇒ 落到 `biz.exception.ts:24` 的兜底，
   * 用户只看到「业务异常」四个字（既没说清能不能评价，也没说清为什么）。
   */
  [ErrorCode.RATING_NOT_ALLOWED]: '当前订单状态不允许评价',
  [ErrorCode.RATING_ALREADY_SUBMITTED]: '该订单已评价过，不能重复提交',
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
  [ErrorCode.BALANCE_FROZEN_NOT_ENOUGH]: '冻结余额不足',
  [ErrorCode.WITHDRAW_NOT_FOUND]: '提现单不存在',
  [ErrorCode.WITHDRAW_STATUS_ILLEGAL]: '提现单当前状态不支持该操作',
  [ErrorCode.BALANCE_CONCURRENT_MODIFIED]: '余额已被其它操作改动，请重试',
  [ErrorCode.BALANCE_ACCOUNT_MISSING]: '该用户余额账户缺失，操作已中止（请联系技术核对余额数据）',
  [ErrorCode.SUPPLIER_NOT_QUALIFIED]: '供应商资质未通过审核',
  [ErrorCode.DISTRIBUTION_CENTER_LOCKED]: '集散中心配置不可删除（存在历史结算）',
  [ErrorCode.SETTLE_AMOUNT_MISMATCH]: '结算金额校验不通过',
  [ErrorCode.WITHDRAW_BALANCE_NOT_ENOUGH]: '可提现余额不足',
  [ErrorCode.PAYOUT_CHANNEL_ERROR]: '出款通道异常',
  [ErrorCode.SUPPLIER_NOT_FOUND]: '供应商不存在或已停用',
  [ErrorCode.DISTRIBUTION_CENTER_NOT_FOUND]: '集散中心不存在或已停用',
  [ErrorCode.SUPPLIER_TYPE_CONFLICT]: '供应商类型与关联集散中心冲突',
  [ErrorCode.COOK_CONFIRM_OVERDUE]: '已过出餐确认截止时间（09:30），请联系运营线下处理',
  [ErrorCode.PRODUCE_PLAN_NOT_FOUND]: '当日无该菜品生产计划',
  [ErrorCode.COOK_CONFIRM_CENTER_MISMATCH]: '集散中心不在该菜品的配送范围',
  [ErrorCode.SUPPLIER_SHARE_NOT_PAYABLE]: '应付单不存在或当前状态不可操作',
  [ErrorCode.PAYMENT_VOUCHER_REQUIRED]: '请填写银行回单号（付款完成的唯一凭证）',
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

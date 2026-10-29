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
  /** 扩展（P2）：账号要求首次登录改密，必须改密后才能继续操作 */
  MUST_CHANGE_PASSWORD = 10007,

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
  /**
   * 扩展：用户未绑定办公楼（`ab_user.building_id` 为空）→ 无法解析楼群与次日套餐
   *
   * ⚠️ **为什么不能继续复用 `10004 NOT_FOUND`**：`MealService.resolveUserGroup`
   *    **原**有两处抛 10004 —— 「未绑定办公楼」与「所属办公楼未配置楼群」。
   *    前者**用户可以自己解决**（自助选楼），后者**只能找运营**（配楼群）。
   *
   *    ⚠️ **现状（N1 · P3-4 + 收尾批已改码，此处保留旧口径仅为说明「为什么必须拆开」）**：
   *    「未绑定办公楼」→ **`20016 USER_BUILDING_UNBOUND`**（本码）；
   *    「所属办公楼未配置楼群」→ **`60011 BUILDING_NOT_GROUPED`**。
   *    **不要照这段旧描述把任何一处回改成 10004。** 拆码的理由见 N1 的 ADR。
   *
   *    合成一个码，端上就只能给一句两可的兜底文案，结果是：
   *    首页 `emptyText` 对任何错误都显示「本楼今日未开团」，
   *    「你还没选楼」这件本可自助的事被彻底藏起来（真实联调里表现为
   *    「扫码进来一片空白 + 重新加载」，没有任何出口）。
   *
   *    端上收到本码 → 空态主按钮换成「选择办公楼」直达 `pages/building/switch`；
   *    收到 `60011` → 提示语用服务端 message（讲的是楼群配置，用户只能找运营）。
   */
  USER_BUILDING_UNBOUND = 20016,

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
   * 扩展（M5-15）：套餐模板**已进入排期**，商品与售价不能再改（D7b 编辑模板）
   *
   * 判据：该模板被**至少一个未取消的分配**（`ab_meal_assignment.status != 'cancelled'`）引用。
   * 此时它已经是「某天某个楼群卖的那份饭」——
   *   · 改 `items`：当天已上架的商品构成会**追溯变化**（用户端看到的菜变了，
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
  /**
   * 扩展（2026-10-08 · P1-5 / BE-05 收口）：订单行被并发修改，`version` 乐观锁未命中
   *
   * 语义：**你手上那份快照已经过期** —— 从你读到这次写入之间，有另一路写点改过这行
   * （另一路改单 / 支付回调 / 退款回退 / 跑批）。此时**必须 fail-closed 抛错**，
   * 不能用过期快照继续写：后写者会把前者的结果整行覆盖回去，且**任何一方都不报错**
   * （表现是「改了但没生效」，与 `30016 DELIVERY_CONFLICT` 同一族）。
   *
   * ⚠️ 刻意**不复用** `30003 ORDER_STATUS_ILLEGAL`：那个码说的是「状态不允许」，
   *    本码说的是「**值过期**」—— 状态可能仍然合法。排查入口也不同：
   *    30003 去看状态机，本码去看「哪两路在写同一行」。
   * ⚠️ 也**不复用** `40018 BALANCE_CONCURRENT_MODIFIED`：那是**余额行**的锁，
   *    「每张单有自己的排查入口」是本仓一贯口径（见 40017 注释）。
   *
   *
   * ⚠️ **λ 批次（#38-A · 2026-10-09）已把「调用方违约」拆走 → `30023`**：
   *    本码现在**只**由 `order-admin.service.ts` 的两处真并发 CAS 抛出
   *    （改份数 / 改楼，共 2 处 —— 由 `e2e:m3` 的 D10-F 段机械守着）。
   *    拆的理由见 `30023` 的注释。
   */
  ORDER_CONCURRENT_MODIFIED = 30022,
  /**
   * λ 批次（#38-A · 2026-10-09）· `syncFrozenBalance` 的**调用方违约**（**不是**并发）
   *
   * 判据（两处，都在 `order.service.ts#syncFrozenBalance`）：
   *   ① 入口断言「行上 `version` == `versionBeforeCas` + 1」不成立；
   *   ② 写回抵扣额时 `affected === 0`。
   * 两者说的是同一件事：**调用方没按契约先在同一事务里做一次真 CAS
   * （`WHERE version = :v`）就动钱了**（或交上来的凭证与真实 CAS 不一致）。
   *
   * ## 为什么要跟 `30022` 拆开 —— 拆的是**排查入口**，不是端上分支
   *
   * · **可观测性**：`30022` 说的是「有另一路写点在跟你抢」（外部时序，重试有用）；
   *   本码说的是「**有个调用点写错了**」（内部缺陷，重试无用 —— 只能改代码）。
   *   两者此前共用一个码 ⇒ 日志 / 监控 / 告警里**完全同形**，于是「线上真有人在
   *   并发改单」与「某个调用点漏做 CAS」看不出区别；后者若被当成并发去重试，
   *   只会把自己**伪装成偶发冲突**，然后一直留着。
   * · **可断言性**：拆开后两边各有独立判据 —— `e2e:m3` 的 D10-F 段机械断言
   *   「本码恰好挂在 `order.service.ts` 的两处、`30022` 恰好挂在
   *   `order-admin.service.ts` 的两处」，且两条**文案必须不同**；
   *   谁把违约路径改回 `30022`，那条断言当场红。
   *
   * ⛔ 拆码**不是**为了给端上分派「重不重试」—— 端上不该靠码名猜语义；
   *    两条路径的文案各自把「下一步该找谁」说清楚。
   *
   * ⚠️ 真相仍**同时**打进服务端日志（`order.service.ts` 那两处 `logger.error`，
   *    本次拆码时**一行未动**）：错误码给**排查与断言**分派入口，日志给人看现场 ——
   *    两者不是一回事，不该二选一。
   */
  ORDER_FROZEN_SYNC_CAS_VIOLATION = 30023,
  OP_BLOCKED = 30024,

  /**
   * 凭证不存在（或不属于该配送单）
   *
   * ⚠️ 刻意**不复用 `DELIVERY_NOT_FOUND`（30017）**：那是「配送单没有」，
   *    本码是「配送单有、这张凭证不在它名下」—— 端上动作完全不同
   *    （前者整页刷新，后者只重拉凭证列表）。混用一个码会让端上无法分辨，
   *    只能一律整页刷 —— 而「软删一张凭证导致整页重来」是明显的体验倒退。
   */
  DELIVERY_PROOF_NOT_FOUND = 30025,

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
  /**
   * 扩展（代金券 · 2026-10-23）：这张券**现在用不了**（D: 核销入口）
   *
   * 四种成因**合流一个码**：券码不存在 / 不属于当前用户 / 已使用 / 不在有效期窗口
   * （未到生效日 或 已过期）。
   *
   * ⚠️ 为什么合流：对**用户**是同一件事 —— 他手上那张券当下不能抵；
   *    排查入口也同一处 —— 去「我的优惠券」看这张券的状态与有效期。
   *    拆成四个码只会让端上写四条分支，而**动作完全一样**（回券列表刷新）。
   *    具体的那一条原因由 `message` 说清（`reserveForOrder` 逐条覆写）。
   *
   * ⚠️ 刻意**不复用** `10004 NOT_FOUND`：券码查不到跟「资源不存在」形态相同，
   *    但这里是**钱**的路径（影响 `payAmount`），必须能单独告警与对账。
   */
  COUPON_NOT_USABLE = 40020,
  /**
   * 扩展（代金券 · 2026-10-23）：订单金额未达券的使用门槛（D: 核销入口）
   *
   * ⚠️ 刻意**与 `40020` 分开**：两者端上动作**不同** ——
   *    `40020` 是「这张券废了，回列表刷新」；
   *    本码是「这张券没问题，**加份数就能用**」（回下单页改份数重算）。
   *    合成一个码会让用户以为券坏了，而正确的动作其实是多订一份。
   *    回带 `data.thresholdFen` / `data.totalFen`，端上可直接提示「再订 N 元可用」。
   */
  COUPON_THRESHOLD_NOT_MET = 40021,
  /**
   * 扩展（代金券 · 2026-10-23）：**券种定义**不可用（D: 后台发券入口）
   *
   * 三种成因：券种不存在 / 已停用 / 已达发行上限（`issued_count >= total_limit`）。
   *
   * ⚠️ 刻意**与 `40020` 分开**：本码是**运营侧**（后台发券时选错了券种），
   *    `40020` 是**用户侧**（下单核销）。两者的处理人、处理页面、下一步动作
   *    全不同 —— 运营收到本码要去券种列表改配置；用户永远不会碰到它。
   */
  COUPON_DEF_INVALID = 40022,
  /**
   * 扩展（代金券 · 2026-10-23）：发券参数不合法（period 型券缺起止日 / 面额非正）
   *
   * ⚠️ 这是**调用方违约**而非用户输入错误：能调到这里的是后台与内部发放钩子
   *    （如推荐转正发券），参数由代码拼装。故意**不复用** `10001 PARAM_INVALID`
   *    —— 那个码走的是校验管线（前端能自己修），本码说明**后端拼参的那段写错了**，
   *    重试无用、只能改代码（与 `30023` 拆 `30022` 同一取舍）。
   */
  COUPON_GRANT_PARAM_INVALID = 40023,

  /**
   * D3 提现规则定稿（2026-10-26）：单日累计提现额超过 `commission.withdraw_daily_limit`。
   *
   * ⚠️ **判定基准是「自然日」而非「滚动 24 小时」**：北京时区 00:00–24:00，
   *    用 `bjDateTime(dateStr, 24)` 取含尾上界（详见 `withdraw.service.apply()`）。
   *    只在**数据库事务内**读当日 SUM，事务外读会让两个并发请求都读到旧值、都通过。
   *
   * ⚠️ 计入 pending/approved/paying/success，**rejected/failed 不计**（钱已原路解冻，
   *    再拦一次等于罚站长）。
   */
  WITHDRAW_DAILY_LIMIT_EXCEEDED = 40024,

  /**
   * D3 提现规则定稿（2026-10-26）：同一自然日已有非终态提现申请，不可重复申请。
   *
   * ⚠️ **刻意与 `40024` 分开**：两者端上动作不同 ——
   *    `40024` 是「今天额度用完了，明天再来 / 改小金额」；
   *    `40025` 是「今天已经提过了，等这笔处理完（或驳回后）再说」。
   *
   * 与 `40024` 共用一次查询（同一区间取 SUM + COUNT），**先判笔数再判金额**，
   * 故 `daily_count=1` 时永远先看到本码 —— 验收 `40024` 需临时把 `daily_count` 调大。
   */
  WITHDRAW_DAILY_DUPLICATED = 40025,
  /**
   * 扩展（P3 · 2026-10-29）：向微信「查单」失败（通道不可用 / 验签 / 网络 / 超时）
   *
   * ⚠️ 刻意**不复用** `40001 PAY_CREATE_FAILED`：后者是「下单没下出去」，
   *    本码是「**已经下过单、现在查不到它的真实状态**」—— 前者用户重试即可，
   *    后者意味着这笔钱**可能已经收了而本地还挂着未支付**，是**资金差错**信号，
   *    必须让运维一眼看出「该去查单补齐，不是让用户重试」。
   *
   * ⚠️ 与 `40009 PAY_NOT_FOUND` 的区别：40009 = 微信**明确回答**「没有这笔单」
   *    （是确定结论）；本码 = **根本没拿到回答**（是不确定，必须重试）。
   */
  PAY_QUERY_FAILED = 40026,
  /**
   * 扩展（H9 · 2026-10-29）：订单完成后已超出**可退时限**（`refund.completed_window_hours`）
   *
   * ⚠️ 刻意**不复用** `40004 REFUND_NOT_ALLOWED`：那是「已截单，用户不能自助退」，
   *    本码是「**团长代退也过期了**」—— 前者走团长代退即可解决，
   *    后者意味着佣金可能早已结算并提现，再退就会把团长余额扣成负（欠款）。
   *
   * ⛔ **兜底通道不受本码限制**：`forceRefund`（D11 后台强制退款）**刻意不校验时限** ——
   *    它是用户拿回钱的最后一条路，被时限堵死等于「系统收了钱、谁也退不出来」。
   *    超期又确需退款时必须走 D11，且全程写操作日志（本就是 D11 的既有要求）。
   */
  REFUND_WINDOW_EXPIRED = 40027,
  /**
   * 扩展（E5 · 2026-10-29）：批量退款审批的 id 数超过单次上限
   *
   * ⚠️ 刻意**不复用** `10001 PARAM_INVALID`：那是「参数不合法，改改再提」的通用校验；
   *    本码是**操作规模**超限 —— 参数全都合法，只是这一批太大，必须拆开点。
   *    两者对运营的动作不同：前者改参数，后者分批次。
   *
   * ⚠️ 为什么要有上限（而不是来多少处理多少）：批量**串行**执行，且每笔都是资金动作。
   *    一次退几百笔、返回里夹着 3 笔失败，运营**不会**去看那 3 笔是谁 ——
   *    「看不完的结果」等于没有结果。与其事后对账，不如在入口就把批次切到人能核对的规模。
   */
  REFUND_BATCH_TOO_LARGE = 40028,

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
  /** 扩展（M3-8）：当日无该商品生产计划（S2 目标项不存在 / 不属于本供应商） */
  PRODUCE_PLAN_NOT_FOUND = 50010,
  /**
   * 扩展（M3-8）：集散中心不在该商品的配送范围（S2）
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
  /** 扩展（N2）：办公楼存在未完结订单，不能直接停用（1 ≤ N ≤ 阈值，需 force + reason） */
  BUILDING_UNFINISHED_ORDERS = 60006,
  /** 扩展（N2）：楼群存在未完结订单，不能直接停用 */
  BUILDING_GROUP_UNFINISHED_ORDERS = 60007,
  /**
   * 扩展（N1）：不能把办公楼挂进已停用的楼群
   *
   * ⚠️ 为什么必须有它：`BUILDING_GROUP_NOT_EMPTY`(60003) 只保证「停用楼群时成员为 0」，
   *    但 `assignMembers()` 与 `updateBuilding(buildingGroupId)` **都不检查目标楼群状态** ——
   *    运营往已停用楼群里搬楼，成员楼会静默失去开团能力。这是 60003 的两条旁路。
   */
  BUILDING_GROUP_SUSPENDED_REJECT = 60008,
  /** 扩展（W1）：当前已一键停售（全局暂停接单） */
  SALES_PAUSED = 60009,
  /**
   * 扩展（N1）：该办公楼**已被运营主动停用**（preparing / suspended / 所属楼群已停用）
   *
   * ⚠️ 与 60011 的区别是**处置动作不同**：本码 = 运营自己停的（无需动作，不该告警）；
   *    60011 = 漏配（是事故，要告警）。合成一码会让日志/监控/告警完全同形 ——
   *    本仓拆 `30022` / `30023` 时给的就是这个理由。
   */
  BUILDING_SUSPENDED = 60010,
  /**
   * 扩展（N1）：该办公楼**未配置楼群**（配置缺失 · 取代现状的 `10004`）
   *
   * ⚠️ 这是**契约变更**：`meal.service.ts:269` 与 `order.service.ts:1628` 现状抛
   *    `ErrorCode.NOT_FOUND`(10004)。见本规格 §5.1 / §5.2 与 §12 的同步动作。
   */
  BUILDING_NOT_GROUPED = 60011,
  /** 扩展（N2）：未完结订单超过阈值，强制停用不可用，须走运营审批 */
  SUSPEND_REQUIRE_APPROVAL = 60012,
  /**
   * 扩展（N2）：已截单订单无法通过停用撤回（**硬约束，不可配置**）
   *
   * ⚠️ 用户已裁定：供应商已按份数采购备货，此阶段撤回让用户与供应商承担损失、
   *    而运营零成本，权责不对等。故即使带 `forceSuspend` 且选「一并退款」也拒绝。
   */
  SUSPEND_CANNOT_REVOKE_ACCEPTED = 60013,

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
  [ErrorCode.MUST_CHANGE_PASSWORD]: '账号要求修改口令后才能继续操作',
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
  [ErrorCode.USER_BUILDING_UNBOUND]: '你还没有选择办公楼，选好即可查看次日套餐',
  [ErrorCode.ORDER_CUTOFF]: '今日 24:00 已截单，明日请早',
  [ErrorCode.QUANTITY_EXCEED]: '份数超出单次上限',
  [ErrorCode.ORDER_STATUS_ILLEGAL]: '当前订单状态不支持该操作',
  [ErrorCode.DUPLICATE_ORDER]: '请勿重复下单',
  [ErrorCode.MEAL_NOT_PUBLISHED]: '该办公楼今日未开团',
  [ErrorCode.DELIVERY_STATUS_ILLEGAL]: '配送单当前状态不支持该推进（履约流只能向前）',
  [ErrorCode.DELIVERY_PROOF_NOT_FOUND]: '这张送达凭证不存在或不属于该配送单，请刷新后重试',
  [ErrorCode.MEAL_TEMPLATE_IN_USE]:
    '该套餐已排进某天的出餐计划，商品与售价不能再改（可改名称，或另存为新模板）',
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
  [ErrorCode.ORDER_CONCURRENT_MODIFIED]: '订单已被其它操作改动，请刷新后重试',
  [ErrorCode.ORDER_FROZEN_SYNC_CAS_VIOLATION]:
    '订单抵扣额同步未通过一致性校验，本次金额未变动，请联系技术处理',
  [ErrorCode.OP_BLOCKED]: '该操作已被管理员列入禁止清单，当前环境不可执行',
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
  [ErrorCode.COUPON_NOT_USABLE]: '这张代金券当前不可用',
  [ErrorCode.COUPON_THRESHOLD_NOT_MET]: '订单金额未达该券的使用门槛',
  [ErrorCode.COUPON_DEF_INVALID]: '券种不可用（不存在 / 已停用 / 已达发行上限）',
  [ErrorCode.COUPON_GRANT_PARAM_INVALID]: '发券参数不完整，本次未发放（请联系技术核对）',
  [ErrorCode.WITHDRAW_DAILY_LIMIT_EXCEEDED]: '今日提现额度已用完，请明日再试（单日上限见运营配置）',
  [ErrorCode.WITHDRAW_DAILY_DUPLICATED]: '今日已有一笔提现在处理中，请等这笔完成后再申请',
  [ErrorCode.PAY_QUERY_FAILED]: '支付状态查询失败，请稍后重试或联系客服',
  [ErrorCode.REFUND_WINDOW_EXPIRED]: '订单已完成且超出可退时限，如需退款请联系客服处理',
  [ErrorCode.REFUND_BATCH_TOO_LARGE]: '单次批量操作笔数超限，请减少勾选数量后分批提交',
  [ErrorCode.SUPPLIER_NOT_QUALIFIED]: '供应商资质未通过审核',
  [ErrorCode.DISTRIBUTION_CENTER_LOCKED]: '集散中心配置不可删除（存在历史结算）',
  [ErrorCode.SETTLE_AMOUNT_MISMATCH]: '结算金额校验不通过',
  [ErrorCode.WITHDRAW_BALANCE_NOT_ENOUGH]: '可提现余额不足',
  [ErrorCode.PAYOUT_CHANNEL_ERROR]: '出款通道异常',
  [ErrorCode.SUPPLIER_NOT_FOUND]: '供应商不存在或已停用',
  [ErrorCode.DISTRIBUTION_CENTER_NOT_FOUND]: '集散中心不存在或已停用',
  [ErrorCode.SUPPLIER_TYPE_CONFLICT]: '供应商类型与关联集散中心冲突',
  [ErrorCode.COOK_CONFIRM_OVERDUE]: '已过出餐确认截止时间（09:30），请联系运营线下处理',
  [ErrorCode.PRODUCE_PLAN_NOT_FOUND]: '当日无该商品生产计划',
  [ErrorCode.COOK_CONFIRM_CENTER_MISMATCH]: '集散中心不在该商品的配送范围',
  [ErrorCode.SUPPLIER_SHARE_NOT_PAYABLE]: '应付单不存在或当前状态不可操作',
  [ErrorCode.PAYMENT_VOUCHER_REQUIRED]: '请填写银行回单号（付款完成的唯一凭证）',
  [ErrorCode.BUILDING_NOT_FOUND]: '办公楼不存在',
  [ErrorCode.BUILDING_GROUP_NOT_FOUND]: '楼群不存在',
  [ErrorCode.BUILDING_GROUP_NOT_EMPTY]: '楼群下仍有办公楼，请先移出成员楼',
  [ErrorCode.BUILDING_GROUP_NAME_TAKEN]: '楼群名已存在',
  [ErrorCode.BUILDING_NAME_TAKEN]: '办公楼名已存在',
  [ErrorCode.BUILDING_UNFINISHED_ORDERS]: '该办公楼仍有未完结订单，不能直接停用',
  [ErrorCode.BUILDING_GROUP_UNFINISHED_ORDERS]: '该楼群仍有未完结订单，不能直接停用',
  [ErrorCode.BUILDING_GROUP_SUSPENDED_REJECT]: '目标楼群已停用，不能把办公楼挂进去',
  [ErrorCode.SALES_PAUSED]: '当前已暂停接单',
  [ErrorCode.BUILDING_SUSPENDED]: '该办公楼已停用时不可下单',
  [ErrorCode.BUILDING_NOT_GROUPED]: '该办公楼暂未开通服务，请联系运营',
  [ErrorCode.SUSPEND_REQUIRE_APPROVAL]: '未完结订单超过阈值，强制停用不可用，请提交运营审批',
  [ErrorCode.SUSPEND_CANNOT_REVOKE_ACCEPTED]: '已有订单进入履约阶段，无法通过停用撤回',
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

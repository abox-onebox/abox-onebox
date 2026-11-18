/**
 * 通知模板 —— **场景声明（唯一真相）**
 *
 * 依据：原型 `P36 系统配置` 的「📨 消息推送策略（微信订阅消息）」卡片。
 *
 * ## 三条来自原型的口径（不是我们发明的）
 *
 * 1. **简化原则**：用户端**常规订单状态不推送**（避免打扰）；
 *    **退款结果、异常处理属必推项** —— 故 `mandatory` 只有退款结果通知为 `true`。
 * 2. **团长送达通知**走「微信群 + 服务通知」双渠道（类似瑞幸取餐提醒）；
 *    **初期以微信群人工通知兜底**，服务通知逐步替代。
 * 3. 一期**没有微信账号**（见《账号资源与密钥清单》用户侧待跟进项）→
 *    订阅消息渠道**必然处于「未配置」**。这不是缺陷，是当前真实状态 ——
 *    页面必须如实显示，而不是假装已启用。
 *
 * ## ⭐ 为什么场景定义在代码里，不在库里
 *
 * 场景键、渠道组合、触发时机、变量白名单、是否必推 —— 这些是**代码事实**：
 * 代码按 `scene` 分派投递、按 `channels` 决定走哪条通道、按 `variables` 校验文案。
 * 若把它们落库，就会出现「库里写着走微信群、代码只发订阅消息」这类**无法自证**的
 * 矛盾（本项目头号顽疾「两个真相」）。库表 `ab_message_template` 只存**可编辑部分**。
 *
 * ## ⭐ 接线状态（`wiring`）—— 本清单的核心信息，与 M3-10 `CONFIG_SPECS` 同源纪律
 *
 * - `live`        代码真的会读它，改了就生效
 * - `record_only` 只作存档/人工使用，**不是程序行为**
 * - `pending`     一期没有投递点，**改了不生效**（页面只读 + 注明原因）
 */

/** 投递渠道 */
export type MessageChannel = 'wechat_subscribe' | 'wechat_group';

/** 渠道中文名（页面与出参共用，端上不维护第二份映射） */
export const MESSAGE_CHANNEL_LABEL: Record<MessageChannel, string> = {
  wechat_subscribe: '微信订阅消息',
  wechat_group: '微信群人工通知',
};

/**
 * 通知点击后跳转的小程序页（**唯一真相**，M4-3 新增）
 *
 * ## 为什么要有这个常量
 *
 * 订阅消息的 `page` 参数若写错，用户**点开通知会落到「页面不存在」**——
 * 而且这条错误**没有任何日志会报**（微信侧只管投递，不管页面存不存在），
 * 属于典型「静默失效」：投递日志显示 `success`，用户体验是坏的。
 *
 * M4-3 之前 `refund_result` 硬编码的是 `pages/order/detail`，而
 * `apps/miniprogram/src/pages.json` 里的真实路由是 `pages/order-detail/order-detail`
 * —— 正好是这个坑。抽取成常量后，**两个投递点共用一份**，以后新增场景
 * 也从这里选，不再各自手抄。
 *
 * ⚠️ 真值来源是 `apps/miniprogram/src/pages.json`（跨 app，无法在编译期校验）。
 *    改动小程序路由时**必须**同步改这里 —— 否则就是上面那种「投递成功但点不开」。
 *    二期可考虑由 `pages.json` 生成，一期保持手抄 + 本注释。
 */
export const NOTIFY_PAGES = {
  /** 订单详情（退款结果通知的落地页） */
  orderDetail: 'pages/order-detail/order-detail',
  /** 团长佣金明细（佣金入账通知的落地页） */
  leaderCommission: 'pages/leader/commission',
  /**
   * 团长工作台（团长申请确认通知的落地页）
   *
   * 选工作台而非「我的」：刚申请的团长需要的是**下一步做什么**（今日战报 / 分享物料 /
   * 佣金规则入口都在工作台），而不是一个身份展示页。
   */
  leaderWorkbench: 'pages/leader/workbench',
  /**
   * 下单页（截单提醒的落地页 · F5）
   *
   * 选下单页而非首页：截单提醒的唯一目的是**促单**，用户点开通知后应当**立刻能下单**，
   * 而不是先落到首页再自己找入口 —— 每多一步就多一层流失，而这条通知的成本
   * （一次订阅消息授权额度）已经花掉了。
   */
  orderCreate: 'pages/order-create/order-create',
  /**
   * 分享物料页（开团通知的落地页 · 2026-11-18）
   *
   * 选分享页而非工作台：开团通知的**唯一目的**是让团长立刻把物料转发出去
   * （工作台是「看自己战绩」的地方，他点进去还得再找一次分享入口）。
   * 与截单提醒落到下单页、要求「点开即可行动」是同一条判据。
   *
   * ⚠️ 真值须与 `apps/miniprogram/src/pages.json` 的 `pages/leader/share` 一致。
   */
  leaderShare: 'pages/leader/share',
  /**
   * 提现页（提现结果通知的落地页 · 2026-11-18）
   *
   * 提现结果通知点开后要能**立刻看到那笔单的状态与驳回原因**，
   * 落「我的-提现」页而不是钱包首页：后者还要他自己再点一次才看到明细。
   */
  leaderWithdraw: 'pages/leader/withdraw',
  /**
   * 团长申请页（停职通知的落地页 · 2026-11-18）
   *
   * 被动停职的团长当务之急是「怎么恢复」——`apply` 对停职者有
   * 「复职并重置为见习」分支（`team-leader.service.ts`），落地页必须直达申请页，
   * 而不是把他丢回一个他进不去的工作台（那正是停职后最糟的体验）。
   */
  leaderApply: 'pages/leader-apply/leader-apply',
} as const;

/**
 * 渠道的**必要条件** —— 启用闸门的唯一依据
 *
 * `wechat_subscribe` 缺模板 ID 时投递**必然失败**（微信侧无从知道用哪个模板）；
 * `wechat_group` 缺文案时人工无从下手。故两者都是「没有它就不许启用」，
 * 而不是「可以启用，发的时候再说」—— 后者会让运营在页面上看到「已启用」，
 * 实际永远发不出去（M3-10 那类「改了不生效」的翻版）。
 */
export const CHANNEL_REQUIREMENT: Record<
  MessageChannel,
  { field: 'wechatTemplateId' | 'groupContent'; fieldLabel: string; reason: string }
> = {
  wechat_subscribe: {
    field: 'wechatTemplateId',
    fieldLabel: '微信订阅消息模板 ID',
    reason: '微信订阅消息必须携带模板 ID 才能投递；未配置时投递必然失败，故不允许启用。',
  },
  wechat_group: {
    field: 'groupContent',
    fieldLabel: '微信群通知文案',
    reason: '微信群渠道由人工复制文案发群；没有文案则启用无意义。',
  },
};

/** 接线状态（场景级） */
export type MessageSceneWiring = 'live' | 'pending';

/** 字段级接线状态 */
export type MessageFieldWiring = 'live' | 'record_only';

export interface MessageTemplateSpec {
  /** 场景键（`ab_message_template.scene`） */
  scene: string;
  /** 中文场景名 */
  label: string;
  /** 触达对象 */
  audience: string;
  /** 该场景用到的渠道（数组顺序即展示顺序） */
  channels: MessageChannel[];
  /** 触发时机（写给运营看） */
  trigger: string;
  /** 是否「必推项」（原型：退款结果 / 异常必推；常规状态不推） */
  mandatory: boolean;
  /** 变量白名单 —— `groupContent` 里只允许出现这些 `{{变量}}` */
  variables: string[];
  /**
   * 是否需要在**用户小程序端**向用户请求订阅授权（M4-3）
   *
   * ## 为什么必须是机器可读的布尔值，而不是从 `audience` 文本反推
   *
   * 微信订阅消息是**一次性授权**：用户没点过「允许」的场景，服务端再推也是白推
   * （微信回 `43101 用户拒绝接收`）。所以「该场景要不要请求授权」是一个
   * **投递成败的前置事实**，必须能被执行代码直接读取。
   * 从 `audience` 这个中文展示串里 `includes('团长')` 反推 —— 改一次文案就静默失效，
   * 正是本项目反复栽的形态。
   *
   * ## 判定标准（三条全中才为 `true`）
   *
   * 1. 收件人是**用户/团长**（同一小程序身份）——供应商端与后台不在此列；
   * 2. 场景走 `wechat_subscribe` 渠道（微信群人工通知不需要授权）；
   * 3. 代码**真有**投递点（`wiring === 'live'`）—— **`pending` 场景必须为 `false`**：
   *    向用户索要一个我们根本不会用的授权，是「索权不用」，既骚扰用户、也是
   *    微信平台明确反对的行为。
   */
  requestSubscribe: boolean;
  /** 代码消费点（**事实**，不是设计意图；`—` 表示还没有投递点） */
  consumedBy: string;
  /** 场景级接线状态 */
  wiring: MessageSceneWiring;
  /** 未接线时的原因（`wiring='pending'` 必填） */
  pendingReason?: string;
  /** 出参附带的额外说明（页面直接展示，端上不自造文案） */
  note?: string;
  /**
   * 业务字段 → **微信模板关键词编号** 的映射（`wechat_subscribe` 渠道**投放必需**）
   *
   * ## 为什么必须有这一层
   *
   * 微信订阅消息 `data` 的键名不是业务名（`orderNo`），而是**关键词编号**
   * （`character_string1` / `amount2` / `time3`），且必须与运营申请到的那个模板
   * 逐个对齐。直接传业务名会 `47003 参数不合法` —— 这个错在 2026-11-18 之前
   * 一直存在，只是被「通道是 Mock」掩盖了：假成功连参数都不校验。
   *
   * ## 这份默认值怎么来的
   *
   * 按微信公共模板库里同类通知的**常见关键词顺序**填。运营申请到模板后**必须核对**：
   * 若模板的关键词类型/顺序与这里不同（如订单号是 `thing1` 而不是 `character_string1`），
   * **改这里一行即可** —— 它与 `wechatTemplateId` 是一对，换模板就要同时改。
   *
   * ⚠️ 为什么不放到后台让运营手填：模板还没申请时他填不出编号，手填 JSON 也更容易错。
   *   先由代码给默认值、后台页面只读展示「本场景要选什么关键词的模板」，
   *   等真有换模板需求时再考虑做成可配置（届时须同时迁移这 9 行默认值）。
   */
  wxFields?: Record<string, string>;
  /** 种子默认值（可编辑部分） */
  seed: {
    enabled: number;
    wechatTemplateId: string | null;
    groupContent: string;
  };
}

/**
 * 14 个场景
 *
 * ## ⚠️ 与原型 P36 的关系（必须如实说明，别让它变成「两个真相」）
 *
 * 前 5 行与原型 P36「消息推送策略」的 5 行**逐一对应**（`user_order_status` /
 * `leader_delivery` / `merchant_cook` / `leader_apply` / `refund_result`）。
 *
 * 第 6 行 `commission_settled` 是 **M4-3 新增**：原型没写这一行，但它对应
 * 已实现的两段式佣金链路（T 日确认计佣 → T+1 02:00 入账，见 M4-2 定稿），
 * 入账后**必须通知团长**（否则团长只能自己去小程序翻余额，两段式会变成投诉源）。
 *
 * 第 7 行 `cutoff_remind` 是 **F5 新增**：对应真源《系统地图》F5 点名的「忘了下单」，
 * 与 `leader_delivery`（=「忘了取餐」）配成一对。二者同属「原型没写、但业务上必需」的行。
 *
 * 第 8 / 9 行 `building_suspend_fulfill` / `building_suspend_refund` 是 **N2 新增**：
 * 楼宇停用只拦新单、存量继续履约（用户已拍板不做批量退款）⇒ 存量订单的用户
 * **必须被告知**。两行**刻意不合成一行** —— 见第 8 行的注释。
 *
 * 第 10 行 `group_open` 是 **2026-11-18 新增**：开团对外没有声音，团长不知道何时
 * 能开始分享 —— 它补齐了团长一天四个节点的**第一个**（开团 → 截单 → 送达 → 入账）。
 *
 * 第 11–14 行 `leader_promoted` / `trainee_expiring` / `leader_suspended` /
 * `withdraw_result` 是 **2026-11-18 第二批**：与开团通知同属一个缺陷族 ——
 * 「状态自动翻转了、当事人不知道、而这直接决定他下一步动作」。
 * 四处全是**钱与资格**：涨佣金、即将失去资格、已经失去资格、提现结果。
 * 它们的共同点是「当事人本来可以做出反应」，静默等于剥夺了他的反应机会。
 *
 * → 后台 P36 页面会显示 **14 行**。这不是页面写错了，是代码事实比原型多了 9 行；
 *   若运营问「为什么多了」，答案在本段。
 *
 * ⚠️ **新增行一律追加在末尾**（保持「前 5 行 = 原型」这一结构的可核对性）——
 *    插在中间会让「前 5 行与原型逐一对应」当场失效，而这句话已被 e2e §24 锚定。
 *
 * ⚠️ 增删场景必须同时改这里 **和** 种子（`seeds/seed.ts`）——
 *    种子由本清单派生，不存在第二份场景列表。
 */
export const MESSAGE_TEMPLATE_SPECS: MessageTemplateSpec[] = [
  {
    scene: 'user_order_status',
    label: '用户端常规状态推送',
    audience: '下单用户',
    channels: ['wechat_subscribe'],
    trigger: '订单状态流转（已支付 / 已出餐 / 配送中）',
    mandatory: false,
    variables: ['orderNo', 'statusText', 'mealDate'],
    // `pending` → 不请求授权：索权却不用，是明确该避免的行为
    requestSubscribe: false,
    consumedBy: '—（一期无投递点）',
    wiring: 'pending',
    pendingReason:
      '按原型「简化原则」**刻意不推**：用户端常规状态变更不打扰，避免订阅消息被当成骚扰而遭拒收。' +
      '保留此行是为了让「为什么用户收不到出餐提醒」有据可查 —— 是设计选择，不是漏了。',
    note: '本场景即使启用，一期也无代码投递（pending）；其存在意义是记录「刻意不推」这一决策。',
    seed: {
      enabled: 0,
      wechatTemplateId: null,
      groupContent: '',
    },
  },
  {
    scene: 'leader_delivery',
    label: '团长送达通知',
    audience: '团长',
    // ⚠️ 一期渠道**只有微信群**：原型的「服务通知」是二期替代方案。
    //    这不是裁剪 —— 声明成「双渠道」会让本场景在种子里启用后**必然缺模板 ID**
    //    （订阅消息渠道的必要条件），于是「已启用」与「闸门」互相矛盾：
    //    要么放行一个发不出去的场景，要么让这个能用的场景也启用不了。
    //    渠道是**代码事实**，代码一期只发人工群 —— 就照实写。
    channels: ['wechat_group'],
    // ⚠️ 触发时机**不写具体时刻**（PR-02 收口）：改前是 `'…（约 11:30）'`，与
    //    `order-timeline.ts` 的真源构成第二份表述。时刻已由下方 `variables` 的
    //    `arriveTime` 承载（且它由服务端按生效时间轴填充），此处只描述**事件**。
    trigger: '餐送达办公楼楼下',
    mandatory: false,
    variables: ['buildingName', 'mealDate', 'arriveTime', 'quantity'],
    // 微信群人工通知：不经过微信订阅消息，无需授权
    requestSubscribe: false,
    consumedBy: '—（一期无投递点，靠人工发群）',
    wiring: 'pending',
    pendingReason:
      '一期**以微信群人工通知兜底**（原型原文），尚无代码在送达时自动推送；' +
      '文案本身可用（`record_only`），由运营/团长复制粘贴发群。',
    note: '类似瑞幸取餐提醒。二期以「服务通知」（订阅消息）替代人工发群时，再往本场景加渠道与投递点。',
    seed: {
      // ⭐ 唯一在种子里**允许启用**的场景：微信群渠道只需文案（人工发群），
      //    不依赖尚未申请的微信模板 ID。这正对应原型「初期采用微信群人工通知兜底」。
      enabled: 1,
      wechatTemplateId: null,
      groupContent:
        '【ABox 取餐提醒】{{mealDate}} 的午餐已于 {{arriveTime}} 送达 {{buildingName}} 楼下，共 {{quantity}} 份，请安排取餐。',
    },
  },
  {
    scene: 'merchant_cook',
    label: '商家出餐提醒',
    audience: '供应商（商家）',
    channels: ['wechat_subscribe'],
    trigger: '截单后（T-1 24:00 之后）',
    mandatory: false,
    variables: ['mealDate', 'centerName', 'itemCount'],
    // 收件人是**供应商**（独立主体、不是用户小程序身份）→ 不由用户端请求授权
    requestSubscribe: false,
    consumedBy: '—（一期无投递点）',
    wiring: 'pending',
    pendingReason:
      '供应商端已有 S1/S2/S3 出餐确认链路，但**提醒本身尚未接入投递**（一期由运营在群里 @ 商家）。',
    seed: {
      enabled: 0,
      wechatTemplateId: null,
      groupContent:
        '【出餐通知】{{mealDate}} 需向 {{centerName}} 交付 {{itemCount}} 个商品，请在 09:30 前完成出餐确认。',
    },
  },
  {
    scene: 'leader_apply',
    label: '团长申请提交确认',
    audience: '团长',
    channels: ['wechat_subscribe'],
    trigger: '提交团长申请即时',
    mandatory: false,
    variables: ['applyAt', 'leaderLevel'],
    requestSubscribe: true,
    consumedBy:
      'team-leader/team-leader.service.ts → MessageService.notify()（M4-3 接线·提交后事务外）',
    wiring: 'live',
    /** 申请时间 / 团长等级 —— 运营须选关键词为「时间 + 等级(事物)」的模板 */
    wxFields: { applyAt: 'time1', leaderLevel: 'thing2' },
    note:
      '⭐ M4-3 接线：C3「申请即生效、无审核」**不等于**无需通知 —— 团长当场并不知道' +
      '「佣金怎么算、去哪看余额、什么时候开始生效」，这些都写在小程序里，' +
      '而**刚成为团长的人不会自己去找**。通知投递在申请事务**提交之后**：' +
      '事务回滚了通知却已发出，就是「祝贺你成为团长」的假消息。',
    seed: {
      enabled: 0,
      wechatTemplateId: null,
      groupContent:
        '【ABox 团长】你已于 {{applyAt}} 成为{{leaderLevel}}团长，可在小程序查看推广物料与佣金。',
    },
  },
  {
    scene: 'refund_result',
    label: '退款结果通知',
    audience: '下单用户',
    channels: ['wechat_subscribe'],
    trigger: '退款到账即触达',
    mandatory: true,
    // ⚠️ `refundNo` **不出现在文案里**，只落进 `ab_message.payload`（与 `refund_result`
    //     场景的 `orderNo` 同理）—— 供运营事后追溯「是哪笔退款」，白名单必须声明否则无据可查。
    variables: ['orderNo', 'amount', 'refundedAt', 'refundNo'],
    requestSubscribe: true,
    consumedBy: 'finance/refund.service.ts → MessageService.notify()（M3-12 接线）',
    wiring: 'live',
    /** 订单号 / 退款金额 / 退款时间 —— 选模板时关键词顺序须与此一致 */
    wxFields: { orderNo: 'character_string1', amount: 'amount2', refundedAt: 'time3' },
    note:
      '⭐ **必推项**（原型原文：用户端常规状态不推，但退款结果属必推）。' +
      '投递在**退款事务提交之后**执行 —— 事务回滚了通知却已发出，是退款链路最忌讳的「说不清」。',
    seed: {
      // 必推 ≠ 已启用：一期没有微信订阅消息模板 ID，**启用闸门**不允许打开。
      // 这正是 fail-closed 想表达的：与其显示「已启用」而实际发不出去，
      // 不如如实显示「未启用（缺模板 ID）」。
      enabled: 0,
      wechatTemplateId: null,
      groupContent:
        '【ABox 退款】订单 {{orderNo}} 已于 {{refundedAt}} 退款 ¥{{amount}}，请留意到账。',
    },
  },
  {
    scene: 'commission_settled',
    label: '团长佣金入账通知',
    audience: '团长',
    channels: ['wechat_subscribe'],
    trigger: '佣金入账完成（T+1 02:00 `commission-settle` 跑批之后）',
    mandatory: false,
    variables: ['mealDate', 'amount', 'settledCount'],
    requestSubscribe: true,
    consumedBy:
      'finance/commission.service.ts → MessageService.notify()（M4-3 接线·队列 settle-orders）',
    wiring: 'live',
    /** 日期 / 金额 / 笔数 —— 选模板时关键词顺序须与此一致 */
    wxFields: { mealDate: 'date1', amount: 'amount2', settledCount: 'number3' },
    note:
      '⭐ 两段式佣金的**必要配套**：T 日确认计佣、T+1 02:00 才入账（见 `COMMISSION_SETTLE_NOTE`），' +
      '中间隔了一夜。若不通知，团长在小程序里看到的是「昨天确认了却没钱」——两段式本身没问题，' +
      '但**不解释就会被当成漏结**。注意通知中**不含订单明细**：明细在佣金页看，通知塞不下也会过期。',
    seed: {
      // 与 refund_result 同理：场景已接线（live），但一期没有微信订阅消息模板 ID，
      // 启用闸门会拦住启用 → 如实显示「未启用（缺模板 ID）」而不是假装在发。
      enabled: 0,
      wechatTemplateId: null,
      groupContent:
        '【ABox 佣金】你 {{mealDate}} 的佣金 ¥{{amount}}（{{settledCount}} 笔）已入账，可在小程序查看明细。',
    },
  },
  {
    scene: 'cutoff_remind',
    label: '截单提醒',
    audience: '近 14 天下过单、且目标出餐日尚未下单的用户',
    channels: ['wechat_subscribe'],
    // ⚠️ 触发时机**不写具体时刻**（同 `leader_delivery` 的 PR-02 收口纪律）：时刻的唯一真相是
    //    `common/utils/order-timeline.ts` 的 `DEFAULT_TIMELINE.cutoff`，此处只描述**事件**。
    trigger: '截单前（由编排端点触发；自动跑批待微信模板审核通过后接入）',
    mandatory: false,
    // `cutoffTime` 的值由服务端按**生效时间轴**填充（`formatTimeOfDay(currentTimeline().cutoff)`），
    // 不是端上写的第二份时刻。
    variables: ['mealDate', 'cutoffTime'],
    /**
     * ⭐ `true`：本场景面向**用户小程序身份**、走订阅消息渠道、且 `wiring='live'`（编排端点是
     * 真实投递点）—— 三条全中，故用户端应当请求授权（判据见 `subscribeTemplateOf`）。
     */
    requestSubscribe: true,
    consumedBy: 'message/message-orchestrator.service.ts → orchestrate()（F5 接线）',
    wiring: 'live',
    /**
     * 只投「截单时间」**一个**关键词。
     *
     * ⚠️ 为什么不是「日期 + 时刻」两个字段（2026-11-18 按实际可申请的模板改）：
     *    微信 `time` 类型**自带日期**，卡片渲染成「2026年11月19日 00:00」——
     *    再塞一个 `date` 字段等于同一信息说两遍；且公共模板库里「截单通知」
     *    这类模板根本没有独立的日期关键词可选（候选只有：截单时间 / 截单档口 /
     *    截单批次 / 备注）。
     *    ⇒ 完整时刻由 `message-orchestrator` 的 `cutoffAtText()` 拼好，此处只声明编号。
     */
    wxFields: { cutoffAt: 'time1' },
    note:
      '⭐ **F5 新增（全清单第 7 行）**：真源《系统地图》F5 点名「忘了下单」是最冤的两笔损失之一' +
      '（另一笔「忘了取餐」由 `leader_delivery` 承载）。' +
      '⚠️ 与 `user_order_status` **不是同一件事，别混**：后者是「订单状态流转」' +
      '（已支付 / 已出餐 / 配送中）的推送，收件人是**已经下单的人**，对他们是打扰，' +
      '故原型按「简化原则」刻意不推；本场景面向**还没下单的人**做促单，与该原则不冲突。' +
      '⚠️ 一期触达入口是**编排端点**（`POST /admin/messages/orchestrate`）——' +
      '自动跑批待微信订阅消息模板审核通过后接入（真源 F5 已注明「依赖：订阅消息模板审核（微信侧流程）」）；' +
      '在此之前由运营在截单前手动触发，编排端点与未来的跑批**共用同一执行口**，接入时不改业务逻辑。',
    seed: {
      // 与其余订阅消息场景同理：一期没有微信订阅消息模板 ID，**启用闸门**会拦住启用
      // → 如实显示「未启用（缺模板 ID）」，而不是假装在发。
      enabled: 0,
      wechatTemplateId: null,
      groupContent:
        '【ABox 提醒】{{mealDate}} 的午餐将于 {{cutoffTime}} 截单，还没下单的话记得尽快。',
    },
  },
  {
    /**
     * 楼宇 / 楼群停用后，**存量订单照常履约**的用户告知（N2 · 全清单第 8 行）
     *
     * ⚠️ 与下一个场景 `building_suspend_refund` **必须分成两个场景，不能合成一个
     *    模板换变量**（spec §6.5 D-N2-3b）：B 组内部两类用户的**结局相反** ——
     *    一类最终拿到餐、一类最终拿到退款。合成一份「继续履约」文案，会让一个正在
     *    退款的用户收到「你的订单将照常送达」：那是**事实性错误**，而且用户会据此
     *    **不做午饭安排**。不发是失职，发错是误导。
     *    ⇒ 分组决定「系统做什么」，结局决定「用户收到什么」。
     */
    scene: 'building_suspend_fulfill',
    label: '楼宇停用 · 存量订单照常配送',
    audience: '被停用楼宇 / 楼群下，持有待支付 / 已支付订单的用户',
    channels: ['wechat_subscribe'],
    trigger: '楼宇或楼群被停用（含强制停用），存量订单处于 pending_pay / paid',
    // `mandatory: true` —— 用户手上已有一笔待履约的订单，停用后「会不会照常送」
    // 是他**必须知道**的事；这属于原型「异常处理属必推项」，不适用「常规状态不推」。
    mandatory: true,
    /**
     * ⚠️ `orderNo` **不出现在文案里**，只落进 `ab_message.payload`
     *    —— spec §6.5 要求「让运营事后看得到有幾個人沒通知到、**是誰**」，
     *    那个「是谁」靠的就是它。白名单里必须声明，否则投递侧塞进去的字段无据可查。
     */
    variables: ['mealDate', 'orderNo'],
    requestSubscribe: true,
    consumedBy: 'building/building-admin.service.ts → notifySuspendAffected()（N2 接线）',
    wiring: 'live',
    /** 只投「出餐日期」一个关键词 —— 选模板时须选只含日期关键词的（或按此顺序对齐） */
    wxFields: { mealDate: 'date1' },
    note:
      '⭐ **N2 新增（全清单第 8 行）**：停用只拦**新单**，存量继续履约（用户已拍板，不做批量退款）。' +
      '⚠️ 一期没有微信模板 ID ⇒ 启用闸门拦住启用 ⇒ 如实「未启用（缺模板 ID）」，' +
      '投递点返回 `delivered=false`，**不许粉饰成已发送**。' +
      '⚠️ 只覆盖 `pending_pay` / `paid` 两态 —— 已截单及之后（A 组）的订单已在履约链上，' +
      '「照常」是它们唯一可能的结局，再发一条属于打扰；退款中间态走 **另一个场景**。',
    seed: {
      enabled: 0,
      wechatTemplateId: null,
      groupContent: '【ABox 通知】您 {{mealDate}} 的订单照常配送，不受本次调整影响。',
    },
  },
  {
    /** 楼宇 / 楼群停用后，**退款仍在处理**的用户告知（N2 · 全清单第 9 行） */
    scene: 'building_suspend_refund',
    label: '楼宇停用 · 存量订单退款中',
    audience: '被停用楼宇 / 楼群下，持有退款申请中 / 退款中订单的用户',
    channels: ['wechat_subscribe'],
    trigger: '楼宇或楼群被停用（含强制停用），存量订单处于 refund_applying / refunding',
    mandatory: true,
    /**
     * ⚠️ `orderNo` **不出现在文案里**，只落进 `ab_message.payload`
     *    —— spec §6.5 要求「让运营事后看得到有幾個人沒通知到、**是誰**」，
     *    那个「是谁」靠的就是它。白名单里必须声明，否则投递侧塞进去的字段无据可查。
     */
    variables: ['mealDate', 'orderNo'],
    requestSubscribe: true,
    consumedBy: 'building/building-admin.service.ts → notifySuspendAffected()（N2 接线）',
    wiring: 'live',
    /** 同 `building_suspend_fulfill`：只投出餐日期一个关键词 */
    wxFields: { mealDate: 'date1' },
    note:
      '⭐ **N2 新增（全清单第 9 行）**。与 `building_suspend_fulfill` **不是同一件事**：' +
      '这批用户的结局是**退款**，不是餐。' +
      '⚠️ 文案里**不得**出现「照常配送 / 照常送达」等履约承诺措辞 —— ' +
      '用户会据此不做午饭安排，而他的饭根本不会来（AC **N2-AC-07**）。' +
      '⚠️ 停用**不改变**退款流程：退款照自己的通道走完，本场景只是告知。',
    seed: {
      enabled: 0,
      wechatTemplateId: null,
      groupContent:
        '【ABox 通知】您 {{mealDate}} 的订单退款正在处理中，款项将原路退回，请注意查收。',
    },
  },
  {
    /**
     * 团长开团通知（2026-11-18 · 全清单第 10 行）
     *
     * ## 它补的是哪一段断链
     *
     * 开团（`T-1 14:00` 把明日套餐 `pending → active`）在系统里是一次**状态翻转**，
     * 但对外**没有任何声音**：团长不知道「今天已经能开始吆喝了」，于是不分享 →
     * 楼里没单 → 供给侧死结。这不是「多加一条通知」，是把团长一天的四个节点补齐：
     * 开团（本场景）→ 截单（`cutoff_remind`）→ 送达（`leader_delivery`）→ 入账（`commission_settled`）。
     *
     * ## ⚠️ 为什么渠道是**双渠道**（与 `leader_delivery` 只写群不同）
     *
     * ABox 属零售 / 预包装快消类目，**申请不到长期订阅**（只对政务、医疗、交通、
     * 金融、教育开放），只能用一次性订阅：用户点一次「允许」= **仅 1 条额度**，
     * 勾选「总是保持以上选择」只是免弹窗、**不增加额度**（额度不过期，可以攒）。
     * ⇒ 只靠订阅消息做「每天一场」的开团通知，团长两天不进小程序就静默收不到，
     * 而且我们侧**收不到任何报错**。故必须配微信群兜底（团长人数少，成本近似为零）。
     * 兜底是人工复制 `groupContent`，**不受 `enabled` 限制**（与 `leader_delivery` 同）。
     *
     * ## ⚠️ 关键词只选 2 个，且日期+套餐名合进 `thing1`
     *
     * `time` 类型**自带日期**（同 `cutoff_remind` 的教训）：单独再塞一个 `date` 会把
     * 同一信息说两遍，而公共模板库里也没有「开团通知」这类模板可选。把「哪天 + 什么饭」
     * 拼进一个 `thing` 关键词，既满足「最少 2 个关键词」的平台规则，也让通知标题
     * 一眼认得出是哪一天的哪份餐。
     */
    scene: 'group_open',
    label: '团长开团通知',
    audience: '该楼群当日已开团（可下单）的团长',
    channels: ['wechat_subscribe', 'wechat_group'],
    // ⚠️ 同 `leader_delivery` / `cutoff_remind`：**不写具体时刻**，时刻的真源是
    //    `common/utils/order-timeline.ts` 的 `DEFAULT_TIMELINE.publish`（14:00），
    //    此处只描述事件。写死「14:00」会立刻变成第二份表述。
    trigger: '跑批开团 / 单条上架（该楼群当日首次变为「可下单」）',
    mandatory: false,
    variables: ['mealDate', 'setMealName', 'cutoffAt'],
    /**
     * `true`：面向**团长（= 用户小程序身份）**、走订阅消息、且 `wiring='live'`
     * —— 三条全中（判据见 `subscribeTemplateOf`）。端上在团长工作台请求授权。
     */
    requestSubscribe: true,
    consumedBy:
      'meal/meal-admin.service.ts → notifyGroupOpen()（两处：publishAssignment 单条上架 / publishByDate 跑批）',
    wiring: 'live',
    /** 开团信息（日期+套餐，拼进 `thing`）/ 截单时刻（`time` 自带日期） */
    wxFields: { noticeTitle: 'thing1', cutoffAt: 'time2' },
    note:
      '⭐ **2026-11-18 新增（全清单第 10 行）**：开团这件事对外**一直没有声音**，' +
      '团长不知道何时能开始分享，是供给侧断链的上半段。' +
      '⚠️ **两处落点都必须挂**：`publishByDate`（T-1 14:00 跑批）与 `publishAssignment`' +
      '（矩阵页单条上架，也是企微「确认开团」逐条 assign→publish 的最终入口）——' +
      ' 只挂跑批，运营手动补开团的那天团长就收不到（与「同一动作两个入口」的坑同类）。' +
      '⚠️ **幂等**：同一「出餐日 + 楼群」当天只发一次（`dedupeKey`），' +
      '否则下架再上架会让团长收到 2–3 条一模一样的「开团了」。' +
      '⚠️ **只发真的开团成功的**：当天未归群 / 已停团 / 没排期的楼群不发 —— ' +
      '发一条「开团了」但他楼里根本下不了单，比不发更糟。' +
      '⚠️ 一次性订阅**额度有限**（每人每次授权仅 1 条）：团长不常进小程序时，' +
      '剩余额度会耗尽，微信回 `43101`。故本场景**必须**保留群兜底，' +
      '后台也须能看到「还剩几条额度」，不许把「投递返回 delivered」当成「团长收到了」。',
    seed: {
      // 双渠道 ⇒ 启用闸门要求「模板 ID + 群文案」都齐；一期模板 ID 为空 → 不允许启用，
      // 页面如实显示「未启用（缺模板 ID）」。群文案字段本身仍可直接复制使用。
      enabled: 0,
      wechatTemplateId: null,
      groupContent:
        '【ABox 开团】{{mealDate}} 的午餐已开团（{{setMealName}}），{{cutoffAt}} 截单，请尽快分享给同事。',
    },
  },
  // ==========================================================================
  // 2026-11-18 第二批（团长激活三件套）
  //
  // 共性：它们全是**自动发生的状态翻转**，当事人却完全无感知 ——
  //   晋级（涨钱）／见习到期（即将失去资格）／被停职（已经失去资格）／提现结果（钱）。
  // 与开团通知同属一个缺陷族：「状态变了、该知道的人不知道、而且这直接决定他下一步动作」。
  //
  // ## ⚠️ 四个场景**刻意用完全相同的模板结构**（2 个关键词：`thing1` + `time2`）
  //
  // 原因不是偷懒：运营要拿这四行去微信公共模板库**分别申请四个模板**，
  // 每个模板的关键词数量与顺序都必须和我们这边对齐。四个场景若各有各的结构
  // （有的 2 个、有的 3 个、`amount` 和 `thing` 混用），申请时就要记四套规则 ——
  // 记错一次就 `47003 参数不合法`，而且失败发生在**生产投递时**，不是申请时。
  // 统一成「第 1 个选事物、第 2 个选时间」，四行只需记一条规则。
  //
  // ## ⚠️ 为什么第 1 个关键词要自己拼成一句话（而不是分 3 个关键词）
  //
  // `thing` 限 20 字符。把「新等级 / 佣金比例 / 还差几单」拆成三个关键词看着更整齐，
  // 但那要求模板恰好有 3 个 `thing` 位 —— 公共模板库里没有这种模板，
  // 运营只能自己组合，反而更容易错。拼成一句 ≤20 字的话，任何 2 关键词模板都能用。
  // ==========================================================================
  {
    /**
     * 团长晋级通知（2026-11-18 · 全清单第 11 行）
     *
     * ## 为什么这条的正反馈最强
     *
     * 晋级 = **佣金率从 8% 涨到 9%/10%/12%**，是团长最该被强化的时刻。
     * 而它现在只写进一行服务端日志（`promotion.service.ts` 的 `logger.log`），
     * 团长永远不会知道自己的费率变了 —— 他下次算钱时只会觉得「怎么对不上」。
     *
     * ## ⚠️ 三个让它「零风险」的事实（决定它该不该发）
     *
     * 1. **只升不降**：`promotion.service.ts` 里是 `promoted ? target : leader.level`，
     *    没有降级分支 ⇒ 这条通知**永远是好消息**，不存在难写的坏消息文案。
     * 2. **自动发生**：确认分发 / 每日自动确认都会触发审计，团长无需任何操作。
     * 3. **当天只发一次**：多次分发一天内触发多次审计，用 `dedupeKey` 兜住
     *    （第二次审计已不再 `promoted`，本就不会重复，但幂等键是第二道保险）。
     */
    scene: 'leader_promoted',
    label: '团长晋级通知',
    audience: '等级被上调的团长',
    channels: ['wechat_subscribe', 'wechat_group'],
    trigger: '确认分发 / 自动确认触发晋级审计并升级时',
    mandatory: false,
    variables: ['levelLabel', 'rateText', 'effectiveAt'],
    requestSubscribe: true,
    consumedBy: 'team-leader/promotion.service.ts → notifyPromoted()（audit 升级分支，事务外）',
    wiring: 'live',
    /** 晋级概要（等级 + 新佣金比例，拼成一句话）/ 生效时间 */
    wxFields: { noticeTitle: 'thing1', effectiveAt: 'time2' },
    note:
      '⭐ 晋级=涨钱，是团长最该被强化的时刻，此前只写日志。' +
      '⚠️ 本通知**只能由「非本人主动」的审计触发**：团长自己在佣金页点「重新核算」时' +
      '（L22），升级结果当场就在他屏幕上，再推一条通知是重复打扰 —— ' +
      '故 `audit()` 带 `notify` 开关，L22 传 `false`。' +
      '⚠️ 一次性订阅额度有限，模板未到位时用群文案人工补（后台可复制）。',
    seed: {
      enabled: 0,
      wechatTemplateId: null,
      groupContent:
        '【ABox 晋级】恭喜升为{{levelLabel}}团长，佣金比例调整为 {{rateText}}，{{effectiveAt}} 起生效。',
    },
  },
  {
    /**
     * 见习到期预警（2026-11-18 · 全清单第 12 行）
     *
     * ## 它补的是「沉默的死」
     *
     * 见习团长 30 天未促单 → 每日 03:00 跑批**直接停职**（`expireTrainees`）。
     * 此前这条链路上**没有任何中途提示**：团长照常过完第 29 天，第 30 天早上
     * 团长入口就没了。而被停职的人本来是**可以救的**（他只要出一单就续上），
     * 前提是他知道自己在倒计时。
     *
     * ## ⚠️ 为什么只在「恰好剩 7 天」发一次，不是最后 7 天每天发
     *
     * 每天发是骚扰，且会迅速被无视（狼来了）。7 天 = 一个完整周盒周期，
     * 够他安排一次促单。跨天去重靠「剩余天数 == 7」这个精确判据（`trainee-warn.task.ts`），
     * **不能用 `dedupeKey`** —— 那个只按「当天」去重，起不到「这辈子只发一次」的作用。
     */
    scene: 'trainee_expiring',
    label: '见习到期预警',
    audience: '见习期即将届满（剩 7 天）的团长',
    channels: ['wechat_subscribe', 'wechat_group'],
    trigger: '每日跑批 · 距见习失效恰好 7 天',
    mandatory: false,
    variables: ['noticeTitle', 'deadlineAt'],
    requestSubscribe: true,
    consumedBy: 'tasks/trainee-warn.task.ts → MessageService.notify()（每日 03:30）',
    wiring: 'live',
    wxFields: { noticeTitle: 'thing1', deadlineAt: 'time2' },
    note:
      '⭐ 30 天未促单会被自动停职，此前没有任何倒计时提醒 —— 这是可救的流失。' +
      '⚠️ 只在「恰好剩 7 天」发一次：最后 7 天每天发会被无视，也违背不打扰原则。' +
      '⚠️ 失效判据的起算点是 `lastOrderAt ?? createdAt`（从未出单者从建档起算），' +
      '与本通知共用 `expireTrainees()` 的同一算法，不允许此处另算一份。',
    seed: {
      enabled: 0,
      wechatTemplateId: null,
      groupContent:
        '【ABox 提醒】你的见习团长资格将于 {{deadlineAt}} 到期，{{noticeTitle}}。出一单即可续上。',
    },
  },
  {
    /**
     * 团长停职通知（2026-11-18 · 全清单第 13 行）
     *
     * ## 为什么必须发（这是最糟的体验，没有之一）
     *
     * 停职后 `LeaderGuard` 会挡住所有团长端接口，端上 `isLeader` 变 false ⇒
     * **底部导航的「团长」入口直接消失**。当事人看到的是「我的团长身份凭空没了」，
     * 没有原因、没有期限、也不知道自己能申请复职。
     *
     * ## 两条触发来源共用本场景（行为一致，文案一致）
     *
     * 1. **被动**：`expireTrainees()` 见习期满（每日 03:00 跑批）；
     * 2. **主动**：运营在后台「停职」（`leader-admin.service.ts` 的 `audit.SUSPEND`）。
     *
     * ⚠️ **复职不发**：复职后团长端立刻恢复可见，他打开就知道；再推一条属于噪音。
     */
    scene: 'leader_suspended',
    label: '团长停职通知',
    audience: '被停职的团长',
    channels: ['wechat_subscribe', 'wechat_group'],
    trigger: '见习期满自动停职 / 运营后台手动停职',
    mandatory: false,
    variables: ['reasonText', 'suspendedAt'],
    requestSubscribe: true,
    consumedBy:
      'team-leader/promotion.service.ts（expireTrainees）· leader-admin.service.ts（audit.SUSPEND）',
    wiring: 'live',
    wxFields: { noticeTitle: 'thing1', suspendedAt: 'time2' },
    note:
      '⭐ 停职后端上团长入口直接消失，此前没有任何解释 —— 这是最伤人的一种静默。' +
      '⚠️ 文案必须给出「可重新申请复职」这条出路（`team-leader.service.ts` 的 apply 对' +
      '停职者有复职分支，等级重置为见习），否则等于宣布他出局。' +
      '⚠️ 落地页是**申请页**而不是工作台：他此刻进不去工作台。',
    seed: {
      enabled: 0,
      wechatTemplateId: null,
      groupContent:
        '【ABox 通知】你的团长身份已于 {{suspendedAt}} 暂停，原因：{{reasonText}}。' +
        '可在小程序「申请团长」重新提交恢复（等级从见习起算），历史佣金与订单均保留。',
    },
  },
  {
    /**
     * 提现结果通知（2026-11-18 · 全清单第 14 行）
     *
     * ## 为什么这条是「信任」问题，不是「便利」问题
     *
     * 提现要过 `approve → markPaid` 两道人工关，还可能 `reject` / `markFailed`。
     * 这四种结果此前**全部静默**，团长只能自己反复进提现页刷。
     * 钱的事让人靠猜，猜错一次就是投诉（「我提现三天了还没到」）。
     *
     * ## 四种结果都发，但**措辞必须能一眼分清**
     *
     * 尤其 `reject`（运营驳回，可再提）与 `markFailed`（打款失败，需改收款方式）
     * 是两种完全不同的下一步动作，文案例必须区分（见 `withdraw-admin.service.ts` 的映射）。
     *
     * ⚠️ 金额塞进 `thing1`（≤20 字符，`¥120.00 已打款` 远未超限）而**不新开 `amount` 位**：
     * 一旦用了 `amount`，模板就必须恰好在第 2 位有金额类型 —— 四行统一结构就破了。
     */
    scene: 'withdraw_result',
    label: '提现结果通知',
    audience: '提交提现申请的团长',
    channels: ['wechat_subscribe', 'wechat_group'],
    trigger: '提现终态：驳回 / 打款成功 / 打款失败（审批通过不单独发，见 note）',
    mandatory: false,
    variables: ['noticeTitle', 'resultAt'],
    requestSubscribe: true,
    consumedBy: 'finance/withdraw-admin.service.ts（approve / reject / markPaid / markFailed）',
    wiring: 'live',
    wxFields: { noticeTitle: 'thing1', resultAt: 'time2' },
    note:
      '⭐ 提现的终态此前全静默，团长靠反复刷页面确认钱到没到 —— 这是信任问题，不是便利问题。' +
      '⚠️ **`approve`（审批通过）刻意不发**：它只是中间态（钱还在路上），' +
      '真正的答案是终态。一次性订阅**一次授权只有 1 条额度**，' +
      '一笔提现若发「已通过」+「已到账」两条，团长点两次「允许」才够用一次 —— ' +
      '额度必须留给「钱到了」和「钱没到」这两种他必须知道的时刻。' +
      '⚠️ `reject`（可重新提交）与 `markFailed`（需改收款方式）的措辞必须区分，' +
      '两者下一步动作不同，写混了等于把一次失败变成两次。' +
      '⚠️ 幂等键为 `withdraw:<id>:<状态>`：运营重复点「确认打款」不会让团长收到两条。',
    seed: {
      enabled: 0,
      wechatTemplateId: null,
      groupContent: '【ABox 提现】{{resultAt}} 你的提现申请{{noticeTitle}}，可在小程序查看明细。',
    },
  },
];

/** 场景键 → 声明（投递侧按 scene 查渠道与变量） */
export const MESSAGE_TEMPLATE_SPEC_MAP: Record<string, MessageTemplateSpec> = Object.fromEntries(
  MESSAGE_TEMPLATE_SPECS.map((s) => [s.scene, s]),
);

/**
 * 页面顶部口径说明（服务端下发，端上不复制第二份）
 *
 * 第三句是全页最容易被误解的地方：**微信订阅消息的文案不由本页决定**。
 */
export const MESSAGE_TEMPLATE_NOTE =
  '① 用户端**常规订单状态默认不推送**（简化原则，避免打扰）；退款结果等**必推项**除外。' +
  '② 启用某场景前，该场景每个渠道的必要条件都必须已配置（缺一即拒绝启用）—— ' +
  '否则页面显示「已启用」而实际投不出去。' +
  '③ ⚠️ **微信订阅消息的实际文案由微信公众平台侧的模板定义**，本页的文案字段用于' +
  '「微信群人工通知」与台账存档，**改它不会改变用户收到的订阅消息内容**。';

/** 模板的可编辑状态（库中三个可编辑字段的取值） */
export interface MessageTemplateState {
  enabled: number;
  wechatTemplateId: string | null;
  groupContent: string | null;
}

/** 库中行的最小形状（`ab_message_template` 的三个可编辑字段） */
export interface MessageTemplateRowLike {
  enabled: number;
  wechatTemplateId?: string | null;
  groupContent?: string | null;
}

/**
 * ⭐ **「库中行（或没有行）→ 生效状态」的唯一换算口**（M4-3 提取）
 *
 * 三处需要它：管理侧 `toView`（出参展示）、投递侧 `MessageService.notify`（判能不能发）、
 * 订阅侧 `MessageSubscribeService`（判能不能请求授权）。
 *
 * ⚠️ 提取的**理由**：这三处原先各自写了一遍三元表达式，形状完全相同 —— 属于
 *    「同一件事写三遍」，任一处被改（例如将来库表加一个字段）就会漂移成
 *    「管理页说已启用、投递侧判定不该发」。**规则单点、访问路径各自**，
 *    与 `missingForEnable` / `stats.constants.ts` 同一纪律。
 *
 * ⚠️ `groupContent` 的 `|| null`：种子里的 `''` 表示「没有文案」，
 *    与库中的 `NULL` 必须同义 —— 否则「未配置」会有两种表示（M3-12 已裁过一次）。
 */
export function specState(
  spec: MessageTemplateSpec,
  row?: MessageTemplateRowLike | null,
): MessageTemplateState {
  if (row) {
    return {
      enabled: row.enabled,
      wechatTemplateId: row.wechatTemplateId ?? null,
      groupContent: row.groupContent ?? null,
    };
  }
  return {
    enabled: spec.seed.enabled,
    wechatTemplateId: spec.seed.wechatTemplateId,
    groupContent: spec.seed.groupContent || null,
  };
}

/**
 * ⭐ **启用闸门（唯一判定口）**
 *
 * 返回「当前状态下还缺什么才能启用」——空数组 = 可以启用。
 *
 * ## 为什么必须是 fail-closed
 *
 * 缺模板 ID 就允许启用，页面会显示「已启用」，而投递时微信必然拒收：
 * 运营看到的是**绿灯**，用户收到的永远是**静默失败**，且没有任何地方显示异常。
 * 与其如此，不如让「启用」这个动作被明确挡下，并告诉运营缺哪一项。
 *
 * ## 为什么放在 specs 里
 *
 * **管理侧**（D60 保存前校验）与**投递侧**（`MessageService` 判断能否发）都要用它。
 * 两边各写一遍 = 迟早出现「管理侧允许启用、投递侧判定不可发」的死角。
 * 规则单点，访问路径各自 —— 与 `stats.constants.ts` 的口径收束同一纪律。
 */
export function missingForEnable(spec: MessageTemplateSpec, state: MessageTemplateState): string[] {
  const missing: string[] = [];
  for (const ch of spec.channels) {
    const req = CHANNEL_REQUIREMENT[ch];
    const value = state[req.field];
    if (value === null || value === undefined || String(value).trim() === '') {
      missing.push(`「${MESSAGE_CHANNEL_LABEL[ch]}」缺 ${req.fieldLabel}（${req.reason}）`);
    }
  }
  return missing;
}

/**
 * 提取文案里的 `{{变量}}` 并校验是否都在白名单内
 *
 * 返回非法变量名数组（去重，保持出现顺序）。
 *
 * 放行的两个边界：
 *   · 单个花括号 `{x}` 不算占位符（不匹配）—— 避免把「整箱 {12} 份」这类
 *     自然文本误判成变量；占位符**必须**是双花括号。
 *   · 空白容忍：`{{ orderNo }}` 与 `{{orderNo}}` 等价。
 */
export function findUnknownVariables(content: string, allowed: readonly string[]): string[] {
  const found = new Set<string>();
  for (const m of content.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
    const name = m[1];
    if (!allowed.includes(name)) found.add(name);
  }
  return [...found];
}

/**
 * ⭐ **用户端该请求哪些场景的订阅授权（唯一判定口）** —— M4-3
 *
 * 返回该场景**当前**应让用户授权的微信模板 ID；返回 `null` = 本场景此刻不该请求授权。
 *
 * ## 四个条件，缺一不可
 *
 * | 条件 | 不满足时的后果 |
 * |------|----------------|
 * | `spec.requestSubscribe` | 非用户端场景（供应商 / 微信群）会去骚扰用户要一个用不上的授权 |
 * | `spec.wiring === 'live'` | 索权却不用（代码根本没有投递点）—— 微信平台明确反对 |
 * | `state.enabled === 1` | 场景关着，就算授权了也不会发 —— 用户的「允许」被浪费 |
 * | `wechatTemplateId` 非空 | 没有模板 ID 就**没有可授权的对象**：`requestSubscribeMessage` 的 `tmplIds` 必须来自微信公众平台，传空/瞎编会被微信拒（`20001` 等） |
 *
 * ## 为什么放在 specs 里（与 `missingForEnable` 同一纪律）
 *
 * 「哪些场景该请求授权」既决定**投递能不能成功**（没授权就推不出去），
 * 又决定**端上向用户显示什么**。两边各写一遍必然漂移 —— 项目里已经有过
 * 「管理侧允许启用、投递侧判定不可发」的死角，这里不重犯。
 *
 * ⚠️ 一期**必然返回空数组**：没有微信账号 → `wechat_template_id` 全为空 →
 *    第 4 条直接不成立。这不是接口坏了（见 `MESSAGE_SUBSCRIBE_NOTE`），
 *    端上拿到空数组时**什么都不做**，而不是拿假 ID 去调微信。
 */
export function subscribeTemplateOf(
  spec: MessageTemplateSpec,
  state: MessageTemplateState,
): string | null {
  if (!spec.requestSubscribe) return null;
  if (spec.wiring !== 'live') return null;
  if (state.enabled !== 1) return null;
  const id = state.wechatTemplateId;
  if (id === null || id === undefined || String(id).trim() === '') return null;
  return String(id).trim();
}

/**
 * 业务字段 → 微信模板关键词 的转换（`wechat_subscribe` 投递前的**唯一入口**）
 *
 * ## 为什么必须集中在这里
 *
 * 调用方组装的是业务语义（`orderNo` / `amount` / `refundedAt`），而微信要的是
 * 模板关键词编号（`character_string1` / `amount2` / `time3`）。两者之间的换算
 * **只能有一处**：散在 6 个投递点里，就是 6 份会各自漂移的映射。
 *
 * ## 返回值为什么带 `missing`
 *
 * 微信要求「模板里每个关键词都必须有值」。少一个 = `47003 参数不合法`，
 * 而这条错误对运营毫无指导意义。这里提前把**缺了哪个业务字段**报出来，
 * 投递侧据此给出「退款时间缺失，未投递」这类能直接定位的原因。
 *
 * ⚠️ 本函数**不做兜底填充**（不拿 `-` / `00:00` 糊弄）：
 *    给微信一个假时间，用户会按假时间安排午饭 —— 那比不发更糟。
 */
/**
 * 订阅消息业务字段的中文名（**仅后台展示用**，不参与投递）
 *
 * 运营在微信公众平台选模板时看到的是中文关键词（「订单号」「退款时间」），
 * 而后台页面原本只有 `orderNo` 这类代码名 —— 两边对不上，他就会选错模板，
 * 然后收到 `47003`。这张小表把 `wxFields` 翻译成运营能对照的文字。
 */
export const WX_BIZ_FIELD_LABEL: Record<string, string> = {
  orderNo: '订单号',
  amount: '金额',
  refundedAt: '退款时间',
  mealDate: '出餐日期',
  settledCount: '笔数',
  cutoffTime: '截单时刻',
  cutoffAt: '截单时间（含日期）',
  applyAt: '申请时间',
  leaderLevel: '团长等级',
  /**
   * ⚠️ 这个键被 **5 个场景**共用（开团 / 晋级 / 见习到期 / 停职 / 提现结果），
   *    所以标签不能再写成「开团信息（日期 + 套餐名）」—— 运营在晋级那行会读不懂。
   *    各场景的具体含义写在各自 `note` 里（开团 = 日期 + 套餐名，晋级 = 等级 + 新费率……）。
   */
  noticeTitle: '通知概要（一句话，≤20 字）',
  effectiveAt: '生效时间',
  deadlineAt: '到期时间',
  suspendedAt: '停职时间',
  resultAt: '处理时间',
};

export function toWxData(
  spec: MessageTemplateSpec,
  bizData: Record<string, { value: string }>,
): { data: Record<string, { value: string }>; missing: string[] } {
  const map = spec.wxFields ?? {};
  const data: Record<string, { value: string }> = {};
  const missing: string[] = [];

  for (const [bizKey, wxKey] of Object.entries(map)) {
    const raw = bizData?.[bizKey]?.value;
    const val = typeof raw === 'string' ? raw.trim() : '';
    if (!val) {
      missing.push(bizKey);
      continue;
    }
    data[wxKey] = { value: val };
  }

  return { data, missing };
}

/**
 * 用户端接口的口径说明（**必须下发** —— 端上不复制第二份文案）
 *
 * ⚠️ 「空列表」有两种完全不同的含义，不写清楚端上就会当成一种：
 *    · **正常**：一期没有微信账号 → 没有模板 ID → 无场景可授权（当前状态）；
 *    · **异常**：运营把所有场景都关掉了。
 *    两者端上表现相同（不请求授权），但排查方向相反。
 */
export const MESSAGE_SUBSCRIBE_NOTE =
  '本清单 = **当前可以让用户授权**的订阅消息场景（条件：用户端场景 · 已接线 · 已启用 · ' +
  '已配置微信模板 ID，四条全中）。列表为空**通常是正常的**：一期尚未申请微信账号，' +
  '所有场景的模板 ID 均为空，故没有可授权的对象 —— 此时端上**不应**调用订阅接口，' +
  '更不能用假 ID 去调。' +
  '② 微信订阅消息为**一次性授权**：用户点过一次「允许」，服务端才推得出去（否则微信回 ' +
  '`43101 用户拒绝接收`）。故「必推项」在微信侧也**必须先拿到授权** —— ' +
  '原型说「退款结果必推」指的是产品意图，不是「无需用户同意」。' +
  '③ ⚠️ 模板 ID 由运营在后台（P36）配置，**端上不得硬编码** —— 硬编码等于第二份真相，' +
  '运营换模板后端上还在请求旧 ID。';

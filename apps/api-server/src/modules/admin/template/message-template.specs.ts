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
  /** 种子默认值（可编辑部分） */
  seed: {
    enabled: number;
    wechatTemplateId: string | null;
    groupContent: string;
  };
}

/**
 * 6 个场景
 *
 * ## ⚠️ 与原型 P36 的关系（必须如实说明，别让它变成「两个真相」）
 *
 * 前 5 行与原型 P36「消息推送策略」的 5 行**逐一对应**（`user_order_status` /
 * `leader_delivery` / `merchant_cook` / `leader_apply` / `refund_result`）。
 * 第 6 行 `commission_settled` 是 **M4-3 新增**：原型没写这一行，但它对应
 * 已实现的两段式佣金链路（T 日确认计佣 → T+1 02:00 入账，见 M4-2 定稿），
 * 入账后**必须通知团长**（否则团长只能自己去小程序翻余额，两段式会变成投诉源）。
 *
 * → 后台 P36 页面会显示 **6 行**。这不是页面写错了，是代码事实比原型多了 1 行；
 *   若运营问「为什么多了」，答案在本段。
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
    variables: ['mealDate', 'centerName', 'dishCount'],
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
        '【出餐通知】{{mealDate}} 需向 {{centerName}} 交付 {{dishCount}} 个菜品，请在 09:30 前完成出餐确认。',
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
    variables: ['orderNo', 'amount', 'refundedAt'],
    requestSubscribe: true,
    consumedBy: 'finance/refund.service.ts → MessageService.notify()（M3-12 接线）',
    wiring: 'live',
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

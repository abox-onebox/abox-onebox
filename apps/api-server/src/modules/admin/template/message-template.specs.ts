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
 * 5 个场景（与原型 P36 的 5 行逐一对应）
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
    trigger: '餐送达办公楼楼下（约 11:30）',
    mandatory: false,
    variables: ['buildingName', 'mealDate', 'arriveTime', 'quantity'],
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
    consumedBy: '—（一期无投递点）',
    wiring: 'pending',
    pendingReason:
      '团长申请为 C3「申请即生效、无审核」，申请成功页已即时反馈；推送提醒待二期接入。',
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

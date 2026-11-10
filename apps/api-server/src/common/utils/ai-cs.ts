/**
 * C 端智能客服（D · #44）：规则命中 FAQ + 124 号令合规公示层
 *
 * 本文件是**纯函数 + 常量**，零 IO、零 Nest DI —— 便于单测钉死分类与挂载逻辑，
 * 服务层只负责把配置值喂进来。设计同 `weekly-digest.ts` / `recall-campaign.service.ts` 的 `classifyUsers`。
 *
 * ## 为什么是「规则命中」而不是接 LLM
 * 生产 `PROVIDER_MODE=mock`（缺商户号/密钥会挂），A/B/C 三代 AI 能力均为规则/台账，
 * 不在运行时调大模型。C 端客服也保持一致：关键词命中 → 罐头答案，
 * 命中食品/资质类话题自动挂载 124 号令公示块。这样无需 LLM 也能交付、可门禁、可部署。
 *
 * ## 124 号令合规层（第二十条）
 * 《食品安全法》124 号令 + 预包装食品标签（GB 7718）要求：主页显著位置公示备案信息，
 * 销售页展示预包装标签。本层把「备案信息（公司级）+ 标签必含字段（schema）」结构化为
 * `ComplianceBlock`，FAQ 在相关意图下自动挂载，前端（小程序主页/商品页/客服窗）复用同一结构。
 */

/** 客服意图 */
export type CsIntent =
  | 'order' // 下单 / 购买 / 价格
  | 'delivery' // 配送 / 送达
  | 'refund' // 退款 / 取消
  | 'meal' // 套餐 / 菜单
  | 'qualification' // 资质 / 备案 / 公示
  | 'label' // 标签 / 配料 / 保质期
  | 'contact' // 客服 / 联系
  | 'other'; // 兜底

/** 124 号令公示块：公司级备案信息 + 预包装标签必含字段 */
export interface ComplianceData {
  /** 经营主体名称 */
  subjectName: string;
  /** 仅销售预包装食品备案编号 */
  filingNo: string;
  /** 统一社会信用代码 */
  creditCode: string;
  /** 经营范围（含「仅销售预包装食品」） */
  businessScope: string;
  /** 备案日期（YYYY-MM-DD） */
  filingDate: string;
}

export interface ComplianceBlock {
  /** 公示标题（如「ABox 一盒 · 资质与标签公示」） */
  title: string;
  /** 公司级备案信息 */
  filing: ComplianceData;
  /** 预包装食品标签必须展示的字段（schema，逐商品由前端填充具体值） */
  labelFields: string[];
  /** 补充说明文案 */
  note: string;
}

export interface CsAnswer {
  intent: CsIntent;
  /** 命中意图后的罐头答案（已规避任何第三方平台名/链接/口令） */
  answer: string;
  /** 命中食品/资质类话题时挂载的 124 号令公示块；否则为 null */
  compliance: ComplianceBlock | null;
  /** 是否命中了已知意图（false = 兜底 other） */
  matched: boolean;
}

/** 预包装食品标签必含字段（GB 7718《预包装食品标签通则》核心项） */
export const LABEL_FIELDS: string[] = [
  '食品名称',
  '配料表',
  '净含量',
  '生产日期',
  '保质期',
  '贮存条件',
  '生产者名称及地址',
  '食品生产许可证编号',
];

/** 挂载合规公示的意图（命中即把公示块附在回答后） */
const COMPLIANCE_INTENTS: CsIntent[] = ['qualification', 'label'];

interface FaqEntry {
  intent: CsIntent;
  keywords: string[];
  answer: string;
}

/** 意图 → 关键词 + 罐头答案。**顺序即优先级**：合规相关放最前，避免被泛意图吞掉。 */
const FAQ: FaqEntry[] = [
  {
    intent: 'qualification',
    keywords: [
      '资质',
      '备案',
      '营业执照',
      '许可证',
      '公示',
      '食品安全',
      '卫生',
      '合格',
      '检测报告',
      '认证',
      '经营许可',
      '经营主体',
      '公司资质',
      '靠谱',
      '正规',
    ],
    answer:
      'ABox 一盒由北京巡礼之年科技有限公司运营，仅销售预包装食品。相关备案与资质如下，可放心查看：',
  },
  {
    intent: 'label',
    keywords: [
      '标签',
      '配料',
      '保质期',
      '生产日期',
      '贮存条件',
      '生产者',
      '成分',
      '过敏',
      '添加剂',
      '净含量',
      '生产许可证',
    ],
    answer: '每款预包装食品的标签须包含以下信息，购买时可在商品页查看：',
  },
  {
    intent: 'refund',
    keywords: ['退款', '退钱', '退单', '取消订单', '撤单', '退货', '取消', '作废'],
    answer:
      '下单后若需取消：截单前（T-1 24:00 前）可在订单页自助取消并原路退款；截单后已进入备餐，原则上不支持退款。' +
      '若遇质量或配送问题，请到「我的 - 联系客服」反馈，我们会核实处理。',
  },
  {
    intent: 'meal',
    keywords: [
      '套餐',
      '今天吃',
      '吃什么',
      '菜单',
      '菜品',
      '一饭四菜',
      '荤素',
      '有什么菜',
      '饭盒',
      '搭配',
      '营养',
      '今日菜单',
    ],
    answer:
      'ABox 一盒是「一饭四菜」中式盒饭（热食），每日菜单由营养师统一搭配，您下单时只需选份数。' +
      '所有餐品均为预包装快消品，标签与资质见下方公示。',
  },
  {
    intent: 'delivery',
    keywords: [
      '配送',
      '送达',
      '送到',
      '几点到',
      '送餐',
      '工位',
      '交付',
      '自提',
      '到达',
      '送货',
      '配送时间',
      '送到工位',
    ],
    answer:
      '我们提供工位直送：截单后次日 11:30 前由团长送到您的工位，无需自提。' +
      '配送范围以您所在楼群的开团为准；若未显示您的楼，可联系客服申请开通。',
  },
  {
    intent: 'order',
    keywords: [
      '下单',
      '购买',
      '怎么买',
      '怎么订',
      '如何买',
      '付款',
      '支付',
      '多少钱',
      '价格',
      '份数',
      '收费',
      '下单流程',
      '订购',
    ],
    answer:
      'ABox 一盒采用「次日达、单一套餐」模式：每晚 24:00 前（T-1）在快团团下单，次日上午 11:30 前送达工位。' +
      '每份 ¥25.80，下单时只选份数，当日菜单由我们统一安排。可在「我的 - 联系客服」了解详情。',
  },
  {
    intent: 'contact',
    keywords: ['客服', '联系客服', '客服电话', '客服微信', '人工', '找人', '帮助', '反馈', '投诉'],
    answer:
      '需要帮助可到「我的 - 联系客服」查看客服微信 / 电话与服务时间；也可在订单页发起反馈。' +
      '目前为人工客服，工作日响应。',
  },
];

const FALLBACK_ANSWER =
  '您的问题我暂时没有标准答案。可到「我的 - 联系客服」获取人工帮助；关于资质与标签，可见下方公示信息。';

/** 把用户问题归到某一意图（关键词命中，首命中优先）。无命中返回 `other`。 */
export function classifyIntent(question: string): CsIntent {
  const q = (question ?? '').toLowerCase();
  for (const entry of FAQ) {
    if (entry.keywords.some((k) => q.includes(k.toLowerCase()))) return entry.intent;
  }
  return 'other';
}

/** 由意图取罐头答案（other 走兜底文案）。 */
export function composeAnswer(question: string): {
  intent: CsIntent;
  answer: string;
  matched: boolean;
} {
  const intent = classifyIntent(question);
  if (intent === 'other') return { intent, answer: FALLBACK_ANSWER, matched: false };
  const entry = FAQ.find((f) => f.intent === intent)!;
  return { intent, answer: entry.answer, matched: true };
}

/** 由配置数据构造 124 号令公示块（纯结构，无 IO）。 */
export function buildComplianceBlock(data: ComplianceData): ComplianceBlock {
  return {
    title: 'ABox 一盒 · 资质与标签公示',
    filing: data,
    labelFields: LABEL_FIELDS,
    note: '依据《食品安全法》及预包装食品标签（GB 7718）要求公示；具体标签值以盒内单品实物标签为准。',
  };
}

/** 命中食品/资质类意图时返回公示块，否则返回 null（纯函数，便于单测）。 */
export function attachCompliance(intent: CsIntent, block: ComplianceBlock): ComplianceBlock | null {
  return COMPLIANCE_INTENTS.includes(intent) ? block : null;
}

/**
 * 一站式回答：分类 → 取答案 → 命中合规意图则挂载公示块。
 * `compliance` 由服务层传入（从 `ab_config` 读取的配置值），本函数不碰数据库。
 */
export function answerQuestion(question: string, compliance: ComplianceBlock): CsAnswer {
  const { intent, answer, matched } = composeAnswer(question);
  return {
    intent,
    answer,
    compliance: attachCompliance(intent, compliance),
    matched,
  };
}

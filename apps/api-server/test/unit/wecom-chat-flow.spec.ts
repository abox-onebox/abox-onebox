import {
  parseIntent,
  isConfirm,
  isCancel,
  looksLikeStructuredCommand,
  chatErrorText,
  summarizeOrderData,
} from '../../src/modules/wecom-kb/chat-flow';

/**
 * 一句话 → 意图 的判据
 *
 * 最要紧的是「否定」这一条：同事说「别退款」必须**什么都不做**。
 * 误判成「退款」的代价是真金白银退出去，而误判成「不执行」的代价只是他再说一句。
 * 所以这里宁可保守。
 */

const now = new Date('2026-11-01T12:30:00Z'); // 北京 20:30

describe('isConfirm / isCancel', () => {
  it('认常见的确认说法', () => {
    for (const s of ['1', '好', '好的', '确认', '确定', '执行', '可以', 'ok']) {
      expect(isConfirm(s)).toBe(true);
    }
  });

  it('认常见的取消说法', () => {
    for (const s of ['2', '取消', '算了', '不用', '先不']) {
      expect(isCancel(s)).toBe(true);
    }
  });

  it('「不要了」既是取消但不该被确认误收', () => {
    expect(isConfirm('不要了')).toBe(false);
  });
});

describe('parseIntent', () => {
  it('排套餐：带上日期', () => {
    const r = parseIntent('给量子大厦 A 座上明天的 A 套餐', now);
    expect(r.kind).toBe('assign');
    if (r.kind === 'assign') {
      expect(r.date).toBe('2026-11-02');
      expect(r.dateExplicit).toBe(true);
    }
  });

  it('排套餐：没说日期时 date=null，交给上层去问', () => {
    const r = parseIntent('给量子大厦上 A 套餐', now);
    expect(r.kind).toBe('assign');
    if (r.kind === 'assign') {
      expect(r.date).toBeNull();
      expect(r.dateExplicit).toBe(false);
    }
  });

  it('查订单：认出「今天」', () => {
    const r = parseIntent('今天多少单', now);
    expect(r.kind).toBe('orders');
    if (r.kind === 'orders') expect(r.date).toBe('2026-11-01');
  });

  it('认「我的审批」', () => {
    expect(parseIntent('我的审批到哪了', now).kind).toBe('myRequests');
  });

  it('★否定：说「别退款」绝不进写操作', () => {
    expect(parseIntent('别退款这单', now).kind).toBe('negated');
    expect(parseIntent('先不排套餐', now).kind).toBe('negated');
    expect(parseIntent('不要下架', now).kind).toBe('negated');
  });

  it('单说「不要」按取消处理（不进未知分支，避免同事以为没听到）', () => {
    expect(parseIntent('不要', now).kind).toBe('cancel');
  });

  it('认「帮助」', () => {
    expect(parseIntent('帮助', now).kind).toBe('help');
    expect(parseIntent('能干什么', now).kind).toBe('help');
  });

  it('认不出的走 unknown（由上层给菜单，不许猜）', () => {
    expect(parseIntent('今天天气不错', now).kind).toBe('unknown');
  });

  it('空消息走 unknown', () => {
    expect(parseIntent('   ', now).kind).toBe('unknown');
  });
});

describe('looksLikeStructuredCommand', () => {
  it('结构化指令仍走老路（给负责人与排障用）', () => {
    expect(looksLikeStructuredCommand('执行 publish_assignment id=123 action=publish')).toBe(true);
    expect(looksLikeStructuredCommand('查询 q_orders date=2026-11-01')).toBe(true);
    expect(looksLikeStructuredCommand('审批通过 12')).toBe(true);
  });

  it('人话不误判成指令', () => {
    expect(looksLikeStructuredCommand('给量子大厦 A 座上明天的 A 套餐')).toBe(false);
    expect(looksLikeStructuredCommand('今天多少单')).toBe(false);
    expect(looksLikeStructuredCommand('帮助')).toBe(false);
  });
});

describe('summarizeOrderData', () => {
  // 真实出参形状（order-admin.service.ts list()）：汇总在 summary 下，不在顶层
  const real = {
    list: [],
    total: 0,
    page: 1,
    pageSize: 20,
    summary: {
      totalCount: 120,
      validCount: 112,
      validQuantity: 336,
      validAmountFen: 866880,
      abnormalCount: 3,
      pendingPayCount: 5,
      refundingCount: 2,
    },
  };

  it('★读 summary 而不是顶层：只读顶层会永远拿不到数', () => {
    const said = summarizeOrderData(real);
    expect(said).toContain('112 单');
    expect(said).toContain('336 份');
  });

  it('无效单单独说明，不混进有效单', () => {
    expect(summarizeOrderData(real)).toContain('另有 8 单已取消/退款');
  });

  it('异常单要提醒人看', () => {
    expect(summarizeOrderData(real)).toContain('异常 3 单');
  });

  it('结构认不出时返回 null，让上层退一步说人话（不编数字）', () => {
    expect(summarizeOrderData(null)).toBeNull();
    expect(summarizeOrderData({ foo: 'bar' })).toBeNull();
    expect(summarizeOrderData('不是对象')).toBeNull();
  });

  it('极端：summary 为空对象也不崩，返回 null', () => {
    expect(summarizeOrderData({ summary: {} })).toBeNull();
  });
});

describe('chatErrorText', () => {
  it('★30003 是订单状态机拒绝，不能说成「截单」', () => {
    const t = chatErrorText(30003);
    expect(t).toContain('状态不允许');
    expect(t).not.toContain('截单');
  });

  it('截单是 30013', () => {
    expect(chatErrorText(30013)).toContain('截单');
  });

  it('重复排餐是 30011', () => {
    expect(chatErrorText(30011)).toContain('已经排过套餐');
  });

  it('未知码回后台原文，原文也没有才说「没说原因」', () => {
    expect(chatErrorText(99999, '后台自定义说明')).toBe('后台自定义说明');
    expect(chatErrorText(99999)).toContain('没说原因');
  });
});

/**
 * 节点 N（团长健康度）与 O（经营健康度）的意图分流
 *
 * 这里最要紧的不是「能认出来」，而是**不抢别人的话**：
 *   · M 的证据词里有「留存预警」，若不先判 N，「团长留存预警」会被当成用户流失；
 *   · O 的证据词里有「健康度」，若不先判 N，「团长健康度」会变成全局经营分；
 *   · O 的证据词广，不能把「经营情况」（统计问答）和「风控对账」抢走。
 */
describe('parseIntent · 节点 N / O 分流', () => {
  const kindOf = (s: string): string => parseIntent(s, now).kind;

  it('认团长健康度（多种说法）', () => {
    for (const s of [
      '生成团长健康度',
      '团长流失预警',
      '看团长掉队情况',
      '团长活跃度分析',
      '养团长方案',
      '团长体检',
    ]) {
      expect(kindOf(s)).toBe('genLeaderHealth');
    }
  });

  it('★「团长留存预警」必须归团长（N），不能被 M 的「留存预警」截走', () => {
    expect(kindOf('团长留存预警')).toBe('genLeaderHealth');
  });

  it('认经营健康度（多种说法）', () => {
    for (const s of ['生成经营健康度', '健康度总分', '健康分多少', '经营体检', '体检报告']) {
      expect(kindOf(s)).toBe('genHealthScore');
    }
  });

  it('★「团长健康度」归 N，「经营健康度」归 O（同一个词不串台）', () => {
    expect(kindOf('团长健康度')).toBe('genLeaderHealth');
    expect(kindOf('经营健康度')).toBe('genHealthScore');
  });

  it('负控：已有的九个节点全部没被新正则抢走', () => {
    expect(kindOf('生成流失预警')).toBe('genChurnRecall');
    expect(kindOf('生成招募提案')).toBe('genRecruitProposal');
    expect(kindOf('生成招募页 双十一暖冬团')).toBe('genCampaign');
    expect(kindOf('生成风控对账')).toBe('genRiskRecon');
    expect(kindOf('今日日报')).toBe('genDailyReport');
    expect(kindOf('生成选品提案')).toBe('genMealProposal');
    expect(kindOf('生成发券策略')).toBe('genCouponStrategy');
    expect(kindOf('生成需求预测')).toBe('genDemandForecast');
    expect(kindOf('生成增长实验')).toBe('genGrowthExperiment');
    expect(kindOf('跑每日编排')).toBe('runOrchestrate');
  });

  it('负控：「经营情况」是统计问答，不许被健康度抢走', () => {
    expect(kindOf('经营情况')).not.toBe('genHealthScore');
  });

  it('负控：排套餐/查单这些日常动作不受影响', () => {
    expect(kindOf('给量子大厦 A 座上明天的 A 套餐')).toBe('assign');
    expect(kindOf('今天多少单')).toBe('orders');
  });
});

/**
 * 节点 P（社群运营）与 Q（退款根因）的意图分流
 * ------------------------------------------------------------------
 * 这两条最容易和邻居串台：
 *   · P 和 B「生成文案」、M「私域」都有词面重叠；
 *   · Q 和 K「风控对账」都在财务语境里。
 * 所以除了正例，必须给「邻居不被抢走」的负控——否则一旦串台，
 * 用户问的是「为什么退款」，收到的却是一份「钱对不对得上」的对账报告。
 */
describe('chatIntent · 社群运营 / 退款根因', () => {
  const kindOf = (s: string): string => parseIntent(s, now).kind;

  it('认社群运营（多种说法）', () => {
    for (const s of [
      '生成社群运营',
      '社群排期',
      '本周社群内容',
      '群运营方案',
      '朋友圈文案',
      '私域运营',
      '社群话术',
    ]) {
      expect(kindOf(s)).toBe('genCommunityPlan');
    }
  });

  it('认退款根因（多种说法）', () => {
    for (const s of [
      '生成退款根因',
      '退款聚类',
      '退款分析',
      '退款原因',
      '为什么退款',
      '退款复盘',
    ]) {
      expect(kindOf(s)).toBe('genRefundCluster');
    }
  });

  it('★「风控对账」仍归 K，「退款分析」归 Q（钱对不对 ≠ 为什么退）', () => {
    expect(kindOf('生成风控对账')).toBe('genRiskRecon');
    expect(kindOf('退款分析')).toBe('genRefundCluster');
  });

  it('负控：单条文案仍归 B，不被 P 抢走', () => {
    expect(kindOf('生成文案 周五截单提醒')).toBe('genCampaign');
  });

  it('负控：用户流失仍归 M，不被 P 的「私域」抢走', () => {
    expect(kindOf('生成流失预警')).toBe('genChurnRecall');
    expect(kindOf('私域流失召回')).toBe('genChurnRecall');
  });

  it('负控：团长健康度仍归 N，不被 P/Q 抢走', () => {
    expect(kindOf('生成团长健康度')).toBe('genLeaderHealth');
  });
});

/**
 * AI 编排节点 R · 开团草稿（#1 自动开团闭环 批 2）
 *
 * 最要紧的一条负面判据：**「开团草稿」不能被 `assign` 抢走**。
 * assign 是「真执行」语义（会追问参数、回 1 才动手），而这里只要一张草稿。
 * 一旦被抢走，同事想「先看看草稿」就会变成一次排餐指令 —— 这类误判代价是真实排期。
 */
describe('开团草稿（节点 R）', () => {
  const kindOf = (s: string): string => parseIntent(s, now).kind;

  it('认常见的几种说法', () => {
    for (const s of ['生成开团草稿', '开团草稿', '排餐草稿', '上架草稿', '出开团方案']) {
      expect(kindOf(s)).toBe('genLaunchDraft');
    }
  });

  it('带日期时解析出排期日（逐日排）', () => {
    const i = parseIntent('明天开团草稿', now);
    expect(i.kind).toBe('genLaunchDraft');
    if (i.kind === 'genLaunchDraft') expect(i.date).toBe('2026-11-02');
  });

  it('不带日期时交给服务层默认明日（此处为 null）', () => {
    const i = parseIntent('开团草稿', now);
    expect(i.kind).toBe('genLaunchDraft');
    if (i.kind === 'genLaunchDraft') expect(i.date).toBeNull();
  });

  it('负控：真排餐指令仍归 assign，不被草稿抢走', () => {
    expect(kindOf('给量子大厦A座上明天的A套餐')).toBe('assign');
    expect(kindOf('明天排餐')).toBe('assign');
  });

  it('负控：选品提案仍归 F', () => {
    expect(kindOf('生成选品提案')).toBe('genMealProposal');
  });

  it('负控：查单仍归 orders', () => {
    expect(kindOf('今天多少单')).toBe('orders');
  });
});

/**
 * 「确认开团」= 唯一会真写线上排期的一句话（#1 批 3）。
 *
 * 最要紧的两条负面判据：
 *   ① 裸「确认」「1」**仍归原有 confirm** —— 那是单条排餐草稿的确认语义，
 *      抢走会让老流程失效（同事回 1 却被告知「没有待确认的事」）；
 *   ② 生成类说法不能被它抢走，否则「想先看草稿」变成「直接开团」。
 */
describe('确认开团（节点 R · 写库）', () => {
  const kindOf = (s: string): string => parseIntent(s, now).kind;
  const picksOf = (s: string): number[] | null => {
    const i = parseIntent(s, now);
    expect(i.kind).toBe('confirmLaunchDraft');
    return i.kind === 'confirmLaunchDraft' ? i.picks : null;
  };

  it('裸「确认开团」⇒ 全排（picks=null）', () => {
    expect(picksOf('确认开团')).toBeNull();
  });

  it('「确认开团 1,3」⇒ 只排第 1、3 条', () => {
    expect(picksOf('确认开团 1,3')).toEqual([1, 3]);
    expect(picksOf('确认开团 1、3')).toEqual([1, 3]);
  });

  it('冒号/空格容错', () => {
    expect(picksOf('确认开团：2')).toEqual([2]);
    expect(picksOf('  确认开团  2  ')).toEqual([2]);
  });

  it('负控：裸「确认」「1」仍归 confirm（不抢老流程）', () => {
    expect(kindOf('确认')).toBe('confirm');
    expect(kindOf('1')).toBe('confirm');
  });

  it('负控：生成开团草稿仍归 genLaunchDraft，不被确认抢走', () => {
    expect(kindOf('生成开团草稿')).toBe('genLaunchDraft');
  });

  it('负控：真排餐指令仍归 assign', () => {
    expect(kindOf('给量子大厦A座上明天的A套餐')).toBe('assign');
  });
});

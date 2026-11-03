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

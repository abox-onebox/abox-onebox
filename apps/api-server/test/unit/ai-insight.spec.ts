import { looksLikeRealOutput, pickInsightTitle } from '../../src/common/utils/ai-insight';

/**
 * AI 台账 · 「这算不算一次真产出」判据
 *
 * 本文件钉死三件事：
 *   ① **必不报**：真实的失败/跳过文案一律判 false —— 台账不能被这些灌满，
 *      否则「AI 建议采纳率」这类指标永久失真（分母是失败提示）。
 *      样本全部**照抄** `wecom-chat.service.ts` 里的原文，不凭印象编。
 *   ② **必报**：典型多段报告判 true —— 防判据恒假，把真产出也拦掉（那比没有更糟）。
 *   ③ **标题抽取**去掉 markdown 记号，且在拿不到标题时用兜底，不留空标题。
 *
 * ⚠️ 阈值判据的天然代价：**一句话的真结论会被判为失败**（如「今天没有异常」）。
 *    这是刻意的取舍，见 `ai-insight.ts` 的「已知边界」——宁可漏极少，也不让噪声灌满。
 */
describe('looksLikeRealOutput · 失败提示必须判 false（样本取自真实文案）', () => {
  const FAILURES = [
    '取不到今天的日期，我先不动。稍后再试。',
    '我没认出是哪栋楼，而且一时拉不到楼栋清单。稍后再试，或让负责人看看后台。',
    '近 30 天日级销量、楼栋与菜品数据这次都没取到（可能权限不足或还没开团）。可在后台看板查看，或稍后重试。',
    '近 30 天的经营基线、楼栋、套餐与券种数据这次都没取到（可能权限不足或还没开团）。可在后台看板查看，或稍后重试。',
    '近 30 天销售数据与套餐目录这次都没取到（可能权限不足或数据还没生成）。可在后台看板查看，或稍后重试。',
    '近 7 天经营数据这次没取到（可能权限不足或数据还没生成）。可在后台看板查看，或稍后重试。',
    '这项数据的权限我判不了（目录里对不上端点），先不查。请让负责人看一眼。',
    '这段不是合法 JSON（比如少了引号或括号）。再发一次，或回 2 取消。',
    '（无内容）',
    '好，什么都没动。',
  ];

  it.each(FAILURES)('失败文案不入台账：%s', (t) => {
    expect(looksLikeRealOutput(t)).toBe(false);
  });
});

describe('looksLikeRealOutput · 真报告必须判 true', () => {
  const REPORT = [
    '# 经营健康度 · 2026-11-04',
    '',
    '总分 72/100 · 黄色 · 需关注（较上次 +4）',
    '',
    '## 五维明细',
    '· 增长 16/20 —— 近 7 天 GMV ¥1,284（环比 +6.2%）',
    '· 留存 12/20 —— D7 留存 18.4%，低于基线',
    '· 资金 20/20 —— 无待审批提现积压',
    '· 履约 14/20 —— 退款率 2.1%，应付未出单 0 项',
    '· 组织 10/20 —— 楼群覆盖 1/5',
    '',
    '## 三条优先动作',
    '1. 补齐 4 个楼群的团长覆盖（缺口最大项，20 分里丢了 8 分）',
    '2. 检查 D7 留存下滑是否与本周菜品重复有关',
    '3. 保持提现日清，资金维已是满分项，别放松',
    '',
    '（只分析不执行 · 数据源：经营看板 7d / 截止 2026-11-03）',
  ].join('\n');

  it('多段报告判 true', () => {
    expect(looksLikeRealOutput(REPORT)).toBe(true);
  });

  it('单行超长文本也判 true（模型偶尔不给换行）', () => {
    expect(looksLikeRealOutput('·'.repeat(200) + '结论')).toBe(true);
  });

  it('多行短文本也判 true（行数是独立判据，与长度取或）', () => {
    expect(looksLikeRealOutput('a\nb\nc\nd\ne\nf')).toBe(true);
  });

  it('空串 / 纯空白判 false', () => {
    expect(looksLikeRealOutput('')).toBe(false);
    expect(looksLikeRealOutput('   \n\n  ')).toBe(false);
  });
});

describe('pickInsightTitle', () => {
  it('去掉 markdown 标题记号', () => {
    expect(pickInsightTitle('# 选品提案 · 2026-11-05\n\n正文', '兜底')).toBe(
      '选品提案 · 2026-11-05',
    );
  });

  it('跳过开头的括注行（如「（AI 生成）」）', () => {
    expect(pickInsightTitle('（AI 生成）\n# 运营日报\n正文', '兜底')).toBe('运营日报');
  });

  it('拿不到标题时用兜底，不留空标题', () => {
    expect(pickInsightTitle('', '运营日报')).toBe('运营日报');
    expect(pickInsightTitle('（无内容）', '运营日报')).toBe('运营日报');
  });
});

import {
  answerQuestion,
  attachCompliance,
  buildComplianceBlock,
  classifyIntent,
  composeAnswer,
  LABEL_FIELDS,
  type ComplianceData,
} from '../../src/common/utils/ai-cs';

const COMPLIANCE: ComplianceData = {
  subjectName: '测试主体有限公司',
  filingNo: 'BJ-FOOD-12345',
  creditCode: '91110108XXXXXXXXXX',
  businessScope: '食品销售（仅销售预包装食品）',
  filingDate: '2026-10-28',
};

describe('ai-cs · 规则命中 FAQ + 124 号令合规层', () => {
  it('classifyIntent：资质类关键词 → qualification', () => {
    expect(classifyIntent('你们有食品经营许可证吗')).toBe('qualification');
    expect(classifyIntent('营业执照能看吗')).toBe('qualification');
  });

  it('classifyIntent：标签类关键词 → label', () => {
    expect(classifyIntent('配料表里有防腐剂吗')).toBe('label');
    expect(classifyIntent('保质期多久')).toBe('label');
  });

  it('classifyIntent：退款/套餐/配送/下单/客服 各自归位', () => {
    expect(classifyIntent('怎么退款')).toBe('refund');
    expect(classifyIntent('今天有什么菜')).toBe('meal');
    expect(classifyIntent('几点送到工位')).toBe('delivery');
    expect(classifyIntent('怎么下单')).toBe('order');
    expect(classifyIntent('客服电话多少')).toBe('contact');
  });

  it('classifyIntent：无命中 → other', () => {
    expect(classifyIntent('今天天气不错')).toBe('other');
  });

  it('composeAnswer：命中返回罐头答案且 matched=true；兜底 matched=false', () => {
    const hit = composeAnswer('你们资质靠谱吗');
    expect(hit.matched).toBe(true);
    expect(hit.answer.length).toBeGreaterThan(0);
    const miss = composeAnswer('今天天气不错');
    expect(miss.matched).toBe(false);
    expect(miss.intent).toBe('other');
  });

  it('buildComplianceBlock：含公司备案信息 + 标签字段 schema', () => {
    const block = buildComplianceBlock(COMPLIANCE);
    expect(block.filing.subjectName).toBe('测试主体有限公司');
    expect(block.filing.filingNo).toBe('BJ-FOOD-12345');
    expect(Array.isArray(block.labelFields)).toBe(true);
    expect(block.labelFields.length).toBe(LABEL_FIELDS.length);
    expect(block.labelFields).toContain('配料表');
    expect(block.labelFields).toContain('生产日期');
  });

  it('attachCompliance：仅资质/标签意图挂载，其余返回 null', () => {
    const block = buildComplianceBlock(COMPLIANCE);
    expect(attachCompliance('qualification', block)).not.toBeNull();
    expect(attachCompliance('label', block)).not.toBeNull();
    expect(attachCompliance('refund', block)).toBeNull();
    expect(attachCompliance('order', block)).toBeNull();
    expect(attachCompliance('other', block)).toBeNull();
  });

  it('answerQuestion：资质/标签问题回带 compliance 块；其他问题为 null', () => {
    const q1 = answerQuestion('你们的备案信息能公示吗', buildComplianceBlock(COMPLIANCE));
    expect(q1.intent).toBe('qualification');
    expect(q1.compliance).not.toBeNull();
    expect(q1.compliance!.filing.creditCode).toBe('91110108XXXXXXXXXX');

    const q2 = answerQuestion('保质期怎么看', buildComplianceBlock(COMPLIANCE));
    expect(q2.intent).toBe('label');
    expect(q2.compliance).not.toBeNull();

    const q3 = answerQuestion('怎么下单', buildComplianceBlock(COMPLIANCE));
    expect(q3.intent).toBe('order');
    expect(q3.compliance).toBeNull();

    const q4 = answerQuestion('今天好饿', buildComplianceBlock(COMPLIANCE));
    expect(q4.intent).toBe('other');
    expect(q4.compliance).toBeNull();
    expect(q4.matched).toBe(false);
  });
});

import {
  diffKeywords,
  expectedKeywordsOf,
  parseTemplateKeywords,
} from '../../src/modules/admin/template/wx-template-inspect.service';

/**
 * 模板关键词校验 · 纯函数单测（D60++）
 *
 * ⚠️ 本文件存在的理由：这段逻辑的**唯一验证途径**本来是「配好模板 → 发一条 → 看 47003」——
 *    一次往返十几分钟，且要消耗一个真实用户的订阅授权额度。
 *    而它出错时**没有任何报错**，只有一条「发不出去」。所以规则必须在这里钉死。
 *
 * 必报样本用的是**当前真实形态**：运营在公众平台勾两个关键词（截单时间 + 温馨提示），
 * 而场景只声明了一个 —— 这正是「必须报 extra」的那一类，写成「包含即可」就会漏掉。
 */
describe('模板关键词校验 · 纯函数（D60++）', () => {
  describe('parseTemplateKeywords：从模板 content 抽编号', () => {
    it('真实单关键词模板（当前截单通知的形态）', () => {
      expect(parseTemplateKeywords('截单时间:{{time1.DATA}}')).toEqual([
        { code: 'time1', label: '截单时间' },
      ]);
    });

    it('两个关键词（运营必须勾两个 —— 微信最少 2 个）', () => {
      const content = '截单时间:{{time1.DATA}}\n温馨提示:{{thing2.DATA}}';
      expect(parseTemplateKeywords(content)).toEqual([
        { code: 'time1', label: '截单时间' },
        { code: 'thing2', label: '温馨提示' },
      ]);
    });

    it('编号**不带数字**也要认（`{{enum.DATA}}` 这类，用 \\w+\\d 会解析成 0 个）', () => {
      expect(parseTemplateKeywords('状态:{{enum.DATA}}')).toEqual([
        { code: 'enum', label: '状态' },
      ]);
      expect(parseTemplateKeywords('短语:{{phrase.DATA}}')).toEqual([
        { code: 'phrase', label: '短语' },
      ]);
    });

    it('标签缺失时用编号兜底，**不编造中文**', () => {
      expect(parseTemplateKeywords('{{time1.DATA}}')).toEqual([{ code: 'time1', label: 'time1' }]);
    });

    it('中文冒号、冒号后空格、占位符内空格都能剥掉', () => {
      expect(parseTemplateKeywords('截单时间： {{ time1.DATA }}')).toEqual([
        { code: 'time1', label: '截单时间' },
      ]);
    });

    it('同一编号出现两次只算一个（否则 diffs 会虚报）', () => {
      const content = '时间:{{time1.DATA}}\n再写一遍:{{time1.DATA}}';
      expect(parseTemplateKeywords(content)).toHaveLength(1);
    });

    it('空 / 未定义 content ⇒ 空数组（不是抛异常）', () => {
      expect(parseTemplateKeywords('')).toEqual([]);
      expect(parseTemplateKeywords(undefined as unknown as string)).toEqual([]);
    });
  });

  describe('expectedKeywordsOf：必须取 wxFields 的**值**', () => {
    it('取微信编号而非业务字段名', () => {
      // 若有人写成 Object.keys()，这里会得到 code='cutoffAt' ⇒ 本行必红
      expect(expectedKeywordsOf({ cutoffAt: 'time1' })).toEqual([
        { code: 'time1', label: '截单时间（含日期）' },
      ]);
    });

    it('中文标签取自业务字段名映射；映射不到就退回业务名（不编造）', () => {
      const out = expectedKeywordsOf({ someNewField: 'thing9' });
      expect(out[0]).toEqual({ code: 'thing9', label: 'someNewField' });
    });
  });

  describe('diffKeywords：集合必须**完全相等**', () => {
    it('完全相等 ⇒ ok（必不报样本）', () => {
      const actual = parseTemplateKeywords('截单时间:{{time1.DATA}}');
      const expected = expectedKeywordsOf({ cutoffAt: 'time1' });
      expect(diffKeywords(actual, expected)).toEqual({ ok: true, missing: [], extra: [] });
    });

    it('模板多一个关键词 ⇒ **必须报 extra**（当前真实困境：勾了两个）', () => {
      const actual = parseTemplateKeywords('截单时间:{{time1.DATA}}\n温馨提示:{{thing2.DATA}}');
      const expected = expectedKeywordsOf({ cutoffAt: 'time1' });
      const r = diffKeywords(actual, expected);
      expect(r.ok).toBe(false);
      expect(r.extra).toEqual(['thing2']);
      expect(r.missing).toEqual([]);
    });

    it('模板少一个关键词 ⇒ 报 missing', () => {
      const actual = parseTemplateKeywords('截单时间:{{time1.DATA}}');
      const expected = expectedKeywordsOf({ cutoffAt: 'time1', tips: 'thing2' });
      const r = diffKeywords(actual, expected);
      expect(r.ok).toBe(false);
      expect(r.missing).toEqual(['thing2']);
      expect(r.extra).toEqual([]);
    });

    it('编号相同但语义不同也无法自动识别 ⇒ 只能靠返回的 label 让人核对', () => {
      // 模板的 time1 叫「下单时间」，我们填的是截单时刻 —— 编号一致，语义错位
      const actual = parseTemplateKeywords('下单时间:{{time1.DATA}}');
      const expected = expectedKeywordsOf({ cutoffAt: 'time1' });
      const r = diffKeywords(actual, expected);
      // 判据上必然 pass，所以 label 必须被带出去给人看
      expect(r.ok).toBe(true);
      expect(actual[0].label).toBe('下单时间');
      expect(expected[0].label).toBe('截单时间（含日期）');
    });

    it('两边都空 ⇒ ok（不误报；空模板由 40037/47003 在发送时兜）', () => {
      expect(diffKeywords([], [])).toEqual({ ok: true, missing: [], extra: [] });
    });
  });
});

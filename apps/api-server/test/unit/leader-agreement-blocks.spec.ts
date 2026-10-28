import {
  LEADER_AGREEMENT_BLOCKS,
  LEADER_AGREEMENT_FULL_TEXT,
  LEADER_AGREEMENT_UPDATED_AT,
  LEADER_AGREEMENT_VERSION,
  blocksToPlainText,
  checkAgreementCoverage,
  norm,
  parseAgreementMarkdown,
} from '@abox/shared-types';

/**
 * 团长协议「全文 → 渲染块」判据（2026-10-28 · 端上全文页）
 *
 * ## 为什么要有这份单测
 *
 * 端上协议页只渲染 `<text>`（**不解析 Markdown**），全文必须先被
 * `parseAgreementMarkdown()` 结构化 —— 这一步**没有任何运行时症状**：
 * 少解析一段，页面照常显示、不报错、不崩溃，只是**少了一条条款**，
 * 而团长已经对着缺失的版本点了「同意」。typecheck / lint / e2e 全绿。
 *
 * ⇒ 本文件守的是一条**合规**不变量：端上显示的正文 == 真源全文 == 公示 md。
 *
 * ## 两条独立判据（刻意用两套不相干的剥离规则，防自证循环）
 *
 *   ① `checkAgreementCoverage()` —— 按**行类型**剥离前缀后逐行精确对拍；
 *   ② `brutal()` —— **符号暴力剥离**（不分类型，抹掉 `# > | * \` - . 数字`）后 `includes` 对拍。
 *      即使 ① 的分类漏了一种 Markdown 新形态，② 仍会把整行丢失照红。
 *
 * ⚠️ 两条都必须配**活性自证**（人为破坏后必须报红）—— 恒绿的检查等于没有检查。
 */
describe('团长协议全文 → 渲染块', () => {
  /** 判据 ② 的暴力归一化（与 `lineToPlain` 的分类型剥离**互不相干**） */
  const brutal = (s: string): string => norm(s.replace(/[#>|*`\-.\d]/g, ''));

  it('结构：13 个章节标题 + 1 张费率表 + 27 条列表项', () => {
    const kinds = LEADER_AGREEMENT_BLOCKS.reduce<Record<string, number>>((acc, b) => {
      acc[b.kind] = (acc[b.kind] || 0) + 1;
      return acc;
    }, {});

    expect(kinds.h1).toBe(1);
    expect(kinds.h2).toBe(13); // 「引言」+ 十二节
    expect(kinds.table).toBe(1);
    expect(kinds.li).toBeGreaterThan(20);
  });

  it('⭐ 佣金费率表解析正确（4 级 8/9/10/12%，团长签的就是这个价）', () => {
    const table = LEADER_AGREEMENT_BLOCKS.find((b) => b.kind === 'table');
    expect(table).toBeDefined();
    if (table?.kind !== 'table') throw new Error('表格块缺失');

    expect(table.head).toEqual(['等级', '佣金费率', '晋升条件（须同时满足）']);
    expect(table.rows.map((r) => r[0])).toEqual(['见习', '正式', '金牌', '首席']);
    expect(table.rows.map((r) => r[1])).toEqual(['8%', '9%', '10%', '12%']);
    expect(table.rows).toHaveLength(4);
  });

  it('⭐ 反传销红线（第六节）必须在块里 —— 少了它就是合规事故', () => {
    const text = blocksToPlainText(LEADER_AGREEMENT_BLOCKS).join('\n');
    expect(text).toContain('合规与禁止行为');
    expect(text).toContain('不按发展下级团长数量计提报酬');
  });

  it('端上拿到的文本**不含 Markdown 残留标记**（<text> 会把星号打到用户眼前）', () => {
    for (const line of blocksToPlainText(LEADER_AGREEMENT_BLOCKS)) {
      expect(line).not.toMatch(/\*\*/);
      expect(line).not.toMatch(/`/);
      expect(line).not.toMatch(/^#/);
      expect(line).not.toMatch(/^>/);
      expect(line).not.toContain('|');
    }
  });

  it('判据 ①：真源每一行都在块里（必不报样本 —— 用**未改动**的真源本身）', () => {
    expect(checkAgreementCoverage(LEADER_AGREEMENT_FULL_TEXT, LEADER_AGREEMENT_BLOCKS)).toEqual([]);
  });

  it('判据 ②：暴力剥离后，真源每一行都被块的纯文本包含', () => {
    const rendered = brutal(blocksToPlainText(LEADER_AGREEMENT_BLOCKS).join('\n'));
    const missing: string[] = [];

    for (const raw of LEADER_AGREEMENT_FULL_TEXT.split('\n')) {
      const expect1 = brutal(raw);
      if (!expect1) continue; // 空行 / 分隔行
      if (!rendered.includes(expect1)) missing.push(raw.trim());
    }

    expect(missing).toEqual([]);
  });

  it('⭐ 活性自证：整节被吞掉时判据 ①② 都必须报红（否则它们是恒绿的空壳）', () => {
    // 模拟「解析器悄悄少一段」：删掉第六节（合规红线）标题到第七节之间的全部块
    const from = LEADER_AGREEMENT_BLOCKS.findIndex(
      (b) => b.kind === 'h2' && b.text.includes('六、'),
    );
    const to = LEADER_AGREEMENT_BLOCKS.findIndex((b) => b.kind === 'h2' && b.text.includes('七、'));
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);

    const broken = [
      ...LEADER_AGREEMENT_BLOCKS.slice(0, from),
      ...LEADER_AGREEMENT_BLOCKS.slice(to),
    ];

    expect(broken.length).toBeLessThan(LEADER_AGREEMENT_BLOCKS.length);
    expect(checkAgreementCoverage(LEADER_AGREEMENT_FULL_TEXT, broken).length).toBeGreaterThan(0);

    const rendered = brutal(blocksToPlainText(broken).join('\n'));
    expect(rendered).not.toContain(brutal('不按发展下级团长数量计提报酬'));
  });

  it('解析器对**不认识的行**降级为段落，而不是丢掉（防新形态导致整行消失）', () => {
    const blocks = parseAgreementMarkdown(
      '随便一行没有标记的话\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    );
    expect(blocks[0]).toEqual({ kind: 'p', text: '随便一行没有标记的话' });
    expect(blocks[1]).toEqual({ kind: 'table', head: ['a', 'b'], rows: [['1', '2']] });
    expect(checkAgreementCoverage('随便一行没有标记的话', blocks.slice(0, 1))).toEqual([]);
  });

  it('版本三处一致：常量 / 全文引言 / 定稿日期（改版只改一处会被这里拦下）', () => {
    expect(LEADER_AGREEMENT_FULL_TEXT).toContain(`**版本**：${LEADER_AGREEMENT_VERSION}`);
    expect(LEADER_AGREEMENT_FULL_TEXT).toContain(LEADER_AGREEMENT_UPDATED_AT);
  });
});

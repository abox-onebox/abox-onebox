import { normalizeLabelInfo } from '../../src/common/utils/label-info';

/**
 * 124 号令第二十条 · 逐品标签归一化（2026-11-10）
 *
 * 钉死两件事：
 *   ① 必不报：合法对象 / 合法 JSON 串必须原样放行（防恒红把合规信息藏起来）；
 *   ② 必报：脏值一律降级为 null，**绝不把原始脏串显示给用户**（防恒绿造成资质展示事故）。
 */

describe('normalizeLabelInfo · 必不报（合法标签放行）', () => {
  it('JSON 列解析后的对象原样返回', () => {
    const info = { 品名: '康师傅冰红茶', 净含量: '500mL', 保质期: '12个月' };
    expect(normalizeLabelInfo(info)).toEqual(info);
  });

  it('手填的 JSON 字符串也认（运营可能直接写文本）', () => {
    expect(normalizeLabelInfo('{"品名":"旺旺雪饼","净含量":"84g"}')).toEqual({
      品名: '旺旺雪饼',
      净含量: '84g',
    });
  });

  it('数字值转字符串、键值首尾空白被去掉', () => {
    expect(normalizeLabelInfo({ ' 净含量 ': ' 500mL ', 数量: 2 })).toEqual({
      净含量: '500mL',
      数量: '2',
    });
  });
});

describe('normalizeLabelInfo · 必报（脏值静默降级，不外泄）', () => {
  it.each([[null], [undefined], [''], ['   '], ['{不是 JSON'], ['[]'], [[]], [42], [true], [{}]])(
    '脏输入 %p → null',
    (raw) => {
      expect(normalizeLabelInfo(raw)).toBeNull();
    },
  );

  it('JSON 串里是数组 / 标量，也降级为 null', () => {
    expect(normalizeLabelInfo('[1,2,3]')).toBeNull();
    expect(normalizeLabelInfo('"一段文本"')).toBeNull();
  });

  it('嵌套对象 / 数组值 / 空值项被逐条跳过，不进展示', () => {
    expect(
      normalizeLabelInfo({
        品名: '蛋黄派',
        嵌套: { a: 1 },
        数组: ['x'],
        空值: '',
        空白: '   ',
        null值: null,
        有效: 'GB/T 20977',
      }),
    ).toEqual({ 品名: '蛋黄派', 有效: 'GB/T 20977' });
  });

  it('超长键 / 超长值被丢弃；行数封顶 20 条', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 30; i += 1) many[`字段${i}`] = `值${i}`;
    const out = normalizeLabelInfo({ ...many, 超长键: 'x'.repeat(30) });
    expect(out).not.toBeNull();
    expect(Object.keys(out ?? {})).toHaveLength(20);
    expect(normalizeLabelInfo({ 正常: 'v', 超长值: 'x'.repeat(201) })).toEqual({ 正常: 'v' });
  });
});

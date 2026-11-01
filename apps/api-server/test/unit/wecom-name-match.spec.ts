import {
  normalizeName,
  matchByName,
  parseMealDate,
  NameCandidate,
} from '../../src/modules/wecom-kb/name-match';

/**
 * 中文说法 → 主键 的匹配判据
 *
 * 为什么值得单测：这一层判错的表现是「套餐排到隔壁楼」「出餐日排到昨天」，
 * 而且**不会报错**——后台照常成功，只有同事第二天发现没饭吃。
 * 故把它写成纯函数并逐条钉死，不依赖任何 IO。
 */

const groups: NameCandidate[] = [
  { id: 1, name: '量子大厦楼群' },
  { id: 2, name: '中关村软件园楼群' },
  { id: 3, name: '望京 SOHO 楼群' },
];

const buildings: NameCandidate[] = [
  { id: 11, name: '量子大厦 A 座', note: '量子大厦楼群' },
  { id: 12, name: '量子大厦 B 座', note: '量子大厦楼群' },
  { id: 13, name: '中关村软件园 3 号楼', note: '中关村软件园楼群' },
];

describe('normalizeName', () => {
  it('去空白、全角转半角、英文小写', () => {
    expect(normalizeName(' 量子大厦 Ａ 座 ')).toBe('量子大厦a座');
    expect(normalizeName('望京ＳＯＨＯ')).toBe('望京soho');
  });

  it('去掉中文标点与括号', () => {
    expect(normalizeName('量子大厦（A座）')).toBe('量子大厦a座');
    expect(normalizeName('A 套餐、B 套餐')).toBe('a套餐b套餐');
  });

  it('空输入返回空串（上层据此判 none，不许当命中）', () => {
    expect(normalizeName('   ')).toBe('');
    expect(normalizeName('')).toBe('');
  });
});

describe('matchByName', () => {
  it('完全相等直接命中', () => {
    const r = matchByName('量子大厦楼群', groups);
    expect(r).toEqual({ kind: 'hit', item: { id: 1, name: '量子大厦楼群' } });
  });

  it('忽略空格与全半角差异后仍算完全相等', () => {
    const r = matchByName(' 望京soho楼群 ', groups);
    expect(r.kind).toBe('hit');
    if (r.kind === 'hit') expect(r.item.id).toBe(3);
  });

  it('输入是名称的一部分：唯一则命中', () => {
    const r = matchByName('中关村软件园 3 号楼', buildings);
    expect(r.kind).toBe('hit');
    if (r.kind === 'hit') expect(r.item.id).toBe(13);
  });

  it('命中多个时必须给候选，绝不自己挑一个', () => {
    const r = matchByName('量子大厦', buildings);
    expect(r.kind).toBe('many');
    if (r.kind === 'many') {
      expect(r.items.map((x) => x.id).sort()).toEqual([11, 12]);
    }
  });

  it('A 座与 B 座不得互相命中（差一个字就是差一栋楼）', () => {
    expect(matchByName('量子大厦 A 座', buildings).kind).toBe('hit');
    const r = matchByName('量子大厦 A 座', buildings);
    if (r.kind === 'hit') expect(r.item.id).toBe(11);
  });

  it('沾不上边返回 none', () => {
    expect(matchByName('上海中心', groups)).toEqual({ kind: 'none' });
  });

  it('空输入返回 none，不许把空串匹配成第一项', () => {
    expect(matchByName('   ', groups)).toEqual({ kind: 'none' });
  });

  it('候选过多时截断，避免回复一大坨', () => {
    const many: NameCandidate[] = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      name: `量子大厦 ${i + 1} 号楼`,
    }));
    const r = matchByName('量子大厦', many, 6);
    expect(r.kind).toBe('many');
    if (r.kind === 'many') expect(r.items.length).toBe(6);
  });

  it('名称越贴近原话排越前（避免把「量子大厦」排在「量子大厦 A 座」前面）', () => {
    const r = matchByName('量子大厦 5 号楼', [
      { id: 1, name: '量子大厦' },
      { id: 2, name: '量子大厦 5 号楼' },
    ]);
    expect(r.kind).toBe('hit');
    if (r.kind === 'hit') expect(r.item.id).toBe(2);
  });
});

describe('parseMealDate', () => {
  // 北京时间 2026-11-01 20:30
  const now = new Date('2026-11-01T12:30:00Z');

  it('认「明天」', () => {
    expect(parseMealDate('给量子大厦上明天的套餐', now)).toEqual({
      date: '2026-11-02',
      explicit: true,
      hint: null,
    });
  });

  it('认「今天」「后天」', () => {
    expect(parseMealDate('今天的单', now).date).toBe('2026-11-01');
    expect(parseMealDate('后天', now).date).toBe('2026-11-03');
  });

  it('认具体日期（带年 / 不带年）', () => {
    expect(parseMealDate('2026-12-03', now).date).toBe('2026-12-03');
    expect(parseMealDate('12月5日', now).date).toBe('2026-12-05');
  });

  it('认不出来时返回 null 且 explicit=false（让上层去问，不许默认明天）', () => {
    const r = parseMealDate('给量子大厦上套餐', now);
    expect(r.date).toBeNull();
    expect(r.explicit).toBe(false);
  });

  it('跨 UTC 日界：北京 00:30 说「明天」不能算成今天', () => {
    // UTC 2026-11-01T16:30Z = 北京 2026-11-02 00:30
    const midnight = new Date('2026-11-01T16:30:00Z');
    expect(parseMealDate('明天', midnight).date).toBe('2026-11-03');
    expect(parseMealDate('今天', midnight).date).toBe('2026-11-02');
  });
});

import {
  aggregatePageDuration,
  medianOf,
  normalizePagePath,
  saneDurationMs,
  saneTimeMs,
} from '../../src/common/utils/page-duration-stats';

/**
 * 页面停留聚合判据（D77 · 2026-10-30）
 *
 * ⚠️ 自证要求：每个判据都给「必报」与「必不报」两组样本 ——
 *    只测正向的用例在判据写反时**照样全绿**（如 `saneTimeMs` 恒返回 null 时，
 *    「剔除无效行」的断言仍然成立，只有「有效行必须留下」能拦住它）。
 */
describe('normalizePagePath', () => {
  it('必报：H5 的前导斜杠必须去掉（否则同一页被算成两个）', () => {
    expect(normalizePagePath('/pages/index/index')).toBe('pages/index/index');
  });

  it('必报：多个斜杠 / 首尾空格一并处理', () => {
    expect(normalizePagePath(' //pages/index/index ')).toBe('pages/index/index');
  });

  it('必不报：小程序原生路径保持原样（不能改坏）', () => {
    expect(normalizePagePath('pages/index/index')).toBe('pages/index/index');
  });

  it('必不报：非字符串返回空串而不是抛错', () => {
    expect(normalizePagePath(undefined)).toBe('');
    expect(normalizePagePath(123)).toBe('');
  });
});

describe('saneTimeMs', () => {
  it('必报：Invalid Date / null / 空串必须判为不可用', () => {
    expect(saneTimeMs(new Date('not-a-date'))).toBeNull();
    expect(saneTimeMs(null)).toBeNull();
    expect(saneTimeMs(undefined)).toBeNull();
    expect(saneTimeMs('')).toBeNull();
  });

  // ⛔ 已知边界：MySQL 宽松模式存下的 '2026-10-27'（7 月 32 日）经 JS 解析后
  //    **是有效日期**（实测 → 2026-10-27），本函数挡不住它 —— 只能靠数据清洗。
  //    此处**不写**「它应该返回 null」的断言：那是假期望，会让判据看起来比实际强。

  it('必不报：正常时刻必须留下（判据写反会在这里红）', () => {
    const d = new Date('2026-10-25T18:13:16.509+08:00');
    expect(saneTimeMs(d)).toBe(d.getTime());
    expect(saneTimeMs('2026-10-25T18:13:16.509+08:00')).toBe(d.getTime());
  });

  it('必不报：null / undefined / 空串判为不可用（不抛错）', () => {
    expect(saneTimeMs(null)).toBeNull();
    expect(saneTimeMs(undefined)).toBeNull();
    expect(saneTimeMs('')).toBeNull();
  });
});

describe('saneDurationMs', () => {
  it('必报：负数判为无效（不能当成 0 参与平均）', () => {
    expect(saneDurationMs(-1)).toBeNull();
  });

  it('必报：超过 24h 封顶（端上口径一致，防后台挂机污染统计）', () => {
    expect(saneDurationMs(25 * 60 * 60 * 1000)).toBe(24 * 60 * 60 * 1000);
  });

  it('必不报：正常毫秒原样返回', () => {
    expect(saneDurationMs(62740)).toBe(62740);
  });
});

describe('medianOf', () => {
  it('必报：奇数取正中', () => {
    expect(medianOf([3, 1, 2])).toBe(2);
  });

  it('必报：偶数取中间两个均值', () => {
    expect(medianOf([1, 2, 3, 4])).toBe(3); // (2+3)/2 = 2.5 → 四舍五入 3
  });

  it('必不报：空数组返回 0 而不是 NaN（NaN 会静默污染下游）', () => {
    expect(medianOf([])).toBe(0);
  });
});

describe('aggregatePageDuration', () => {
  const T = new Date('2026-10-25T10:00:00+08:00').getTime();
  const DAY = 24 * 60 * 60 * 1000;

  it('必报：小程序与 H5 的同一页必须合并成一行（visits=2）', () => {
    const r = aggregatePageDuration([
      { page: 'pages/index/index', durationMs: 1000, atMs: T },
      { page: '/pages/index/index', durationMs: 3000, atMs: T },
    ]);
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0].visits).toBe(2);
    expect(r.pages[0].avgMs).toBe(2000);
    expect(r.pages[0].maxMs).toBe(3000);
  });

  it('必报：share 的分母是**全部**访问次数，不是 TOP 行之和', () => {
    const r = aggregatePageDuration([
      { page: 'a', durationMs: 1, atMs: T },
      { page: 'b', durationMs: 1, atMs: T },
      { page: 'b', durationMs: 1, atMs: T },
      { page: 'b', durationMs: 1, atMs: T },
    ]);
    expect(r.pages[0].page).toBe('b');
    expect(r.pages[0].share).toBe(0.75);
    expect(r.summary.visits).toBe(4);
  });

  it('必报：分日按日期升序，且跨天不互相污染', () => {
    const r = aggregatePageDuration([
      { page: 'a', durationMs: 100, atMs: T + DAY },
      { page: 'a', durationMs: 200, atMs: T },
    ]);
    expect(r.daily.map((d) => d.date)).toEqual(['2026-10-25', '2026-10-26']);
    expect(r.daily[0].avgMs).toBe(200);
    expect(r.daily[1].avgMs).toBe(100);
  });

  it('必不报：空输入不抛错且全为 0（空视图比 500 好）', () => {
    const r = aggregatePageDuration([]);
    expect(r.pages).toEqual([]);
    expect(r.daily).toEqual([]);
    expect(r.summary).toEqual({ visits: 0, pageCount: 0, totalMs: 0, avgMs: 0 });
  });

  it('必不报：同访问次数时按累计停留降序（不留随机序）', () => {
    const r = aggregatePageDuration([
      { page: 'z', durationMs: 10, atMs: T },
      { page: 'a', durationMs: 99, atMs: T },
    ]);
    expect(r.pages.map((p) => p.page)).toEqual(['a', 'z']);
  });

  it('必报：空页面名的行不计入任何分桶（脏数据不产生幽灵页）', () => {
    const r = aggregatePageDuration([{ page: '', durationMs: 500, atMs: T }]);
    expect(r.pages).toHaveLength(0);
    expect(r.summary.visits).toBe(0);
  });
});

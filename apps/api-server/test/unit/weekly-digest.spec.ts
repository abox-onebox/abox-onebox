import { buildWeeklyDigest, type WeeklyDigestRow } from '../../src/common/utils/weekly-digest';

describe('buildWeeklyDigest', () => {
  it('空数据：total=0 且摘要包含「共沉淀 0 条」', () => {
    const r = buildWeeklyDigest([], '2026-11-02', '2026-11-08');
    expect(r.total).toBe(0);
    expect(r.byKind).toEqual({});
    expect(r.digest).toContain('共沉淀 0 条');
    expect(r.digest).toContain('2026-11-02 ~ 2026-11-08');
    // 空数据时不应出现「近期重点」段
    expect(r.digest).not.toContain('近期重点');
  });

  it('按类型与状态计数正确', () => {
    const rows: WeeklyDigestRow[] = [
      { kind: 'daily-report', status: 'open', title: 'A' },
      { kind: 'daily-report', status: 'adopted', title: 'B' },
      { kind: 'meal-proposal', status: 'open', title: 'C' },
      { kind: 'meal-proposal', status: 'open', title: 'D' },
    ];
    const r = buildWeeklyDigest(rows, '2026-11-02', '2026-11-08');
    expect(r.total).toBe(4);
    expect(r.byKind).toEqual({ 'daily-report': 2, 'meal-proposal': 2 });
    expect(r.byStatus).toEqual({ open: 3, adopted: 1 });
    // 状态段用中文
    expect(r.digest).toContain('已采纳：1');
    expect(r.digest).toContain('待看：3');
  });

  it('类型排序按数量降序', () => {
    const rows: WeeklyDigestRow[] = [
      { kind: 'a', status: 'open', title: '1' },
      { kind: 'a', status: 'open', title: '2' },
      { kind: 'a', status: 'open', title: '3' },
      { kind: 'b', status: 'open', title: '4' },
    ];
    const r = buildWeeklyDigest(rows, '2026-11-02', '2026-11-08');
    const idxA = r.digest.indexOf('· a：3');
    const idxB = r.digest.indexOf('· b：1');
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeLessThan(idxB);
  });

  it('近期重点只取前 8 条', () => {
    const rows: WeeklyDigestRow[] = Array.from({ length: 12 }, (_, i) => ({
      kind: 'k',
      status: 'open',
      title: `T${i}`,
    }));
    const r = buildWeeklyDigest(rows, '2026-11-02', '2026-11-08');
    expect(r.digest).toContain('· T0');
    expect(r.digest).toContain('· T7');
    expect(r.digest).not.toContain('· T8');
    expect(r.digest).not.toContain('· T11');
  });

  it('状态段跳过三态白名单外的 status，不报错', () => {
    const rows: WeeklyDigestRow[] = [{ kind: 'x', status: 'pending', title: 'P' }];
    const r = buildWeeklyDigest(rows, '2026-11-02', '2026-11-08');
    expect(r.total).toBe(1);
    expect(r.byKind).toEqual({ x: 1 });
    expect(r.digest).not.toContain('pending');
  });

  it('计数对空值兜底（status/title 缺失不抛错）', () => {
    const rows = [{ kind: 'k', status: undefined as never, title: undefined as never }];
    const r = buildWeeklyDigest(rows as WeeklyDigestRow[], '2026-11-02', '2026-11-08');
    expect(r.total).toBe(1);
    expect(r.byKind).toEqual({ k: 1 });
    expect(r.byStatus).toEqual({});
  });
});

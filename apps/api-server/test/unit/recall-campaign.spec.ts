import {
  classifyUsers,
  type ClassifyRow,
} from '../../src/modules/wecom-kb/recall-campaign.service';

const DAY = 86_400_000;

describe('classifyUsers · 复购 / 流失圈人', () => {
  const at = new Date('2026-11-04T00:00:00+08:00');

  it('复购客：累计有效订单 ≥ 2', () => {
    const rows: ClassifyRow[] = [{ userId: 1, cnt: 3, lastAt: at }];
    const r = classifyUsers(rows, at);
    expect(r.repurchase).toEqual([1]);
    expect(r.churn).toEqual([]);
  });

  it('流失客：至少 1 单且最近一单超过 14 天', () => {
    const rows: ClassifyRow[] = [{ userId: 2, cnt: 1, lastAt: new Date(at.getTime() - 20 * DAY) }];
    const r = classifyUsers(rows, at);
    expect(r.churn).toEqual([2]);
    expect(r.repurchase).toEqual([]);
  });

  it('沉寂的多买客：既算复购也算流失', () => {
    const rows: ClassifyRow[] = [{ userId: 3, cnt: 5, lastAt: new Date(at.getTime() - 30 * DAY) }];
    const r = classifyUsers(rows, at);
    expect(r.repurchase).toContain(3);
    expect(r.churn).toContain(3);
  });

  it('近 14 天内有单的 1 单用户：既不是复购也不是流失', () => {
    const rows: ClassifyRow[] = [{ userId: 4, cnt: 1, lastAt: new Date(at.getTime() - 3 * DAY) }];
    const r = classifyUsers(rows, at);
    expect(r.repurchase).toEqual([]);
    expect(r.churn).toEqual([]);
  });

  it('空数据：两端都空', () => {
    const r = classifyUsers([], at);
    expect(r.repurchase).toEqual([]);
    expect(r.churn).toEqual([]);
  });

  it('opts 可覆盖阈值', () => {
    const rows: ClassifyRow[] = [
      { userId: 5, cnt: 1, lastAt: new Date(at.getTime() - 5 * DAY) }, // 5 天前，churnDays=3 则流失
    ];
    const r = classifyUsers(rows, at, { churnDays: 3, repurchaseMin: 1 });
    expect(r.churn).toContain(5);
    expect(r.repurchase).toContain(5);
  });
});

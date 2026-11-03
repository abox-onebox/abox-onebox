/**
 * 节点 P 判据单测：社群靶楼分层
 * ------------------------------------------------------------------
 * 关键负控：**新上任的团长绝不能进「沉默」档**。
 * 一旦判错，群里会去 @ 一个昨天才接手的人要单量——这种错发出去就没人再信这份排期。
 */

import {
  pickCommunityTargets,
  describeTargets,
  AMPLIFY_MIN_ORDERS,
} from '../../src/modules/wecom-kb/community-plan';
import type { LeaderHealthItem, LeaderBand } from '../../src/modules/wecom-kb/leader-health';

function item(over: Partial<LeaderHealthItem> = {}): LeaderHealthItem {
  return {
    leaderId: 1,
    buildingName: '量子大厦 A 座',
    groupName: null,
    level: 'formal',
    band: 'healthy' as LeaderBand,
    silentDays: 1,
    tenureDays: 60,
    monthOrders: 40,
    totalOrders: 200,
    invitedFormalCount: 0,
    blockers: [],
    gapToNextLevel: null,
    ...over,
  };
}

describe('pickCommunityTargets · 分档', () => {
  it('健康且本月达到放量门槛 ⇒ amplify', () => {
    const t = pickCommunityTargets([item({ monthOrders: AMPLIFY_MIN_ORDERS })]);
    expect(t.totals.amplify).toBe(1);
    expect(t.amplify[0].tier).toBe('amplify');
  });

  it('健康但差一单到门槛 ⇒ steady（边界不能写成 >）', () => {
    const t = pickCommunityTargets([item({ monthOrders: AMPLIFY_MIN_ORDERS - 1 })]);
    expect(t.totals.amplify).toBe(0);
    expect(t.steady[0].tier).toBe('steady');
  });

  it('待唤醒 ⇒ wake', () => {
    const t = pickCommunityTargets([item({ band: 'watch', silentDays: 10, monthOrders: 5 })]);
    expect(t.totals.wake).toBe(1);
    expect(t.wake[0].tier).toBe('wake');
  });

  it('沉睡与从未出单 ⇒ silent', () => {
    const t = pickCommunityTargets([
      item({ band: 'dormant', silentDays: 40, monthOrders: 0 }),
      item({ band: 'never', silentDays: null, monthOrders: 0, totalOrders: 0 }),
    ]);
    expect(t.totals.silent).toBe(2);
  });

  it('★新上任即使 0 单也归 steady，绝不进 silent（负控）', () => {
    const t = pickCommunityTargets([
      item({ band: 'new', tenureDays: 2, silentDays: null, monthOrders: 0, totalOrders: 0 }),
    ]);
    expect(t.totals.silent).toBe(0);
    expect(t.totals.steady).toBe(1);
    expect(t.newCount).toBe(1);
    expect(t.steady[0].tier).toBe('steady');
  });
});

describe('pickCommunityTargets · 排序与重点', () => {
  it('放量档按本月单量降序，focus 取前 3', () => {
    const t = pickCommunityTargets([
      item({ leaderId: 1, monthOrders: 50 }),
      item({ leaderId: 2, monthOrders: 90 }),
      item({ leaderId: 3, monthOrders: 70 }),
      item({ leaderId: 4, monthOrders: 35 }),
    ]);
    expect(t.amplify.map((x) => x.leaderId)).toEqual([2, 3, 1, 4]);
    expect(t.focus.map((x) => x.leaderId)).toEqual([2, 3, 1]);
  });

  it('mustWake 只取「历史有量」的沉默楼，按累计单量降序', () => {
    const t = pickCommunityTargets([
      item({ leaderId: 9, band: 'never', monthOrders: 0, totalOrders: 0, silentDays: null }),
      item({ leaderId: 8, band: 'dormant', monthOrders: 0, totalOrders: 88, silentDays: 34 }),
      item({ leaderId: 7, band: 'dormant', monthOrders: 0, totalOrders: 14, silentDays: 96 }),
    ]);
    expect(t.mustWake.map((x) => x.leaderId)).toEqual([8, 7]);
  });

  it('唤醒档按沉默天数降序（越久越急）', () => {
    const t = pickCommunityTargets([
      item({ leaderId: 1, band: 'watch', silentDays: 8 }),
      item({ leaderId: 2, band: 'watch', silentDays: 13 }),
    ]);
    expect(t.wake.map((x) => x.leaderId)).toEqual([2, 1]);
  });

  it('空输入不炸', () => {
    const t = pickCommunityTargets([]);
    expect(t.totals).toEqual({ amplify: 0, steady: 0, wake: 0, silent: 0 });
    expect(t.focus).toEqual([]);
    expect(t.mustWake).toEqual([]);
  });
});

describe('describeTargets', () => {
  it('只说楼栋与单量，不带姓名/手机号', () => {
    const t = pickCommunityTargets([item({ buildingName: '量子大厦 A 座', monthOrders: 45 })]);
    const txt = describeTargets(t);
    expect(txt).toContain('量子大厦 A 座');
    expect(txt).toContain('45 单');
    expect(txt).not.toMatch(/1[3-9]\d{9}/);
  });

  it('没有楼名时退化为「团#id」指代', () => {
    const t = pickCommunityTargets([item({ leaderId: 42, buildingName: null })]);
    expect(describeTargets(t)).toContain('团#42');
  });
});

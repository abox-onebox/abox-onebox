import {
  judgeLeader,
  nextLevelGap,
  parseTime,
  summarizeLeaderHealth,
  describeLeader,
  NEW_LEADER_DAYS,
  HEALTHY_DAYS,
  WATCH_DAYS,
  type LeaderHealthRow,
} from '../../src/modules/wecom-kb/leader-health';

/**
 * 团长健康度分档判据
 *
 * 最要紧的两条负控：
 *   ① 新团长必须判 `new`，**绝不能**因为 0 单被算成沉睡（假警报会让报告失信）；
 *   ② 卡点只在字段**明确为 false / 空**时判定 —— `payoutBound: undefined`
 *      （服务端没给这个字段）不等于「没绑收款」，那是两回事。
 */

const NOW = new Date('2026-11-03T12:00:00+08:00').getTime();
const daysAgo = (n: number): string =>
  new Date(NOW - n * 86400000).toISOString().replace('Z', '+00:00');

function row(over: Partial<LeaderHealthRow> = {}): LeaderHealthRow {
  return {
    id: 1,
    buildingId: 10,
    buildingName: '量子大厦 A 座',
    groupName: '量子大厦',
    level: 'formal',
    status: 1,
    monthOrders: 40,
    totalOrders: 320,
    invitedFormalCount: 1,
    lastOrderAt: daysAgo(2),
    payoutBound: true,
    agreeVersion: 'v1.1',
    createdAt: daysAgo(200),
    ...over,
  };
}

describe('parseTime', () => {
  it('吃两种格式：ISO 带 T、MySQL 用空格', () => {
    expect(parseTime('2026-11-01T10:00:00+08:00')).not.toBeNull();
    expect(parseTime('2026-11-01 10:00:00')).not.toBeNull();
  });

  it('空值/垃圾串一律 null（不许变成 NaN 混进天数计算）', () => {
    expect(parseTime(null)).toBeNull();
    expect(parseTime(undefined)).toBeNull();
    expect(parseTime('不是时间')).toBeNull();
  });
});

describe('judgeLeader 分档', () => {
  it('2 天前出过单 = 健康', () => {
    expect(judgeLeader(row({ lastOrderAt: daysAgo(2) }), NOW).band).toBe('healthy');
  });

  it(`边界：${HEALTHY_DAYS} 天仍在健康档，${HEALTHY_DAYS + 1} 天进待唤醒`, () => {
    expect(judgeLeader(row({ lastOrderAt: daysAgo(HEALTHY_DAYS) }), NOW).band).toBe('healthy');
    expect(judgeLeader(row({ lastOrderAt: daysAgo(HEALTHY_DAYS + 1) }), NOW).band).toBe('watch');
  });

  it(`边界：${WATCH_DAYS} 天仍是待唤醒，${WATCH_DAYS + 1} 天算沉睡`, () => {
    expect(judgeLeader(row({ lastOrderAt: daysAgo(WATCH_DAYS) }), NOW).band).toBe('watch');
    expect(judgeLeader(row({ lastOrderAt: daysAgo(WATCH_DAYS + 1) }), NOW).band).toBe('dormant');
  });

  it('★新团长：上任 3 天 + 0 单，必须判 new，不能算沉睡', () => {
    const it = judgeLeader(
      row({ createdAt: daysAgo(3), lastOrderAt: null, monthOrders: 0, totalOrders: 0 }),
      NOW,
    );
    expect(it.band).toBe('new');
    expect(it.silentDays).toBeNull();
  });

  it(`★上任正好 ${NEW_LEADER_DAYS} 天开始参与流失判定`, () => {
    const it = judgeLeader(
      row({ createdAt: daysAgo(NEW_LEADER_DAYS), lastOrderAt: daysAgo(30) }),
      NOW,
    );
    expect(it.band).toBe('dormant');
  });

  it('有任职但从未出单 = never（不是 healthy，也不能 silenceDays=0）', () => {
    const it = judgeLeader(row({ createdAt: daysAgo(60), lastOrderAt: null }), NOW);
    expect(it.band).toBe('never');
    expect(it.silentDays).toBeNull();
  });

  it('上任时间未知时不误判成新团长（按出单情况照常分档）', () => {
    const it = judgeLeader(row({ createdAt: null, lastOrderAt: daysAgo(40) }), NOW);
    expect(it.band).toBe('dormant');
    expect(it.tenureDays).toBeNull();
  });
});

describe('judgeLeader 卡点', () => {
  it('未绑收款 = payout_unbound', () => {
    expect(judgeLeader(row({ payoutBound: false }), NOW).blockers).toContain('payout_unbound');
  });

  it('★字段缺失（undefined）不等于「没绑」——不许误报卡点', () => {
    const it = judgeLeader(row({ payoutBound: undefined }), NOW);
    expect(it.blockers).not.toContain('payout_unbound');
  });

  it('协议版本为空 = 待补签；有版本号则无此卡点', () => {
    expect(judgeLeader(row({ agreeVersion: null }), NOW).blockers).toContain('agreement_stale');
    expect(judgeLeader(row({ agreeVersion: '  ' }), NOW).blockers).toContain('agreement_stale');
    expect(judgeLeader(row({ agreeVersion: 'v1.1' }), NOW).blockers).not.toContain(
      'agreement_stale',
    );
  });

  it('卡点与活跃度正交：沉睡且未绑收款，两条都在', () => {
    const it = judgeLeader(
      row({ lastOrderAt: daysAgo(40), payoutBound: false, agreeVersion: null }),
      NOW,
    );
    expect(it.band).toBe('dormant');
    expect(it.blockers).toEqual(['payout_unbound', 'agreement_stale']);
  });
});

describe('nextLevelGap', () => {
  it('见习 → 正式：门槛取 LEADER_LEVEL_META（30 单 / 1 人）', () => {
    expect(nextLevelGap('trainee', 10, 0)).toEqual({ level: 'formal', orders: 20, referrals: 1 });
  });

  it('已达标时差值为 0，不出负数', () => {
    expect(nextLevelGap('trainee', 99, 5)).toEqual({ level: 'formal', orders: 0, referrals: 0 });
  });

  it('首席已是顶级 → null；等级认不出也 → null（不猜）', () => {
    expect(nextLevelGap('chief', 200, 5)).toBeNull();
    expect(nextLevelGap('unknown', 10, 0)).toBeNull();
    expect(nextLevelGap(null, 10, 0)).toBeNull();
  });
});

describe('summarizeLeaderHealth', () => {
  const rows: LeaderHealthRow[] = [
    row({ id: 1, buildingName: 'A 座', lastOrderAt: daysAgo(1) }), // healthy
    row({ id: 2, buildingName: 'B 座', lastOrderAt: daysAgo(10) }), // watch
    row({ id: 3, buildingName: 'C 座', lastOrderAt: daysAgo(40), monthOrders: 0 }), // dormant
    row({ id: 4, buildingName: 'D 座', createdAt: daysAgo(2), monthOrders: 0 }), // new
    row({ id: 5, buildingName: 'E 座', createdAt: daysAgo(90), lastOrderAt: null }), // never
    row({
      id: 6,
      buildingName: 'F 座',
      lastOrderAt: daysAgo(50),
      payoutBound: false,
      monthOrders: 5,
    }), // dormant + 卡点
  ];

  it('分档计数与总人数对得上', () => {
    const { totals } = summarizeLeaderHealth(rows, NOW);
    expect(totals.total).toBe(6);
    expect(totals.byBand).toEqual({ new: 1, healthy: 1, watch: 1, dormant: 2, never: 1 });
    expect(
      totals.byBand.new +
        totals.byBand.healthy +
        totals.byBand.watch +
        totals.byBand.dormant +
        totals.byBand.never,
    ).toBe(totals.total);
  });

  it('卡点计数只数明确未绑的人', () => {
    expect(summarizeLeaderHealth(rows, NOW).totals.payoutUnbound).toBe(1);
    expect(summarizeLeaderHealth(rows, NOW).totals.agreementStale).toBe(0);
  });

  it('「沉睡且卡点」= 最该先打电话的人', () => {
    expect(summarizeLeaderHealth(rows, NOW).totals.blockedAndSilent).toBe(1);
  });

  it('本月单量分档合计等于人数', () => {
    const b = summarizeLeaderHealth(rows, NOW).totals.orderBuckets;
    expect(b['0'] + b['1-20'] + b['21-60'] + b['61-100'] + b['100+']).toBe(6);
    expect(b['21-60']).toBe(3);
  });

  it('空名单不崩（新项目第一天就是这个形态）', () => {
    const r = summarizeLeaderHealth([], NOW);
    expect(r.totals.total).toBe(0);
    expect(r.items).toEqual([]);
  });
});

describe('describeLeader', () => {
  it('只出楼栋 + 团长#id，不出姓名/手机号', () => {
    const it = judgeLeader(row({ id: 7, buildingName: '量子大厦 A 座' }), NOW);
    const text = describeLeader(it);
    expect(text).toContain('量子大厦 A 座');
    expect(text).toContain('团长#7');
    expect(text).not.toContain('@');
  });

  it('卡点与晋级差距都转成人话', () => {
    const it = judgeLeader(
      row({ level: 'trainee', monthOrders: 12, invitedFormalCount: 0, payoutBound: false }),
      NOW,
    );
    const text = describeLeader(it);
    expect(text).toContain('未绑收款');
    expect(text).toContain('差 18 单 / 1 人');
  });
});

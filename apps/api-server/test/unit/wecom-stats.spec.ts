/**
 * 统计口径问答 · 纯函数单测
 *
 * ⚠️ 本文件的两条写法纪律（不是风格偏好，是踩过的坑）：
 *
 *   ① **每条「不该出现」的断言，都要配一条「该出现」的正控**。
 *      只写 `expect(text).not.toContain('退款')` 有个致命问题：把整个格式化函数改成
 *      `return ''`（或者它恒返回 null 被 `!` 断言成 undefined 而报错）时，
 *      这条断言在某些写法下**照样通过** —— 恒假的检查等于没有检查。
 *      故每个负控都紧跟一个「同样的输入但字段齐全 ⇒ 该出现」的正控。
 *
 *   ② **金额/比率用真实出参形状断言，不用手算的期望值糊过去**。
 *      `gmvFen: 1234567` 必须显示成 `¥12,345.67`：分→元、千分位、两位小数，
 *      三件事任何一件错了都会让老板对着账本对不上数。
 */

import {
  addDays,
  bjTodayStr,
  daysOf,
  endDateOf,
  parseStatsIntent,
  prevEndDateOf,
} from '../../src/modules/wecom-kb/stats-intent';
import {
  ALERT_BUILDING_DROP,
  ALERT_MIN_GMV_FEN,
  ALERT_REFUND_RATE,
  compareDashboard,
  fmtChange,
  fmtInt,
  fmtMs,
  fmtPct,
  fmtPp,
  fmtYuan,
  summarizeBuildingRank,
  summarizeDashboard,
  summarizeDishHeat,
  summarizePageDuration,
  summarizeRetention,
} from '../../src/modules/wecom-kb/stats-summary';

/* ------------------------------------------------------------------ *
 * 夹具（形状照抄 `stats.service.ts` 的出参类型，不凭印象）
 * ------------------------------------------------------------------ */

const RANGE_7D = {
  range: '7d',
  label: '近 7 日',
  startDate: '2026-10-26',
  endDate: '2026-11-01',
  days: 7,
};

function dash(over: Record<string, unknown> = {}, warnings: string[] = []): unknown {
  return {
    range: RANGE_7D,
    metrics: {
      orderCount: 38,
      quantity: 42,
      gmvFen: 1234567,
      avgOrderAmountFen: 32489,
      avgUnitPriceFen: 29394,
      totalOrderCount: 40,
      pendingPayCount: 2,
      refundCount: 1,
      refundRate: 0.025,
      activeUserCount: 36,
      activeLeaderCount: 3,
      activeBuildingCount: 5,
      repeatUserCount: 9,
      repeatRate: 0.25,
      commissionFen: 98000,
      purchaseFen: 600000,
      fulfillmentFen: 0,
      grossProfitFen: 310000,
      grossProfitRate: 0.2511,
      ...over,
    },
    costRegistration: { allRegistered: true, missingLabels: [] },
    costItems: [],
    purchaseGenerated: true,
    trend: [],
    warnings,
  };
}

function rank(rows: Array<Record<string, unknown>>, totalGmvFen = 1234567): unknown {
  return { range: RANGE_7D, groups: [], buildings: rows, totalGmvFen };
}

/* ------------------------------------------------------------------ *
 * 格式化原语
 * ------------------------------------------------------------------ */

describe('格式化原语', () => {
  it('分 → 元：两位小数 + 千分位', () => {
    expect(fmtYuan(1234567)).toBe('¥12,345.67');
    expect(fmtYuan(0)).toBe('¥0.00');
    expect(fmtYuan(5)).toBe('¥0.05');
    expect(fmtYuan(-1234567)).toBe('-¥12,345.67');
  });

  it('比率 → 百分比；null 打 `—` 而不是 0%', () => {
    expect(fmtPct(0.025)).toBe('2.5%');
    expect(fmtPct(0.2511)).toBe('25.1%');
    expect(fmtPct(null)).toBe('—');
    // 正控：0 是真实值，必须显示 0.0% 而不是 `—`
    expect(fmtPct(0)).toBe('0.0%');
  });

  it('变化率：涨/跌/持平/上期为 0', () => {
    expect(fmtChange(1234567, 1000000)).toBe('涨 23.5%');
    expect(fmtChange(800000, 1000000)).toBe('跌 20.0%');
    expect(fmtChange(1000000, 1000000)).toBe('持平');
    expect(fmtChange(5000, 0)).toBe('上期为 0，无法算变化');
    expect(fmtChange(0, 0)).toBe('持平');
  });

  it('百分点差（两个比率的比较，不用相对变化表述）', () => {
    expect(fmtPp(0.034, 0.026)).toBe('+0.8 个百分点');
    expect(fmtPp(0.02, 0.026)).toBe('-0.6 个百分点');
    expect(fmtPp(0.026, 0.026)).toBe('持平');
    expect(fmtPp(null, 0.026)).toBe('—');
  });

  it('毫秒 → 人话', () => {
    expect(fmtMs(820)).toBe('820 毫秒');
    expect(fmtMs(42300)).toBe('42.3 秒');
    expect(fmtMs(492000)).toBe('8 分 12 秒');
  });

  it('整数千分位', () => {
    expect(fmtInt(1234)).toBe('1,234');
    expect(fmtInt(0)).toBe('0');
  });
});

/* ------------------------------------------------------------------ *
 * 意图识别
 * ------------------------------------------------------------------ */

describe('统计问句识别', () => {
  it('五个视角各自认得出', () => {
    expect(parseStatsIntent('经营情况')?.which).toBe('dashboard');
    expect(parseStatsIntent('楼栋排行')?.which).toBe('buildingRank');
    expect(parseStatsIntent('菜品热度')?.which).toBe('dishHeat');
    expect(parseStatsIntent('留存怎么样')?.which).toBe('retention');
    expect(parseStatsIntent('页面停留')?.which).toBe('pageDuration');
  });

  it('档位：默认 7 天且截至昨天', () => {
    const it = parseStatsIntent('经营情况')!;
    expect(it.range).toBe('7d');
    expect(it.endShift).toBe(-1);
  });

  it('「今天」档含今天，「昨天」档是单日回退一天', () => {
    const today = parseStatsIntent('今天经营数据')!;
    expect(today.range).toBe('today');
    expect(today.endShift).toBe(0);

    const yest = parseStatsIntent('昨天的经营数据')!;
    expect(yest.range).toBe('today');
    // ⭐ 这一条是回归：曾把「昨天」当废话，档位仍取默认 7d ⇒ 给近 7 天的数却说是昨天
    expect(yest.endShift).toBe(-1);
  });

  it('30 天档', () => {
    expect(parseStatsIntent('近30天经营情况')!.range).toBe('30d');
    expect(parseStatsIntent('本月经营数据')!.range).toBe('30d');
  });

  it('不认的说法一律返回 null（宁可漏认，不可错认）', () => {
    // 「楼栋」单独出现不是问排行：这是运维操作
    expect(parseStatsIntent('楼栋停用')).toBeNull();
    expect(parseStatsIntent('给量子大厦排套餐')).toBeNull();
    expect(parseStatsIntent('今天多少单')).toBeNull();
    expect(parseStatsIntent('操作目录')).toBeNull();
    expect(parseStatsIntent('取消')).toBeNull();
    expect(parseStatsIntent('')).toBeNull();
  });

  it('正控：「楼栋」带排行语义时才认', () => {
    expect(parseStatsIntent('楼栋排行')?.which).toBe('buildingRank');
    expect(parseStatsIntent('哪个楼卖得好')?.which).toBe('buildingRank');
  });
});

/* ------------------------------------------------------------------ *
 * 日期运算（纯日历，不受时区影响）
 * ------------------------------------------------------------------ */

describe('日期运算', () => {
  it('加减天：跨月 / 跨年 / 二月', () => {
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-11-01', -7)).toBe('2026-10-25');
  });

  it('档位天数', () => {
    expect(daysOf('today')).toBe(1);
    expect(daysOf('7d')).toBe(7);
    expect(daysOf('30d')).toBe(30);
  });

  it('本期终点按 endShift 算，上期终点整平移一个档位且不重叠', () => {
    const it = { which: 'dashboard' as const, range: '7d' as const, endShift: -1 };
    const end = endDateOf(it, '2026-11-02');
    expect(end).toBe('2026-11-01');
    // 本期 [10-26, 11-01] ⇒ 上期 [10-19, 10-25]，终点 10-25
    expect(prevEndDateOf(it, end)).toBe('2026-10-25');
  });

  it('北京今天：取 +08:00 平移后的日历日（UTC 16:30 = 北京次日 00:30）', () => {
    expect(bjTodayStr(new Date('2026-11-01T16:30:00Z'))).toBe('2026-11-02');
    // 正控：同一 UTC 日的早些时候仍是北京同一天
    expect(bjTodayStr(new Date('2026-11-01T02:00:00Z'))).toBe('2026-11-01');
  });
});

/* ------------------------------------------------------------------ *
 * D47 经营数据
 * ------------------------------------------------------------------ */

describe('经营数据 · 说人话', () => {
  it('核心四项逐字对上（分→元、千分位、单量、区间）', () => {
    const text = summarizeDashboard(dash())!;
    expect(text).toContain('10-26 ~ 11-01');
    expect(text).toContain('GMV ¥12,345.67');
    expect(text).toContain('38 单');
    expect(text).toContain('42 份');
    expect(text).toContain('客单价 ¥324.89');
  });

  it('退款率与复购率按百分比显示', () => {
    const text = summarizeDashboard(dash())!;
    expect(text).toContain('退款 1 单（2.5%）');
    expect(text).toContain('复购 9 人（25.0%）');
  });

  it('缺字段就不说那个数（绝不补 0）', () => {
    const text = summarizeDashboard(dash({ refundCount: undefined, refundRate: undefined }))!;
    expect(text).not.toContain('退款');
    // 正控：字段齐全时确实会出现「退款」—— 证明上一条的 not 不是恒真
    expect(summarizeDashboard(dash())!).toContain('退款');
  });

  it('未支付为 0 时不占一行（0 没有信息量）', () => {
    const text = summarizeDashboard(dash({ pendingPayCount: 0 }))!;
    expect(text).not.toContain('未支付');
    // 正控：2 单时会出现
    expect(summarizeDashboard(dash())!).toContain('未支付 2 单');
  });

  it('grossProfitRate 为 null（GMV 为 0 时 ratio 返回 null）⇒ 只报毛利额，不报假的 0%', () => {
    const text = summarizeDashboard(dash({ grossProfitRate: null }))!;
    expect(text).toContain('毛利 ¥3,100.00');
    expect(text).not.toContain('毛利 ¥3,100.00（');
    // 正控：有比率时带括号
    expect(summarizeDashboard(dash())!).toContain('毛利 ¥3,100.00（25.1%）');
  });

  it('warnings 必须逐条转述（毛利虚高不说是最危险的一种漏报）', () => {
    const w = ['履约成本三项未登记（场地 / 打包 / 配送），毛利仅为上限值'];
    const text = summarizeDashboard(dash({}, w))!;
    expect(text).toContain('注意：');
    expect(text).toContain('毛利仅为上限值');
  });

  it('结构不认识 ⇒ 返回 null（让调用方说「我看不懂」，而不是编一段数字）', () => {
    expect(summarizeDashboard(null)).toBeNull();
    expect(summarizeDashboard({})).toBeNull();
    expect(summarizeDashboard({ range: RANGE_7D })).toBeNull();
    // 两个核心数都取不到才算不认识
    expect(summarizeDashboard({ range: RANGE_7D, metrics: {} })).toBeNull();
    // 正控：只给一个核心数也算认识（照样能说）
    expect(summarizeDashboard({ range: RANGE_7D, metrics: { orderCount: 5 } })).toContain('5 单');
  });
});

/* ------------------------------------------------------------------ *
 * 环比与预警
 * ------------------------------------------------------------------ */

describe('环比与阈值预警', () => {
  it('GMV 涨跌与差额', () => {
    const cur = dash();
    const prev = dash({ gmvFen: 1000000 });
    const lines = compareDashboard(cur, prev).join('\n');
    expect(lines).toContain('GMV 涨 23.5%');
    expect(lines).toContain('+¥2,345.67');
  });

  it('退款率超 5% 警戒线要点名', () => {
    const cur = dash({ refundRate: 0.062, refundCount: 3 });
    const lines = compareDashboard(cur, dash()).join('\n');
    expect(lines).toContain('【要注意】');
    expect(lines).toContain('退款率 6.2%');
    expect(lines).toContain(fmtPct(ALERT_REFUND_RATE, 0));
  });

  it('退款率未超线时不报警（避免「一切正常」占注意力）', () => {
    const cur = dash({ refundRate: 0.031 });
    const lines = compareDashboard(cur, dash()).join('\n');
    expect(lines).not.toContain('【要注意】');
    // 正控：同样结构下改成超线值就会出现
    expect(compareDashboard(dash({ refundRate: 0.09 }), dash()).join('\n')).toContain('【要注意】');
  });

  it('GMV 环比跌超 20% 要点名', () => {
    const cur = dash({ gmvFen: 700000 });
    const prev = dash({ gmvFen: 1000000 });
    const lines = compareDashboard(cur, prev).join('\n');
    expect(lines).toContain('GMV 环比跌 30.0%');
  });

  it('毛利为负要点名', () => {
    const lines = compareDashboard(dash({ grossProfitFen: -5000 }), dash()).join('\n');
    expect(lines).toContain('毛利为负');
  });

  it('上期为 0 时说「本期多少 / 上一档为 0」，不说「无法算变化」', () => {
    const cur = dash();
    const prev = dash({ gmvFen: 0, orderCount: 0, grossProfitFen: 0 });
    const lines = compareDashboard(cur, prev).join('\n');
    // 线上实测原话是「GMV 上期为 0，无法算变化（+¥567.60）」—— 既没回答问题又多塞个数字
    expect(lines).toContain('GMV 本期 ¥12,345.67（上一档为 0）');
    expect(lines).toContain('单量 0 → 38 单');
    expect(lines).not.toContain('无法算变化');
  });

  it('上期结构不认识 ⇒ 空数组（宁可不给，不给错）', () => {
    expect(compareDashboard(dash(), {})).toEqual([]);
    expect(compareDashboard({}, dash())).toEqual([]);
    // 正控：两边都正常时确实有内容
    expect(compareDashboard(dash(), dash()).length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * D48 楼栋排行
 * ------------------------------------------------------------------ */

describe('楼栋排行', () => {
  const cur = rank([
    { id: 1, name: '量子大厦 A 座', orderCount: 32, quantity: 34, gmvFen: 412000, gmvShare: 0.334 },
    { id: 2, name: '量子大厦 B 座', orderCount: 20, quantity: 21, gmvFen: 300000, gmvShare: 0.243 },
  ]);

  it('出榜：名次 / 金额 / 单量 / 占比 / 合计', () => {
    const text = summarizeBuildingRank(cur, null)!;
    expect(text).toContain('楼栋排行');
    expect(text).toContain('1. 量子大厦 A 座');
    expect(text).toContain('¥4,120.00');
    expect(text).toContain('33.4%');
    expect(text).toContain('合计 ¥12,345.67');
  });

  it('跌幅超 30% 且基数够 ⇒ 点名一栋', () => {
    const prev = rank([
      { id: 1, name: '量子大厦 A 座', orderCount: 55, quantity: 58, gmvFen: 712000, gmvShare: 0.5 },
      {
        id: 2,
        name: '量子大厦 B 座',
        orderCount: 20,
        quantity: 21,
        gmvFen: 300000,
        gmvShare: 0.24,
      },
    ]);
    const text = summarizeBuildingRank(cur, prev)!;
    expect(text).toContain('【要注意】量子大厦 A 座');
    expect(text).toContain('跌 42.1%');
    expect(text).toContain('¥7,120.00 → ¥4,120.00');
  });

  it('基数太小不点名（比例再大也只是噪声）', () => {
    // 上期 ¥400（低于 ¥500 门槛）→ ¥50，跌 87.5% 也不该占注意力
    const prev = rank([
      {
        id: 1,
        name: '量子大厦 A 座',
        orderCount: 1,
        quantity: 1,
        gmvFen: ALERT_MIN_GMV_FEN - 10000,
        gmvShare: 0.1,
      },
    ]);
    const small = rank([
      { id: 1, name: '量子大厦 A 座', orderCount: 1, quantity: 1, gmvFen: 5000, gmvShare: 0.01 },
    ]);
    const text = summarizeBuildingRank(small, prev)!;
    expect(text).not.toContain('【要注意】');
    // 正控：同一栋把上期基数提到门槛之上，点名就会出现
    const big = rank([
      {
        id: 1,
        name: '量子大厦 A 座',
        orderCount: 1,
        quantity: 1,
        gmvFen: ALERT_MIN_GMV_FEN * 10,
        gmvShare: 0.4,
      },
    ]);
    expect(summarizeBuildingRank(small, big)!).toContain('【要注意】');
  });

  it('跌幅未到警戒线（30%）不点名', () => {
    const prev = rank([
      { id: 1, name: '量子大厦 A 座', orderCount: 40, quantity: 42, gmvFen: 500000, gmvShare: 0.4 },
    ]);
    // 500000 → 412000 跌 17.6%，低于 30%
    expect(summarizeBuildingRank(cur, prev)!).not.toContain('【要注意】');
  });

  it('有楼栋就优先出楼栋（不回落到楼群）', () => {
    const mixed = {
      range: RANGE_7D,
      groups: [{ id: 9, name: '量子楼群', orderCount: 1, quantity: 1, gmvFen: 1, gmvShare: 1 }],
      buildings: [{ id: 1, name: '某栋', orderCount: 1, quantity: 1, gmvFen: 100, gmvShare: 1 }],
      totalGmvFen: 100,
    };
    const text = summarizeBuildingRank(mixed, null)!;
    expect(text).toContain('楼栋排行');
    expect(text).not.toContain('量子楼群');
  });

  it('空榜 ⇒ null', () => {
    expect(summarizeBuildingRank(rank([]), null)).toBeNull();
    expect(summarizeBuildingRank({}, null)).toBeNull();
  });

  it('`ALERT_BUILDING_DROP` 是 30%：17.6% 不报、42.1% 报（阈值改动会连带这里红）', () => {
    expect(ALERT_BUILDING_DROP).toBe(0.3);
  });
});

/* ------------------------------------------------------------------ *
 * D49 / D50 / D77
 * ------------------------------------------------------------------ */

describe('菜品热度', () => {
  const heat = {
    range: RANGE_7D,
    topN: 2,
    items: [
      {
        itemId: 1,
        itemName: '宫保鸡丁',
        supplierId: 1,
        supplierName: 'A 供应商',
        quantity: 42,
        orderCount: 38,
        share: 0.123,
      },
      {
        itemId: 2,
        itemName: '红烧肉',
        supplierId: 1,
        supplierName: 'A 供应商',
        quantity: 30,
        orderCount: 28,
        share: 0.088,
      },
    ],
    totalQuantity: 342,
    itemCount: 18,
  };

  it('TOP 榜 + 分母说明', () => {
    const text = summarizeDishHeat(heat)!;
    expect(text).toContain('1. 宫保鸡丁');
    expect(text).toContain('42 份');
    expect(text).toContain('12.3%');
    expect(text).toContain('区间共 342 份');
    expect(text).toContain('涉及 18 个商品');
  });

  it('空列表 ⇒ null', () => {
    expect(summarizeDishHeat({ range: RANGE_7D, items: [] })).toBeNull();
  });
});

describe('留存', () => {
  const ret = {
    range: RANGE_7D,
    summary: {
      activeUserCount: 36,
      newUserCount: 12,
      returningUserCount: 8,
      repeatUserCount: 9,
      repeatRate: 0.25,
    },
    cohorts: [
      {
        cohortStart: '2026-10-12',
        cohortEnd: '2026-10-18',
        newUserCount: 15,
        retainedWeek1: 6,
        retentionRate1: 0.4,
        observable: true,
      },
      {
        cohortStart: '2026-10-26',
        cohortEnd: '2026-11-01',
        newUserCount: 12,
        retainedWeek1: null,
        retentionRate1: null,
        observable: false,
      },
    ],
    note: '',
  };

  it('汇总四项 + 分群', () => {
    const text = summarizeRetention(ret)!;
    expect(text).toContain('活跃 36 人');
    expect(text).toContain('新客 12');
    expect(text).toContain('复购 9 人（25.0%）');
    expect(text).toContain('次周留 40.0%');
  });

  it('观察窗口未走完 ⇒ 不给留存率（低留存只是数据还没长出来）', () => {
    const text = summarizeRetention(ret)!;
    expect(text).toContain('观察窗口未走完');
    // 正控：走完的那一群确实给了数
    expect(text).toContain('40.0%');
  });

  it('结构不认识 ⇒ null', () => {
    expect(summarizeRetention({ range: RANGE_7D })).toBeNull();
  });
});

describe('页面停留', () => {
  const pd = {
    range: RANGE_7D,
    anchor: 'visitedAt',
    anchorLabel: '访问日',
    pages: [
      {
        page: 'pages/home/index',
        visits: 320,
        totalMs: 17600000,
        avgMs: 55000,
        medianMs: 42000,
        maxMs: 600000,
        share: 0.26,
      },
    ],
    daily: [],
    summary: { visits: 1234, pageCount: 12, totalMs: 52000000, avgMs: 42300 },
    droppedRows: 0,
    note: '',
  };

  it('汇总 + 单页 + 匿名口径说明', () => {
    const text = summarizePageDuration(pd)!;
    expect(text).toContain('1,234 次访问');
    expect(text).toContain('12 个页面');
    expect(text).toContain('平均停留 42.3 秒');
    expect(text).toContain('pages/home/index');
    // ⚠️ 匿名口径必须说出来，否则「1234 次访问」会被读成「1234 个人」
    expect(text).toContain('没有独立访客数');
  });

  it('结构不认识 ⇒ null', () => {
    expect(summarizePageDuration({ range: RANGE_7D })).toBeNull();
  });
});

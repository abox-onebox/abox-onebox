/**
 * 出参摘要说人话（`result-summary` / `result-fmt` / `result-directed`）
 *
 * 夹具全部照**线上真实响应**（2026-11-02 抓的 31 个样本）裁剪而来，
 * 不是照 DTO 猜的形状 —— 本项目已多次因为「按印象写探针」得到假绿/假红。
 *
 * 三条主线：
 *   ① 形态识别：分页信封（含缺 `total` 的）/ 数组 / 单对象；
 *   ② 念得对：金额分→元、状态用人话版、订单行按业务顺序；
 *   ③ 念不漏：`passwordHash` 这类字段**永远不许**出现（企微消息永久留痕）。
 */

import { summarizeData } from '../../src/modules/wecom-kb/result-summary';
import { DIRECTED_CODES } from '../../src/modules/wecom-kb/result-directed';

/** 线上 `/admin/orders` 的一行（裁到摘要用得到的字段） */
function orderRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderNo: 'AB2026102802850288',
    mealDate: '2026-10-29',
    status: 'completed',
    statusText: '已完成',
    quantity: 2,
    unitPriceFen: 2580,
    totalAmountFen: 5160,
    payAmountFen: 5160,
    userName: '李明',
    phoneMasked: '186****0001',
    buildingName: '国贸三期 A 座',
    groupName: '国贸三期组',
    setMealName: 'ABox 零食盒 · 良品铺子/卫龙/伊利',
    ...over,
  };
}

describe('形态识别', () => {
  it('分页信封：念「共 N 条」+ 前 3 条 + 合计', () => {
    const out = summarizeData(
      {
        list: [
          orderRow(),
          orderRow({ orderNo: 'AB2' }),
          orderRow({ orderNo: 'AB3' }),
          orderRow({ orderNo: 'AB4' }),
        ],
        page: 1,
        pageSize: 20,
        total: 98,
        hasMore: true,
        summary: {
          totalCount: 98,
          validCount: 21,
          validQuantity: 22,
          validAmountFen: 56760,
          abnormalCount: 0,
        },
      },
      'get_admin_orders',
    );
    expect(out).toContain('共 98 条（这页 4 条）');
    expect(out).toContain('合计：有效单数 21 · 有效份数 22 · 有效金额 ¥567.60 · 异常 0');
    expect(out).toContain('还有 1 条');
    // `totalCount` 与「共 N 条」是同一件事，不许念两遍
    expect(out).not.toContain('总计');
  });

  it('⭐ 缺 `total` 的分页仍按列表念（线上 deliveries/op-blocklist/schedule/system-roles 都没有 total）', () => {
    const out = summarizeData(
      { list: [{ name: '三味屋' }, { name: '四季鲜蔬' }] },
      'get_admin_unknown_x',
    );
    expect(out).toContain('共 2 条');
    expect(out).toContain('名称 三味屋');
    // 掉进单对象分支的典型症状
    expect(out).not.toContain('后台返回了');
  });

  it('空列表：一句话说没有', () => {
    expect(summarizeData({ list: [], total: 0 }, 'x')).toContain('没有符合条件的记录');
    expect(summarizeData([], 'x')).toBe('没有记录。');
  });

  it('单个对象：只念白名单字段', () => {
    const out = summarizeData({
      ok: true,
      orderNo: 'AB1',
      statusText: '已完成',
      totalAmountFen: 2580,
    });
    expect(out).toContain('单号 AB1');
    expect(out).toContain('状态 已完成');
    expect(out).toContain('¥25.80');
  });

  it('只有 ok 的对象：不念 `ok= true` 这种机器话', () => {
    expect(summarizeData({ ok: true })).toBe('已执行。');
    expect(summarizeData({ ok: false })).toContain('没给原因');
  });

  it('null / 标量', () => {
    expect(summarizeData(null)).toContain('没有返回内容');
    expect(summarizeData('abc')).toBe('abc');
  });
});

describe('念得对', () => {
  it('金额：整数分 → ¥xx.xx（千分位）', () => {
    const out = summarizeData({ list: [{ name: 'A', balanceFen: 1234567 }], total: 1 });
    expect(out).toContain('¥12,345.67');
  });

  it('状态优先用人话版，不吐枚举名', () => {
    const out = summarizeData({
      list: [orderRow({ status: 'refund_applying', statusText: '退款中' })],
      total: 1,
    });
    expect(out).toContain('退款中');
    expect(out).not.toContain('refund_applying');
  });

  it('订单行按业务顺序念：出餐日 · 单号 · 客户 · 楼栋 · 楼组 · 状态 · 份数 · 金额', () => {
    const out = summarizeData({ list: [orderRow()], total: 1 }, 'get_admin_orders');
    const line = out.split('\n').find((l) => l.startsWith('1. ')) ?? '';
    const idx = (s: string) => line.indexOf(s);
    expect(idx('10-29')).toBeGreaterThan(-1);
    expect(idx('AB2026102802850288')).toBeGreaterThan(idx('10-29'));
    expect(idx('李明')).toBeGreaterThan(idx('AB2026102802850288'));
    expect(idx('国贸三期 A 座')).toBeGreaterThan(idx('李明'));
    expect(idx('已完成')).toBeGreaterThan(idx('国贸三期 A 座'));
    expect(line).toContain('2 份');
    expect(line).toContain('¥51.60');
  });

  it('同一个值不念两遍（realName 与 nickname 都叫李明）', () => {
    const out = summarizeData({ list: [{ realName: '李明', nickname: '李明' }], total: 1 });
    expect((out.match(/李明/g) ?? []).length).toBe(1);
  });

  it('取不到的钱不补 0（0 与「取不到」是两件事）', () => {
    const out = summarizeData({ list: [{ name: 'A', balanceFen: 0 }], total: 1 });
    expect(out).toContain('余额 ¥0.00');
    const out2 = summarizeData({ list: [{ name: 'A' }], total: 1 });
    expect(out2).not.toContain('余额');
  });
});

describe('⛔ 念不漏：白名单之外一个值都不许外泄', () => {
  it('用户行里的 passwordHash 绝不出现', () => {
    const out = summarizeData({
      list: [
        {
          id: 1,
          username: 'admin',
          name: '超级管理员',
          passwordHash: '$2b$10$abcdefghijklmnop',
          openidTail: 'xyz9',
        },
      ],
      total: 1,
    });
    expect(out).not.toContain('passwordHash');
    expect(out).not.toContain('abcdefghijklmnop');
    expect(out).not.toContain('openidTail');
    expect(out).toContain('账号 admin');
  });

  it('认不出的对象：只报字段数，不 dump 原值', () => {
    const out = summarizeData({ secretToken: 'SECRET_XYZ', nested: { a: 1 } });
    expect(out).toContain('后台返回了 2 个字段');
    expect(out).not.toContain('SECRET_XYZ');
  });

  it('⭐ 不读 `dishes` 别名（它只是 `items` 的旧名镜像）', () => {
    const out = summarizeData(
      {
        total: 137,
        items: [{ code: 'get_a', module: 'finance' }],
        dishes: [{ code: 'get_a', module: 'finance' }],
      },
      'get_admin_wecomkb_ops',
    );
    expect(out).toContain('端点目录：共 137 个');
    expect(out).not.toContain('菜品');
  });
});

describe('定向摘要（结构化端点）', () => {
  it('待办：只念有事的，并把明日排餐进度说出来', () => {
    const out = summarizeData(
      {
        businessDate: '2026-11-02',
        items: [
          { key: 'refundApplying', label: '退款待审', count: 0 },
          { key: 'withdrawPending', label: '提现待审', count: 1 },
          { key: 'tomorrowGroupsUnassigned', label: '明日未排套餐的楼群', count: 5 },
        ],
        brief: { tomorrowGroupsTotal: 5, tomorrowGroupsAssigned: 0, deliveryTotal: 0 },
      },
      'get_admin_dashboard_todos',
    );
    expect(out).toContain('今天有 2 件待办');
    expect(out).toContain('提现待审：1');
    expect(out).not.toContain('退款待审');
    expect(out).toContain('明日排餐：0 / 5 个楼群已排');
  });

  it('待办：全 0 时说「没有待办」而不是列 4 行 0', () => {
    const out = summarizeData(
      {
        items: [{ label: '退款待审', count: 0 }],
        brief: { tomorrowGroupsTotal: 0, tomorrowGroupsAssigned: 0 },
      },
      'get_admin_dashboard_todos',
    );
    expect(out).toContain('今天没有待办');
    expect(out).not.toContain('退款待审');
  });

  it('财务总览：收入/支出/应付/负债/毛利全念，warnings 逐条转述', () => {
    const out = summarizeData(
      {
        range: {
          range: '7d',
          label: '近 7 日',
          startDate: '2026-10-27',
          endDate: '2026-11-02',
          days: 7,
        },
        income: {
          orderCount: 21,
          quantity: 22,
          gmvFen: 56760,
          avgOrderAmountFen: 2703,
          refundCount: 1,
          refundRate: 0.0106,
        },
        expense: { purchaseFen: 4650, commissionFen: 619, fulfillmentFen: 0 },
        payable: { unpaidFen: 4650, pendingCount: 4 },
        liability: { balanceFen: 519, frozenFen: 100 },
        profit: { grossProfitFen: 51491, grossProfitRate: 0.9072 },
        warnings: ['履约成本未登记，毛利只是上限值'],
      },
      'get_admin_finance_overview',
    );
    expect(out).toContain('近 7 日（10-27 ~ 11-02）');
    expect(out).toContain('收入：21 单 · 22 份 · GMV ¥567.60 · 客单价 ¥27.03');
    expect(out).toContain('退款：1 单，退款率 1.1%');
    expect(out).toContain('支出：采购 ¥46.50 · 佣金 ¥6.19 · 履约 ¥0.00');
    expect(out).toContain('应付未付：¥46.50（4 笔待付）');
    expect(out).toContain('负债：团长余额 ¥5.19 · 冻结 ¥1.00');
    expect(out).toContain('毛利：¥514.91（90.7%）');
    expect(out).toContain('⚠️ 履约成本未登记');
  });

  it('财务总览：毛利率为 null 时打「—」而不是 0%', () => {
    const out = summarizeData(
      { profit: { grossProfitFen: 100, grossProfitRate: null } },
      'get_admin_finance_overview',
    );
    expect(out).toContain('毛利：¥1.00（—）');
    expect(out).not.toContain('0.0%');
  });

  it('订单详情：念下一个未完成节点与可退款金额', () => {
    const out = summarizeData(
      {
        order: orderRow({ status: 'delivering', statusText: '配送中' }),
        timeline: [
          { node: 'paid', at: '2026-10-28T19:26:17+08:00', done: true, text: '待出餐' },
          { node: 'delivered', at: '2026-10-29T11:30:00+08:00', done: false, text: '已送达' },
        ],
        actions: {
          canForceRefund: true,
          refundableFen: 5160,
          canAdjust: false,
          adjustBlockReason: '已过截单时刻',
        },
      },
      'get_admin_orders_orderno',
    );
    expect(out).toContain('AB2026102802850288 · 配送中');
    expect(out).toContain('套餐：ABox 零食盒');
    expect(out).toContain('下一步：已送达（10-29 11:30）');
    expect(out).toContain('可退款 ¥51.60');
    expect(out).toContain('不能改单：已过截单时刻');
  });

  it('套餐矩阵：格子口径 + 点名有空楼的楼群', () => {
    const out = summarizeData(
      {
        startDate: '2026-11-02',
        endDate: '2026-11-08',
        stats: {
          dateCount: 7,
          groupCount: 5,
          cellCount: 35,
          assignedCells: 0,
          publishedCells: 0,
          emptyCells: 35,
        },
        groups: [
          { name: '国贸三期组', buildingIds: [1, 2, 3, 4], emptyBuildings: [3] },
          { name: '华贸组', buildingIds: [8], emptyBuildings: [] },
        ],
      },
      'get_admin_meal_matrix',
    );
    expect(out).toContain('排餐区间：11-02 ~ 11-08');
    expect(out).toContain('7 天 × 5 个楼群 = 35 格 · 已排 0 · 已上架 0 · 空 35');
    expect(out).toContain('国贸三期组：1 栋空');
    expect(out).not.toContain('华贸组');
  });

  it('队列：失败数要带警示，不藏', () => {
    const out = summarizeData(
      {
        driver: 'redis',
        durable: true,
        queues: [
          { queue: 'order-paid', label: '支付后续', waiting: 0, active: 0, delayed: 0, failed: 0 },
          {
            queue: 'settle-orders',
            label: '结算后续',
            waiting: 2,
            active: 1,
            delayed: 0,
            failed: 3,
          },
        ],
      },
      'get_admin_queue',
    );
    expect(out).toContain('队列驱动：redis（持久）');
    expect(out).toContain('结算后续：等待 2 · 进行 1 · 延迟 0 · 失败 3 ⚠️');
  });

  it('定时任务：念内容/时刻/口径，不只念「创建」', () => {
    const out = summarizeData(
      {
        list: [
          {
            task: 'meal-publish',
            effectiveAt: '14:00',
            dateKindLabel: '次日（T+1）',
            what: 'T-1 开团：次日套餐上架，用户可下单',
          },
        ],
        summary: { total: 9, implemented: 9, registered: 9 },
      },
      'get_admin_schedule',
    );
    expect(out).toContain('内容 T-1 开团');
    expect(out).toContain('时刻 14:00');
    expect(out).toContain('日期口径 次日（T+1）');
    expect(out).not.toContain('没有能直接念的字段');
  });

  it('定向摘要在出参变形时不抛错，退回通用三路', () => {
    // 结构完全不对：不该炸，也不该返回空
    const out = summarizeData({ total: 1, items: 'not-an-array' }, 'get_admin_wecomkb_ops');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('定向摘要的编码与线上目录一致（防改名后静默失效）', () => {
    expect(DIRECTED_CODES).toContain('get_admin_dashboard_todos');
    expect(DIRECTED_CODES).toContain('get_admin_orders_orderno');
    expect(DIRECTED_CODES).toContain('get_admin_finance_overview');
  });
});

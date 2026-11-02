/**
 * 统计问句 · **接线**测试（不是纯函数测试）
 *
 * ⚠️ 为什么单写一个文件：`wecom-stats.spec.ts` 只证明「给我一份出参，我说得对不对」，
 *    它一个字都证明不了「这句人话有没有走到统计分支」。而这次改动的最大风险恰在接线：
 *
 *    `reply()` 里 `matchCatalogEntry` 有一条 `/^(?:看|查看|列出|打开)\s*(.+)$/`。
 *    若统计分支排在它**后面**，「看经营数据」会先被当成「搜端点：经营数据」，
 *    搜不到就回「没找到」——**纯函数单测全绿，功能完全不可用**。
 *    这类错只有真跑一遍 `reply()` 才看得见。
 *
 * ⚠️ 这里每个「走了统计分支」的断言，都配一条「仍然走原来的路」的断言（目录 / 查订单）。
 *    否则「把 matchCatalogEntry 整个删掉」也能让测试通过 —— 那是更严重的回归。
 */

import { WecomChatService } from '../../src/modules/wecom-kb/wecom-chat.service';
import type { Binding } from '../../src/modules/wecom-kb/op-proxy.service';

/** 一份最小可用的 dashboard 出参（形状照抄 `StatsDashboardView`） */
const DASH = {
  range: { range: '7d', label: '近 7 日', startDate: '2026-10-26', endDate: '2026-11-01', days: 7 },
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
  },
  costRegistration: { allRegistered: true, missingLabels: [] },
  costItems: [],
  purchaseGenerated: true,
  trend: [],
  warnings: [],
};

const RANK = {
  range: DASH.range,
  groups: [],
  buildings: [
    { id: 1, name: '量子大厦 A 座', orderCount: 32, quantity: 34, gmvFen: 412000, gmvShare: 0.334 },
  ],
  totalGmvFen: 412000,
};

const BINDING: Binding = {
  operatorName: '测试负责人',
  operatorToken: 'op-token',
  approverToken: 'appr-token',
  tier: 'owner',
};

/** 造一个只关心「被调了哪些查询码、带了什么参数」的 proxy 替身 */
function makeSvc(handler: (code: string, params: Record<string, string>) => unknown): {
  svc: WecomChatService;
  calls: Array<{ code: string; params: Record<string, string> }>;
  execCatalog: jest.Mock;
} {
  const calls: Array<{ code: string; params: Record<string, string> }> = [];
  const execCatalog = jest.fn().mockResolvedValue({ code: 0, message: '', data: {} });
  const proxy = {
    query: (code: string, params: Record<string, string>) => {
      calls.push({ code, params });
      return Promise.resolve({ code: 0, message: '', data: handler(code, params) });
    },
    execCatalog,
  };
  // resolver 在统计路径上完全用不到，给个空壳即可（用到就会抛错，反而是好事）
  const resolver = { resolveGroup: jest.fn(), resolveItem: jest.fn() };
  const svc = new WecomChatService(resolver as never, proxy as never);
  return { svc, calls, execCatalog };
}

describe('统计问句 · 接线', () => {
  it('「经营情况」走统计分支，并调 dashboard 两次（本期 + 上期做环比）', async () => {
    const { svc, calls, execCatalog } = makeSvc(() => DASH);
    const out = await svc.reply('u1', '经营情况', BINDING);

    expect(calls.map((c) => c.code)).toEqual(['q_stats_dashboard', 'q_stats_dashboard']);
    expect(calls[0].params.range).toBe('7d');
    // 本期与上期必须是两个**不同**的终点，否则环比是在跟自己比
    expect(calls[0].params.date).not.toBe(calls[1].params.date);
    expect(out).toContain('GMV ¥12,345.67');
    expect(execCatalog).not.toHaveBeenCalled();
  });

  it('⭐「看经营数据」不被「看 X」那条目录匹配抢走（顺序回归）', async () => {
    const { svc, calls } = makeSvc(() => DASH);
    const out = await svc.reply('u2', '看经营数据', BINDING);

    expect(calls[0]?.code).toBe('q_stats_dashboard');
    // 抢走的症状就是这句
    expect(out).not.toContain('没找到');
    expect(out).toContain('GMV');
  });

  it('「昨天的经营数据」= 单日档 + 终点回退一天（不是近 7 天）', async () => {
    const { svc, calls } = makeSvc(() => DASH);
    await svc.reply('u3', '昨天的经营数据', BINDING);

    expect(calls[0].params.range).toBe('today');
    const end = calls[0].params.date;
    const prev = calls[1].params.date;
    // today 档 1 天：上期终点就是本期终点前一天
    const day = (s: string): number => Date.parse(s + 'T00:00:00Z');
    expect(day(end) - day(prev)).toBe(86_400_000);
  });

  it('「楼栋排行」两次取数，且能点名跌幅', async () => {
    const { svc, calls } = makeSvc((code) => (code === 'q_building_rank' ? RANK : DASH));
    const out = await svc.reply('u4', '楼栋排行', BINDING);
    expect(calls.filter((c) => c.code === 'q_building_rank')).toHaveLength(2);
    expect(out).toContain('量子大厦 A 座');
  });

  it('环比那一次失败不影响本期结论（退化而不是整条报错）', async () => {
    let n = 0;
    const calls: string[] = [];
    const proxy = {
      query: (code: string, _params: Record<string, string>) => {
        calls.push(code);
        n += 1;
        // 第一次成功、第二次（上期）失败
        return Promise.resolve(
          n === 1
            ? { code: 0, message: '', data: DASH }
            : { code: 50001, message: 'boom', data: null },
        );
      },
      execCatalog: jest.fn(),
    };
    const resolver = { resolveGroup: jest.fn(), resolveItem: jest.fn() };
    const svc = new WecomChatService(resolver as never, proxy as never);

    const out = await svc.reply('u5', '经营情况', BINDING);
    expect(out).toContain('GMV ¥12,345.67'); // 本期照常给
    expect(out).toContain('上一档没取到'); // 并且说明为什么没有环比
  });

  it('反面：说「操作目录」仍然进目录（统计分支没有把通用入口吃掉）', async () => {
    const { svc, calls } = makeSvc(() => DASH);
    const out = await svc.reply('u6', '操作目录', BINDING);
    expect(calls).toHaveLength(0);
    expect(out).toContain('项能力');
  });

  it('反面：说「今天多少单」仍然走订单查询（没被 dashboard 抢走）', async () => {
    const { svc, calls } = makeSvc(() => ({
      summary: { totalCount: 40, validCount: 38, validQuantity: 42, abnormalCount: 1 },
    }));
    await svc.reply('u7', '今天多少单', BINDING);
    expect(calls[0].code).toBe('q_orders');
  });

  it('⭐ 订单查询的日期字段是 `mealDate`，不是 `date`（否则 DTO 白名单直接 400）', async () => {
    const { svc, calls } = makeSvc(() => ({
      summary: { totalCount: 40, validCount: 38, validQuantity: 42, abnormalCount: 1 },
    }));
    await svc.reply('u7b', '今天多少单', BINDING);
    // `/admin/orders` 的 DTO 只有 mealDate；传 date 会回 `property date should not exist`，
    // 而机器人把它转成「没查到：…」，于是这句（还在帮助文案里当示例）一直是坏的。
    expect(calls[0].params).toHaveProperty('mealDate');
    expect(calls[0].params).not.toHaveProperty('date');
  });

  it('反面：说「取消」仍然清会话，不触发任何取数', async () => {
    const { svc, calls } = makeSvc(() => DASH);
    const out = await svc.reply('u8', '取消', BINDING);
    expect(calls).toHaveLength(0);
    expect(out).toContain('什么都没动');
  });

  it('取数失败时说人话，不抛异常', async () => {
    const proxy = {
      query: () => Promise.resolve({ code: 50001, message: 'boom', data: null }),
      execCatalog: jest.fn(),
    };
    const resolver = { resolveGroup: jest.fn(), resolveItem: jest.fn() };
    const svc = new WecomChatService(resolver as never, proxy as never);
    const out = await svc.reply('u9', '经营情况', BINDING);
    expect(out).toContain('没查到');
  });
});

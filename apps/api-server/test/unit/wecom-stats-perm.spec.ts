/**
 * 统计问答 · **权限**测试（同事档默认看不到钱的口径）
 *
 * 背景：2026-11-02 之前 `replyStats` 直接调 `proxy.query()`，而 `query()` **完全不看 tier**
 * （它只检查「有没有 operator 令牌」）。后果是：后台 `stats-admin.controller.ts` 的
 * `@Roles(... 'operator' ...)` 本来就允许 operator，于是**同事问一句就能看 GMV 与毛利**。
 * 负责人要求「默认只我能查，需要时再放权」，故加此闸。
 *
 * 三条不能退让的判据：
 *   ① 拦在**取数之前** —— 取完再拦等于数据已经发出去了；
 *   ② 判据**只有一处**（`canExec`）—— 否则「问句被拦、从目录点进去能看」；
 *   ③ 放权要**真的能用** —— 只拦不放，等于「后台点了放权、机器人还说做不了」，
 *      这正是本项目已经踩过一次的坑。
 */

import { WecomChatService } from '../../src/modules/wecom-kb/wecom-chat.service';
import type { Binding } from '../../src/modules/wecom-kb/op-proxy.service';
import { canExec, codeOfPath, find } from '../../src/modules/wecom-kb/op-policy';

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
  buildings: [],
  totalGmvFen: 0,
};

const OWNER: Binding = { operatorName: '老板', operatorToken: 'op', tier: 'owner' };
const STAFF: Binding = { operatorName: '同事小李', operatorToken: 'op', tier: 'staff' };

function makeSvc(data: unknown = DASH): {
  svc: WecomChatService;
  calls: string[];
} {
  const calls: string[] = [];
  const proxy = {
    query: (code: string) => {
      calls.push(code);
      return Promise.resolve({ code: 0, message: '', data });
    },
    execCatalog: jest.fn(),
  };
  const resolver = { resolveGroup: jest.fn(), resolveItem: jest.fn() };
  return {
    svc: new WecomChatService(
      resolver as never,
      proxy as never,
      null as never,
      null as never,
      null as never,
      { record: async () => undefined } as never,
      { getRaw: async () => null } as never,
    ),
    calls,
  };
}

describe('统计问答 · 权限', () => {
  it('⭐ 同事问「经营情况」被拦下，且**一次取数都没发**', async () => {
    const { svc, calls } = makeSvc();
    const out = await svc.reply('s1', '经营情况', STAFF);

    expect(calls).toHaveLength(0); // 取完再拦 = 数据已经发出去了
    expect(out).toContain('负责人');
    expect(out).not.toContain('GMV'); // 一个数字都不许漏
  });

  it('负责人照旧能看（闸门没有误伤本人）', async () => {
    const { svc, calls } = makeSvc();
    const out = await svc.reply('s2', '经营情况', OWNER);

    expect(calls).toEqual(['q_stats_dashboard', 'q_stats_dashboard']);
    expect(out).toContain('GMV');
  });

  it('⭐ 放权之后同事能看（否则等于「后台点了放权、机器人还说做不了」）', async () => {
    const code = codeOfPath('/admin/stats/dashboard', 'GET');
    expect(code).toBeTruthy();

    const { svc, calls } = makeSvc();
    const out = await svc.reply('s3', '经营情况', { ...STAFF, grantedOps: [code as string] });

    expect(calls).toEqual(['q_stats_dashboard', 'q_stats_dashboard']);
    expect(out).toContain('GMV');
  });

  it('放权是**按功能项**的：只放了经营数据，楼栋排行仍然拦', async () => {
    const code = codeOfPath('/admin/stats/dashboard', 'GET') as string;
    const { svc, calls } = makeSvc(RANK);
    const out = await svc.reply('s4', '楼栋排行', { ...STAFF, grantedOps: [code] });

    expect(calls).toHaveLength(0);
    expect(out).toContain('负责人');
  });

  it('五个视角逐个拦：留存 / 菜品热度 / 页面停留都不能给同事', async () => {
    for (const q of ['这周留存怎么样', '菜品热度排行', '页面停留数据']) {
      const { svc, calls } = makeSvc();
      const out = await svc.reply('s5', q, STAFF);
      expect(calls).toHaveLength(0);
      expect(out).toContain('负责人');
    }
  });

  it('⭐ 反面：从「操作目录」点进 stats 也拦得住（判据在 canExec 里，不在聊天层）', () => {
    const code = codeOfPath('/admin/stats/dashboard', 'GET') as string;
    const item = find(code);
    expect(item).toBeTruthy();
    const entry = item!.entry;

    // 源码 @Roles 里本来就有 operator ⇒ 只看角色会判成「可以」，这条限制是我们额外加的
    expect(entry.roles).toContain('operator');
    expect(canExec('staff', entry, { code }).ok).toBe(false);
    expect(canExec('staff', entry, { code, granted: [code] }).ok).toBe(true);
    expect(canExec('owner', entry, { code }).ok).toBe(true);
  });

  it('反面：同事查「今天多少单」不受影响（这不是钱的口径，是干活要用的）', async () => {
    const { svc, calls } = makeSvc({
      summary: { totalCount: 40, validCount: 38, validQuantity: 42, abnormalCount: 1 },
    });
    const out = await svc.reply('s6', '今天多少单', STAFF);

    expect(calls[0]).toBe('q_orders');
    expect(out).not.toContain('负责人');
  });

  it('反面：同事说「操作目录」仍然能看到目录（没有把整个机器人锁死）', async () => {
    const { svc, calls } = makeSvc();
    const out = await svc.reply('s7', '操作目录', STAFF);
    expect(calls).toHaveLength(0);
    expect(out).toContain('项能力');
  });
});

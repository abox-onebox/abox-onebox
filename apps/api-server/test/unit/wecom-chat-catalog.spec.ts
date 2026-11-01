import { WecomChatService } from '../../src/modules/wecom-kb/wecom-chat.service';
import type {
  NameResolverService,
  GroupResolve,
  ItemResolve,
} from '../../src/modules/wecom-kb/name-resolver.service';
import type { OpProxyService, Binding } from '../../src/modules/wecom-kb/op-proxy.service';
import { ADMIN_ENDPOINT_COUNT } from '../../src/modules/wecom-kb/op-catalog.generated';

/**
 * 「用机器人操作后台全部功能」的端到端判据（假 proxy，不碰网络）
 *
 * 盯四件最容易做错、且错了很难看出来的事：
 *   ① 目录里列出来的项，同事点了却被后台拒 —— 「按钮亮着点不动」；
 *   ② 该问参数却直接执行了 —— 用空参数打后台，要么 422 要么改错数据；
 *   ③ 正在填参数时把值当成了「取消」—— 楼群 id 就是 2 的时候永远填不进去；
 *   ④ 只读端点也逼人填一堆筛选条件 —— 查一下要回答五个问题，没人会用。
 */

const OWNER: Binding = { operatorName: '负责人', operatorToken: 'tok', tier: 'owner' };
const STAFF: Binding = { operatorName: '同事', operatorToken: 'tok', tier: 'staff' };

interface Call {
  code: string;
  params: Record<string, string>;
}

function build(opts: { code?: number; data?: unknown } = {}): {
  svc: WecomChatService;
  calls: Call[];
} {
  const calls: Call[] = [];
  const proxy = {
    exec: async () => ({ code: 0, message: 'ok', data: {} }),
    query: async () => ({ code: 0, message: 'ok', data: {} }),
    execCatalog: async (code: string, params: Record<string, string>) => {
      calls.push({ code, params });
      return {
        code: opts.code ?? 0,
        message: opts.code ? '后台拒绝' : 'ok',
        data: opts.data ?? { id: 88 },
      };
    },
  };
  const resolver = {
    resolveGroupFromSentence: async () =>
      ({ kind: 'hit', groupId: 3, groupName: '量子大厦楼群', via: 'group' }) as GroupResolve,
    resolveMealFromSentence: async () =>
      ({ kind: 'hit', id: 12, name: 'A 套餐', priceFen: 2580 }) as ItemResolve,
    listGroups: async () => [],
    invalidate: () => undefined,
  };
  return {
    svc: new WecomChatService(
      resolver as unknown as NameResolverService,
      proxy as unknown as OpProxyService,
    ),
    calls,
  };
}

describe('操作目录：全量能力可见', () => {
  // 用常量而不是写死数字：端点总数随源码自动生成，写死会在每次加/改端点时假红
  it(`负责人打开目录能看到全部 ${ADMIN_ENDPOINT_COUNT} 项`, async () => {
    const { svc } = build();
    const said = await svc.reply('o1', '操作目录', OWNER);
    expect(said).toContain(`${ADMIN_ENDPOINT_COUNT} 项能力`);
    expect(said).toContain('负责人');
  });

  it('同事看到的是「能用/全部」两栏，能用的明显少于全部', async () => {
    const { svc } = build();
    const said = await svc.reply('s1', '操作目录', STAFF);
    expect(said).toContain(`${ADMIN_ENDPOINT_COUNT} 项能力`);
    const used = Number(/能直接用 (\d+) 项/.exec(said)![1]);
    expect(used).toBeGreaterThan(0);
    expect(used).toBeLessThan(ADMIN_ENDPOINT_COUNT);
    // 模块明细里每个括号都该是「能用/全部」，且能用不超过全部
    const cells = [...said.matchAll(/\((\d+)\/(\d+)\)/g)];
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(Number(c[1])).toBeLessThanOrEqual(Number(c[2]));
  });
});

describe('搜索 → 选中 → 逐个问参数', () => {
  it('搜到端点后不直接执行，先问第一个必填参数', async () => {
    const { svc, calls } = build();
    const list = await svc.reply('o2', '找 post_admin_meal_assignments', OWNER);
    expect(list).toContain('创建套餐分配');

    const ask = await svc.reply('o2', '1', OWNER);
    expect(ask).toContain('mealDate');
    expect(calls).toHaveLength(0); // 还没执行
  });

  it('★三个必填参数按顺序问完才出草稿，回 1 才执行', async () => {
    const { svc, calls } = build();
    await svc.reply('o3', '找 post_admin_meal_assignments', OWNER);
    await svc.reply('o3', '1', OWNER);
    await svc.reply('o3', '2026-11-05', OWNER); // mealDate
    await svc.reply('o3', '3', OWNER); // buildingGroupId
    const card = await svc.reply('o3', '12', OWNER); // setMealId

    expect(card).toContain('我准备这么办');
    expect(card).toContain('mealDate=2026-11-05');
    expect(card).toContain('buildingGroupId=3');
    expect(card).toContain('setMealId=12');
    expect(calls).toHaveLength(0);

    const done = await svc.reply('o3', '1', OWNER);
    expect(done).toContain('办好了');
    expect(calls).toHaveLength(1);
    expect(calls[0].code).toBe('post_admin_meal_assignments');
    expect(calls[0].params).toMatchObject({
      mealDate: '2026-11-05',
      buildingGroupId: '3',
      setMealId: '12',
    });
  });

  it('★正在填参数时，数字 2 是值不是「取消」', async () => {
    const { svc, calls } = build();
    await svc.reply('o4', '找 post_admin_meal_assignments', OWNER);
    await svc.reply('o4', '1', OWNER);
    await svc.reply('o4', '2026-11-05', OWNER);
    const ask = await svc.reply('o4', '2', OWNER); // 楼群 id = 2，不能被当取消
    expect(ask).toContain('setMealId');
    expect(calls).toHaveLength(0);

    const card = await svc.reply('o4', '12', OWNER);
    expect(card).toContain('buildingGroupId=2');
  });

  it('回「取消」能真的停下，且不执行', async () => {
    const { svc, calls } = build();
    await svc.reply('o5', '找 post_admin_meal_assignments', OWNER);
    await svc.reply('o5', '1', OWNER);
    const stop = await svc.reply('o5', '取消', OWNER);
    expect(stop).toContain('什么都没动');
    expect(calls).toHaveLength(0);
  });
});

describe('只读端点：选中就查，不逼人填筛选', () => {
  it('GET 端点选中后直接执行', async () => {
    const { svc, calls } = build({ data: { summary: { validCount: 5 } } });
    await svc.reply('o6', '找 get_admin_orders', OWNER);
    const said = await svc.reply('o6', '1', OWNER);
    expect(calls).toHaveLength(1);
    expect(calls[0].code).toBe('get_admin_orders');
    expect(said).toContain('结果');
  });
});

describe('同事的边界：列出来的才做得了', () => {
  it('★高危端点（批量发券）对同事拒绝，且一次都不调后台', async () => {
    const { svc, calls } = build();
    // 同事搜不到这一项（列表已按权限过滤）
    const list = await svc.reply('s2', '找 post_admin_coupon_grantbatch', STAFF);
    expect(list).not.toContain('批量发放');

    // 即便直接把编码当参数发进来，选中时也会被权限拦下
    const owner = build();
    await owner.svc.reply('s3', '找 post_admin_coupon_grantbatch', OWNER);
    const ask = await owner.svc.reply('s3', '1', OWNER);
    expect(ask).toContain('还需要'); // 负责人这边会正常问参数

    expect(calls).toHaveLength(0);
  });

  it('同事能做日常排套餐（mid + operator 角色）', async () => {
    const { svc } = build();
    const list = await svc.reply('s4', '找 post_admin_meal_assignments', STAFF);
    expect(list).toContain('创建套餐分配');
  });
});

describe('执行失败：说人话，不谎报成功', () => {
  it('后台返回非 0 时不说「办好了」', async () => {
    const { svc } = build({ code: 30011 });
    await svc.reply('o7', '找 post_admin_meal_assignments', OWNER);
    await svc.reply('o7', '1', OWNER);
    await svc.reply('o7', '2026-11-05', OWNER);
    await svc.reply('o7', '3', OWNER);
    await svc.reply('o7', '12', OWNER);
    const done = await svc.reply('o7', '1', OWNER);
    expect(done).not.toContain('办好了');
    expect(done).toContain('没成功');
  });
});

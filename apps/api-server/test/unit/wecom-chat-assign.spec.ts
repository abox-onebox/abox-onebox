import { WecomChatService } from '../../src/modules/wecom-kb/wecom-chat.service';
import type {
  NameResolverService,
  GroupResolve,
  ItemResolve,
} from '../../src/modules/wecom-kb/name-resolver.service';
import type { OpProxyService, Binding } from '../../src/modules/wecom-kb/op-proxy.service';

/**
 * 「说一句话就排套餐」的**端到端判据**（假 resolver + 假 proxy，不碰网络）
 *
 * 盯两件曾经真实写错的事：
 *   ① 只调 D2 建分配就回「已排上」—— 建出来是 pending，用户端买不到，等于谎报成功；
 *      必须再调 D4 publish 才算真开团。
 *   ② 已过截单仍然建行 —— 建了也是 pending，用户端照样下不了单，
 *      只在后台留一条让人困惑的记录。
 */

const BINDING: Binding = { operatorName: '测试同事', operatorToken: 'tok' };

interface Call {
  op: string;
  params: Record<string, string>;
}

function build(opts: {
  group?: GroupResolve;
  meal?: ItemResolve;
  assignCode?: number;
  publishCode?: number;
  assignData?: unknown;
  queryData?: unknown;
}): { svc: WecomChatService; calls: Call[] } {
  const calls: Call[] = [];
  const proxy = {
    exec: async (op: string, params: Record<string, string>) => {
      calls.push({ op, params });
      if (op === 'assign_meal') {
        return {
          code: opts.assignCode ?? 0,
          message: opts.assignCode ? '后台拒绝' : 'ok',
          data: opts.assignData ?? { id: 77 },
        };
      }
      if (op === 'publish_assignment') {
        return { code: opts.publishCode ?? 0, message: 'ok', data: {} };
      }
      return { code: 0, message: 'ok', data: {} };
    },
    query: async () => ({ code: 0, message: 'ok', data: opts.queryData ?? {} }),
  };

  const resolver = {
    resolveGroupFromSentence: async () =>
      opts.group ??
      ({ kind: 'hit', groupId: 3, groupName: '量子大厦楼群', via: 'group' } as GroupResolve),
    resolveMealFromSentence: async () =>
      opts.meal ?? ({ kind: 'hit', id: 12, name: 'A 套餐', priceFen: 2580 } as ItemResolve),
    listGroups: async () => [],
    invalidate: () => undefined,
  };

  return {
    svc: new WecomChatService(
      resolver as unknown as NameResolverService,
      proxy as unknown as OpProxyService,
      null as never,
      null as never,
      null as never,
      { record: async () => undefined } as never,
    ),
    calls,
  };
}

/** 今天（北京日）——「已截单」这一类判据只能用它才确定 */
function todayBj(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

describe('排套餐：先出草稿，回 1 才动库', () => {
  it('第一次只说事，不写库', async () => {
    const { svc, calls } = build({});
    const reply = await svc.reply('u1', '给量子大厦上明天的 A 套餐', BINDING);
    expect(reply).toContain('我准备这么办');
    expect(reply).toContain('量子大厦楼群');
    expect(reply).toContain('A 套餐');
    expect(calls).toHaveLength(0);
  });

  it('★回 1 之后：建分配 + 再上架，两步都要有', async () => {
    const { svc, calls } = build({});
    await svc.reply('u2', '给量子大厦上明天的 A 套餐', BINDING);
    const done = await svc.reply('u2', '1', BINDING);

    expect(calls.map((c) => c.op)).toEqual(['assign_meal', 'publish_assignment']);
    expect(calls[1].params).toEqual({ id: '77', action: 'publish' });
    expect(done).toContain('办好了');
    expect(done).toContain('能下单');
  });

  it('★只建成功、上架失败时不许说「办好了」', async () => {
    const { svc } = build({ publishCode: 30013 });
    await svc.reply('u3', '给量子大厦上明天的 A 套餐', BINDING);
    const done = await svc.reply('u3', '1', BINDING);
    expect(done).not.toContain('办好了');
    expect(done).toContain('上架没成功');
  });

  it('★已截单（排今天）就不建行，直接说清楚', async () => {
    const { svc, calls } = build({});
    const reply = await svc.reply('u4', '给量子大厦上今天的 A 套餐', BINDING);
    expect(reply).toContain(todayBj().slice(5));
    const done = await svc.reply('u4', '1', BINDING);
    expect(done).toContain('已经截单');
    expect(calls).toHaveLength(0);
  });

  it('建分配被拒时把后台原因说成人话', async () => {
    const { svc } = build({ assignCode: 30011 });
    await svc.reply('u5', '给量子大厦上明天的 A 套餐', BINDING);
    const done = await svc.reply('u5', '1', BINDING);
    expect(done).toContain('已经排过套餐');
  });

  it('回 2 取消：一步都不动', async () => {
    const { svc, calls } = build({});
    await svc.reply('u6', '给量子大厦上明天的 A 套餐', BINDING);
    const done = await svc.reply('u6', '2', BINDING);
    expect(done).toContain('什么都没动');
    expect(calls).toHaveLength(0);
  });
});

describe('补充回答：别把已经认出的楼丢掉', () => {
  it('被问「哪天」后只回「明天」，仍能出草稿', async () => {
    const { svc } = build({});
    const ask = await svc.reply('u7', '给量子大厦上 A 套餐', BINDING);
    expect(ask).toContain('哪天');
    const card = await svc.reply('u7', '明天', BINDING);
    expect(card).toContain('我准备这么办');
    expect(card).toContain('量子大厦楼群');
  });

  it('★追问「哪天」不许再给 1/2/3 数字菜单（会和「回 2 取消」打架）', async () => {
    const { svc } = build({});
    const ask = await svc.reply('u8', '给量子大厦上 A 套餐', BINDING);
    expect(ask).not.toMatch(/回 1 = 今天/);
    expect(ask).not.toMatch(/2 = 明天/);
  });
});

describe('查订单：走 summary 口径', () => {
  it('把有效单与份数说成人话', async () => {
    const { svc } = build({
      queryData: {
        summary: { totalCount: 10, validCount: 9, validQuantity: 27, abnormalCount: 0 },
      },
    });
    const said = await svc.reply('u9', '今天多少单', BINDING);
    expect(said).toContain('9 单');
    expect(said).toContain('27 份');
  });
});

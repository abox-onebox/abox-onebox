import {
  describePreflight,
  preflight,
  type PreflightInput,
} from '../../src/modules/wecom-kb/preflight';

/** 有数据（用来做「不该降级」的基线） */
const HEALTHY: PreflightInput = {
  publishedCells: 21,
  assignedCells: 21,
  groupCount: 5,
  couponDefs: 3,
  orders7d: 40,
};

const pick = (over: Partial<PreflightInput>): PreflightInput => ({ ...HEALTHY, ...over });

describe('preflight · 正常态不该降级', () => {
  it('数据齐时 ok 且不跳过任何节点', () => {
    const r = preflight(HEALTHY);
    expect(r.grade).toBe('ok');
    expect(r.skipNodes).toEqual([]);
    expect(r.blockers).toEqual([]);
  });

  it('★负控：取数全失败（null）不能当成「全是 0」', () => {
    const r = preflight({
      publishedCells: null,
      assignedCells: null,
      groupCount: null,
      couponDefs: null,
      orders7d: null,
    });
    expect(r.grade).toBe('ok');
    expect(r.blockers).toEqual([]);
    expect(r.skipNodes).toEqual([]);
  });

  it('★0 与 null 必须分开判：orders7d=0 降级，=null 不降级', () => {
    const zero = preflight(pick({ orders7d: 0 }));
    const unknown = preflight(pick({ orders7d: null }));
    expect(zero.grade).toBe('thin');
    expect(unknown.grade).toBe('ok');
  });

  it('券种 0 条只提示、不降级（发券节点自身会说明无券可用）', () => {
    const r = preflight(pick({ couponDefs: 0 }));
    expect(r.grade).toBe('ok');
    expect(r.skipNodes).toEqual([]);
    expect(r.notes.join()).toContain('券种 0 条');
  });
});

describe('preflight · 空壳降级', () => {
  it('没排餐也没订单 ⇒ empty，只留日报', () => {
    const r = preflight(pick({ publishedCells: 0, assignedCells: 0, orders7d: 0 }));
    expect(r.grade).toBe('empty');
    expect(r.skipNodes.length).toBe(11);
    expect(r.skipNodes).not.toContain('daily');
    expect(r.headline).toContain('只出日报');
  });

  it('★空壳时风险与退款也不该跑（0 单下它们只会说「暂无」，白耗一次 LLM）', () => {
    const r = preflight(pick({ publishedCells: 0, assignedCells: 0, orders7d: 0 }));
    expect(r.skipNodes).toContain('risk');
    expect(r.skipNodes).toContain('refund');
    expect(r.skipNodes).toContain('leader');
  });

  it('只有没排餐（有历史订单）⇒ thin，只跳选品与社群', () => {
    const r = preflight(pick({ publishedCells: 0, assignedCells: 0 }));
    expect(r.grade).toBe('thin');
    expect(r.skipNodes.sort()).toEqual(['community', 'meal']);
  });

  it('只有 0 单（排餐正常）⇒ thin，只跳依赖订单的四个节点', () => {
    const r = preflight(pick({ orders7d: 0 }));
    expect(r.grade).toBe('thin');
    expect(r.skipNodes.sort()).toEqual(['churn', 'demand', 'growth', 'health']);
  });
});

describe('preflight · 文案要能指向下一步动作', () => {
  it('★「排了没上架」与「压根没排」必须说成两件事', () => {
    const notLive = preflight(pick({ publishedCells: 0, assignedCells: 6 }));
    const none = preflight(pick({ publishedCells: 0, assignedCells: 0 }));
    expect(notLive.blockers[0]).toContain('没有一个上架');
    expect(none.blockers[0]).toContain('没有任何排餐');
    expect(notLive.blockers[0]).not.toBe(none.blockers[0]);
  });

  it('blockers 里带「待办」前缀，notes 里带「提示」前缀', () => {
    const t = describePreflight(
      preflight(pick({ publishedCells: 0, assignedCells: 0, couponDefs: 0 })),
    );
    expect(t).toContain('待办');
    expect(t).toContain('提示');
    expect(t).toContain('本次跳过');
  });

  it('★ok 且无提示时返回空串（不能给负责人塞一段「一切正常」的废话）', () => {
    expect(describePreflight(preflight(HEALTHY))).toBe('');
  });

  it('ok 但有提示时仍要出段（券种 0 条属该说的事）', () => {
    const t = describePreflight(preflight(pick({ couponDefs: 0 })));
    expect(t).toContain('数据体检');
    expect(t).toContain('券种 0 条');
  });
});

import {
  DEFAULT_ACTIVE_KINDS,
  isActiveTemplate,
  launchDraftText,
  parseActiveKinds,
  planLaunchConfirm,
  revalidateLaunchDraft,
  type LaunchConfirmPending,
  type LaunchDraftRecheckCtx,
  type LaunchDraftRow,
} from '../../src/common/utils/launch-draft';

/**
 * #1 自动开团 · 批 2 —— 「展示前实时复核」闸的判据
 *
 * 本文件钉死四件事：
 *   ① **必不报**：完全合法的草稿必须原样放行（防判据恒红、把正常链路卡死）；
 *   ② **必报**：编造 ID / 停用 / 日期错 / 重复 必须逐条拦下并给出人话原因（防恒绿）；
 *   ③ **非当前启用品类必须拦**：假定本文件 CTX 配置成 `activeKinds=['meal']`
 *      （模拟将来开盒饭），则 `fmcg` 模板 id 合法也必须被拦；另有一组用例钉死
 *      **缺省启用品类是 `fmcg`**（当前只跑快消品）；
 *   ④ 脏数据**不许抛错**：开团链路不能因一条畸形草稿崩掉整段对话。
 */

const CTX: LaunchDraftRecheckCtx = {
  mealDate: '2026-11-05',
  // 本文件测的是「复核闸判据」，显式配成 meal 档以保留原有断言语义；
  // 当前生产缺省（fmcg）由下面那组独立用例钉死。
  activeKinds: ['meal'],
  groups: [
    { id: 1, name: '量子大厦', status: 1 },
    { id: 2, name: '京仪大厦', status: 1 },
    { id: 3, name: '停用楼群', status: 0 },
  ],
  templates: [
    { id: 7, name: '牛肉双拼', status: 1, kind: 'meal', priceFen: 2580, usedCount: 86 },
    { id: 9, name: '鸡腿套餐', status: 1, kind: 'meal', priceFen: 2580, usedCount: 40 },
    { id: 8, name: '预包装零食盒', status: 1, kind: 'fmcg', priceFen: 2580, usedCount: 5 },
    { id: 12, name: '已下架套餐', status: 0, kind: 'meal', priceFen: 2880, usedCount: 0 },
  ],
};

describe('revalidateLaunchDraft —— 必不报：合法草稿全放行', () => {
  it('两条合法草稿通过，并补全楼群名/套餐名/价格/被排次数', () => {
    const r = revalidateLaunchDraft(
      {
        drafts: [
          { mealDate: '2026-11-05', buildingGroupId: 2, setMealId: 9, reason: '次热' },
          { mealDate: '2026-11-05', buildingGroupId: 1, setMealId: 7, reason: '热销' },
        ],
      },
      CTX,
    );

    expect(r.blocked).toHaveLength(0);
    expect(r.rows).toHaveLength(2);
    // 按楼群 id 升序
    expect(r.rows.map((x) => x.buildingGroupId)).toEqual([1, 2]);
    expect(r.rows[0]).toEqual({
      mealDate: '2026-11-05',
      buildingGroupId: 1,
      buildingGroupName: '量子大厦',
      setMealId: 7,
      setMealName: '牛肉双拼',
      priceFen: 2580,
      usedCount: 86,
      reason: '热销',
    });
  });

  it('缺 mealDate 时继承本次排期（不误拦）', () => {
    const r = revalidateLaunchDraft(
      { drafts: [{ buildingGroupId: 1, setMealId: 7, reason: '' }] },
      CTX,
    );
    expect(r.blocked).toHaveLength(0);
    expect(r.rows[0].mealDate).toBe('2026-11-05');
  });

  it('上游没给 status 时不拦（缺字段视为启用）', () => {
    const r = revalidateLaunchDraft(
      { drafts: [{ buildingGroupId: 1, setMealId: 7 }] },
      {
        mealDate: '2026-11-05',
        // 本用例只测「status 缺省视为启用」，品类显式沿用 CTX 口径，
        // 否则缺 kind 会按 meal 撞上全局缺省 fmcg，红的是别的事。
        activeKinds: ['meal'],
        groups: [{ id: 1, name: '量子大厦' }],
        templates: [{ id: 7, name: '牛肉双拼', priceFen: 2580 }],
      },
    );
    expect(r.blocked).toHaveLength(0);
    expect(r.rows).toHaveLength(1);
  });
});

describe('revalidateLaunchDraft —— 必报：该拦的一条都不许漏', () => {
  it('非当前启用品类（fmcg）的模板必须拦（id 合法也不能开团）', () => {
    const r = revalidateLaunchDraft(
      { drafts: [{ mealDate: '2026-11-05', buildingGroupId: 1, setMealId: 8 }] },
      CTX,
    );
    expect(r.rows).toHaveLength(0);
    expect(r.blocked[0].code).toBe('template_kind_mismatch');
    expect(r.blocked[0].detail).toContain('fmcg');
  });

  it('楼群停用 → group_disabled', () => {
    const r = revalidateLaunchDraft(
      { drafts: [{ mealDate: '2026-11-05', buildingGroupId: 3, setMealId: 7 }] },
      CTX,
    );
    expect(r.rows).toHaveLength(0);
    expect(r.blocked[0].code).toBe('group_disabled');
    expect(r.blocked[0].detail).toContain('停用楼群');
  });

  it('模板停用 → template_disabled', () => {
    const r = revalidateLaunchDraft(
      { drafts: [{ mealDate: '2026-11-05', buildingGroupId: 1, setMealId: 12 }] },
      CTX,
    );
    expect(r.blocked[0].code).toBe('template_disabled');
  });

  it('编造的楼群 / 模板 ID → group_unknown / template_unknown', () => {
    const r = revalidateLaunchDraft(
      {
        drafts: [
          { mealDate: '2026-11-05', buildingGroupId: 99, setMealId: 7 },
          { mealDate: '2026-11-05', buildingGroupId: 1, setMealId: 999 },
        ],
      },
      CTX,
    );
    expect(r.rows).toHaveLength(0);
    expect(r.blocked.map((b) => b.code)).toEqual(['group_unknown', 'template_unknown']);
  });

  it('日期不一致 → date_mismatch（逐日排，只认一天）', () => {
    const r = revalidateLaunchDraft(
      { drafts: [{ mealDate: '2026-11-06', buildingGroupId: 1, setMealId: 7 }] },
      CTX,
    );
    expect(r.blocked[0].code).toBe('date_mismatch');
  });

  it('同一楼群多条 → 只留第一条，其余 duplicate_group', () => {
    const r = revalidateLaunchDraft(
      {
        drafts: [
          { mealDate: '2026-11-05', buildingGroupId: 1, setMealId: 7, reason: 'a' },
          { mealDate: '2026-11-05', buildingGroupId: 1, setMealId: 9, reason: 'b' },
        ],
      },
      CTX,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].setMealId).toBe(7);
    expect(r.blocked).toHaveLength(1);
    expect(r.blocked[0].code).toBe('duplicate_group');
  });
});

describe('revalidateLaunchDraft —— 脏数据不抛错', () => {
  it.each([[null], [undefined], [{}], ['一串文本'], [{ drafts: 'not-array' }]])(
    '畸形输入 %p → bad_shape，不抛错',
    (raw) => {
      const r = revalidateLaunchDraft(raw, CTX);
      expect(r.rows).toHaveLength(0);
      expect(r.blocked).toHaveLength(1);
      expect(r.blocked[0].code).toBe('bad_shape');
    },
  );

  it('数组里夹 null / 缺字段的条目逐条拦，不整批丢', () => {
    const r = revalidateLaunchDraft(
      {
        drafts: [null, { mealDate: '2026-11-05', setMealId: 7 }, { buildingGroupId: 1 }],
      },
      CTX,
    );
    expect(r.rows).toHaveLength(0);
    expect(r.blocked.every((b) => b.code === 'bad_shape')).toBe(true);
    expect(r.blocked).toHaveLength(3);
  });
});

describe('catalog.activeKinds —— 启用品类由配置驱动（2026-11-10 裁定）', () => {
  it('缺省只跑快消品 fmcg，绝不放开盒饭档', () => {
    expect(DEFAULT_ACTIVE_KINDS).toEqual(['fmcg']);
  });

  it.each([
    [null, ['fmcg']],
    [undefined, ['fmcg']],
    ['', ['fmcg']],
    ['   ', ['fmcg']],
    ['fmcg,meal', ['fmcg', 'meal']],
    [' MEAL , fmcg ', ['meal', 'fmcg']],
    ['meal,meal', ['meal']],
    ['junk,meal', ['meal']],
    ['junk', ['fmcg']],
  ])('parseActiveKinds(%p) → %p', (raw, expected) => {
    expect(parseActiveKinds(raw as string | null | undefined)).toEqual(expected);
  });

  it('isActiveTemplate：缺 kind 按 meal 处理，不猜成启用品类', () => {
    expect(isActiveTemplate({ id: 1, kind: 'fmcg' })).toBe(true);
    expect(isActiveTemplate({ id: 2, kind: 'meal' })).toBe(false);
    expect(isActiveTemplate({ id: 3 })).toBe(false);
    expect(isActiveTemplate({ id: 2, kind: 'meal' }, ['fmcg', 'meal'])).toBe(true);
  });

  it('★ 缺省 CTX（不传 activeKinds）下：meal 模板被拦、fmcg 模板放行', () => {
    const noCfg: LaunchDraftRecheckCtx = {
      mealDate: '2026-11-05',
      groups: [{ id: 1, name: '量子大厦', status: 1 }],
      templates: [
        { id: 7, name: '红烧肉套餐', status: 1, kind: 'meal' },
        { id: 8, name: 'ABox 零食盒', status: 1, kind: 'fmcg' },
      ],
    };
    const r = revalidateLaunchDraft(
      {
        drafts: [
          { buildingGroupId: 1, setMealId: 7 },
          { buildingGroupId: 1, setMealId: 8 },
        ],
      },
      noCfg,
    );
    // 被品类闸拦下的条目**不占用**楼群去重位（seenGroup 只在全通过后才 add），
    // 所以第 2 条 fmcg 正常放行 —— 这正是「缺省只跑快消品」的最强证据。
    expect(r.blocked).toHaveLength(1);
    expect(r.blocked[0].code).toBe('template_kind_mismatch');
    expect(r.blocked[0].detail).toContain('fmcg');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].setMealId).toBe(8);
  });

  it('把配置切成 fmcg,meal 后，同一份 meal 草稿即可放行（零代码开盒饭）', () => {
    const r = revalidateLaunchDraft(
      { drafts: [{ buildingGroupId: 1, setMealId: 7 }] },
      { ...CTX, activeKinds: parseActiveKinds('fmcg,meal') },
    );
    expect(r.blocked).toHaveLength(0);
    expect(r.rows).toHaveLength(1);
  });
});

describe('launchDraftText —— 展示文本', () => {
  it('有草稿：逐个楼群一行，含理由与价格', () => {
    const res = revalidateLaunchDraft(
      {
        drafts: [{ mealDate: '2026-11-05', buildingGroupId: 1, setMealId: 7, reason: '牛肉热销' }],
      },
      CTX,
    );
    const txt = launchDraftText(res, { mealDate: '2026-11-05' });
    expect(txt).toContain('2026-11-05');
    expect(txt).toContain('量子大厦 → 牛肉双拼 ¥25.80');
    expect(txt).toContain('牛肉热销');
    // 不许让同事误以为已经排上了
    expect(txt).toContain('没有写库');
  });

  it('无草稿 + 有拦截：两段都要说清', () => {
    const res = revalidateLaunchDraft(
      { drafts: [{ mealDate: '2026-11-05', buildingGroupId: 1, setMealId: 8 }] },
      CTX,
    );
    const txt = launchDraftText(res, { mealDate: '2026-11-05', mode: 'stub' });
    expect(txt).toContain('没排出可用草稿');
    expect(txt).toContain('已拦截 1 条');
    expect(txt).toContain('占位模式');
  });
});

/**
 * 批 3 · 确认开团的四道闸
 *
 * 这是**唯一会真写线上排期**的入口，判据必须一条条钉死：
 * 越权、隔天草稿、已截单、点错序号 —— 每一种都不能靠「服务层里写个 if」兜着。
 */
function row(n: number): LaunchDraftRow {
  return {
    mealDate: '2026-11-05',
    buildingGroupId: n,
    buildingGroupName: `楼群${n}`,
    setMealId: 7,
    setMealName: '牛肉双拼',
    priceFen: 2580,
    usedCount: 86,
    reason: '热销',
  };
}

const PENDING: LaunchConfirmPending = {
  mealDate: '2026-11-05',
  day: '2026-11-04',
  rows: [row(1), row(2), row(3)],
};

const base = {
  pending: PENDING,
  today: '2026-11-04',
  afterCutoff: false,
  tier: 'owner' as const,
  picks: null as number[] | null,
};

describe('planLaunchConfirm —— 必不报：合法确认要放行', () => {
  it('默认全排：picks=null 时三条全给', () => {
    const p = planLaunchConfirm(base);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.rows.map((r) => r.buildingGroupId)).toEqual([1, 2, 3]);
  });

  it('挑条：picks=[1,3] 只给第 1、3 条，且保持草稿原序', () => {
    const p = planLaunchConfirm({ ...base, picks: [3, 1] });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.rows.map((r) => r.buildingGroupId)).toEqual([1, 3]);
  });

  it('空数组按「全排」处理（与 null 同义，不让人白点一次）', () => {
    const p = planLaunchConfirm({ ...base, picks: [] });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.rows).toHaveLength(3);
  });
});

describe('planLaunchConfirm —— 必报：越权/过期/截单/越界全拦', () => {
  it('没有待确认草稿 → no_pending', () => {
    const p = planLaunchConfirm({ ...base, pending: null });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.code).toBe('no_pending');
  });

  it('草稿行数为 0 也当没有 → no_pending', () => {
    const p = planLaunchConfirm({ ...base, pending: { ...PENDING, rows: [] } });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.code).toBe('no_pending');
  });

  it('同事（staff）不能确认 → forbidden', () => {
    const p = planLaunchConfirm({ ...base, tier: 'staff' });
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.code).toBe('forbidden');
      expect(p.detail).toContain('负责人');
    }
  });

  it('隔天草稿 → expired（当日 24:00 失效）', () => {
    const p = planLaunchConfirm({ ...base, today: '2026-11-05' });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.code).toBe('expired');
  });

  it('已过截单 → cutoff', () => {
    const p = planLaunchConfirm({ ...base, afterCutoff: true });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.code).toBe('cutoff');
  });

  it('序号越界 → bad_pick，且点出是哪几条', () => {
    const p = planLaunchConfirm({ ...base, picks: [1, 9] });
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.code).toBe('bad_pick');
      expect(p.badPicks).toEqual([9]);
      expect(p.detail).toContain('9');
    }
  });

  it('★ 判据顺序：无权限的人不该看到「草稿已过期」这种内部状态', () => {
    const p = planLaunchConfirm({ ...base, tier: 'staff', today: '2026-11-06' });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.code).toBe('forbidden');
  });
});

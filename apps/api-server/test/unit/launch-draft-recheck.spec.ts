import {
  launchDraftText,
  revalidateLaunchDraft,
  type LaunchDraftRecheckCtx,
} from '../../src/common/utils/launch-draft';

/**
 * #1 自动开团 · 批 2 —— 「展示前实时复核」闸的判据
 *
 * 本文件钉死四件事：
 *   ① **必不报**：完全合法的草稿必须原样放行（防判据恒红、把正常链路卡死）；
 *   ② **必报**：编造 ID / 停用 / 日期错 / 重复 必须逐条拦下并给出人话原因（防恒绿）；
 *   ③ **`kind=fmcg` 必须拦**：生产库 `ab_set_meal` 里确有预包装快消品套餐，
 *      id 合法、状态正常，但绝不该进餐盒开团 —— 脚本侧只看 id，这个洞只能这里堵；
 *   ④ 脏数据**不许抛错**：开团链路不能因一条畸形草稿崩掉整段对话。
 */

const CTX: LaunchDraftRecheckCtx = {
  mealDate: '2026-11-05',
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
        groups: [{ id: 1, name: '量子大厦' }],
        templates: [{ id: 7, name: '牛肉双拼', priceFen: 2580 }],
      },
    );
    expect(r.blocked).toHaveLength(0);
    expect(r.rows).toHaveLength(1);
  });
});

describe('revalidateLaunchDraft —— 必报：该拦的一条都不许漏', () => {
  it('kind=fmcg 的模板必须拦（id 合法也不能开团）', () => {
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

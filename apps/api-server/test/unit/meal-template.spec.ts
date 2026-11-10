import {
  dishFitsKind,
  isCookedDish,
  revalidateMealTemplateDraft,
  type MealTemplateDraft,
} from '../../src/common/utils/meal-template';

/**
 * #A 供给侧 AI 建模板 · 确认前「实时复核」判据
 *
 * 钉死两件事：
 *   ① 必不报：合法的饭类一饭四菜 / 快消单品一律放行 —— 防判据恒假，把真草稿也拦掉。
 *   ② 必报：编造 id / 已下架 / 重复商品 / 缺档位 / 含主食档 / 重名 / 空项，
 *      全部拦截并给可展示的人话 —— 防判据失效，让脏草稿混进模板库。
 *
 * ⚠️ 必须与 scripts/gen-meal-template.mjs 的 validateTemplateDraft 同源：
 *   脚本管「生成时刻快照」，这里管「确认时刻实时集」。两者判据漂移会被本测试抓出。
 *
 * ⭐ 2026-11-10 加品类隔离：LIVE 夹具照**生产库真实形态**裁剪 ——
 *    现做菜 `category` 非空，独立预包装快消单品 `category` 为 NULL（服务层下发 ''）。
 */

const LIVE = [
  { id: 101, status: 1, category: 'main' },
  { id: 102, status: 1, category: 'half' },
  { id: 103, status: 1, category: 'veg' },
  { id: 104, status: 1, category: 'soup' },
  { id: 199, status: 0, category: 'main' }, // 已下架
  // 独立预包装快消单品（ab_item.category IS NULL）
  { id: 201, status: 1, category: '' },
  { id: 202, status: 1, category: '' },
  { id: 203, status: 1, category: '' },
];

function meal(
  items: Array<{ itemId: number; slot: number }>,
  name = '测试套餐',
): MealTemplateDraft {
  return { name, kind: 'meal', items };
}
function fmcg(
  items: Array<{ itemId: number; slot: number }>,
  name = '测试快消',
): MealTemplateDraft {
  return { name, kind: 'fmcg', items };
}

describe('revalidateMealTemplateDraft · 必不报（合法草稿放行）', () => {
  const ctx = { dishes: LIVE, existingNames: new Set<string>() };

  it('饭类一饭四菜全放行', () => {
    const r = revalidateMealTemplateDraft(
      meal([
        { itemId: 101, slot: 1 },
        { itemId: 102, slot: 2 },
        { itemId: 103, slot: 3 },
        { itemId: 104, slot: 4 },
      ]),
      ctx,
    );
    expect(r.ok).toBe(true);
  });

  it('快消单品 slot=3 放行', () => {
    const r = revalidateMealTemplateDraft(fmcg([{ itemId: 201, slot: 3 }]), ctx);
    expect(r.ok).toBe(true);
  });

  it('快消多件任意档位放行', () => {
    const r = revalidateMealTemplateDraft(
      fmcg([
        { itemId: 201, slot: 1 },
        { itemId: 202, slot: 2 },
        { itemId: 203, slot: 4 },
      ]),
      ctx,
    );
    expect(r.ok).toBe(true);
  });
});

describe('revalidateMealTemplateDraft · 必报（违规草稿拦截）', () => {
  const ctx = { dishes: LIVE, existingNames: new Set<string>() };

  it('编造菜品 id → unknown_dish', () => {
    const r = revalidateMealTemplateDraft(
      meal([
        { itemId: 999, slot: 1 },
        { itemId: 102, slot: 2 },
        { itemId: 103, slot: 3 },
        { itemId: 104, slot: 4 },
      ]),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blocked.code).toBe('unknown_dish');
  });

  it('已下架菜品 → off_shelf', () => {
    const r = revalidateMealTemplateDraft(
      meal([
        { itemId: 101, slot: 1 },
        { itemId: 199, slot: 2 },
        { itemId: 103, slot: 3 },
        { itemId: 104, slot: 4 },
      ]),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blocked.code).toBe('off_shelf');
  });

  it('饭类缺档位（少素品）→ composition', () => {
    const r = revalidateMealTemplateDraft(
      meal([
        { itemId: 101, slot: 1 },
        { itemId: 102, slot: 2 },
        { itemId: 104, slot: 4 },
      ]),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blocked.code).toBe('composition');
  });

  it('饭类含主食档 slot=5 → composition', () => {
    const r = revalidateMealTemplateDraft(
      meal([
        { itemId: 101, slot: 1 },
        { itemId: 102, slot: 2 },
        { itemId: 103, slot: 3 },
        { itemId: 104, slot: 5 },
      ]),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blocked.code).toBe('composition');
  });

  it('重复商品项 → dup_item', () => {
    const r = revalidateMealTemplateDraft(
      meal([
        { itemId: 101, slot: 1 },
        { itemId: 101, slot: 2 },
        { itemId: 103, slot: 3 },
        { itemId: 104, slot: 4 },
      ]),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blocked.code).toBe('dup_item');
  });

  it('非法档位 → bad_shape', () => {
    const r = revalidateMealTemplateDraft(
      meal([
        { itemId: 101, slot: 1 },
        { itemId: 102, slot: 9 },
        { itemId: 103, slot: 3 },
        { itemId: 104, slot: 4 },
      ]),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blocked.code).toBe('bad_shape');
  });

  it('空商品项 → empty', () => {
    const r = revalidateMealTemplateDraft(meal([]), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blocked.code).toBe('empty');
  });

  it('空模板名 → bad_shape', () => {
    const r = revalidateMealTemplateDraft(meal([{ itemId: 101, slot: 1 }], ''), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blocked.code).toBe('bad_shape');
  });
});

describe('品类隔离 · 判据自证（与脚本 filterDishesByKind 同源）', () => {
  it.each([
    ['main', true],
    ['veg', true],
    [' ', false],
    ['', false],
    [null, false],
  ])('isCookedDish(%p) → %p', (c, expected) => {
    expect(isCookedDish(c as string | null)).toBe(expected);
  });

  it('dishFitsKind：fmcg 只收空品类，meal 只收现做菜', () => {
    expect(dishFitsKind('fmcg', '')).toBe(true);
    expect(dishFitsKind('fmcg', null)).toBe(true);
    expect(dishFitsKind('fmcg', 'main')).toBe(false);
    expect(dishFitsKind('meal', 'main')).toBe(true);
    expect(dishFitsKind('meal', '')).toBe(false);
  });
});

describe('品类隔离 · 必报 / 必不报（2026-11-10）', () => {
  const ctx = { dishes: LIVE, existingNames: new Set<string>() };

  it('★ 必报：快消模板混入现做菜 → kind_mismatch（旧版会放行）', () => {
    const r = revalidateMealTemplateDraft(fmcg([{ itemId: 101, slot: 1 }]), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.blocked.code).toBe('kind_mismatch');
      expect(r.blocked.detail).toContain('现做菜');
    }
  });

  it('★ 必报：饭类模板混入快消单品 → kind_mismatch（反向也堵）', () => {
    const r = revalidateMealTemplateDraft(
      meal([
        { itemId: 101, slot: 1 },
        { itemId: 102, slot: 2 },
        { itemId: 103, slot: 3 },
        { itemId: 201, slot: 4 },
      ]),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blocked.code).toBe('kind_mismatch');
  });

  it('必不报：纯快消多件（含 slot=5）放行 —— 判据不恒红', () => {
    const r = revalidateMealTemplateDraft(
      fmcg([
        { itemId: 201, slot: 1 },
        { itemId: 202, slot: 2 },
        { itemId: 203, slot: 5 },
      ]),
      ctx,
    );
    expect(r.ok).toBe(true);
  });

  it('必不报：纯现做菜饭类一饭四菜照常放行 —— 将来开盒饭不用改判据', () => {
    const r = revalidateMealTemplateDraft(
      meal([
        { itemId: 101, slot: 1 },
        { itemId: 102, slot: 2 },
        { itemId: 103, slot: 3 },
        { itemId: 104, slot: 4 },
      ]),
      ctx,
    );
    expect(r.ok).toBe(true);
  });
});

describe('revalidateMealTemplateDraft · 重名检测', () => {
  const ctx = { dishes: LIVE, existingNames: new Set(['牛肉双拼']) };

  it('与现有模板同名 → dup_name', () => {
    const r = revalidateMealTemplateDraft(
      meal(
        [
          { itemId: 101, slot: 1 },
          { itemId: 102, slot: 2 },
          { itemId: 103, slot: 3 },
          { itemId: 104, slot: 4 },
        ],
        '牛肉双拼',
      ),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blocked.code).toBe('dup_name');
  });

  it('大小写/空白差异仍判重名', () => {
    const r = revalidateMealTemplateDraft(
      meal(
        [
          { itemId: 101, slot: 1 },
          { itemId: 102, slot: 2 },
          { itemId: 103, slot: 3 },
          { itemId: 104, slot: 4 },
        ],
        ' 牛肉双拼 ',
      ),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blocked.code).toBe('dup_name');
  });
});

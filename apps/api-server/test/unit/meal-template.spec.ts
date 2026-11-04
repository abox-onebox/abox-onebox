import {
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
 */

const LIVE = [
  { id: 101, status: 1 },
  { id: 102, status: 1 },
  { id: 103, status: 1 },
  { id: 104, status: 1 },
  { id: 199, status: 0 }, // 已下架
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
    const r = revalidateMealTemplateDraft(fmcg([{ itemId: 103, slot: 3 }]), ctx);
    expect(r.ok).toBe(true);
  });

  it('快消多件任意档位放行', () => {
    const r = revalidateMealTemplateDraft(
      fmcg([
        { itemId: 101, slot: 1 },
        { itemId: 102, slot: 2 },
        { itemId: 103, slot: 4 },
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

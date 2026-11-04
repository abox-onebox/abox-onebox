import {
  allItems,
  canExec,
  displayName,
  find,
  isMoneyView,
  moduleOf,
  modules,
  riskOf,
  search,
  TIER_ROLE,
} from '../../src/modules/wecom-kb/op-policy';
import {
  ADMIN_CATALOG,
  ADMIN_ENDPOINT_COUNT,
} from '../../src/modules/wecom-kb/op-catalog.generated';
import type { CatalogEntry } from '../../src/modules/wecom-kb/op-catalog.types';

/**
 * 操作权限策略判据
 *
 * 这一层的错法都很难看：
 *   · 把 owner 判成不可用 ⇒ 负责人自己「什么都干不了」，功能等于没做；
 *   · 把 staff 判成可用 ⇒ 同事能动钱，是真实资损。
 * 所以两头都要钉死，而不是只测「能不能过」。
 */

const entry = (patch: Partial<CatalogEntry>): CatalogEntry => ({
  method: 'POST',
  path: '/admin/meal/assignments',
  label: '测试端点',
  roles: ['super_admin', 'admin', 'operator'],
  source: 'test:1',
  params: [],
  ...patch,
});

describe('op-policy · 目录规模', () => {
  /**
   * 这里**刻意不写死条数**（2026-11-04 修正）。
   *
   * 原先是 `expect(ADMIN_ENDPOINT_COUNT).toBe(137)` —— 那是把常量与字面量比，
   * 每加一个后台端点都得改一次测试，改的人只会照着报错数字填，等于**训练自己忽略它**。
   * 而「目录与源码是否同步」本来就是 `wecom:catalog` 门禁的职责（它重新解析源码再比对）。
   *
   * 保留下来的是**真正的交叉校验**：常量 vs 实际展开后的条目 vs 字典键数，
   * 三者不等就说明生成器少写/多写了条目 —— 这才是有价值的判据。
   */
  it('常量、展开条目、字典键数三者一致（漂移由 wecom:catalog 门禁把守）', () => {
    expect(ADMIN_ENDPOINT_COUNT).toBeGreaterThan(0);
    expect(allItems().length).toBe(ADMIN_ENDPOINT_COUNT);
    expect(Object.keys(ADMIN_CATALOG).length).toBe(ADMIN_ENDPOINT_COUNT);
  });

  it('每条都能定位到源码位置（否则改端点后无从核对漂移）', () => {
    for (const it of allItems()) {
      expect(it.entry.source).toMatch(/\.ts:\d+$/);
    }
  });
});

describe('op-policy · 负责人拥有全部权限', () => {
  it('★ 全部端点对 owner 都可执行（这是本功能的核心诉求）', () => {
    const blocked = allItems().filter((it) => !canExec('owner', it.entry).ok);
    expect(blocked.map((b) => b.code)).toEqual([]);
  });

  it('owner 执行身份是 admin 角色', () => {
    expect(TIER_ROLE.owner).toBe('admin');
    expect(TIER_ROLE.staff).toBe('operator');
  });
});

describe('op-policy · 同事受限', () => {
  it('staff 可用数 = 源码 @Roles 含 operator 的端点数', () => {
    const should = allItems().filter((it) => it.entry.roles.includes('operator')).length;
    const actual = allItems().filter((it) => canExec('staff', it.entry).ok).length;
    // staff 里凡被判 high 的会被拦，故 actual <= should，且差额只来自高危项
    expect(actual).toBeLessThanOrEqual(should);
    const highBlocked = allItems().filter(
      (it) =>
        it.entry.roles.includes('operator') &&
        riskOf(it.entry) === 'high' &&
        !canExec('staff', it.entry).ok,
    ).length;
    // ⭐ 第三个桶（2026-11-02 加）：钱的口径（`/admin/stats/*`）。
    //   这些是 GET、源码 @Roles 本来就含 operator，靠 risk 与角色都判不出来 ——
    //   是**额外加的一条规则**，所以必须在这里显式减掉，否则这个等式会莫名其妙差 6。
    const moneyBlocked = allItems().filter(
      (it) =>
        it.entry.roles.includes('operator') &&
        isMoneyView(it.entry) &&
        !canExec('staff', it.entry).ok,
    ).length;
    // 反过来盯住「桶是空的」：若哪天 isMoneyView 判据失效，上面那个等式会**恒真**（两边一起变），
    // 这条断言就是那个情况的探针。
    expect(moneyBlocked).toBeGreaterThan(0);
    expect(actual).toBe(should - highBlocked - moneyBlocked);
  });

  it('★ 财务退款审批：同事做不了（后台角色不含 operator）', () => {
    const it = find('post_admin_finance_refunds_id_approve');
    expect(it).toBeDefined();
    const r = canExec('staff', it!.entry);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('后台只允许');
    expect(canExec('owner', it!.entry).ok).toBe(true);
  });

  it('★ 批量发券：即使 operator 有端点权限，high 也拦下（动钱）', () => {
    const it = find('post_admin_coupon_grantbatch');
    expect(it).toBeDefined();
    expect(it!.entry.roles).toContain('operator');
    expect(riskOf(it!.entry)).toBe('high');
    expect(canExec('staff', it!.entry).ok).toBe(false);
    expect(canExec('owner', it!.entry).ok).toBe(true);
  });

  it('日常排套餐同事能干（mid + operator）', () => {
    const it = find('post_admin_meal_assignments');
    expect(it).toBeDefined();
    expect(riskOf(it!.entry)).toBe('mid');
    expect(canExec('staff', it!.entry).ok).toBe(true);
  });
});

describe('op-policy · 危险分级', () => {
  it('GET 一律只读，DELETE 一律高危', () => {
    expect(riskOf(entry({ method: 'GET', path: '/admin/orders' }))).toBe('low');
    expect(riskOf(entry({ method: 'DELETE', path: '/admin/meal/assignments/:id' }))).toBe('high');
  });

  it('财务/订单/团长模块的写操作一律高危', () => {
    for (const p of [
      '/admin/finance/x',
      '/admin/orders/x',
      '/admin/leaders/x',
      '/admin/system/x',
    ]) {
      expect(riskOf(entry({ method: 'POST', path: p }))).toBe('high');
    }
  });

  it('普通写操作是 mid（不是高危，别把日常也拦掉）', () => {
    expect(riskOf(entry({ method: 'POST', path: '/admin/meal/templates' }))).toBe('mid');
  });
});

describe('op-policy · 未标角色的端点不默认放行', () => {
  const e = entry({ roles: [] });

  it('staff 不可执行', () => {
    const r = canExec('staff', e);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('只有负责人');
  });

  it('owner 可执行但带提示（源码缺 @Roles 是待补的债，不是设计）', () => {
    const r = canExec('owner', e);
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('没有标注角色');
  });
});

describe('op-policy · 检索与展示', () => {
  it('搜「退款」能命中退款相关端点，且都对该 tier 可用', () => {
    const hits = search('退款', 'owner', 8);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(canExec('owner', h.entry).ok).toBe(true);
  });

  it('同事搜不到自己不能做的端点（列表里不该出现点了就被拒的项）', () => {
    const hits = search('退款', 'staff', 8);
    for (const h of hits) expect(canExec('staff', h.entry).ok).toBe(true);
  });

  it('空关键词返回空，不返回全量（避免误把目录当搜索）', () => {
    expect(search('', 'owner')).toEqual([]);
  });

  it('展示名去掉后台 summary 的编号前缀', () => {
    expect(displayName(entry({ label: 'D41 审批通过 → 实际退款' }))).toBe('审批通过 → 实际退款');
  });

  it('模块分组总数等于目录规模', () => {
    const sum = modules('owner').reduce((a, m) => a + m.total, 0);
    expect(sum).toBe(ADMIN_ENDPOINT_COUNT);
  });

  it('模块名取路径第 2 段', () => {
    expect(moduleOf(entry({ path: '/admin/finance/refunds' }))).toBe('finance');
  });
});

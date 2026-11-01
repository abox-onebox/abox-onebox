import {
  allItems,
  canExec,
  find,
  isGranted,
  itemsOfModule,
  moduleOf,
  modules,
  normalizeGrant,
  riskOf,
  search,
  usableCount,
} from '../../src/modules/wecom-kb/op-policy';
import type { Tier } from '../../src/modules/wecom-kb/op-policy';

/**
 * 按功能项放权（`grantedOps`）判据
 *
 * 这个功能的风险形状与前一轮不同：它**故意**让人越过后台 @Roles，
 * 一旦判据写错，代价是「随手放的权顺手把账也放了」。所以三件事必须钉死：
 *
 *   1. **不放权 = 行为完全不变**（granted 为空时可用集合必须与加这功能之前逐条相等）；
 *   2. **放权精确**：只放 A 不能让 B 也能做（穷举每个端点各自放一次来证）；
 *   3. **收回立刻失效**：清空清单后可用集合回到基线，不留任何残留。
 *
 * 另一条容易被忽略的④：**少了 code 就不放行**。
 * 调用方若忘记把端编码传进来，`granted` 里哪怕有这一项也不该生效 ——
 * 否则「传参遗漏」会静默变成「全通」，这类缺陷上线后看不出来。
 */

/** 加放权功能之前的 staff 可用集合；即「基线」，用来证明不回归 */
const staffBaseline = (): Set<string> =>
  new Set(
    allItems()
      .filter((it) => canExec('staff', it.entry).ok)
      .map((it) => it.code),
  );

describe('放权 · 不回归（没放权时行为与之前完全一致）', () => {
  it('★ granted 为空数组 / 不传 / undefined 三种写法，可用集合与基线逐条相等', () => {
    const base = staffBaseline();
    expect(base.size).toBeGreaterThan(0); // 集合为空会让下面所有比较自动成立，先自证非空

    for (const granted of [[], undefined] as Array<string[] | undefined>) {
      const now = new Set(
        allItems()
          .filter((it) => canExec('staff', it.entry, { granted, code: it.code }).ok)
          .map((it) => it.code),
      );
      expect([...now].sort()).toEqual([...base].sort());
    }
  });

  it('usableCount 与逐条判定同源（少一个就说明两处判据写岔了）', () => {
    const base = staffBaseline();
    expect(usableCount('staff')).toBe(base.size);
    expect(usableCount('owner')).toBe(allItems().length);
  });
});

describe('放权 · 缺 code 不放行（防止传参遗漏变成全通）', () => {
  it('传了清单但没传 code：不生效，仍按原权限判定', () => {
    const it = find('post_admin_finance_refunds_id_approve');
    expect(it).toBeDefined();
    const r = canExec('staff', it!.entry, { granted: [it!.code] });
    expect(r.ok).toBe(false);
    expect(isGranted('staff', undefined, [it!.code])).toBe(false);
  });

  it('isGranted 只认精确编码，不做前缀/模糊匹配（否则放一个等于放一片）', () => {
    const it = find('post_admin_finance_refunds_id_approve')!;
    expect(isGranted('staff', it.code, [it.code])).toBe(true);
    expect(isGranted('staff', it.code, [it.code + 'x'])).toBe(false);
    expect(isGranted('staff', it.code + 'x', [it.code])).toBe(false);
    expect(isGranted('staff', it.code, [it.code.slice(0, -1)])).toBe(false);
  });

  it('owner 不靠放权（本来全通），isGranted 对 owner 恒 false', () => {
    const it = find('post_admin_meal_assignments')!;
    expect(isGranted('owner', it.code, [it.code])).toBe(false);
  });
});

describe('放权 · 生效且精确', () => {
  it('★ 退款审批：不放权做不了 → 放权后能做（这正是「张三能批、李四不能」）', () => {
    const it = find('post_admin_finance_refunds_id_approve');
    expect(it).toBeDefined();
    expect(canExec('staff', it!.entry, { code: it!.code }).ok).toBe(false);

    const granted = canExec('staff', it!.entry, { granted: [it!.code], code: it!.code });
    expect(granted.ok).toBe(true);
    expect(granted.reason).toContain('单独放给你');
  });

  it('★ 穷举：任意一个端点单独放权后，只它自己变成可用，其余一条不多', () => {
    const base = staffBaseline();
    const all = allItems();
    const leaks: string[] = [];

    for (const target of all) {
      const after = new Set(
        all
          .filter((it) => canExec('staff', it.entry, { granted: [target.code], code: it.code }).ok)
          .map((it) => it.code),
      );
      // 期望 = 基线 ∪ {target}
      const expected = new Set(base).add(target.code);
      if (after.size !== expected.size) {
        leaks.push(`${target.code} 数量 ${after.size} ≠ ${expected.size}`);
        continue;
      }
      for (const c of expected) if (!after.has(c)) leaks.push(`${target.code} 少了 ${c}`);
      for (const c of after) if (!expected.has(c)) leaks.push(`${target.code} 多出 ${c}`);
    }

    // 一条都不许有：多出=越权，少了=放权无效
    expect(leaks).toEqual([]);
  });

  it('★ 收回放权：清空清单后回到基线，不留残留', () => {
    const target = find('post_admin_finance_refunds_id_approve')!;
    expect(canExec('staff', target.entry, { granted: [target.code], code: target.code }).ok).toBe(
      true,
    );

    const afterRevoke = new Set(
      allItems()
        .filter((it) => canExec('staff', it.entry, { granted: [], code: it.code }).ok)
        .map((it) => it.code),
    );
    expect([...afterRevoke].sort()).toEqual([...staffBaseline()].sort());
    expect(canExec('staff', target.entry, { granted: [], code: target.code }).ok).toBe(false);
  });

  it('放权对 owner 无副作用（owner 全通，传清单不会让他变少）', () => {
    const target = allItems()[0];
    const blocked = allItems().filter(
      (it) => !canExec('owner', it.entry, { granted: [target.code], code: it.code }).ok,
    );
    expect(blocked.map((b) => b.code)).toEqual([]);
  });
});

describe('放权 · 展示层与执行层同源（目录/搜索也必须认清单）', () => {
  const target = find('post_admin_finance_refunds_id_approve')!;
  const mod = moduleOf(target.entry);

  it('搜索命中：不放权搜不到，放权后能搜到', () => {
    const kw = '退款';
    const before = search(kw, 'staff', 8).map((x) => x.code);
    const after = search(kw, 'staff', 8, [target.code]).map((x) => x.code);
    expect(before).not.toContain(target.code);
    expect(after).toContain(target.code);
  });

  it('模块明细：放权项出现在该模块的可做列表里', () => {
    const before = itemsOfModule(mod, 'staff', true).map((x) => x.code);
    const after = itemsOfModule(mod, 'staff', true, [target.code]).map((x) => x.code);
    expect(before).not.toContain(target.code);
    expect(after).toContain(target.code);
  });

  it('模块计数：该模块 allowed 恰好 +1（不多不少）', () => {
    const pick = (g?: string[]): number => {
      const m = modules('staff', g).find((x) => x.module === mod);
      return m ? m.allowed : -1;
    };
    const before = pick();
    expect(before).toBeGreaterThanOrEqual(0);
    expect(pick([target.code])).toBe(before + 1);
  });

  it('放权的都是高危项时不改变 risk 判定（授权不等于降级风险提示）', () => {
    expect(riskOf(target.entry)).toBe('high');
    const r = canExec('staff', target.entry, { granted: [target.code], code: target.code });
    expect(r.risk).toBe('high');
  });
});

describe('放权 · 清单规整 normalizeGrant', () => {
  it('剔除目录里不存在的编码（路由改名后残留的死编码）', () => {
    const r = normalizeGrant(['不存在的编码', 'post_admin_meal_assignments']);
    expect(r.valid).toEqual(['post_admin_meal_assignments']);
    expect(r.unknown).toEqual(['不存在的编码']);
  });

  it('去重 + 去空 + 保持顺序', () => {
    const r = normalizeGrant([
      'post_admin_meal_assignments',
      '',
      '  ',
      'post_admin_meal_assignments',
      'post_admin_finance_refunds_id_approve',
    ]);
    expect(r.valid).toEqual([
      'post_admin_meal_assignments',
      'post_admin_finance_refunds_id_approve',
    ]);
    expect(r.unknown).toEqual([]);
  });

  it('脏输入不炸（null / undefined / 字符串 / 数字混入）', () => {
    expect(normalizeGrant(null)).toEqual({ valid: [], unknown: [] });
    expect(normalizeGrant(undefined)).toEqual({ valid: [], unknown: [] });
    expect(normalizeGrant('post_admin_meal_assignments')).toEqual({ valid: [], unknown: [] });
    expect(normalizeGrant([12, null]).valid).toEqual([]);
  });

  it('★ 规整后的清单能真的生效（防止「存进去的是另一种形状」）', () => {
    const raw = ['post_admin_finance_refunds_id_approve', 'dead_code_xxx'];
    const { valid } = normalizeGrant(raw);
    expect(valid).toEqual(['post_admin_finance_refunds_id_approve']);
    const it = find(valid[0])!;
    expect(canExec('staff', it.entry, { granted: valid, code: it.code }).ok).toBe(true);
  });
});

describe('放权 · tier 类型边界', () => {
  it('两个 tier 都只接受字面量（防止调用方塞进第三个值被当成 staff 静默降级）', () => {
    const tiers: Tier[] = ['owner', 'staff'];
    for (const t of tiers) {
      // 不断言具体结果，只断言「有明确结论且不抛」
      expect(() => canExec(t, find('post_admin_meal_assignments')!.entry)).not.toThrow();
    }
  });
});

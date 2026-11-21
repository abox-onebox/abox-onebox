import { APPROVABLE_ADMIN_OPS } from '../../src/modules/admin/operation-request/dto/operation-request.dto';
import {
  OP_SCHEMAS,
  validateOpParams,
} from '../../src/modules/admin/operation-request/operation-schema';

/**
 * 高危审批 · 结构化参数声明判据（2026-11-21）
 *
 * 本文件钉死三件在人工测试里最容易「点了没反应 / 执行才炸」的事：
 *   ① **三处集合同源**：schema 覆盖的 op 必须与提交白名单 `APPROVABLE_ADMIN_OPS` 完全相等。
 *      本批之前正是 schema 11 个、白名单 9 个 ⇒ 两个停用类 op 后台提交恒 10001。
 *   ② **必报**：每个 op 传空对象都必须报必填，防止某 op 的 required 整列漏标
 *      ⇒ 表单全空也能提交、到执行期才炸（错误没前移）。
 *   ③ **必不报**：按每个 schema 的必填字段自动生成一份**合法参数**（真实未改动的声明），
 *      校验必须零错误；否则「表单填完还是提交不了」——比没校验更糟。
 *
 * 另钉死一个真实边界：`0` 与 `false` 是**有效值**（金额 0 分、dryRun=false、status=0 下架），
 * 绝不能被当成「没填」。历史坑是把判据写成 `!v` 会把它们全误杀。
 */

describe('OP_SCHEMAS · 与提交白名单同源', () => {
  it('恰好 11 个 op，且 opCode 无重复', () => {
    expect(OP_SCHEMAS).toHaveLength(11);
    const codes = OP_SCHEMAS.map((s) => s.opCode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('schema 集合 === APPROVABLE_ADMIN_OPS（不重不漏）', () => {
    const schemaCodes = [...OP_SCHEMAS.map((s) => s.opCode)].sort();
    const allowCodes = [...APPROVABLE_ADMIN_OPS].sort();
    expect(schemaCodes).toEqual(allowCodes);
  });

  it.each(OP_SCHEMAS)('$opCode：effect 非空、字段非空、字段 key 不重复', (s) => {
    expect(s.effect.trim().length).toBeGreaterThan(0);
    expect(s.fields.length).toBeGreaterThan(0);
    const keys = s.fields.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('validateOpParams · 必报样本（空对象必被拦）', () => {
  // 11 个 op 全部用同一个空对象输入：每个都至少有一个 required 字段
  it.each(OP_SCHEMAS.map((s) => s.opCode))('%s 传空对象必须报错', (code) => {
    const errs = validateOpParams(code, {});
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.every((e) => e.includes('必填'))).toBe(true);
  });

  it('未知 op 报错', () => {
    expect(validateOpParams('not_a_real_op', { id: 1 })).toEqual(['未知操作类型 not_a_real_op']);
  });

  it.each([null, undefined, [], 'x', 42])('参数不是对象（%p）一律报错', (bad) => {
    expect(validateOpParams('create_dish', bad)).toEqual(['参数必须是对象']);
  });
});

describe('validateOpParams · 必不报样本（合法参数零错误）', () => {
  /** 按 schema 的必填字段生成合法值——值来自声明本身，不是凭印象手打 */
  function legalParams(code: string): Record<string, unknown> {
    const schema = OP_SCHEMAS.find((s) => s.opCode === code)!;
    const out: Record<string, unknown> = {};
    for (const f of schema.fields) {
      if (!f.required) continue;
      out[f.key] =
        f.type === 'int'
          ? 1
          : f.type === 'ints'
            ? [1, 2]
            : f.type === 'boolean'
              ? false
              : f.options?.length
                ? f.options[0].value
                : 'x';
    }
    return out;
  }

  it.each(OP_SCHEMAS.map((s) => s.opCode))('%s 用声明里的必填字段填全，必须零错误', (code) => {
    expect(validateOpParams(code, legalParams(code))).toEqual([]);
  });

  it('0 与 false 是有效值，不能被当成「没填」', () => {
    // status=0（下架）与 dryRun=false（真发）都是业务上的合法选择
    expect(validateOpParams('batch_dish_status', { ids: [1], status: 0 })).toEqual([]);
    expect(
      validateOpParams('send_message', { scene: 'cutoff_remind', audience: 'all', dryRun: false }),
    ).toEqual([]);
  });

  it.each([undefined, null, '', []])('空值 %p 才算没填', (empty) => {
    expect(validateOpParams('create_dish', { supplierId: empty })).toContain('供应商 ID 必填');
  });
});

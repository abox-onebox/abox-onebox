import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BuildingGroupStatus, BuildingStatus } from '@abox/shared-types';

import {
  AvailabilityInput,
  REASON_TEXT,
  StructureBlockReason,
  StructureScope,
  evaluateAvailability,
  evaluateStructure,
  reasonText,
} from '../../src/common/utils/orderability';

/**
 * 可订性判据（N1 · 见 `docs/decisions/ADR-N1N2W1-楼宇停用与一键停售.md`）
 * ⚠️ 为什么必须有单测：抽纯函数的**全部收益就在可测性上** —— 没有单测时这次抽取只剩搬家的
 *    成本，判据散在四处的病根（改一边漏一边、两边都不报错）不会因为有纯函数而自动消失。
 * ⚠️ 断言一律用**枚举名**而非数字字面量：枚举值一调整，字面量用例会继续绿着而判据已翻。
 */
const structure = (s: Partial<StructureScope>): StructureScope => ({
  buildingStatus: BuildingStatus.ACTIVE,
  buildingGroupId: 7,
  buildingGroupStatus: BuildingGroupStatus.ACTIVE,
  ...s,
});

/** 时间层基准：开团 09-15 14:00、截单 09-16 00:00（UTC+8），截单窗口 10 分钟 */
const PUBLISH_MS = Date.parse('2026-09-15T06:00:00Z');
const CUTOFF_MS = Date.parse('2026-09-15T16:00:00Z');
const WINDOW_MIN = 10;

const input = (i: Partial<AvailabilityInput>): AvailabilityInput => ({
  ...structure({}),
  assignmentStatus: 'active',
  salesPaused: false,
  cutoffWindowMinutes: WINDOW_MIN,
  publishAtMs: PUBLISH_MS,
  cutoffAtMs: CUTOFF_MS,
  nowMs: PUBLISH_MS,
  ...i,
});

describe('evaluateStructure（结构层 · 管家端与用户端共用）', () => {
  it('四条阻断原因各一例 + 可下单一例', () => {
    const cases: [Partial<StructureScope>, StructureBlockReason | null][] = [
      [{ buildingGroupId: null }, 'building_not_grouped'],
      [{ buildingStatus: BuildingStatus.PREPARING }, 'building_preparing'],
      [{ buildingStatus: BuildingStatus.SUSPENDED }, 'building_suspended'],
      [{ buildingGroupStatus: BuildingGroupStatus.SUSPENDED }, 'group_suspended'],
      [{}, null],
    ];
    for (const [patch, reason] of cases) {
      expect(evaluateStructure(structure(patch))).toEqual({ ok: reason === null, reason });
    }
  });

  /** ⚠️ fail-open 定向回归（**同一个 bug 的左右两半**）：存在性判定漏一个字段，对应的
   *    「记录不可达」输入就四步全过、返回 `ok:true`。左半 = 楼不存在但 groupId 有值；右半 =
   *    楼群状态为 null（相等判定天然漏 null）。两次都编译过、跑得过、验收句式全绿。 */
  it('★ fail-open 回归：楼 / 楼群记录不可达都不得判可下单', () => {
    const unreachable: StructureScope[] = [
      { buildingStatus: null, buildingGroupId: 7, buildingGroupStatus: BuildingGroupStatus.ACTIVE },
      { buildingStatus: BuildingStatus.ACTIVE, buildingGroupId: 7, buildingGroupStatus: null },
    ];
    for (const s of unreachable) {
      expect(evaluateStructure(s)).toEqual({ ok: false, reason: 'building_not_grouped' });
    }
  });

  /** ⚠️ 与上条配对：**修 fail-open 不得把语义判定修没了** —— `group_suspended` 靠第 4 条的相等
   *    判定产出，存在性已移交第 1 条但第 4 条不许删。同时钉住顺序：楼为 null 时恒为
   *    `building_not_grouped`。 */
  it('★ 顺序护栏：group_suspended 仍在，且楼不存在时楼群状态不参与判定', () => {
    const suspended = structure({ buildingGroupStatus: BuildingGroupStatus.SUSPENDED });
    expect(evaluateStructure(suspended).reason).toBe('group_suspended');
    expect(evaluateStructure({ ...suspended, buildingStatus: null }).reason).toBe(
      'building_not_grouped',
    );
  });
});

describe('evaluateAvailability（用户端完整谓词）', () => {
  it('★ 停售优先级最高：先于结构层与时间层', () => {
    expect(
      evaluateAvailability(
        input({ salesPaused: true, buildingStatus: BuildingStatus.SUSPENDED, nowMs: CUTOFF_MS }),
      ).reason,
    ).toBe('sales_paused');
  });

  it('时间层边界：nowMs 恰等于 publishAtMs ⇒ 已开团（左闭）', () => {
    expect(evaluateAvailability(input({ nowMs: PUBLISH_MS })).canOrder).toBe(true);
    expect(evaluateAvailability(input({ nowMs: PUBLISH_MS - 1 })).reason).toBe('not_open_yet');
  });

  it('时间层边界：nowMs 恰等于 cutoffAtMs − window ⇒ 已截单（右开）', () => {
    const edge = CUTOFF_MS - WINDOW_MIN * 60_000;
    expect(evaluateAvailability(input({ nowMs: edge })).reason).toBe('cutoff');
    expect(evaluateAvailability(input({ nowMs: edge - 1 })).canOrder).toBe(true);
  });

  it('编排层：未上架 ⇒ meal_not_published，且优先于时间层', () => {
    const r = evaluateAvailability(input({ assignmentStatus: 'pending' })).reason;
    expect(r).toBe('meal_not_published');
  });
});

describe('reasonText（文案唯一出口）', () => {
  const ctx = { publishAtMs: PUBLISH_MS, cutoffAtMs: CUTOFF_MS, cutoffWindowMinutes: WINDOW_MIN };

  it('★ not_open_yet / cutoff 插值后必须是非空串（表里是空串，漏插值 = 空文案）', () => {
    expect(reasonText('not_open_yet', ctx)).toBe('今日 14:00 开团，敬请期待');
    expect(reasonText('cutoff', ctx)).toBe('距截单不足 10 分钟，请明日再订');
  });

  /**
   * ⭐ W1：`sales_paused` 现在是**第三个插值值**（`not_open_yet` / `cutoff` 之后）。
   *
   * ⚠️ 表里那句带 `{reason}` 占位符，是**唯一**敢这么写的一条 —— 因为 `reasonText()`
   *    有它的专属 case + 缺失回落。下面两条一起锁住这个契约：
   *      · 有运营原因 ⇒ 原样下发（用户真正想知道的是「为什么停」）；
   *      · 没有 ⇒ 回落静态句，且**绝不**把 `{reason}` 原样下发给用户
   *        （那是一条看起来完全正常的假文案，比空文案更难发现）。
   */
  it('★ sales_paused：有 reason 则原样下发；无 reason 则回落且不得漏出占位符', () => {
    const why = '全区消杀，暂停接单';
    expect(reasonText('sales_paused', { ...ctx, salesPauseReason: why })).toBe(
      `今日暂停接单：${why}`,
    );
    const bare = reasonText('sales_paused', ctx);
    expect(bare).toBe('今日暂停接单');
    expect(bare).not.toContain('{reason}');
    expect(bare).not.toContain('：');
  });

  it('其余五值恒等于查表结果（不得出现第二份文案）', () => {
    const rest = [
      'building_not_grouped',
      'building_preparing',
      'building_suspended',
      'group_suspended',
      'meal_not_published',
    ] as (keyof typeof REASON_TEXT)[];
    for (const r of rest) {
      expect(reasonText(r, ctx)).toBe(REASON_TEXT[r]);
      expect(reasonText(r, ctx).length).toBeGreaterThan(0);
    }
  });
});

/** ⚠️ 用「读源码」而非「看 import 形状」：要守的是「有没有引入第二个时间源」，不是「有没有
 *    import 某个符号」—— 按 import 形状写会漏掉「把时间写进模板串」这类无 import 的回归。 */
describe('纯函数约束', () => {
  const src = readFileSync(join(__dirname, '../../src/common/utils/orderability.ts'), 'utf8');

  it('★ 不读时钟：无参 new Date() 与 Date.now() 命中数为 0', () => {
    expect(src.match(/new\s+Date\(\s*\)/g) ?? []).toHaveLength(0);
    expect(src.match(/Date\.now\s*\(/g) ?? []).toHaveLength(0);
  });

  it('不取数、不抛码：零 Repository 注入、零 throw', () => {
    expect(src).not.toMatch(/Repository/);
    expect(src).not.toMatch(/\bthrow\b/);
  });
});

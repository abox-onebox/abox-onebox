/**
 * 可订性判据（**唯一真源** · N1 / N2 / W1 · 见 `docs/decisions/ADR-N1N2W1-楼宇停用与一键停售.md`）
 *
 * 「这栋楼现在能不能下单」要在四个入口各答一次（U1 首页 / U6 下单 / 团长工作台 /
 * 管家端楼栋列表）。判据散在四处的必然结果是**改一边、漏一边**：「A 页面说能订、
 * B 页面说不能订」且两边都不报错 —— M5-17 缺陷 ⑫ 的同族病根。
 *
 * ⚠️ 边界：只回答**真假与原因** —— 不取数（归 `OrderAvailabilityService`）、不抛码
 *    （抛什么是**调用方**的契约责任）、不拼动态文案（`REASON_TEXT` 只给静态部分）。
 * ⚠️ 与 `common/utils/time.ts` 同性质：零 IO、零 DI、**不读时钟**（`now()` 是调用方职责，
 *    本文件只收毫秒数）；唯一的 `new Date(ms)` 是给 `toBjIso` 的**纯换算**，见其注释。
 */
import { BuildingGroupStatus, BuildingStatus } from '@abox/shared-types';

import { toBjIso } from './time';

/** 结构层输入（**无时间维度** —— 管家端与用户端共用） */
export interface StructureScope {
  buildingStatus: number | null; // ab_building.status；null = 楼不存在 / 已软删
  buildingGroupId: number | null; // null = 未归群
  buildingGroupStatus: number | null; // ab_building_group.status；null = 群不存在
}

/** 用户端完整输入（结构层 + 编排层 + 时间层 + 停售层） */
export interface AvailabilityInput extends StructureScope {
  assignmentStatus: string | null; // ab_meal_assignment.status；null = 无分配
  salesPaused: boolean;
  cutoffWindowMinutes: number;
  publishAtMs: number; // publishAtOf(mealDate).getTime()
  cutoffAtMs: number; // cutoffAtOf(mealDate).getTime()
  nowMs: number; // now().getTime()
}

export type StructureBlockReason =
  'building_not_grouped' | 'building_preparing' | 'building_suspended' | 'group_suspended';

export type OrderBlockReason =
  'sales_paused' | StructureBlockReason | 'meal_not_published' | 'not_open_yet' | 'cutoff';

export interface StructureResult {
  ok: boolean;
  reason: StructureBlockReason | null;
}

export interface Availability {
  canOrder: boolean;
  reason: OrderBlockReason | null; // canOrder === true 时恒为 null
}

/**
 * 结构层谓词 —— 三处共用同一实现（管家端只调本函数）
 *
 * 判据只有三项：楼 `status`、是否归群、楼群 `status`。
 *
 * ⚠️ **刻意不判集散中心覆盖**（`DistributionGap`）：项目已把「未覆盖」定义为「下单能成立、
 *    履约断链」。并进本谓词会让 `gap` 字段失去意义，且把「集散中心配置」的后果**静默传导
 *    成停摆**：运营少配一个集散中心，用户端会表现成「该办公楼已暂停服务」，排查方向全错。
 *
 * ⚠️ **求值顺序是全序，不要调换**（单测锁死）：`building_not_grouped` → `building_preparing`
 *    → `building_suspended` → `group_suspended`。· 未归群最先判：没进群的楼即使 `status = 1`
 *    也送不了，「营业中」是假的安全信号。· 楼自身优先于楼群：楼群停用时若回「今日未开团」，
 *    用户读到的是「明天再来看看」，而实际上明天也不会有。
 *
 * ⚠️ 第 1 条是**三个 `=== null` 的存在性判定**，一个都不能少。漏 `buildingStatus` ⇒
 *    `{ status: null, gid: 7, gs: 1 }` 四步全过返回 `ok: true`（**不存在的楼可下单**）；
 *    漏 `buildingGroupStatus` ⇒ `{ status: 1, gid: 7, gs: null }` 同样全过（**挂着悬空
 *    楼群 id 的楼可下单**，而楼群不存在 ⇒ 集散 / 团长 / 配送全断链）。同一 bug 的左右两半。
 *
 * ⚠️ 病根不是「漏了一行」，是**两个同源字段用了两套判据风格**：`buildingStatus` 只做存在性
 *    判定，而 `buildingGroupStatus` 却拿**相等判定**去承担存在性 —— 相等判定天然漏 `null`
 *    （`null === SUSPENDED` 恒为 false）。故两个字段的存在性**都由第 1 条**用同一套判定。
 *
 * ⚠️ 第 4 条的 `=== SUSPENDED` **保留，不要删**：它只是不再承担存在性职责，本身仍是
 *    `group_suspended` 的唯一来源（60010 的四个输入之一 + 独立文案「该区域已暂停服务」）。
 *
 * ⚠️ 记录不可达时**不抛异常**（调用方已在 `resolveXxx()` 抛过 `BUILDING_NOT_FOUND`，再抛
 *    就是同一件事两处抛码）—— 只把结论判成 false。软删行同样落本桶：编排层查询带
 *    `deletedAt: IsNull()` ⇒ 取不到 ⇒ 状态为 null ⇒ fail-closed。
 */
export function evaluateStructure(s: StructureScope): StructureResult {
  // 存在性：三个字段任一为 null 即 fail-closed（详见上方注释）
  if (s.buildingStatus === null || s.buildingGroupId === null || s.buildingGroupStatus === null) {
    return { ok: false, reason: 'building_not_grouped' };
  }
  if (s.buildingStatus === BuildingStatus.PREPARING) {
    return { ok: false, reason: 'building_preparing' };
  }
  if (s.buildingStatus === BuildingStatus.SUSPENDED) {
    return { ok: false, reason: 'building_suspended' };
  }
  if (s.buildingGroupStatus === BuildingGroupStatus.SUSPENDED) {
    return { ok: false, reason: 'group_suspended' };
  }
  return { ok: true, reason: null };
}

/**
 * 用户端完整谓词（结构层 + 编排层 + 时间层 + 停售层）
 *
 * ⚠️ 求值顺序同样是全序，不要调换：1 `sales_paused`（**全局**事实，先判才不会把停售
 *    误报成「这栋楼的问题」）→ 2~5 `evaluateStructure` → 6 `meal_not_published`
 *    → 7 `not_open_yet` → 8 `cutoff`。
 *
 * ⚠️ 第 7 / 8 条合起来等价于既有 `isOrderable()` 的 `[开团, 截单 − cutoffWindowMinutes)`
 *    左闭右开区间，只是把「false」拆成了两个可区分的原因 —— 二者对用户的处置完全相反
 *    （「再等等」 vs 「来不及了」），合并回一个 false 会让端上只能猜。
 */
export function evaluateAvailability(i: AvailabilityInput): Availability {
  if (i.salesPaused) return { canOrder: false, reason: 'sales_paused' };

  const structure = evaluateStructure(i);
  if (structure.reason !== null) return { canOrder: false, reason: structure.reason };

  if (i.assignmentStatus !== 'active') return { canOrder: false, reason: 'meal_not_published' };
  if (i.nowMs < i.publishAtMs) return { canOrder: false, reason: 'not_open_yet' };
  if (i.nowMs >= i.cutoffAtMs - i.cutoffWindowMinutes * 60_000) {
    return { canOrder: false, reason: 'cutoff' };
  }

  return { canOrder: true, reason: null };
}

/**
 * 阻断原因 → 文案查表
 *
 * ⚠️ 为什么用查表而不是三元：既有 `meal.service.ts` 已是三层嵌套三元，加结构层四条会变五层
 *    —— 三元的求值顺序是**隐式的**（读的人要自己推导），查表的顺序是显式可测的。
 *
 * ⚠️ `not_open_yet` / `cutoff` / `sales_paused` 三个键留空串**是刻意的**：
 *    这三条的文案都含插值（`{HH:mm}` / `{N}` / `{reason}`），由 `reasonText()`
 *    的**专属 case** 生成 —— 把带占位符的模板塞进表里，就会有调用方忘记插值、
 *    把 `{HH:mm}` 原样下发给用户，那是一条看起来完全正常的假文案，比空文案更难发现。
 *
 * ⚠️ 空串的含义是「**这句文案由 `reasonText()` 生成**」—— 是**有意义的空**，
 *    不是遗漏。直接索引 `REASON_TEXT[...]` 的调用方一律被 `N1-11` 拦住。
 */
export const REASON_TEXT: Record<OrderBlockReason, string> = {
  /**
   * W1 · spec §7.6 第 1 条：运营填的停售原因必须**原样下发到用户端** ——
   * 用户真正想知道的是「为什么停、什么时候能订」，而 `reason` 在后台是
   * **必填**字段（`CreateSalesPauseDto` 的 `@MinLength(4)`）。故本键需插值，留空串。
   */
  sales_paused: '',
  /**
   * ⚠️ 这一句承接**三种成因**，共用一句是**刻意的**：① 楼未归群；② 楼记录不可达；
   *    ③ 楼群记录不可达。为什么不分：三者对**用户**的处置动作完全相同（找团长 / 运营问），
   *    为一个用户感知不到的区别多开分支，收益为零而成本不小（动 `OrderBlockReason` 联合类型
   *    ⇒ N1-5 / N1-6 / N1-8 / N1-12 四条判据连带要改）。运营排查走后台 `gap` / `canAssign`
   *    与操作日志，不看这句用户文案。
   */
  building_not_grouped: '该办公楼暂未开通服务，请联系运营',
  building_preparing: '该办公楼尚未开通，敬请期待',
  building_suspended: '该办公楼已暂停服务',
  group_suspended: '该区域已暂停服务',
  meal_not_published: '该办公楼今日未开团',
  not_open_yet: '', // 动态文案：今日 {HH:mm} 开团，敬请期待
  cutoff: '', // 动态文案：距截单不足 {N} 分钟，请明日再订
};

/** 插值所需上下文（毫秒数，与 `AvailabilityInput` 同源，调用方不必再算一遍） */
export interface ReasonContext {
  publishAtMs: number;
  cutoffAtMs: number;
  cutoffWindowMinutes: number;
  /**
   * W1：命中停售时，运营填的那条原因（`ab_sales_pause.reason`）
   *
   * `not_open_yet` / `cutoff` 之外**唯一**需要外部文案的原因 —— 供
   * `sales_paused` 分支插值。缺省 = 没有运营原因 ⇒ 回落静态句，不出空文案。
   */
  salesPauseReason?: string | null;
}

/**
 * 文案**唯一出口** —— 四个调用方（U1 / U6 / 团长工作台 / 管家端）一律走它，
 * **不得**自行拼字符串或直接读 `REASON_TEXT`
 *
 * ⚠️ 为什么必须有它：`not_open_yet` / `cutoff` 要插值，而「漏插值」是**静默失败** —— 用户
 *    拿到空文案，没有任何门禁或类型约束拦得住（`string` 就是 `string`，空串合法）。若让四个
 *    调用方各自写插值，就是把这两条动态文案复制四份 —— 正是本批在消灭的病根。
 *
 * ⚠️ 仍是零 IO / 零 DI：`new Date(ms)` 是**毫秒 → Date 的纯换算**（`toBjIso` 只收 `Date`）。
 *
 * ⚠️ `canOrder === true` 时 `reason` 为 `null` —— 调用方**不得**调本函数，直接给 `null`。
 */
export function reasonText(reason: OrderBlockReason, ctx: ReasonContext): string {
  switch (reason) {
    case 'not_open_yet':
      // `new Date(ms)` 恒为有效 Date ⇒ `toBjIso` 不会返回 null，与 meal.service 既有写法一致
      return `今日 ${toBjIso(new Date(ctx.publishAtMs))!.slice(11, 16)} 开团，敬请期待`;
    case 'cutoff':
      return `距截单不足 ${ctx.cutoffWindowMinutes} 分钟，请明日再订`;
    case 'sales_paused': {
      const why = ctx.salesPauseReason;
      // ⚠️ 缺失 / 空串 ⇒ 回落静态句，**不拼冒号、不留空尾巴**
      return why ? `今日暂停接单：${why}` : '今日暂停接单';
    }
    default:
      return REASON_TEXT[reason];
  }
}

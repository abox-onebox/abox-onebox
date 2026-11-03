/**
 * AI 每日编排的「冷启动体检」
 *
 * 为什么需要它：
 *   编排每天 09:00 无条件跑 12 个节点。一旦业务处在「没排餐 / 没订单 / 没券种」
 *   的冷启动态，12 个节点照样会产稿 —— 但产出来的是「GMV 环比 -100%」
 *   「全员流失风险」「建议发券」这类**空壳告警**：数据确实空，结论却是假的
 *   （把「还没开团」说成「经营崩了」）。负责人连着几天收到一堆红字就不再看了，
 *   那这 12 个节点等于没做。
 *
 * 判据三条铁律（改这个文件前先读完）：
 *   ① **null 不等于 0**。取数失败是「不知道」，不是「就是零」。把取数失败当 0，
 *      会把「接口抖了一下」报成「今天一单都没有」—— 与本项目 D-1 `getNumber`
 *      fallback 是同一类静默算错。故这里只用 `=== 0` 判空，绝不用 `!x`。
 *   ② 只在**能确证为空**时才降级。任一关键项为 null ⇒ 该项不参与判断，
 *      宁可按原样跑，也不靠猜测削减节点。
 *   ③ 降级不等于沉默。empty 时仍跑日报，把「今天为什么没数据」和下一步动作
 *      说清楚 —— 沉默比噪音更糟，负责人会以为系统坏了。
 */

/** 空壳等级：ok 正常跑；thin 跳过部分节点；empty 只留日报 */
export type PreflightGrade = 'ok' | 'thin' | 'empty';

export interface PreflightInput {
  /** 未来 7 天排餐网格里**已上架**（active）的格子数；null = 未能核实 */
  publishedCells: number | null;
  /** 未来 7 天已排期（含 pending 未上架）的格子数；null = 未能核实 */
  assignedCells: number | null;
  /** 在营楼群数；null = 未能核实 */
  groupCount: number | null;
  /** 可用券种数；null = 未能核实 */
  couponDefs: number | null;
  /** 近 7 天订单数；null = 未能核实 */
  orders7d: number | null;
}

export interface PreflightResult {
  grade: PreflightGrade;
  /** 一句话结论，直接进推送首段 */
  headline: string;
  /** 会让分析失去意义的硬缺口（已确证） */
  blockers: string[];
  /** 不致命、但会让提案落不了地的问题（已确证） */
  notes: string[];
  /** 建议跳过的节点 key —— 只放**判据确证**会产空壳告警的那些 */
  skipNodes: string[];
}

/**
 * 依赖历史订单的节点：0 单时它们只会把「没有样本」说成「指标崩了」。
 * ⚠️ 不含 daily（日报要说清现状）、risk（对账即使 0 单也能查出平不平）、
 *    leader / refund（按人/按笔看，0 单时输出「暂无」是诚实的）。
 */
const ORDER_DEPENDENT = ['demand', 'growth', 'churn', 'health'];

/** 依赖在售套餐的节点：一个都没上架时，选品与社群排期无标的 */
const MEAL_DEPENDENT = ['meal', 'community'];

/** empty 时保留的节点：只留日报，用它把「为什么没数据」讲清楚 */
const EMPTY_KEEP = ['daily'];

/**
 * 体检
 *
 * 返回的 skipNodes 只是**建议**，是否真跳由调用方决定 —— 抽成纯函数是为了能单测，
 * 因为本仓没有 order.service 那类服务层单测，判据写在 service 里就没人拦得住。
 */
export function preflight(i: PreflightInput): PreflightResult {
  const blockers: string[] = [];
  const notes: string[] = [];

  const noMeal = i.publishedCells === 0;
  const noOrder = i.orders7d === 0;

  if (noMeal) {
    // 区分「压根没排」和「排了没上架」：后者是**动作漏了一步**，前者是没开始，
    // 提示语不同，负责人的下一步动作也不同（去排餐 vs 去点「上架」）。
    const scheduledButNotLive = (i.assignedCells ?? 0) > 0;
    blockers.push(
      scheduledButNotLive
        ? '未来 7 天已排期但没有一个上架 —— 用户在小程序里买不到'
        : '未来 7 天没有任何排餐',
    );
  }
  if (noOrder) blockers.push('近 7 天 0 单');

  if (i.couponDefs === 0) notes.push('券种 0 条 —— 发券类提案没有可用券，只能停在建议');
  if (i.groupCount === 0) notes.push('在营楼群 0 个 —— 招募与覆盖类分析无标的');

  let grade: PreflightGrade = 'ok';
  if (noMeal && noOrder) grade = 'empty';
  else if (noMeal || noOrder) grade = 'thin';

  let skipNodes: string[] = [];
  if (grade === 'empty') {
    // 全量跳过（只留日报）：12 个节点都依赖「有餐、有单」这个前提
    // 含 recruit：没餐没单时招人进来也没东西卖，先别扩团长
    skipNodes = [
      ...ORDER_DEPENDENT,
      ...MEAL_DEPENDENT,
      'recruit',
      'coupon',
      'leader',
      'refund',
      'risk',
    ].filter((k) => !EMPTY_KEEP.includes(k));
  } else if (grade === 'thin') {
    const set = new Set<string>();
    if (noOrder) ORDER_DEPENDENT.forEach((k) => set.add(k));
    if (noMeal) MEAL_DEPENDENT.forEach((k) => set.add(k));
    skipNodes = [...set];
  }

  const headline =
    grade === 'empty'
      ? '今日编排已降级：数据不足以支撑分析，只出日报'
      : grade === 'thin'
        ? `今日编排部分降级：跳过 ${skipNodes.length} 个暂无数据支撑的节点`
        : '数据体检通过，全部节点正常执行';

  return { grade, headline, blockers, notes, skipNodes };
}

/** 把体检结果拼成给负责人看的几行（空数组时返回空串，调用方据此不加段） */
export function describePreflight(r: PreflightResult): string {
  if (r.grade === 'ok' && !r.notes.length) return '';
  const lines: string[] = [`【数据体检】${r.headline}`];
  for (const b of r.blockers) lines.push(`· 待办：${b}`);
  for (const n of r.notes) lines.push(`· 提示：${n}`);
  if (r.skipNodes.length) {
    // 明说跳过了谁：否则负责人看到节点少了会以为程序坏了
    lines.push(`· 本次跳过：${r.skipNodes.join(' / ')}（数据到位后自动恢复）`);
  }
  return lines.join('\n');
}

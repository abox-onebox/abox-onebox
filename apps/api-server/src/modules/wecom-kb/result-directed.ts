/**
 * 定向出参摘要 —— 结构化的那 8 个端点，通用摘要念不动，单独写。
 *
 * 为什么值得单写：这些端点的返回值是**嵌套对象/多段统计**，
 * 通用三路（分页 / 数组 / 扁平对象）只能吐出「后台返回了 N 个字段」。
 * 而它们恰好是每天要用的：待办、财务总览、订单详情、套餐矩阵、
 * 楼栋总览、队列积压、打包任务、端点目录。
 *
 * 纪律（与 `stats-summary.ts` 一致）：
 *   · 取不到就**跳过**，绝不补 0 —— 0 与「取不到」在经营上是两件事；
 *   · 金额一律整数分（显示 ÷100），比率一律 0–1（显示 ×100）；
 *   · 后端给的 `warnings` 必须**逐条转述**，不许吞。
 *
 * 字段名全部来自**线上真实响应**（2026-11-02 抓的 31 个样本），不是照 DTO 猜的。
 */

import { asObj, md, mdh, num, objs, str, yuan } from './result-fmt';
import type { Obj } from './result-fmt';
import { fmtPct } from './stats-summary';

// ---------------------------------------------------------------- 待办

function wantTodos(d: Obj): string {
  const lines: string[] = [];
  const items = objs(d.items);

  // ⚠️ 只念「有事」的：后台会返回 4 个固定项，count=0 的念出来是噪音
  const pending = items.filter((i) => (num(i.count) ?? 0) > 0);
  if (pending.length === 0) lines.push('今天没有待办。');
  else {
    lines.push(`今天有 ${pending.length} 件待办：`);
    for (const it of pending) {
      const label = str(it.label) ?? str(it.key) ?? '未命名';
      const count = num(it.count);
      // 不写「件」：这 4 项的计数单位各不相同（待审是单、未排是楼群），统一量词会读成错的
      lines.push(count === null ? `· ${label}` : `· ${label}：${count}`);
    }
  }

  const brief = asObj(d.brief);
  if (brief) {
    const total = num(brief.tomorrowGroupsTotal);
    const assigned = num(brief.tomorrowGroupsAssigned);
    if (total !== null && assigned !== null) {
      lines.push(`明日排餐：${assigned} / ${total} 个楼群已排`);
    } else if (total !== null) {
      lines.push(`明日共 ${total} 个楼群`);
    }
    const dt = num(brief.deliveryTotal);
    const da = num(brief.deliveryArrived);
    // 配送 0 单是常态（还没到点），只在下过单时才念
    if (dt !== null && dt > 0) lines.push(`今日配送：${da ?? 0} / ${dt} 已送达`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- 财务总览

function wantFinanceOverview(d: Obj): string {
  const lines: string[] = [];
  const range = asObj(d.range);
  if (range) {
    const label = str(range.label) ?? str(range.range);
    const from = md(range.startDate);
    const to = md(range.endDate);
    const span = from && to ? `${from} ~ ${to}` : null;
    lines.push([label, span].filter(Boolean).join('（') + (label && span ? '）' : ''));
  }

  const income = asObj(d.income);
  if (income) {
    const bits: string[] = [];
    const cnt = num(income.orderCount);
    const qty = num(income.quantity);
    const gmv = yuan(income.gmvFen);
    const avg = yuan(income.avgOrderAmountFen);
    if (cnt !== null) bits.push(`${cnt} 单`);
    if (qty !== null) bits.push(`${qty} 份`);
    if (gmv) bits.push(`GMV ${gmv}`);
    if (avg) bits.push(`客单价 ${avg}`);
    if (bits.length) lines.push(`收入：${bits.join(' · ')}`);

    const rc = num(income.refundCount);
    const rr = num(income.refundRate);
    if (rc !== null && rc > 0) lines.push(`退款：${rc} 单，退款率 ${fmtPct(rr)}`);
    else if (rc === 0) lines.push('退款：无');
  }

  const expense = asObj(d.expense);
  if (expense) {
    const bits: string[] = [];
    const purchase = yuan(expense.purchaseFen);
    const commission = yuan(expense.commissionFen);
    const fulfillment = yuan(expense.fulfillmentFen);
    if (purchase) bits.push(`采购 ${purchase}`);
    if (commission) bits.push(`佣金 ${commission}`);
    if (fulfillment) bits.push(`履约 ${fulfillment}`);
    if (bits.length) lines.push(`支出：${bits.join(' · ')}`);
  }

  const payable = asObj(d.payable);
  if (payable) {
    const unpaid = yuan(payable.unpaidFen);
    const pendingCount = num(payable.pendingCount);
    if (unpaid) {
      const tail = pendingCount === null ? '' : `（${pendingCount} 笔待付）`;
      lines.push(`应付未付：${unpaid}${tail}`);
    }
  }

  const liability = asObj(d.liability);
  if (liability) {
    const bits: string[] = [];
    const bal = yuan(liability.balanceFen);
    const frozen = yuan(liability.frozenFen);
    if (bal) bits.push(`团长余额 ${bal}`);
    if (frozen) bits.push(`冻结 ${frozen}`);
    if (bits.length) lines.push(`负债：${bits.join(' · ')}`);
  }

  const profit = asObj(d.profit);
  if (profit) {
    const gp = yuan(profit.grossProfitFen);
    const rate = num(profit.grossProfitRate);
    if (gp) lines.push(`毛利：${gp}（${fmtPct(rate)}）`);
  }

  for (const w of Array.isArray(d.warnings) ? d.warnings : []) {
    const s = str(w);
    if (s) lines.push(`⚠️ ${s}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- 订单详情

function wantOrderDetail(d: Obj): string {
  const order = asObj(d.order);
  if (!order) return '';

  const lines: string[] = [];
  const no = str(order.orderNo) ?? '';
  const status = str(order.statusText) ?? str(order.status);
  lines.push([no, status].filter(Boolean).join(' · '));

  const bits: string[] = [];
  const date = md(order.mealDate);
  if (date) bits.push(`出餐日 ${date}`);
  const qty = num(order.quantity);
  if (qty !== null) bits.push(`${qty} 份`);
  const amount = yuan(order.totalAmountFen);
  if (amount) bits.push(amount);
  const user = str(order.userName);
  if (user) bits.push(user);
  const building = str(order.buildingName);
  const group = str(order.groupName);
  if (building) bits.push(group ? `${building}（${group}）` : building);
  if (bits.length) lines.push(bits.join(' · '));

  const meal = str(order.setMealName);
  if (meal) lines.push(`套餐：${meal}`);

  const phone = str(order.phoneMasked);
  if (phone) lines.push(`电话：${phone}`);

  // 只念「还没到」的第一个节点 —— 全念一遍没人看
  const timeline = objs(d.timeline);
  const next = timeline.find((n) => n.done !== true);
  if (next) {
    const text = str(next.text) ?? str(next.node) ?? '';
    const at = mdh(next.at);
    lines.push(`下一步：${text}${at ? `（${at}）` : ''}`);
  } else if (timeline.length) {
    const last = timeline[timeline.length - 1];
    const text = str(last.text) ?? '';
    const at = mdh(last.at);
    lines.push(`流程已走完：${text}${at ? `（${at}）` : ''}`);
  }

  const cancel = str(order.cancelReasonText) ?? str(order.cancelReason);
  if (cancel) {
    const src = str(order.cancelSourceText);
    lines.push(`${src ? src + '取消' : '取消'}：${cancel}`);
  }

  // 能不能改单 / 能不能退款，由后端算好放在 actions 里
  const actions = asObj(d.actions);
  if (actions) {
    const refundable = yuan(actions.refundableFen);
    if (actions.canForceRefund === true && refundable) lines.push(`可退款 ${refundable}`);
    const block = str(actions.adjustBlockReason);
    if (actions.canAdjust === false && block) lines.push(`不能改单：${block}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- 套餐矩阵

function wantMealMatrix(d: Obj): string {
  const lines: string[] = [];
  const from = md(d.startDate);
  const to = md(d.endDate);
  if (from && to) lines.push(`排餐区间：${from} ~ ${to}`);

  const stats = asObj(d.stats);
  if (stats) {
    const days = num(stats.dateCount);
    const groups = num(stats.groupCount);
    const cells = num(stats.cellCount);
    const assigned = num(stats.assignedCells);
    const published = num(stats.publishedCells);
    const empty = num(stats.emptyCells);
    const bits: string[] = [];
    if (days !== null && groups !== null && cells !== null) {
      bits.push(`${days} 天 × ${groups} 个楼群 = ${cells} 格`);
    } else if (cells !== null) bits.push(`${cells} 格`);
    if (assigned !== null) bits.push(`已排 ${assigned}`);
    if (published !== null) bits.push(`已上架 ${published}`);
    if (empty !== null) bits.push(`空 ${empty}`);
    if (bits.length) lines.push(bits.join(' · '));
  }

  // 只点名「有空楼」的楼群 —— 一格没排就等于开不了团
  const groups = objs(d.groups).filter((g) => (g.emptyBuildings as unknown[] | undefined)?.length);
  if (groups.length) {
    lines.push('有办公楼没排上的楼群：');
    for (const g of groups) {
      const name = str(g.name) ?? '未命名楼群';
      const n = (g.emptyBuildings as unknown[]).length;
      lines.push(`· ${name}：${n} 栋空`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- 楼栋总览

function wantBuildingsOverview(d: Obj): string {
  const lines: string[] = [];

  const b = asObj(d.buildings);
  if (b) {
    const total = num(b.totalCount);
    const bits: string[] = [];
    const active = num(b.activeCount);
    const preparing = num(b.preparingCount);
    const suspended = num(b.suspendedCount);
    if (active !== null) bits.push(`启用 ${active}`);
    if (preparing !== null) bits.push(`筹备 ${preparing}`);
    if (suspended !== null) bits.push(`停用 ${suspended}`);
    const canAssign = num(b.canAssignCount);
    if (canAssign !== null) bits.push(`可派单 ${canAssign}`);
    lines.push(`楼栋 ${total ?? '?'} 栋` + (bits.length ? `（${bits.join(' · ')}）` : ''));
  }

  const l = asObj(d.leaderStats);
  if (l) {
    const bits: string[] = [];
    const assigned = num(l.assignedCount);
    const vacant = num(l.vacantBuildingCount);
    const multi = num(l.multiBuildingCount);
    if (assigned !== null) bits.push(`已派团长 ${assigned}`);
    if (vacant !== null) bits.push(`空缺 ${vacant}`);
    if (multi !== null) bits.push(`一人多栋 ${multi}`);
    if (bits.length) lines.push(`团长覆盖：${bits.join(' · ')}`);
  }

  const g = asObj(d.groupStats);
  if (g) {
    const bits: string[] = [];
    const total = num(g.totalCount);
    const empty = num(g.emptyCount);
    const uncovered = num(g.uncoveredCount);
    if (total !== null) bits.push(`共 ${total} 个`);
    if (empty !== null) bits.push(`空 ${empty}`);
    if (uncovered !== null) bits.push(`未覆盖 ${uncovered}`);
    if (bits.length) lines.push(`楼组：${bits.join(' · ')}`);
  }

  const c = asObj(d.centerStats);
  if (c) {
    const bits: string[] = [];
    const total = num(c.totalCount);
    const covered = num(c.coveredBuildingCount);
    if (total !== null) bits.push(`共 ${total} 个`);
    if (covered !== null) bits.push(`覆盖 ${covered} 栋`);
    if (bits.length) lines.push(`集散中心：${bits.join(' · ')}`);
  }

  const vacantList = objs(d.vacantBuildings);
  if (vacantList.length) {
    const names = vacantList.map((x) => str(x.name) ?? str(x.buildingName) ?? '').filter(Boolean);
    const head = names.slice(0, 3).join('、');
    lines.push(
      `有待派团长的楼 ${vacantList.length} 栋${head ? `：${head}${names.length > 3 ? ' 等' : ''}` : ''}`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- 队列

function wantQueue(d: Obj): string {
  const lines: string[] = [];
  const driver = str(d.driver);
  const durable = d.durable === true ? '持久' : null;
  if (driver) lines.push(`队列驱动：${driver}${durable ? `（${durable}）` : ''}`);

  for (const q of objs(d.queues)) {
    const label = str(q.label) ?? str(q.queue) ?? '未命名队列';
    const bits: string[] = [];
    const waiting = num(q.waiting);
    const active = num(q.active);
    const delayed = num(q.delayed);
    const failed = num(q.failed);
    if (waiting !== null) bits.push(`等待 ${waiting}`);
    if (active !== null) bits.push(`进行 ${active}`);
    if (delayed !== null) bits.push(`延迟 ${delayed}`);
    if (failed !== null) bits.push(`失败 ${failed}`);
    const warn = failed !== null && failed > 0 ? ' ⚠️' : '';
    lines.push(`· ${label}：${bits.join(' · ')}${warn}`);
  }
  if (lines.length <= 1) lines.push('（当前没有队列在跑任务）');
  return lines.join('\n');
}

// ---------------------------------------------------------------- 打包任务

function wantPackingTasks(d: Obj): string {
  const lines: string[] = [];
  const date = md(d.date);
  if (d.visible === false) lines.push('这个日期还看不到打包任务（未到作业日）。');
  if (date) lines.push(`打包日期：${date}`);

  const centers = objs(d.centers);
  if (centers.length === 0) lines.push('没有启用的加工场所。');
  for (const c of centers) {
    const name = str(c.centerName) ?? '未命名场所';
    const ready = c.ready === true ? '可开始' : '未就绪';
    const routes = Array.isArray(c.routes) ? c.routes.length : 0;
    const items = Array.isArray(c.items) ? c.items.length : 0;
    const bits = [`${ready}`, `${routes} 条路线`, `${items} 个品项`];
    lines.push(`· ${name}：${bits.join(' · ')}`);
    for (const b of Array.isArray(c.blockers) ? c.blockers : []) {
      const s = str(b);
      if (s) lines.push(`  ⚠️ ${s}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- 端点目录

function wantOpsCatalog(d: Obj): string {
  const total = num(d.total);
  const items = objs(d.items);
  const lines: string[] = [];
  if (total !== null) lines.push(`端点目录：共 ${total} 个`);
  else if (items.length) lines.push(`端点目录：${items.length} 个`);

  const byModule = new Map<string, number>();
  for (const it of items) {
    const m = str(it.module);
    if (m) byModule.set(m, (byModule.get(m) ?? 0) + 1);
  }
  if (byModule.size) {
    const top = [...byModule.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([m, n]) => `${m} ${n}`)
      .join(' · ');
    lines.push(`模块分布：${top}`);
  }
  // ⛔ 不要念 `d.dishes`：`response.interceptor.ts` 有兼容别名层
  //    （`items → dishes`），这个键是 `items` 的镜像，不是菜品。
  return lines.join('\n');
}

/**
 * 端点编码 → 定向摘要。返回 `''` 表示「这个端点交给通用三路」。
 *
 * ⚠️ 键必须与 `op-catalog` 的 code 完全一致（`get_admin_xxx` 这种下划线形态，
 *    路径里的连字符会被生成器转成下划线）。
 */
const DIRECTED: Record<string, (d: Obj) => string> = {
  get_admin_dashboard_todos: wantTodos,
  get_admin_finance_overview: wantFinanceOverview,
  get_admin_orders_orderno: wantOrderDetail,
  get_admin_meal_matrix: wantMealMatrix,
  get_admin_buildings_overview: wantBuildingsOverview,
  get_admin_queue: wantQueue,
  get_admin_packingtasks: wantPackingTasks,
  get_admin_wecomkb_ops: wantOpsCatalog,
};

/** 结构化端点的定向摘要；不认识/念不出内容时返回空串，由调用方退回通用三路 */
export function summarizeDirected(code: string | undefined, data: unknown): string {
  if (!code) return '';
  const fn = DIRECTED[code];
  if (!fn) return '';
  const d = asObj(data);
  if (!d) return '';
  try {
    return fn(d) || '';
  } catch {
    // 出参变了也不该把机器人搞挂 —— 退回通用摘要
    return '';
  }
}

/** 供单测断言「这些编码确实有定向摘要」 */
export const DIRECTED_CODES = Object.keys(DIRECTED);

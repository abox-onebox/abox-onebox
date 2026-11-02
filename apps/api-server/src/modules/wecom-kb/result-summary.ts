/**
 * 出参说人话 —— 把后台接口的返回值转成企微里能读的几行。
 *
 * 通用摘要原来只认 7 个字段名（`id/orderNo/status/totalCount/count/ok/tier`），
 * 其余一律是截断的 JSON。137 个端点里 64 个是只读，绝大多数返回的东西
 * 一个都对不上那 7 个名字 ⇒ 用户执行完看到的是 `{"a":1,"b":2,...`。
 *
 * 这里按**返回形态**分三路（不针对单个端点猜字段）：
 *   ① 分页信封 `PageResult{list,page,pageSize,total,hasMore}` —— 全仓 22 个 service 用它；
 *   ② 数组；
 *   ③ 单个对象。
 *
 * 结构化的那 8 个端点（待办 / 财务总览 / 订单详情 / 套餐矩阵 / 楼栋总览 /
 * 队列 / 打包 / 端点目录）交给 `result-directed.ts` —— 它们是嵌套对象，
 * 通用三路只能吐出「后台返回了 N 个字段」。
 *
 * ⛔⛔ 一律走**白名单**（`result-fmt.ts` 的 `FIELD_SPECS`），绝不「有什么印什么」：
 *     `admin-user.service` 的用户行里带 `passwordHash`，泛印等于把密码哈希
 *     发到企微群里（那是永久留痕的）。所以「认不出」时的兜底只报
 *     「后台返回了 N 个字段」，**一个原值都不 dump**。
 */

import { asObj, fmtInt, has, md, pickFields } from './result-fmt';
import type { Obj } from './result-fmt';
import { summarizeDirected } from './result-directed';

/** 列表最多念几行；再多就指路去后台 */
const SHOW_ROWS = 3;
/** 单行/单对象最多念几个字段 */
const MAX_FIELDS = 6;

/** 订单列表/退款列表的行都带 `orderNo`，这几列固定念（比通用顺序更贴业务） */
const ORDER_LINE_KEYS = ['mealDate', 'orderNo', 'userName', 'buildingName', 'groupName'];

/** 订单/退款这类「有单号」的行，按业务习惯的顺序念 */
function orderLine(o: Obj): string | null {
  if (!has(o.orderNo)) return null;
  const bits: string[] = [];
  for (const k of ORDER_LINE_KEYS) {
    const v = o[k];
    // 出餐日压成 10-29：单号已经够长了，不再占 4 个字符
    if (k === 'mealDate') {
      const short = md(v);
      if (short) bits.push(short);
      continue;
    }
    if (has(v)) bits.push(String(v));
  }
  const status = o.statusText ?? o.statusLabel ?? o.status;
  if (has(status)) bits.push(String(status));
  if (typeof o.quantity === 'number') bits.push(`${o.quantity} 份`);
  if (typeof o.totalAmountFen === 'number') bits.push(`¥${(o.totalAmountFen / 100).toFixed(2)}`);
  return bits.join(' · ');
}

function rowLine(o: Obj, index: number): string {
  const order = orderLine(o);
  if (order) return `${index}. ${order}`;
  const bits = pickFields(o, MAX_FIELDS);
  if (bits.length) return `${index}. ${bits.join(' · ')}`;
  return `${index}. （这条没有能直接念的字段，去后台看）`;
}

/** `summary` 子对象：全量口径的合计 */
function summaryLine(summary: Obj): string | null {
  const bits = pickFields(summary, MAX_FIELDS);
  return bits.length ? `合计：${bits.join(' · ')}` : null;
}

function summarizeRows(rows: unknown[], label: string | null): string {
  const list = rows.map(asObj).filter((x): x is Obj => x !== null);
  const lines: string[] = [];
  if (label) lines.push(label);
  if (list.length === 0) {
    lines.push('没有记录。');
    return lines.join('\n');
  }
  list.slice(0, SHOW_ROWS).forEach((o, i) => lines.push(rowLine(o, i + 1)));
  const rest = list.length - Math.min(SHOW_ROWS, list.length);
  if (rest > 0) lines.push(`（还有 ${fmtInt(rest)} 条，去后台看）`);
  return lines.join('\n');
}

/**
 * 分页信封 `{ list, page, pageSize, total, hasMore }`
 *
 * ⚠️ `total` 并非总是有：线上实测 `deliveries` / `op-blocklist` /
 *    `schedule` / `system-roles` 四个端点**没有 `total`**（只有 `list`）。
 *    所以判据是「`list` 是数组」，`total` 取不到就用本页条数 ——
 *    否则会掉进单对象分支，吐一句「后台返回了 N 个字段」。
 */
function summarizePage(d: Obj): string {
  const list = d.list as unknown[];
  const total = typeof d.total === 'number' ? d.total : list.length;
  const lines: string[] = [];

  if (total === 0) lines.push('没有符合条件的记录。');
  else {
    const pageNote = list.length < total ? `（这页 ${fmtInt(list.length)} 条）` : '';
    lines.push(`共 ${fmtInt(total)} 条${pageNote}`);
  }

  const summary = asObj(d.summary);
  if (summary) {
    const s = summaryLine(summary);
    if (s) lines.push(s);
  }

  if (list.length > 0) lines.push(summarizeRows(list, null));
  return lines.join('\n');
}

/** 单个对象：只念白名单里认得的；认不出就实话说认不出 */
function summarizeObject(d: Obj): string {
  const keys = Object.keys(d).filter((k) => has(d[k]));
  if (keys.length === 0) return '已执行（后台没有回执内容）。';
  if (keys.length === 1 && (keys[0] === 'ok' || keys[0] === 'success')) {
    return d[keys[0]] === true ? '已执行。' : '后台回了未成功，但没给原因。';
  }

  const bits = pickFields(d, MAX_FIELDS + 2);
  if (bits.length) return bits.join(' · ');

  // ⛔ 不认识就**不 dump 原值**：用户行里有 passwordHash 这类东西
  return `后台返回了 ${keys.length} 个字段，这条没有能直接念的摘要；去后台看详情。`;
}

/**
 * 主入口：把出参转成人话。
 *
 * @param code 端点编码（`op-catalog` 的 key）。命中 `result-directed.ts`
 *             的定向摘要时优先用；其余走通用三路。
 *             **不要**在这个参数上再堆「猜字段」的分支 —— 猜出来的
 *             字段名一旦和真实出参不同，就会静默变成「没有能念的摘要」。
 */
export function summarizeData(data: unknown, code?: string): string {
  if (data === null || data === undefined) return '（后台没有返回内容，通常是成功但无回执）';
  if (typeof data !== 'object') return String(data).slice(0, 300);

  // 定向摘要优先：结构化端点用通用三路念不明白
  const directed = summarizeDirected(code, data);
  if (directed) return directed;

  if (Array.isArray(data)) return summarizeRows(data, null);

  const d = data as Obj;
  if (Array.isArray(d.list)) return summarizePage(d);
  return summarizeObject(d);
}

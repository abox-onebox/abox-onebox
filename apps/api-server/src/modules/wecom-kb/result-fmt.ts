/**
 * 出参摘要的共用原语（白名单 + 格式化）。
 *
 * 单独成文件是为了**避免循环依赖**：`result-summary`（通用三路）要调
 * `result-directed`（定向摘要），而定向摘要又要用同一套字段格式化。
 * 两者都只依赖这里。
 */

import { fmtInt, fmtYuan } from './stats-summary';

/** 转发给上层（行摘要里要数条数） */
export { fmtInt };

export type Kind = 'money' | 'time' | 'text';

export interface FieldSpec {
  /** 规范键（同义字段由 {@link ALIASES} 折叠到这个键上） */
  key: string;
  label: string;
  kind?: Kind;
  /** 同义组：一组只念一个（如「金额」在订单行是 totalAmountFen、在退款行是 amountFen） */
  group?: string;
}

/**
 * 同义字段：按**优先级**取第一个有值的。
 *
 * ⚠️ 状态类必须把 `statusText`/`statusLabel` 排在裸 `status` 之前 ——
 *    否则用户看到的是 `refund_applying` 而不是「退款中」。
 */
export const ALIASES: Record<string, string[]> = {
  status: ['statusText', 'statusLabel', 'statusLabelText', 'status'],
  phone: ['phoneMasked', 'phone'],
  role: ['roleLabel', 'role'],
  level: ['levelLabel', 'level'],
  reason: ['reasonTypeText', 'cancelSourceText', 'reason'],
  channel: ['payoutChannelText', 'payoutType'],
  amount: ['totalAmountFen', 'amountFen', 'payAmountFen'],
};

/**
 * 白名单字段表。**顺序即优先级**：一行只念前几个命中的。
 *
 * ⛔ 新增字段前先想一句：这东西发到企微群里合适吗？
 *    （`admin-user` 的用户行里有 `passwordHash` —— 所以绝不「有什么印什么」）
 */
export const FIELD_SPECS: FieldSpec[] = [
  // —— 身份：先让用户知道「这是哪一条」 ——
  { key: 'orderNo', label: '单号' },
  { key: 'refundNo', label: '退款单号' },
  { key: 'withdrawNo', label: '提现单号' },
  { key: 'payoutBatchNo', label: '打款批次' },
  { key: 'name', label: '名称' },
  { key: 'label', label: '名称', group: 'name' },
  { key: 'realName', label: '姓名' },
  { key: 'nickname', label: '昵称' },
  { key: 'username', label: '账号' },
  { key: 'role', label: '角色' },
  { key: 'level', label: '等级' },

  // —— 业务字段 ——
  { key: 'setMealName', label: '套餐' },
  { key: 'mealDate', label: '出餐日', kind: 'time' },
  { key: 'status', label: '状态' },
  { key: 'quantity', label: '份数' },
  { key: 'amount', label: '金额', kind: 'money', group: 'amount' },
  { key: 'balanceFen', label: '余额', kind: 'money' },
  { key: 'frozenFen', label: '冻结', kind: 'money' },
  { key: 'costPriceFen', label: '成本', kind: 'money' },
  { key: 'priceFen', label: '售价', kind: 'money' },
  { key: 'commissionRateText', label: '佣金率' },
  { key: 'reason', label: '事由' },
  { key: 'buildingName', label: '楼栋' },
  { key: 'groupName', label: '楼组' },
  { key: 'phone', label: '电话' },
  { key: 'city', label: '城市' },
  { key: 'district', label: '区' },
  { key: 'address', label: '地址' },

  // —— 定时任务 / 操作日志 ——
  // `what` 是任务的一句话说明（已写成中文），`task` 是机器名（meal-publish 这种）
  { key: 'what', label: '内容' },
  { key: 'task', label: '任务' },
  { key: 'effectiveAt', label: '时刻' },
  { key: 'dateKindLabel', label: '日期口径' },
  { key: 'module', label: '模块' },
  { key: 'action', label: '动作' },
  { key: 'targetId', label: '对象' },
  { key: 'opCode', label: '操作' },

  // —— 分页信封里 `summary` 子对象的字段（全量统计，不受分页影响） ——
  // ⚠️ 刻意不含 `totalCount`：它恒等于「共 N 条」，重复念一遍是噪音
  { key: 'validCount', label: '有效单数' },
  { key: 'validQuantity', label: '有效份数' },
  { key: 'validAmountFen', label: '有效金额', kind: 'money' },
  { key: 'abnormalCount', label: '异常' },
  { key: 'pendingPayCount', label: '待支付' },
  { key: 'refundingCount', label: '退款中' },
  { key: 'pendingCount', label: '待处理' },

  // —— 时间放最后：前面已经有识别信息了 ——
  { key: 'createdAt', label: '创建', kind: 'time' },
  { key: 'appliedAt', label: '申请', kind: 'time' },
  { key: 'paidAt', label: '支付', kind: 'time' },
  { key: 'auditAt', label: '审批', kind: 'time' },
];

export type Obj = Record<string, unknown>;

export function asObj(v: unknown): Obj | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Obj;
}

/** 判「有没有值」用 `Boolean(x)` 语义，**不用 `!== null`**（`undefined !== null` 为 true） */
export function has(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return false;
  return true;
}

export function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

export function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v;
  if (typeof v === 'number') return String(v);
  return null;
}

export function objs(v: unknown): Obj[] {
  if (!Array.isArray(v)) return [];
  return v.map(asObj).filter((x): x is Obj => x !== null);
}

/** `10-29`（把 ISO 日期压成人看的月-日） */
export function md(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[2]}-${m[3]}` : s;
}

/** `10-29 14:30` */
export function mdh(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : s;
}

/** 金额（分）→ `¥12.34`；取不到返回 null（**不补 0**） */
export function yuan(v: unknown): string | null {
  const n = num(v);
  return n === null ? null : fmtYuan(n);
}

export function fmtValue(v: unknown, kind: Kind | undefined): string {
  if (kind === 'money' && typeof v === 'number') return fmtYuan(v);
  if (kind === 'time') {
    const s = String(v);
    const full = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
    if (full) return `${full[2]}-${full[3]} ${full[4]}:${full[5]}`;
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (day) return `${day[2]}-${day[3]}`;
    return s.slice(0, 19);
  }
  if (typeof v === 'number') return fmtInt(v);
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}

/** 按别名表取第一个有值的 */
function resolve(o: Obj, key: string): unknown {
  const names = ALIASES[key] ?? [key];
  for (const n of names) if (has(o[n])) return o[n];
  return undefined;
}

/** 按白名单挑字段，转成 `标签 值` 数组 */
export function pickFields(o: Obj, max: number): string[] {
  const out: string[] = [];
  const seenGroup = new Set<string>();
  const seenText = new Set<string>();
  for (const spec of FIELD_SPECS) {
    if (out.length >= max) break;
    const group = spec.group ?? spec.key;
    if (seenGroup.has(group)) continue;
    const v = resolve(o, spec.key);
    if (!has(v)) continue;
    seenGroup.add(group);

    // 数组只念条数：一行里塞整个数组没人读
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      out.push(`${spec.label} ${v.length} 项`);
      continue;
    }
    const text = fmtValue(v, spec.kind);
    // 同一个值不念两遍（如 `realName` 与 `nickname` 都叫「李明」）
    if (seenText.has(text)) continue;
    seenText.add(text);
    out.push(`${spec.label} ${text}`);
  }
  return out;
}

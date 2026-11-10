/**
 * 预包装食品标签归一化（124 号令第二十条 · 2026-11-10）
 *
 * `ab_item.label_info` 是 MySQL `JSON` 列，正常情况 TypeORM 已解析成对象；
 * 但库里的历史脏值 / 运营手填可能仍是 **JSON 字符串**，甚至不是对象。
 * 判据抽成纯函数是为了两件事：
 *   ① 端上永远只收到 `Record<string,string>`，不用自己猜形态；
 *   ② 「解析失败」必须静默降级为 null，**不能把原始脏串显示给用户**。
 *
 * 零 IO，便于单测钉死。
 */

export type ItemLabelInfo = Record<string, string>;

/** 上限是防御：标签最多十几项，异常值不该把弹窗撑爆或拖慢序列化 */
const MAX_ROWS = 20;
const MAX_KEY_LEN = 24;
const MAX_VALUE_LEN = 200;

export function normalizeLabelInfo(raw: unknown): ItemLabelInfo | null {
  let value: unknown = raw;

  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const out: ItemLabelInfo = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.trim();
    if (!key || key.length > MAX_KEY_LEN) continue;
    // 只收标量：拒绝把嵌套对象 / 数组塞进标签行
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const text = String(v).trim();
    if (!text || text.length > MAX_VALUE_LEN) continue;
    out[key] = text;
    if (Object.keys(out).length >= MAX_ROWS) break;
  }

  return Object.keys(out).length ? out : null;
}

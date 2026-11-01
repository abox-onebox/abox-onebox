/**
 * 中文说法 → 后台主键的确定性匹配（纯函数，零 IO）
 *
 * 为什么单独抽出来：
 *   同事说的是「量子大厦 5 号楼」「A 套餐」，后台要的是 `buildingGroupId=3`、
 *   `setMealId=12`。中间这层如果靠模型猜，错一位就是把套餐排到别的楼上 ——
 *   所以判据必须是**纯函数 + 单测**，不许夹在 service 里靠人眼审。
 *
 * 三条规则（按优先级，命中即停）：
 *   1. 归一化后完全相等      → 直接命中
 *   2. 一方是另一方的子串    → 唯一则命中，多个则给候选让人选（绝不猜）
 *   3. 都不沾边              → none，由上层列全部候选
 *
 * ⚠️ 刻意**不**做「模糊相似度」（编辑距离之类）：
 *   楼名之间常只差一个字（「量子大厦 A 座 / B 座」），相似度会把 A 判成 B，
 *   而这类错在业务上是「套餐排错楼」，代价远高于「让他再回一个数字」。
 */

export interface NameCandidate {
  id: number;
  name: string;
  /** 附注（如楼群名、"已停用"），用于候选列表里帮人区分 */
  note?: string;
}

export type MatchResult =
  | { kind: 'hit'; item: NameCandidate }
  | { kind: 'many'; items: NameCandidate[] }
  | { kind: 'none' };

/** 归一化：去所有空白、全角转半角、英文小写。中文标点统一成半角后再去。 */
export function normalizeName(s: string): string {
  if (!s) return '';
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    // 全角 ASCII（！-～）→ 半角
    if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0);
    } else if (code === 0x3000) {
      // 全角空格
      out += ' ';
    } else {
      out += ch;
    }
  }
  return out
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[（）()【】[\]「」『』'"·、,，。.：:；;]/g, '')
    .toLowerCase();
}

/** 名称匹配（纯函数，供单测钉死判据） */
export function matchByName(input: string, list: NameCandidate[], limit = 6): MatchResult {
  const key = normalizeName(input);
  if (!key) return { kind: 'none' };

  // 1) 完全相等
  const exact = list.filter((x) => normalizeName(x.name) === key);
  if (exact.length === 1) return { kind: 'hit', item: exact[0] };
  if (exact.length > 1) return { kind: 'many', items: exact.slice(0, limit) };

  // 2) 子串包含（双向）
  const partial = list.filter((x) => {
    const n = normalizeName(x.name);
    return n.includes(key) || key.includes(n);
  });
  if (partial.length === 1) return { kind: 'hit', item: partial[0] };
  if (partial.length > 1) {
    // 名称越长说明越贴近他的说法（「量子大厦5号楼」优先于「量子大厦」）
    const sorted = [...partial].sort((a, b) => {
      const la = Math.abs(normalizeName(a.name).length - key.length);
      const lb = Math.abs(normalizeName(b.name).length - key.length);
      return la - lb || a.id - b.id;
    });
    return { kind: 'many', items: sorted.slice(0, limit) };
  }

  return { kind: 'none' };
}

/**
 * 从**整句话**里把候选名捞出来（长名优先）。
 *
 * 为什么不用正则去截「给(.+?)上」：同事的说法千变万化（「帮我把量子大厦 A 座明天排上 A 套餐」
 * 「量子大厦 A 座，明天，A 套餐」），截出来的片段常带多余字。反过来做 ——
 * 拿库里的真实名称去句子里找 —— 命中就是命中，不会截歪。
 *
 * 只认长度 >= 2 的名称：单字名（如「A」）在自然语言里误命中率太高。
 */
export function findCandidatesInText(text: string, list: NameCandidate[]): NameCandidate[] {
  const t = normalizeName(text);
  if (!t) return [];
  const hits = list.filter((x) => {
    const n = normalizeName(x.name);
    return n.length >= 2 && t.includes(n);
  });
  // 长名优先：「量子大厦 A 座」命中时不该再判给「量子大厦」
  return hits.sort((a, b) => normalizeName(b.name).length - normalizeName(a.name).length);
}

/**
 * 北京时间「今天 + days」的 YYYY-MM-DD
 *
 * 业务日是**北京自然日**：直接 `toISOString()` 得到的是 UTC 日期，
 * 早上 8 点前会差一天，把套餐排到昨天去。
 */
export function bjYmdPlus(now: Date, days: number): string {
  const BJ = 8 * 3600 * 1000;
  const d = new Date(now.getTime() + days * 24 * 3600 * 1000 + BJ);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}-${dd}`;
}

/**
 * 从一句话里认出「出餐日」。
 *
 * 只用**北京时间**算：业务日是北京时间的自然日，`mealDate` 是日期字符串（YYYY-MM-DD），
 * 不能用 UTC 的 toISOString —— 那在早上 8 点前会差一天，直接把套餐排到昨天去。
 *
 * 认不出来时返回 `explicit:false`，由上层追问「哪天？」——**绝不默认明天**：
 * 排错天的代价是「明天没饭吃」，比多问一句贵得多。
 */
export function parseMealDate(
  text: string,
  now: Date,
): { date: string | null; explicit: boolean; hint: string | null } {
  const t = normalizeName(text);

  // `now` 传真实当前时刻；先偏移到北京时间，再取「年月日」分量拼字符串。
  // 直接 toISOString() 会得到 UTC 日期 —— 早上 8 点前会差一天。
  const shift = (days: number): string => bjYmdPlus(now, days);

  if (t.includes('今天') || t.includes('今日'))
    return { date: shift(0), explicit: true, hint: null };
  if (t.includes('明天') || t.includes('明日'))
    return { date: shift(1), explicit: true, hint: null };
  if (t.includes('后天')) return { date: shift(2), explicit: true, hint: null };

  // 2026-12-03 / 2026/12/03 / 2026年12月3日
  const iso = /(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(t);
  if (iso) {
    const y = Number(iso[1]);
    const m = String(Number(iso[2])).padStart(2, '0');
    const d = String(Number(iso[3])).padStart(2, '0');
    return { date: `${y}-${m}-${d}`, explicit: true, hint: null };
  }

  // 12月3日 / 12-3 / 12/3（无年份，取今年）
  const md = /(\d{1,2})[-/月](\d{1,2})/.exec(t);
  if (md) {
    const y = bjYmdPlus(now, 0).slice(0, 4);
    const m = String(Number(md[1])).padStart(2, '0');
    const d = String(Number(md[2])).padStart(2, '0');
    return { date: `${y}-${m}-${d}`, explicit: true, hint: null };
  }

  return { date: null, explicit: false, hint: null };
}

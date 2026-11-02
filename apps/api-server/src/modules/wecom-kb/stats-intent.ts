/**
 * 统计问句识别（纯函数 · 无 IO）
 *
 * ⚠️ **为什么不塞进 `parseIntent`**：
 *   `parseIntent` 的 8 种意图已被单测锁定（帮助/排套餐/查单/我的申请/确认/取消/否定/未知），
 *   而统计问句的判定必须**早于** `matchCatalogEntry` 执行 —— 因为那里有一条
 *   `/^(?:看|查看|列出|打开)\s*(.+)$/` 会把「看经营数据」当成「搜端点：经营数据」，
 *   而目录里没有叫这个名字的模块 ⇒ 回「没找到」。顺序在 `reply()` 里显式写出来，
 *   比埋在 parseIntent 的 if 链里可维护。
 *
 * ⚠️ **只认明确说法，不做模糊猜测**（与 `matchCatalogEntry` 同一条纪律）：
 *   宁可漏认一句让人重说，也不要把「给量子大厦排套餐」误认成「想看数据」。
 *   因此词表里刻意**不收**「数据」这种单字宽泛词，也不收「上周」——
 *   「上周」是自然周口径，而本模块只支持「以某日为终点的 N 天」，
 *   认了它就会给出一个用户没要的区间。
 */

import { toBjIso } from '../../common/utils/time';

/** 五个统计视角（与 `/admin/stats/*` 的端点一一对应） */
export type StatsWhich = 'dashboard' | 'buildingRank' | 'dishHeat' | 'retention' | 'pageDuration';

/** 统计档位（与后端 `STATS_RANGES` 同值） */
export type StatsRangeWord = 'today' | '7d' | '30d';

export interface StatsIntent {
  which: StatsWhich;
  range: StatsRangeWord;
  /**
   * 区间**终点**相对今天的偏移天数：`0` = 含今天，`-1` = 截至昨天。
   *
   * ⚠️ 没有这个字段会出一个很难发现的错：用户说「昨天的经营数据」，
   *    若只把「昨天」当成一句废话、档位仍取默认 7d，就会给他近 7 天的数
   *    并标注区间 —— **数字全对、语义全错**，而且用户很难意识到自己看的不是昨天。
   *    「昨天」= `range='today'` + `endShift=-1`，两者缺一不可。
   */
  endShift: number;
}

/**
 * 视角词表 —— **顺序即优先级**：具体的先判，宽泛的（经营数据）最后兜。
 *
 * 若把 `dashboard` 放前面，`楼栋排行` 里没有 dashboard 的词，本不会误吃；
 * 但将来有人给 dashboard 补一个「排行」类词，顺序就决定成败，故这里固定成
 * 「窄 → 宽」，让新增词的人只需要往下面加、不必回头调顺序。
 */
const WHICH_RULES: ReadonlyArray<{ re: RegExp; which: StatsWhich }> = [
  { re: /(楼栋|楼群|哪栋楼|哪个楼|哪座楼)/, which: 'buildingRank' },
  {
    re: /(菜品热度|菜品排行|菜品榜|哪个菜|什么菜.*(卖|热销)|卖得最好|热销|口味排行)/,
    which: 'dishHeat',
  },
  { re: /(留存|复购|回头客|二次购买|老客)/, which: 'retention' },
  { re: /(页面停留|停留时长|停留时间|页面数据|哪个页面|页面访问)/, which: 'pageDuration' },
  {
    re: /(经营数据|经营情况|经营状况|经营看板|数据看板|核心指标|大盘|整体情况|生意怎么样|生意如何|报表|营业额|毛利|客单价|退款率)/,
    which: 'dashboard',
  },
];

/**
 * 「楼栋排行」的 `which` 只由「楼栋」二字决定，太窄（「楼栋停用」这类话会被误认）。
 * 故这里补一条**反向收窄**：命中「楼栋」但整句没有「排行/排名/榜/卖/下单/多少」时，不算统计问句。
 */
const RANK_SUFFIX = /(排行|排名|榜|卖|下单|多少|前几|TOP|top)/;

/**
 * 档位词表 —— 同样「具体先、宽泛后」。
 *
 * ⚠️ 「昨天/昨日」必须**排在**「今天/今日」前面，且映射为 `today + endShift=-1`：
 *    单日区间 + 终点回退一天。若只写「昨天 ⇒ 7d」会给出近 7 天（见 `StatsIntent.endShift` 注释）。
 *
 * ⚠️ 「本周/这周」是**近似**映射到 7d（自然周对齐需要另一套口径，本模块不做）。
 *    接受这个近似的理由：回复里**始终打印真实区间**（`10-26 ~ 11-01`），
 *    老板一眼能看出这不是「本周一至今」，不会在错误的区间上做判断。
 *    真要自然周口径，那是看板该补的能力，不该由聊天层猜。
 */
const RANGE_RULES: ReadonlyArray<{ re: RegExp; range: StatsRangeWord; endShift: number }> = [
  {
    re: /(近30天|近三十天|最近30天|最近一个月|近一个月|本月|这月|当月|30天|一个月)/,
    range: '30d',
    endShift: -1,
  },
  { re: /(近7天|近七天|最近7天|最近七天|本周|这周|七天|一周|7天)/, range: '7d', endShift: -1 },
  { re: /(昨天|昨日|前一天)/, range: 'today', endShift: -1 },
  { re: /(今天|今日|当天)/, range: 'today', endShift: 0 },
];

/** 默认：近 7 天、截至昨天（理由见 `defaultRangeOf`） */
const DEFAULT_RANGE: StatsRangeWord = '7d';
const DEFAULT_SHIFT = -1;

/**
 * 缺省档位为什么是 7 天而不是今天：
 *   `today` 的数据**还在长**（现在下午 2 点，今天只过了一半）。拿它跟「昨天全天」比，
 *   每天下午都会得出「跌了 40%」这种假警报。7 天是能覆盖一个完整自然周附近、
 *   又不至于把近期变化磨平的最小档位。
 */
export function defaultRangeOf(): StatsRangeWord {
  return DEFAULT_RANGE;
}

/** 识别人话里的统计意图；返回 null 表示这句不是在问数 */
export function parseStatsIntent(raw: string): StatsIntent | null {
  const t = (raw || '').trim();
  if (!t) return null;

  const which = whichOf(t);
  if (!which) return null;

  return { which, ...rangeOf(t) };
}

function whichOf(t: string): StatsWhich | null {
  for (const rule of WHICH_RULES) {
    if (!rule.re.test(t)) continue;
    // 「楼栋」单独出现几乎都不是想看排行（「楼栋停用」「楼栋怎么加」），
    // 必须带排行语义才算 —— 否则会把一整类运维操作误认成统计。
    if (rule.which === 'buildingRank' && !RANK_SUFFIX.test(t)) return null;
    return rule.which;
  }
  return null;
}

function rangeOf(t: string): { range: StatsRangeWord; endShift: number } {
  for (const rule of RANGE_RULES) {
    if (rule.re.test(t)) return { range: rule.range, endShift: rule.endShift };
  }
  return { range: DEFAULT_RANGE, endShift: DEFAULT_SHIFT };
}

/** 档位对应的天数（环比回退时要用它算上期终点） */
export function daysOf(range: StatsRangeWord): number {
  if (range === 'today') return 1;
  if (range === '30d') return 30;
  return 7;
}

/** 北京「今天」的日期串（YYYY-MM-DD）。统计区间的终点基准一律取它，不用本地时区 */
export function bjTodayStr(at: Date): string {
  const iso = toBjIso(at);
  // toBjIso 已做 +08:00 平移，前 10 位就是北京日历日
  return iso ? iso.slice(0, 10) : '';
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 日期加减（纯字符串运算，不经过本地时区）
 *
 * ⚠️ 不能用 `new Date('2026-11-01')` 再 `setDate()`：那样得到的是**本地时区**的
 *    零点，而本机与服务器时区不一定相同，跨时区会整体偏一天。
 *    这里用 `Date.UTC` 做纯日历运算，输入输出都是「日历日」，与时区无关。
 */
export function addDays(dateStr: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + delta * 86_400_000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * 本期区间的**终点锚点**（出餐日）
 *
 * 由 `endShift` 决定：`0` = 含今天，`-1` = 截至昨天。
 * 缺省档位一律 −1 —— 今天的数据还在长，拿「含半个今天」的区间去和「完整上期」比，
 * 每天下午都会得出「跌了 40%」的假警报。
 */
export function endDateOf(intent: StatsIntent, today: string): string {
  return addDays(today, intent.endShift);
}

/**
 * 上期区间的终点锚点 —— 往前整平移一个档位长度，**与本期不重叠**。
 *
 * 本期 [end-6, end]（7d）⇒ 上期 [end-13, end-7]，终点 = end-7。
 */
export function prevEndDateOf(intent: StatsIntent, endDate: string): string {
  return addDays(endDate, -daysOf(intent.range));
}

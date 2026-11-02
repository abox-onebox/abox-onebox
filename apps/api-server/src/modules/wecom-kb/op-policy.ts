import { ADMIN_CATALOG } from './op-catalog.generated';
import type { CatalogEntry } from './op-catalog.types';

/**
 * 操作权限策略（纯函数，零 IO）
 *
 * 为什么把「谁能做什么」单独抽一层：
 *   机器人现在能打到**全部 131 个后台端点**，一旦判定写错，代价是「同事顺手把账调了」
 *   或者「负责人自己反而干不了」。所以判据必须是一个可单测、可穷举的纯函数，
 *   而不是散在会话流程里的 if。
 *
 * 两个概念必须分开（混起来就会互相打架）：
 *   · **tier**（人）：`owner` = 负责人本人，`staff` = 同事。
 *   · **risk**（事）：`low` 只读、`mid` 改数据、`high` 动钱/动单/动权。
 *   谁能做什么 = tier × risk × 端点自带的 @Roles，三者取交集，缺一不可。
 */

export type Tier = 'owner' | 'staff';
export type Risk = 'low' | 'mid' | 'high';

/** tier → 机器人执行时使用的后台角色（服务账号就是这个角色） */
export const TIER_ROLE: Record<Tier, string> = {
  owner: 'admin',
  staff: 'operator',
};

export const TIER_LABEL: Record<Tier, string> = {
  owner: '负责人',
  staff: '同事',
};

/**
 * 执行身份：机器人该用**哪个角色**的服务账号去打后台。
 *
 *   owner → admin 角色（全部端点）
 *   staff → operator 角色（只有它本来能做的那些，其余由后台 @Roles 直接拒）
 *
 * ⚠️ 同事一旦有**单独放权清单**，执行身份必须升到 owner：
 *    被放权的端点（如退款审批）`@Roles` 里没有 operator，用 operator 令牌打过去
 *    会被后台 403 —— 现象是「后台明明点了放权，机器人还说做不了」。
 *    安全性**不依赖身份本身**，而靠 `canExec` 按清单逐条判（执行入口 + 展示层各一次）：
 *    清单外的端点在 `execCatalog` 入口就被 403 挡掉，根本发不到后台。
 *
 * ⚠️⚠️ 这条规则**只能有一个出处**。试跑台若自己写死 `owner`，跑出来的就不是
 *    「同事看到的结论」—— 那样试跑等于没试（2026-11-02 实修：试跑台看不出放权效果）。
 */
export function execTierOf(tier: Tier, granted?: readonly string[]): Tier {
  return tier === 'owner' || (granted?.length ?? 0) > 0 ? 'owner' : 'staff';
}

/**
 * 高危模块（写操作一律按「动钱/动单/动权」处理）。
 *
 * ⚠️ 必须用**真实模块名**（路径第 2 段，取自实际控制器前缀），不能凭印象写单数：
 *    实测踩过 —— 写 `order` / `leader` 而真实是 `orders` / `leaders`，
 *    结果订单与团长的写操作被判成「mid 改数据」，同事可以直接改单。
 *    改这里之前先跑 `modules()` 把真实模块名打出来。
 */
const HIGH_MODULES = new Set([
  'finance', // 财务（含 finance/refunds）
  'orders', // 订单：改单 / 强制退款 / 状态流转
  'leaders', // 团长：任命 / 变更 / 资质
  'users', // 用户：封禁 / 资料
  'suppliers', // 供应商：资质 / 结算账户
  'supplier-shares', // 供应商分成
  'system', // 后台账号：建号 / 改口令 / 权限
  'op-blocklist', // 禁止清单（能改它就能解除自己的限制）
  'coupon', // 代金券 = 发钱
]);

/** 高危动作词（路径里出现即视为 high，即使模块本身不敏感） */
const HIGH_ACTIONS =
  /(force|refund|cancel|adjust|approve|reject|publish|revoke|grant|delete|remove|reset)/i;

export function riskOf(entry: CatalogEntry): Risk {
  if (entry.method === 'GET') return 'low';
  if (entry.method === 'DELETE') return 'high';

  const segs = entry.path.split('/').filter(Boolean); // ['admin', 'finance', 'refunds', ...]
  const moduleSeg = (segs[1] || '').toLowerCase();
  const tail = '/' + segs.slice(2).join('/');

  if (HIGH_MODULES.has(moduleSeg)) return 'high';
  if (moduleSeg.startsWith('supplier') || moduleSeg.startsWith('finance')) return 'high';
  if (HIGH_ACTIONS.test(tail)) return 'high';
  return 'mid';
}

export const RISK_LABEL: Record<Risk, string> = {
  low: '只读',
  mid: '改数据',
  high: '动钱/动单/动权',
};

export interface PermissionResult {
  ok: boolean;
  /** 不通过时给人看的一句话（说清「为什么不行」和「该找谁」） */
  reason?: string;
  /** 该端点要求的角色（源码 @Roles 真值） */
  roles: string[];
  risk: Risk;
}

/** 放权上下文：单独放给某个同事的端点清单 + 当前这条的编码 */
export interface GrantCtx {
  /** 单独放权的端点编码（取自目录 code）。owner 忽略此字段。 */
  granted?: readonly string[];
  /** 当前端点的编码 —— 少了它就无法判断「这一条在不在清单里」，等于没放权 */
  code?: string;
}

/** 这一条是否被单独放权（只看 staff；owner 不需放权） */
export function isGranted(
  tier: Tier,
  code: string | undefined,
  granted?: readonly string[],
): boolean {
  if (tier !== 'staff') return false;
  if (!code || !granted || granted.length === 0) return false;
  return granted.includes(code);
}

/**
 * 能不能执行这个端点。
 *
 * @param tier 谁在操作
 * @param entry 端点
 * @param opts.requireOwnerForHigh owner tier 是否可以对 high 直接执行
 *        （true = 负责人本人直干；false = 连负责人也必须走审批，一期不用）
 * @param opts.granted 单独放权清单（见 GrantCtx）
 * @param opts.code 当前端点编码（见 GrantCtx）
 */
export function canExec(
  tier: Tier,
  entry: CatalogEntry,
  opts: { requireOwnerForHigh?: boolean } & GrantCtx = {},
): PermissionResult {
  const risk = riskOf(entry);
  const roles = entry.roles || [];
  const role = TIER_ROLE[tier];

  // ── 单独放权：**必须**排在角色判定之前 ──────────────────────────
  // 被放权的端点通常 `@Roles` 里根本没有 operator（这正是同事做不了的原因），
  // 若先判角色，会出现「后台明明点了放权，机器人还是说做不了」。
  // 真正的安全靠两层：① 这里只放清单内的编码；② 执行身份升到 owner 后，
  // 执行入口（op-proxy.execCatalog）会再判一次，收回权限立刻失效。
  if (isGranted(tier, opts.code, opts.granted)) {
    return { ok: true, roles, risk, reason: '这一项是单独放给你的，可以做。' };
  }

  // 源码没标 @Roles：不默认放行，只允许负责人操作（并提示这是未标注端点）
  if (roles.length === 0) {
    if (tier === 'owner')
      return {
        ok: true,
        roles,
        risk,
        reason: '这个端点源码里没有标注角色，按最高权限处理，只允许负责人操作。',
      };
    return { ok: false, roles, risk, reason: '这个端点没有明确的角色限制，只有负责人能用。' };
  }

  if (!roles.includes(role)) {
    const who = roles
      .map((r) => (r === 'operator' ? '同事' : r === 'admin' ? '负责人' : r))
      .join(' / ');
    return {
      ok: false,
      roles,
      risk,
      reason: `这件事后台只允许「${who}」做，你当前的执行身份是 ${TIER_LABEL[tier]}（${role}），做不了。`,
    };
  }

  if (tier === 'staff' && risk === 'high' && !opts.requireOwnerForHigh) {
    return {
      ok: false,
      roles,
      risk,
      reason: '这属于动钱/动单/动权的操作，同事不能直接做。可以让负责人批，或找他本人执行。',
    };
  }

  return { ok: true, roles, risk };
}

/** 目录里的一条 + 它的编码，用于列表展示与执行 */
export interface CatalogItem {
  code: string;
  entry: CatalogEntry;
  risk: Risk;
}

const ALL_ITEMS: CatalogItem[] = Object.entries(ADMIN_CATALOG).map(([code, entry]) => ({
  code,
  entry,
  risk: riskOf(entry),
}));

export function allItems(): CatalogItem[] {
  return ALL_ITEMS;
}

/** 业务模块（路径第 2 段），用于「操作目录」顶层分组 */
export function moduleOf(entry: CatalogEntry): string {
  const segs = entry.path.split('/').filter(Boolean);
  return segs[1] || '(根)';
}

export interface ModuleSummary {
  module: string;
  total: number;
  /** 当前 tier 能直接执行的条数（用于让他知道「这些我能干」） */
  allowed: number;
}

export function modules(tier: Tier, granted?: readonly string[]): ModuleSummary[] {
  const map = new Map<string, ModuleSummary>();
  for (const it of ALL_ITEMS) {
    const m = moduleOf(it.entry);
    const cur = map.get(m) || { module: m, total: 0, allowed: 0 };
    cur.total += 1;
    if (canExec(tier, it.entry, { granted, code: it.code }).ok) cur.allowed += 1;
    map.set(m, cur);
  }
  return [...map.values()].sort((a, b) => a.module.localeCompare(b.module));
}

/** 某模块下的端点（按当前 tier + 放权清单过滤；allowedOnly=false 时也列出不可用的并标注原因） */
export function itemsOfModule(
  module: string,
  tier: Tier,
  allowedOnly = true,
  granted?: readonly string[],
): CatalogItem[] {
  return ALL_ITEMS.filter(
    (it) =>
      moduleOf(it.entry) === module &&
      (!allowedOnly || canExec(tier, it.entry, { granted, code: it.code }).ok),
  ).sort((a, b) => a.entry.path.localeCompare(b.entry.path));
}

/** 当前身份 + 放权清单下「能直接用」的条数（「操作目录」首行用） */
export function usableCount(tier: Tier, granted?: readonly string[]): number {
  return ALL_ITEMS.filter((it) => canExec(tier, it.entry, { granted, code: it.code }).ok).length;
}

/**
 * 按关键词找端点。匹配顺序（越靠前越可信）：
 *   中文名 → 路径 → 精确编码。命中多个时由调用方列候选让他回数字，绝不猜。
 */
export function search(
  keyword: string,
  tier: Tier,
  limit = 8,
  granted?: readonly string[],
): CatalogItem[] {
  const k = (keyword || '').trim().toLowerCase();
  if (!k) return [];
  const scored: { it: CatalogItem; score: number }[] = [];
  for (const it of ALL_ITEMS) {
    if (!canExec(tier, it.entry, { granted, code: it.code }).ok) continue;
    const label = it.entry.label.toLowerCase();
    const p = it.entry.path.toLowerCase();
    let score = 0;
    if (it.code === k) score = 100;
    else if (label === k) score = 90;
    else if (label.includes(k)) score = 70;
    else if (p.includes(k)) score = 50;
    else if (k.split(/\s+/).every((w) => label.includes(w) || p.includes(w))) score = 40;
    if (score > 0) scored.push({ it, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.it.entry.path.localeCompare(b.it.entry.path))
    .slice(0, limit)
    .map((x) => x.it);
}

/** 取一条（编码精确匹配） */
export function find(code: string): CatalogItem | undefined {
  return ALL_ITEMS.find((x) => x.code === code);
}

/**
 * 规整放权清单：去重、去空、剔除目录里不存在的编码。
 *
 * 为什么必须剔除：端点编码由源码自动生成，`/admin` 路由改名或删除后编码会消失。
 * 清单里残留死编码不会造成越权（`isGranted` 只对存在的端点生效），
 * 但会让管理员在页面上看到「明明放权了却用不了」，也会让清单越来越脏。
 */
export function normalizeGrant(codes: unknown): { valid: string[]; unknown: string[] } {
  const arr = Array.isArray(codes) ? codes : [];
  const valid: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const raw of arr) {
    const c = String(raw ?? '').trim();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    if (find(c)) valid.push(c);
    else unknown.push(c);
  }
  return { valid, unknown };
}

/**
 * 端点展示名：优先中文 summary，没有就退回「方法 + 路径」。
 * 后台 summary 常带编号前缀（`D41 审批通过 →…`），去掉更像个动作名。
 */
export function displayName(entry: CatalogEntry): string {
  const raw = (entry.label || '').trim();
  const cleaned = raw.replace(/^[A-Z]\d{1,3}\s+/, '');
  return cleaned || `${entry.method} ${entry.path}`;
}

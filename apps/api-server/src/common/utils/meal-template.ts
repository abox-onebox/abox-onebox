/**
 * 套餐模板草稿 · 生成与复核（#A 供给侧 AI 建模板）
 *
 * 为什么有这一层（与 `scripts/gen-meal-template.mjs` 的 `validateTemplateDraft` **不重复**）：
 *   · 脚本那层用的是「生成那一刻的快照」菜品集，只防 **LLM 编造 ID / 选下架菜**。
 *   · 这一层用的是**实时**菜品集（调用方重新拉取），补的是 **快照失效**：
 *     这几秒里某菜被下架 / 被改名，生成时合法的草稿，确认时可能已不合法。
 *
 * 两层都留着是有意的纵深防御：脚本管「编造」，这里管「失效 + 构成 + 重名 + 品类隔离」。
 * 纯函数、零 IO —— 便于单测钉死；调用方不许把这里的判断再写一遍。
 *
 * ⭐ 2026-11-10 加「品类隔离」：当前只跑预包装快消品，`fmcg` 模板里混进现做菜
 *    （`ab_item.category` 非空）就等于「仅销售预包装食品备案」下实际制售，属资质混用。
 *    判据以**单品品类**为准，不靠模板名猜；将来开盒饭两类共存也不冲突。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** 后台下发的生成入参（来自实时菜品库 + 提案原文） */
export interface MealTemplateGenInput {
  proposalText: string;
  kind: 'meal' | 'fmcg';
  /** 在售单品白名单（id + name + status + category；category 用于品类隔离） */
  dishes: Array<{
    id: number;
    name?: string | null;
    status?: number | null;
    category?: string | null;
  }>;
  /** 现有模板名（用于重名检测） */
  existingTemplates?: Array<{ id: number; name?: string }>;
}

export interface MealTemplateDraftItem {
  itemId: number;
  slot: number;
}

export interface MealTemplateDraft {
  name: string;
  kind: 'meal' | 'fmcg';
  price?: number;
  items: MealTemplateDraftItem[];
  reason?: string;
}

export interface MealTemplateGenResult {
  ok: boolean;
  kind: string;
  mode: string;
  drafts: MealTemplateDraft[];
  dropped: Array<{ draft: unknown; why: string }>;
  notes: string[];
  generatedAt?: string;
  message?: string;
}

// 与 @abox/shared-utils SET_MEAL_COMPOSITION 同源（util 侧硬拷贝，避免引 TS 包进纯函数）
const REQUIRED_SLOTS = [1, 2, 3, 4];
const SLOT_LABEL: Record<number, string> = {
  1: '主件',
  2: '辅品',
  3: '素品',
  4: '附品',
  5: '随附',
};
const STAPLE_SLOT = 5;

export type TemplateBlockCode =
  | 'bad_shape'
  | 'unknown_dish'
  | 'off_shelf'
  | 'kind_mismatch'
  | 'dup_item'
  | 'composition'
  | 'dup_name'
  | 'empty';

/**
 * `ab_item.category` 非空 = 现做菜（main/half/veg/soup/…）；
 * 为空 / null = 独立预包装快消单品（生产库实测：fmcg 套餐 28 个单品全部 category IS NULL）。
 *
 * ⚠️ 这是「品类隔离」唯一判据，脚本 `gen-meal-template.mjs` 的 `filterDishesByKind`
 *    必须与它逐字同源；两边漂移会让「生成时拦了、确认时又放行」。
 */
export function isCookedDish(category: string | null | undefined): boolean {
  return category != null && String(category).trim() !== '';
}

/** 该单品能不能进这个品类的模板 */
export function dishFitsKind(kind: 'meal' | 'fmcg', category: string | null | undefined): boolean {
  return kind === 'fmcg' ? !isCookedDish(category) : isCookedDish(category);
}

export interface TemplateBlocked {
  name: string;
  code: TemplateBlockCode;
  /** 人话，端上可直接展示 */
  detail: string;
}

export interface RevalidateTemplateCtx {
  /** 必带 `category`：缺了就无法判品类，宁可编译期报错也不要运行时 fail-open */
  dishes: Array<{ id: number; status?: number | null; category: string | null }>;
  /** 现有模板名（小写去空白集合），用于重名检测 */
  existingNames: Set<string>;
}

/**
 * 用**实时**菜品集复核一条待确认草稿（不抛错，返回 ok / blocked）。
 * 任何畸形输入都退化为 blocked，confirm 链路不允许因脏数据崩掉。
 */
export function revalidateMealTemplateDraft(
  draft: MealTemplateDraft,
  ctx: RevalidateTemplateCtx,
): { ok: true; row: MealTemplateDraft } | { ok: false; blocked: TemplateBlocked } {
  const name = String((draft as { name?: unknown })?.name ?? '').trim();
  if (!name) {
    return { ok: false, blocked: { name: '', code: 'bad_shape', detail: '模板名不能为空' } };
  }
  if (ctx.existingNames.has(name.toLowerCase())) {
    return {
      ok: false,
      blocked: { name, code: 'dup_name', detail: `模板名「${name}」与现有模板重名` },
    };
  }

  const items = Array.isArray((draft as { items?: unknown })?.items)
    ? (draft as { items: MealTemplateDraftItem[] }).items
    : [];
  if (items.length === 0) {
    return {
      ok: false,
      blocked: { name, code: 'empty', detail: `模板「${name}」没有任何商品项` },
    };
  }

  const dishById = new Map<number, { status?: number | null; category: string | null }>();
  for (const d of ctx.dishes)
    dishById.set(Number(d.id), { status: d.status, category: d.category });

  const normItems: MealTemplateDraftItem[] = [];
  for (const it of items) {
    const itemId = Number((it as { itemId?: unknown })?.itemId);
    const slot = Number((it as { slot?: unknown })?.slot);
    if (!Number.isFinite(itemId) || !dishById.has(itemId)) {
      return {
        ok: false,
        blocked: { name, code: 'unknown_dish', detail: `模板「${name}」含不存在的菜品 #${itemId}` },
      };
    }
    if (dishById.get(itemId)?.status !== 1) {
      return {
        ok: false,
        blocked: { name, code: 'off_shelf', detail: `模板「${name}」含已下架菜品 #${itemId}` },
      };
    }
    // 品类隔离：kind 取自**草稿自身**（可能是 LLM 写的），不与输入 kind 混用
    const draftKind = (draft as { kind?: string })?.kind === 'fmcg' ? 'fmcg' : 'meal';
    if (!dishFitsKind(draftKind, dishById.get(itemId)?.category)) {
      return {
        ok: false,
        blocked: {
          name,
          code: 'kind_mismatch',
          detail:
            `模板「${name}」是「${draftKind}」，却混入了` +
            (draftKind === 'fmcg' ? '现做菜' : '预包装快消单品') +
            ` #${itemId}（品类不符，不能入库）`,
        },
      };
    }
    if (!Number.isInteger(slot) || slot < 1 || slot > 5) {
      return {
        ok: false,
        blocked: {
          name,
          code: 'bad_shape',
          detail: `模板「${name}」含非法档位 slot=${slot}（需 1–5）`,
        },
      };
    }
    normItems.push({ itemId, slot });
  }

  if (new Set(normItems.map((p) => p.itemId)).size !== normItems.length) {
    return {
      ok: false,
      blocked: { name, code: 'dup_item', detail: `模板「${name}」含重复商品项` },
    };
  }

  const kind = (draft as { kind?: string })?.kind === 'fmcg' ? 'fmcg' : 'meal';
  if (kind === 'meal') {
    const slots = normItems.map((p) => p.slot);
    const missing = REQUIRED_SLOTS.filter((s) => !slots.includes(s));
    const extra = slots.filter((s) => s === STAPLE_SLOT);
    if (missing.length || extra.length) {
      const parts: string[] = [];
      if (missing.length)
        parts.push(`缺少档位 ${missing.map((s) => SLOT_LABEL[s] ?? s).join(' / ')}`);
      if (extra.length) parts.push('含不允许的主食档位 slot=5（米饭由集散中心统一供，不建商品项）');
      return {
        ok: false,
        blocked: {
          name,
          code: 'composition',
          detail: `模板「${name}」不满足一饭四菜：${parts.join('；')}`,
        },
      };
    }
  }

  return {
    ok: true,
    row: {
      name,
      kind,
      price: (draft as { price?: number }).price,
      items: normItems,
      reason: String((draft as { reason?: unknown })?.reason ?? ''),
    },
  };
}

// ---------------------------------------------------------------- 脚本调用

function resolveRepoRoot(): string {
  const candidates: string[] = [];
  if (typeof __dirname !== 'undefined') candidates.push(resolve(__dirname, '../../../../'));
  candidates.push(resolve(process.cwd(), '..', '..'));
  candidates.push(process.cwd());
  for (const c of candidates) {
    if (existsSync(join(c, 'scripts', 'gen-meal-template.mjs'))) return c;
  }
  return candidates[0];
}

function pickWritableDir(repoRoot: string): string {
  const candidates = [
    join(repoRoot, 'data', 'uploads', 'meal-template'),
    join(repoRoot, 'releases', 'meal-template'),
    join(tmpdir(), 'abox-meal-template'),
  ];
  for (const c of candidates) {
    try {
      mkdirSync(c, { recursive: true });
      writeFileSync(join(c, '.w'), '');
      unlinkSync(join(c, '.w'));
      return c;
    } catch {
      /* 不可写，试下一个 */
    }
  }
  return candidates[candidates.length - 1];
}

/**
 * 调脚本生成模板草稿。失败（脚本缺失 / 超时 / 输出非 JSON）一律降级为空草稿 + 说明，
 * 绝不抛错中断调用方（生成层与主流程解耦）。
 */
export async function generateMealTemplateDraft(
  input: MealTemplateGenInput,
  timeoutMs = 60_000,
): Promise<MealTemplateGenResult> {
  const repoRoot = resolveRepoRoot();
  const script = join(repoRoot, 'scripts', 'gen-meal-template.mjs');
  const tmpDir = pickWritableDir(repoRoot);
  const plainFile = join(tmpDir, `_mt_${Date.now()}.json`);

  try {
    writeFileSync(plainFile, JSON.stringify(input), 'utf8');
  } catch {
    return {
      ok: false,
      kind: input.kind,
      mode: 'error',
      drafts: [],
      dropped: [],
      notes: [],
      message: '候选集写不进临时文件（磁盘权限）',
    };
  }

  if (!existsSync(script)) {
    try {
      unlinkSync(plainFile);
    } catch {
      /* noop */
    }
    return {
      ok: false,
      kind: input.kind,
      mode: 'error',
      drafts: [],
      dropped: [],
      notes: [],
      message: `模板草稿脚本未找到（${script}），请确认部署包完整。`,
    };
  }

  const out = await new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (m: string | null): void => {
      if (!settled) {
        settled = true;
        resolve(m);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('node', [script, '--plain-file', plainFile], {
        cwd: repoRoot,
        env: { ...process.env },
      });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* noop */
      }
      finish(null);
    }, timeoutMs);
    let buf = '';
    child.stdout?.on('data', (d) => (buf += String(d)));
    child.stderr?.on('data', () => undefined);
    child.on('error', () => finish(null));
    child.on('close', () => {
      clearTimeout(timer);
      finish(buf.trim() ? buf.trim() : null);
    });
  });

  try {
    unlinkSync(plainFile);
  } catch {
    /* noop */
  }

  if (!out) {
    return {
      ok: false,
      kind: input.kind,
      mode: 'error',
      drafts: [],
      dropped: [],
      notes: ['生成超时或脚本异常，已转人工'],
      message: '生成超时（>60s）或脚本异常',
    };
  }
  try {
    const parsed = JSON.parse(out) as MealTemplateGenResult;
    if (!parsed || !Array.isArray(parsed.drafts)) {
      return {
        ok: false,
        kind: input.kind,
        mode: 'error',
        drafts: [],
        dropped: [],
        notes: [],
        message: '生成结果结构无法解析',
      };
    }
    return parsed;
  } catch {
    return {
      ok: false,
      kind: input.kind,
      mode: 'error',
      drafts: [],
      dropped: [],
      notes: [],
      message: '生成结果非 JSON',
    };
  }
}

/**
 * 开团草稿 · 展示前「实时复核」闸（#1 自动开团闭环 · 批 2）
 *
 * 为什么要有这一层（与 `scripts/gen-launch-draft.mjs` 的 `validateDraft` **不重复**）：
 *   · 脚本那层用的是「生成那一刻的快照」候选集，只防 **LLM 编造 ID**（编个 999 的模板）。
 *   · 这一层用的是**实时**模板与楼群（调用方重新拉取），补的是 **快照失效**：
 *     这几秒里模板被停用 / 楼群被停用 / 该楼群当天已被排过。
 *   · 并额外拦掉 `kind !== 'meal'` 的模板 —— 生产库实测 `ab_set_meal` 里混着
 *     `fmcg`（预包装快消品）套餐，id 合法、状态正常，但**绝不该进餐盒开团**。
 *     ⚠️ 脚本侧只看 id、看不到 kind，这个洞只有这一层能堵。
 *
 * 两层都留着是有意的纵深防御，不是「同一条判据写两遍」：
 *   脚本管「编造」，这里管「失效 + 类型错配 + 冲突」。
 *
 * 纯函数、零 IO —— 便于单测钉死；调用方不许把这里的判断再写一遍。
 */

/** 楼上/楼群候选（`/admin/building-groups` 形状） */
export interface LaunchDraftGroupRef {
  id: number;
  name?: string | null;
  /** 1 = 启用；缺省视为启用（上游某些视图不返回该字段） */
  status?: number | null;
}

/** 套餐模板候选（`/admin/meal/templates` 形状） */
export interface LaunchDraftTemplateRef {
  id: number;
  name?: string | null;
  status?: number | null;
  /** `meal` = 餐盒套餐；`fmcg` = 预包装快消品（不可开团） */
  kind?: string | null;
  priceFen?: number | null;
  usedCount?: number | null;
}

export interface LaunchDraftRecheckCtx {
  /** 本次排期日（逐日排）。以调用方传入为准 */
  mealDate: string;
  groups: LaunchDraftGroupRef[];
  templates: LaunchDraftTemplateRef[];
}

export type LaunchDraftBlockCode =
  | 'bad_shape'
  | 'date_mismatch'
  | 'group_unknown'
  | 'group_disabled'
  | 'template_unknown'
  | 'template_disabled'
  | 'template_kind_mismatch'
  | 'duplicate_group';

export interface LaunchDraftRow {
  mealDate: string;
  buildingGroupId: number;
  buildingGroupName: string;
  setMealId: number;
  setMealName: string;
  priceFen: number;
  usedCount: number;
  reason: string;
}

export interface LaunchDraftBlocked {
  buildingGroupId: number | null;
  setMealId: number | null;
  code: LaunchDraftBlockCode;
  /** 人话，端上可直接展示 */
  detail: string;
}

export interface LaunchDraftRecheckResult {
  rows: LaunchDraftRow[];
  blocked: LaunchDraftBlocked[];
}

const ENABLED = 1;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function toNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 启用判定：缺 `status` 视为启用（上游视图不保证带该字段），只有显式非 1 才拦。
 * 导出给调用方组候选集时用 —— 判据只此一份，服务层不许再写一遍。
 */
export function isLaunchCandidateEnabled(status: number | null | undefined): boolean {
  if (status === null || status === undefined) return true;
  return Number(status) === ENABLED;
}

/** 是否是「餐盒套餐」。`fmcg`（预包装快消品）同样存在 `ab_set_meal` 里，但不可开团。 */
export function isMealTemplate(t: LaunchDraftTemplateRef): boolean {
  return (t?.kind ?? 'meal').toString().toLowerCase() === 'meal';
}

/**
 * 复核一份草稿：`raw` 是脚本产出的 JSON（`{drafts:[...]}`）。
 * 任何畸形输入都**不抛错**，退化为「全拦截 + 说明」——开团链路不允许因脏数据崩掉对话。
 */
export function revalidateLaunchDraft(
  raw: unknown,
  ctx: LaunchDraftRecheckCtx,
): LaunchDraftRecheckResult {
  const rows: LaunchDraftRow[] = [];
  const blocked: LaunchDraftBlocked[] = [];

  const groupById = new Map<number, LaunchDraftGroupRef>();
  for (const g of ctx.groups ?? []) {
    const id = toNum(g?.id);
    if (id !== null) groupById.set(id, g);
  }
  const tplById = new Map<number, LaunchDraftTemplateRef>();
  for (const t of ctx.templates ?? []) {
    const id = toNum(t?.id);
    if (id !== null) tplById.set(id, t);
  }

  const root = asRecord(raw);
  const list = root && Array.isArray(root.drafts) ? root.drafts : null;
  if (!list) {
    return {
      rows,
      blocked: [
        {
          buildingGroupId: null,
          setMealId: null,
          code: 'bad_shape',
          detail: '草稿结构不认识（缺少 drafts 数组），已整体丢弃，请重试或转人工',
        },
      ],
    };
  }

  const seenGroup = new Set<number>();

  for (const item of list) {
    const d = asRecord(item);
    if (!d) {
      blocked.push({
        buildingGroupId: null,
        setMealId: null,
        code: 'bad_shape',
        detail: '有一条草稿不是对象，已丢弃',
      });
      continue;
    }

    const bgId = toNum(d.buildingGroupId);
    const smId = toNum(d.setMealId);
    const reason = typeof d.reason === 'string' ? d.reason.trim() : '';

    // 1) 日期：以本次排期为准；缺省继承，显式冲突才拦（逐日排）
    const rawDate = typeof d.mealDate === 'string' ? d.mealDate.trim() : '';
    if (rawDate && rawDate !== ctx.mealDate) {
      blocked.push({
        buildingGroupId: bgId,
        setMealId: smId,
        code: 'date_mismatch',
        detail: `草稿日期「${rawDate}」与本次排期「${ctx.mealDate}」不一致（逐日排，只认一天）`,
      });
      continue;
    }

    // 2) 楼群
    if (bgId === null) {
      blocked.push({
        buildingGroupId: null,
        setMealId: smId,
        code: 'bad_shape',
        detail: '草稿缺 buildingGroupId，已丢弃',
      });
      continue;
    }
    const group = groupById.get(bgId);
    if (!group) {
      blocked.push({
        buildingGroupId: bgId,
        setMealId: smId,
        code: 'group_unknown',
        detail: `楼群 #${bgId} 不在当前楼群清单里（可能已删除），已丢弃`,
      });
      continue;
    }
    if (!isLaunchCandidateEnabled(group.status)) {
      blocked.push({
        buildingGroupId: bgId,
        setMealId: smId,
        code: 'group_disabled',
        detail: `楼群「${group.name || '#' + bgId}」已停用，不能开团`,
      });
      continue;
    }
    if (seenGroup.has(bgId)) {
      blocked.push({
        buildingGroupId: bgId,
        setMealId: smId,
        code: 'duplicate_group',
        detail: `楼群「${group.name || '#' + bgId}」出现多条（一楼群一日只能一套餐），只保留第一条`,
      });
      continue;
    }

    // 3) 模板
    if (smId === null) {
      blocked.push({
        buildingGroupId: bgId,
        setMealId: null,
        code: 'bad_shape',
        detail: `楼群「${group.name || '#' + bgId}」的草稿缺 setMealId，已丢弃`,
      });
      continue;
    }
    const tpl = tplById.get(smId);
    if (!tpl) {
      blocked.push({
        buildingGroupId: bgId,
        setMealId: smId,
        code: 'template_unknown',
        detail: `套餐模板 #${smId} 不存在（可能已删除），已丢弃`,
      });
      continue;
    }
    if (!isMealTemplate(tpl)) {
      const kind = String(tpl.kind);
      blocked.push({
        buildingGroupId: bgId,
        setMealId: smId,
        code: 'template_kind_mismatch',
        detail: `模板「${tpl.name || '#' + smId}」是「${kind}」（非餐盒套餐），不能用于开团`,
      });
      continue;
    }
    if (!isLaunchCandidateEnabled(tpl.status)) {
      blocked.push({
        buildingGroupId: bgId,
        setMealId: smId,
        code: 'template_disabled',
        detail: `模板「${tpl.name || '#' + smId}」已停用，不能上架`,
      });
      continue;
    }

    seenGroup.add(bgId);
    rows.push({
      mealDate: ctx.mealDate,
      buildingGroupId: bgId,
      buildingGroupName: group.name || `楼群#${bgId}`,
      setMealId: smId,
      setMealName: tpl.name || `套餐#${smId}`,
      priceFen: toNum(tpl.priceFen) ?? 0,
      usedCount: toNum(tpl.usedCount) ?? 0,
      reason,
    });
  }

  rows.sort((a, b) => a.buildingGroupId - b.buildingGroupId);
  return { rows, blocked };
}

/**
 * 企微/后台统一展示文本（纯函数）。
 * 刻意写明「未写库、不会自动执行」—— 批 3 之前执行链路根本不存在，
 * 回复里不能让同事误以为已经排上了。
 */
export function launchDraftText(
  res: LaunchDraftRecheckResult,
  opt: { mealDate: string; mode?: string },
): string {
  const lines: string[] = [];
  const mode = opt.mode === 'stub' ? '（确定性占位模式，未调 AI）' : '';
  lines.push(`开团草稿 · ${opt.mealDate}（逐日排）${mode}`);

  if (res.rows.length === 0) {
    lines.push('');
    lines.push('这次没排出可用草稿。');
  } else {
    lines.push('');
    res.rows.forEach((r, i) => {
      const price = r.priceFen > 0 ? ` ¥${(r.priceFen / 100).toFixed(2)}` : '';
      lines.push(
        `${i + 1}) ${r.buildingGroupName} → ${r.setMealName}${price}` +
          `（历史被排 ${r.usedCount} 次）`,
      );
      if (r.reason) lines.push(`   理由：${r.reason}`);
    });
  }

  if (res.blocked.length > 0) {
    lines.push('');
    lines.push(`已拦截 ${res.blocked.length} 条：`);
    for (const b of res.blocked) lines.push(`· ${b.detail}`);
  }

  lines.push('');
  lines.push('这是草稿，没有写库、也不会自动上架线上排期。');
  return lines.join('\n');
}

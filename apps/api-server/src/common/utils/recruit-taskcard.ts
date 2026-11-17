/**
 * 招募任务卡 · 生成与复核（AI 编排节点 G · 安全版）
 *
 * 为什么有这一层（与 `scripts/gen-recruit-taskcard.mjs` 的 `validateTaskCards` 不重复）：
 *   · 脚本那层用的是「生成那一刻的快照」缺口集，只防 **LLM 编造楼 / 禁用词 / 篡改数字**。
 *   · 这一层用**实时**缺口集（调用方确认时重新拉），补的是 **快照失效**：
 *     这几分钟里这栋楼可能已有在职团长 / 已非在营 → 生成时合法的卡，确认时不能再发。
 *
 * 两层都留着是有意的纵深防御：脚本管「编造 + 话术合规」，这里管「失效 + 楼存在 + 合规复核」。
 * 纯函数、零 IO（除了 spawn 封装部分）——复核函数零副作用、便于单测钉死；
 * 调用方不许把这里的判断再写一遍。
 *
 * ⚠️ 安全版硬约束：本模块**只产出物料**，绝不发消息、绝不建团长、绝不碰钱。
 *    ref 恒 null，applyPath 为裸申请路径（端上无 ref 即自荐）。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** 后台下发的生成入参（缺口差集，由 recruit-taskcard.service 实时算出） */
export interface RecruitGap {
  buildingId: number;
  buildingName?: string | null;
  orderCount30d?: number | string | null;
  gmv30d?: number | string | null;
  activeLeader?: number | null;
}

export interface RecruitTaskCardGenInput {
  generatedAt: string;
  gaps: RecruitGap[];
  coveredBuildingIds: number[];
}

/** 草稿器产出的一条任务卡（确认时从此结构复核） */
export interface RecruitTaskCard {
  buildingId: number;
  buildingName: string;
  priority: number;
  gap: { orderCount30d: string; gmv30d: string; activeLeader: number };
  targetSegment: string;
  pitchText: string;
  estimatedEarningText: string;
  applyPath: string;
  ref: string | null;
  reason: string;
}

export interface RecruitTaskCardGenResult {
  ok: boolean;
  mode: string;
  cards: RecruitTaskCard[];
  rejected: Array<{ buildingId: number | string | null; why: string }>;
  notes: string[];
  generatedAt?: string;
  message?: string;
}

/** 与脚本 BANNED_PITCH_WORDS 逐字同源 —— 漂移会造成「生成时拦了、确认时又放行」 */
export const BANNED_PITCH_WORDS = [
  '躺赚',
  '零花钱',
  '月入过万',
  '轻松赚',
  '稳赚',
  '保底',
  '包赚',
  '暴富',
  '独占',
  '独家代理',
  '躺平赚钱',
  '被动收入',
  '无本万利',
  '稳收益',
  '躺赢',
];
export const ESTIMATE_MARK = '测算示例';
export const APPLY_PATH = 'pages/leader-apply/leader-apply';

export type TaskCardBlockCode =
  'bad_shape' | 'not_gap' | 'already_covered' | 'dup_building' | 'banned_word' | 'no_estimate';

export interface TaskCardBlocked {
  buildingId: number;
  buildingName: string;
  code: TaskCardBlockCode;
  detail: string;
}

export interface RevalidateTaskCardCtx {
  /** 实时缺口楼（确认时重拉）：buildingId 白名单 + 名称 + 数字真源 */
  gaps: RecruitGap[];
  /** 实时在职团长覆盖的楼 id（含生成后才开的楼） */
  coveredBuildingIds: number[];
}

/**
 * 用**实时**缺口集复核一条待确认任务卡（不抛错，返回 ok / blocked）。
 * 任何畸形输入都退化为 blocked，confirm 链路不允许因脏数据崩掉。
 *
 * 注意：这里**不复核数字篡改** —— 数字在生成时已被脚本用输入值覆盖（见脚本 §③），
 * 且确认阶段不展示可编辑的数字。复核聚焦「这张卡现在还能不能发」。
 * 「非在营/楼已不存在」不单列状态码：缺口由 buildingRank 近30天有单楼算出，非在营楼
 * 自然不在 gaps → 走 not_gap 拦下（挑刺 v1.1 删掉无数据源的 not_active 死码）。
 * ⭐ 话术由调用方（confirm）从 generate 原卡带回，这里再过闸；楼名与数字仍以实时 gaps 为准。
 */
export function revalidateTaskCard(
  card: RecruitTaskCard,
  ctx: RevalidateTaskCardCtx,
): { ok: true; row: RecruitTaskCard } | { ok: false; blocked: TaskCardBlocked } {
  const buildingId = Number((card as { buildingId?: unknown })?.buildingId);
  const buildingName = String(
    (card as { buildingName?: unknown })?.buildingName ?? `#${buildingId}`,
  );
  const blocked = (code: TaskCardBlockCode, detail: string) => ({
    ok: false as const,
    blocked: { buildingId, buildingName, code, detail },
  });

  if (!Number.isFinite(buildingId) || buildingId <= 0) {
    return blocked(
      'bad_shape',
      `任务卡 buildingId 非法：${(card as { buildingId?: unknown })?.buildingId}`,
    );
  }

  // ① 实时缺口白名单：生成后若该楼已被覆盖 / 不在有单楼 → 不再发
  const gap = ctx.gaps.find((g) => Number(g?.buildingId) === buildingId);
  if (!gap) return blocked('not_gap', `楼「${buildingName}」(#${buildingId}) 已不在招募缺口清单`);
  const covered = new Set(ctx.coveredBuildingIds.map(Number));
  if (covered.has(buildingId)) {
    return blocked(
      'already_covered',
      `楼「${buildingName}」(#${buildingId}) 现有在职团长，无需再招`,
    );
  }

  // ② 话术合规闸再跑一遍（防生成后脚本被改 / 注入）
  const estimated = String(
    (card as { estimatedEarningText?: unknown })?.estimatedEarningText ?? '',
  );
  const pitch = String((card as { pitchText?: unknown })?.pitchText ?? '');
  const text = `${pitch} ${estimated}`;
  const hit = BANNED_PITCH_WORDS.find((w) => text.includes(w));
  if (hit) return blocked('banned_word', `话术命中禁用词「${hit}」`);
  if (!estimated.includes(ESTIMATE_MARK)) {
    return blocked('no_estimate', `收益文案缺少「${ESTIMATE_MARK}」标注`);
  }
  if (!pitch.trim()) return blocked('bad_shape', '话术为空');

  // ③ 安全版常量复核：ref 必须 null、applyPath 必须是裸路径（防有人塞推荐码绕过）
  if ((card as { ref?: unknown })?.ref != null) {
    return blocked('bad_shape', '安全版不允许携带推荐码 ref（缺口楼无真实推荐人）');
  }
  if ((card as { applyPath?: unknown })?.applyPath !== APPLY_PATH) {
    return blocked('bad_shape', `申请路径必须是 ${APPLY_PATH}`);
  }

  return {
    ok: true,
    row: {
      ...card,
      buildingId,
      buildingName: String(gap.buildingName || buildingName),
      gap: {
        orderCount30d: gap.orderCount30d == null ? '暂缺' : String(gap.orderCount30d),
        gmv30d: gap.gmv30d == null ? '暂缺' : String(gap.gmv30d),
        activeLeader: Number(gap.activeLeader ?? 0),
      },
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
    if (existsSync(join(c, 'scripts', 'gen-recruit-taskcard.mjs'))) return c;
  }
  return candidates[0];
}

function pickWritableDir(repoRoot: string): string {
  const candidates = [
    join(repoRoot, 'data', 'uploads', 'recruit-taskcard'),
    join(repoRoot, 'releases', 'recruit-taskcard'),
    join(tmpdir(), 'abox-recruit-taskcard'),
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
 * 调脚本生成任务卡草稿。失败（脚本缺失 / 超时 / 输出非 JSON）一律降级为空卡 + 说明，
 * 绝不抛错中断调用方（生成层与主流程解耦，与 A 的 generateMealTemplateDraft 同款）。
 */
export async function generateRecruitTaskCards(
  input: RecruitTaskCardGenInput,
  timeoutMs = 60_000,
): Promise<RecruitTaskCardGenResult> {
  const repoRoot = resolveRepoRoot();
  const script = join(repoRoot, 'scripts', 'gen-recruit-taskcard.mjs');
  const tmpDir = pickWritableDir(repoRoot);
  const plainFile = join(tmpDir, `_rt_${Date.now()}.json`);
  const empty = (
    mode: string,
    message: string,
    notes: string[] = [],
  ): RecruitTaskCardGenResult => ({
    ok: false,
    mode,
    cards: [],
    rejected: [],
    notes,
    message,
  });

  try {
    writeFileSync(plainFile, JSON.stringify(input), 'utf8');
  } catch {
    return empty('error', '缺口数据写不进临时文件（磁盘权限）');
  }
  if (!existsSync(script)) {
    try {
      unlinkSync(plainFile);
    } catch {
      /* noop */
    }
    return empty('error', `招募任务卡脚本未找到（${script}），请确认部署包完整。`);
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
    return empty('error', `生成超时（>${Math.round(timeoutMs / 1000)}s）或脚本异常`, [
      '生成超时或脚本异常，已转人工',
    ]);
  }
  try {
    const parsed = JSON.parse(out) as RecruitTaskCardGenResult;
    if (!parsed || !Array.isArray(parsed.cards)) return empty('error', '生成结果结构无法解析');
    return parsed;
  } catch {
    return empty('error', '生成结果非 JSON');
  }
}

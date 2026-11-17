/**
 * 团长处置卡 · 生成与复核（AI 编排节点 N · 安全版）
 *
 * 与 `scripts/gen-leader-taskcard.mjs` 的 `validateLeaderCards` 分工：
 *   · 脚本层用「生成那一刻的快照」白名单，防 LLM 编造 leaderId / 动作 / 既成事实话术。
 *   · 这一层用**实时**在职团长名册复核（调用方确认时重拉），补「快照失效」：这几分钟里
 *     团长可能已被停用 / 已从名册移除 → 生成时合法的卡，确认时不能再出执行清单。
 *
 * 🚨 履约红线（祝总 2026-11-17 拍板）：本模块**只出执行清单 + 记台账**，
 *    绝不调 leaderAdmin.audit / 任何写接口、绝不改团长状态、绝不清用户归属。
 *    真处置（尤其 suspend）由人拿清单去后台 D22 人工确认。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** 团长白名单条目（实时从 NameResolver.listLeaders 取，仅在职 status=1） */
export interface LeaderOption {
  leaderId: number;
  buildingName: string;
  band: string;
  silentDays: number | null;
  monthOrders: number;
  level: string;
  blockers: string[];
}

/** 数据摘要（只读健康度汇总） */
export interface LeaderTotals {
  total?: number;
  payoutUnbound?: number;
  agreementStale?: number;
  blockedAndSilent?: number;
  byBand?: Record<string, number>;
}

/** 生成入参（由 leader-taskcard.service 实时算出写入脚本） */
export interface LeaderTaskCardGenInput {
  generatedAt: string;
  leaders: LeaderOption[];
  totals: LeaderTotals;
}

export type LeaderCardKind =
  'agreementFollowup' | 'silentWakeup' | 'payoutFollowup' | 'suspendReview';
/** D22 真实动作枚举（与 shared-types/enums/leader-admin.ts 同源） */
export type LeaderAuditSuggestion = 'suspend' | 'restore' | 'sign_agreement' | 'note';

/** 红线话术（与脚本同源，服务端复核再拦一次） */
export const BANNED_PITCH_WORDS = [
  '已停用',
  '已清归属',
  '已恢复在职',
  '已置停职',
  '已解绑',
  '系统已停用',
];
export const ALLOWED_ACTIONS: LeaderAuditSuggestion[] = [
  'suspend',
  'restore',
  'sign_agreement',
  'note',
];
export const CARD_KINDS: LeaderCardKind[] = [
  'agreementFollowup',
  'silentWakeup',
  'payoutFollowup',
  'suspendReview',
];
export const EXEC_HINT =
  '系统未改任何团长状态。请拿本清单去后台 D22「资质补录/例外处理」人工确认，停用会清用户归属，务必核对事实后再点。';

/** 结构化处置卡（脚本产出 + 服务端复核后的最终形态） */
export interface LeaderStrategyCard {
  kind: LeaderCardKind;
  leaderId: number;
  buildingName: string;
  level: string;
  band: string;
  silentDays: number | null;
  monthOrders: number;
  facts: string;
  action: LeaderAuditSuggestion;
  reason: string;
  blockerList: string[];
  executeHint: string;
}

export interface LeaderCardRejected {
  kind: string | null;
  why: string;
}

export interface LeaderTaskCardGenResult {
  ok: boolean;
  mode: string;
  cards: LeaderStrategyCard[];
  rejected: LeaderCardRejected[];
  notes: string[];
  message?: string;
  generatedAt?: string;
}

export interface RevalidateLeaderCardCtx {
  leaders: LeaderOption[];
}

export interface RevalidateLeaderCardResult {
  ok: boolean;
  row?: LeaderStrategyCard;
  blocked?: { code: string; detail: string };
}

/** 与脚本同源的事实文案（只读数据拼装，AI/请求方改不动） */
export function fmtFacts(l: LeaderOption | undefined): string {
  if (!l) return '暂无数据';
  const band = String(l.band || 'unknown');
  const silent = l.silentDays == null ? '无出单记录' : `距最近出单 ${l.silentDays} 天`;
  const blockers =
    Array.isArray(l.blockers) && l.blockers.length
      ? l.blockers.map((b) => (b === 'payout_unbound' ? '未绑收款' : '协议待补签')).join('、')
      : '无卡点';
  return `分档=${band} · ${silent} · 本月 ${l.monthOrders ?? 0} 单 · 卡点：${blockers}`;
}

/**
 * 服务端实时复核单卡（零 IO 纯函数）。
 * 校验：leaderId 仍在实时在职白名单、动作合法、理由非空且无红线话术；
 * 事实字段全部用白名单覆盖，executeHint 强制红线口径。任一不过 → blocked。
 */
export function revalidateLeaderCard(
  card: LeaderStrategyCard,
  ctx: RevalidateLeaderCardCtx,
): RevalidateLeaderCardResult {
  const leaderId = Number(card?.leaderId);
  const leader = (ctx.leaders || []).find((l) => Number(l.leaderId) === leaderId);
  if (!Number.isFinite(leaderId) || !leader) {
    return {
      ok: false,
      blocked: { code: 'LEADER_NOT_ACTIVE', detail: `团长 #${card?.leaderId} 已不在在职名册` },
    };
  }
  if (!ALLOWED_ACTIONS.includes(card?.action)) {
    return {
      ok: false,
      blocked: { code: 'BAD_ACTION', detail: `不允许的 D22 动作 action=${card?.action}` },
    };
  }
  const reason = String(card?.reason || '').trim();
  if (!reason) {
    return { ok: false, blocked: { code: 'NO_REASON', detail: '处置理由为空' } };
  }
  const hit = BANNED_PITCH_WORDS.find((w) => reason.includes(w));
  if (hit) {
    return {
      ok: false,
      blocked: {
        code: 'BANNED_PITCH',
        detail: `理由含红线话术「${hit}」（系统无权执行，只出建议）`,
      },
    };
  }

  return {
    ok: true,
    row: {
      kind: card.kind,
      leaderId,
      buildingName: String(leader.buildingName || `#${leaderId}`),
      level: String(leader.level || 'unknown'),
      band: String(leader.band || 'unknown'),
      silentDays: leader.silentDays ?? null,
      monthOrders: Number(leader.monthOrders ?? 0),
      facts: fmtFacts(leader),
      action: card.action,
      reason,
      blockerList: Array.isArray(leader.blockers) ? leader.blockers : [],
      // 强制红线口径，不认请求里可能篡改的执行提示
      executeHint: EXEC_HINT,
    },
  };
}

function resolveRepoRoot(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'scripts', 'gen-leader-taskcard.mjs'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function pickWritableDir(repoRoot: string): string {
  const candidates = [
    join(repoRoot, 'data', 'uploads', 'leader-taskcard'),
    join(repoRoot, 'releases', 'leader-taskcard'),
    join(tmpdir(), 'abox-leader-taskcard'),
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

/** 调脚本生成处置卡草稿。失败一律降级为空卡 + 说明，绝不抛错中断调用方。 */
export async function generateLeaderTaskCards(
  input: LeaderTaskCardGenInput,
  timeoutMs = 60_000,
): Promise<LeaderTaskCardGenResult> {
  const repoRoot = resolveRepoRoot();
  const script = join(repoRoot, 'scripts', 'gen-leader-taskcard.mjs');
  const tmpDir = pickWritableDir(repoRoot);
  const plainFile = join(tmpDir, `_lt_${Date.now()}.json`);
  const empty = (mode: string, message: string, notes: string[] = []): LeaderTaskCardGenResult => ({
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
    return empty('error', '处置卡数据写不进临时文件（磁盘权限）');
  }
  if (!existsSync(script)) {
    try {
      unlinkSync(plainFile);
    } catch {
      /* noop */
    }
    return empty('error', `团长处置卡脚本未找到（${script}），请确认部署包完整。`);
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
    const parsed = JSON.parse(out) as LeaderTaskCardGenResult;
    if (!parsed || !Array.isArray(parsed.cards)) return empty('error', '生成结果结构无法解析');
    return parsed;
  } catch {
    return empty('error', '生成结果非 JSON');
  }
}

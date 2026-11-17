/**
 * 发券策略卡 · 生成与复核（AI 编排节点 H · 安全版）
 *
 * 与 `scripts/gen-coupon-taskcard.mjs` 的 `validateStrategyCards` 分工：
 *   · 脚本层用「生成那一刻的快照」白名单，防 LLM 编造券种 id / 楼 id / 金额 / scope。
 *   · 这一层用**实时**券种集复核（调用方确认时重拉），补「快照失效」：这几分钟里券种可能
 *     被停用 / 楼可能非在营 → 生成时合法的卡，确认时不能再出执行清单。
 *
 * ⚠️ 安全版硬约束：本模块**只出执行清单 + 记台账**，绝不调 grantBatch / createDef、
 *    绝不建券种、绝不真发券、不写业务表。真发券由人拿清单去后台「批量发券」页确认。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** 券种白名单条目（实时从 NameResolver.listCouponDefs 取，仅 active） */
export interface CouponDefOption {
  id: number;
  name: string;
  faceValueFen: number;
  thresholdFen: number;
  validityType: string;
  validDays: number;
  status?: string;
}

/** 楼栋白名单条目（实时从 StatsService.buildingRank 取） */
export interface CouponBuildingOption {
  id: number;
  name: string;
  orderCount30d: number | string;
  gmv30d: string;
}

/** 数据摘要（人群规模，只读 stats） */
export interface CouponSegmentScale {
  newCustomerCount?: number | string;
  sleepCount?: number | string;
  repeatCount?: number | string;
}

/** 生成入参（由 coupon-taskcard.service 实时算出写入脚本） */
export interface CouponTaskCardGenInput {
  generatedAt: string;
  couponDefs: CouponDefOption[];
  buildings: CouponBuildingOption[];
  segments: CouponSegmentScale;
}

export type CouponStrategyKind = 'newCustomer' | 'sleepWake' | 'buildingTarget' | 'repurchase';
export type CouponScope = 'all' | 'building';

/** 结构化策略卡（脚本产出 + 服务端复核后的最终形态） */
export interface CouponStrategyCard {
  kind: CouponStrategyKind;
  scope: CouponScope;
  buildingId: number | null;
  buildingName: string;
  couponDefId: number;
  couponName: string;
  faceValueFen: number;
  thresholdFen: number;
  validityType: string;
  validDays: number;
  targetCount: string;
  budgetText: string;
  reason: string;
  executeHint: string;
}

export interface CouponCardRejected {
  kind: string | null;
  why: string;
}

export interface CouponTaskCardGenResult {
  ok: boolean;
  mode: string;
  cards: CouponStrategyCard[];
  rejected: CouponCardRejected[];
  notes: string[];
  message?: string;
  generatedAt?: string;
}

/** 与脚本同源：预算测算标注、允许的 scope、策略类型 */
export const ESTIMATE_MARK = '测算示例';
export const ALLOWED_SCOPES: CouponScope[] = ['all', 'building'];
export const STRATEGY_KINDS: CouponStrategyKind[] = [
  'newCustomer',
  'sleepWake',
  'buildingTarget',
  'repurchase',
];

export interface RevalidateCouponCardCtx {
  couponDefs: CouponDefOption[];
  buildings: CouponBuildingOption[];
}

export interface RevalidateCouponCardResult {
  ok: boolean;
  row?: CouponStrategyCard;
  blocked?: { code: string; detail: string };
}

/**
 * 服务端实时复核单卡（零 IO 纯函数）。
 * 校验：券种在实时白名单（仍 active）、scope=building 时楼在白名单、金额用白名单覆盖、
 * 预算含「测算示例」、scope 合法。任一不过 → blocked。
 */
export function revalidateCouponCard(
  card: CouponStrategyCard,
  ctx: RevalidateCouponCardCtx,
): RevalidateCouponCardResult {
  const def = (ctx.couponDefs || []).find((d) => Number(d.id) === Number(card?.couponDefId));
  if (!def || String(def.status || 'active') !== 'active') {
    return {
      ok: false,
      blocked: {
        code: 'COUPON_DEF_NOT_ACTIVE',
        detail: `券种 #${card?.couponDefId} 已停用或不存在`,
      },
    };
  }
  if (!ALLOWED_SCOPES.includes(card?.scope)) {
    return { ok: false, blocked: { code: 'BAD_SCOPE', detail: `不允许的 scope=${card?.scope}` } };
  }
  let buildingId: number | null = null;
  let buildingName = '';
  if (card.scope === 'building') {
    buildingId = Number(card?.buildingId);
    const b = (ctx.buildings || []).find((x) => Number(x.id) === buildingId);
    if (!Number.isFinite(buildingId) || buildingId <= 0 || !b) {
      return {
        ok: false,
        blocked: {
          code: 'BUILDING_NOT_IN_SCOPE',
          detail: `楼 #${card?.buildingId} 不在楼栋白名单`,
        },
      };
    }
    buildingName = String(b.name || `#${buildingId}`);
  }
  if (!String(card?.budgetText || '').includes(ESTIMATE_MARK)) {
    return {
      ok: false,
      blocked: { code: 'NO_ESTIMATE_MARK', detail: '预算文案缺少「测算示例」标注' },
    };
  }

  return {
    ok: true,
    row: {
      kind: card.kind,
      scope: card.scope,
      buildingId,
      buildingName,
      couponDefId: Number(def.id),
      couponName: String(def.name || '未命名'),
      // 金额一律用实时白名单覆盖，不认请求里可能篡改的值
      faceValueFen: Number(def.faceValueFen) || 0,
      thresholdFen: Number(def.thresholdFen) || 0,
      validityType: def.validityType || 'days',
      validDays: Number.isFinite(Number(def.validDays)) ? Number(def.validDays) : 7,
      targetCount: String(card.targetCount ?? '暂缺'),
      budgetText: String(card.budgetText),
      reason: String(card.reason ?? ''),
      executeHint:
        card.scope === 'building'
          ? `后台批量发券：scope=building，buildingId=${buildingId}，选券种 #${def.id}`
          : `后台批量发券：scope=all，选券种 #${def.id}（或按人群自行圈定）`,
    },
  };
}

function resolveRepoRoot(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'scripts', 'gen-coupon-taskcard.mjs'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function pickWritableDir(repoRoot: string): string {
  const candidates = [
    join(repoRoot, 'data', 'uploads', 'coupon-taskcard'),
    join(repoRoot, 'releases', 'coupon-taskcard'),
    join(tmpdir(), 'abox-coupon-taskcard'),
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
 * 调脚本生成策略卡草稿。失败一律降级为空卡 + 说明，绝不抛错中断调用方。
 */
export async function generateCouponTaskCards(
  input: CouponTaskCardGenInput,
  timeoutMs = 60_000,
): Promise<CouponTaskCardGenResult> {
  const repoRoot = resolveRepoRoot();
  const script = join(repoRoot, 'scripts', 'gen-coupon-taskcard.mjs');
  const tmpDir = pickWritableDir(repoRoot);
  const plainFile = join(tmpDir, `_ct_${Date.now()}.json`);
  const empty = (mode: string, message: string, notes: string[] = []): CouponTaskCardGenResult => ({
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
    return empty('error', '策略卡数据写不进临时文件（磁盘权限）');
  }
  if (!existsSync(script)) {
    try {
      unlinkSync(plainFile);
    } catch {
      /* noop */
    }
    return empty('error', `发券策略卡脚本未找到（${script}），请确认部署包完整。`);
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
    const parsed = JSON.parse(out) as CouponTaskCardGenResult;
    if (!parsed || !Array.isArray(parsed.cards)) return empty('error', '生成结果结构无法解析');
    return parsed;
  } catch {
    return empty('error', '生成结果非 JSON');
  }
}

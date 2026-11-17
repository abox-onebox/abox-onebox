/**
 * 社群排期卡 · 生成与复核（AI 编排节点 P · 安全版）
 *
 * 与 `scripts/gen-community-taskcard.mjs` 的 `validateCommunityCards` 分工：
 *   · 脚本层用「生成那一刻的快照」白名单，防 LLM 编造套餐/券/平台名/链接口令。
 *   · 这一层用**实时**套餐/券种名册复核（调用方确认时重拉），补「快照失效」：
 *     这几分钟里套餐可能已停用 / 券可能已下架 → 生成时合法的卡，确认时不能再出清单。
 *
 * 🚨 发消息红线（祝总 2026-11-17 拍板）：本模块**只出执行清单 + 记台账**，
 *    绝不调 wecomToken.sendText / 任何发消息接口、绝不发券、绝不发群、绝不拉好友。
 *    真发由人拿清单去群里手动操作、去券管理页人工发券。
 *
 * 🚨 话术合规闸（本节点核心增量，端内文案纪律）：AI 话术逐条过闸，命中即拦 ——
 *    ① 第三方平台名（含**快团团**：与 ABox 无任何业务关系，任何文案禁提）；
 *    ② 链接 / 短链 / 口令样式（导流到自研小程序之外）；
 *    ③ 既成事实话术（「已发券/已经发券了/已发群」——系统无权执行，只出建议）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** 第三方平台名（禁导流；快团团为第一铁律） */
export const BANNED_PLATFORM_WORDS = [
  '快团团',
  '淘宝',
  '天猫',
  '拼多多',
  '京东',
  '抖音',
  '快手',
  '小红书',
  '美团',
  '饿了么',
  '微店',
  '有赞',
  '视频号小店',
];
/** 既成事实话术（含变体：脚本 selftest 抓出「已经发券了」不含连续子串「已发券」） */
export const BANNED_PITCH_WORDS = [
  '已发券',
  '已到账',
  '已发群',
  '已推送',
  '已发送',
  '已加入',
  '已下单成功',
  '已拉群',
  '已经发券',
  '已经到账',
  '已经发群',
  '已经推送',
  '已经发送',
  '已经加入',
  '已经拉群',
  '券已发',
  '已发到',
];
/** 链接 / 短链 / 口令样式 */
const BANNED_LINK_RE =
  /(https?:\/\/|www\.|\.com\/|\.cn\/|点击[链连]接|复制.*(打开|粘贴)|口令|￥[^￥]{3,}￥|\$[^$]{3,}\$)/i;
export const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;
export const TIERS = ['amplify', 'steady', 'wake', 'silent'] as const;
export const EXEC_HINT =
  '系统未发任何群消息、未发券、未加好友。请拿本清单人工复制到群里；发券去后台券管理页，发群请在群里手动操作。';

export type CommunityTier = (typeof TIERS)[number];

/** 靶楼白名单条目（实时取自 pickCommunityTargets，只带事实，无姓名/手机号） */
export interface CommunityTargetOption {
  leaderId: number;
  buildingName: string;
  tier: string;
  monthOrders: number;
  totalOrders: number;
  silentDays: number | null;
}
/** 当期套餐白名单（status=1 启用中） */
export interface CommunityTemplateOption {
  id: number;
  name: string;
  priceFen: number;
}
/** 现有券种白名单 */
export interface CommunityCouponOption {
  id: number;
  name: string;
  faceValueFen: number;
  thresholdFen: number;
}
export interface CommunityTotals {
  amplify?: number;
  steady?: number;
  wake?: number;
  silent?: number;
  newCount?: number;
}

export interface CommunityTaskCardGenInput {
  generatedAt: string;
  targets: CommunityTargetOption[];
  templates: CommunityTemplateOption[];
  coupons: CommunityCouponOption[];
  totals: CommunityTotals;
}

/** 一周排期卡（脚本产出 + 服务端复核后的最终形态） */
export interface CommunityScheduleCard {
  day: string;
  targetTier: CommunityTier;
  templateId: number | null;
  templateName: string | null;
  couponId: number | null;
  couponName: string | null;
  /** 价格/面额由白名单覆盖，标注测算示例在页面层 */
  offer: string;
  pitch: string;
  note: string;
  executeHint: string;
}
/** 分档话术卡 */
export interface CommunityPitchCard {
  tier: CommunityTier;
  text: string;
  executeHint: string;
}
export interface CommunityRejected {
  type: string | null;
  why: string;
}
export interface CommunityTaskCardGenResult {
  ok: boolean;
  mode: string;
  schedule: CommunityScheduleCard[];
  pitches: CommunityPitchCard[];
  rejected: CommunityRejected[];
  notes: string[];
  message?: string;
  generatedAt?: string;
}

export interface RevalidateCommunityCtx {
  templates: CommunityTemplateOption[];
  coupons: CommunityCouponOption[];
}
export interface RevalidateScheduleResult {
  ok: boolean;
  row?: CommunityScheduleCard;
  blocked?: { code: string; detail: string };
}

/** 话术合规闸（零 IO 纯函数，与脚本同源）。返回命中的禁用项，null = 通过。 */
export function screenPitch(text: unknown): string | null {
  const s = String(text || '');
  const platform = BANNED_PLATFORM_WORDS.find((w) => s.includes(w));
  if (platform) return `第三方平台名「${platform}」`;
  const fact = BANNED_PITCH_WORDS.find((w) => s.includes(w));
  if (fact) return `既成事实话术「${fact}」（系统无权执行）`;
  if (BANNED_LINK_RE.test(s)) return '链接/短链/口令样式';
  return null;
}

function yuan(fen: unknown): string {
  return `¥${((Number(fen) || 0) / 100).toFixed(2)}`;
}

/** 只读数据拼价格/面额文案（AI/请求方改不动） */
function fmtOffer(
  template: CommunityTemplateOption | undefined,
  coupon: CommunityCouponOption | undefined,
): string {
  const parts: string[] = [];
  if (template) parts.push(`${template.name || '未命名套餐'} ${yuan(template.priceFen)}`);
  if (coupon) parts.push(`${coupon.name || '券'} 面额${yuan(coupon.faceValueFen)}`);
  return parts.length ? parts.join(' · ') : '（不指定套餐/券）';
}

/**
 * 服务端实时复核单条排期卡（零 IO 纯函数）。
 * 校验：日合法、档位合法、套餐/券仍在实时白名单、话术过合规闸；
 * 价格/面额/执行提示全部用白名单覆盖。任一不过 → blocked。
 */
export function revalidateScheduleCard(
  card: CommunityScheduleCard,
  ctx: RevalidateCommunityCtx,
): RevalidateScheduleResult {
  const day = String(card?.day || '');
  if (!(DAYS as readonly string[]).includes(day)) {
    return { ok: false, blocked: { code: 'BAD_DAY', detail: `非法排期日 day=${card?.day}` } };
  }
  const tier = String(card?.targetTier || '');
  if (!(TIERS as readonly string[]).includes(tier)) {
    return {
      ok: false,
      blocked: { code: 'BAD_TIER', detail: `非法靶楼档位 targetTier=${card?.targetTier}` },
    };
  }
  const templateId = card?.templateId == null ? null : Number(card.templateId);
  const couponId = card?.couponId == null ? null : Number(card.couponId);
  const templates = ctx.templates || [];
  const coupons = ctx.coupons || [];
  const template =
    templateId == null ? undefined : templates.find((t) => Number(t.id) === templateId);
  const coupon = couponId == null ? undefined : coupons.find((c) => Number(c.id) === couponId);
  if (templateId != null && !template) {
    return {
      ok: false,
      blocked: {
        code: 'TEMPLATE_NOT_ACTIVE',
        detail: `套餐 #${card.templateId} 已停用或不在白名单`,
      },
    };
  }
  if (couponId != null && !coupon) {
    return {
      ok: false,
      blocked: { code: 'COUPON_NOT_ACTIVE', detail: `券 #${card.couponId} 已下架或不在白名单` },
    };
  }
  const pitch = String(card?.pitch || '').trim();
  if (!pitch) return { ok: false, blocked: { code: 'NO_PITCH', detail: `${day} 话术为空` } };
  const hit = screenPitch(pitch);
  if (hit)
    return { ok: false, blocked: { code: 'PITCH_UNCOMPLIANT', detail: `${day} 话术违规：${hit}` } };

  return {
    ok: true,
    row: {
      day,
      targetTier: tier as CommunityTier,
      templateId: templateId ?? null,
      templateName: template ? String(template.name || '未命名') : null,
      couponId: couponId ?? null,
      couponName: coupon ? String(coupon.name || '券') : null,
      offer: fmtOffer(template, coupon),
      pitch,
      note: String(card?.note || '').slice(0, 120),
      executeHint: EXEC_HINT,
    },
  };
}

/** 服务端实时复核单条分档话术 */
export function revalidatePitch(card: CommunityPitchCard): {
  ok: boolean;
  row?: CommunityPitchCard;
  blocked?: { code: string; detail: string };
} {
  const tier = String(card?.tier || '');
  if (!(TIERS as readonly string[]).includes(tier)) {
    return { ok: false, blocked: { code: 'BAD_TIER', detail: `非法话术档位 tier=${card?.tier}` } };
  }
  const text = String(card?.text || '').trim();
  if (!text) return { ok: false, blocked: { code: 'NO_PITCH', detail: `${tier} 话术为空` } };
  const hit = screenPitch(text);
  if (hit)
    return {
      ok: false,
      blocked: { code: 'PITCH_UNCOMPLIANT', detail: `${tier} 话术违规：${hit}` },
    };
  return { ok: true, row: { tier: tier as CommunityTier, text, executeHint: EXEC_HINT } };
}

function resolveRepoRoot(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'scripts', 'gen-community-taskcard.mjs'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function pickWritableDir(repoRoot: string): string {
  const candidates = [
    join(repoRoot, 'data', 'uploads', 'community-taskcard'),
    join(repoRoot, 'releases', 'community-taskcard'),
    join(tmpdir(), 'abox-community-taskcard'),
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

/** 调脚本生成排期卡草稿。失败一律降级为空 + 说明，绝不抛错中断调用方。 */
export async function generateCommunityTaskCards(
  input: CommunityTaskCardGenInput,
  timeoutMs = 60_000,
): Promise<CommunityTaskCardGenResult> {
  const repoRoot = resolveRepoRoot();
  const script = join(repoRoot, 'scripts', 'gen-community-taskcard.mjs');
  const tmpDir = pickWritableDir(repoRoot);
  const plainFile = join(tmpDir, `_ct_${Date.now()}.json`);
  const empty = (
    mode: string,
    message: string,
    notes: string[] = [],
  ): CommunityTaskCardGenResult => ({
    ok: false,
    mode,
    schedule: [],
    pitches: [],
    rejected: [],
    notes,
    message,
  });

  try {
    writeFileSync(plainFile, JSON.stringify(input), 'utf8');
  } catch {
    return empty('error', '排期卡数据写不进临时文件（磁盘权限）');
  }
  if (!existsSync(script)) {
    try {
      unlinkSync(plainFile);
    } catch {
      /* noop */
    }
    return empty('error', `社群排期卡脚本未找到（${script}），请确认部署包完整。`);
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
    const parsed = JSON.parse(out) as CommunityTaskCardGenResult;
    if (!parsed || !Array.isArray(parsed.schedule) || !Array.isArray(parsed.pitches)) {
      return empty('error', '生成结果结构无法解析');
    }
    return parsed;
  } catch {
    return empty('error', '生成结果非 JSON');
  }
}

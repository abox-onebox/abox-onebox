/**
 * 任务卡 → 企微人话（纯函数 · 零 IO · 零写接口）
 *
 * 用途：同事在企微说「出一份招募任务卡」时，把后台 G/H/N/P 生成的结构化卡片
 * 转成人话文本直接回。**只做展示**，不改数据、不调任何写接口、不推群、不发券。
 *
 * 🚨 安全版硬边界（祝总 2026-11-17 拍板）：
 *   · `ref` 恒不展示（安全版恒 null，展示出来会让人以为有直达申请链接）
 *   · 每张卡附一句「这是草稿，去对应后台页人工确认执行」
 *   · 不出现任何第三方平台名 / 口令 / 外链
 *
 * 输入用结构化最小接口（structural typing），不 import taskcard utils 的类型 ——
 * 让本文件完全独立、可单独 node 跑 selftest，不受 wecom-kb 模块的 DI 影响。
 */

interface RecruitLike {
  ok: boolean;
  cards?: Array<{
    buildingName?: string;
    priority?: number;
    targetSegment?: string;
    pitchText?: string;
    estimatedEarningText?: string;
    reason?: string;
    applyPath?: string;
    ref?: string | null;
  }>;
  notes?: string[];
  message?: string;
  degraded?: boolean;
}

interface CouponLike {
  ok: boolean;
  cards?: Array<{
    kind?: string;
    scope?: string;
    buildingName?: string;
    couponName?: string;
    faceValueFen?: number;
    thresholdFen?: number;
    targetCount?: string;
    budgetText?: string;
    reason?: string;
  }>;
  notes?: string[];
  message?: string;
  degraded?: boolean;
}

interface LeaderLike {
  ok: boolean;
  cards?: Array<{
    kind?: string;
    buildingName?: string;
    level?: string;
    band?: string;
    silentDays?: number | null;
    monthOrders?: number;
    facts?: string;
    action?: string;
    reason?: string;
  }>;
  notes?: string[];
  message?: string;
  degraded?: boolean;
}

interface CommunityLike {
  ok: boolean;
  schedule?: Array<{
    day?: string;
    targetTier?: string;
    offer?: string;
    pitch?: string;
    note?: string;
  }>;
  pitches?: Array<{ tier?: string; text?: string }>;
  notes?: string[];
  message?: string;
  degraded?: boolean;
}

export type TaskCardKind = 'recruit' | 'coupon' | 'leader' | 'community';

const TITLES: Record<TaskCardKind, string> = {
  recruit: '团长招募任务卡',
  coupon: '发券策略卡',
  leader: '团长处置卡',
  community: '社群排期卡',
};

const HANDOFF: Record<TaskCardKind, string> = {
  recruit: '这是草稿。要去发展团长，拿这张卡到后台「招募任务卡」页逐卡确认。',
  coupon: '这是草稿。要真发券，拿这张卡到后台「发券策略卡」页逐卡确认。',
  leader:
    '这是草稿。要真处置团长，拿这张卡到后台「团长处置卡」页逐卡确认（高危动作不可从聊天直发）。',
  community: '这是草稿。要真排社群，拿这张卡到后台「社群排期卡」页逐日确认。',
};

const NO_DATA: Record<TaskCardKind, string> = {
  recruit: '现在没有可发展的楼宇缺口（近期订单楼栋都已有在职团长），先不用出卡。',
  coupon: '现在没有可生成的发券策略（缺券种或目标楼栋），先去后台把券种建好。',
  leader: '现在没有需要处置的团长，先不用出卡。',
  community: '现在没有可排的社群目标，先不用出卡。',
};

const COUPON_KIND_ZH: Record<string, string> = {
  newCustomer: '新客首单',
  sleepWake: '沉睡唤醒',
  buildingTarget: '重点楼宇',
  repurchase: '复购激励',
};

const LEADER_KIND_ZH: Record<string, string> = {
  agreementFollowup: '协议补签',
  silentWakeup: '沉睡唤醒',
  payoutFollowup: '收款跟进',
  suspendReview: '停用复核（高危·仅建议）',
};

const LEADER_ACTION_ZH: Record<string, string> = {
  sign_agreement: '补签协议',
  note: '记录观察',
  interview: '约谈',
  suspend: '建议停用（高危·需人工复核）',
};

const TIER_ZH: Record<string, string> = {
  amplify: '放大',
  steady: '稳态',
  wake: '唤醒',
  silent: '沉默',
};

function yuan(fen: unknown): string {
  const n = Number(fen);
  if (!Number.isFinite(n)) return '—';
  return `${(n / 100).toFixed(2)} 元`;
}

function head(
  kind: TaskCardKind,
  result: { ok: boolean; degraded?: boolean; message?: string },
): string | null {
  if (result.ok) return null;
  const why = result.message || NO_DATA[kind];
  const degrade = result.degraded ? '\n（数据不足，已按降级口径如实说明，未编造卡片。）' : '';
  return `${TITLES[kind]}：${why}${degrade}`;
}

function tail(kind: TaskCardKind, notes?: string[]): string[] {
  const lines: string[] = [];
  const clean = (notes ?? []).map((n) => String(n).trim()).filter(Boolean);
  if (clean.length) lines.push(`备注：${clean.join('；')}`);
  lines.push(HANDOFF[kind]);
  return lines;
}

export function formatRecruitChat(r: RecruitLike): string {
  const h = head('recruit', r);
  if (h) return h;
  const cards = r.cards ?? [];
  if (!cards.length) {
    const note = (r.notes ?? []).filter(Boolean).join('；');
    return note ? `${NO_DATA.recruit}\n${note}` : NO_DATA.recruit;
  }
  const lines = [`${TITLES.recruit}（${cards.length} 张，按优先级）`];
  cards.forEach((c, i) => {
    lines.push(
      `${i + 1}. ${c.buildingName ?? '未命名楼'} · ${c.targetSegment ?? '待定人群'}（优先级 ${c.priority ?? '-'}）`,
    );
    if (c.pitchText) lines.push(`   话术：${c.pitchText}`);
    if (c.estimatedEarningText) lines.push(`   收益：${c.estimatedEarningText}（测算示例）`);
    if (c.reason) lines.push(`   理由：${c.reason}`);
  });
  lines.push(...tail('recruit', r.notes));
  return lines.join('\n');
}

export function formatCouponChat(r: CouponLike): string {
  const h = head('coupon', r);
  if (h) return h;
  const cards = r.cards ?? [];
  if (!cards.length) {
    const note = (r.notes ?? []).filter(Boolean).join('；');
    return note ? `${NO_DATA.coupon}\n${note}` : NO_DATA.coupon;
  }
  const lines = [`${TITLES.coupon}（${cards.length} 张）`];
  cards.forEach((c, i) => {
    const kind = COUPON_KIND_ZH[c.kind ?? ''] ?? c.kind ?? '策略';
    const scope = c.scope === 'building' ? `· ${c.buildingName ?? '指定楼'}` : '· 全量';
    lines.push(`${i + 1}. ${kind} ${scope}`);
    lines.push(
      `   券：${c.couponName ?? '—'} · 面额 ${yuan(c.faceValueFen)} · 门槛 ${yuan(c.thresholdFen)}`,
    );
    if (c.targetCount) lines.push(`   预计覆盖：${c.targetCount}`);
    if (c.budgetText) lines.push(`   预算：${c.budgetText}`);
    if (c.reason) lines.push(`   理由：${c.reason}`);
  });
  lines.push(...tail('coupon', r.notes));
  return lines.join('\n');
}

export function formatLeaderChat(r: LeaderLike): string {
  const h = head('leader', r);
  if (h) return h;
  const cards = r.cards ?? [];
  if (!cards.length) {
    const note = (r.notes ?? []).filter(Boolean).join('；');
    return note ? `${NO_DATA.leader}\n${note}` : NO_DATA.leader;
  }
  const lines = [`${TITLES.leader}（${cards.length} 张，仅建议不执行）`];
  cards.forEach((c, i) => {
    const kind = LEADER_KIND_ZH[c.kind ?? ''] ?? c.kind ?? '跟进';
    const act = LEADER_ACTION_ZH[c.action ?? ''] ?? c.action ?? '记录';
    lines.push(
      `${i + 1}. ${kind} · ${c.buildingName ?? '楼'}（${c.level ?? '-'} / ${c.band ?? '-'}）`,
    );
    if (c.silentDays != null) lines.push(`   沉默 ${c.silentDays} 天 · 月单 ${c.monthOrders ?? 0}`);
    if (c.facts) lines.push(`   事实：${c.facts}`);
    lines.push(`   建议动作：${act}`);
    if (c.reason) lines.push(`   理由：${c.reason}`);
  });
  lines.push(...tail('leader', r.notes));
  return lines.join('\n');
}

export function formatCommunityChat(r: CommunityLike): string {
  const h = head('community', r);
  if (h) return h;
  const sched = r.schedule ?? [];
  const pitches = r.pitches ?? [];
  if (!sched.length && !pitches.length) {
    const note = (r.notes ?? []).filter(Boolean).join('；');
    return note ? `${NO_DATA.community}\n${note}` : NO_DATA.community;
  }
  const lines = [`${TITLES.community}`];
  if (sched.length) {
    lines.push('排期：');
    sched.forEach((s, i) => {
      const tier = TIER_ZH[s.targetTier ?? ''] ?? s.targetTier ?? '-';
      lines.push(`${i + 1}. 周${s.day ?? '?'} · ${tier}档：${s.offer ?? s.pitch ?? '—'}`);
      if (s.note) lines.push(`   注意：${s.note}`);
    });
  }
  if (pitches.length) {
    lines.push('分档话术：');
    pitches.forEach((p) => {
      const tier = TIER_ZH[p.tier ?? ''] ?? p.tier ?? '-';
      lines.push(`· ${tier}：${p.text ?? '—'}`);
    });
  }
  lines.push(...tail('community', r.notes));
  return lines.join('\n');
}

/** 统一分发（供 wecom-chat 的 switch 调用） */
export function formatTaskCardChat(
  kind: TaskCardKind,
  result: RecruitLike | CouponLike | LeaderLike | CommunityLike,
): string {
  switch (kind) {
    case 'recruit':
      return formatRecruitChat(result as RecruitLike);
    case 'coupon':
      return formatCouponChat(result as CouponLike);
    case 'leader':
      return formatLeaderChat(result as LeaderLike);
    case 'community':
      return formatCommunityChat(result as CommunityLike);
  }
}

// ── selftest（纯函数、零副作用，node 直接跑）────────────────
export function selftest(): { pass: number; fail: number; cases: string[] } {
  const cases: string[] = [];
  let pass = 0;
  let fail = 0;
  const check = (name: string, cond: boolean): void => {
    if (cond) {
      pass++;
      cases.push(`PASS ${name}`);
    } else {
      fail++;
      cases.push(`FAIL ${name}`);
    }
  };

  const fullRecruit = formatRecruitChat({
    ok: true,
    cards: [
      {
        buildingName: '量子大厦',
        priority: 1,
        targetSegment: '白领',
        pitchText: '健康午餐',
        estimatedEarningText: '200 元',
        reason: '订单多无团长',
        applyPath: 'pages/leader-apply',
        ref: 'pages/leader-apply?ref=x',
      },
    ],
  });
  check('招募卡出楼名', fullRecruit.includes('量子大厦'));
  check('招募卡收益标测算', fullRecruit.includes('测算示例'));
  check('招募卡不展示 ref 链接', !fullRecruit.includes('ref=x') && !fullRecruit.includes('?ref'));
  check('招募卡有人工确认提示', fullRecruit.includes('后台'));

  const coupon = formatCouponChat({
    ok: true,
    cards: [
      {
        kind: 'newCustomer',
        scope: 'all',
        couponName: '新客券',
        faceValueFen: 500,
        thresholdFen: 2000,
        reason: '拉新',
      },
    ],
  });
  check('券卡金额转元', coupon.includes('5.00 元'));
  check('券卡策略中文', coupon.includes('新客首单'));

  const leader = formatLeaderChat({
    ok: true,
    cards: [{ kind: 'suspendReview', buildingName: 'A 座', action: 'suspend', reason: '长期沉默' }],
  });
  check('团长卡高危标注', leader.includes('高危'));
  check('团长卡动作中文', leader.includes('建议停用'));

  const community = formatCommunityChat({
    ok: true,
    schedule: [{ day: '一', targetTier: 'amplify', offer: '套餐推广' }],
    pitches: [{ tier: 'steady', text: '今日好餐' }],
  });
  check('社群卡排期', community.includes('周一') && community.includes('套餐推广'));
  check('社群卡话术', community.includes('今日好餐'));
  check('社群卡不提第三方平台', !/快团团|拼多多|口令|http/.test(community));

  const empty = formatRecruitChat({ ok: false, message: '没有缺口', degraded: false });
  check('无数据如实说明', empty.includes('没有缺口') && !empty.includes('后台'));

  const emptyWithNote = formatRecruitChat({
    ok: true,
    cards: [],
    notes: ['当前没有招募缺口：近 30 天有订单的楼均已有在职团长'],
  });
  check('空卡回显原始说明', emptyWithNote.includes('近 30 天有订单的楼'));

  // 负控：屏掉既成事实话术不应悄悄带进来（原样展示话术，但软边界由 utils 保证；
  // 这里只断言 formatter 自己不新增违禁词）
  check('formatter 不自造既成事实', !/已经发券了/.test(fullRecruit + coupon + leader + community));

  return { pass, fail, cases };
}

/* istanbul ignore next */
// ⚠️ 精确匹配 basename：宽泛子串会误命中 `verify-taskcard-chat.mjs` 这类调用方，
//    导致 require 本模块时就 process.exit、主验证逻辑根本不跑（实测踩过，假绿）。
if (
  typeof process !== 'undefined' &&
  process.argv &&
  process.argv[1] &&
  /(^|\/|\\)taskcard-chat\.(ts|cjs|js)$/.test(process.argv[1])
) {
  const r = selftest();
  r.cases.forEach((c) => console.log(c));
  console.log(`\n${r.pass} passed, ${r.fail} failed`);
  process.exit(r.fail === 0 ? 0 : 1);
}

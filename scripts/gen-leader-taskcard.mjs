#!/usr/bin/env node
/**
 * ABox 一盒 · 团长处置卡草稿生成（AI 编排节点 N · 安全版）
 * ------------------------------------------------------------------
 * 定位：把「团长健康度分档 + 在职团长白名单」映射成结构化「团长处置卡」。
 *       **只产草稿、不写库、不调任何写接口、不真停用、不改任何团长状态、不清用户归属**。
 *       这是 N「接执行」的安全版：把原 gen-leader-health.mjs 的自由文本提案升级成
 *       可逐卡确认的结构化处置卡；运营挑卡后系统只吐「可执行处置清单」（团长#id + 建议
 *       D22 动作 + 事实依据 + 去哪页人工点），真处置仍由人拿清单去后台 D22 人工确认。
 *
 * ⚠️ 与 gen-leader-health.mjs 并存、互不替代：那条链路是企微口语「团长健康度」的
 *    自由文本提案（健康参谋），本脚本只服务于后台 N 安全版页的结构化出卡。
 *
 * 🚨 履约红线（祝总 2026-11-17 拍板）：
 *    D22 的 suspend 会置停职并清用户归属团长；本脚本**绝不执行**，只把它作为「建议动作」
 *    标签写进清单，并要求文案明确「去 D22 人工确认、系统未改任何状态」。
 *    AI 不得输出「已停用 / 已清归属 / 已恢复」等既成事实话术（必拦，见 BANNED_PITCH_WORDS）。
 *
 * 入参：--plain-file <path>  内容为 JSON（在职团长白名单 + 健康度分档摘要），见 readInput
 * 出参：处置卡 JSON 打印 stdout，并落盘 releases/leader-taskcard/<ts>.json
 *
 * 三道校验（生成时刻快照，与服务端 common/utils/leader-taskcard.ts 复核同源）：
 *   ① 团长白名单：leaderId 必须来自输入 leaders（杜绝编造 id）
 *   ② 动作白名单：action 只能是四枚举（suspend/restore/sign_agreement/note）
 *   ③ 红线话术：理由/依据不得含「已停用/已清归属/已恢复」等既成事实词；
 *      每条卡必须带「去 D22 人工确认、系统未改状态」的执行提示
 *
 * 原则零保障（AI 可剥离）：--no-llm 用确定性 stub 走通全链路；LLM 失败/解析失败
 *   一律返回空卡 + 说明，绝不抛错中断调用方、绝不改任何团长状态。
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { callLLM, extractJson } from './lib/cloud-llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 红线话术：AI 不得宣称已执行（这些动作只有人去 D22 点才算数） */
export const BANNED_PITCH_WORDS = ['已停用', '已清归属', '已恢复在职', '已置停职', '已解绑', '系统已停用'];

/** D22 真实动作枚举（与 shared-types/enums/leader-admin.ts 同源，restore 也允许作建议） */
const ALLOWED_ACTIONS = ['suspend', 'restore', 'sign_agreement', 'note'];
/** 四类处置卡的场景枚举（与动作不完全一一对应：interview 无 D22 动作，纯建议） */
const CARD_KINDS = ['agreementFollowup', 'silentWakeup', 'payoutFollowup', 'suspendReview'];
/** 每个卡必须带的红线执行提示 */
const EXEC_HINT = '系统未改任何团长状态。请拿本清单去后台 D22「资质补录/例外处理」人工确认，停用会清用户归属，务必核对事实后再点。';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plain-file') out.plainFile = argv[++i];
    else if (a === '--no-llm') out.noLlm = true;
    else if (a === '--selftest') out.selftest = true;
  }
  return out;
}

/** 多候选可写目录（与 gen-coupon-taskcard.mjs 同源逻辑） */
function pickWritableDir() {
  const repoRoot = existsSync(join(__dirname, '..', 'scripts'))
    ? resolve(__dirname, '..')
    : process.cwd();
  const candidates = [
    join(repoRoot, 'releases', 'leader-taskcard'),
    join(repoRoot, 'data', 'uploads', 'leader-taskcard'),
    join(repoRoot, 'data', 'leader-taskcard'),
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

/**
 * 读入数据。约定 JSON 形状（由 leader-taskcard.service 实时算出后写入）：
 * {
 *   "generatedAt": "2026-11-17T...",
 *   "leaders": [{ "leaderId": 12, "buildingName": "量子大厦", "band": "dormant",
 *                 "silentDays": 21, "monthOrders": 0, "blockers": ["payout_unbound"],
 *                 "level": "formal", "gapToNextLevel": null }, ...],   // 仅在职(status=1)
 *   "totals": { "total": 8, "byBand": {...}, "payoutUnbound": 2, "agreementStale": 1,
 *               "blockedAndSilent": 1 }
 * }
 * 兼容：非 JSON → 降级为空，仅打印提示，不抛错。
 */
function readInput(plainFile) {
  const raw = readFileSync(plainFile, 'utf8');
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('not object');
    return {
      generatedAt: String(data.generatedAt || ''),
      leaders: Array.isArray(data.leaders) ? data.leaders : [],
      totals: data.totals && typeof data.totals === 'object' ? data.totals : {},
      structured: true,
    };
  } catch {
    return { generatedAt: '', leaders: [], totals: {}, structured: false };
  }
}

function leaderMap(leaders) {
  const m = new Map();
  for (const l of leaders) {
    const id = Number(l?.leaderId);
    if (Number.isFinite(id)) m.set(id, l);
  }
  return m;
}

/** 只读数据里的分档事实（AI 不得改写） */
function fmtFacts(l) {
  if (!l) return '暂无数据';
  const band = String(l.band || 'unknown');
  const silent = l.silentDays == null ? '无出单记录' : `距最近出单 ${l.silentDays} 天`;
  const blockers = Array.isArray(l.blockers) && l.blockers.length
    ? l.blockers.map((b) => (b === 'payout_unbound' ? '未绑收款' : '协议待补签')).join('、')
    : '无卡点';
  return `分档=${band} · ${silent} · 本月 ${l.monthOrders ?? 0} 单 · 卡点：${blockers}`;
}

/**
 * 核心护栏：把 LLM 的原始卡逐条校验，只放行「三真」条目。
 * 纯函数，便于单测与 --selftest 自证。返回 { cards, rejected, notes }。
 */
function validateLeaderCards(input, rawDraft) {
  const leaders = leaderMap(input.leaders);
  const cards = [];
  const rejected = [];
  const notes = [];

  const rawList = Array.isArray(rawDraft?.cards) ? rawDraft.cards : [];
  if (rawList.length === 0) notes.push('AI 未产出任何团长处置卡（数据可能不足）。');

  const seen = new Set();
  for (const c of rawList) {
    const kind = String(c?.kind || '');
    if (!CARD_KINDS.includes(kind)) {
      rejected.push({ kind: c?.kind ?? null, why: `未知处置类型 kind=${c?.kind}` });
      continue;
    }
    if (seen.has(kind)) {
      rejected.push({ kind, why: `重复处置类型 ${kind}（同类只出一张卡）` });
      continue;
    }

    // ① 团长白名单：leaderId 必须来自输入 leaders
    const leaderId = Number(c?.leaderId);
    const leader = leaders.get(leaderId);
    if (!Number.isFinite(leaderId) || !leader) {
      rejected.push({ kind, why: `编造/不在白名单的 leaderId=${c?.leaderId}` });
      continue;
    }

    // ② 动作白名单
    const action = String(c?.action || '');
    if (!ALLOWED_ACTIONS.includes(action)) {
      rejected.push({ kind, why: `不允许的 D22 动作 action=${c?.action}` });
      continue;
    }

    // ③ 红线话术：不得宣称已执行
    const reason = String(c?.reason || '').trim();
    if (!reason) {
      rejected.push({ kind, why: `${kind} 缺少处置理由` });
      continue;
    }
    const hit = BANNED_PITCH_WORDS.find((w) => reason.includes(w));
    if (hit) {
      rejected.push({ kind, why: `${kind} 理由含红线话术「${hit}」（系统无权执行，只出建议）` });
      continue;
    }

    seen.add(kind);
    cards.push({
      kind,
      leaderId,
      buildingName: String(leader.buildingName || `#${leaderId}`),
      level: String(leader.level || 'unknown'),
      band: String(leader.band || 'unknown'),
      silentDays: leader.silentDays ?? null,
      monthOrders: Number(leader.monthOrders ?? 0),
      // 事实依据：服务端白名单覆盖，AI 不得改写
      facts: fmtFacts(leader),
      // 建议动作只是标签，绝不执行
      action,
      reason,
      blockerList: Array.isArray(leader.blockers) ? leader.blockers : [],
      executeHint: EXEC_HINT,
    });
  }

  // 数据里有对应人群但 AI 没出卡的档，记提示（不伪造卡）
  const kindLabels = {
    agreementFollowup: '协议补签',
    silentWakeup: '沉睡唤醒',
    payoutFollowup: '收款卡点跟进',
    suspendReview: '停用复核（高危，仅建议）',
  };
  for (const k of CARD_KINDS) {
    if (!seen.has(k)) notes.push(`${kindLabels[k]}：AI 未出卡，已跳过。`);
  }
  if (Array.isArray(rawDraft?.notes)) {
    for (const n of rawDraft.notes) if (n) notes.push(String(n));
  }

  return { cards, rejected, notes };
}

function buildSystemPrompt(input) {
  const leaderLines = input.leaders
    .map(
      (l) =>
        `- leaderId=${Number(l.leaderId)} 楼=${l.buildingName || '?'} 分档=${l.band || '?'} ` +
        `沉默天数=${l.silentDays ?? '无出单'} 本月单=${l.monthOrders ?? 0} ` +
        `卡点=${Array.isArray(l.blockers) && l.blockers.length ? l.blockers.join('/') : '无'} 等级=${l.level || '?'}`,
    )
    .join('\n');
  const t = input.totals || {};
  return `你是「ABox 一盒」的团长处置编排助理，任务是把团长健康度数据写成「团长处置卡草稿」（供人工逐卡确认，绝不直接停用团长、绝不改任何状态、绝不碰用户归属）。

【在职团长白名单】（leaderId 只能从这里选，禁止编造 id）
${leaderLines || '（空）'}

【汇总】在职 ${t.total ?? '?'} 人 · 未绑收款 ${t.payoutUnbound ?? '?'} 人 · 协议待补签 ${t.agreementStale ?? '?'} 人 · 沉睡且带卡点 ${t.blockedAndSilent ?? '?'} 人

硬性规则（违反即被系统剔除）：
1. 最多出 4 张卡，四类各一张：agreementFollowup（协议补签）/ silentWakeup（沉睡唤醒）/ payoutFollowup（收款卡点跟进）/ suspendReview（停用复核，高危仅建议）；
2. 每张卡给 kind、leaderId（严格取自白名单）、action（只能 suspend/restore/sign_agreement/note）、reason（一句话依据）；
3. action 建议口径：协议待补签→sign_agreement；未绑收款→note；沉睡>14天→note（先电话访谈）；仅「违规/恶意」事实才建议 suspend，且 reason 必须写清违规事实；
4. 不要给「事实依据」字段（系统自动用白名单数据覆盖，你写了也没用）；
5. reason 严禁写「已停用/已清归属/已恢复在职/已置停职」等既成事实 —— 系统无权执行，只能建议；
6. 数据不足时不要硬编，宁可少出卡；
7. 只输出 JSON，不要任何解释文字、不要 markdown 围栏、不要 emoji。

输出 JSON（严格此结构）：
{"cards":[{"kind":"agreementFollowup","leaderId":0,"action":"sign_agreement","reason":"协议版本未留痕，建议补签 v1.1"}],"notes":["……"]}`;
}

function buildUserPrompt() {
  return '请按四类输出严格 JSON 的团长处置卡，leaderId 只从白名单取，action 只从四枚举取。';
}

/** --no-llm 确定性 stub：按白名单事实派卡，跑通链路用（不真执行任何动作） */
function stubDraft(input) {
  const cards = [];
  const find = (fn) => input.leaders.find(fn);
  const agree = find((l) => Array.isArray(l.blockers) && l.blockers.includes('agreement_stale'));
  if (agree) cards.push({ kind: 'agreementFollowup', leaderId: Number(agree.leaderId), action: 'sign_agreement', reason: 'stub：协议待补签' });
  const payout = find((l) => Array.isArray(l.blockers) && l.blockers.includes('payout_unbound'));
  if (payout) cards.push({ kind: 'payoutFollowup', leaderId: Number(payout.leaderId), action: 'note', reason: 'stub：未绑收款，先电话跟进' });
  const silent = find((l) => l.band === 'dormant' || l.band === 'never');
  if (silent) cards.push({ kind: 'silentWakeup', leaderId: Number(silent.leaderId), action: 'note', reason: 'stub：沉睡，先电话访谈' });
  const first = input.leaders[0];
  if (first) cards.push({ kind: 'suspendReview', leaderId: Number(first.leaderId), action: 'note', reason: 'stub：复核前先核实事实，暂建议备注' });
  return { cards, notes: [] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) return selftest();
  if (!args.plainFile) {
    process.stderr.write('缺少 --plain-file <path>（或 --selftest）\n');
    process.exit(2);
  }

  const input = readInput(args.plainFile);
  if (!input.structured) {
    const msg = '团长处置卡输入不是有效 JSON（缺在职团长白名单），已跳过生成。';
    process.stdout.write(JSON.stringify({ ok: false, message: msg, cards: [] }));
    process.stderr.write(msg + '\n');
    return;
  }
  if (input.leaders.length === 0) {
    const payload = {
      ok: true,
      mode: args.noLlm ? 'stub' : 'llm',
      cards: [],
      rejected: [],
      notes: ['当前没有在职团长（名册为空），无法出处置卡。'],
      generatedAt: new Date().toISOString(),
    };
    process.stdout.write(JSON.stringify(payload));
    return;
  }

  let rawDraft = null;
  if (args.noLlm) {
    rawDraft = stubDraft(input);
  } else {
    try {
      const text = await callLLM({
        system: buildSystemPrompt(input),
        user: buildUserPrompt(),
        timeoutMs: 15000,
        temperature: 0.4,
      });
      rawDraft = extractJson(text);
    } catch (e) {
      process.stderr.write(`LLM/解析失败：${e?.message || e}\n`);
      rawDraft = { cards: [], notes: ['LLM 输出无法解析，已转人工'] };
    }
  }

  const result = validateLeaderCards(input, rawDraft);
  const payload = {
    ok: true,
    mode: args.noLlm ? 'stub' : 'llm',
    ...result,
    generatedAt: new Date().toISOString(),
  };

  try {
    const dir = pickWritableDir();
    writeFileSync(join(dir, `${Date.now()}.json`), JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    process.stderr.write(`落盘失败（不影响回显）：${e?.message || e}\n`);
  }

  process.stdout.write(JSON.stringify(payload));
}

/** 自证：必报样本（编造团长/非法动作/红线话术/缺理由/重复/错类型）+ 必不报样本（全合法） */
function selftest() {
  let passed = 0;
  let failed = 0;
  const check = (name, cond) => {
    if (cond) {
      passed++;
      process.stdout.write(`PASS ${name}\n`);
    } else {
      failed++;
      process.stdout.write(`FAIL ${name}\n`);
    }
  };

  const input = {
    generatedAt: '2026-11-17T10:00:00+08:00',
    leaders: [
      { leaderId: 12, buildingName: '量子大厦', band: 'dormant', silentDays: 21, monthOrders: 0, blockers: ['payout_unbound'], level: 'formal', gapToNextLevel: null },
      { leaderId: 7, buildingName: '望京 SOHO', band: 'healthy', silentDays: 3, monthOrders: 18, blockers: ['agreement_stale'], level: 'trainee', gapToNextLevel: null },
    ],
    totals: { total: 2, payoutUnbound: 1, agreementStale: 1, blockedAndSilent: 1 },
  };

  // 必不报：三张合法卡全放行
  const ok = validateLeaderCards(input, {
    cards: [
      { kind: 'agreementFollowup', leaderId: 7, action: 'sign_agreement', reason: '协议版本未留痕，建议补签' },
      { kind: 'payoutFollowup', leaderId: 12, action: 'note', reason: '未绑收款，先电话核实' },
      { kind: 'silentWakeup', leaderId: 12, action: 'note', reason: '距最近出单 21 天，先电话访谈' },
    ],
  });
  check('必不报：3 张合法卡全放行', ok.cards.length === 3 && ok.rejected.length === 0);

  // 判据自证：白名单真的含团长（防 leaderMap 恒空导致"全剔除"假绿）
  check('判据自证：白名单含 leaderId 12 与 7', leaderMap(input.leaders).has(12) && leaderMap(input.leaders).has(7));

  // 事实依据不得被 AI 改写（AI 写"band=healthy"，服务端应以白名单 dormant 覆盖）
  // 产物 fmtFacts 真实写法是「分档=dormant」（中文），探针须从产物复制
  check(
    '必报：事实依据取服务端白名单不被改写',
    ok.cards[1].facts.includes('分档=dormant') && !ok.cards[1].facts.includes('healthy'),
  );

  // 执行提示必带红线口径
  check(
    '必报：每张卡带「去 D22 人工 + 未改状态」提示',
    ok.cards.every((c) => c.executeHint.includes('D22') && c.executeHint.includes('未改任何团长状态')),
  );

  // 必报：编造团长 + 非法动作 + 红线话术 + 缺理由 + 错类型 全剔除
  const bad = validateLeaderCards(input, {
    cards: [
      { kind: 'agreementFollowup', leaderId: 999, action: 'note', reason: '编造团长' },
      { kind: 'payoutFollowup', leaderId: 12, action: 'delete', reason: '非法动作' },
      { kind: 'silentWakeup', leaderId: 12, action: 'suspend', reason: '已停用该团长' },
      { kind: 'suspendReview', leaderId: 12, action: 'suspend', reason: '' },
      { kind: 'note', leaderId: 12, action: 'note', reason: '错类型' },
    ],
  });
  check('必报：5 张违规卡全剔除', bad.cards.length === 0 && bad.rejected.length === 5);

  // 必报：重复类型只出第一张（两张同类都合法，第二张须被去重拦下）
  const dup = validateLeaderCards(input, {
    cards: [
      { kind: 'agreementFollowup', leaderId: 7, action: 'sign_agreement', reason: '首张合法' },
      { kind: 'agreementFollowup', leaderId: 12, action: 'sign_agreement', reason: '重复类型' },
    ],
  });
  check('必报：同类只出第一张，重复卡被拦', dup.cards.length === 1 && dup.rejected.length === 1);

  // 红线话术逐个词验证（防词表写错导致恒绿）
  check(
    '判据自证：红线词表逐词可拦',
    BANNED_PITCH_WORDS.every((w) => {
      const r = validateLeaderCards(input, {
        cards: [{ kind: 'agreementFollowup', leaderId: 7, action: 'note', reason: `建议${w}处理` }],
      });
      return r.cards.length === 0;
    }),
  );

  // stub 路径也合规
  const stub = stubDraft(input);
  const stubValid = validateLeaderCards(input, stub);
  check('必不报：stub 产出的卡全部合法', stub.cards.length === 4 && stubValid.cards.length === 4);

  // 空白名单不产卡（防"没有团长也出卡"）
  const empty = validateLeaderCards({ ...input, leaders: [] }, {
    cards: [{ kind: 'agreementFollowup', leaderId: 7, action: 'note', reason: '无白名单也应拦' }],
  });
  check('必报：空白名单时无卡放行', empty.cards.length === 0 && empty.rejected.length === 1);

  process.stdout.write(`\n--selftest: ${passed} passed, ${failed} failed --\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, message: '团长处置卡生成异常', cards: [] }));
  process.stderr.write(`gen-leader-taskcard 异常：${e?.stack || e}\n`);
});

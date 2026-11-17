#!/usr/bin/env node
/**
 * ABox 一盒 · 招募任务卡草稿生成（AI 编排节点 G · 安全版）
 * ------------------------------------------------------------------
 * 定位：把「招募缺口数据（真实楼 ID 白名单）」映射成结构化「招募任务卡」。
 *       **只产草稿、不写库、不调任何写接口、不自动发消息、不建团长**（生成与执行分离）。
 *       这是 G「接执行」的安全版第一步：把 gen-recruit-proposal.mjs 的自由文本话术
 *       升级成可逐卡人工确认的结构化任务卡；运营批准后系统只吐「话术 + 申请路径」物料，
 *       对外一句话都不发。
 *
 * 入参：--plain-file <path>  内容为 JSON（缺口数据），见 readInput 注释
 * 出参：任务卡 JSON 打印 stdout，并落盘 releases/recruit-taskcard/<ts>.json
 *
 * 三道校验（生成时刻快照，与服务端 common/utils/recruit-taskcard.ts 的复核同源）：
 *   ① 缺口白名单：buildingId 必须来自输入 gaps；不在表内 = 剔除（杜绝 LLM 编造楼）
 *   ② 话术合规闸：命中禁用词（躺赚/零花钱/月入过万/独占/保底…）或缺「测算示例」= 剔除
 *   ③ 数字真实性：orderCount30d / gmv30d 必须等于输入值；脚本不得改写，缺失写「暂缺」
 *
 * 原则零保障（AI 可剥离）：--no-llm 用确定性 stub 走通全链路；LLM 失败/解析失败
 *   一律返回空卡 + 说明，绝不抛错中断调用方。
 *
 * ⚠️ ref 恒为 null：缺口楼没有团长 = 没有真实推荐人；推荐码（USR/LDR）只能来自真实
 *    用户/团长，由 user/referral 与 leader/share 现成能力提供，AI 编造会绑错推荐关系。
 *    本期只给裸申请路径 pages/leader-apply/leader-apply（端上 onLoad 无 ref 即自荐）。
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { callLLM, extractJson } from './lib/cloud-llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 收益承诺禁用词（命中即卡不发）——与服务端 BANNED_PITCH_WORDS 逐字同源 */
const BANNED_PITCH_WORDS = [
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
/** 测算示例必须出现的位置：收益文案 */
const ESTIMATE_MARK = '测算示例';
/** 裸申请路径（端上 onLoad 无 ref = 自荐） */
const APPLY_PATH = 'pages/leader-apply/leader-apply';

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

/** 多候选可写目录（与 gen-meal-template.mjs 同源逻辑） */
function pickWritableDir() {
  const repoRoot = existsSync(join(__dirname, '..', 'scripts'))
    ? resolve(__dirname, '..')
    : process.cwd();
  const candidates = [
    join(repoRoot, 'releases', 'recruit-taskcard'),
    join(repoRoot, 'data', 'uploads', 'recruit-taskcard'),
    join(repoRoot, 'data', 'recruit-taskcard'),
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
 * 读入缺口数据。约定 JSON 形状（由 recruit-taskcard.service 实时算出后写入）：
 * {
 *   "generatedAt": "2026-11-17T...",
 *   "gaps": [{ "buildingId": 12, "buildingName": "量子大厦",
 *              "orderCount30d": 138, "gmv30d": "3520.00", "activeLeader": 0 }, ...],
 *   "coveredBuildingIds": [3, 7]
 * }
 * 兼容：非 JSON → 降级为无缺口集，仅打印提示，不抛错。
 */
function readInput(plainFile) {
  const raw = readFileSync(plainFile, 'utf8');
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('not object');
    return {
      generatedAt: String(data.generatedAt || ''),
      gaps: Array.isArray(data.gaps) ? data.gaps : [],
      coveredBuildingIds: Array.isArray(data.coveredBuildingIds) ? data.coveredBuildingIds : [],
      structured: true,
    };
  } catch {
    return { generatedAt: '', gaps: [], coveredBuildingIds: [], structured: false };
  }
}

function gapMap(gaps) {
  const m = new Map();
  for (const g of gaps) {
    const id = Number(g?.buildingId);
    if (Number.isFinite(id)) m.set(id, g);
  }
  return m;
}

function normName(n) {
  return String(n || '')
    .trim()
    .toLowerCase();
}

/** 数字真实性：金额统一两位小数字符串；缺失返回「暂缺」 */
function fmtGmv(v) {
  if (v == null || v === '') return '暂缺';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '暂缺';
}
function fmtCount(v) {
  if (v == null || v === '') return '暂缺';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '暂缺';
}

/** 禁用词检测：返回命中的词数组（空 = 合规） */
function bannedHits(text) {
  const t = String(text || '');
  return BANNED_PITCH_WORDS.filter((w) => t.includes(w));
}

/**
 * 核心护栏：把 LLM 的原始卡逐条校验，只放行「三真」条目。
 * 纯函数，便于单测与 --selftest 自证。返回 { cards, rejected, notes }。
 */
function validateTaskCards(input, rawDraft) {
  const gaps = gapMap(input.gaps);
  const cards = [];
  const rejected = [];
  const notes = [];

  const rawList = Array.isArray(rawDraft?.cards) ? rawDraft.cards : [];
  if (rawList.length === 0) {
    notes.push('AI 未产出任何招募任务卡（缺口数据可能为空，或候选楼不足）。');
  }

  const seen = new Set();
  for (const c of rawList) {
    const buildingId = Number(c?.buildingId);
    const source = gaps.get(buildingId);

    // ① 缺口白名单：buildingId 必须来自输入 gaps
    if (!Number.isFinite(buildingId) || !source) {
      rejected.push({
        buildingId: c?.buildingId ?? null,
        why: `编造/不在缺口白名单的 buildingId=${c?.buildingId}`,
      });
      continue;
    }
    if (seen.has(buildingId)) {
      rejected.push({ buildingId, why: `重复楼 #${buildingId}（同楼只出一张卡）` });
      continue;
    }

    const pitchText = String(c?.pitchText || '').trim();
    const estimateText = String(c?.estimatedEarningText || '').trim();
    if (!pitchText) {
      rejected.push({ buildingId, why: `楼 #${buildingId} 话术为空` });
      continue;
    }

    // ② 话术合规闸：禁用词 + 测算示例存在性
    const hits = bannedHits(`${pitchText} ${estimateText}`);
    if (hits.length) {
      rejected.push({ buildingId, why: `楼 #${buildingId} 话术命中禁用词：${hits.join('、')}` });
      continue;
    }
    if (!estimateText.includes(ESTIMATE_MARK)) {
      rejected.push({ buildingId, why: `楼 #${buildingId} 收益文案缺少「${ESTIMATE_MARK}」标注` });
      continue;
    }

    // ③ 数字真实性：一律用输入值覆盖 AI 可能篡改的数字，缺失写「暂缺」
    const orderCount30d = fmtCount(source.orderCount30d);
    const gmv30d = fmtGmv(source.gmv30d);
    const buildingName = String(source.buildingName || `#${buildingId}`);

    seen.add(buildingId);
    cards.push({
      buildingId,
      buildingName,
      priority: Number.isFinite(Number(c?.priority))
        ? Math.max(1, Math.trunc(Number(c.priority)))
        : cards.length + 1,
      gap: {
        orderCount30d,
        gmv30d,
        activeLeader: Number.isFinite(Number(source.activeLeader))
          ? Number(source.activeLeader)
          : 0,
      },
      targetSegment: '该楼近 30 天有过订单的用户',
      pitchText,
      estimatedEarningText: estimateText,
      applyPath: APPLY_PATH,
      ref: null,
      reason: String(c?.reason ?? ''),
    });
  }

  // 按缺口 GMV 降序排优先级（AI 给的 priority 只作微调，排序以真实 GMV 为准）
  cards.sort((a, b) => Number(b.gap.gmv30d) - Number(a.gap.gmv30d) || a.buildingId - b.buildingId);
  cards.forEach((c, i) => (c.priority = i + 1));

  // 输入里有缺口但 AI 没出卡的楼，记一句提示（不伪造卡）
  for (const g of input.gaps) {
    const id = Number(g?.buildingId);
    if (Number.isFinite(id) && !seen.has(id)) {
      notes.push(`楼 #${id}（${g?.buildingName || '?'}）AI 未出卡，已跳过。`);
    }
  }
  if (Array.isArray(rawDraft?.notes)) {
    for (const n of rawDraft.notes) if (n) notes.push(String(n));
  }

  return { cards, rejected, notes };
}

function buildSystemPrompt(input) {
  const gapLines = input.gaps
    .map(
      (g) =>
        `- buildingId=${Number(g?.buildingId)} 楼名=${g?.buildingName || '?'} 近30天订单=${g?.orderCount30d ?? '暂缺'} GMV=${g?.gmv30d ?? '暂缺'}元 在职团长=${g?.activeLeader ?? 0}`,
    )
    .join('\n');
  return `你是「ABox 一盒」的团长招募编排助理，任务是把**招募缺口数据**写成「招募任务卡草稿」（供人工逐卡确认，绝不直接改库、绝不对外发消息）。

【招募缺口楼】（buildingId 只能从这里选，禁止编造楼名或 ID）
${gapLines || '（空）'}

硬性规则（违反即被系统剔除）：
1. 每张卡给出 buildingId（严格取自上面）、pitchText（可复制的招募话术）、estimatedEarningText（收益文案）、reason（一句话为什么优先拓这栋）；
2. 收益表述必须中性：禁止「躺赚/零花钱/月入过万/轻松赚/稳赚/保底/包赚/暴富/独占/独家代理/被动收入/稳收益/躺赢」等词；
3. estimatedEarningText 必须以「测算示例」开头或包含该四字，并注明「以实际订单与佣金率为准」；金额一律测算示例，不得写成承诺；
4. 一栋楼可以有多位团长，话术不得暗示独占或唯一；
5. 只输出 JSON，不要任何解释文字、不要 markdown 围栏、不要 emoji。

输出 JSON（严格此结构）：
{"cards":[{"buildingId":0,"pitchText":"……","estimatedEarningText":"测算示例：……以实际订单与佣金率为准","reason":"……"}],"notes":["……"]}`;
}

function buildUserPrompt(input) {
  return `请为以下 ${input.gaps.length} 栋招募缺口楼各写一张招募任务卡，按 GMV 优先顺序，输出严格 JSON。`;
}

/** --no-llm 确定性 stub：只产合规空话术卡（跑通链路用，不代表真实文案质量） */
function stubDraft(input) {
  const cards = input.gaps.map((g) => ({
    buildingId: Number(g?.buildingId),
    pitchText: `【${g?.buildingName || '这栋楼'}】正在招募楼内团长，负责把每天的套餐送到工位。有意者可了解详情。`,
    estimatedEarningText: '测算示例：按实际订单与佣金率计算，以实际订单与佣金率为准。',
    reason: `stub：近30天 ${g?.orderCount30d ?? '?'} 单，暂无在职团长`,
  }));
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
    const msg = '招募任务卡输入不是有效 JSON（缺缺口数据），已跳过生成。';
    process.stdout.write(JSON.stringify({ ok: false, message: msg, cards: [] }));
    process.stderr.write(msg + '\n');
    return;
  }
  if (input.gaps.length === 0) {
    const payload = {
      ok: true,
      mode: args.noLlm ? 'stub' : 'llm',
      cards: [],
      rejected: [],
      notes: ['当前没有招募缺口（近30天有单楼均已有在职团长）。'],
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
        user: buildUserPrompt(input),
        timeoutMs: 15000,
        temperature: 0.4,
      });
      rawDraft = extractJson(text);
    } catch (e) {
      process.stderr.write(`LLM/解析失败：${e?.message || e}\n`);
      rawDraft = { cards: [], notes: ['LLM 输出无法解析，已转人工'] };
    }
  }

  const result = validateTaskCards(input, rawDraft);
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

/** 自证：必报样本（编造楼/禁用词/缺测算示例/篡改数字）+ 必不报样本（全合法），两者都断言 */
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
    gaps: [
      {
        buildingId: 12,
        buildingName: '量子大厦',
        orderCount30d: 138,
        gmv30d: '3520.00',
        activeLeader: 0,
      },
      {
        buildingId: 7,
        buildingName: '望京 SOHO',
        orderCount30d: 96,
        gmv30d: '2480.50',
        activeLeader: 0,
      },
    ],
    // 这里是「已被覆盖但仍在 gaps 里」的测试噪声源：脚本层不消费 coveredBuildingIds，
    // 服务端算 gaps 时已减掉有在职团长的楼。故合法样本里 7 可以放行（挑刺 v1.1 修正语义）。
    coveredBuildingIds: [3],
  };

  // 必不报：两张合法卡全放行
  const ok = validateTaskCards(input, {
    cards: [
      {
        buildingId: 12,
        pitchText: '量子大厦招募楼内团长，把套餐送到工位。',
        estimatedEarningText: '测算示例：以实际订单与佣金率为准',
        reason: '单量高',
      },
      {
        buildingId: 7,
        pitchText: '望京 SOHO 招募楼内团长。',
        estimatedEarningText: '测算示例：以实际订单为准',
        reason: '缺口明显',
      },
    ],
  });
  check('必不报：2 张合法卡全放行', ok.cards.length === 2 && ok.rejected.length === 0);

  // 判据自证：先确认输入里的楼真的进了白名单（防 gapMap 恒空导致"全剔除"假绿）
  check('判据自证：缺口白名单含 12 与 7', gapMap(input.gaps).has(12) && gapMap(input.gaps).has(7));

  // 必报：编造楼 + 禁用词 + 缺测算示例 + 数字被 AI 篡改
  const bad = validateTaskCards(input, {
    cards: [
      {
        buildingId: 999,
        pitchText: '编造的楼',
        estimatedEarningText: '测算示例：以实际订单为准',
      },
      {
        buildingId: 12,
        pitchText: '躺赚零花钱，月入过万！',
        estimatedEarningText: '测算示例',
      },
      {
        buildingId: 7,
        pitchText: '望京招募团长。',
        estimatedEarningText: '稳赚不赔',
      },
    ],
  });
  check('必报：3 张违规卡全剔除', bad.cards.length === 0 && bad.rejected.length === 3);

  // 数字真实性：AI 把 GMV 写成 99999，必须被输入值覆盖
  const tampered = validateTaskCards(input, {
    cards: [
      {
        buildingId: 12,
        pitchText: '量子大厦招募团长。',
        estimatedEarningText: '测算示例：以实际订单为准',
        gmv30d: '99999.00',
        orderCount30d: 1,
      },
    ],
  });
  check(
    '必报：AI 篡改 GMV/单量被输入值覆盖',
    tampered.cards.length === 1 &&
      tampered.cards[0].gap.gmv30d === '3520.00' &&
      tampered.cards[0].gap.orderCount30d === '138',
  );

  // ref 恒 null + 裸路径
  check(
    '安全版：ref 恒 null、applyPath 为裸路径',
    ok.cards.every((c) => c.ref === null && c.applyPath === 'pages/leader-apply/leader-apply'),
  );

  // 禁用词检测自证：命中与不命中都要验
  check(
    '话术闸自证：命中禁用词 / 合规话术不命中',
    bannedHits('躺赚零花钱').includes('躺赚') &&
      bannedHits('按月结算，以实际订单为准').length === 0,
  );

  // stub 路径也合规（线上 PROVIDER_MODE=mock 实测曾踩坑）
  const stub = stubDraft(input);
  const stubValid = validateTaskCards(input, stub);
  check('必不报：stub 产出的卡全部合法', stub.cards.length === 2 && stubValid.cards.length === 2);

  // 缺测算示例必拦（别把判据做成恒绿：只查禁用词会放过这条）
  const noMark = validateTaskCards(input, {
    cards: [
      { buildingId: 12, pitchText: '量子大厦招募团长。', estimatedEarningText: '按订单结算' },
    ],
  });
  check('必报：缺「测算示例」标注被拦', noMark.cards.length === 0 && noMark.rejected.length === 1);

  process.stdout.write(`\n--selftest: ${passed} passed, ${failed} failed --\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, message: '招募任务卡生成异常', cards: [] }));
  process.stderr.write(`gen-recruit-taskcard 异常：${e?.stack || e}\n`);
});

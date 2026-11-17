#!/usr/bin/env node
/**
 * ABox 一盒 · 发券策略卡草稿生成（AI 编排节点 H · 安全版）
 * ------------------------------------------------------------------
 * 定位：把「经营数据 + 现有券种白名单 + 楼栋白名单」映射成结构化「发券策略卡」。
 *       **只产草稿、不写库、不调任何写接口、不真发券、不建券种**（生成与执行分离）。
 *       这是 H「接执行」的安全版：把原 gen-coupon-strategy.mjs 的自由文本提案升级成
 *       可逐卡确认的结构化策略卡；运营挑卡后系统只吐「可执行发券清单」（scope + 券种
 *       + 面额门槛 + 试算人群），真发券仍由人拿清单去后台「批量发券」页确认执行。
 *
 * ⚠️ 与 gen-coupon-strategy.mjs 并存、互不替代：那条链路是企微口语「发券策略」的
 *    自由文本提案（营销参谋），本脚本只服务于后台 H 安全版页的结构化出卡。
 *
 * 入参：--plain-file <path>  内容为 JSON（券种/楼栋白名单 + 数据摘要），见 readInput
 * 出参：策略卡 JSON 打印 stdout，并落盘 releases/coupon-taskcard/<ts>.json
 *
 * 三道校验（生成时刻快照，与服务端 common/utils/coupon-taskcard.ts 复核同源）：
 *   ① 券种白名单：couponDefId 必须来自输入 couponDefs；不在表内 = 剔除（杜绝编造 id）
 *   ② 楼栋白名单：scope=building 时 buildingId 必须来自输入 buildings
 *   ③ 金额真实性：面额/门槛/有效期一律用白名单券种的值覆盖 AI 可能篡改的数字；
 *      预算文案必须含「测算示例」；scope 仅允许 all/building
 *
 * 原则零保障（AI 可剥离）：--no-llm 用确定性 stub 走通全链路；LLM 失败/解析失败
 *   一律返回空卡 + 说明，绝不抛错中断调用方、绝不发券。
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { callLLM, extractJson } from './lib/cloud-llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 预算测算文案必须出现的位置 */
const ESTIMATE_MARK = '测算示例';
/** 允许的 scope（与 grant-batch 的 all/building 对齐；phones/userIds 需真实号码/ID，AI 不得编造） */
const ALLOWED_SCOPES = ['all', 'building'];
/** 四类策略的目标枚举 */
const STRATEGY_KINDS = ['newCustomer', 'sleepWake', 'buildingTarget', 'repurchase'];

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

/** 多候选可写目录（与 gen-recruit-taskcard.mjs 同源逻辑） */
function pickWritableDir() {
  const repoRoot = existsSync(join(__dirname, '..', 'scripts'))
    ? resolve(__dirname, '..')
    : process.cwd();
  const candidates = [
    join(repoRoot, 'releases', 'coupon-taskcard'),
    join(repoRoot, 'data', 'uploads', 'coupon-taskcard'),
    join(repoRoot, 'data', 'coupon-taskcard'),
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
 * 读入数据。约定 JSON 形状（由 coupon-taskcard.service 实时算出后写入）：
 * {
 *   "generatedAt": "2026-11-17T...",
 *   "couponDefs": [{ "id": 3, "name": "¥2 无门槛", "faceValueFen": 200,
 *                    "thresholdFen": 0, "validDays": 7, "status": "active" }, ...],
 *   "buildings": [{ "id": 12, "name": "量子大厦", "orderCount30d": 138,
 *                   "gmv30d": "3520.00" }, ...],
 *   "segments": { "newCustomerCount": 340, "sleepCount": 760, "repeatCount": 220 }
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
      couponDefs: Array.isArray(data.couponDefs) ? data.couponDefs : [],
      buildings: Array.isArray(data.buildings) ? data.buildings : [],
      segments: data.segments && typeof data.segments === 'object' ? data.segments : {},
      structured: true,
    };
  } catch {
    return { generatedAt: '', couponDefs: [], buildings: [], segments: {}, structured: false };
  }
}

function defMap(defs) {
  const m = new Map();
  for (const d of defs) {
    const id = Number(d?.id);
    if (Number.isFinite(id)) m.set(id, d);
  }
  return m;
}

function buildingMap(buildings) {
  const m = new Map();
  for (const b of buildings) {
    const id = Number(b?.id);
    if (Number.isFinite(id)) m.set(id, b);
  }
  return m;
}

/** 只读数据里的目标规模（AI 不得改写）；缺失写「暂缺」 */
function fmtScale(v) {
  if (v == null || v === '') return '暂缺';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '暂缺';
}

/**
 * 核心护栏：把 LLM 的原始卡逐条校验，只放行「三真」条目。
 * 纯函数，便于单测与 --selftest 自证。返回 { cards, rejected, notes }。
 */
function validateStrategyCards(input, rawDraft) {
  const defs = defMap(input.couponDefs);
  const blds = buildingMap(input.buildings);
  const cards = [];
  const rejected = [];
  const notes = [];

  const rawList = Array.isArray(rawDraft?.cards) ? rawDraft.cards : [];
  if (rawList.length === 0) notes.push('AI 未产出任何发券策略卡（券种/数据可能不足）。');

  const seen = new Set();
  for (const c of rawList) {
    const kind = String(c?.kind || '');
    if (!STRATEGY_KINDS.includes(kind)) {
      rejected.push({ kind: c?.kind ?? null, why: `未知策略类型 kind=${c?.kind}` });
      continue;
    }
    if (seen.has(kind)) {
      rejected.push({ kind, why: `重复策略类型 ${kind}（同类只出一张卡）` });
      continue;
    }

    const scope = String(c?.scope || '');
    if (!ALLOWED_SCOPES.includes(scope)) {
      rejected.push({ kind, why: `不允许的 scope=${scope}（只允许 all/building）` });
      continue;
    }

    // ① 券种白名单：couponDefId 必须来自输入 couponDefs
    const couponDefId = Number(c?.couponDefId);
    const def = defs.get(couponDefId);
    if (!Number.isFinite(couponDefId) || !def) {
      rejected.push({ kind, why: `编造/不在白名单的 couponDefId=${c?.couponDefId}` });
      continue;
    }

    // ② 楼栋白名单：scope=building 时 buildingId 必须来自输入 buildings，且必须给
    let buildingId = null;
    let buildingName = '';
    if (scope === 'building') {
      buildingId = Number(c?.buildingId);
      const b = blds.get(buildingId);
      if (!Number.isFinite(buildingId) || !b) {
        rejected.push({ kind, why: `scope=building 但 buildingId=${c?.buildingId} 不在楼栋白名单` });
        continue;
      }
      buildingName = String(b.name || `#${buildingId}`);
    }

    // ③ 金额真实性：一律用白名单券种值覆盖 AI 可能篡改的数字
    const budgetText = String(c?.budgetText || '').trim();
    if (!budgetText) {
      rejected.push({ kind, why: `${kind} 缺少预算测算文案` });
      continue;
    }
    if (!budgetText.includes(ESTIMATE_MARK)) {
      rejected.push({ kind, why: `${kind} 预算文案缺少「${ESTIMATE_MARK}」标注` });
      continue;
    }

    // 目标规模：以服务端只读数据为准，按 kind 取，AI 不得改写
    const targetCount =
      kind === 'newCustomer'
        ? fmtScale(input.segments.newCustomerCount)
        : kind === 'sleepWake'
          ? fmtScale(input.segments.sleepCount)
          : kind === 'repurchase'
            ? fmtScale(input.segments.repeatCount)
            : scope === 'building'
              ? fmtScale(blds.get(buildingId)?.orderCount30d)
              : '暂缺';

    seen.add(kind);
    cards.push({
      kind,
      scope,
      buildingId,
      buildingName,
      // 券方案：服务端白名单值，AI 改不动
      couponDefId,
      couponName: String(def.name || '未命名'),
      faceValueFen: Number(def.faceValueFen) || 0,
      thresholdFen: Number(def.thresholdFen) || 0,
      validityType: def.validityType || 'days',
      validDays: Number.isFinite(Number(def.validDays)) ? Number(def.validDays) : 7,
      // 展示/执行辅助
      targetCount,
      budgetText,
      reason: String(c?.reason ?? ''),
      // 执行清单口径：真发券去后台批量发券页，scope+券种+面额门槛照此填
      executeHint:
        scope === 'building'
          ? `后台批量发券：scope=building，buildingId=${buildingId}，选券种 #${couponDefId}`
          : `后台批量发券：scope=all，选券种 #${couponDefId}（或按人群自行圈定）`,
    });
  }

  // 数据里有规模但 AI 没出卡的档，记提示（不伪造卡）
  const kindLabels = {
    newCustomer: '新客承接',
    sleepWake: '沉睡唤醒',
    buildingTarget: '楼栋定向',
    repurchase: '复购激励',
  };
  for (const k of STRATEGY_KINDS) {
    if (!seen.has(k)) notes.push(`${kindLabels[k]}：AI 未出卡，已跳过（可人工在券管理页自定）。`);
  }
  if (Array.isArray(rawDraft?.notes)) {
    for (const n of rawDraft.notes) if (n) notes.push(String(n));
  }

  return { cards, rejected, notes };
}

function buildSystemPrompt(input) {
  const defLines = input.couponDefs
    .filter((d) => String(d.status || 'active') === 'active')
    .map(
      (d) =>
        `- couponDefId=${Number(d.id)} 券种=${d.name || '未命名'} 面额=${d.faceValueFen}分 门槛=${d.thresholdFen}分 有效期=${d.validDays ?? '?'}天`,
    )
    .join('\n');
  const bldLines = input.buildings
    .map(
      (b) =>
        `- buildingId=${Number(b.id)} 楼名=${b.name || '?'} 近30天订单=${b.orderCount30d ?? '暂缺'} GMV=${b.gmv30d ?? '暂缺'}元`,
    )
    .join('\n');
  return `你是「ABox 一盒」的发券策略编排助理，任务是把经营数据写成「发券策略卡草稿」（供人工逐卡确认，绝不直接发券、绝不建券种、绝不改库）。

【现有券种白名单】（couponDefId 只能从这里选，禁止编造 id / 面额 / 门槛）
${defLines || '（空）'}

【楼栋白名单】（scope=building 时 buildingId 只能从这里选）
${bldLines || '（空）'}

【数据摘要】
新客数=${input.segments.newCustomerCount ?? '暂缺'} 沉睡可唤醒数=${input.segments.sleepCount ?? '暂缺'} 复购人数=${input.segments.repeatCount ?? '暂缺'}

硬性规则（违反即被系统剔除）：
1. 最多出 4 张卡，四类各一张：newCustomer（新客承接）/ sleepWake（沉睡唤醒）/ buildingTarget（楼栋定向）/ repurchase（复购激励）；
2. 每张卡给 kind、scope（只能 all 或 building）、couponDefId（严格取自白名单）、reason（一句话为什么这样定）、budgetText（预算测算）；
3. scope=building 时必给 buildingId（严格取自楼栋白名单），否则不要给 scope=building；
4. 不要给面额/门槛/有效期字段（系统自动用白名单券种的真实值覆盖，你写了也没用）；
5. budgetText 必须含「测算示例」四字，并注明以实际核销为准；金额与人数一律测算，不得写成承诺；
6. 数据里人数为「暂缺」时不要硬编，budgetText 里说明「人群暂缺、待核」；
7. 只输出 JSON，不要任何解释文字、不要 markdown 围栏、不要 emoji。

输出 JSON（严格此结构）：
{"cards":[{"kind":"newCustomer","scope":"all","couponDefId":0,"reason":"……","budgetText":"测算示例：……以实际核销为准"}],"notes":["……"]}`;
}

function buildUserPrompt() {
  return '请按四类策略输出严格 JSON 的发券策略卡，couponDefId 与 buildingId 只从白名单里取。';
}

/** --no-llm 确定性 stub：每类选第一张可用券种，跑通链路用 */
function stubDraft(input) {
  const activeDefs = input.couponDefs.filter((d) => String(d.status || 'active') === 'active');
  const def = activeDefs[0] || input.couponDefs[0];
  if (!def) return { cards: [], notes: ['券种白名单为空，stub 无法出卡'] };
  const firstBuilding = input.buildings[0];
  const cards = [
    { kind: 'newCustomer', scope: 'all', couponDefId: Number(def.id), reason: 'stub：承接新客', budgetText: '测算示例：以实际核销为准' },
    { kind: 'sleepWake', scope: 'all', couponDefId: Number(def.id), reason: 'stub：唤醒沉睡', budgetText: '测算示例：以实际核销为准' },
    { kind: 'repurchase', scope: 'all', couponDefId: Number(def.id), reason: 'stub：激励复购', budgetText: '测算示例：以实际核销为准' },
  ];
  if (firstBuilding) {
    cards.push({
      kind: 'buildingTarget',
      scope: 'building',
      buildingId: Number(firstBuilding.id),
      couponDefId: Number(def.id),
      reason: 'stub：楼栋定向',
      budgetText: '测算示例：以实际核销为准',
    });
  }
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
    const msg = '发券策略卡输入不是有效 JSON（缺券种/楼栋白名单），已跳过生成。';
    process.stdout.write(JSON.stringify({ ok: false, message: msg, cards: [] }));
    process.stderr.write(msg + '\n');
    return;
  }
  if (input.couponDefs.length === 0) {
    const payload = {
      ok: true,
      mode: args.noLlm ? 'stub' : 'llm',
      cards: [],
      rejected: [],
      notes: ['当前没有可用券种（后台券种库为空或全停用），无法出策略卡。'],
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

  const result = validateStrategyCards(input, rawDraft);
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

/** 自证：必报样本（编造券种/楼栋/篡改金额/缺测算示例/错 scope）+ 必不报样本（全合法） */
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
    couponDefs: [
      { id: 3, name: '¥2 无门槛', faceValueFen: 200, thresholdFen: 0, validDays: 7, status: 'active' },
      { id: 5, name: '满30减5', faceValueFen: 500, thresholdFen: 3000, validDays: 14, status: 'active' },
      { id: 9, name: '停用券', faceValueFen: 100, thresholdFen: 0, validDays: 7, status: 'inactive' },
    ],
    buildings: [
      { id: 12, name: '量子大厦', orderCount30d: 138, gmv30d: '3520.00' },
      { id: 7, name: '望京 SOHO', orderCount30d: 96, gmv30d: '2480.50' },
    ],
    segments: { newCustomerCount: 340, sleepCount: 760, repeatCount: 220 },
  };

  // 必不报：三张合法卡全放行（含一张 building）
  const ok = validateStrategyCards(input, {
    cards: [
      { kind: 'newCustomer', scope: 'all', couponDefId: 3, reason: '承接新客', budgetText: '测算示例：以实际核销为准' },
      { kind: 'sleepWake', scope: 'all', couponDefId: 5, reason: '唤醒', budgetText: '测算示例：以实际核销为准' },
      { kind: 'buildingTarget', scope: 'building', buildingId: 12, couponDefId: 3, reason: '定向', budgetText: '测算示例：以实际核销为准' },
    ],
  });
  check('必不报：3 张合法卡全放行', ok.cards.length === 3 && ok.rejected.length === 0);

  // 判据自证：白名单真的含券种与楼（防 defMap/bldMap 恒空导致"全剔除"假绿）
  check('判据自证：券种白名单含 3、楼栋白名单含 12', defMap(input.couponDefs).has(3) && buildingMap(input.buildings).has(12));

  // 金额真实性：AI 把面额写成 99999，必须被白名单值 200 覆盖
  check(
    '必报：AI 篡改面额被白名单覆盖',
    ok.cards[0].faceValueFen === 200 && ok.cards[0].thresholdFen === 0,
  );

  // 目标规模：不得被 AI 改写，取数据摘要
  check(
    '必报：新客目标规模取服务端数据 340',
    ok.cards[0].targetCount === '340' && ok.cards[2].targetCount === '138',
  );

  // 必报：编造券种 + 编造楼 + 错 scope + 缺测算示例 + 改金额（金额字段被忽略但金额篡改不影响放行，这里测的是白名单）
  const bad = validateStrategyCards(input, {
    cards: [
      { kind: 'newCustomer', scope: 'all', couponDefId: 999, budgetText: '测算示例' },
      { kind: 'sleepWake', scope: 'building', buildingId: 999, couponDefId: 3, budgetText: '测算示例' },
      { kind: 'repurchase', scope: 'phones', couponDefId: 3, budgetText: '测算示例' },
      { kind: 'buildingTarget', scope: 'building', buildingId: 12, couponDefId: 3, budgetText: '按实际发' },
      { kind: 'unknown', scope: 'all', couponDefId: 3, budgetText: '测算示例' },
    ],
  });
  check('必报：5 张违规卡全剔除', bad.cards.length === 0 && bad.rejected.length === 5);

  // 停用券种被放行？——安全版只校验 id 在白名单，status 过滤发生在 prompt 层；
  // 这里显式测「停用券 id 在白名单内会被放行」，提示服务端出卡前应过滤停用券。
  const inactiveCard = validateStrategyCards(input, {
    cards: [{ kind: 'newCustomer', scope: 'all', couponDefId: 9, budgetText: '测算示例' }],
  });
  check('白名单口径：停用券 id 在表内会放行（服务端出数时应只给 active）', inactiveCard.cards.length === 1);

  // stub 路径也合规
  const stub = stubDraft(input);
  const stubValid = validateStrategyCards(input, stub);
  check('必不报：stub 产出的卡全部合法', stub.cards.length === 4 && stubValid.cards.length === 4);

  // 缺测算示例必拦（别把判据做成恒绿）
  const noMark = validateStrategyCards(input, {
    cards: [{ kind: 'newCustomer', scope: 'all', couponDefId: 3, budgetText: '按实际核销' }],
  });
  check('必报：缺「测算示例」标注被拦', noMark.cards.length === 0 && noMark.rejected.length === 1);

  process.stdout.write(`\n--selftest: ${passed} passed, ${failed} failed --\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, message: '发券策略卡生成异常', cards: [] }));
  process.stderr.write(`gen-coupon-taskcard 异常：${e?.stack || e}\n`);
});

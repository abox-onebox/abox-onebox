#!/usr/bin/env node
/**
 * ABox 一盒 · 开团草稿生成（AI 编排节点 · #1 自动开团闭环 批 1）
 * ------------------------------------------------------------------
 * 定位：把「F 选品提案（自由文本）」+「真实候选集（模板库实 ID / 楼群）」映射成
 *       结构化「开团草稿」。**只产草稿、不写库、不调任何写接口**（生成与执行分离）。
 *
 * 为什么需要这一层：gen-meal-proposal.mjs 输出是自由文本 markdown，没有 setMealId /
 * buildingGroupId；而排餐上架 API（admin/meal/assignments）必须吃真实 ID。故由本节点
 * 在「ID 白名单」约束下做映射，杜绝 LLM 编造 ID。
 *
 * 入参：--plain-file <path>  内容为 JSON（候选集 + 提案原文），见下方 readInput 注释
 * 出参：draft JSON 打印 stdout，并落盘 releases/launch-draft/<mealDate>.json
 *
 * 口径（2026-11-04 用户定）：
 *   - 逐日排：一次只排 `mealDate` 这一天（不排整周）
 *   - 楼群 1–2 个：draft 按楼群各出一条
 *   - 企微优先：draft 采用「一天一楼群一行」的扁平结构，便于企微文本确认
 *
 * 原则零保障（AI 可剥离）：--no-llm 用确定性 stub 走通全链路；LLM 失败/解析失败
 * 一律返回空草稿 + needsNewTemplate 说明，绝不抛错中断调用方。
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { callLLM, extractJson } from './lib/cloud-llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

/** 多候选可写目录（与 gen-meal-proposal.mjs 同源逻辑） */
function pickWritableDir() {
  const repoRoot = existsSync(join(__dirname, '..', 'scripts')) ? resolve(__dirname, '..') : process.cwd();
  const candidates = [
    join(repoRoot, 'releases', 'launch-draft'),
    join(repoRoot, 'data', 'uploads', 'launch-draft'),
    join(repoRoot, 'data', 'launch-draft'),
    join(tmpdir(), 'abox-launch-draft'),
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
 * 读入候选集。约定 JSON 形状：
 * {
 *   "mealDate": "2026-11-05",
 *   "buildingGroups": [{ "id": 1, "name": "量子大厦" }],
 *   "templates": [{ "id": 7, "name": "牛肉双拼", "kind": "meal",
 *                   "price": "25.80", "usedCount": 86, "items": ["牛肉","鸡腿"] }],
 *   "proposalText": "……F 选品提案原文……"
 * }
 * 兼容：若文件不是 JSON，则降级为「纯文本 → 空候选集」，仅打印提示，不抛错。
 */
function readInput(plainFile) {
  const raw = readFileSync(plainFile, 'utf8');
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('not object');
    return {
      mealDate: String(data.mealDate || ''),
      buildingGroups: Array.isArray(data.buildingGroups) ? data.buildingGroups : [],
      templates: Array.isArray(data.templates) ? data.templates : [],
      proposalText: String(data.proposalText || ''),
      structured: true,
    };
  } catch {
    return { mealDate: '', buildingGroups: [], templates: [], proposalText: raw, structured: false };
  }
}

function idSet(list) {
  const s = new Set();
  for (const x of list) {
    const id = Number(x?.id);
    if (Number.isFinite(id)) s.add(id);
  }
  return s;
}

/**
 * 核心护栏：把 LLM 的原始 draft 逐条校验，只放行「三真」条目
 *   - mealDate 必须等于 input.mealDate（逐日排）
 *   - buildingGroupId 必须在候选楼群内
 *   - setMealId 必须在候选模板内（白名单）
 * 越界条目进 dropped[]，同时把「该楼群无可用模板」记入 needsNewTemplate。
 * 纯函数，便于单测与 --selftest 自证。
 */
function validateDraft(input, rawDraft) {
  const bgIds = idSet(input.buildingGroups);
  const tmplIds = idSet(input.templates);
  const drafts = [];
  const dropped = [];
  const needsNewTemplate = [];

  const rawList = Array.isArray(rawDraft?.drafts) ? rawDraft.drafts : [];
  for (const d of rawList) {
    const mealDate = String(d?.mealDate ?? '');
    const bg = Number(d?.buildingGroupId);
    const sm = Number(d?.setMealId);
    if (mealDate !== input.mealDate) {
      dropped.push({ draft: d, why: `mealDate「${mealDate}」≠ 本次排期「${input.mealDate}」（逐日排）` });
      continue;
    }
    if (!bgIds.has(bg)) {
      dropped.push({ draft: d, why: `buildingGroupId ${bg} 不在候选楼群` });
      continue;
    }
    if (!tmplIds.has(sm)) {
      dropped.push({ draft: d, why: `setMealId ${sm} 不在候选模板白名单` });
      continue;
    }
    drafts.push({ mealDate, buildingGroupId: bg, setMealId: sm, reason: String(d?.reason ?? '') });
  }

  // 去重：同一楼群只留一条（后到覆盖先到）
  const byBg = new Map();
  for (const d of drafts) byBg.set(d.buildingGroupId, d);
  const finalDrafts = [...byBg.values()].sort((a, b) => a.buildingGroupId - b.buildingGroupId);

  // 覆盖度：哪些候选楼群没排到 → 提示（不自动补，交人判断）
  const covered = new Set(finalDrafts.map((d) => d.buildingGroupId));
  for (const bg of input.buildingGroups) {
    const id = Number(bg?.id);
    if (Number.isFinite(id) && !covered.has(id)) {
      needsNewTemplate.push({ buildingGroupId: id, reason: `楼群「${bg?.name || id}」未排到套餐（AI 未给或全部越界）` });
    }
  }
  // 透传 LLM 自报的缺模板
  if (Array.isArray(rawDraft?.needsNewTemplate)) {
    for (const n of rawDraft.needsNewTemplate) needsNewTemplate.push({ reason: String(n?.reason ?? n) });
  }

  return { drafts: finalDrafts, dropped, needsNewTemplate };
}

function buildSystemPrompt(input) {
  const tmplLines = input.templates
    .map(
      (t) =>
        `- id=${t.id} 名=${t.name || ''} 类型=${t.kind || 'meal'} 价=${t.price || ''} 被排次数usedCount=${t.usedCount ?? 0}`,
    )
    .join('\n');
  const bgLines = input.buildingGroups.map((b) => `- id=${b.id} 名=${b.name || ''}`).join('\n');
  return `你是「ABox 一盒」的排餐编排助理，任务是【逐日】把选品提案落成「开团草稿（草稿，供人工一键确认，绝不直接改库）」。

本次排期：${input.mealDate}（只排这一天）

【候选楼群】（buildingGroupId 只能从这里选）
${bgLines || '（空）'}

【候选套餐模板】（setMealId 只能从这里选，禁止编造）
${tmplLines || '（空）'}

规则（违反即视为错误，会被系统剔除）：
1. 每个候选楼群出一条草稿，用该楼群最合适的候选模板；
2. setMealId 必须严格取自上面候选模板的 id；buildingGroupId 必须严格取自候选楼群 id；
3. mealDate 一律写 ${input.mealDate}；
4. 若某楼群找不到合适模板（如提案里的新菜无对应模板），不要编造，放进 needsNewTemplate 并说明；
5. 只输出 JSON，不要任何解释文字、不要 markdown 围栏、不要 emoji。

输出 JSON（严格此结构）：
{"drafts":[{"mealDate":"${input.mealDate}","buildingGroupId":0,"setMealId":0,"reason":"一句话理由"}],"needsNewTemplate":[{"reason":"……"}]}`;
}

function buildUserPrompt(input) {
  return `【F 选品提案原文】\n${input.proposalText || '（无，暂缺）'}\n\n请据此为每个候选楼群挑选本次排期的套餐模板，输出严格 JSON。`;
}

/** --no-llm 确定性 stub：给每个楼群取「usedCount 最高」的模板（跑通链路用，不代表真实决策） */
function stubDraft(input) {
  const sorted = [...input.templates].sort((a, b) => Number(b?.usedCount ?? 0) - Number(a?.usedCount ?? 0));
  const best = sorted[0];
  const drafts = input.buildingGroups.map((b) => ({
    mealDate: input.mealDate,
    buildingGroupId: Number(b.id),
    setMealId: best ? Number(best.id) : 0,
    reason: best ? `stub：取 usedCount 最高模板「${best.name || best.id}」` : 'stub：无候选模板',
  }));
  return { drafts, needsNewTemplate: best ? [] : [{ reason: '候选模板为空' }] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) return selftest();
  if (!args.plainFile) {
    process.stderr.write('缺少 --plain-file <path>（或 --selftest）\n');
    process.exit(2);
  }

  const input = readInput(args.plainFile);
  if (!input.structured || !input.mealDate) {
    const msg = '开团草稿输入不是有效 JSON（缺 mealDate/候选集），已跳过生成。';
    process.stdout.write(JSON.stringify({ ok: false, message: msg, drafts: [] }));
    process.stderr.write(msg + '\n');
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
        timeoutMs: 9000,
        temperature: 0.2,
      });
      rawDraft = extractJson(text);
    } catch (e) {
      process.stderr.write(`LLM/解析失败：${e?.message || e}\n`);
      rawDraft = { drafts: [], needsNewTemplate: [{ reason: 'LLM 输出无法解析，已转人工' }] };
    }
  }

  const result = validateDraft(input, rawDraft);
  const payload = {
    ok: true,
    mealDate: input.mealDate,
    mode: args.noLlm ? 'stub' : 'llm',
    ...result,
    generatedAt: new Date().toISOString(),
  };

  // 落盘（失败不影响回显）
  try {
    const dir = pickWritableDir();
    writeFileSync(join(dir, `${input.mealDate}.json`), JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    process.stderr.write(`落盘失败（不影响回显）：${e?.message || e}\n`);
  }

  process.stdout.write(JSON.stringify(payload));
}

/** 自证：必报样本（越界 ID / 错日期）+ 必不报样本（全合法），两者都断言，防恒绿/恒红 */
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
    mealDate: '2026-11-05',
    structured: true,
    buildingGroups: [
      { id: 1, name: '量子大厦' },
      { id: 2, name: '京仪大厦' },
    ],
    templates: [
      { id: 7, name: '牛肉双拼', usedCount: 86 },
      { id: 9, name: '鸡腿套餐', usedCount: 40 },
    ],
    proposalText: '牛肉/鸡腿领跑',
  };

  // 必不报：全部合法
  const ok = validateDraft(input, {
    drafts: [
      { mealDate: '2026-11-05', buildingGroupId: 1, setMealId: 7, reason: '热销' },
      { mealDate: '2026-11-05', buildingGroupId: 2, setMealId: 9, reason: '次热' },
    ],
  });
  check('必不报：2 条合法草稿全放行', ok.drafts.length === 2 && ok.dropped.length === 0);

  // 必报：越界 setMealId / 越界楼群 / 错日期
  const bad = validateDraft(input, {
    drafts: [
      { mealDate: '2026-11-05', buildingGroupId: 1, setMealId: 999, reason: '编造ID' },
      { mealDate: '2026-11-05', buildingGroupId: 3, setMealId: 7, reason: '编造楼群' },
      { mealDate: '2026-11-06', buildingGroupId: 1, setMealId: 7, reason: '错日期' },
    ],
  });
  check('必报：3 条越界/错日期全剔除', bad.drafts.length === 0 && bad.dropped.length === 3);
  check('必报：未覆盖楼群进 needsNewTemplate', bad.needsNewTemplate.length >= 2);

  // 去重：同一楼群两条只留一条
  const dup = validateDraft(input, {
    drafts: [
      { mealDate: '2026-11-05', buildingGroupId: 1, setMealId: 7, reason: 'a' },
      { mealDate: '2026-11-05', buildingGroupId: 1, setMealId: 9, reason: 'b' },
    ],
  });
  check('去重：同楼群只留 1 条', dup.drafts.length === 1);

  process.stdout.write(`\n--selftest: ${passed} passed, ${failed} failed --\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, message: '开团草稿生成异常', drafts: [] }));
  process.stderr.write(`gen-launch-draft 异常：${e?.stack || e}\n`);
});

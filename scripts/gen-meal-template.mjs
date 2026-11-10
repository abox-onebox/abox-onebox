#!/usr/bin/env node
/**
 * ABox 一盒 · 套餐模板草稿生成（AI 编排节点 · #A 供给侧建模板）
 * ------------------------------------------------------------------
 * 定位：把「F 选品提案（自由文本）/业务目标」+「真实菜品库（itemId 白名单）」映射成
 *       结构化「套餐模板草稿」。**只产草稿、不写库、不调任何写接口**（生成与执行分离）。
 *
 * 为什么需要这一层（解自动开团恒 0 的死结）：
 *   gen-launch-draft 这一步恒为 0 条，根因是 `ab_set_meal` 里 `kind='meal'` 正餐模板
 *   不够、且提案里出现的「零食/饮品」在模板库完全没有对应。本节点反向补「供给侧」：
 *   让 AI 把提案直接落成**可入模板库的草稿**（带真实 itemId），人工确认后由 D7 入库。
 *
 * 入参：--plain-file <path>  内容为 JSON（候选菜品集 + 提案原文），见 readInput 注释
 * 出参：draft JSON 打印 stdout，并落盘 releases/meal-template/<ts>.json
 *
 * 护栏（与 D7 服务端校验同源，但这是「生成时刻快照」的第一道闸）：
 *   - itemId 必须取自菜品白名单且 status=1（杜绝 LLM 编造 ID / 选已下架菜）
 *   - 饭类(kind='meal')：恰好覆盖档位 {1,2,3,4}（主件/辅品/素品/附品）各一道，禁 slot=5
 *   - 快消(kind='fmcg')：任意档位 1–5、≥1 件
 *   - ⭐ 品类隔离（2026-11-10）：`fmcg` 候选池只放 `category` 为空的独立预包装单品，
 *     `meal` 只放 `category` 非空的现做菜。判据与服务端 `dishFitsKind()` 同源。
 *     当前只跑快消品，混进现做菜 = 「仅销售预包装食品备案」下实际制售，属资质混用。
 *   - name 非空且不与 existingTemplates 重名
 *
 * 原则零保障（AI 可剥离）：--no-llm 用确定性 stub 走通全链路；LLM 失败/解析失败
 * 一律返回空草稿 + 说明，绝不抛错中断调用方。
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { callLLM, extractJson } from './lib/cloud-llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 与 @abox/shared-utils SET_MEAL_COMPOSITION 同源（脚本侧硬拷贝，避免引 TS 包）
const REQUIRED_SLOTS = [1, 2, 3, 4];
const SLOT_LABEL = { 1: '主件', 2: '辅品', 3: '素品', 4: '附品', 5: '随附' };
const STAPLE_SLOT = 5;

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

/** 多候选可写目录（与 gen-launch-draft.mjs 同源逻辑） */
function pickWritableDir() {
  const repoRoot = existsSync(join(__dirname, '..', 'scripts'))
    ? resolve(__dirname, '..')
    : process.cwd();
  const candidates = [
    join(repoRoot, 'releases', 'meal-template'),
    join(repoRoot, 'data', 'uploads', 'meal-template'),
    join(repoRoot, 'data', 'meal-template'),
    join(tmpdir(), 'abox-meal-template'),
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
 * 读入候选菜品集。约定 JSON 形状：
 * {
 *   "proposalText": "……F 选品提案原文 / 业务目标……",
 *   "kind": "meal" | "fmcg" (可选，默认 meal),
 *   "dishes": [{ "id": 101, "name": "红烧牛肉", "category": "主荤",
 *                "costPrice": "6.50", "status": 1 }, ...],
 *   "existingTemplates": [{ "id": 7, "name": "牛肉双拼" }, ...] (可选)
 * }
 * 兼容：若文件不是 JSON，则降级为「纯文本 → 空候选集」，仅打印提示，不抛错。
 */
function readInput(plainFile) {
  const raw = readFileSync(plainFile, 'utf8');
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('not object');
    return {
      proposalText: String(data.proposalText || ''),
      kind: data.kind === 'fmcg' ? 'fmcg' : 'meal',
      dishes: Array.isArray(data.dishes) ? data.dishes : [],
      existingTemplates: Array.isArray(data.existingTemplates) ? data.existingTemplates : [],
      structured: true,
    };
  } catch {
    return {
      proposalText: raw,
      kind: 'meal',
      dishes: [],
      existingTemplates: [],
      structured: false,
    };
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

/** 菜品查找表：id → {name, status} */
function dishMap(list) {
  const m = new Map();
  for (const d of list) {
    const id = Number(d?.id);
    if (Number.isFinite(id)) m.set(id, { name: String(d?.name || ''), status: Number(d?.status) });
  }
  return m;
}

/**
 * `ab_item.category` 非空 = 现做菜；空 / null = 独立预包装快消单品。
 * ⚠️ 与服务端 `common/utils/meal-template.ts` 的 `isCookedDish()` 逐字同源：
 *    两边漂移会造成「生成时拦了、确认时又放行」。
 */
function isCookedCategory(category) {
  return category != null && String(category).trim() !== '';
}

/** 候选池按品类隔离 —— 生成时就不给 LLM 看见另一品类的 id */
function filterDishesByKind(dishes, kind) {
  const cooked = kind !== 'fmcg';
  return (Array.isArray(dishes) ? dishes : []).filter(
    (d) => isCookedCategory(d?.category) === cooked,
  );
}

function normName(n) {
  return String(n || '')
    .trim()
    .toLowerCase();
}

/**
 * 核心护栏：把 LLM 的原始 draft 逐条校验，只放行「三真」条目。
 * 纯函数，便于单测与 --selftest 自证。
 * 返回 { drafts, dropped, notes }。
 */
function validateTemplateDraft(input, rawDraft) {
  const allIds = idSet(input.dishes);
  const existingNames = new Set(
    (input.existingTemplates || []).map((t) => normName(t?.name)).filter(Boolean),
  );

  const drafts = [];
  const dropped = [];
  const notes = [];

  const rawList = Array.isArray(rawDraft?.drafts) ? rawDraft.drafts : [];
  if (rawList.length === 0) {
    notes.push('AI 未产出任何模板草稿（提案可能缺少明确菜品，或候选库不足）。');
  }

  for (const d of rawList) {
    const name = String(d?.name || '').trim();
    const kind = d?.kind === 'fmcg' ? 'fmcg' : input.kind === 'fmcg' ? 'fmcg' : 'meal';
    // 每条草稿按**自己的 kind**取候选池：LLM 即便把 kind 写错，也拿不到另一品类的 id
    const dishes = dishMap(filterDishesByKind(input.dishes, kind));
    const dishIds = idSet(filterDishesByKind(input.dishes, kind));
    const items = Array.isArray(d?.items) ? d.items : [];

    // ① 名称
    if (!name) {
      dropped.push({ draft: d, why: '模板名不能为空' });
      continue;
    }
    if (existingNames.has(normName(name))) {
      dropped.push({ draft: d, why: `模板名「${name}」与现有模板重名` });
      continue;
    }

    // ② 商品项形态
    if (items.length === 0) {
      dropped.push({ draft: d, why: `模板「${name}」没有任何商品项` });
      continue;
    }
    const normalizedItems = [];
    let itemBad = false;
    for (const it of items) {
      const itemId = Number(it?.itemId);
      const slot = Number(it?.slot);
      if (!Number.isFinite(itemId) || !dishIds.has(itemId)) {
        const why = allIds.has(itemId)
          ? `模板「${name}」含品类不符的单品 #${itemId}（${kind} 模板不能混用另一品类）`
          : `模板「${name}」含编造/不在候选库的 itemId=${it?.itemId}`;
        dropped.push({ draft: d, why });
        itemBad = true;
        break;
      }
      if (dishes.get(itemId).status !== 1) {
        dropped.push({ draft: d, why: `模板「${name}」含已下架菜品 #${itemId}` });
        itemBad = true;
        break;
      }
      if (!Number.isInteger(slot) || slot < 1 || slot > 5) {
        dropped.push({ draft: d, why: `模板「${name}」含非法档位 slot=${it?.slot}（需 1–5）` });
        itemBad = true;
        break;
      }
      normalizedItems.push({ itemId, slot });
    }
    if (itemBad) continue;

    // ③ 构成规则
    const slots = normalizedItems.map((p) => p.slot);
    if (new Set(normalizedItems.map((p) => p.itemId)).size !== normalizedItems.length) {
      dropped.push({ draft: d, why: `模板「${name}」含重复商品项` });
      continue;
    }
    if (kind === 'meal') {
      const missing = REQUIRED_SLOTS.filter((s) => !slots.includes(s));
      const extra = slots.filter((s) => s === STAPLE_SLOT);
      if (missing.length || extra.length) {
        const parts = [];
        if (missing.length)
          parts.push(`缺少档位 ${missing.map((s) => SLOT_LABEL[s] ?? s).join(' / ')}`);
        if (extra.length)
          parts.push('含不允许的主食档位 slot=5（米饭由集散中心统一供，不建商品项）');
        dropped.push({ draft: d, why: `模板「${name}」不满足一饭四菜：${parts.join('；')}` });
        continue;
      }
    }

    drafts.push({
      name,
      kind,
      price: typeof d?.price === 'number' && d.price > 0 ? d.price : undefined,
      items: normalizedItems,
      reason: String(d?.reason ?? ''),
    });
  }

  // 去重：同名只留第一条
  const byName = new Map();
  for (const d of drafts) byName.set(normName(d.name), d);
  const finalDrafts = [...byName.values()];

  if (Array.isArray(rawDraft?.notes)) {
    for (const n of rawDraft.notes) if (n) notes.push(String(n));
  }

  return { drafts: finalDrafts, dropped, notes };
}

function buildSystemPrompt(input) {
  const kind = input.kind === 'fmcg' ? 'fmcg' : 'meal';
  const dishLines = filterDishesByKind(input.dishes, kind)
    .map(
      (t) =>
        `- id=${t.id} 名=${t.name || ''} 品类=${t.category || ''} 供价=${t.costPrice || ''} 状态=${t.status === 1 ? '在售' : '下架'}`,
    )
    .join('\n');
  const ruleText =
    kind === 'meal'
      ? '饭类套餐：必须恰好包含档位 1=主件、2=辅品、3=素品、4=附品 各一道（共 4 项，禁止 slot=5 主食档）。'
      : '快消品套餐：任意档位 1–5、至少 1 项，不强制一饭四菜。';
  return `你是「ABox 一盒」的套餐模板编排助理，任务是把选品提案落成「套餐模板草稿（草稿，供人工确认入库，绝不直接改库）」。

本次模板类型：${kind}
构成规则：${ruleText}
档位含义：1=主件 2=辅品 3=素品 4=附品 5=随附（饭类禁用 5）。

【候选菜品库】（itemId 只能从这里选，且只要 status=在售 的；禁止编造 id，禁止选下架菜）
${dishLines || '（空）'}

规则（违反即被系统剔除)：
1. 每个模板给出 name（中文套餐名）、items（数组，每项 {itemId, slot}）、可选 price（元）、reason（一句话理由）；
2. itemId 必须严格取自候选库且在售；slot 必须是 1–5 且符合上面的构成规则；
3. 不要超出候选库范围，不要出现候选库没有的菜品；
4. 只输出 JSON，不要任何解释文字、不要 markdown 围栏、不要 emoji。

输出 JSON（严格此结构）：
{"drafts":[{"name":"套餐名","kind":"${kind}","price":25.8,"items":[{"itemId":0,"slot":1},{"itemId":0,"slot":2},{"itemId":0,"slot":3},{"itemId":0,"slot":4}],"reason":"一句话理由"}],"notes":["……"]}`;
}

function buildUserPrompt(input) {
  return `【选品提案原文 / 业务目标】\n${input.proposalText || '（无，暂缺）'}\n\n请据此产出 1–3 个符合构成规则的套餐模板草稿，输出严格 JSON。`;
}

/** --no-llm 确定性 stub：给饭类挑 4 个在售菜分slot 1–4；快消挑最多 3 个分slot 1–3（跑通链路用，不代表真实决策） */
function stubDraft(input) {
  const kind = input.kind === 'fmcg' ? 'fmcg' : 'meal';
  const onSale = filterDishesByKind(input.dishes, kind).filter((d) => d.status === 1);
  if (onSale.length === 0) return { drafts: [], notes: ['候选菜品库为空，stub 无法生成'] };
  if (kind === 'meal') {
    if (onSale.length < 4)
      return { drafts: [], notes: ['在售菜品不足 4 个，stub 无法凑齐一饭四菜'] };
    const items = onSale.slice(0, 4).map((d, i) => ({ itemId: Number(d.id), slot: i + 1 }));
    return {
      drafts: [
        {
          name: `AI草稿-四菜套餐(${onSale[0].name})`,
          kind,
          items,
          reason: 'stub：取前 4 个在售菜',
        },
      ],
      notes: [],
    };
  }
  const items = onSale.slice(0, 3).map((d, i) => ({ itemId: Number(d.id), slot: i + 1 }));
  return {
    drafts: [
      { name: `AI草稿-快消组合(${onSale[0].name})`, kind, items, reason: 'stub：取前 3 个在售品' },
    ],
    notes: [],
  };
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
    const msg = '套餐模板草稿输入不是有效 JSON（缺候选菜品集），已跳过生成。';
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
        timeoutMs: 12000,
        temperature: 0.3,
      });
      rawDraft = extractJson(text);
    } catch (e) {
      process.stderr.write(`LLM/解析失败：${e?.message || e}\n`);
      rawDraft = { drafts: [], notes: ['LLM 输出无法解析，已转人工'] };
    }
  }

  const result = validateTemplateDraft(input, rawDraft);
  const payload = {
    ok: true,
    kind: input.kind,
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

/** 自证：必报样本（越界 ID / 错档位 / 重名）+ 必不报样本（全合法），两者都断言，防恒绿/恒红 */
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
    kind: 'meal',
    dishes: [
      { id: 101, name: '红烧牛肉', category: '主荤', costPrice: '6.5', status: 1 },
      { id: 102, name: '宫保鸡丁', category: '半荤', costPrice: '5.0', status: 1 },
      { id: 103, name: '清炒时蔬', category: '素菜', costPrice: '2.0', status: 1 },
      { id: 104, name: '紫菜蛋汤', category: '汤品', costPrice: '1.5', status: 1 },
      { id: 199, name: '下架菜', category: '主荤', costPrice: '9.0', status: 0 },
      // 独立预包装快消单品：生产库里 category 为 NULL，服务端下发 ''
      { id: 201, name: '康师傅冰红茶', category: '', costPrice: '3.0', status: 1 },
      { id: 202, name: '旺旺雪饼', category: '', costPrice: '4.0', status: 1 },
      { id: 203, name: '达利园蛋黄派', category: '', costPrice: '5.0', status: 1 },
    ],
    existingTemplates: [{ id: 7, name: '牛肉双拼' }],
    structured: true,
  };

  // 必不报：饭类一饭四菜全部合法 + 快消合法
  const ok = validateTemplateDraft(input, {
    drafts: [
      {
        name: '牛肉四菜',
        kind: 'meal',
        items: [
          { itemId: 101, slot: 1 },
          { itemId: 102, slot: 2 },
          { itemId: 103, slot: 3 },
          { itemId: 104, slot: 4 },
        ],
      },
      {
        name: '快消组合',
        kind: 'fmcg',
        items: [{ itemId: 201, slot: 1 }],
      },
    ],
  });
  check('必不报：合法饭类+合法快消全放行', ok.drafts.length === 2 && ok.dropped.length === 0);

  // 必报：编造 id / 下架菜 / 缺档位(少素品) / 含主食档位5 / 重名
  const bad = validateTemplateDraft(input, {
    drafts: [
      {
        name: '编造ID',
        kind: 'meal',
        items: [
          { itemId: 999, slot: 1 },
          { itemId: 102, slot: 2 },
          { itemId: 103, slot: 3 },
          { itemId: 104, slot: 4 },
        ],
      },
      {
        name: '下架菜',
        kind: 'meal',
        items: [
          { itemId: 101, slot: 1 },
          { itemId: 199, slot: 2 },
          { itemId: 103, slot: 3 },
          { itemId: 104, slot: 4 },
        ],
      },
      {
        name: '缺素品',
        kind: 'meal',
        items: [
          { itemId: 101, slot: 1 },
          { itemId: 102, slot: 2 },
          { itemId: 104, slot: 4 },
        ],
      },
      {
        name: '含主食档',
        kind: 'meal',
        items: [
          { itemId: 101, slot: 1 },
          { itemId: 102, slot: 2 },
          { itemId: 103, slot: 3 },
          { itemId: 104, slot: 5 },
        ],
      },
      {
        name: '牛肉双拼',
        kind: 'meal',
        items: [
          { itemId: 101, slot: 1 },
          { itemId: 102, slot: 2 },
          { itemId: 103, slot: 3 },
          { itemId: 104, slot: 4 },
        ],
      },
    ],
  });
  check('必报：5 条违规全剔除', bad.drafts.length === 0 && bad.dropped.length === 5);

  // 快消：任意档位 ≥1 件即可（slot=3 单品合法）
  const fmcgOk = validateTemplateDraft(
    { ...input, kind: 'fmcg' },
    { drafts: [{ name: '单品', kind: 'fmcg', items: [{ itemId: 201, slot: 3 }] }] },
  );
  check('快消：单品 slot=3 合法', fmcgOk.drafts.length === 1 && fmcgOk.dropped.length === 0);

  // 重复商品项应剔除
  const dup = validateTemplateDraft(input, {
    drafts: [
      {
        name: '重复菜',
        kind: 'meal',
        items: [
          { itemId: 101, slot: 1 },
          { itemId: 101, slot: 2 },
          { itemId: 103, slot: 3 },
          { itemId: 104, slot: 4 },
        ],
      },
    ],
  });
  check('重复商品项：剔除', dup.drafts.length === 0 && dup.dropped.length === 1);

  // ---- 品类隔离（2026-11-10）----
  // 判据自证：先看候选池真的被切成两半（防止过滤函数恒返回全部 / 恒返回空）
  const cookedPool = filterDishesByKind(input.dishes, 'meal');
  const fmcgPool = filterDishesByKind(input.dishes, 'fmcg');
  check(
    '品类隔离自证：meal 池 5 个现做菜 / fmcg 池 3 个快消单品',
    cookedPool.length === 5 &&
      fmcgPool.length === 3 &&
      cookedPool.every((d) => d.id < 200) &&
      fmcgPool.every((d) => d.id >= 200),
  );

  // 必报：快消模板混入现做菜（旧版会放行，正是本次要堵的资质混用）
  const mixedFmcg = validateTemplateDraft(
    { ...input, kind: 'fmcg' },
    { drafts: [{ name: '混入现做菜', kind: 'fmcg', items: [{ itemId: 101, slot: 1 }] }] },
  );
  check(
    '必报：fmcg 模板混入现做菜 → 剔除',
    mixedFmcg.drafts.length === 0 &&
      mixedFmcg.dropped.length === 1 &&
      mixedFmcg.dropped[0].why.includes('品类不符'),
  );

  // 必报：饭类模板混入快消单品（反向也要堵，将来开双档才不会串）
  const mixedMeal = validateTemplateDraft(
    { ...input, kind: 'meal' },
    {
      drafts: [
        {
          name: '混入快消品',
          kind: 'meal',
          items: [
            { itemId: 101, slot: 1 },
            { itemId: 102, slot: 2 },
            { itemId: 103, slot: 3 },
            { itemId: 201, slot: 4 },
          ],
        },
      ],
    },
  );
  check('必报：meal 模板混入快消单品 → 剔除', mixedMeal.drafts.length === 0);

  // 必不报：纯快消多件组合仍放行（别把判据做成恒红）
  const pureFmcg = validateTemplateDraft(
    { ...input, kind: 'fmcg' },
    {
      drafts: [
        {
          name: '纯快消组合',
          kind: 'fmcg',
          items: [
            { itemId: 201, slot: 1 },
            { itemId: 202, slot: 2 },
            { itemId: 203, slot: 5 },
          ],
        },
      ],
    },
  );
  check('必不报：纯快消 3 件（含 slot=5）放行', pureFmcg.drafts.length === 1);

  // stub 路径也不许再取到红烧肉（线上 PROVIDER_MODE=mock 实测曾按 id 取到现做菜）
  const stubFmcg = stubDraft({ ...input, kind: 'fmcg' });
  check(
    '必不报：fmcg stub 只取快消单品，不含现做菜',
    stubFmcg.drafts.length === 1 && stubFmcg.drafts[0].items.every((it) => it.itemId >= 200),
  );

  // 提示词候选库同样隔离：不给 LLM 看见另一品类的 id
  const sysFmcg = buildSystemPrompt({ ...input, kind: 'fmcg' });
  check(
    '提示词：fmcg 候选库不含现做菜、含快消单品',
    sysFmcg.includes('id=201') && !sysFmcg.includes('id=101') && !sysFmcg.includes('红烧牛肉'),
  );

  process.stdout.write(`\n--selftest: ${passed} passed, ${failed} failed --\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, message: '套餐模板草稿生成异常', drafts: [] }));
  process.stderr.write(`gen-meal-template 异常：${e?.stack || e}\n`);
});

#!/usr/bin/env node
/**
 * ABox 一盒 · 社群排期卡草稿生成（AI 编排节点 P · 安全版）
 * ------------------------------------------------------------------
 * 定位：把「靶楼分层 + 当期套餐/券种白名单」映射成结构化「社群排期卡」。
 *       **只产草稿、不写库、不调任何发消息接口、不发券、不加好友**。
 *       这是 P「接执行」的安全版：把原 gen-community-plan.mjs 的自由文本提案升级成
 *       可逐卡确认的结构化排期（一周 7 条）+ 分档话术（4 条）；运营挑卡后系统只吐
 *       「排期表 + 合规话术清单」，人拿清单去群里人工发、去券管理页人工发券。
 *
 * ⚠️ 与 gen-community-plan.mjs 并存、互不替代：那条链路是企微口语「社群运营排期」的
 *    自由文本提案（运营参谋），本脚本只服务于后台 P 安全版页的结构化出卡。
 *
 * 🚨 话术合规闸（本节点核心增量，祝总纪律：端内/文案禁第三方平台名/链接/口令）：
 *    AI 写的话术逐条过闸，命中即剔除该条 —— 三类必拦：
 *      ① 第三方平台名（含**快团团**——与 ABox 无任何业务关系，任何文案禁提）；
 *      ② 链接 / 短链 / 淘口令样式（导流到自研小程序之外）；
 *      ③ 既成事实话术（「已发券/已发群/已推送」——系统无权执行，只出建议）。
 *    服务端 common/utils/community-taskcard.ts 复核同源再拦一次。
 *
 * 入参：--plain-file <path>  内容为 JSON（靶楼白名单 + 套餐/券种白名单），见 readInput
 * 出参：排期卡 JSON 打印 stdout，并落盘 releases/community-taskcard/<ts>.json
 *
 * 四道校验（生成时刻快照，与服务端复核同源）：
 *   ① 套餐/券种白名单：templateId / couponId 必须来自输入（杜绝编造套餐名/金额）
 *   ② 靶楼档位白名单：targetTier 只能 amplify/steady/wake/silent
 *   ③ 话术合规：每条 pitch/text 过三类闸（平台名/链接口令/既成事实）
 *   ④ 一周排期不重日：day 周一~周日各一条
 *
 * 原则零保障（AI 可剥离）：--no-llm 用确定性 stub 走通全链路；LLM 失败/解析失败
 *   一律返回空卡 + 说明，绝不抛错中断调用方、绝不发任何消息。
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { callLLM, extractJson } from './lib/cloud-llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 第三方平台名（禁导流；快团团为第一铁律——与 ABox 无任何业务关系） */
export const BANNED_PLATFORM_WORDS = [
  '快团团', '淘宝', '天猫', '拼多多', '京东', '抖音', '快手', '小红书',
  '美团', '饿了么', '微店', '有赞', '视频号小店',
];
/** 既成事实话术（系统无权发券/发群/加好友，只能建议） */
export const BANNED_PITCH_WORDS = [
  '已发券', '已到账', '已发群', '已推送', '已发送', '已加入', '已下单成功', '已拉群',
  // 变体：「已经发券了」不含连续子串「已发券」，必须单列（实测 selftest 抓出的真缺陷）
  '已经发券', '已经到账', '已经发群', '已经推送', '已经发送', '已经加入', '已经拉群',
  '券已发', '已发到',
];
/** 链接 / 短链 / 口令样式：导流到自研小程序之外 */
const BANNED_LINK_RE = /(https?:\/\/|www\.|\.com\/|\.cn\/|点击[链连]接|复制.*(打开|粘贴)|口令|￥[^￥]{3,}￥|\$[^$]{3,}\$)/i;
/** 一周七天 */
const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
/** 四档话术 */
const TIERS = ['amplify', 'steady', 'wake', 'silent'];
/** 执行提示（红线口径，服务端强制覆盖） */
const EXEC_HINT =
  '系统未发任何群消息、未发券、未加好友。请拿本清单人工复制到群里；发券去后台券管理页，发群请在群里手动操作。';

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

function pickWritableDir() {
  const repoRoot = existsSync(join(__dirname, '..', 'scripts'))
    ? resolve(__dirname, '..')
    : process.cwd();
  const candidates = [
    join(repoRoot, 'releases', 'community-taskcard'),
    join(repoRoot, 'data', 'uploads', 'community-taskcard'),
    join(repoRoot, 'data', 'community-taskcard'),
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

/**
 * 读数据。约定 JSON 形状（由 community-taskcard.service 实时算出写入）：
 * {
 *   "generatedAt": "...",
 *   "targets": [{ "leaderId": 12, "buildingName": "量子大厦", "tier": "silent",
 *                 "monthOrders": 0, "totalOrders": 80, "silentDays": 21 }, ...],
 *   "templates": [{ "id": 3, "name": "周一能量盒", "priceFen": 2580 }],   // status=1
 *   "coupons": [{ "id": 5, "name": "唤醒券", "faceValueFen": 300, "thresholdFen": 2000 }],
 *   "totals": { "amplify": 3, "steady": 5, "wake": 2, "silent": 1, "newCount": 2 }
 * }
 */
function readInput(plainFile) {
  const raw = readFileSync(plainFile, 'utf8');
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('not object');
    return {
      generatedAt: String(data.generatedAt || ''),
      targets: Array.isArray(data.targets) ? data.targets : [],
      templates: Array.isArray(data.templates) ? data.templates : [],
      coupons: Array.isArray(data.coupons) ? data.coupons : [],
      totals: data.totals && typeof data.totals === 'object' ? data.totals : {},
      structured: true,
    };
  } catch {
    return { generatedAt: '', targets: [], templates: [], coupons: [], totals: {}, structured: false };
  }
}

function mapById(rows) {
  const m = new Map();
  for (const r of rows) {
    const id = Number(r?.id);
    if (Number.isFinite(id)) m.set(id, r);
  }
  return m;
}

/** 话术合规闸：返回命中的禁用项描述，null = 通过。三类必拦。 */
export function screenPitch(text) {
  const s = String(text || '');
  const platform = BANNED_PLATFORM_WORDS.find((w) => s.includes(w));
  if (platform) return `第三方平台名「${platform}」`;
  const fact = BANNED_PITCH_WORDS.find((w) => s.includes(w));
  if (fact) return `既成事实话术「${fact}」（系统无权执行）`;
  if (BANNED_LINK_RE.test(s)) return '链接/短链/口令样式';
  return null;
}

function yuan(fen) {
  return `¥${((Number(fen) || 0) / 100).toFixed(2)}`;
}

/** 只读数据拼文案（AI 不得改写价格/面额），供清单展示，标注测算示例 */
function fmtOffer(template, coupon) {
  const parts = [];
  if (template) parts.push(`${template.name || '未命名套餐'} ${yuan(template.priceFen)}`);
  if (coupon) parts.push(`${coupon.name || '券'} 面额${yuan(coupon.faceValueFen)}`);
  return parts.length ? parts.join(' · ') : '（不指定套餐/券）';
}

/**
 * 核心护栏：把 LLM 原始草稿逐条校验，只放行「四真」条目。
 * 纯函数，便于单测与 --selftest 自证。返回 { schedule, pitches, rejected, notes }。
 */
export function validateCommunityCards(input, rawDraft) {
  const templates = mapById(input.templates);
  const coupons = mapById(input.coupons);
  const targets = input.targets || [];
  const schedule = [];
  const pitches = [];
  const rejected = [];
  const notes = [];

  const rawSchedule = Array.isArray(rawDraft?.schedule) ? rawDraft.schedule : [];
  const rawPitches = Array.isArray(rawDraft?.pitches) ? rawDraft.pitches : [];
  if (rawSchedule.length === 0) notes.push('AI 未产出一周排期（数据可能不足）。');
  if (rawPitches.length === 0) notes.push('AI 未产出分档话术（数据可能不足）。');

  // ── 排期卡：7 条，日不重复，套餐/券白名单，话术合规 ──
  const seenDays = new Set();
  for (const c of rawSchedule) {
    const day = String(c?.day || '');
    if (!DAYS.includes(day)) {
      rejected.push({ type: 'schedule', why: `非法排期日 day=${c?.day}` });
      continue;
    }
    if (seenDays.has(day)) {
      rejected.push({ type: 'schedule', why: `重复排期日 ${day}（一周各一条）` });
      continue;
    }
    const tier = String(c?.targetTier || '');
    if (!TIERS.includes(tier)) {
      rejected.push({ type: 'schedule', why: `${day} 非法靶楼档位 targetTier=${c?.targetTier}` });
      continue;
    }
    const templateId = c?.templateId == null ? null : Number(c.templateId);
    const couponId = c?.couponId == null ? null : Number(c.couponId);
    const template = templateId == null ? null : templates.get(templateId);
    const coupon = couponId == null ? null : coupons.get(couponId);
    if (templateId != null && !template) {
      rejected.push({ type: 'schedule', why: `${day} 编造/停用套餐 templateId=${c.templateId}` });
      continue;
    }
    if (couponId != null && !coupon) {
      rejected.push({ type: 'schedule', why: `${day} 编造/停用券 couponId=${c.couponId}` });
      continue;
    }
    const pitch = String(c?.pitch || '').trim();
    if (!pitch) {
      rejected.push({ type: 'schedule', why: `${day} 话术为空` });
      continue;
    }
    const hit = screenPitch(pitch);
    if (hit) {
      rejected.push({ type: 'schedule', why: `${day} 话术违规：${hit}` });
      continue;
    }
    seenDays.add(day);
    schedule.push({
      day,
      targetTier: tier,
      templateId: templateId ?? null,
      templateName: template ? String(template.name || '未命名') : null,
      couponId: couponId ?? null,
      couponName: coupon ? String(coupon.name || '券') : null,
      // 价格/面额由白名单覆盖，AI 写不动；标注测算示例
      offer: fmtOffer(template, coupon),
      pitch,
      note: String(c?.note || '').slice(0, 120),
      executeHint: EXEC_HINT,
    });
  }
  schedule.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day));

  // ── 分档话术：4 条，档位合法，话术合规 ──
  const seenTiers = new Set();
  for (const c of rawPitches) {
    const tier = String(c?.tier || '');
    if (!TIERS.includes(tier)) {
      rejected.push({ type: 'pitch', why: `非法话术档位 tier=${c?.tier}` });
      continue;
    }
    if (seenTiers.has(tier)) {
      rejected.push({ type: 'pitch', why: `重复话术档位 ${tier}` });
      continue;
    }
    const text = String(c?.text || '').trim();
    if (!text) {
      rejected.push({ type: 'pitch', why: `${tier} 话术为空` });
      continue;
    }
    const hit = screenPitch(text);
    if (hit) {
      rejected.push({ type: 'pitch', why: `${tier} 话术违规：${hit}` });
      continue;
    }
    seenTiers.add(tier);
    pitches.push({ tier, text, executeHint: EXEC_HINT });
  }
  pitches.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));

  if (targets.length === 0) notes.push('当前没有可排靶楼（名册为空或全为新团长），排期仅供参考。');
  if (Array.isArray(rawDraft?.notes)) {
    for (const n of rawDraft.notes) if (n) notes.push(String(n));
  }

  return { schedule, pitches, rejected, notes };
}

function buildSystemPrompt(input) {
  const t = input.totals || {};
  const targetLines = input.targets
    .slice(0, 20)
    .map(
      (x) =>
        `- 团长#${Number(x.leaderId)} 楼=${x.buildingName || '?'} 档=${x.tier || '?'} ` +
        `本月单=${x.monthOrders ?? 0} 累计单=${x.totalOrders ?? 0} 沉默=${x.silentDays ?? '无出单'}`,
    )
    .join('\n');
  const templateLines = input.templates
    .map((x) => `- #${Number(x.id)} ${x.name || '未命名'} ${yuan(x.priceFen)}`)
    .join('\n');
  const couponLines = input.coupons
    .map((x) => `- #${Number(x.id)} ${x.name || '券'} 面额${yuan(x.faceValueFen)} 门槛${yuan(x.thresholdFen)}`)
    .join('\n');
  return `你是「ABox 一盒」的社群运营编排助理，把分层数据写成「社群排期卡草稿」（供人工逐卡确认，绝不自动发群、发券、加好友）。

【靶楼白名单】（只能引用这里的楼，禁止编造）
${targetLines || '（空）'}

【当期套餐白名单】（templateId 只能从这里选，禁止编 id 或价格）
${templateLines || '（空）'}

【现有券种白名单】（couponId 只能从这里选）
${couponLines || '（空）'}

【四档分布】放量 ${t.amplify ?? '?'} / 维持 ${t.steady ?? '?'} / 唤醒 ${t.wake ?? '?'} / 沉默 ${t.silent ?? '?'} 栋 · 新上任 ${t.newCount ?? '?'} 人

硬性规则（违反即被系统剔除）：
1. schedule 输出 7 条，day 严格取「周一~周日」各一条、不重复；每条给 targetTier（amplify/steady/wake/silent 四档之一）、pitch（一条可直接粘贴的群话术）、可选 templateId/couponId（从上面白名单取，不写就填 null）、可选 note；
2. pitches 输出 4 条分档话术，tier 取四档各一条、不重复，每条给 text；
3. 【话术合规铁律】任何 pitch/text 严禁出现：① 第三方平台名（尤其「快团团」，与 ABox 无任何关系，绝对禁提；淘宝/拼多多/京东/抖音/美团等也一律禁）② 链接、短链、口令样式 ③ 既成事实话术（已发券/已发群/已推送/已到账等——系统无权执行）。违规条目会被整条剔除；
4. 不要写价格/面额数字（系统用白名单覆盖，你写了也没用），话术里用「本期套餐」「专属券」等中性说法；
5. 话术口语、简短、不说教，不暴露团长姓名/手机号；数据不足别硬编，宁可少出；
6. 只输出 JSON，不要任何解释文字、不要 markdown 围栏、不要 emoji。

输出 JSON（严格此结构）：
{"schedule":[{"day":"周一","targetTier":"silence→用四档之一","templateId":null,"couponId":null,"pitch":"...","note":"..."}],"pitches":[{"tier":"wake","text":"..."}],"notes":["……"]}`;
}

function buildUserPrompt() {
  return '请按一周 7 条排期 + 4 条分档话术输出严格 JSON，id 只从白名单取，话术过合规铁律。';
}

/** --no-llm 确定性 stub：按白名单事实派卡，跑通链路用（不发任何消息） */
function stubDraft(input) {
  const tpl = input.templates[0];
  const cpn = input.coupons[0];
  const schedule = DAYS.map((day, i) => ({
    day,
    targetTier: TIERS[i % TIERS.length],
    templateId: tpl ? Number(tpl.id) : null,
    couponId: i % 3 === 0 && cpn ? Number(cpn.id) : null,
    pitch: `stub：${day}本期套餐到店，需要的邻居留言，我们统一送到工位。`,
    note: 'stub 排期，仅跑通链路',
  }));
  const pitches = TIERS.map((tier) => ({
    tier,
    text: `stub：${tier} 档邻居，本期有好套餐，留言即可，我们送到工位。`,
  }));
  return { schedule, pitches, notes: [] };
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
    const msg = '社群排期卡输入不是有效 JSON（缺靶楼/套餐白名单），已跳过生成。';
    process.stdout.write(JSON.stringify({ ok: false, message: msg, schedule: [], pitches: [] }));
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
        user: buildUserPrompt(),
        timeoutMs: 20000,
        temperature: 0.5,
      });
      rawDraft = extractJson(text);
    } catch (e) {
      process.stderr.write(`LLM/解析失败：${e?.message || e}\n`);
      rawDraft = { schedule: [], pitches: [], notes: ['LLM 输出无法解析，已转人工'] };
    }
  }

  const result = validateCommunityCards(input, rawDraft);
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

/** 自证：三类话术违规逐词 + 白名单/档位/重日 + 必不报样本 */
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
    targets: [
      { leaderId: 12, buildingName: '量子大厦', tier: 'silent', monthOrders: 0, totalOrders: 80, silentDays: 21 },
      { leaderId: 7, buildingName: '望京 SOHO', tier: 'amplify', monthOrders: 42, totalOrders: 120, silentDays: 2 },
    ],
    templates: [{ id: 3, name: '周一能量盒', priceFen: 2580 }],
    coupons: [{ id: 5, name: '唤醒券', faceValueFen: 300, thresholdFen: 2000 }],
    totals: { amplify: 1, steady: 0, wake: 0, silent: 1, newCount: 0 },
  };

  // 必不报：7 条合法排期 + 4 条合法话术全放行
  const good = {
    schedule: DAYS.map((day, i) => ({
      day,
      targetTier: TIERS[i % 4],
      templateId: 3,
      couponId: i === 0 ? 5 : null,
      pitch: `本期${day}套餐到店，留言即送工位，欢迎邻居。`,
    })),
    pitches: TIERS.map((tier) => ({ tier, text: `${tier} 档邻居，本期套餐不错，留言订餐。` })),
  };
  const ok = validateCommunityCards(input, good);
  check('必不报：7 排期 + 4 话术全放行', ok.schedule.length === 7 && ok.pitches.length === 4 && ok.rejected.length === 0);

  // 判据自证：白名单真的非空（防恒空导致"全剔除"假绿）
  check('判据自证：套餐/券白名单非空', mapById(input.templates).has(3) && mapById(input.coupons).has(5));

  // 价格/面额由白名单覆盖（AI 写 9999 无效）
  check('必报：价格/面额取白名单不被改写', ok.schedule.every((s) => s.offer.includes('¥25.80')) && ok.schedule[0].offer.includes('¥3.00'));

  // 执行提示必带红线口径
  check(
    '必报：每条带「未发消息/未发券」提示',
    [...ok.schedule, ...ok.pitches].every((c) => c.executeHint.includes('未发任何群消息') && c.executeHint.includes('未发券')),
  );

  // 必报：编造套餐 + 编造券 + 非法档位 + 空话术 全剔除（不含重日：重日须由两张都合法的卡单独测）
  const bad = validateCommunityCards(input, {
    schedule: [
      { day: '周一', targetTier: 'silent', templateId: 999, pitch: '合法话术' },
      { day: '周二', targetTier: 'silent', couponId: 888, pitch: '合法话术' },
      { day: '周三', targetTier: 'bogus', pitch: '合法话术' },
      { day: '周四', targetTier: 'silent', pitch: '' },
    ],
    pitches: [{ tier: 'nope', text: '非法档位' }],
  });
  check('必报：5 张违规卡全剔除', bad.schedule.length === 0 && bad.pitches.length === 0 && bad.rejected.length === 5);

  // 必报：重复日只排第一张（两张都合法，第二张须被去重拦下）
  const dupDay = validateCommunityCards(input, {
    schedule: [
      { day: '周一', targetTier: 'silent', pitch: '首张合法' },
      { day: '周一', targetTier: 'wake', pitch: '重复日' },
    ],
    pitches: [],
  });
  check('必报：同一天只排第一张，重复日被拦', dupDay.schedule.length === 1 && dupDay.rejected.length === 1);

  // 三类话术违规逐词验证（防词表写错导致恒绿）
  const pitchBad = [
    '快团团上订更便宜', '去淘宝下单', '点此链接 https://x.cn/a', '复制口令 ￥abc123￥',
    '已经发券了', '群已推送', '已到账',
  ];
  check(
    '判据自证：三类话术违规逐条可拦',
    pitchBad.every((p) => screenPitch(p) !== null),
  );
  check(
    '判据自证：合规话术不被误拦',
    ['本期套餐到店，留言订餐', '专属券已备好，需要的邻居说一声', '送到工位，欢迎下单'].every((p) => screenPitch(p) === null),
  );

  // 话术违规落到卡片层：含平台名的排期整条剔除
  const plat = validateCommunityCards(input, {
    schedule: [{ day: '周一', targetTier: 'silent', pitch: '去快团团下单' }],
    pitches: [],
  });
  check('必报：话术违规卡整条剔除', plat.schedule.length === 0 && plat.rejected.length === 1);

  // stub 路径也合规
  const stub = stubDraft(input);
  const stubValid = validateCommunityCards(input, stub);
  check('必不报：stub 产出的卡全部合法', stubValid.schedule.length === 7 && stubValid.pitches.length === 4);

  // 空白白名单不产卡（防"没有白名单也出卡"）
  const empty = validateCommunityCards({ ...input, templates: [], coupons: [], targets: [] }, {
    schedule: [{ day: '周一', targetTier: 'silent', templateId: 3, pitch: '无白名单也应拦' }],
    pitches: [],
  });
  check('必报：空白白名单时排期被拦', empty.schedule.length === 0 && empty.rejected.length === 1);

  process.stdout.write(`\n--selftest: ${passed} passed, ${failed} failed --\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, message: '社群排期卡生成异常', schedule: [], pitches: [] }));
  process.stderr.write(`gen-community-taskcard 异常：${e?.stack || e}\n`);
});

#!/usr/bin/env node
/**
 * ABox 一盒 · 文案与素材生成（AI 编排节点 B）
 * ------------------------------------------------------------------
 * 作用：根据一份 brief（活动/新团/新商品），用 LLM 起草品牌一致的中文文案，并渲染成
 *   ① copy.md（招募文案 / 卖点 / 朋友圈话术 / 社群话术 / 合规脚注）
 *   ② poster.html（米色 #F6F0E5 + 暖棕 #6E5435 + 楷体 的品牌招募页，结构对齐小程序 recruit.vue）
 *   ③ poster.svg（同款信息的移动端海报）
 * 输出落在 releases/campaign/<slug>/ 下。
 *
 * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
 *   - 本脚本是「独立新增文件」，不修改任何核心代码、不自动发布；
 *   - LLM 起草的只是「草稿」，须经人工确认后才上线（脚本本身不触碰发布链路）；
 *   - LLM 不可用 / 超时 / 异常 / 返回非 JSON → 降级为「占位模板」（结构齐全、文案留空待填），
 *     传统手工写文案/做图路径完全不受影响；
 *   - 品牌规范硬编码进渲染层（颜色/字体/结构/中性词），即使 LLM 宕机，产出入眼仍合规。
 *
 * 用法：
 *   node scripts/gen-campaign.mjs [--brief "<一句话需求>"] [--brief-file <json>] [--slug <名>] [--out <dir>] [--no-llm]
 *
 * brief JSON 字段（均可选，缺省走内置示例 brief）：
 *   { "theme":"本周新团", "goal":"招募团长", "audience":"写字楼同事", "products":"本日精选组合",
 *     "tone":"温暖克制", "date":"2026-11-09", "platform":"企微+朋友圈" }
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLLM, extractJson } from './lib/cloud-llm.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TS = new Date().toISOString().slice(0, 10);

// ---- 参数 ----
const argv = process.argv.slice(2);
let briefText = null;
let briefFile = null;
let slug = null;
let outRoot = resolve(ROOT, 'releases', 'campaign');
let noLlm = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--brief') briefText = argv[++i] || null;
  else if (argv[i] === '--brief-file') briefFile = argv[++i] || null;
  else if (argv[i] === '--slug') slug = argv[++i] || null;
  else if (argv[i] === '--out') outRoot = resolve(argv[++i] || outRoot);
  else if (argv[i] === '--no-llm') noLlm = true;
}

// ---- 解析 brief ----
const DEFAULT_BRIEF = {
  theme: '本周新团招募',
  goal: '招募一栋楼的团长',
  audience: '写字楼里热心、人缘好的同事',
  products: 'ABox 一盒本日精选组合（预包装快消品路线）',
  tone: '温暖、克制、不喊',
  date: TS,
  platform: '企业微信 + 朋友圈',
};
function parseBrief() {
  if (briefFile && existsSync(briefFile)) {
    try {
      const j = JSON.parse(readFileSync(briefFile, 'utf8'));
      return { ok: true, brief: { ...DEFAULT_BRIEF, ...j } };
    } catch (e) {
      return { ok: false, reason: `brief 文件解析失败：${e?.message || e}`, brief: DEFAULT_BRIEF };
    }
  }
  if (briefText) {
    return { ok: true, brief: { ...DEFAULT_BRIEF, theme: briefText } };
  }
  return { ok: true, reason: '未提供 brief，使用内置示例', brief: DEFAULT_BRIEF };
}
const briefRes = parseBrief();
const brief = briefRes.brief;

// ---- 品牌规范（硬编码进渲染层，确保降级也合规）----
const BRAND = {
  bg: '#F6F0E5',
  ink: '#6E5435',
  inkDeep: '#5A4327',
  card: '#FBF7EF',
  line: '#D8CBB4',
  font: '"KaiTi","STKaiti","楷体","SimSun",serif',
};
const BRAND_RUBRIC = `ABox 一盒 品牌与文案规范（草稿必须遵守，否则视为不合格）：
- 配色：背景米色 #F6F0E5，主文字/强调暖棕 #6E5435；卡片底 #FBF7EF，分隔线 #D8CBB4。
- 字体：楷体（KaiTi/STKaiti/楷体/SimSun）。高端极简，字号层级精简。
- 结构（对齐小程序招募页 recruit.vue）：安静页眉（不喊口号）→ 三张浮起卡（钱 / 事 / 人）→ 双 CTA（语义互斥）→ 推荐券说明 → 合规脚注。
- 文案铁律：① 收益一律中性语（"每单按售价提 X%"），量级按个人顺手算（每月好几百）；禁"躺赚/零花钱/躺平收入"等夸张收益词；
  ② 交付口径=轻（转发链接/顺手带回来），禁"逐层爬楼/苦力活"；
  ③ CTA 一屏一义："申请成为团长"整页只出现一次，另一枚为"介绍给合适的同事"（语义互斥）；
  ④ 介绍奖励=单层代金券（5 元代金券），非分销抽成；
  ⑤ 金额须标"测算示例"，不承诺保底；
  ⑥ 一栋楼可有多位团长，文案不得暗示唯一。
- 去餐饮化（关键）：ABox 走预包装快消品路线，禁"饭菜/外卖/餐饮/好吃/菜品/口味"等词；用"组合/精选/商品/本日精选/满意度"等中性词。`;

const SYSTEM_PROMPT = `你是 ABox 一盒（微信小程序盒饭团购，现已转为预包装快消品路线）的品牌文案与运营策划。
下面给你一份 brief 与品牌规范。请基于它们起草一套「团长招募」落地文案，并**只输出一个 JSON 对象**（不要任何解释、不要 Markdown 围栏外的废话）：
{
  "eyebrow": "页眉小字，如 ABox 一盒 · 团长招募",
  "titleMain": "主标题前半，如 好事做了，顺手带了",
  "titleEm": "主标题强调，如 钱也赚了",
  "meta": "页眉副信息，如 每天一次 · 不用费事 · 大家都省心",
  "cards": [
    {"no":"01","title":"钱，明明白白","items":["每单按售价提 8%–12%（测算示例）","次日入账，能抵消费，也能提现","每月好几百，饭钱就有了"]},
    {"no":"02","title":"事，不添麻烦","items":["下班以后，转发个链接","同事点开，就进你的团","午休时间，顺手带回来"]},
    {"no":"03","title":"人，记你的好","items":["热心肠，有了名分","你的单，同事乐意跟","好人缘，一次次的加深"]}
  ],
  "ctaPrimary": "申请成为团长",
  "ctaGhost": "介绍给合适的同事",
  "ctaNote": "自己暂时不当也行——介绍他成为团长，你领 5 元代金券",
  "footer": "申请即代表同意《团长协议》。佣金按售价按单计提；介绍奖励为单层代金券，非分销抽成。",
  "wechatMoments": "朋友圈文案（≤ 3 行，温暖克制，含一次 CTA 引导）",
  "community": "社群推送文案（≤ 5 行，可读、不刷屏）"
}
要求：
- 三张卡片的 items 每条一句话、口语、不喊；数字/收益按中性语+测算示例；
- 严格遵循品牌规范与去餐饮化铁律，不得出现餐饮词与夸张收益词；
- 双 CTA 语义互斥，整页"申请成为团长"只出现一次；
- wechatMoments / community 自然、不硬广。`;

// ---- 渲染层（纯函数，降级也能产出合规占位）----
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderCopy(data, usedLlm) {
  const L = [];
  L.push(`# ABox 一盒 · 文案草稿（节点 B 产出）`);
  L.push('');
  L.push(`> 生成时间：${TS} ｜ brief：${brief.theme} ｜ 由 \`scripts/gen-campaign.mjs\` 产出`);
  L.push(
    `> ${usedLlm ? 'AI 已起草，仍需**人工终审**后使用（原则四/原则零）。' : '⚠️ LLM 未参与（降级占位），请人工补全文案。'}`,
  );
  L.push('');
  L.push(`## 一、招募页文案`);
  L.push('');
  L.push(`- 页眉：${data.eyebrow}`);
  L.push(`- 主标题：${data.titleMain} **${data.titleEm}**`);
  L.push(`- 副信息：${data.meta}`);
  L.push('');
  for (const c of data.cards) {
    L.push(`### 卡片 ${c.no} · ${c.title}`);
    for (const it of c.items) L.push(`- ${it}`);
    L.push('');
  }
  L.push(`## 二、CTA 与脚注`);
  L.push(`- 主按钮：${data.ctaPrimary}`);
  L.push(`- 次按钮：${data.ctaGhost}`);
  L.push(`- 推荐说明：${data.ctaNote}`);
  L.push(`- 合规脚注：${data.footer}`);
  L.push('');
  L.push(`## 三、朋友圈话术`);
  L.push('');
  L.push(data.wechatMoments || '（待填）');
  L.push('');
  L.push(`## 四、社群话术`);
  L.push('');
  L.push(data.community || '（待填）');
  L.push('');
  L.push(`---`);
  L.push(`ABox 一盒 · 文案草稿（auto-generated by gen-campaign.mjs）· ${TS}`);
  return L.join('\n');
}

function renderHtml(data) {
  const cards = data.cards
    .map(
      (c) => `
    <section class="card">
      <div class="card__hd"><span class="card__no">${esc(c.no)}</span><span class="card__t">${esc(c.title)}</span></div>
      <div class="card__rule"></div>
      <ul class="card__list">${c.items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>
    </section>`,
    )
    .join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ABox 一盒 · ${esc(data.eyebrow)}</title>
<style>
  :root{ --bg:${BRAND.bg}; --ink:${BRAND.ink}; --ink-deep:${BRAND.inkDeep}; --card:${BRAND.card}; --line:${BRAND.line}; }
  *{box-sizing:border-box;}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:${BRAND.font};line-height:1.7;-webkit-font-smoothing:antialiased;}
  .page{max-width:480px;margin:0 auto;padding:0 20px 160px;min-height:100vh;}
  .head{padding:64px 8px 12px;text-align:center;}
  .head__eyebrow{font-size:13px;letter-spacing:6px;color:var(--ink);opacity:.7;}
  .head__title{margin-top:24px;font-size:30px;font-weight:bold;letter-spacing:3px;line-height:1.5;}
  .head__em{display:block;margin-top:8px;color:var(--ink-deep);}
  .head__line{margin:22px auto 0;width:64px;height:3px;background:var(--ink);border-radius:3px;}
  .head__meta{display:block;margin-top:22px;font-size:14px;letter-spacing:3px;opacity:.6;}
  .cards{margin-top:32px;display:flex;flex-direction:column;gap:20px;}
  .card{padding:28px 26px 24px;background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:0 6px 22px rgba(110,84,53,.08);}
  .card__hd{display:flex;align-items:baseline;gap:14px;}
  .card__no{font-size:18px;font-weight:bold;letter-spacing:2px;opacity:.7;}
  .card__t{font-size:20px;font-weight:bold;letter-spacing:3px;}
  .card__rule{margin-top:18px;height:1px;background:var(--line);}
  .card__list{margin:18px 0 0;padding-left:18px;}
  .card__list li{margin:8px 0;font-size:15px;}
  .cta{margin-top:36px;}
  .cta__btn{display:block;width:100%;height:56px;line-height:56px;text-align:center;font-size:16px;font-weight:bold;letter-spacing:3px;color:var(--card);background:var(--ink);border:none;border-radius:28px;box-shadow:0 6px 22px rgba(110,84,53,.12);}
  .cta__btn--ghost{margin-top:14px;color:var(--ink);background:transparent;border:1px solid var(--ink);box-shadow:none;}
  .cta__note{display:block;margin-top:16px;text-align:center;font-size:13px;line-height:1.8;opacity:.7;}
  .foot{margin-top:32px;padding:0 8px;}
  .foot__text{font-size:13px;line-height:1.8;opacity:.6;}
</style>
</head>
<body>
<div class="page">
  <header class="head">
    <div class="head__eyebrow">${esc(data.eyebrow)}</div>
    <div class="head__title">${esc(data.titleMain)}<span class="head__em">${esc(data.titleEm)}</span></div>
    <div class="head__line"></div>
    <span class="head__meta">${esc(data.meta)}</span>
  </header>
  <div class="cards">${cards}</div>
  <div class="cta">
    <div class="cta__btn">${esc(data.ctaPrimary)}</div>
    <div class="cta__btn cta__btn--ghost">${esc(data.ctaGhost)}</div>
    <span class="cta__note">${esc(data.ctaNote)}</span>
  </div>
  <footer class="foot"><p class="foot__text">${esc(data.footer)}</p></footer>
</div>
</body>
</html>`;
}

function renderSvg(data) {
  const W = 750;
  const H = 1334;
  const cardY = [360, 620, 880];
  const itemsText = (items, y0) =>
    items
      .map(
        (it, i) =>
          `<text x="90" y="${y0 + 60 + i * 46}" font-size="26" fill="#6E5435" opacity="0.78">· ${esc(it)}</text>`,
      )
      .join('');
  const cards = data.cards
    .map(
      (c, i) => `
    <rect x="60" y="${cardY[i]}" width="630" height="${120 + c.items.length * 46}" rx="20" fill="#FBF7EF" stroke="#D8CBB4"/>
    <text x="90" y="${cardY[i] + 56}" font-size="30" font-weight="bold" fill="#6E5435">${esc(c.no)} ${esc(c.title)}</text>
    ${itemsText(c.items, cardY[i] + 70)}`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#F6F0E5"/>
  <text x="375" y="140" text-anchor="middle" font-size="24" letter-spacing="6" fill="#6E5435" opacity="0.7" font-family="KaiTi,STKaiti,楷体,SimSun,serif">${esc(data.eyebrow)}</text>
  <text x="375" y="220" text-anchor="middle" font-size="46" font-weight="bold" fill="#6E5435" font-family="KaiTi,STKaiti,楷体,SimSun,serif">${esc(data.titleMain)}</text>
  <text x="375" y="280" text-anchor="middle" font-size="46" font-weight="bold" fill="#5A4327" font-family="KaiTi,STKaiti,楷体,SimSun,serif">${esc(data.titleEm)}</text>
  <rect x="335" y="310" width="80" height="4" rx="2" fill="#6E5435"/>
  ${cards}
  <rect x="120" y="1230" width="510" height="64" rx="32" fill="#6E5435"/>
  <text x="375" y="1272" text-anchor="middle" font-size="28" font-weight="bold" fill="#FBF7EF" font-family="KaiTi,STKaiti,楷体,SimSun,serif">${esc(data.ctaPrimary)}</text>
</svg>`;
}

// ---- 执行 ----
const PLACEHOLDER = {
  eyebrow: 'ABox 一盒 · 团长招募',
  titleMain: '好事做了，顺手带了',
  titleEm: '钱也赚了',
  meta: '每天一次 · 不用费事 · 大家都省心',
  cards: [
    {
      no: '01',
      title: '钱，明明白白',
      items: [
        '（待填：每单按售价提 X% · 测算示例）',
        '（待填：次日入账，能抵消费也能提现）',
        '（待填：每月好几百，饭钱就有了）',
      ],
    },
    {
      no: '02',
      title: '事，不添麻烦',
      items: [
        '（待填：下班以后，转发个链接）',
        '（待填：同事点开，就进你的团）',
        '（待填：午休时间，顺手带回来）',
      ],
    },
    {
      no: '03',
      title: '人，记你的好',
      items: [
        '（待填：热心肠，有了名分）',
        '（待填：你的单，同事乐意跟）',
        '（待填：好人缘，一次次的加深）',
      ],
    },
  ],
  ctaPrimary: '申请成为团长',
  ctaGhost: '介绍给合适的同事',
  ctaNote: '自己暂时不当也行——介绍他成为团长，你领 5 元代金券',
  footer: '申请即代表同意《团长协议》。佣金按售价按单计提；介绍奖励为单层代金券，非分销抽成。',
  wechatMoments: '（待填：朋友圈文案）',
  community: '（待填：社群文案）',
};

let data = PLACEHOLDER;
let usedLlm = false;
let llmError = '';

if (!noLlm) {
  try {
    const userPrompt = `brief：${JSON.stringify(brief, null, 2)}\n\n品牌规范：\n${BRAND_RUBRIC}\n\n请按系统指令输出 JSON。`;
    const answer = await callLLM({
      system: SYSTEM_PROMPT,
      user: userPrompt,
      timeoutMs: 20000,
      temperature: 0.5,
    });
    const parsed = extractJson(answer);
    // 兜底字段
    data = {
      ...PLACEHOLDER,
      ...parsed,
      cards:
        Array.isArray(parsed.cards) && parsed.cards.length === 3 ? parsed.cards : PLACEHOLDER.cards,
    };
    usedLlm = true;
  } catch (e) {
    llmError = String(e?.message || e);
    // 降级：保留占位，确保结构合规
  }
}

const finalSlug =
  slug || (brief.theme ? brief.theme.replace(/[^\w一-龥-]+/g, '_').slice(0, 24) : 'demo') || 'demo';
const outDir = resolve(outRoot, finalSlug);
mkdirSync(outDir, { recursive: true });

const copy = renderCopy(data, usedLlm);
const html = renderHtml(data);
const svg = renderSvg(data);
writeFileSync(join(outDir, 'copy.md'), copy, 'utf8');
writeFileSync(join(outDir, 'poster.html'), html, 'utf8');
writeFileSync(join(outDir, 'poster.svg'), svg, 'utf8');

console.log('[gen-campaign] 已生成文案与素材：');
console.log('  ', outDir);
console.log('   - copy.md（招募文案 / 朋友圈 / 社群）');
console.log('   - poster.html（品牌招募页）');
console.log('   - poster.svg（移动端海报）');
console.log('  AI 参与：', usedLlm ? '是' : `否（降级占位：${llmError || 'no-llm'}）`);
if (!usedLlm)
  console.log('  ⚠️ 降级模式：结构合规、文案待人工补全；传统手工写文案/做图路径不受影响。');
else console.log('  ⚠️ AI 草稿，请人工终审后再用于发布（原则零：本脚本不自动发布）。');

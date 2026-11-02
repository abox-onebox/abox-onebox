#!/usr/bin/env node
/**
 * ABox 一盒 · 选品提案生成（AI 编排节点 F · 脚本侧）
 * ------------------------------------------------------------------
 * 由 wecom-chat.service.ts 的 `genMealProposal()` 调起：后端已用 proxy.query 取好
 * 近 30 天两视角（菜品热度/楼栋排行）+ 全量套餐目录（含菜品构成/被排次数/状态），
 * 格式化成「人话纯文本」，本脚本只负责「AI 选品提案 + 落盘 + 可选群推送」。
 *
 * 入参：--plain-file <path>  含已格式化的原始数据文本（utf8）
 * 出参：把「AI 选品提案」打印到 stdout（供后端作为企微回复回显给发令人）；
 *       同时落盘 releases/menu-proposal/<date>.md（多候选目录回退，保证可写）。
 *
 * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
 *   - 本脚本只做「提案 + 写文件 + 可选推送」，任何失败都打印降级文本（原始数据），
 *     绝不抛错中断、绝不阻塞调用方。
 *   - 推送为可选项：仅当配置 ABOX_MENU_WEBHOOK（企微群机器人）时才主动推群，
 *     未配置则只回显 + 落盘，退回「人看后台/看会话」的传统路径。
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { callLLM } from './lib/cloud-llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plain-file') out.plainFile = argv[++i];
  }
  return out;
}

/** 多候选可写目录（与 gen-campaign.mjs / gen-daily-report.mjs 同源逻辑） */
function pickWritableDir() {
  const repoRoot = existsSync(join(__dirname, '..', 'scripts')) ? resolve(__dirname, '..') : process.cwd();
  const candidates = [
    join(repoRoot, 'releases', 'menu-proposal'),
    join(repoRoot, 'data', 'uploads', 'menu-proposal'),
    join(repoRoot, 'data', 'menu-proposal'),
    join(tmpdir(), 'abox-menu-proposal'),
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

/** 北京日期 YYYY-MM-DD */
function bjYmd() {
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${bj.getFullYear()}-${p(bj.getMonth() + 1)}-${p(bj.getDate())}`;
}

const PROPOSAL_SYSTEM = `你是「ABox 一盒」的选品策略助理。下面三段数据：①近 30 天热销菜品（含份数与占比）；②近 30 天楼栋需求分布；③当前可选套餐目录（每个套餐的菜品构成、状态、被多少个分配引用过 usedCount）。
请产出一份《下周选品提案》（**草稿，供人工确认，绝不直接改库**）：
1. 热销信号（一句话，基于①）；
2. 需求分布要点（基于②，哪些楼是主力、有无明显集中）；
3. 套餐目录诊断：逐类点出——常驻锚点（被排次数高、且菜品含热销项，建议保留为常规轮换）、试水候选（停用/低被排但值得测试的）、观察项（0 被排且菜品不在热销榜，可考虑退役）；
4. 下周建议动作（具体：保留哪些锚点、试点哪一个、是否需补品类/新套餐）；
5. 风险/备注（如目录多样性不足、数据口径说明）。
规则：只基于给到的数据说话；数据缺失写「暂缺」，**绝不编造数字或套餐名**；不要使用 emoji；不超过 600 字；结尾必须写明「此为 AI 草稿，需人工确认后执行」。`;

function fallback(plain, reason) {
  const head = '（AI 提案暂不可用' + (reason ? `：${reason}` : '') + '，附原始数据）';
  return `${head}\n\n${plain}`;
}

async function main() {
  const { plainFile } = parseArgs(process.argv.slice(2));
  if (!plainFile || !existsSync(plainFile)) {
    process.stdout.write('选品提案生成失败：未收到数据文件。');
    return;
  }
  const plain = readFileSync(plainFile, 'utf8');
  // 读后即删临时文件（后端写的）
  try {
    unlinkSync(plainFile);
  } catch {
    /* noop */
  }

  const date = bjYmd();
  let proposal;
  try {
    proposal = await callLLM({
      system: PROPOSAL_SYSTEM,
      user: plain,
      timeoutMs: 9000,
      temperature: 0.3,
    });
    proposal = (proposal || '').trim();
    if (!proposal) proposal = null;
  } catch (e) {
    proposal = null;
    process.stderr.write(`LLM 提案失败：${e?.message || e}\n`);
  }

  const finalText = proposal
    ? `# ABox 一盒 · 选品提案（${date}）\n\n${proposal}\n\n---\n\n## 原始数据（近 30 天）\n\n${plain}`
    : fallback(plain, 'AI 未返回');

  // 落盘（多候选目录回退）
  const dir = pickWritableDir();
  try {
    writeFileSync(join(dir, `${date}.md`), finalText, 'utf8');
  } catch (e) {
    process.stderr.write(`落盘失败（不影响回复）：${e?.message || e}\n`);
  }

  // 可选：群机器人推送（仅当配置了 webhook）
  const webhook = process.env.ABOX_MENU_WEBHOOK;
  if (webhook && proposal) {
    try {
      const cap = proposal.length > 1800 ? proposal.slice(0, 1800) + '…' : proposal;
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content: cap } }),
      });
    } catch (e) {
      process.stderr.write(`群推送失败（不影响回复）：${e?.message || e}\n`);
    }
  }

  // 回显给发令人（企微文本消息 ≤2048 字节，截提案部分）
  const echo = proposal && proposal.length <= 1800 ? proposal : plain.slice(0, 1700);
  process.stdout.write(echo);
}

main().catch((e) => {
  process.stdout.write('选品提案生成出现异常，请稍后重试或看后台看板。');
  process.stderr.write(`gen-meal-proposal 异常：${e?.stack || e}\n`);
});

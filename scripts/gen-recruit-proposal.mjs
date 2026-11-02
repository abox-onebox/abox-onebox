#!/usr/bin/env node
/**
 * ABox 一盒 · 招募提案生成（AI 编排节点 G · 脚本侧）
 * ------------------------------------------------------------------
 * 由 wecom-chat.service.ts 的 `genRecruitProposal()` 调起：后端已用 proxy.query 取好
 * 近 30 天「有订单楼栋」与「在职团长覆盖楼」并算出招募缺口（差集），
 * 格式化成「人话纯文本」，本脚本只负责「AI 招募提案 + 落盘 + 可选群推送」。
 *
 * 入参：--plain-file <path>  含已格式化的原始缺口数据文本（utf8）
 * 出参：把「AI 招募提案」打印到 stdout（供后端作为企微回复回显给发令人）；
 *       同时落盘 releases/recruit-proposal/<date>.md（多候选目录回退，保证可写）。
 *
 * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
 *   - 本脚本只做「提案 + 写文件 + 可选推送」，任何失败都打印降级文本（原始数据），
 *     绝不抛错中断、绝不阻塞调用方。
 *   - 推送为可选项：仅当配置 ABOX_RECRUIT_WEBHOOK（企微群机器人）时才主动推群，
 *     未配置则只回显 + 落盘，退回「人看后台/看会话」的传统路径。
 *
 * ⚠️ 招募文案硬约束（与 ABox 全局口径一致，违反即退回传统运营）：
 *   - 收益中性语：禁「躺赚 / 零花钱 / 轻松赚钱 / 月入过万」等夸大表述；
 *   - 所有金额、收益一律标「测算示例」，并注明以实际订单与佣金率为准；
 *   - 一栋楼可有多位团长，话术不得暗示「独占」；
 *   - 英文名恒为 ABox（禁 ABOX / abox）；
 *   - 只基于给到的数据说话，数据缺失写「暂缺」，绝不编造数字或楼名。
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

/** 多候选可写目录（与 gen-campaign.mjs / gen-meal-proposal.mjs / gen-daily-report.mjs 同源逻辑） */
function pickWritableDir() {
  const repoRoot = existsSync(join(__dirname, '..', 'scripts'))
    ? resolve(__dirname, '..')
    : process.cwd();
  const candidates = [
    join(repoRoot, 'releases', 'recruit-proposal'),
    join(repoRoot, 'data', 'uploads', 'recruit-proposal'),
    join(repoRoot, 'data', 'recruit-proposal'),
    join(tmpdir(), 'abox-recruit-proposal'),
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

const PROPOSAL_SYSTEM = `你是「ABox 一盒」的团长招募策略助理。下面是一段已算好的「近 30 天楼栋销量与团长覆盖缺口」数据（含每栋 GMV、单量、是否有在职团长，以及汇总出的招募缺口清单）。

请产出一份《团长招募提案》（**草稿，供人工确认，绝不直接改库、绝不自动任命团长**）：
1. 招募优先级清单：基于缺口清单按 GMV 给优先序（前 3 名重点说明为什么优先拓）；
2. 每栋话术草稿：为该栋写一段可直接发给潜在团长的招募话术（数据驱动、接地气、可复制），要包含：
   - 该栋近 30 天的需求信号（GMV / 单量，用数据说话）；
   - 收益测算示例（明确标注「测算示例」，按订单份数 × 客单价 × 佣金率粗算，注明以实际订单与佣金率为准）；
   - 说明「一栋楼可有多位团长」，不暗示独占；
3. 新人团长赋能要点：怎么做（接单/分发/售后）、预期收益测算示例、以及合规与风险提示（食品交付、按实际成交结算、禁夸大收益）。

硬性规则（违反即不合格）：
- 收益中性语：禁「躺赚 / 零花钱 / 轻松赚钱 / 月入过万」等夸大表述；
- 所有金额、收益一律标「测算示例」，并说明以实际订单与佣金率为准；
- 一栋楼可有多位团长，话术不得暗示独占；
- 英文名恒为 ABox（禁 ABOX / abox）；
- 只基于给到的数据说话；数据缺失写「暂缺」，**绝不编造数字或楼名**；
- 不要使用 emoji；不超过 600 字；结尾必须写明「此为 AI 草稿，需人工确认后执行」。`;

function fallback(plain, reason) {
  const head = '（AI 提案暂不可用' + (reason ? `：${reason}` : '') + '，附原始数据）';
  return `${head}\n\n${plain}`;
}

async function main() {
  const { plainFile } = parseArgs(process.argv.slice(2));
  if (!plainFile || !existsSync(plainFile)) {
    process.stdout.write('招募提案生成失败：未收到数据文件。');
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
    ? `# ABox 一盒 · 团长招募提案（${date}）\n\n${proposal}\n\n---\n\n## 原始缺口数据（近 30 天）\n\n${plain}`
    : fallback(plain, 'AI 未返回');

  // 落盘（多候选目录回退）
  const dir = pickWritableDir();
  try {
    writeFileSync(join(dir, `${date}.md`), finalText, 'utf8');
  } catch (e) {
    process.stderr.write(`落盘失败（不影响回复）：${e?.message || e}\n`);
  }

  // 可选：群机器人推送（仅当配置了 webhook）
  const webhook = process.env.ABOX_RECRUIT_WEBHOOK;
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
  process.stdout.write('招募提案生成出现异常，请稍后重试或看后台看板。');
  process.stderr.write(`gen-recruit-proposal 异常：${e?.stack || e}\n`);
});

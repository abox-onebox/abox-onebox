#!/usr/bin/env node
/**
 * ABox 一盒 · A/B 增长实验设计生成（AI 编排节点 J · 脚本侧）
 * ------------------------------------------------------------------
 * 由 wecom-chat.service.ts 的 `genGrowthExperiment()` 调起：后端已用 proxy.query 取好
 * 近 30 天「整体经营基线 + 楼栋表现与差异 + 套餐模板人气 + 现有券种 + 可测杠杆」，
 * 格式化成「人话纯文本」，本脚本只负责「AI 实验设计 + 落盘 + 可选群推送」。
 *
 * 入参：--plain-file <path>  含已格式化的原始数据文本（utf8）
 * 出参：把「AI A/B 增长实验设计方案」打印到 stdout（供后端作为企微回复回显给发令人）；
 *       同时落盘 releases/growth-experiment/<date>.md（多候选目录回退，保证可写）。
 *
 * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
 *   - 本脚本只做「设计 + 写文件 + 可选推送」，任何失败都打印降级文本（原始数据），
 *     绝不抛错中断、绝不阻塞调用方、绝不自动改套餐/发券/改价/改文案。
 *   - 推送为可选项：仅当配置 ABOX_GROWTH_WEBHOOK（企微群机器人）时才主动推群，
 *     未配置则只回显 + 落盘，退回「人看后台/看会话」的传统路径。
 *
 * ⚠️ 实验硬约束（与 ABox 全局口径一致，违反即退回传统运营）：
 *   - 本节点**只设计、不执行**：所有改套餐/发券/改价/改文案动作必须由人工在后台确认；
 *   - 数值一律标「测算/观察」，并注明以实际核销与看板为准；
 *   - 券实验优先复用「现有券种」所列表格中的 #id，不凭空造券种 id；
 *   - 只基于给到的数据说话，数据缺失写「暂缺」，**绝不编造数字或楼名**；
 *   - 英文名恒为 ABox（禁 ABOX / abox）。
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

/** 多候选可写目录（与 gen-campaign/meal/recruit/coupon/daily/demand 同源逻辑） */
function pickWritableDir() {
  const repoRoot = existsSync(join(__dirname, '..', 'scripts'))
    ? resolve(__dirname, '..')
    : process.cwd();
  const candidates = [
    join(repoRoot, 'releases', 'growth-experiment'),
    join(repoRoot, 'data', 'uploads', 'growth-experiment'),
    join(repoRoot, 'data', 'growth-experiment'),
    join(tmpdir(), 'abox-growth-experiment'),
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

const PROPOSAL_SYSTEM = `你是「ABox 一盒」的增长实验设计助理。下面是一段已取好的「近 30 天整体经营基线 + 楼栋表现与差异 + 套餐模板人气 + 现有券种 + 可测杠杆」数据（数值均为测算/观察）。

请产出一份《A/B 增长实验设计方案》（**草稿，供人工确认，绝不自动执行**），严格按以下结构：

1. 实验机会扫描：基于数据指出 2~3 个「自然 A/B 机会」——
   · 楼栋间：规模相近但转化/客单价差明显的楼，可做对照；
   · 套餐间：头部与长尾人气差大，可对头部套餐做图文/文案变体；
   · 券：现有券种是否被充分 A/B 过（面额/门槛对照）；
2. 推荐 1~2 个实验（每个含）：
   · 假设（要验证什么）；
   · 变量（对照组 vs 实验组，明确改哪个、不改哪个）；
   · 实验单元（哪栋楼 / 哪类用户 / 哪个套餐）；
   · 观测指标（用上面已有的指标：GMV、单量、客单价、复购率、退款率等）；
   · 样本量与周期（基于现有体量给测算，注明「测算」）；
   · 成功阈值（lift 多少算赢，避免只看噪声）；
   · 护栏（可随时停：如某楼转化跌超 X% 立即回滚）；
3. 度量与归因：如何避免混淆（同周期、同口径、就近/随机分配），用什么看板核对 lift；
4. 确认路径：明确「所有改动须人工在后台执行（改套餐/发券/换文案属敏感操作，走审批/确认），本方案只设计不执行」。

硬性规则（违反即不合格）：
- 本节点只设计、不执行；任何改套餐、发券、改价、改文案动作必须由人工在后台确认；
- 所有数值标「测算/观察」，并说明以实际核销与看板为准；
- 券实验优先复用上面「现有券种」清单里的 #id，不凭空造券种 id；
- 只基于给到的数据说话；数据缺失写「暂缺」，**绝不编造数字或楼名**；
- 英文名恒为 ABox（禁 ABOX / abox）；
- 不要使用 emoji；不超过 1000 字；结尾必须写明「此为 AI 草稿，需人工确认后执行」。`;

function fallback(plain, reason) {
  const head = '（AI 设计暂不可用' + (reason ? `：${reason}` : '') + '，附原始数据）';
  return `${head}\n\n${plain}`;
}

async function main() {
  const { plainFile } = parseArgs(process.argv.slice(2));
  if (!plainFile || !existsSync(plainFile)) {
    process.stdout.write('增长实验设计失败：未收到数据文件。');
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
      timeoutMs: 20000,
      temperature: 0.4,
    });
    proposal = (proposal || '').trim();
    if (!proposal) proposal = null;
  } catch (e) {
    proposal = null;
    process.stderr.write(`LLM 设计失败：${e?.message || e}\n`);
  }

  const finalText = proposal
    ? `# ABox 一盒 · A/B 增长实验设计方案（${date}）\n\n${proposal}\n\n---\n\n## 原始数据（近 30 天）\n\n${plain}`
    : fallback(plain, 'AI 未返回');

  // 落盘（多候选目录回退）
  const dir = pickWritableDir();
  try {
    writeFileSync(join(dir, `${date}.md`), finalText, 'utf8');
  } catch (e) {
    process.stderr.write(`落盘失败（不影响回复）：${e?.message || e}\n`);
  }

  // 可选：群机器人推送（仅当配置了 webhook）
  const webhook = process.env.ABOX_GROWTH_WEBHOOK;
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
  process.stdout.write('增长实验设计出现异常，请稍后重试或看后台看板。');
  process.stderr.write(`gen-growth-experiment 异常：${e?.stack || e}\n`);
});

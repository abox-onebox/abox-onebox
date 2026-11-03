#!/usr/bin/env node
/**
 * ABox 一盒 · 动态发券策略提案生成（AI 编排节点 H · 脚本侧）
 * ------------------------------------------------------------------
 * 由 wecom-chat.service.ts 的 `genCouponStrategy()` 调起：后端已用 proxy.query 取好
 * 近 30 天「整体看板 + 留存分层 + 楼栋表现 + 现有券种」，
 * 格式化成「人话纯文本」，本脚本只负责「AI 发券策略提案 + 落盘 + 可选群推送」。
 *
 * 入参：--plain-file <path>  含已格式化的原始数据文本（utf8）
 * 出参：把「AI 发券策略提案」打印到 stdout（供后端作为企微回复回显给发令人）；
 *       同时落盘 releases/coupon-strategy/<date>.md（多候选目录回退，保证可写）。
 *
 * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
 *   - 本脚本只做「提案 + 写文件 + 可选推送」，任何失败都打印降级文本（原始数据），
 *     绝不抛错中断、绝不阻塞调用方、绝不发券。
 *   - 推送为可选项：仅当配置 ABOX_COUPON_WEBHOOK（企微群机器人）时才主动推群，
 *     未配置则只回显 + 落盘，退回「人看后台/看会话」的传统路径。
 *
 * ⚠️ 发券硬约束（与 ABox 全局口径一致，违反即退回传统运营）：
 *   - 本节点**只提案、不发券**：所有发券动作必须由人工在后台「批量发券」确认执行；
 *   - 金额、预算一律标「测算示例」，并注明以实际核销与面额为准；
 *   - 优先复用「现有券种」所列表格中的 #id，不凭空造券种 id；
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

/** 多候选可写目录（与 gen-campaign/meal/recruit/daily 同源逻辑） */
function pickWritableDir() {
  const repoRoot = existsSync(join(__dirname, '..', 'scripts'))
    ? resolve(__dirname, '..')
    : process.cwd();
  const candidates = [
    join(repoRoot, 'releases', 'coupon-strategy'),
    join(repoRoot, 'data', 'uploads', 'coupon-strategy'),
    join(repoRoot, 'data', 'coupon-strategy'),
    join(tmpdir(), 'abox-coupon-strategy'),
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

const PROPOSAL_SYSTEM = `你是「ABox 一盒」的动态发券策略助理。下面是一段已算好的「近 30 天经营·留存·楼栋·现有券种」数据（含整体看板、留存分层、楼栋表现 TOP、以及可直接复用的现有券种清单）。

请产出一份《动态发券策略提案》（**草稿，供人工确认，绝不直接发券、绝不改库**）：
1. 策略总览：基于数据判断「现在是否适合推券、主推哪类」，一句话点明时机与理由；
2. 四类券建议（每类给：目标人群·规模、建议面额/门槛/有效期、预期撬动，全部基于上面的数字）：
   · 新客承接券 —— 目标=新客数；
   · 沉睡唤醒券 —— 目标=「可唤醒沉睡用户（活跃-复购）」；
   · 楼栋定向券 —— 选楼栋表现里 1~2 栋做定向（注明可走后台批量发券 scope=building）；
   · 复购激励券 —— 目标=复购率偏低或复购人群；
3. 预算测算：每张券按「面额 × 预估发放张数 × 预估核销率」粗算总补贴，明确标注「测算示例」；
4. 确认与发放路径：明确写明「需人工在后台批量发券(grant-batch)执行，先 dryRun 试算确认人群与数量后再实发」。

硬性规则（违反即不合格）：
- 本节点只提案、不发券；任何发券动作必须由人工在后台确认；
- 金额、预算一律标「测算示例」，并说明以实际核销与面额为准；
- 优先复用上面「现有券种」清单里的 #id（如 #3 ¥2 无门槛），不凭空造券种 id；
- 只基于给到的数据说话；数据缺失写「暂缺」，**绝不编造数字或楼名**；
- 英文名恒为 ABox（禁 ABOX / abox）；
- 不要使用 emoji；不超过 1000 字；结尾必须写明「此为 AI 草稿，需人工确认后发放」。`;

function fallback(plain, reason) {
  const head = '（AI 提案暂不可用' + (reason ? `：${reason}` : '') + '，附原始数据）';
  return `${head}\n\n${plain}`;
}

async function main() {
  const { plainFile } = parseArgs(process.argv.slice(2));
  if (!plainFile || !existsSync(plainFile)) {
    process.stdout.write('发券策略生成失败：未收到数据文件。');
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
      temperature: 0.3,
    });
    proposal = (proposal || '').trim();
    if (!proposal) proposal = null;
  } catch (e) {
    proposal = null;
    process.stderr.write(`LLM 提案失败：${e?.message || e}\n`);
  }

  const finalText = proposal
    ? `# ABox 一盒 · 动态发券策略提案（${date}）\n\n${proposal}\n\n---\n\n## 原始数据（近 30 天）\n\n${plain}`
    : fallback(plain, 'AI 未返回');

  // 落盘（多候选目录回退）
  const dir = pickWritableDir();
  try {
    writeFileSync(join(dir, `${date}.md`), finalText, 'utf8');
  } catch (e) {
    process.stderr.write(`落盘失败（不影响回复）：${e?.message || e}\n`);
  }

  // 可选：群机器人推送（仅当配置了 webhook）
  const webhook = process.env.ABOX_COUPON_WEBHOOK;
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
  process.stdout.write('发券策略生成出现异常，请稍后重试或看后台看板。');
  process.stderr.write(`gen-coupon-strategy 异常：${e?.stack || e}\n`);
});

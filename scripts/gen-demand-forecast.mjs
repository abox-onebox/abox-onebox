#!/usr/bin/env node
/**
 * ABox 一盒 · 需求预测与产能预警生成（AI 编排节点 I · 脚本侧）
 * ------------------------------------------------------------------
 * 由 wecom-chat.service.ts 的 `genDemandForecast()` 调起：后端已用 proxy.query 取好
 * 近 30 天「日级销量趋势 + 楼栋表现 + 菜品热度 + 供应商日产能」，
 * 并在 service 端**预计算**了周几规律、动量系数、未来 7 天预测、产能利用率，
 * 格式化成「人话纯文本」，本脚本只负责「AI 解读 + 落盘 + 可选群推送」。
 *
 * 入参：--plain-file <path>  含已格式化的原始数据文本（utf8）
 * 出参：把「AI 需求预测与产能预警提案」打印到 stdout（供后端作为企微回复回显给发令人）；
 *       同时落盘 releases/demand-forecast/<date>.md（多候选目录回退，保证可写）。
 *
 * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
 *   - 本脚本只做「解读 + 写文件 + 可选推送」，任何失败都打印降级文本（原始数据），
 *     绝不抛错中断、绝不阻塞调用方、绝不自动改产能或下单。
 *   - 推送为可选项：仅当配置 ABOX_DEMAND_WEBHOOK（企微群机器人）时才主动推群，
 *     未配置则只回显 + 落盘，退回「人看后台/看会话」的传统路径。
 *
 * ⚠️ 硬约束（与 ABox 全局口径一致，违反即退回传统运营）：
 *   - 本节点**只提案、不执行**：所有备料/排产/招募/扩容动作必须由人工确认后落地；
 *   - 预测值、利用率、占比一律标「测算」，并注明以实际为准；
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

/** 多候选可写目录（与 gen-campaign/meal/recruit/coupon/daily 同源逻辑） */
function pickWritableDir() {
  const repoRoot = existsSync(join(__dirname, '..', 'scripts'))
    ? resolve(__dirname, '..')
    : process.cwd();
  const candidates = [
    join(repoRoot, 'releases', 'demand-forecast'),
    join(repoRoot, 'data', 'uploads', 'demand-forecast'),
    join(repoRoot, 'data', 'demand-forecast'),
    join(tmpdir(), 'abox-demand-forecast'),
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

const PROPOSAL_SYSTEM = `你是「ABox 一盒」的需求预测与产能预警助理。下面是一段已算好的「近 30 天日级销量 + 周几规律 + 动量系数 + 未来 7 天预测 + 楼栋/菜品表现 + 供应商日产能基线」数据（service 端已做好时序分解与预测，数值都标了测算）。

请产出一份《需求预测与产能预警提案》（**草稿，供人工确认，绝不自动改产能或下单**），严格按以下结构：

1. 未来 7 天需求预测：直接引用数据里的「未来7天需求预测(测算)」逐日数值（**不要自己重算**），点明 7 日合计与峰值日；
2. 产能预警：引用「产能利用率(测算) / (参考)」数值并判级——
   · <90%：正常，按需备料；
   · 90%~100%：预警，需提前备料 + 加排；
   · >100%：告警，产能不足，需扩容或分流；
   若「产能基线缺失」，明确说明改用历史峰值参考，并建议先补全供应商 capacity_per_day 配置；
3. 分楼栋预测与预警：按楼栋占比（数据里是 GMV 占比，作为需求分布的测算代理）推算各楼预测份数；若某楼预测 > 总产能×50%（测算阈值）提示集中度风险，建议加团长或分流；
4. 分菜品备货建议：按菜品热度占比推算各菜品预测份数方向，给备料优先级（热销前几名优先锁量）；
5. 行动建议（按优先级列出，明确「需人工确认后执行」）：备料 / 加排 / 招募团长 / 产能扩容 / 分流。

硬性规则（违反即不合格）：
- 本节点只提案、不执行；任何产能/排产/下单动作必须由人工在后台确认；
- 预测值、利用率、占比一律标「测算」，并说明以实际核销与备货为准；
- 只基于给到的数据说话；数据缺失写「暂缺」，**绝不编造数字或楼名**；
- 英文名恒为 ABox（禁 ABOX / abox）；
- 不要使用 emoji；不超过 1000 字；结尾必须写明「此为 AI 草稿，需人工确认后执行」。`;

function fallback(plain, reason) {
  const head = '（AI 提案暂不可用' + (reason ? `：${reason}` : '') + '，附原始数据）';
  return `${head}\n\n${plain}`;
}

async function main() {
  const { plainFile } = parseArgs(process.argv.slice(2));
  if (!plainFile || !existsSync(plainFile)) {
    process.stdout.write('需求预测生成失败：未收到数据文件。');
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
    ? `# ABox 一盒 · 需求预测与产能预警提案（${date}）\n\n${proposal}\n\n---\n\n## 原始数据（近 30 天）\n\n${plain}`
    : fallback(plain, 'AI 未返回');

  // 落盘（多候选目录回退）
  const dir = pickWritableDir();
  try {
    writeFileSync(join(dir, `${date}.md`), finalText, 'utf8');
  } catch (e) {
    process.stderr.write(`落盘失败（不影响回复）：${e?.message || e}\n`);
  }

  // 可选：群机器人推送（仅当配置了 webhook）
  const webhook = process.env.ABOX_DEMAND_WEBHOOK;
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
  process.stdout.write('需求预测生成出现异常，请稍后重试或看后台看板。');
  process.stderr.write(`gen-demand-forecast 异常：${e?.stack || e}\n`);
});

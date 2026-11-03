#!/usr/bin/env node
/**
 * ABox 一盒 · 风控对账体检报告生成（AI 编排节点 K · 脚本侧）
 * ------------------------------------------------------------------
 * 由 wecom-chat.service.ts 的 `genRiskRecon()` 调起：后端已用 svc token 取好
 * 「本地三头对账差异 + 退款积压 + 应付未出单 + 提现待审批」四类数据并汇总成纯文本，
 * 本脚本只负责「AI 风控解读 + 落盘 + 可选群推送」。
 *
 * 入参：--plain-file <path>  含已格式化的原始数据文本（utf8）
 * 出参：把「AI 风控对账体检报告」打印到 stdout（供后端作为企微回复回显给发令人）；
 *       同时落盘 releases/risk-recon/<date>.md（多候选目录回退，保证可写）。
 *
 * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
 *   - 本脚本只做「解读 + 写文件 + 可选推送」，任何失败都打印降级文本（原始数据），
 *     绝不抛错中断、绝不阻塞调用方、绝不自动平账/改余额/批退款/批提现。
 *   - 推送为可选项：仅当配置 ABOX_RISK_WEBHOOK（企微群机器人）时才主动推群，
 *     未配置则只回显 + 落盘，退回「人看后台/看会话」的传统路径。
 *
 * ⚠️ 风控硬约束（与 ABox 全局口径一致，违反即退回传统运营）：
 *   - 本节点**只解读、不执行**：所有平账/调账/批退款/批提现动作必须由人工在后台执行；
 *   - 一期仅「本地三头对账」（无微信账单），报告必须诚实声明「不等于已与微信对平」；
 *   - 数值一律标「系统实读/测算」，并注明以后台详情为准；
 *   - 只基于给到的数据说话，数据缺失写「暂缺」，**绝不编造数字、订单号或结论**；
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

/** 多候选可写目录（与 gen-campaign/meal/recruit/coupon/daily/demand/growth 同源逻辑） */
function pickWritableDir() {
  const repoRoot = existsSync(join(__dirname, '..', 'scripts'))
    ? resolve(__dirname, '..')
    : process.cwd();
  const candidates = [
    join(repoRoot, 'releases', 'risk-recon'),
    join(repoRoot, 'data', 'uploads', 'risk-recon'),
    join(repoRoot, 'data', 'risk-recon'),
    join(tmpdir(), 'abox-risk-recon'),
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

const PROPOSAL_SYSTEM = `你是「ABox 一盒」的风控对账体检官。下面是一段已取好的「本地三头支付对账差异 + 退款积压 + 应付未出单异常 + 提现待审批」数据（数值均为系统实读汇总，已脱敏）。

请产出一份《风控对账体检报告》（**草稿，供人工复核，绝不自动执行**），严格按以下结构：

1. 总体结论：用一句话给「健康 / 需关注 / 高风险」定性，并说明依据（如对账是否平衡、各积压量是否异常）。
2. 风险清单（按严重度从高到低排序，最多 5 条）：每条含
   · 风险点（一句话）
   · 数据依据（引用上面给到的具体数字，如「对账差异 N 笔 / 待审批退款 M 笔 ¥X / 未出单 K 项」）
   · 为什么危险（钱去哪了 / 卡在哪 / 可能引发什么）
   · 建议的人工下一步（明确「谁来做、在哪个后台页」——例如「财务在 D43 对账页逐笔核对差异的 nextAction」）；
3. 需人工确认的事项：把对账差异里自带的「下一步动作」转述清楚；提示退款积压、应付未出单、提现待审批各自该去哪个后台页处理；
4. 诚实声明：一期仅做「本地三头对账」（无微信账单），**本地三头平 ≠ 已与微信对平**；所有差异需人工逐笔核，本节点不改任何账。

硬性规则（违反即不合格）：
- 本节点只解读、不执行；任何平账、调账、批退款、批提现动作必须由人工在后台执行；
- 一期仅本地三头对账（无微信账单），必须诚实声明「不等于已与微信对平」；
- 所有数值标「系统实读/测算」，并说明以后台详情为准；
- 只基于给到的数据说话；数据缺失写「暂缺」，**绝不编造数字、订单号或结论**；
- 英文名恒为 ABox（禁 ABOX / abox）；
- 不要使用 emoji；不超过 1000 字；结尾必须写明「此为 AI 草稿，需人工确认后处置」。`;

function fallback(plain, reason) {
  const head = '（AI 解读暂不可用' + (reason ? `：${reason}` : '') + '，附原始数据）';
  return `${head}\n\n${plain}`;
}

async function main() {
  const { plainFile } = parseArgs(process.argv.slice(2));
  if (!plainFile || !existsSync(plainFile)) {
    process.stdout.write('风控对账生成失败：未收到数据文件。');
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
    process.stderr.write(`LLM 解读失败：${e?.message || e}\n`);
  }

  const finalText = proposal
    ? `# ABox 一盒 · 风控对账体检报告（${date}）\n\n${proposal}\n\n---\n\n## 原始数据\n\n${plain}`
    : fallback(plain, 'AI 未返回');

  // 落盘（多候选目录回退）
  const dir = pickWritableDir();
  try {
    writeFileSync(join(dir, `${date}.md`), finalText, 'utf8');
  } catch (e) {
    process.stderr.write(`落盘失败（不影响回复）：${e?.message || e}\n`);
  }

  // 可选：群机器人推送（仅当配置了 webhook）
  const webhook = process.env.ABOX_RISK_WEBHOOK;
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
  process.stdout.write('风控对账生成出现异常，请稍后重试或看后台看板。');
  process.stderr.write(`gen-risk-recon 异常：${e?.stack || e}\n`);
});

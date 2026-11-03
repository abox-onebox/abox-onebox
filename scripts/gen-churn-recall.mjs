#!/usr/bin/env node
/**
 * ABox 一盒 · 用户流失预警与召回方案生成（AI 编排节点 M · 脚本侧）
 * ------------------------------------------------------------------
 * 由 wecom-chat.service.ts 的 `genChurnRecall()` 调起：后端已用 svc token 取好
 * 「全量用户流失分群 + D50 留存背景 + 现有可复用券种」并汇总成纯文本（已脱敏，不含个人信息），
 * 本脚本只负责「AI 流失解读 + 召回方案设计 + 落盘 + 可选群推送」。
 *
 * 入参：--plain-file <path>  含已格式化的原始数据文本（utf8）
 * 出参：把「用户流失预警与召回方案」打印到 stdout（供后端作为企微回复回显给发令人）；
 *       同时落盘 releases/churn-recall/<date>.md（多候选目录回退，保证可写）。
 *
 * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
 *   - 本脚本只做「解读 + 方案设计 + 写文件 + 可选推送」，任何失败都打印降级文本（原始数据），
 *     绝不抛错中断、绝不阻塞调用方、绝不自动发券 / 改用户状态 / 代绑楼。
 *   - 推送为可选项：仅当配置 ABOX_CHURN_WEBHOOK（企微群机器人）时才主动推群，
 *     未配置则只回显 + 落盘，退回「人看后台/看会话」的传统路径。
 *
 * ⚠️ 流失召回硬约束（与 ABox 全局口径一致，违反即退回传统运营）：
 *   - 本节点**只提案、不执行**：召回券必须由人工在后台发放；本脚本永不调用发券接口；
 *   - 个人昵称/手机号/openid 未进入输入数据，本节点也绝不编造任何个人信息；
 *   - 现有券种一律复用给到的 #id（标「测算示例」），不凭空造券种；
 *   - 金额/占比一律标「系统实读/测算」，并注明以后台详情为准；
 *   - 只基于给到的数据说话，数据缺失写「暂缺」，**绝不编造数字或结论**；
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

/** 多候选可写目录（与 gen-risk-recon 等同源逻辑） */
function pickWritableDir() {
  const repoRoot = existsSync(join(__dirname, '..', 'scripts'))
    ? resolve(__dirname, '..')
    : process.cwd();
  const candidates = [
    join(repoRoot, 'releases', 'churn-recall'),
    join(repoRoot, 'data', 'uploads', 'churn-recall'),
    join(repoRoot, 'data', 'churn-recall'),
    join(tmpdir(), 'abox-churn-recall'),
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

const PROPOSAL_SYSTEM = `你是「ABox 一盒」的用户增长与留存官。下面是一段已取好的「全量用户流失分群 + D50 留存背景 + 现有可复用券种」数据（数值均为系统实读汇总，已脱敏，不含任何个人信息）。

请产出一份《用户流失预警与召回方案》（**草稿，供人工复核，绝不自动执行**），严格按以下结构：

1. 总体定性：用一句话给「健康 / 需关注 / 高风险」定性，依据三项——沉默用户（>14 天未下单）占比、未绑楼（下不了单）人数、近 30 天复购率。
2. 流失预警清单（按严重度从高到低，最多 5 条）：每条含
   · 预警点（一句话，如「沉默用户规模达 N 人，其中 90 天以上 X 人已接近流失」）
   · 数据依据（引用上面给到的具体数字：沉默人数/分布、未绑楼人数、复购率、cohort 留存）
   · 为什么危险（对周一周盒高频复购品类，沉默=营收持续漏损）
   · 建议的人工下一步；
3. 召回策略提案（核心，可分三块，每块给可落地动作）：
   · 沉默用户召回券：基于给到的「现有可复用券种 #id」设计 1~2 张召回券（写明复用哪个 #id、面额、门槛、有效期），金额标「测算示例」；强调需人工在后台发放，本方案不自动发；
   · 未绑楼「假流失」挽回：给一段可发给用户的「代绑楼引导话术」草稿（让他们重新选办公楼即可下单）；
   · 低复购结构性提升：基于 cohort 次周留存，给 1~2 条提升复购的动作（如盲盒惊喜、周期提醒、口味轮替）；
4. 诚实声明：本节点只提案不执行，召回券需人工确认后在后台发放；所有占比/金额标「系统实读/测算示例」；仅基于给到的数据，缺失写「暂缺」。

硬性规则（违反即不合格）：
- 本节点只提案不执行；任何发券/改状态/代绑楼动作必须由人工在后台做；
- 个人昵称/手机号/openid 未出现在输入中，也绝不编造任何个人信息或具体用户；
- 券种一律复用给到的 #id（标「测算示例」），不凭空造券种 id；
- 所有数值标「系统实读/测算」，并说明以后台详情为准；
- 只基于给到的数据说话；数据缺失写「暂缺」，**绝不编造数字或结论**；
- 英文名恒为 ABox（禁 ABOX / abox）；
- 不要使用 emoji；不超过 1100 字；结尾必须写明「此为 AI 草稿，需人工确认后发放/执行」。`;

function fallback(plain, reason) {
  const head = '（AI 解读暂不可用' + (reason ? `：${reason}` : '') + '，附原始数据）';
  return `${head}\n\n${plain}`;
}

async function main() {
  const { plainFile } = parseArgs(process.argv.slice(2));
  if (!plainFile || !existsSync(plainFile)) {
    process.stdout.write('用户流失预警生成失败：未收到数据文件。');
    return;
  }
  const plain = readFileSync(plainFile, 'utf8');
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
    ? `# ABox 一盒 · 用户流失预警与召回方案（${date}）\n\n${proposal}\n\n---\n\n## 原始数据\n\n${plain}`
    : fallback(plain, 'AI 未返回');

  const dir = pickWritableDir();
  try {
    writeFileSync(join(dir, `${date}.md`), finalText, 'utf8');
  } catch (e) {
    process.stderr.write(`落盘失败（不影响回复）：${e?.message || e}\n`);
  }

  const webhook = process.env.ABOX_CHURN_WEBHOOK;
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

  const echo = proposal && proposal.length <= 1800 ? proposal : plain.slice(0, 1700);
  process.stdout.write(echo);
}

main().catch((e) => {
  process.stdout.write('用户流失预警生成出现异常，请稍后重试或看后台用户管理。');
  process.stderr.write(`gen-churn-recall 异常：${e?.stack || e}\n`);
});

#!/usr/bin/env node
/**
 * ABox 一盒 · AI 编排节点 Q「退款根因聚类」生成脚本
 * ------------------------------------------------------------------
 * 入参：--plain-file <path>  含已聚类的退款数据文本（utf8，聚类由 service 端纯函数算好）
 * 出参：stdout 输出 markdown 草案（service 直接回给企微）
 *       同时落盘 releases/refund-cluster/<date>.md（多候选目录回退）。
 *
 * 原则零：算术全在 `refund-cluster.ts` 里做完，本脚本只让 LLM 做「归因解读与整改建议」，
 *   LLM 失败一律降级为「附原始数据」，绝不阻断。
 *
 * ⚠️ 硬边界（写进 system prompt）：
 *   · 只提案：不审批、不驳回、不退款、不改订单状态；
 *   · 不推断缺失的归因 —— 输入说「未标注」就写「未标注」，不许自己归类；
 *   · 必须转述样本口径（最近 N 笔 / 窗口内 M 笔），不许说成「全部退款」。
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

function pickWritableDir() {
  const repoRoot = join(__dirname, '..');
  const candidates = [
    join(repoRoot, 'releases', 'refund-cluster'),
    join(repoRoot, 'data', 'uploads', 'refund-cluster'),
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

function bjYmd() {
  // ⚠️ 用 toISOString（TZ 无关），不要「+8h 后读本地分量」（容器 TZ=Asia/Shanghai 会双平移）
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

const PROPOSAL_SYSTEM = `你是「ABox 一盒」的用户体验与运营质量负责人。下面是一段已取好的「退款率背景 + 近 30 天逐笔退款聚类」数据（数值均为系统实读汇总，不含昵称与手机号）。

ABox 的业务形态：一栋写字楼一个团长，周一周盒（每周一期），团长把盒饭送到工位。退款主要发生在「截单前取消」「出餐后品质/漏送」「临时不去」三类场景。

请产出一份《退款根因分析与整改建议》（**草稿，供人工复核，绝不自动处理**），严格按以下结构：

1. 一句话结论：退款率处于什么水平（结合输入给的退款率与环比）、最大的一类根因是什么、这件事该不该现在动手。
2. 根因排序（按笔数降序，最多 5 类）：每类含
   · 原因（照抄输入里的原因名，不要改名）
   · 笔数与占比、金额特征（笔均金额 / 主要落在哪个金额档）
   · 判断（这是「流程问题」「品质问题」「预期管理问题」还是「用户自身原因」，各给一句依据）
   · 如果是「未标注原因」这一类，直接写「数据缺失，无法归因」，**不要猜它是什么**
3. 三条整改动作（本周可做，按性价比排序）：每条写清
   · 改什么（具体到环节：截单提醒 / 出餐核对 / 配送交接 / 菜单描述 / 退款原因必填）
   · 谁负责（岗位，不写人名）
   · 怎么验证有没有效（看哪个数、几天后看）
4. 数据质量问题（必须如实说）：样本口径（最近多少笔、窗口内多少笔）、未标注原因占比是否过高、两条口径（看板退款率 vs 逐笔聚类）不可互相校验金额。
5. 诚实声明：只提案不执行；退款审批、订单状态回退须人工在后台操作；仅基于给到的数据，缺失写「暂缺」。

硬性规则（违反即不合格）：
- **不要再写一级标题**：# 号大标题脚本已经加过，重复会出现两个标题；直接从「一、一句话结论」开始；
- **只提案不执行**：不自动通过/驳回退款，不改订单状态，不联系用户；
- **不推断缺失归因**：输入写「未标注原因」就照写，绝不自行归类成某个原因；
- **不编造数字**：笔数/占比/金额一律照抄输入，缺失写「暂缺」；
- 必须转述样本口径，**不许把「最近 N 笔的窗口内子集」说成「全部退款」**；
- 英文名恒为 ABox（禁 ABOX / abox）；不要使用 emoji；不超过 1100 字；
- 结尾必须写明「此为 AI 草稿，需人工确认后执行」。`;

function fallback(plain, reason) {
  const head = '（AI 解读暂不可用' + (reason ? `：${reason}` : '') + '，附原始数据）';
  return `${head}\n\n${plain}`;
}

async function main() {
  const { plainFile } = parseArgs(process.argv.slice(2));
  if (!plainFile || !existsSync(plainFile)) {
    process.stdout.write('退款根因分析生成失败：未收到数据文件。');
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
    // ⚠️ 45s 而非 20s：云端首 token 延迟常超 20s，20s 会被 abort 成 LLM_EMPTY（2026-11-03 实测）
    proposal = await callLLM({
      system: PROPOSAL_SYSTEM,
      user: plain,
      timeoutMs: 45000,
      temperature: 0.3,
    });
    proposal = (proposal || '').trim();
    if (!proposal) proposal = null;
  } catch (e) {
    proposal = null;
    process.stderr.write(`LLM 解读失败：${e?.message || e}\n`);
  }

  const finalText = proposal
    ? `# ABox 一盒 · 退款根因分析与整改建议（${date}）\n\n${proposal}\n\n---\n\n## 原始数据\n\n${plain}`
    : fallback(plain, 'AI 未返回');

  const dir = pickWritableDir();
  try {
    writeFileSync(join(dir, `${date}.md`), finalText, 'utf8');
  } catch (e) {
    process.stderr.write(`落盘失败（不影响回复）：${e?.message || e}\n`);
  }

  const webhook = process.env.ABOX_REFUND_WEBHOOK;
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

  process.stdout.write(finalText);
}

main().catch((e) => {
  process.stderr.write(`生成失败：${e?.stack || e}\n`);
  process.stdout.write('退款根因分析生成失败，请稍后重试。');
});

#!/usr/bin/env node
/**
 * ABox 一盒 · 经营健康度解读（AI 编排节点 O · 脚本侧）
 * ------------------------------------------------------------------
 * 由 wecom-chat.service.ts 的 `genHealthScore()` 调起：后端已用纯函数算好
 * 「五维得分（增长/留存/资金/履约/组织，各 20 分）+ 总分 + 红黄绿 + 关键数字」，
 * 本脚本只负责「把分数说成人话 + 给三条优先动作 + 落盘」。
 *
 * 入参：--plain-file <path>  含已格式化的打分文本（utf8）
 * 出参：把「经营健康度体检结论」打印到 stdout（供后端回显 / 每日编排封面）；
 *       同时落盘 releases/health-score/<date>.md（多候选目录回退，保证可写）。
 *
 * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
 *   - 只做「解读 + 建议 + 写文件 + 可选推送」，任何失败都打印降级文本（原始打分），
 *     绝不抛错中断、绝不阻塞调用方、绝不触发任何写操作。
 *
 * ⚠️ 健康度硬约束（违反即不合格）：
 *   - **分数不由你改**：后端算好的分与红黄绿是事实，任务是把「为什么」讲清楚；
 *   - **缺失维度必须转述**：给到的「已测 N/5 维」与「缺失：X」必须原样出现 ——
 *     只测了三维却宣称「全面健康」是最容易骗到人的一种错；
 *   - 只提案不执行：任何发券/退款/调账/停职动作都必须由人工在后台做；
 *   - 不编造数字：只引给到的数，缺失写「暂缺」；
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

function pickWritableDir() {
  const repoRoot = existsSync(join(__dirname, '..', 'scripts'))
    ? resolve(__dirname, '..')
    : process.cwd();
  const candidates = [
    join(repoRoot, 'releases', 'health-score'),
    join(repoRoot, 'data', 'uploads', 'health-score'),
    join(repoRoot, 'data', 'health-score'),
    join(tmpdir(), 'abox-health-score'),
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

const PROPOSAL_SYSTEM = `你是「ABox 一盒」的经营分析师。下面是一段由系统纯函数算好的《经营健康度总分》数据：五维各 20 分（增长 / 留存 / 资金 / 履约 / 组织），已折算成 0~100 总分与红黄绿等级，并附了原始关键数字。

ABox 的业务形态：一栋写字楼一个团长，周一周盒（每周一期），预包装快消品（非餐饮现制），T-1 24:00 截单、次日 11:30 送达工位。

请产出一份《经营健康度体检结论》（**草稿，供人工复核，绝不自动执行**），严格按以下结构：

1. 一句话结论：分数 + 颜色 + 最关键的定性（如「72 分黄色：增长还行，留存是短板」）。
   · **必须先原样转述「已测 N/5 维」与缺失维度**——只测了三维就别说「全面健康」。
2. 分维诊断（五条，缺失维度写「数据暂缺，本次不计入总分」）：
   · 每维：得分/20 + 一句话解释「为什么是这个分」，引用给到的原始数字；
   · 最短板那维多说两句（它决定明天的优先级）。
3. 三条优先动作（必须可落地、本周能做、不花钱或花小钱）：
   · 每条写清：做什么、针对哪一维、预期改善哪个指标、谁来做；
   · 允许引用已有节点的能力（如「发一次沉默用户召回券，见今日流失预警草稿」），但要说清是人工执行。
4. 诚实声明：分数由系统纯函数按固定阈值判定，不是主观感觉；缺失维度不计入分母；只基于给到的数据，缺失写「暂缺」；任何动作须人工确认后执行。

硬性规则（违反即不合格）：
- **不许改分、不许自己重算总分**，后端给的分数与颜色是事实；
- 必须转述「已测 N/5 维」；缺失维度不得当成低分，也不得忽略不提；
- 只提案不执行；发券/退款/调账/停职/换人一律由人工在后台做；
- 不编造任何数字（包括行业均值、竞品数据）；只引给到的数；
- 英文名恒为 ABox（禁 ABOX / abox）；
- 不要使用 emoji；不超过 900 字；结尾必须写明「此为 AI 草稿，需人工确认后执行」。`;

function fallback(plain, reason) {
  const head = '（AI 解读暂不可用' + (reason ? `：${reason}` : '') + '，附原始打分）';
  return `${head}\n\n${plain}`;
}

async function main() {
  const { plainFile } = parseArgs(process.argv.slice(2));
  if (!plainFile || !existsSync(plainFile)) {
    process.stdout.write('经营健康度解读失败：未收到数据文件。');
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
    // ⚠️ 同 gen-leader-health：40s 而非 20s。云端首 token 延迟波动大，
    //    20s 容易在「尚未吐字」时被 abort（报 LLM_EMPTY 假象）；service 侧 spawn 超时 90s。
    proposal = await callLLM({
      system: PROPOSAL_SYSTEM,
      user: plain,
      timeoutMs: 40000,
      temperature: 0.3,
    });
    proposal = (proposal || '').trim();
    if (!proposal) proposal = null;
  } catch (e) {
    proposal = null;
    process.stderr.write(`LLM 解读失败：${e?.message || e}\n`);
  }

  const finalText = proposal
    ? `# ABox 一盒 · 经营健康度体检结论（${date}）\n\n${proposal}\n\n---\n\n## 原始打分\n\n${plain}`
    : fallback(plain, 'AI 未返回');

  const dir = pickWritableDir();
  try {
    writeFileSync(join(dir, `${date}.md`), finalText, 'utf8');
  } catch (e) {
    process.stderr.write(`落盘失败（不影响回复）：${e?.message || e}\n`);
  }

  const webhook = process.env.ABOX_HEALTH_WEBHOOK;
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
  process.stdout.write('经营健康度解读出现异常，请稍后重试。');
  process.stderr.write(`gen-health-score 异常：${e?.stack || e}\n`);
});

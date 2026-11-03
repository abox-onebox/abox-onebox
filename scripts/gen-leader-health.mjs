#!/usr/bin/env node
/**
 * ABox 一盒 · 团长健康度与留存干预方案（AI 编排节点 N · 脚本侧）
 * ------------------------------------------------------------------
 * 由 wecom-chat.service.ts 的 `genLeaderHealth()` 调起：后端已用 svc token 取好
 * 「在职团长名册汇总 + 沉睡/从未出单清单 + 卡点清单 + 近晋级清单 + 楼群覆盖」并汇总成纯文本
 * （已脱敏：不含姓名/手机号/nickname/openid），本脚本只负责「AI 判断 + 干预方案设计 + 落盘」。
 *
 * 入参：--plain-file <path>  含已格式化的原始数据文本（utf8）
 * 出参：把「团长健康度与留存干预方案」打印到 stdout（供后端回显给发令人）；
 *       同时落盘 releases/leader-health/<date>.md（多候选目录回退，保证可写）。
 *
 * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
 *   - 只做「解读 + 方案设计 + 写文件 + 可选推送」，任何失败都打印降级文本（原始数据），
 *     绝不抛错中断、绝不阻塞调用方、绝不自动停职/换人/改佣金。
 *   - 推送为可选项：仅当配置 ABOX_LEADER_WEBHOOK 时才主动推群。
 *
 * ⚠️ 团长运营硬约束（与 ABox 全局口径一致，违反即退回人工运营）：
 *   - 只提案不执行：停用/转交/改佣金/改等级必须由人工在后台操作；
 *   - 不编造个人信息（姓名/手机号/微信号一律不出现），只按「楼栋 + 团长#id」指代；
 *   - **不谈佣金金额**：健康度不含钱的口径（佣金余额看财务节点 K），别自己算钱；
 *   - 阈值口径必须原样转述（新上任 <7 天不计流失；7 天内健康；8~14 天待唤醒；>14 天沉睡）；
 *   - 只基于给到的数据说话，缺失写「暂缺」，**绝不编造数字或结论**；
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

/** 多候选可写目录（与 gen-churn-recall 同源逻辑） */
function pickWritableDir() {
  const repoRoot = existsSync(join(__dirname, '..', 'scripts'))
    ? resolve(__dirname, '..')
    : process.cwd();
  const candidates = [
    join(repoRoot, 'releases', 'leader-health'),
    join(repoRoot, 'data', 'uploads', 'leader-health'),
    join(repoRoot, 'data', 'leader-health'),
    join(tmpdir(), 'abox-leader-health'),
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
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${bj.getFullYear()}-${p(bj.getMonth() + 1)}-${p(bj.getDate())}`;
}

const PROPOSAL_SYSTEM = `你是「ABox 一盒」的团长运营负责人。下面是一段已取好的「在职团长健康度」数据（数值均为系统实读汇总，已脱敏：不含姓名、手机号、微信标识）。

ABox 的业务形态：一栋写字楼一个团长，周一周盒（每周一期），团长负责把盒饭送到工位。团长不是买家，他的「出单」指的是他名下产生了订单。

请产出一份《团长健康度与留存干预方案》（**草稿，供人工复核，绝不自动执行**），严格按以下结构：

1. 总体定性：一句话给「健康 / 需关注 / 高风险」，依据三项——沉睡与从未出单人数占比、带卡点（未绑收款/协议待补签）人数、近晋级人数。
2. 掉队预警清单（按处置紧急度从高到低，最多 5 条）：每条含
   · 预警点（一句话，如「X 个楼群团长已沉睡超 30 天」）
   · 数据依据（引用给到的具体数字：分档人数、沉默天数、本月单量）
   · 为什么危险（一栋楼没人带 = 那栋楼的复购整条断掉）
   · 人工下一步（谁去、做什么、多久内）
3. 干预方案（核心，分三块，每块给可落地动作）：
   · 卡点清零（最先做）：未绑收款/协议待补签的人，给一段「怎么提醒、提醒话术要点」的说明（不要编造具体人名，用「楼栋 + 团长#id」指代）；
   · 沉睡唤醒：给 1~2 个不靠发钱的动作（如一封唤醒说明、一次楼内试吃、一次标杆团长的经验转述），以及判断「该不该直接换人」的标准；
   · 近晋级推一把：对差 ≤10 单/≤1 人转正的团长，给一个具体的冲刺动作（一栋楼的集中推广、老客带新），说明升级后的激励差异（税率按 8/9/10/12% 阶梯，但不要替人算钱）。
4. 诚实声明：只提案不执行；停职/转交/改佣金须人工在后台做；所有数值标「系统实读」；仅基于给到的数据，缺失写「暂缺」。

硬性规则（违反即不合格）：
- 只提案不执行；任何停职/换人/改佣金/改等级动作必须由人工在后台操作；
- 绝不出现姓名、手机号、微信号等个人信息，也绝不编造具体个人；只用「楼栋 + 团长#id」指代；
- **不要讨论佣金金额或团长余额**（本节点不含钱的口径），激励只说机制不说钱数；
- 阈值口径原样转述：新上任 <7 天不参与流失判定、7 天内健康、8~14 天待唤醒、>14 天沉睡、有任职无订单为「从未出单」；
- 只基于给到的数据说话；缺失写「暂缺」，**绝不编造数字或结论**；
- 英文名恒为 ABox（禁 ABOX / abox）；
- 不要使用 emoji；不超过 1100 字；结尾必须写明「此为 AI 草稿，需人工确认后执行」。`;

function fallback(plain, reason) {
  const head = '（AI 解读暂不可用' + (reason ? `：${reason}` : '') + '，附原始数据）';
  return `${head}\n\n${plain}`;
}

async function main() {
  const { plainFile } = parseArgs(process.argv.slice(2));
  if (!plainFile || !existsSync(plainFile)) {
    process.stdout.write('团长健康度生成失败：未收到数据文件。');
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
    // ⚠️ 超时 45s 而非 20s：该 prompt 输出长（近 1100 字），云端首 token 常需 20s 以上，
    //    20s 会在「还没吐第一个 token」时被 abort，表现为 LLM_EMPTY 而非真正的拒答
    //    （2026-11-03 实测：同一输入 20s 恒空、45s 正常出稿）。service 侧 spawn 超时 90s，留足余量。
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
    ? `# ABox 一盒 · 团长健康度与留存干预方案（${date}）\n\n${proposal}\n\n---\n\n## 原始数据\n\n${plain}`
    : fallback(plain, 'AI 未返回');

  const dir = pickWritableDir();
  try {
    writeFileSync(join(dir, `${date}.md`), finalText, 'utf8');
  } catch (e) {
    process.stderr.write(`落盘失败（不影响回复）：${e?.message || e}\n`);
  }

  const webhook = process.env.ABOX_LEADER_WEBHOOK;
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
  process.stdout.write('团长健康度生成出现异常，请稍后重试或看后台团长管理。');
  process.stderr.write(`gen-leader-health 异常：${e?.stack || e}\n`);
});

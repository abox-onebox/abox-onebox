#!/usr/bin/env node
/**
 * ABox 一盒 · AI 编排节点 P「社群/私域运营助手」生成脚本
 * ------------------------------------------------------------------
 * 入参：--plain-file <path>  含已格式化的靶楼分层 / 套餐 / 券种 / 留存文本（utf8）
 * 出参：stdout 输出 markdown 草案（service 直接回给企微）
 *       同时落盘 releases/community-plan/<date>.md（多候选目录回退，保证可写）。
 *
 * 原则零：本脚本只负责「把已取好的数据交给 LLM 写成排期与话术」，
 *   LLM 失败一律降级为「附原始数据」，绝不阻断、绝不编内容。
 *
 * ⚠️ 硬边界（写进 system prompt）：
 *   · 只提案：不发群、不加好友、不发券，全部由人工执行；
 *   · 券只用输入里给到的 #id，金额与门槛标注「测算示例」；
 *   · 菜名只用输入里的套餐，不许编菜；
 *   · 不出现团长姓名/手机号，只用「楼栋（团长#id）」指代。
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

/** 可写目录：优先 releases/，退到 data/uploads/（容器里 data 是可写卷） */
function pickWritableDir() {
  const repoRoot = join(__dirname, '..');
  const candidates = [
    join(repoRoot, 'releases', 'community-plan'),
    join(repoRoot, 'data', 'uploads', 'community-plan'),
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

const PROPOSAL_SYSTEM = `你是「ABox 一盒」的社群运营负责人。下面是一段已取好的「靶楼分层 + 当期可排套餐 + 现有券种 + 留存背景」数据（数值均为系统实读汇总，不含团长姓名与手机号）。

ABox 的业务形态：一栋写字楼一个团长，周一周盒（每周一期），团长把盒饭送到工位；交付是「送到工位」，不是自提，也不要写成「爬楼/苦力」。套餐只有份数选择，没有口味与选餐。

请产出一份《本周社群运营排期与话术》（**草稿，供人工复核，绝不自动发送**），严格按以下结构：

1. 本周打法（3 句话内）：这一周的社群力气主要花在哪一档楼（放量/维持/唤醒/沉默），为什么是它，预期动词是什么。不要写成口号。
2. 一周排期（周一~周日，共 7 条）：每条含
   · 时间（周几 + 时段，如「周一 10:30」）
   · 发在哪（主战场楼群 / 待唤醒楼群 / 朋友圈，用输入里的楼栋名，不许编新楼）
   · 发什么（内容主题，如「本周菜单 + 截单时间提醒」）
   · 想让人做什么（下单 / 复购 / 转告同事，一次只一个动作）
3. 分档话术（4 条，可直接粘贴到群里）：
   · 放量档 1 条（趁热加码，讲本周亮点与截单时间）
   · 维持档 1 条（讲复购与固定节奏，别催太急）
   · 唤醒档 1 条（8~14 天没单的楼，讲「本周菜单变了什么」，不谈钱）
   · 沉默档 1 条（历史有量的楼，讲「我们还在、本周照常送」，给一个低门槛动作）
4. 朋友圈文案 3 条（不同角度：菜单本身 / 复购口碑 / 同楼同事拼单），每条 2 句以内。
5. 诚实声明：只提案不执行；发群、加好友、发券须人工操作；券只用给到的 #id 并标「测算示例」；数值标「系统实读」。

硬性规则（违反即不合格）：
- **不要再写一级标题**：# 号大标题脚本已经加过，重复会出现两个标题；直接从「一、本周打法」开始；
- **只提案不执行**：不自动发群消息、不自动发券、不自动加好友；
- **券只能用输入里给到的 #id**，面额与门槛照抄并标「测算示例」，绝不新造券；
- **菜名/套餐只能用输入里给到的**，不许编菜、不许编价格；
- 绝不出现团长姓名、手机号、微信号；只用「楼栋名（团长#id）」指代；
- 只基于给到的数据说话；缺失写「暂缺」，**绝不编造数字或结论**；
- 英文名恒为 ABox（禁 ABOX / abox）；不要使用 emoji；不超过 1200 字；
- 结尾必须写明「此为 AI 草稿，需人工确认后执行」。`;

function fallback(plain, reason) {
  const head = '（AI 解读暂不可用' + (reason ? `：${reason}` : '') + '，附原始数据）';
  return `${head}\n\n${plain}`;
}

async function main() {
  const { plainFile } = parseArgs(process.argv.slice(2));
  if (!plainFile || !existsSync(plainFile)) {
    process.stdout.write('社群运营方案生成失败：未收到数据文件。');
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
    // ⚠️ 45s 而非 20s：长输出 prompt 的云端首 token 常超 20s，20s 会被 abort 成 LLM_EMPTY
    //    （2026-11-03 实测）。service 侧 spawn 超时 90s，余量足够。
    proposal = await callLLM({
      system: PROPOSAL_SYSTEM,
      user: plain,
      timeoutMs: 45000,
      temperature: 0.5,
    });
    proposal = (proposal || '').trim();
    if (!proposal) proposal = null;
  } catch (e) {
    proposal = null;
    process.stderr.write(`LLM 解读失败：${e?.message || e}\n`);
  }

  const finalText = proposal
    ? `# ABox 一盒 · 本周社群运营排期与话术（${date}）\n\n${proposal}\n\n---\n\n## 原始数据\n\n${plain}`
    : fallback(plain, 'AI 未返回');

  const dir = pickWritableDir();
  try {
    writeFileSync(join(dir, `${date}.md`), finalText, 'utf8');
  } catch (e) {
    process.stderr.write(`落盘失败（不影响回复）：${e?.message || e}\n`);
  }

  const webhook = process.env.ABOX_COMMUNITY_WEBHOOK;
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
  process.stdout.write('社群运营方案生成失败，请稍后重试。');
});

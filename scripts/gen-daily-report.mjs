#!/usr/bin/env node
/**
 * ABox 一盒 · 运营日报生成（AI 编排节点 E · 脚本侧）
 * ------------------------------------------------------------------
 * 由 wecom-chat.service.ts 的 `genDailyReport()` 调起：后端已用 proxy.query 取好四视角
 * 数据并格式化成「人话纯文本」，本脚本只负责「AI 归因摘要 + 落盘 + 可选群推送」。
 *
 * 入参：--plain-file <path>  含已格式化的原始数据文本（utf8）
 * 出参：把「AI 日报摘要」打印到 stdout（供后端作为企微回复回显给发令人）；
 *       同时落盘 releases/daily/<date>.md（多候选目录回退，保证可写）。
 *
 * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
 *   - 本脚本只做「摘要 + 写文件 + 可选推送」，任何失败都打印降级文本（原始数据），
 *     绝不抛错中断、绝不阻塞调用方。
 *   - 推送为可选项：仅当配置 ABOX_REPORT_WEBHOOK（企微群机器人）时才主动推群，
 *     未配置则只回显 + 落盘，退回「人看后台/看会话」的传统路径。
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

/** 多候选可写目录（与 gen-campaign.mjs 同源逻辑）：优先 releases，回退挂载卷，再退 /tmp */
function pickWritableDir() {
  const repoRoot = existsSync(join(__dirname, '..', 'scripts')) ? resolve(__dirname, '..') : process.cwd();
  const candidates = [
    join(repoRoot, 'releases', 'daily'),
    join(repoRoot, 'data', 'uploads', 'daily'),
    join(repoRoot, 'data', 'daily'),
    join(tmpdir(), 'abox-daily'),
  ];
  for (const c of candidates) {
    try {
      // 先确保目录存在（recursive），再试探写权限
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

const DIGEST_SYSTEM = `你是「ABox 一盒」的运营助理。下面是一段已格式化的经营数据（近 7 天 vs 上一档，含阈值预警）。
请写一段克制、有用的《运营日报摘要》，严格遵循：
1. 一句话总览（今天生意整体怎么样）；
2. 亮点（1-2 条，有数据支撑）；
3. 需要关注的风险（对照这些警戒线：退款率 >5%、GMV 环比跌 >20%、单栋楼环比跌 >30% 且绝对额够大）；
4. 今日/明日的 1-2 条具体行动建议（如：哪栋楼要跟进、是否该发一张召回券）。
规则：只基于给到的数据说话；数据缺失就写「暂缺」，**绝不编造数字**；不要使用 emoji；不超过 600 字；语气像给老板的简报。`;

function fallback(plain, reason) {
  const head = '（AI 摘要暂不可用' + (reason ? `：${reason}` : '') + '，附原始数据）';
  return `${head}\n\n${plain}`;
}

async function main() {
  const { plainFile } = parseArgs(process.argv.slice(2));
  if (!plainFile || !existsSync(plainFile)) {
    process.stdout.write('日报生成失败：未收到数据文件。');
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
  let digest;
  try {
    digest = await callLLM({
      system: DIGEST_SYSTEM,
      user: plain,
      timeoutMs: 9000,
      temperature: 0.3,
    });
    digest = (digest || '').trim();
    if (!digest) digest = null;
  } catch (e) {
    digest = null;
    process.stderr.write(`LLM 摘要失败：${e?.message || e}\n`);
  }

  const finalText = digest
    ? `# ABox 一盒 · 运营日报（${date}）\n\n${digest}\n\n---\n\n## 原始数据\n\n${plain}`
    : fallback(plain, 'AI 未返回');

  // 落盘（多候选目录回退）
  const dir = pickWritableDir();
  try {
    writeFileSync(join(dir, `${date}.md`), finalText, 'utf8');
  } catch (e) {
    process.stderr.write(`落盘失败（不影响回复）：${e?.message || e}\n`);
  }

  // 可选：群机器人推送（仅当配置了 webhook）
  const webhook = process.env.ABOX_REPORT_WEBHOOK;
  if (webhook && digest) {
    try {
      const cap = digest.length > 1800 ? digest.slice(0, 1800) + '…' : digest;
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content: cap } }),
      });
    } catch (e) {
      process.stderr.write(`群推送失败（不影响回复）：${e?.message || e}\n`);
    }
  }

  // 回显给发令人（企微文本消息 ≤2048 字节，截摘要部分）
  const echo = digest && digest.length <= 1800 ? digest : plain.slice(0, 1700);
  process.stdout.write(echo);
}

main().catch((e) => {
  process.stdout.write('日报生成出现异常，请稍后重试或看后台看板。');
  process.stderr.write(`gen-daily-report 异常：${e?.stack || e}\n`);
});

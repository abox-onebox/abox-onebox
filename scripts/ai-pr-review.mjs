#!/usr/bin/env node
/**
 * ABox 一盒 · AI 代码审查（AI 编排节点 A）
 * ------------------------------------------------------------------
 * 作用：在 PR / 提交时，对 diff 做一次 AI 辅助代码审查，产出结构化 Markdown 报告
 *   （问题清单（文件:行号-估计 / 严重度 / 建议）、亮点、必须人工复核的高风险项）。
 *
 * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
 *   - 本脚本是「独立新增文件」，不修改 gate.mjs / 任何核心代码；
 *   - 只出「软建议」，绝不做自动 merge、绝不阻塞合并（默认 exit 0；--fail-on-high 才可选非零）；
 *   - 不重跑门禁（门禁由 CI gates job 独立执行），仅把门禁清单附作上下文；
 *   - LLM 不可用 / 超时 / 异常 → 降级为「仅转发门禁清单 + 提示人工审查」，不静默吞错；
 *   - 传统模式照常：不看本脚本，开发者按原有 review 流程走即可。
 *
 * 用法：
 *   node scripts/ai-pr-review.mjs [--diff-file <path>] [--base <sha>] [--head <sha>]
 *                                [--pr <number>] [--out <dir>] [--fail-on-high] [--no-llm]
 *
 * 参数：
 *   --diff-file <path>   直接读 diff 文件（CI 推荐：先 `git diff` 落盘再传入）
 *   --base/--head <sha>  用 `git diff base...head` 取 diff
 *   --pr <number>        若 gh + GITHUB_TOKEN 可用，把报告作为 PR 评论贴回
 *   --out <dir>          报告输出目录（默认 releases/ai-review）
 *   --fail-on-high       仅当报告含「高风险」标记时 exit 1（默认关闭，非阻塞）
 *   --no-llm             跳过 LLM，仅产出「门禁清单 + 人工审查提示」（纯降级模式）
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLLM } from './lib/cloud-llm.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TS = new Date().toISOString().slice(0, 10);

// ---- 参数 ----
const argv = process.argv.slice(2);
let diffFile = null;
let base = null;
let head = null;
let prNumber = process.env.PR_NUMBER || null;
let outDir = resolve(ROOT, 'releases', 'ai-review');
let failOnHigh = false;
let noLlm = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--diff-file') diffFile = argv[++i] || null;
  else if (argv[i] === '--base') base = argv[++i] || null;
  else if (argv[i] === '--head') head = argv[++i] || null;
  else if (argv[i] === '--pr') prNumber = argv[++i] || prNumber;
  else if (argv[i] === '--out') outDir = resolve(argv[++i] || outDir);
  else if (argv[i] === '--fail-on-high') failOnHigh = true;
  else if (argv[i] === '--no-llm') noLlm = true;
}

// ---- 1) 收集 diff ----
const MAX_DIFF = 60000;
function collectDiff() {
  if (diffFile) {
    if (!existsSync(diffFile))
      return { ok: false, reason: `diff 文件不存在: ${diffFile}`, text: '' };
    try {
      const t = readFileSync(diffFile, 'utf8');
      return {
        ok: true,
        reason: '',
        text: t.length > MAX_DIFF ? t.slice(0, MAX_DIFF) + `\n\n…（已截断至 ${MAX_DIFF} 字）` : t,
      };
    } catch (e) {
      return { ok: false, reason: String(e?.message || e), text: '' };
    }
  }
  const b = base || process.env.PR_BASE_SHA || 'origin/main';
  const h = head || 'HEAD';
  try {
    const r = spawnSync('git', ['diff', `${b}...${h}`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 60 * 1024 * 1024,
    });
    if (!r.stdout)
      return {
        ok: false,
        reason: `git diff ${b}...${h} 无输出（可能无改动或不在 git 仓库）`,
        text: '',
      };
    return {
      ok: true,
      reason: '',
      text:
        r.stdout.length > MAX_DIFF
          ? r.stdout.slice(0, MAX_DIFF) + `\n\n…（已截断至 ${MAX_DIFF} 字）`
          : r.stdout,
    };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e), text: '' };
  }
}

// ---- 2) 门禁清单（仅作上下文，不重跑）----
function collectGateNames() {
  try {
    const r = spawnSync(process.execPath, ['scripts/gate.mjs', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60000,
    });
    if (r.status !== 0 || !r.stdout)
      return { ok: false, reason: 'gate.mjs --json 执行失败', names: [] };
    const parsed = JSON.parse(r.stdout);
    const names = Object.keys(parsed.gates || {});
    if (!names.length) return { ok: false, reason: '门禁清单为空', names: [] };
    return { ok: true, reason: '', names };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e), names: [] };
  }
}

// ---- 3) 项目工程纪律审查清单（节选自 ref 分册，内嵌以保证 CI 自包含）----
const RUBRIC = `ABox 一盒 · 工程纪律审查清单（节选自项目 ref 分册，供 AI 审查对照）：
1. 命名：英文名恒为 ABox；禁 ABOX/abox。组件/变量见名知意。
2. 套餐模型：单一套餐，用户表单只有「份数」；禁口味/选餐/备注输入；当日菜单只读展示。
3. 类型与构建：改 packages/shared-types 后必须 npm run build（api 解析 dist/）。DAO 返回类型 ≠ 实体声明类型：mysql2 把 DATE 返回成 JS Date 对象（字段标 string 也不管），取到即用 toBizDateStr() 归一；DECIMAL 返 string 同一类；比较/解析前必须先归一，否则静默算错。
4. 数据库：TypeORM 不自动转 snake_case，多词列必须显式 name:'x_y'。新增实体必须进 database/entities/index.ts 的 ALL_ENTITIES，否则运行时 No metadata 且 parity 门禁对其沉默。
5. 判值：判「有没有值」用 Boolean(x)，别用 !== null（undefined!==null 为 true）。
6. 时间：用 toBjIso()/now()/bjDateTime(d,24)；勿用 toISOString 做东八区日期（会退一天）。
7. 报错：一律 BizException(ErrorCode.*)；裸 Error 逃过 200+code；新码须登记 enum+ERROR_MESSAGE。
8. 并发：判并发要同时查悲观锁与乐观锁（写钱路径用 version+1 + where version=:v）。
9. 依赖注入：@InjectRepository(X) 必须能在「本模块+CommonModule」的 forFeature 找到，tsc 与单测都拦不住，投递前跑 check-di-forfeature.mjs。
10. 余额真源：唯一真源=ab_balance（user_id 维度）；ab_team_leader.balance/total_commission 只是统计快照（恒 0），不可用于展示或判断。
11. 门禁与纪律：门禁全绿≠功能可用；判成败一律看 body.code（业务错误恒 HTTP 200+body.code；鉴权失败=HTTP 401+code 10002）。数表别用 grep -oE 挑文件名（@Entity 两种写法都要扫、grep -E 不支持 \\s）。
12. 安全红线：不可在交易主链路（下单/支付/配送）加 AI 或任何非必要外部调用；AI 只做旁路、可剥离、失败可降级。
13. 个人数据红线：不可对用户个人目录（Desktop/Downloads/Documents）做递归删除/批量改名/清空；连扫描都只出报告不改动。
14. 提交纪律：commit 正文中文每行~40 字（commitlint body-max-line-length 按字符计，超长被拦会自动回滚）。`;

const SYSTEM_PROMPT = `你是 ABox 一盒（微信小程序盒饭团购）的资深代码审查员。下面会给你一份 git diff 与项目工程纪律清单。
你的职责：对 diff 做一次**辅助**代码审查，帮助人类 reviewer 更快发现隐患。**你只输出审查意见，绝不修改代码，绝不批准合并。**

输出要求（严格 Markdown，中文，简洁，不啰嗦）：
# AI 代码审查报告
## 概览
（一句话：本次改动规模、整体观感、有无必须人工复核的高风险项）
## 门禁提醒
（提醒：门禁由 CI 独立运行，本条不重判；若 diff 触及 packages/shared-types / 实体 / 依赖注入 / 余额 / 时间处理，请特别点名）
## 审查发现
按严重度分三档，每档下列条目；每条含：估计位置（diff 中的文件 + 行号，写「文件:估计行」即可）、问题、建议修复。
### 🔴 高（可能导致静默算错/数据错/线上故障/安全违规）
### 🟡 中（规范违反、可维护性、潜在 bug）
### 🟢 低（风格、命名、注释）
## 亮点
（做得好的地方，没有就写「无」）
## 必须人工复核的高风险项
（把「高」档里最该人盯的挑出来；若没有写「无」。这一节用于 --fail-on-high 判定）

对照纪律清单时重点检查：snake_case 显式列名、DATE/DECIMAL 归一、BizException 统一报错、乐观/悲观锁、DI forFeature 注册、余额只读 ab_balance、交易主链路不引入 AI、个人目录不破坏数据。

若 diff 为空或读取失败，只输出：「⚠️ 未获取到有效 diff，请人工审查或检查 --diff-file / git 状态。」`;

// ---- 4) 执行 ----
const diff = collectDiff();
const gates = collectGateNames();

const gateLine = gates.ok
  ? `门禁清单已读取 **${gates.names.length}** 道（由 CI gates job 独立运行，本审查不重判）。`
  : `⚠️ 门禁清单自动读取失败（${gates.reason}）——请人工确认 \`node scripts/gate.mjs all\` 全绿。`;

let report;
let degraded = false;
let llmError = '';

if (noLlm || !diff.ok) {
  degraded = true;
  llmError = noLlm ? '（--no-llm 显式跳过）' : `（diff 获取失败：${diff.reason}）`;
  report = [
    '# AI 代码审查报告（降级模式）',
    '',
    `> 生成时间：${TS} ｜ 由 \`scripts/ai-pr-review.mjs\` 产出`,
    `> ${llmError} AI 未参与，仅作上下文汇总，请人工 review。`,
    '',
    '## 门禁提醒',
    gateLine,
    '',
    '## 审查发现',
    '⚠️ AI 未运行，本节点仅转发门禁清单与提示。请按团队既有 review 流程人工审查 diff。',
    '',
    '## 必须人工复核的高风险项',
    '（降级模式无法自动判定，请人工重点看：shared-types/实体/DI/余额/时间处理/交易主链路。）',
  ].join('\n');
} else {
  const userPrompt = `项目工程纪律清单：\n${RUBRIC}\n\n待审查的 git diff（已截断至 ${MAX_DIFF} 字）：\n\`\`\`diff\n${diff.text}\n\`\`\`\n\n请按系统指令输出审查报告。`;
  try {
    const answer = await callLLM({
      system: SYSTEM_PROMPT,
      user: userPrompt,
      timeoutMs: 20000,
      temperature: 0.2,
    });
    report = [
      `# AI 代码审查报告`,
      '',
      `> 生成时间：${TS} ｜ 由 \`scripts/ai-pr-review.mjs\` 产出（AI 辅助，软建议，不自动合并）`,
      `> diff 规模：约 ${diff.text.length} 字。门禁由 CI 独立运行，本审查不重判。`,
      '',
      '## 门禁提醒',
      gateLine,
      '',
      answer.trim(),
    ].join('\n');
  } catch (e) {
    degraded = true;
    llmError = String(e?.message || e);
    report = [
      '# AI 代码审查报告（LLM 降级）',
      '',
      `> 生成时间：${TS} ｜ LLM 调用失败（${llmError}），已降级为上下文汇总。`,
      '',
      '## 门禁提醒',
      gateLine,
      '',
      '## 审查发现',
      '⚠️ LLM 不可用，AI 审查未运行。请按团队既有 review 流程人工审查 diff。',
      '',
      '## 必须人工复核的高风险项',
      '（LLM 降级，无法自动判定，请人工重点看：shared-types/实体/DI/余额/时间处理/交易主链路。）',
    ].join('\n');
  }
}

mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `ai-review-${TS}.md`);
writeFileSync(outFile, report, 'utf8');

console.log('[ai-pr-review] 已生成审查报告：');
console.log('  ', outFile);
console.log('  门禁清单：', gates.ok ? `${gates.names.length} 道` : `失败(${gates.reason})`);
console.log('  AI 参与：', degraded ? `否（降级：${llmError || 'no-llm'}）` : '是');
if (degraded) console.log('  ⚠️ 降级模式：传统 review 流程不受影响，请人工审查。');

// ---- 5) 可选：贴 PR 评论 ----
if (prNumber && process.env.GITHUB_TOKEN) {
  try {
    const hasGh = spawnSync('gh', ['--version'], { encoding: 'utf8' }).status === 0;
    if (hasGh) {
      const r = spawnSync('gh', ['pr', 'comment', String(prNumber), '--body-file', outFile], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      if (r.status === 0) console.log(`  已贴 PR #${prNumber} 评论`);
      else console.log('  ⚠️ gh 评论失败（不影响报告产出）：', (r.stderr || '').slice(0, 120));
    }
  } catch {
    /* ignore */
  }
}

// ---- 6) 退出码 ----
let exitCode = 0;
if (failOnHigh && !degraded && /## 必须人工复核的高风险项\s*\n+([\s\S]*?)\n+## /m.test(report)) {
  const m = report.match(/## 必须人工复核的高风险项\s*\n+([\s\S]*?)(?:\n+## |$)/);
  const body = (m?.[1] || '').trim();
  if (body && !/^无\s*$/.test(body)) {
    console.log('  ⚠️ --fail-on-high：报告含高风险项，exit 1。');
    exitCode = 1;
  }
}
process.exit(exitCode);

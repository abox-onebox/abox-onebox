#!/usr/bin/env node
/**
 * ABox 一盒 · 提审材料准备生成器（AI 编排节点 C）
 * ------------------------------------------------------------------
 * 作用：在「备案通过」触发后，一键汇编提审交付物包（markdown）：
 *   A. 备案三道门状态确认
 *   B. 备案批下后必须 7 步
 *   C. 提审前合规缺口（124 号令 / 食品标签）
 *   D. 上线前建议动作（Q3 / H9 / 定时任务 / e2e）
 *   E. 部署后验证 P0 六条
 *   F. 门禁与能力清单（gate.mjs + op-catalog 137 端点）
 *   G. 退回预案
 *   H. 人工终审签名栏
 *
 * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
 *   - 本脚本是「独立新增文件」，不修改 gate.mjs / deploy.sh / 任何核心代码；
 *   - 只读 gate.mjs --json（列清单，不跑构建）与 op-catalog 端点计数（正则），均非破坏性；
 *   - 运行失败不影响发布：传统手工按既存文档汇编的路径依旧可用；
 *   - AI 不替人做合规判断（原则四）：所有项均含「来源」与「待确认」勾选框，需人工终审。
 *
 * 用法：
 *   node scripts/gen-launch-pack.mjs [--out <dir>] [--date <YYYY-MM-DD>] [--no-gate]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TS = new Date().toISOString().slice(0, 10);

// ---- 参数 ----
const argv = process.argv.slice(2);
let outDir = resolve(ROOT, 'releases');
let packDate = TS;
let noGate = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') outDir = resolve(argv[++i] || outDir);
  else if (argv[i] === '--date') packDate = argv[++i] || packDate;
  else if (argv[i] === '--no-gate') noGate = true;
}

// ---- 1) 门禁清单（只读，非破坏）----
function collectGates() {
  if (noGate) return { ok: false, reason: '已用 --no-gate 跳过', names: [] };
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
    return { ok: false, reason: String((e && e.message) || e), names: [] };
  }
}

// ---- 2) 企微操作助手端点计数（正则，不解析 base64）----
function collectOpCount() {
  const f = resolve(ROOT, 'apps/api-server/src/modules/wecom-kb/op-catalog.generated.ts');
  if (!existsSync(f)) return { ok: false, reason: 'op-catalog 文件不存在', count: null };
  try {
    const src = readFileSync(f, 'utf8');
    const m = src.match(/ADMIN_ENDPOINT_COUNT\s*=\s*(\d+)/);
    if (!m) return { ok: false, reason: '未找到 ADMIN_ENDPOINT_COUNT', count: null };
    return { ok: true, count: Number(m[1]) };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e), count: null };
  }
}

// ---- 3) 萃取自既存文档的提审清单（每条标注来源，供人工复核）----
// 来源：ABox_小程序备案判定与备案后上线清单_2026-10-28.html
//       ABox_提审前最后一公里复核_2026-10-29.html
//       ABox_部署后验证清单_P0六条_2026-10-29.md
const SECTIONS = [
  {
    key: 'A',
    title: 'A · 备案三道门状态确认',
    note: '来源：ABox_小程序备案判定与备案后上线清单_2026-10-28 §一',
    items: [
      ['门1 能不能提交：名称/头像/简介已完善且与实际一致', '备案清单 §一 门1'],
      ['门1 至少 1 个已通过的服务类目（食品销售/商家自营-食品）', '备案清单 §五'],
      ['门1 企业主体已完成微信认证（300 元/年）', '备案清单 §一 门1'],
      ['门1 法人人脸核验环境备好（白墙、无遮挡）', '备案清单 §一 门1'],
      ['门2 主体材料一致性：营业执照逐字 / 法人身份证 / 人脸核验', '备案清单 §一 门2'],
      ['门2 12381 短信 24 小时内核验（超时整套作废重提）', '备案清单 §一 门2'],
      ['门3 接口域名 https + 非 IP + 已 ICP 备案（当前不满足，见 B 步骤）', '备案清单 §二'],
    ],
  },
  {
    key: 'B',
    title: 'B · 备案批下后必须 7 步（缺一步就白等）',
    note: '来源：ABox_小程序备案判定与备案后上线清单_2026-10-28 §三',
    items: [
      ['DNS 加 A 记录：api.xunlizhinian.cn → 154.8.164.180（admin 同理）', '备案清单 §三 第1步'],
      ['申请 SSL 证书（腾讯云免费 DV；受信任 CA；证书链完整；TLS≥1.2）', '备案清单 §三 第2步'],
      [
        'nginx 加 443 server，搬原 location /api/ /static/ /assets/ 及 Cookie 闸门',
        '备案清单 §三 第3步',
      ],
      ['compose 开 443 映射（h5-prod 加 443:443）', '备案清单 §三 第4步'],
      ['改小程序端地址 https://api.xunlizhinian.cn/api/v1（不带端口/443）', '备案清单 §三 第5步'],
      ['单独重新构建小程序（--mode production）并上传，勿用 dev 包', '备案清单 §三 第6步'],
      ['微信后台配 request 合法域名 https://api.xunlizhinian.cn（可提前做）', '备案清单 §三 第7步'],
    ],
  },
  {
    key: 'C',
    title: 'C · 提审前合规缺口（不阻备案，但阻巡检）',
    note: '来源：ABox_小程序备案判定与备案后上线清单_2026-10-28 §四；124 号令 2026-05-20 施行',
    items: [
      [
        '① 主页面资质公示：恢复店铺主页显著位置持续公示备案凭证及可查验链接（「来自：X」不可替代）',
        '备案清单 §四 ①',
      ],
      ['② 销售页食品标签：配料表/净含量/生产日期/保质期/生产者/产品标准代号', '备案清单 §四 ②'],
      ['② 补「仅销售预包装食品备案编号」并与资质公示一并展示', '备案清单 §四 ②'],
    ],
  },
  {
    key: 'D',
    title: 'D · 上线前建议动作（按优先级）',
    note: '来源：ABox_提审前最后一公里复核_2026-10-29 §六',
    items: [
      ['Q3 送达凭证：团长端上传 + 后台查看入口（不补则把 Q3 从已完成划掉）', '最后一公里 §一/§六'],
      [
        'H9 落库：系统配置页设 refund.completed_window_hours 并保存；补进 biz-config-baseline.mjs',
        '最后一公里 §二/§六',
      ],
      ['盯一天定时任务：确认 02:00 佣金结算、02:10 供应商结算单自动产出', '最后一公里 §三/§六'],
      [
        '本地 e2e 环境重置后重跑 gate verify，确认 m3 的 50 条为环境问题非真回归',
        '最后一公里 §五/§六',
      ],
    ],
  },
  {
    key: 'E',
    title: 'E · 部署后验证 P0 六条（部署完成必跑）',
    note: '来源：ABox_部署后验证清单_P0六条_2026-10-29.md',
    items: [
      ['判通过一律看 body.code（0 通过；401=10002 未登录，非部署坏）', 'P0 §0'],
      ['L0 8 条新路由已注册（不带 token 返回 401/10002 即存在）', 'P0 §2.1'],
      ['S5 对账补跑 code==0，且 ab_operation_log 出现 对账执行（留痕带「不含微信侧」）', 'P0 §2.2'],
      ['L1 条件批量预览命中 0 为正确空结果；错楼宇被拒 code!=0', 'P0 §3'],
      ['L2 勾选批量三类结果 outcome/counts/amounts 齐全', 'P0 §4.2'],
      ['L2 幂等重试仍展示首次结果；乐观锁 40029 一笔都不执行', 'P0 §4.3/§4.4'],
      ['L2 Q3 凭证增删查：软删后 scope=all 仍在、scope=alive 不在', 'P0 §4.5'],
    ],
  },
];

function render(gates, op) {
  const L = [];
  L.push(`# ABox 一盒 · 提审材料包`);
  L.push('');
  L.push(
    `> 生成时间：${TS} ｜ 备案通过日期（待填）：${packDate} ｜ 由 \`scripts/gen-launch-pack.mjs\` 自动汇编`,
  );
  L.push('>');
  L.push('> ⚠️ **本包为 AI 辅助汇编草稿，仍需人工终审。AI 不替人做合规判断（原则四）。**');
  L.push(
    '> 任一自动读取失败，传统按既存《备案后上线清单》《提审前最后一公里复核》手工汇编的路径依旧可用（原则零）。',
  );
  L.push('');

  // 能力清单摘要
  const gateLine = gates.ok
    ? `门禁清单已读取 **${gates.names.length}** 道（见 §F）`
    : `⚠️ 门禁清单自动读取失败（${gates.reason}）——请手动确认 \`node scripts/gate.mjs all\` 全绿`;
  const opLine = op.ok ? `企微操作助手端点 **${op.count}** 个` : `⚠️ 端点计数失败（${op.reason}）`;
  L.push(`**能力快照**：${gateLine}；${opLine}。`);
  L.push('');

  for (const s of SECTIONS) {
    L.push(`## ${s.title}`);
    if (s.note) L.push(`> ${s.note}`);
    L.push('');
    for (const [text, ref] of s.items) {
      L.push(`- [ ] ${text}  （来源：${ref}）`);
    }
    L.push('');
  }

  // F 门禁清单（展开）
  L.push('## F · 门禁与能力清单');
  if (gates.ok) {
    L.push('');
    L.push(
      `<details><summary>门禁清单（${gates.names.length} 道，来自 gate.mjs --json）</summary>`,
    );
    L.push('');
    for (const n of gates.names) L.push(`- ${n}`);
    L.push('');
    L.push('</details>');
    L.push('');
  } else {
    L.push('');
    L.push(
      `> ⚠️ 门禁清单未自动读取（${gates.reason}）。请手动运行 \`node scripts/gate.mjs list\` 核对全绿后再提审。`,
    );
    L.push('');
  }
  if (op.ok) {
    L.push(
      `**企微操作助手端点能力**：${op.count} 个（owner 全量可用；staff 可用数见 op-policy 放权口径）。`,
    );
    L.push('');
  }

  // G 退回预案
  L.push('## G · 退回预案（审核被拒怎么办）');
  L.push('');
  L.push(
    '- [ ] 若「类目/资质」被拒：核对主体为「北京巡礼之年科技有限公司」，预包装路线选「食品销售/商家自营-食品」，补齐备案凭证或食品经营许可证。',
  );
  L.push(
    '- [ ] 若「域名/网络」被拒：复核 https + 非 IP + 已 ICP 备案；确认微信后台 request 合法域名不含端口/路径。',
  );
  L.push(
    '- [ ] 若「内容/合规」被拒：补主页资质公示与食品标签（见 §C）；整改后重新提交，不重复缴费。',
  );
  L.push('- [ ] 被拒不改代码也能重提：本包为材料清单，与代码发布解耦，按反馈逐项勾除即可。');
  L.push('');

  // H 人工终审签名栏
  L.push('## H · 人工终审签名栏');
  L.push('');
  L.push('| 项 | 确认人 | 日期 | 备注 |');
  L.push('| --- | --- | --- | --- |');
  L.push('| 备案三道门（§A） |  |  |  |');
  L.push('| 批下后 7 步（§B） |  |  |  |');
  L.push('| 合规缺口（§C） |  |  |  |');
  L.push('| 上线前动作（§D） |  |  |  |');
  L.push('| 部署验证 P0（§E） |  |  |  |');
  L.push('| 门禁全绿（§F） |  |  |  |');
  L.push('| 退回预案已知（§G） |  |  |  |');
  L.push('');
  L.push('---');
  L.push(`ABox 一盒 · 提审材料包（auto-generated by gen-launch-pack.mjs）· ${TS}`);
  return L.join('\n');
}

// ---- 执行 ----
const gates = collectGates();
const op = collectOpCount();
const md = render(gates, op);

mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `ABox一盒_提审包_${packDate}.md`);
writeFileSync(outFile, md, 'utf8');

console.log('[gen-launch-pack] 已生成提审包：');
console.log('  ', outFile);
console.log('  门禁清单：', gates.ok ? `${gates.names.length} 道` : `失败(${gates.reason})`);
console.log('  操作端点：', op.ok ? `${op.count} 个` : `失败(${op.reason})`);
console.log('  ⚠️ 本包为 AI 辅助草稿，需人工终审后用于提审。');

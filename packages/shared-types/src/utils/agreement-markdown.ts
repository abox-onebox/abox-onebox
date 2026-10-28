/**
 * 协议正文 Markdown → **渲染块**（结构化）
 *
 * ## 为什么必须有它
 *
 * 端上协议页 `pages/agreement/leader.vue` 的渲染层是原生 `<text>`，**不解析 Markdown**
 * （既有口径，见 `apps/miniprogram/src/constants/agreements.ts` 头注第 4 条）。
 * 而团长协议正文真源 `LEADER_AGREEMENT_FULL_TEXT` 是 **Markdown 字符串**
 * （它必须与工作区根公示的 `ABox一盒_团长合作协议_v1.1.md` **逐字同源**，故不能为渲染方便
 *   把它改成另一套结构 —— 那等于造出第二份真相）。
 * ⇒ 唯一不漂移的做法：**在编译期把 Markdown 派生为块**，端上只消费派生结果。
 *
 * ⭐ **派生 ≠ 第二份真相**：本文件**不持有**任何协议文字，只持有解析规则；
 *    协议改版时**只需改 `LEADER_AGREEMENT_FULL_TEXT` 一处**，块随之重算。
 *
 * ## 支持的 Markdown 子集（超出即按普通段落处理，不抛错）
 *
 * | 原文 | 块 |
 * |---|---|
 * | `# ` | `h1` |
 * | `## `（含更深层级，一律降为 h2） | `h2` |
 * | `> ` | `quote` |
 * | `1. ` / `- ` | `li`（`ordered` 标记是否有序） |
 * | `\| a \| b \|` 连续行 | `table`（首行 = 表头，`\|---\|` 分隔行丢弃） |
 * | `---` | 丢弃（分隔线，渲染为间距） |
 * | 其余 | `p` |
 *
 * ⚠️ 行内标记一律**剥除**（`**粗体**`、`` `代码` ``、行首尾单 `*`）—— `<text>` 渲染不出来，
 *    留着只会把星号打到用户眼前。
 *
 * ## ⚠️ 覆盖率自证的两条独立判据（缺一不可）
 *
 * 最大的失败形态不是报错，而是**悄悄少一段**（真源与公示文件里都有，唯独端上不显示
 * ⇒ 用户签了一份缺条款的协议，而全仓 typecheck / lint / e2e 全绿）。判据有两条，
 * **刻意用两套互不相干的剥离规则**，避免"解析器漏了什么、自证也跟着漏"的自证循环：
 *
 *   ① `checkAgreementCoverage()` —— 按**行类型**剥离前缀（`## ` / `> ` / `1. ` / `|`），逐行精确对拍；
 *   ② 单测里另做一次**符号暴力剥离**（不分类型，直接抹掉 `# > | * \``），断言原文每行
 *      都被块的纯文本 `includes`。→ 即使 ① 的分类漏了一种新形态，② 仍会把整行丢失照红。
 */

export type AgreementBlock =
  | { kind: 'h1'; text: string }
  | { kind: 'h2'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'li'; text: string; ordered: boolean }
  | { kind: 'table'; head: string[]; rows: string[][] };

/** 剥除行内 Markdown 标记（`**粗体**`、`` `代码` ``、行首尾的 `*斜体*`） */
export function stripAgreementInline(raw: string): string {
  return raw.replace(/\*\*/g, '').replace(/`/g, '').replace(/^\*/, '').replace(/\*$/, '').trim();
}

/** 表格分隔行（`|---|:---:|` 之类） */
function isTableDivider(line: string): boolean {
  return /^\|[\s:|-]+\|$/.test(line);
}

/** 拆表格行 → 单元格（去掉首尾空管道产生的空串） */
function splitRow(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => stripAgreementInline(c));
}

/**
 * 单行 → 「期望出现在块里」的纯文本；**非实质行返回 `null`**
 *
 * ⭐ 解析器与覆盖率判据 ① **共用这一个函数** —— 两边对「这行该长什么样」的理解
 *    必须是同一份，否则自证会与实现各说各话（这正是判据 ② 存在的理由）。
 */
export function lineToPlain(raw: string): string | null {
  const line = raw.trim();
  if (!line) return null;
  if (/^-{3,}$/.test(line) || isTableDivider(line)) return null;

  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return stripAgreementInline(heading[2]);

  if (/^>\s?/.test(line)) return stripAgreementInline(line.replace(/^>\s?/, '')) || null;

  if (/^\|/.test(line)) return splitRow(line).join('');

  const ordered = /^\d+\.\s+/.exec(line);
  if (ordered) return stripAgreementInline(line.replace(/^\d+\.\s+/, ''));

  const bullet = /^[-*]\s+/.exec(line);
  if (bullet) return stripAgreementInline(line.replace(/^[-*]\s+/, ''));

  return stripAgreementInline(line);
}

/**
 * Markdown → 块序列
 *
 * ⚠️ 刻意**不吞异常**：协议正文是常量，解析失败说明有人改了真源形态，
 *    宁可在单测里红，也不要在端上静默少一段。
 */
export function parseAgreementMarkdown(md: string): AgreementBlock[] {
  const lines = md.split('\n');
  const blocks: AgreementBlock[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    // 分隔线 / 表格分隔行 —— 只作排版，不进块
    if (/^-{3,}$/.test(line) || isTableDivider(line)) continue;

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: heading[1].length === 1 ? 'h1' : 'h2',
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- heading[2] 必然存在（正则已捕获）
        text: stripAgreementInline(heading[2]!),
      });
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const text = stripAgreementInline(line.replace(/^>\s?/, ''));
      if (text) blocks.push({ kind: 'quote', text });
      continue;
    }

    // 表格（连续块整体处理）
    if (/^\|/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i].trim())) {
        const cur = lines[i].trim();
        if (!isTableDivider(cur)) rows.push(splitRow(cur));
        i += 1;
      }
      i -= 1; // for 循环自身的 `i += 1` 会补回最后一个非表格行
      if (rows.length > 0) {
        const [head, ...rest] = rows;
        blocks.push({ kind: 'table', head, rows: rest });
      }
      continue;
    }

    // 列表项
    if (/^\d+\.\s+/.test(line)) {
      blocks.push({
        kind: 'li',
        text: stripAgreementInline(line.replace(/^\d+\.\s+/, '')),
        ordered: true,
      });
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      blocks.push({
        kind: 'li',
        text: stripAgreementInline(line.replace(/^[-*]\s+/, '')),
        ordered: false,
      });
      continue;
    }

    blocks.push({ kind: 'p', text: stripAgreementInline(line) });
  }

  return blocks;
}

/**
 * 块序列 → 纯文本行（覆盖率自证用）
 *
 * ⚠️ 表格单元格按**无缝**拼接：原文 `| 见习 | 8% |` 去掉标记后就是「见习8%」，
 *    与 `lineToPlain()` 的结果同形，才能逐行对拍。
 */
export function blocksToPlainText(blocks: AgreementBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'table') {
      out.push(b.head.join(''));
      for (const row of b.rows) out.push(row.join(''));
    } else {
      out.push(b.text);
    }
  }
  return out;
}

/** 归一化：去掉一切空白（含 U+3000）后再比对，避免排版空格造成假红 */
export function norm(s: string): string {
  return s.replace(/\s/g, '');
}

/**
 * 判据 ①：覆盖率自证 —— 真源里**每一条实质文本行**都必须出现在块里
 *
 * 返回**缺失行**（空数组 = 覆盖完整）。
 */
export function checkAgreementCoverage(md: string, blocks: AgreementBlock[]): string[] {
  const covered = new Set(blocksToPlainText(blocks).map(norm));
  const missing: string[] = [];

  for (const raw of md.split('\n')) {
    const expect = lineToPlain(raw);
    if (!expect) continue;
    if (!covered.has(norm(expect))) missing.push(raw.trim());
  }

  return missing;
}

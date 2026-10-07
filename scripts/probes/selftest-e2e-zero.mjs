/**
 * 一次性自证：验证三份 e2e 新增的「0 条断言 ⇒ exit 1」判定真的会红。
 *
 * ⚠️ 判据片段是**从 e2e 脚本原样抽出 eval 的**（不是复刻），并用假的 process/log 注入，
 *    避免「测的是另一份表述」。必报样本 results=[]（须 exit 1）+
 *    必不报样本 results=[{pass:true}]（不得 exit）。
 */
// ── 收编注入（2026-10-07）：以下路径**相对本文件推导**，换机器无需改一行 ──────────
import { fileURLToPath as __aboxFup } from 'node:url';
const __aboxU = (p) => __aboxFup(new URL(p, import.meta.url)).replace(/[\/]+$/, '');

import { readFileSync } from 'node:fs';

const SCRIPTS = __aboxU('..') + '/';
const FILES = ['e2e-m1.mjs', 'e2e-m2.mjs', 'e2e-m3.mjs'];

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✔ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✘ ${name} ${detail}`);
  }
};

for (const f of FILES) {
  const src = readFileSync(SCRIPTS + f, 'utf8');
  const s = src.indexOf('if (results.length === 0) {');
  if (s < 0) {
    ok(`${f} 含 0 条下限判定`, false, '未找到片段 —— 改动没落盘？');
    continue;
  }
  const e = src.indexOf('\n  }', s) + 4;
  const body = src.slice(s, e);
  const fn = new Function('results', 'log', 'process', body);

  const runWith = (results) => {
    let code = null;
    fn(results, () => {}, { exit: (c) => (code = c) });
    return code;
  };

  ok(`${f} 0 条断言 ⇒ exit 1（必报）`, runWith([]) === 1, `实得 ${runWith([])}`);
  ok(`${f} 有断言 ⇒ 不 exit（必不报）`, runWith([{ pass: true }]) === null);
  ok(`${f} 有失败断言 ⇒ 也不由本判定 exit（交给汇总）`, runWith([{ pass: false }]) === null);
}

console.log(`\n合计：通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);

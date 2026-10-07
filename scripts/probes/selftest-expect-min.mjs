/**
 * 一次性自证：验证 gate.mjs 里新增的 checkMinAssertions 判据真的会红/会绿。
 *
 * ⚠️ 判据源码是**从 gate.mjs 原样抽出来 eval 的**，不是复刻 —— 防止「测的是另一份表述」。
 * 必报样本（缩水 / 0 条 / 无汇总行）+ 必不报样本（达标 / 未登记门禁）各一组。
 */
// ── 收编注入（2026-10-07）：以下路径**相对本文件推导**，换机器无需改一行 ──────────
import { fileURLToPath as __aboxFup } from 'node:url';
const __aboxU = (p) => __aboxFup(new URL(p, import.meta.url)).replace(/[\/]+$/, '');

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const GATE = resolve(__aboxU('..'), 'gate.mjs');
const src = readFileSync(GATE, 'utf8');

// 抽出 EXPECT_MIN 与 checkMinAssertions 两段真源码
const s1 = src.indexOf('const EXPECT_MIN = {');
if (s1 < 0) throw new Error('未找到 EXPECT_MIN 定义 —— 判据没落盘？');
const e1 = src.indexOf('};', s1) + 1; // 只取到 '}'，不带上分号
const s2 = src.indexOf('function checkMinAssertions');
if (s2 < 0) throw new Error('未找到 checkMinAssertions —— 判据没落盘？');
// 函数体：从声明起，到它自己的收尾大括号（取其后第一个 "\n}" 的下一行）
const e2 = src.indexOf('\n}', src.indexOf('return null;\n}', s2)) + 2;

const EXPECT_MIN = eval(`(${src.slice(src.indexOf('{', s1), e1)})`);
const checkMinAssertions = eval(`(${src.slice(s2, e2)})`);

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✔ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✘ ${name} ${detail}`);
  }
}

console.log('EXPECT_MIN =', JSON.stringify(EXPECT_MIN));
console.log('\n[必报样本 · 判据必须红]');
ok('m1 缩水 110/114 → 报', checkMinAssertions('e2e:m1', '通过 108/110 · 全绿 ✅') !== null);
// ⚠️ 缩水的形态是「总数变小」（通过 1300/1300），不是「失败变多」（通过 1300/1335 ——
//    那属于「有 35 条没过」，由脚本 exit code 管，规模仍达标，判据不该插手）。
ok('m3 缩水 1300/1300 → 报', checkMinAssertions('e2e:m3', '通过 1300/1300 · 全绿 ✅') !== null);
ok('m2 0/0（正是原缺陷形态）→ 报', checkMinAssertions('e2e:m2', '通过 0/0 · 全绿 ✅') !== null);
ok('完全没有汇总行 → 报', checkMinAssertions('e2e:m1', 'some other output') !== null);
ok('空输出 → 报', checkMinAssertions('e2e:m3', '') !== null);

console.log('\n[必不报样本 · 判据不许误伤]');
ok('m1 刚好 114/114 → 不报', checkMinAssertions('e2e:m1', '通过 114/114 · 全绿 ✅') === null);
ok('m3 刚好 1335/1335 → 不报', checkMinAssertions('e2e:m3', '通过 1335/1335 · 全绿 ✅') === null);
ok('m2 上升 160/160 → 不报', checkMinAssertions('e2e:m2', '通过 160/160 · 全绿 ✅') === null);
ok('未登记门禁（lint）→ 不报', checkMinAssertions('lint', '通过 0/0') === null);
ok('e2e 失败但规模达标 → 不报（失败由 exit code 管）', checkMinAssertions('e2e:m1', '通过 113/114 · 失败：X') === null);

console.log(`\n合计：通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);

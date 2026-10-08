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
// ⚠️ 缩水的形态是「总数变小」（通过 1300/1300），不是「失败变多」（通过 1300/1345 ——
//    那属于「有 45 条没过」，由脚本 exit code 管，规模仍达标，判据不该插手）。
ok('m3 缩水 1300/1300 → 报', checkMinAssertions('e2e:m3', '通过 1300/1300 · 全绿 ✅') !== null);
ok('m2 0/0（正是原缺陷形态）→ 报', checkMinAssertions('e2e:m2', '通过 0/0 · 全绿 ✅') !== null);
ok('完全没有汇总行 → 报', checkMinAssertions('e2e:m1', 'some other output') !== null);
ok('空输出 → 报', checkMinAssertions('e2e:m3', '') !== null);

console.log('\n[必不报样本 · 判据不许误伤]');
/**
 * ⚠️ 样本值**一律从 `EXPECT_MIN` 派生**，不写死数字（2026-10-09 修）
 *
 * 判据源码是从 `gate.mjs` **原样 eval** 的，但**样本值此前是写死的**（114 / 1335 / 160）。
 * 于是 min 每抬一次，就有样本从「必不报」翻成「必报」⇒ **自证自己红了**，
 * 而它红的形态看起来像「判据坏了」，很容易被误读成要去改判据。
 * 2026-10-09 那次抬升（m2 158→162、m3 1339→1345）一抬就翻了两条：
 * `m3 1335/1335`（< 1345）与 `m2 160/160`（< 162）。
 * ⇒ 改成派生：样本跟着真源走，**阈值再抬也不会把自证带红**。
 */
const at = (k) => `${EXPECT_MIN[k]}/${EXPECT_MIN[k]}`;
const above = (k, n) => `${EXPECT_MIN[k] + n}/${EXPECT_MIN[k] + n}`;
ok(
  `m1 刚好 ${at('e2e:m1')} → 不报`,
  checkMinAssertions('e2e:m1', `通过 ${at('e2e:m1')} · 全绿 ✅`) === null,
);
ok(
  `m3 刚好 ${at('e2e:m3')} → 不报`,
  checkMinAssertions('e2e:m3', `通过 ${at('e2e:m3')} · 全绿 ✅`) === null,
);
ok(
  `m2 上升 ${above('e2e:m2', 8)} → 不报`,
  checkMinAssertions('e2e:m2', `通过 ${above('e2e:m2', 8)} · 全绿 ✅`) === null,
);
ok('未登记门禁（lint）→ 不报', checkMinAssertions('lint', '通过 0/0') === null);
ok(
  'e2e 失败但规模达标 → 不报（失败由 exit code 管）',
  checkMinAssertions('e2e:m1', `通过 ${EXPECT_MIN['e2e:m1'] - 1}/${EXPECT_MIN['e2e:m1']} · 失败：X`) ===
    null,
);

console.log(`\n合计：通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
